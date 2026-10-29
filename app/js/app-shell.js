// app-shell.js - the Open Nova shell: the workflow tabs across the top, the same as Unico / VMP (Device, Layout,
// Correction, Screen Settings, Backup, Preset, Monitor, Schedule; Source stays hidden until phase 14 builds it; the project
// dashboard opens from the tree's project row and Tools, and is where the app starts when a project opens, as in VMP);
// Alt+1…9 switch tabs; Ctrl+E = Export; the "?" shortcut sheet (the menu bar above the tabs is app-menubar.js, bound from
// here first so its keys come before these); and the key guard that
// keeps the canvas shortcuts (Delete, Tab, arrows, B, Q …) from acting on the hidden Layout while
// another tab is shown (undo / redo still work everywhere).
// Tabs not built yet show a wireframe of what is coming (docs/OPEN_NOVA_DESIGN.md, phase noted).
// Owns: TAB_KEY, TABS, TREE_TABS, tabDef, setTab, setTreeView, mountTree, fitHeader, bindShell, shortcutSheet,
// SHORTCUTS; ui.tab, ui.treeView (shared tree: 'screens' | 'procs').
// Depends on: app-core (P, ui, $, esc, log, IS_MAC), app-render (renderAll), app-menubar (bindMenuBar, mbClose), app-pipeline (proLook,
// fitPipe: the pro look's header), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// ------------------------------------------------------------------ tab registry
var TAB_KEY = 'opennova.tab';
// id = the <main> suffix (mod<Id>) and the data-tab value. built: false → wireframe placeholder.
var TABS = [   // the tab bar, in Unico / VMP order (user: keep the tabs consistent with them); bar:false = opened elsewhere
  { id: 'devices', label: 'Device', main: 'modDevices', built: true },
  { id: 'layout', label: 'Layout', main: 'modLayout', built: true },
  { id: 'correction', label: 'Correction', main: 'modCorrection', built: true },
  { id: 'screen', label: 'Screen Settings', main: 'modScreen', built: true },
  { id: 'source', label: 'Source', main: 'modSource', built: false, phase: 14, hide: true },   // hidden until phase 14 (UI cleanup item 10)
  { id: 'backup', label: 'Backup', main: 'modBackup', built: true },
  { id: 'presets', label: 'Preset', main: 'modPresets', built: true },
  { id: 'health', label: 'Monitor', main: 'modHealth', built: true },
  { id: 'schedule', label: 'Schedule', main: 'modSchedule', built: true },
  { id: 'dashboard', label: 'Dashboard', main: 'modDashboard', built: true, bar: false },   // click the project in the tree
  { id: 'maintain', label: 'Maintain', main: 'modMaintain', built: true, bar: false },     // Tools ▸ Maintain (menu bar)
  { id: 'library', label: 'Cabinet library', main: 'modLibrary', built: true, bar: false },  // Tools ▸ Cabinet library
  { id: 'diag', label: 'Diagnostics', main: 'modDiag', built: true, bar: false }              // Tools ▸ Diagnostics
];
function tabDef(id) {
  for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i];
  return null;
}

// ------------------------------------------------------------------ shared project tree
// One left column (#navTree, Unico / VMP style) shared by these tabs: it is moved into the tab
// being shown. Value = the tree view the tab opens with (null = keep the current one).
var TREE_TABS = { layout: 'screens', devices: 'procs', health: null, correction: 'screens', screen: 'screens', backup: 'procs', presets: 'screens', dashboard: 'screens' };
function setTreeView(v) {
  ui.treeView = v === 'procs' ? 'procs' : 'screens';
  $('treeScreens').hidden = ui.treeView !== 'screens';
  $('treeProcs').hidden = ui.treeView !== 'procs';
  Array.prototype.forEach.call(document.querySelectorAll('#treeSeg [data-tv]'), function (b) { b.classList.toggle('on', b.dataset.tv === ui.treeView); });
}
function mountTree(t) {
  var nav = $('navTree'), m = $(tabDef(t).main);
  if (!nav || !m || !(t in TREE_TABS)) return;
  if (nav.parentNode !== m) m.insertBefore(nav, m.firstElementChild);
  if (TREE_TABS[t]) setTreeView(TREE_TABS[t]);
}

