// node app/tests/redundancy_send_test.js — "Send backup" = NovaLCT's redundancy page Send (hwsend.js buildRedundancyPlan),
// its Delete (clear), and the port-backup part of the layout Send, checked against what NovaLCT wrote in its recorded
// redundancy Sends (four H_20 cards 2026-09-27, the real H5 2026-10-11; compared frame by frame outside this test) and,
// when python is there, run on the helper's in-memory processor (tools\novalink.py SimLink).
var path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process'), H = require(path.join(__dirname, '..', 'hwsend.js'));
var fails = 0;
function ok(cond, text) { console.log((cond ? 'PASS ' : 'FAIL ') + text); if (!cond) fails++; }
function ws(plan) { return plan.ops.filter(function (o) { return o.op === 'w'; }); }
function hx(s) { return s.replace(/ /g, '').toLowerCase(); }
var P3 = [{ ps: 0, pp: 0, bs: 2, bp: 0 }, { ps: 0, pp: 1, bs: 2, bp: 1 }, { ps: 0, pp: 2, bs: 2, bp: 2 }];

// --- NovaLCT's redundancy Send with four H_20 cards (SC1 P1-3 -> SC3 P1-3)
var r = H.buildRedundancyPlan(null, { modelId: 0x7B48, senders: 4, backup: P3 }), w = ws(r);
ok(w.slice(0, 20).every(function (o, p) { return o.dst === 255 && o.hex === '00'; }) && w[3].addr === 0x0200001B && w[4].addr === 0x02000098 && w[19].addr === 0x02010043,
  'every port flag 00 to all cards first (20 single bytes)');
ok(w.slice(20, 23).map(function (o) { return o.dst + ':' + o.addr.toString(16); }).join() === '0:2000018,0:2000019,0:200001a', 'then each pair’s primary port flag 00 on its card');
ok(!r.ops.some(function (o) { return o.op === 'w' && (o.dev !== 0 || [0x01000001, 0x01000011, 0x05065000, 0x05066000, 0x05000000].indexOf(o.addr) >= 0); }),
  'no Save, no commit, no REDU / SSPE / NSSD (NovaLCT writes REDU on its Save only)');
var tbl = w.filter(function (o) { return o.addr === 0x02300000; })[0];
ok(tbl && tbl.hex === hx('9A 04 00 0F 00 03 1B 00 00 1B 00 03 27 00 00 00 00 02 00 00 01 02 01 00 02 02 02 00 00 02 00 00 01 02 01 00 02 02 02') && tbl.tolerate,
  'pair table = NovaLCT’s 39 bytes (tolerated: the H refuses it)');
var cps = r.ops.filter(function (o) { return o.op === 'copy'; });
ok(cps.length === 2 && cps[0].from === 0 && cps[0].to === 2 && JSON.stringify(cps[0].ranges) === JSON.stringify([[0x02000000, 256], [0x02000100, 256], [0x02010040, 80], [0x02010140, 192], [0x02010240, 512], [0x03000000, 81920], [0x020001EC, 4], [0x03100000, 896]]),
  'backup card 3 gets card 1’s blocks in NovaLCT’s write order (0x020001EC, then the card counts last)');
ok(cps[0].set.map(function (s) { return s[0].toString(16) + '=' + s[1]; }).join() === '2000018=80,2000019=80,200001a=80', 'backup ports flagged 0x80 inside the block');
ok(JSON.stringify(cps[1].ranges) === JSON.stringify([[0x020000D4, 5]]) && r.ops.indexOf(cps[1]) > r.ops.indexOf(tbl), '0x020000D4 = the primary’s, after the table');
var last = r.ops[r.ops.length - 1];
ok(last.addr === 0x020000AE && last.dst === 255 && r.ops[r.ops.length - 2].op === 'sleep', 'ends with 0x020000AE (after LCT’s 50 ms)');

// --- the real H5 (NovaLCT's Send, 2026-10-11): 10 pairs on one card, P1->P2, P3->P4 ... P19->P20
var P10 = []; for (var i = 0; i < 10; i++) P10.push({ ps: 0, pp: 2 * i, bs: 0, bp: 2 * i + 1 });
var h = H.buildRedundancyPlan(null, { modelId: 0x7B48, senders: 1, backup: P10 }), ht = ws(h).filter(function (o) { return o.addr === 0x02300000; })[0];
ok(ht.hex.indexOf(hx('9a 01 00 06 00 0a 00 00 00 01 00 02 00 03 00 04 00 05 00 06')) === 0 && ht.hex.length === 2 * 46, 'same-card table as NovaLCT on the H (46 B, listed once)');
var hc = h.ops.filter(function (o) { return o.op === 'copy' && o.ranges.length > 1; })[0];
ok(hc.from === 0 && hc.to === 0 && hc.slots.some(function (s) { return s[1] === 0x020001B7 && s[2] === 0x020001B8; }) && hc.slots.some(function (s) { return s[1] === 0x03000000 && s[2] === 0x03001000 && s[3] === 4096; }),
  'same card: the card is its own backup — P1’s coordinate table and DVI byte go into P2’s slot');

