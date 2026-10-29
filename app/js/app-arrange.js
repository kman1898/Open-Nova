// app-arrange.js - arranging sections on the canvas (Unico / VMP "Align & Arrange", our take):
//   - several sections selected at once: Ctrl+click a section (outside Manual wiring, where
//     Ctrl+click selects panels), Ctrl+A = every section on this screen; dragging one of them
//     moves them all; Esc clears;
//   - align left / right / top / bottom / centres, distribute horizontally / vertically (equal gaps);
//   - lock a section (s.locked, saved in the project): it can't be dragged, aligned or distributed;
//   - grid: show it, snap moved sections to it (step in canvas pixels), remembered in this browser;
//   - copy / paste sections (Ctrl+C / Ctrl+V) onto free ports.
// Undo / redo: every arrange step is one commit.
//   - groups (Ctrl+G / Ctrl+Shift+G, Arrange ▾, right-click; data and actions in app-sections.js): a click selects
//     the whole group, Ctrl+click adds / removes it as a whole, copy / paste makes a new group.
// Owns: ui.selSecs, ui.grid, GRID_KEY, GRID_STEPS, arrangeTargets, arrangeToggle, arrangeSelectAll,
// arrangeClear, moveBoundsTo, alignSections, distributeSections, toggleLock, gridSnapXY, copySections,
// pasteSections (ui.clip), zoomOneToOne, zoomToSelection, renderRulers, selectSamePanel, swapPanels,
// renderPanelCard, bindPanelCard, arrangeMenuItems,
// openArrangeMenu, renderGrid, bindArrange.
// Depends on: app-core (P, ui, $, log, commit, toast), app-geometry (screenBounds, visibleScreens),
// app-capacity (screenById), app-render (renderAll, el), app-context-menu (openMenu), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var GRID_KEY = 'opennova.grid';
var GRID_STEPS = [8, 16, 32, 64, 96, 128, 192, 256];

// The sections an arrange command works on: the multi-selection plus the selected section,
// on the screen being shown, in canvas order.
function arrangeTargets() {
  var ids = new Set(ui.selSecs || []); if (ui.sel) ids.add(ui.sel);
  return visibleScreens().filter(function (s) { return ids.has(s.id); });
}
// A group (app-sections.js) is added / removed as a whole.
function arrangeToggle(s) {
  ui.selSecs = ui.selSecs || new Set();
  if (ui.sel && ui.sel !== s.id) groupSelIds(screenById(ui.sel) || s).forEach(function (id) { ui.selSecs.add(id); });
  var ids = groupSelIds(s);
  if (ui.selSecs.has(s.id) && ui.selSecs.size > ids.length) {
    ids.forEach(function (id) { ui.selSecs.delete(id); });
    if (ids.indexOf(ui.sel) >= 0) ui.sel = Array.from(ui.selSecs)[0];
  } else { ids.forEach(function (id) { ui.selSecs.add(id); }); ui.sel = s.id; }
  log('select_sections', { sections: arrangeTargets().map(function (x) { return x.name; }) });
  renderAll();
}
function arrangeSelectAll() {
  var vis = visibleScreens(); if (!vis.length) return;
  ui.selSecs = new Set(vis.map(function (s) { return s.id; }));
  if (!ui.sel || !ui.selSecs.has(ui.sel)) ui.sel = vis[0].id;
  log('select_sections', { sections: vis.length, all: true });
  renderAll();
}
function arrangeClear() { if (ui.selSecs && ui.selSecs.size) { ui.selSecs = new Set(); return true; } return false; }

