// server/match/match/snapRate.js — Match methods: the battle-snapshot rate (DESIGN §4, §8.2).
//
// The policy is a pure module (server/match/snapRate.js); this is the wiring.
//
// The adaptive gear is RETIRED (2026-10-11): there is one rate per ROLE — SNAPSHOT_EVERY (3 ticks, 20 Hz at 2×)
// for a field's own players, SNAPSHOT_EVERY_IDLE (12 ticks, 5 Hz) for anyone who merely watches — and the emit site
// picks it from whether the watcher drives the field (server/match/fields.js _emit). It no longer asks this module
// for a per-link upgrade, so `snapIsFast()` is kept only for observability and to keep SP_SNAP_RATE=fast meaningful.
//
// What the per-connection policy still does: the CONGESTION brake. A socket that is already queueing is never
// given a denser cadence — more frames would deepen the backlog, not help. That half was always the more valuable
// one and it is what the m.public path uses (server/lobby.js). Link samples are still collected
// (server/net.js linkProbeMs; 0 stops paying for them) so an adaptive gear can be re-armed without new wire work.
//
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { SNAPSHOT_EVERY, SNAPSHOT_EVERY_FAST, TICK } from '../../sim/constants.js';
import { GAME_SPEED } from '../fields.js';
import { snapRatesCompatible } from '../snapRate.js';

/**
 * How often the policy re-reads the link samples. Well under the policy's own dwell (5 s), so a rate change is
 * never delayed by this, and far slower than the tick loop, so it costs nothing.
 */
export const SNAP_RATE_REFRESH_MS = 1000;

/** The wire rate an interval of `every` ticks works out to at the match's speed (GAME_SPEED / TICK = 60 ticks/s). */
const rateLabel = (every) => `${Math.round(GAME_SPEED / TICK / every)} Hz`;

export class MatchSnapRate {
  /**
   * Re-read every watched connection's link samples and settle its snapshot rate. Throttled to
   * SNAP_RATE_REFRESH_MS of match time. A match with no link source (tests, a host that passes none) keeps the
   * base rate everywhere and never enters here.
   *
   * With the gear retired the policy cannot move a connection (there is nothing denser to move it to), so this now
   * only refreshes the jitter reading and the congestion state — both still observed and still logged on change.
   */
  refreshSnapRates() {
    if (!this.linkOf) return;
    const now = this.sched.now();
    if (now - this._snapRateAt < SNAP_RATE_REFRESH_MS) return;
    this._snapRateAt = now;
    for (const playerId of this.watchers.keys()) {
      let link = null;
      try { link = this.linkOf(playerId); } catch (e) { this.reportError('linkOf', e); }
      this.snapRate.update(playerId, link, now);
      if (this.snapRate.changed(playerId)) {
        const jitter = this.snapRate.jitterOf(playerId);
        // the label is derived from the interval, never a literal: it cannot drift from the constants again
        const rate = this.snapRate.rateFor(playerId);
        this.log.info(`[snap] ${this.roomCode} ${playerId} → ${rateLabel(rate)}` +
          (jitter == null ? '' : ` (jitter ${Math.round(jitter)} ms)`));
      }
    }
    this.snapRate.prune(new Set(this.watchers.keys()));
  }

  /**
   * The snapshot interval (ticks) this field's own players get right now. Observability only: the wire path no
   * longer consults it, because the emit site picks the cadence per watcher from whether that watcher drives the
   * field (fields.js _emit) — a field serves its players 20 Hz and its watchers 5 Hz at once, so no single
   * field-wide interval describes it any more. `SP_SNAP_RATE` still pins what it can: 'fast' names the dense
   * interval, 'slow' the base one.
   * @param {string} fieldId
   * @returns {number}
   */
  snapEveryFor(fieldId) {
    if (this.snapRateMode === 'slow') return SNAPSHOT_EVERY;
    if (this.snapRateMode === 'fast') return SNAPSHOT_EVERY_FAST;
    if (!snapRatesCompatible()) return SNAPSHOT_EVERY;
    for (const playerId of this.watchersOf(fieldId)) if (this.snapRate.isFast(playerId)) return SNAPSHOT_EVERY_FAST;
    return SNAPSHOT_EVERY;
  }

  /** Whether this watcher is on the fast rate right now (it then takes every emitted frame). @param {string} playerId */
  snapIsFast(playerId) {
    if (this.snapRateMode === 'fast') return true;
    if (this.snapRateMode === 'slow' || !snapRatesCompatible()) return false;
    return this.snapRate.isFast(playerId);
  }

  /** Connections on the fast rate (observability: /healthz, the match log). */
  snapFastCount() {
    if (this.snapRateMode === 'fast') return this.watchers.size;
    if (this.snapRateMode === 'slow' || !snapRatesCompatible()) return 0;
    return this.snapRate.fastCount();
  }
}
