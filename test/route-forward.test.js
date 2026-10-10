// test/route-forward.test.js — phase 1, step 3: the upgrade reaches the slot that OWNS the session.
//
// Steps 1–2 proved the credential travels and verifies. This is the part that actually MOVES the socket: two real
// processes sharing one directory file, where a client holding slot B's credential connects to slot A's port and
// must end up talking to B — resuming the session there rather than being minted a new one.
//
// The invariants that matter and that these tests pin:
//   * a flip does not strand the session — `resumed: true` and the same playerId on the owning slot;
//   * the hand-off only ever goes to a configured peer port, and NEVER to this process's own port (a loop would be
//     an outage, not a bug);
//   * every failure is "serve it here" — an unreachable peer, a bad target, no credential: all still connect;
//   * the client's real address survives the hop, so the per-address cap still applies on the owner.
// Run: node --test test/route-forward.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { forwardTarget, forwardUpgrade, upgradeRequestBytes } from '../server/http/routeForward.js';

const SECRET = 'test-fwd-secret';
const dirFile = () => join(mkdtempSync(join(tmpdir(), 'sprf-')), 'sessions.json');
const wsUrl = (port) => `ws://127.0.0.1:${port}/ws`;

/** slot A active at :portA, slot B idle at :portB, both sharing one directory and knowing each other's port. */
async function twoSlots(file, t) {
  const srvB = await startServer({ port: 0, host: '127.0.0.1', quiet: true, route: { file, secret: SECRET, slot: 'B', instanceId: 'inst-B', peers: {} } });
  const peersA = { B: srvB.port };
  const srvA = await startServer({ port: 0, host: '127.0.0.1', quiet: true, route: { file, secret: SECRET, slot: 'A', instanceId: 'inst-A', peers: peersA } });
  t.after(() => Promise.all([srvA.close(), srvB.close()]));
  return { srvA, srvB };
}

test('forwardTarget: only a foreign slot with a configured port, and never our own', () => {
  const peers = { B: 3001 };
  assert.equal(forwardTarget(null, peers, 3002), null, 'no credential ⇒ serve here');
  assert.equal(forwardTarget({ mine: true, slot: 'B' }, peers, 3002), null, 'ours ⇒ serve here');
  assert.equal(forwardTarget({ mine: false, slot: 'B' }, peers, 3002), 3001);
  assert.equal(forwardTarget({ mine: false, slot: 'C' }, peers, 3002), null, 'a slot with no port ⇒ serve here');
  assert.equal(forwardTarget({ mine: false, slot: 'B' }, peers, 3001), null, 'the peer port is OUR port ⇒ never loop');
  assert.equal(forwardTarget({ mine: false, slot: 'B' }, {}, 3002), null, 'no peers configured ⇒ serve here');
  for (const bad of [0, -1, 65536, 1.5, '3001', NaN]) {
    assert.equal(forwardTarget({ mine: false, slot: 'B' }, { B: bad }, 3002), null, `junk port ${bad}`);
  }
});

test('the replayed request keeps the upgrade verbatim and appends the real client', () => {
  const req = {
    method: 'GET', url: '/ws?cred=v1.aaa.bbb', httpVersion: '1.1',
    rawHeaders: ['Host', 'h.example', 'Upgrade', 'websocket', 'Connection', 'Upgrade', 'Sec-WebSocket-Key', 'k1', 'Sec-WebSocket-Version', '13'],
  };
  const bytes = upgradeRequestBytes(req, '203.0.113.7').toString('utf8');
  assert.ok(bytes.startsWith('GET /ws?cred=v1.aaa.bbb HTTP/1.1\r\n'), 'the request line including the credential');
  assert.ok(bytes.includes('Sec-WebSocket-Key: k1'), 'the client handshake survives');
  assert.ok(bytes.endsWith('Host: h.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: k1\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-For: 203.0.113.7\r\n\r\n'), 'one X-Forwarded-For appended last');

  const existing = { ...req, rawHeaders: [...req.rawHeaders, 'X-Forwarded-For', '198.51.100.4'] };
  const appended = upgradeRequestBytes(existing, '203.0.113.7').toString('utf8');
  assert.ok(appended.includes('X-Forwarded-For: 198.51.100.4, 203.0.113.7'), 'what an outer proxy said is preserved');
  assert.ok(!appended.includes('X-Forwarded-For: 203.0.113.7\r\n\r\nX-Forwarded-For'), 'exactly one header is emitted');
  // A poisoned address must not reach the header line: losing the cap beats an injection.
  assert.ok(!upgradeRequestBytes(req, 'evil\r\nX-Injected: 1').toString('utf8').includes('X-Injected'), 'not an IP ⇒ dropped, not escaped');
});

