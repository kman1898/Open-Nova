// app-quickadd.js - Quick add (NovaStar Unico's "Swift Layout"): drop one panel, then drag its
// handles to grow a wall of columns × rows; the ports are assigned while it grows, one column
// (or row) per port from the active port (ui.mSender / ui.mPort) onward. On the canvas:
//   move + click      place the first panel (the Panel library's pick, ui.drawPanelId); its
//                     top-left follows the pointer and snaps like Self draw (Alt = no snapping)
//   drag a handle     right edge = more columns, bottom edge = more rows, corner = both
//                     (pressing and dragging when placing grows it straight away)
//   drag the wall     move it          arrow keys   one column / row more or less
//   Enter / OK        make it a section on this screen      Esc / Cancel   discard it
//   Q or the toolbar's Quick add button   start / leave
// The Quick add box over the canvas picks the pattern: one port per column or per row, the
// start corner, and whether every cable starts on the same side or they alternate.
// A column (row) bigger than a port is cut where the port fills up (rectangle rule, portCap)
// and carries on on the next port, like the pattern pad's Organized fill.
// Ports advance with advancePort over the real port counts of the processors' sending cards;
// a wall that needs more ports than are left is refused, never wrapped.
// OK makes a normal grid section (newScreen): Auto wiring when auto gives exactly the planned
// ports (Organized, max panels/port = one line — checked with autoAssign), otherwise Manual
// wiring with the planned sender / port / cable position per panel. Panels already on the screen
// under the wall are removed only after asking (blanks in grid sections, removed from freeform
// ones, whole sections when all their panels are covered). One commit, so Ctrl+Z undoes it all.
// Owns: QA_GRAB_PX, QA_OPTS_KEY, qa, setQuickAdd, qaToggle, qaReset, qaLoadOpts, qaSaveOpts,
// qaPanel, qaCellsNow, qaSnap, qaLimits, qaPlan, qaBounds, qaHandles, qaHit, qaDown,
// qaDragMove, qaDragEnd, qaHover, qaNudge, qaOnCanvas, qaPointerUp, qaSameWiring, qaDropRegions,
// qaClearUnder, qaOk, qaIcon, qaPatternTitle, qaBoxBuild, qaBoxUpdate, qaBadgeText,
// renderQuickAdd.
// Depends on: app-core (P, ui, $, uid, key, clamp, fmt, esc, toast, commit, keysText, newScreen),
// app-log (log), app-capacity (capacity, rectOf, rectUnion, rectArea, portCap, portsOfSender,
// portColor, portLabel, advancePort, cardProblem), app-geometry (allCells, cellGeom,
// visibleScreens), app-autowire (pathLines, autoAssign), app-manual-wiring (curPort, renumber,
// toggleHole), app-selfdraw (sdSnap, sdOccupied, setSelfDraw), app-canvas-input (svgPoint),
// app-context-menu (closeMenu), app-render (el, renderAll, renderModeBadge), all at run time.
// Hooks: renderCanvas (app-render) calls renderQuickAdd to draw the preview and the box;
// renderModeBadge shows qaBadgeText while ui.tool === 'quick'.
// Registers at load: document listeners in the capture phase — pointer events on the canvas
// are taken over only while ui.tool === 'quick' (left button, Space not held), so pan / zoom /
// right-click keep working — plus the keys and the toolbar button's click.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

var QA_GRAB_PX = 11;                       // screen px around a handle that grabs it
var QA_OPTS_KEY = 'opennova.quickadd';    // the pattern last picked, in this browser
// at = top-left of the wall once placed (hover = the ghost before that); plan = qaPlan's cache
// preset = {cols, rows}: a wall size set from outside (app-hardware.js, detected panels): the ghost and the first click use it
var qa = { at: null, cols: 1, rows: 1, hover: null, drag: null, plan: null, planKey: '', box: null, padDir: null, preset: null,
  opts: { dir: 'V', corner: 'TL', alt: false } };

function setQuickAdd(on, via) {
  on = !!on;
  if (on === (ui.tool === 'quick')) return;
  if (on && ui.tool === 'draw') setSelfDraw(false);
  var was = qa.at ? qa.cols + '×' + qa.rows : undefined;
  ui.tool = on ? 'quick' : null;
  qaReset();
  if (on) { qaLoadOpts(); ui.selKeys = new Set(); ui.selScreen = null; }
  var vp = $('viewport'); if (vp) vp.style.cursor = on ? 'crosshair' : '';
  var pn = qaPanel();
  if (on) log('quick_add_start', { via: via, panel: pn ? pn.name + ' ' + pn.w + '×' + pn.h : 'none', from_port: portLabel(ui.mSender || 0, ui.mPort || 0),
    pattern: qa.opts.dir + ' ' + qa.opts.corner + (qa.opts.alt ? ' alternating' : '') });
  else log('quick_add_cancel', { via: via, discarded: was || 'nothing placed' });
  renderAll();
}
function qaToggle(via) { setQuickAdd(ui.tool !== 'quick', via); }
function qaReset() { qa.at = null; qa.hover = null; qa.drag = null; qa.cols = 1; qa.rows = 1; qa.plan = null; qa.planKey = ''; qa.cellsBy = null; qa.preset = null; }
function qaLoadOpts() {
  try {
    var o = JSON.parse(localStorage.getItem(QA_OPTS_KEY) || 'null');
    if (o && /^[VH]$/.test(o.dir) && /^(TL|TR|BL|BR)$/.test(o.corner)) qa.opts = { dir: o.dir, corner: o.corner, alt: !!o.alt };
  } catch (e) { /* storage unavailable */ }
}
function qaSaveOpts() { try { localStorage.setItem(QA_OPTS_KEY, JSON.stringify(qa.opts)); } catch (e) { /* storage unavailable */ } }

