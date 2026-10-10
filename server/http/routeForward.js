// server/http/routeForward.js — phase 1, step 3: send an inbound `/ws` upgrade to the slot that OWNS the session.
//
// Why this exists: nginx points :3000 at whichever slot is ACTIVE, but after a blue/green flip the session a
// reconnecting browser wants still lives in the OTHER process (SessionRegistry is in-memory per process). So the
// active slot must be able to say "not mine — slot B has it" and hand the socket over instead of minting a new
// session. Steps 1–2 built the directory and the signed credential that carries the answer; this file is the part
// that actually moves the bytes.
//
// Deliberately dumb and low-level:
//   * a raw TCP splice — the upgrade request and the already-parsed `head` are replayed to the peer verbatim, so
//     the owning slot performs its own `handleUpgrade`, its own admission and its own `hello`. This slot never
//     parses a frame and never learns the token;
//   * only ever to a LOOPBACK port from the configured peer map (`SP_ROUTE_PEERS`), never to anything a client
//     named — the credential carries no port by design, so a client cannot steer this at another host;
//   * a failure (no peer configured, peer down, self, timeout) means SERVE IT HERE, which is exactly the behaviour
//     of the server before this layer existed. A routing hint is an optimisation, never a gate.
//
// One subtlety worth naming: the peer sees the connection arrive from 127.0.0.1, which is a "local peer" that
// `clientAddress` would exempt from the per-address connection cap. So the original client address is appended to
// `X-Forwarded-For` on the way through, and the peer (trustProxy 'auto', which honours forwarded headers from
// loopback) still counts the real address against its cap.
import { connect } from 'node:net';
import { isIP } from 'node:net';

/** How long to wait for the owning slot to accept before giving up and serving the socket here. */
export const FORWARD_CONNECT_TIMEOUT_MS = 1500;

/**
 * The peer port this upgrade should be handed to, or null when it should be served by this process.
 *
 * Null is the answer for: no verified credential, a credential that resolves to US, an unknown slot, a slot with
 * no configured port, and — importantly — a peer port that is our own listening port (a misconfigured peer map
 * must not turn one inbound socket into an endless loop of hand-offs).
 * @param {{ mine: boolean, slot: string } | null | undefined} route the verified credential (Network.routeCredential)
 * @param {Record<string, number>} peers slot name → loopback port
 * @param {number | undefined} ownPort this process's listening port
 * @returns {number | null}
 */
export function forwardTarget(route, peers, ownPort) {
  if (!route || route.mine !== false) return null;
  const port = peers && Object.hasOwn(peers, route.slot) ? peers[route.slot] : null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (Number.isInteger(ownPort) && port === ownPort) return null;
  return port;
}

/**
 * The upgrade request exactly as it arrived, plus the real client address as a forwarded header.
 * @param {import('node:http').IncomingMessage} req
 * @param {string} clientIp what this process resolved the client address to (never a credential or a token)
 * @returns {Buffer}
 */
export function upgradeRequestBytes(req, clientIp) {
  // Sanitised HERE, not by the caller: anything that is not an IP literal is dropped rather than escaped, because a
  // client-controlled value that reaches a header line unchecked is a header injection. Losing the per-address cap
  // on such a connection is the acceptable cost.
  const safeIp = (() => {
    const s = String(clientIp ?? '').trim();
    return s && isIP(s) ? s : '';
  })();
  const head = [`${req.method || 'GET'} ${req.url || '/'} HTTP/${req.httpVersion || '1.1'}`];
  const raw = Array.isArray(req.rawHeaders) ? req.rawHeaders : null;
  let sawForwardedFor = false;
  if (raw) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = raw[i];
      let value = raw[i + 1];
      if (String(name).toLowerCase() === 'x-forwarded-for') {
        sawForwardedFor = true;
        // Preserve what upstream proxies already said and append ourselves: the peer reads the rightmost entry.
        value = safeIp ? `${value}, ${safeIp}` : value;
      }
      head.push(`${name}: ${value}`);
    }
  } else {
    for (const [name, value] of Object.entries(req.headers || {})) {
      if (String(name).toLowerCase() === 'x-forwarded-for') sawForwardedFor = true;
      head.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
    }
  }
  if (!sawForwardedFor && safeIp) head.push(`X-Forwarded-For: ${safeIp}`);
  head.push('', '');
  return Buffer.from(head.join('\r\n'), 'utf8');
}

/** An address safe to put in a header line: only what `clientAddress` would have produced. */
function safeClientIp(ip) {
  const s = String(ip ?? '').trim();
  if (!s) return '';
  // Anything that is not an IP literal is refused rather than escaped: a header injection is worse than losing the cap.
  return isIP(s) ? s : '';
}

/**
 * Hand an inbound upgrade to the owning slot: connect to its loopback port, replay the request and the buffered
 * `head`, then splice the two sockets together. Resolves true when the hand-off started (the caller must return
 * and touch this socket no further) and false when the socket should be served HERE instead — which is what any
 * failure means, because before this layer every socket was served here.
 *
 * Never throws, and never leaves the caller's socket half-forwarded: on any failure the socket is returned
 * untouched (still unread, `head` still buffered) so `handleUpgrade` can proceed as usual.
 * @param {{
 *   req: import('node:http').IncomingMessage, socket: import('node:net').Socket, head: Buffer,
 *   port: number, clientIp?: string, log?: object, timeoutMs?: number,
 * }} args
 * @returns {Promise<boolean>}
 */
export function forwardUpgrade({ req, socket, head, port, clientIp = '', log = null, timeoutMs = FORWARD_CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (forwarded) => { if (!settled) { settled = true; resolve(forwarded); } };
    let up = null;
    const cleanup = () => {
      if (up && !up.destroyed) { up.removeAllListeners(); up.destroy(); }
    };
    try {
      up = connect({ host: '127.0.0.1', port }, () => {
        if (settled) { cleanup(); return; }
        try {
          up.write(upgradeRequestBytes(req, safeClientIp(clientIp)));
          if (head && head.length) up.write(head);
          // Both directions, for the whole life of the socket: from here on the two ends talk to each other.
          socket.pipe(up);
          up.pipe(socket);
          const passErrors = (which) => () => {
            log?.debug?.(`[route] forwarded socket ${which} ended`);
            try { socket.destroy(); } catch { /* ignore */ }
            cleanup();
          };
          socket.on('error', () => { cleanup(); });
          up.on('error', passErrors('upstream'));
          socket.on('close', passErrors('client'));
          up.on('close', () => { try { socket.destroy(); } catch { /* ignore */ } });
          done(true);
        } catch (err) {
          log?.warn?.('[route] hand-off failed, serving here', err?.message);
          cleanup();
          done(false);
        }
      });
      up.setTimeout(timeoutMs, () => {
        log?.warn?.(`[route] slot :${port} did not accept in ${timeoutMs} ms, serving here`);
        cleanup();
        done(false);
      });
      up.on('error', (err) => {
        log?.warn?.(`[route] slot :${port} unreachable (${err?.code || err?.message}), serving here`);
        cleanup();
        done(false);
      });
    } catch (err) {
      log?.warn?.('[route] hand-off failed, serving here', err?.message);
      cleanup();
      done(false);
    }
  });
}
