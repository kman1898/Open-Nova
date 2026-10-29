// app-selfdraw.js - Self draw: place panels by hand onto the active port, like Tessera's
// "Add Fixtures From Library". Pick a panel type (Panel library, ui.drawPanelId), then on the
// canvas:
//   click            one panel at the ghost (its top-left follows the pointer, snapped)
//   click + drag     a block that grows toward the pointer; the cable starts at the panel you
//                    pressed on and snakes in rows if you drag mostly sideways, in columns if
//                    mostly up/down — the ghost and its cable path update live
//   Shift + click    start a new string: the next free port on the active sending card
//   R                rotate the panel 90°        Alt   place freely (no snapping)
//   Esc              finish (leave Self draw)
// Panels are appended to the active port's cable (ui.mSender / ui.mPort). A panel that would
// push the port over its capacity is not placed (drawing stops there, with a warning), nor is
// one on top of an existing panel. Afterwards the pattern pad re-orders the port (see
// repatternActivePort in app-manual-wiring.js).
// Self-drawn panels live in one freeform section per LCT screen ("Drawn", kind 'complex',
// drawn: true, origin 0,0 so each region's dx/dy is its canvas position). It exports through
// mergeSections, so aligned panels become a Standard grid with spacer blanks, like LCT's own.
// Depends on: app-core, app-log, app-capacity, app-geometry, app-manual-wiring, app-render.
// Hooks: bindCanvas (app-canvas-input) calls selfDrawDown/Move/Up/Hover/Leave while
// ui.tool === 'draw'; renderCanvas (app-render) calls sdPaint to draw the ghost.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

var SD_SNAP_PX = 10;           // screen px within which the ghost snaps to a panel edge
var sd = { hover: null, drag: null, plan: null };

function setSelfDraw(on) {
  on = !!on;
  if (on === (ui.tool === 'draw')) return;
  ui.tool = on ? 'draw' : null;
  sd.hover = null; sd.drag = null; sd.plan = null;
  if (on) { ui.selKeys = new Set(); ui.selScreen = null; }
  var vp = $('viewport'); if (vp) vp.style.cursor = on ? 'crosshair' : '';
  log('self_draw', { on: on, panel: on ? sdPanel().name : undefined, port: on ? portLabel(ui.mSender || 0, ui.mPort || 0) : undefined });
  renderAll();
}

// The panel being drawn (Panel library selection), turned 90° with R.
function sdPanel() {
  var p = P.panels.find(function (x) { return x.id === ui.drawPanelId; }) || P.panels[0] || { id: null, name: 'Cabinet', w: 128, h: 128 };
  return ui.drawRot ? { id: p.id, name: p.name + ' (90°)', w: p.h, h: p.w } : { id: p.id, name: p.name, w: p.w, h: p.h };
}

// The "Drawn" section of an LCT screen (created on first use).
function drawnSection(lctId, create) {
  var s = P.screens.find(function (x) { return x.drawn && x.screenId === lctId; });
  if (s || !create) return s || null;
  s = {
    id: uid(), kind: 'complex', drawn: true, complexType: SCR.TYPE.Complex, name: 'Drawn', screenId: lctId, x: 0, y: 0,
    panelId: sdPanel().id, holes: {}, manual: {}, override: {}, raw: {}, regions: [],
    wiring: { mode: 'manual', corner: 'TL', dir: 'V', pattern: 'serpentine', split: 'lines', max: 0, restart: 'continue', sender: ui.mSender || 0, port: ui.mPort || 0 },
    virtualMode: 0
  };
  P.screens.push(s);
  return s;
}

// Everything already on this screen that a new panel must not overlap (blanks don't count).
function sdOccupied(cellsBy) {
  var out = [];
  visibleScreens().forEach(function (s) { cellsBy[s.id].forEach(function (c) { if (!c.hole) out.push(c); }); });
  return out;
}

