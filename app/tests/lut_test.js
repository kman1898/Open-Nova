// node app/tests/lut_test.js — the 3-D LUT viewer (js/app-lut3d.js): .cube / .3dl parsing, domain scaling, 1-D sections,
// malformed files, and a render smoke check on a recording stand-in for a Canvas-2D context.
var path = require('path'), X = require(path.join(__dirname, '..', 'js', 'app-lut3d.js'));
var fails = 0;
function ok(cond, text) { console.log((cond ? 'PASS ' : 'FAIL ') + text); if (!cond) fails++; }
function bad(text, name, want) { var r = X.lutParse(text, name); ok(!r.ok && want.test(r.error), 'rejects ' + name + ': ' + (r.ok ? 'accepted!' : r.error)); }
function cube(N, f, head) {
  var t = (head || []).concat(['LUT_3D_SIZE ' + N]);
  for (var b = 0; b < N; b++) for (var g = 0; g < N; g++) for (var r = 0; r < N; r++) t.push(f(r / (N - 1), g / (N - 1), b / (N - 1)).join(' '));
  return t.join('\n');
}
function maxErr(L) {   // largest |cloud output − input lattice| = 0 for an identity
  var C = X.lutCloud(L), N = C.N, m = 0;
  for (var i = 0; i < N * N * N; i++) {
    var q = [i % N, Math.floor(i / N) % N, Math.floor(i / (N * N))];
    for (var c = 0; c < 3; c++) m = Math.max(m, Math.abs(C.out[i * 3 + c] - C.grid[q[c]]));
  }
  return m;
}
var id = function (r, g, b) { return [r, g, b]; };

