// node app/tests/freeroute_test.js — the free-route pass of a Send, against NovaLCT's own Send to the real H2 with
// free topology on (recorded 2026-10-11 16:36:27): a 20 x 4 Standard screen of
// 128 x 256 cabinets, port 1 = rows 1-3 columns 1-5 snaking (cards 1-15) + one cabinet at row 4 column 20 (card 16).
var path = require('path'), H = require(path.join(__dirname, '..', 'hwsend.js'));
var at = {}, cells = [], fails = 0;
[[0, [0, 1, 2, 3, 4]], [1, [4, 3, 2, 1, 0]], [2, [0, 1, 2, 3, 4]]].forEach(function (r, k) { r[1].forEach(function (c, i) { at[r[0] + ',' + c] = k * 5 + i; }); });
at['3,19'] = 15;
for (var r = 0; r < 4; r++) for (var c = 0; c < 20; c++) {
  var k = at[r + ',' + c], blank = k === undefined;
  cells.push({ row: r, col: c, x: c * 128, y: r * 256, width: 128, height: 256, sender: blank ? 255 : 0, port: blank ? 255 : 0, connect: blank ? 0 : k });
}
var model = { screens: [{ type: 1, x: 0, y: 0, cols: 20, rows: 4, cells: cells }] };
function ok(cond, text) { console.log((cond ? 'PASS ' : 'FAIL ') + text); if (!cond) fails++; }
function ops(fr) { return H.buildSendPlan(model, { modelId: 0x7B46, senders: 1, freeRoute: fr }).ops.filter(function (o) { return o.op === 'w' && o.dev === 0; }); }

var on = ops(true), names = on.map(function (o) { return '0x' + o.addr.toString(16); });
var recs = on.filter(function (o) { return (o.addr >>> 20) === 0x032; }).map(function (o) { return '0x' + o.addr.toString(16) + '=' + o.hex; });
ok(JSON.stringify(recs) === JSON.stringify([
  '0x3200000=00800200030000000000000000000000',   // 640 x 768 at 0,0: the snaking block
  '0x3200010=00800000018009000300000000000000',   // 128 x 256 at 2432,768: the lone cabinet
  '0x3200020=00800200030000000000000000000000']), // the widest area again
  'records as NovaLCT: ' + recs.join(' '));
var cnt = on.filter(function (o) { return o.addr === 0x02030000; })[0];
ok(cnt && cnt.hex === '0300', 'record count 0x02030000 = 03 00');
ok(names.indexOf('0x2000050') < names.indexOf('0x3200000') && names.indexOf('0x2030000') < names.indexOf('0x3000000'), 'order: port enable, records, count, coordinate table');
var t = on.filter(function (o) { return o.addr === 0x03000000; })[0].hex;
function xy(i) { var b = t.substr(8 * i, 8); return [parseInt(b.substr(2, 2) + b.substr(0, 2), 16), parseInt(b.substr(6, 2) + b.substr(4, 2), 16)]; }
ok(xy(15).join() === '0,768' && xy(5).join() === '512,256' && xy(16).join() === '0,0', 'coordinates in the packed picture: card 16 at 0,768 (' + xy(15) + '), card 6 at 512,256, then cyclic');
var off = ops(false);
ok(!off.some(function (o) { return (o.addr >>> 20) === 0x032 || o.addr === 0x02030000; }), 'free route off: no records, no count');
var t2 = off.filter(function (o) { return o.addr === 0x03000000; })[0].hex.substr(120, 8);
ok(t2 === '80090003', 'free route off: card 16 keeps its place in the port rectangle (2432,768)');
process.exit(fails ? 1 : 0);