// --- Delete / clear (as NovaLCT's Delete with four H_20 cards)
var d1 = H.buildRedundancyPlan(null, { modelId: 0x7B48, senders: 4, backup: P3.slice(1), remove: [P3[0]] }), dw = ws(d1);
ok(dw.length === 2 && dw[0].dst === 2 && dw[0].addr === 0x02000018 && dw[0].hex === '00' && dw[1].hex === hx('9A 04 00 0F 00 02 17 00 00 17 00 02 1F 00 00 00 01 02 01 00 02 02 02 00 01 02 01 00 02 02 02'),
  'Delete one pair: its backup port flag 00 on card 3, then the table of the two left (as at 1027.6 s)');
var c0 = H.buildRedundancyPlan(null, { modelId: 0x7B48, senders: 4, backup: [], prev: P3 }), cw = ws(c0);
ok(cw.length === 4 && cw.slice(0, 3).every(function (o, k) { return o.dst === 2 && o.addr === 0x02000018 + k && o.hex === '00'; }) && cw[3].hex === hx('9A 00 00') + '000000000000000000000000',
  'clear all: every backup port 00, then the empty table 9A 00 00 + 12 zeros (as at 1031.7 s)');
var c1 = H.buildRedundancyPlan(null, { modelId: 0x7B48, senders: 4, backup: [] });
ok(c1.ops.some(function (o) { return o.op === 'reduclear' && o.table === hx('9A 00 00') + '000000000000000000000000'; }) && !ws(c1).length, 'clear without knowing the pairs: the helper reads them from the REDU record (op reduclear)');
ok((function () { try { H.buildRedundancyPlan(null, { modelId: 0x7B48, senders: 4, backup: [{ ps: 0, pp: 1, bs: 0, bp: 1 }] }); } catch (e) { return /itself/.test(e.message); } })(), 'a port backing itself up is refused');

// --- layout Send with pairs: the backup ports kept in step, NovaLCT's way
var cells = [];
for (var k = 0; k < 4; k++) cells.push({ row: 0, col: k, x: k * 64, y: 0, width: 64, height: 64, sender: 0, port: k < 2 ? 0 : 1, connect: k < 2 ? k : k - 2 });
var model = { screens: [{ type: 1, x: 0, y: 0, cols: 4, rows: 1, cells: cells }] };
var PX = [{ ps: 0, pp: 0, bs: 2, bp: 0 }, { ps: 0, pp: 1, bs: 2, bp: 15 }];
var L = H.buildSendPlan(model, { modelId: 0x7B48, senders: 4, backup: PX, now: new Date(2026, 9, 11) }), lw = ws(L);
var ae = lw.filter(function (o) { return o.addr === 0x020000AE; }), ix = function (o) { return L.ops.indexOf(o); };
ok(ae.length === 1 && ix(L.ops.filter(function (o) { return o.op === 'copy'; })[0]) < ix(ae[0]) && ix(lw.filter(function (o) { return o.addr === 0x020001EC; })[0]) < ix(L.ops.filter(function (o) { return o.op === 'copy'; })[0]),
  'one 0x020000AE, after the redundancy copy, which comes after the screen size');
ok(L.ops.some(function (o) { return o.op === 'unstash' && o.dst === 2 && o.addr === 0x020000F0; }) && lw.some(function (o) { return o.dst === 2 && o.addr === 0x02000024; }),
  'backup card 3: the primary’s virtual-pixel byte (as read before) and the same output window');
var slot = lw.filter(function (o) { return o.dst === 2 && o.addr >= 0x0200016F && o.addr <= 0x02000177; }).map(function (o) { return o.addr - 0x0200016F; }).join();
ok(slot === '5,7,1,3' && lw.some(function (o) { return o.dst === 2 && o.addr === 0x031002E0; }) && lw.some(function (o) { return o.dst === 2 && o.addr === 0x0300F000; }),
  'P2 -> card 3 P16: rectangle (no enable byte), card count and coordinate table in P16’s slot');
