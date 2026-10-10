// test/match/ws-public-compact.test.js — protocol acceptance for the compact m.public layer (PR #157). The hot
// broadcast is `publicView({ full: false })` (server/match/match/messaging.js `_maybeSendPublic`) and the per-match
// constants travel in a BASELINE (`full: true`) sent by platform.js `baselinePublic()` / `_resync()`; a client that
// declared the `pub` capability merges the hot frames into its mirror (public/js/main.js wireNet). This file drives a
// real Match (co-op, production client-side combat) through a unite round (3 humans) and through the boss pair plus
// the hidden round (2 humans), and checks:
//   1. a full publicView() carries every one of the ten constants (views.js);
//   2. publicView({ full: false }) drops exactly them, has no `full: true` marker, and still carries the hot state;
//   3. the client's exact merge over [baseline, ...hot frames] agrees with publicView() (full) taken at the same
//      match state - the constants survive and no compact frame erases anything (narrowed, see FINDING below);
//   4. while the match is in the UNITE phase a hot frame carries `v.unite` { helpers, leakers } and the merge keeps it;
//   5. in the boss round a hot frame's `fields` names the boss field (kind 'boss', or 'hidden' for the hidden round)
//      with its shared pool, and the merge keeps `bossId` / `hiddenBossId` from the baseline - the regression guard
//      for "the boss does not show": without the baseline constants the client cannot render the leader at all;
//   6. the Lobby's capability routing: a session that did not declare `hello.pub` (pubCap 0) receives the FULL
//      encoding of every m.public broadcast, a session with pubCap > 0 the compact one;
//   7. the compact frame's null-clearing rule (server/match/match/views.js COMPACT_NULL_POCKETS): after a unite round
//      reaches SETTLE the mirror holds `uniteResult`, and the LATER SETTLE that resolves no unite carries an explicit
//      `uniteResult: null`, so the merged mirror clears the ended pocket instead of popping the previous unite's
//      result box and sound (public/js/screens/game.js reads `pub?.uniteResult` at every SETTLE);
//   8. step ③ of the next compression round (docs/ws-link-compression-next.md): a session that declared `hello.pubBonds`
//      receives a per-recipient hot frame — only the 1–2 players its screen can show keep their bonds, everyone else
//      travels as an explicit `[]` (never stale); the baseline and a frame for a session without the capability are
//      content-identical to today's, and `g.bonds` answers one unicast `m.bonds` with players[].bonds' own payload
//      (a player seat or a spectator seat; refused by the lobby without the capability, refused by the match for an
//      unknown player id);
//   9. step ④: a connection that declared `hello.pubDelta` (and a match running SP_PUB_SYNC=delta) receives delta hot
//      frames — top-level keys and players[] entries only where something changed, cleared keys as an explicit null —
//      and the periodic full anchor (a complete compact frame, no `full` marker); the client's exact per-player merge
//      over [baseline, ...frames] restores the full view, a frame the client missed heals on the next anchor, and a
//      reconnect baseline resets the chain. With the doc's default `SP_PUB_SYNC=full` every frame stays complete (the
//      one-key fallback), and a connection without the capability never sees a delta.
//
// Run: node --test test/match/ws-public-compact.test.js
//
// FINDING (reported with PR #157; the equivalence below is deliberate): the brief asks the merged mirror to agree with
// `publicView()` (full) over [baseline, ...hot frames]. With the client's exact merge the strict deep-equal needs TWO
// equivalences, both the explicit-null prerequisite of the compression doc's steps ② and ④:
//   * top level: a shallow merge never removes a key, and a compact frame clears every ended phase pocket it does not
//     publish with an explicit null (views.js COMPACT_NULL_POCKETS), so the mirror holds `draft: null` / `uniteResult:
//     null` where the fresh full view has no key at all;
//   * per player (step ④): the client merges `players[]` per player (public/js/main.js mergePlayers), so a compact
//     frame a delta-capable connection receives carries a cleared `pendingLp` / `uniteLeft` as an explicit null
//     (views.js DELTA_PLAYER_NULL_KEYS) where the fresh full view omits the key — the client reads both as falsy.
// For those keys an absent key in the full view is therefore equivalent to null in the mirror; the strictEST property
// that can hold is asserted (assertMirrorAgrees): every key the full view publishes is present and deep-equal, and NO
// pocket key survives as a stale non-null value. Earlier that strict form could not hold at all - a stale `uniteResult`
// survived in the mirror and a later SETTLE without a unite would pop the previous unite's result box and sound instead
// of that round's own battle result; the fix and test 7 pin the cleared form. A stale per-player value (a `pendingLp`
// that was billed in one round and cleared in the settle) is the same class of bug for the per-player merge and is
// pinned by the step-④ tests below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, ERR } from '../../shared/constants.js';
import { validateC2S, S2C } from '../../shared/protocol.js';
import { parsePubSync } from '../../server/match/Match.js';
import { DATA, makeMatch, give, legalTileFor, chessOfTier } from './harness.js';
import { createBattleFromSpec, compactResult } from '../../server/sim/spec.js';
import { Lobby, Room } from '../../server/lobby.js';

/** The ten per-match constants: fixed at match start, carried only by a baseline (server/match/match/views.js). */
const CONSTANTS = ['lastRound', 'modeId', 'difficulty', 'stageId', 'factions', 'disabledBonds', 'drawnDisabledBonds', 'bannedChess', 'bossId', 'hiddenBossId'];
/** The hot state every frame carries, baseline or not. */
const HOT = ['phase', 'round', 'deadline', 'serverNow', 'bossRound', 'hiddenRound', 'spRound', 'combatMode', 'paused', 'players', 'fields'];
/** Phase-scoped keys: a frame publishes them only in their phase, and the merge keeps them after that phase ends. */
const PHASE_POCKETS = new Set(['draft', 'sp', 'unite', 'uniteResult', 'bossHp', 'overtimeAt', 'teamLp']);
/** The pockets a compact frame must clear with an explicit null (server/match/match/views.js COMPACT_NULL_POCKETS). */
const NULLED_POCKETS = ['unite', 'uniteResult', 'draft', 'sp', 'overtimeAt', 'teamLp'];
/** The per-player keys a delta-capable frame clears with an explicit null (views.js DELTA_PLAYER_NULL_KEYS, step ④). */
const NULLED_PLAYER_KEYS = ['pendingLp', 'uniteLeft'];

/** public/js/main.js `payload(msg)`: a server message without its transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg;
  return rest;
}

/** The client's exact m.public merge (public/js/main.js, net.on('m.public')) — copied so the test fails with it. */
function mergePublic(cur, msg) {
  const p = payload(msg);
  const { full: baseline, ...next } = p && typeof p === 'object' ? p : {};
  const prev = cur && cur.public;
  return { public: baseline === true || !prev ? next : mergeFrame(prev, next) };
}

