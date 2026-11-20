// app-display.js - Display & Test (design phase 5, the field tool): what the wall shows right now, on every linked
// processor at once, through its driver (drv-*.js) — never part of Send, never saved.
//   - header Blackout / Freeze (toggle) and Normal; Alt+B / Alt+F / Alt+N; a red chip in the menu bar while anything is
//     active (one click, no confirm — user decision; Normal is always one click away); the tiles are live whenever a
//     processor is linked, worked out on every render (dispTiles), else greyed with the reason;
//   - Layout ▸ Test ▾ and right-click ▸ Test pattern: a pattern on the selected panels, else the selected sections, else
//     everything; Identify (a tool: click a panel, it lights green on the wall for 3 s); Mapping (cards draw their port
//     and chain number);
//   - targets come from the project: a panel's (processor, card on its link, port, cable position) from the export's
//     cable order (hwPortCells), so they address exactly what the layout placed.
// Owns: disp, DISP_IDENT_MS, dispTargets, dispLinked, dispRun, dispSet, dispPattern, dispNormal, dispToggle, dispIdentify,
// dispMapping, dispMenuItems, openTestMenu, DISP_TILES, dispTiles, renderDisplayBar, renderIdentify, bindDisplay.
// Depends on: app-core (P, ui, $, esc, log, toast), app-capacity (screenById), app-geometry (cellsOf, visibleScreens),
// app-processors (deviceOfCard, cardsOfDevice), app-hardware (hwPortCells), drv-core (DRV), app-context-menu (openMenu),
// app-render (renderAll, renderCanvas, el), app-alpha (alphaOwn), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var disp = { mode: 'normal', pattern: null, scope: '', mapping: false, tips: {} };   // tips: the tiles' own tooltips (index.html)
var DISP_IDENT_MS = 3000;

// Linked processors that can show things (a real link or a simulated one).
function dispLinked() { return ((typeof olShownDevices === 'function' ? olShownDevices() : P.devices) || []).filter(function (d) { return d.hw && DRV.caps(d).display; }); }   // online: the connected ones (app-online.js)

// {deviceId: targets|null} for the cells of `cells` (or null everywhere = the whole wall), and a scope text.
function dispTargets(cells) {
  var by = {}, n = 0, port = hwPortCells();
  if (!cells) { dispLinked().forEach(function (d) { by[d.id] = null; }); return { by: by, text: 'everything' }; }
  cells.forEach(function (c) {
    if (c.sender == null) return;
    var d = deviceOfCard(c.sender); if (!d || !d.hw) return;
    var list = port[c.sender + ':' + c.port] || [], idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].x === c.x && list[i].y === c.y) { idx = i; break; }
    if (idx < 0) return;
    (by[d.id] || (by[d.id] = [])).push({ card: cardsOfDevice(d).indexOf(c.sender), port: c.port, index: idx }); n++;
  });
  return { by: by, text: n + ' cabinet' + (n === 1 ? '' : 's') };
}
// The canvas selection as cells: selected panels, else the selected sections, else null (= everything).
function dispSelectionCells() {
  var s = screenById(ui.selScreen);
  if (s && ui.selKeys && ui.selKeys.size) return cellsOf(s).filter(function (c) { return ui.selKeys.has(c.k) && !c.hole; });
  var ids = new Set(ui.selSecs || []); if (ui.sel) ids.add(ui.sel);
  var secs = visibleScreens().filter(function (x) { return ids.has(x.id); });
  if (!secs.length) return null;
  return [].concat.apply([], secs.map(function (x) { return cellsOf(x).filter(function (c) { return !c.hole; }); }));
}