// Show one tab. The canvas can only be measured while it is shown, so everything is redrawn.
function setTab(t) {
  if (!tabDef(t) || tabDef(t).hide) t = 'layout';
  var was = ui.tab;
  ui.tab = t;
  // a menu or popover left open (e.g. after Alt+1…9) must not float over the next tab
  if (typeof closeMenu === 'function') closeMenu();
  if (typeof mbClose === 'function') mbClose();   // the menu bar (app-menubar.js)
  document.querySelectorAll('.dropmenu, .wt-pop').forEach(function (m) { m.hidden = true; });
  try { localStorage.setItem(TAB_KEY, t); } catch (e) { /* storage unavailable */ }
  mountTree(t);
  TABS.forEach(function (d) { var m = $(d.main); if (m) m.hidden = d.id !== t; });
  Array.prototype.forEach.call(document.querySelectorAll('.modtabs [data-tab]'), function (b) {
    var on = b.dataset.tab === t;
    b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on));
  });
  if (was && was !== t) log('module_tab', { tab: tabDef(t).label });
  renderAll();
}

// ------------------------------------------------------------------ shortcut sheet
var SHORTCUTS = [
  ['Tabs', [['Alt+1 … Alt+8', 'Device, Layout, Correction, Screen Settings, Backup, Preset, Monitor, Schedule'], ['?', 'This sheet (also Help ▸ Keyboard Shortcuts)'], ['F10 / Alt', 'The menu bar (File); arrows walk the menus, Esc closes'], ['Ctrl+E', 'Export (NovaLCT .scr)']]],
  ['Show', [['Alt+B', 'Blackout every linked processor (again = picture back)'], ['Alt+F', 'Freeze (again = unfreeze)'], ['Alt+N', 'Normal: picture back, test patterns and freeze off']]],
  ['Everywhere', [['Ctrl+Z / Ctrl+Y', 'Undo / redo (Ctrl+Shift+Z also redoes)'], ['Esc', 'Close a menu, leave a tool, clear the selection'],
    ['Ctrl+Alt+= / Ctrl+Alt+− / Ctrl+Alt+0', 'Interface size: bigger / smaller / 100 % (View ▸ Interface Size; text only: View ▸ Text Size)']]],
  ['Layout canvas', [['Q', 'Quick add: drop a cabinet, drag its handles to grow a wall (Enter OK, Esc cancel, arrows ± a column / row)'],
    ['B', 'Set blank: blanks the selected cabinets, or turns the Set blank tool on / off'],
    ['Alt+click', 'Mark a position as blank (no cabinet); again puts the cabinet back'],
    ['Tab / Shift+Tab', 'Next / previous port'],
    ['Delete', 'Unwire the selected cabinets (self-drawn ones are deleted); otherwise delete the selected cabinets'],
    ['Space + drag', 'Pan'], ['Alt + drag', 'Move without the magnet or grid snap'], ['R', 'Self draw: rotate the cabinet being placed'],
    ['Ctrl+click cabinets', 'Add them to / remove them from the selection (outside Manual wiring); drag one to move them all'],
    ['Ctrl+A', 'Select all cabinets on this screen (then Arrange ▾: align, distribute, lock)'],
    ['Ctrl+G / Ctrl+Shift+G', 'Group the selected cabinets (one name; they select and move as one) / ungroup them'],
    ['Ctrl+C / Ctrl+V', 'Copy / paste the selected cabinets (the copies go onto free ports)'],
    ['Ctrl+0 / Ctrl+D', 'Zoom 1:1 / zoom to the selection']]],
  ['Layout: manual wiring', [['Click', 'Wire a cabinet onto the current port (cabinets already on a port are left alone)'],
    ['Arrows', 'Keep going on the current port'],
    ['Drag', 'Select cabinets; then pick a pattern to fill them (patterns overwrite)'],
    ['Ctrl+click / Ctrl+drag', 'Add to the selection'], ['Delete', 'Unwire the selection'],
    ['Shift+drag', 'Move the cabinets'], ['Drag a self-drawn cabinet', 'Moves its whole port (or the selection it’s in)']]]
];
function shortcutSheet(open) {
  var d = $('keysDlg'); if (!d) return;
  if (open === false || (open == null && !d.hidden)) { d.hidden = true; return; }
  $('keysBody').innerHTML = SHORTCUTS.map(function (g) {   // Mac key names as everywhere else (keysText, app-core.js)
    return '<h3>' + esc(g[0]) + '</h3><dl>' + g[1].map(function (k) { return '<dt>' + esc(keysText(k[0])) + '</dt><dd>' + esc(keysText(k[1])) + '</dd>'; }).join('') + '</dl>';
  }).join('');
  d.hidden = false;
  log('shortcut_sheet', {});
}

