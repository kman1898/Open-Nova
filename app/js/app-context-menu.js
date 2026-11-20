// app-context-menu.js - the right-click menu: closeMenu, the serpentine pattern pads
// (patternIcon, PATTERNS, patternTitle; also used by the side panel's pad in app-forms),
// buildMenu, openMenu and openCanvasMenu.
// Registers at load a document pointerdown listener and a window blur listener that close
// the menu.
// Depends on: app-core, app-capacity, app-geometry, app-canvas-input (screenAt, cellAt),
// app-manual-wiring, app-sections, app-render, app-display, app-health, app-service (svCellKeys, svOpenCabinets).
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ---- Right-click menu
function closeMenu() { var m = $('ctxMenu'); if (m && !m.hidden) { m.hidden = true; m.innerHTML = ''; } }
function patternIcon(corner, dir, raster) {
  var pts = [], fr = corner[1] === 'R', fb = corner[0] === 'B';
  for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) {
    var jj = i % 2 && !raster ? 2 - j : j;   // raster: every line starts on the same side
    var col = dir === 'H' ? (fr ? 2 - jj : jj) : (fr ? 2 - i : i);
    var row = dir === 'H' ? (fb ? 2 - i : i) : (fb ? 2 - jj : jj);
    pts.push((4 + col * 8) + ',' + (4 + row * 8));
  }
  var cells = '';
  for (var cc = 0; cc < 3; cc++) for (var rr = 0; rr < 3; rr++) cells += '<rect class="pp-cell" x="' + (1 + cc * 8) + '" y="' + (1 + rr * 8) + '" width="6" height="6" rx="1"/>';
  var st = pts[0].split(',');
  return '<svg viewBox="0 0 26 26" class="pattern-icon">' + cells + '<polyline class="pp-path" points="' + pts.join(' ') + '"/><circle class="pp-start" cx="' + st[0] + '" cy="' + st[1] + '" r="2.6"/></svg>';
}
// 16 patterns, as LCT / Unico offer them: 4 start corners × rows / columns × serpentine / raster.
var PATTERNS = [['TL', 'H'], ['TR', 'H'], ['BL', 'H'], ['BR', 'H'], ['TL', 'V'], ['TR', 'V'], ['BL', 'V'], ['BR', 'V'],
  ['TL', 'H', 1], ['TR', 'H', 1], ['BL', 'H', 1], ['BR', 'H', 1], ['TL', 'V', 1], ['TR', 'V', 1], ['BL', 'V', 1], ['BR', 'V', 1]];
function patternTitle(corner, dir, raster) {
  return (raster ? 'Raster (each line from the same side) from ' : 'Serpentine from ') + { TL: 'top-left', TR: 'top-right', BL: 'bottom-left', BR: 'bottom-right' }[corner] + ', ' + (dir === 'H' ? 'rows' : 'columns');
}

