// app-heat.js - the thermal heat map (docs/PRO_LOOK_PLAN.md §5.6): Layout ▸ View ▸ Live ▸ Temperature / Voltage draw one
// continuous, interpolated image per screen from the cabinets' own monitoring readings (hlt.by, app-health.js), with a
// legend, MAX / MIN marks and a hover readout; Bit errors and Status stay flat per cabinet (hltCellFill). The Monitor tab's
// cabinet map reuses the same image. Read-only: it uses only what monitoring already reads, never sends anything.
// How: each cabinet's reading is splatted over its rectangle into a value raster (longest side ≤ 1024 px) with a weight
// mask (1 = a real reading, 0 = none), then normalised convolution with a tent one cabinet pitch wide (two box passes per
// axis): field = blur(value·w) / blur(w). A missing / dark / unlinked cabinet has weight 0, so it never pulls its
// neighbours down and is never painted with an invented value (it gets grey / red hatching instead). Colour comes after
// interpolation, through a 256-entry palette table. The raster goes to an offscreen <canvas> -> blob -> object URL, shown
// as one SVG <image> in canvas units, so pan / zoom cost nothing; it is rebuilt only when its key changes (view, palette,
// scale, the readings' times, the layout), i.e. at most once per poll.
// Owns: HEAT_PAL, heat, heatLut, heatGrad, heatOn, heatItems, heatScale, heatBlur, heatField, heatKey, heatImage, heatImgTag,
// renderHeat, heatExtreme, heatOverlay, heatLegend, heatLegendBar, heatAge, heatAt, heatHover, heatMax, heatJump, heatSet, bindHeat.
// Depends on: app-core (P, ui, $, esc, log), app-render (el, renderCanvas, allCells), app-geometry (visibleScreens),
// app-health (hlt, hltCabinet, hltCellAt), app-watch (watch, tempFmt, tempUnit, watchBerFill), app-processors (deviceOfCard,
// deviceLabel, lctById), app-capacity (portLabel), app-hardware (hwErrText), app-forms (uiZoom), app-sections (showScreen),
// all at run time.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// palettes, built from a few stops each (no files): iron (FLIR-like) and inferno for temperature, a diverging one for the
// supply voltage (low = the danger, so the low end is the strong colour; neutral at the nominal 5.0 V)
var HEAT_PAL = {
  iron: [[0, '#000000'], [0.1, '#12062e'], [0.24, '#3d0a6b'], [0.38, '#7c1384'], [0.5, '#b8226c'], [0.62, '#e04a2c'], [0.74, '#f6860f'], [0.86, '#fcc531'], [0.95, '#fff08a'], [1, '#ffffff']],
  inferno: [[0, '#000004'], [0.11, '#1b0c41'], [0.22, '#4a0c6b'], [0.33, '#781c6d'], [0.44, '#a52c60'], [0.55, '#cf4446'], [0.66, '#ed6925'], [0.77, '#fb9b06'], [0.88, '#f7d13d'], [1, '#fcffa4']],
  volt: [[0, '#1d4fff'], [0.27, '#3f8cff'], [0.52, '#2a3646'], [0.667, '#30353d'], [0.76, '#4a2c26'], [0.88, '#e2603a'], [1, '#ff3b3b']]
};
// pal / scale: the user's picks (this browser); img[scope] = the image last built for a screen ({key, url, field…});
// builds = how many fields were computed (tests); logged = the view whose timing was logged; snap / snapRev = layout changes
var heat = { pal: 'iron', scale: 'auto', img: {}, luts: {}, builds: 0, logged: '', snap: null, snapRev: 0, max: null, cur: null };
try { if (localStorage.getItem('opennova.heatpal') === 'inferno') heat.pal = 'inferno'; if (localStorage.getItem('opennova.heatscale') === 'fixed') heat.scale = 'fixed'; } catch (e) { /* storage unavailable */ }

