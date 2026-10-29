// app-dashboard.js - the project dashboard (design phase 13; VMP's project overview): click the project in the tree.
// The show at a glance: status rings for screens, processors and cabinets; per screen its size, processors and
// settings (wanted vs applied); the scenes to recall; Blackout / Freeze / Normal; the last pre-show check; what isn't
// saved on the processors yet. Read-only except the buttons, which call the same functions as their own tabs.
// Owns: dbRing, dbStatus, renderDashboard, bindDashboard.
// Depends on: app-core (P, ui, $, esc, fmt), app-geometry (allCells), app-hardware (hw), app-health (hlt), app-screen
// (scrDevices, scrColor, scrWanted, scrApplied, scrFmt, scrField), app-presets (sceneRecall), app-preshow (pre, preCheck),
// app-display (disp, dispToggle, dispNormal), app-save (hwUnsaved, hwSaveDevices), app-processors (deviceLabel,
// procModel), drv-core (DRV), app-shell (setTab), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// A donut: ok / warn / err counts (grey when there's nothing).
function dbRing(ok, warn, err) {
  var t = ok + warn + err, r = 26, c = 2 * Math.PI * r, h = '<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="' + r + '" fill="none" stroke="rgba(127,127,127,.25)" stroke-width="9"/>';
  var off = 0;
  [[ok, '#2fae6a'], [warn, '#e0a84a'], [err, '#e05252']].forEach(function (x) {
    if (!t || !x[0]) return;
    var len = c * x[0] / t;
    h += '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="' + x[1] + '" stroke-width="9" stroke-dasharray="' + len + ' ' + (c - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 32 32)"/>';
    off += len;
  });
  return h + '</svg>';
}
// Per processor: 'ok' | 'warn' | 'err' with a word.
function dbStatus(d) {
  if (!d.hw) return ['warn', 'not linked'];
  var w = hlt.watch[d.id] || {}, hw2 = hw.watch[d.id] || {};
  if (w.err || hw2.err) return ['err', 'not answering'];
  var h = hlt.by[d.id];
  if (h && h.sum && (h.sum.dark || h.sum.err)) return ['err', 'faults'];
  // the last pre-show check counts too (layout differs, placed ≠ detected, backup not verified …)
  var mine = pre.result ? pre.result.items.filter(function (x) { return x.dev === deviceLabel(d); }) : [];
  if (mine.some(function (x) { return x.level === 'err'; })) return ['err', mine.filter(function (x) { return x.level === 'err'; }).length + ' pre-show problem(s)'];
  if (h && h.sum && (h.sum.backup || h.sum.warn)) return ['warn', 'warnings'];
  if (mine.some(function (x) { return x.level === 'warn'; })) return ['warn', 'pre-show warning(s)'];
  if (DRV.caps(d).simulated) return [typeof olMode === 'function' && olMode() === 'offline' ? 'ok' : 'warn', 'simulated'];   // offline: simulated is the normal case
  return ['ok', h ? 'healthy' : 'linked'];
}
function renderDashboard() {
  var box = $('dbBody'); if (!box || ui.tab !== 'dashboard') return;
  $('dbTitle').textContent = P.name || 'Project';
  var cellsBy = allCells(), st = P.devices.map(dbStatus);
  var cnt = function (a, k) { return a.filter(function (x) { return x[0] === k; }).length; };
  // screens: the worst state of the processors driving them
  var scr = P.lct.map(function (lc) {
    var ds = scrDevices(lc).map(function (e) { return dbStatus(e.d)[0]; });
    return [ds.indexOf('err') >= 0 ? 'err' : ds.indexOf('warn') >= 0 || !ds.length ? 'warn' : 'ok'];
  });
  var cab = { ok: 0, warn: 0, err: 0 };
  P.devices.forEach(function (d) { var h = hlt.by[d.id]; if (!h || !h.sum) return; cab.err += h.sum.dark + h.sum.err; cab.warn += h.sum.backup + h.sum.warn; cab.ok += Math.max(0, h.sum.total - h.sum.dark - h.sum.err - h.sum.backup - h.sum.warn); });
  var placed = 0; P.screens.forEach(function (s) { placed += (cellsBy[s.id] || []).filter(function (c) { return !c.hole; }).length; });
  var ring = function (label, ok, warn, err, sub) { return '<div class="db-ring">' + dbRing(ok, warn, err) + '<div><b>' + (ok + warn + err) + '</b><span>' + label + (sub ? ' · ' + sub : '') + '</span><br><span>' +
    [[ok, 'normal'], [warn, 'warning'], [err, 'error']].filter(function (x) { return x[0]; }).map(function (x) { return x[0] + ' ' + x[1]; }).join(' · ') + '</span></div></div>'; };
  var h = '<div class="db-rings">' + ring('screens', cnt(scr, 'ok'), cnt(scr, 'warn'), cnt(scr, 'err')) + ring('processors', cnt(st, 'ok'), cnt(st, 'warn'), cnt(st, 'err')) +
    (cab.ok + cab.warn + cab.err ? ring('cabinets live', cab.ok, cab.warn, cab.err, placed + ' placed') : '<div class="db-ring">' + dbRing(0, 0, 0) + '<div><b>' + placed + '</b><span>cabinets placed</span><br><span>' + (P.devices.some(function (d) { return d.hw; }) ? 'no live reading yet — open Monitor to start one' : 'live health shows once processors are linked') + '</span></div></div>') + '</div>';
  h += '<div class="db-grid">';
  // show controls + scenes
  h += '<div class="db-card"><h3>Show<span class="grow"></span><span class="hint">' + (disp.mode !== 'normal' ? esc(disp.mode) + ' on' : disp.pattern ? 'test pattern on' : 'normal') + '</span></h3>' +
    '<div class="row"><button data-db="blackout"' + (disp.mode === 'blackout' ? ' class="on"' : '') + '>Blackout</button><button data-db="freeze"' + (disp.mode === 'freeze' ? ' class="on"' : '') + '>Freeze</button><button data-db="normal">Normal</button></div>' +
    '<h3 style="margin-top:10px">Scenes</h3><div class="db-scenes">' + ((P.scenes || []).map(function (sc) { return '<button data-db="scene" data-id="' + sc.id + '" title="Recall (asks first)">' + esc(sc.name) + '</button>'; }).join('') || '<span class="hint">None yet (Preset tab).</span>') + '</div></div>';
  // per screen
  P.lct.forEach(function (lc) {
    var devs = scrDevices(lc), want = scrWanted(lc), val = scrColor(lc), cells = [];
    P.screens.forEach(function (s) { if (s.screenId === lc.id) cells = cells.concat((cellsBy[s.id] || []).filter(function (c) { return !c.hole; })); });
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    cells.forEach(function (c) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); });
    var applied = function (k) { return devs.length && devs.every(function (e) { return !e.d.hw || !scrSupports(e.d, scrField(k)) || scrApplied(e.d, lc)[k] === want[k]; }); };   // processors that can't take it don't count
    var kv = ['brightness', 'gamma', 'colorTemp', 'gamut'].map(function (k) {
      var f = scrField(k);
      return '<dt>' + esc(f.label) + '</dt><dd>' + esc(scrFmt(f, val[k])) + (k in want ? (applied(k) ? '' : ' <span class="hint">● not applied</span>') : ' <span class="hint" title="Not set in Open Nova: the processor’s own value">○</span>') + '</dd>';
    }).join('');
    var th = typeof scrThumbSvg === 'function' && scrThumbSvg(lc, cellsBy, 'db-thumb pro-only');   // the wall's picture (pro look only)
    h += '<div class="db-card"><h3>' + esc(lc.name) + '<span class="grow"></span><button class="mini" data-db="screen" data-id="' + lc.id + '">Settings</button><button class="mini" data-db="layout" data-id="' + lc.id + '">Layout</button></h3>' +
      (th ? th.svg : '') + '<dl class="db-kv"><dt>Size</dt><dd>' + (cells.length ? fmt(x1 - x0) + ' × ' + fmt(y1 - y0) + ' px · ' + cells.length + ' cabinets' : 'no cabinets') + '</dd>' +
      '<dt>Processors</dt><dd>' + (devs.length ? devs.map(function (e) { var s = dbStatus(e.d); return esc(deviceLabel(e.d)) + ' <span class="rd-msg ' + (s[0] === 'ok' ? 'ok' : s[0]) + '">' + esc(s[1]) + '</span>'; }).join('<br>') : '—') + '</dd>' + kv + '</dl></div>';
  });
  // pre-show + unsaved
  var r = pre.result, un = hwUnsaved();
  h += '<div class="db-card"><h3>Pre-show check<span class="grow"></span><span class="hint">' + (r ? new Date(r.at).toLocaleTimeString() : 'not run') + '</span></h3>' +
    (r ? '<p>' + r.items.filter(function (x) { return x.level === 'err'; }).length + ' problem(s), ' + r.items.filter(function (x) { return x.level === 'warn'; }).length + ' warning(s)</p>' +
      r.items.filter(function (x) { return x.level !== 'ok'; }).slice(0, 4).map(function (x) { return '<p class="rd-msg ' + x.level + '">' + esc(x.dev + ' · ' + x.text) + '</p>'; }).join('') : '') +
    '<h3 style="margin-top:10px">Not saved on the processors<span class="grow"></span>' + (un.length ? '<button class="mini" data-db="save">Save…</button>' : '') + '</h3>' +
    (un.length ? un.map(function (d) { return '<p>' + esc(deviceLabel(d)) + ' <span class="hint">' + esc(hw.unsaved[d.id].why || '') + '</span></p>'; }).join('') : '<p class="hint">Everything sent is saved.</p>') + '</div>';
  box.innerHTML = h + '</div>';
}
function bindDashboard() {
  var box = $('dbBody'); if (!box) return;
  $('dbPre').onclick = function () { preCheck().then(function () { renderDashboard(); }); renderDashboard(); };
  box.onclick = function (e) {
    var b = e.target.closest('[data-db]'); if (!b) return;
    var a = b.dataset.db, id = b.dataset.id;
    if (a === 'blackout' || a === 'freeze') return Promise.resolve(dispToggle(a)).then(renderDashboard);
    if (a === 'normal') return Promise.resolve(dispNormal()).then(renderDashboard);
    if (a === 'scene') return sceneRecall(id);
    if (a === 'save') return hwSaveDevices(hwUnsaved());
    if (a === 'screen' || a === 'layout') { if (id !== ui.viewScreen) showScreen(id); return setTab(a); }
  };
}
