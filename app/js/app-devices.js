// app-devices.js - the Processors module (NovaStar Unico's "Device" tab; the tabs across the top are
// app-shell.js) — the Processors tab itself:
//   left:   the project and its processors in cascade order (search, click selects);
//   centre: one card per processor (name, model, sending cards, a small drawing of its outputs;
//           drag or ← / → to change the cascade order) plus a dashed "+ Add processor" card, and
//           under them the selected processor's rear panel: every output port, coloured like the
//           canvas when a screen uses it, with its load; H-series chassis draw each slot's output
//           card. Clicking a port opens it in Layout (active card / port);
//   right:  "Processor properties": name, model, cascade position, its output cards (type per slot, add /
//           remove; the ports of a "Pick a model" processor's cards), the Hardware card (app-hardware.js) and, folded away
//           at the bottom, Service: restart / factory reset (app-service.js) and Remove processor.
// Right-click a processor card (or its row in the tree): Earlier / Later / Remove (UI cleanup, docs/UI_STREAMLINE_PROPOSAL.md
// item 6: the panel's Earlier / Later buttons and the card's Remove button moved there; drag and the card's arrows still reorder).
// The "Add processor" picker is also the first question of a new project ("Which processors are you using?"; a new
// project has no processor). Online it lists ONLY the processors found right now (one click = added and linked,
// app-online.js); offline ONLY the model catalogue (families → models, quantity, H-series output cards). Never both, as in
// VMP; the switch is in its header (and Tools ▸ Enter / Exit offline mode). There is no generic processor to pick.
// Owns: bindDevices, renderDevices, renderDevProps, devSelected, devShow,
// devGoPort, devRangeText, devIsBlank, devAdd, devBands, devPerRow, devListHtml,
// devCardHtml, devPortCount, devPortWords, devModelChange, devMiniSvg, devRearSvg, devPortsHtml, fillSelect, cardOptionGroups, devPick, devPickerDialog,
// devOpenPicker, devRenderPicker, devRenderPickSum, devClosePicker, devFirstRun, devMenu, devSvcFold, devMultiPick, devMultiClear;
// ui.devSel (selected processor id), ui.devMulti (ids picked together with Ctrl/⌘ / Shift: the pro look's strip shows them), ui.devDrag (id of the card being dragged), ui.devSvcOpen (the Service section is open).
// Depends on: app-core (P, ui, $, esc, uid, int, log, commit, toast, save, snapshot, lctById,
// MAX_CARD_PORTS), app-processors (the data layer: PROC_MODELS, PROC_ORDER, OUTPUT_CARDS,
// procModel, procModelOptions, deviceById, deviceOfCard, cardsOfDevice, deviceLabel,
// cardTypeLabel, newProcName, wiredCards, cardList, applyCards, cardChangeToast, addProcessor,
// addOutputCard, removeProcessor, setProcessorModel, setOutputCardType, setCardPorts,
// moveProcessor, lctDevMap, lctScreensOf), app-sections (removeSendingCard, addLctScreen, lctMenu, showScreen), app-tree
// (activateCard), app-scr-io (lctScreenType), app-capacity (portColor,
// portLabel, portUsage), app-geometry (allCells), app-render (renderAll), all at run time.
// renderDevices is called from renderAll; bindDevices and devFirstRun from main.js.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ helpers
// The processor shown in the Processors tab: the one picked there, else the one of the active
// sending card, else the first.
// Online, only a connected processor (app-online.js olShown).
function devSelected() {
  var on = typeof olShown === 'function' ? function (d) { return d && olShown(d) ? d : null; } : function (d) { return d; };
  return on(deviceById(ui.devSel)) || on(deviceOfCard(ui.mSender || 0)) || (typeof olShownDevices === 'function' ? olShownDevices() : P.devices)[0];
}
// Several processors at once (the tree's Processors view, the strip's processor switcher): Ctrl/⌘-click adds / takes one away,
// Shift-click takes the range from the selected one; a plain click or Esc goes back to one. Only what is shown changes (the
// pro look's strip shows each of them); nothing is sent.
function devMultiPick(d, range) {
  var cur = devSelected(), set = (ui.devMulti && ui.devMulti.length > 1 ? ui.devMulti : cur ? [cur.id] : []).slice();
  if (range && cur) { var a = P.devices.indexOf(cur), b = P.devices.indexOf(d); set = P.devices.slice(Math.min(a, b), Math.max(a, b) + 1).map(function (x) { return x.id; }); }
  else { var i = set.indexOf(d.id); if (i >= 0) set.splice(i, 1); else set.push(d.id); }
  ui.devMulti = set.length > 1 ? set : [];
  if (set.length === 1) ui.devSel = set[0];
  log('select_processors', { processors: set.map(function (id) { var x = deviceById(id); return x ? deviceLabel(x) : id; }) });
  renderAll();
}
function devMultiClear() { if (!ui.devMulti || !ui.devMulti.length) return false; ui.devMulti = []; log('select_processors', { processors: 'one' }); renderAll(); return true; }
// "sending card 4" / "sending cards 4–6" (a chassis), "card 4" (a "Pick a model" processor), "16 ports" (a fixed one)
function devRangeText(idx, short) {
  if (!idx.length) return 'no cards';
  if (idx.every(function (i) { return !cardIsReal(i); })) return portsOfSender(idx[0]) + ' ports';   // a fixed processor: no card numbers
  var dv = deviceOfCard(idx[0]), w = short || !dv || procModel(dv.model).kind !== 'chassis' ? 'card' : 'sending card';
  return idx.length === 1 ? w + ' ' + (idx[0] + 1) : w + 's ' + (idx[0] + 1) + '–' + (idx[idx.length - 1] + 1);
}
// Open processor d in the Processors tab (from the tree or the Sending card card).
function devShow(d) {
  if (d) ui.devSel = d.id;
  log('open_processor', { processor: d ? deviceLabel(d) : undefined });
  setTab('devices');
}
// A port clicked on the rear panel: make it the active port and show it in Layout, on the
// screen that uses it (if one does).
function devGoPort(card, port) {
  var u = portUsage(allCells())[card + ':' + port], lct = u && Object.keys(u.lct)[0];
  ui.mSender = card; ui.mPort = port;
  log('select_port', { port: portLabel(card, port), via: 'processor_rear_panel' });
  if (lct && lct !== ui.viewScreen) { ui.viewScreen = lct; ui.view = null; ui.selKeys = new Set(); ui.selScreen = null; ui.sel = null; }
  else if (!lct) lctShowFor(card);   // a free port: a screen of its processor (a screen belongs to one processor, app-sections.js)
  setTab('layout');
}
// A project nobody has set processors for yet: no processor, no sections.
function devIsBlank() {
  return P.procsChosen !== true && !P.screens.length && !P.devices.length;
}

// Add qty units of model key, cascaded after the last processor (one undo step). A chassis gets
// nCards output cards of cardType. Only real models (never "Pick a model").
function devAdd(key, qty, cardType, nCards) {
  var m = procModel(key), cards = cardList(), added = [];
  if (!PROC_MODELS[key] || m.kind === 'custom') return toast('Pick a model');
  for (var u = 0; u < qty; u++) {
    var d = { id: uid(), model: key, name: newProcName(P.devices, key) };
    P.devices.push(d); added.push(d);
    if (m.kind === 'chassis') {
      var t = m.cardTypes.indexOf(cardType) >= 0 ? cardType : m.cardTypes[0];
      for (var k = 0; k < Math.max(1, Math.min(m.slots, nCards || 1)); k++) cards.push({ ports: OUTPUT_CARDS[t].ports, type: t, dev: d.id, old: null });
    } else for (k = 0; k < m.cards; k++) cards.push({ ports: m.ports, dev: d.id, old: null });
  }
  P.procsChosen = true;
  var pinned = applyCards(cards), idx = [];
  added.forEach(function (d) { idx = idx.concat(cardsOfDevice(d)); });
  ui.devSel = added[0].id; ui.mSender = idx[0]; ui.mPort = 0;
  log('add_processor', { model: m.name, units: qty, output_cards: m.kind === 'chassis' ? nCards + ' × ' + OUTPUT_CARDS[cardType].name : undefined,
    mode: 'offline catalogue', cards: idx.map(function (i) { return i + 1; }) });
  commit(); renderAll();
  cardChangeToast('Added ' + (qty > 1 ? qty + ' × ' : '') + m.name + (m.kind === 'fixed' ? '' : ' — ' + devRangeText(idx)), pinned);
}