// Snap a cabinet's top-left to a neighbour's edge or the canvas edge when one is within SD_SNAP_PX on
// screen; anywhere else it goes where it's dropped — no cabinet-size grid from the corner (user, 2026-10-12: "why do
// you have it snapping when nothing is on screen?"). Alt = free.
function sdSnap(x, y, pw, ph, cells, free) {
  if (free) return { x: Math.round(x), y: Math.round(y) };
  var thr = SD_SNAP_PX / (ui.pxPerUnit || 1);
  var best = function (v, size, cands) {
    var pick = null;
    cands.forEach(function (c) { var d = Math.abs(c - v); if (d <= thr && (!pick || d < pick.d)) pick = { d: d, v: c }; });
    return pick ? pick.v : Math.round(v);
  };
  var xs = [0, P.canvasW - pw], ys = [0, P.canvasH - ph];
  cells.forEach(function (c) { xs.push(c.x + c.w, c.x - pw, c.x, c.x + c.w - pw); ys.push(c.y + c.h, c.y - ph, c.y, c.y + c.h - ph); });
  return { x: Math.max(0, best(x, pw, xs)), y: Math.max(0, best(y, ph, ys)) };
}

// Where the active port's cable currently ends on this screen (for the dashed link).
function sdPortTail(cellsBy) {
  var cp = curPort(), best = null, secs = visibleScreens();
  secs.forEach(function (s, si) {
    cellsBy[s.id].forEach(function (c) {
      if (c.sender === cp.sender && c.port === cp.port && (!best || si > best.si || (si === best.si && c.connect > best.c.connect))) best = { si: si, c: c };
    });
  });
  return best && best.c;
}

// The block for anchor a (top-left of the first panel) and pointer p: panel positions in cable
// order, each with a state: ok | occupied | full | outside, plus a summary.
function sdPlanBlock(a, p, pw, ph, cellsBy) {
  var xdir = p.x >= a.x ? 1 : -1, ydir = p.y >= a.y ? 1 : -1;
  var cols = xdir > 0 ? Math.floor((p.x - a.x) / pw) + 1 : Math.ceil((a.x - p.x) / pw) + 1;
  var rows = ydir > 0 ? Math.floor((p.y - a.y) / ph) + 1 : Math.ceil((a.y - p.y) / ph) + 1;
  cols = clamp(cols, 1, 255); rows = clamp(rows, 1, 255);
  // follow the drag: mostly sideways -> rows, mostly up/down -> columns (in panel units)
  var byRows = rows === 1 || (cols > 1 && Math.abs(p.x - (a.x + pw / 2)) / pw >= Math.abs(p.y - (a.y + ph / 2)) / ph);
  var order = [];
  var nLines = byRows ? rows : cols, len = byRows ? cols : rows;
  for (var li = 0; li < nLines; li++) for (var j = 0; j < len; j++) {
    var jj = li % 2 ? len - 1 - j : j;          // serpentine
    var ci = byRows ? jj : li, ri = byRows ? li : jj;
    order.push({ x: a.x + xdir * ci * pw, y: a.y + ydir * ri * ph, w: pw, h: ph });
  }
  return sdCheck(order, cellsBy, { cols: cols, rows: rows, byRows: byRows });
}

// Mark each planned panel ok / occupied / outside / full (capacity, card) in cable order.
function sdCheck(order, cellsBy, info) {
  var occ = sdOccupied(cellsBy), cp = curPort(), bad = cardProblem(cp), rect = null, stopped = false;
  var use = portUsage(cellsBy)[cp.sender + ':' + cp.port];
  rect = use ? use.rect : null;
  var nOk = 0, reason = bad || '';
  order.forEach(function (g) {
    if (g.x < 0 || g.y < 0 || g.x + g.w > 65535 || g.y + g.h > 65535) { g.state = 'outside'; return; }
    if (occ.some(function (c) { return g.x < c.x + c.w && g.x + g.w > c.x && g.y < c.y + c.h && g.y + g.h > c.y; })) { g.state = 'occupied'; return; }
    if (bad || stopped) { g.state = 'full'; return; }
    var next = rectUnion(rect, rectOf(g));
    if (rectArea(next) > portCap(next)) {
      g.state = 'full'; stopped = true;
      reason = portLabel(cp.sender, cp.port) + ' is full (' + fmt(rectArea(next)) + ' > ' + fmt(portCap(next)) + ' px) — Shift+click for a new string, or pick another port';
      return;
    }
    rect = next; g.state = 'ok'; nOk++;
  });
  info.order = order; info.ok = nOk; info.reason = reason; info.rect = rect;
  info.pct = rect ? Math.round(rectArea(rect) / Math.max(1, portCap(rect)) * 100) : 0;
  return info;
}

