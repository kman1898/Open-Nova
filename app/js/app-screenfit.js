// app-screenfit.js - three small canvas tools from Unico (docs/UNICO_UI_TOUR.md §2.3-2.4 and §3,
// ROADMAP 0g):
//   Match Screen   the Screen card's button: the canvas (P.canvasW/H = NovaLCT's DVI graphics size,
//                  one for the whole project) becomes the size of the placed panels measured from
//                  0,0 — W = right edge of the rightmost panel, H = bottom edge of the lowest (blanks
//                  don't count), like Unico's "Custom W × H". Only offered when every processor can
//                  set its input resolution (canSetInputEdid in PROC_MODELS) or its canvas (canSetCanvas: VX2000 Pro,
//                  through Unico); otherwise a hint says
//                  why. panelExtent, screenFitBlocker, matchScreen.
//   Rotation       0° / 90° / 180° / 270° buttons on the Section card. A grid section turns as one
//                  (s.rot); in a freeform section (Self draw, Complex import) the selected panels turn,
//                  or all of them when none are selected (region.rot). 90 / 270 swap every panel's
//                  width and height; the block keeps its top-left corner, each panel keeps its place
//                  (column / row) in the block and its place on the cable, and the block packs around
//                  the new sizes (turnGroup). 180 only stores the angle. A freeform turn that would sit
//                  on other panels is refused. The angle is kept for a later hardware send: receiving-
//                  card register 0x0200009B+0 = angle / 90 (panelRotation; CONFIG_FILE_FORMATS §1.5).
//                  0° is stored as no field, so unrotated projects (and their .scr) are unchanged.
//                  rotatedSize, isQuarterTurn, panelRotation, rotationTarget, currentRotation,
//                  turnGroup, turnClash, rotateGridSection, rotatePanels, ROT_ANGLES.
//   Coords tag     "x,y" (canvas px) at the top-left corner of the panel under the pointer, and of a
//                  section / drawn panels while you drag them (Self draw's ghost has its own tag).
//                  One HTML element over the canvas, moved on hover and re-placed after each canvas
//                  draw, so hovering never redraws the SVG. Toolbar "Coords" (ui.showCoords, kept in
//                  this browser like Magnet). coordTagAt, coordTagPlace.
// renderScreenFit draws the button, hint and rotation buttons; bindScreenFit wires them.
// Depends on: app-core (P, ui, $, clamp, commit, toast, log), app-log, app-capacity (panelOf,
// screenById), app-geometry (cellGeom, allCells, visibleScreens, screenBounds), app-processors
// (procModel, deviceLabel), app-render (renderAll), all at run time.
// Hooks: cellGeom (app-geometry) calls rotatedSize; renderAll calls renderScreenFit and
// renderCanvas calls coordTagPlace (app-render); hover, the section drag and moveDrawnGroup
// (app-canvas-input) call coordTagAt; sdPlace (app-selfdraw) marks panels drawn turned (R) as
// rot 90; bindScreenFit is called from main.js.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ Match Screen
// Right / bottom edge of every panel in the project (all screens share the one canvas).
function panelExtent() {
  var cellsBy = allCells(), w = 0, h = 0, n = 0;
  P.screens.forEach(function (s) {
    cellsBy[s.id].forEach(function (c) { if (c.hole) return; n++; w = Math.max(w, c.x + c.w); h = Math.max(h, c.y + c.h); });
  });
  return n ? { w: clamp(w, 1, 65535), h: clamp(h, 1, 65535), n: n } : null;   // 16-bit in the .scr
}
// Why Match Screen isn't offered ('' = it is): a processor that can't set its input resolution.
function screenFitBlocker() {
  var no = P.devices.filter(function (d) { var m = procModel(d.model); return m.canSetInputEdid === false && !m.canSetCanvas; });
  if (!no.length) return '';
  var ch = no.filter(function (d) { return procModel(d.model).kind === 'chassis'; });   // H series and MX chassis alike
  if (ch.length)
    return 'Match Screen isn’t available on ' + ch.map(function (d) { return procModel(d.model).name; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', ') + ' — the processor sets its own output size.';
  var names = no.map(deviceLabel).filter(function (v, i, a) { return a.indexOf(v) === i; });
  return 'Match Screen isn’t available on ' + names.join(', ') + ' — the processor sets its own input size.';
}
function matchScreen() {
  var why = screenFitBlocker(); if (why) return toast(why);
  var e = panelExtent(); if (!e) return toast('Place some cabinets first');
  if (e.w === P.canvasW && e.h === P.canvasH) return toast('The canvas already fits the cabinets (' + e.w + ' × ' + e.h + ')');
  log('match_screen', { from: P.canvasW + '×' + P.canvasH, to: e.w + '×' + e.h, panels: e.n });
  P.canvasW = e.w; P.canvasH = e.h;
  commit(); renderAll();
  toast('Canvas set to ' + e.w + ' × ' + e.h + ' (custom) — fits the cabinets from 0,0 (Ctrl+Z to undo)');
}

// ------------------------------------------------------------------ rotation
var ROT_ANGLES = [0, 90, 180, 270];
function isQuarterTurn(rot) { return rot === 90 || rot === 270; }
// Footprint of panel p turned by rot (90 / 270 swap width and height).
function rotatedSize(p, rot) { return isQuarterTurn(rot) ? { w: p.h, h: p.w } : { w: p.w, h: p.h }; }
// Angle of one panel (0/90/180/270) — for a hardware send, register 0x0200009B+0 = angle / 90.
function panelRotation(s, k) {
  if (s.kind === 'complex') { var g = s.regions[+k]; return (g && g.rot) || 0; }
  return s.rot || 0;
}
// What the buttons turn: { s, keys } — keys null = a whole grid section, else region keys.
function rotationTarget() {
  var s = screenById(ui.sel); if (!s) return null;
  if (s.kind !== 'complex') return { s: s, keys: null };
  var sel = ui.selScreen === s.id && ui.selKeys && ui.selKeys.size;
  var keys = sel ? Array.from(ui.selKeys) : s.regions.map(function (g, i) { return String(i); });
  keys = keys.filter(function (k) { return s.regions[+k]; });
  return keys.length ? { s: s, keys: keys, picked: !!sel } : null;
}
// The target's angle, or null when its panels are turned differently.
function currentRotation(t) {
  if (!t) return null;
  if (!t.keys) return t.s.rot || 0;
  var a = panelRotation(t.s, t.keys[0]);
  return t.keys.every(function (k) { return panelRotation(t.s, k) === a; }) ? a : null;
}
// New top-left (nx, ny) for cells {x, y, w, h, nw, nh, hole} whose sizes change to nw × nh.
// Columns (distinct left edges) and rows (top edges) keep their order from the block's top-left;
// a gap between columns stays, columns that overlap (staggered panels) keep their offset in
// proportion. Blanks don't size a column: they take its new width (a column of blanks only, a
// spacer from an imported file, keeps its width), likewise for rows.
function turnGroup(cells) {
  var uniq = function (a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }).sort(function (p, q) { return p - q; }); };
  var axis = function (pos, size, nsize) {
    var edges = uniq(cells.map(pos)), old = edges.map(function () { return 0; }), neu = old.slice(), live = {};
    cells.forEach(function (c) { if (c.hole) return; var i = edges.indexOf(pos(c)); live[i] = 1; old[i] = Math.max(old[i], size(c)); neu[i] = Math.max(neu[i], nsize(c)); });
    cells.forEach(function (c) { var i = edges.indexOf(pos(c)); if (!live[i]) old[i] = neu[i] = Math.max(old[i], size(c)); });
    var at = [edges[0]];
    for (var i = 1; i < edges.length; i++) {
      var d = edges[i] - edges[i - 1];
      at.push(at[i - 1] + (d >= old[i - 1] || !old[i - 1] ? neu[i - 1] + d - old[i - 1] : Math.round(d * neu[i - 1] / old[i - 1])));
    }
    return { start: function (c) { return at[edges.indexOf(pos(c))]; }, size: function (c) { return neu[edges.indexOf(pos(c))]; } };
  };
  var X = axis(function (c) { return c.x; }, function (c) { return c.w; }, function (c) { return c.nw; });
  var Y = axis(function (c) { return c.y; }, function (c) { return c.h; }, function (c) { return c.nh; });
  cells.forEach(function (c) { c.nx = X.start(c); c.ny = Y.start(c); if (c.hole) { c.nw = X.size(c); c.nh = Y.size(c); } });
}
// Would the turned cells overlap each other ('self'), or other panels on this screen (the other
// section's name)? '' = no. skip = keys of section s being turned (null: all of s).
function turnClash(s, cells, skip) {
  var box = function (c) { return { x: c.nx, y: c.ny, w: c.nw, h: c.nh }; };
  var hit = function (a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; };
  var live = cells.filter(function (c) { return !c.hole; }).map(box), cellsBy = allCells(), other = '';
  for (var i = 0; i < live.length; i++) for (var j = i + 1; j < live.length; j++) if (hit(live[i], live[j])) return 'self';
  visibleScreens().forEach(function (o) {
    cellsBy[o.id].forEach(function (c) {
      if (!other && !c.hole && !(o === s && (!skip || skip[c.k])) && live.some(function (b) { return hit(b, c); })) other = secLabel(o);
    });
  });
  return other;
}
// A grid section turns as one. Its default grid re-lays itself (cellGeom uses rotatedSize); panels
// with their own geometry (overrides, from an imported file) are re-packed and stored again —
// refused (returns why) when their layout is too irregular for that to keep them apart.
function rotateGridSection(s, angle) {
  var turn = isQuarterTurn(s.rot || 0) !== isQuarterTurn(angle);
  if (turn && s.override && Object.keys(s.override).length) {
    var cells = cellGeom(s);
    cells.forEach(function (c) { c.nw = c.h; c.nh = c.w; });
    turnGroup(cells);
    if (turnClash(s, cells, null) === 'self' || cells.some(function (c) { return c.nx + c.nw > 65535 || c.ny + c.nh > 65535; }))
      return 'its cabinets (from an imported file) don’t sit on a regular grid, so turning them would make them overlap';
    var pn = rotatedSize(panelOf(s), angle), ov = {};
    cells.forEach(function (c) {
      if (c.nx !== s.x + c.c * pn.w || c.ny !== s.y + c.r * pn.h || c.nw !== pn.w || c.nh !== pn.h) ov[c.k] = { dx: c.nx - s.x, dy: c.ny - s.y, w: c.nw, h: c.nh };
    });
    s.override = ov;
  }
  if (angle) s.rot = angle; else delete s.rot;
}
function rotatePanels(angle) {
  var t = rotationTarget();
  if (!t) return toast('Select cabinets first');
  var s = t.s, from = currentRotation(t), n = t.keys ? t.keys.length : cellGeom(s).filter(function (c) { return !c.hole; }).length;
  if (from === angle) return;
  if (!t.keys) {
    var why = rotateGridSection(s, angle);
    if (why) {
      log('rotate_panels', { section: s.name, what: 'section', panels: n, from: from, to: angle, refused: why });
      return toast('Can’t turn these cabinets: ' + why);
    }
    var b = screenBounds(s), over = [];
    visibleScreens().forEach(function (o) { var ob = screenBounds(o); if (o !== s && b.x < ob.x + ob.w && b.x + b.w > ob.x && b.y < ob.y + ob.h && b.y + b.h > ob.y) over.push(o.name); });
    log('rotate_panels', { section: s.name, what: 'section', panels: n, from: from, to: angle, size: b.w + '×' + b.h, overlaps: over.length ? over : undefined });
    commit(); renderAll();
    if (over.length) toast('These cabinets now overlap other cabinets — move them, or Ctrl+Z to undo');
    return;
  }
  var skip = {}, cells = t.keys.map(function (k) {
    var g = s.regions[+k], turn = isQuarterTurn(g.rot || 0) !== isQuarterTurn(angle);
    skip[k] = 1;
    return { k: k, x: s.x + g.dx, y: s.y + g.dy, w: g.w, h: g.h, nw: turn ? g.h : g.w, nh: turn ? g.w : g.h, hole: !!s.holes[k] };
  });
  turnGroup(cells);
  var clash = turnClash(s, cells, skip);
  if (clash) {
    log('rotate_panels', { section: s.name, what: t.picked ? 'selected panels' : 'all panels', panels: n, from: from, to: angle, refused: 'overlap ' + clash });
    return toast('Can’t turn ' + (n === 1 ? 'that cabinet' : 'those cabinets') + ' — ' +
      (clash === 'self' ? 'they would overlap each other' : (n === 1 ? 'it' : 'they') + ' would sit on other cabinets (' + clash + ')'));
  }
  cells.forEach(function (c) {
    var g = s.regions[+c.k];
    g.dx = c.nx - s.x; g.dy = c.ny - s.y; g.w = c.nw; g.h = c.nh;
    if (angle) g.rot = angle; else delete g.rot;
  });
  log('rotate_panels', { section: s.name, what: t.picked ? 'selected panels' : 'all panels', panels: n, from: from, to: angle });
  commit(); renderAll();
}