// <option> rows for picking a sending card, grouped under their processor. n = how many cards
// to offer (past the last card: "not added").
function cardOptionGroups(sel, n) {
  var h = '', cur = null, gone = typeof olGone === 'function' ? olGone() : [];   // online: not the cards of a processor that isn't connected
  for (var i = 0; i < n; i++) {
    var c = P.processors[i], d = c && deviceById(c.dev), g = d ? d.id : '-';
    if (d && i !== sel && gone.indexOf(d) >= 0) continue;
    if (g !== cur) {
      if (cur !== null) h += '</optgroup>';
      h += '<optgroup label="' + esc(d ? deviceLabel(d) + ' · ' + procModel(d.model).name : 'Not added') + '">';
      cur = g;
    }
    h += '<option value="' + i + '"' + (i === sel ? ' selected' : '') + '>' + esc(cardName(i)) +
      (c ? ' · ' + c.ports + ' ports' : ' (not added)') + '</option>';
  }
  return h + (cur !== null ? '</optgroup>' : '');
}
// Refill a <select> with [value, text, group?] rows (rows with a group go under an <optgroup>)
// and pick `value`. A value that isn't offered (an old model key) is added so it still shows,
// named from `table` (PROC_MODELS or OUTPUT_CARDS) or "(unknown …)".
function fillSelect(sel, opts, value, table) {
  if (value != null && !opts.some(function (o) { return o[0] === value; }))
    opts = opts.concat([[value, table && table[value] ? table[value].name : '(unknown: ' + value + ')']]);
  var sig = opts.map(function (o) { return o.join('='); }).join('|');
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = '';
    var grp = null, grpName = null;
    opts.forEach(function (o) {
      var e = document.createElement('option'); e.value = o[0]; e.textContent = o[1];
      if (o[2]) {
        if (o[2] !== grpName) { grp = document.createElement('optgroup'); grp.label = grpName = o[2]; sel.appendChild(grp); }
        grp.appendChild(e);
      } else { grpName = null; sel.appendChild(e); }
    });
    sel.dataset.sig = sig;
  }
  if (value != null) sel.value = value; else sel.selectedIndex = -1;
}

// ------------------------------------------------------------------ drawings
// The bands of a processor's drawing: one per sending card; a chassis also gets its empty slots.
function devBands(d) {
  var m = procModel(d.model), idx = cardsOfDevice(d), out = [];
  if (m.kind === 'chassis') for (var s = 0; s < Math.max(m.slots, idx.length); s++) out.push(idx[s] != null ? { card: idx[s], slot: s } : { empty: true, slot: s });
  else idx.forEach(function (i, k) { out.push({ card: i, slot: k }); });
  return out;
}
function devPerRow(n) { return n <= 20 ? n : Math.ceil(n / Math.ceil(n / 20)); }

// Small drawing for the processor card: the unit with its output ports as dots, one row of
// ports per sending card (an H chassis: one strip per slot, empty slots dashed).
function devMiniSvg(d, use) {
  var bands = devBands(d), sq = 6, g = 2, pad = 6, y = pad, rows = '', maxW = 10;
  bands.forEach(function (b) { if (!b.empty) maxW = Math.max(maxW, devPerRow(P.processors[b.card].ports)); });
  var W = pad * 2 + maxW * (sq + g) - g, bandGap = bands.length > 8 ? 2 : 4;
  bands.forEach(function (b) {
    if (b.empty) { rows += '<rect class="dm-empty" x="' + pad + '" y="' + y + '" width="' + (W - 2 * pad) + '" height="' + sq + '" rx="1.5"/>'; y += sq + bandGap; return; }
    var n = P.processors[b.card].ports, per = devPerRow(n);
    for (var p = 0; p < n; p++) {
      var x = pad + (p % per) * (sq + g), yy = y + Math.floor(p / per) * (sq + g), u = use[b.card + ':' + p];
      rows += '<rect class="dm-port' + (u ? (u.load > u.cap ? ' over' : ' used') : '') + '" x="' + x + '" y="' + yy + '" width="' + sq + '" height="' + sq + '" rx="1.2"' +
        (u ? ' style="fill:' + portColor(b.card, p) + '"' : '') + '/>';
    }
    y += Math.ceil(n / per) * (sq + g) - g + bandGap;
  });
  var H = y - bandGap + pad;
  return '<svg class="dv-mini" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
    '<rect class="dm-face" x=".5" y=".5" width="' + (W - 1) + '" height="' + (H - 1) + '" rx="3"/>' + rows + '</svg>';
}

