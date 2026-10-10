#!/usr/bin/env node
// tools/ws-link-gate.mjs — the upstream-sync gate for the fork-only WS-link layer.
//
// Why this exists: everything the WS-link work adds lives ON TOP OF upstream files —
// `server/wsCompression.js` does not exist upstream, and upstream's `server/http/websocket.js` pins
// `perMessageDeflate: false`, its `net.js` sendRaw has no `compress` flag and its `lobby.js`
// broadcastRoom passes no compression. A wholesale upstream sync therefore SILENTLY reverts the layer:
// the server starts, the handshake simply stops offering permessage-deflate, and nothing errors.
// That already happened once on the box (both slots came back as `win=9`, whitelist without m.public,
// broadcast uncompressed, and the slot cmd's SP_WS_COMPRESSION line rewritten away).
//
// Run it after every upstream merge (and in CI): `node tools/ws-link-gate.mjs`.
// Exit 0 = the layer is intact; 1 = it was dropped, with the file and the fix named.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);

const checks = [];
const want = (name, file, ok, fix) => checks.push({ name, file, ok: !!ok, fix });

// 1. the compression module itself (a fork addition — an upstream file list would not bring it back)
const wsc = read('server/wsCompression.js');
want('wsCompression.js exists', 'server/wsCompression.js', wsc, 'restore the module (it is a fork addition)');
want('whitelist covers m.public', 'server/wsCompression.js', wsc && /'m\.public'/.test(wsc), 'add m.public to isCompressibleType');
want('whitelist covers m.private / m.result', 'server/wsCompression.js', wsc && /'m\.private'/.test(wsc) && /'m\.result'/.test(wsc), 'add them to isCompressibleType');
want('window bits is 12 (m.public is ~4.6 KB)', 'server/wsCompression.js', wsc && /serverMaxWindowBits:\s*12/.test(wsc), 'set serverMaxWindowBits: 12');

// 2. the WebSocket server must still hand perMessageDeflate over to the module (upstream pins it false)
const ws = read('server/http/websocket.js');
want('websocket.js does not pin perMessageDeflate: false', 'server/http/websocket.js', ws && !/perMessageDeflate:\s*false/.test(ws), 'pass the resolved options through (server/wsCompression.js)');

// 3. the send paths — sendRaw must know `compress`, broadcastRoom must pass it
const net = read('server/net.js');
want('sendRaw accepts a compress flag', 'server/net.js', net && /compress/.test(net) && /export function sendRaw/.test(net), 'restore the compress option on sendRaw');
const lobby = read('server/lobby.js');
want('broadcastRoom passes compress', 'server/lobby.js', lobby && /isCompressibleType/.test(lobby) && /sendRaw\([^)]*compress/.test(lobby), 'pass compress in broadcastRoom (m.public is broadcast, not unicast)');

// 4. the other fork-only layer on the same wire: the two-tier per-WATCHER snapshot cadence.
//    Two independent cadences, chosen by whether you drive the field: SNAPSHOT_EVERY for a player of it,
//    SNAPSHOT_EVERY_IDLE for a mere watcher. Upstream shipped neither constant nor the split, so a sync
//    reverts it silently — the battle still runs and the frames still arrive, just 4× as often as they
//    need to for everyone who only watches. That is invisible in a smoke test and only shows up on the
//    box's uplink graph, which is the whole reason this gate exists.
want('snapRate module exists', 'server/match/snapRate.js', read('server/match/snapRate.js'), 'restore server/match/snapRate.js (fork addition)');
const constants = read('server/sim/constants.js');
want('constants.js names the idle cadence', 'server/sim/constants.js', constants && /export const SNAPSHOT_EVERY_IDLE/.test(constants), 'restore SNAPSHOT_EVERY_IDLE (fork addition; upstream has only the base rate)');
const fields = read('server/match/fields.js');
want('fields.js imports the idle cadence', 'server/match/fields.js', fields && /SNAPSHOT_EVERY_IDLE/.test(fields), 'restore the import in server/match/fields.js');
want('fields.js splits the cadence by whether the watcher drives the field', 'server/match/fields.js', fields && /IDLE_SNAP_EVERY/.test(fields) && /f\.players\.includes\(pid\)/.test(fields), 'restore the per-watcher `every` in _emit');
// The retired link-adaptive gear: SNAPSHOT_EVERY_FAST naming a second rate is exactly what a re-arm must
// not stumble over, so this is the one check that FAILS in the desired direction — it fires when someone
// re-arms the gear, and says which way to move. See server/match/snapRate.js for the kept thresholds.
want('no second rate is armed (SNAPSHOT_EVERY_FAST === SNAPSHOT_EVERY)', 'server/sim/constants.js', constants && /export const SNAPSHOT_EVERY_FAST = SNAPSHOT_EVERY;/.test(constants), 'EXPECTED if you re-armed the adaptive gear: delete this check and restore the old one from git history');

// 5. the box updater must keep writing the switch, or a slot flip silently disables compression
const box = read('tools/box/sp_update_zip.ps1');
want('box updater writes SP_WS_COMPRESSION', 'tools/box/sp_update_zip.ps1', box && /set SP_WS_COMPRESSION=on/.test(box), 'add the line to the generated slot cmd');

const bad = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}  (${c.file})`);
if (bad.length) {
  console.log(`\n${bad.length} of ${checks.length} checks failed — the upstream sync dropped the WS-link layer.`);
  for (const c of bad) console.log(`  fix: ${c.fix}  [${c.file}]`);
  console.log('\nSilent revert looks like: the server runs fine, but the handshake stops offering');
  console.log('permessage-deflate, and every watcher pays the driver\'s 20 Hz. Verify on the live slot with');
  console.log('a real Upgrade handshake, not a HEAD request.');
  process.exit(1);
}
console.log(`\nall ${checks.length} checks passed — the WS-link layer is intact.`);
