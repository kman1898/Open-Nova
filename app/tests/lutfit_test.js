// node app/tests/lutfit_test.js — a LUT on NovaLCT cards (js/app-lutfit.js): what fits as curves, what needs the gamut matrix, what
// can't be done and says so, the card's tables and NovaLCT's colour-space record.
var path = require('path'), V = require(path.join(__dirname, '..', 'js', 'app-lut3d.js'));
global.lutCloud = V.lutCloud; global.lutPick = V.lutPick;
var X = require(path.join(__dirname, '..', 'js', 'app-lutfit.js'));
global.lfHex = X.lfHex; global.gmRecord = require(path.join(__dirname, '..', 'js', 'app-gamut.js')).gmRecord;
var fails = 0, G = 2.8;
function ok(cond, text) { console.log((cond ? 'PASS ' : 'FAIL ') + text); if (!cond) fails++; }
function cube(N, f) {
  var t = ['LUT_3D_SIZE ' + N];
  for (var b = 0; b < N; b++) for (var g = 0; g < N; g++) for (var r = 0; r < N; r++) t.push(f(r / (N - 1), g / (N - 1), b / (N - 1)).map(function (v) { return Math.max(0, Math.min(1, v)).toFixed(6); }).join(' '));
  return t.join('\n');
}
function fit(N, f) { return X.lutFit(V.lutParse(cube(N, f), 't.cube').lut, G); }
var pow = Math.pow, lin = function (v) { return pow(v, G); }, enc = function (v) { return pow(Math.max(0, Math.min(1, v)), 1 / G); };

var a = fit(17, function (r, g, b) { return [r, g, b]; });
ok(!a.matrix && a.mean < .05 && a.max < .3, 'identity: curves only, nothing moves (' + a.mean.toFixed(3) + ' %)');
var g28 = a.tables[0], off = 0;
for (var i = 0; i < 256; i++) off = Math.max(off, Math.abs(g28[i] - Math.round(65535 * pow(i / 255, G))));
ok(off <= 1 && a.tables[0][255] === 65535 && a.tables[0][0] === 0, 'identity: the table is the plain gamma, as the closed form (off by ' + off + ')');

var b = fit(33, function (r, g, c) { return [pow(r, 1.2), g * .9, pow(c, .85)]; });
ok(!b.matrix && b.mean < .4, 'per-colour curves and gain: exact without the matrix (' + b.mean.toFixed(2) + ' %)');
ok(b.tables[0][128] !== b.tables[1][128] && b.tables[1][128] !== b.tables[2][128], 'the three tables differ');

var M = [[.8, .15, .05], [.05, .9, .05], [.02, .08, .9]];   // a gamut pull in light
var c = fit(33, function (r, g, bl) { var l = [lin(r), lin(g), lin(bl)]; return M.map(function (m) { return enc(m[0] * l[0] + m[1] * l[1] + m[2] * l[2]); }); });
ok(!!c.matrix && c.mean < .6, 'a gamut change: found as a matrix (' + c.mean.toFixed(2) + ' %, ' + (c.matrix || []).join(' ') + ')');
ok(c.matrix && M.every(function (m, i) { return m.every(function (v, j) { return Math.abs(c.matrix[i * 3 + j] / 255 - v) < .04; }); }), 'the matrix found is the one in the LUT');
ok(c.matrix && c.matrix.every(function (v) { return v >= 0 && v <= 255; }), 'matrix bytes stay 0-255 (the cards take 0 to 1)');

var d = fit(33, function (r, g, bl) { return [(r > .5 && g < .4) ? 1 - r : r, g, bl > g ? g : bl]; });   // colour-range twists
ok(d.mean > 2.5 && !/close/i.test(d.verdict), 'a LUT that bends one colour range is called out (' + d.mean.toFixed(1) + ' %: ' + d.verdict + ')');

['warm', 'teal'].forEach(function (k) { var w = X.lutFit(V.lutParse(V.lutMakeCube(k, 33, k), k + '.cube').lut, G); console.log('     ' + k + ' look: ' + w.verdict + ', ' + w.mean.toFixed(1) + ' % average, ' + w.max.toFixed(1) + ' % worst, matrix ' + !!w.matrix); });
var cu = V.lutParse(X.lfCube(c), 'fit.cube');
ok(cu.ok && cu.lut.size === c.K, 'the fit as a .cube for the picture');
ok(X.lfTableHex(a.tables).length === 3072, 'tables as bytes: 1536 B (R, G, B, u16)');
ok(X.lfTableHex(a.tables).slice(-4) === 'FFFF', 'little-endian, top entry full');

var pal = [0x6C, 0x33, 0x07, 0x03, 0xA9, 0x03, 0x01, 0x07, 0x4B], r = X.lfRecord(pal), u = function (o) { return parseInt(r.substr(o * 2 + 2, 2) + r.substr(o * 2, 2), 16); };
ok(r.length === 512 && r.slice(0, 10) === '4763096DFF', 'record: magic, type FF = custom');
ok(r.slice(32, 80) === '5E1AE40C6C07781E14059001240A590928235046B80B3075', 'record: original side = NovaLCT’s, byte for byte (from its recorded PAL record)');
// (8-bit coefficients: 1/255 of the blue primary alone moves x by about 0.01; this side of the record is for showing only)
ok(Math.abs(u(40) - 6400) < 150 && Math.abs(u(42) - 3300) < 150 && Math.abs(u(44) - 3000) < 150 && Math.abs(u(46) - 6000) < 150, 'record: NovaLCT’s PAL matrix gives back PAL’s primaries as the target (' + [u(40), u(42), u(44), u(46)].join(' ') + ')');
ok(r.slice(128, 192) === '6C003300070000000300A90003000000010007004B0000000000000000006C00', 'record: the matrix as NovaLCT stores it, m00 repeated at the end');
process.exit(fails ? 1 : 0);
