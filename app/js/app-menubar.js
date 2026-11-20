// app-menubar.js - the menu bar, the very top line of the window above the tabs, as in Unico / VMP (user, 2026-10-12):
// File · Edit · View · Tools · Settings · Help (VMP's set; the user calls the first one File), Unico's look and item names,
// the project's name centred (click = File, where the project list is). Every item is an action the app already has: the
// buttons that lived in the old Project ▾ / Tools ▾ were moved here with their ids and handlers; Edit and View call the
// Layout's own functions and checkboxes (the Layout toolbar keeps its View ▾ for quick access and the grid step).
// Desktop behaviour: a click opens a menu, hovering another title while one is open moves to it, Esc / a click outside
// closes, F10 or Alt pressed alone opens File (Alt+1…9 and Alt+B / F / N stay the tab and display keys), arrows walk the
// items and submenus (›). Narrow windows (≤ 700 px): one ☰ button; the titles and their menus stack below it.
// Owns: mb, mbTops, mbOpenName, mbNarrow, mbClose, mbOpen, mbSubClose, mbSubOpen, mbFill, mbRender, mbEditItems, mbViewItems,
// mbHLoginItems, mbItems, mbFocus, mbHelp, renderMenuBar, bindMenuBar.
// Depends on: app-core (P, ui, $, esc, log, keysText, IS_MAC, undo, redo), app-arrange (arrangeMenuItems, arrangeSelectAll,
// zoomOneToOne, zoomToSelection), app-sections (duplicateSection, deleteSection), app-forms (viewLive, UI_SIZES, TEXT_SIZES,
// uiZoom, uiText, setUiSize, stepUiSize, setTextSize), app-sync
// (projMenuFill), app-display (openTestMenu), app-devices (devOpenPicker), app-online (olIsH, hlOpen), app-watch (watch,
// watchUnit), app-preshow, app-shell (setTab, TABS, shortcutSheet), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var mb = { alt: false };   // alt: Alt went down on its own (released with nothing in between = open File)

function mbTops() { return Array.prototype.slice.call(document.querySelectorAll('#menuBar .mb-top')); }
function mbOpenName() { var t = mbTops().filter(function (b) { return !$(b.dataset.mb).hidden; })[0]; return t ? t.dataset.mb : null; }
function mbNarrow() { var b = $('mbBurger'); return !!b && getComputedStyle(b).display !== 'none'; }

function mbSubClose(scope, keep) {
  Array.prototype.forEach.call(scope.querySelectorAll('.mb-sub'), function (s) {
    if (keep && (s === keep || s.contains(keep))) return;
    s.lastElementChild.hidden = true; s.classList.remove('open'); s.firstElementChild.setAttribute('aria-expanded', 'false');
  });
}
// Close every menu (keepList: on narrow windows the ☰ list stays open).
function mbClose(keepList) {
  var bar = $('menuBar'); if (!bar) return;
  mbSubClose(bar);
  mbTops().forEach(function (b) { $(b.dataset.mb).hidden = true; b.setAttribute('aria-expanded', 'false'); b.classList.remove('on'); });
  if (!keepList) { bar.classList.remove('mb-list'); $('mbBurger').setAttribute('aria-expanded', 'false'); }
}
function mbOpen(id, focus) {
  var top = mbTops().filter(function (b) { return b.dataset.mb === id; })[0]; if (!top) return;
  var bar = $('menuBar'), m = $(id);
  if (typeof closeMenu === 'function') closeMenu();   // a right-click / Test ▾ menu left open
  mbClose(true);
  if (mbNarrow()) { bar.classList.add('mb-list'); $('mbBurger').setAttribute('aria-expanded', 'true'); }
  mbFill(id);
  m.hidden = false; top.setAttribute('aria-expanded', 'true'); top.classList.add('on');
  m.style.left = m.style.right = '';
  if (!mbNarrow() && m.getBoundingClientRect().right > innerWidth - 4) { m.style.left = 'auto'; m.style.right = '0'; }
  if (focus) mbFocus(m, 0);
}
function mbSubOpen(sub, focus) {
  var m = sub.lastElementChild;
  mbSubClose(sub.parentNode, sub);
  if (m.id === 'mbHLogins') mbRender(m, mbHLoginItems());
  if (m.dataset.items) mbRender(m, mbViewItems()[m.dataset.items]);   // View ▸ Live / Interface Size / Text Size
  m.hidden = false; sub.classList.add('open'); sub.firstElementChild.setAttribute('aria-expanded', 'true');
  m.style.left = m.style.right = m.style.top = '';
  // Placed to stay in the window: right of its menu, else left of it, else (no room either side: a narrow window at a
  // big interface size) over the menu against the window's right edge; a long one low in its menu moves up. The rects
  // are on-screen px, the CSS lengths are scaled by the interface size (app-forms.js uiZoom).
  if (!mbNarrow()) {
    var z = uiZoom(), r = m.getBoundingClientRect();
    if (r.right > innerWidth - 4) {
      m.style.left = 'auto'; m.style.right = '100%'; r = m.getBoundingClientRect();
      if (r.left < 4) { m.style.right = 'auto'; m.style.left = (Math.max(4, innerWidth - 4 - r.width) - sub.getBoundingClientRect().left) / z + 'px'; }
    }
    var over = r.bottom - (innerHeight - 4);
    if (over > 0) m.style.top = (-5 - Math.max(0, Math.min(over, r.top - 4)) / z) + 'px';
  }
  if (focus) mbFocus(m, 0);
}