// The panel type the wall is made of: the Panel library's pick (as Self draw), not turned.
function qaPanel() { return P.panels.find(function (p) { return p.id === ui.drawPanelId; }) || P.panels[0] || null; }

// All cells, and the panels on this screen a ghost must snap to, recomputed only after an edit
// (commit / undo / sync change ui.lastSnap) or another screen tab.
function qaCellsNow() {
  if (!qa.cellsBy || qa.cSnap !== ui.lastSnap || qa.cView !== ui.viewScreen) {
    qa.cellsBy = allCells(); qa.cSnap = ui.lastSnap; qa.cView = ui.viewScreen; qa.occ = sdOccupied(qa.cellsBy);
  }
  return qa.cellsBy;
}
// Top-left for a panel whose corner is at p: Self draw's snapping (neighbour edges, else the
// panel grid while Magnet is on); free = Alt.
function qaSnap(p, free) {
  var pn = qaPanel(); qaCellsNow();
  return sdSnap(p.x, p.y, pn.w, pn.h, qa.occ, free);
}
function qaLimits(pn) {   // up to 255 × 255 (a section's limit) and inside the .scr's 65,535 px
  return { cols: clamp(Math.floor((65535 - qa.at.x) / pn.w), 1, 255), rows: clamp(Math.floor((65535 - qa.at.y) / pn.h), 1, 255) };
}

// ------------------------------------------------------------------ the plan
// The wall as OK would make it: its runs (one per port, in port order, each in cable order) with
// sender / port, what it covers on this screen, and what's wrong. Cached until something changes.
function qaPlan() {
  var pn = qaPanel(), a = qa.at || qa.hover;
  if (!pn || !a) return null;
  var o = qa.opts, pre = qa.preset, cols = qa.at ? qa.cols : pre ? pre.cols : 1, rows = qa.at ? qa.rows : pre ? pre.rows : 1, start = curPort();
  var cellsBy = qaCellsNow();
  var pk = [a.x, a.y, cols, rows, pn.id, pn.w, pn.h, o.dir, o.corner, o.alt, start.sender, start.port, ui.viewScreen].join('|');
  if (qa.plan && qa.planKey === pk && qa.planSnap === ui.lastSnap) return qa.plan;
  var plan = { at: a, cols: cols, rows: rows, pn: pn, runs: [], lines: 0, map: {}, err: '', out: 0, left: 0, covers: [], shared: [] };
  var geom = function (pt) { return { c: pt.c, r: pt.r, k: key(pt.c, pt.r), x: a.x + pt.c * pn.w, y: a.y + pt.r * pn.h, w: pn.w, h: pn.h }; };
  // the lines in the chosen order (autowire's pathLines), each cut where the port fills up
  var lines = pathLines({ cols: cols, rows: rows, wiring: { dir: o.dir, corner: o.corner } });
  plan.lines = lines.length;
  if (!capacity()) plan.err = 'the frame rate is above 120 Hz, which has no port capacity';
  lines.forEach(function (line, li) {
    var cur = [], rect = null;
    (o.alt && li % 2 ? line.slice().reverse() : line).forEach(function (pt) {
      var g = geom(pt), next = rectUnion(rect, rectOf(g));
      if (rectArea(next) > portCap(next)) {
        if (cur.length) { plan.runs.push({ cells: cur }); cur = []; next = rectOf(g); }
        if (rectArea(next) > portCap(next) && !plan.err) plan.err = 'one ' + pn.w + '×' + pn.h + ' cabinet is more than a port can drive (' + fmt(rectArea(next)) + ' > ' + fmt(portCap(next)) + ' px)';
      }
      cur.push(g); rect = next;
    });
    if (cur.length) plan.runs.push({ cells: cur });
  });
  // ports from the active one on, over the cards that exist
  var bad = cardProblem(start), sp = start;
  if (bad && !plan.err) plan.err = bad;
  // (only the start card's processor: a screen belongs to one processor, app-processors.js)
  var home = deviceOfCard(start.sender), onHome = function (si) { var d = deviceOfCard(si); return !home || (d && d.id === home.id); };
  for (var si = start.sender; si < P.processors.length; si++) if (onHome(si)) plan.left += portsOfSender(si) - (si === start.sender ? start.port : 0);
  plan.left = Math.max(0, plan.left);
  plan.runs.forEach(function (run, i) {
    if (i) sp = advancePort(sp);
    run.sender = sp.sender; run.port = sp.port;
    run.ok = sp.sender < P.processors.length && sp.port < portsOfSender(sp.sender) && onHome(sp.sender);
    if (!run.ok) plan.out++;
    run.cells.forEach(function (g, ci) { plan.map[g.k] = { sender: sp.sender, port: sp.port, connect: ci }; });
  });
  // panels already on this screen under the wall (the wall is a full rectangle)
  var x1 = a.x + cols * pn.w, y1 = a.y + rows * pn.h, under = {};
  visibleScreens().forEach(function (s) {
    (cellsBy[s.id] || []).forEach(function (c) {
      if (c.hole || c.x >= x1 || c.x + c.w <= a.x || c.y >= y1 || c.y + c.h <= a.y) return;
      plan.covers.push({ s: s, k: c.k, c: c }); under[s.id + '|' + c.k] = 1;
    });
  });
  // planned ports some other panel (not about to be replaced) already uses
  var used = {};
  P.screens.forEach(function (s) {
    (cellsBy[s.id] || []).forEach(function (c) { if (c.sender != null && !under[s.id + '|' + c.k]) used[c.sender + ':' + c.port] = secLabel(s); });
  });
  plan.runs.forEach(function (run) { var u = used[run.sender + ':' + run.port]; if (u) plan.shared.push(portLabel(run.sender, run.port) + ' (' + u + ')'); });
  plan.cut = plan.runs.length > plan.lines;
  plan.auto = !plan.cut && (!o.alt || plan.lines === 1);   // what OK is expected to make (qaOk checks)
  qa.plan = plan; qa.planKey = pk; qa.planSnap = ui.lastSnap;
  return plan;
}
function qaBounds(plan) { return { x0: plan.at.x, y0: plan.at.y, x1: plan.at.x + plan.cols * plan.pn.w, y1: plan.at.y + plan.rows * plan.pn.h }; }
// Handle centres, a little outside the wall so they never cover a panel: right, bottom, corner.
function qaHandles(plan) {
  var b = qaBounds(plan), u = 1 / (ui.pxPerUnit || 1), off = 13 * u;
  return { e: { x: b.x1 + off, y: (b.y0 + b.y1) / 2 }, s: { x: (b.x0 + b.x1) / 2, y: b.y1 + off }, se: { x: b.x1 + off * 0.8, y: b.y1 + off * 0.8 } };
}
// What the pointer is on once the first panel is down: a handle, the wall ('move') or nothing.
function qaHit(p) {
  var plan = qa.at && qaPlan();
  if (!plan) return null;
  var hs = qaHandles(plan), best = null;
  Object.keys(hs).forEach(function (h) {
    var d = Math.hypot(p.x - hs[h].x, p.y - hs[h].y) * (ui.pxPerUnit || 1);
    if (d <= QA_GRAB_PX && (!best || d < best.d)) best = { h: h, d: d };
  });
  if (best) return best.h;
  var b = qaBounds(plan);
  return p.x >= b.x0 && p.x < b.x1 && p.y >= b.y0 && p.y < b.y1 ? 'move' : null;
}