// Move section s so its drawn bounds start at (bx, by).
function moveBoundsTo(s, bx, by) {
  var b = screenBounds(s);
  s.x = Math.max(0, Math.round(s.x + (bx - b.x))); s.y = Math.max(0, Math.round(s.y + (by - b.y)));
}
// edge: 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'. Locked sections stay put but
// still count as the reference.
function alignSections(edge) {
  var t = arrangeTargets();
  if (t.length < 2) return toast('Select more cabinets (Ctrl+click) to align them');
  var bs = t.map(screenBounds);
  var minX = Math.min.apply(null, bs.map(function (b) { return b.x; })), maxR = Math.max.apply(null, bs.map(function (b) { return b.x + b.w; }));
  var minY = Math.min.apply(null, bs.map(function (b) { return b.y; })), maxB = Math.max.apply(null, bs.map(function (b) { return b.y + b.h; }));
  var cx = (minX + maxR) / 2, cy = (minY + maxB) / 2, moved = 0;
  t.forEach(function (s, i) {
    if (s.locked) return;
    var b = bs[i], nx = b.x, ny = b.y;
    if (edge === 'left') nx = minX; else if (edge === 'right') nx = maxR - b.w;
    else if (edge === 'top') ny = minY; else if (edge === 'bottom') ny = maxB - b.h;
    else if (edge === 'hcenter') nx = Math.round(cx - b.w / 2); else if (edge === 'vcenter') ny = Math.round(cy - b.h / 2);
    if (nx !== b.x || ny !== b.y) { moveBoundsTo(s, nx, ny); moved++; }
  });
  log('align_sections', { edge: edge, sections: t.length, moved: moved, locked: t.filter(function (s) { return s.locked; }).length });
  if (moved) { commit(); renderAll(); }
  toast(moved ? 'Aligned (Ctrl+Z to undo)' : 'Already aligned');
}
// Equal gaps between the sections, the first and last staying where they are.
function distributeSections(axis) {
  var t = arrangeTargets();
  if (t.length < 3) return toast('Select three or more blocks of cabinets (Ctrl+click) to distribute them');
  var horiz = axis === 'h';
  var items = t.map(function (s) { return { s: s, b: screenBounds(s) }; })
    .sort(function (a, c) { return horiz ? a.b.x - c.b.x : a.b.y - c.b.y; });
  var first = items[0].b, last = items[items.length - 1].b;
  var span = horiz ? last.x + last.w - first.x : last.y + last.h - first.y;
  var sizes = items.reduce(function (n, it) { return n + (horiz ? it.b.w : it.b.h); }, 0);
  var gap = (span - sizes) / (items.length - 1), pos = horiz ? first.x : first.y, moved = 0;
  items.forEach(function (it, i) {
    var want = Math.round(pos);
    if (i > 0 && i < items.length - 1 && !it.s.locked) {
      var nx = horiz ? want : it.b.x, ny = horiz ? it.b.y : want;
      if (nx !== it.b.x || ny !== it.b.y) { moveBoundsTo(it.s, nx, ny); moved++; }
    }
    pos += (horiz ? it.b.w : it.b.h) + gap;
  });
  log('distribute_sections', { axis: horiz ? 'horizontal' : 'vertical', sections: t.length, gap: Math.round(gap), moved: moved });
  if (moved) { commit(); renderAll(); }
  toast(moved ? 'Distributed: gaps of ' + Math.round(gap) + ' px (Ctrl+Z to undo)' : 'Already evenly spaced');
}
function toggleLock(list) {
  list = list || arrangeTargets(); if (!list.length) return;
  var to = !list.every(function (s) { return s.locked; });
  list.forEach(function (s) { s.locked = to; });
  log('lock_sections', { sections: list.map(function (s) { return s.name; }), locked: to });
  commit(); renderAll();
  toast((to ? 'Locked ' : 'Unlocked ') + secsLabel(list));
}