/** public/js/main.js mergePublic (step ④: players[] merges per player; cleared keys travel as explicit nulls). */
function mergeFrame(prev, next) {
  const out = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (k === 'players' && Array.isArray(v) && Array.isArray(prev.players)) out.players = mergePlayers(prev.players, v);
    else out[k] = v;
  }
  return out;
}

/** public/js/main.js mergePlayers: each incoming part laid over its current entry; new playerIds are appended. */
function mergePlayers(prevList, nextList) {
  const parts = new Map();
  for (const p of nextList) if (p && typeof p.playerId === 'string') parts.set(p.playerId, p);
  const out = prevList.map((p) => {
    const part = p && parts.get(p.playerId);
    return part ? { ...p, ...part } : p;
  });
  const seen = new Set(out.map((p) => p && p.playerId));
  for (const p of nextList) if (p && typeof p.playerId === 'string' && !seen.has(p.playerId)) out.push(p);
  return out;
}

/**
 * Everything ONE recipient receives as m.public, in wire order: the unicast baselines the match sends it (start /
 * _resync, `full: true`, recorded by the onSend hook) and — for every hot broadcast — the frame the lobby would send
 * that recipient (server/lobby.js broadcastPublic -> Match.publicViewFor with its declared capabilities; a null delta
 * sends nothing and is dropped here like the lobby drops it, in broadcastPublic). Register BEFORE h.start().
 * @param {object} h harness @param {string} playerId @param {{ full?: boolean, bonds?: boolean, delta?: boolean }} opts
 */
function recipientStream(h, playerId, opts) {
  const stream = [];
  h.onSend.push((pid, msg) => { if (pid === playerId && msg.t === 'm.public') stream.push(msg); });
  h.onBroadcast.push((msg) => {
    if (msg.t !== 'm.public') return;
    const view = h.m.publicViewFor(playerId, opts);
    if (view !== null) stream.push(view);
  });
  return stream;
}

/** A complete (non-delta) hot frame: every hot key and every player entry with its full key set (anchors included). */
function isCompleteFrame(v) {
  if (!Object.hasOwn(v, 'fields') || !Object.hasOwn(v, 'phase')) return false;
  return Array.isArray(v.players) && v.players.every((p) => p && Object.hasOwn(p, 'fieldId') && Object.hasOwn(p, 'name'));
}

/** publicView() without its transport/marker fields: what a mirror holds of a full frame. */
function viewOf(full) {
  const { t, full: marker, ...rest } = full;
  return rest;
}

/**
 * The merge-fidelity check (see the header FINDING) — `assertMirrorAgrees` below. The frames a recipient actually
 * receives come from `recipientStream` (below), which models the lobby's per-recipient routing.
 */

/**
 * The merge-fidelity check (see the header FINDING): the mirror must agree with the server's fresh full view on
 * every key the full view publishes (nothing erased, constants included). For the pockets the compact frame clears
 * with an explicit null (views.js COMPACT_NULL_POCKETS) an absent key in the full view is equivalent to null in the
 * mirror - the merge never removes a key - and no pocket key may survive as a stale non-null value. The same
 * equivalence applies per player for the cleared optional keys a per-player merge keeps as null (NULLED_PLAYER_KEYS,
 * step ④). Returns the extra keys, for the caller to report.
 */
function assertMirrorAgrees(mirror, full, frames) {
  const want = viewOf(full);
  const missing = Object.keys(want).filter((k) => !Object.hasOwn(mirror, k));
  assert.deepEqual(missing, [], 'a compact frame erased a key the full view publishes');
  // No pocket key may survive as a stale non-null value: a pocket the full view does not publish is null (the
  // cleared form the compact frames carry) or absent in the mirror; a published pocket must agree.
  for (const k of PHASE_POCKETS) {
    const published = Object.hasOwn(want, k) && want[k] != null;
    if (published) {
      assert.ok(Object.hasOwn(mirror, k), `the full view publishes ${k}; the compact stream must keep the mirror current`);
      assert.deepEqual(mirror[k], want[k], `mirror.${k} === publicView().${k}`);
    } else {
      assert.ok(!Object.hasOwn(mirror, k) || mirror[k] == null, `a stale pocket survived the merge: ${k} = ${JSON.stringify(mirror[k])}`);
    }
  }
  const extras = Object.keys(mirror).filter((k) => !Object.hasOwn(want, k));
  const pruned = { ...mirror };
  for (const k of extras) delete pruned[k];
  // a per-player merge keeps `key: null` where the full view omits the key (NULLED_PLAYER_KEYS): equivalent
  pruned.players = Array.isArray(pruned.players)
    ? pruned.players.map((p) => {
      const q = { ...p };
      for (const k of NULLED_PLAYER_KEYS) if (q[k] == null) delete q[k];
      return q;
    })
    : pruned.players;
  assert.deepEqual(pruned, want, 'the mirror deep-equals publicView() (full) once the pockets it kept on top are dropped');
  for (const k of extras) {
    assert.ok(PHASE_POCKETS.has(k), `the merge kept an unexpected key: ${k}`);
    assert.ok(frames.some((f) => Object.hasOwn(payload(f), k)), `the mirror only keeps keys the wire carried: ${k}`);
  }
  return extras;
}

/** The ten constants survived the compact stream (the point of the baseline + merge protocol). */
function assertConstantsSurvive(mirror, full) {
  for (const k of CONSTANTS) {
    assert.ok(Object.hasOwn(mirror, k), `the constants survive the compact stream: ${k}`);
    assert.deepEqual(mirror[k], full[k], `mirror.${k} === publicView().${k}`);
  }
}

/** Every hot frame on the wire is compact: none of the ten constants, never the `full: true` marker, hot state intact. */
function assertCompactFrames(h) {
  const hot = h.bc.filter((msg) => msg.t === 'm.public');
  assert.ok(hot.length >= 1, 'hot frames were broadcast');
  for (const f of hot) {
    assert.equal('full' in f, false, 'a hot frame never carries the baseline marker');
    for (const k of CONSTANTS) assert.equal(k in f, false, `a hot frame never carries the constant ${k}`);
    for (const k of HOT) assert.ok(Object.hasOwn(f, k), `the hot frame carries the hot key ${k}`);
  }
}

test('a baseline carries the ten per-match constants; the hot frame drops exactly them and keeps the hot state', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 71, fake: true }).start();
  const m = h.m;
  const full = m.publicView();
  assert.equal(full.full, true, 'publicView() defaults to the baseline');
  for (const k of CONSTANTS) assert.ok(Object.hasOwn(full, k), `the full view carries ${k}`);
  const compact = m.publicView({ full: false });
  assert.equal('full' in compact, false, 'a compact frame has no baseline marker');
  for (const k of CONSTANTS) assert.equal(k in compact, false, `the compact view drops ${k}`);
  for (const k of HOT) assert.ok(Object.hasOwn(compact, k), `the compact view still carries the hot key ${k}`);
  // on the wire: every human's first m.public is the baseline (start() -> baselinePublic), the broadcast is compact
  for (const pid of ['p_0', 'p_1']) {
    const first = h.allTo(pid, 'm.public')[0];
    assert.ok(first && first.full === true, `${pid}'s first m.public is the baseline`);
    for (const k of CONSTANTS) assert.ok(Object.hasOwn(first, k), `the baseline carries ${k}`);
  }
  assertCompactFrames(h);
  m.dispose();
});

