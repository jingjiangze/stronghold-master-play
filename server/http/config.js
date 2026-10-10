// server/http/config.js — where the server's settings come from. startServer() options win over the environment:
//
//   * PORT (default 3000), HOST (default '::', one dual-stack socket for IPv6 and IPv4);
//   * TRUST_PROXY ('auto' default: honour CF-Connecting-IP / X-Real-IP / X-Forwarded-For only from loopback/private
//     peers such as a local cloudflared; '1' always; '0' never) → net.js trustProxy;
//   * the session-routing layer (SP_ROUTE_DIRECTORY / SP_ROUTE_SECRET / SP_ROUTE_SLOT / SP_ROUTE_INSTANCE /
//     SP_ROUTE_PEERS → server/sessionDirectory.js): OFF unless a directory file AND a secret are both configured;
//   * DEBUG → the console logger's debug level;
//   * the served directories (public/, data/, shared/ and the content packs' packs/ of this repository unless the
//     options name others), and which startServer() options are handed on to net.js Network and lobby.js Lobby.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newInstanceId } from '../sessionDirectory.js';

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** startServer() options handed on to net.js Network / lobby.js Lobby (an absent one keeps that module's default). */
const NET_OPTION_KEYS = ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
  'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy', 'linkProbeMs', 'linkWarmMs'];
const LOBBY_OPTION_KEYS = ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs', 'matchmaking'];

/**
 * Bind address used when neither the `host` option nor `HOST` says otherwise: one dual-stack socket, so the server
 * answers IPv6 and IPv4 alike without a second listener (Node keeps `ipv6Only` off for `::`).
 * `HOST=0.0.0.0` still means IPv4 only, `HOST=127.0.0.1` still means loopback only (a reverse proxy in front).
 */
export const DEFAULT_BIND_HOST = '::';

/**
 * Where to listen: the `port` / `host` options, else PORT / HOST, else port 3000 on DEFAULT_BIND_HOST.
 * An empty host is treated as unset.
 * @param {{ port?: number, host?: string }} opts
 * @returns {{ port: number, host: string }}
 * @throws {RangeError} when the port is not an integer in 0…65535
 */
export function listenAddress(opts) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = (opts.host || process.env.HOST) || DEFAULT_BIND_HOST;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  return { port, host };
}

/**
 * The hosts to try, in order, for a bind. Only the default is retried: a host with IPv6 switched off refuses `::`
 * with EAFNOSUPPORT / EADDRNOTAVAIL / EINVAL, and falling back to IPv4 beats not booting. An explicit HOST is literal.
 * @param {string} host a host out of listenAddress()
 * @returns {string[]}
 */
export function bindCandidates(host) {
  return host === DEFAULT_BIND_HOST ? [DEFAULT_BIND_HOST, '0.0.0.0'] : [host];
}

/**
 * The directories the static server reads (packsDir: the pack folders, server/packs.js).
 * @param {{ publicDir?: string, dataDir?: string, sharedDir?: string, packsDir?: string }} opts
 */
export function serveDirs(opts) {
  return {
    publicDir: opts.publicDir || path.join(ROOT, 'public'),
    dataDir: opts.dataDir || path.join(ROOT, 'data'),
    sharedDir: opts.sharedDir || path.join(ROOT, 'shared'),
    packsDir: opts.packsDir || path.join(ROOT, 'packs'),
  };
}

/** net.js Network options out of the startServer() options; `trustProxy` falls back to TRUST_PROXY. */
export function netOptionsFrom(opts) {
  const netOptions = {};
  for (const k of NET_OPTION_KEYS) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  return netOptions;
}

/** lobby.js Lobby options out of the startServer() options. */
export function lobbyOptionsFrom(opts) {
  const lobbyOptions = {};
  for (const k of LOBBY_OPTION_KEYS) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  return lobbyOptions;
}

/**
 * The box's slot map as the routing layer wants it: `SP_ROUTE_PEERS="A=3002,B=3001"` → `{ A: 3002, B: 3001 }`.
 * Only loopback ports are useful here (the forwarder never dials anything else), so junk entries are dropped.
 * @param {string | undefined} spec
 * @returns {Record<string, number>}
 */
export function parseRoutePeers(spec) {
  const out = {};
  for (const part of String(spec ?? '').split(',')) {
    const m = /^([A-Za-z0-9_-]{1,16})=(\d{1,5})$/.exec(part.trim());
    if (!m) continue;
    const port = Number(m[2]);
    if (port >= 1 && port <= 65535) out[m[1]] = port;
  }
  return out;
}

/**
 * Session-routing layer (server/sessionDirectory.js, phase 1 step 2/3): startServer() options win over the
 * environment, like the other option groups.
 *
 *   SP_ROUTE_DIRECTORY  the shared ownership-directory JSON file — BOTH slots must point at ONE file
 *   SP_ROUTE_SECRET     the HMAC secret of the routing credential (never the reconnect token)
 *   SP_ROUTE_SLOT       this slot's name (e.g. A/B) `SP_ROUTE_INSTANCE` its instance id (default: random per process)
 *   SP_ROUTE_PEERS      "<slot>=<loopback port>[,<slot>=<port>…]": where the OTHER slots listen on 127.0.0.1
 *
 * Returns null — the feature completely OFF, `welcome` without a credential, no forwarding — unless a directory
 * file AND a secret are both configured. That is what makes the layer reversible in one step (unset the two
 * variables) and what keeps a missing/renamed file from changing any behaviour.
 * @param {{ route?: false | object, [option: string]: any }} opts startServer() options
 * @param {NodeJS.ProcessEnv} [env]
 */
export function routeOptionsFrom(opts = {}, env = process.env) {
  if (opts.route === false) return null;
  const o = opts.route && typeof opts.route === 'object' ? opts.route : {};
  const file = o.file ?? env.SP_ROUTE_DIRECTORY ?? '';
  const secret = o.secret ?? env.SP_ROUTE_SECRET ?? '';
  if (!file || !secret) return null;
  const slot = String(o.slot ?? env.SP_ROUTE_SLOT ?? 'A');
  return {
    file,
    secret,
    slot,
    instanceId: o.instanceId ?? env.SP_ROUTE_INSTANCE ?? newInstanceId(slot.toLowerCase()),
    peers: o.peers ?? parseRoutePeers(env.SP_ROUTE_PEERS),
    leaseMs: o.leaseMs,
    credentialMs: o.credentialMs,
  };
}

/** TRUST_PROXY env → net.js trustProxy ('auto' unless explicitly on/off). @param {string | undefined} v */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

/** The console logger (`quiet` → silent; debug lines only with DEBUG set). */
export function makeLogger(quiet) {
  if (quiet) return noopLog;
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}