// Fill a menu as it opens: the project list, what Edit can do here, the View ticks, the °C / °F mark.
function mbFill(id) {
  if (id === 'projMenu' && typeof projMenuFill === 'function') projMenuFill();   // the server's project list (app-sync.js)
  if (id === 'editMenu') mbRender($(id), mbEditItems());
  if (id === 'viewMbMenu') mbRender($(id), mbViewItems().items);
  if (id === 'settingsMenu' && typeof watch !== 'undefined') Array.prototype.forEach.call(document.querySelectorAll('#mbUnit [data-wtu]'), function (b) {
    var on = b.dataset.wtu === watch.set.unit; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  });
}

// items: { label, key, title, disabled, act, checked (true / false = a tick item), radio, keep (the menu stays open and is
// drawn again: sizes to compare), sub: [items] | 'live' | 'uisize' | 'textsize' (a part of mbViewItems, filled as it opens) } / { sep }
function mbRender(box, items) {
  box.innerHTML = '';
  var ticks = items.some(function (it) { return it.checked != null; });
  items.forEach(function (it) {
    if (it.sep) { box.appendChild(document.createElement('hr')); return; }
    var b = document.createElement('button'); b.type = 'button';
    b.setAttribute('role', it.checked == null ? 'menuitem' : it.radio ? 'menuitemradio' : 'menuitemcheckbox');
    if (it.checked != null) b.setAttribute('aria-checked', String(!!it.checked));
    b.innerHTML = (ticks ? '<span class="mb-tick" aria-hidden="true">' + (it.checked ? (it.radio ? '●' : '✓') : '') + '</span>' : '') + esc(it.label) +
      (it.sub ? '<span class="menu-k">›</span>' : it.key ? '<span class="menu-k">' + esc(keysText(it.key)) + '</span>' : '');
    if (it.title) b.title = it.title;
    if (it.disabled) { b.setAttribute('aria-disabled', 'true'); b.classList.add('off'); }
    if (it.sub) {
      var sub = document.createElement('div'); sub.className = 'mb-sub';
      b.className = 'mb-subbtn'; b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false');
      var m = document.createElement('div'); m.className = 'dropmenu mb-menu mb-subm'; m.setAttribute('role', 'menu'); m.hidden = true;
      if (typeof it.sub === 'string') m.dataset.items = it.sub; else mbRender(m, it.sub);
      sub.appendChild(b); sub.appendChild(m); box.appendChild(sub); return;
    }
    if (it.keep) b.dataset.keep = '1';
    b.onclick = function (e) {
      if (it.disabled) { e.stopPropagation(); return; }
      var i = mbItems(box).indexOf(b), had = document.activeElement === b;
      it.act();
      if (it.keep && box.dataset.items) { mbSubOpen(box.parentNode); if (had) mbFocus(box, i); }   // drawn again, placed again (new size)
    };
    box.appendChild(b);
  });
}

