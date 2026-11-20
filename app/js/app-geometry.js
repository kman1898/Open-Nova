// app-geometry.js - where every panel of a section sits and which port it is on: cellGeom,
// screenBounds, cellsOf, allCells, and the section list of the current screen tab
// (visibleScreens, cardsUsed).
// Depends on: app-core (P, ui, key), app-capacity (panelOf), app-autowire (autoAssign),
// app-screenfit (rotatedSize, at run time).
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// Geometry of every grid position in a screen.
function cellGeom(s) {
  if (s.kind === 'complex') {     // freeform: an ordered list of cabinets, no grid
    return s.regions.map(function (g, i) {
      return { c: i, r: 0, k: String(i), x: s.x + g.dx, y: s.y + g.dy, w: g.w, h: g.h, hole: !!s.holes[String(i)] };
    });
  }
  var pn = rotatedSize(panelOf(s), s.rot), out = [];   // turned 90/270: width and height swap (app-screenfit.js)
  for (var c = 0; c < s.cols; c++) for (var r = 0; r < s.rows; r++) {
    var k = key(c, r), o = s.override && s.override[k];
    out.push({
      c: c, r: r, k: k,
      x: s.x + (o ? o.dx : c * pn.w), y: s.y + (o ? o.dy : r * pn.h),
      w: o ? o.w : pn.w, h: o ? o.h : pn.h, hole: !!s.holes[k]
    });
  }
  return out;
}
function screenBounds(s) {
  var g = cellGeom(s), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  g.forEach(function (c) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); });
  if (!g.length) { x0 = x1 = s.x; y0 = y1 = s.y; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Full per-cell data for a screen (geometry + wiring).
function cellsOf(s) {
  var asg = s.wiring.mode === 'auto' && s.kind !== 'complex' ? autoAssign(s) : s.manual;
  return cellGeom(s).map(function (g) {
    var a = !g.hole && asg[g.k];
    g.sender = a ? a.sender : null; g.port = a ? a.port : null; g.connect = a ? a.connect : null;
    g.unassigned = !g.hole && !a;
    return g;
  });
}

function allCells() {
  var out = {};
  P.screens.forEach(function (s) { out[s.id] = cellsOf(s); });
  return out;
}

// ---- Screen tabs = NovaLCT screens. Each is a canvas holding any number of sections
// (panel blocks) on any sending cards; the canvas shows the current screen's sections.
// Online, a screen of a processor that isn't connected isn't drawn (app-online.js olLcShown).
function visibleScreens() {
  if (typeof olLcShown === 'function' && !olLcShown(lctById(ui.viewScreen))) return [];
  return P.screens.filter(function (s) { return s.screenId === ui.viewScreen; });
}
function cardsUsed(cells) {
  var set = {};
  cells.forEach(function (c) { if (c.sender != null) set[c.sender] = 1; });
  return Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
}