test('a unite round: a hot frame carries helpers/leakers, the merge keeps them and the constants', () => {
  let ran = 0;
  const h = makeMatch({
    mode: 'coop', humans: 3, seed: 9111, fake: true, clientCombat: true,
    // the normal battles leak for p_0 only -> planUnite gives the two perfect players the unite field (server/match/unite.js)
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 4 } } : {}),
    // the unite spec runs the REAL sim on the authority client, like test/match/hud-capsule-resolved.test.js
    perPlayer: Object.fromEntries(['p_0', 'p_1', 'p_2'].map((pid) => [pid, {
      tamper: (result, spec) => {
        if (spec.kind !== 'unite') return result;
        ran++;
        const b = createBattleFromSpec(spec, h.m.ds, { recordEvents: false, quiet: true });
        return compactResult(b.runToEnd(4000));
      },
    }])),
  });
  const frames = recipientStream(h, 'p_0', { full: false, bonds: true, delta: true });
  const m = h.m;
  h.start();
  const unite = () => m.fields.find((f) => f.fieldId === 'u');
  h.drive(() => (unite() && unite().done) || h.ended != null);
  assert.equal(m.phase, PHASE.UNITE, 'the match is in the unite phase (the settle of the finished field is delayed)');
  assert.ok(ran > 0, 'the unite field ran the real sim for its authority');
  assert.deepEqual(m.unitePlan.helpers.map((p) => p.playerId), ['p_1', 'p_2']);
  assert.deepEqual(m.unitePlan.leakers.map((p) => p.playerId), ['p_0']);
  // 4. the hot frames of the UNITE phase carry the plan
  const uniteFrames = h.bc.filter((msg) => msg.t === 'm.public' && msg.phase === PHASE.UNITE);
  assert.ok(uniteFrames.length >= 1, 'a hot frame landed in the unite phase');
  for (const f of uniteFrames) assert.deepEqual(f.unite, { helpers: ['p_1', 'p_2'], leakers: ['p_0'] });
  assertCompactFrames(h);
  const phases = new Set(h.bc.filter((msg) => msg.t === 'm.public').map((msg) => msg.phase));
  for (const p of ['PREP', 'COMBAT', PHASE.UNITE]) assert.ok(phases.has(p), `a hot frame landed in ${p}`);
  // the state the mirror is compared against: a final frame of the same match state (flush does not advance the clock)
  m.flush(true);
  const last = h.bc[h.bc.length - 1];
  assert.equal(last.t, 'm.public');
  assert.equal(last.phase, PHASE.UNITE);
  assert.deepEqual(last.unite, { helpers: ['p_1', 'p_2'], leakers: ['p_0'] });
  const uniteField = last.fields.find((f) => f.fieldId === 'u');
  assert.equal(uniteField.kind, 'unite');
  assert.deepEqual(uniteField.players, ['p_1', 'p_2']);
  assert.equal(uniteField.live, false, 'the field finished (the frame keeps its capsule progress)');
  // 3. the client's exact merge over every frame it received (baseline + per-recipient hot frames, recipientStream)
  let mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  const full = m.publicView();
  assertMirrorAgrees(mirror.public, full, frames);
  assertConstantsSurvive(mirror.public, full);
  // 4. after the merge the mirror still has the unite plan
  assert.ok(Object.hasOwn(mirror.public, 'unite'), 'the merge keeps the unite plan');
  assert.deepEqual(mirror.public.unite, full.unite);
  m.dispose();
});

test('an ended unite pocket is cleared: the later SETTLE without a unite carries uniteResult: null and the mirror drops it', () => {
  // The stale-box regression (views.js COMPACT_NULL_POCKETS): the client's merge never removes a key, so an ended
  // pocket would stay in the mirror and public/js/screens/game.js reads `pub?.uniteResult` at every SETTLE
  // (battleOverSfx / uniteResultBox) - a later SETTLE without a unite would pop the PREVIOUS unite's box and sound.
  // Drive the same 3-human unite round as above, but leak in R1 only: R2's combats are all perfect, so no unite
  // resolves and its SETTLE must clear the pocket.
  let ran = 0;
  const h = makeMatch({
    mode: 'coop', humans: 3, seed: 9111, fake: true, clientCombat: true,
    script: (b) => (b.kind === 'normal' && b.round === 1 ? { leaks: { p_0: 4 } } : {}),
    perPlayer: Object.fromEntries(['p_0', 'p_1', 'p_2'].map((pid) => [pid, {
      tamper: (result, spec) => {
        if (spec.kind !== 'unite') return result;
        ran++;
        const b = createBattleFromSpec(spec, h.m.ds, { recordEvents: false, quiet: true });
        return compactResult(b.runToEnd(4000));
      },
    }])),
  });
  let frames = recipientStream(h, 'p_0', { full: false, bonds: true, delta: true });
  const m = h.m;
  h.start();
  const unite = () => m.fields.find((f) => f.fieldId === 'u');
  h.drive(() => (unite() && unite().done) || h.ended != null);
  assert.equal(m.phase, PHASE.UNITE, 'the match is in the unite phase');
  assert.ok(ran > 0, 'the unite field ran the real sim for its authority');
  // R1 SETTLE: the unite resolved, the compact frame carries the result and the mirror holds it
  h.drive(() => m.phase === PHASE.SETTLE || h.ended != null);
  assert.equal(m.phase, PHASE.SETTLE);
  assert.equal(m.round, 1);
  assert.ok(m.uniteResultView, 'the round-1 SETTLE view carries the unite outcome');
  m.flush(true);
  const uniteSettle = h.bc[h.bc.length - 1];
  assert.equal(uniteSettle.t, 'm.public');
  assert.equal(uniteSettle.phase, PHASE.SETTLE);
  assert.ok(uniteSettle.uniteResult && uniteSettle.uniteResult.losses.p_0 > 0, 'the compact SETTLE frame carries the unite result');
  let mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  assert.deepEqual(mirror.public.uniteResult, uniteSettle.uniteResult, 'the mirror holds the round-1 unite result');
  assertMirrorAgrees(mirror.public, m.publicView(), frames);
  // continue to a LATER SETTLE that resolves no unite: no leak in R2, so no leakers and planUnite gives no field
  h.drive(() => (m.phase === PHASE.SETTLE && m.round >= 2) || h.ended != null);
  assert.ok(h.ended == null, 'the match is still running');
  assert.equal(m.phase, PHASE.SETTLE);
  assert.ok(m.round > 1, 'the later SETTLE is a later round');
  assert.equal(m.uniteResultView, null, 'no unite resolved this round');
  m.flush(true);
  const later = h.bc[h.bc.length - 1];
  assert.equal(later.t, 'm.public');
  assert.equal(later.phase, PHASE.SETTLE);
  assert.ok(Object.hasOwn(later, 'uniteResult'), 'the compact frame carries the cleared pocket as an explicit null');
  assert.equal(later.uniteResult, null);
  for (const k of NULLED_POCKETS) assert.ok(Object.hasOwn(later, k), `every compact frame carries the pocket key ${k}`);
  // 7. the client's exact merge over every frame it received: the ended pocket is cleared, not kept
  mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  assert.ok(!Object.hasOwn(mirror.public, 'uniteResult') || mirror.public.uniteResult == null,
    `the merged mirror cleared the stale uniteResult (got ${JSON.stringify(mirror.public.uniteResult)})`);
  const full = m.publicView();
  assert.equal(Object.hasOwn(full, 'uniteResult'), false, 'the fresh full view still omits the pocket (its key set is unchanged)');
  assertMirrorAgrees(mirror.public, full, frames);
  assertConstantsSurvive(mirror.public, full);
  m.dispose();
});