// Edit: the Layout's own commands (the same as Arrange ▾, the right-click menu and the keys); greyed where they can't act.
function mbEditItems() {
  var lay = ui.tab === 'layout', am = {}, why = lay ? '' : 'On the Layout tab';
  if (lay && typeof arrangeMenuItems === 'function') arrangeMenuItems().forEach(function (it) { if (it.label) am[it.label] = it; });
  var s = lay ? screenById(ui.sel) : null, lock = am.Lock || am.Unlock;
  var cmd = function (label, key, it, title) {
    return { label: label, key: key, disabled: !it || !!it.disabled, title: it ? title : why || title, act: function () { it.act(); } };
  };
  return [
    { label: 'Undo', key: 'Ctrl+Z', disabled: !ui.undo.length, act: undo },
    { label: 'Redo', key: 'Ctrl+Y', disabled: !ui.redo.length, act: redo },
    { sep: true },
    cmd('Copy', 'Ctrl+C', am.Copy, 'Copy the selected cabinets'),
    cmd('Paste', 'Ctrl+V', am.Paste, 'Paste them onto free ports'),
    { label: 'Duplicate', disabled: !s, title: s ? 'A copy of these cabinets, on free ports' : why || 'Select cabinets first', act: function () { duplicateSection(s); } },
    { label: 'Delete', key: 'Del', disabled: !s, title: s ? 'Delete these cabinets (Ctrl+Z brings them back)' : why || 'Select cabinets first', act: function () { deleteSection(s); } },
    { label: 'Select All', key: 'Ctrl+A', disabled: !lay, title: why || 'Every cabinet on this screen', act: arrangeSelectAll },
    { sep: true },
    cmd('Group', 'Ctrl+G', am.Group, 'One name; they select and move as one'),
    cmd('Ungroup', 'Ctrl+Shift+G', am.Ungroup),
    cmd(lock ? lock.label : 'Lock', '', lock, 'Locked cabinets can’t be moved, aligned or distributed')
  ];
}
// View: the Layout canvas's toggles (the toolbar View ▾ checkboxes, ticked through their own handlers), Live, zoom.
function mbViewItems() {
  var lay = ui.tab === 'layout', why = lay ? '' : 'On the Layout tab', lv = $('liveView') ? $('liveView').value : 'off', uz = uiZoom();
  var chk = function (id, label) {
    var c = $(id);
    return { label: label, checked: !!(c && c.checked), title: c && c.parentNode.title, act: function () { c.checked = !c.checked; c.dispatchEvent(new Event('change')); } };
  };
  var live = function (v, label) {
    return { label: label, radio: true, checked: lv === v, act: function () {
      if (v !== 'off') return viewLive(v);   // shows the Layout tab (app-forms.js)
      var s = $('liveView'); if (s.value !== 'off') { s.value = 'off'; s.dispatchEvent(new Event('change')); }
    } };
  };
  var z = function (label, key, fn, title) { return { label: label, key: key, disabled: !lay, title: why || title, act: fn }; };
  return {
    items: [chk('showWires', 'Wires'), chk('showLabels', 'Labels'), chk('showCoords', 'Coordinates'), chk('magnet', 'Magnet'), { sep: true },
      chk('showGrid', 'Grid'), chk('snapGrid', 'Snap to Grid'), chk('showRulers', 'Rulers'), chk('showNav', 'Navigator'), { sep: true },
      { label: 'Content', sub: 'content', title: 'A picture under the cabinets (only in Open Nova, never sent): gradient, colour bars, alignment grid or your own' },
      { label: 'Live', sub: 'live', title: 'Colour the cabinets by what the linked processors report right now' },
      { sep: true },
      z('Fit', '', function () { $('btnZoomFit').click(); }, 'Fit the screen in the view'),
      z('Zoom In', '', function () { $('btnZoomIn').click(); }), z('Zoom Out', '', function () { $('btnZoomOut').click(); }),
      z('Zoom 1:1', 'Ctrl+0', zoomOneToOne, 'One canvas pixel = one screen pixel'), z('Zoom to Selection', 'Ctrl+D', zoomToSelection),
      { sep: true },
      { label: 'Look', sub: 'look', title: 'Pro (the default) or Classic, the look before October 2026 (this browser only; the page reloads)' },
      { label: 'Interface Size', sub: 'uisize', title: 'How big the whole app is drawn (this browser only)' },
      { label: 'Text Size', sub: 'textsize', title: 'Only the text, not the canvas (this browser only)' }],
    content: typeof pvMenuItems === 'function' ? pvMenuItems() : [],
    look: [['pro', 'Pro'], ['classic', 'Classic']].map(function (l) { return { label: l[1], radio: true, checked: (document.documentElement.dataset.look || 'classic') === l[0], act: function () { setLook(l[0]); } }; }),
    live: [live('off', 'Off'), live('status', 'Status'), live('temp', 'Temperature'), live('volt', 'Voltage'), live('ber', 'Bit errors')].concat(typeof heatSet === 'function' ? [{ sep: true },
      { label: 'Iron palette', radio: true, keep: true, checked: heat.pal === 'iron', title: 'Temperature colours: black → red → yellow → white (as thermal cameras)', act: function () { heatSet('pal', 'iron'); } },
      { label: 'Inferno palette', radio: true, keep: true, checked: heat.pal === 'inferno', title: 'Temperature colours, even steps (reads in grey and for colour-blind eyes)', act: function () { heatSet('pal', 'inferno'); } },
      { sep: true },
      { label: 'Auto scale', radio: true, keep: true, checked: heat.scale === 'auto', title: 'Temperature scale from the readings (at least 10 °C wide)', act: function () { heatSet('scale', 'auto'); } },
      { label: 'Fixed scale', radio: true, keep: true, checked: heat.scale === 'fixed', title: 'Temperature scale 20 °C … the error limit + 10', act: function () { heatSet('scale', 'fixed'); } }] : []),
    // Interface Size › and Text Size ›: they stay open while you click through the sizes (keep)
    uisize: [{ label: 'Bigger', key: 'Ctrl+Alt+=', keep: true, disabled: uz >= UI_SIZES[UI_SIZES.length - 1], act: function () { stepUiSize(1); } },
      { label: 'Smaller', key: 'Ctrl+Alt+−', keep: true, disabled: uz <= UI_SIZES[0], act: function () { stepUiSize(-1); } },
      { label: 'Actual Size', key: 'Ctrl+Alt+0', keep: true, act: function () { stepUiSize(0); } }, { sep: true }].concat(UI_SIZES.map(function (s) {
      return { label: Math.round(s * 100) + ' %', radio: true, checked: Math.abs(s - uz) < 0.001, keep: true, act: function () { setUiSize(s); } };
    })),
    textsize: TEXT_SIZES.map(function (t) {
      return { label: t[1], radio: true, checked: t[0] === uiText(), keep: true, act: function () { setTextSize(t[0]); } };
    })
  };
}
// Settings ▸ H Logins: one line per H series processor in the project (hlOpen, app-online.js).
function mbHLoginItems() {
  var hs = (P.devices || []).filter(function (d) { return olIsH(d) || procModel(d.model).family === 'H series'; });
  if (!hs.length) return [{ label: 'No H series processor', disabled: true, title: 'Add and link an H series processor (Device) first', act: function () {} }];
  return hs.map(function (d) {
    var ok = olIsH(d);
    return { label: deviceLabel(d) + '…', disabled: !ok, title: ok ? 'The login of ' + d.hw.host + '’s web page' : 'Link it on the network first (Device)', act: function () { hlOpen(d); } };
  });
}

