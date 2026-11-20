// app-lutfit.js - a LUT on a NovaLCT processor (user, 2026-10-30 / 2026-11-06: "we would only control the gamut from the
// brightness in Gamma screens and the gamma using custom"; "take the lut and modify the gamut to get the "same" result within
// reason"). The cards have no 3-D LUT: what they can do is one table per colour (Custom gamma, 256 entries) and one 3×3 colour
// matrix with coefficients from 0 to 1 (the gamut). lutFit finds the closest tables + matrix to a .cube / .3dl and says how close
// it got; Screen Settings ▸ Load LUT… shows that and Sends it. Nothing touches calibration coefficients or receiving-card files,
// and nothing is saved: Remove (or a power cycle, before Save) takes it off.
// Model, in light: out = M · (tR(r), tG(g), tB(b)), each table holding the screen's gamma, what a LUT output means on that screen
// (its gamma as output^gamma). Whether a card applies the matrix after the table is assumed here (the matrix is made from
// light values, so it must) and has to be confirmed on a wall. Curves alone are preferred when the matrix adds little.
// The fit uses no DOM, so tests/lutfit_test.js runs it in node.
// Owns: lf, LF_PTS, LF_ORIG, lfRow, lfInput, lfCurves, lfTable, lfTables, lfScore, lutFit, lfVerdict, lfRecord, lfHex, lfTableHex,
// lfCube, lfOpen, lfLoad, lfShow, lfSend, lfRemove, lfFieldHtml, bindLutFit.
// Depends on: app-lut3d (lutCloud, lutPick, lutParse, lutDraw), app-gamut (gmRecord), and in the app: app-core ($, esc, toast, commit, renderAll), app-log
// (log), app-hardware (hwBegin, hwEnd), app-save (hwMarkUnsaved), app-screen (scrLc, scrColor, scrDevices, scrLocked), drv-core (DRV).
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var lf = { name: '', L: null, fit: null, lc: null };
var LF_PTS = 17;   // lattice points per axis used for the fit
// NovaLCT's default LED primaries, x y Y (its DefaultColorRestore.bin): the record's "original" side
var LF_ORIG = [[.675, .33, 900], [.19, .78, 1800], [.13, .04, 300]];

