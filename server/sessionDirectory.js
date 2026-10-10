// server/sessionDirectory.js — session OWNERSHIP routing (phase 1 of the cross-process work).
//
// The problem this solves: the two blue/green slots are separate node processes, and SessionRegistry is
// in-memory, so after a flip a browser refresh opens a NEW socket that the entry (nginx :3000 -> active slot)
// sends to the WRONG process: the token is unknown there, a fresh session is minted and the player loses the
// match (the client shows 「服务器会话已重置」). Everything about the match itself is still fine — it is the
// ROUTING that is wrong.
//
// So this module answers exactly one question: "which process holds this session right now?" It deliberately
// does NOT pretend to restore a match: the owning process still runs its own registry.byToken(), Lobby.onHello()
// and Match.onReconnect(). A shared token table alone would NOT be enough (it only proves a session existed).
//
// Design constraints taken from the audit:
//   * keyed by token HASH — the raw token is never stored here, never logged, never put in a URL;
//   * the routing credential is SIGNED and carries an expiry + generation, so a client can never name an
//     internal port or slot directly (the slot is resolved server-side from the signed record);
//   * the LEASE (is the owner still alive?) and the session's own RECOVERY DEADLINE (10 min co-op / 24 h solo)
//     are tracked separately: a slot with zero sockets may still owe recoverable sessions to its players;
//   * no new infrastructure: the default backend is a single JSON file with atomic replace, which is what a
//     two-slot single-box deployment can actually rely on.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';

/** Index key for a session: the token's SHA-256, truncated. The raw token never reaches this module's store. */
export function tokenHash(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 32);
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** Shape of a credential as it may appear in a URL: `v1.<base64url payload>.<base64url signature>`. */
const CREDENTIAL_RE = /^v1\.[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{1,128}$/;

/**
 * The routing credential an upgrade URL carries (`/ws?cred=v1.<payload>.<sig>`), or null.
 *
 * Why the URL: `hello` is strictly validated, so an unknown field there would make an OLD server reject the whole
 * handshake — the credential has to ride where an old server simply does not look. Parsing never trusts the value
 * (the signature is verified later) and never throws; anything that is not the exact shape is treated as absent.
 * @param {string | null | undefined} url the raw request target (`req.url`)
 * @returns {string | null}
 */
export function routeCredentialFromUrl(url) {
  if (typeof url !== 'string') return null;
  const q = url.indexOf('?');
  if (q < 0) return null;
  const query = url.slice(q + 1).split('#')[0];
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== 'cred') continue;
    let value = pair.slice(eq + 1);
    try { value = decodeURIComponent(value); } catch { return null; }
    return CREDENTIAL_RE.test(value) ? value : null;
  }
  return null;
}

/**
 * A routing credential: `v1.<payload>.<sig>`. The payload names the OWNING instance, its slot and the
 * generation at issue time — never a port, never the token. Anyone may read it (it travels in the WS URL), so
 * it is useless as an identity: `hello.token` is still what authenticates, and a tampered payload fails the
 * signature.
 */
export function signCredential(payload, secret) {
  const p = b64u(JSON.stringify(payload));
  const sig = b64u(createHmac('sha256', secret).update(p).digest()).slice(0, 32);
  return `v1.${p}.${sig}`;
}

export function verifyCredential(cred, secret, now = Date.now()) {
  const parts = String(cred || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'malformed' };
  const [, p, sig] = parts;
  const want = b64u(createHmac('sha256', secret).update(p).digest()).slice(0, 32);
  const a = Buffer.from(sig), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };
  let payload;
  try { payload = JSON.parse(unb64u(p).toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!payload || typeof payload !== 'object' || typeof payload.s !== 'string') return { ok: false, reason: 'malformed' };
  if (Number.isFinite(payload.e) && payload.e <= now) return { ok: false, reason: 'expired', payload };
  return { ok: true, payload };
}

/**
 * Ownership directory + credential issuer for one process. `slot`/`instanceId` describe THIS process; the
 * backend is shared by both slots so either can answer for the other.
 */
