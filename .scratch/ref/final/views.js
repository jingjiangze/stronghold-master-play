// server/match/match/views.js — Match methods: the state builders — m.public (publicView with statusOf / fieldOf, the
// fields' progress, the teammates' live pendingLp / uniteLeft, the SETTLE uniteResult), the nextEnemies preview of
// m.private and the prep scout's m.field (prepFieldMeta: board, hand and temp as units, the scouted player's effects and
// coming enemies; in a boss round's prep on the player's half of the boss field).
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, GEO, ERR } from '../../../shared/constants.js';
import { boardOrder, pieceDir } from '../board.js';
import { bondList, offBondCounts } from '../bondsMeta.js';
import { cardView } from '../choices.js';
import { bountySpawns, previewOf } from '../waves.js';
import { timelineAt } from '../fields.js';
import { bossFieldPlacement } from '../finalAssault.js';
import { battleProgress } from '../../sim/spec.js';
import { OK, fail } from './common.js';

/**
 * The phase-scoped pockets of m.public: a compact frame (`full: false`) publishes one only while its phase applies (or
 * its object exists), and a merging client — `{ ...prev, ...next }` in public/js/main.js wireNet, which only ever adds
 * or overwrites keys — would then keep the last value forever. After a 联防 round the mirror's `pub.uniteResult` stayed
 * set, so a later SETTLE (no 联防 of its own) popped the PREVIOUS unite's result box and sound (public/js/screens/
 * game.js reads `pub?.uniteResult` at every SETTLE). RULE: an absent pocket must travel as an explicit null in a compact
 * frame — the documented prerequisite for the delta step in
 * https://downcdn.jiangjiangze.icu/docs/ws-link-compression-next.md §4. Every key here is consumed as truthy /
 * optional-chained / through a null-taking normaliser on the client: unite (`pub?.unite?.leakers|helpers`: game.js,
 * teamPanel.js, gameLogic/phases.js), uniteResult (game.js SETTLE, uniteResultBox takes null), draft (bandDraft
 * normalizeDraft / draftClock), sp (gameLogic/draft.js normalizeSp rejects non-objects), overtimeAt (hud.js,
 * matchStatus.js: Number() + > 0), teamLp (hud.js / gameLogic/result.js / stats.js: Number.isFinite). bossHp is left
 * out: it rides the shared pool that never un-sets before RESULT, so it cannot go stale.
 */
const COMPACT_NULL_POCKETS = ['unite', 'uniteResult', 'draft', 'sp', 'overtimeAt', 'teamLp'];

/**
 * The delta chain's periodic full anchor (step ④ of the compression doc): after this many delta frames, or this long
 * since the last complete frame, a recipient is sent a COMPLETE compact frame again instead of a delta — the client
 * that missed a frame (or whose mirror is otherwise out of step) heals on it. It is not the snapshot-rate "slow tick is
 * a subset of the fast tick" rule: it belongs to the delta chain alone and is per recipient (views.js publicViewFor).
 * Engine-only overrides for tests: Match opts.pubAnchorFrames / opts.pubAnchorMs.
 */
export const PUB_DELTA_ANCHOR_FRAMES = 50;
export const PUB_DELTA_ANCHOR_MS = 30_000;

/**
 * The per-player keys a compact view may omit once cleared (`_pendingLpView` drops them at 0): a client that merges
 * `players[]` per player (hello.pubDelta) would keep the last value forever, so a delta-capable frame carries them as an
 * explicit null — the player-level half of the doc's step ② (the top-level half is COMPACT_NULL_POCKETS).
 */
const DELTA_PLAYER_NULL_KEYS = ['pendingLp', 'uniteLeft'];

/** Deep equality of two JSON-safe view values (the delta diff; key order never matters). */
function sameJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameJson(a[k], b[k]));
}

/**
 * The delta between the payload last sent to a recipient and the next complete one (publicViewFor, step ④): every
 * top-level key that changed, and `players[]` as a PARTIAL array — per player only the keys that changed, `playerId`
 * always, plus an explicit `null` for a key that vanished from the entry (a cleared pendingLp / uniteLeft). `t` always
 * travels; the result is null when nothing changed for this recipient at all (the lobby then sends it nothing).
 * The baseline is never diffed: its payload may still carry the per-match constants and the keys a compact frame nulls,
 * and the client RESETS its mirror on it — so a reset also resets the chain this function walks.
 */
