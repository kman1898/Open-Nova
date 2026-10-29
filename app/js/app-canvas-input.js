// app-canvas-input.js - pointer / wheel input on the canvas: svgPoint, cellAt, screenAt,
// bindCanvas (pan, move, marquee select, click-to-wire, hole painting, wheel zoom, and
// handing pointer events to Self draw — app-selfdraw.js — while ui.tool === 'draw'), the
// magnet (MAGNET_PX, magnetSnap), paintCell and the hover readout.
// Depends on: app-core, app-capacity (screenById, portLabel), app-geometry, app-manual-wiring
// (addToCurrentPort, toggleHole), app-render, app-context-menu (closeMenu, openCanvasMenu),
// app-screenfit (coordTagAt: the hover / drag "x,y" tag).
// bindCanvas is called from main.js.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ canvas interaction
function svgPoint(evt) {
  var svg = $('svg'), pt = svg.createSVGPoint();
  pt.x = evt.clientX; pt.y = evt.clientY;
  return pt.matrixTransform(svg.getScreenCTM().inverse());
}
function cellAt(s, pt) {
  var g = cellGeom(s);
  for (var i = 0; i < g.length; i++) { var c = g[i]; if (pt.x >= c.x && pt.x < c.x + c.w && pt.y >= c.y && pt.y < c.y + c.h) return c; }
  return null;
}
function screenAt(pt) {
  // topmost = last drawn; prefer selected screen when overlapping
  var vis = visibleScreens(), sel = screenById(ui.sel);
  if (sel && vis.indexOf(sel) >= 0 && cellAt(sel, pt)) return sel;
  for (var i = vis.length - 1; i >= 0; i--) if (cellAt(vis[i], pt)) return vis[i];
  return null;
}

// ---- Moving self-drawn panels (Self draw off): grab a panel and drag, and its whole port
// moves with it — or, if the grabbed panel is in the selection, the selection moves.
function drawnGroupKeys(s, k) {
  if (ui.selScreen === s.id && ui.selKeys && ui.selKeys.has(k) && ui.selKeys.size > 1) return Array.from(ui.selKeys);
  var a = s.manual[k];
  return a ? portKeys(s, a.sender, a.port) : [k];
}
// Follow the pointer; the group's bounding box snaps to other panels' edges (within 8 screen
// px), otherwise to the panel grid while Magnet is on.
function moveDrawnGroup(d, e) {
  var s = d.s, ppu = ui.pxPerUnit, inGroup = {};
  d.group.forEach(function (k) { inGroup[k] = 1; });
  if (!d.box) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    d.group.forEach(function (k) { var g = s.regions[+k]; x0 = Math.min(x0, s.x + g.dx); y0 = Math.min(y0, s.y + g.dy); x1 = Math.max(x1, s.x + g.dx + g.w); y1 = Math.max(y1, s.y + g.dy + g.h); });
    var first = s.regions[+d.group[0]];
    d.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, gw: first.w, gh: first.h };
    d.others = [];
    var cellsBy = allCells();
    visibleScreens().forEach(function (o) { cellsBy[o.id].forEach(function (c) { if (!c.hole && !(o === s && inGroup[c.k])) d.others.push(c); }); });
    var a = s.manual[d.group[0]];
    d.what = d.group.length > 1 && a && d.group.every(function (k) { var m = s.manual[k]; return m && m.sender === a.sender && m.port === a.port; }) ? portLabel(a.sender, a.port) : d.group.length + ' cabinet(s)';
  }
  var b = d.box, thr = 8 / ppu;
  var tx = b.x + (e.clientX - d.sx) / ppu, ty = b.y + (e.clientY - d.sy) / ppu;
  var snap1 = function (v, size, grid, edges) {
    var pick = null;
    edges.forEach(function (c) { var dd = Math.abs(c - v); if (dd <= thr && (!pick || dd < pick.d)) pick = { d: dd, v: c }; });
    return pick ? pick.v : ui.magnet ? Math.round(v / grid) * grid : Math.round(v);
  };
  var ex = [0], ey = [0];
  d.others.forEach(function (c) { ex.push(c.x + c.w, c.x - b.w, c.x, c.x + c.w - b.w); ey.push(c.y + c.h, c.y - b.h, c.y, c.y + c.h - b.h); });
  var nx = Math.max(0, snap1(tx, b.w, b.gw, ex)), ny = Math.max(0, snap1(ty, b.h, b.gh, ey));
  var ddx = nx - b.x, ddy = ny - b.y;
  d.group.forEach(function (k) { var g = s.regions[+k]; g.dx = d.orig[k].dx + ddx; g.dy = d.orig[k].dy + ddy; });
  renderCanvas(allCells());
  coordTagAt({ x: nx, y: ny });   // the group's new top-left (app-screenfit.js)
}
// Would the moved group sit on another panel? (returns a reason, or null)
function drawnGroupClash(d) {
  if (!d.others) return null;
  var s = d.s;
  for (var i = 0; i < d.group.length; i++) {
    var g = s.regions[+d.group[i]], x = s.x + g.dx, y = s.y + g.dy;
    for (var j = 0; j < d.others.length; j++) {
      var c = d.others[j];
      if (x < c.x + c.w && x + g.w > c.x && y < c.y + c.h && y + g.h > c.y) return 'overlap';
    }
  }
  return null;
}