// The rear panel of processor d: "OUTPUT" strip, one band per sending card (slot) with its
// ports numbered, coloured when a screen uses them, and a load bar under each.
function devRearSvg(d, use) {
  var m = procModel(d.model), bands = devBands(d), PW = 30, PH = 22, GX = 7, ROW = 50, LW = 168, X0 = 40, TOP = 12;
  var maxPer = 10;
  bands.forEach(function (b) { if (!b.empty) maxPer = Math.max(maxPer, devPerRow(P.processors[b.card].ports)); });
  var px0 = X0 + LW, W = px0 + maxPer * (PW + GX) - GX + 20, y = TOP, s = '', act = ui.mSender || 0, actP = ui.mPort || 0;
  // the pro look draws the unit (looks/pro-pages.css): each slot a card plate with screws, two LEDs per jack (link / backup)
  var bk = {}, bkp = typeof bkRead === 'function' ? bkRead() : { mode: 'none' };
  if (bkp.mode === 'port') bkp.pairs.forEach(function (q) { bk[q.bs + ':' + q.bp] = 1; });
  var screw = function (x, yy) { return '<circle class="dr-screw" cx="' + x + '" cy="' + yy + '" r="3.2"/><path class="dr-slot" d="M' + (x - 2) + ',' + yy + 'h4"/>'; };
  var plate = function (y0, h, empty) { return '<g class="pro-only"><rect class="dr-plate' + (empty ? ' empty' : '') + '" x="' + (X0 - 4) + '" y="' + y0 + '" width="' + (W - X0 - 6) + '" height="' + h + '" rx="2"/>' + screw(X0 + 3, y0 + h / 2) + screw(W - 14, y0 + h / 2) + '</g>'; };
  bands.forEach(function (b, bi) {
    if (bi) s += '<line class="dr-sep" x1="' + X0 + '" x2="' + (W - 10) + '" y1="' + (y - 6) + '" y2="' + (y - 6) + '"/>';
    s += b.empty ? plate(y - 2, 40, true) : plate(y - 4, Math.max((Math.ceil(P.processors[b.card].ports / devPerRow(P.processors[b.card].ports)) - 1) * ROW + 50, 60));
    if (b.empty) {
      s += '<text class="dr-lbl" x="' + (X0 + 12) + '" y="' + (y + 22) + '">Slot ' + (b.slot + 1) + '</text>' +
        '<g class="dr-add" data-act="addcard"><title>Empty slot — click to add an output card</title>' +
        '<rect x="' + px0 + '" y="' + (y + 6) + '" width="' + (W - 20 - px0) + '" height="26" rx="4"/>' +
        '<text x="' + (px0 + (W - 20 - px0) / 2) + '" y="' + (y + 23) + '">Empty slot · + Add output card</text></g>';
      y += 44;
      return;
    }
    var c = P.processors[b.card], n = c.ports, per = devPerRow(n), nr = Math.ceil(n / per), used = 0;
    for (var p = 0; p < n; p++) if (use[b.card + ':' + p]) used++;
    var sub = m.kind === 'chassis' ? 'Slot ' + (b.slot + 1) + ' · ' + cardTypeLabel(c).replace(/^H /, '') : n + ' ports';
    s += '<g class="dr-card' + (b.card === act ? ' on' : '') + '" data-act="card" data-card="' + b.card + '"><title>' + esc(cardName(b.card)) + ' — click to open it in Layout</title>' +
      '<text class="dr-name" x="' + (X0 + 12) + '" y="' + (y + 20) + '">' + esc(cardName(b.card)) + '</text>' +
      '<text class="dr-lbl" x="' + (X0 + 12) + '" y="' + (y + 36) + '">' + esc(sub) + '</text>' +
      '<text class="dr-lbl" x="' + (X0 + 12) + '" y="' + (y + 51) + '">' + used + ' of ' + n + ' used</text></g>';
    for (p = 0; p < n; p++) {
      var x = px0 + (p % per) * (PW + GX), yy = y + Math.floor(p / per) * ROW, k = b.card + ':' + p, u = use[k];
      var pct = u ? (u.cap ? u.load / u.cap : Infinity) : 0, on = b.card === act && p === actP;
      var cls = 'dr-port' + (u ? ' used' : '') + (u && u.load > u.cap ? ' over' : '') + (on ? ' on' : '') + (bk[k] ? ' bk' : ''), led = u ? 'ok' : bk[k] ? 'bk' : 'off';
      var tip = portLabel(b.card, p) + (u ? ' · ' + u.cabs + ' cabinet' + (u.cabs === 1 ? '' : 's') + ' · ' + (isFinite(pct) ? Math.round(pct * 100) + '%' : '—') +
        ' of capacity · on ' + Object.keys(u.lct).map(function (l) { return (lctById(l) || {}).name || '?'; }).join(', ') : ' · free') + ' — click to draw on it in Layout';
      s += '<g class="' + cls + '" data-act="port" data-card="' + b.card + '" data-port="' + p + '"' + (u ? ' style="--pc:' + portColor(b.card, p) + '"' : '') + '><title>' + esc(tip) + '</title>' +
        '<text class="dr-n" x="' + (x + PW / 2) + '" y="' + (yy + 10) + '">' + (p + 1) + '</text>' +
        '<rect class="dr-rj" x="' + x + '" y="' + (yy + 14) + '" width="' + PW + '" height="' + PH + '" rx="3"' + (u ? ' style="fill:' + portColor(b.card, p) + '"' : '') + '/>' +
        '<path class="dr-jack" d="M' + (x + 6) + ',' + (yy + 19) + 'h' + (PW - 12) + 'v8h-4v3h-' + (PW - 20) + 'v-3h-4z"/>' +
        '<rect class="dr-led pro-only ' + led + '" x="' + (x + 3) + '" y="' + (yy + 16) + '" width="6" height="3" rx="1"/><rect class="dr-led pro-only ' + (u ? led : 'off') + '" x="' + (x + PW - 9) + '" y="' + (yy + 16) + '" width="6" height="3" rx="1"/>';
      if (u) s += '<rect class="dr-bar" x="' + x + '" y="' + (yy + 39) + '" width="' + PW + '" height="3" rx="1"/>' +
        '<rect class="dr-fill' + (u.load > u.cap ? ' over' : pct > 0.9 ? ' hi' : '') + '" x="' + x + '" y="' + (yy + 39) + '" width="' + (PW * Math.min(1, isFinite(pct) ? pct : 1)).toFixed(1) + '" height="3" rx="1"/>';
      s += '</g>';
    }
    y += nr * ROW + 16;
  });
  var H = y + 2;
  return '<svg class="dv-rear-svg" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px" role="img" aria-label="' + esc(deviceLabel(d) + ' output ports') + '">' +
    '<defs><linearGradient id="drBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34383f"/><stop offset=".06" stop-color="#262a30"/><stop offset="1" stop-color="#191b1f"/></linearGradient>' +
      '<linearGradient id="drPlate" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f333a"/><stop offset=".5" stop-color="#24272d"/><stop offset="1" stop-color="#1d2025"/></linearGradient>' +
      '<linearGradient id="drEar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2b2f35"/><stop offset="1" stop-color="#1b1d21"/></linearGradient>' +
      '<radialGradient id="drScrew" cx=".4" cy=".35"><stop offset="0" stop-color="#d9dde3"/><stop offset="1" stop-color="#6f7680"/></radialGradient></defs>' +
    '<rect class="dr-face" x="1" y="1" width="' + (W - 2) + '" height="' + (H - 2) + '" rx="8"/>' +
    '<rect class="dr-strip" x="1" y="1" width="' + (X0 - 12) + '" height="' + (H - 2) + '" rx="8"/>' +
    '<text class="dr-vert" transform="translate(' + ((X0 - 12) / 2 + 5) + ',' + (H / 2) + ') rotate(-90)">OUTPUT</text>' + s + '</svg>';
}

// The ports in use under the rear panel (the pro look only, looks/pro-pages.css): port, screen, cabinets, load, backup port.
function devPortsHtml(d, use) {
  var b = typeof bkRead === 'function' ? bkRead() : { mode: 'none' }, rows = '';
  cardsOfDevice(d).forEach(function (i) {
    for (var p = 0; p < P.processors[i].ports; p++) {
      var u = use[i + ':' + p]; if (!u) continue;
      var pct = u.cap ? Math.round(u.load / u.cap * 100) : null, col = portColor(i, p);
      var q = b.mode === 'port' ? b.pairs.filter(function (x) { return x.ms === i && x.mp === p; })[0] : null;
      rows += '<tr data-act="port" data-card="' + i + '" data-port="' + p + '"' + (i === (ui.mSender || 0) && p === (ui.mPort || 0) ? ' class="sel"' : '') + '>' +
        '<td><i class="dv-sw" style="background:' + col + '"></i>' + esc(portLabel(i, p)) + '</td>' +
        '<td>' + esc(Object.keys(u.lct).map(function (l) { return (lctById(l) || {}).name || '?'; }).join(', ')) + '</td><td class="n">' + u.cabs + '</td>' +
        '<td class="n' + (u.load > u.cap ? ' over' : '') + '"><span class="dv-load"><i style="width:' + Math.min(100, pct == null ? 100 : pct) + '%;background:' + col + '"></i></span>' + (pct == null ? '—' : pct + ' %') + '</td>' +
        '<td>' + (q ? '<i class="dv-led"></i>' + esc(portLabel(q.bs, q.bp)) : '<span class="na">—</span>') + '</td></tr>';
    }
  });
  var key = '<div class="dv-key"><span><i class="ok"></i>link</span><span><i class="bk"></i>backup ready</span><span><i></i>not used</span><span><i class="sel"></i>selected</span></div>';
  return rows ? key + '<table class="dv-ptbl"><thead><tr><th>Port</th><th>Screen</th><th class="n">Cabinets</th><th class="n">Load</th><th>Backup</th></tr></thead><tbody>' + rows + '</tbody></table>' : '';
}