function deltaPublicView(prev, next) {
  const out = { t: next.t };
  let changed = false;
  if (Array.isArray(next.players)) {
    const before = new Map((Array.isArray(prev.players) ? prev.players : []).map((p) => [p && p.playerId, p]));
    const parts = [];
    for (const p of next.players) {
      const old = p && before.get(p.playerId);
      if (!old) { parts.push(p); changed = true; continue; }
      const part = { playerId: p.playerId };
      let hit = false;
      for (const k of Object.keys(p)) {
        if (k === 'playerId') continue;
        if (!Object.hasOwn(old, k) || !sameJson(old[k], p[k])) { part[k] = p[k]; hit = true; }
      }
      for (const k of Object.keys(old)) {
        if (k === 'playerId' || Object.hasOwn(p, k)) continue;
        if (old[k] != null) { part[k] = null; hit = true; } // a cleared value must travel as an explicit null
      }
      if (hit) { parts.push(part); changed = true; }
    }
    if (parts.length) out.players = parts;
  }
  for (const k of Object.keys(next)) {
    if (k === 'players' || k === 't') continue;
    if (!Object.hasOwn(prev, k) || !sameJson(prev[k], next[k])) { out[k] = next[k]; changed = true; }
  }
  return changed ? out : null;
}

/** A reported capsule numerator clamped to its denominator, else null (unknown — never a fabricated 0). */
const finiteOrNull = (v, cap = Infinity) => {
  if (v == null) return null;   // Number(null) === 0: an unreported value must not read as "0 resolved"
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(Number.isFinite(cap) ? cap : Infinity, Math.trunc(n)));
};

/**
 * A scouted operator's potential (below 6) and 练度 (0.2.2), like the sim's UnitInfo: PlayerState.loadoutFor's
 * `potential` / `cultivate` (null for a stand-in or a prototype 自选 pick: neither field).
 */
function cultivationInfo(lo) {
  const out = {};
  if (lo && Number.isInteger(lo.potential) && lo.potential < 6) out.potential = lo.potential;
  if (lo && Number.isInteger(lo.cultivate)) out.cultivate = lo.cultivate;
  return out;
}

export class MatchViews {
  statusOf(ps) {
    if (ps.left) return 'left';
    if (!ps.alive) return 'dead';
    switch (this.phase) {
      case PHASE.INFO_CHECK: return ps.infoReady ? 'ready' : 'deciding';
      case PHASE.BAND_DRAFT:
        if (this.draft && this.draft.picks[ps.playerId]) return 'ready';
        return this.draft && this.draftTurn() === ps.playerId ? 'deciding' : 'acting';
      case PHASE.SP_DRAFT:
        if (this.sp && this.sp.picks[ps.playerId] != null) return 'ready';
        return this.sp && this.spTurn() === ps.playerId ? 'deciding' : 'acting';
      case PHASE.PREP: return ps.ready ? 'ready' : 'acting';
      case PHASE.COMBAT: case PHASE.FINAL_ASSAULT: case PHASE.HIDDEN_CORE: {
        const f = this.fields.find((x) => x.players.includes(ps.playerId));
        return f && f.live ? 'combat' : 'done';
      }
      case PHASE.UNITE: return this.unitePlan && this.unitePlan.helpers.includes(ps) ? 'helping' : 'done';
      case PHASE.ROUND_START: return 'acting';
      default: return 'done';
    }
  }

  fieldOf(ps) {
    const f = this.fields.find((x) => x.players.includes(ps.playerId));
    return f ? f.fieldId : null;
  }