// ------------------------------------------------------------------ pointer and keys
function qaOnCanvas(e) {
  var vp = $('viewport'), t = e.target;
  return !!(vp && t && t.nodeType === 1 && vp.contains(t) && !(qa.box && qa.box.contains(t)));
}
function qaDown(e) {
  var p = svgPoint(e), pn = qaPanel();
  if (!pn) return toast('Add a cabinet type in Cabinet types first');
  if (!qa.at) {                              // place the first panel, and grow it if the press drags
    qa.at = qaSnap(p, e.altKey); qa.cols = qa.preset ? qa.preset.cols : 1; qa.rows = qa.preset ? qa.preset.rows : 1; qa.hover = null;
    log('quick_add_place', { at: qa.at.x + ',' + qa.at.y, panel: pn.name + ' ' + pn.w + '×' + pn.h, from_port: portLabel(ui.mSender || 0, ui.mPort || 0),
      preset: qa.preset ? qa.cols + '×' + qa.rows : undefined });
    // a preset wall (detected panels, app-hardware.js) lands at its size: dragging the first press moves it
    qa.drag = qa.preset ? { h: 'move', sx: e.clientX, sy: e.clientY, moved: false, dx: p.x - qa.at.x, dy: p.y - qa.at.y }
      : { h: 'se', first: true, sx: e.clientX, sy: e.clientY, moved: false };
    renderModeBadge();
  } else {
    var h = qaHit(p);
    if (!h) return;
    qa.drag = { h: h, sx: e.clientX, sy: e.clientY, moved: false, dx: p.x - qa.at.x, dy: p.y - qa.at.y };
  }
  renderQuickAdd();
}
function qaDragMove(e) {
  var d = qa.drag, pn = qaPanel();
  if (!d || !pn) return;
  if (!d.moved && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) return;
  d.moved = true;
  var p = svgPoint(e); d.pt = p;
  if (d.h === 'move') qa.at = qaSnap({ x: p.x - d.dx, y: p.y - d.dy }, e.altKey);
  else {
    // a handle follows the pointer to the nearest panel edge; the first press-drag includes the
    // panel under the pointer (like Self draw's block)
    var lim = qaLimits(pn), n = function (v, size) { return d.first ? Math.floor(v / size) + 1 : Math.round(v / size); };
    if (d.h !== 's') qa.cols = clamp(n(p.x - qa.at.x, pn.w), 1, lim.cols);
    if (d.h !== 'e') qa.rows = clamp(n(p.y - qa.at.y, pn.h), 1, lim.rows);
  }
  renderQuickAdd();
}
function qaDragEnd(e) {
  var d = qa.drag; qa.drag = null;
  if (d && d.moved) {
    if (d.h === 'move') log('quick_add_move', { to: qa.at.x + ',' + qa.at.y });
    else log('quick_add_resize', { size: qa.cols + '×' + qa.rows, handle: d.first ? 'placing drag' : { e: 'right', s: 'bottom', se: 'corner' }[d.h] });
  }
  renderQuickAdd();
  if (e) qaHover(e);
}
function qaHover(e) {
  var vp = $('viewport'), p = svgPoint(e);
  if (!qa.at) {
    var s = qaSnap(p, e.altKey);
    if (!qa.hover || s.x !== qa.hover.x || s.y !== qa.hover.y) { qa.hover = s; renderQuickAdd(); }
    if (vp) vp.style.cursor = 'crosshair';
    return;
  }
  if (vp) vp.style.cursor = { e: 'ew-resize', s: 'ns-resize', se: 'nwse-resize', move: 'move' }[qaHit(p)] || 'default';
}
function qaNudge(k) {
  var pn = qaPanel();
  if (!qa.at || !pn) return;
  var lim = qaLimits(pn), c0 = qa.cols, r0 = qa.rows;
  if (k === 'ArrowRight') qa.cols = Math.min(lim.cols, qa.cols + 1);
  else if (k === 'ArrowLeft') qa.cols = Math.max(1, qa.cols - 1);
  else if (k === 'ArrowDown') qa.rows = Math.min(lim.rows, qa.rows + 1);
  else if (k === 'ArrowUp') qa.rows = Math.max(1, qa.rows - 1);
  if (qa.cols === c0 && qa.rows === r0) return;
  log('quick_add_resize', { size: qa.cols + '×' + qa.rows, handle: 'arrow key' });
  renderQuickAdd();
}

