// server/match/snapRate.js — the battle-snapshot rate (DESIGN §4, §8.2). RETIRED ADAPTIVE GEAR — see below.
//
// 2026-10-11: the adaptive second gear is gone. There is one rate per ROLE, chosen by whether the watcher drives
// the field: SNAPSHOT_EVERY (3 ticks = 20 Hz at 2×) for a field's own players, SNAPSHOT_EVERY_IDLE (12 ticks =
// 5 Hz) for anything that merely watches. The decision and its reasoning live in server/sim/constants.js; the
// emit site is server/match/fields.js _emit, and it no longer consults this module for a per-link upgrade.
//
// Why it was retired rather than retuned: the two rates were 15 Hz and 20 Hz, bought against the client's 100 ms
// interpolation buffer (public/js/render/interp.js), which at 10 Hz had zero jitter slack — every bit of arrival
// jitter ran the render clock past the newest snapshot, and past `maxExtrapolate` (120 ms) the view froze. The
// measured pair, from the real buffer fed jittered arrival times (probe-interp-jitter.mjs):
//
//     jitter   10 Hz extrapolated frames   20 Hz extrapolated frames
//     30 ms                 0.1%                      0.0%
//     50 ms                 1.5%                      0.2%
//     75 ms                 4.2%                      0.6%
//    150 ms                11.2%                      3.6%
//
// That table justified ESCALATING to 20 Hz, not pinning it — but once 20 Hz is the base for everyone who drives a
// field, its 100 ms buffer covers two intervals (the slack the old fast gear was bought to secure) and a
// link-dependent upgrade has nothing left to buy: jitter >= escalateMs and jitter <= calmMs now select the same
// interval, so the policy below is a no-op on the wire. Keeping a ping probe alive to decide a choice that no
// longer changes anything would cost uplink for nothing.
//
// What survives, deliberately:
//   * `parseSnapRate` — SP_SNAP_RATE is the operator's one-step uplink fallback and is still honoured. With one
//     gear, 'fast' and the default are the same per-role cadence; 'slow' pins EVERY watcher to the idle rate
//     (fields.js _emit), which is the way back if 20 Hz for drivers proves too expensive on a narrow pipe. It is
//     a static pin, not the adaptive gear the user retired.
//   * the measured thresholds and the dwell — re-arming a gear needs no new measurement.
//   * the RTT probe itself (server/net.js linkProbeMs) — samples are still collected, so a future gear needs no new
//     wire work. Set linkProbeMs=0 to stop paying for them.
//
// Note the m.public path's own congestion fallback (server/lobby.js broadcastPublic) is INDEPENDENT of this module:
// it reads `ws.bufferedAmount` directly and drops a queued recipient's delta chain. This module never governed it.
//
// A pure module: no sockets, no timers. `update()` is fed samples and returns a rate; the caller owns the clock.

import { SNAPSHOT_EVERY, SNAPSHOT_EVERY_FAST } from '../sim/constants.js';

/** The two snapshot intervals, as tick counts. Both are 3 = 20 Hz at 2× real time: the adaptive gear is retired,
 *  so there is no longer a second, denser rate for the policy to escalate to (see the header). They stay two
 *  named constants so re-arming a gear later is a one-line change in server/sim/constants.js. */
export const SNAP_SLOW = SNAPSHOT_EVERY;
export const SNAP_FAST = SNAPSHOT_EVERY_FAST;

/**
 * Whether a faster gear exists to escalate to: "fast" must be STRICTLY denser than "slow" (fewer ticks). With the
 * gear retired the two are equal, so `hasFastGear()` is false and `update()` never moves a connection — the
 * escalation path stays as it is only so that making SNAPSHOT_EVERY_FAST denser again re-arms it in one edit.
 */
export const hasFastGear = () => SNAP_FAST < SNAP_SLOW;

/**
 * Escalate at the jitter where a denser gear starts to pay: measured at the 10 Hz base, 10 Hz extrapolated 1.5% of
 * frames at 50 ms against 20 Hz's 0.2%; below `calmMs` both measured 0.0%, so a calm link drops back. Unused while
 * `hasFastGear()` is false — kept with the rest of the policy so re-arming a gear needs no new measurement.
 */
export const SNAP_ESCALATE_MS = 50;
export const SNAP_CALM_MS = 20;
/** RTT samples kept per connection (server/net.js ring). Three are enough to measure jitter; the rest smooth it. */
export const SNAP_MIN_SAMPLES = 3;
/** How long a rate must hold before the other one may replace it (both directions), so the rates cannot flap. */
export const SNAP_DWELL_MS = 5000;
/**
 * A socket with this much queued is not keeping up: escalating would add frames to a backlog that is already 32 KiB
 * deep, so the policy drops to the slow rate and stays there until the queue drains.
 */
export const SNAP_CONGESTED_BYTES = 32 * 1024;

/**
 * The mean absolute successive difference of a series of numbers (ms here): the metric an arrival-jitter
 * buffer actually feels, and the one this project measured end to end. `null` until there are enough samples
 * to mean anything.
 * @param {readonly number[]} samples oldest → newest
 * @returns {number | null}
 */
export function rttJitter(samples) {
  if (!Array.isArray(samples) || samples.length < SNAP_MIN_SAMPLES) return null;
  let sum = 0;
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    sum += Math.abs(b - a);
    n++;
  }
  return n ? sum / n : null;
}

/** `SP_SNAP_RATE` → 'auto' | 'slow' | 'fast'. Anything unrecognised (and unset) means auto. @param {unknown} v */
export function parseSnapRate(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'slow' || s === '10') return 'slow';
  if (s === 'fast' || s === '20') return 'fast';
  return 'auto';
}

