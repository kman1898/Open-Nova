// app-presets.js - the Preset tab (design phase 11; Unico "Programming ▸ Preset", VMP "Preset").
//   - Scenes (project data, every processor family, LCT walls included): each scene keeps, per screen, the Screen
//     Settings values that were set (brightness, gamma, colour temperature, gamut — not bit depth or low latency, which
//     change capacity / latency and stay on Screen Settings). Recall = those values become the screens' wanted values
//     (undoable) and go out through Screen Settings' Apply: one confirmation listing every screen and processor, refusals
//     roll back, nothing is saved to flash.
//   - On the processors: presets that Unico / COEX processors store themselves (filled in once their calls are captured).
// Owns: SCENE_KEYS, scn, sceneCapture, sceneNew, sceneById, sceneRecall, sceneUpdate, sceneRename, sceneDelete, sceneSummary,
// renderPresets, bindPresets, dvp, dvpDevices, dvpLoad, dvpRun, dvpAct, renderDevPresets.
// Depends on: app-core (P, ui, $, uid, esc, toast, commit), app-log (log), app-screen (scrWanted, scrField, scrFmt,
// scrApplyScreens, SCR_FIELDS), app-render (renderAll), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var SCENE_KEYS = ['brightness', 'gamma', 'colorTemp', 'gamut'];
var scn = { last: null };   // last recalled scene id (this session)

// The current wanted values of every screen (only those set on Screen Settings): { lcId: { key: value } }.
function sceneCapture() {
  var out = {}, n = 0;
  P.lct.forEach(function (lc) {
    var w = scrWanted(lc), v = {};
    SCENE_KEYS.forEach(function (k) { if (k in w) { v[k] = w[k]; n++; } });
    if (Object.keys(v).length) out[lc.id] = v;
  });
  return n ? out : null;
}
function sceneNew() {
  var cap = sceneCapture();
  if (!cap) return toast('Set brightness, gamma, colour temperature or gamut on Screen Settings first — a scene keeps those');
  var name = prompt('Scene name:', 'Scene ' + ((P.scenes || []).length + 1)); if (!name || !name.trim()) return;
  P.scenes = P.scenes || [];
  P.scenes.push({ id: uid(), name: name.trim(), screens: cap });
  log('scene_new', { name: name.trim(), screens: Object.keys(cap).length }); commit(); renderAll();
}
function sceneById(id) { return (P.scenes || []).filter(function (s) { return s.id === id; })[0]; }
function sceneRecall(id) {
  var sc = sceneById(id); if (!sc) return;
  var lcs = P.lct.filter(function (lc) { return sc.screens[lc.id]; });
  if (!lcs.length) return toast('This scene’s screens are gone from the project');
  if (scr.busy) return toast('Wait — Screen Settings are still being applied');
  var before = lcs.map(function (lc) { return JSON.stringify(lc.color || null); });
  lcs.forEach(function (lc) { lc.color = lc.color || {}; var v = sc.screens[lc.id]; Object.keys(v).forEach(function (k) { lc.color[k] = v[k]; }); });
  // the confirmation lists what changes; Cancel puts the project back as it was (nothing committed yet)
  return scrApplyScreens(lcs, 'scene “' + sc.name + '”').then(function (ok) {
    if (ok === null) { lcs.forEach(function (lc, i) { var b = JSON.parse(before[i]); if (b) lc.color = b; else delete lc.color; }); renderAll(); return ok; }
    log('scene_recall', { name: sc.name, applied: !!ok }); commit(); renderAll();
    if (ok) { scn.last = sc.id; renderPresets(); }
    return ok;
  });
}
function sceneUpdate(id) {
  var sc = sceneById(id), cap = sceneCapture(); if (!sc) return;
  if (!cap) return toast('Nothing set on Screen Settings to keep');
  if (!confirm('Replace “' + sc.name + '” with the current Screen Settings?')) return;
  sc.screens = cap; log('scene_update', { name: sc.name }); commit(); renderAll();
}
function sceneRename(id) {
  var sc = sceneById(id); if (!sc) return;
  var n = prompt('Scene name:', sc.name); if (!n || !n.trim()) return;
  log('scene_rename', { from: sc.name, to: n.trim() }); sc.name = n.trim(); commit(); renderAll();
}
function sceneDelete(id) {
  var sc = sceneById(id); if (!sc) return;
  if (!confirm('Delete the scene “' + sc.name + '”? (Ctrl+Z brings it back)')) return;
  P.scenes = P.scenes.filter(function (s) { return s.id !== id; }); log('scene_delete', { name: sc.name }); commit(); renderAll();
}
function sceneSummary(sc) {
  var rows = P.lct.filter(function (lc) { return sc.screens[lc.id]; }).map(function (lc) {
    var v = sc.screens[lc.id];
    return '<tr><td>' + esc(lc.name) + '</td>' + SCENE_KEYS.map(function (k) { return '<td>' + (k in v ? esc(scrFmt(scrField(k), v[k])) : '<span class="hint">—</span>') + '</td>'; }).join('') + '</tr>';
  });
  var gone = Object.keys(sc.screens).filter(function (id) { return !lctById(id); }).length;
  return '<table><tr><th>Screen</th>' + SCENE_KEYS.map(function (k) { return '<th>' + esc(scrField(k).label) + '</th>'; }).join('') + '</tr>' + rows.join('') + '</table>' +
    (gone ? '<p class="hint">' + gone + ' screen(s) of this scene are no longer in the project.</p>' : '');
}
function renderPresets() {
  var box = $('psBody'); if (!box || ui.tab !== 'presets') return;
  var list = P.scenes || [];
  box.innerHTML = list.length ? list.map(function (sc) {
    return '<div class="ps-scene' + (scn.last === sc.id ? ' on' : '') + '"><h3>' + esc(sc.name) + (scn.last === sc.id ? ' <span class="hint">last recalled</span>' : '') + '<span class="grow"></span>' +
      '<button class="primary" data-ps="recall" data-id="' + sc.id + '" title="Apply this scene to every processor (asks first)">Recall…</button>' +
      '<button class="mini" data-ps="update" data-id="' + sc.id + '" title="Replace with the current Screen Settings">Update</button>' +
      '<button class="mini" data-ps="rename" data-id="' + sc.id + '">Rename</button>' +
      '<button class="mini" data-ps="delete" data-id="' + sc.id + '" title="Delete (undoable)">×</button></h3>' + sceneSummary(sc) + '</div>';
  }).join('') : '<p class="hint">No scenes yet — set the look on Screen Settings, then <b>New scene</b>.' +
    itip('A scene keeps brightness, gamma, colour temperature and gamut per screen. Scenes work on every processor, NovaLCT ones included (which have no presets of their own).') + '</p>';
  renderDevPresets();
}