// Run one driver method on every processor in `t.by`; one toast with the outcome.
function dispRun(method, arg, t, label) {
  var ids = Object.keys(t.by), devs = (P.devices || []).filter(function (d) { return ids.indexOf(d.id) >= 0; });
  if (!devs.length) { toast(dispLinked().length ? 'None of the selected cabinets is on a linked processor' : 'Link a processor first (Processors ▸ Hardware ▸ Find, or Simulate)'); return Promise.resolve(false); }
  return Promise.all(devs.map(function (d) {
    return DRV.of(d)[method](d, arg, t.by[d.id]).then(function (r) { r.dev = d; return r; }, function (e) { hw.helper = false; return { ok: false, error: e.message, dev: d }; });
  })).then(function (rs) {
    var bad = rs.filter(function (r) { return !r.ok; });
    log('display', { action: label, scope: t.text, processors: rs.length, failed: bad.map(function (r) { return r.dev.name + ': ' + r.error; }) });
    toast(bad.length ? label + ' failed on ' + bad.map(function (r) { return r.dev.hw.name + ' (' + r.error + ')'; }).join(', ') : label + ' · ' + t.text + (rs.length > 1 ? ' on ' + rs.length + ' processors' : ''));
    return !bad.length;
  });
}
function dispSet(mode) {
  return dispRun('display', mode, dispTargets(null), mode === 'blackout' ? 'Blackout' : mode === 'freeze' ? 'Freeze' : 'Normal').then(function (ok) {
    // only what the processors confirmed: a failed Normal keeps the red banner (the wall may still be black / frozen)
    if (ok) { disp.mode = mode; if (mode === 'normal') { disp.pattern = null; disp.scope = ''; } }
    renderDisplayBar();
  });
}
function dispToggle(mode) { return dispSet(disp.mode === mode ? 'normal' : mode); }
function dispNormal() { return dispSet('normal'); }
function dispPattern(code, cells) {
  var t = dispTargets(cells === undefined ? dispSelectionCells() : cells), name = (DRV.PATTERNS.filter(function (p) { return p[0] === code; })[0] || [code, code])[1];
  if (code === 'normal') return dispRun('display', 'normal', t, 'Normal').then(function (ok) { if (ok) { disp.pattern = null; disp.scope = ''; } renderDisplayBar(); });
  return dispRun('pattern', code, t, 'Test pattern ' + name).then(function (ok) { if (ok) { disp.pattern = name; disp.scope = t.text; } renderDisplayBar(); });
}
// Identify one panel: it lights green on the wall (LCT's "Locate") for a moment, and pulses on the canvas.
function dispIdentify(s, cell) {
  var full = cellsOf(s).filter(function (c) { return c.k === cell.k; })[0];
  if (!full || full.sender == null) return toast('That cabinet isn’t wired to a port');
  // its 'done' step sets the panel back to normal (on NovaLCT the whole sending card): that would undo a blackout /
  // freeze / pattern behind the banner
  if (disp.mode !== 'normal' || disp.pattern) return toast('Identify is off while ' + (disp.pattern ? 'a test pattern' : disp.mode) + ' is on — press Normal first');
  var t = dispTargets([full]);
  ui.identify = { sid: s.id, k: cell.k, until: Date.now() + DISP_IDENT_MS }; renderCanvas(allCells());
  dispRun('pattern', 'locate', t, 'Identify ' + portLabel(full.sender, full.port) + ' #' + (full.connect + 1)).then(function () {
    setTimeout(function () {
      ui.identify = null; renderCanvas(allCells());
      dispRun('display', 'normal', t, 'Identify done');
    }, DISP_IDENT_MS);
  });
}
function dispMapping(on) {
  return dispRun('mapping', !!on, dispTargets(null), 'Mapping ' + (on ? 'on' : 'off')).then(function (ok) { if (ok) disp.mapping = !!on; renderDisplayBar(); });
}