function bindCanvas() {
  var vpEl = $('viewport'), drag = null;
  vpEl.addEventListener('pointerdown', function (e) {
    closeMenu();
    if (ui.spaceHeld && e.button === 0) {       // Space + drag pans, anywhere
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: Object.assign({}, ui.view), click: false };
      vpEl.setPointerCapture(e.pointerId); vpEl.classList.add('panning'); e.preventDefault(); return;
    }
    if (e.button === 1 || e.button === 2) {    // middle/right drag pans; a right click (no drag) opens the menu
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: Object.assign({}, ui.view), click: true, rclick: e.button === 2, pt: svgPoint(e) };
      vpEl.setPointerCapture(e.pointerId); e.preventDefault(); return;
    }
    // Self draw: click places a panel, drag lays out a block (app-selfdraw.js).
    if (ui.tool === 'draw' && e.button === 0) {
      if (selfDrawDown(e)) { drag = { kind: 'selfdraw' }; vpEl.setPointerCapture(e.pointerId); }
      e.preventDefault();
      return;
    }
    var pt = svgPoint(e), s = screenAt(pt);
    // Identify tool (app-display.js): a click lights that panel on the wall
    if (ui.tool === 'identify' && e.button === 0) { var ic = s && cellAt(s, pt); if (ic) dispIdentify(s, ic); e.preventDefault(); return; }
    // Shift + drag moves a screen in any mode.
    if (s && e.shiftKey && !ui.tool) {
      if (!(ui.selSecs && ui.selSecs.has(s.id))) ui.selSecs = new Set(groupSelIds(s));   // a group moves as one (app-sections.js)
      if (s.id !== ui.sel) { ui.sel = s.id; renderAll(); }
      drag = moveDrag(s, e);
      vpEl.setPointerCapture(e.pointerId);
      return;
    }
    // Manual wiring: a click wires the panel onto the current port, a drag draws a selection box
    // (from a panel or from just outside the selected screen).
    var selScr = screenById(ui.sel);
    var manualOn = function (sc) { return sc && sc.wiring.mode === 'manual' && !ui.tool && !e.altKey; };
    if ((!s && manualOn(selScr)) || (s && manualOn(s))) {
      var ms = s || selScr, add = e.ctrlKey || e.metaKey;
      drag = { kind: 'manual', s: ms, x0: pt.x, y0: pt.y, add: add, ctrl: add,
        sx: e.clientX, sy: e.clientY, moved: false, cell: s ? cellAt(s, pt) : null, base: null };
      // Self-drawn panels: dragging one moves its whole port (or the selection it's part of)
      if (ms.drawn && s === ms && drag.cell && !add) drag.group = drawnGroupKeys(ms, drag.cell.k);
      vpEl.setPointerCapture(e.pointerId);
      return;
    }
    if (!s) { drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, v: Object.assign({}, ui.view), click: true }; vpEl.setPointerCapture(e.pointerId); return; }
    var c = cellAt(s, pt);
    if (ui.tool === 'hole' || e.altKey) {
      if (s.id !== ui.sel) { ui.sel = s.id; }
      drag = { kind: 'paint', s: s, done: {}, op: 'hole', holeTo: null };
      paintCell(drag, c);
      vpEl.setPointerCapture(e.pointerId);
      renderLight(); renderScreenForm();
      return;
    }
    // Ctrl+click adds / removes a section in the multi-selection (app-arrange.js); a plain click on a
    // section outside it starts a new selection.
    if (e.ctrlKey || e.metaKey) { arrangeToggle(s); return; }
    // a section of a group selects the whole group, which then drags as one (app-sections.js)
    if (!(ui.selSecs && ui.selSecs.has(s.id))) {
      var hadSel = ui.selSecs && ui.selSecs.size;
      ui.selSecs = new Set(s.group ? groupSelIds(s) : []);
      if ((hadSel || s.group) && s.id === ui.sel) renderAll();
    }
    if (s.id !== ui.sel) { ui.sel = s.id; renderAll(); }
    drag = moveDrag(s, e);
    vpEl.setPointerCapture(e.pointerId);
  });
  // A section drag: the grabbed section plus the rest of the multi-selection; locked ones stay.
  function moveDrag(s, e) {
    var grp = ui.selSecs && ui.selSecs.has(s.id) && ui.selSecs.size > 1 ? arrangeTargets() : [s];
    return { kind: 'move', s: s, sx: e.clientX, sy: e.clientY, ox: s.x, oy: s.y, moved: false,
      group: grp.filter(function (x) { return !x.locked; }).map(function (x) { return { s: x, ox: x.x, oy: x.y }; }) };
  }
  vpEl.addEventListener('pointermove', function (e) {
    if (!drag) { if (ui.tool === 'draw') selfDrawHover(e); hover(e); return; }
    if (drag.kind === 'selfdraw') { selfDrawMove(e); return; }
    if (drag.kind === 'groupmove') { moveDrawnGroup(drag, e); return; }
    if (drag.kind === 'manual') {
      if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
      if (!drag.moved && drag.group) {   // a drawn panel was grabbed: move its port
        drag.kind = 'groupmove'; drag.moved = true; ui.sel = drag.s.id;
        drag.orig = {}; drag.group.forEach(function (k) { var g = drag.s.regions[+k]; drag.orig[k] = { dx: g.dx, dy: g.dy }; });
        moveDrawnGroup(drag, e);
        return;
      }
      if (!drag.moved) {                 // became a drag: start the selection box
        drag.moved = true;
        if (ui.selScreen !== drag.s.id || !drag.add) { ui.selKeys = new Set(); ui.selScreen = drag.s.id; }
        ui.sel = drag.s.id; drag.base = new Set(ui.selKeys);
      }
      var q = svgPoint(e);
      ui.marquee = { x0: Math.min(drag.x0, q.x), y0: Math.min(drag.y0, q.y), x1: Math.max(drag.x0, q.x), y1: Math.max(drag.y0, q.y) };
      var sel = new Set(drag.base);
      cellGeom(drag.s).forEach(function (g) {
        if (!g.hole && g.x < ui.marquee.x1 && g.x + g.w > ui.marquee.x0 && g.y < ui.marquee.y1 && g.y + g.h > ui.marquee.y0) sel.add(g.k);
      });
      ui.selKeys = sel;
      renderCanvas(allCells());
      return;
    }
    if (drag.kind === 'pan') {
      var k = 1 / ui.pxPerUnit;
      ui.view.x = drag.v.x - (e.clientX - drag.sx) * k; ui.view.y = drag.v.y - (e.clientY - drag.sy) * k;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.click = false;
      renderCanvas(allCells());
    } else if (drag.kind === 'move') {
      var dx = (e.clientX - drag.sx) / ui.pxPerUnit, dy = (e.clientY - drag.sy) / ui.pxPerUnit;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3 / ui.pxPerUnit) return;
      if (drag.s.locked) {   // locked (app-arrange.js): say so once, don't move
        if (!drag.lockedSaid) { drag.lockedSaid = true; toast('These cabinets are locked — unlock them to move them (right-click ▸ Arrange)'); }
        return;
      }
      drag.moved = true;
      var nx = Math.round(drag.ox + dx), ny = Math.round(drag.oy + dy);
      ui.snapGuides = null;
      if (ui.grid && ui.grid.snap && !e.altKey) {
        var gs = gridSnapXY(drag.s, nx, ny); nx = gs.x; ny = gs.y;
      } else if (ui.magnet && !e.altKey) {
        var snapped = magnetSnap(drag.s, nx, ny);
        nx = snapped.x; ny = snapped.y; ui.snapGuides = snapped.guides;
      }
      var mdx = Math.max(nx, 0) - drag.ox, mdy = Math.max(ny, 0) - drag.oy;
      drag.group.forEach(function (m) { m.s.x = Math.max(0, m.ox + mdx); m.s.y = Math.max(0, m.oy + mdy); });
      renderCanvas(allCells());
      $('sX').value = drag.s.x; $('sY').value = drag.s.y;
      coordTagAt(screenBounds(drag.s));   // the cabinets' new top-left
    } else if (drag.kind === 'paint') {
      var c = cellAt(drag.s, svgPoint(e));
      if (c && !drag.done[c.k]) { paintCell(drag, c); renderLight(); }
    }
  });
  function end(e) {
    vpEl.classList.remove('panning');
    if (!drag) return;
    if (drag.kind === 'groupmove') {   // drop the moved port, unless it lands on other panels
      var gm = drag; drag = null; ui.snapGuides = null;
      var clash = e && e.type === 'pointercancel' ? 'cancelled' : drawnGroupClash(gm);
      if (clash) {
        gm.group.forEach(function (k) { var g = gm.s.regions[+k]; g.dx = gm.orig[k].dx; g.dy = gm.orig[k].dy; });
        renderAll();
        if (clash !== 'cancelled') toast('Can’t drop there — it would sit on top of other cabinets');
        log('move_drawn_panels', { section: gm.s.name, what: gm.what, panels: gm.group.length, refused: clash });
        return;
      }
      var g0 = gm.s.regions[+gm.group[0]];
      log('move_drawn_panels', { section: gm.s.name, what: gm.what, panels: gm.group.length, by: (g0.dx - gm.orig[gm.group[0]].dx) + ',' + (g0.dy - gm.orig[gm.group[0]].dy) });
      commit(); renderAll();
      return;
    }
    if (drag.kind === 'selfdraw') {   // placing happens on release; a cancelled pointer places nothing
      drag = null;
      if (e && e.type === 'pointercancel') { sd.drag = null; sdPaint(); } else selfDrawUp(e);
      return;
    }
    // One entry per gesture (never per mouse move): what kind, on what, and the outcome.
    log('canvas_' + (drag.kind === 'manual' ? (drag.moved ? 'select_box' : drag.ctrl ? 'ctrl_click' : 'click') : drag.kind === 'pan' ? (drag.click ? (drag.rclick ? 'right_click' : 'click_empty') : 'pan') : drag.kind + (drag.moved === false ? '_click' : '')), {
      section: drag.s ? drag.s.name : undefined,
      panel: drag.cell ? drag.cell.k : undefined,
      selected: drag.kind === 'manual' && drag.moved ? ui.selKeys.size : undefined,
      from: drag.kind === 'move' && drag.moved ? drag.ox + ',' + drag.oy : undefined,
      to: drag.kind === 'move' && drag.moved ? drag.s.x + ',' + drag.s.y : undefined,
      snapped: drag.kind === 'move' && ui.snapGuides && ui.snapGuides.length ? ui.snapGuides.map(function (g) { return g.x != null ? 'x=' + g.x : 'y=' + g.y; }) : undefined });
    if (drag.kind === 'manual') {
      var ms = drag.s, cell = drag.cell, msg = null, changed = false;
      if (!drag.moved) {                 // a click
        ui.sel = ms.id;
        if (drag.ctrl) {                 // Ctrl-click: toggle one panel in the selection
          if (cell && !cell.hole) {
            if (ui.selScreen !== ms.id) { ui.selKeys = new Set(); ui.selScreen = ms.id; }
            if (ui.selKeys.has(cell.k)) ui.selKeys.delete(cell.k); else ui.selKeys.add(cell.k);
          }
        } else if (ui.selKeys.size) {    // a pending selection: a plain click just drops it
          ui.selKeys = new Set();
        } else if (cell) {               // click: wire onto the current port
          var before = JSON.stringify(ms.manual);
          msg = addToCurrentPort(ms, cell.k);
          changed = JSON.stringify(ms.manual) !== before;
        }
      }
      ui.marquee = null; drag = null;
      if (changed) commit();
      renderAll();
      if (msg) toast(msg);
      return;
    }
    if (drag.kind === 'move') ui.snapGuides = null;
    if (drag.kind === 'move' && drag.moved) { commit(); renderAll(); }
    else if (drag.kind === 'move') renderCanvas(allCells());
    else if (drag.kind === 'paint') { commit(); renderAll(); }
    else if (drag.kind === 'pan' && drag.click && drag.rclick) { var at = drag; drag = null; openCanvasMenu(at.sx, at.sy, at.pt); return; }
    else if (drag.kind === 'pan' && drag.click && ui.tool == null) { ui.sel = null; renderAll(); }
    drag = null;
  }
  vpEl.addEventListener('pointerup', end);
  vpEl.addEventListener('pointercancel', end);
  vpEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  // Wheel, the way LED Raster Designer does it (user, 2026-09-26): scrolling forward / back —
  // two fingers on a trackpad, or a mouse wheel — zooms at the pointer; a sideways swipe pans;
  // panning otherwise is Space+drag (or right / middle drag). A trackpad sends many small
  // steps, each zooming 2.5% (RD's rate) so it's smooth; a mouse-wheel notch arrives as one big
  // step and zooms ~15%. Pinch (Ctrl+wheel in browsers) zooms the same way.
  vpEl.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (!ui.view || !ui.pxPerUnit) return;
    var unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;   // lines / pages -> px
    var dx = e.deltaX * unit, dy = e.deltaY * unit, v = ui.view;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 1) {             // sideways swipe: pan
      v.x += dx / ui.pxPerUnit; v.y += dy / ui.pxPerUnit;
    } else {
      if (Math.abs(dy) < 1) return;                                     // stray jitter
      var step = Math.abs(dy) >= 50 ? 1.15 : 1.025;                     // mouse notch vs trackpad
      var pt = svgPoint(e), f = dy > 0 ? step : 1 / step;
      v.x = pt.x - (pt.x - v.x) * f; v.y = pt.y - (pt.y - v.y) * f; v.w *= f; v.h *= f;
    }
    renderCanvas(allCells());
  }, { passive: false });
  vpEl.addEventListener('pointerleave', function () { ui.hover = null; renderStatus(ui.lastProbs || []); if (ui.tool === 'draw') selfDrawLeave(); if (typeof heatHover === 'function') heatHover(null); });
  window.addEventListener('resize', function () { renderCanvas(allCells()); });
}