test('the boss pair and the hidden round: the hot frame names the field and its pool, bossId/hiddenBossId survive the merge', () => {
  // "the boss does not show" regression guard: m.public.fields carries only { fieldId, kind, players, live, progress };
  // the field's units ride the unicast b.start spec. The client can render the boss field only if the hot frame still
  // names it (kind 'boss' / 'hidden') and the baseline's bossId / hiddenBossId survive in the mirror - otherwise the
  // leader has no id to look up. This test pins both halves on a real 2-human pair.
  const h = makeMatch({
    mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 52, fake: true, clientCombat: true,
    script: (b) => (b.kind === 'boss' || b.kind === 'hidden' ? { bossDps: 1e9 } : {}),
  });
  let frames = recipientStream(h, 'p_0', { full: false, bonds: true, delta: true });
  const m = h.m;
  h.start();
  h.autoHumans();
  const fill = (ps) => {
    const id = chessOfTier(1).find((x) => m.pool.has(x));
    const tile = legalTileFor(m, ps, id);
    if (tile) give(m, ps, id, 'board', tile);
  };
  h.drive(() => m.phase === PHASE.PREP && m.round === 14);
  for (const ps of m.players.values()) if (ps.alive) fill(ps);
  // the hidden core's eligibility recipe (test/match/finalAssault.test.js): bond layers > 1200 at the end of the prep
  for (const ps of m.players.values()) { ps.bondCountBonus.yanShip = 3; ps.layers.yanShip = 601; ps.recompute(); }
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  m.flush(true);
  const bossFrame = h.bc[h.bc.length - 1];
  assert.equal(bossFrame.t, 'm.public');
  assert.equal(bossFrame.phase, PHASE.FINAL_ASSAULT);
  const bossField = bossFrame.fields.find((f) => f.kind === 'boss');
  assert.ok(bossField, 'the compact frame names the boss field');
  assert.equal(bossField.fieldId, 'b1');
  assert.deepEqual(bossField.players, ['p_0', 'p_1'], 'both players of the pair');
  assert.equal(bossField.live, true);
  assert.deepEqual(bossFrame.bossHp, { hp: Math.round(m.bossPool.hp), max: Math.round(m.bossPool.maxHp) }, 'the shared pool travels compactly');
  assert.equal(bossFrame.teamLp, Math.max(0, Math.round(m.teamLp)), 'the merged team LP travels compactly');
  assert.equal(bossFrame.bossRound, m.gd.bossRound);
  // the boss field's units, on the frame the client simulates it from
  const bossStart = h.sent.map(([, x]) => x).find((x) => x.t === 'b.start' && x.fieldId === 'b1');
  assert.ok(bossStart, 'the boss field spec reached the seat');
  assert.equal(bossStart.kind, 'boss');
  assert.equal(bossStart.spec.bossId, m.bossId);
  assert.ok(bossStart.spec.players.every((p) => p.units.length >= 1), 'the boss field carries its units');
  assert.ok(bossStart.spec.spawns.some((s) => s.tag === 'boss'), 'and the leader spawn');
  assertCompactFrames(h);
  // 3. merge fidelity at the boss round
  let mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  let full = m.publicView();
  assertMirrorAgrees(mirror.public, full, frames);
  assertConstantsSurvive(mirror.public, full);
  assert.equal(mirror.public.bossId, m.bossId, 'after the merge the mirror still exposes bossId');
  assert.equal(mirror.public.hiddenBossId, m.hiddenBossId, 'and the not-yet-reached hidden round leader');
  // the hidden round: the same pairing, kind 'hidden'
  h.drive(() => m.phase === PHASE.PREP && m.round === 15);
  for (const ps of m.players.values()) if (ps.alive) fill(ps);
  h.drive(() => m.phase === PHASE.HIDDEN_CORE);
  m.flush(true);
  const hiddenFrame = h.bc[h.bc.length - 1];
  assert.equal(hiddenFrame.phase, PHASE.HIDDEN_CORE);
  const hiddenField = hiddenFrame.fields.find((f) => f.kind === 'hidden');
  assert.ok(hiddenField, 'the compact frame names the hidden field');
  assert.deepEqual(hiddenField.players, ['p_0', 'p_1']);
  assert.deepEqual(hiddenFrame.bossHp, { hp: Math.round(m.bossPool.hp), max: Math.round(m.bossPool.maxHp) }, 'one pool across both rounds');
  const hiddenStart = h.sent.map(([, x]) => x).filter((x) => x.t === 'b.start' && x.kind === 'hidden').pop();
  assert.ok(hiddenStart, 'the hidden field spec reached the seat');
  assert.equal(hiddenStart.spec.bossId, m.hiddenBossId, 'the hidden leader is the one the baseline named');
  assert.ok(hiddenStart.spec.players.every((p) => p.units.length >= 1), 'the hidden field carries its units');
  mirror = null;
  for (const f of frames) mirror = mergePublic(mirror, f);
  full = m.publicView();
  assertMirrorAgrees(mirror.public, full, frames);
  assert.equal(mirror.public.hiddenBossId, m.hiddenBossId, 'the mirror still exposes hiddenBossId in the hidden round');
  m.dispose();
});