// ------------------------------------------------------------------ menus
function dispMenuItems(cells) {
  var t = dispTargets(cells === undefined ? dispSelectionCells() : cells);
  var items = [{ header: 'Test pattern · ' + t.text }];
  DRV.PATTERNS.forEach(function (p) {
    items.push({ label: (p[2] ? '■ ' : '') + p[1], act: function () { dispPattern(p[0], cells); } });
  });
  items.push({ sep: true }, { label: 'Normal (end pattern, blackout and freeze)', key: 'Alt+N', act: dispNormal });
  return items;
}
function openTestMenu(btn) {
  var r = btn.getBoundingClientRect();
  var items = dispMenuItems().concat([{ sep: true },
    { label: ui.tool === 'identify' ? 'Stop identifying' : 'Identify: click a cabinet to light it on the wall', act: function () { ui.tool = ui.tool === 'identify' ? null : 'identify'; log('identify_tool', { on: ui.tool === 'identify' }); renderAll(); } },
    { label: disp.mapping ? 'Mapping off' : 'Mapping on (cards show their port and number)', act: function () { dispMapping(!disp.mapping); } }]);
  openMenu(r.left, r.bottom + 4, items);
}

// ------------------------------------------------------------------ the tiles, the state chip, the canvas pulse
// Blackout / Freeze / Normal / Pattern: live while any processor is linked (or simulated), else greyed with the reason.
// renderAll calls this too (the project arriving at start-up, every link change), so it is never a stale start-up state.
var DISP_TILES = ['btnBlackout', 'btnFreeze', 'btnNormalHdr', 'btnTestHdr'];
function dispTiles() {
  var none = !dispLinked().length;
  DISP_TILES.forEach(function (id) {
    var b = $(id); if (!b) return;
    if (!(id in disp.tips)) disp.tips[id] = b.dataset.roTitle || b.title;
    alphaOwn(b, none, none ? 'Link a processor first' : disp.tips[id]);   // the alpha's read-only greying keeps its own reason
  });
}
// The state chip in the menu bar (index.html #displayBar): one line, never pushes the workspace.
function renderDisplayBar() {
  var bar = $('displayBar'); if (!bar) return;
  var what = disp.mode === 'blackout' ? 'Blacked out' : disp.mode === 'freeze' ? 'Frozen' : '', tip = what ? 'The wall is ' + what.toLowerCase() : '';
  if (disp.pattern) { what = (what ? what + ' · ' : '') + 'Pattern ' + disp.pattern; tip = (tip ? tip + ' · ' : '') + 'Test pattern ' + disp.pattern + ' on ' + disp.scope; }
  if (disp.mapping) { what = (what ? what + ' · ' : '') + 'Mapping on'; tip = (tip ? tip + ' · ' : '') + 'Mapping is on'; }
  bar.hidden = !what; $('displayText').textContent = what; bar.title = tip ? tip + ' — Normal brings the picture back (Alt+N)' : '';
  $('btnBlackout').classList.toggle('on', disp.mode === 'blackout');
  $('btnFreeze').classList.toggle('on', disp.mode === 'freeze');
  dispTiles();
  if (typeof renderPipe === 'function') renderPipe();   // the Override tiles (app-pipeline.js)
}
function renderIdentify(svg, unit) {
  var id = ui.identify; if (!id || Date.now() > id.until) return;
  var s = screenById(id.sid); if (!s) return;
  var c = cellsOf(s).filter(function (x) { return x.k === id.k; })[0]; if (!c) return;
  el('rect', { class: 'ident-pulse', x: c.x, y: c.y, width: c.w, height: c.h, 'stroke-width': 4 * unit, 'pointer-events': 'none' }, svg);
}

function bindDisplay() {
  $('btnBlackout').onclick = function () { dispToggle('blackout'); };
  $('btnFreeze').onclick = function () { dispToggle('freeze'); };
  $('btnNormalHdr').onclick = dispNormal;
  $('btnNormalBar').onclick = function () { (disp.mapping ? dispMapping(false) : Promise.resolve()).then(dispNormal); };
  $('btnTest').onclick = function (e) { e.stopPropagation(); openTestMenu(this); };
  window.addEventListener('keydown', function (e) {   // VMP's shortcuts
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var k = e.key.toLowerCase();
    if (k === 'b') { e.preventDefault(); e.stopPropagation(); dispToggle('blackout'); }
    else if (k === 'f') { e.preventDefault(); e.stopPropagation(); dispToggle('freeze'); }
    else if (k === 'n') { e.preventDefault(); e.stopPropagation(); dispNormal(); }
  }, true);
  renderDisplayBar();
}