  /**
   * The match's public state. `full` (default) carries everything, including the fields that never change during a
   * match and the ones that change rarely; it is the BASELINE a client resets its mirror from (`full: true` on the
   * frame), and it is what a client that did not declare `hello.pub` always gets.
   *
   * `full: false` is the hot broadcast: it drops the per-match constants (measured constant over five matches across
   * co-op NORMAL/HARD/ABYSS, solo and the 协同共竞 variant) so a client that merges keeps paying for them once instead
   * of in every frame, and it nulls every phase pocket it does not publish (COMPACT_NULL_POCKETS) so the mirror cannot
   * keep an ended pocket. Because every frame is deflated independently (`serverNoContextTakeover`), a constant left in
   * the hot frame costs its compressed size in EVERY frame — that is what makes this worth doing at all.
   */
  publicView({ full = true } = {}) {
    const v = {
      t: 'm.public',
      // `full` marks a baseline: the client drops its mirror and starts from this frame. A compact frame never has it.
      ...(full ? { full: true } : null),
      phase: this.phase,
      round: this.round,
      deadline: this.deadline,
      serverNow: this.sched.now(),
      bossRound: this.gd.bossRound,
      hiddenRound: this.gd.hiddenRound,
      spRound: this.gd.spRounds().includes(this.round),
      combatMode: this.clientCombat ? 'client' : 'server',
      // solo pause (g.pause, DESIGN §14): the battle, its field clock and every deadline are frozen while true
      paused: !!this.paused,
      players: this.order.map((ps) => ({
        playerId: ps.playerId,
        seat: ps.seat,
        name: ps.name,
        isBot: ps.isBot,
        connected: ps.isBot || (ps.connected && !ps.left),
        alive: ps.alive,
        lp: Math.max(0, ps.lp),
        bandId: ps.bandId,
        shopLevel: ps.shop.level,
        boardCount: ps.deployCount,
        ready: this.phase === PHASE.INFO_CHECK ? ps.infoReady : ps.ready,
        // the strip of a teammate watching this player (DESIGN §20.15): every bond with members, layers or an active tier
        // (= the player's own m.private list without thresholds / countsHand — the client reads those from bonds.json),
        // this round's in-battle gains included once the COMBAT phase ended (PlayerState.bondsView); [] once eliminated —
        // nobody can watch an eliminated player (g.watch refuses them, they have no field) and the result screen reads
        // m.result's own bonds, so their layers would only cost every m.public bytes for the rest of the match
        // (the mode-off bonds with members included, `off: true`, as in m.private — bondsMeta.offBondCounts)
        bonds: this._bondsOf(ps),
        fieldId: this.fieldOf(ps),
        status: this.statusOf(ps),
        autoplay: ps.autoplay,
        // the LP this round's own battle will cost at settlement so far (COMBAT / 联防 only, omitted when 0)
        ...this._pendingLpView(ps),
      })),
      fields: this.fields.map((f) => {
        const v = { fieldId: f.fieldId, kind: f.kind, players: f.players.slice(), live: !!f.live };
        const pr = this._fieldProgress(f);
        if (pr) v.progress = pr;
        return v;
      }),
    };
    if (this.teamLp != null) v.teamLp = Math.max(0, Math.round(this.teamLp));
    // 最终攻势 / 隐秘核心: when the overtime drain starts (ms epoch; `deadline` is the level's 120 s countdown)
    if ((this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE) && this.overtimeAt) v.overtimeAt = this.overtimeAt;
    if (this.bossPool) v.bossHp = { hp: Math.max(0, Math.round(this.bossPool.hp)), max: Math.round(this.bossPool.maxHp) };
    if (this.phase === PHASE.BAND_DRAFT && this.draft) {
      const d = this.draft;
      // turnSeconds: the length of a turn (the countdown gauge's total; 0 when untimed) — deadline = turnDeadline
      v.draft = {
        order: d.order.slice(), turn: this.draftTurn(), picks: { ...d.picks }, skipsLeft: { ...d.skipsLeft }, turnDeadline: d.turnDeadline || 0,
        turnSeconds: d.untimed ? 0 : this.bandTurnMs() / 1000, untimed: !!d.untimed,
      };
    }
    if (this.phase === PHASE.SP_DRAFT && this.sp) {
      const s = this.sp;
      v.sp = {
        family: s.family, name: s.name, desc: s.desc, eventId: s.eventId, cards: s.cards.map(cardView), order: s.order.slice(),
        turn: this.spTurn(), picks: { ...s.picks }, taken: { ...s.taken }, untimed: !!s.untimed,
      };
    }
    if (this.phase === PHASE.UNITE && this.unitePlan) v.unite = { helpers: this.unitePlan.helpers.map((p) => p.playerId), leakers: this.unitePlan.leakers.map((p) => p.playerId) };
    // SETTLE after a 联防: its outcome as data (settle.js uniteResultView; GitHub #235, PR #112) — { through, helpers,
    // leakers, losses: { playerId: the LP settlement charged this round } } — the client's result box reads the viewer's
    // own charge from it; absent when no 联防 resolved (the client then shows the round's own battle result)
    if (this.phase === PHASE.SETTLE && this.uniteResultView) {
      const ur = this.uniteResultView;
      v.uniteResult = { through: ur.through, helpers: ur.helpers.slice(), leakers: ur.leakers.slice(), losses: { ...ur.losses } };
    }
    // A compact frame clears every pocket it does not publish: the merging client only ever ADDS keys, so an ended
    // pocket omitted here would survive in its mirror (see COMPACT_NULL_POCKETS). The baseline (full) keeps its exact
    // key set — a client that replaces the whole state needs no nulls, and the wire format of the full frame stays put.
    if (!full) for (const k of COMPACT_NULL_POCKETS) if (!Object.hasOwn(v, k)) v[k] = null;
    if (full) {
      // The per-match constants: fixed at match start and unchanged afterwards (read once by the briefing screen, the
      // HUD's difficulty tag, the bond popup/panel and the BGM pick). Kept out of the compact frame — see the header.
      v.lastRound = this.gd.lastRound;
      v.modeId = this.modeId;
      v.difficulty = this.difficulty;
      v.stageId = this.stageId;
      v.factions = this.factions.slice();
      v.disabledBonds = [...new Set([...this.disabledBonds, ...this.staticInactiveBonds])].sort();
      v.drawnDisabledBonds = this.disabledBonds.slice();
      v.bannedChess = this.bannedChess.slice();
      v.bossId = this.bossId;
      v.hiddenBossId = this.hiddenBossId;
    }
    return v;
  }

