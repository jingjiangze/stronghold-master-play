// server/match/snapRate.js — the battle-snapshot rate: the policy, the SP_SNAP_RATE pin, and the field/match wiring.
//
// The ADAPTIVE GEAR IS RETIRED (2026-10-11). Two fixed rates, chosen per watcher by whether it DRIVES the field:
// a field's own players take SNAPSHOT_EVERY (3 ticks = 20 Hz at 2×), anything that merely watches takes
// SNAPSHOT_EVERY_IDLE (12 ticks = 5 Hz). Those two and their reasoning are in server/sim/constants.js; the emit
// site is server/match/fields.js _emit, which no longer asks this module for a per-link upgrade.
//
// So the policy is a table of inputs and expected rates where the expected rate is now always the base one: with
// no denser gear to escalate to, jitter must move NOTHING. That is the property worth pinning — a future edit that
// re-arms a gear by making SNAPSHOT_EVERY_FAST denser must re-enable the escalation tests below rather than leave
// them asserting an inert policy. The wiring is covered through the real harness: a player of a field must take
// 20 Hz, a watcher of the same field 5 Hz, and neither may lose an event (the per-watcher counters and the parked
// batches; the old grid model would have thinned the slow one far below its own rate).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SnapRate, parseSnapRate, rttJitter, snapRatesCompatible, hasFastGear,
  SNAP_SLOW, SNAP_FAST, SNAP_ESCALATE_MS, SNAP_CALM_MS, SNAP_DWELL_MS, SNAP_CONGESTED_BYTES,
} from '../../server/match/snapRate.js';
import { SNAPSHOT_EVERY, SNAPSHOT_EVERY_FAST, SNAPSHOT_EVERY_IDLE } from '../../server/sim/constants.js';
import { FakeBattle } from './fakeBattle.js';
import { makeMatch } from './harness.js';

const jitter = (n, j) => Array.from({ length: n }, (_, i) => (i % 2 ? j : 0));   // mean |Δ| = j

describe('the rates: one gear, two roles', () => {
  test('the base is 20 Hz for a driver and 5 Hz for a watcher, and the policy has no second gear', () => {
    assert.equal(SNAP_SLOW, SNAPSHOT_EVERY);
    assert.equal(SNAP_FAST, SNAPSHOT_EVERY_FAST);
    assert.equal(SNAP_SLOW, 3, '20 Hz at 60 ticks per real second');
    assert.equal(SNAPSHOT_EVERY_IDLE, 12, '5 Hz at 60 ticks per real second');
    // The retired gear: "fast" is no longer denser than "slow", so there is nothing to escalate to. This is the
    // assertion that must be flipped (along with the escalation tests) if a gear is ever re-armed.
    assert.equal(SNAP_FAST, SNAP_SLOW, 'the adaptive gear is retired: one gear, no denser rate to escalate to');
    assert.equal(hasFastGear(), false, 'hasFastGear() is what keeps update() from moving a connection');
    // 12 happens to be a multiple of 3, so the shipped pair nests — but that is luck, not a requirement. Each watcher
    // counts the ticks since its own last frame (fields.js _emit), so ANY pair works: the retired 4 and 3 did not nest
    // and served both cadences fine. Verified with SNAPSHOT_EVERY_IDLE = 5 (no common grid): a driver measured 20 Hz
    // and a watcher of the same field 12 Hz. Nothing here may start depending on divisibility again.
    assert.equal(SNAPSHOT_EVERY_IDLE % SNAPSHOT_EVERY, 0, 'the shipped pair nests — by luck, not by requirement');
    assert.ok(snapRatesCompatible(), 'equal rates are a legal configuration (that is the retired gear)');
  });

  test('SP_SNAP_RATE: unrecognised and unset mean the base; slow and fast are the operator pin', () => {
    assert.equal(parseSnapRate(undefined), 'auto');
    assert.equal(parseSnapRate(''), 'auto');
    assert.equal(parseSnapRate('AUTO'), 'auto');
    assert.equal(parseSnapRate('slow'), 'slow');
    assert.equal(parseSnapRate('10'), 'slow');
    assert.equal(parseSnapRate('fast'), 'fast');
    assert.equal(parseSnapRate('20'), 'fast');
    assert.equal(parseSnapRate('nonsense'), 'auto', 'an unknown value must not pin a rate');
  });
});