test('an unreachable peer falls back to serving the socket here', { timeout: 10000 }, async (t) => {
  // Port 1 refuses instantly; the client must still get a working connection to this slot.
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
  t.after(() => srv.close());
  const forwarded = await forwardUpgrade({
    req: { method: 'GET', url: '/ws', httpVersion: '1.1', rawHeaders: ['Host', 'h'] },
    socket: { pipe() { throw new Error('must not be spliced'); } },
    head: Buffer.alloc(0), port: 1, log: { warn() {}, debug() {} },
  });
  assert.equal(forwarded, false, 'a dead peer is never fatal');
});

test('a seat whose credential names the other slot lands on that slot and resumes there', { timeout: 15000 }, async (t) => {
  const file = dirFile();
  const { srvA, srvB } = await twoSlots(file, t);

  // Seat created on B — what a player connected before the flip has: B owns it.
  const b1 = await TestClient.connect(wsUrl(srvB.port));
  const wb = await b1.hello('Flip');
  assert.equal(typeof wb.cred, 'string');
  await b1.terminate();

  // nginx now points at A, and the browser reconnects there carrying B's credential.
  const c = await TestClient.connect(`${wsUrl(srvA.port)}?cred=${wb.cred}`);
  const w = await c.hello('Flip', wb.token);
  assert.equal(w.resumed, true, 'NOT a new session: the flip did not strand it');
  assert.equal(w.playerId, wb.playerId, 'same player id, living on the slot that owns it');

  // The proof that it really moved: B has the live socket, A minted nothing.
  assert.ok(srvB.registry.byToken(wb.token), 'the owning slot holds the session');
  assert.equal(srvA.registry.byToken(wb.token), null, 'the entry slot never adopted it');
  assert.equal(srvB.registry.byToken(wb.token).connected, true, 'and it is live on the owner');
  await c.close();
});

test('a session owned by this slot is not forwarded away', { timeout: 15000 }, async (t) => {
  const file = dirFile();
  const { srvA } = await twoSlots(file, t);
  const c1 = await TestClient.connect(wsUrl(srvA.port));
  const w1 = await c1.hello('Owner');
  await c1.terminate();
  const c2 = await TestClient.connect(`${wsUrl(srvA.port)}?cred=${w1.cred}`);
  const w2 = await c2.hello('Owner', w1.token);
  assert.equal(w2.resumed, true);
  assert.ok(srvA.registry.byToken(w1.token), 'it stays on the slot that owns it');
  const hint = srvA.registry.byToken(w1.token).routeHint;
  assert.deepEqual(hint, { mine: true, slot: 'A', instanceId: 'inst-A', sid: hint.sid });
  await c2.close();
});

test('with no peers configured every socket is served here (the layer off)', { timeout: 15000 }, async (t) => {
  const file = dirFile();
  const srvB = await startServer({ port: 0, host: '127.0.0.1', quiet: true, route: { file, secret: SECRET, slot: 'B', instanceId: 'inst-B', peers: {} } });
  const srvA = await startServer({ port: 0, host: '127.0.0.1', quiet: true, route: { file, secret: SECRET, slot: 'A', instanceId: 'inst-A', peers: {} } });
  t.after(() => Promise.all([srvA.close(), srvB.close()]));
  const b = await TestClient.connect(wsUrl(srvB.port));
  const wb = await b.hello('NoPeers');
  await b.terminate();
  // A would be the wrong slot, but nobody told it where B is: serving the socket here is the only safe answer.
  const c = await TestClient.connect(`${wsUrl(srvA.port)}?cred=${wb.cred}`);
  const w = await c.hello('NoPeers', wb.token);
  assert.equal(w.resumed, false, 'new session — exactly what happened before this layer existed');
  assert.ok(srvA.registry.byToken(w.token), 'adopted here, not dropped');
  await c.close();
});