  /**
   * The m.public frame ONE recipient gets on the hot path (WS compression round 2, steps ③/④; the lobby calls this per
   * session instead of publicView — server/lobby.js broadcastPublic). `bonds` / `delta` are the capabilities the
   * connection declared (hello.pubBonds / hello.pubDelta), not its identity: a recipient that declared neither gets the
   * shared compact frame, untouched.
   *
   * ③ `bonds`: every bond list the recipient's screen cannot show is stripped to `[]` (see _bondScopeFor; the doc's
   * 1–2 players). The stripped lists are refreshed with one g.bonds ⇄ m.bonds round trip when the client opens a popup
   * for a player it has no live list for; a full baseline is NEVER stripped, so a client that cannot ask still receives
   * every player's bonds.
   *
   * ④ `delta`: before the chain runs, every players[] entry is normalized to carry its cleared optional keys
   * (DELTA_PLAYER_NULL_KEYS) as explicit nulls — the client merges `players[]` per player, so this holds in the
   * 'full' sync mode too. On the chain (pubSync === 'delta'), the payload last handed to this recipient is remembered
   * and only what changed since it is returned (deltaPublicView); a full baseline resets the chain, an anchor —
   * PUB_DELTA_ANCHOR_FRAMES frames or PUB_DELTA_ANCHOR_MS after the last complete frame, whichever first — is a
   * complete frame with no `full` marker (the client keeps its constants), and a delta with nothing in it returns null,
   * so the recipient is sent nothing at all.
   *
   * @param {string} playerId the recipient (a player seat or a spectator seat; any id when the match does not know it)
   * @param {{ full?: boolean, bonds?: boolean, delta?: boolean }} [opts]
   * @returns {object | null} the frame, or null for a delta with nothing new (`full` never returns null)
   */
  publicViewFor(playerId, { full = false, bonds = false, delta = false } = {}) {
    const v = this.publicView({ full });
    if (full) {
      // a baseline: the client's mirror — and so the delta chain — restarts from this frame
      this._pubSent.set(playerId, v);
      this._pubState.set(playerId, { frames: 0, at: this.sched.now() });
      return v;
    }
    if (!bonds && !delta) return v;
    if (bonds) {
      const scope = this._bondScopeFor(playerId);
      for (const p of v.players) if (p && !scope.includes(p.playerId)) p.bonds = [];
    }
    if (!delta) return v;
    for (const p of v.players) for (const k of DELTA_PLAYER_NULL_KEYS) if (p && !Object.hasOwn(p, k)) p[k] = null;
    const prev = this._pubSent.get(playerId);
    this._pubSent.set(playerId, v);
    if (!prev || this.pubSync !== 'delta') { this._pubState.delete(playerId); return v; }
    const now = this.sched.now();
    const st = this._pubState.get(playerId) || { frames: 0, at: now };
    if (st.frames >= this.pubAnchorFrames || now - st.at >= this.pubAnchorMs) {
      this._pubState.set(playerId, { frames: 0, at: now });
      return v;
    }
    const d = deltaPublicView(prev, v);
    this._pubState.set(playerId, d ? { frames: st.frames + 1, at: st.at } : st);
    return d;
  }

