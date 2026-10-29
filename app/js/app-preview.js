// app-preview.js - the Layout canvas's content preview (docs/PRO_LOOK_PLAN.md §5.2): View ▸ Content draws a picture under
// the cabinets of the screen shown — a generated gradient, colour bars or an alignment grid, or a picture picked per
// screen — and the cabinets turn into see-through port bands, so the mapping shows over the content as in Tessera. Only a
// picture in Open Nova: never part of Send, the .scr / .scfg export or any driver call (the wall's own test patterns are
// Override ▸ Pattern). The Live view and Self draw win: no picture while they are on.
// A picked picture: scaled in the browser to <= 2048 px (JPEG) and kept beside the project on the app server
// (/api/preview, serve.py / serve.ps1), so every computer that opens the project sees it; never in the project itself
// (it is synced to every browser and kept in localStorage). Opened as a file (no server): kept in memory until a reload.
// The mode is per browser (localStorage opennova.preview).
// Owns: PREVIEW_KEY, PREVIEW_MODES, pv, pvKey, pvOn, pvSet, pvBounds, pvLayer, pvImageLoad, pvImagePick, pvImageUse, pvEvent,
// pvMenuItems, bindPreview.
// Depends on: app-core ($, P, ui, el, log, toast), app-geometry (allCells), app-render (renderCanvas, renderAll), app-health
// (hlt), app-sync (sync), app-sections (visibleScreens), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var PREVIEW_KEY = 'opennova.preview';
var PREVIEW_MODES = [['ports', 'Port colours', 'The cabinets in their port colours (no picture)'], ['gradient', 'Gradient', 'A colour gradient under the cabinets'],
  ['bars', 'Colour bars', 'Colour bars under the cabinets'], ['grid', 'Alignment grid', 'A grid with a centre cross: lines every 64 canvas pixels'],
  ['image', 'Picture…', 'A picture of your own under this screen’s cabinets (kept with the project on the server, never sent to a processor)']];
var pv = { mode: 'ports', url: {}, busy: {} };   // url[project|screen] = object URL, false = none on the server, undefined = not asked yet

function pvKey(lcId) { return ((typeof sync !== 'undefined' && sync.project) || 'local') + '|' + lcId; }
// on, for this screen, now (a picture mode without its picture shows the port colours)
function pvOn() {
  if (pv.mode === 'ports' || (typeof hlt !== 'undefined' && hlt.view !== 'off') || ui.tool === 'draw' || !ui.viewScreen) return false;
  return pv.mode !== 'image' || !!pv.url[pvKey(ui.viewScreen)];
}
function pvSet(mode) {
  if (!PREVIEW_MODES.some(function (m) { return m[0] === mode; })) return;
  if (mode === 'image' && pv.url[pvKey(ui.viewScreen)] === false) return pvImagePick();   // nothing on the server yet: pick one
  if (pv.mode !== mode) log('preview_mode', { from: pv.mode, to: mode });
  pv.mode = mode;
  try { localStorage.setItem(PREVIEW_KEY, mode); } catch (e) { /* storage unavailable */ }
  if ($('pvMode') && $('pvMode').value !== mode) $('pvMode').value = mode;
  if (mode === 'image') pvImageLoad(ui.viewScreen);
  renderAll();
}
// what the picture covers: the cabinets of the screen shown (the processor scales its input onto them), in canvas units
function pvBounds(cellsBy) {
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  visibleScreens().forEach(function (s) { (cellsBy[s.id] || []).forEach(function (c) { if (c.hole) return; x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); }); });
  return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