// ------------------------------------------------------------------ the Processors tab
// Each processor with its screens under it, numbered in its NovaLCT order (Screen 1, 2 … of that processor: one Send writes
// them all; right-click reorders or gives it to another processor, app-sections.js lctMenu).
function devListHtml(q) {
  var h = '', shown = 0, cellsBy = allCells(), dm = lctDevMap(cellsBy);
  P.devices.forEach(function (d, k) {
    if (typeof olShown === 'function' && !olShown(d)) return;   // online: not connected (app-online.js)
    var m = procModel(d.model), idx = cardsOfDevice(d), lcs = lctScreensOf(d, cellsBy, dm);
    if (q && (deviceLabel(d) + ' ' + m.name + ' ' + lcs.map(function (l) { return l.name; }).join(' ')).toLowerCase().indexOf(q) < 0) return;
    shown++;
    var on = d === devSelected(), many = ui.devMulti && ui.devMulti.length > 1 && ui.devMulti.indexOf(d.id) >= 0;
    h += '<div class="tn dv-li' + (on || many ? ' on' : '') + (many ? ' multi' : '') + '" data-id="' + d.id + '" role="option" aria-selected="' + on + '" title="' + esc(deviceLabel(d) + ' · ' + m.name + ' · ' + devRangeText(idx) +
        ' · ' + lcs.length + ' screen' + (lcs.length === 1 ? '' : 's')) + '">' +
      '<span class="dv-dot' + (m.kind === 'custom' ? ' warn' : '') + '"></span>' +
      '<span class="dv-li-t"><span class="tn-name">' + esc(deviceLabel(d)) + '</span><span class="dv-li-s">' + esc(m.name) + ' · ' + devRangeText(idx, true) + '</span></span>' +
      '<span class="dv-pos" title="Position in the cascade">' + (k + 1) + '</span></div>';
    lcs.forEach(function (lc, i) {
      var ty = lctScreenType(lc.id, cellsBy), cur = lc.id === ui.viewScreen;
      h += '<div class="tn dv-scr' + (cur ? ' on' : '') + '" data-lct="' + lc.id + '" data-id="' + d.id + '" role="option" aria-selected="' + cur + '" title="' + esc(lc.name + ' · screen ' + (i + 1) + ' of ' + deviceLabel(d) +
          (ty ? ' · NovaLCT ' + ty.kind : ' · no cabinets yet') +
          ' · click to show it, right-click to reorder') + '">' +
        '<span class="dv-n">' + (i + 1) + '</span><span class="tn-name">' + esc(lc.name) + '</span>' +
        (ty ? '<span class="tn-type">' + ty.kind + '</span>' : '') + '</div>';
    });
  });
  if (!shown && q) h += '<p class="hint tn-none">No processor matches “' + esc(q) + '”.</p>';
  else if (!shown && P.devices.length) h += '<p class="hint tn-none">No processors connected.</p>';   // online (app-online.js)
  return h;
}
// The ports of processor d, one meaning everywhere (this card, the Device tile in app-pipeline.js): used = ports with
// cabinets wired; backup = backup ports of port pairs (no cabinets of their own), said apart: "4 of 36 ports used · 4 backup".
function devPortCount(d, use) {
  var n = { total: 0, used: 0, backup: 0 }, bk = {}, b = typeof bkRead === 'function' ? bkRead() : { mode: 'none' };
  if (b.mode === 'port') b.pairs.forEach(function (q) { bk[q.bs + ':' + q.bp] = 1; });
  cardsOfDevice(d).forEach(function (i) { var np = portsOfSender(i) || 0; n.total += np; for (var p = 0; p < np; p++) { if (use[i + ':' + p]) n.used++; else if (bk[i + ':' + p]) n.backup++; } });
  return n;
}
function devPortWords(n) { return n.used + ' of ' + n.total + ' ports used' + (n.backup ? ' · ' + n.backup + ' backup' : ''); }
// Processor properties ▸ Model: a processor with cabinets wired asks first (its cards and ports change); a new one (nothing
// wired) changes at once. Either way one undo step (setProcessorModel commits).
function devModelChange(d, key) {
  if (d.model === key || !PROC_MODELS[key]) return;
  var w = wiredCards(), from = procModel(d.model).name, to = procModel(key).name, who = deviceLabel(d);
  if (cardsOfDevice(d).some(function (i) { return w[i]; }) && !confirm('Change ' + who + (who !== from ? ' (' + from + ')' : '') + ' to ' + to + '?\n\nIts cards and ports change to the ' + to +
      '’s. If cabinets are on ports the ' + to + ' doesn’t have, nothing changes. Ctrl+Z undoes it.')) { log('set_processor_model', { processor: who, to: to, cancelled: true }); return; }
  setProcessorModel(d, key);
}
function devCardHtml(d, k, use) {
  var m = procModel(d.model), idx = cardsOfDevice(d), on = d === devSelected(), pc = devPortCount(d, use);
  var what = m.kind === 'chassis' ? idx.length + ' of ' + m.slots + ' slots' : devRangeText(idx);
  return '<div class="dv-card' + (on ? ' on' : '') + '" draggable="true" data-id="' + d.id + '" role="option" aria-selected="' + on + '" title="' + esc(deviceLabel(d) + ' — click to select, drag (or ← →) to change the cascade order, right-click for more') + '">' +
    '<div class="dv-c-top"><span class="dv-dot' + (m.kind === 'custom' ? ' warn' : '') + '"></span><b class="dv-c-name">' + esc(deviceLabel(d)) + '</b>' +
      '<span class="dv-pos" title="Position in the cascade">' + (k + 1) + '</span></div>' +
    '<div class="dv-c-sub">' + esc(m.name) + ' <span class="dv-bar-sep">|</span> ' + (m.kind === 'chassis' ? devRangeText(idx) : what) + '</div>' +
    '<div class="dv-c-img">' + devMiniSvg(d, use) + '</div>' +
    '<div class="dv-c-foot">' + (m.kind === 'custom' ? '<span class="dv-c-warn" data-act="setmodel" title="Its model isn’t known (an imported file): pick it in Processor properties, or link it — nothing is sent until then">Pick a model</span>' : '<span class="dv-c-use"' + (m.kind === 'chassis' ? ' title="' + esc(devPortWords(pc) + ' · ' + what) + '"' : '') + '>' + devPortWords(pc) + '</span>') +   // the slots: Processor properties
      '<span class="dv-c-acts">' +
        '<button class="mini" data-act="left" title="Earlier in the cascade (its cards get lower numbers)"' + (k === 0 ? ' disabled' : '') + '>←</button>' +
        '<button class="mini" data-act="right" title="Later in the cascade"' + (k === P.devices.length - 1 ? ' disabled' : '') + '>→</button>' +
      '</span></div></div>';
}

function renderDevices(use) {
  if (devPick.open && devPick.first && devPick.proj !== P && !devIsBlank()) devClosePicker();   // the server's project (set up) arrived meanwhile
  var d = devSelected();
  if (d) ui.devSel = d.id;
  var om = $('btnOfflineMode');   // Tools (app-online.js olWorkspace)
  if (om) { om.textContent = olMode() === 'offline' ? 'Exit offline mode' : 'Enter offline mode';
    om.title = olMode() === 'offline' ? 'Back to the online projects. This offline project is kept: Enter offline mode opens it again.'
      : 'The offline projects, designed without hardware (Add processor lists the model catalogue; nothing is searched). Your online projects stay as they are. As VMP’s Tools ▸ Offline Mode.'; }
  // the shared tree's Processors view (app-shell.js) can be open on any tab that shows the tree
  if (ui.treeView === 'procs' && !$('treeProcs').hidden) {
    $('dvProj').textContent = P.name || 'Untitled';
    var realCards = P.processors.filter(function (c, i) { var o = deviceOfCard(i); return cardIsReal(i) && (!o || olShown(o)); }).length;   // a fixed processor's card isn't counted
    var chassis = P.devices.some(function (x) { return procModel(x.model).kind === 'chassis'; });
    var nOn = P.devices.length - olGone().length;   // online: the connected ones (app-online.js)
    $('dvProjSub').textContent = (olMode() === 'online' ? 'Online · ' : 'Offline · ') + nOn + ' processor' + (nOn === 1 ? '' : 's') +
      (realCards ? ' · ' + realCards + (chassis ? ' sending card' : ' card') + (realCards === 1 ? '' : 's') : '');
    $('dvProjSub').title = olMode() === 'online' ? 'Online project: Add processor lists the processors found on the network' : 'Offline project: Add processor lists the model catalogue (Tools ▸ Offline Mode)';
    $('devList').innerHTML = devListHtml(($('devSearch').value || '').trim().toLowerCase());
  }
  if (ui.tab !== 'devices') return;
  var h = '', on = typeof olShown === 'function' ? olShown : function () { return true; };
  P.devices.forEach(function (dv, k) { if (on(dv)) h += devCardHtml(dv, k, use); });   // online: the connected ones; the others in one fold under the cards (app-online.js)
  h += '<button class="dv-card dv-add" data-act="add" title="' + (olMode() === 'online' ? 'Add a processor found on the network (online)' : 'Add a processor from the model catalogue (offline)') + ': it cascades after the last one"><span>+ Add processor</span></button>';
  $('devCards').innerHTML = h;
  if (typeof olGoneRender === 'function') olGoneRender();
  if (d) {
    var m = procModel(d.model);
    $('devRearTitle').innerHTML = '<span class="dv-dot' + (m.kind === 'custom' ? ' warn' : '') + '"></span><b>' + esc(m.name) + '</b><span class="hint">' + esc(deviceLabel(d)) + ' · ' + devRangeText(cardsOfDevice(d)) +
      ' · click a port to draw on it in Layout</span>';
    $('devRear').innerHTML = devRearSvg(d, use);
    if ($('devPorts')) $('devPorts').innerHTML = devPortsHtml(d, use);
  } else { $('devRearTitle').innerHTML = ''; $('devRear').innerHTML = ''; if ($('devPorts')) $('devPorts').innerHTML = ''; }
  renderDevProps(d, use);
}