  /**
   * The players whose bonds the recipient's screen can show (see publicViewFor): the field it watches or the board it
   * scouts (`watchers`; g.watch names the player of a shared field), else its own live field, else the scope it had when
   * `watchers` was last live — the map is read after a phase end cleared `watchers` (settle.js), so the SETTLE result box
   * of a 联防 / boss round still carries the field's 1–2 players —, else the player it follows (an eliminated human /
   * spectator seat, watchPref) and itself at last. startRound clears the remembered scope with `watchers`, so a new
   * round never keeps the last one's teammate. The scope is remembered on every live read, which is what makes the
   * SETTLE fallback work without touching the watcher lifecycle.
   * @param {string} playerId
   * @returns {string[]}
   */
  _bondScopeFor(playerId) {
    const watched = this.watchers.get(playerId);
    let live = null;
    if (typeof watched === 'string' && watched.startsWith('n:')) {
      const pid = watched.slice(2);
      if (this.players.has(pid)) live = [pid];
    } else if (watched) {
      const f = this.fields.find((x) => x.fieldId === watched);
      if (f && Array.isArray(f.players)) live = f.players.slice();
    }
    if (live) { this._bondScope.set(playerId, live); return live; }
    const own = this.fields.find((f) => Array.isArray(f.players) && f.players.includes(playerId));
    if (own) return own.players.slice();
    const last = this._bondScope.get(playerId);
    if (last) return last;
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    if (ps && this._follows(ps)) {
      const target = this._watchTargetOf(ps);
      if (target) return [target];
    }
    return [playerId];
  }

  /** The players[].bonds payload of a player — one expression, shared by publicView and the m.bonds answer (g.bonds). */
  _bondsOf(ps) {
    return ps.alive ? bondList(this.gd, ps.bondsView(), { off: offBondCounts(ps.gd || this.gd, ps) }) : [];
  }

  /**
   * g.bonds { playerId } (step ③): the bonds of a player whose list the requester's hot frames strip — an off-screen
   * player, the case the on-demand channel exists for. One unicast m.bonds to the requester (never broadcast: each
   * connection refreshes its own popup); an unknown id is refused. The payload is players[].bonds' own, so the client
   * can write it into its mirror entry unchanged.
   */
  sendBonds(ps, playerId) {
    const target = this.players.get(playerId);
    if (!target) return fail(ERR.BAD_TARGET, 'no such player');
    this.sendTo(ps.playerId, { t: 'm.bonds', playerId, bonds: this._bondsOf(target) });
    return OK;
  }

  /**
   * m.public.fields[].progress: { killed, resolved, total, done } (teammates' waiting UI). `resolved` is the HUD
   * capsule's numerator — the field's own scheduled enemies knocked out or leaked (Battle.resolved / the reported
   * b.progress `resolved`); it is `null` (never 0) while unknown, so the client's `resolved ?? killed` fallback holds.
   * `total` is the capsule's denominator: only the enemies the round scheduled (runtime splits / summons — boss summons
   * included — are in neither part).
   */
  _fieldProgress(f) {
    if (!f) return null;
    if (!f.cc) {
      const b = f.battle;
      if (!b) return null;
      const total = Number(b.total) || 0;
      return { killed: Number(b.killed) || 0, resolved: finiteOrNull(b.resolved, total), total, done: !f.live };
    }
    if (f.done && f.result) {
      let killed = 0, total = 0, own = 0, ownKnown = true;
      for (const pp of Object.values(f.result.perPlayer || {})) {
        killed += Number(pp && pp.killed) || 0;
        total += Number(pp && pp.total) || 0;
        if (Number.isFinite(pp && pp.resolved)) own += Number(pp.resolved); else ownKnown = false;
      }
      // the FIELD's numerator (the validated client result / Battle.result(): what the capsule showed) — not the sum of the
      // players' own: an enemy that spawns on one half and leaks on the other (a 联防 lane, the boss pair's crossing routes)
      // is billed to one player's `total` and to the other's leak, so their own min(total, …) clamp it to 0
      let resolved = finiteOrNull(f.result.resolved, total);
      if (resolved == null && ownKnown) resolved = Math.min(total, own);
      if (f.result.synthetic) { killed = f.progress.killed; total = f.progress.total; resolved = finiteOrNull(f.progress.resolved, total); }
      return { killed, resolved, total, done: true };
    }
    if (f.mode === 'server' && f.timeline) {
      // a server-run / bot field: no authority ever sends a b.progress, so the capsule reads the battle's own counters —
      // the timeline sample carries `resolved` (Battle.resolved: knocked out + leaked among the field's own enemies),
      // never the report-driven `progress.leaks`, which would leave such a field at 0 forever
      const [, killed, total, resolved] = timelineAt(f.timeline, this._fieldElapsed(f));
      return { killed, resolved: finiteOrNull(resolved, total), total, done: false };
    }
    const total = f.progress.total;
    return { killed: f.progress.killed, resolved: finiteOrNull(f.progress.resolved, total), total, done: false };
  }