/**
 * Sanity check of the two intervals: both are positive integers and SNAP_SLOW >= SNAP_FAST, i.e. "fast" is at least
 * as dense as "slow". Equal is legal and is the shipped state — that is the retired gear, where the two name the
 * same interval. Divisibility is not required: each watcher counts the ticks since its own last frame
 * (server/match/fields.js _emit), so watchers on different cadences keep their own instead of taking only the ticks
 * divisible by both (3 and 12 ticks do not nest, and do not need to).
 */
export const snapRatesCompatible = () =>
  Number.isInteger(SNAP_FAST) && Number.isInteger(SNAP_SLOW) && SNAP_FAST > 0 && SNAP_SLOW >= SNAP_FAST;

/**
 * Per-connection snapshot-rate policy. One instance per match; `update()` per watcher on a throttle,
 * `rateFor()`/`isFast()` whenever a frame is about to go out.
 */
export class SnapRate {
  /**
   * @param {{ escalateMs?: number, calmMs?: number, dwellMs?: number, congestedBytes?: number,
   *           slow?: number, fast?: number }} [opts]
   *   calmMs defaults to the same fraction of escalateMs as the measured pair below (20 / 50), so moving the
   *   threshold keeps the hysteresis band proportional instead of accidentally narrowing it to nothing.
   *   `slow`/`fast` override the two intervals (tests only): the shipped ones come from the constants, and giving
   *   them to the instance is what lets a re-armed gear be exercised without changing what production ships.
   */
  constructor({ escalateMs = SNAP_ESCALATE_MS, calmMs = null, dwellMs = SNAP_DWELL_MS, congestedBytes = SNAP_CONGESTED_BYTES,
    slow = SNAP_SLOW, fast = SNAP_FAST } = {}) {
    this.escalateMs = escalateMs;
    this.calmMs = calmMs ?? escalateMs * (SNAP_CALM_MS / SNAP_ESCALATE_MS);
    this.dwellMs = dwellMs;
    this.congestedBytes = congestedBytes;
    this.slow = slow;
    this.fast = fast;
    /** @type {Map<string, { rate: typeof SNAP_SLOW | typeof SNAP_FAST, changedAt: number, jitter: number | null, changed: boolean }>} */
    this.states = new Map();
  }

  /** @param {string} playerId */
  _state(playerId) {
    let st = this.states.get(playerId);
    if (!st) {
      st = { rate: SNAP_SLOW, changedAt: -Infinity, jitter: null, changed: false };
      this.states.set(playerId, st);
    }
    return st;
  }

  /**
   * Feed one connection's link samples and settle on its rate. A connection with no samples, or with too few,
   * keeps whatever it has (the initial rate is the slow one: the bandwidth-saving default).
   * @param {string} playerId
   * @param {{ rtts?: readonly number[], buffered?: number } | null} stats server/net.js linkQualityOf()
   * @param {number} now ms (a monotone-ish clock; only differences matter)
   * @returns {typeof SNAP_SLOW | typeof SNAP_FAST} the rate now in force
   */
  update(playerId, stats, now) {
    const st = this._state(playerId);
    st.changed = false;
    if (!stats) return st.rate;

    const buffered = Number(stats.buffered) || 0;
    if (buffered >= this.congestedBytes) {
      // The socket is already queueing: the frames are not arriving on time and adding more would deepen the
      // backlog. Drop to the slow rate and do not wait out the dwell — a congested link is bad right now.
      st.jitter = null;
      if (st.rate !== this.slow) {
        st.rate = this.slow;
        st.changedAt = now;
        st.changed = true;
      }
      return st.rate;
    }

    const jitter = rttJitter(stats.rtts);
    st.jitter = jitter;
    // The gate is the module constants (one gear shipped). `this.fast < this.slow` covers a policy built with a
    // denser gear — tests only, so that re-arming a gear is a constants change and nothing else.
    if (!(this.fast < this.slow) && !hasFastGear()) return st.rate;
    if (jitter == null) return st.rate;

    const want = jitter >= this.escalateMs ? this.fast : jitter <= this.calmMs ? this.slow : null;
    if (want == null || want === st.rate) return st.rate;
    if (now - st.changedAt < this.dwellMs) return st.rate;
    st.rate = want;
    st.changedAt = now;
    st.changed = true;
    return st.rate;
  }

  /** @param {string} playerId @returns {number} */
  rateFor(playerId) {
    if (!snapRatesCompatible()) return this.slow;
    return this.states.get(playerId)?.rate ?? this.slow;
  }

  /** @param {string} playerId */
  isFast(playerId) {
    return this.rateFor(playerId) === this.fast && this.fast < this.slow;
  }

  /** Whether the last `update()` for this connection changed its rate (the caller logs it). @param {string} playerId */
  changed(playerId) {
    return this.states.get(playerId)?.changed === true;
  }

  /** The last measured jitter in ms, for the log line / /healthz (`null` before any sample). @param {string} playerId */
  jitterOf(playerId) {
    return this.states.get(playerId)?.jitter ?? null;
  }

  /** Connections currently on the fast rate (observability). Zero while there is one gear. */
  fastCount() {
    let n = 0;
    for (const st of this.states.values()) if (st.rate === this.fast && this.fast < this.slow) n++;
    return n;
  }

  /** Forget connections that left (a long match would otherwise accumulate one entry per departed watcher). */
  prune(keep) {
    for (const playerId of [...this.states.keys()]) if (!keep.has(playerId)) this.states.delete(playerId);
  }
}