// Right panel: "Processor properties" of the selected processor.
function renderDevProps(d, use) {
  var none = !d;   // no processor yet: only "+ Add processor"
  $('dvNone').hidden = !none;
  var nt = $('dvNone').firstChild;   // online with every processor not connected: say that instead (app-online.js)
  if (none && nt && nt.nodeType === 3) nt.textContent = typeof olGone === 'function' && olGone().length ? 'No processors connected.' : 'No processor in this project yet.';
  ['dvInfo', 'dvCards', 'dvHw'].forEach(function (k) { var c = document.querySelector('#modDevices [data-card="' + k + '"]'); if (c) c.hidden = none; });
  $('dvService').hidden = none;
  if (!d) return;
  var m = procModel(d.model), idx = cardsOfDevice(d), k = P.devices.indexOf(d), w = wiredCards();
  $('dvTitle').textContent = deviceLabel(d);
  $('dvNudge').hidden = m.kind !== 'custom';
  if (document.activeElement !== $('dvName')) $('dvName').value = deviceLabel(d);
  fillSelect($('dvModel'), procModelOptions(), d.model, PROC_MODELS);
  // ModelID (what the hardware reports, for auto-detect) is a developer fact: in the Model tooltip and Device info (Hardware)
  $('dvModel').title = 'Its cards and port counts follow the model' + (m.modelId != null ? ' · ModelID 0x' + m.modelId.toString(16).toUpperCase() : '');
  var facts = [['Cascade position', (k + 1) + ' of ' + P.devices.length]].concat(m.kind === 'fixed' ? [] : [
    [m.kind === 'chassis' ? 'Sending cards' : 'Cards', idx.length ? (idx.length === 1 ? String(idx[0] + 1) : (idx[0] + 1) + '–' + (idx[idx.length - 1] + 1)) : '—']]).concat([
    m.kind === 'fixed' ? ['Ports', m.ports + (m.cards > 1 ? ' per card' : '')] : m.kind === 'chassis' ? ['Output slots', idx.length + ' of ' + m.slots + ' used'] : ['Ports', 'free, 1–' + MAX_CARD_PORTS + ' per card']]);
  var ctip = P.devices.length > 1 ? 'Its cards are numbered after the processors before it. Drag its card, use ← →, or right-click it (Earlier / Later): the cards renumber and the wiring moves with them.'
    : 'The only processor. Processors you add cascade after it.';
  $('dvFacts').innerHTML = facts.map(function (f, i) { return '<dt>' + esc(f[0]) + (i ? '' : itip(ctip)) + '</dt><dd>' + esc(f[1]) + '</dd>'; }).join('');
  // Free topology: how this processor counts a port's load (app-processors.js procFreeTopology)
  var fam = procFamily(m), ft = procFreeTopology(d);
  $('dvFreeTopo').checked = ft;
  $('dvFreeTopo').disabled = fam === 'coex' || m.kind === 'custom';
  $('dvFreeTopoWrap').hidden = $('dvFreeTopoNote').hidden = m.kind === 'custom';
  $('dvFreeTopoNote').innerHTML = itip(fam === 'coex'
    ? 'Always on for this model: the cabinets are merged into row / column blocks and each block counts at least 128 px wide.'
    : (ft ? 'A port’s load is its cabinets’ own pixels — gaps are free. ' : 'A port’s load is the rectangle around its cabinets — gaps count. ') +
      (fam === 'unico' ? 'On by default for this model. ' : 'Use it only when the processor supports free topology. ') +
      'Every receiving card on the port must support it too (e.g. A10s Pro / A8s Pro, or A5s–A10s Plus-N and MRV cards on firmware 4.8 or later).');
  $('dvCardsTitle').textContent = m.kind === 'chassis' ? 'Output cards' : m.kind === 'fixed' ? 'Ports' : 'Cards';
  var h = '';
  idx.forEach(function (i, s) {
    var c = P.processors[i], need = w[i] || 0, n = 0;
    for (var p = 0; p < c.ports; p++) if (use[i + ':' + p]) n++;
    h += '<div class="dv-cr' + (i === (ui.mSender || 0) ? ' on' : '') + '">' +
      '<button class="dv-cr-go" data-act="go" data-card="' + i + '" title="Open ' + esc(cardName(i, true)) + ' in Layout">' +
        '<b>' + (m.kind === 'chassis' ? 'Slot ' + (s + 1) : cardName(i)) + '</b><span>' + (m.kind === 'chassis' ? cardName(i) + ' · ' : '') + n + ' of ' + c.ports + ' ports used</span></button>';
    if (m.kind === 'chassis') h += '<select data-act="type" data-card="' + i + '" aria-label="Output card in slot ' + (s + 1) + '" title="Output card in this slot">' +
      m.cardTypes.map(function (t) { return '<option value="' + t + '"' + (t === c.type ? ' selected' : '') + '>' + esc(OUTPUT_CARDS[t].name) + '</option>'; }).join('') + '</select>';
    else if (m.kind === 'custom') h += '<label class="dv-cr-ports" title="Ports on this card (1–' + MAX_CARD_PORTS + ')">Ports<input type="number" min="1" max="' + MAX_CARD_PORTS + '" data-act="ports" data-card="' + i + '" value="' + c.ports + '"></label>';
    if (cardHasScreen(d)) { var cs = cardScreen(i); h += '<select data-act="screen" data-card="' + i + '" aria-label="Screen of ' + esc(cardName(i, true)) + '" title="The screen this card draws on: its own, or shared with other cards">' +
      (cs ? '' : '<option value="" selected>Own screen</option>') + lctScreensOf(d).map(function (lc) { return '<option value="' + lc.id + '"' + (cs === lc ? ' selected' : '') + '>' + esc(lc.name) + '</option>'; }).join('') + '<option value="__new">New screen</option></select>'; }
    if (m.kind !== 'fixed') h += '<button class="mini" data-act="rmcard\" data-card="' + i + '"' + (need || idx.length < 2 ? ' disabled' : '') +
      ' title="' + (need ? cardName(i) + ' has cabinets wired — move or clear its ports first' : idx.length < 2 ? 'A processor keeps at least one card (Remove processor removes it all)'
        : 'Remove this card; later cards move up one number') + '">×</button>';
    h += '</div>';
  });
  if (m.kind === 'chassis') h += '<div class="row"><button class="wide" data-act="addcard"' + (idx.length >= m.slots ? ' disabled' : '') + ' title="Add an output card in the next slot; later cards move up one number">' +
    (idx.length >= m.slots ? 'All ' + m.slots + ' slots used' : '+ Add output card') + '</button></div>';
  else if (m.kind === 'custom') h += '<div class="row"><button class="wide" data-act="addcard" title="Add a card to this processor; later cards move up one number">+ Add card</button></div>';
  else h += '<div class="row"><button class="wide" data-act="another">+ Add another ' + esc(m.name) + '</button>' +
    itip(m.name + ' has ' + m.ports + ' ports. For more ports, add another ' + m.name + ': it cascades right after this one.') + '</div>';
  $('dvCardsBody').innerHTML = h;
  var busy = idx.filter(function (i) { return w[i]; });
  $('dvRemoveNote').innerHTML = itip('Removes it' + (busy.length ? ' and the cabinets wired to it (asks first; Ctrl+Z brings them back)' : ' (Ctrl+Z brings it back)') +
    (k < P.devices.length - 1 ? '; the processors after it move up.' : '.'));
  $('dvSvcBody').innerHTML = typeof svHtml === 'function' ? svHtml(d) : '';   // restart / factory reset, always asked first (app-service.js)
  devSvcFold(!ui.devSvcOpen);
  renderHwCard(d);   // the Hardware card: link, Detect, Compare, Save (app-hardware.js; Send is the header's Send ▾)
}

