// app-forms.js - bindForms: wires every side-panel field and toolbar button (project, screen
// name, sending card, panel library, tree + and search, sections, wiring, the toolbar
// Auto | Manual | Self draw switch, pattern pad, theme, save / open / export, undo / redo) and
// the keyboard shortcuts; bindCards (CARDS_KEY, CARDS_FOLDED, cardsClosed, cardIsFolded, cardFold): folding the right
// panel's cards; bindOutputGroup (OUTPUT_KEY): the Screen card's Output group; the toolbar View ▾ menu (viewMenu,
// bindViewMenu, viewLive); the interface size and text size (UI_SIZES, TEXT_SIZES, uiZoom, uiText, setUiSize, stepUiSize,
// setTextSize, textSizeName, uiSizeKey, uiSizeBadge, renderUiSize, setCorners: View and Settings ▸ Preferences in the menu bar).
// Depends on: every earlier file. bindForms is called from main.js.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ interface size, text size
// Interface size: the whole app is drawn at this size (CSS zoom on <html>). Text size: only the text (the --fs multiplier
// on every font-size in app.css / polish.css, and the canvas labels' upper limit), so a tech can read the labels without
// making the canvas smaller (user, 2026-10-28). Both remembered per browser and applied in index.html before first paint.
// Keys: Ctrl/Cmd + Alt (Option) + = / - / 0 = bigger / smaller / 100 % (uiSizeKey, called from app-shell.js); Ctrl/Cmd +
// = / - / 0 without Alt stay the browser's own zoom (and Ctrl+0 the canvas's 1:1 on the Layout tab).
// With zoom, pointer and getBoundingClientRect numbers are on-screen pixels while CSS lengths inside the page
// are scaled: anything placed at a pointer position divides by uiZoom() (openMenu, coordTagPlace).
var UI_SIZES = [0.7, 0.8, 0.85, 0.9, 1, 1.1, 1.15, 1.2, 1.3, 1.4, 1.5];
var TEXT_SIZES = [[0.9, 'Small'], [1, 'Normal'], [1.15, 'Large'], [1.3, 'Extra large']];
function uiZoom() { return parseFloat(document.documentElement.style.zoom) || 1; }
function uiText() { return parseFloat(document.documentElement.style.getPropertyValue('--fs')) || 1; }
function textSizeName(f) { var t = TEXT_SIZES.filter(function (x) { return x[0] === f; })[0]; return t ? t[1] : Math.round(f * 100) + ' %'; }
// "Interface 110 %" for a moment at the top of the window (the menu bar's keys and items change the size without a look)
function uiSizeBadge(msg) {
  var b = $('uiBadge');
  if (!b) { b = document.createElement('div'); b.id = 'uiBadge'; b.className = 'ui-badge'; b.setAttribute('role', 'status'); document.body.appendChild(b); }
  b.textContent = msg; b.hidden = false;
  clearTimeout(ui.badgeT); ui.badgeT = setTimeout(function () { b.hidden = true; }, 1300);
}
function setUiSize(z) {
  z = Math.round(z * 100) / 100;
  if (!(z >= UI_SIZES[0] && z <= UI_SIZES[UI_SIZES.length - 1]) || z === uiZoom()) return;
  log('ui_size', { from: Math.round(uiZoom() * 100) + '%', to: Math.round(z * 100) + '%' });
  document.documentElement.style.zoom = z === 1 ? '' : String(z);
  if (z === 1) document.documentElement.style.removeProperty('--uiz'); else document.documentElement.style.setProperty('--uiz', String(z));   // vh / vw ÷ this (app.css)
  try { localStorage.setItem('opennova.uisize', String(z)); } catch (e) { /* storage unavailable */ }
  uiSizeBadge('Interface ' + Math.round(z * 100) + ' %');
  renderUiSize(); renderAll();
  if (typeof fitHeader === 'function') fitHeader();   // what fits beside the tabs changes with the size (app-shell.js)
}
// d = 1 bigger, -1 smaller (the next step of UI_SIZES), 0 = 100 %
function stepUiSize(d) {
  var z = uiZoom(), n = d === 0 ? 1 : d > 0 ? UI_SIZES.filter(function (x) { return x > z + 0.001; })[0] : UI_SIZES.filter(function (x) { return x < z - 0.001; }).pop();
  if (n == null || n === z) { uiSizeBadge('Interface ' + Math.round(z * 100) + ' %' + (n == null ? (d > 0 ? ' (largest)' : ' (smallest)') : '')); return; }
  setUiSize(n);
}
function setTextSize(f) {
  if (!TEXT_SIZES.some(function (t) { return t[0] === f; }) || f === uiText()) return;
  log('text_size', { from: textSizeName(uiText()), to: textSizeName(f) });
  if (f === 1) document.documentElement.style.removeProperty('--fs'); else document.documentElement.style.setProperty('--fs', String(f));
  try { localStorage.setItem('opennova.textsize', String(f)); } catch (e) { /* storage unavailable */ }
  uiSizeBadge('Text ' + textSizeName(f));
  renderUiSize(); renderAll();
  if (typeof fitHeader === 'function') fitHeader();
}
// The keys (app-shell.js's capture handler, before the tab keys): true when it was one of them. Matched on the character
// first, then on the key's place (e.code: a Mac's Option changes the character, other layouts move = and -; the number
// pad works everywhere). Windows reports AltGr as Ctrl+Alt: a key that types a character of its own is left alone.
function uiSizeKey(e) {
  if (!(e.ctrlKey || e.metaKey) || !e.altKey) return false;
  var k = e.key || '', d = k === '=' || k === '+' ? 1 : k === '-' || k === '_' || k === '−' ? -1 : k === '0' ? 0 : null;
  var a = document.activeElement, typing = a && /INPUT|TEXTAREA/.test(a.tagName), altGr = e.getModifierState && e.getModifierState('AltGraph');
  if (!IS_MAC && (altGr && typing || d == null && (k.length === 1 || altGr))) return false;
  if (d == null) d = { Equal: 1, NumpadAdd: 1, Minus: -1, NumpadSubtract: -1, Digit0: 0, Numpad0: 0 }[e.code];
  if (d == null) return false;
  e.preventDefault(); e.stopPropagation();
  if (e.repeat && d === 0) return true;
  log('shortcut', { key: 'Ctrl+Alt+' + (d > 0 ? '=' : d < 0 ? '-' : '0'), action: d > 0 ? 'interface bigger' : d < 0 ? 'interface smaller' : 'interface 100 %' });
  stepUiSize(d);
  return true;
}
// Corners (the pro look's radius tokens, looks/pro.css): 'round' (the default) | 'square'; set on <html> before first paint.
function setCorners(c) {
  c = c === 'square' ? 'square' : 'round';
  if (document.documentElement.dataset.corners === c) return;
  log('ui_corners', { from: document.documentElement.dataset.corners, to: c });
  document.documentElement.dataset.corners = c;
  try { localStorage.setItem('opennova.corners', c); } catch (e) { /* storage unavailable */ }
  renderUiSize();
}
// Settings ▸ Preferences: Interface size − 100 % + (the middle = back to 100 %), Text size A A A A, Corners.
function renderUiSize() {
  var box = $('uiSizeBtns'), tb = $('textSizeBtns'), z = uiZoom(), f = uiText();
  Array.prototype.forEach.call(document.querySelectorAll('#cornerBtns [data-corners]'), function (b) { var on = b.dataset.corners === (document.documentElement.dataset.corners || 'round'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  if (box) box.innerHTML = '<button type="button" data-uistep="-1" title="' + esc(keysText('Smaller (Ctrl+Alt+−)')) + '" aria-label="Smaller"' + (z <= UI_SIZES[0] ? ' disabled' : '') + '>−</button>' +
    '<button type="button" data-uistep="0" class="on" title="' + esc(keysText('Back to 100 % (Ctrl+Alt+0)')) + '">' + Math.round(z * 100) + ' %</button>' +
    '<button type="button" data-uistep="1" title="' + esc(keysText('Bigger (Ctrl+Alt+=)')) + '" aria-label="Bigger"' + (z >= UI_SIZES[UI_SIZES.length - 1] ? ' disabled' : '') + '>+</button>';
  if (tb) tb.innerHTML = TEXT_SIZES.map(function (t, i) {
    return '<button type="button" data-textsize="' + t[0] + '" title="' + t[1] + '" aria-label="' + t[1] + '" aria-pressed="' + (t[0] === f) + '"' + (t[0] === f ? ' class="on"' : '') +
      ' style="font-size:' + (11 + 2 * i) + 'px">A</button>';
  }).join('');
}

// ------------------------------------------------------------------ form bindings
function bindForms() {
  function onOut(id, fn) { $(id).addEventListener('change', function () { fn($(id).value); commit(); renderAll(); }); }
  onOut('canvasW', function (v) { P.canvasW = clamp(int(v, P.canvasW), 1, 65535); });   // stored as 16-bit in the .scr
  onOut('canvasH', function (v) { P.canvasH = clamp(int(v, P.canvasH), 1, 65535); });
  onOut('bitDepth', function (v) { P.bitDepth = int(v, 8); });
  onOut('refresh', function (v) { var f = parseFloat(v); P.refresh = f > 0 ? f : 60; });
  $('lowLatency').addEventListener('change', function () { P.lowLatency = $('lowLatency').checked; commit(); renderAll(); });
  onOut('rxCard', function (v) { P.rxCard = v.trim(); });

  function onScr(id, fn) { $(id).addEventListener('change', function () { var s = screenById(ui.sel); if (!s) return; fn(s, $(id).value); commit(); renderAll(); }); }
  $('sName').addEventListener('change', function () { var g = groupOf(screenById(ui.sel)); if (g) renameGroup(g, $('sName').value); else renderAll(); });   // the group's name (app-sections.js)
  onScr('sX', function (s, v) { s.x = Math.max(0, int(v, s.x)); });
  onScr('sY', function (s, v) { s.y = Math.max(0, int(v, s.y)); });
  onScr('sCols', function (s, v) { s.cols = clamp(int(v, s.cols), 1, 255); pruneScreen(s); });
  onScr('sRows', function (s, v) { s.rows = clamp(int(v, s.rows), 1, 255); pruneScreen(s); });
  onScr('sPanel', function (s, v) { s.panelId = v; s.override = {}; });
  onScr('wCorner', function (s, v) { s.wiring.corner = v; });
  onScr('wDir', function (s, v) { s.wiring.dir = v; });
  onScr('wPattern', function (s, v) { s.wiring.pattern = v; });
  onScr('wSplit', function (s, v) { s.wiring.split = v; });
  onScr('wMax', function (s, v) { s.wiring.max = Math.max(0, int(v, 0)); });
  onScr('wSender', function (s, v) { s.wiring.sender = int(v, 0); });
  onScr('wPort', function (s, v) { s.wiring.port = Math.max(0, int(v, 1) - 1); });
  $('mSender').onchange = function () { ui.mSender = int($('mSender').value, 0); renderAll(); };
  $('mPort').onchange = function () { ui.mPort = Math.max(0, int($('mPort').value, 1) - 1); renderAll(); };
  $('lctName').addEventListener('change', function () {
    var lc = lctById(ui.viewScreen), v = $('lctName').value.trim();
    if (!lc || !v) { renderOutput(); return; }
    log('rename_screen', { from: lc.name, to: v, via: 'screen card' });
    lc.name = v; commit(); renderAll();
    if (v.length > 10) toast('NovaLCT keeps the first 10 characters: “' + v.slice(0, 10) + '”');
  });

  $('btnNextFree').onclick = function () { var s = screenById(ui.sel); if (!s) return; var nf = lctFreePort(s.screenId, s.id); s.wiring.sender = nf.sender; s.wiring.port = nf.port; commit(); renderAll(); };
  $('btnHoleMode').onclick = function () { ui.tool = ui.tool === 'hole' ? null : 'hole'; renderAll(); };
  $('btnClearPort').onclick = function () {
    var s = screenById(ui.sel); if (!s) return; ensureManual(s);
    Object.keys(s.manual).forEach(function (k) { var a = s.manual[k]; if (a.sender === ui.mSender && a.port === ui.mPort) delete s.manual[k]; });
    commit(); renderAll();
  };
  $('btnReverse').onclick = function () {
    var s = screenById(ui.sel); if (!s) return;
    reversePort(s, ui.mSender, ui.mPort);
    commit(); renderAll();
  };
  $('btnToAuto').onclick = function () { var s = screenById(ui.sel); if (!s) return; s.manual = autoAssign(s); commit(); renderAll(); };
  $('btnDelScreen').onclick = function () { var s = screenById(ui.sel); if (s) deleteSection(s); };
  // (Move to another screen / processor, Duplicate and Clear all ports are on the right-click menu: app-context-menu.js)

  // Sending card card: ports of a "Pick a model" card; the processor is edited in the Processors
  // tab (app-devices.js).
  $('btnEditProc').onclick = function () { devShow(deviceOfCard(ui.mSender || 0)); };
  $('btnTreeAdd').onclick = function () { var r = $('btnTreeAdd').getBoundingClientRect(); treeAddMenu(r.left, r.bottom + 4); };
  $('treeSearch').addEventListener('input', function () { renderTree(portUsage(allCells())); });
  $('cardPorts').addEventListener('change', function () {
    var pr = P.processors[ui.mSender || 0]; if (!pr) return;
    setCardPorts(ui.mSender || 0, int($('cardPorts').value, pr.ports));   // refuses below the highest wired port
  });
  // Panel library: + adds a type and picks it (so it opens for editing); the search filters.
  $('btnAddPanel').onclick = function () {
    var pn = { id: uid(), name: 'Cabinet', w: 128, h: 128 };
    P.panels.push(pn); ui.drawPanelId = pn.id;
    log('add_panel', { size: pn.w + '×' + pn.h });
    commit(); renderAll();
  };
  $('panelSearch').addEventListener('input', renderPanelLibrary);
  // Toolbar Auto | Manual | Self draw. Auto / Manual set the selected section's wiring (and
  // leave Self draw); Self draw is setSelfDraw (app-selfdraw.js).
  Array.prototype.forEach.call($('modeSeg').children, function (btn) {
    btn.onclick = function () {
      var m = btn.dataset.mode, hasDraw = typeof setSelfDraw === 'function';
      if (m === 'draw') {
        if (hasDraw) setSelfDraw(ui.tool !== 'draw'); else toast('Self draw isn’t available in this version');   // toggles
        return;
      }
      if (ui.tool === 'draw' && hasDraw) setSelfDraw(false);
      var s = screenById(ui.sel);
      if (s && s.wiring.mode !== m && !(m === 'auto' && s.kind === 'complex')) setWiringMode(s, m); else renderAll();
    };
  });
  bindCards(); bindViewMenu();
  $('btnAddScreen').onclick = function () {
    var x = 0;
    visibleScreens().forEach(function (s) { var b = screenBounds(s); x = Math.max(x, b.x + b.w); });
    var s = newScreen(x, 0); P.screens.push(s); ui.sel = s.id; commit(); ui.view = null; renderAll();
  };
  $('btnZoomFit').onclick = function () { fitView(); renderCanvas(allCells()); };
  $('btnZoomIn').onclick = function () { zoom(1 / 1.3); };
  $('btnZoomOut').onclick = function () { zoom(1.3); };
  $('showWires').onchange = function () { ui.showWires = $('showWires').checked; renderCanvas(allCells()); };
  $('showLabels').onchange = function () { ui.showLabels = $('showLabels').checked; renderCanvas(allCells()); };
  try { ui.magnet = localStorage.getItem('opennova.magnet') !== 'off'; } catch (e) { ui.magnet = true; }
  $('magnet').checked = ui.magnet;
  $('magnet').onchange = function () {
    ui.magnet = $('magnet').checked;
    try { localStorage.setItem('opennova.magnet', ui.magnet ? 'on' : 'off'); } catch (e) { /* storage unavailable */ }
  };

  $('btnNew').onclick = function () {
    if (projShared()) return projNew();   // with the server's project list: a new project in the list (app-sync.js)
    if (P.screens.length && !confirm('Start a new project? (Current one can be restored with Ctrl+Z)')) return log('new_project', { cancelled: true });
    log('new_project', { replacing: P.name });
    var pj = newProject(); pj.mode = olMode(); replaceProject(pj);   // in the open workspace (app-online.js)
    devOpenPicker({ first: true });   // "Which processors are you using?" (app-devices.js)
  };
  // Pattern pad: 8 serpentines (start corner × rows/columns), each drawn as a 3×3 cable path.
  var pad = $('patternPad');
  PATTERNS.forEach(function (pd) {
    var btn = document.createElement('button');
    btn.title = patternTitle(pd[0], pd[1], pd[2]); btn.innerHTML = patternIcon(pd[0], pd[1], pd[2]);
    btn.onclick = function () { applyPattern(pd[0], pd[1], pd[2]); };
    pad.appendChild(btn);
  });
  $('mSplit').onchange = function () { var s = screenById(ui.sel); if (!s) return; s.wiring.split = $('mSplit').value; commit(); renderAll(); };
  $('btnExport').onclick = exportScr;
  $('btnExportScfg').onclick = exportScfg;   // app-scfg.js
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    $('btnTheme').textContent = 'Theme: ' + (t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Auto');
  }
  var theme = 'dark';   // dark by default; Auto follows the OS setting
  try { theme = localStorage.getItem('opennova.theme') || 'dark'; } catch (e) { /* storage unavailable */ }
  applyTheme(theme);
  renderUiSize();
  $('uiSizeBtns').onclick = function (e) { var b = e.target.closest('[data-uistep]'); if (b) stepUiSize(+b.dataset.uistep); };
  $('textSizeBtns').onclick = function (e) { var b = e.target.closest('[data-textsize]'); if (b) setTextSize(parseFloat(b.dataset.textsize)); };
  if ($('cornerBtns')) $('cornerBtns').onclick = function (e) { var b = e.target.closest('[data-corners]'); if (b) setCorners(b.dataset.corners); };
  $('btnTheme').onclick = function () {
    theme = theme === 'dark' ? 'light' : theme === 'light' ? 'auto' : 'dark';
    try { localStorage.setItem('opennova.theme', theme); } catch (e) { /* storage unavailable */ }
    applyTheme(theme); renderCanvas(allCells());
  };
  $('btnSaveProject').onclick = function () {
    log('save_project_file', { file: (P.name || 'project') + '.ledmap.json', sections: P.screens.length });
    download(new Blob([JSON.stringify(P, null, 1)], { type: 'application/json' }), (P.name || 'project') + '.ledmap.json');
  };

  // Hold Space to pan the canvas with the mouse.
  function setSpace(on) { ui.spaceHeld = on; $('viewport').classList.toggle('space-pan', on); }
  document.addEventListener('keyup', function (e) {
    if (e.code === 'Space' && ui.spaceHeld) { e.preventDefault(); setSpace(false); }
  });
  window.addEventListener('blur', function () { setSpace(false); });
  document.addEventListener('keydown', function (e) {
    if (!$('logDlg').hidden) { if (e.key === 'Escape') $('logClose').click(); return; }   // Logs window open: keys are its own
    var typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.code === 'Space' && !typing) {   // no page scroll / button press while Space pans
      e.preventDefault();
      if (!e.repeat) setSpace(true);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
    else if (e.key === 'Tab' && !typing && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      stepSelectedPort(e.shiftKey ? -1 : 1);
      renderAll();
      toast('Port ' + portLabel(ui.mSender, ui.mPort));
    }
    else if (!typing && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      var as = screenById(ui.sel);
      if (!as || as.wiring.mode !== 'manual') return;
      e.preventDefault();
      var before = JSON.stringify(as.manual), amsg = arrowStep(as, e.key);
      if (JSON.stringify(as.manual) !== before) { commit(); renderAll(); }
      if (amsg) toast(amsg);
    }
    else if (e.key === 'Escape' && !$('ctxMenu').hidden) { closeMenu(); }
    else if (e.key === 'Escape') { ui.tool = null; ui.selKeys = new Set(); renderAll(); }
    else if (!typing && (e.key === 'b' || e.key === 'B') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // B = Set blank: the selected panels become blanks (or, if they all are, panels again);
      // with nothing selected it switches the Set blank tool on / off.
      e.preventDefault();
      var bs = screenById(ui.selScreen);
      if (bs && ui.selKeys && ui.selKeys.size && !bs.drawn) {
        var keys = Array.from(ui.selKeys), allBlank = keys.every(function (k) { return bs.holes[k]; });
        keys.forEach(function (k) { if (!!bs.holes[k] === allBlank) toggleHole(bs, k); });
        log('set_blank', { section: bs.name, panels: keys.length, to: allBlank ? 'panels' : 'blanks' });
        ui.selKeys = new Set(); commit(); renderAll();
        toast(keys.length + (allBlank ? ' blank(s) turned back into cabinets' : ' cabinet(s) set blank') + ' (Ctrl+Z to undo)');
      } else if (bs && bs.drawn && ui.selKeys && ui.selKeys.size) {
        toast('Self-drawn cabinets are deleted rather than blanked — press Delete');
      } else {
        if (ui.tool === 'draw') setSelfDraw(false);
        ui.tool = ui.tool === 'hole' ? null : 'hole';
        log('set_blank_tool', { on: ui.tool === 'hole' });
        renderAll();
      }
    }
    else if (!typing && (e.key === 'Delete' || e.key === 'Backspace') && ui.selKeys && ui.selKeys.size && screenById(ui.selScreen)) {
      // with panels selected, Delete takes them off their ports (not the screen)
      e.preventDefault();
      var ss = screenById(ui.selScreen); ensureManual(ss);
      var touched = {};
      ui.selKeys.forEach(function (k) { var a = ss.manual[k]; if (a) { touched[a.sender + ':' + a.port] = a; delete ss.manual[k]; } });
      Object.keys(touched).forEach(function (pk) { renumber(ss, touched[pk].sender, touched[pk].port); });
      ui.selKeys = new Set(); commit(); renderAll(); toast('Unwired the selected cabinets');
    }
    // (a Mac's delete key sends Backspace)
    else if (!typing && (e.key === 'Delete' || (IS_MAC && e.key === 'Backspace')) && ui.sel) { e.preventDefault(); $('btnDelScreen').click(); }
  });
}

// Right-panel cards (VMP style): the header folds / unfolds the card; folded cards are
// remembered in this browser. CARDS_FOLDED = cards that start folded until the user opens them (Unico's Cabinet
// Library starts collapsed): the cabinet types, which unfold themselves in Self draw (renderPanelLibrary).
var CARDS_KEY = 'opennova.cards', CARDS_FOLDED = { panels: true };
function cardsClosed() {
  var closed = {};
  try { closed = JSON.parse(localStorage.getItem(CARDS_KEY) || '{}') || {}; } catch (e) { closed = {}; }
  return closed;
}
function cardIsFolded(name) { var c = cardsClosed(); return name in c ? !!c[name] : !!CARDS_FOLDED[name]; }
// Fold (true) / unfold (false) a card; null = back to the remembered state. passing = don't remember it (Self draw).
function cardFold(name, fold, passing) {
  var card = document.querySelector('.card[data-card="' + name + '"]'); if (!card) return;
  if (fold == null) fold = cardIsFolded(name);
  card.classList.toggle('collapsed', fold); card.querySelector('.card-t').setAttribute('aria-expanded', String(!fold));
  if (passing) return;
  var closed = cardsClosed();
  if (fold === !!CARDS_FOLDED[name]) delete closed[name]; else closed[name] = fold;
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(closed)); } catch (e) { /* storage unavailable */ }
}
function bindCards() {
  Array.prototype.forEach.call(document.querySelectorAll('.card[data-card]'), function (card) {
    var name = card.dataset.card;
    cardFold(name, null, true);
    card.querySelector('.card-t').onclick = function () {
      var fold = !card.classList.contains('collapsed');
      cardFold(name, fold);
      log('card_fold', { card: name, folded: fold });
    };
  });
  bindOutputGroup();
}
// The Screen card's Output group (bit depth, frame rate, receiving card, low latency): open by default (user,
// 2026-10-11), folded or not remembered in this browser.
var OUTPUT_KEY = 'opennova.outputGroup';
function bindOutputGroup() {
  var d = $('outGroup'); if (!d) return;
  try { if (localStorage.getItem(OUTPUT_KEY) === 'closed') d.open = false; } catch (e) { /* storage unavailable */ }
  d.addEventListener('toggle', function () {
    log('card_fold', { card: 'output', folded: !d.open });
    try { if (d.open) localStorage.removeItem(OUTPUT_KEY); else localStorage.setItem(OUTPUT_KEY, 'closed'); } catch (e) { /* storage unavailable */ }
  });
}

// Toolbar View ▾ (VMP View ▸ Display): Wires, Labels, Coords, Magnet, Grid / Snap / step, Rulers, Live. The checkboxes
// keep their ids and handlers (here, app-arrange.js, app-screenfit.js, app-health.js); the menu stays open while you
// tick them and closes on a click elsewhere, Esc or a tab change.
function viewMenu(open) {
  var m = $('viewMenu'); if (!m) return;
  if (open == null) open = m.hidden;
  m.hidden = !open; $('btnView').setAttribute('aria-expanded', String(open));
  if (!open) return;
  m.style.left = ''; m.style.right = '';   // narrow windows: open toward the left when it would run off the right edge
  if (m.getBoundingClientRect().right > (document.documentElement.clientWidth || innerWidth) - 4) { m.style.left = 'auto'; m.style.right = '0'; }
}
function bindViewMenu() {
  $('btnView').onclick = function (e) { e.stopPropagation(); viewMenu(); };
  document.addEventListener('click', function (e) { if (!e.target.closest('#viewMenu') && !e.target.closest('#btnView')) viewMenu(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('viewMenu').hidden) viewMenu(false); });
  Array.prototype.forEach.call($('viewMenu').querySelectorAll('input[type=checkbox]'), function (c) {
    c.addEventListener('change', function () { log('view_option', { option: c.id, on: c.checked }); });
  });
}
// View ▸ Live from elsewhere (Monitor's "Show on canvas"): 'off' | 'status' | 'temp'; shows the Layout tab.
function viewLive(v) {
  var lv = $('liveView'); if (!lv) return;
  if (lv.value !== v) { lv.value = v; lv.dispatchEvent(new Event('change')); }   // app-health.js reads it and polls
  if (ui.tab !== 'layout') setTab('layout');
}
