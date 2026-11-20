// app-gamut.js - NovaLCT's custom gamut (user, 2026-11-06: "we need to build this incase someone doesnt use a lut"), the same
// settings as its Configure Color Space: original R / G / B / white (x, y, luminance), target PAL / NTSC / custom, target white with
// a colour temperature, named entries; the "target gamut exceeds original gamut" check. M = transpose(T · inverse(O)), each
// coefficient ·255 cut to a byte, gives NovaLCT's bytes for its three recorded Sends (tests/gamut_test.js).
// The target's luminances: its primaries solved for the white, the white stepped down 1 % at a time (15 tries) until each is under
// the original's, as NovaLCT does; the luminance can be typed, as in NovaLCT. Sent through the Gamut control (drv-lct.js screenSet).
// The maths uses no DOM, so tests/gamut_test.js runs it in node.
// Owns: gm, GM_DEF, GM_PRIMS, gmRows, gmInv, gmSolve, gmWhite, gmFit, gmMatrix, gmBytes, gmInside, gmCheck, gmRecord, gmParse, gmCct,
// gmCompare, gmLogCard, gmEntry, gmBuild, gmPrims, gmDraft, gmOpen, gmShow, gmResult, gmRead, gmSend, gmDelete, bindGamut.
// Depends on: app-lutfit (lfHex); in the app: app-core (P, $, esc, uid, toast, commit, renderAll), app-log (log), app-screen (scr, scrLc,
// scrKey, scrDevices, scrLive, scrLocked), drv-core (DRV).
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var gm = { e: null, lc: null };   // the entry in the dialog
var GM_DEF = { orig: [[.675, .33, 900], [.19, .78, 1800], [.13, .04, 300]], white: [.3127, .329] };   // NovaLCT's defaults, its D65
var GM_PRIMS = { pal: [[.64, .33], [.3, .6], [.15, .06]], ntsc: [[.67, .33], [.21, .71], [.14, .08]] };