// Keyboard: the items of one open menu panel that can be reached.
function mbItems(panel) {
  return Array.prototype.filter.call(panel.querySelectorAll(':scope > button, :scope > label, :scope > .mb-sub > .mb-subbtn, :scope > .proj-list button'), function (b) {
    return b.offsetParent && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
  });
}
function mbFocus(panel, i) { var l = mbItems(panel); if (l.length) l[(i + l.length) % l.length].focus(); }

// Help ▸ User Manual / About Open Nova (one small dialog).
function mbHelp(which) {
  var h = '';
  if (which === 'about') {
    $('helpTitle').textContent = 'About Open Nova';
    h = '<h3>Open Nova</h3><p>Open-source control for NovaStar LED processors: layout and wiring, Send / Save, screen settings, backup, ' +
      'presets, monitoring and diagnostics — an alternative to NovaLCT, VMP and Unico.</p>' +
      '<dl><dt>Version</dt><dd>' + esc(typeof alphaVersionText === 'function' ? alphaVersionText().replace(/^Open Nova /, '') : 'unknown') + '</dd><dt>Running at</dt><dd>' + esc(location.host || 'this file') + '</dd>' +
      '<dt>Runs on</dt><dd>Windows, Mac and Linux (Python 3, nothing to install)</dd></dl>' +
      '<h3>Guides</h3><dl><dt>docs/RUNNING.md</dt><dd>Starting Open Nova, the ports, where projects and logs are kept</dd>' +
      '<dt>docs/DIAGNOSTICS.md</dt><dd>Recordings of the processor traffic, Wireshark</dd></dl><p class="hint">In the Open Nova folder.</p>' +
      '<p>Something wrong? Help ▸ Report a Problem… makes one .zip to send us.</p>';
  } else {
    $('helpTitle').textContent = 'User Manual';
    h = '<h3>Tabs</h3><dl>' + TABS.filter(function (t) { return t.bar !== false && !t.hide; }).map(function (t) {
      var b = document.querySelector('.modtabs [data-tab="' + t.id + '"]'), d = b ? b.title.replace(/^[^:]*:\s*/, '') : '';
      d = d.charAt(0).toUpperCase() + d.slice(1);
      return '<dt>' + esc(t.label) + '</dt><dd>' + esc(keysText(d)) + '</dd>';
    }).join('') + '</dl>' +
      '<h3>Menus</h3><dl><dt>File</dt><dd>Projects (switch, new, rename, remove), import and export files, read the layout from the processors</dd>' +
      '<dt>Edit</dt><dd>Undo / redo and the Layout commands: copy, paste, delete, group, lock</dd>' +
      '<dt>View</dt><dd>' + esc(keysText('What the Layout canvas shows, Live colours, zoom; Interface Size (Ctrl+Alt+= / − / 0) and Text Size')) + '</dd>' +
      '<dt>Tools</dt><dd>Dashboard, Maintain, Cabinet Library, finding processors, test patterns, Diagnostics, pre-show check, offline mode</dd>' +
      '<dt>Settings</dt><dd>The log, theme, interface and text size, °C / °F, alarm limits, H series logins</dd></dl>' +
      '<h3>Always in view</h3><dl><dt>Override</dt><dd>' + esc(keysText('Pattern, Blackout, Freeze and Normal on every linked processor (Alt+B / Alt+F / Alt+N)')) + '</dd>' +
      '<dt>Send · Save</dt><dd>Send puts the layout on the processors; Save stores it in their flash (always separate)</dd></dl>' +
      '<p class="hint">Keyboard shortcuts: Help ▸ Keyboard Shortcuts (?). More in docs/RUNNING.md in the Open Nova folder.</p>';
  }
  $('helpBody').innerHTML = h; $('helpDlg').hidden = false;
  log('help', { open: which });
}