// One matrix row: minimise mᵀGm − 2bᵀm with every coefficient within 0..1 (each set of coefficients held at 0, tried in turn).
function lfRow(G, b) {
  var best = null, bestV = Infinity;
  for (var mask = 1; mask < 8; mask++) {
    var ix = [0, 1, 2].filter(function (i) { return mask >> i & 1; }), n = ix.length, A = [], i, j, k;
    for (i = 0; i < n; i++) { A.push([]); for (j = 0; j < n; j++) A[i].push(G[ix[i]][ix[j]] + (i === j ? 1e-9 : 0)); A[i].push(b[ix[i]]); }
    for (i = 0; i < n; i++) {   // Gauss-Jordan with the largest pivot
      var p = i; for (k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[p][i])) p = k;
      var t = A[i]; A[i] = A[p]; A[p] = t;
      if (Math.abs(A[i][i]) < 1e-12) continue;
      for (k = 0; k < n; k++) if (k !== i) { var q = A[k][i] / A[i][i]; for (j = i; j <= n; j++) A[k][j] -= q * A[i][j]; }
    }
    var m = [0, 0, 0];
    for (i = 0; i < n; i++) m[ix[i]] = Math.max(0, Math.min(1, A[i][i] ? A[i][n] / A[i][i] : 0));
    var v = 0;
    for (i = 0; i < 3; i++) { v -= 2 * b[i] * m[i]; for (j = 0; j < 3; j++) v += m[i] * G[i][j] * m[j]; }
    if (v < bestV) { bestV = v; best = m; }
  }
  return best;
}
// The fit's input: K points per axis, T = what each lattice point should give in light, code = the LUT's output.
function lfInput(L, gamma) {
  var C = lutCloud(L), N = C.N, idx = lutPick(N, LF_PTS), K = idx.length, n = K * K * K, g = idx.map(function (i) { return C.grid[i]; });
  var T = new Float64Array(n * 3), code = new Float64Array(n * 3), p = 0;
  for (var b = 0; b < K; b++) for (var gi = 0; gi < K; gi++) for (var r = 0; r < K; r++, p++) {
    var at = (idx[b] * N * N + idx[gi] * N + idx[r]) * 3;
    for (var c = 0; c < 3; c++) { var v = Math.max(0, Math.min(1, C.out[at + c])); code[p * 3 + c] = v; T[p * 3 + c] = Math.pow(v, gamma); }
  }
  return { K: K, n: n, g: g, T: T, code: code, gamma: gamma };
}
// Curves f[c][k] from matrix M, channel after channel (the other two held), kept rising.
function lfCurves(I, M, f) {
  var K = I.K;
  for (var c = 0; c < 3; c++) {
    var num = new Float64Array(K), den = new Float64Array(K), step = c === 0 ? 1 : c === 1 ? K : K * K;
    for (var p = 0; p < I.n; p++) {
      var k = [p % K, Math.floor(p / K) % K, Math.floor(p / (K * K))], F = [f[0][k[0]], f[1][k[1]], f[2][k[2]]];
      for (var i = 0; i < 3; i++) {
        var rest = 0; for (var j = 0; j < 3; j++) if (j !== c) rest += M[i][j] * F[j];
        num[k[c]] += M[i][c] * (I.T[p * 3 + i] - rest); den[k[c]] += M[i][c] * M[i][c];
      }
    }
    for (var q = 0; q < K; q++) { if (den[q] > 1e-9) f[c][q] = Math.max(0, Math.min(1, num[q] / den[q])); if (q) f[c][q] = Math.max(f[c][q], f[c][q - 1]); }
  }
}
// 256 entries per colour, 0–65535, between the knots along the gamma curve (so a plain gamma stays exact).
function lfTable(fc, g, gamma) {
  var out = [], k = 0;
  for (var i = 0; i < 256; i++) {
    var t = i / 255; while (k < g.length - 2 && t > g[k + 1]) k++;
    var a = Math.pow(fc[k], 1 / gamma), b = Math.pow(fc[k + 1], 1 / gamma), w = g[k + 1] > g[k] ? (t - g[k]) / (g[k + 1] - g[k]) : 0;
    var v = Math.round(65535 * Math.pow(Math.max(0, Math.min(1, a + (b - a) * w)), gamma));
    out.push(i && v < out[i - 1] ? out[i - 1] : v);
  }
  return out;
}
function lfTables(f, I) { return [0, 1, 2].map(function (c) { return lfTable(f[c], I.g, I.gamma); }); }
// What the card would really do with these tables and matrix bytes, against the LUT, in % of full scale.
function lfScore(I, tables, mb) {
  var K = I.K, sum = 0, max = 0, approx = new Float64Array(I.n * 3), at = I.g.map(function (t) { return t * 255; });
  var val = function (c, k) { var x = at[k], i = Math.min(254, Math.floor(x)), w = x - i; return (tables[c][i] * (1 - w) + tables[c][i + 1] * w) / 65535; };
  for (var p = 0; p < I.n; p++) {
    var F = [val(0, p % K), val(1, Math.floor(p / K) % K), val(2, Math.floor(p / (K * K)))];
    for (var i = 0; i < 3; i++) {
      var o = mb ? (mb[i * 3] * F[0] + mb[i * 3 + 1] * F[1] + mb[i * 3 + 2] * F[2]) / 255 : F[i];
      var v = Math.pow(Math.max(0, Math.min(1, o)), 1 / I.gamma), e = Math.abs(v - I.code[p * 3 + i]);
      approx[p * 3 + i] = v; sum += e; if (e > max) max = e;
    }
  }
  return { mean: sum / (I.n * 3) * 100, max: max * 100, approx: approx };
}
// A parsed LUT and the screen's gamma → { tables [R, G, B], matrix (9 bytes, null = curves are enough), mean, max (% of full scale),
// verdict, approx, K, gamma }.
function lutFit(L, gamma) {
  var I = lfInput(L, gamma), id = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], K = I.K;
  var start = function () { return [0, 1, 2].map(function () { return I.g.map(function (t) { return Math.pow(t, gamma); }); }); };
  var fc = start(); for (var a = 0; a < 2; a++) lfCurves(I, id, fc);
  var tc = lfTables(fc, I), sc = lfScore(I, tc, null);
  var f = start(), M = id.map(function (r) { return r.slice(); });
  for (var it = 0; it < 20; it++) {
    var G = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var p = 0; p < I.n; p++) {
      var F = [f[0][p % K], f[1][Math.floor(p / K) % K], f[2][Math.floor(p / (K * K))]];
      for (var i = 0; i < 3; i++) { for (var j = 0; j < 3; j++) G[i][j] += F[i] * F[j]; for (var r = 0; r < 3; r++) B[r][i] += F[i] * I.T[p * 3 + r]; }
    }
    M = [lfRow(G, B[0]), lfRow(G, B[1]), lfRow(G, B[2])];
    lfCurves(I, M, f);
  }
  for (var c = 0; c < 3; c++) {   // a table ends at full: its top goes into the matrix
    var s = f[c][K - 1]; if (s <= 0) continue;
    for (var q = 0; q < K; q++) f[c][q] /= s;
    for (var row = 0; row < 3; row++) M[row][c] = Math.min(1, M[row][c] * s);
  }
  var mb = []; M.forEach(function (rw) { rw.forEach(function (v) { mb.push(Math.round(v * 255)); }); });
  var tm = lfTables(f, I), sm = lfScore(I, tm, mb);
  // the matrix earns its place: it depends on more of the card than the tables do
  var useM = sm.mean < sc.mean * .8 && sc.mean - sm.mean > .15, s2 = useM ? sm : sc;
  return { tables: useM ? tm : tc, matrix: useM ? mb : null, mean: s2.mean, max: s2.max, verdict: lfVerdict(s2.mean), approx: s2.approx, K: K, gamma: gamma };
}
function lfVerdict(mean) { return mean <= 1 ? 'Very close' : mean <= 2.5 ? 'Close' : mean <= 5 ? 'Rough' : 'Poor: this LUT does things the cards can’t'; }
// The 0x12009000 record NovaLCT reads back (magic, type FF = custom, original and target xy / Y, the matrix): the target is what
// the matrix makes of the original primaries, so its Color Gamut window shows a matching custom gamut.
function lfRecord(mb) {
  var o = LF_ORIG.slice(0, 3), xyz = o.map(function (p) { return [p[2] * p[0] / p[1], p[2], p[2] * (1 - p[0] - p[1]) / p[1]]; });
  var T = [0, 1, 2].map(function (i) { return [0, 1, 2].map(function (k) { return mb[i] / 255 * xyz[0][k] + mb[3 + i] / 255 * xyz[1][k] + mb[6 + i] / 255 * xyz[2][k]; }); });
  return gmRecord(o, T.map(function (t) { var n = t[0] + t[1] + t[2] || 1; return [t[0] / n, t[1] / n, t[1]]; }), mb, 'custom');
}
function lfHex(bytes) { var h = ''; for (var i = 0; i < bytes.length; i++) h += ('0' + bytes[i].toString(16).toUpperCase()).slice(-2); return h; }
// The three tables as the 1536 bytes the cards take: R, G, B, u16 little-endian.
function lfTableHex(tables) {
  var b = []; tables.forEach(function (t) { t.forEach(function (v) { b.push(v & 255, v >> 8); }); });
  return lfHex(b);
}
// What the fit really gives, as .cube text (for the same picture as the LUT).
function lfCube(fit) {
  var t = ['LUT_3D_SIZE ' + fit.K];
  for (var p = 0; p < fit.K * fit.K * fit.K; p++) t.push(fit.approx[p * 3].toFixed(5) + ' ' + fit.approx[p * 3 + 1].toFixed(5) + ' ' + fit.approx[p * 3 + 2].toFixed(5));
  return t.join('\n') + '\n';
}