function gmRows(p) { return p.map(function (q) { return [q[2] * q[0] / q[1], q[2], q[2] * (1 - q[0] - q[1]) / q[1]]; }); }
function gmInv(a) {
  var d = a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  if (Math.abs(d) < 1e-12) return null;
  var c = function (i, j) { var r = [0, 1, 2].filter(function (x) { return x !== i; }), s = [0, 1, 2].filter(function (x) { return x !== j; }); return ((i + j) % 2 ? -1 : 1) * (a[r[0]][s[0]] * a[r[1]][s[1]] - a[r[0]][s[1]] * a[r[1]][s[0]]) / d; };
  return [0, 1, 2].map(function (i) { return [0, 1, 2].map(function (j) { return c(j, i); }); });
}
// The primaries' luminances for white w = [x, y, Y] (NovaLCT's RGBCxCyFromWhiteCxCy) → [[x, y, Y] × 3], or null.
function gmSolve(prims, w) {
  var A = [0, 1, 2].map(function (k) { return prims.map(function (p) { return [p[0] / p[1], 1, (1 - p[0] - p[1]) / p[1]][k]; }); }), inv = gmInv(A); if (!inv) return null;
  var W = [w[2] * w[0] / w[1], w[2], w[2] * (1 - w[0] - w[1]) / w[1]];
  return prims.map(function (p, i) { return [p[0], p[1], inv[i][0] * W[0] + inv[i][1] * W[1] + inv[i][2] * W[2]]; });
}
// The white of three primaries (RGBCxCyToWhiteCxCy) → [x, y, Y].
function gmWhite(p) {
  var t = gmRows(p), X = t[0][0] + t[1][0] + t[2][0], Y = t[0][1] + t[1][1] + t[2][1], Z = t[0][2] + t[1][2] + t[2][2], s = X + Y + Z || 1;
  return [X / s, Y / s, Y];
}
// NovaLCT's target white: from the original white's luminance, down 1 % a try (15 tries) until every primary is under the original's.
function gmFit(orig, prims, w) {
  var top = gmWhite(orig)[2], lum = top, t = null;
  for (var i = 0; i < 15; i++) {
    t = gmSolve(prims, [w[0], w[1], lum]);
    if (t && t[0][2] < orig[0][2] && t[1][2] < orig[1][2] && t[2][2] < orig[2][2]) break;
    lum = top * (1 - (i + 1) * .01);
  }
  return t ? gmWhite(t)[2] : lum;
}
function gmMatrix(orig, target) {
  var inv = gmInv(gmRows(orig)), T = gmRows(target); if (!inv) return null;
  var R = T.map(function (r) { return [0, 1, 2].map(function (j) { return r[0] * inv[0][j] + r[1] * inv[1][j] + r[2] * inv[2][j]; }); });
  return [0, 1, 2].map(function (i) { return [R[0][i], R[1][i], R[2][i]]; });
}
function gmBytes(M) { var b = []; M.forEach(function (r) { r.forEach(function (v) { b.push(Math.trunc(v * 255) & 255); }); }); return b; }
function gmInside(p, t) {
  var s = function (a, b, c) { return (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]); };
  var d = [s(p, t[0], t[1]), s(p, t[1], t[2]), s(p, t[2], t[0])];
  return !(d.some(function (v) { return v < 0; }) && d.some(function (v) { return v > 0; }));
}
// What's wrong with these settings, '' = nothing.
function gmCheck(orig, prims, w, M) {
  if (!prims.every(function (p) { return gmInside(p, orig); })) return 'Target gamut exceeds original gamut';
  if (!gmInside(w, prims)) return 'Target white is outside the target gamut';
  if (!M) return 'The original colours don’t make a triangle';
  if (M.some(function (r) { return r.some(function (v) { return v < -.002 || v > 1; }); })) return 'Too bright for these LEDs: lower the target luminance';
  return '';
}
// The 0x12009000 record (NovaLCT's ColorRestoreInfo): magic, type (00 its PAL / NTSC, FF custom), original xy + Y, target xy + Y, matrix.
function gmRecord(orig, target, mb, type) {
  var b = new Uint8Array(256).fill(0xFF), u = function (o, v) { v = Math.max(0, Math.min(65535, Math.round(v))); b[o] = v & 255; b[o + 1] = v >> 8; };
  [0x47, 0x63, 0x09, 0x6D].forEach(function (v, i) { b[i] = v; }); b[4] = type === 'custom' ? 0xFF : 0;
  [[orig, 16], [target, 40]].forEach(function (s) {
    var p = s[0].concat([gmWhite(s[0])]);
    p.forEach(function (q, i) { u(s[1] + i * 4, q[0] * 10000); u(s[1] + i * 4 + 2, q[1] * 10000); u(s[1] + 16 + i * 2, q[2] * 10); });
  });
  [mb[0], mb[1], mb[2], 0, mb[3], mb[4], mb[5], 0, mb[6], mb[7], mb[8], 0, 0, 0, 0, mb[0]].forEach(function (v, i) { u(64 + i * 2, v); });
  return lfHex(b);
}
// A record as hex → { orig, target, matrix } (nothing valid: null).
function gmParse(hex) {
  if (!hex || hex.length < 192 || hex.slice(0, 8).toUpperCase() !== '4763096D') return null;
  var u = function (o) { return parseInt(hex.substr(o * 2 + 2, 2) + hex.substr(o * 2, 2), 16); };
  var side = function (o) { return [0, 1, 2].map(function (i) { return [u(o + i * 4) / 10000, u(o + i * 4 + 2) / 10000, u(o + 16 + i * 2) / 10]; }); };
  var r = { orig: side(16), target: side(40), matrix: [64, 66, 68, 72, 74, 76, 80, 82, 84].map(u), type: hex.substr(8, 2).toUpperCase() };
  return r.orig.every(function (p) { return p[0] > 0 && p[0] < 1 && p[1] > 0 && p[1] < 1 && p[2] > 0; }) ? r : null;
}
// Colour temperature → white xy (NovaLCT's GetXYFromTemperature, the CIE daylight locus; none below 4000 K, as there).
function gmCct(T) {
  if (T < 4000 || T > 25000) return null;
  var x = T > 7000 ? -2.0064e9 / (T * T * T) + 1.9018e6 / (T * T) + 247.48 / T + .23704 : -4.607e9 / (T * T * T) + 2.9678e6 / (T * T) + 99.11 / T + .244063;
  return [x, -3 * x * x + 2.87 * x - .275];
}
// What a record on the cards says against our maths, for the log: NovaLCT sets a gamut, Open Nova reads it, and the two can be
// compared (user, 2026-11-06). steps: how many 1 % steps of 0.99 its target white is below the original white (recorded: 44 for
// PAL, 11 for NTSC), oneStep: the white our single pass gives, same: our bytes from its own target = the bytes on the cards.
function gmCompare(c) {
  var prims = c.target.map(function (p) { return [p[0], p[1]]; }), ow = gmWhite(c.orig), tw = gmWhite(c.target), M = gmMatrix(c.orig, c.target), ours = M ? gmBytes(M) : null;
  var r3 = function (a) { return a.map(function (v) { return +v.toFixed(4); }); };
  return { type: c.type, original: c.orig.map(r3), target: c.target.map(r3), originalWhite: r3(ow), targetWhite: r3(tw), matrix: c.matrix, ourMatrix: ours, same: !!ours && ours.join() === c.matrix.join(),
    oneStep: +gmFit(c.orig, prims, tw).toFixed(1), steps: +(Math.log(tw[2] / ow[2]) / Math.log(.99)).toFixed(2) };
}
// Logged once per processor and record: every read of a screen comes here (app-screen.js scrRead).
function gmLogCard(d, lc, hex) {
  var c = gmParse(hex); if (!c) return;
  gm.seen = gm.seen || {}; if (gm.seen[d.id] === hex) return; gm.seen[d.id] = hex;
  log('gamut_on_cards', Object.assign({ processor: deviceLabel(d), screen: lc.name }, gmCompare(c)));
}
function gmEntry(v) { var m = /^c:(.+)$/.exec(v || ''); return m && typeof P !== 'undefined' ? (P.gamuts || []).filter(function (e) { return e.id === m[1]; })[0] || null : null; }
// An entry → { m (the 10 bytes as hex), rec, mb, M, target, error }.
function gmBuild(e) {
  var prims = e.type === 'custom' ? e.prims : GM_PRIMS[e.type], target = gmSolve(prims, e.white), M = target && gmMatrix(e.orig, target), err = target ? gmCheck(e.orig, prims, e.white, M) : 'The target colours don’t make a triangle';
  if (!M) return { error: err };
  var mb = gmBytes(M);
  return { mb: mb, M: M, target: target, error: err, m: '02' + lfHex(mb), rec: gmRecord(e.orig, target, mb, e.type) };
}
function gmPrims(v) { var e = gmEntry(v); return e ? (e.type === 'custom' ? e.prims : GM_PRIMS[e.type]) : null; }