// ------------------------------------------------------------------ coordinate tag
// p = a panel (or any {x, y}) in canvas px, or null to hide.
function coordTagAt(p) {
  ui.coordAt = p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
  coordTagPlace();
}
// Put the tag where ui.coordAt is now on screen (called after every canvas draw: pan, zoom, drag).
function coordTagPlace() {
  var vp = $('viewport'), tag = $('coordTagBox'), svg = $('svg');
  if (!vp || !svg) return;
  var at = ui.showCoords !== false && ui.tool !== 'draw' ? ui.coordAt : null;
  if (!at) { if (tag) tag.hidden = true; return; }
  if (!tag) {
    tag = document.createElement('div'); tag.id = 'coordTagBox';
    tag.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:2;font:600 11px/1.3 ui-monospace,Menlo,Consolas,monospace;' +
      'padding:0 4px;border-radius:3px;background:var(--panel);color:var(--ink);border:1px solid var(--line);opacity:.92;white-space:nowrap;font-variant-numeric:tabular-nums';
    vp.appendChild(tag);
  }
  var ctm = svg.getScreenCTM(); if (!ctm) { tag.hidden = true; return; }
  var pt = svg.createSVGPoint(); pt.x = at.x; pt.y = at.y;
  var q = pt.matrixTransform(ctm), r = vp.getBoundingClientRect();
  tag.textContent = at.x + ',' + at.y;
  var z = uiZoom();   // on-screen px → the page's CSS px (interface size, app-forms.js)
  tag.style.transform = 'translate(' + Math.round((q.x - r.left + 2) / z) + 'px,' + Math.round((q.y - r.top + 2) / z) + 'px)';
  tag.hidden = false;
}

