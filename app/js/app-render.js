// app-render.js - all drawing: the right panel's cards (renderOutput = Screen card, layoutTip,
// renderCardEditor = Sending card card, renderPanelLibrary = Cabinet types, senderOptions,
// renderScreenForm = the cabinets card), the SVG canvas (el, fitView, renderCanvas, zoom; cellsTouch = dashed cable where a chain jumps,
// overlapCells = red outline where sections overlap), the
// renderPortsPro = the pro look's port outlines / cables / plates), the
// status line, mode badge and toolbar mode switch (renderModeSeg), and renderAll /
// renderLight. The left tree is app-tree.js, the port list under the canvas app-portlist.js.
// Depends on: app-core, app-capacity, app-geometry, app-sections, app-tree (renderTree) and
// app-portlist (renderPortList), the last two at run time only; app-screenfit (renderScreenFit,
// coordTagPlace), also at run time; app-quickadd (renderQuickAdd, qaBadgeText), at run time;
// app-devices (renderDevices, cardOptionGroups) and app-processors, at run time; drv-offline (simEnsure), at run time;
// app-save (renderUnsaved) and app-display (dispTiles), at run time;
// app-pipeline (proLook) and app-backup (backupRole) for the pro look's port drawing (renderPortsPro), at run time.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ rendering: side panels
// The project's name is renamed in Project ▾ and the tree (not here); the NovaLCT screen type and the low-latency rule
// are ⓘ tips; bit depth / frame rate / receiving card / low latency sit in the folding "Output" group (open by default,
// remembered per browser: bindOutputGroup, app-forms.js) with a one-line summary for when it is closed.
function renderOutput() {
  $('canvasW').value = P.canvasW; $('canvasH').value = P.canvasH;
  $('bitDepth').value = String(P.bitDepth); $('refresh').value = P.refresh;
  $('lowLatency').checked = !!P.lowLatency; $('rxCard').value = P.rxCard || '';
  $('lctName').value = (lctById(ui.viewScreen) || {}).name || '';
  var ty = lctScreenType(ui.viewScreen, allCells());
  layoutTip($('lctType'), 'NovaLCT screen type: ' + (!ty ? '— (no cabinets yet)' : ty.kind === 'Standard'
    ? 'Standard · ' + ty.cols + ' × ' + ty.rows + ' grid' : 'Complex · ' + ty.cabinets + ' cabinets (they don’t line up on one grid)') +
    '.\nIn NovaLCT a whole screen is one type: Standard (one grid, gaps as blanks) or Complex (cabinets placed freely). This is what Export writes.');
  $('outSum').textContent = P.bitDepth + '-bit · ' + (+P.refresh || 60) + ' fps' + (P.rxCard ? ' · ' + P.rxCard : '') + (P.lowLatency ? ' · low latency' : '');
  var cap = capacity();
  $('capOut').textContent = cap ? fmt(cap) : 'not supported above 120 Hz';
  $('capNote').hidden = !P.lowLatency;
  if (P.lowLatency) layoutTip($('capNote'), 'Low latency: each port gets cap × (1 − top Y / ' + fmt(P.canvasH) + ')');
}
// Text of an ⓘ tip made in index.html (title on hover, the popover on click: app-tips.js).
function layoutTip(b, t) { if (b.getAttribute('data-itip') !== t) { b.title = t; b.setAttribute('data-itip', t); } b.textContent = 'ⓘ'; }

// "Sending card" card: the active card (ui.mSender, picked in the tree or the port list), which
// processor it is in, how many of its ports are used, and the port count of a "Pick a model" card.
// The processor itself (model, output cards, cascade order) is edited in the Processors tab
// (app-devices.js); the handlers are in app-forms.js.
function renderCardEditor(use) {
  var i = ui.mSender || 0, pr = P.processors[i], d = pr && deviceById(pr.dev);
  $('cardSend').hidden = !pr;
  if (!pr || !d) return;
  var m = procModel(d.model), idx = cardsOfDevice(d), here = 0, all = 0;
  Object.keys(use).forEach(function (key) { var u = use[key]; if (u.sender !== i) return; all++; if (u.lct[ui.viewScreen]) here++; });
  var real = cardIsReal(i);
  $('cardHead').textContent = real ? (m.kind === 'chassis' ? 'Sending card' : 'Card') : 'Processor';
  $('cardName').textContent = real ? String(i + 1) : '';
  $('cardProc').innerHTML = '<b>' + esc(deviceLabel(d)) + '</b> · ' + esc(m.name) +
    (m.kind === 'chassis' ? ' · slot ' + (idx.indexOf(i) + 1) + ' · ' + esc(cardTypeLabel(pr)) : idx.length > 1 ? ' · card ' + (idx.indexOf(i) + 1) + ' of ' + idx.length : '');
  $('cardInfo').textContent = here + ' port' + (here === 1 ? '' : 's') + ' on this screen · ' + all + ' of ' + pr.ports + ' used in the project';
  $('cardPortsWrap').hidden = m.kind !== 'custom';
  $('cardPorts').max = MAX_CARD_PORTS;
  if (document.activeElement !== $('cardPorts')) $('cardPorts').value = pr.ports;
}