// Magnet: pull a moving screen's edges onto other screens' edges and the canvas edges,
// but only within a few on-screen pixels so it never fights the drag.
var MAGNET_PX = 8;
function magnetSnap(s, nx, ny) {
  var b = screenBounds(s), offX = b.x - s.x, offY = b.y - s.y;
  var thr = MAGNET_PX / ui.pxPerUnit;
  var xs = [0, P.canvasW], ys = [0, P.canvasH];
  visibleScreens().forEach(function (o) {
    if (o === s) return;
    var ob = screenBounds(o);
    xs.push(ob.x, ob.x + ob.w); ys.push(ob.y, ob.y + ob.h);
  });
  function best(start, size, targets) {
    var pick = null;
    [start, start + size].forEach(function (edge, i) {
      targets.forEach(function (t) {
        var d = t - edge;
        if (Math.abs(d) <= thr && (!pick || Math.abs(d) < Math.abs(pick.d))) pick = { d: d, at: t };
      });
    });
    return pick;
  }
  var gx = best(nx + offX, b.w, xs), gy = best(ny + offY, b.h, ys), guides = [];
  if (gx) { nx += gx.d; guides.push({ x: gx.at }); }
  if (gy) { ny += gy.d; guides.push({ y: gy.at }); }
  return { x: Math.round(nx), y: Math.round(ny), guides: guides };
}