function heatOn(v) { v = v || hlt.view; return v === 'temp' || v === 'volt'; }
function heatLut(name) {
  if (heat.luts[name]) return heat.luts[name];
  var st = HEAT_PAL[name], o = new Uint8ClampedArray(768), hx = function (c, k) { return parseInt(c.substr(1 + 2 * k, 2), 16); };
  for (var i = 0; i < 256; i++) {
    var t = i / 255, k = 0; while (k < st.length - 2 && t > st[k + 1][0]) k++;
    var a = st[k], b = st[k + 1], f = Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0])));
    for (var j = 0; j < 3; j++) o[i * 3 + j] = hx(a[1], j) + (hx(b[1], j) - hx(a[1], j)) * f;
  }
  return (heat.luts[name] = o);
}
function heatGrad(name, dir) { return 'linear-gradient(' + (dir || 'to right') + ',' + HEAT_PAL[name].map(function (s) { return s[1] + ' ' + (s[0] * 100) + '%'; }).join(',') + ')'; }

// The cabinets of a screen with what the field may use: v = the reading (°C or V), w = 1 when it may be used, st = why not
// ('nolink' processor not linked / not answering / no reading yet, 'missing' no reading for this cabinet, 'dark' not
// answering on either side), x = the health record (app-health.js).
function heatItems(cells, mode) {
  return cells.filter(function (c) { return !c.hole && !c.unassigned && c.sender != null; }).map(function (c) {
    var d = deviceOfCard(c.sender), w = d && hlt.watch[d.id], x = d && d.hw && !(w && w.err) ? hltCabinet(c) : null;
    var it = { c: c, x: x, d: d, w: 0, v: null, st: 'ok' };
    if (!x) it.st = 'nolink';
    else if (x.missing) it.st = 'missing';
    else if (x.dark) it.st = 'dark';
    else {
      var v = mode === 'volt' ? x.voltage : x.temp;
      if (v == null || isNaN(v)) it.st = 'missing'; else { it.v = v; it.w = 1; }
    }
    return it;
  });
}
// The colour scale: temperature Auto (the readings' min / max rounded out to 5 °C, at least 10 °C wide, so a uniform wall
// isn't drawn as wild contrast) or Fixed (20 °C … the error limit + 10); voltage fixed 4.0–5.5 V around the nominal 5.0 V.
function heatScale(mode, items) {
  if (mode === 'volt') return { lo: 4.0, hi: 5.5 };
  if (heat.scale === 'fixed') return { lo: 20, hi: (watch.set.tempErr || 80) + 10 };
  var vs = items.filter(function (i) { return i.w; }).map(function (i) { return i.v; });
  if (!vs.length) return { lo: 20, hi: 60 };
  var lo = Math.floor(Math.min.apply(null, vs) / 5) * 5, hi = Math.ceil(Math.max.apply(null, vs) / 5) * 5;
  if (hi - lo < 10) { var m = (lo + hi) / 2; lo = Math.floor((m - 5) / 5) * 5; hi = lo + 10; if (hi < Math.max.apply(null, vs)) hi += 5; }
  return { lo: lo, hi: hi };
}
// The tent blur, in place: two box passes along the rows (a row buffer), then two down the columns, row by row with one
// running sum per column (no transposing: cache-friendly). Running sums, O(pixels); the box's 1 / width is left out, as
// the field divides two blurs of the same size (value·w and w). Edges count as zero, which that division cancels.
function heatBlur(a, W, H, r) {
  var t = new Float32Array(Math.max(W, H)), T = new Float32Array(a.length), acc = new Float64Array(W), x, y, i, b, pass, s;
  for (y = 0; y < H; y++) {
    b = y * W;
    for (pass = 0; pass < 2; pass++) {
      for (i = 0; i < W; i++) t[i] = a[b + i];
      s = 0; for (i = 0; i <= r && i < W; i++) s += t[i];
      for (i = 0; i < W; i++) { a[b + i] = s; if (i + r + 1 < W) s += t[i + r + 1]; if (i - r >= 0) s -= t[i - r]; }
    }
  }
  var col = function (src, dst) {
    acc.fill(0);
    for (y = 0; y <= r && y < H; y++) for (x = 0; x < W; x++) acc[x] += src[y * W + x];
    for (y = 0; y < H; y++) {
      var o = y * W, ad = (y + r + 1) * W, sb = (y - r) * W, addOk = y + r + 1 < H, subOk = y - r >= 0;
      for (x = 0; x < W; x++) { dst[o + x] = acc[x]; if (addOk) acc[x] += src[ad + x]; if (subOk) acc[x] -= src[sb + x]; }
    }
  };
  col(a, T); col(T, a);
  return a;
}
// The interpolated field over the items' bounds: {F (NaN = nothing to show), M (item index + 1 per pixel, 0 = no cabinet),
// W, H, s (raster px per canvas unit), x0, y0, ms}.
function heatField(items) {
  var t0 = performance.now(), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  items.forEach(function (i) { var c = i.c; x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); });
  // raster scale: the longest side ≤ 1024 px and ≤ 250 000 pixels in all (the blur's cost goes with the pixels: ≈ 15 ms),
  // ≥ 256 px for small walls, and no more than 16 px per cabinet pitch (the browser scales the image up smoothly)
  var cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0), L = Math.max(cw, ch), pit = items.map(function (i) { return Math.min(i.c.w, i.c.h); }).sort(function (a, b) { return a - b; });
  var s = Math.min(1024 / L, Math.sqrt(250000 / (cw * ch)), Math.max(256 / L, 16 / (pit[pit.length >> 1] || 16)));
  var W = Math.max(1, Math.round(cw * s)), H = Math.max(1, Math.round(ch * s)), N = W * H;
  var A = new Float32Array(N), B = new Float32Array(N), M = new Int32Array(N), WT = new Uint8Array(items.length + 1);
  items.forEach(function (it, k) {
    var c = it.c, ax = Math.max(0, Math.round((c.x - x0) * s)), ay = Math.max(0, Math.round((c.y - y0) * s)), bx = Math.min(W, Math.max(ax + 1, Math.round((c.x + c.w - x0) * s))), by = Math.min(H, Math.max(ay + 1, Math.round((c.y + c.h - y0) * s)));
    var v = it.v, w = it.w ? 1 : 0, y, p, e; WT[k + 1] = w;
    for (y = ay; y < by; y++) for (p = y * W + ax, e = y * W + bx; p < e; p++) { M[p] = k + 1; A[p] = w * v; B[p] = w; }
  });
  var r = Math.max(1, Math.round((pit[pit.length >> 1] || 4) * s / 4));   // box ≈ half a pitch; two passes = a tent one pitch wide
  heatBlur(A, W, H, r); heatBlur(B, W, H, r);
  var F = new Float32Array(N);
  for (var i = 0; i < N; i++) F[i] = WT[M[i]] && B[i] > 1e-3 ? A[i] / B[i] : NaN;   // clipped to cabinets with a reading
  return { F: F, M: M, W: W, H: H, s: s, x0: x0, y0: y0, cw: cw, ch: ch, ms: performance.now() - t0 };
}
// What the image depends on: the view, the palette and scale, the readings (their times, the held list, links) and the layout.
function heatKey(scope, mode) {
  if (heat.snap !== ui.lastSnap) { heat.snap = ui.lastSnap; heat.snapRev++; }
  return [scope, mode, heat.pal, heat.scale, watch.set.tempErr, hlt.rev, heat.snapRev, P.devices.map(function (d) {
    var x = hlt.by[d.id], w = hlt.watch[d.id]; return (d.hw ? 1 : 0) + ':' + (x ? x.at : 0) + ':' + (w && w.err ? 1 : 0);
  }).join(',')].join('|');
}
// The image for one screen's cells (scope 'canvas:<screen>' or 'map:<screen>'): built when the key changed, else the last
// one. The URL arrives a moment later (toBlob is asynchronous): every <image data-heat="key"> gets it then.
function heatImage(scope, cells, mode) {
  var key = heatKey(scope, mode), old = heat.img[scope];
  if (old && old.key === key) return old;
  var items = heatItems(cells, mode), sc = heatScale(mode, items);
  if (!items.length) return null;
  var f = heatField(items), lut = heatLut(mode === 'volt' ? 'volt' : heat.pal), cv = document.createElement('canvas');
  heat.builds++;
  if (heat.logged !== mode + heat.pal) { heat.logged = mode + heat.pal; log('heat_field', { view: mode, palette: heat.pal, cabinets: items.length, raster: f.W + '×' + f.H, ms: Math.round(f.ms * 10) / 10 }); }
  cv.width = f.W; cv.height = f.H;
  var g = cv.getContext('2d'), img = g.createImageData(f.W, f.H), px = img.data, span = sc.hi - sc.lo || 1;
  for (var i = 0; i < f.F.length; i++) {
    var v = f.F[i]; if (v !== v) continue;
    var k = Math.max(0, Math.min(255, Math.round((v - sc.lo) / span * 255))) * 3;
    px[i * 4] = lut[k]; px[i * 4 + 1] = lut[k + 1]; px[i * 4 + 2] = lut[k + 2]; px[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  var e = { key: key, scope: scope, mode: mode, url: null, field: f, items: items, lo: sc.lo, hi: sc.hi, at: Date.now() };
  if (old && old.url) URL.revokeObjectURL(old.url);
  heat.img[scope] = e;
  var done = function (u) {
    if (heat.img[scope] !== e) { if (u && u.indexOf('blob:') === 0) URL.revokeObjectURL(u); return; }
    e.url = u;
    Array.prototype.forEach.call(document.querySelectorAll('image[data-heat]'), function (im) { if (im.getAttribute('data-heat') === key) im.setAttribute('href', u); });
  };
  if (cv.toBlob) cv.toBlob(function (b) { done(b ? URL.createObjectURL(b) : cv.toDataURL()); }); else done(cv.toDataURL());
  return e;
}
function heatImgTag(e) {   // the <image> as markup (the Monitor map builds its SVG as a string)
  var f = e.field;
  return '<image data-heat="' + esc(e.key) + '" href="' + (e.url || '') + '" x="' + f.x0 + '" y="' + f.y0 + '" width="' + f.cw + '" height="' + f.ch + '" preserveAspectRatio="none" pointer-events="none"/>';
}

// ------------------------------------------------------------------ the Layout canvas
// In renderCanvas, after the canvas background and grid, before the cabinets (their fill is see-through in these views):
// the image, then the cabinets without a reading — grey (not linked / not answering), grey hatching (no reading), red
// outline and cross-hatch (dark). Also keeps the legend in step (every view: it hides itself when not needed).
function renderHeat(svg, cellsBy, unit) {
  heat.cur = null;
  var mode = hlt.view;
  if (heatOn(mode)) {
    var cells = []; visibleScreens().forEach(function (s) { cells = cells.concat(cellsBy[s.id] || []); });
    var e = heatImage('canvas:' + ui.viewScreen, cells, mode);
    if (e) {
      heat.cur = e;
      var defs = el('defs', {}, svg), f = e.field;
      var pm = el('pattern', { id: 'heatMiss', width: 8 * unit, height: 8 * unit, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
      el('rect', { x: 0, y: 0, width: 1.5 * unit, height: 8 * unit, fill: 'rgba(200,205,212,.55)' }, pm);
      var pd = el('pattern', { id: 'heatDark', width: 7 * unit, height: 7 * unit, patternUnits: 'userSpaceOnUse' }, defs);
      el('path', { d: 'M0,0L' + 7 * unit + ',' + 7 * unit + 'M' + 7 * unit + ',0L0,' + 7 * unit, stroke: 'rgba(240,72,77,.6)', 'stroke-width': 1.1 * unit }, pd);
      var im = el('image', { 'data-heat': e.key, x: f.x0, y: f.y0, width: f.cw, height: f.ch, preserveAspectRatio: 'none', 'pointer-events': 'none' }, svg);
      if (e.url) im.setAttribute('href', e.url);
      var g = el('g', { class: 'heat-gaps', 'pointer-events': 'none' }, svg);
      e.items.forEach(function (it) {
        if (it.w) return;
        var c = it.c, r = { x: c.x, y: c.y, width: c.w, height: c.h };
        if (it.st === 'nolink') el('rect', Object.assign({ fill: 'rgba(128,128,128,.4)' }, r), g);
        else if (it.st === 'missing') { el('rect', Object.assign({ fill: 'rgba(90,96,106,.55)' }, r), g); el('rect', Object.assign({ fill: 'url(#heatMiss)' }, r), g); }
        else {
          el('rect', Object.assign({ fill: 'rgba(0,0,0,.72)' }, r), g); el('rect', Object.assign({ fill: 'url(#heatDark)' }, r), g);
          el('rect', { x: c.x + unit, y: c.y + unit, width: Math.max(0, c.w - 2 * unit), height: Math.max(0, c.h - 2 * unit), fill: 'none', stroke: '#f0484d', 'stroke-width': 2 * unit }, g);
        }
      });
    }
  }
  heatLegend(cellsBy);
}
function heatExtreme(e, dir) {
  var best = null;
  e.items.forEach(function (it) { if (it.w && (!best || (dir > 0 ? it.v > best.v : it.v < best.v))) best = it; });
  return best;
}
// On top of everything (renderHealthOverlay calls it): the reading in each cabinet big enough (> 22 px), white with a
// black drop shadow so it reads on the bright end of the palette, and the MAX / MIN marks (voltage: MIN only, low is the danger).
function heatOverlay(svg, cellsBy, unit) {
  var e = heat.cur, ber = hlt.view === 'ber'; if (!(e && heatOn()) && !ber) return;
  var defs = el('defs', {}, svg), fl = el('filter', { id: 'heatTxt', x: '-30%', y: '-40%', width: '160%', height: '180%' }, defs);
  el('feDropShadow', { dx: 0, dy: unit, stdDeviation: unit, 'flood-color': '#000', 'flood-opacity': 1, result: 'a' }, fl);
  el('feDropShadow', { in: 'a', dx: 0, dy: 0, stdDeviation: 1.5 * unit, 'flood-color': '#000', 'flood-opacity': 1 }, fl);
  var g = el('g', { class: 'heat-num', 'pointer-events': 'none', filter: 'url(#heatTxt)' }, svg), volt = hlt.view === 'volt', ppu = ui.pxPerUnit || 1;
  // the number sits above the cable (which runs through the middle of each cabinet)
  var pro = typeof proLook === 'function' && proLook();   // pro look: small mono figures at the lower right, as the gallery (the plate keeps the top left)
  var num = function (c, txt, px) {
    if (pro) { var pd = Math.min(6, px * 0.08) * unit; el('text', { class: 'heat-v', x: c.x + c.w - pd, y: c.y + c.h - pd, 'text-anchor': 'end', 'font-size': Math.min(10.5, px * 0.2) * unit, fill: '#fff' }, g).textContent = txt; return; }
    el('text', { x: c.x + c.w / 2, y: c.y + c.h * 0.3, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': Math.min(13, px * 0.26) * unit, 'font-weight': 600, fill: '#fff' }, g).textContent = txt; };
  if (ber) {   // Bit errors: the count in each cabinet that has some
    visibleScreens().forEach(function (s) { (cellsBy[s.id] || []).forEach(function (c) {
      var x = !c.hole && c.sender != null ? hltCabinet(c) : null, px = Math.min(c.w, c.h) * ppu;
      if (x && !x.missing && !x.dark && x.bitErrors && px > 22) num(c, (x.bitErrorsRaw === 65535 ? '65535+' : x.bitErrors) + (px > 60 ? ' err' : ''), px);
    }); });
    return;
  }
  e.items.forEach(function (it) {
    var c = it.c, px = Math.min(c.w, c.h) * ppu; if (!it.w || px <= 22) return;
    num(c, volt ? it.v.toFixed(2) : tempFmt(it.v, px > 44 ? 1 : 0, true), px);
  });
  [[1, '#ff4b4f', 'MAX'], [-1, '#4fa3ff', 'MIN']].forEach(function (m) {
    if (volt && m[0] > 0) return;
    var it = heatExtreme(e, m[0]); if (!it) return;
    var c = it.c, x = c.x + c.w / 2, y = c.y + 6 * unit, a = 5 * unit;
    var mg = el('g', { class: 'heat-mark', 'pointer-events': 'none' }, svg);
    el('path', { d: 'M' + (x - a) + ',' + y + 'h' + 2 * a + 'l' + (-a) + ',' + 1.6 * a + 'z', fill: m[1], stroke: '#000', 'stroke-width': unit }, mg);
    el('text', { x: x + a + 2 * unit, y: y + a, 'font-size': 10 * unit, 'font-weight': 700, fill: '#fff', stroke: '#000', 'stroke-width': 2.4 * unit, 'paint-order': 'stroke' }, mg).textContent = m[2];
  });
}

// ------------------------------------------------------------------ legend (HTML, bottom left of the canvas)
function heatAge(e) {
  var ats = P.devices.map(function (d) { return hlt.by[d.id] && d.hw ? hlt.by[d.id].at : 0; }).filter(Boolean);
  if (!ats.length) return '';
  var s = Math.round((Date.now() - Math.min.apply(null, ats)) / 1000);
  return s < 60 ? s + ' s ago' : Math.round(s / 60) + ' min ago';
}
// palette bar with ticks, the warning / error limits marked (temperature) or the low limit (voltage)
function heatLegendBar(mode, lo, hi, width) {
  var volt = mode === 'volt', pal = volt ? 'volt' : heat.pal, span = hi - lo || 1, pos = function (v) { return Math.max(0, Math.min(100, (v - lo) / span * 100)); };
  var step = volt ? 0.25 : span > 40 ? 10 : 5, s = '';
  for (var v = lo; v <= hi + 1e-6; v += step) s += '<span class="heat-tk" style="left:' + pos(v) + '%">' + (volt ? v.toFixed(2) : tempFmt(v, 0, true).replace('°', '')) + '</span>';
  var lim = volt ? [[watch.set.voltLow, 'warn', 'low ' + watch.set.voltLow + ' V']] : [[watch.set.tempWarn, 'warn', 'warning ' + tempFmt(watch.set.tempWarn, 0)], [watch.set.tempErr, 'bad', 'error ' + tempFmt(watch.set.tempErr, 0)]];
  lim.forEach(function (l) { if (l[0] > lo && l[0] < hi) s += '<i class="heat-lim ' + l[1] + '" style="left:' + pos(l[0]) + '%" title="' + esc(l[2]) + '"></i>'; });
  return '<div class="heat-bar"' + (width ? ' style="width:' + width + 'px"' : '') + '><div class="heat-grad" style="background:' + heatGrad(pal) + '"></div>' + s + '</div>';
}
function heatLegend(cellsBy) {
  var vp = $('viewport'), box = $('heatLegend'), mode = hlt.view, e = heat.cur;
  if (!vp) return;
  if (mode === 'off' || mode === 'status' || (heatOn(mode) && !e)) { if (box) box.hidden = true; return; }
  if (!box) {
    box = document.createElement('div'); box.id = 'heatLegend'; box.className = 'heat-legend heat-plate'; vp.appendChild(box);
    box.addEventListener('click', function (ev) { if (ev.target.closest('.heat-max')) { log('heat_jump_max', {}); heatJump(); } });
    ['pointerdown', 'pointermove', 'wheel', 'contextmenu'].forEach(function (n) { box.addEventListener(n, function (ev) { ev.stopPropagation(); }); });
  }
  var h = '';
  if (mode === 'ber') {
    h = '<div class="heat-h"><b>Bit errors</b><span class="grow"></span><span class="heat-age">' + heatAge() + '</span></div><div class="heat-sw">' +
      [[HLT_COL.primary, 'none'], ['#d4a017', '1–9'], ['#e07a3a', '10–99'], [HLT_COL.error, '100+'], ['#3a4252', 'no reading']].map(function (x) { return '<span><i style="background:' + x[0] + '"></i>' + x[1] + '</span>'; }).join('') + '</div>';
  } else {
    var volt = mode === 'volt', mx = heatExtreme(e, 1), mn = heatExtreme(e, -1), f = function (v) { return volt ? v.toFixed(2) + ' V' : tempFmt(v); };
    h = '<div class="heat-h"><b>' + (volt ? 'Supply voltage' : 'Temperature') + '</b> · ' + (volt ? 'V · fixed' : tempUnit() + ' · ' + heat.scale) + '<span class="grow"></span>' +
      (mx ? (volt ? '<span>max ' + f(mx.v) + '</span>' : '<button type="button" class="heat-max" title="Show the hottest cabinet">max ' + f(mx.v) + '</button>') : '') + (mn ? '<span>min ' + f(mn.v) + '</span>' : '') +
      '<span class="heat-age">' + heatAge() + '</span></div>' + heatLegendBar(mode, e.lo, e.hi);
  }
  // the processors that give no reading for these cabinets, and why (never painted with a value)
  var why = {};
  visibleScreens().forEach(function (s) { (cellsBy[s.id] || []).forEach(function (c) {
    var d = c.sender != null && deviceOfCard(c.sender); if (!d || why[d.id] !== undefined) return;
    var w = hlt.watch[d.id];
    why[d.id] = !d.hw ? 'not linked' : w && w.err ? hwErrText(w.err) : !hlt.by[d.id] ? 'reading…' : '';
  }); });
  Object.keys(why).forEach(function (id) { var d = deviceById(id); if (why[id] && d) h += '<div class="heat-miss">' + esc(deviceLabel(d)) + ': ' + esc(why[id]) + '</div>'; });
  if (box.innerHTML !== h) box.innerHTML = h;
  box.hidden = false;
}

// ------------------------------------------------------------------ hover readout, the hottest cabinet
// The interpolated value at a canvas point (NaN off the field), from the image on the Layout canvas.
function heatAt(x, y, e) {
  e = e || heat.cur; if (!e) return NaN;
  var f = e.field, px = Math.floor((x - f.x0) * f.s), py = Math.floor((y - f.y0) * f.s);
  if (px < 0 || py < 0 || px >= f.W || py >= f.H) return NaN;
  return f.F[py * f.W + px];
}
// From the canvas's hover (app-canvas-input.js): the reading under the pointer in the status line and a small tag beside
// it ("41.5 °C · field 41.2"). pt = canvas point, c = the cabinet there (or null); heatHover(null) hides the tag.
function heatHover(pt, c, ev) {
  var tag = $('heatTag'), vp = $('viewport');
  var hide = function () { if (tag) tag.hidden = true; };
  if (!pt || hlt.view === 'off' || !vp) return hide();
  var x = c ? hltCabinet(c) : null, mode = hlt.view, f = heatAt(pt.x, pt.y), big = '', sub = '';
  if (!c) return hide();
  if (!x) big = 'no reading';
  else if (x.missing) big = 'no reading for this cabinet';
  else if (x.dark) big = 'not answering';
  else {
    var t = x.temp != null ? tempFmt(x.temp) : '', v = x.voltage != null ? x.voltage.toFixed(2) + ' V' : '', b = x.bitErrors != null ? x.bitErrors + ' bit errors' : '';
    big = mode === 'volt' ? v : mode === 'ber' ? (b || '0 bit errors') : mode === 'status' ? (x.side === 'backup' ? 'fed from backup' : 'on primary') : t;
    if (heatOn(mode) && f === f) sub = 'field ' + (mode === 'volt' ? f.toFixed(2) : tempFmt(f, 1, true).replace('°', ''));
    var rest = [mode !== 'temp' ? t : '', mode !== 'volt' ? v : '', mode !== 'status' ? (x.side === 'backup' ? 'fed from backup' : 'on primary') : ''].filter(Boolean);
    ui.hover = (ui.hover ? ui.hover + ' · ' : '') + big + (sub ? ' (' + sub + ')' : '') + (rest.length ? ' · ' + rest.join(' · ') : '');
  }
  if (!x || x.missing || x.dark) ui.hover = (ui.hover ? ui.hover + ' · ' : '') + big;
  if (!tag) { tag = document.createElement('div'); tag.id = 'heatTag'; tag.className = 'heat-tag heat-plate'; vp.appendChild(tag); }
  tag.innerHTML = '<b>' + esc(big) + '</b>' + (sub ? '<span>' + esc(sub) + '</span>' : '');
  var r = vp.getBoundingClientRect(), z = uiZoom(), cx = ev ? ev.clientX : r.left, cy = ev ? ev.clientY : r.top;
  var lx = (cx - r.left) / z + 14, ly = (cy - r.top) / z + 14;
  if (lx + 150 > r.width / z) lx -= 170;
  if (ly + 44 > r.height / z) ly -= 60;
  tag.style.transform = 'translate(' + Math.round(lx) + 'px,' + Math.round(ly) + 'px)';
  tag.hidden = false;
}
// The hottest cabinet of the project (every screen): {value °C, text, label "Main wall P5 #3", screen id, cell}, or null.
// For the pipeline's Monitor tile (app-pipeline.js) and the legend's "max" (jumps there).
function heatMax() {
  var key = heatKey('max', 'temp');
  if (heat.max && heat.max.key === key) return heat.max.r;
  var all = allCells(), best = null;
  P.screens.forEach(function (s) {
    heatItems(all[s.id] || [], 'temp').forEach(function (it) { if (it.w && (!best || it.v > best.v)) best = { v: it.v, it: it, s: s }; });
  });
  var r = null;
  if (best) {
    var lc = lctById(best.s.screenId), at = hltCellAt(best.it.c);
    r = { value: best.v, text: tempFmt(best.v), label: (lc ? lc.name + ' ' : '') + portLabel(best.it.c.sender, best.it.c.port) + (at ? ' #' + (at.index + 1) : ''), screen: best.s.screenId, cell: best.it.c };
  }
  heat.max = { key: key, r: r };
  return r;
}
// Show the hottest cabinet: its screen on the Layout canvas, centred, at the zoom it has.
function heatJump() {
  var m = heatMax(); if (!m) return;
  if (ui.tab !== 'layout' && typeof setTab === 'function') setTab('layout');
  if (m.screen !== ui.viewScreen) showScreen(m.screen);
  if (!ui.view) fitView();
  var c = m.cell, v = ui.view;
  v.x = c.x + c.w / 2 - v.w / 2; v.y = c.y + c.h / 2 - v.h / 2;
  renderCanvas(allCells());
}
// View ▸ Live ▸ palette / scale (remembered in this browser)
function heatSet(k, v) {
  if (heat[k] === v) return;
  heat[k] = v; log('heat_' + k, { value: v });
  try { localStorage.setItem(k === 'pal' ? 'opennova.heatpal' : 'opennova.heatscale', v); } catch (e) { /* storage unavailable */ }
  if (hlt.view !== 'off') renderCanvas(allCells());
  if (ui.tab === 'health') renderHealth();
}
function bindHeat() {
  setInterval(function () {   // the legend's "3 s ago"
    if (document.hidden || hlt.view === 'off' || ui.tab !== 'layout') return;
    var a = document.querySelector('#heatLegend .heat-age'); if (a) a.textContent = heatAge();
  }, 1000);
}