// ------------------------------------------------------------------ the Add processor picker
// Online (app-online.js olMode): ONLY the processors found right now; one click adds one, linked (olAdd), and the list stays
// open for the next. Offline: ONLY the model catalogue. Never both (user, 2026-10-11: "just like with VMP").
var devPick = { open: false, first: false, fam: null, key: null, qty: 1, nCards: 1, cardType: 'h16', q: '' };
function devPickerDialog() {
  var dlg = $('devPickDlg');
  if (dlg) return dlg;
  dlg = document.createElement('div');
  dlg.id = 'devPickDlg'; dlg.className = 'logdlg'; dlg.hidden = true;
  dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-labelledby', 'dpTitle');
  dlg.innerHTML =
    '<div class="logbox dp-box">' +
      '<div class="loghead"><b id="dpTitle">Add processor</b>' +
        '<span id="dpMode" class="seg dp-mode" role="group" aria-label="Online or offline">' +
          '<button data-mode="online" title="Online: the processors found on the network and USB right now">Online</button>' +
          '<button data-mode="offline" title="Offline: the model catalogue, to design without hardware (VMP: Tools ▸ Offline Mode)">Offline</button></span>' +
        '<span class="grow"></span><button id="dpClose" title="Close">×</button></div>' +
      '<p id="dpLead" class="hint" style="margin:0"></p>' +
      '<div id="dpFound" class="dp-models dp-found-list" role="listbox" aria-label="Processors found"></div>' +
      '<div id="dpMain" class="dp-main">' +
        '<div class="dp-fams"><input id="dpSearch" type="search" placeholder="Search models…" aria-label="Search models"><div id="dpFams" role="tablist" aria-label="Families"></div></div>' +
        '<div id="dpModels" class="dp-models" role="listbox" aria-label="Models"></div>' +
      '</div>' +
      '<div class="dp-opts" id="dpOpts"></div>' +
      '<div id="dpSum" class="dp-sum"></div>' +
      '<div class="loghead"><button id="dpAddr" title="A processor on another network, or over a VPN such as Tailscale, doesn’t hear the search: type its address">Add by address…</button>' +
        '<span class="grow"></span><button id="dpCancel">Close</button><button id="dpGo" class="primary">Add</button></div>' +
    '</div>';
  document.body.appendChild(dlg);
  $('dpClose').onclick = $('dpCancel').onclick = function () { log('add_processor', { closed: true, mode: olMode() }); devClosePicker(); };
  $('dpAddr').onclick = olAddAddress;   // app-online.js
  dlg.addEventListener('mousedown', function (e) { if (e.target === dlg) devClosePicker(); });
  $('dpSearch').oninput = function () { devPick.q = this.value.trim().toLowerCase(); devRenderPicker(); };
  dlg.addEventListener('click', function (e) {
    var t = e.target.closest('[data-fam],[data-key],[data-mode],[data-found]');
    if (!t || t.disabled) return;
    if (t.dataset.mode) return olSetMode(t.dataset.mode, 'add processor');   // app-online.js
    if (t.dataset.found) return olAdd(hw.found[+t.dataset.found]);
    if (t.dataset.fam) {   // another family: pick its first model unless the picked one is in it
      devPick.fam = t.dataset.fam; devPick.q = ''; $('dpSearch').value = '';
      if (procModel(devPick.key).family !== devPick.fam) devPick.key = PROC_ORDER.find(function (k) { return PROC_MODELS[k].family === devPick.fam; });
    }
    else { devPick.key = t.dataset.key; devPick.fam = PROC_MODELS[t.dataset.key].family; }
    devRenderPicker();
  });
  dlg.addEventListener('dblclick', function (e) { if (e.target.closest('[data-key]')) $('dpGo').click(); });
  // Options only update the summary (rebuilding them would take the focus away while typing).
  function opt(e) {
    var t = e.target, m = procModel(devPick.key);
    if (t.id === 'dpQty') devPick.qty = Math.max(1, Math.min(16, int(t.value, devPick.qty)));
    else if (t.id === 'dpN') devPick.nCards = Math.max(1, Math.min(m.slots || 1, int(t.value, devPick.nCards)));
    else if (t.id === 'dpType') devPick.cardType = t.value;
    else return;
    devRenderPickSum();
  }
  dlg.addEventListener('input', opt);
  dlg.addEventListener('change', opt);
  $('dpGo').onclick = function () {
    var key = devPick.key;
    if (olMode() !== 'offline' || !PROC_MODELS[key] || PROC_ORDER.indexOf(key) < 0) return toast('Pick a model');
    var m = procModel(key), n = Math.max(1, Math.min(m.slots || 1, devPick.nCards));
    devClosePicker();
    devAdd(key, devPick.qty, devPick.cardType, n);
  };
  return dlg;
}
// opts.first: the new-project question.
function devOpenPicker(opts) {
  opts = opts || {};
  var dlg = devPickerDialog();
  devPick.open = true; devPick.first = !!opts.first; devPick.q = ''; devPick.qty = 1; devPick.nCards = 1; devPick.proj = P;
  if (!PROC_MODELS[devPick.key] || PROC_ORDER.indexOf(devPick.key) < 0) devPick.key = 'mctrl4k';
  devPick.fam = PROC_MODELS[devPick.key].family;
  $('dpSearch').value = '';
  log('processor_picker', { opened: devPick.first ? 'new project' : 'add', mode: olMode() });
  dlg.hidden = false;
  if (olMode() === 'online') olSearch(false);   // a search the user asked for (app-online.js); kept current while open
  devRenderPicker();
  setTimeout(function () { var sel = dlg.querySelector(olMode() === 'online' ? '.dp-found:not([disabled])' : '.dp-model.on'); if (sel) sel.focus(); }, 0);
}
function devClosePicker() {
  var dlg = $('devPickDlg');
  devPick.open = false;
  if (dlg) dlg.hidden = true;
}
function devRenderPicker() {
  var dlg = $('devPickDlg'); if (!dlg) return;
  var on = olMode() === 'online';
  Array.prototype.forEach.call($('dpMode').children, function (b) { var o = b.dataset.mode === (on ? 'online' : 'offline'); b.classList.toggle('on', o); b.setAttribute('aria-pressed', String(o)); });
  $('dpMode').hidden = !!P.devices.length;   // a project with processors stays in its workspace (Tools ▸ Offline mode, app-online.js)
  $('dpTitle').textContent = devPick.first ? 'Which processors are you using?' : 'Add processor';
  $('dpFound').hidden = $('dpAddr').hidden = !on;
  $('dpMain').hidden = $('dpOpts').hidden = $('dpSum').hidden = $('dpGo').hidden = on;
  if (on) {
    $('dpLead').textContent = 'Found on the network and USB right now' + (ol.at ? ' (checked ' + new Date(ol.at).toLocaleTimeString() + ')' : '') +
      '. Click one to add it, linked. Designing without the hardware? ' + (P.devices.length ? 'Tools ▸ Enter offline mode.' : 'Switch to Offline.');
    var foc = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.found : null;
    $('dpFound').innerHTML = olFoundHtml();
    if (foc != null) { var back = $('dpFound').querySelector('[data-found="' + foc + '"]'); if (back) back.focus(); }
    return;
  }
  $('dpLead').textContent = 'Pick the model. The new processor cascades after the last one' + (P.devices.length ? '' : '; you can add other models later') + '.';
  var fams = [], by = {}, q = devPick.q;
  PROC_ORDER.forEach(function (k) {
    var f = PROC_MODELS[k].family || 'Other';
    if (!by[f]) { by[f] = []; fams.push(f); }
    by[f].push(k);
  });
  if (fams.indexOf(devPick.fam) < 0) devPick.fam = fams[0];
  $('dpFams').innerHTML = fams.map(function (f) {
    var on2 = !q && f === devPick.fam;
    return '<button class="dp-fam' + (on2 ? ' on' : '') + '" role="tab" aria-selected="' + on2 + '" data-fam="' + esc(f) + '">' + esc(f) + '<span>' + by[f].length + '</span></button>';
  }).join('');
  var keys = q ? PROC_ORDER.filter(function (k) { return (PROC_MODELS[k].name + ' ' + PROC_MODELS[k].family).toLowerCase().indexOf(q) >= 0; }) : by[devPick.fam];
  $('dpModels').innerHTML = keys.length ? keys.map(function (k) {
    var m = PROC_MODELS[k], sel = k === devPick.key;
    var sub = m.kind === 'fixed' ? m.ports + ' ports' + (m.cards > 1 ? ' × ' + m.cards + ' cards' : '') : 'chassis · ' + m.slots + ' output card slots';
    return '<button class="dp-model' + (sel ? ' on' : '') + '" role="option" aria-selected="' + sel + '" data-key="' + k + '"><b>' + esc(m.name) + '</b><span>' + esc(sub) + '</span></button>';
  }).join('') : '<p class="hint">No model matches “' + esc(q) + '”.</p>';
  var m = procModel(devPick.key), h = '';
  h += '<label class="dp-o">Quantity<input id="dpQty" type="number" min="1" max="16" value="' + devPick.qty + '"></label>';
  if (m.kind === 'chassis') {
    devPick.nCards = Math.min(devPick.nCards, m.slots);
    if (m.cardTypes.indexOf(devPick.cardType) < 0) devPick.cardType = m.cardTypes[0];
    h += '<label class="dp-o">Output cards<input id="dpN" type="number" min="1" max="' + m.slots + '" value="' + devPick.nCards + '"></label>' +
      '<label class="dp-o dp-wide">Output card type<select id="dpType">' + m.cardTypes.map(function (t) {
        return '<option value="' + t + '"' + (t === devPick.cardType ? ' selected' : '') + '>' + esc(OUTPUT_CARDS[t].name) + '</option>';
      }).join('') + '</select></label>';
  }
  $('dpOpts').innerHTML = h;
  devRenderPickSum();
}
// The picker's summary line and button: what Add will do (offline).
function devRenderPickSum() {
  var m = procModel(devPick.key);
  var perUnit = m.kind === 'chassis' ? devPick.nCards : m.cards || 1;
  var first = P.processors.length, last = first + perUnit * devPick.qty - 1;
  var ports = m.kind === 'chassis' ? OUTPUT_CARDS[devPick.cardType].ports + ' ports each' : m.ports + ' ports' + (devPick.qty > 1 ? ' each' : '');
  $('dpSum').textContent = PROC_MODELS[devPick.key] ? 'Adds ' + (devPick.qty > 1 ? devPick.qty + ' × ' : '') + m.name + (devPick.qty > 1 ? ', cascaded' : '') + ' → ' +
    (m.kind === 'chassis' ? (first === last ? 'sending card ' + (first + 1) : 'sending cards ' + (first + 1) + '–' + (last + 1)) + ' (' + ports + ')' : ports) : '';
  $('dpGo').textContent = (devPick.first ? 'Use ' : 'Add ') + (devPick.qty > 1 ? devPick.qty + ' × ' : '') + m.name;
}