// Grid snap of a moving section's drawn top-left (canvas pixels).
function gridSnapXY(s, nx, ny) {
  var st = ui.grid && ui.grid.step || 64, b = screenBounds(s), offX = b.x - s.x, offY = b.y - s.y;
  return { x: Math.round((nx + offX) / st) * st - offX, y: Math.round((ny + offY) / st) * st - offY };
}
function renderGrid(svg, unit) {
  if (!ui.grid || !ui.grid.show) return;
  var st = ui.grid.step || 64, W = P.canvasW, H = P.canvasH, d = '';
  if (st * ui.pxPerUnit < 4) return;   // too dense to draw at this zoom
  for (var x = st; x < W; x += st) d += 'M' + x + ' 0V' + H;
  for (var y = st; y < H; y += st) d += 'M0 ' + y + 'H' + W;
  el('path', { class: 'grid-lines', d: d, 'stroke-width': unit, 'pointer-events': 'none' }, svg);
}

// Copy / paste sections (Ctrl+C / Ctrl+V). The copies keep their shape, blanks and hand wiring
// (moved onto free ports, freshPorts in app-sections.js) and are placed right of the copied group
// on the same screen, or at the same place on another screen.
function copySections() {
  var t = arrangeTargets(); if (!t.length) return false;
  ui.clip = { from: ui.viewScreen, sections: t.map(function (s) { return JSON.parse(JSON.stringify(s)); }) };
  log('copy_sections', { sections: t.map(function (s) { return s.name; }) });
  toast('Copied ' + secsLabel(t) + ' (Ctrl+V to paste)');
  return true;
}
function pasteSections() {
  if (!ui.clip || !ui.clip.sections.length) return false;
  var src = ui.clip.sections, same = ui.clip.from === ui.viewScreen;
  var minX = Infinity, maxR = -Infinity;
  src.forEach(function (s) { var b = screenBounds(s); minX = Math.min(minX, b.x); maxR = Math.max(maxR, b.x + b.w); });
  var dx = same ? maxR - minX : 0, ids = [], ng = {};
  src.forEach(function (s) {
    var d = JSON.parse(JSON.stringify(s)); d.id = uid(); d.name = s.name + ' copy'; d.locked = false;
    d.screenId = ui.viewScreen || d.screenId; d.x = s.x + dx;
    // copied groups become new groups ("Group 1 copy"); cabinets copied without their group are on their own
    var og = groupById(s.group); delete d.group;
    if (og && src.filter(function (x) { return x.group === og.id; }).length > 1) {
      if (!ng[og.id]) { ng[og.id] = { id: uid(), name: og.name + ' copy' }; (P.groups = P.groups || []).push(ng[og.id]); }
      d.group = ng[og.id].id;
    }
    freshPorts(d);
    P.screens.push(d); ids.push(d.id);
  });
  ui.selSecs = new Set(ids); ui.sel = ids[0];
  log('paste_sections', { sections: ids.length, offset: dx, to_screen: (lctById(ui.viewScreen) || {}).name });
  commit(); renderAll();
  toast('Pasted ' + secsLabel(ids.map(screenById)) + ' on free ports (Ctrl+Z to undo)');
  return true;
}