export class SessionDirectory {
  /**
   * @param {{
   *   instanceId: string, slot: string, secret: string,
   *   backend?: { load: () => object, save: (obj: object) => void }, file?: string | null,
   *   peers?: Record<string, number>, leaseMs?: number, credentialMs?: number, now?: () => number, log?: object,
   * }} opts
   */
  constructor({ instanceId, slot, secret, backend = null, file = null, peers = {}, leaseMs = 60_000, credentialMs = 24 * 60 * 60 * 1000, now = Date.now, log = null }) {
    if (!instanceId) throw new TypeError('SessionDirectory: instanceId required');
    if (!slot) throw new TypeError('SessionDirectory: slot required');
    if (!secret) throw new TypeError('SessionDirectory: secret required (SP_ROUTE_SECRET)');
    this.instanceId = instanceId;
    this.slot = slot;
    this.secret = secret;
    this.leaseMs = leaseMs;
    this.credentialMs = credentialMs;
    this.now = now;
    this.log = log;
    this.file = file;
    /**
     * The other slots' LOOPBACK ports ("<slot>=<port>", from SP_ROUTE_PEERS) — the only places step 3 will hand an
     * upgrade to; nothing else in a box knows them and a client can never name one. @type {Record<string, number>}
     */
    this.peers = peers && typeof peers === 'object' ? { ...peers } : {};
    this.backend = backend || (file ? fileBackend(file) : memoryBackend());
    /** @type {Map<string, {sid:string, instanceId:string, slot:string, generation:number, leaseUntil:number, recoverUntil:number, roomCode:string|null, updatedAt:number}>} */
    this.entries = new Map();
    this.generation = 1;
    this._load();
  }

  _load() {
    try {
      const raw = this.backend.load() || {};
      this.generation = Number.isInteger(raw.generation) && raw.generation > 0 ? raw.generation : 1;
      for (const [sid, e] of Object.entries(raw.entries || {})) if (e && typeof e === 'object') this.entries.set(sid, e);
    } catch (err) {
      // A directory we cannot read is treated as EMPTY, never as "everything is ours": routing must fail
      // towards "look up / mint", not towards stealing or dropping another process's sessions.
      this.log?.warn?.('[route] directory unreadable, starting empty', err?.message);
    }
  }

  _flush() {
    try { this.backend.save({ v: 1, generation: this.generation, entries: Object.fromEntries(this.entries) }); }
    catch (err) { this.log?.warn?.('[route] directory write failed', err?.message); }
  }

  /**
   * Re-read the shared backend before answering. The two slots are separate processes writing one file, so a
   * one-shot load at construction would answer from a snapshot the other slot has already moved past. Our own
   * live entries always win (we are authoritative for the sessions we hold); everything else is taken from disk.
   */
  _sync() {
    let raw;
    try { raw = this.backend.load() || {}; } catch { return; }
    const g = Number.isInteger(raw.generation) && raw.generation > 0 ? raw.generation : this.generation;
    if (g > this.generation) this.generation = g;
    for (const [sid, e] of Object.entries(raw.entries || {})) {
      if (!e || typeof e !== 'object') continue;
      const mine = this.entries.get(sid);
      if (mine && mine.instanceId === this.instanceId) continue;
      this.entries.set(sid, e);
    }
  }

  /** This process's ownership record for a session, with a fresh lease and a signed credential for the client. */
  register(token, { roomCode = null, recoverUntil = null } = {}) {
    const sid = tokenHash(token);
    const now = this.now();
    const entry = {
      sid, instanceId: this.instanceId, slot: this.slot, generation: this.generation,
      leaseUntil: now + this.leaseMs,
      // The RECOVERY deadline is the session's own window (co-op ~10 min, solo up to 24 h). Kept apart from the
      // lease on purpose: the reaper must not reuse a slot that still owes a recoverable session.
      recoverUntil: Number.isFinite(recoverUntil) ? recoverUntil : now + this.credentialMs,
      roomCode: roomCode || null, updatedAt: now,
    };
    this.entries.set(sid, entry);
    this._flush();
    return { sid, credential: this.credentialFor(entry) };
  }

  credentialFor(entry, ttlMs = this.credentialMs) {
    return signCredential({ s: entry.sid, i: entry.instanceId, k: entry.slot, g: entry.generation, e: this.now() + ttlMs }, this.secret);
  }