// The project's name in the middle of the bar (renderAll).
function renderMenuBar() {
  var b = $('mbProject'); if (!b || !P) return;
  var n = P.name || 'Untitled'; if (b.textContent !== n) b.textContent = n;
  b.title = n + ' — the project list is in File';
}

function bindMenuBar() {
  var bar = $('menuBar'); if (!bar) return;
  Array.prototype.forEach.call(bar.querySelectorAll('.menu-k[data-keys]'), function (k) { k.textContent = keysText(k.dataset.keys); });
  bar.addEventListener('click', function (e) {
    var top = e.target.closest('.mb-top');
    if (top) { if ($(top.dataset.mb).hidden) mbOpen(top.dataset.mb); else mbClose(mbNarrow()); return; }
    if (e.target.closest('#mbBurger')) { var on = !bar.classList.contains('mb-list'); mbClose(); if (on) { bar.classList.add('mb-list'); $('mbBurger').setAttribute('aria-expanded', 'true'); } return; }
    if (e.target.closest('#mbProject')) { if (mbOpenName() === 'projMenu') mbClose(); else mbOpen('projMenu'); return; }
    var sb = e.target.closest('.mb-subbtn');
    if (sb) { if (sb.parentNode.lastElementChild.hidden) mbSubOpen(sb.parentNode); else mbSubClose(sb.parentNode.parentNode); return; }
    var u = e.target.closest('#mbUnit [data-wtu]');
    if (u) { watchUnit(u.dataset.wtu); mbFill('settingsMenu'); return; }
    var b = e.target.closest('.mb-menu button');
    // Theme, the interface / text sizes keep the menu open (to compare); a disabled item does nothing
    if (!b || b.dataset.keep || b.closest('.menu-size') || b.id === 'btnTheme' || b.getAttribute('aria-disabled') === 'true') return;
    var item = Array.prototype.filter.call(b.childNodes, function (n) { return n.nodeType === 3; }).map(function (n) { return n.nodeValue; }).join('').trim();
    log('menu', { menu: b.closest('.mb-item').firstElementChild.textContent, item: item || b.textContent.trim() });
    mbClose();
  });
  bar.addEventListener('mouseover', function (e) {   // desktop menus: hover moves between open menus and opens submenus
    if (mbNarrow()) return;
    var top = e.target.closest('.mb-top'), open = mbOpenName();
    if (top) { if (open && open !== top.dataset.mb) mbOpen(top.dataset.mb); return; }
    var it = e.target.closest('.mb-menu > button, .mb-menu > label, .mb-sub');
    if (!it) return;
    if (it.classList.contains('mb-sub')) { if (it.lastElementChild.hidden) mbSubOpen(it); } else mbSubClose(it.parentNode);
  });
  window.addEventListener('pointerdown', function (e) {
    mb.alt = false;
    if ((mbOpenName() || bar.classList.contains('mb-list')) && !e.target.closest('#menuBar')) mbClose();
  }, true);
  window.addEventListener('blur', function () { mb.alt = false; mbClose(); });
  $('fileOpen').addEventListener('change', function () { mbClose(); });
  $('fileInto').addEventListener('change', function () { mbClose(); });
  $('mbExport').onclick = function () { $('btnExport').click(); };
  $('mbDiscover').onclick = function () { setTab('devices'); devOpenPicker(); };
  $('mbTestTool').onclick = function () { setTab('layout'); openTestMenu($('btnTest')); };
  $('mbPreshow').onclick = function () { setTab('dashboard'); $('dbPre').click(); };
  $('mbAlarms').onclick = function () { setTab('health'); setTimeout(function () { var p = $('wtPop'); if (p && p.hidden) $('wtBtn').click(); }, 0); };
  $('mbManual').onclick = function () { mbHelp('manual'); };
  $('mbAbout').onclick = function () { mbHelp('about'); };
  $('helpClose').onclick = function () { $('helpDlg').hidden = true; };

  // Keys, capture phase on window, ahead of the shell's and the canvas's (bindShell calls this first).
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Alt') { mb.alt = !e.ctrlKey && !e.metaKey && !e.shiftKey && !IS_MAC; return; }
    mb.alt = false;
    var open = mbOpenName(), list = bar.classList.contains('mb-list');
    if (e.key === 'F10' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      if (open || list) mbClose(); else mbOpen('projMenu', true);
      return;
    }
    if (!open) { if (list && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); mbClose(); } return; }
    if (e.ctrlKey || e.metaKey || e.altKey) { mbClose(); return; }   // Ctrl+Z, Alt+B … go on to their own handlers
    e.stopPropagation();   // a menu is open: its keys don't reach the canvas (Enter, arrows, B, Delete …)
    var a = document.activeElement, panel = a && a.closest('.mb-menu');
    if (!panel || panel.hidden) {   // nothing focused in a menu (opened with the mouse): Esc closes the innermost submenu first
      var subs = e.key === 'Escape' ? $(open).querySelectorAll('.mb-subm:not([hidden])') : [];
      panel = subs.length ? subs[subs.length - 1] : $(open);
    }
    var items = mbItems(panel), i = items.indexOf(a), sub = panel.classList.contains('mb-subm') ? panel.parentNode : null;
    var tops = mbTops(), ti = tops.indexOf($('menuBar').querySelector('.mb-top.on'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); mbFocus(panel, i < 0 ? (e.key === 'ArrowDown' ? 0 : -1) : i + (e.key === 'ArrowDown' ? 1 : -1)); }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (a && a.classList.contains('mb-subbtn') && panel.contains(a)) mbSubOpen(a.parentNode, true);
      else if (!mbNarrow()) mbOpen(tops[(ti + 1) % tops.length].dataset.mb, true);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (sub) { mbSubClose(sub.parentNode); sub.firstElementChild.focus(); }
      else if (!mbNarrow()) mbOpen(tops[(ti - 1 + tops.length) % tops.length].dataset.mb, true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (sub) { mbSubClose(sub.parentNode); sub.firstElementChild.focus(); }
      else { var t = tops[ti]; mbClose(); if (t) t.focus(); }
    } else if ((e.key === 'Enter' || e.key === ' ') && a && a.tagName === 'LABEL' && panel.contains(a)) { e.preventDefault(); a.click(); }
    else if (e.key === 'Tab') mbClose();
  }, true);
  window.addEventListener('keyup', function (e) {   // Alt pressed and released on its own: File (Windows / Linux, like a desktop app)
    if (e.key !== 'Alt' || !mb.alt) return;
    mb.alt = false; e.preventDefault();
    var dlg = Array.prototype.some.call(document.querySelectorAll('.logdlg'), function (x) { return !x.hidden; });
    if (mbOpenName()) mbClose(); else if (!dlg && !(typeof devPick !== 'undefined' && devPick.open)) mbOpen('projMenu', true);
  }, true);
  renderMenuBar();
}
