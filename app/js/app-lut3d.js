// app-lut3d.js - the 3-D LUT viewer (user, 2026-10-28: "when the file is uploaded we see a 3D representation of that file
// … we don't need the white lines"; then "a still image … small, just like Helios / Megapixel"). File ▸ Open LUT… reads a
// .cube (Adobe / Resolve) or .3dl (Autodesk / Lustre) file and shows a small still picture: every lattice point drawn where
// the LUT sends it (its output colour is its position in the RGB cube) and in that colour, in a fixed ¾ perspective on
// near-black; the cube is only its 8 corner dots, no lines. Click the picture for a larger one. View only: nothing here
// sends a LUT to a processor.
// The parser and the renderer use no DOM (lutRender draws on any Canvas-2D context), so tests/lut_test.js runs them in
// node; out/pro/lut.html uses this file too.
// Owns: lut, lutErr, lutNum, lutCut, lutN, lutParse, lutParseCube, lutParse3dl, lutRange, lutCurve, lutCloud, lutPick,
// lutStats, lutLook, lutMakeCube, lutRender, lutDraw, lutInfo, lutCss, lutCard, lutEsc, lutShow, lutLoadFile, bindLut3d.
// Depends on: app-core ($, esc, toast), app-log (log), app-forms (uiZoom), at run time and only in the app's dialog.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var lut = { file: '', L: null, big: false };   // the LUT shown in File ▸ Open LUT… (big: the larger picture)