// New project / first start: ask which processors are used (only while nothing is set up).
function devFirstRun() {
  if (devIsBlank()) devOpenPicker({ first: true });
}

// The Service section (restart, factory reset, Remove): folded unless opened in this session.
function devSvcFold(fold) {
  var c = $('dvService'); if (!c) return;
  c.classList.toggle('collapsed', fold); $('dvSvcHead').setAttribute('aria-expanded', String(!fold));
}
// Right-click on a processor card / tree row: what used to be the Earlier / Later / Remove buttons.
function devMenu(e, id) {
  var d = deviceById(id); if (!d) return;
  e.preventDefault();
  if (ui.devSel !== d.id) { ui.devSel = d.id; renderAll(); }
  var k = P.devices.indexOf(d);
  log('processor_menu', { processor: deviceLabel(d) });
  openMenu(e.clientX, e.clientY, [{ header: deviceLabel(d) },
    { label: '← Earlier in the cascade', disabled: k <= 0, act: function () { moveProcessor(d, -1); } },
    { label: 'Later in the cascade →', disabled: k >= P.devices.length - 1, act: function () { moveProcessor(d, 1); } },
    { sep: true },
    { label: '+ Screen on ' + deviceLabel(d), act: function () {   // its next screen (app-sections.js)
      ui.devSel = d.id; var c = cardsOfDevice(d); if (c.length && c.indexOf(ui.mSender || 0) < 0) { ui.mSender = c[0]; ui.mPort = 0; } addLctScreen(); } },
    { sep: true },
    { label: 'Remove processor', act: function () { removeProcessor(d); } }]);   // asks first when panels are wired (app-processors.js)
}