  /**
   * LP a player's own battle of this normal round will cost at settlement so far — settle()'s min(lpCapPerRound,
   * counted leaks) — for the teammates' live LP (m.public players[].pendingLp, user playtest #3 item 2; the own client
   * counts its local battle itself). COMBAT: the recorded result once every field is done, else the field's result, else
   * the authority's b.progress leaks (a server-run field reports none before its result is released); 联防: a leaker's
   * enemies still standing on the 联防 field (_uniteLeft, uncapped in `uniteLeft`, user playtest #6 item 7), anyone
   * else's own battle count (0: they were perfect). Omitted when 0 and in every other phase (boss rounds charge the
   * merged team LP live).
   * @returns {{ pendingLp?: number, uniteLeft?: number }}
   */
  _pendingLpView(ps) {
    if (!ps || !ps.alive || (this.phase !== PHASE.COMBAT && this.phase !== PHASE.UNITE)) return {};
    const counted = (r) => (r && Array.isArray(r.leaked) ? r.leaked.filter((l) => l && l.counted !== false).length : 0);
    // 联防: a leaker's enemies still standing on the 联防 field (uncapped), the loss capped like settle()
    const left = this._uniteLeft(ps);
    if (left != null) {
      const loss = Math.min(this.gd.lpCapPerRound, left);
      return loss > 0 ? { uniteLeft: left, pendingLp: loss } : { uniteLeft: left };
    }
    let n = 0;
    if (this.lastResults.has(ps.playerId)) n = counted(this.lastResults.get(ps.playerId));
    else if (this.phase === PHASE.COMBAT) {
      const f = this.fields.find((x) => x && x.kind === 'normal' && Array.isArray(x.players) && x.players.includes(ps.playerId));
      if (f && f.cc) n = f.done && f.result ? counted(f.result.perPlayer && f.result.perPlayer[ps.playerId]) : Number(f.progress && f.progress.leaks) || 0;
      else if (f && f.battle) { try { n = battleProgress(f.battle).leaks; } catch { n = 0; } }
    }
    const loss = Math.min(this.gd.lpCapPerRound, Math.max(0, Math.trunc(Number(n) || 0)));
    return loss > 0 ? { pendingLp: loss } : {};
  }

  /** nextEnemies preview for m.private. */
  nextEnemiesFor(ps) {
    if (!ps.alive) return [];
    if (this.bossWaves) {
      const g = this.bossGroupOf(ps);
      if (!g) return [];
      return previewOf([...g.wave.spawns, ...bountySpawns(this.gd, this.round, g.wave, ps.bounties, ps.playerId, { solo: this.isSolo, side: g.side })]);
    }
    if (!this.wave) return [];
    const bounty = bountySpawns(this.gd, this.round, this.wave, ps.bounties, ps.playerId, { solo: this.isSolo });
    return previewOf([...this.wave.spawns, ...bounty]);
  }

  /** A 自选 piece's pick (like the sim's UnitInfo.diy): a scout's card composes the operator from it (shared/diy.js). */
  _diyInfo(ps, piece) {
    const p = piece.kind === 'chess' && typeof ps.diyPickOf === 'function' ? ps.diyPickOf(piece.id) : null;
    return p ? { charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId } : undefined;
  }