// ------------------------------------------------------------------ presets stored on the processors (Unico, COEX)
var dvp = {};   // dvp[devId] = { busy, presets: [{id, slot, name, flags, active}], error }
function dvpDevices() { return (typeof olShownDevices === 'function' ? olShownDevices() : P.devices).filter(function (d) { return d.hw && DRV.caps(d).presets; }); }   // online: the connected ones (app-online.js)   // a simulated one keeps its presets in memory (drv-offline.js)
function dvpLoad(d) {
  var e = dvp[d.id] = dvp[d.id] || {}; e.busy = true; renderDevPresets();
  return DRV.of(d).presets(d).then(function (r) { return r; }, function (x) { return { ok: false, error: 'helper: ' + x.message }; }).then(function (r) {
    e.busy = false; e.error = r.ok ? '' : r.error; if (r.ok) e.presets = r.presets; renderDevPresets();
  });
}
function dvpRun(d, what, call) {
  var e = dvp[d.id] = dvp[d.id] || {}; e.busy = true; renderDevPresets();
  return call.then(function (r) { return r; }, function (x) { return { ok: false, error: 'helper: ' + x.message }; }).then(function (r) {
    log('device_preset', { processor: deviceLabel(d), what: what, ok: !!r.ok, error: r.error });
    toast(r.ok ? deviceLabel(d) + ': ' + what : '⚠ ' + deviceLabel(d) + ': ' + what + ' failed — ' + r.error);
    return dvpLoad(d);
  });
}
function dvpAct(d, act, slot) {
  var x = DRV.of(d), c = DRV.caps(d).presets, e = dvp[d.id] || {}, p = (e.presets || []).filter(function (q) { return String(q.slot) === String(slot); })[0];
  if (act === 'refresh') return dvpLoad(d);
  if (act === 'save') {
    var name = prompt('Save the processor’s current ' + c.what + ' as a preset on ' + deviceLabel(d) + '.\n\nName:', 'Preset ' + ((e.presets || []).length + 1));
    if (!name || !name.trim()) return;
    return dvpRun(d, 'saved “' + name.trim() + '”', x.presetSave(d, name.trim(), c.flags ? { source: true, processing: true, output: true, layout: false } : undefined));
  }
  if (!p) return;
  if (act === 'recall') {
    var lay = p.flags && p.flags.screenData;
    if (!confirm('Recall “' + p.name + '” on ' + deviceLabel(d) + '?\n\nThis changes the picture now.' + (lay ? '\n\n⚠ This preset includes the cabinet LAYOUT (saved in VMP with Layout ticked): recalling it replaces the processor’s layout, which then no longer matches the project. Send the layout again (or Compare) afterwards.' : ''))) return;
    return dvpRun(d, 'recalled “' + p.name + '”', x.presetApply(d, p)).then(function () { if (lay && hw.applied) liveSet(d, LIVE_STALE); });
  }
  if (act === 'rename') { var n = prompt('Preset name:', p.name); if (!n || !n.trim()) return; return dvpRun(d, 'renamed to “' + n.trim() + '”', x.presetRename(d, p, n.trim())); }
  if (act === 'delete') { if (!confirm('Delete the preset “' + p.name + '” (slot ' + p.slot + ') from ' + deviceLabel(d) + '? This can’t be undone.')) return; return dvpRun(d, 'deleted “' + p.name + '”', x.presetDelete(d, p)); }
}
function renderDevPresets() {
  var dv = $('psDev'); if (!dv || ui.tab !== 'presets') return;
  var devs = dvpDevices(), pn = dv.closest('.ps-panel');
  // the panel only shows once a processor that stores presets itself (VX Pro, MX) is linked (UI cleanup item 10)
  if (pn) pn.hidden = !devs.length; $('modPresets').classList.toggle('ps-nodev', !devs.length);
  if (!devs.length) { dv.innerHTML = ''; return; }
  dv.innerHTML = devs.map(function (d) {
    var e = dvp[d.id], c = DRV.caps(d).presets;
    if (!e) { setTimeout(function () { dvpLoad(d); }, 0); e = { busy: true }; }
    var h = '<div class="ps-scene"><h3>' + esc(deviceLabel(d)) + (DRV.caps(d).simulated ? ' <span class="hint">simulated</span>' : '') + '<span class="grow"></span><button class="mini" data-dp="refresh" data-dev="' + d.id + '"' + (e.busy ? ' disabled' : '') + '>' + (e.busy ? '…' : 'Refresh') + '</button>' +
      '<button class="mini" data-dp="save" data-dev="' + d.id + '"' + (e.busy ? ' disabled' : '') + ' title="Save the processor’s current ' + esc(c.what) + ' in the next free slot">Save new…</button>' +
      itip('Holds ' + c.what + '.' + (c.delete ? '' : ' Delete these in the processor’s own app for now.')) + '</h3>';
    if (e.error) h += '<p class="rd-msg err">' + esc(e.error) + '</p>';
    var ps = e.presets || [];
    h += ps.length ? '<table>' + ps.map(function (p) {
      var f = p.flags || {}, tags = c.flags ? [['sourceData', 'source'], ['processingData', 'processing'], ['outputData', 'settings'], ['screenData', 'LAYOUT']].filter(function (t) { return f[t[0]]; }).map(function (t) { return t[1]; }).join(' · ') : '';
      return '<tr><td>' + p.slot + '</td><td><b>' + esc(p.name) + '</b>' + (p.active ? ' <span class="hint">current</span>' : '') + (tags ? '<br><span class="hint' + (f.screenData ? ' rd-msg warn' : '') + '">' + esc(tags) + '</span>' : '') + '</td><td style="text-align:right">' +
        '<button class="mini" data-dp="recall" data-dev="' + d.id + '" data-slot="' + p.slot + '">Recall…</button>' +
        (c.rename ? '<button class="mini" data-dp="rename" data-dev="' + d.id + '" data-slot="' + p.slot + '">Rename</button>' : '') +
        (c.delete ? '<button class="mini" data-dp="delete" data-dev="' + d.id + '" data-slot="' + p.slot + '">×</button>' : '') + '</td></tr>';
    }).join('') + '</table>' : (e.busy ? '' : '<p class="hint">No presets stored.</p>');
    return h + '</div>';
  }).join('');
}
function bindPresets() {
  var nb = $('psNew'); if (nb) nb.onclick = sceneNew;
  var dv = $('psDev');
  if (dv) dv.onclick = function (e) {
    var b = e.target.closest('[data-dp]'); if (!b) return;
    var d = P.devices.filter(function (x) { return x.id === b.dataset.dev; })[0]; if (d) dvpAct(d, b.dataset.dp, b.dataset.slot);
  };
  var box = $('psBody'); if (!box) return;
  box.onclick = function (e) {
    var b = e.target.closest('[data-ps]'); if (!b) return;
    var id = b.dataset.id, a = b.dataset.ps;
    if (a === 'recall') sceneRecall(id); else if (a === 'update') sceneUpdate(id); else if (a === 'rename') sceneRename(id); else if (a === 'delete') sceneDelete(id);
  };
}