function buildMenu(items, into) {
  items.forEach(function (it) {
    if (it.sep) { var sp = document.createElement('div'); sp.className = 'ctx-sep'; into.appendChild(sp); return; }
    if (it.header) { var h = document.createElement('div'); h.className = 'ctx-h'; h.textContent = it.header; into.appendChild(h); return; }
    if (it.pads) {
      var box = document.createElement('div'); box.className = 'ctx-pads';
      PATTERNS.forEach(function (pd) {
        var b = document.createElement('button'); b.title = patternTitle(pd[0], pd[1], pd[2]); b.innerHTML = patternIcon(pd[0], pd[1], pd[2]);
        b.onclick = function () { closeMenu(); applyPattern(pd[0], pd[1], pd[2]); };
        box.appendChild(b);
      });
      into.appendChild(box); return;
    }
    var btn = document.createElement('button');
    btn.className = 'ctx-i'; btn.setAttribute('role', 'menuitem');
    btn.innerHTML = '<span>' + esc(it.label) + '</span>' + (it.sub ? '<span class="ctx-k">▸</span>' : it.key ? '<span class="ctx-k">' + esc(keysText(it.key)) + '</span>' : '');
    if (it.disabled) btn.disabled = true;
    if (it.sub) {
      var sub = document.createElement('div'); sub.className = 'ctx ctx-sub'; sub.hidden = true;
      buildMenu(it.sub, sub); btn.appendChild(sub);
      var show = function () {
        Array.prototype.forEach.call(into.querySelectorAll(':scope > .ctx-i > .ctx-sub'), function (o) { if (o !== sub) { o.hidden = true; o.parentNode.classList.remove('open'); } });
        sub.hidden = false; btn.classList.add('open');
        var r = sub.getBoundingClientRect();
        if (r.right > innerWidth) { sub.style.left = 'auto'; sub.style.right = '100%'; }
        if (r.bottom > innerHeight) sub.style.top = (innerHeight - r.bottom - 5) / uiZoom() + 'px';
      };
      btn.onmouseenter = show; btn.onclick = function (e) { e.stopPropagation(); show(); };
    } else {
      btn.onmouseenter = function () { Array.prototype.forEach.call(into.querySelectorAll(':scope > .ctx-i > .ctx-sub'), function (o) { o.hidden = true; o.parentNode.classList.remove('open'); }); };
      btn.onclick = function (e) { e.stopPropagation(); if (it.disabled) return; ui.menuEvent = e; closeMenu(); it.act(); ui.menuEvent = null; };   // menuEvent: Ctrl / Shift held (app-pipeline.js)
    }
    into.appendChild(btn);
  });
}

function openMenu(x, y, items) {
  var m = $('ctxMenu'); m.innerHTML = ''; buildMenu(items, m); m.hidden = false;
  m.style.left = '0px'; m.style.top = '0px'; m.classList.remove('tall');
  var r = m.getBoundingClientRect();
  if (r.height > innerHeight - 8) { m.classList.add('tall'); r = m.getBoundingClientRect(); }   // short screens: scroll it
  var z = uiZoom();   // x, y and r are on-screen px; CSS px inside the page are scaled by the interface size (app-forms.js)
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) / z + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) / z + 'px';
  var first = m.querySelector('.ctx-i:not([disabled])'); if (first) first.focus();
}

