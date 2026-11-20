// node app/tests/gamut_test.js — NovaLCT's custom gamut (js/app-gamut.js) against what NovaLCT itself sent: the matrix bytes of its three
// recorded Sends (docs/COLOR_BRIGHTNESS.md §5.2 "On the wire"), its record layout, its checks.
var path = require('path');
global.lfHex = function (b) { var h = ''; for (var i = 0; i < b.length; i++) h += ('0' + b[i].toString(16).toUpperCase()).slice(-2); return h; };
var X = require(path.join(__dirname, '..', 'js', 'app-gamut.js')), fails = 0;
function ok(c, t) { console.log((c ? 'PASS ' : 'FAIL ') + t); if (!c) fails++; }
var O = X.GM_DEF.orig, W = X.GM_DEF.white, hex = function (b) { return global.lfHex(b); };
function bytes(prims, lum) { return hex(X.gmBytes(X.gmMatrix(O, X.gmSolve(prims, [W[0], W[1], lum])))); }
var pal = X.GM_PRIMS.pal, ntsc = X.GM_PRIMS.ntsc;

// the recorded target luminances solve from the white
var t = X.gmSolve(pal, [W[0], W[1], 1927.8]);
ok(Math.abs(t[0][2] - 409.9) < .6 && Math.abs(t[1][2] - 1378.7) < .6 && Math.abs(t[2][2] - 139.1) < .6, 'PAL at white 1927.8: R 409.9, G 1378.7, B 139.1, as NovaLCT (' + t.map(function (p) { return p[2].toFixed(1); }).join(' ') + ')');
ok(bytes(pal, 1927.8) === '6C330703A80301074B', 'NovaLCT’s PAL Send: 6C 33 07 | 03 A8 03 | 01 07 4B (' + bytes(pal, 1927.8) + ')');
ok(bytes(ntsc, 2686) === 'DA0A0400E0130005' + '70', 'NovaLCT’s NTSC Send: DA 0A 04 | 00 E0 13 | 00 05 70 (' + bytes(ntsc, 2686) + ')');
ok(bytes(pal, 600) === '210F02013401000217', 'NovaLCT’s default target (white 600): 21 0F 02 | 01 34 01 | 00 02 17 (' + bytes(pal, 600) + ')');

var ow = X.gmWhite(O);
ok(Math.abs(ow[0] - .2596) < .0002 && Math.abs(ow[1] - .2393) < .0002 && Math.abs(ow[2] - 3000) < .1, 'the original white from the three LEDs: 0.2596 / 0.2393, 3000');
var f = X.gmFit(O, pal, W);
ok(f <= 3000 && f >= 2500, 'target white stepped down from the original (' + f.toFixed(0) + ')');
ok(X.gmFit(O, pal, W) && X.gmSolve(pal, [W[0], W[1], f]).every(function (p) { return p[2] > 0; }), 'every target primary positive');

var M = function (p, l) { return X.gmMatrix(O, X.gmSolve(p, [W[0], W[1], l])); };
ok(X.gmCheck(O, pal, W, M(pal, 1927.8)) === '', 'PAL fits the default LEDs');
var p3 = [[.68, .32], [.265, .69], [.15, .06]];
ok(/exceeds original/.test(X.gmCheck(O, p3, W, M(p3, 1000))), 'DCI-P3 red is outside them: "target gamut exceeds original gamut", as NovaLCT');
ok(/white/i.test(X.gmCheck(O, pal, [.1, .8], M(pal, 1000))), 'a white outside the target is refused');
ok(/bright/i.test(X.gmCheck(O, pal, W, M(pal, 6000))), 'a white the LEDs can’t reach is refused (a coefficient over 1)');

var e = { type: 'pal', orig: O, prims: pal, white: [W[0], W[1], 1927.8] }, b = X.gmBuild(e);
ok(b.m === '026C330703A80301074B' && !b.error, 'an entry builds the 10 bytes of 0x02000130');
ok(b.rec.length === 512 && b.rec.slice(0, 10) === '4763096D00', 'record: magic, type 00 for PAL (as recorded)');
ok(b.rec.slice(32, 64) === '5E1AE40C6C07781E14059001240A5909', 'record: the original xy as NovaLCT stores them');
ok(b.rec.slice(64, 80) === '28235046B80B3075', 'record: the original luminances ·10');
ok(X.gmBuild({ type: 'custom', orig: O, prims: pal, white: e.white }).rec.slice(8, 10) === 'FF', 'record: type FF for custom');
var r = X.gmParse(b.rec);
ok(r && Math.abs(r.orig[1][1] - .78) < 1e-6 && Math.abs(r.target[0][0] - .64) < .001 && r.matrix.join() === '108,51,7,3,168,3,1,7,75', 'a record reads back: original, target, matrix');
ok(X.gmParse('FF'.repeat(256)) === null && X.gmParse('') === null, 'nothing valid on the cards: none');

// the log's comparison, on NovaLCT's recorded PAL record: same bytes, 44 steps of 0.99, 2580 from our single pass
var rec = '4763096D00FFFFFFFFFFFFFFFFFFFFFF5E1AE40C6C07781E14059001240A590928235046B80B3075' + '0019E40CB80B7017DC055802370CDA0C0310DB356F054E4B' + '6C003300070000000300A80003000000010007004B0000000000000000006C00' + 'FF'.repeat(160);
var cmp = X.gmCompare(X.gmParse(rec));
ok(cmp.same && Math.round(cmp.steps) === 44 && Math.abs(cmp.targetWhite[2] - 1927.8) < 1 && Math.abs(cmp.oneStep - 2580) < 40, 'log: NovaLCT’s PAL record: same bytes, ' + cmp.steps + ' steps, ours in one pass ' + cmp.oneStep);
var d = X.gmCct(6500), c = X.gmCct(9000);
ok(Math.abs(d[0] - .3128) < .0005 && Math.abs(d[1] - .3292) < .0005, 'colour temperature: 6500 K on the daylight locus (' + d.map(function (v) { return v.toFixed(4); }) + ')');
ok(c[0] < d[0] && X.gmCct(3200) === null, 'higher is bluer; none below 4000 K, as NovaLCT');
process.exit(fails ? 1 : 0);