test('capability routing: a session without hello.pub gets the full encoding, pubCap > 0 the compact one', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 72, fake: true }).start();
  const match = h.m;
  // net.js `hello` sets session.pubCap = Number.isInteger(msg.pub) && msg.pub > 0 ? msg.pub : 0; sendRaw needs an
  // OPEN socket ({ readyState: 1, bufferedAmount, send }) — a recording stub stands in for the ws.
  const socket = (out) => ({ readyState: 1, bufferedAmount: 0, send: (data) => { out.push(data); } });
  const session = (playerId, pubCap, out, extra = {}) => ({ playerId, pubCap, connected: true, roomCode: 'TEST', ws: socket(out), ...extra });
  const frames = { p_0: [], p_1: [] };
  const sessions = new Map([['p_0', session('p_0', 0, frames.p_0)], ['p_1', session('p_1', 1, frames.p_1)]]);
  const errors = [];
  const lobby = new Lobby({
    registry: { byId: (id) => sessions.get(id) },
    now: () => 0,
    getData: () => DATA,
    log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
  });
  const room = new Room('TEST', 'coop', 'NORMAL', 0);
  room.seats[0] = { seat: 0, playerId: 'p_0', name: 'P0', isBot: false, ready: true, connected: true, left: false };
  room.seats[1] = { seat: 1, playerId: 'p_1', name: 'P1', isBot: false, ready: true, connected: true, left: false };
  lobby.rooms.set(room.code, room); // routeGame resolves the room through the registry (the other assertions call the seams directly)
  const ctx = { live: true, ended: false, disposed: false, match, lastPublic: null, lastPublicFull: null, sharedResult: null, results: new Map() };
  const compact = match.publicView({ full: false });
  lobby.matchBroadcast(room, ctx, compact);
  assert.equal(frames.p_0.length, 1, 'the non-capable session is sent one frame');
  assert.equal(frames.p_1.length, 1, 'the capable session is sent one frame');
  const fullFallback = JSON.parse(frames.p_0[0]);
  const compactFrame = JSON.parse(frames.p_1[0]);
  for (const k of CONSTANTS) {
    assert.ok(Object.hasOwn(fullFallback, k), `the session without hello.pub gets the full encoding: ${k}`);
    assert.equal(k in compactFrame, false, `the capable session gets the compact encoding: no ${k}`);
  }
  assert.equal(fullFallback.full, true, 'the fallback is a baseline: publicView() keeps its marker, so a client that does merge resets on it');
  assert.deepEqual(fullFallback, match.publicView(), 'exactly the full view (what baselinePublic sends)');
  assert.deepEqual(compactFrame, compact, 'exactly the compact hot frame');
  for (const k of HOT) assert.ok(Object.hasOwn(compactFrame, k), `the compact frame keeps ${k}`);
  assert.equal(ctx.lastPublic, frames.p_1[0], 'the replay record holds the compact frame');
  assert.equal(ctx.lastPublicFull, frames.p_0[0], 'and the full one for a session that cannot merge');
  // the result replay a resume gets follows the same routing (lobby.replayFor)
  ctx.results.set('p_0', '{"t":"m.result","playerId":"p_0"}');
  ctx.results.set('p_1', '{"t":"m.result","playerId":"p_1"}');
  room.replay = lobby.buildReplay(room, ctx);
  assert.equal(lobby.replayFor(room, 'p_0')[0], ctx.lastPublicFull, 'a resume replay for the non-capable session is the full frame');
  assert.equal(lobby.replayFor(room, 'p_1')[0], ctx.lastPublic, 'for the capable one, the compact frame');
  // an all-capable room never pays for the full frame (matchBroadcast builds it only when a session needs it)
  const capFrames = { p_0: [], p_1: [] };
  sessions.set('p_0', session('p_0', 1, capFrames.p_0));
  sessions.set('p_1', session('p_1', 1, capFrames.p_1));
  const ctx2 = { live: true, ended: false, disposed: false, match, lastPublic: null, lastPublicFull: null, sharedResult: null, results: new Map() };
  lobby.matchBroadcast(room, ctx2, compact);
  assert.equal(ctx2.lastPublicFull, null, 'no session needs the full frame: none is built');
  for (const pid of ['p_0', 'p_1']) assert.deepEqual(JSON.parse(capFrames[pid][0]), compact, `${pid} gets the compact frame`);
  // step ③: a session that declared hello.pubBonds gets its OWN frame — the players its screen cannot show are stripped
  // (this room is in INFO_CHECK: no field, no watch, so each seat's screen shows its own board and only its own bonds).
  const bondFrames = { p_0: [], p_1: [] };
  sessions.set('p_0', session('p_0', 0, bondFrames.p_0));
  sessions.set('p_1', session('p_1', 1, bondFrames.p_1, { pubBonds: 1 }));
  const ctx3 = { live: true, ended: false, disposed: false, match, lastPublic: null, lastPublicFull: null, sharedResult: null, results: new Map() };
  lobby.matchBroadcast(room, ctx3, compact);
  const bondRow = (v, pid) => v.players.find((p) => p.playerId === pid);
  const perBond = JSON.parse(bondFrames.p_1[0]);
  assert.deepEqual(bondRow(perBond, 'p_1').bonds, bondRow(compact, 'p_1').bonds, 'the recipient keeps the bonds of the player on its screen');
  assert.deepEqual(bondRow(perBond, 'p_0').bonds, [], 'every other player\'s bonds travel as an explicit empty list');
  assert.deepEqual(bondRow(JSON.parse(bondFrames.p_0[0]), 'p_1').bonds, bondRow(match.publicView(), 'p_1').bonds, 'a session without the capability keeps all bonds (full frame)');
  assert.deepEqual(JSON.parse(ctx3.lastPublic), compact, 'the replay record stays the complete compact frame (per-recipient frames could not stand alone)');
  assert.equal(ctx3.lastPublicFull, bondFrames.p_0[0], 'the non-capable session got the full frame');
  // the lobby only routes g.bonds for a session that declared hello.pubBonds (step ③ admission) — an old client that
  // somehow sends the type is refused, a capable one reaches the match and gets its m.bonds unicast (the test match's
  // own send path records those in h.sent, as it does for every unicast frame)
  room.match = match;
  const plain = sessions.get('p_0');
  assert.equal(lobby.routeGame(plain, { t: 'g.bonds', playerId: 'p_1' }).error, ERR.BAD_MSG, 'g.bonds without hello.pubBonds is refused');
  const capable = sessions.get('p_1');
  const bondAnswers = () => h.sent.filter(([, msg]) => msg.t === 'm.bonds');
  const before = bondAnswers().length;
  assert.ok(lobby.routeGame(capable, { t: 'g.bonds', playerId: 'p_0' }).ok, 'a capable session reaches the match');
  const after = bondAnswers();
  assert.equal(after.length, before + 1, 'and gets exactly one answer');
  assert.deepEqual(after[after.length - 1], ['p_1', { t: 'm.bonds', playerId: 'p_0', bonds: bondRow(match.publicView(), 'p_0').bonds }], 'the answer is players[].bonds\' own payload');
  // step ④: with the match in delta mode the same state produces NOTHING for a delta-capable session (an empty delta
  // sends no frame at all) while a session that cannot merge still receives the full frame every time
  const deltaFrames = { p_0: [], p_1: [] };
  sessions.set('p_0', session('p_0', 0, deltaFrames.p_0));
  sessions.set('p_1', session('p_1', 1, deltaFrames.p_1, { pubBonds: 1, pubDelta: 1 }));
  match.pubSync = 'delta';
  const ctx4 = { live: true, ended: false, disposed: false, match, lastPublic: null, lastPublicFull: null, sharedResult: null, results: new Map() };
  lobby.matchBroadcast(room, ctx4, compact);
  assert.equal(deltaFrames.p_1.length, 1, 'the first frame is a delta against the chain (the start baseline seeded it)');
  const deltaFrame = JSON.parse(deltaFrames.p_1[0]);
  assert.equal(deltaFrame.t, 'm.public', 'a delta is a m.public frame');
  assert.ok(!isCompleteFrame(deltaFrame), 'and it is partial (only what changed)');
  assert.deepEqual(JSON.parse(ctx4.lastPublic), compact, 'the replay record still holds the complete compact frame');
  lobby.matchBroadcast(room, ctx4, compact);
  assert.equal(deltaFrames.p_1.length, 1, 'an empty delta is not sent at all');
  assert.equal(deltaFrames.p_0.length, 2, 'the non-capable session still gets the full frame every broadcast');
  match.pubSync = 'full';
  assert.deepEqual(errors, [], 'the broadcast path did not report an error');
  match.dispose();
});