describe('rttJitter', () => {
  test('is the mean absolute successive difference, and null until there are enough samples', () => {
    assert.equal(rttJitter([]), null);
    assert.equal(rttJitter([40]), null);
    assert.equal(rttJitter([40, 90]), null, 'two samples are not enough to mean anything');
    assert.equal(rttJitter([40, 90, 40]), (50 + 50) / 2);
    assert.equal(rttJitter([100, 100, 100, 100]), 0, 'a perfectly steady link has no jitter');
  });

  test('a constant RTT is calm however large it is: latency is not jitter', () => {
    assert.equal(rttJitter([500, 500, 500, 500, 500]), 0);
    assert.equal(rttJitter([5, 5, 5, 5, 5]), 0);
  });

  test('junk samples are skipped rather than poisoning the reading', () => {
    assert.equal(rttJitter([100, NaN, 100, 100]), 0, 'a pair with junk in it is dropped, the rest still counts');
    assert.equal(rttJitter([100, Infinity, 100]), null, 'with every pair dropped there is nothing to measure');
  });
});

describe('SnapRate policy', () => {
  const t0 = 1_000_000;

  test('a connection with no samples, or too few, keeps the slow rate', () => {
    const p = new SnapRate();
    assert.equal(p.update('a', null, t0), SNAP_SLOW);
    assert.equal(p.update('a', { rtts: [], buffered: 0 }, t0), SNAP_SLOW);
    assert.equal(p.update('a', { rtts: [10, 10], buffered: 0 }, t0), SNAP_SLOW);
    assert.equal(p.rateFor('a'), SNAP_SLOW);
  });

  // RETIRED GEAR. With one gear there is nothing denser to escalate to, so jitter must move nothing at all. The
  // escalation is still exercised against a two-gear policy built by hand below, so re-arming it (one constant in
  // server/sim/constants.js) is a matter of deleting the skip rather than rewriting the expectations.
  test('jitter moves nothing while there is no denser gear to escalate to', () => {
    const p = new SnapRate();
    assert.equal(p.update('a', { rtts: jitter(8, SNAP_ESCALATE_MS), buffered: 0 }, t0), SNAP_SLOW);
    assert.equal(p.isFast('a'), false, 'a jitter reading must not escalate when fast === slow');
    for (let i = 0; i < 5; i++) p.update('a', { rtts: jitter(8, 500), buffered: 0 }, t0 + i * SNAP_DWELL_MS);
    assert.equal(p.rateFor('a'), SNAP_SLOW, 'and it stays there however long the link misbehaves');
    assert.equal(p.fastCount(), 0);
  });

  // RE-ARM GUARD. hasFastGear() gates the escalation on the module constants, so re-arming a gear is a one-line
  // change in server/sim/constants.js — but only if the escalation logic behind the gate still works. These drive
  // the real update() path with a policy built a gear denser than its base (the two intervals are constructor
  // options for exactly this), so the first-reading rule, the dwell and the hysteresis stay pinned while they are
  // switched off in production. If a gear is re-armed for real, the same properties must hold from the constants.
  const armed = (opts = {}) => new SnapRate({ slow: SNAP_SLOW, fast: SNAP_SLOW - 1, ...opts });

  test('RE-ARM GUARD: a jittery link escalates on the first real evidence, and the dwell holds it', () => {
    const p = armed();
    // The dwell holds a rate against *changing back*, not against the first honest reading: a connection whose
    // link is jittery when the battle starts must not wait a dwell before its frames get smoother.
    assert.equal(p.update('a', { rtts: jitter(8, SNAP_ESCALATE_MS), buffered: 0 }, t0), p.fast);
    assert.equal(p.isFast('a'), true);
    // a calm reading right afterwards must not flip it back before the dwell has elapsed
    assert.equal(p.update('a', { rtts: jitter(8, 0), buffered: 0 }, t0 + 1), p.fast);
    assert.equal(p.update('a', { rtts: jitter(8, 0), buffered: 0 }, t0 + SNAP_DWELL_MS - 1), p.fast);
    assert.equal(p.update('a', { rtts: jitter(8, 0), buffered: 0 }, t0 + SNAP_DWELL_MS), p.slow);
  });

  test('RE-ARM GUARD: the middle of the range changes nothing — hysteresis, not a threshold', () => {
    const p = armed();
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0);
    assert.equal(p.rateFor('a'), p.fast);
    const middle = (SNAP_CALM_MS + SNAP_ESCALATE_MS) / 2;
    for (let i = 0; i < 10; i++) p.update('a', { rtts: jitter(8, middle), buffered: 0 }, t0 + 100 + i * SNAP_DWELL_MS);
    assert.equal(p.rateFor('a'), p.fast, 'between the two thresholds the rate must hold, not oscillate');
  });

  // The congestion brake is the half of this module that still does work with one gear, so it is pinned against
  // the real shipped policy (not an armed one): a socket that is already queueing must never be given a denser
  // cadence — more frames would deepen the backlog it is failing to drain.
  test('a congested socket stays on the base rate — it is bad right now, no dwell', () => {
    const p = new SnapRate();
    assert.equal(p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0), SNAP_SLOW);
    assert.equal(p.update('a', { rtts: jitter(8, 200), buffered: SNAP_CONGESTED_BYTES }, t0 + 1), SNAP_SLOW);
    assert.equal(p.changed('a'), false, 'one gear: the queue changes nothing, but it must never escalate');
  });

  test('with a gear armed, a congested socket drops to the base at once — no dwell', () => {
    const p = armed();
    assert.equal(p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0), p.fast);
    assert.equal(p.update('a', { rtts: jitter(8, 200), buffered: SNAP_CONGESTED_BYTES }, t0 + 1), p.slow,
      'the queue is bad right now: the drop must not wait out the dwell');
    assert.equal(p.changed('a'), true);
  });

  test('a jittery link with a deep queue stays on the base rate', () => {
    const p = armed();
    for (let i = 0; i < 5; i++) {
      p.update('a', { rtts: jitter(8, 500), buffered: SNAP_CONGESTED_BYTES + 1 }, t0 + i * SNAP_DWELL_MS);
    }
    assert.equal(p.rateFor('a'), p.slow, 'adding frames to a backlog would deepen it');
  });

  test('connections are independent: one jittery link does not move another', () => {
    const p = armed();
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0);
    p.update('b', { rtts: jitter(8, 0), buffered: 0 }, t0);
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0 + SNAP_DWELL_MS + 1);
    p.update('b', { rtts: jitter(8, 0), buffered: 0 }, t0 + SNAP_DWELL_MS + 1);
    assert.equal(p.rateFor('a'), p.fast);
    assert.equal(p.rateFor('b'), p.slow);
    assert.equal(p.fastCount(), 1);
  });

  test('prune forgets departed watchers so a long match cannot grow the map', () => {
    const p = new SnapRate();
    p.update('a', { rtts: jitter(8, 0), buffered: 0 }, t0);
    p.update('b', { rtts: jitter(8, 0), buffered: 0 }, t0);
    p.prune(new Set(['a']));
    assert.equal(p.states.has('a'), true);
    assert.equal(p.states.has('b'), false);
  });

  test('changed() reports only the update that moved the rate', () => {
    const p = armed();
    assert.equal(p.changed('a'), false, 'nothing has happened yet');
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0);
    assert.equal(p.changed('a'), true, 'the escalation');
    p.update('a', { rtts: jitter(8, 200), buffered: 0 }, t0 + 1);
    assert.equal(p.changed('a'), false, 'the same rate again');
  });

  test('one gear: changed() never fires, so the match logs no rate line', () => {
    const p = new SnapRate();
    assert.equal(p.changed('a'), false);
    for (let i = 0; i < 5; i++) p.update('a', { rtts: jitter(8, 500), buffered: 0 }, t0 + i * SNAP_DWELL_MS);
    assert.equal(p.changed('a'), false, 'nothing moved: there is no second rate to move to');
  });
});

