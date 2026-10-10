// test/route-credential.test.js — the routing credential on the wire (phase 1, step 2).
//
// What matters here: `welcome` carries an OPTIONAL signed credential for the seat (omitted entirely without a
// routing directory — an old client sees byte-identical behaviour), the client keeps it per TAB next to the token
// it belongs to and presents it as `/ws?cred=…` on the next attempt, and the server verifies it at the upgrade
// WITHOUT it ever authenticating anything: the token still does, and an absent/expired/tampered/foreign credential
// leaves the connection on the exact path it took before this layer existed. The token never reaches the URL or a
// log line.
// Run: node --test test/route-credential.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { SessionDirectory, signCredential, tokenHash, verifyCredential, routeCredentialFromUrl } from '../server/sessionDirectory.js';
import { Net, createIdentity, withRouteCredential } from '../public/js/net.js';

const SECRET = 'test-route-secret';
const dirFile = () => join(mkdtempSync(join(tmpdir(), 'sprc-')), 'sessions.json');
const wsUrl = (port) => `ws://127.0.0.1:${port}/ws`;
const routeOpts = (file, over = {}) => ({ file, secret: SECRET, slot: 'A', instanceId: 'inst-A', peers: {}, ...over });

/** A credential of the real shape, signed with the test secret (payload may be minimal). */
const credFor = (sid, over = {}) => signCredential({ s: sid, i: 'inst-A', k: 'A', g: 1, e: Date.now() + 60_000, ...over }, SECRET);

/** A logger that collects every line, so a test can prove what was never written. */
function captureLog() {
  const lines = [];
  const push = (...a) => lines.push(a.map((x) => (x && x.message) || String(x)).join(' '));
  return { log: { info: push, warn: push, error: push, debug: push }, text: () => lines.join('\n') };
}

/** Minimal Storage double (same shape as test/client-identity-session.test.js). */
function storage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('the URL helper: no credential changes nothing, and the token never rides the URL', () => {
  const token = 'tok-abcdef0123456789';
  const cred = credFor(tokenHash(token));
  assert.equal(withRouteCredential('ws://h:3000/ws', null), 'ws://h:3000/ws', 'old client: byte-identical');
  assert.equal(withRouteCredential('ws://h:3000/ws', undefined), 'ws://h:3000/ws');
  assert.equal(withRouteCredential('ws://h:3000/ws', 'not-a-credential'), 'ws://h:3000/ws');
  assert.equal(withRouteCredential('ws://h:3000/ws', token), 'ws://h:3000/ws', 'a bare token is not a credential');
  const u = withRouteCredential('ws://h:3000/ws', cred);
  assert.equal(u, `ws://h:3000/ws?cred=${cred}`);
  assert.ok(!u.includes(token), 'the reconnect token is never in the URL');
  assert.equal(withRouteCredential('ws://h:3000/ws?x=1', cred), 'ws://h:3000/ws?x=1', 'a URL with a query is left alone');
});

test('reading the credential from a request target is shape-checked and never throws', () => {
  const cred = credFor('a'.repeat(32));
  assert.equal(routeCredentialFromUrl(`/ws?cred=${cred}`), cred);
  assert.equal(routeCredentialFromUrl(`/ws?a=1&cred=${cred}&b=2`), cred, 'not necessarily the first parameter');
  assert.equal(routeCredentialFromUrl('/ws'), null);
  assert.equal(routeCredentialFromUrl('/ws?cred='), null);
  assert.equal(routeCredentialFromUrl('/ws?cred=nope'), null);
  assert.equal(routeCredentialFromUrl('/ws?other=v1.x.y'), null);
  assert.equal(routeCredentialFromUrl('/ws?cred=v1.@@@.@@@'), null);
  assert.equal(routeCredentialFromUrl('/ws?cred=%E0%A4%A'), null, 'a malformed escape is a miss, not a throw');
  assert.equal(routeCredentialFromUrl(undefined), null);
  assert.equal(routeCredentialFromUrl(`/ws?cred=v1.${'a'.repeat(5000)}.${'b'.repeat(32)}`), null, 'absurd length refused');
});

test('the credential lives in sessionStorage, bound to the token of this tab', () => {
  const local = storage();
  const session = storage();
  const id = createIdentity({ local, session, tabId: 'tab-1', channel: null });
  const token = 'a'.repeat(32);
  const other = 'b'.repeat(32);
  const cred = credFor(tokenHash(token));
  id.saveToken(token);
  id.saveCred(token, cred);
  assert.equal(id.getCred(), cred);
  assert.equal(local.getItem('sp.cred'), null, 'never localStorage');
  assert.ok(session.getItem('sp.cred').includes(cred), 'per tab, in sessionStorage');
  // The tab falls back to a different token: that seat's credential must not be presented for it.
  id.saveToken(other);
  assert.equal(id.getCred(), null);
  // Forgetting the token forgets what was issued for it.
  id.clearToken();
  assert.equal(id.getCred(), null);
  assert.equal(session.getItem('sp.cred'), null);
  assert.equal(session.getItem('sp.token'), null);
});

test('without a routing directory `welcome` is exactly what it always was', async (t) => {
  const cap = captureLog();
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, log: cap.log });
  t.after(() => srv.close());
  const c1 = await TestClient.connect(wsUrl(srv.port));
  const w1 = await c1.hello('Old');
  assert.ok(!('cred' in w1), 'no credential field at all (an old client ignores it anyway)');
  assert.equal(w1.resumed, false);
  await c1.terminate();
  const c2 = await TestClient.connect(wsUrl(srv.port));
  const w2 = await c2.hello('Old', w1.token);
  assert.equal(w2.resumed, true, 'the token path is unchanged');
  assert.equal(w2.playerId, w1.playerId);
  assert.equal(srv.registry.byToken(w1.token).routeHint, null);
  assert.equal(srv.network.directory, null);
  await c2.close();
});