test('step ③: in a shared field both halves keep their bonds, the leaker\'s own list travels as []; baseline and plain frames are untouched', () => {
  // A 3-human unite round with a real board (same recipe as the test above plus one chess per prep): p_0 leaks, p_1 and
  // p_2 hold the 联防 field 'u'. The doc's unit of the strip is 1–2 players — a shared field shows both halves' units,
  // so BOTH helpers' bonds must stay while the leaker's own (not on screen) travels as an explicit [].
  let ran = 0;
  const h = makeMatch({
    mode: 'coop', humans: 3, seed: 9111, fake: true, clientCombat: true,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 4 } } : {}),
    perPlayer: Object.fromEntries(['p_0', 'p_1', 'p_2'].map((pid) => [pid, {
      tamper: (result, spec) => {
        if (spec.kind !== 'unite') return result;
        ran++;
        const b = createBattleFromSpec(spec, h.m.ds, { recordEvents: false, quiet: true });
        return compactResult(b.runToEnd(4000));
      },
    }])),
  }).start();
  const m = h.m;
  h.autoHumans();
  const fill = (ps) => {
    const id = chessOfTier(1).find((x) => m.pool.has(x));
    const tile = legalTileFor(m, ps, id);
    if (tile) give(m, ps, id, 'board', tile);
  };
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  for (const ps of m.players.values()) if (ps.alive) fill(ps);
  const unite = () => m.fields.find((f) => f.fieldId === 'u');
  h.drive(() => (unite() && unite().done) || h.ended != null);
  assert.equal(m.phase, PHASE.UNITE, 'the match is in the unite phase');
  assert.ok(ran > 0, 'the unite field ran the real sim for its authority');
  assert.equal(m.watchers.get('p_0'), 'u', 'the leaker is shown the unite field');
  const full = m.publicView();
  const plain = m.publicView({ full: false });
  const row = (v, pid) => v.players.find((p) => p.playerId === pid);
  // no capability field / an old client: the shared frame, content-identical to publicView({ full: false })
  assert.deepEqual(m.publicViewFor('p_0', { full: false }), plain, 'without hello.pubBonds the frame is the shared compact one');
  assert.deepEqual(m.publicViewFor('p_0', { full: false, bonds: false }), plain, 'and so is a declared-but-off strip');
  // the strip: both helpers (the shared field on screen) keep everything, the leaker's own list travels as []
  const per = m.publicViewFor('p_0', { full: false, bonds: true });
  assert.deepEqual(per.unite, plain.unite, 'the unite plan is untouched');
  for (const pid of ['p_1', 'p_2']) assert.deepEqual(row(per, pid).bonds, row(full, pid).bonds, `helper ${pid} keeps its bonds (the shared field shows its half)`);
  assert.deepEqual(row(per, 'p_0').bonds, [], 'the bond list of the player not on screen travels as an explicit empty list');
  assert.ok(row(full, 'p_1').bonds.length + row(full, 'p_2').bonds.length > 0, 'the helpers actually carry bonds (the field the doc measured at ~2/3 of the frame)');
  // nothing but the bonds changed: strip the lists from both frames and they are equal
  const noBonds = (v) => JSON.parse(JSON.stringify({ ...v, players: v.players.map((p) => ({ ...p, bonds: null })) }));
  assert.deepEqual(noBonds(per), noBonds(plain), 'the per-recipient frame differs from the shared one only in players[].bonds');
  // a helper's own frame: both halves stay (it is on the field itself) — per-recipient divergence on the same frame
  const helperFrame = m.publicViewFor('p_1', { full: false, bonds: true });
  assert.deepEqual(row(helperFrame, 'p_1').bonds, row(full, 'p_1').bonds);
  assert.deepEqual(row(helperFrame, 'p_2').bonds, row(full, 'p_2').bonds);
  assert.deepEqual(row(helperFrame, 'p_0').bonds, []);
  assert.deepEqual(noBonds(helperFrame), noBonds(per), 'both recipients get the same frame except their bond lists');
  // the baseline is never stripped: a client that cannot ask (no g.bonds) must still receive every list
  const base = m.publicViewFor('p_0', { full: true, bonds: true });
  assert.equal(base.full, true);
  for (const pid of ['p_0', 'p_1', 'p_2']) assert.deepEqual(row(base, pid).bonds, row(full, pid).bonds, `the baseline keeps ${pid}'s bonds`);
  m.dispose();
});