// The user's rule (2026-10-11), pinned end to end through the real harness:
//   * a watcher who DRIVES the field — one of its players — takes 20 Hz (SNAPSHOT_EVERY = 3 ticks at 60 ticks/s);
//   * a watcher who does NOT drive it — a spectator, a teammate peeking — takes 5 Hz (SNAPSHOT_EVERY_IDLE = 12);
//   * and neither depends on the LINK any more: the adaptive gear is retired, so a jittery connection gets exactly
//     what a quiet one gets. That last property is the one worth asserting hardest — it is what "不加动态" means.
describe('the wiring: a driver takes 20 Hz, a watcher 5 Hz, and the link decides nothing', () => {
  /** A running match in server-run combat whose linkOf reports one player's link. */
  const started = (linkOf, opts = {}) => {
    // `duration` is GAME seconds and the match runs at 2x, so a real-second measurement needs a long battle.
    const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 41, fake: true, instant: false, script: () => ({ duration: 3600 }), ...opts });
    h.m.linkOf = linkOf;
    return h.start();
  };
  /** Count b.snap frames delivered to one player over one real second, once the rates have settled. */
  const perSecond = (h, pid) => {
    h.sched.advance(1000);                     // let the policy read the links and settle
    const before = h.allTo(pid, 'b.snap').length;
    h.sched.advance(1000);
    return h.allTo(pid, 'b.snap').length - before;
  };
  const toCombat = (h) => {
    h.toPrep(1);
    h.autoHumans();
    h.run(() => h.m.phase === 'COMBAT');
    return h;
  };
  const quiet = () => ({ rtts: jitter(8, 0), buffered: 0 });
  const jittery = () => ({ rtts: jitter(8, 300), buffered: 0 });

  test('a field player takes 20 Hz whether or not the match has any link samples', () => {
    for (const linkOf of [null, quiet]) {
      const snaps = perSecond(toCombat(started(linkOf)), 'p_0');
      assert.ok(snaps >= 17 && snaps <= 23, `20 Hz for a driver: got ${snaps} snapshots in a real second`);
    }
  });

  test('a jittery link changes NOTHING: the retired gear must not move a driver off 20 Hz', () => {
    const calm = perSecond(toCombat(started(quiet)), 'p_0');
    const bad = perSecond(toCombat(started(jittery)), 'p_0');
    assert.equal(bad, calm, `the link must not decide the cadence: ${bad} vs ${calm}`);
    assert.ok(calm >= 17 && calm <= 23, `and the cadence is 20 Hz: got ${calm}`);
  });

  test('a watcher that does not drive the field takes 5 Hz, on the same field, at the same time', () => {
    const h = toCombat(started(quiet));
    // p_1 drives its own field; make it watch p_0's instead and it must drop to the idle cadence.
    assert.equal(h.m.handle('p_1', { t: 'g.watch', fieldId: 'n:p_0' }).ok, true);
    const driver = perSecond(h, 'p_0');
    const watcher = perSecond(h, 'p_1');
    assert.ok(driver >= 17 && driver <= 23, `the driver keeps 20 Hz: got ${driver}`);
    assert.ok(watcher >= 4 && watcher <= 8, `the watcher of the same field takes 5 Hz: got ${watcher}`);
    assert.ok(watcher < driver, 'and strictly fewer — the idle cadence is really coarser');
  });

  test('an idle watcher skipping frames still receives every event batch', () => {
    const h = toCombat(started(quiet));
    h.sched.advance(1000);
    // A teammate watching p_0's field is on the idle rate, so it skips most frames. Whatever events those frames
    // drained must still reach it with its next snapshot.
    assert.equal(h.m.handle('p_1', { t: 'g.watch', fieldId: 'n:p_0' }).ok, true);
    const from = { p0: h.allTo('p_0', 'b.ev').length, p1: h.allTo('p_1', 'b.ev').length };
    h.sched.advance(1000);
    // End the field: the final frame goes to every watcher regardless of cadence, so at this point the idle
    // watcher must hold everything the driver saw (a running battle would still leave it one interval behind).
    FakeBattle.instances.find((b) => b.fieldId === 'n:p_0').forceEnd('forced');
    h.sched.advance(300);
    const toP0 = h.allTo('p_0', 'b.ev').slice(from.p0).filter((m) => m.fieldId === 'n:p_0');
    const toP1 = h.allTo('p_1', 'b.ev').slice(from.p1).filter((m) => m.fieldId === 'n:p_0');
    assert.ok(toP0.length > 0, 'the driver received events');
    assert.ok(toP1.length > 0, 'the idle watcher received events too');
    const seen = (msgs) => new Set(msgs.flatMap((m) => m.ev.map((e) => JSON.stringify(e))));
    const fast = seen(toP0);
    const slow = seen(toP1);
    for (const e of fast) assert.ok(slow.has(e), `the idle watcher missed an event: ${e}`);
  });

  test("SP_SNAP_RATE: 'slow' pins every watcher to the idle cadence; 'fast' and the default are 20 Hz for a driver", () => {
    for (const [mode, lo, hi] of [['slow', 4, 8], ['fast', 17, 23], [undefined, 17, 23]]) {
      const h = toCombat(started(jittery, mode ? { snapRate: mode } : {}));
      const snaps = perSecond(h, 'p_0');
      assert.ok(snaps >= lo && snaps <= hi, `${mode ?? 'default'}: got ${snaps} snapshots per real second`);
    }
  });

  test('a congested socket gets no more frames than a quiet one (one gear: the cadence is not link-driven)', () => {
    const calm = perSecond(toCombat(started(quiet)), 'p_0');
    const h = toCombat(started(() => ({ rtts: jitter(8, 300), buffered: 1 << 20 })));
    const snaps = perSecond(h, 'p_0');
    assert.ok(snaps <= calm, `a socket that is already queueing must not be given more frames: ${snaps} vs ${calm}`);
  });
});