// ------------------------------------------------------------------ parsing
function lutErr(msg) { return { ok: false, error: msg }; }
function lutNum(s) { return s.split(/\s+/).map(Number); }
function lutCut(s) { return s.length > 40 ? s.slice(0, 40) + '…' : s; }
function lutN(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

// The text of a .cube / .3dl file → { ok: true, lut } | { ok: false, error }. By the extension, else by the content.
// lut: { format: 'cube' | '3dl', name, title, size (3-D points per axis, 0 = none), size1 (1-D length, 0 = none),
//   data (3-D outputs as in the file, R fastest), d1 (1-D outputs), grid (each axis's inputs, 0–1), dmin / dmax (the 3-D
//   domain; outputs are scaled by it too), dmin1 / dmax1 (1-D), inMax / outMax (.3dl code ranges), outLo / outHi }
function lutParse(text, name) {
  if (text == null || !String(text).trim()) return lutErr('The file is empty');
  text = String(text).replace(/^﻿/, '');
  if (text.indexOf('\0') >= 0) return lutErr('Not a text file — a .cube or .3dl LUT is plain text');
  var ext = ((/\.([a-z0-9]+)$/i.exec(name || '') || [])[1] || '').toLowerCase();
  var r = ext === '3dl' ? lutParse3dl(text) : ext === 'cube' || /^\s*(TITLE|LUT_[13]D_SIZE|DOMAIN_M)/im.test(text) ? lutParseCube(text) : lutParse3dl(text);
  if (r.ok) r.lut.name = name || ''; else if (ext !== 'cube' && ext !== '3dl') r.error = 'Not a .cube or .3dl LUT (' + r.error + ')';
  return r;
}

function lutParseCube(text) {
  var lines = text.split(/\r\n|\r|\n/), rows = [], c;
  var L = { format: 'cube', title: '', size: 0, size1: 0, dmin: [0, 0, 0], dmax: [1, 1, 1], dmin1: null, dmax1: null };
  for (var i = 0; i < lines.length; i++) {
    var s = lines[i].trim(), n = i + 1;
    if (!s || s.charAt(0) === '#') continue;
    if (/^[-+.\d]/.test(s)) {   // a table row
      var p = lutNum(s);
      if (p.length !== 3) return lutErr('Line ' + n + ': a table row needs 3 numbers (R G B), found ' + p.length);
      if (!(isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]))) return lutErr('Line ' + n + ': not a number: “' + lutCut(s) + '”');
      rows.push(p[0], p[1], p[2]); continue;
    }
    var m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?$/.exec(s);
    if (!m) return lutErr('Line ' + n + ': can’t read “' + lutCut(s) + '”');
    if (rows.length) return lutErr('Line ' + n + ': “' + lutCut(s) + '” inside the table');
    var kw = m[1].toUpperCase(), arg = (m[2] || '').trim(), v = lutNum(arg);
    var bad = function (what) { return lutErr('Line ' + n + ': ' + kw + ' ' + what + ', found “' + lutCut(arg) + '”'); };
    if (kw === 'TITLE') L.title = arg.replace(/^"([^"]*)"?$/, '$1');
    else if (kw === 'LUT_3D_SIZE' || kw === 'LUT_1D_SIZE') {
      var three = kw === 'LUT_3D_SIZE', sz = /^\d+$/.test(arg) ? +arg : 0;
      if (!(sz >= 2 && sz <= (three ? 256 : 65536))) return bad(three ? 'must be 2–256' : 'must be 2–65536');
      L[three ? 'size' : 'size1'] = sz;
    } else if (kw === 'DOMAIN_MIN' || kw === 'DOMAIN_MAX') {
      if (v.length !== 3 || !v.every(isFinite)) return bad('needs 3 numbers');
      L[kw === 'DOMAIN_MIN' ? 'dmin' : 'dmax'] = v;
    } else if (kw === 'LUT_3D_INPUT_RANGE' || kw === 'LUT_1D_INPUT_RANGE') {   // Resolve
      if (v.length !== 2 || !v.every(isFinite)) return bad('needs 2 numbers');
      if (kw === 'LUT_3D_INPUT_RANGE') { L.dmin = [v[0], v[0], v[0]]; L.dmax = [v[1], v[1], v[1]]; } else { L.dmin1 = [v[0], v[0], v[0]]; L.dmax1 = [v[1], v[1], v[1]]; }
    }   // other keywords (LUT_IN_VIDEO_RANGE …) are read past
  }
  var n3 = L.size * L.size * L.size, n1 = L.size1, got = rows.length / 3;
  if (!n3 && !n1) return lutErr(got ? 'No LUT_3D_SIZE line — not a .cube LUT' : 'No LUT_3D_SIZE line and no table — not a .cube LUT');
  if (got !== n3 + n1) return lutErr('Expected ' + lutN(n3 + n1) + ' table rows (' + [n1 ? '1-D ' + n1 : '', n3 ? L.size + '³' : ''].filter(Boolean).join(' + ') + '), found ' + lutN(got));
  if (!L.dmin1) { L.dmin1 = L.dmin.slice(); L.dmax1 = L.dmax.slice(); }
  for (c = 0; c < 3; c++) if (!(L.dmin[c] < L.dmax[c]) || !(L.dmin1[c] < L.dmax1[c])) return lutErr('The domain minimum must be below the maximum');
  L.d1 = n1 ? new Float32Array(rows.slice(0, n1 * 3)) : null;   // a Resolve shaper comes before the 3-D table
  L.data = n3 ? new Float32Array(rows.slice(n1 * 3)) : null;
  L.grid = []; for (c = 0; c < L.size; c++) L.grid.push(c / (L.size - 1));
  lutRange(L);
  return { ok: true, lut: L };
}