test('step ③: the strip follows the watched player, keeps its list through SETTLE (watchers cleared) and never touches an old client', () => {
  // A normal round (server-run combat via the fake battle) with one chess per player, so players[].bonds really carries
  // data. Walks the whole lifecycle the doc calls out: the own field -> a watched teammate -> the SETTLE after the
  // watcher map was cleared (the remembered scope must keep the watched player's bonds for the result box).
  const h = makeMatch({ mode: 'coop', humans: 3, seed: 42, fake: true }).start();
  const m = h.m;
  h.autoHumans();
  const fill = (ps) => {
    const id = chessOfTier(1).find((x) => m.pool.has(x));
    const tile = legalTileFor(m, ps, id);
    if (tile) give(m, ps, id, 'board', tile);
  };
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  for (const ps of m.players.values()) if (ps.alive) fill(ps);
  h.drive(() => m.phase === PHASE.COMBAT || h.ended != null);
  assert.equal(m.phase, PHASE.COMBAT, 'the normal round reached COMBAT');
  const full = m.publicView();
  const row = (v, pid) => v.players.find((p) => p.playerId === pid);
  for (const pid of ['p_0', 'p_1', 'p_2']) assert.ok(row(full, pid).bonds.length > 0, `${pid} carries bonds (the strip has something to strip)`);
  assert.equal(m.watchers.get('p_0'), 'n:p_0', 'a fighting player is shown its own field');
  // the own field: only its own list survives (1 player — the doc's 普通场)
  const own = m.publicViewFor('p_0', { full: false, bonds: true });
  assert.deepEqual(row(own, 'p_0').bonds, row(full, 'p_0').bonds);
  assert.deepEqual(row(own, 'p_1').bonds, []);
  assert.deepEqual(row(own, 'p_2').bonds, []);
  // 前往查看 a teammate: the watched player's list replaces the own one — the same broadcast, another recipient
  assert.ok(m.handle('p_0', { t: 'g.watch', fieldId: 'n:p_1', playerId: 'p_1' }).ok, 'watching a teammate is accepted');
  assert.equal(m.watchers.get('p_0'), 'n:p_1');
  const watched = m.publicViewFor('p_0', { full: false, bonds: true });
  assert.deepEqual(row(watched, 'p_1').bonds, row(full, 'p_1').bonds, 'the watched teammate keeps its bonds');
  assert.deepEqual(row(watched, 'p_0').bonds, [], 'the own list is stripped while the screen shows the teammate');
  const other = m.publicViewFor('p_1', { full: false, bonds: true });
  assert.deepEqual(row(other, 'p_1').bonds, row(full, 'p_1').bonds, 'p_1\'s own frame still keeps p_1 (per-recipient divergence)');
  assert.deepEqual(row(other, 'p_0').bonds, []);
  // SETTLE: settle.js clears watchers; the remembered scope keeps the watched player's list for the result screen
  h.drive(() => m.phase === PHASE.SETTLE || h.ended != null);
  assert.equal(m.phase, PHASE.SETTLE, 'the round reached SETTLE');
  assert.equal(m.watchers.size, 0, 'the watcher map is cleared at settle');
  const settle = m.publicViewFor('p_0', { full: false, bonds: true });
  assert.deepEqual(row(settle, 'p_1').bonds, m.publicView().players.find((p) => p.playerId === 'p_1').bonds, 'the remembered scope keeps the watched player\'s bonds at SETTLE');
  assert.deepEqual(row(settle, 'p_0').bonds, []);
  // an old client / no capability on the same state: the shared compact frame, untouched
  assert.deepEqual(m.publicViewFor('p_0', { full: false }), m.publicView({ full: false }), 'a client without hello.pubBonds gets exactly the shared frame');
  m.dispose();
});

test('step ③: g.bonds answers one m.bonds to the requester — a player seat or a spectator seat; unknown ids are refused', () => {
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 77, fake: true, spectators: ['s_1'] }).start();
  const m = h.m;
  assert.equal(validateC2S({ t: 'g.bonds', playerId: 'p_1' }), null, 'g.bonds validates');
  assert.equal(validateC2S({ t: 'g.bonds' }), 'bad field playerId', 'the player id is required');
  assert.equal(validateC2S({ t: 'g.bonds', playerId: 42 }), 'bad field playerId', 'and must be an id');
  assert.ok(S2C.includes('m.bonds'), 'm.bonds is documented in the S2C catalogue');
  assert.equal(validateC2S({ t: 'hello', name: 'x', pub: 1, pubBonds: 1, pubDelta: 1 }), null, 'the new hello capabilities stay optional and valid');
  const want = m.publicView().players.find((p) => p.playerId === 'p_1').bonds;
  assert.ok(m.handle('p_0', { t: 'g.bonds', playerId: 'p_1' }).ok, 'a player seat may ask');
  const answer = h.sent.filter(([pid, msg]) => pid === 'p_0' && msg.t === 'm.bonds').pop();
  assert.deepEqual(answer && answer[1], { t: 'm.bonds', playerId: 'p_1', bonds: want }, 'the answer is players[].bonds\' own payload, unicast');
  assert.equal(m.handle('p_0', { t: 'g.bonds', playerId: 'nobody' }).error, ERR.BAD_TARGET, 'an unknown player is refused');
  assert.equal(h.sent.filter(([, msg]) => msg.t === 'm.bonds').length, 1, 'a refusal sends nothing');
  // a spectator seat watches like an eliminated player: its popups read the same mirror entry, so it may ask too
  assert.ok(m.handle('s_1', { t: 'g.bonds', playerId: 'p_0' }).ok, 'a spectator seat may ask');
  const toSpectator = h.sent.filter(([pid, msg]) => pid === 's_1' && msg.t === 'm.bonds');
  assert.equal(toSpectator.length, 1, 'exactly one answer to the spectator');
  assert.deepEqual(toSpectator[0][1].bonds, m.publicView().players.find((p) => p.playerId === 'p_0').bonds);
  m.dispose();
});

/**
 * The unite-round recipe the step-④ tests share: 3 humans, one chess each, p_0 leaks in R1 so a real unite round runs
 * (the same scenario as the earlier tests; `h.autoHumans()` + fillBoards drive it).
 */
function makeUniteMatch(extra = {}) {
  const h = makeMatch({
    mode: 'coop', humans: 3, seed: 9111, fake: true, clientCombat: true,
    script: (b) => (b.kind === 'normal' ? { leaks: { p_0: 4 } } : {}),
    perPlayer: Object.fromEntries(['p_0', 'p_1', 'p_2'].map((pid) => [pid, {
      tamper: (result, spec) => {
        if (spec.kind !== 'unite') return result;
        const b = createBattleFromSpec(spec, h.m.ds, { recordEvents: false, quiet: true });
        return compactResult(b.runToEnd(4000));
      },
    }])),
    ...extra,
  });
  return h;
}

/** One tier-1 chess on every living player's board, at the first PREP (bonds with members: the strip needs data). */
function fillBoards(h) {
  const m = h.m;
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  for (const ps of m.players.values()) {
    if (!ps.alive) continue;
    const id = chessOfTier(1).find((x) => m.pool.has(x));
    const tile = legalTileFor(m, ps, id);
    if (tile) give(m, ps, id, 'board', tile);
  }
}

test('step ④: a delta hot frame carries only what changed, merges per player, and the full anchor lands every N frames', () => {
  const h = makeUniteMatch({ pubSync: 'delta', pubAnchorFrames: 4, pubAnchorMs: 1e12 });
  const m = h.m;
  // delta mechanics only (bonds off): the strip's own equivalence (an off-screen list is [] by design) is the ③ tests'
  const stream = recipientStream(h, 'p_0', { full: false, delta: true });
  h.start();
  h.autoHumans();
  fillBoards(h);
  const unite = () => m.fields.find((f) => f.fieldId === 'u');
  h.drive(() => (unite() && unite().done) || h.ended != null);
  assert.ok(m.phase === PHASE.UNITE || m.phase === PHASE.SETTLE, `the unite round ran (phase ${m.phase})`);
  assert.ok(stream.length >= 6, `a delta stream was recorded (${stream.length} frames)`);
  const baseIdx = stream.findIndex((v) => v.full === true);
  assert.ok(baseIdx >= 0, 'the stream carries the baseline (the reset point of the delta chain)');
  const partials = stream.slice(baseIdx + 1).filter((v) => !isCompleteFrame(v));
  assert.ok(partials.length >= 3, `delta frames went out (got ${partials.length} of ${stream.length - 1})`);
  assert.ok(partials.some((v) => !Object.hasOwn(v, 'fields')), 'a delta omitted an unchanged top-level key (fields)');
  assert.ok(partials.some((v) => Array.isArray(v.players) && v.players.some((p) => p && p.playerId && !Object.hasOwn(p, 'name'))), 'players[] is diffed per player (unchanged keys omitted)');
  // the client's exact merge over [baseline, ...deltas] restores the current full view, constants included
  m.flush(true); // a final frame of the same match state (flush does not advance the clock)
  let mirror = null;
  for (const f of stream) mirror = mergePublic(mirror, f);
  const full = m.publicView();
  assertMirrorAgrees(mirror.public, full, stream);
  assertConstantsSurvive(mirror.public, full);
  // the anchor: complete frames (the baseline included) are at most pubAnchorFrames + 1 apart
  const idx = stream.map((v, i) => (isCompleteFrame(v) ? i : -1)).filter((i) => i >= 0);
  assert.ok(idx.length >= 2, `at least one anchor besides the baseline (${idx.length} complete frames)`);
  const gaps = idx.map((i, k) => (k ? i - idx[k - 1] : i));
  assert.ok(Math.max(...gaps) <= m.pubAnchorFrames + 1, `anchor gap ${Math.max(...gaps)} <= ${m.pubAnchorFrames + 1}`);
  m.dispose();
});