// ------------------------------------------------------------------ Screen Settings ▸ Custom gamut… (the app)
function gmDraft(lc) {
  var cur = gmEntry((lc.color || {}).gamut); if (cur) return JSON.parse(JSON.stringify(cur));
  var e = { id: '', name: 'Custom ' + ((P.gamuts || []).length + 1), type: 'pal', orig: JSON.parse(JSON.stringify(GM_DEF.orig)), prims: JSON.parse(JSON.stringify(GM_PRIMS.pal)), white: GM_DEF.white.concat([0]), auto: true };
  e.white[2] = gmFit(e.orig, GM_PRIMS.pal, e.white);
  return e;
}
function gmOpen() { var lc = scrLc(); if (!lc) return; gm = { e: gmDraft(lc), lc: lc }; gmShow(); $('gmDlg').hidden = false; gmRead(true); }
function gmShow() {
  var e = gm.e, n4 = function (v) { return (+v).toFixed(4); }, ro = e.type === 'custom' ? '' : ' readonly', inp = function (k, v, more) { return '<input type="number" step="any" data-gm="' + k + '" value="' + v + '"' + (more || '') + '>'; };
  var ow = gmWhite(e.orig), names = ['Red', 'Green', 'Blue'], prims = e.type === 'custom' ? e.prims : GM_PRIMS[e.type];
  $('gmBody').innerHTML = '<label class="gm-name">Name <input type="text" data-gm="name" maxlength="40" value="' + esc(e.name) + '"></label>' +
    '<div class="seg gm-type" role="group" aria-label="Target">' + [['pal', 'Rec.709'], ['ntsc', 'NTSC'], ['custom', 'Custom']].map(function (t) { return '<button type="button" data-gmt="' + t[0] + '"' + (t[0] === e.type ? ' class="on"' : '') + (t[0] === 'pal' ? ' title="NovaLCT’s PAL"' : '') + '>' + t[1] + '</button>'; }).join('') + '</div>' +
    '<div class="gm-scroll"><table class="cmp gm-tbl"><tr><th></th><th colspan="3">Original (the LEDs)</th><th colspan="3">Target</th></tr><tr><th></th><th>x</th><th>y</th><th>Lum</th><th>x</th><th>y</th><th>Lum</th></tr>' +
    names.map(function (nm, i) {
      return '<tr><th>' + nm + '</th><td>' + inp('o' + i + '0', n4(e.orig[i][0])) + '</td><td>' + inp('o' + i + '1', n4(e.orig[i][1])) + '</td><td>' + inp('o' + i + '2', (+e.orig[i][2]).toFixed(1)) + '</td>' +
        '<td>' + inp('p' + i + '0', n4(prims[i][0]), ro) + '</td><td>' + inp('p' + i + '1', n4(prims[i][1]), ro) + '</td><td data-gmy="' + i + '"></td></tr>';
    }).join('') +
    '<tr><th>White</th><td>' + n4(ow[0]) + '</td><td>' + n4(ow[1]) + '</td><td>' + ow[2].toFixed(1) + '</td><td>' + inp('w0', n4(e.white[0])) + '</td><td>' + inp('w1', n4(e.white[1])) + '</td><td>' + inp('w2', (+e.white[2]).toFixed(1)) + '</td></tr></table></div>' +
    '<label class="gm-cct"><span>Target colour temperature</span><input type="range" data-gm="cct" min="1700" max="10000" step="100" value="6500"><span id="gmK">6500 K</span></label>' +
    '<div id="gmOut"></div>';
  gmResult();
}
function gmResult() {
  var b = gmBuild(gm.e), box = $('gmOut'), locked = scrLocked();
  Array.prototype.forEach.call(document.querySelectorAll('#gmBody [data-gmy]'), function (td) { td.textContent = b.target ? b.target[+td.dataset.gmy][2].toFixed(1) : '—'; });
  box.innerHTML = (b.error ? '<p class="rd-msg err">' + esc(b.error) + '</p>' : '') + (b.M ? '<p class="hint">Gamut matrix (what each colour takes from the LEDs):</p><table class="cmp lf-m">' + b.M.map(function (r) { return '<tr>' + r.map(function (v) { return '<td>' + (v * 100).toFixed(1) + ' %</td>'; }).join('') + '</tr>'; }).join('') + '</table>' : '') +
    '<p class="hint">Live, not saved until Save.' + (locked ? ' Unlock sending to send it (Settings ▸ Alpha ▸ Allow sending).' : '') + '</p>';
  $('gmGo').disabled = !!b.error || locked;
  $('gmDel').hidden = !gm.e.id;
}
// What the card has: its original colours (and target) go in the dialog, as NovaLCT's Refresh. quiet: when the dialog opens.
function gmRead(quiet) {
  var e0 = scrDevices(gm.lc).filter(function (e) { return e.d.hw && DRV.of(e.d).readColor; })[0];
  if (!e0) return quiet ? null : toast('Link this screen’s processor first (Processors ▸ Hardware)');
  return DRV.of(e0.d).readColor(e0.d, e0.ports).then(function (r) {
    var c = r && r.ok ? gmParse(r.record) : null;
    if (!c) return quiet ? null : toast('No gamut stored on the cards: NovaLCT’s default colours stay');
    var e = gm.e; e.orig = c.orig;
    if (!quiet || !e.id) { e.type = 'custom'; e.prims = c.target.map(function (p) { return [p[0], p[1]]; }); var w = gmWhite(c.target); e.white = w; e.auto = false; }
    gmLogCard(e0.d, gm.lc, r.record); gmShow();
  }, function (x) { if (!quiet) toast('Read failed: ' + x.message); });
}
function gmSend() {
  var e = gm.e, lc = gm.lc, b = gmBuild(e); if (b.error) return toast(b.error);
  P.gamuts = P.gamuts || [];
  if (!e.id) { e.id = uid(); P.gamuts.push(e); } else P.gamuts = P.gamuts.map(function (x) { return x.id === e.id ? e : x; });
  delete e.auto;
  log('gamut_custom', { screen: lc.name, name: e.name, type: e.type, matrix: b.mb, original: e.orig, target: b.target, white: e.white });
  $('gmDlg').hidden = true;
  lc.color = lc.color || {}; lc.color.gamut = 'c:' + e.id; commit(); renderAll(); scrLive('gamut', lc.color.gamut);
}
function gmDelete() {
  var e = gm.e, lc = gm.lc; if (!e.id || !confirm('Delete “' + e.name + '”? Screens using it go back to gamut off.')) return;
  P.gamuts = P.gamuts.filter(function (x) { return x.id !== e.id; });
  $('gmDlg').hidden = true;
  var on = (lc.color || {}).gamut === 'c:' + e.id;
  (P.lct || []).forEach(function (l) { if (l.color && l.color.gamut === 'c:' + e.id) l.color.gamut = 'original'; });
  commit(); renderAll(); if (on) scrLive('gamut', 'original');
}
function bindGamut() {
  var d = document.createElement('div'); d.id = 'gmDlg'; d.className = 'logdlg rcv-dlg'; d.hidden = true;
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Custom gamut');
  d.innerHTML = '<div class="logbox keysbox svc-box gm-box"><div class="loghead"><b>Custom gamut</b><span class="grow"></span><button id="gmClose" title="Close (Esc)">×</button></div>' +
    '<div id="gmBody" class="keysbody"></div><div class="rcv-foot"><button id="gmCancel" class="primary-outline">Cancel</button><button id="gmDel" class="danger" hidden>Delete</button><span class="grow"></span>' +
    '<button id="gmRead" title="Read the colours stored on the cards. Changes nothing.">Read from cards</button><button id="gmGo" class="primary" title="Keep this gamut and send it to this screen’s processor. Not saved.">Send</button></div></div>';
  document.body.appendChild(d);
  $('gmClose').onclick = $('gmCancel').onclick = function () { d.hidden = true; };
  $('gmGo').onclick = function () { gmSend(); };
  $('gmDel').onclick = function () { gmDelete(); };
  $('gmRead').onclick = function () { gmRead(false); };
  $('gmBody').addEventListener('click', function (ev) {
    var t = ev.target.closest('[data-gmt]'); if (!t) return;
    var e = gm.e, was = e.type === 'custom' ? e.prims : GM_PRIMS[e.type];
    if (t.dataset.gmt === 'custom') e.prims = JSON.parse(JSON.stringify(was));
    e.type = t.dataset.gmt; if (e.auto) e.white[2] = gmFit(e.orig, e.type === 'custom' ? e.prims : GM_PRIMS[e.type], e.white);
    gmShow();
  });
  $('gmBody').addEventListener('input', function (ev) {
    var k = ev.target.dataset.gm, e = gm.e, v = +ev.target.value; if (!k) return;
    if (k === 'name') { e.name = ev.target.value; return; }
    if (k === 'cct') {
      var w = gmCct(v); $('gmK').textContent = v + ' K' + (w ? '' : ' (no white below 4000 K, as in NovaLCT)');
      if (w) { e.white[0] = w[0]; e.white[1] = w[1]; ['w0', 'w1'].forEach(function (id, i) { var n = document.querySelector('#gmBody [data-gm="' + id + '"]'); if (n) n.value = w[i].toFixed(4); }); }
    } else if (isFinite(v)) {
      var lim = function (x) { return Math.max(.001, Math.min(.9, x)); };   // NovaLCT's limits for x and y
      if (k[0] === 'o') e.orig[+k[1]][+k[2]] = k[2] === '2' ? Math.max(.1, v) : lim(v);
      else if (k[0] === 'p') e.prims[+k[1]][+k[2]] = lim(v);
      else if (k === 'w2') { e.white[2] = Math.max(0, v); e.auto = false; } else e.white[+k[1]] = lim(v);
    }
    if (e.auto) { e.white[2] = gmFit(e.orig, e.type === 'custom' ? e.prims : GM_PRIMS[e.type], e.white); var l = document.querySelector('#gmBody [data-gm="w2"]'); if (l && k !== 'w2') l.value = e.white[2].toFixed(1); }
    gmResult();
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { GM_DEF: GM_DEF, GM_PRIMS: GM_PRIMS, gmSolve: gmSolve, gmWhite: gmWhite, gmFit: gmFit, gmMatrix: gmMatrix, gmBytes: gmBytes, gmCheck: gmCheck, gmRecord: gmRecord, gmParse: gmParse, gmCct: gmCct, gmBuild: gmBuild, gmCompare: gmCompare };