// .3dl: an optional "3DMESH" / "Mesh <in bits> <out bits>" header, the mesh line (the input codes per axis, 0 … 1023),
// then N³ rows of integer output codes with blue changing fastest. Output bit depth: the header, else the largest code.
function lutParse3dl(text) {
  var lines = text.split(/\r\n|\r|\n/), nums = [], at = [], inBits = 0, outBits = 0, i, j, c;
  for (i = 0; i < lines.length; i++) {
    var s = lines[i].trim(); if (!s || s.charAt(0) === '#') continue;
    var m = /^mesh\s+(\d+)\s+(\d+)$/i.exec(s);
    if (m) { inBits = +m[1]; outBits = +m[2]; continue; }
    if (/^([a-z]|3dmesh)/i.test(s)) { if (nums.length > 1) return lutErr('Line ' + (i + 1) + ': “' + lutCut(s) + '” inside the table'); continue; }   // 3DMESH, LUT8, gamma …
    var p = lutNum(s);
    if (!p.every(function (v) { return isFinite(v) && v >= 0; })) return lutErr('Line ' + (i + 1) + ': not a code (0 … 65535): “' + lutCut(s) + '”');
    nums.push(p); at.push(i + 1);
  }
  if (!nums.length) return lutErr('No table — not a .3dl LUT');
  var rising = function (a) { for (var k = 1; k < a.length; k++) if (!(a[k] > a[k - 1])) return false; return true; };
  // the mesh line: not 3 values, or 3 rising values when the rows alone aren't a cube number (N³ + 1 never is)
  var cubic = Math.pow(Math.round(Math.cbrt(nums.length)), 3) === nums.length;
  var mesh = nums[0].length !== 3 || (!cubic && rising(nums[0])) ? nums.shift() : null, meshAt = mesh ? at.shift() : 0;
  var N = mesh ? mesh.length : Math.round(Math.cbrt(nums.length));
  if (mesh && !(N >= 2 && N <= 256)) return lutErr('Line ' + meshAt + ': the mesh line has ' + N + ' values (2–256 expected)');
  if (mesh && !rising(mesh)) return lutErr('Line ' + meshAt + ': the mesh line must rise (0 … 1023)');
  for (j = 0; j < nums.length; j++) if (nums[j].length !== 3) return lutErr('Line ' + at[j] + ': a table row needs 3 numbers (R G B), found ' + nums[j].length);
  if (nums.length !== N * N * N) return lutErr(mesh ? 'Expected ' + lutN(N * N * N) + ' rows for a ' + N + '-point mesh, found ' + lutN(nums.length) : 'Found ' + lutN(nums.length) + ' rows: no mesh line, and not a cube number');
  var top = 0; nums.forEach(function (r) { top = Math.max(top, r[0], r[1], r[2]); });
  var nice = function (v, eight) { return eight && v <= 255 ? 255 : v <= 1023 ? 1023 : v <= 4095 ? 4095 : 65535; };
  if (mesh && inBits && N !== Math.pow(2, inBits) + 1) return lutErr('The Mesh line says ' + (Math.pow(2, inBits) + 1) + ' points per axis, the mesh line (line ' + meshAt + ') has ' + N);
  var inMax = mesh ? nice(mesh[N - 1], mesh[N - 1] <= 255) : 1023;   // "Mesh 4 12": 2⁴ + 1 points, 12-bit out
  var outMax = outBits ? Math.pow(2, outBits) - 1 : nice(top, inMax === 255);
  if (top > outMax) return lutErr('Codes up to ' + top + ' don’t fit the ' + outBits + '-bit output in the Mesh line');
  var L = { format: '3dl', title: '', size: N, size1: 0, inMax: inMax, outMax: outMax, dmin: [0, 0, 0], dmax: [outMax, outMax, outMax], d1: null };
  L.data = new Float32Array(N * N * N * 3);
  for (j = 0; j < nums.length; j++) {   // file order: R slowest, B fastest → cube order (R fastest)
    var r = Math.floor(j / (N * N)), g = Math.floor(j / N) % N, b = j % N, k = r + g * N + b * N * N;
    for (c = 0; c < 3; c++) L.data[k * 3 + c] = nums[j][c];
  }
  L.grid = []; for (c = 0; c < N; c++) L.grid.push(mesh ? mesh[c] / inMax : c / (N - 1));
  L.dmin1 = [0, 0, 0]; L.dmax1 = [1, 1, 1];
  lutRange(L);
  return { ok: true, lut: L };
}