// Put the plan's ok panels onto the active port in the screen's Drawn section.
function sdPlace(plan) {
  var cp = curPort(), place = plan.order.filter(function (g) { return g.state === 'ok'; });
  var skipped = plan.order.length - place.length;
  if (!place.length) {
    log('self_draw_place', { placed: 0, refused: plan.order.length, why: plan.reason || 'occupied' });
    return toast(plan.reason || 'There is already a cabinet there');
  }
  var s = drawnSection(ui.viewScreen, true), n0 = portKeys(s, cp.sender, cp.port).length;
  place.forEach(function (g, i) {
    var k = String(s.regions.length);
    s.regions.push(ui.drawRot ? { dx: g.x - s.x, dy: g.y - s.y, w: g.w, h: g.h, rot: 90 }   // drawn turned (R): angle kept (app-screenfit.js)
      : { dx: g.x - s.x, dy: g.y - s.y, w: g.w, h: g.h });
    s.manual[k] = { sender: cp.sender, port: cp.port, connect: n0 + i };
  });
  ui.sel = s.id;
  log('self_draw_place', { port: portLabel(cp.sender, cp.port), placed: place.length, refused: skipped, block: plan.cols + '×' + plan.rows,
    path: plan.byRows ? 'rows' : 'columns', at: place[0].x + ',' + place[0].y, panel: sdPanel().name, why: skipped ? plan.reason || 'occupied' : undefined });
  commit(); renderAll();
  if (skipped) toast(plan.reason || (skipped + ' position(s) already had a cabinet'));
}

// Remove drawn panels (keys of a Drawn section); later regions move up one key.
function sdDeletePanels(s, keys) {
  sdDropPanels(s, keys);
  log('self_draw_delete', { section: s.name, deleted: keys.length, left: s.regions.length });
  if (!s.regions.length) { P.screens = P.screens.filter(function (x) { return x !== s; }); if (ui.sel === s.id) ui.sel = null; }
  ui.selKeys = new Set();
  commit(); renderAll();
}
// The data part of sdDeletePanels (also used by removeProcessor): no log, commit or render.
function sdDropPanels(s, keys) {
  var del = {}; keys.forEach(function (k) { del[k] = 1; });
  var map = {}, regions = [], n = 0;
  s.regions.forEach(function (g, i) { if (!del[String(i)]) { map[String(i)] = String(n++); regions.push(g); } });
  ['manual', 'holes', 'raw'].forEach(function (f) {
    var o = {}; Object.keys(s[f] || {}).forEach(function (k) { if (map[k] != null) o[map[k]] = s[f][k]; }); s[f] = o;
  });
  s.regions = regions;
  var seen = {}; Object.keys(s.manual).forEach(function (k) { var a = s.manual[k]; seen[a.sender + ':' + a.port] = a; });
  Object.keys(seen).forEach(function (pk) { renumber(s, seen[pk].sender, seen[pk].port); });
}

// ------------------------------------------------------------------ pointer (from bindCanvas)
function sdPoint(e) {
  var p = svgPoint(e), pn = sdPanel();
  return { raw: p, snap: sdSnap(p.x, p.y, pn.w, pn.h, sdOccupied(allCells()), e.altKey) };
}
function selfDrawHover(e) {
  if (sd.drag) return;
  var q = sdPoint(e), pn = sdPanel();
  sd.hover = q.snap;
  sd.plan = sdCheck([{ x: q.snap.x, y: q.snap.y, w: pn.w, h: pn.h }], allCells(), { cols: 1, rows: 1, byRows: true });
  sdPaint();
}
function selfDrawLeave() { if (!sd.drag) { sd.hover = null; sd.plan = null; sdPaint(); } }
function selfDrawDown(e) {
  if (e.shiftKey) {                    // Shift+click: new string on the next free port of this card
    var nf = nextFreePort(null, ui.mSender || 0);
    if (nf.sender !== (ui.mSender || 0)) { toast(cardName(ui.mSender || 0) + ' has no free port left'); return false; }
    ui.mPort = nf.port;
    log('self_draw_new_string', { port: portLabel(nf.sender, nf.port) });
    renderAll();
  }
  var q = sdPoint(e);
  sd.drag = { a: q.snap, sx: e.clientX, sy: e.clientY, moved: false };
  sd.hover = q.snap;
  selfDrawMove(e);
  return true;
}
function selfDrawMove(e) {
  if (!sd.drag) return selfDrawHover(e);
  if (Math.abs(e.clientX - sd.drag.sx) + Math.abs(e.clientY - sd.drag.sy) > 4) sd.drag.moved = true;
  var pn = sdPanel(), p = svgPoint(e), a = sd.drag.a;
  sd.plan = sd.drag.moved ? sdPlanBlock(a, p, pn.w, pn.h, allCells())
    : sdCheck([{ x: a.x, y: a.y, w: pn.w, h: pn.h }], allCells(), { cols: 1, rows: 1, byRows: true });
  sdPaint();
}
function selfDrawUp(e) {
  if (!sd.drag) return;
  selfDrawMove(e);
  var plan = sd.plan;
  sd.drag = null;
  if (plan) sdPlace(plan);
  selfDrawHover(e);
}