// ------------------------------------------------------------------ bindings
function bindDevices() {
  $('dvFreeTopo').onchange = function () {
    var d = devSelected(); if (!d) return;
    d.freeTopology = this.checked;
    log('free_topology', { processor: deviceLabel(d), on: d.freeTopology });
    commit(); renderAll();
  };
  $('btnDevAdd').onclick = $('btnDevAdd2').onclick = $('btnDevAdd3').onclick = function () { devOpenPicker(); };
  $('devSearch').addEventListener('input', function () { $('devList').innerHTML = devListHtml(this.value.trim().toLowerCase()); });
  function pick(id, e) {
    var d = deviceById(id); if (!d) return;
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) return devMultiPick(d, e.shiftKey);
    if (ui.devMulti && ui.devMulti.length) { ui.devMulti = []; if (ui.devSel === id) { renderAll(); return; } }
    if (ui.devSel === id) return;
    ui.devSel = id;
    log('select_processor', { processor: deviceLabel(d) });
    renderAll();
  }
  // a screen under a processor: show it, with that processor's card on it as the active one (app-tree.js activateCard)
  function pickScreen(r) {
    var d = deviceById(r.dataset.id), lc = lctById(r.dataset.lct); if (!d || !lc) return;
    var mine = cardsOfDevice(d), cellsBy = allCells(), on = [];
    P.screens.forEach(function (s) { if (s.screenId === lc.id) cardsUsed(cellsBy[s.id]).forEach(function (c) { if (mine.indexOf(c) >= 0 && on.indexOf(c) < 0) on.push(c); }); });
    ui.devMulti = []; ui.devSel = d.id;
    if (mine.length) activateCard(lc.id, on.length ? Math.min.apply(null, on) : mine[0]); else showScreen(lc.id);
  }
  $('devList').onclick = function (e) { var s = e.target.closest('.dv-scr'); if (s) return pickScreen(s); var r = e.target.closest('.dv-li'); if (r) pick(r.dataset.id, e); };
  $('devList').onmousedown = function (e) { if (e.shiftKey) e.preventDefault(); };   // Shift-click picks a range, not text
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ui.devMulti && ui.devMulti.length && !document.querySelector('.ctx:not([hidden]), .dropmenu:not([hidden])')) devMultiClear(); });
  $('devList').oncontextmenu = function (e) {
    var s = e.target.closest('.dv-scr'), lc = s && lctById(s.dataset.lct); if (lc) return lctMenu(e, lc, deviceById(s.dataset.id));   // app-sections.js
    var r = e.target.closest('.dv-li'); if (r) devMenu(e, r.dataset.id);
  };
  $('dvSvcHead').onclick = function () { ui.devSvcOpen = !ui.devSvcOpen; devSvcFold(!ui.devSvcOpen); log('card_fold', { card: 'dvService', folded: !ui.devSvcOpen }); };
  $('dvSvcBody').onclick = function (e) {   // the service buttons (svHtml) ask first in their own dialog (app-service.js)
    var b = e.target.closest('[data-hw="svc"]'), d = devSelected(); if (b && d && !b.disabled) svOpen(d, b.dataset.act);
  };
  $('devList').ondblclick = function (e) {
    var sr = e.target.closest('.dv-scr'), lc = sr && lctById(sr.dataset.lct);
    if (lc) {   // rename a screen, as in the Screens view
      var sn = prompt('Screen name (LCT keeps the first 10 characters):', lc.name);
      if (sn == null || !sn.trim()) return;
      log('rename_screen', { from: lc.name, to: sn.trim() });
      lc.name = sn.trim(); commit(); renderAll(); return;
    }
    var r = e.target.closest('.dv-li'), d = r && deviceById(r.dataset.id); if (!d) return;
    var nm = prompt('Processor name:', deviceLabel(d));
    if (nm == null || !nm.trim()) return;
    log('rename_processor', { from: deviceLabel(d), to: nm.trim() });
    d.name = nm.trim(); commit(); renderAll();
  };
  var cards = $('devCards');
  cards.onclick = function (e) {
    var a = e.target.closest('[data-act]'), c = e.target.closest('.dv-card'), d = c && deviceById(c.dataset.id);
    if (a && a.dataset.act === 'add') return devOpenPicker();
    if (a && d) {
      if (a.dataset.act === 'left') return moveProcessor(d, -1);
      if (a.dataset.act === 'right') return moveProcessor(d, 1);
      if (a.dataset.act === 'setmodel') { pick(d.id); return $('dvModel').focus(); }
    }
    if (d) pick(d.id);
  };
  cards.oncontextmenu = function (e) { var c = e.target.closest('.dv-card[data-id]'); if (c) devMenu(e, c.dataset.id); };
  // Drag a card onto another to move it there in the cascade (before or after it: which half).
  function clearMarks() { Array.prototype.forEach.call(cards.querySelectorAll('.drop-l,.drop-r,.dragging'), function (x) { x.classList.remove('drop-l', 'drop-r', 'dragging'); }); }
  cards.addEventListener('dragstart', function (e) {
    var c = e.target.closest && e.target.closest('.dv-card[data-id]'); if (!c) return;
    ui.devDrag = c.dataset.id; c.classList.add('dragging');
    try { e.dataTransfer.setData('text/plain', c.dataset.id); e.dataTransfer.effectAllowed = 'move'; } catch (er) { /* old browser */ }
  });
  cards.addEventListener('dragover', function (e) {
    var c = e.target.closest('.dv-card[data-id]'); if (!c || !ui.devDrag) return;
    e.preventDefault();
    var r = c.getBoundingClientRect(), right = e.clientX > r.left + r.width / 2;
    Array.prototype.forEach.call(cards.querySelectorAll('.drop-l,.drop-r'), function (x) { if (x !== c) x.classList.remove('drop-l', 'drop-r'); });
    c.classList.toggle('drop-r', right); c.classList.toggle('drop-l', !right);
  });
  cards.addEventListener('dragleave', function (e) { if (!cards.contains(e.relatedTarget)) Array.prototype.forEach.call(cards.querySelectorAll('.drop-l,.drop-r'), function (x) { x.classList.remove('drop-l', 'drop-r'); }); });
  cards.addEventListener('dragend', function () { ui.devDrag = null; clearMarks(); });
  cards.addEventListener('drop', function (e) {
    var c = e.target.closest('.dv-card[data-id]'), d = deviceById(ui.devDrag);
    e.preventDefault();
    var right = c && c.classList.contains('drop-r');
    ui.devDrag = null; clearMarks();
    if (!c || !d) return;
    var k = P.devices.indexOf(d), j = P.devices.indexOf(deviceById(c.dataset.id)) + (right ? 1 : 0);
    if (j > k) j--;
    if (j !== k) moveProcessor(d, j - k);
  });
  $('devRear').onclick = function (e) {
    var a = e.target.closest('[data-act]'), d = devSelected(); if (!a || !d) return;
    if (a.dataset.act === 'port') return devGoPort(+a.dataset.card, +a.dataset.port);
    if (a.dataset.act === 'card') { ui.mSender = +a.dataset.card; ui.mPort = 0; log('select_card', { card: ui.mSender + 1, via: 'processor_rear_panel' }); return setTab('layout'); }
    if (a.dataset.act === 'addcard') return addOutputCard(d);
  };
  if ($('devPorts')) $('devPorts').onclick = $('devRear').onclick;   // the port table (pro look): a row opens that port in Layout
  // Processor properties
  $('dvName').addEventListener('change', function () {
    var d = devSelected(), v = this.value.trim(); if (!d) return;
    if (!v || v === deviceLabel(d)) { this.value = deviceLabel(d); return; }
    log('rename_processor', { from: deviceLabel(d), to: v });
    d.name = v; commit(); renderAll();
  });
  $('dvModel').addEventListener('change', function () { var d = devSelected(); if (d) devModelChange(d, this.value); renderAll(); });
  $('dvRemove').onclick = function () { var d = devSelected(); if (d) removeProcessor(d); };
  var body = $('dvCardsBody');
  body.onclick = function (e) {
    var a = e.target.closest('[data-act]'), d = devSelected(); if (!a || !d || a.tagName === 'SELECT' || a.tagName === 'INPUT') return;
    var i = +a.dataset.card;
    switch (a.dataset.act) {
      case 'go': ui.mSender = i; ui.mPort = 0; log('select_card', { card: i + 1, via: 'processor_properties' }); return setTab('layout');
      case 'rmcard': return removeSendingCard(i);
      case 'addcard': return addOutputCard(d);
      case 'another': return addProcessor(d.model, null, d);
    }
  };
  body.onchange = function (e) {
    var t = e.target, i = +t.dataset.card;
    if (t.dataset.act === 'screen') { if (t.value) cardToScreen(i, t.value); }
    else if (t.dataset.act === 'type') { setOutputCardType(i, t.value); renderAll(); }
    else if (t.dataset.act === 'ports') setCardPorts(i, int(t.value, P.processors[i].ports));
  };
  // Keys: while the picker is open they are its own. (Keeping the canvas shortcuts off the hidden
  // Layout on every other tab is app-shell.js's job.)
  window.addEventListener('keydown', function (e) {
    var other = !$('logDlg').hidden || ($('scfgDlg') && !$('scfgDlg').hidden);
    if (other) return;
    if (devPick.open) {
      if (e.key === 'Escape') { e.preventDefault(); devClosePicker(); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && olMode() === 'offline') { e.preventDefault(); $('dpGo').click(); }
      e.stopImmediatePropagation();
      return;
    }
  }, true);
}