// ------------------------------------------------------------------ zoom keys, rulers
// Ctrl+0: 1:1 (one canvas pixel = one screen pixel), around the view's centre.
function zoomOneToOne() {
  var vp = $('viewport').getBoundingClientRect(), v = ui.view; if (!v || !(vp.width > 0)) return;
  var cx = v.x + v.w / 2, cy = v.y + v.h / 2;
  ui.view = { x: cx - vp.width / 2, y: cy - vp.height / 2, w: vp.width, h: vp.height };
  log('zoom', { to: '1:1' }); renderCanvas(allCells());
}
// Ctrl+D: zoom to the selected panels, else the selected sections (with a margin).
function zoomToSelection() {
  var b = null, grow = function (x, y, w, h) { b = b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x + w), y1: Math.max(b.y1, y + h) } : { x0: x, y0: y, x1: x + w, y1: y + h }; };
  var ps = screenById(ui.selScreen);
  if (ps && ui.selKeys && ui.selKeys.size) cellGeom(ps).forEach(function (g) { if (ui.selKeys.has(g.k)) grow(g.x, g.y, g.w, g.h); });
  else arrangeTargets().forEach(function (s) { var r = screenBounds(s); grow(r.x, r.y, r.w, r.h); });
  if (!b) return toast('Select cabinets first');
  var m = Math.max(b.x1 - b.x0, b.y1 - b.y0) * 0.08 + 8;
  ui.view = { x: b.x0 - m, y: b.y0 - m, w: b.x1 - b.x0 + 2 * m, h: b.y1 - b.y0 + 2 * m };
  log('zoom', { to: 'selection' }); renderCanvas(allCells());
}
// Rulers along the top and left edges of the view, in canvas pixels; ticks at a round step ~80 screen px apart.
function renderRulers(svg, unit) {
  if (!ui.grid || !ui.grid.rulers) return;
  var vb = svg.getAttribute('viewBox').split(' ').map(Number), vx = vb[0], vy = vb[1], w = vb[2], h = vb[3];
  var raw = 80 * unit, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), step = [1, 2, 5, 10].map(function (k) { return k * mag; }).filter(function (v) { return v >= raw; })[0] || 10 * mag;
  var pro = typeof proLook === 'function' && proLook();   // pro look: the gallery's rulers (20 px, minor ticks, an edge line, a corner box)
  var th = (pro ? 20 : 18) * unit, tw = pro ? 22 * unit : th * 1.6, g = el('g', { class: 'rulers', 'pointer-events': 'none' }, svg), d = '', dm = '';
  el('rect', { class: 'ruler-bg', x: vx, y: vy, width: w, height: th }, g);
  el('rect', { class: 'ruler-bg', x: vx, y: vy, width: tw, height: h }, g);
  var fs = (pro ? 9 : 10) * unit;
  for (var x = Math.ceil(vx / step) * step; x < vx + w; x += step) {
    d += pro ? 'M' + x + ',' + (vy + th) + 'v' + (-th * 0.55) : 'M' + x + ',' + vy + 'v' + th * 0.45;
    if (pro) for (var mx = 1; mx < 4; mx++) dm += 'M' + (x + step * mx / 4) + ',' + (vy + th) + 'v' + (-th * 0.22);
    el('text', { class: 'ruler-t', x: x + (pro ? 3 : 2) * unit, y: vy + th * (pro ? 0.5 : 0.85), 'font-size': fs }, g).textContent = Math.round(x);
  }
  for (var y = Math.ceil(vy / step) * step; y < vy + h; y += step) {
    d += pro ? 'M' + (vx + tw) + ',' + y + 'h' + (-tw * 0.5) : 'M' + vx + ',' + y + 'h' + th * 0.45;
    if (pro) for (var my = 1; my < 4; my++) dm += 'M' + (vx + tw) + ',' + (y + step * my / 4) + 'h' + (-tw * 0.2);
    if (pro) el('text', { class: 'ruler-t', x: vx + tw * 0.55, y: y + 3 * unit, 'font-size': fs, transform: 'rotate(-90 ' + (vx + tw * 0.55) + ' ' + (y + 3 * unit) + ')', 'text-anchor': 'end' }, g).textContent = Math.round(y);
    else el('text', { class: 'ruler-t', x: vx + 2 * unit, y: y - 2 * unit, 'font-size': fs }, g).textContent = Math.round(y);
  }
  el('path', { class: 'ruler-tick', d: d, 'stroke-width': unit }, g);
  if (pro) {
    el('path', { class: 'ruler-tick minor', d: dm, 'stroke-width': unit }, g);
    el('path', { class: 'ruler-edge', d: 'M' + vx + ',' + (vy + th) + 'h' + w + 'M' + (vx + tw) + ',' + vy + 'v' + h, 'stroke-width': unit }, g);
    el('rect', { class: 'ruler-bg corner', x: vx, y: vy, width: tw, height: th }, g);
  }
}