function lutRange(L) {   // the lowest / highest output per channel, in the file's own units
  var d = L.data || L.d1; L.outLo = [Infinity, Infinity, Infinity]; L.outHi = [-Infinity, -Infinity, -Infinity];
  for (var i = 0; i < d.length; i++) { var c = i % 3; if (d[i] < L.outLo[c]) L.outLo[c] = d[i]; if (d[i] > L.outHi[c]) L.outHi[c] = d[i]; }
}
function lutCurve(L, c, t) {   // a 1-D table at t (0–1 along it), linear between its entries
  var x = Math.max(0, Math.min(1, t)) * (L.size1 - 1), i = Math.min(L.size1 - 2, Math.floor(x)), f = x - i;
  return L.d1[i * 3 + c] * (1 - f) + L.d1[(i + 1) * 3 + c] * f;
}
// The point cloud: { N, grid (inputs per axis, 0–1), out: Float32Array of N³ × RGB outputs scaled by the domain (R fastest) }.
// A 1-D-only file: its three curves applied to a lattice of up to 33 points per axis.
function lutCloud(L) {
  if (L.cloud) return L.cloud;
  var N, grid, out, i, c;
  if (L.data) {
    N = L.size; grid = L.grid; out = new Float32Array(L.data.length);
    for (i = 0; i < out.length; i++) { c = i % 3; out[i] = (L.data[i] - L.dmin[c]) / (L.dmax[c] - L.dmin[c]); }
  } else {
    N = Math.min(33, L.size1); grid = []; for (i = 0; i < N; i++) grid.push(i / (N - 1));
    out = new Float32Array(N * N * N * 3);
    for (i = 0; i < N * N * N; i++) {
      var q = [i % N, Math.floor(i / N) % N, Math.floor(i / (N * N))];
      for (c = 0; c < 3; c++) out[i * 3 + c] = (lutCurve(L, c, q[c] / (N - 1)) - L.dmin[c]) / (L.dmax[c] - L.dmin[c]);
    }
  }
  L.cloud = { N: N, grid: grid, out: out };
  return L.cloud;
}
function lutPick(N, M) {   // M of N lattice indices, evenly spread, both ends kept
  M = Math.max(2, Math.min(N, M)); var a = [];
  for (var k = 0; k < M; k++) a.push(Math.round(k * (N - 1) / (M - 1)));
  return a;
}
function lutStats(L) {   // how far the LUT moves colours (0–1 units): { max, mean }
  var C = lutCloud(L), N = C.N, g = C.grid, mx = 0, sum = 0, n = N * N * N;
  for (var i = 0; i < n; i++) {
    var dr = C.out[i * 3] - g[i % N], dg = C.out[i * 3 + 1] - g[Math.floor(i / N) % N], db = C.out[i * 3 + 2] - g[Math.floor(i / (N * N))];
    var d = Math.sqrt(dr * dr + dg * dg + db * db); sum += d; if (d > mx) mx = d;
  }
  return { max: mx, mean: sum / n };
}