// renderCanvas's first layer (after the canvas and grid, before the cabinets): true when a picture was drawn
function pvLayer(svg, cellsBy, unit) {
  svg.classList.remove('pv-on');
  if (pv.mode === 'image' && ui.viewScreen && pv.url[pvKey(ui.viewScreen)] === undefined) pvImageLoad(ui.viewScreen);
  if (!pvOn()) return false;
  var b = pvBounds(cellsBy); if (!b) return false;
  var g = el('g', { class: 'pv-layer', 'pointer-events': 'none' }, svg), defs = el('defs', {}, g), i;
  if (pv.mode === 'image') el('image', { href: pv.url[pvKey(ui.viewScreen)], x: b.x, y: b.y, width: b.w, height: b.h, preserveAspectRatio: 'none' }, g);
  else if (pv.mode === 'gradient') {
    var lg = el('linearGradient', { id: 'pvGrad', x1: 0, y1: 0, x2: 0, y2: 1 }, defs), hg = el('linearGradient', { id: 'pvHue', x1: 0, y1: 0, x2: 1, y2: 0 }, defs);
    [[0, '#0b0626'], [0.45, '#3a0f5e'], [0.78, '#b22a78'], [1, '#ff7a45']].forEach(function (s) { el('stop', { offset: s[0], 'stop-color': s[1] }, lg); });
    [[0, '#00c8ff', 0.35], [0.5, '#00c8ff', 0], [1, '#ffd36b', 0.3]].forEach(function (s) { el('stop', { offset: s[0], 'stop-color': s[1], 'stop-opacity': s[2] }, hg); });
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'url(#pvGrad)' }, g);
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'url(#pvHue)' }, g);
  } else if (pv.mode === 'bars') {   // 75 % bars over a black / white / black strip, as a generator's bars
    var bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'], bw = b.w / bars.length, bh = b.h * 0.72;
    bars.forEach(function (c, k) { el('rect', { x: b.x + k * bw, y: b.y, width: bw + unit * 0.5, height: bh, fill: c }, g); });
    var low = ['#0000c0', '#131313', '#c000c0', '#131313', '#00c0c0', '#131313', '#c0c0c0'];
    low.forEach(function (c, k) { el('rect', { x: b.x + k * bw, y: b.y + bh, width: bw + unit * 0.5, height: b.h * 0.08, fill: c }, g); });
    [['#00214c', 1.25], ['#ffffff', 1.25], ['#32006a', 1.25], ['#131313', 3.25]].reduce(function (x, s) {
      el('rect', { x: x, y: b.y + b.h * 0.8, width: bw * s[1] + unit * 0.5, height: b.h * 0.2, fill: s[0] }, g); return x + bw * s[1];
    }, b.x);
  } else {   // alignment grid: a line every 64 px, a stronger one every 256, a centre cross and circle, the edges
    var pat = el('pattern', { id: 'pvGridP', x: b.x, y: b.y, width: 256, height: 256, patternUnits: 'userSpaceOnUse' }, defs);
    el('rect', { width: 256, height: 256, fill: '#101318' }, pat);
    var d = ''; for (i = 64; i < 256; i += 64) d += 'M' + i + ',0V256M0,' + i + 'H256';
    el('path', { d: d, stroke: '#3a4250', 'stroke-width': 1, fill: 'none' }, pat);
    el('path', { d: 'M0,0V256M0,0H256', stroke: '#7d8796', 'stroke-width': 2, fill: 'none' }, pat);
    el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'url(#pvGridP)' }, g);
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2, r = Math.min(b.w, b.h) * 0.42;
    el('path', { d: 'M' + cx + ',' + b.y + 'V' + (b.y + b.h) + 'M' + b.x + ',' + cy + 'H' + (b.x + b.w), stroke: '#e6e9ee', 'stroke-width': 2, fill: 'none' }, g);
    el('circle', { cx: cx, cy: cy, r: r, stroke: '#e6e9ee', 'stroke-width': 2, fill: 'none' }, g);
    el('rect', { x: b.x + 1, y: b.y + 1, width: b.w - 2, height: b.h - 2, stroke: '#ffd36b', 'stroke-width': 2, fill: 'none' }, g);
  }
  svg.classList.add('pv-on');
  return true;
}
// the picture of screen lcId from the server, once (held as an object URL: renderCanvas rebuilds the SVG on every call)
function pvImageLoad(lcId) {
  var k = pvKey(lcId);
  if (!lcId || pv.url[k] !== undefined || pv.busy[k] || !/^https?:$/.test(location.protocol) || typeof sync === 'undefined' || !sync.project) {
    if (lcId && pv.url[k] === undefined && !/^https?:$/.test(location.protocol)) pv.url[k] = false;
    return;
  }
  pv.busy[k] = true;
  fetch('api/preview?project=' + encodeURIComponent(sync.project) + '&screen=' + encodeURIComponent(lcId), { cache: 'no-store' }).then(function (r) {
    return r.ok ? r.blob() : null;
  }).then(function (b) {
    pv.busy[k] = false; pv.url[k] = b ? URL.createObjectURL(b) : false;
    if (pv.mode === 'image' && ui.tab === 'layout') renderCanvas(allCells());
  }, function () { pv.busy[k] = false; pv.url[k] = false; });
}
function pvImagePick() {
  var lc = lctById(ui.viewScreen); if (!lc) return toast('Show a screen first');
  var f = $('pvFile');
  if (!f) { f = document.createElement('input'); f.type = 'file'; f.id = 'pvFile'; f.accept = 'image/*'; f.hidden = true; document.body.appendChild(f); f.onchange = function () { if (f.files[0]) pvImageUse(f.files[0]); f.value = ''; }; }
  f.click();
}
// scale to <= 2048 px, JPEG, then to the server (or memory only when opened as a file)
function pvImageUse(file) {
  var lc = lctById(ui.viewScreen); if (!lc) return;
  var img = new Image(), src = URL.createObjectURL(file);
  img.onerror = function () { URL.revokeObjectURL(src); toast('That file isn’t a picture this browser can read'); };
  img.onload = function () {
    URL.revokeObjectURL(src);
    var s = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * s)); c.height = Math.max(1, Math.round(img.naturalHeight * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    c.toBlob(function (blob) {
      if (!blob) return toast('The picture could not be prepared');
      var k = pvKey(lc.id), old = pv.url[k];
      if (old) URL.revokeObjectURL(old);
      pv.url[k] = URL.createObjectURL(blob);
      log('preview_picture', { screen: lc.name, file: file.name, size: c.width + '×' + c.height, bytes: blob.size });
      pvSet('image');
      if (!/^https?:$/.test(location.protocol) || typeof sync === 'undefined' || !sync.project) return toast('Picture shown (opened as a file: kept until a reload)');
      fetch('api/preview?project=' + encodeURIComponent(sync.project) + '&screen=' + encodeURIComponent(lc.id), { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg', 'X-Client': sync.id } })
        .then(function (r) { return r.json(); }).then(function (r) { if (!r.ok) throw new Error(r.error || 'refused'); toast('Picture kept with the project'); },
          function (e) { log('preview_picture_error', { error: e.message }); toast('Picture shown here only: the server didn’t keep it (' + e.message + ')'); });
    }, 'image/jpeg', 0.85);
  };
  img.src = src;
}
// another browser put a new picture on this project's screen: fetch it again
function pvEvent(m) {
  if (typeof sync === 'undefined' || m.project !== sync.project) return;
  var k = pvKey(m.preview); if (pv.url[k]) URL.revokeObjectURL(pv.url[k]);
  delete pv.url[k];
  if (pv.mode === 'image' && m.preview === ui.viewScreen) pvImageLoad(m.preview);
}
// menu bar View ▸ Content ›
function pvMenuItems() {
  return PREVIEW_MODES.map(function (m) {
    return { label: m[1], radio: true, checked: pv.mode === m[0] && (m[0] !== 'image' || !!pv.url[pvKey(ui.viewScreen)]), title: m[2], act: function () { if (m[0] === 'image') pvImagePick(); else pvSet(m[0]); } };
  }).concat([{ sep: true }, { label: 'Change Picture…', disabled: !ui.viewScreen, title: 'Pick another picture for this screen', act: pvImagePick }]);
}
function bindPreview() {
  try { var m = localStorage.getItem(PREVIEW_KEY); if (PREVIEW_MODES.some(function (x) { return x[0] === m; })) pv.mode = m; } catch (e) { /* storage unavailable */ }
  var s = $('pvMode'); if (!s) return;
  s.value = pv.mode;
  s.addEventListener('change', function () { if (s.value === 'image') { s.value = pv.mode; pvImagePick(); } else pvSet(s.value); });
}