// Left-button presses on the canvas belong to Quick add while it's on (Space+drag, right /
// middle drag and the wheel still pan and zoom). Capture phase, so the canvas's own handlers
// (app-canvas-input.js) don't see them.
document.addEventListener('pointerdown', function (e) {
  if (ui.tool !== 'quick' || e.button !== 0 || ui.spaceHeld || !qaOnCanvas(e)) return;
  e.stopPropagation(); e.preventDefault(); closeMenu();
  var a = document.activeElement; if (a && a !== document.body && a.blur) a.blur();   // so Enter / Esc reach Quick add
  qaDown(e);
  if (qa.drag) { try { $('viewport').setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ } }
}, true);
document.addEventListener('pointermove', function (e) {
  if (ui.tool !== 'quick') return;
  if (qa.drag) { e.stopPropagation(); qaDragMove(e); return; }
  if (qaOnCanvas(e)) qaHover(e);            // (the canvas's own hover readout still runs)
  else if (qa.hover && !qa.at) { qa.hover = null; renderQuickAdd(); }
}, true);
function qaPointerUp(e) {
  if (ui.tool !== 'quick' || !qa.drag) return;
  e.stopPropagation();
  if (e.type === 'pointercancel') { qa.drag = null; renderQuickAdd(); return; }
  qaDragEnd(e);
}
document.addEventListener('pointerup', qaPointerUp, true);
document.addEventListener('pointercancel', qaPointerUp, true);
document.addEventListener('click', function (e) {
  var b = e.target && e.target.closest ? e.target.closest('#btnQuickAdd') : null;
  if (b) { b.blur(); qaToggle('button'); }
});
// Q starts / leaves Quick add; while it's on: Enter = OK, Esc = Cancel, arrows = ± a column / row.
// Delete does nothing meanwhile (it would delete the selected section).
document.addEventListener('keydown', function (e) {
  var a = document.activeElement, typing = a && /INPUT|SELECT|TEXTAREA/.test(a.tagName), dlg = $('logDlg');
  if (typing || (dlg && !dlg.hidden) || e.ctrlKey || e.metaKey || e.altKey) return;
  var stop = function () { e.preventDefault(); e.stopImmediatePropagation(); };
  if (e.key === 'q' || e.key === 'Q') { stop(); if (!e.repeat) qaToggle('key Q'); return; }
  if (ui.tool !== 'quick') return;
  if (e.key === 'Escape') { var m = $('ctxMenu'); if (m && !m.hidden) return; stop(); setQuickAdd(false, 'Esc'); }
  else if (e.key === 'Enter') { stop(); qaOk(); }
  else if (/^Arrow(Up|Down|Left|Right)$/.test(e.key)) { stop(); qaNudge(e.key); }
  else if (e.key === 'Delete' || e.key === 'Backspace') stop();
}, true);