ok(L.ops.some(function (o) { return o.op === 'roles'; }) && !lw.some(function (o) { return o.addr === 0x05065000; }), 'card roles re-applied; no REDU when the backup is already saved');
var LR = H.buildSendPlan(model, { modelId: 0x7B48, senders: 4, backup: PX, redu: true }), rw = ws(LR);
ok(LR.redu && rw.findIndex(function (o) { return o.addr === 0x05065000; }) < rw.findIndex(function (o) { return o.addr === 0x05066000; }), 'a backup Send not saved yet: REDU goes first in the Send’s commit (as NovaLCT)');
var sv = H.buildSavePlan({ pixels: 1000, senders: 4, redu: P3 });
ok(sv.ops[0].addr === 0x05065000 && sv.ops[0].hex.indexOf(hx('52 45 44 55 E9 03')) === 0 && sv.ops.some(function (o) { return o.dev === 1 && o.addr === 0x01000011; }) && !H.buildSavePlan({ pixels: 1 }).ops.some(function (o) { return o.addr === 0x05065000; }),
  'Save after a backup Send: REDU first, then the usual Save; without one no REDU');

// --- the helper runs it (python tools\novalink.py SimLink): the backup slots end up as the primary's
var tools = path.join(__dirname, '..', '..', 'tools'), tmp = path.join(os.tmpdir(), 'opennova_redu_' + process.pid + '.json');
var clear = H.buildRedundancyPlan(null, { modelId: 0x7B48, senders: 4, backup: [], prev: PX });
fs.writeFileSync(tmp, JSON.stringify({ layout: L, clear: clear, save: H.buildSavePlan({ pixels: 1, senders: 4, redu: PX }), clear2: c1 }));
var py = [
  'import sys, json', 'sys.path.insert(0, sys.argv[1])', 'import novalink',
  'a = json.load(open(sys.argv[2]))', 'sim = novalink.SimLink(4)', 'novalink.run_plan(sim, a["layout"], lambda s: None)',
  'g = lambda d, ad, n: sim.read(0, d, 0, 0, ad, n).hex()',
  'out = {"f1": g(2, 0x02000018, 1), "f16": g(2, 0x02000107, 1), "pf": g(0, 0x02000018, 2),',
  '  "t16": g(2, 0x0300F000, 4096) == g(0, 0x03001000, 4096), "b16": g(2, 0x0200016F + 1, 8) == g(0, 0x02000059 + 1, 8),',
  '  "c16": g(2, 0x031002E0, 32) == g(0, 0x03100020, 32), "t1": g(2, 0x03000000, 4096) == g(0, 0x03000000, 4096), "tb": g(0, 0x02300000, 3)}',
  'novalink.run_plan(sim, a["clear"], lambda s: None)', 'out["after"] = g(2, 0x02000018, 1) + g(2, 0x02000107, 1) + g(0, 0x02300000, 3)',
  'novalink.run_plan(sim, a["layout"], lambda s: None)', 'novalink.run_plan(sim, a["save"], lambda s: None)', 'out["redu"] = novalink.read_backup(sim, 1)["pairs"]',
  'novalink.run_plan(sim, a["clear2"], lambda s: None)', 'out["after2"] = g(2, 0x02000018, 1) + g(2, 0x02000107, 1) + g(0, 0x02300000, 3)',
  'print(json.dumps(out))'].join('\n');
var res = cp.spawnSync('python', ['-I', '-c', py, tools, tmp], { encoding: 'utf8' });
try { fs.unlinkSync(tmp); } catch (e) { /* gone already */ }
if (res.error || res.status !== 0) console.log('SKIP helper run (python): ' + (res.error ? res.error.message : res.stderr.split('\n').slice(-3).join(' ')));
else {
  var o = JSON.parse(res.stdout.trim().split('\n').pop());
  ok(o.f1 === '80' && o.f16 === '80' && o.pf === '0000', 'helper: card 3 P1 and P16 flagged 0x80, card 1’s ports 00');
  ok(o.t1 && o.t16 && o.b16 && o.c16, 'helper: card 3 P1 = card 1 P1, card 3 P16 = card 1 P2 (coordinate table, rectangle, card count)');
  ok(o.tb === '9a0400', 'helper: pair table on the cards');
  ok(o.after === '0000' + '9a0000', 'helper: clear switches both backup ports off and empties the table');
  ok(JSON.stringify(o.redu) === '[[0,0,2,0],[0,1,2,15]]' && o.after2 === '0000' + '9a0000', 'helper: Save wrote REDU; a clear without known pairs reads it and switches them off');
}
console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