// ------------------------------------------------------------------ Screen / Section card parts
function renderScreenFit() {
  var why = screenFitBlocker(), e = panelExtent(), btn = $('btnMatchScreen');
  btn.hidden = !!why;
  $('matchNote').textContent = why; $('matchNote').hidden = !why;
  var same = e && e.w === P.canvasW && e.h === P.canvasH;
  btn.disabled = !e || same;
  btn.title = !e ? 'Place some cabinets first' : same ? 'The canvas already fits the cabinets (' + e.w + ' × ' + e.h + ')'
    : 'Set the canvas to ' + e.w + ' × ' + e.h + ': the right and bottom edges of the cabinets, measured from 0,0 (all screens share one canvas)';
  btn.textContent = e && !same ? 'Match Screen → ' + e.w + ' × ' + e.h : 'Match Screen';

  var t = rotationTarget(), cur = currentRotation(t);
  Array.prototype.forEach.call($('rotSeg').children, function (b) {
    var on = cur === +b.dataset.rot;
    b.disabled = !t; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  var note = '';
  if (t && !t.keys) note = 'Turns these cabinets as a whole: at 90° / 270° each cabinet’s width and height swap; they keep their top-left corner and cable order.';
  else if (t) note = 'Turns ' + (t.picked ? t.keys.length + ' selected cabinet' + (t.keys.length === 1 ? '' : 's') : 'all ' + t.keys.length + ' cabinets (select some to turn only those)') +
    ' — they keep their top-left corner and cable order' + (cur == null ? ' · now turned differently' : '') + '.';
  layoutTip($('rotNote'), note || 'Select cabinets to turn them.');   // an ⓘ since the UI cleanup (app-render.js)
}

function bindScreenFit() {
  $('btnMatchScreen').onclick = matchScreen;
  Array.prototype.forEach.call($('rotSeg').children, function (b) {
    b.onclick = function () { rotatePanels(+b.dataset.rot); };
  });
  try { ui.showCoords = localStorage.getItem('opennova.coords') !== 'off'; } catch (e) { ui.showCoords = true; }
  $('showCoords').checked = ui.showCoords;
  $('showCoords').onchange = function () {
    ui.showCoords = $('showCoords').checked;
    log('coords_tag', { on: ui.showCoords });
    try { localStorage.setItem('opennova.coords', ui.showCoords ? 'on' : 'off'); } catch (e) { /* storage unavailable */ }
    coordTagPlace();
  };
  $('viewport').addEventListener('pointerleave', function () { coordTagAt(null); });
}