// ------------------------------------------------------------------ panel-level tools
// Every section on this screen that uses the same panel as s -> the multi-selection.
function selectSamePanel(s) {
  var pid = s.panelId, list = visibleScreens().filter(function (x) { return !x.regions && x.panelId === pid; });
  if (!list.length) list = [s];
  ui.selSecs = new Set(list.map(function (x) { return x.id; })); ui.sel = s.id;
  log('select_same_panel', { panel: panelOf(s).name, sections: list.length });
  renderAll(); toast(secsLabel(list) + ' of type ' + panelOf(s).name);
}
// Swap two wired panels' places in their chains (Unico's "Swap"): each takes the other's port and cable position.
// Refused when a port would go over its capacity.
function swapPanels(s, keys) {
  ensureManual(s);
  var a = s.manual[keys[0]], b = s.manual[keys[1]];
  if (!a || !b) return toast('Both cabinets must be wired to swap them');
  var before = JSON.stringify(s.manual);
  s.manual[keys[0]] = b; s.manual[keys[1]] = a;
  var use = portUsage(allCells()), over = [a, b].filter(function (q) { var u = use[q.sender + ':' + q.port]; return u && u.load > u.cap; });
  if (over.length) {
    s.manual = JSON.parse(before);
    log('swap_panels', { section: s.name, refused: 'over capacity' });
    return toast('Can’t swap: ' + portLabel(over[0].sender, over[0].port) + ' would go over its capacity');
  }
  log('swap_panels', { section: s.name, a: portLabel(a.sender, a.port) + ' #' + (a.connect + 1), b: portLabel(b.sender, b.port) + ' #' + (b.connect + 1) });
  ui.selKeys = new Set(); commit(); renderAll();
  toast('Swapped the two cabinets in their chains (Ctrl+Z to undo)');
}
// The Panel card: X / Y of one selected panel of a free-form section (cabinets placed freely), LCT's table idea.
function renderPanelCard() {
  var card = $('cardPanelXY'); if (!card) return;
  var s = screenById(ui.selScreen), k = s && ui.selKeys && ui.selKeys.size === 1 ? Array.from(ui.selKeys)[0] : null;
  var g = s && s.regions && k != null ? s.regions[+k] : null;
  card.hidden = !g;
  if (!g) return;
  $('pxTitle').textContent = (groupOf(s) ? groupOf(s).name + ' · ' : '') + 'no. ' + (+k + 1);
  if (document.activeElement !== $('pxX')) $('pxX').value = s.x + g.dx;
  if (document.activeElement !== $('pxY')) $('pxY').value = s.y + g.dy;
  $('pxSize').textContent = g.w + ' × ' + g.h + ' px';
}
function bindPanelCard() {
  var set = function () {
    var s = screenById(ui.selScreen), k = s && ui.selKeys && ui.selKeys.size === 1 ? Array.from(ui.selKeys)[0] : null;
    var g = s && s.regions && k != null ? s.regions[+k] : null; if (!g) return;
    var nx = int($('pxX').value, s.x + g.dx), ny = int($('pxY').value, s.y + g.dy);
    if (nx < 0 || ny < 0) return toast('X and Y can’t be negative');
    g.dx = nx - s.x; g.dy = ny - s.y;
    log('panel_xy', { section: s.name, panel: +k + 1, to: nx + ',' + ny });
    commit(); renderAll();
  };
  $('pxX').onchange = set; $('pxY').onchange = set;
}