test('a valid credential at the upgrade resumes the seat on the instance that owns it', async (t) => {
  const file = dirFile();
  const cap = captureLog();
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, log: cap.log, route: routeOpts(file) });
  t.after(() => srv.close());

  const c1 = await TestClient.connect(wsUrl(srv.port));
  const w1 = await c1.hello('Routed');
  assert.equal(typeof w1.cred, 'string', 'the credential reaches the client');
  const v = verifyCredential(w1.cred, SECRET);
  assert.equal(v.ok, true);
  assert.equal(v.payload.s, tokenHash(w1.token));
  assert.ok(!w1.cred.includes(w1.token), 'the credential never carries the token');

  await c1.terminate();
  const c2 = await TestClient.connect(`${wsUrl(srv.port)}?cred=${w1.cred}`);
  const w2 = await c2.hello('Routed', w1.token);
  assert.equal(w2.resumed, true, 'the existing resumed path');
  assert.equal(w2.playerId, w1.playerId);
  assert.deepEqual(srv.registry.byToken(w1.token).routeHint, { mine: true, slot: 'A', instanceId: 'inst-A', sid: v.payload.s });
  assert.equal(typeof w2.cred, 'string', 'a fresh credential comes back with the welcome');
  assert.ok(!cap.text().includes(w1.token), 'the token never reaches a log line');
  assert.ok(!cap.text().includes(w1.cred), 'and neither does the credential');
  await c2.close();
});

test('expired, tampered and foreign credentials change nothing', async (t) => {
  const file = dirFile();
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, route: routeOpts(file) });
  t.after(() => srv.close());

  const c1 = await TestClient.connect(wsUrl(srv.port));
  const w1 = await c1.hello('Seat');
  await c1.terminate();
  const sid = tokenHash(w1.token);
  const now = Date.now();
  const expired = credFor(sid, { g: 0, e: now - 1000 });
  // Tamper the PAYLOAD (the signature covers it): same shape, different bytes.
  const [, payload, sig] = w1.cred.split('.');
  const flipped = (payload[0] === 'e' ? 'f' : 'e') + payload.slice(1);
  const tampered = `v1.${flipped}.${sig}`;
  // A credential the shared directory says belongs to ANOTHER instance/slot (the box's other process).
  const other = new SessionDirectory({ instanceId: 'inst-B', slot: 'B', secret: SECRET, file });
  const foreignToken = 'f'.repeat(32);
  const foreign = other.register(foreignToken).credential;

  for (const [label, cred, token, resumed] of [
    ['expired', expired, w1.token, true],   // the token still resumes: that path is untouched
    ['tampered', tampered, w1.token, true],
    ['foreign', foreign, foreignToken, false], // the registry here never saw that seat ⇒ a new session
  ]) {
    const c = await TestClient.connect(`${wsUrl(srv.port)}?cred=${cred}`);
    const w = await c.hello('Seat', token);
    assert.equal(w.resumed, resumed, `${label}: hello behaves as it does without the credential`);
    const hint = srv.registry.byToken(w.token).routeHint;
    if (label === 'foreign') assert.deepEqual(hint, { mine: false, slot: 'B', instanceId: 'inst-B', sid: tokenHash(foreignToken) }, 'verified, but not ours');
    else assert.equal(hint, null, `${label}: refused at the upgrade, no routing hint`);
    await c.close();
  }
});

test('the client stores the credential per tab and comes back with it on the URL', { timeout: 8000 }, async (t) => {
  const file = dirFile();
  const srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, route: routeOpts(file) });
  t.after(() => srv.close());

  const session = storage();
  const id = createIdentity({ local: storage(), session, tabId: 'tab-1', channel: null });
  await id.init();
  /** The socket URLs this client actually opened. */
  const opened = [];
  class RecordingWS extends WebSocket {
    constructor(url, ...rest) { super(url, ...rest); opened.push(url); }
  }
  const net = new Net({
    url: wsUrl(srv.port), WebSocket: RecordingWS,
    getToken: () => id.getToken(), getCred: () => id.getCred(),
  });
  t.after(() => net.close());
  net.on('welcome', (w) => { // what main.js does with a welcome
    id.saveToken(w.token);
    if (typeof w.cred === 'string') id.saveCred(w.token, w.cred); else id.clearCred();
  });
  const nextWelcome = () => new Promise((resolve, reject) => {
    const off = net.on('welcome', (w) => { clearTimeout(timer); off(); resolve(w); });
    const timer = setTimeout(() => { off(); reject(new Error('no welcome')); }, 3000);
  });
  const first = nextWelcome();
  net.setName('Client');
  const w1 = await first;
  assert.equal(opened[0], wsUrl(srv.port), 'the first attempt has no credential yet');
  assert.equal(id.getCred(), w1.cred);

  const second = nextWelcome();
  net.reconnectNow();
  const w2 = await second;
  assert.equal(w2.resumed, true);
  assert.equal(w2.playerId, w1.playerId);
  assert.ok(opened[1].startsWith(`${wsUrl(srv.port)}?cred=`), 'the reconnect carries the credential in the URL');
  assert.ok(!opened.some((u) => u.includes(w1.token)), 'no attempt ever puts the token in a URL');
  assert.deepEqual(srv.registry.byToken(w1.token).routeHint, { mine: true, slot: 'A', instanceId: 'inst-A', sid: tokenHash(w1.token) });
});