// ------------------------------------------------------------------ OK
function qaSameWiring(a, b) {
  var ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(function (k) {
    var x = a[k], y = b[k]; return !!y && x.sender === y.sender && x.port === y.port && x.connect === y.connect;
  });
}
// Remove panels (keys) from a freeform section; later ones move up a key (as Self draw's delete).
function qaDropRegions(s, keys) {
  var del = {}, map = {}, regions = [], n = 0, seen = {};
  keys.forEach(function (k) { del[k] = 1; });
  s.regions.forEach(function (g, i) { if (!del[String(i)]) { map[String(i)] = String(n++); regions.push(g); } });
  ['manual', 'holes', 'raw'].forEach(function (f) {
    var o = {}; Object.keys(s[f] || {}).forEach(function (k) { if (map[k] != null) o[map[k]] = s[f][k]; }); s[f] = o;
  });
  s.regions = regions;
  Object.keys(s.manual).forEach(function (k) { var a = s.manual[k]; seen[a.sender + ':' + a.port] = a; });
  Object.keys(seen).forEach(function (pk) { renumber(s, seen[pk].sender, seen[pk].port); });
}
// Take away the panels the wall covers: blanks in grid sections, removed from freeform ones, and
// a section goes entirely when all its panels are covered. Returns {section name: panels}.
function qaClearUnder(covers) {
  var bySec = {}, out = {};
  covers.forEach(function (cv) { (bySec[cv.s.id] = bySec[cv.s.id] || { s: cv.s, keys: [] }).keys.push(cv.k); });
  Object.keys(bySec).forEach(function (id) {
    var s = bySec[id].s, keys = bySec[id].keys, live = cellGeom(s).filter(function (g) { return !g.hole; }).length;
    out[s.name] = keys.length;
    if (keys.length >= live) { P.screens = P.screens.filter(function (x) { return x !== s; }); if (ui.sel === s.id) ui.sel = null; out[s.name] += ' (section removed)'; }
    else if (s.kind === 'complex') qaDropRegions(s, keys);
    else keys.forEach(function (k) { if (!s.holes[k]) toggleHole(s, k); });
  });
  return out;
}
function qaOk() {
  if (ui.tool !== 'quick') return;
  if (!qa.at) return toast('Click on the canvas to place the first cabinet');
  qa.planKey = ''; qa.cellsBy = null;          // fresh, from the project as it is now
  var plan = qaPlan(), size = plan.cols + '×' + plan.rows;
  if (plan.err) { log('quick_add_ok', { size: size, refused: plan.err }); return toast('Quick add: ' + plan.err); }
  if (plan.out) {
    log('quick_add_ok', { size: size, refused: 'out of ports', ports_needed: plan.runs.length, ports_left: plan.left, from_port: portLabel(plan.runs[0].sender, plan.runs[0].port) });
    return toast('Not enough ports: this wall needs ' + plan.runs.length + ' ports from ' + portLabel(plan.runs[0].sender, plan.runs[0].port) + ', but only ' + plan.left +
      ' are left. Add a processor (or an output card), or make the wall smaller.');
  }
  var replaced;
  if (plan.covers.length) {
    var names = [];
    plan.covers.forEach(function (cv) { if (names.indexOf(cv.s.name) < 0) names.push(cv.s.name); });
    if (!confirm('The new wall covers ' + plan.covers.length + ' cabinet' + (plan.covers.length === 1 ? '' : 's') + ' already on this screen.\n\n' +
      'OK: replace them with the new wall.\nCancel: keep them and go back to Quick add.')) {
      log('quick_add_ok', { size: size, refused: 'kept the panels already there', covers: plan.covers.length, sections: names });
      return;
    }
    replaced = qaClearUnder(plan.covers);
  }
  var o = qa.opts, first = plan.runs[0], last = plan.runs[plan.runs.length - 1];
  var s = newScreen(plan.at.x, plan.at.y);
  s.cols = plan.cols; s.rows = plan.rows; s.panelId = plan.pn.id;
  // Auto when auto gives exactly these ports: Organized with at most one line per port.
  s.wiring = { mode: 'auto', corner: o.corner, dir: o.dir, pattern: 'serpentine', split: 'lines', max: o.dir === 'V' ? plan.rows : plan.cols,
    restart: 'continue', sender: first.sender, port: first.port };
  var why = !plan.auto ? (plan.cut ? 'a ' + (o.dir === 'V' ? 'column' : 'row') + ' is bigger than one port' : 'the cables alternate sides') : '';
  var auto = plan.auto && autoAssign(s);
  if (!auto || (ui.autoErr[s.id] || []).length || !qaSameWiring(auto, plan.map)) {
    if (plan.auto) why = 'auto wiring would differ';
    delete ui.autoErr[s.id];
    s.wiring.mode = 'manual'; s.manual = plan.map;
  }
  P.screens.push(s); ui.sel = s.id;
  var nx = advancePort(last);                  // the next Quick add / drawing carries on after it
  if (nx.sender < P.processors.length) { ui.mSender = nx.sender; ui.mPort = nx.port; } else { ui.mSender = last.sender; ui.mPort = last.port; }
  var ports = portLabel(first.sender, first.port) + (plan.runs.length > 1 ? ' – ' + portLabel(last.sender, last.port) : '');
  log('quick_add_ok', { section: s.name, at: s.x + ',' + s.y, size: size, panels: plan.cols * plan.rows, panel: plan.pn.name + ' ' + plan.pn.w + '×' + plan.pn.h,
    ports: ports, port_count: plan.runs.length, per: o.dir === 'V' ? 'column' : 'row', corner: o.corner, alternate: o.alt,
    wiring: s.wiring.mode, why_manual: s.wiring.mode === 'manual' ? why : undefined, replaced: replaced, shared_ports: plan.shared.length ? plan.shared : undefined });
  ui.tool = null; qaReset();
  var vp = $('viewport'); if (vp) vp.style.cursor = '';
  commit(); renderAll();
  toast('Added ' + plan.cols + ' × ' + plan.rows + ' cabinets on ' + ports + ' (' + (s.wiring.mode === 'auto' ? 'Auto' : 'Manual') + ' wiring) — Ctrl+Z to undo');
}