  /** Who owns this token? `alive` says whether that owner's lease is still fresh. */
  resolve(token, { sweep = true } = {}) {
    this._sync();
    const sid = tokenHash(token);
    const e = this.entries.get(sid);
    if (!e) return { found: false, sid };
    if (sweep && this._expired(e)) { this.entries.delete(sid); this._flush(); return { found: false, sid }; }
    return { found: true, sid, entry: e, alive: e.leaseUntil > this.now(), mine: e.instanceId === this.instanceId };
  }

  /** Resolve a client-presented credential WITHOUT trusting it: signature, expiry and the current directory are all checked. */
  resolveCredential(cred) {
    this._sync();
    const v = verifyCredential(cred, this.secret, this.now());
    if (!v.ok) return v;
    const e = this.entries.get(v.payload.s);
    if (!e) return { ok: false, reason: 'unknown-session', payload: v.payload };
    if (e.generation !== v.payload.g && v.payload.g !== 0) {
      // The session was handed over since this credential was issued — the holder moved on.
      return { ok: false, reason: 'stale-generation', entry: e, payload: v.payload };
    }
    return { ok: true, entry: e, payload: v.payload, mine: e.instanceId === this.instanceId };
  }

  /** Keep this process's ownership fresh while the socket is alive. */
  renew(token) {
    const e = this.entries.get(tokenHash(token));
    if (!e || e.instanceId !== this.instanceId) return false;
    e.leaseUntil = this.now() + this.leaseMs;
    e.updatedAt = this.now();
    this._flush();
    return true;
  }

  /**
   * Give up ownership (the socket closed for good, the session expired). A generation bump makes every
   * credential issued for the old holder stale, so a client cannot come back to a released slot.
   */
  release(token, { bumpGeneration = true } = {}) {
    const sid = tokenHash(token);
    const e = this.entries.get(sid);
    if (!e) return false;
    this.entries.delete(sid);
    if (bumpGeneration) this.generation++;
    this._flush();
    return true;
  }

  /** Drop entries whose RECOVERY window has passed (what the reaper may treat as truly gone). */
  sweep() {
    this._sync();
    const now = this.now();
    let dropped = 0;
    for (const [sid, e] of this.entries) {
      if (this._expired(e, now)) { this.entries.delete(sid); dropped++; }
    }
    if (dropped) this._flush();
    return dropped;
  }

  _expired(e, now = this.now()) {
    const rec = Number.isFinite(e.recoverUntil) ? e.recoverUntil : 0;
    // Dead only when BOTH the routing lease and the session's own recovery window are over.
    return e.leaseUntil <= now && rec <= now;
  }

  /** What this process still owes its players — the reaper's real question (sockets==0 is NOT enough). */
  obligations({ slot = this.slot, now = this.now() } = {}) {
    this._sync();
    const mine = [...this.entries.values()].filter((e) => e.slot === slot);
    const recoverable = mine.filter((e) => !this._expired(e, now));
    return { total: mine.length, recoverable: recoverable.length, maxRecoverUntil: recoverable.reduce((m, e) => Math.max(m, e.recoverUntil || 0), 0) };
  }

  /** Slots that still hold recoverable sessions (so a deploy cannot recycle them yet). */
  busySlots({ now = this.now() } = {}) {
    this._sync();
    const out = new Map();
    for (const e of this.entries.values()) {
      if (this._expired(e, now)) continue;
      out.set(e.slot, (out.get(e.slot) || 0) + 1);
    }
    return out;
  }
}

function memoryBackend() {
  let box = null;
  return { load: () => box, save: (obj) => { box = obj; } };
}

/** Default backend for a single box with two slots: one JSON file, replaced atomically. */
function fileBackend(file) {
  const tmp = `${file}.tmp`;
  return {
    load: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
    save: (obj) => {
      writeFileSync(tmp, JSON.stringify(obj));
      try { renameSync(tmp, file); } catch (err) { try { unlinkSync(tmp); } catch { /* ignore */ } throw err; }
    },
  };
}

/** A random per-process instance id (also usable as the `SP_ROUTE_INSTANCE` override). */
export function newInstanceId(prefix = 'sp') {
  return `${prefix}-${randomBytes(6).toString('hex')}`;
}