// identity cubes, sizes 2 / 17 / 33 / 65
[2, 17, 33, 65].forEach(function (N) {
  var r = X.lutParse(cube(N, id, ['# comment', 'TITLE "Identity ' + N + '"', '']), 'id' + N + '.cube');
  ok(r.ok && r.lut.size === N && r.lut.data.length === N * N * N * 3 && r.lut.title === 'Identity ' + N, 'identity ' + N + '³ parses (title, size, rows)');
  ok(r.ok && maxErr(r.lut) < 1e-6 && X.lutStats(r.lut).max < 1e-6, 'identity ' + N + '³: every point sits on its input');
});
// order: R changes fastest
var L = X.lutParse(cube(3, function (r, g, b) { return [r, g * 0.5, b * 0.25]; }), 'o.cube').lut;
ok(L.data[3 * 1] === 0.5 && L.data[3 * 3 + 1] === 0.25 && L.data[3 * 9 + 2] === 0.125, 'row order: R fastest, then G, then B');
// DOMAIN scaling: an identity over 0–2 lands on the lattice; a 3D INPUT_RANGE (Resolve) too
var d2 = X.lutParse(cube(5, function (r, g, b) { return [2 * r, 2 * g, 2 * b]; }, ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 2 2 2']), 'd.cube');
ok(d2.ok && maxErr(d2.lut) < 1e-6 && d2.lut.dmax[1] === 2, 'DOMAIN_MAX 2: identity scaled onto the unit cube');
var d3 = X.lutParse(cube(3, function (r, g, b) { return [r * 1.1 - 0.1, g * 1.1 - 0.1, b * 1.1 - 0.1]; }, ['LUT_3D_INPUT_RANGE -0.1 1.0']), 'r.cube');
ok(d3.ok && maxErr(d3.lut) < 1e-6, 'LUT_3D_INPUT_RANGE −0.1 … 1.0 scales like DOMAIN');
// 1-D only, and 1-D shaper + 3-D (Resolve)
var one = ['TITLE "Gamma"', 'LUT_1D_SIZE 5'].concat([0, 0.25, 0.5, 0.75, 1].map(function (x) { var y = Math.pow(x, 2.2); return [y, y, y].join(' '); })).join('\n');
var r1 = X.lutParse(one, 'g.cube');
ok(r1.ok && r1.lut.size === 0 && r1.lut.size1 === 5 && r1.lut.d1.length === 15, '1-D only file parses');
ok(r1.ok && X.lutCloud(r1.lut).N === 5 && Math.abs(X.lutCloud(r1.lut).out[3 * 2] - Math.pow(0.5, 2.2)) < 1e-6, '1-D only: its curves make the 3-D cloud');
var both = ['LUT_1D_SIZE 3', 'LUT_1D_INPUT_RANGE 0 1', 'LUT_3D_SIZE 2', '0 0 0', '0.5 0.5 0.5', '1 1 1'].concat(cube(2, id).split('\n').slice(1)).join('\n');
var r2 = X.lutParse(both, 'shaper.cube');
ok(r2.ok && r2.lut.size1 === 3 && r2.lut.size === 2 && r2.lut.d1[3] === 0.5 && r2.lut.data.length === 24 && maxErr(r2.lut) < 1e-6, '1-D shaper + 3-D: both tables, shaper first');
ok(r2.ok && /shaper/.test(X.lutInfo(r2.lut)[0][1]), 'info names the shaper');
// unknown keywords are read past, CRLF and a BOM are fine
var r3 = X.lutParse('﻿LUT_IN_VIDEO_RANGE\r\n' + cube(2, id).replace(/\n/g, '\r\n'), 'k.cube');
ok(r3.ok && r3.lut.size === 2, 'BOM, CRLF and an unknown keyword');
// malformed
bad('', 'empty.cube', /empty/);
bad('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n', 'short.cube', /Expected 8 table rows \(2³\), found 2/);
bad(cube(2, id) + '\n0 0 0', 'long.cube', /found 9/);
bad('LUT_3D_SIZE 2\n0 0\n', 'two.cube', /Line 2: a table row needs 3 numbers/);
bad('LUT_3D_SIZE 2\n0 0 x\n', 'nan.cube', /Line 2: not a number/);
bad('LUT_3D_SIZE 1\n0 0 0\n', 'one.cube', /LUT_3D_SIZE must be 2–256/);
bad('LUT_3D_SIZE 300\n', 'huge.cube', /must be 2–256/);
bad('TITLE "x"\n0 0 0\n', 'nosize.cube', /No LUT_3D_SIZE/);
bad(cube(2, id, ['DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 0 1']), 'dom.cube', /domain minimum must be below/);
bad(cube(2, id, ['DOMAIN_MIN 0 0']), 'dom3.cube', /DOMAIN_MIN needs 3 numbers/);
bad('LUT_3D_SIZE 2\n0 0 0\nTITLE "late"\n', 'late.cube', /inside the table/);
bad('{"json": true}', 'x.cube', /can’t read/);
bad('PK\u0003\u0004\0\0binary', 'zip.cube', /Not a text file/);
bad('hello world\n', 'notes.txt', /Not a \.cube or \.3dl LUT/);

// .3dl: mesh line, blue fastest, 10-bit in / 12-bit out
function dl(N, f, head, outMax) {
  var mesh = [], t = (head || []).slice();
  for (var i = 0; i < N; i++) mesh.push(Math.round(i * 1023 / (N - 1)));
  t.push(mesh.join(' '));
  for (var r = 0; r < N; r++) for (var g = 0; g < N; g++) for (var b = 0; b < N; b++) t.push(f(r / (N - 1), g / (N - 1), b / (N - 1)).map(function (v) { return Math.round(v * outMax); }).join(' '));
  return t.join('\n');
}
var t1 = X.lutParse(dl(17, id, ['# Lustre', '3DMESH', 'Mesh 4 12'], 4095), 'look.3dl');
ok(t1.ok && t1.lut.format === '3dl' && t1.lut.size === 17 && t1.lut.outMax === 4095 && t1.lut.inMax === 1023, '.3dl 17-point, Mesh 4 12 header');
bad(dl(9, id, ['Mesh 4 12'], 4095), 'meshhdr.3dl', /says 17 points per axis/);
ok(t1.ok && maxErr(t1.lut) < 0.002, '.3dl identity sits on the lattice (rounding only): ' + (t1.ok && maxErr(t1.lut).toFixed(4)));
var t2 = X.lutParse(dl(5, function (r, g, b) { return [r, g * 0.5, b * 0.25]; }, [], 4095), 'o.3dl');
ok(t2.ok && t2.lut.outMax === 4095 && t2.lut.inMax === 1023 && Math.abs(t2.lut.data[3 * 1] - 1024) < 1, '.3dl without header: 12-bit out inferred, rows reordered to R fastest');
ok(t2.ok && Math.abs(t2.lut.data[3 * 25 + 2] - 256) < 1, '.3dl: B axis read from the fastest column');
var t3 = X.lutParse(dl(3, id, [], 1023), 'three.3dl');
ok(t3.ok && t3.lut.size === 3 && t3.lut.outMax === 1023, '.3dl 3-point mesh (mesh line has 3 values, like a row)');
bad('0 512 1023\n0 0 0\n', 'short.3dl', /Expected 27 rows for a 3-point mesh, found 1/);
bad('0 1023 512 700\n' + Array(65).join('0 0 0\n'), 'fall.3dl', /mesh line must rise/);
bad('0 1023\n0 0\n' + Array(8).join('0 0 0\n'), 'row.3dl', /a table row needs 3 numbers/);
bad('0 1023\n0 0 -5\n', 'neg.3dl', /not a code/);
bad('# nothing\n', 'empty.3dl', /No table/);

// samples
var w = X.lutParse(X.lutMakeCube('warm', 33, 'Warm film'), 'warm.cube');
ok(w.ok && w.lut.size === 33 && X.lutStats(w.lut).max > 0.05 && w.lut.outHi[0] <= 1 && w.lut.outLo[2] >= 0, 'sample warm 33³ parses, moves colours, stays in 0–1');
ok(X.lutLook('warm', 1, 1, 1)[0] > X.lutLook('warm', 1, 1, 1)[2], 'warm look: white is warmer (R > B)');

// render smoke check: a stand-in context records what is drawn
function fake() {
  var c = { arcs: 0, out: 0, styles: {}, fills: 0 };
  c.fillRect = function () {}; c.beginPath = function () {}; c.fill = function () { c.fills++; };
  c.arc = function (x, y, r) { c.arcs++; if (x < 0 || y < 0 || x > 240 || y > 180 || !(r > 0)) c.out++; };
  Object.defineProperty(c, 'fillStyle', { set: function (v) { c.styles[v] = 1; }, get: function () { return ''; } });
  return c;
}
var ctx = fake(), res = X.lutRender(ctx, w.lut, { w: 240, h: 180, M: 17 });
ok(res.points === 4913 && ctx.arcs === 4913 + 8 && ctx.fills === ctx.arcs, 'render: 17³ points + 8 corner dots drawn (' + ctx.arcs + ')');
ok(ctx.out === 0, 'render: every dot inside the 240 × 180 picture');
ok(Object.keys(ctx.styles).length > 1000, 'render: points in their own colours (' + Object.keys(ctx.styles).length + ' colours)');
var big = X.lutParse(cube(65, id), 'id65.cube').lut, c2 = fake(), r65 = X.lutRender(c2, big, { w: 240, h: 180, M: 17 });
ok(r65.M === 17 && r65.N === 65 && c2.arcs === 4913 + 8, 'render: 65³ is drawn as 17³ (sub-sampled)');
var c3 = fake(); X.lutRender(c3, r1.lut, { w: 240, h: 180 });
ok(c3.arcs === 125 + 8 && c3.out === 0, 'render: a 1-D only file draws its 5³ cloud');
process.exit(fails ? 1 : 0);