  /** UnitInfo of a player's board pieces on their (board) tiles — a prep scout's board, the boss partner's (bossMateView).
   *  `area: 'board'` (a bench unit says 'hand' / 'temp': prepFieldMeta). */
  _prepBoardUnits(ps) {
    const units = [];
    // the player's own view of the data (0.2.0 自选编队: its slotted DIY slots are its operators — player/diy.js)
    const gd = ps.gd || this.gd;
    for (const { r, c, piece } of boardOrder(ps.board)) {
      const chess = piece.kind === 'token' ? null : gd.chess(piece.id);
      // 0.2.0 补位: a chess this player fields as its stand-in is deployed with the stand-in's body — name, art, max HP,
      // skill, like the sim's UnitInfo (`standInFor` = the replaced operator's charId)
      const rec = piece.kind === 'token' ? gd.token(piece.id) : ps.fieldRecord(chess);
      const assets = (rec && rec.assets) || {};
      // DESIGN §16: the skill / module THIS player's operator fights with (the scout's detail card shows it, like the
      // sim's UnitInfo in a shared field); moduleId only for an elite; 0.2.2 its potential (below 6) and 练度
      const lo = piece.kind === 'chess' && chess ? ps.loadoutFor(chess) : null;
      units.push({
        id: piece.uid, uid: piece.uid, kind: piece.kind === 'token' ? 'token' : 'op', side: 'ally', ownerId: ps.playerId, defId: piece.id,
        area: 'board',
        name: rec ? rec.name : piece.id, tier: rec && Number.isInteger(rec.tier) ? rec.tier : 1, golden: !!(rec && rec.isGolden),
        spine: assets.spine || (rec && rec.charId) || piece.id, avatar: assets.avatar || (rec && rec.charId) || piece.id,
        x: c, y: r, dir: pieceDir(piece), facing: pieceDir(piece) === 'LEFT' ? -1 : 1, maxHp: rec && rec.stats && Number.isFinite(rec.stats.maxHp) ? rec.stats.maxHp : 1,
        skillIndex: lo && Number.isInteger(lo.skillIndex) ? lo.skillIndex : undefined,
        moduleId: lo && typeof lo.moduleId === 'string' ? lo.moduleId : undefined,
        // the equipped items (like the sim's UnitInfo): a 变形同构体 wearer shows as a member of the bond it grants
        items: piece.kind === 'chess' && Array.isArray(piece.items) && piece.items.length ? piece.items.map((it) => it.id) : undefined,
        standInFor: rec && rec.standInFor ? rec.standInFor : undefined,
        diy: this._diyInfo(ps, piece),
        ...cultivationInfo(lo),
      });
    }
    return units;
  }

  /**
   * A boss round's prep (最终攻势 / 隐秘核心: the pairing planned, no field up yet): the other player of `ps`'s pair as
   * { mate: PlayerState, side: its half 'L' | 'R' }, else null (a lone player, any other phase).
   */
  _bossMateOf(ps) {
    if (!ps || !this.bossWaves || this.fields.length) return null;
    const g = this.bossGroupOf(ps);
    const pid = g && g.players.length > 1 ? g.players.find((x) => x !== ps.playerId) : null;
    const mate = pid ? this.players.get(pid) : null;
    return mate ? { mate, side: g.side === 'R' ? 'L' : 'R' } : null;
  }

  /**
   * m.private `bossMate` (community report of 2026-10-06, item 51): in a boss round's prep the partner's board on its
   * half of the boss field, as the battle will place it (bossFieldPlacement: the right half mirrored, RIGHT ↔ LEFT) — the
   * own prep view draws it beside the own half, read-only, as the official prep shows both players of a pair together
   * (the official client knows every board: ChangePositionDn { boardStatus }, research 09). Null otherwise.
   * @returns {{ playerId: string, side: 'L'|'R', units: object[] } | null}
   */
  bossMateView(ps) {
    const m = ps && ps.alive ? this._bossMateOf(ps) : null;
    if (!m) return null;
    return { playerId: m.mate.playerId, side: m.side, units: this._prepBoardUnits(m.mate).map((u) => this._onBossHalf(u, m.side)) };
  }