// ------------------------------------------------------------------ panel counter
// Like LED Raster Designer's custom-run readout: in the strip above the canvas (not on the
// wall, where it would cover panels), "S1 P3  12/21 on port  +8 drawing · 4×2", with "full"
// in the warning colour once one more panel won't fit. 21 = whole panels of the size being
// drawn that the port's capacity holds (the rectangle rule can make the real limit lower).
// Shown in Self draw, and in Manual while panels are selected (+N selected).
function sdReadout() {
  var box = $('drawReadout');
  if (!box) {
    var bar = document.querySelector('#modLayout .stage-tools'); if (!bar) return;
    box = document.createElement('span'); box.id = 'drawReadout';
    box.style.cssText = 'display:inline-flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;padding:2px 8px;border:1px solid var(--line);border-radius:12px;background:var(--bg)';
    var badge = $('modeBadge');
    if (badge && badge.parentNode === bar) bar.insertBefore(box, badge); else bar.appendChild(box);
  }
  var drawing = ui.tool === 'draw', selN = ui.selKeys && ui.selScreen ? ui.selKeys.size : 0;
  if (!drawing && !selN) { box.hidden = true; box.style.display = 'none'; return; }
  box.hidden = false; box.style.display = 'inline-flex';
  var cp = curPort(), cellsBy = allCells(), use = portUsage(cellsBy)[cp.sender + ':' + cp.port];
  var have = use ? use.cabs : 0, pn = sdPanel();
  var holds = Math.floor(portCap(use ? use.rect : null) / Math.max(1, pn.w * pn.h));
  var plan = drawing && sd.drag ? sd.plan : null, adding = plan ? plan.ok : 0;
  // full = the panel under the pointer (or the drag) doesn't fit on the port any more
  var full = drawing && !!(sd.plan && /is full/.test(sd.plan.reason || ''));
  var html = '<b style="color:' + portColor(cp.sender, cp.port) + '">' + esc(portLabel(cp.sender, cp.port)) + '</b>' +
    '<span>' + have + '/' + holds + ' on port</span>';
  if (adding) html += '<span style="color:var(--warn)">+' + adding + ' drawing</span>';
  if (plan && sd.drag.moved) html += '<span><b>' + plan.cols + ' × ' + plan.rows + '</b> <span style="color:var(--muted)">' + (plan.byRows ? 'rows' : 'columns') + '</span></span>';
  if (!drawing && selN) {
    // the selection's size in panels: distinct columns × rows it covers
    var ss = screenById(ui.selScreen), xs = {}, ys = {};
    if (ss) cellGeom(ss).forEach(function (g) { if (ui.selKeys.has(g.k)) { xs[g.x] = 1; ys[g.y] = 1; } });
    html += '<span style="color:var(--warn)">+' + selN + ' selected</span><span><b>' + Object.keys(xs).length + ' × ' + Object.keys(ys).length + '</b></span>';
  }
  if (full) html += '<span style="color:var(--danger);font-weight:600">full</span>';
  box.innerHTML = html;
  box.title = portLabel(cp.sender, cp.port) + ': ' + have + ' cabinet(s) on it; its capacity holds about ' + holds + ' × ' + pn.w + '×' + pn.h +
    (use ? ' (rectangle ' + fmt(use.load) + ' of ' + fmt(use.cap) + ' px)' : '');
}