// The per-watcher-counter regression guard. The old model emitted a field on one grid (its finest watcher's interval)
// and let slower watchers take only the grid ticks that were also multiples of their own interval — on a field whose
// watchers did not nest, the slower one was thinned far below the rate it should have had. Every watcher now counts
// the ticks since its own last frame, so a field serves a driver and a watcher — or two drivers — their own cadences
// without either thinning the other, and the parking path leaves neither short of a single `b.ev`.
describe('one field, two cadences: watchers of the same field keep their own cadence', () => {
  test('the 联防 field: both helpers play it and take 20 Hz; a watcher of it takes 5 Hz; no event lost', () => {
    // p_0 leaks; p_1 and p_2 are perfect and both play the 联防 field 'u' — neither is idle-throttled. p_1's link is
    // jittery and p_2's is quiet: with the adaptive gear retired that must make no difference at all.
    const h = makeMatch({
      mode: 'coop', humans: 3, seed: 77, fake: true, instant: false,
      linkOf: (pid) => ({ rtts: pid === 'p_1' ? jitter(8, 300) : jitter(8, 0), buffered: 0 }),
      // the normal fields end at once (4 game s); the 联防 battle outlives the measurement
      script: (b) => (b.kind === 'unite' ? { duration: 3600 } : { duration: 4, leaks: { p_0: 2 } }),
    }).start();
    h.toPrep(1);
    assert.ok(h.drive(() => h.m.phase === 'UNITE'), 'the round must reach 联防');
    const u = h.m.fields.find((f) => f.fieldId === 'u');
    assert.ok(u && u.live, 'the 联防 field is up');
    assert.deepEqual(u.players.slice().sort(), ['p_1', 'p_2'], 'both helpers play the field');
    // baseline: the b.ev messages each helper already had before the 联防 field started
    const from = { p1: h.allTo('p_1', 'b.ev').length, p2: h.allTo('p_2', 'b.ev').length };
    // let the rate policy read the links, then count the frames each watcher receives over one real second (60 ticks)
    h.sched.advance(1000);
    const count = (pid) => {
      const before = h.allTo(pid, 'b.snap').length;
      h.sched.advance(1000);
      return h.allTo(pid, 'b.snap').length - before;
    };
    const c1 = count('p_1');
    const c2 = count('p_2');
    assert.ok(c1 >= 17 && c1 <= 23, `a helper drives the field and takes 20 Hz: got ${c1}`);
    assert.ok(c2 >= 17 && c2 <= 23, `so does the other: got ${c2}`);
    assert.equal(c1, c2, 'the link must not decide the cadence (the adaptive gear is retired)');
    // End the field: the final frame is due for every watcher and flushes whatever each had parked, so both must
    // then hold every event the field drained over the whole 联防.
    FakeBattle.instances.find((b) => b.fieldId === 'u').forceEnd('forced');
    h.sched.advance(300);
    const flat = (pid, n) => h.allTo(pid, 'b.ev').slice(n).filter((m) => m.fieldId === 'u').flatMap((m) => m.ev.map((e) => JSON.stringify(e))).sort();
    const ev1 = flat('p_1', from.p1);
    const ev2 = flat('p_2', from.p2);
    assert.ok(ev1.length > 0 && ev2.length > 0, 'both watchers received events');
    assert.deepEqual(ev2, ev1, 'same cadence, same events: neither is thinned by the other');
    h.m.dispose();
  });

  test('a driver and an idle watcher of the same field: 20 Hz and 5 Hz, neither short of an event', () => {
    const h = makeMatch({
      mode: 'coop', humans: 3, seed: 77, fake: true, instant: false,
      // the normal fields end at once (4 game s); the 联防 battle outlives the measurement
      script: (b) => (b.kind === 'unite' ? { duration: 3600 } : { duration: 4, leaks: { p_0: 2 } }),
    }).start();
    h.toPrep(1);
    assert.ok(h.drive(() => h.m.phase === 'UNITE'), 'the round must reach 联防');
    // p_0 is the leaker: it does not play the 联防 field, so watching it is the idle cadence for p_0.
    assert.equal(h.m.handle('p_0', { t: 'g.watch', fieldId: 'u' }).ok, true);
    h.sched.advance(1000);
    const count = (pid) => {
      const before = h.allTo(pid, 'b.snap').length;
      h.sched.advance(1000);
      return h.allTo(pid, 'b.snap').length - before;
    };
    const driver = count('p_1');
    const idle = count('p_0');
    assert.ok(driver >= 17 && driver <= 23, `the helper drives the field and takes 20 Hz: got ${driver}`);
    assert.ok(idle >= 4 && idle <= 8, `the leaker only watches it and takes 5 Hz: got ${idle}`);
    assert.ok(idle < driver, 'the idle cadence is really coarser');
    h.m.dispose();
  });
});