test('step ④: a cleared per-player value travels as an explicit null — the mirror never keeps a stale pendingLp/uniteLeft', () => {
  const h = makeUniteMatch({ pubSync: 'delta', pubAnchorFrames: 1000, pubAnchorMs: 1e12 });
  const m = h.m;
  const stream = recipientStream(h, 'p_0', { full: false, delta: true }); // delta mechanics only, see the test above
  h.start();
  h.autoHumans();
  fillBoards(h);
  const unite = () => m.fields.find((f) => f.fieldId === 'u');
  h.drive(() => (unite() && unite().done) || h.ended != null);
  /** p_0's pendingLp as its player entry carries it (undefined when the key is not in the frame at all). */
  const pending = (v) => {
    const p = Array.isArray(v.players) ? v.players.find((x) => x && x.playerId === 'p_0') : null;
    return p && Object.hasOwn(p, 'pendingLp') ? p.pendingLp : undefined;
  };
  assert.ok(stream.some((v) => typeof pending(v) === 'number' && pending(v) > 0), 'p_0\'s pendingLp travels while its battle is billed');
  h.drive(() => (m.phase === PHASE.SETTLE && m.round === 1) || h.ended != null);
  assert.equal(m.phase, PHASE.SETTLE, 'the round settled');
  const baseIdx = stream.findIndex((v) => v.full === true);
  assert.ok(baseIdx >= 0, 'the baseline is in the stream');
  assert.ok(stream.slice(baseIdx + 1).some((v) => pending(v) === null), 'the clearing frame carries pendingLp: null (never an omitted key)');
  m.flush(true); // a final frame of the same match state
  let mirror = null;
  for (const f of stream) mirror = mergePublic(mirror, f);
  const row = mirror.public.players.find((p) => p.playerId === 'p_0');
  assert.ok(row.pendingLp == null, `the merged mirror cleared it (got ${JSON.stringify(row.pendingLp)})`);
  assert.ok(row.uniteLeft == null, `and uniteLeft too (got ${JSON.stringify(row.uniteLeft)})`);
  const full = m.publicView();
  assert.equal(Object.hasOwn(full.players.find((p) => p.playerId === 'p_0'), 'pendingLp'), false, 'the fresh full view still omits the key (its shape is unchanged)');
  assertMirrorAgrees(mirror.public, full, stream);
  m.dispose();
});

test('step ④: a client that missed a frame heals on the anchor; a reconnect sends a fresh baseline and restarts the chain', () => {
  const h = makeUniteMatch({ pubSync: 'delta', pubAnchorFrames: 3, pubAnchorMs: 1e12 });
  const m = h.m;
  const stream = recipientStream(h, 'p_1', { full: false, bonds: true, delta: true });
  h.start();
  h.autoHumans();
  h.drive(() => m.phase === PHASE.COMBAT || h.ended != null);
  assert.equal(m.phase, PHASE.COMBAT, 'the normal round reached COMBAT');
  assert.ok(stream.length >= 2, `hot frames went out before the churn (${stream.length})`);
  // a reconnect mid-match: a fresh baseline (full: true) joins the stream and resets the delta chain
  m.onReconnect('p_1');
  const reconnectAt = stream.length - 1;
  assert.equal(stream[reconnectAt].full, true, 'the reconnect frame is a baseline');
  h.drive(() => (m.phase === PHASE.SETTLE && m.round === 1) || h.ended != null);
  assert.ok(stream.length > reconnectAt + 1, 'the chain continued after the reconnect');
  assert.ok(stream.slice(reconnectAt + 1).some((v) => !isCompleteFrame(v)), 'deltas resumed after the reconnect baseline');
  // a client that MISSED one delta: merging everything but it still agrees at the end (the next complete frame heals)
  const dropIdx = stream.findIndex((v, i) => i > 0 && !isCompleteFrame(v));
  assert.ok(dropIdx > 0, 'a delta to drop exists');
  assert.ok(stream.some((v, i) => i > dropIdx && isCompleteFrame(v)), 'a complete frame (anchor / baseline) follows the missed one');
  let mirror = null;
  for (let i = 0; i < stream.length; i++) if (i !== dropIdx) mirror = mergePublic(mirror, stream[i]);
  assertMirrorAgrees(mirror.public, m.publicView(), stream.filter((_, i) => i !== dropIdx));
  m.dispose();
});

test('step ④: SP_PUB_SYNC defaults to full — a delta-capable connection still gets complete frames (the doc\'s fallback switch)', () => {
  assert.equal(parsePubSync(undefined), 'full', 'the default is full');
  assert.equal(parsePubSync(''), 'full');
  assert.equal(parsePubSync('DELTA'), 'delta');
  assert.equal(parsePubSync('nonsense'), 'full');
  const h = makeMatch({ mode: 'coop', humans: 2, seed: 9, fake: true, pubSync: 'full' });
  const m = h.m;
  assert.equal(m.pubSync, 'full');
  const stream = recipientStream(h, 'p_0', { full: false, bonds: true, delta: true });
  h.start();
  h.autoHumans();
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  m.flush(true);
  assert.ok(stream.length >= 2, `hot frames went out (${stream.length})`);
  const baseIdx = stream.findIndex((v) => v.full === true);
  assert.ok(baseIdx >= 1, 'a baseline arrived after the first (pre-baseline) compact frame');
  for (const f of stream.slice(baseIdx + 1)) {
    assert.ok(isCompleteFrame(f), 'every hot frame is complete in the full mode');
    const row = f.players.find((p) => p.playerId === 'p_0');
    assert.ok(Object.hasOwn(row, 'pendingLp') && row.pendingLp === null, 'and carries the cleared optional keys as explicit nulls (the per-player merge shape)');
  }
  // a connection that declared nothing still gets the untouched shared compact frame
  assert.deepEqual(m.publicViewFor('p_0', { full: false }), m.publicView({ full: false }));
  m.dispose();
});