  /** UnitInfo list of a player's board and hand (prep scouting): board pieces on their tiles, held pieces on the
   *   hand row (row 7) — the scout renders like the own prep bench. */
  prepFieldMeta(ps) {
    const units = this._prepBoardUnits(ps);
    const gd = ps.gd || this.gd;
    // the hand (整备区) and the 临时整备区 scout exactly like the own prep bench renders them: pieces as units on
    // their rows (hand row 7, col = hand slot; temp row 8, cols 4..8 = temp slots; no dir — bench pieces face right),
    // items included (the client draws their floating plates). PRTS 帮助 counts the temp area with the hand (review of
    // PR #129). Part of the meta for every watcher alike — the spectator seat's copy equals a teammate's
    // (test/match/spectator.test.js). User playtest #2 item 1 (GitHub #44).
    // (a held chess the player fields as its stand-in is the stand-in there too — name, art, max HP — and carries
    // `standInFor`, like a board piece: the owner's recall of the official mode, 2026-10-06, the hand shows the stand-in)
    // Each unit says where it waits (`area` 'hand' | 'temp'; a board unit 'board'): the bond popup of a watched player
    // counts it like the player's own (ui/watchBonds.js ownerBoard — a hand operator is owned and counts for 投资人 远见
    // 奇迹, a temp one counts for nothing; GitHub #385, PR #387). The tag survives the boss-half remap (_onBossHalf), the
    // row does not.
    const benchUnit = (piece, i, y, area) => {
      const rec = piece.kind === 'item' ? gd.item(piece.id) : piece.kind === 'token' ? gd.token(piece.id) : gd.chess(piece.id);
      const standIn = piece.kind === 'chess' && rec && ps.fieldsStandIn(rec) ? this.gd.standIn(rec.chessId) : null;
      const body = standIn || rec;
      const assets = (body && body.assets) || {};
      const lo = piece.kind === 'chess' && rec ? ps.loadoutFor(rec) : null;
      units.push({
        id: piece.uid, uid: piece.uid, kind: piece.kind === 'token' ? 'token' : piece.kind === 'item' ? 'item' : 'op',
        side: 'ally', ownerId: ps.playerId, defId: piece.id, area,
        name: body ? body.name : piece.id, tier: rec && Number.isInteger(rec.tier) ? rec.tier : 1, golden: !!(rec && rec.isGolden),
        spine: assets.spine || (body && body.charId) || piece.id, avatar: assets.avatar || (body && body.charId) || piece.id,
        x: i, y, maxHp: body && body.stats && Number.isFinite(body.stats.maxHp) ? body.stats.maxHp : 1,
        skillIndex: lo && Number.isInteger(lo.skillIndex) ? lo.skillIndex : undefined,
        moduleId: lo && typeof lo.moduleId === 'string' ? lo.moduleId : undefined,
        items: piece.kind === 'chess' && Array.isArray(piece.items) && piece.items.length ? piece.items.map((it) => it.id) : undefined,
        standInFor: standIn && standIn.standInFor ? standIn.standInFor : undefined,
        diy: this._diyInfo(ps, piece),
        ...cultivationInfo(lo),
      });
    };
    for (let i = 0; i < ps.hand.length; i++) {
      if (ps.hand[i]) benchUnit(ps.hand[i], i, GEO.HAND_ROW, 'hand');
    }
    for (let i = 0; i < ps.temp.length; i++) {
      if (ps.temp[i]) benchUnit(ps.temp[i], GEO.TEMP_C0 + i, GEO.TEMP_ROW, 'temp');
    }
    // `nextEnemies`: the scouted player's coming enemies — their preview pen shows on the scouting board too (research 09
    // §2.2 "Teammates"; render/app.js enterBattle({ prep: true, nextEnemies }))
    let nextEnemies = [];
    try { nextEnemies = this.nextEnemiesFor(ps); } catch (e) { this.reportError('nextEnemies', e); }
    // the scouted player's effects column (策略 / 机变 / 悬赏 …), display-ready (user playtest #2: while scouting, the
    // right column shows the watched player's effects, not one's own)
    const meta = { t: 'm.field', fieldId: `n:${ps.playerId}`, kind: 'normal', rect: { ...GEO.NORMAL_RECT }, stageId: this.stageId, units, effects: ps.effectsView(), prep: true, nextEnemies };
    // 最终攻势 / 隐秘核心 prep: the pieces stand on the player's half of the boss field — the scout shows them there (rows
    // − 7, the right half mirrored with RIGHT ↔ LEFT: finalAssault.js bossFieldPlacement, as the own prep view), with the
    // round's leader at its spawn tile (nextEnemies `start`), framed by the boss-field prep camera of the player's side
    // (`side`). Until 0.2.0 an eliminated player or a spectator seat scouting a player then saw the normal board and no
    // leader at all (community report of 2026-10-06, item 55).
    // The pair's other player stands on the other half (item 51: both players of a pair together, as in the battle).
    const g = this.fields.length ? null : this.bossGroupOf(ps);
    if (!g) return meta;
    const mate = this.bossMateView(ps);
    const own = units.map((u) => this._onBossHalf(u, g.side));
    return { ...meta, kind: 'boss', rect: { ...GEO.BOSS_RECT }, side: g.side, units: mate ? [...own, ...mate.units] : own, ...(mate ? { mate: { playerId: mate.playerId, side: mate.side } } : {}) };
  }

  /** A prep UnitInfo (board, bench or temp row) placed on side 'L' | 'R' of the boss field (bossFieldPlacement). */
  _onBossHalf(u, side) {
    const p = bossFieldPlacement(side, u.y, u.x, u.dir || 'RIGHT');
    const v = { ...u, x: p.col, y: p.row };
    // a board piece keeps facing the same way relative to the leader (mirrored on the right half); a bench piece has no
    // stored facing (it faces right, as the own prep bench draws it)
    if (u.dir) { v.dir = p.dir; v.facing = p.dir === 'LEFT' ? -1 : 1; }
    return v;
  }
}
