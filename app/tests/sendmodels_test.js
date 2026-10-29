// node app/tests/sendmodels_test.js — the per-model Send profiles (hwsend.js LCT_MODELS, docs\APP_SEND.md "Send profiles").
// Byte comparisons against NovaLCT's own Sends to the fake processor are done outside this test (private recordings).
var path = require('path'), H = require(path.join(__dirname, '..', 'hwsend.js'));
var fails = 0;
function ok(cond, text) { console.log((cond ? 'PASS ' : 'FAIL ') + text); if (!cond) fails++; }
function hx(n, len) { var s = ''; for (var i = 0; i < len; i++) s += ('0' + ((n >> (8 * i)) & 255).toString(16)).slice(-2); return s; }
// one Standard screen, 2 sending cards side by side (as NYC v2 on the fake: card 1 at x 0, card 2 at x 2056), port 1 each,
// 4 cabinets 510 x 1320 per card, plus a blank cell at the right (so the screen box is wider than the cards' boxes)
function layout(ports) {
  var cells = [], col = 0;
  [0, 1].forEach(function (d) {
    for (var i = 0; i < 4; i++) cells.push({ row: 0, col: col++, x: d * 2056 + i * 510, y: 0, width: 510, height: 1320, sender: d, port: (ports || 1) - 1, connect: i });
  });
  cells.push({ row: 0, col: col, x: 4096, y: 0, width: 64, height: 1320, sender: 255, port: 255, connect: 0 });
  return { screens: [{ type: 1, x: 0, y: 0, cols: col + 1, rows: 1, cells: cells }] };
}
function plan(id, o) { o = o || {}; return H.buildSendPlan(o.model || layout(o.ports), { modelId: id, senders: o.senders || 2, backup: o.backup || [], now: new Date(2026, 9, 11, 12, 0, 0) }); }
function writes(p, addr) { return p.ops.filter(function (o) { return o.op === 'w' && o.dev === 0 && o.addr === addr; }); }
function has(p, addr) { return writes(p, addr).length > 0; }

// --- VX1000 (0x620C): Pro UHD Jr's Send + video sync, 10 ports (as NovaLCT's Send to a VX1000)
var vx = plan(0x620C), M = H.MODELS[0x620C];
ok(M && M.name === 'VX1000' && M.ports === 10 && M.sync && M.save && !M.video && !M.threeD && M.verified === 'capture', 'VX1000 profile: 10 ports, save, sync, per-card window, verified by capture');
ok(has(vx, 0x02000101) && !has(vx, 0x02000102), 'VX1000: port flags up to 0x02000101 (10 ports), no 0x02000102');
var s = vx.ops.filter(function (o) { return o.op === 'sync'; });
ok(s.length === 1 && s[0].from === 0 && s[0].to === 1 && s[0].times === 2 && s[0].hex === '00000f8007',
  'VX1000: 0x020000D4 sync op = read card 1, write card 2 twice, default 00 00 0F 80 07 (3840 x 1920, sync off): ' + JSON.stringify(s[0]));
var iAE = vx.ops.indexOf(writes(vx, 0x020000AE)[0]), iS = vx.ops.indexOf(s[0]), iSSPE = vx.ops.indexOf(writes(vx, 0x05066000)[0]);
ok(iAE < iS && iS < iSSPE, 'VX1000: sync after 0x020000AE, before LCT’s save (SSPE)');
var sb = H.syncOp(layout(), [{ ps: 1, pp: 0, bs: 2, bp: 0 }]);
ok(sb.to === 2 && sb.times === 3, 'sync with a backup card: the last card set is the backup card, one write per card in LCT’s list (' + sb.to + ' x' + sb.times + ')');
ok(!plan(0x6205).ops.some(function (o) { return o.op === 'sync'; }), 'Pro UHD Jr (no sync model): no sync op');

// --- 3D model (MCTRL4K): 0x02000089 = the last card's window right edge, to all cards, port / card all (as NovaLCT)
var mc = plan(0x1103), d89 = writes(mc, 0x02000089);
ok(d89.length === 1 && d89[0].dst === 255 && d89[0].port === 255 && d89[0].card === 65535 && d89[0].hex === hx(2056 + 2040, 2) + '000000000000',
  'MCTRL4K: 0x02000089 <- ' + (d89[0] && d89[0].hex) + ' (2056 + 2040 = 4096)');
ok(!has(plan(0x7B46), 0x02000089) && !has(plan(0x620C), 0x02000089), 'H9 and VX1000: no 0x02000089');
ok(writes(mc, 0x02000024)[0].hex === hx(2040, 2), 'MCTRL4K: per-card output window (2040)');