function paintCell(drag, c) {
  if (!c) return;
  drag.done[c.k] = 1;
  if (drag.op === 'hole') {
    var want = drag.holeTo == null ? !drag.s.holes[c.k] : drag.holeTo;
    drag.holeTo = want;
    if (!!drag.s.holes[c.k] !== want) toggleHole(drag.s, c.k);
  }
}

function hover(e) {
  var pt = svgPoint(e), s = screenAt(pt), c = s && cellAt(s, pt);
  if (c) {
    var full = cellsOf(s).find(function (x) { return x.k === c.k; });
    var hg = groupOf(s);   // no section name in the UI; a group's name is
    ui.hover = (hg ? hg.name + ' · ' : '') + (s.kind === 'complex' ? 'cabinet ' + (c.c + 1) : 'col ' + (c.c + 1) + ', row ' + (c.r + 1)) + ' · x ' + c.x + ', y ' + c.y + ' · ' + c.w + '×' + c.h +
      (full.hole ? ' · blank' : full.unassigned ? ' · not wired' : ' · ' + portLabel(full.sender, full.port) + ' #' + (full.connect + 1));
  } else ui.hover = Math.round(pt.x) + ', ' + Math.round(pt.y);
  if (typeof heatHover === 'function') heatHover(pt, c ? full : null, e);   // Live view: the reading under the pointer (app-heat.js)
  coordTagAt(c);   // "x,y" at the panel's top-left (app-screenfit.js)
  renderStatus(ui.lastProbs || []);
}