// ------------------------------------------------------------------ sample LUTs (the demo page, the tests)
function lutLook(kind, r, g, b) {
  var cl = function (x) { return Math.max(0, Math.min(1, x)); }, l;
  if (kind === 'warm') {   // a warm film look: warmer white, less saturation, teal shadows / amber highlights, S-curve, faded blacks
    r *= 1.05; b *= 0.88; l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = l + (r - l) * 0.85; g = l + (g - l) * 0.85; b = l + (b - l) * 0.85;
    var sh = Math.pow(1 - cl(l), 3), hi = Math.pow(cl(l), 2);
    r += -0.03 * sh + 0.035 * hi; g += 0.012 * sh + 0.01 * hi; b += 0.045 * sh - 0.04 * hi;
    var s = function (x) { x = cl(x); return 0.025 + 0.95 * (x + 0.5 * (x * x * (3 - 2 * x) - x)); };
    return [s(r), s(g), s(b)];
  }
  if (kind === 'teal') {   // teal & orange: warm hues pushed to orange, cool ones to teal
    l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    var cr = r - l, cg = g - l, cb = b - l, sat = Math.sqrt(cr * cr + cg * cg + cb * cb), w = r - b;
    var dir = w >= 0 ? [0.5, 0.02, -0.55] : [-0.5, 0.12, 0.42], a = 0.45 * Math.min(1, Math.abs(w) * 2.5) * sat;
    return [cl(l + cr * 0.9 + dir[0] * a), cl(l + cg * 0.9 + dir[1] * a), cl(l + cb * 0.9 + dir[2] * a)];
  }
  return [r, g, b];   // identity
}
function lutMakeCube(kind, N, title) {   // .cube text
  var t = ['# Open Nova sample LUT', 'TITLE "' + (title || kind) + '"', 'LUT_3D_SIZE ' + N, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
  for (var b = 0; b < N; b++) for (var g = 0; g < N; g++) for (var r = 0; r < N; r++)
    t.push(lutLook(kind, r / (N - 1), g / (N - 1), b / (N - 1)).map(function (v) { return v.toFixed(6); }).join(' '));
  return t.join('\n') + '\n';
}

// ------------------------------------------------------------------ the picture
// Draws L on a Canvas-2D context, w × h (context units): near-black, the 8 corner dots, M³ points (up to M per axis, default
// 17) at their output colour, back to front, in a fixed ¾ perspective (R → right, G → up, B → towards you, turned and
// tilted so black is low and white high). → { points, M, N }
function lutRender(ctx, L, o) {
  o = o || {};
  var W = o.w, H = o.h, C = lutCloud(L), N = C.N, idx = lutPick(N, o.M || 17), M = idx.length, i, k;
  ctx.fillStyle = '#08090b'; ctx.fillRect(0, 0, W, H);
  if (ctx.createRadialGradient) {
    var bg = ctx.createRadialGradient(W * 0.5, H * 0.46, 0, W * 0.5, H * 0.46, Math.max(W, H) * 0.62);
    bg.addColorStop(0, '#171a20'); bg.addColorStop(1, '#08090b'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  }
  var yaw = o.yaw != null ? o.yaw : -0.66, pitch = o.pitch != null ? o.pitch : 0.5, dist = 2.9;
  var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  var kz = Math.min(W, H) * 1.4;   // projection scale: the cube fills ~ 75 % of the shorter side
  var r0 = o.r || Math.max(0.9, Math.min(W, H) / (M * 8.5));   // dots ~ ⅓ of their spacing: the inside shows through
  var pts = [];   // [x, y, depth, radius, colour, alpha]
  var put = function (x, y, z, col, a, rr) {
    x -= 0.5; y -= 0.5; z -= 0.5;
    var vx = cy * x + sy * z, vy = sp * sy * x + cp * y - sp * cy * z, vz = -cp * sy * x + sp * y + cp * cy * z, w = dist - vz;
    pts.push([W / 2 + kz * vx / w, H / 2 - kz * vy / w + H * 0.02, vz, rr * dist / w, col, a]);
  };
  var hex = function (r, g, b) { return 'rgb(' + Math.round(Math.max(0, Math.min(1, r)) * 255) + ',' + Math.round(Math.max(0, Math.min(1, g)) * 255) + ',' + Math.round(Math.max(0, Math.min(1, b)) * 255) + ')'; };
  for (k = 0; k < 8; k++) {   // the cube: its corners only, faint
    var X = k & 1, Y = (k >> 1) & 1, Z = (k >> 2) & 1;
    put(X, Y, Z, hex(0.3 + X * 0.45, 0.3 + Y * 0.45, 0.3 + Z * 0.45), 0.55, Math.max(1.2, r0 * 0.75));
  }
  for (var b = 0; b < M; b++) for (var g = 0; g < M; g++) for (var r = 0; r < M; r++) {
    i = (idx[r] + idx[g] * N + idx[b] * N * N) * 3;
    put(C.out[i], C.out[i + 1], C.out[i + 2], hex(C.out[i], C.out[i + 1], C.out[i + 2]), 1, r0);
  }
  pts.sort(function (p, q) { return p[2] - q[2]; });
  for (k = 0; k < pts.length; k++) {
    var p = pts[k];
    ctx.globalAlpha = p[5]; ctx.fillStyle = p[4];
    ctx.beginPath(); ctx.arc(p[0], p[1], p[3], 0, 6.2832); ctx.fill();
  }
  ctx.globalAlpha = 1;
  return { points: M * M * M, M: M, N: N };
}
// Size a canvas to w × h CSS px (sharp at the screen's pixel ratio and the interface size) and draw L on it.
function lutDraw(cv, L, w, h, M) {
  var s = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) * (typeof uiZoom === 'function' ? uiZoom() : 1);
  cv.width = Math.round(w * s); cv.height = Math.round(h * s); cv.style.width = w + 'px'; cv.style.height = 'auto';   // auto: keeps its shape when max-width narrows it
  var ctx = cv.getContext('2d'); ctx.setTransform(s, 0, 0, s, 0, 0);
  return lutRender(ctx, L, { w: w, h: h, M: M });
}

// [label, value] rows for the card: format, size, domain, output range, how much it moves colours.
function lutInfo(L) {
  var f = function (v) { return Math.abs(v) >= 100 ? String(Math.round(v)) : (+v.toFixed(3)).toString(); };
  var span = function (lo, hi) {
    var t = [0, 1, 2].map(function (c) { return f(lo[c]) + '–' + f(hi[c]); });
    return t[0] === t[1] && t[1] === t[2] ? t[0] : 'R ' + t[0] + ' · G ' + t[1] + ' · B ' + t[2];
  };
  var bits = function (m) { return Math.round(Math.log(m + 1) / Math.LN2) + '-bit'; };
  var st = lutStats(L), rows = [];
  rows.push(['Format', L.format === '3dl' ? '.3dl · ' + bits(L.inMax) + ' in, ' + bits(L.outMax) + ' out' : '.cube' + (L.d1 && L.data ? ' with 1-D shaper' : '')]);
  rows.push(['Size', (L.size ? L.size + '³ (' + lutN(L.size * L.size * L.size) + ' points)' : '') + (L.size1 ? (L.size ? ' + ' : '') + '1-D ' + lutN(L.size1) : '')]);
  rows.push(['Domain', L.format === '3dl' ? '0–' + L.inMax : span(L.data ? L.dmin : L.dmin1, L.data ? L.dmax : L.dmax1)]);
  rows.push(['Output', span(L.outLo, L.outHi)]);
  rows.push(['Shift', st.max < 0.0005 ? 'none (identity)' : 'up to ' + st.max.toFixed(3) + ', mean ' + st.mean.toFixed(3)]);
  return rows;
}

// ------------------------------------------------------------------ the card (the app's dialog, the demo page)
function lutCss() {
  if (document.getElementById('lutCss')) return;
  var s = document.createElement('style'); s.id = 'lutCss';
  s.textContent = '.lut-card{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:flex-start;margin:0}' +
    '.lut-pic{display:block;flex:none;max-width:100%;border:1px solid #000;border-radius:8px;background:#08090b;cursor:zoom-in}' +
    '.lut-card.big .lut-pic{cursor:zoom-out}' +
    '.lut-card figcaption{flex:1 1 170px;min-width:0}' +
    '.lut-card figcaption b{display:block;margin:0 0 6px;overflow-wrap:anywhere}' +
    '.lut-card dl{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 10px;margin:0;font-size:calc(12.5px * var(--fs, 1))}' +
    '.lut-card dt{color:var(--muted, var(--ink-3, #9aa3ae));font:inherit}.lut-card dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}' +
    '.lut-msg{margin:8px 0;color:var(--muted, var(--ink-3, #9aa3ae))}.lut-msg.err{color:var(--danger, var(--bad-ink, #ff8487))}' +
    '.lut-box{width:min(820px,100%)}';
  document.head.appendChild(s);
}
// Fill host with L's card: the picture (small: 240 × 180; big: up to 720 × 540, as wide as host allows) and its facts.
// onPic: called when the picture is clicked.
function lutCard(host, L, big, onPic) {
  lutCss();
  var fig = document.createElement('figure'); fig.className = 'lut-card' + (big ? ' big' : '');
  var cv = document.createElement('canvas'); cv.className = 'lut-pic';
  cv.title = big ? 'Click for the small picture' : 'Click for a larger picture';
  cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', '3-D picture of the LUT: each colour drawn where the LUT sends it');
  var cap = document.createElement('figcaption'), name = L.title || L.name || 'LUT';
  cap.innerHTML = '<b title="' + lutEsc(L.name || '') + '">' + lutEsc(name) + '</b><dl>' + lutInfo(L).map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + lutEsc(r[1]) + '</dd>'; }).join('') + '</dl>';
  fig.appendChild(cv); fig.appendChild(cap);
  host.innerHTML = ''; host.appendChild(fig);
  var w = big ? Math.max(160, Math.min(720, Math.floor(host.clientWidth || 720) - 2)) : 240;
  lutDraw(cv, L, w, Math.round(w * 0.75), big ? 33 : 17);
  if (onPic) cv.onclick = onPic;
  return fig;
}
function lutEsc(t) { return String(t).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

// ------------------------------------------------------------------ File ▸ Open LUT… (the app)
function lutShow() {
  var body = $('lutBody'); if (!body) return;
  if (!lut.L) { body.innerHTML = '<p class="lut-msg">Open a .cube or .3dl file.</p>'; return; }
  lutCard(body, lut.L, lut.big, function () { lut.big = !lut.big; log('lut_picture', { file: lut.file, size: lut.big ? 'large' : 'small' }); lutShow(); });
}
function lutLoadFile(f) {
  if (!f) return;
  var dlg = $('lutDlg'), t0 = Date.now();
  if (f.size > 120 * 1024 * 1024) { log('lut_open', { file: f.name, error: 'too big', bytes: f.size }); toast('That file is too big for a LUT (' + Math.round(f.size / 1048576) + ' MB)'); return; }
  var rd = new FileReader();
  rd.onload = function () {
    var r = lutParse(rd.result, f.name);
    lut.file = f.name; dlg.hidden = false;
    if (!r.ok) {
      lut.L = null; log('lut_open', { file: f.name, error: r.error });
      $('lutBody').innerHTML = '<p class="lut-msg err"><b>' + esc(f.name) + '</b> can’t be read: ' + esc(r.error) + '</p>';
      return;
    }
    lut.L = r.lut; lut.big = false; lutShow();
    log('lut_open', { file: f.name, format: r.lut.format, size: r.lut.size, size1: r.lut.size1, bytes: f.size, ms: Date.now() - t0 });
  };
  rd.onerror = function () { log('lut_open', { file: f.name, error: 'read failed' }); toast('Couldn’t read ' + f.name); };
  rd.readAsText(f);
}
function bindLut3d() {
  var d = document.createElement('div'); d.id = 'lutDlg'; d.className = 'logdlg'; d.hidden = true;
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'LUT');
  d.innerHTML = '<div class="logbox keysbox lut-box"><div class="loghead"><b>3-D LUT</b><span class="grow"></span>' +
    '<button id="lutAgain" title="Open another .cube or .3dl file">Open…</button><button id="lutClose" title="Close (Esc)">×</button></div>' +
    '<div id="lutBody" class="keysbody"></div><input type="file" id="lutFile" accept=".cube,.3dl" hidden></div>';
  document.body.appendChild(d);
  lutCss();
  var pick = function () { $('lutFile').value = ''; $('lutFile').click(); };
  if ($('mbLut')) $('mbLut').addEventListener('click', pick);
  $('lutAgain').onclick = pick;
  $('lutFile').onchange = function () { lutLoadFile(this.files[0]); };
  $('lutClose').onclick = function () { d.hidden = true; };
  // closed by × or Esc (app-shell.js hides any open dialog on Esc)
  new MutationObserver(function () { if (d.hidden) log('lut_close', { file: lut.file }); }).observe(d, { attributes: true, attributeFilter: ['hidden'] });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { lutParse: lutParse, lutCloud: lutCloud, lutPick: lutPick, lutStats: lutStats, lutLook: lutLook, lutMakeCube: lutMakeCube, lutRender: lutRender, lutInfo: lutInfo };
