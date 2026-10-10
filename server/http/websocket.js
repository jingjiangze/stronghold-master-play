// server/http/websocket.js — the real-time side of the server:
//
//   * session wiring: SessionRegistry (reconnect tokens) → Lobby (rooms, server/lobby.js) → Network (the socket
//     protocol, server/net.js), built from the startServer() options (config.js decides which go where);
//   * session-ownership routing (phase 1, OFF unless configured): a SessionDirectory shared by the box's slots, so
//     `welcome` carries the seat's routing credential and an inbound `/ws?cred=…` is verified at the upgrade;
//   * WebSocket (ws) at /ws, maxPayload 64 KB, no per-message deflate → Network.handleConnection. Refused at the
//     upgrade: any other path 404; per-network socket limit for internet clients (maxConnectionsPerAddr, see net.js
//     clientAddress; local/LAN peers are exempt) 429; server full (maxConnections) or shutting down 503.

import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from '../net.js';
import { Lobby } from '../lobby.js';
import { SessionDirectory } from '../sessionDirectory.js';
import { splitUrl } from './common.js';
import { forwardTarget, forwardUpgrade } from './routeForward.js';
import { netOptionsFrom, lobbyOptionsFrom, routeOptionsFrom } from './config.js';

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/**
 * The session stack of one server.
 * @param {{ MatchClass?: Function, seedFn?: () => number, route?: false | object, [option: string]: any }} opts
 *   startServer() options; `route` is the session-routing layer (server/sessionDirectory.js), or false to disable it
 * @param {{ data: object, log: object }} deps the game data the lobby's matches use, the logger
 * @returns {{ registry: SessionRegistry, lobby: Lobby, network: Network, directory: SessionDirectory | null }}
 */
export function createSessionStack(opts, { data, log }) {
  const netOptions = netOptionsFrom(opts);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = lobbyOptionsFrom(opts);
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions });
  // Session-ownership routing (phase 1): null unless SP_ROUTE_DIRECTORY + SP_ROUTE_SECRET (or the `route` option)
  // are configured — see server/http/config.js routeOptionsFrom. Both slots of a box point at ONE directory file.
  const routeOptions = routeOptionsFrom(opts);
  const directory = routeOptions ? new SessionDirectory(routeOptions) : null;
  const network = new Network({ registry, handler: lobby, directory, log, options: netOptions });
  return { registry, lobby, network, directory };
}

/**
 * Serve the WebSocket endpoint /ws on `server` (its 'upgrade' event).
 * @param {import('node:http').Server} server
 * @param {{ network: Network, log: object, wsCompression?: false | object,
 *           peers?: Record<string, number>, ownPort?: () => (number | undefined) }} deps wsCompression: the
 *   `perMessageDeflate` option set (server/wsCompression.js); false (the default) leaves compression off.
 *   peers/ownPort: step 3 of the session-routing layer — a socket whose credential belongs to another slot is handed
 *   to that slot's loopback port instead of being served here (see server/http/routeForward.js). Both default to
 *   nothing to hand over, which is the behaviour of the server before that layer existed.
 * @returns {WebSocketServer}
 */
export function attachWebSocket(server, { network, log, wsCompression = false, peers = {}, ownPort = () => undefined }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: wsCompression, clientTracking: false });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    // Routing step 3: this socket may belong to the OTHER slot (a session the blue/green flip left there). The
    // credential decides, and a failure of any kind means serve it here — which is what this process always did.
    const target = forwardTarget(network.routeCredential(req), peers, ownPort());
    if (target) {
      // The real client address must survive the hop: the peer sees 127.0.0.1, a local peer the per-address cap
      // would otherwise exempt, so it is forwarded as a header the peer's own trustProxy already honours.
      let forwarded = false;
      if (Number.isInteger(target)) forwarded = await forwardUpgrade({ req, socket, head, port: target, clientIp: network.clientIpOf(req), log });
      if (forwarded) return; // the splice owns `socket` now; touching it again would corrupt the frame stream
    }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });
  return wss;
}