// Panel library: searchable list of panel types. Clicking a row picks it for Self draw
// (ui.drawPanelId; fixSel falls back to the first panel); the picked row is edited in place.
// The card starts folded (bindCards) and unfolds itself while Self draw is on, without changing the remembered state.
function renderPanelLibrary() {
  var card = $('cardPanels');
  if (card && ui.tool === 'draw' && !ui.libOpened) { ui.libOpened = true; cardFold('panels', false, true); }
  else if (ui.tool !== 'draw' && ui.libOpened) { ui.libOpened = false; cardFold('panels', null, true); }
  var box = $('panelList'), q = ($('panelSearch').value || '').trim().toLowerCase(), shown = 0;
  box.innerHTML = '';
  var head = document.createElement('div'); head.className = 'plib-head';
  head.innerHTML = '<span>Name</span><span>Resolution</span><span title="How many blocks of cabinets use it">Used</span>'; box.appendChild(head);
  P.panels.forEach(function (pn, i) {
    var res = pn.w + '×' + pn.h;
    if (q && (pn.name + ' ' + res + ' ' + pn.w + 'x' + pn.h).toLowerCase().indexOf(q) < 0) return;
    shown++;
    var on = pn.id === ui.drawPanelId, uses = P.screens.filter(function (s) { return s.panelId === pn.id; }).length;
    var row = document.createElement('div'); row.className = 'plib-row' + (on ? ' on' : '');
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(on));
    if (on) {
      row.title = 'Self draw places this cabinet type · used ' + uses + '×';
      row.innerHTML = '<input class="plib-name" aria-label="Cabinet type name"><span class="plib-res"><input type="number" min="1" aria-label="Width px" title="Width px">×<input type="number" min="1" aria-label="Height px" title="Height px"></span><button title="Remove this cabinet type">×</button>';
      var inp = row.querySelectorAll('input');
      inp[0].value = pn.name; inp[1].value = pn.w; inp[2].value = pn.h;
      inp[0].onchange = function () { pn.name = inp[0].value; commit(); renderAll(); };
      inp[1].onchange = function () { pn.w = Math.max(1, int(inp[1].value, pn.w)); commit(); renderAll(); };
      inp[2].onchange = function () { pn.h = Math.max(1, int(inp[2].value, pn.h)); commit(); renderAll(); };
      row.querySelector('button').onclick = function () {
        if (P.screens.some(function (s) { return s.panelId === pn.id; })) return toast('This cabinet type is in use');
        if (P.panels.length === 1) return toast('Need at least one cabinet type');
        log('remove_panel', { panel: pn.name, size: res });
        P.panels.splice(i, 1); commit(); renderAll();
      };
    } else {
      row.title = 'Click to use ' + pn.name + ' for Self draw · used ' + uses + '×';
      row.innerHTML = '<span class="plib-name">' + esc(pn.name) + '</span><span class="plib-res">' + res + '</span><span class="plib-n">' + (uses || '') + '</span>';
      row.onclick = function () {
        ui.drawPanelId = pn.id;
        log('select_draw_panel', { panel: pn.name, size: res });
        renderAll();
      };
    }
    box.appendChild(row);
  });
  if (!shown) { var none = document.createElement('p'); none.className = 'hint'; none.textContent = 'No cabinet type matches “' + q + '”.'; box.appendChild(none); }
}

// Sending-card picker, the cards grouped under their processor (cardOptionGroups, app-devices.js).
function senderOptions(sel, value) {
  var lbl = $('mSenderLbl'); if (lbl) lbl.textContent = P.processors.some(function (c, i) { var d = deviceOfCard(i); return d && procModel(d.model).kind === 'chassis'; }) ? 'Sending card'
    : P.processors.some(function (c, i) { return cardIsReal(i); }) ? 'Card' : 'Processor';
  sel.innerHTML = cardOptionGroups(value, Math.max(P.processors.length, value + 1));
  var ok = lctAllowedCards(ui.viewScreen);   // a screen belongs to one processor: only its cards (app-processors.js)
  if (ok) Array.prototype.forEach.call(sel.querySelectorAll('option'), function (o) { if (ok.indexOf(+o.value) < 0 && +o.value !== value) o.remove(); });
  Array.prototype.forEach.call(sel.querySelectorAll('optgroup'), function (g) { if (!g.children.length) g.remove(); });
  sel.value = String(value);
}

// The cabinets card (was "Section"): about the selected cabinets, its title "40 cabinets · 10 × 4 · Panel 176"; the
// Group name field only for grouped cabinets. Auto / Manual is the toolbar's switch; Move / Duplicate / Clear all ports
// are on the right-click menu (UI cleanup item 3).
function renderScreenForm() {
  var s = screenById(ui.sel);
  $('screenEmpty').hidden = !!s; $('screenForm').hidden = !s;
  if (!s) { $('secHead').textContent = 'Cabinets'; return; }
  var cx = s.kind === 'complex', g = groupOf(s), n = cabCount(s);
  $('secHead').textContent = (g ? g.name + ' · ' : '') + cabsText(n) + (s.drawn ? ' · self-drawn' : cx ? ' · placed freely' : ' · ' + s.cols + ' × ' + s.rows + ' · ' + panelOf(s).name);
  $('sNameWrap').hidden = !g;
  if (g && document.activeElement !== $('sName')) $('sName').value = g.name;
  $('sX').value = s.x; $('sY').value = s.y; $('sCols').value = s.cols; $('sRows').value = s.rows;
  var sp = $('sPanel'); sp.innerHTML = '';
  P.panels.forEach(function (p) { var o = document.createElement('option'); o.value = p.id; o.textContent = p.name + ' (' + p.w + '×' + p.h + ')'; sp.appendChild(o); });
  sp.value = s.panelId;
  ['sCols', 'sRows', 'sPanel'].forEach(function (id) { $(id).parentNode.hidden = cx; });
  $('btnToAuto').parentNode.hidden = cx;
  var b = screenBounds(s);
  $('sDims').textContent = b.w + ' × ' + b.h + ' px · ' + fmt(cellsOf(s).reduce(function (a, c) { return a + (c.hole ? 0 : c.w * c.h); }, 0)) + ' px lit';
  var w = s.wiring;
  $('autoOpts').hidden = w.mode !== 'auto'; $('manualOpts').hidden = w.mode !== 'manual';
  $('wCorner').value = w.corner; $('wDir').value = w.dir; $('wPattern').value = w.pattern; $('wSplit').value = w.split;
  if (w.split !== 'fill') w.split = 'lines';     // older projects may say 'balanced'
  $('wSplit').value = w.split; $('mSplit').value = w.split;
  var nSel = ui.selScreen === s.id && ui.selKeys ? ui.selKeys.size : 0;
  $('selInfo').textContent = nSel ? cabsText(nSel) + ' selected — pattern fills from ' + portLabel(ui.mSender || 0, ui.mPort || 0) : 'Nothing selected.';
  $('wMax').value = w.max || ''; $('wPort').value = w.port + 1;
  senderOptions($('wSender'), w.sender);
  if (ui.mSender == null) { ui.mSender = 0; ui.mPort = 0; }
  senderOptions($('mSender'), ui.mSender); $('mPort').value = ui.mPort + 1;
  $('btnHoleMode').classList.toggle('active', ui.tool === 'hole');
  $('btnHoleMode').textContent = ui.tool === 'hole' ? 'Set blank is on — click to stop (B)' : 'Set blank (B)';
}