function openCanvasMenu(cx, cy, pt) {
  var s = screenAt(pt), items = [];
  if (!s) {
    items.push({ header: (lctById(ui.viewScreen) || {}).name || 'Canvas' });
    items.push({ label: '+ Cabinets', act: function () { setSelfDraw(true); } });   // draw them (app-selfdraw.js); Quick add grows a block
    items.push({ label: '+ Screen', act: function () { addLctScreen(); } });   // the next screen of the active processor (app-sections.js)
    items.push({ sep: true }, { label: 'Fit view', act: function () { fitView(); renderCanvas(allCells()); } });
    return openMenu(cx, cy, items);
  }
  if (ui.sel !== s.id) { ui.sel = s.id; if (!(ui.selSecs && ui.selSecs.has(s.id))) ui.selSecs = new Set(s.group ? groupSelIds(s) : []); renderAll(); }
  var c = cellAt(s, pt), full = c && cellsOf(s).find(function (x) { return x.k === c.k; });
  var grp = groupOf(s), multi = arrangeTargets(), many = multi.length > 1 && multi.indexOf(s) >= 0;   // a group / Ctrl+clicked cabinets
  var manual = s.wiring.mode === 'manual', cp = curPort();
  var here = full && full.sender != null ? { sender: full.sender, port: full.port } : null;
  var where = c ? (s.kind === 'complex' ? 'cabinet ' + (c.c + 1) : 'col ' + (c.c + 1) + ', row ' + (c.r + 1)) : '';
  items.push({ header: (grp ? grp.name : 'Cabinet') + (where ? ' · ' + where : '') + (here ? ' · ' + portLabel(here.sender, here.port) : '') });

  if (c && !c.hole) {
    var onOther = here && !(here.sender === cp.sender && here.port === cp.port);
    items.push({ label: here && !onOther ? 'Already on ' + portLabel(cp.sender, cp.port) : onOther ? 'On ' + portLabel(here.sender, here.port) + ' (not overwritten)' : 'Wire to ' + portLabel(cp.sender, cp.port),
      disabled: !!here, key: 'click', act: function () { var msg = addToCurrentPort(s, c.k); commit(); renderAll(); if (msg) toast(msg); } });
    if (here) items.push({ label: 'Draw on ' + portLabel(here.sender, here.port) + ' (make current)', act: function () { ui.mSender = here.sender; ui.mPort = here.port; renderAll(); } });
    if (here) items.push({ label: 'Unwire this cabinet', act: function () { ensureManual(s); unwire(s, c.k); commit(); renderAll(); } });
  }
  if (c && s.drawn) {   // Self draw panels are removed outright rather than blanked
    items.push({ label: 'Delete this cabinet', act: function () { sdDeletePanels(s, [c.k]); } });
    var nSelD = ui.selScreen === s.id && ui.selKeys ? ui.selKeys.size : 0;
    if (nSelD) items.push({ label: 'Delete ' + nSelD + ' selected cabinet(s)', key: 'Del', act: function () { sdDeletePanels(s, Array.from(ui.selKeys)); } });
  } else if (c) items.push({ label: c.hole ? 'Remove blank' : 'Set blank', key: 'Alt+click', act: function () { toggleHole(s, c.k); commit(); renderAll(); } });

  if (c && !c.hole && full && full.sender != null) {   // Display & Test (app-display.js)
    var testCells = ui.selScreen === s.id && ui.selKeys && ui.selKeys.size ? cellsOf(s).filter(function (x) { return ui.selKeys.has(x.k) && !x.hole; }) : cellsOf(s).filter(function (x) { return !x.hole; });
    items.push({ label: 'Identify this cabinet', act: function () { dispIdentify(s, c); } });
    var hat = typeof hltCellAt === 'function' ? hltCellAt(full) : null, hd = hat && deviceOfCard(hat.card);   // errors kept until Clear (app-health)
    if (hd && hltHeldAt(hat.card, hat.port, hat.index).length) items.push({ label: 'Clear errors on this cabinet', act: function () { hltClear({ dev: hd, cab: hat }); } });
    items.push({ label: 'Test pattern', sub: dispMenuItems(testCells).filter(function (it) { return !it.header; }) });
    // restart the receiving card (Maintain's Restart, app-service.js): this cabinet, or the selected ones it is among
    var rsel = ui.selScreen === s.id && ui.selKeys && ui.selKeys.size > 1 && ui.selKeys.has(c.k) ? cellsOf(s).filter(function (x) { return ui.selKeys.has(x.k) && !x.hole; }) : null;
    items.push({ label: 'Restart this cabinet…', act: function () { svOpenCabinets(svCellKeys([full])); } });
    if (rsel) items.push({ label: 'Restart ' + rsel.length + ' selected cabinets…', act: function () { svOpenCabinets(svCellKeys(rsel)); } });
  }
  items.push({ sep: true });
  var select = function (keys) { if (!manual) ensureManual(s); ui.selScreen = s.id; ui.selKeys = new Set(keys); if (!manual) commit(); renderAll(); };
  var liveKeys = function (f) { return cellsOf(s).filter(function (x) { return !x.hole && f(x); }).map(function (x) { return x.k; }); };
  if (here) items.push({ label: 'Select ' + portLabel(here.sender, here.port) + ' cabinets', act: function () { select(liveKeys(function (x) { return x.sender === here.sender && x.port === here.port; })); } });
  if (c && s.kind !== 'complex') {
    items.push({ label: 'Select row ' + (c.r + 1), act: function () { select(liveKeys(function (x) { return x.r === c.r; })); } });
    items.push({ label: 'Select column ' + (c.c + 1), act: function () { select(liveKeys(function (x) { return x.c === c.c; })); } });
  }
  items.push({ label: 'Select all these cabinets', act: function () { select(liveKeys(function () { return true; })); } });
  if (!s.regions) items.push({ label: 'Select all ' + panelOf(s).name + ' cabinets', act: function () { selectSamePanel(s); } });   // app-arrange.js
  var nSel = ui.selScreen === s.id && ui.selKeys ? ui.selKeys.size : 0;
  if (nSel) {
    items.push({ header: 'Fill ' + nSel + ' selected from ' + portLabel(cp.sender, cp.port) + ' (' + (s.wiring.split === 'fill' ? 'max capacity' : 'organized') + ')' }, { pads: true });
    items.push({ label: 'Unwire selected cabinets', key: 'Del', act: function () {
      ensureManual(s); var touched = {};
      ui.selKeys.forEach(function (k) { var a = s.manual[k]; if (a) { touched[a.sender + ':' + a.port] = a; delete s.manual[k]; } });
      Object.keys(touched).forEach(function (pk) { renumber(s, touched[pk].sender, touched[pk].port); });
      ui.selKeys = new Set(); commit(); renderAll();
    } });
    if (nSel === 2) items.push({ label: 'Swap these two cabinets in their chains', act: function () { swapPanels(s, Array.from(ui.selKeys)); } });
    items.push({ label: 'Clear selection', key: 'Esc', act: function () { ui.selKeys = new Set(); renderAll(); } });
  }

  items.push({ sep: true });
  if (here) {
    items.push({ label: 'Reverse ' + portLabel(here.sender, here.port), act: function () { reversePort(s, here.sender, here.port); commit(); renderAll(); } });
    items.push({ label: 'Clear ' + portLabel(here.sender, here.port), act: function () {
      ensureManual(s); Object.keys(s.manual).forEach(function (k) { var a = s.manual[k]; if (a.sender === here.sender && a.port === here.port) delete s.manual[k]; });
      commit(); renderAll();
    } });
  }
  items.push({ label: 'Clear all ports on these cabinets', act: function () { clearAllPorts(s); } });
  if (s.kind !== 'complex') items.push({ label: manual ? 'Switch to Auto wiring' : 'Switch to Manual wiring', act: function () { setWiringMode(s, manual ? 'auto' : 'manual'); } });

  items.push({ sep: true });
  // a screen belongs to one processor: other screens of the cabinets' processor (or of none yet), its cards only
  var sd = cardsUsed(cellsOf(s)).map(deviceOfCard).filter(Boolean)[0], okCards = lctAllowedCards(s.screenId);
  items.push({ label: 'Move cabinets to', sub: P.lct.filter(function (lc) { var o = lctOwner(lc); return lc.id !== s.screenId && (!sd || !o || o.id === sd.id); }).map(function (lc) {
    return { label: lc.name, act: function () { moveSectionTo(s, lc.id); } };
  }).concat([{ label: 'New screen', act: function () { moveSectionTo(s, '__new'); } }]) });
  items.push({ label: 'Move ports to', sub: P.processors.map(function (pr, i) {
    return { label: cardName(i), i: i, act: function () { movePortsTo(s, i); } };
  }).filter(function (it) { return !okCards || okCards.indexOf(it.i) >= 0; }) });
  items.push({ label: 'Arrange', sub: arrangeMenuItems().filter(function (it) { return !it.header; }) });   // app-arrange.js
  // Group (Unico's Ctrl+G): the selected cabinets become one named group; Ungroup takes it apart (app-sections.js)
  if (many && !(grp && groupMembers(grp).length === multi.length && multi.every(function (x) { return x.group === grp.id; }))) items.push({ label: 'Group', key: 'Ctrl+G', act: function () { groupSections(multi); } });
  if (grp) {
    items.push({ label: 'Rename group…', act: function () { renameGroup(grp); } });
    items.push({ label: 'Ungroup', key: 'Ctrl+Shift+G', act: function () { ungroupSections(groupMembers(grp)); } });
  } else if (!many) items.push({ label: 'Group', key: 'Ctrl+G', act: function () { groupSections([s]); } });
  items.push({ label: 'Duplicate cabinets', act: function () { duplicateSection(s); } });
  items.push({ label: many ? 'Delete ' + secsLabel(multi) : 'Delete cabinets', key: 'Del', act: function () { deleteSection(s); } });
  openMenu(cx, cy, items);
}
document.addEventListener('pointerdown', function (e) { var m = $('ctxMenu'); if (m && !m.hidden && !m.contains(e.target)) closeMenu(); });
window.addEventListener('blur', closeMenu);