// Menu entries (toolbar ▾ and the canvas right-click menu).
function arrangeMenuItems() {
  var t = arrangeTargets(), n = t.length, locked = n && t.every(function (s) { return s.locked; });
  var g0 = n && groupOf(t[0]), oneGroup = g0 && groupMembers(g0).length === n && t.every(function (s) { return s.group === g0.id; });
  return [
    { header: n > 1 ? 'Arrange ' + secsLabel(t) : 'Arrange' },
    { label: 'Align left', disabled: n < 2, act: function () { alignSections('left'); } },
    { label: 'Align right', disabled: n < 2, act: function () { alignSections('right'); } },
    { label: 'Align top', disabled: n < 2, act: function () { alignSections('top'); } },
    { label: 'Align bottom', disabled: n < 2, act: function () { alignSections('bottom'); } },
    { label: 'Align centres (horizontal)', disabled: n < 2, act: function () { alignSections('hcenter'); } },
    { label: 'Align centres (vertical)', disabled: n < 2, act: function () { alignSections('vcenter'); } },
    { sep: true },
    { label: 'Distribute horizontally', disabled: n < 3, act: function () { distributeSections('h'); } },
    { label: 'Distribute vertically', disabled: n < 3, act: function () { distributeSections('v'); } },
    { sep: true },
    { label: locked ? 'Unlock' : 'Lock', disabled: !n, act: function () { toggleLock(t); } },
    { sep: true },
    { label: 'Group', key: 'Ctrl+G', disabled: !n || !!oneGroup, act: function () { groupSections(t); } },
    { label: 'Ungroup', key: 'Ctrl+Shift+G', disabled: !t.some(function (s) { return s.group; }), act: function () { ungroupSections(t); } },
    { sep: true },
    { label: 'Copy', key: 'Ctrl+C', disabled: !n, act: copySections },
    { label: 'Paste', key: 'Ctrl+V', disabled: !(ui.clip && ui.clip.sections.length), act: pasteSections },
    { label: 'Select all cabinets', key: 'Ctrl+A', act: arrangeSelectAll }
  ];
}
function openArrangeMenu(btn) {
  var r = btn.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, arrangeMenuItems());
}

function bindArrange() {
  ui.selSecs = new Set();
  ui.grid = { show: false, snap: false, step: 64, rulers: document.documentElement.dataset.look === 'pro' };   // the pro look shows rulers until turned off
  try { var g = JSON.parse(localStorage.getItem(GRID_KEY) || 'null'); if (g) Object.assign(ui.grid, g); } catch (e) { /* storage unavailable */ }
  var save = function () { try { localStorage.setItem(GRID_KEY, JSON.stringify(ui.grid)); } catch (e) { /* storage unavailable */ } };
  $('showGrid').checked = !!ui.grid.show; $('snapGrid').checked = !!ui.grid.snap;
  $('gridStep').innerHTML = GRID_STEPS.map(function (v) { return '<option value="' + v + '"' + (v === ui.grid.step ? ' selected' : '') + '>' + v + ' px</option>'; }).join('');
  $('showGrid').onchange = function () { ui.grid.show = this.checked; save(); log('grid', { show: ui.grid.show }); renderAll(); };
  $('snapGrid').onchange = function () { ui.grid.snap = this.checked; save(); log('grid', { snap: ui.grid.snap }); };
  $('gridStep').onchange = function () { ui.grid.step = +this.value; save(); log('grid', { step: ui.grid.step }); renderAll(); };
  $('btnArrange').onclick = function (e) { e.stopPropagation(); openArrangeMenu(this); };
  $('showRulers').checked = !!ui.grid.rulers;
  $('showRulers').onchange = function () { ui.grid.rulers = this.checked; save(); log('rulers', { show: ui.grid.rulers }); renderAll(); };
  bindPanelCard();
  document.addEventListener('keydown', function (e) {
    if (ui.tab !== 'layout') return;
    var a = document.activeElement, typing = a && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
    if (typing || (e.altKey)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); zoomOneToOne(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); zoomToSelection(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
      var s = screenById(ui.sel);
      if (s && s.wiring.mode === 'manual') return;   // Manual wiring keeps Ctrl+A for its own panels (none today)
      e.preventDefault(); arrangeSelectAll();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C') && !(ui.selKeys && ui.selKeys.size)) {
      if (copySections()) e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      if (pasteSections()) e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {   // Group / Ungroup, as in Unico
      e.preventDefault(); if (e.shiftKey) ungroupSections(); else groupSections();
    } else if (e.key === 'Escape' && arrangeClear()) renderAll();
  });
}