// ------------------------------------------------------------------ the Quick add box
// Pattern icon: three lines, each its own port (own colour and start dot).
function qaIcon(corner, dir, alt) {
  var fr = corner[1] === 'R', fb = corner[0] === 'B', cells = '', runs = '';
  for (var cc = 0; cc < 3; cc++) for (var rr = 0; rr < 3; rr++) cells += '<rect class="pp-cell" x="' + (1 + cc * 8) + '" y="' + (1 + rr * 8) + '" width="6" height="6" rx="1"/>';
  for (var i = 0; i < 3; i++) {
    var pts = [];
    for (var j = 0; j < 3; j++) {
      var jj = alt && i % 2 ? 2 - j : j;
      var col = dir === 'H' ? (fr ? 2 - jj : jj) : (fr ? 2 - i : i);
      var row = dir === 'H' ? (fb ? 2 - i : i) : (fb ? 2 - jj : jj);
      pts.push((4 + col * 8) + ',' + (4 + row * 8));
    }
    var st = pts[0].split(','), c = portColor(0, i);
    runs += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + c + '" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="' + st[0] + '" cy="' + st[1] + '" r="2.5" fill="' + c + '"/>';
  }
  return '<svg viewBox="0 0 26 26" class="pattern-icon">' + cells + runs + '</svg>';
}
function qaPatternTitle(corner, dir, alt) {
  var line = dir === 'V' ? 'column' : 'row';
  var firstLine = dir === 'V' ? (corner[1] === 'R' ? 'right' : 'left') : (corner[0] === 'B' ? 'bottom' : 'top');
  var side = dir === 'V' ? (corner[0] === 'B' ? 'bottom' : 'top') : (corner[1] === 'R' ? 'right' : 'left');
  return 'One port per ' + line + ', first port on the ' + firstLine + ' ' + line + '; ' +
    (alt ? 'the first cable starts at the ' + side + ', the next at the other end, and so on' : 'every cable starts at the ' + side);
}
function qaBoxBuild() {
  var vp = $('viewport');
  if (!vp) return null;
  var box = document.createElement('div');
  box.className = 'qa-box'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Quick add');
  box.innerHTML = '<div class="qa-h"><b>Quick add</b><span class="qa-sub"></span></div>' +
    '<div class="seg qa-seg" role="group" aria-label="One port per"><button data-dir="V" title="Each column of cabinets gets its own port">Port per column</button>' +
    '<button data-dir="H" title="Each row of cabinets gets its own port">Port per row</button></div>' +
    '<div class="qa-cap">Every cable starts on the same side</div><div class="pattern-pad qa-pad" data-alt="0"></div>' +
    '<div class="qa-cap">Cables alternate sides</div><div class="pattern-pad qa-pad" data-alt="1"></div>' +
    '<div class="qa-info"></div>' +
    '<div class="row"><button class="qa-cancel" title="Discard (Esc)">Cancel</button><button class="primary qa-ok" title="Add these cabinets (Enter)">OK</button></div>';
  // the box is on the canvas: keep its clicks away from the canvas's pan / select handlers
  ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'contextmenu', 'dblclick'].forEach(function (ev) { box.addEventListener(ev, function (e) { e.stopPropagation(); }); });
  Array.prototype.forEach.call(box.querySelectorAll('.qa-seg button'), function (b) {
    b.onclick = function () {
      if (qa.opts.dir === b.dataset.dir) return;
      qa.opts.dir = b.dataset.dir; qaSaveOpts();
      log('quick_add_pattern', { per: qa.opts.dir === 'V' ? 'column' : 'row', corner: qa.opts.corner, alternate: qa.opts.alt });
      renderQuickAdd();
    };
  });
  box.querySelector('.qa-cancel').onclick = function () { setQuickAdd(false, 'Cancel button'); };
  box.querySelector('.qa-ok').onclick = function () { qaOk(); };
  vp.appendChild(box);
  return box;
}
function qaBoxUpdate(plan) {
  var box = qa.box && qa.box.parentNode ? qa.box : (qa.box = qaBoxBuild());
  if (!box) return;
  box.hidden = false;
  var o = qa.opts, pn = qaPanel();
  box.querySelector('.qa-sub').textContent = pn ? pn.name + ' · ' + pn.w + '×' + pn.h : 'no cabinet type';
  Array.prototype.forEach.call(box.querySelectorAll('.qa-seg button'), function (b) { b.classList.toggle('on', b.dataset.dir === o.dir); });
  if (qa.padDir !== o.dir) {                 // the icons depend on columns / rows
    qa.padDir = o.dir;
    Array.prototype.forEach.call(box.querySelectorAll('.qa-pad'), function (pad) {
      var alt = pad.dataset.alt === '1';
      pad.innerHTML = '';
      ['TL', 'TR', 'BL', 'BR'].forEach(function (corner) {
        var b = document.createElement('button');
        b.title = qaPatternTitle(corner, o.dir, alt); b.innerHTML = qaIcon(corner, o.dir, alt);
        b.dataset.corner = corner; b.dataset.alt = alt ? '1' : '0';
        b.onclick = function () {
          qa.opts.corner = corner; qa.opts.alt = alt; qaSaveOpts();
          log('quick_add_pattern', { per: qa.opts.dir === 'V' ? 'column' : 'row', corner: corner, alternate: alt });
          renderQuickAdd();
        };
        pad.appendChild(b);
      });
    });
  }
  Array.prototype.forEach.call(box.querySelectorAll('.qa-pad button'), function (b) {
    var on = b.dataset.corner === o.corner && (b.dataset.alt === '1') === o.alt;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
  var h = '', line = o.dir === 'V' ? 'column' : 'row';
  if (!qa.at) h = '<div>Click the canvas to place the first cabinet (the wall’s top-left). It snaps like Self draw; hold ' + keysText('Alt') + ' to place freely.</div>' +
    '<div class="hint">First port: ' + esc(portLabel(ui.mSender || 0, ui.mPort || 0)) + ' (Tab / Shift+Tab or the port list to change it)</div>';
  else if (plan) {
    var first = plan.runs[0], last = plan.runs[plan.runs.length - 1];
    h = '<div><b>' + plan.cols + ' × ' + plan.rows + '</b> · ' + fmt(plan.cols * plan.rows) + ' cabinet' + (plan.cols * plan.rows === 1 ? '' : 's') +
      ' · ' + fmt(plan.cols * plan.pn.w) + ' × ' + fmt(plan.rows * plan.pn.h) + ' px</div>' +
      '<div>' + plan.runs.length + ' port' + (plan.runs.length === 1 ? '' : 's') + ': <b style="color:' + portColor(first.sender, first.port) + '">' + esc(portLabel(first.sender, first.port)) + '</b>' +
      (plan.runs.length > 1 ? ' → <b style="color:' + portColor(last.sender, last.port) + '">' + esc(portLabel(last.sender, last.port)) + '</b>' : '') + '</div>' +
      '<div>Wiring: ' + (plan.auto ? 'Auto (one ' + line + ' per port)' : 'Manual — ' + (plan.cut ? 'a ' + line + ' is bigger than one port, so it is split' : 'the cables alternate sides')) + '</div>';
    if (plan.err) h += '<div class="bad">' + esc(plan.err) + '</div>';
    if (plan.out) h += '<div class="bad">Needs ' + plan.runs.length + ' ports, only ' + plan.left + ' left from ' + esc(portLabel(first.sender, first.port)) + ' — add a processor (or an output card), or make it smaller</div>';
    if (plan.covers.length) h += '<div class="warn">Covers ' + plan.covers.length + ' cabinet' + (plan.covers.length === 1 ? '' : 's') + ' already here — OK asks before replacing them</div>';
    if (plan.shared.length) h += '<div class="warn">Already in use: ' + esc(plan.shared.slice(0, 3).join(', ')) + (plan.shared.length > 3 ? ' +' + (plan.shared.length - 3) + ' more' : '') + '</div>';
    h += '<div class="hint">Drag the right, bottom or corner handle to grow it; drag the wall to move it. Arrow keys: a column / row more or less.</div>';
  }
  box.querySelector('.qa-info').innerHTML = h;
  box.querySelector('.qa-ok').disabled = !qa.at || !plan || !!plan.err || !!plan.out;
}
function qaBadgeText() {
  return 'Quick add from ' + portLabel(ui.mSender || 0, ui.mPort || 0) + (qa.at ? ' — drag the handles to grow, Enter = OK, Esc = Cancel' : ' — click to place the first cabinet, Esc to cancel');
}

// ------------------------------------------------------------------ preview (called from renderCanvas)
function renderQuickAdd() {
  var on = ui.tool === 'quick', btn = $('btnQuickAdd'), svg = $('svg');
  if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-pressed', String(on)); }
  var old = svg && svg.querySelector('#qaLayer'); if (old) old.remove();
  if (!on) {
    if (qa.at || qa.hover) { log('quick_add_cancel', { via: 'another tool', discarded: qa.at ? qa.cols + '×' + qa.rows : 'nothing placed' }); qaReset(); }
    if (qa.box) qa.box.hidden = true;
    return;
  }
  var plan = qaPlan();
  qaBoxUpdate(plan);
  if (!svg || !plan || !ui.pxPerUnit) return;
  var u = 1 / ui.pxPerUnit, ppu = ui.pxPerUnit, g = el('g', { id: 'qaLayer', 'pointer-events': 'none' }, svg);
  var mid = function (c) { return (c.x + c.w / 2) + ',' + (c.y + c.h / 2); };
  plan.runs.forEach(function (run) {         // the wall in its port colours (red past the last port)
    var col = run.ok ? portColor(run.sender, run.port) : 'var(--danger)';
    run.cells.forEach(function (c) {
      el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, fill: col, 'fill-opacity': run.ok ? 0.6 : 0.3, stroke: 'currentColor', 'stroke-opacity': 0.45, 'stroke-width': u }, g);
    });
  });
  plan.covers.forEach(function (cv) {        // panels already there that OK would replace
    el('rect', { x: cv.c.x, y: cv.c.y, width: cv.c.w, height: cv.c.h, fill: 'var(--danger)', 'fill-opacity': 0.25, stroke: 'var(--danger)',
      'stroke-width': 1.5 * u, 'stroke-dasharray': (4 * u) + ' ' + (3 * u) }, g);
  });
  var oneCard = plan.runs.every(function (r) { return r.sender === plan.runs[0].sender; });
  plan.runs.forEach(function (run) {         // each port's cable, start dot and name
    var f = run.cells[0];
    if (run.cells.length > 1) el('polyline', { class: 'wire', points: run.cells.map(mid).join(' '), 'stroke-width': 1.6 * u, 'marker-end': 'url(#arrow)' }, g);
    el('circle', { class: 'wire-start', cx: f.x + f.w / 2, cy: f.y + f.h / 2, r: clamp(Math.min(f.w, f.h) * ppu * 0.07, 2, 5) * u }, g);
    var txt = oneCard ? 'P' + (run.port + 1) : portLabel(run.sender, run.port), fs = Math.min(f.h * ppu * 0.3, f.w * ppu * 0.9 / (txt.length * 0.62), 14);
    if (fs >= 7) el('text', { x: f.x + f.w / 2, y: f.y + Math.min(f.h * 0.3, f.h / 2) + fs * 0.35 * u, 'font-size': fs * u, 'font-weight': 700, 'text-anchor': 'middle',
      fill: '#111', stroke: '#fff', 'stroke-opacity': 0.75, 'stroke-width': 3 * u, 'paint-order': 'stroke' }, g).textContent = txt;
  });
  var b = qaBounds(plan), tagAt, tag;
  if (qa.at) {
    el('rect', { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0, fill: 'none', stroke: 'var(--sel)', 'stroke-width': 2 * u }, g);
    var hs = qaHandles(plan), glyph = { e: 'M-4.5,-4 L-0.5,0 L-4.5,4 M0.5,-4 L4.5,0 L0.5,4', s: 'M-4,-2 L0,2 L4,-2', se: 'M-3.5,-3.5 L3.5,3.5 M3.5,-1 L3.5,3.5 L-1,3.5' };
    Object.keys(hs).forEach(function (h) {  // drawn in screen pixels (scale u)
      var hg = el('g', { transform: 'translate(' + hs[h].x + ',' + hs[h].y + ') scale(' + u + ')' }, g);
      el('circle', { r: 8.5, fill: 'var(--accent)', stroke: 'var(--panel)', 'stroke-width': 2 }, hg);
      el('path', { d: glyph[h], fill: 'none', stroke: 'var(--accent-ink)', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, hg);
    });
    var n = plan.cols * plan.rows;
    tag = plan.cols + ' × ' + plan.rows + ' · ' + n + ' cabinet' + (n === 1 ? '' : 's') + ' · ' + plan.runs.length + ' port' + (plan.runs.length === 1 ? '' : 's') + (plan.out ? ' · out of ports' : '');
    // near the pointer while dragging (like Self draw's block), else above the wall
    tagAt = qa.drag && qa.drag.moved && qa.drag.pt && qa.drag.h !== 'move' ? { x: qa.drag.pt.x + 16 * u, y: qa.drag.pt.y + 26 * u } : { x: b.x0, y: b.y0 - 6 * u };
  } else { tag = plan.at.x + ', ' + plan.at.y + ' px'; tagAt = { x: b.x0, y: b.y0 - 6 * u }; }
  var fs2 = 11 * u, bg = el('rect', { x: tagAt.x - 3 * u, y: tagAt.y - fs2, height: fs2 * 1.35, width: tag.length * fs2 * 0.56 + 6 * u, rx: 2 * u, fill: 'var(--panel)', opacity: 0.9 }, g);
  var t = el('text', { x: tagAt.x, y: tagAt.y, 'font-size': fs2, fill: plan.err || plan.out ? 'var(--danger)' : 'currentColor' }, g);
  t.textContent = tag;
  try { bg.setAttribute('width', t.getBBox().width + 6 * u); } catch (err) { /* not laid out yet */ }
}