// --- video model (Pro UHD Jr, H_20): output window = the screen box (blank cell included), as NovaLCT
[0x6205, 0x7B48, 0x6204].forEach(function (id) {
  var p = plan(id, { ports: 1 }), w24 = writes(p, 0x02000024);
  ok(w24.length === 2 && w24.every(function (o) { return o.hex === hx(4160, 2); }) && writes(p, 0x02000028)[1].hex === hx(2056, 2),
    H.MODELS[id].name + ': output window 4160 wide on both cards (the screen box), card 2 at x 2056');
});
ok(writes(plan(0x7B46), 0x02000024)[0].hex === hx(2040, 2), 'H9: the card’s own box (both NovaLCT Sends to an H9) [R]');

// --- more than 16 ports (H 8xFiber, 40): bank 2 for flags / rectangles, card counts continue at 0x03100200 (NovaLCT's address banks)
var h8 = plan(0x7B4F, { ports: 40 }), fl = writes(h8, 0x02010057), blk = 0x02010240 + 9 * 23;
ok(H.MODELS[0x7B4F].ports === 40 && fl.length === 1 && !has(h8, 0x02010058), 'H 8xFiber: port flags up to 0x02010057 (port 40), none after');
ok(has(h8, blk) && has(h8, blk + 1) && has(h8, 0x03100200 + 0x20 * 31) && has(h8, 0x03000000 + 39 * 0x1000),
  'H 8xFiber port 40: rectangle at 0x' + blk.toString(16) + ', card count at 0x031005E0, coordinate table at 0x03027000');
var k40 = plan(0x621D, { ports: 40 });
ok(H.MODELS[0x621D].verified === 'code' && has(k40, 0x02010057), 'K40 (code only): 40 ports, same banks');

// --- non-save models: no 0x0200004A, LCT's Send ends at 0x020000AE (no SSPE / NSSD / commit), seen on the MSD300
var ms = H.buildSendPlan({ screens: [{ type: 1, x: 0, y: 0, cols: 2, rows: 1, cells: [
  { row: 0, col: 0, x: 0, y: 0, width: 60, height: 120, sender: 0, port: 0, connect: 0 }, { row: 0, col: 1, x: 60, y: 0, width: 60, height: 120, sender: 0, port: 0, connect: 1 }] }] },
  { modelId: 0x0001, senders: 1 });
var last = ms.ops.filter(function (o) { return o.op === 'w'; }).pop();
ok(!has(ms, 0x0200004A) && !ms.ops.some(function (o) { return o.op === 'nssd'; }) && last.addr === 0x020000AE, 'MSD300: no 0x0200004A, plan ends with 0x020000AE');
ok(has(plan(0x620C), 0x0200004A) && plan(0x620C).ops.some(function (o) { return o.op === 'nssd'; }), 'VX1000 (save model): 0x0200004A and NSSD');

// --- MCTRL R5: rotation off first, as NovaLCT
var r5 = plan(0x1104, { ports: 1 }), iR = r5.ops.indexOf(writes(r5, 0x02700000)[0]);
ok(iR > 0 && r5.ops[iR].dst === 255 && r5.ops[iR].hex === '00' && iR < r5.ops.indexOf(writes(r5, 0x0200004A)[0]), 'MCTRL R5: 0x02700000 <- 00 to all cards, before 0x0200004A');

// --- LCT's commit after the Send: invalidate / distributor / 3D emitter with port and card = all (as NovaLCT, also on the real H) [R]
var tail = plan(0x7B48).ops.filter(function (o) { return o.op === 'w' && ((o.dev === 0 && o.addr === 0x05000000) || o.dev === 3 || o.dev === 4); });
ok(tail.length === 3 && tail.every(function (o) { return o.port === 255 && o.card === 65535; }), 'invalidate, distributor and 3D-emitter commit go to port 255 / card 65535');

// --- refusals
function err(id) { try { plan(id, { ports: 1 }); return ''; } catch (e) { return e.message; } }
ok(/another way/.test(err(0x1105)) && /MCTRL1600/.test(err(0x1105)), 'MCTRL1600 refused (another Send path): ' + err(0x1105));
ok(/asynchronous/.test(err(0x9620)), 'T30 refused (asynchronous player): ' + err(0x9620));
ok(/doesn’t know/.test(err(0x1234)) && H.refusal(0x620C) === null, 'unknown ModelID refused: ' + err(0x1234));

// --- every profile builds a plan; no plan stores the receiving cards (Save stays separate)
var bad = [], n = 0;
Object.keys(H.MODELS).forEach(function (k) {
  n++;
  try { var p = plan(+k, { ports: 1 }); if (p.ops.some(function (o) { return o.op === 'w' && o.dev === 1 && o.addr === 0x01000011; })) bad.push(H.MODELS[k].name + ' stores'); }
  catch (e) { bad.push(H.MODELS[k].name + ': ' + e.message); }
});
ok(!bad.length && n > 140, n + ' profiles build a Send plan, none with a receiving-card store' + (bad.length ? ': ' + bad.join('; ') : ''));
var cap = Object.keys(H.MODELS).filter(function (k) { return H.MODELS[k].verified === 'capture'; }).map(function (k) { return H.MODELS[k].name; });
ok(cap.length === 8, 'verified by capture: ' + cap.join(', '));
process.exit(fails ? 1 : 0);