// ------------------------------------------------------------------ the ghost (drawn over the canvas)
function sdPaint() {
  sdReadout();
  var svg = $('svg'); if (!svg) return;
  var old = svg.querySelector('#sdLayer'); if (old) old.remove();
  if (ui.tool !== 'draw' || !sd.plan || !ui.pxPerUnit) return;
  var unit = uiZoom() / ui.pxPerUnit, cp = curPort(), col = portColor(cp.sender, cp.port);
  var g = el('g', { id: 'sdLayer', 'pointer-events': 'none' }, svg);
  var plan = sd.plan, ok = plan.order.filter(function (x) { return x.state === 'ok'; });
  plan.order.forEach(function (c) {
    var st = c.state;
    el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, 'stroke-width': 1.5 * unit,
      fill: st === 'ok' ? col : st === 'full' ? 'var(--danger)' : 'none', 'fill-opacity': st === 'ok' ? 0.55 : 0.3,
      stroke: st === 'ok' ? 'currentColor' : st === 'full' ? 'var(--danger)' : 'var(--muted)',
      'stroke-dasharray': st === 'ok' ? '' : (4 * unit) + ' ' + (3 * unit) }, g);
  });
  // cable: dashed link from the port's current end, then through the new panels in order
  var mid = function (c) { return (c.x + c.w / 2) + ',' + (c.y + c.h / 2); };
  var tail = sdPortTail(allCells());
  if (tail && ok.length) el('polyline', { points: mid(tail) + ' ' + mid(ok[0]), fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 * unit, 'stroke-dasharray': (5 * unit) + ' ' + (4 * unit), opacity: 0.8 }, g);
  if (ok.length > 1) el('polyline', { class: 'wire', points: ok.map(mid).join(' '), 'stroke-width': 1.8 * unit, 'marker-end': 'url(#arrow)' }, g);
  if (ok.length) el('circle', { class: 'wire-start', cx: ok[0].x + ok[0].w / 2, cy: ok[0].y + ok[0].h / 2, r: Math.max(3 * unit, Math.min(ok[0].w, ok[0].h) * 0.07) }, g);
  // small tag at the first panel's top-left, like Tessera's "1171px,535px" (+ the count while
  // dragging); the full readout is in the toolbar (sdReadout) so nothing big covers the wall
  var a = plan.order[0];
  // while dragging it reads in panels: "28 × 3 · 84 panels" (placeable ones; "· full" if cut short)
  var text = sd.drag && sd.drag.moved
    ? plan.cols + ' × ' + plan.rows + ' · ' + plan.ok + ' cabinet' + (plan.ok === 1 ? '' : 's') + (plan.ok < plan.order.length ? ' of ' + plan.order.length : '')
    : a.x + ', ' + a.y + ' px';
  if (plan.reason && /is full/.test(plan.reason)) text += ' · full';
  var fs = 11 * unit, tx = a.x, ty = a.y - 6 * unit;
  var bg = el('rect', { x: tx - 3 * unit, y: ty - fs, height: fs * 1.35, width: text.length * fs * 0.56 + 6 * unit, rx: 2 * unit, fill: 'var(--panel)', opacity: 0.9 }, g);
  var t = el('text', { x: tx, y: ty, 'font-size': fs, fill: plan.reason ? 'var(--danger)' : 'currentColor' }, g);
  t.textContent = text;
  try { bg.setAttribute('width', t.getBBox().width + 6 * unit); } catch (err) { /* not laid out yet */ }
}

// ------------------------------------------------------------------ keys while drawing
document.addEventListener('keydown', function (e) {
  if (ui.tool !== 'draw') return;
  var a = document.activeElement, typing = a && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
  var dlg = $('logDlg');
  if (typing || (dlg && !dlg.hidden) || e.ctrlKey || e.metaKey) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setSelfDraw(false); }
  else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault(); e.stopImmediatePropagation();
    ui.drawRot = !ui.drawRot; log('self_draw_rotate', { panel: sdPanel().name });
    if (sd.hover && !sd.drag) { var pn = sdPanel(); sd.plan = sdCheck([{ x: sd.hover.x, y: sd.hover.y, w: pn.w, h: pn.h }], allCells(), { cols: 1, rows: 1, byRows: true }); }
    sdPaint(); renderModeBadge();
  }
}, true);
// Delete / Backspace with panels selected in a Drawn section removes those panels (not just
// their wiring): in a Drawn section the panels themselves are what was drawn.
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  var a = document.activeElement, typing = a && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
  var dlg = $('logDlg'), s = screenById(ui.selScreen);
  if (typing || (dlg && !dlg.hidden) || !s || !s.drawn || !ui.selKeys || !ui.selKeys.size) return;
  e.preventDefault(); e.stopImmediatePropagation();
  sdDeletePanels(s, Array.from(ui.selKeys));
}, true);