// ------------------------------------------------------------------ Screen Settings ▸ Load LUT… (the app)
// Under the gamut control, for processors that take it (caps.color.lut).
function lfFieldHtml(lc, devs) {
  if (!devs.some(function (e) { return (DRV.caps(e.d).color || {}).lut; })) return '';
  var u = lc.lut;
  return '<div class="sc-lut"><button type="button" data-lf="gamut" title="NovaLCT’s Configure Color Space: your LEDs’ colours, the target, its white">Custom gamut…</button><button type="button" data-lf="open" title="Fit a .cube or .3dl LUT to what the cards can do: Custom gamma per colour, plus the gamut matrix when it helps. You see how close it gets before anything is sent.">Load LUT…</button>' +
    (u ? '<span class="hint" title="' + esc('Average difference ' + u.mean.toFixed(1) + ' %, worst ' + u.max.toFixed(1) + ' %' + (u.matrix ? ', with the gamut matrix' : ', curves only')) + '">' + esc(u.name) + '</span><button type="button" data-lf="remove" title="Back to gamut off and the plain gamma">Remove</button>' : '') + '</div>';
}
function lfOpen() { var i = $('lfFile'); i.value = ''; i.click(); }
function lfLoad(file) {
  var lc = scrLc(); if (!file || !lc) return;
  if ((P.bitDepth || 8) !== 8) return toast('A LUT needs an 8-bit source for now (custom gamma is confirmed for 8-bit only)');
  var rd = new FileReader();
  rd.onerror = function () { toast('Couldn’t read ' + file.name); };
  rd.onload = function () {
    var r = lutParse(rd.result, file.name);
    if (!r.ok) { log('lut_fit', { file: file.name, error: r.error }); return toast(file.name + ' can’t be read: ' + r.error); }
    var gamma = +scrColor(lc).gamma || 2.8, t0 = Date.now();
    lf = { name: file.name, L: r.lut, fit: lutFit(r.lut, gamma), lc: lc };
    log('lut_fit', { file: file.name, screen: lc.name, gamma: gamma, mean: +lf.fit.mean.toFixed(2), max: +lf.fit.max.toFixed(2), matrix: lf.fit.matrix, ms: Date.now() - t0 });
    lfShow();
  };
  rd.readAsText(file);
}
function lfShow() {
  var x = lf.fit, m = x.matrix, pct = function (v) { return Math.round(v / 2.55); }, locked = scrLocked();
  $('lfTitle').textContent = 'Load LUT: ' + lf.name;
  $('lfBody').innerHTML = '<p><b>' + esc(x.verdict) + '</b> — average difference ' + x.mean.toFixed(1) + ' %, worst ' + x.max.toFixed(1) + ' %, at gamma ' + x.gamma + '.</p>' +
    '<div class="lf-pics"><figure><canvas id="lfA" width="220" height="180"></canvas><figcaption>The LUT</figcaption></figure><figure><canvas id="lfB" width="220" height="180"></canvas><figcaption>What the cards will do</figcaption></figure></div>' +
    (m ? '<p class="hint">Custom gamma per colour, plus this gamut matrix:</p><table class="cmp lf-m">' + [0, 3, 6].map(function (i) { return '<tr><td>' + pct(m[i]) + ' %</td><td>' + pct(m[i + 1]) + ' %</td><td>' + pct(m[i + 2]) + ' %</td></tr>'; }).join('') + '</table>'
      : '<p class="hint">Custom gamma per colour is enough: the gamut stays off.</p>') +
    '<p class="hint">Live, not saved until Save. Once sent, Remove (beside Load LUT…) takes it off.' + (locked ? ' Unlock sending to send it (Settings ▸ Alpha ▸ Allow sending).' : '') + '</p>';
  $('lfGo').disabled = locked;
  $('lfDlg').hidden = false;
  lutDraw($('lfA'), lf.L, 220, 180); lutDraw($('lfB'), lutParse(lfCube(x), 'fit.cube').lut, 220, 180);
}
function lfSend() {
  var lc = lf.lc, x = lf.fit, name = lf.name, devs = scrDevices(lc).filter(function (e) { return e.d.hw && DRV.of(e.d).lutApply; });
  if (!devs.length) return toast('Link this screen’s processor first (Processors ▸ Hardware)');
  if (!hwBegin('service')) return;
  $('lfGo').disabled = true;
  return Promise.all(devs.map(function (e) {
    return DRV.of(e.d).lutApply(e.d, e.ports, x).then(function (r) { return r; }, function (err) { return { ok: false, error: err.message }; }).then(function (r) {
      log('lut_send', { file: name, screen: lc.name, device: deviceLabel(e.d), matrix: !!x.matrix, ok: r.ok, error: r.error });
      if (r.ok) hwMarkUnsaved(e.d, 'LUT'); r.d = e.d; return r;
    });
  })).then(function (rs) {
    hwEnd('service'); $('lfDlg').hidden = true;
    var bad = rs.filter(function (r) { return !r.ok; });
    if (!bad.length) { lc.lut = { name: name, mean: x.mean, max: x.max, matrix: !!x.matrix, gamma: x.gamma }; commit(); }
    renderAll();
    toast(bad.length ? 'LUT failed on ' + bad.map(function (r) { return deviceLabel(r.d) + ': ' + r.error; }).join(', ') : name + ' sent — not saved');
  });
}
// Back to plain: gamut off, the gamma it replaced.
function lfRemove() {
  var lc = scrLc(); if (!lc || !lc.lut) return;
  var was = lc.lut.gamma, devs = scrDevices(lc).filter(function (e) { return e.d.hw; });
  if (!hwBegin('service')) return;
  return Promise.all(devs.map(function (e) {
    var x = DRV.of(e.d);
    return x.screenSet(e.d, 'gamut', 'original', e.ports).then(function () { return x.screenSet(e.d, 'gamma', was, e.ports); }).then(function (r) { hwMarkUnsaved(e.d, 'LUT removed'); return r; }, function (err) { return { ok: false, error: err.message }; });
  })).then(function (rs) {
    hwEnd('service');
    var bad = rs.filter(function (r) { return !r || !r.ok; });
    log('lut_remove', { screen: lc.name, file: lc.lut.name, failed: bad.length });
    if (!bad.length) { delete lc.lut; commit(); }
    renderAll();
    toast(bad.length ? 'Remove failed: ' + (bad[0] && bad[0].error) : 'LUT removed — gamut off, gamma ' + was);
  });
}
function bindLutFit() {
  var d = document.createElement('div'); d.id = 'lfDlg'; d.className = 'logdlg rcv-dlg'; d.hidden = true;
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Load LUT');
  d.innerHTML = '<div class="logbox keysbox svc-box"><div class="loghead"><b id="lfTitle">Load LUT</b><span class="grow"></span><button id="lfClose" title="Close (Esc)">×</button></div>' +
    '<div id="lfBody" class="keysbody"></div><div class="rcv-foot"><button id="lfCancel" class="primary-outline">Cancel</button><button id="lfGo" class="primary" title="Send it to this screen’s processor. Not saved.">Send</button></div></div>';
  document.body.appendChild(d);
  var i = document.createElement('input'); i.type = 'file'; i.id = 'lfFile'; i.accept = '.cube,.3dl'; i.hidden = true; document.body.appendChild(i);
  i.onchange = function () { lfLoad(this.files[0]); };
  $('lfClose').onclick = $('lfCancel').onclick = function () { d.hidden = true; };
  $('lfGo').onclick = function () { lfSend(); };
  $('scForm').addEventListener('click', function (e) {
    var b = e.target.closest('[data-lf]'); if (!b) return;
    if (b.dataset.lf === 'gamut') return gmOpen();
    if (b.dataset.lf === 'open') lfOpen(); else lfRemove();
  });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { lutFit: lutFit, lfRecord: lfRecord, lfTableHex: lfTableHex, lfCube: lfCube, lfHex: lfHex };