// ------------------------------------------------------------------ rendering: canvas
function el(name, attrs, parent) {
  var e = document.createElementNS(SVGNS, name);
  for (var a in attrs) e.setAttribute(a, attrs[a]);
  if (parent) parent.appendChild(e);
  return e;
}

// Fit = the screen's panels (as Unico zooms to the screen), or the whole canvas while nothing is placed yet.
function fitView() {
  var vis = visibleScreens(), x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  vis.forEach(function (s) { var b = screenBounds(s); x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
  if (!vis.length) { x0 = 0; y0 = 0; x1 = P.canvasW; y1 = P.canvasH; }
  var m = Math.max(x1 - x0, y1 - y0) * 0.08;
  ui.view = { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
}

// Two cabinets share an edge (a cable between them doesn't jump over anything).
function cellsTouch(a, b) {
  var ov = function (p0, p1, q0, q1) { return Math.min(p1, q1) - Math.max(p0, q0) > 0; };
  return ((a.x + a.w === b.x || b.x + b.w === a.x) && ov(a.y, a.y + a.h, b.y, b.y + b.h)) ||
    ((a.y + a.h === b.y || b.y + b.h === a.y) && ov(a.x, a.x + a.w, b.x, b.x + b.w));
}
// Cabinets of different sections on this screen that overlap each other (keys "sectionId|k").
function overlapCells(vis, cellsBy) {
  var B = 512, grid = {}, hit = {};
  vis.forEach(function (s) {
    cellsBy[s.id].forEach(function (c) {
      if (c.hole) return;
      for (var gx = Math.floor(c.x / B); gx <= Math.floor((c.x + c.w - 1) / B); gx++)
        for (var gy = Math.floor(c.y / B); gy <= Math.floor((c.y + c.h - 1) / B); gy++) {
          var cell = grid[gx + ',' + gy] || (grid[gx + ',' + gy] = []);
          cell.forEach(function (o) {
            if (o.s !== s.id && c.x < o.c.x + o.c.w && o.c.x < c.x + c.w && c.y < o.c.y + o.c.h && o.c.y < c.y + c.h) {
              hit[s.id + '|' + c.k] = c; hit[o.s + '|' + o.c.k] = o.c;
            }
          });
          cell.push({ s: s.id, c: c });
        }
    });
  });
  return hit;
}

// Live ▸ Status / Bit errors in the pro look: the gallery's deep status fills (app/out/pro/pro.js) for app-health's bright ones.
var LIVE_FILL_PRO = { '#2fae6a': '#1d5a37', '#e0a84a': '#6b4d12', '#c8b400': '#c9a51f', '#d4a017': '#c9a51f', '#e07a3a': '#e07a1c', '#e05252': '#e8383d', '#808080': '#3a4252' };
function renderCanvas(cellsBy) {
  var svg = $('svg');
  if (!ui.view) fitView();
  var vp = $('viewport').getBoundingClientRect();
  if (!(vp.width > 0 && vp.height > 0)) return;   // hidden / collapsed: nothing to draw into
  // keep aspect: expand viewBox to viewport aspect
  var v = ui.view, ar = vp.width / Math.max(1, vp.height), w = v.w, h = v.h;
  if (w / h < ar) w = h * ar; else h = w / ar;
  var vx = v.x - (w - v.w) / 2, vy = v.y - (h - v.h) / 2;
  svg.setAttribute('viewBox', vx + ' ' + vy + ' ' + w + ' ' + h);
  ui.pxPerUnit = vp.width / w;
  svg.innerHTML = '';
  var unit = uiZoom() / ui.pxPerUnit, tk = uiText();   // one CSS pixel in canvas units (an on-screen pixel × the interface size, app-forms.js); tk = text size
  var defs = el('defs', {}, svg);
  var mk = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' }, defs);
  el('path', { d: 'M0,0 L10,5 L0,10 z', fill: '#111', opacity: .7 }, mk);

  el('rect', { class: 'canvas-bg', x: 0, y: 0, width: P.canvasW, height: P.canvasH, 'stroke-width': unit }, svg);
  renderGrid(svg, unit);   // optional grid (app-arrange.js)
  var pro = typeof proLook === 'function' && proLook();   // the pro look (app-pipeline.js) draws the ports as tints, outlines and plates (renderPortsPro); classic as before
  var cl = el('text', { class: 'cv-label', x: (pro ? 0 : 4) * unit, y: pro ? -7 * unit : P.canvasH + 14 * unit, 'font-size': (pro ? 10 : 11) * tk * unit, fill: 'currentColor', opacity: pro ? 1 : .6 }, svg);
  var vlc = lctById(ui.viewScreen); if (vlc && typeof olLcShown === 'function' && !olLcShown(vlc)) vlc = null;   // online: not a screen that isn't shown (app-online.js)
  cl.textContent = (vlc ? vlc.name + ' · ' : '') + 'canvas ' + P.canvasW + (pro ? ' × ' : '×') + P.canvasH;

  if (typeof renderHeat === 'function') renderHeat(svg, cellsBy, unit);   // Live ▸ Temperature / Voltage: the heat image under the cabinets (app-heat.js)
  var pvOn = typeof pvLayer === 'function' && pvLayer(svg, cellsBy, unit);   // View ▸ Content: a picture under the cabinets, which become port bands (app-preview.js)
  // 1) panels, in the port colours (pro: a dark cabinet tinted by its port, --pc; brighter on the active port)
  var vis = visibleScreens(), groups = {}, act = (ui.mSender || 0) + ':' + (ui.mPort || 0);
  vis.forEach(function (s) {
    var g = groups[s.id] = el('g', { 'data-screen': s.id }, svg);
    if (pro && s.kind !== 'complex' && !s.drawn && !(typeof hlt !== 'undefined' && hlt.view !== 'off')) {   // the wall's shadow (not over a Live heat image)
      var wb = screenBounds(s); el('rect', { class: 'wall-sh', x: wb.x, y: wb.y, width: wb.w, height: wb.h, 'pointer-events': 'none' }, g);
    }
    cellsBy[s.id].forEach(function (c) {
      var cls = 'cab' + (c.hole ? ' hole' : c.unassigned ? ' unassigned' : '');
      var r = el('rect', { class: cls, x: c.x, y: c.y, width: c.w, height: c.h, 'data-k': c.k, 'stroke-width': unit }, g);
      if (c.hole || c.unassigned) return;
      var hf = hltCellFill(c);   // Live view (app-health.js)
      if (pro) {
        if (hf) { r.setAttribute('fill', LIVE_FILL_PRO[hf] || hf); r.setAttribute('class', cls + ' live'); }
        else { r.setAttribute('class', cls + ' pc' + (c.sender + ':' + c.port === act ? ' on' : '')); r.setAttribute('style', '--pc:' + portColor(c.sender, c.port)); }
        return;
      }
      r.setAttribute('fill', hf || portColor(c.sender, c.port));
      if (pvOn) { r.setAttribute('fill-opacity', 0.1); r.setAttribute('stroke', portColor(c.sender, c.port)); }
    });
  });
  // 2) cables, numbers and port names on top, VMP style: each port's run through all the
  // sections on this screen (in section order, as exported), a small arrow on every hop, the
  // cable position in each panel and "P1" on its first panel. Text sizes are in screen pixels
  // (clamped to the panel) so they stay readable without zooming in.
  var runs = {}, cards = {};
  vis.forEach(function (s, si) {
    cellsBy[s.id].forEach(function (c) {
      if (c.sender == null) return;
      (runs[c.sender + ':' + c.port] = runs[c.sender + ':' + c.port] || []).push({ c: c, si: si });
      cards[c.sender] = 1;
    });
  });
  var oneCard = Object.keys(cards).length <= 1, ppu = ui.pxPerUnit;
  var over = el('g', { class: 'port-overlay', 'pointer-events': 'none' }, svg);
  if (pro) renderPortsPro(over, runs, oneCard, unit, tk, act);
  else Object.keys(runs).forEach(function (pk) {
    var list = runs[pk].sort(function (a, b) { return a.si - b.si || a.c.connect - b.c.connect; }).map(function (x) { return x.c; });
    var f = list[0], minPx = Math.min(f.w, f.h) * ppu;
    var cx = function (c) { return c.x + c.w / 2; }, cy = function (c) { return c.y + c.h / 2; };
    if (ui.showWires) {
      if (list.length > 1) {
        // a hop between cabinets that touch is a solid cable; a hop that skips over a gap (the chain
        // jumps) is drawn dashed in the warning colour
        var solid = '', jump = '';
        for (var hi = 1; hi < list.length; hi++) {
          var p0 = list[hi - 1], p1 = list[hi], seg = 'M' + cx(p0) + ',' + cy(p0) + 'L' + cx(p1) + ',' + cy(p1);
          if (cellsTouch(p0, p1)) solid += seg; else jump += seg;
        }
        if (solid) el('path', { d: solid, fill: 'none', stroke: '#111', 'stroke-opacity': 0.55, 'stroke-width': 1.3 * unit, 'stroke-linejoin': 'round' }, over);
        if (jump) el('path', { class: 'wire-jump', d: jump, fill: 'none', 'stroke-width': 1.8 * unit, 'stroke-dasharray': (5 * unit) + ' ' + (4 * unit) }, over);
        // one arrowhead per hop, at the middle of the hop, pointing along the cable
        var a = clamp(Math.min(f.w, f.h) * ppu * 0.12, 3, 7) * unit, d = '';
        for (var i = 1; i < list.length; i++) {
          var x0 = cx(list[i - 1]), y0 = cy(list[i - 1]), x1 = cx(list[i]), y1 = cy(list[i]);
          var len = Math.hypot(x1 - x0, y1 - y0); if (!len) continue;
          var ux = (x1 - x0) / len, uy = (y1 - y0) / len, mx = (x0 + x1) / 2 + ux * a / 2, my = (y0 + y1) / 2 + uy * a / 2;
          d += 'M' + mx + ',' + my + 'L' + (mx - ux * a * 1.6 - uy * a) + ',' + (my - uy * a * 1.6 + ux * a) +
            'L' + (mx - ux * a * 1.6 + uy * a) + ',' + (my - uy * a * 1.6 - ux * a) + 'Z';
        }
        if (d) el('path', { d: d, fill: '#111', 'fill-opacity': 0.7 }, over);
      }
    }
    // The start / end of the run are drawn after the labels (below), so nothing covers them.
    var drawEnds = function () {
      if (!ui.showWires) return;
      var r = clamp(minPx * 0.11, 3.5, 8) * unit;
      if (list.length > 1) {                      // end of the run: a small square
        var l = list[list.length - 1], s2 = r * 0.75;
        el('rect', { class: 'wire-end', x: cx(l) - s2, y: cy(l) - s2, width: 2 * s2, height: 2 * s2, rx: s2 * 0.3, 'stroke-width': 1.5 * unit }, over);
      }
      el('circle', { class: 'wire-start', cx: cx(f), cy: cy(f), r: r * 1.35, 'stroke-width': 2 * unit }, over);   // cable in: a ring…
      if (list.length > 1) {                      // …with an arrowhead toward the next cabinet
        var n = list[1], dx = cx(n) - cx(f), dy = cy(n) - cy(f), dl = Math.hypot(dx, dy) || 1, ux = dx / dl, uy = dy / dl, a = r * 0.9;
        el('path', { class: 'wire-start-arrow', d: 'M' + (cx(f) + ux * a) + ',' + (cy(f) + uy * a) + 'L' + (cx(f) - ux * a * 0.6 - uy * a * 0.8) + ',' + (cy(f) - uy * a * 0.6 + ux * a * 0.8) +
          'L' + (cx(f) - ux * a * 0.6 + uy * a * 0.8) + ',' + (cy(f) - uy * a * 0.6 - ux * a * 0.8) + 'Z' }, over);
      } else el('circle', { class: 'wire-start-dot', cx: cx(f), cy: cy(f), r: r * 0.55 }, over);
    };
    if (!ui.showLabels) return drawEnds();
    var halo = { fill: '#111', stroke: '#fff', 'stroke-opacity': 0.75, 'paint-order': 'stroke', 'stroke-linejoin': 'round' };
    list.forEach(function (c, i) {            // cable position, lower right of each panel
      // as big as the panel allows (digits ~0.6 em wide), 7-16 px on screen
      var txt = String(i + 1), wpx = c.w * ppu, hpx = c.h * ppu;
      var fs = Math.min(hpx * 0.42, wpx * 0.85 / (txt.length * 0.6), 16 * tk);   // Text size raises the limit (app-forms.js)
      if (fs < 7) return;
      var pad = Math.max(1.5, Math.min(wpx, hpx) * 0.07) * unit;
      el('text', Object.assign({ x: c.x + c.w - pad, y: c.y + c.h - pad, 'font-size': fs * unit,
        'text-anchor': 'end', 'stroke-width': 2.5 * unit }, halo), over).textContent = txt;
    });
    // Port name on its first panel as a tag in the top-left corner, in the port's colour (as VMP labels its ports), so the
    // cable-in marker in the middle of the panel stays visible. Sized to the panel: up to ~45 % of its width.
    var wpxF = f.w * ppu, hpxF = f.h * ppu, tag = oneCard ? 'P' + (f.port + 1) : portLabel(f.sender, f.port);
    var fsP = Math.min(wpxF * 0.45 / (tag.length * 0.62), hpxF * 0.26, 15 * tk);
    if (fsP < 7 && !oneCard) { tag = 'P' + (f.port + 1); fsP = Math.min(wpxF * 0.45 / (tag.length * 0.62), hpxF * 0.26, 15 * tk); }
    if (fsP >= 6.5) {
      var padT = Math.max(1, Math.min(wpxF, hpxF) * 0.04) * unit, tw = (tag.length * fsP * 0.62 + 6) * unit, th = (fsP + 4) * unit;
      el('rect', { x: f.x + padT, y: f.y + padT, width: tw, height: th, rx: 3 * unit, fill: portColor(f.sender, f.port), stroke: '#0b0e14', 'stroke-width': 1 * unit, 'stroke-opacity': 0.6 }, over);
      el('text', { x: f.x + padT + 3 * unit, y: f.y + padT + th / 2, 'font-size': fsP * unit, 'font-weight': 800, fill: '#0b0e14', 'dominant-baseline': 'central' }, over).textContent = tag;
    }
    drawEnds();
  });
  // sections overlapping each other: their shared cabinets get a red hatch-like outline
  var ovl = overlapCells(vis, cellsBy);
  Object.keys(ovl).forEach(function (k) { var c = ovl[k]; el('rect', { class: 'cab-overlap', x: c.x, y: c.y, width: c.w, height: c.h, 'stroke-width': 2 * unit, 'pointer-events': 'none' }, svg); });
  vis.forEach(function (s) {
    var g = groups[s.id], cells = cellsBy[s.id];
    if (ui.selScreen === s.id && ui.selKeys && ui.selKeys.size) {
      cells.forEach(function (c) {
        if (ui.selKeys.has(c.k)) el('rect', { class: 'cab-sel', x: c.x, y: c.y, width: c.w, height: c.h, 'stroke-width': 2 * unit }, g);
      });
    }
    var b = screenBounds(s);
    var msel = s.id !== ui.sel && ui.selSecs && ui.selSecs.has(s.id);   // multi-selection (app-arrange.js)
    el('rect', { class: 'scr-outline' + (s.id === ui.sel ? ' sel' : msel ? ' msel' : ''), x: b.x, y: b.y, width: b.w, height: b.h, 'stroke-width': (s.id === ui.sel || msel ? (pro ? 1.5 : 2.5) : pro ? 1 : 1.2) * unit, 'pointer-events': 'none' }, g);
    if (pro && s.id === ui.sel && b.w * ui.pxPerUnit > 40) {   // the gallery's selection handles: corners and edge middles (a mark only, not a resize grip)
      var hs = 7 * unit;
      [[0, 0], [.5, 0], [1, 0], [0, .5], [1, .5], [0, 1], [.5, 1], [1, 1]].forEach(function (q) {
        el('rect', { class: 'sel-hnd', x: b.x + b.w * q[0] - hs / 2, y: b.y + b.h * q[1] - hs / 2, width: hs, height: hs, rx: 1.5 * unit, 'stroke-width': unit, 'pointer-events': 'none' }, svg);
      });
    }
    // no "Section N" name label over it (user, 2026-10-11: "section 1 we dont need this. it is not in any other apps")
  });
  // a selected group: one dashed box around all of its cabinets (no name on the canvas either)
  var gsel = groupOf(screenById(ui.sel));
  if (gsel) {
    var gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
    vis.forEach(function (s) { if (s.group !== gsel.id) return; var gb = screenBounds(s); gx0 = Math.min(gx0, gb.x); gy0 = Math.min(gy0, gb.y); gx1 = Math.max(gx1, gb.x + gb.w); gy1 = Math.max(gy1, gb.y + gb.h); });
    var gp = 6 * unit;
    if (gx1 > gx0) el('rect', { class: 'grp-outline', x: gx0 - gp, y: gy0 - gp, width: gx1 - gx0 + 2 * gp, height: gy1 - gy0 + 2 * gp, 'stroke-width': 1.5 * unit, 'stroke-dasharray': (6 * unit) + ' ' + (4 * unit), 'pointer-events': 'none' }, svg);
  }
  (ui.snapGuides || []).forEach(function (gd) {
    if (gd.x != null) el('line', { class: 'snap-guide', x1: gd.x, x2: gd.x, y1: v.y - v.h, y2: v.y + 2 * v.h, 'stroke-width': 1.5 * unit }, svg);
    else el('line', { class: 'snap-guide', y1: gd.y, y2: gd.y, x1: v.x - v.w, x2: v.x + 2 * v.w, 'stroke-width': 1.5 * unit }, svg);
  });
  if (ui.marquee) {
    var mq = ui.marquee;
    el('rect', { class: 'marquee', x: mq.x0, y: mq.y0, width: mq.x1 - mq.x0, height: mq.y1 - mq.y0, 'stroke-width': 1.5 * unit }, svg);
    // size of the selection in panels, at the box's corner: "28 × 3 · 84"
    var mqs = screenById(ui.selScreen), mxs = {}, mys = {}, mn = 0;
    if (mqs) cellGeom(mqs).forEach(function (g) { if (ui.selKeys.has(g.k)) { mxs[g.x] = 1; mys[g.y] = 1; mn++; } });
    if (mn) {
      var mfs = 11 * tk * unit, mt = el('text', { x: mq.x0, y: mq.y0 - 5 * unit, 'font-size': mfs, 'font-weight': 600, fill: 'currentColor', 'paint-order': 'stroke', stroke: 'var(--bg)', 'stroke-width': 3 * unit }, svg);
      mt.textContent = Object.keys(mxs).length + ' × ' + Object.keys(mys).length + ' · ' + cabsText(mn);
    }
  }
  sdPaint();   // Self draw ghost + cable preview on top, and the panel counter (app-selfdraw.js)
  renderHealthOverlay(svg, cellsBy, unit);   // Live view: backup hatching, break marker, temperatures (app-health.js)
  renderQuickAdd();   // Quick add wall preview, handles and its box (app-quickadd.js)
  coordTagPlace();   // the hover "x,y" tag follows pan / zoom / drags (app-screenfit.js)
  renderRulers(svg, unit);   // optional rulers on top (app-arrange.js)
  renderIdentify(svg, unit);   // the panel being identified pulses (app-display.js)
  if (typeof navUpdate === 'function') navUpdate(cellsBy);   // the navigator's view box (app-navigator.js)
}

// The pro look's ports over the cabinets (docs/DESIGN_SYSTEM.md; the gallery app/out/pro/layout.html): each port's outline in
// its colour (the cabinet sides no other cabinet of that port shares, drawn just inside), a thin cable through the cabinet
// centres with a small arrow per hop (a hop that jumps a gap: dashed, warning colour), a hollow circle where the cable comes
// in and a filled square where it ends, the cable position in small mono figures, and a rounded plate "P3" ("P3 ← P13"
// with a backup port) on the first cabinet. The active port (act, the one Manual / Self draw wire onto) is drawn brighter.
// Live views keep only the plates, so the readings show. Colours and weights are classes (looks/pro-canvas.css).
function renderPortsPro(over, runs, oneCard, unit, tk, act) {
  var ppu = ui.pxPerUnit, live = typeof hlt !== 'undefined' && hlt.view !== 'off', plates = [];
  var cx = function (c) { return c.x + c.w / 2; }, cy = function (c) { return c.y + c.h / 2; };
  var gE = el('g', { class: 'pw-edges' }, over), gW = el('g', { class: 'pw-wires' }, over), gN = el('g', { class: 'pw-nums' }, over), gT = el('g', { class: 'pw-tops' }, over);
  Object.keys(runs).forEach(function (pk) {
    var list = runs[pk].sort(function (a, b) { return a.si - b.si || a.c.connect - b.c.connect; }).map(function (x) { return x.c; });
    var f = list[0], on = pk === act, col = portColor(f.sender, f.port), minPx = Math.min(f.w, f.h) * ppu, i;
    if (!live) {   // outline: count each side; a side two cabinets share is inside the port
      var side = {}, d = '', ins = (on ? 1 : 0.7) * unit;
      list.forEach(function (c) {
        var x0 = c.x, y0 = c.y, x1 = c.x + c.w, y1 = c.y + c.h;
        [['H', x0, y0, x1, ins], ['V', x1, y0, y1, -ins], ['H', x0, y1, x1, -ins], ['V', x0, y0, y1, ins]].forEach(function (e) {
          var k = e[0] + e[1] + ',' + e[2] + ',' + e[3]; if (side[k]) side[k].n++; else side[k] = { n: 1, e: e };
        });
      });
      Object.keys(side).forEach(function (k) {
        var s = side[k]; if (s.n > 1) return; var e = s.e;
        d += e[0] === 'H' ? 'M' + e[1] + ',' + (e[2] + e[4]) + 'H' + e[3] : 'M' + (e[1] + e[4]) + ',' + e[2] + 'V' + e[3];
      });
      el('path', { class: 'pw-edge' + (on ? ' on' : ''), d: d, style: '--pc:' + col, 'stroke-width': (on ? 2 : 1.25) * unit }, gE);
    }
    if (!live && ui.showWires) {
      var r = clamp(minPx * 0.045, 2.2, 4) * unit * (on ? 1.25 : 1);
      if (list.length > 1) {
        var solid = '', jump = '', arr = '', a = clamp(minPx * 0.05, 2.2, 4) * unit * (on ? 1.15 : 1);
        for (i = 1; i < list.length; i++) {
          var p0 = list[i - 1], p1 = list[i], x0 = cx(p0), y0 = cy(p0), x1 = cx(p1), y1 = cy(p1), seg = 'M' + x0 + ',' + y0 + 'L' + x1 + ',' + y1;
          if (cellsTouch(p0, p1)) solid += seg; else jump += seg;
          var len = Math.hypot(x1 - x0, y1 - y0); if (!len || len * ppu < 18) continue;   // one arrowhead at the middle of each hop
          var ux = (x1 - x0) / len, uy = (y1 - y0) / len, mx = (x0 + x1) / 2 + ux * a, my = (y0 + y1) / 2 + uy * a;
          arr += 'M' + mx + ',' + my + 'L' + (mx - ux * a * 1.7 - uy * a) + ',' + (my - uy * a * 1.7 + ux * a) + 'L' + (mx - ux * a * 1.7 + uy * a) + ',' + (my - uy * a * 1.7 - ux * a) + 'Z';
        }
        if (solid) el('path', { class: 'pw-line' + (on ? ' on' : ''), d: solid, 'stroke-width': (on ? 1.6 : 1.1) * unit }, gW);
        if (jump) el('path', { class: 'wire-jump', d: jump, fill: 'none', 'stroke-width': 1.6 * unit, 'stroke-dasharray': (5 * unit) + ' ' + (4 * unit) }, gW);
        if (arr) el('path', { class: 'pw-arrow' + (on ? ' on' : ''), d: arr }, gW);
        var l = list[list.length - 1], s2 = r * 0.85;
        el('rect', { class: 'pw-end' + (on ? ' on' : ''), x: cx(l) - s2, y: cy(l) - s2, width: 2 * s2, height: 2 * s2, rx: s2 * 0.25 }, gT);
      }
      el('circle', { class: 'pw-start' + (on ? ' on' : ''), cx: cx(f), cy: cy(f), r: r, 'stroke-width': (on ? 1.8 : 1.3) * unit }, gT);
    }
    if (!ui.showLabels) return;
    if (!live) list.forEach(function (c, n) {   // cable position, lower right of each cabinet
      var txt = String(n + 1), wpx = c.w * ppu, hpx = c.h * ppu, fs = Math.min(9.5 * tk, hpx * 0.3, wpx * 0.8 / (txt.length * 0.62));
      if (fs < 6.5) return;
      var pad = clamp(Math.min(wpx, hpx) * 0.06, 2, 5) * unit;
      el('text', { class: 'pw-num', x: c.x + c.w - pad, y: c.y + c.h - pad - fs * 0.15 * unit, 'font-size': fs * unit, 'text-anchor': 'end', 'stroke-width': 2.4 * unit }, gN).textContent = txt;
    });
    // the plate: "P3", the processor's name too when this screen shows more than one card, "← P13" when a port backs it up
    var role = typeof backupRole === 'function' ? backupRole(f.sender, f.port) : null, tag = oneCard ? 'P' + (f.port + 1) : portLabel(f.sender, f.port);
    if (role && !role.backup) tag += ' ← ' + (role.s === f.sender ? 'P' + (role.p + 1) : portLabel(role.s, role.p));
    var wpxF = f.w * ppu, hpxF = f.h * ppu, fsP = Math.min(11 * tk, hpxF * 0.3, wpxF * 0.85 / (tag.length * 0.56));
    if (fsP < 7 && tag !== 'P' + (f.port + 1)) { tag = 'P' + (f.port + 1); fsP = Math.min(11 * tk, hpxF * 0.3, wpxF * 0.85 / (tag.length * 0.56)); }
    if (fsP < 6.5) return;
    var pad = clamp(Math.min(wpxF, hpxF) * 0.03, 2, 4) * unit, th = (fsP + 4.5) * unit, g = el('g', { class: 'pw-plate' + (on ? ' on' : '') }, gT);
    var bg = el('rect', { x: f.x + pad, y: f.y + pad, width: th * 1.6, height: th, rx: 3 * unit, style: '--pc:' + col, 'stroke-width': unit }, g);
    var t = el('text', { x: f.x + pad + 4.5 * unit, y: f.y + pad + th / 2, 'font-size': fsP * unit, 'dominant-baseline': 'central' }, g);
    t.textContent = tag;
    plates.push([bg, t]);
  });
  // plate widths from the drawn text (measured together: one layout)
  plates.map(function (p) { try { return p[1].getComputedTextLength(); } catch (e) { return 0; } })
    .forEach(function (w, i) { if (w > 0) plates[i][0].setAttribute('width', w + 9 * unit); });
}

function renderStatus(probs) {
  var st = $('status');
  if (ui.hover) { st.textContent = ui.hover; st.style.color = ''; return; }
  if (probs.length) { st.textContent = '⚠ ' + probs[0] + (probs.length > 1 ? '  (+' + (probs.length - 1) + ' more)' : ''); st.style.color = 'var(--danger)'; }
  else { st.textContent = P.screens.length ? 'No problems found.' : 'Add cabinets to start.'; st.style.color = ''; }
  st.classList.toggle('bad', !!probs.length); st.classList.toggle('ok', !probs.length && !!P.screens.length);   // the pro look's status dot
  ui.lastProbs = probs;
}

function renderModeBadge() {
  var b = $('modeBadge');
  var s = screenById(ui.sel), cur = portLabel(ui.mSender || 0, ui.mPort || 0);
  if (ui.tool === 'quick') { b.hidden = false; b.textContent = keysText(qaBadgeText()); }   // app-quickadd.js
  else if (ui.tool === 'draw') { b.hidden = false; b.textContent = keysText('Self draw — ' + cur + ' · click to place, drag for a block, Shift+click new string, R rotates, Esc to finish'); }
  else if (s && s.wiring.mode === 'manual' && ui.tool !== 'hole') { b.hidden = false; b.textContent = 'Drawing ' + cur + ' — click / arrows / Tab'; }
  else if (ui.tool === 'hole') { b.hidden = false; b.textContent = 'Set blank — click or drag cabinets, Esc to stop'; }
  else b.hidden = true;
}

// Toolbar switch Auto | Manual | Self draw (#modeSeg). Auto / Manual mirror the selected
// section's wiring mode (the only such switch since the UI cleanup); Self draw is ui.tool 'draw'.
function renderModeSeg() {
  var s = screenById(ui.sel), drawing = ui.tool === 'draw';
  Array.prototype.forEach.call($('modeSeg').children, function (b) {
    var m = b.dataset.mode, on;
    if (m === 'draw') { on = drawing; b.disabled = false; }
    else {
      on = !drawing && !!s && s.wiring.mode === m;
      // while drawing they're always clickable: a click leaves Self draw; greyed, the tooltip says why
      b.disabled = !drawing && (!s || (m === 'auto' && s.kind === 'complex'));
      if (b.dataset.tip == null) b.dataset.tip = b.title;
      var t = !b.disabled ? b.dataset.tip : !s ? (P.screens.length ? 'Select cabinets first' : 'Add cabinets first (+ Cabinets or Quick add)') : 'A complex screen is wired by hand (Manual)';
      if (b.title !== t) b.title = t;
    }
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
}

function renderAll() {
  if (typeof olView === 'function') olView();   // online: only connected processors are worked on and drawn (app-online.js)
  fixSel(); groupsFix();   // groups whose cabinets are gone (app-sections.js)
  if (typeof simEnsure === 'function') simEnsure();   // offline project: every processor simulated by itself (drv-offline.js)
  var cellsBy = allCells(), use = portUsage(cellsBy);
  renderTree(use, cellsBy);
  renderOutput(); renderCardEditor(use); renderPanelLibrary(); renderScreenForm(); renderPanelCard(); renderPortList(use);
  renderScreenFit();   // Match Screen + rotation buttons (app-screenfit.js)
  renderBackup(use);   // the backup plan card (app-backup.js, on the Backup tab)
  renderRedundancy();  // Backup tab per processor + Layout's summary (app-redundancy.js)
  renderPresets();     // Preset tab: scenes (app-presets.js)
  renderMaintain();    // Tools ▸ Maintain: cabinet table + configuration check (app-maintain.js)
  renderLibrary();     // Tools ▸ Cabinet library (app-library.js)
  renderDiag();        // Tools ▸ Diagnostics (app-diag.js)
  renderDashboard();   // the project dashboard (app-dashboard.js)
  renderSchedule();    // Schedule tab (app-schedule.js)
  renderDevices(use);  // Processors tab, when it is shown (app-devices.js)
  renderHealth();      // Health tab, when it is shown (app-health.js)
  renderScreenTab();   // Screen Settings tab, when it is shown (app-screen.js)
  renderCorrection();  // Correction tab, when it is shown (app-correction.js)
  renderMenuBar();     // the project's name in the menu bar (app-menubar.js)
  renderCanvas(cellsBy); renderStatus(problems(cellsBy, use)); renderModeBadge(); renderModeSeg();
  $('btnUndo').disabled = !ui.undo.length; $('btnRedo').disabled = !ui.redo.length;
  if (typeof renderUnsaved === 'function') renderUnsaved(true);   // the "not saved" bar follows the project (app-save.js)
  if (typeof dispTiles === 'function') dispTiles();                 // Blackout / Freeze / Normal follow the links (app-display.js)
  if (typeof renderPipe === 'function') renderPipe(use, cellsBy);   // the pro look's pipeline strip (app-pipeline.js)
  if (typeof ctlEnhance === 'function') ctlEnhance();               // and its controls (app-controls.js)
}
function renderLight() {   // canvas + port list only (during drags)
  var cellsBy = allCells(), use = portUsage(cellsBy);
  renderCanvas(cellsBy); renderPortList(use); renderStatus(problems(cellsBy, use));
}

function zoom(f) {
  var v = ui.view, cx = v.x + v.w / 2, cy = v.y + v.h / 2;
  v.w *= f; v.h *= f; v.x = cx - v.w / 2; v.y = cy - v.h / 2; renderCanvas(allCells());
}