// ------------------------------------------------------------------ bindings
// The action buttons (Blackout … Export) sit beside the tab tiles when the window is wide enough, and on a row of their
// own when it isn't — the menu bar took 28 px, this gives them back (user, 2026-10-12). Measured, not a fixed width:
// the Interface size (zoom) and the number of tabs change what fits.
function fitHeader() {
  var h = document.querySelector('header.bar'); if (!h) return;
  if (typeof proLook === 'function' && proLook()) return fitPipe();   // the pro look's strip + tabs row (app-pipeline.js)
  var tabs = h.querySelector('.modtabs'), acts = h.querySelector('.bar-actions'), brand = h.querySelector('.brand');
  // what a box's visible children need (a grid cell may stretch the box itself, so its own width says nothing); the
  // action row's button groups are see-through boxes (display: contents), so their buttons count
  function need(el) {
    var cs = getComputedStyle(el), w = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight), n = 0;
    (function add(box) {
      Array.prototype.forEach.call(box.children, function (c) { if (c.offsetWidth) { w += c.offsetWidth; n++; } else if (getComputedStyle(c).display === 'contents') add(c); });
    })(el);
    return w + Math.max(0, n - 1) * (parseFloat(cs.columnGap) || 0);
  }
  h.classList.remove('tight', 'squeeze'); h.classList.add('one-row');
  var W = h.clientWidth, bw = brand.scrollWidth + 36;
  if (need(tabs) + 2 * Math.max(bw, need(acts)) <= W) return;   // tabs centred in the window
  h.classList.add('tight');   // narrower tiles, tabs between the name and the buttons
  if (bw + need(tabs) + need(acts) + 16 <= W) return;
  h.classList.remove('tight', 'one-row');   // the buttons get their own row
  // the tiles don't fit beside the name even so: the narrow-window tiles (scrolling). The width media queries can't see
  // the interface size (CSS zoom) or the text size, so a wide window at 150 % / large text gets them from here.
  if (bw + need(tabs) > W) h.classList.add('squeeze');
}
function bindShell() {
  bindMenuBar();   // first: its keys (F10, Alt, arrows in an open menu) come before the ones below
  window.addEventListener('resize', fitHeader); setTimeout(fitHeader, 0);
  Array.prototype.forEach.call(document.querySelectorAll('.modtabs [data-tab]'), function (b) {
    b.onclick = function () { setTab(b.dataset.tab); };
  });
  // A project opens on its dashboard, as in VMP (user, 2026-10-11); app-sync.js does the same when another project opens.
  ui.tab = 'dashboard';
  try { localStorage.setItem(TAB_KEY, ui.tab); } catch (e) { /* storage unavailable */ }
  Array.prototype.forEach.call(document.querySelectorAll('.modtabs [data-tab]'), function (b) { var d = tabDef(b.dataset.tab); if (d && d.hide) b.hidden = true; });
  setTreeView('screens');
  mountTree(ui.tab);
  TABS.forEach(function (d) { var m = $(d.main); if (m) m.hidden = d.id !== ui.tab; });
  Array.prototype.forEach.call(document.querySelectorAll('#treeSeg [data-tv]'), function (b) {
    b.onclick = function () { setTreeView(b.dataset.tv); log('tree_view', { view: ui.treeView }); renderAll(); };
  });
  Array.prototype.forEach.call(document.querySelectorAll('.modtabs [data-tab]'), function (b) {
    b.classList.toggle('on', b.dataset.tab === ui.tab); b.setAttribute('aria-selected', String(b.dataset.tab === ui.tab));
  });
  // placeholders: a button that jumps to the tab where the feature lives today
  Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (b) {
    b.onclick = function () { setTab(b.dataset.goto); };
  });

  // File ▸ the project list and its buttons (app-sync.js); the menu bar (app-menubar.js) opens and closes it
  $('projList').onclick = function (e) {
    var b = e.target.closest('[data-pid]'); if (b) return projOpen(b.dataset.pid);
    b = e.target.closest('[data-restore]'); if (b) return projRestore(b.dataset.restore);
    if (e.target.closest('[data-projback]')) { e.stopPropagation(); projMenuFill(); }   // keep the menu open
  };
  $('btnProjRemoved').onclick = function (e) { e.stopPropagation(); projMenuFill('removed'); };
  $('btnProjDup').onclick = projDuplicate;
  $('btnProjRename').onclick = projRename;
  $('btnProjRemove').onclick = projRemove;
  $('btnKeys').onclick = function () { shortcutSheet(); };
  $('keysClose').onclick = function () { shortcutSheet(false); };

  // Keys, capture phase on window (runs before every document listener):
  // - Alt+1…8 switch tabs, "?" opens the sheet, Esc closes the menu / sheet;
  // - on any tab but Layout the canvas shortcuts are stopped (undo / redo still go through).
  // A modal dialog (Compare, Send receiving-card file, …) owns the keyboard: nothing reaches the canvas, the tab shortcuts
  // or undo behind it; Esc closes it (the Logs window keeps its own handling, a running file send can't be closed).
  window.addEventListener('keydown', function (e) {
    var dlg = Array.prototype.filter.call(document.querySelectorAll('.logdlg'), function (x) { return !x.hidden && x.id !== 'logDlg'; })[0];
    if (!dlg) return;
    e.stopPropagation();
    if (e.key === 'Escape' && !(dlg.id === 'rcvDlg' && typeof rg !== 'undefined' && rg.busy === 'send')) { e.preventDefault(); dlg.hidden = true; }
  }, true);
  window.addEventListener('keydown', function (e) {
    var a = document.activeElement, typing = a && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
    var logOpen = $('logDlg') && !$('logDlg').hidden, scfgOpen = $('scfgDlg') && !$('scfgDlg').hidden;
    if (typeof uiSizeKey === 'function' && uiSizeKey(e)) return;   // Ctrl+Alt+= / − / 0: interface size, on every tab (app-forms.js)
    if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-9]$/.test(e.code)) {
      var barTabs = TABS.filter(function (t) { return t.bar !== false && !t.hide; }), bt = barTabs[+e.code.slice(5) - 1];
      if (bt) { e.preventDefault(); e.stopPropagation(); setTab(bt.id); }
      return;
    }
    if (e.key === 'Escape' && !$('keysDlg').hidden) { e.preventDefault(); e.stopPropagation(); shortcutSheet(false); return; }
    if (e.key === '?' && !typing && !logOpen && !scfgOpen) { e.preventDefault(); e.stopPropagation(); shortcutSheet(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyE' && !logOpen && !scfgOpen) { e.preventDefault(); e.stopPropagation(); log('shortcut', { key: 'Ctrl+E', action: 'export' }); $('btnExport').click(); return; }
    if (ui.tab === 'layout' || logOpen || scfgOpen) return;
    if ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)) return;
    if (typing) return;
    e.stopPropagation();
  }, true);
}
