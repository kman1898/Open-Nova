// app-service.js - Processors ▸ Service (folded under the Hardware card): restart the processor, factory reset it, restart its receiving cards;
// and Restart cabinets: only the cabinets picked in Maintain's cabinet table or on the Layout canvas (right-click), as Unico's
// and VMP's Maintain ▸ Cabinet ▸ Restart, on every processor they are on (svOpenCabinets); nothing picked = not offered.
// User, 2026-10-11: "restart and factory reset need to be added but with caution menus aka ask before doing".
// Every action goes through this dialog: what happens, what is lost, Cancel as the default; a factory reset also needs RESET
// typed and offers a support bundle (read-back of every linked processor) first. Only what was seen working is offered:
// NovaLCT factory reset (Restore Factory [R]) and receiving-card restart (NCP send's restarts [R]); Unico Device Restart and
// Factory Reset (NovaStar's simulator [R]); COEX receiving-card restart (VMP on the emulator [R]). The rest is shown greyed
// with the reason. A simulated processor (drv-offline.js) offers what its real model offers and only pretends.
// Owns: sv, SV_ACTS, SV_LEVELS, svWhy, svHtml, svOpen, svCellKeys, svOpenCabinets, svRender, svRenderCabinets, svRun,
// svRunCabinets, bindService.
// Depends on: app-core (P, $, esc, toast), app-log (log), drv-core (DRV), app-hardware (hw, hwBegin, hwEnd, hwForget,
// renderHwCard), app-save (hwUnsavedStore, liveSet, renderUnsaved), app-processors (deviceById, deviceLabel, deviceOfCard,
// cardsOfDevice), app-capacity (portLabel), app-health (hltCellAt),
// app-support (supportBundle), drv-offline (simFamily), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var sv = { dev: '', act: '', level: '', text: '', bundle: true, busy: false, by: null };   // by: Maintain's cabinets, {deviceId: [{card, port, index}]}
var SV_ACTS = { restart: 'Restart processor', factory: 'Factory reset', panels: 'Restart cabinets' };
// What each factory-reset level keeps and erases, per family (NovaLCT: CAPTURE_MCTRL4K_SEND "Restore Factory";
// Unico: UNICO_OPERATIONS §6.3 and its own tooltip).
var SV_LEVELS = {
  lct: { all: { name: 'Restore factory settings', text: 'The processor goes back to its factory settings, and the screen layout and the port backup pairs stored on the processor are erased. The receiving cards (cabinets) keep their configuration. Send the layout again afterwards.' } },
  unico: {
    keepUser: { name: 'Keep user data', text: 'Keeps the input EDID, imported files, language, device name, IP address and the projects with their restore points. Screens, layers, presets and scenes are reset.' },
    keepIp: { name: 'Keep the IP address only', text: 'Keeps only the IP address. Everything else is erased: projects, screens, presets, scenes, EDID and imported files.' },
    all: { name: 'Reset everything', text: 'Erases everything, the IP address too: the processor comes back on its factory address, so Open Nova may not reach it until you find it again.' }
  }
};
// Why an action isn't offered for a processor ('' = it is).
function svWhy(d, act) {
  if (!d || !d.hw) return 'Link the processor first';
  var c = (DRV.of(d).caps(d).service) || {}, fam = d.hw.kind === 'offline' ? simFamily(d) : d.hw.kind;   // simulated: as its real model
  if (act === 'restart' && !c.restart) return fam === 'lct' ? 'NovaLCT has no restart command for the processor itself — power-cycle it' : 'Not offered yet: VMP’s controller restart hasn’t been captured working';
  if (act === 'factory' && !(c.factory || []).length) return 'Not offered yet: VMP’s controller factory reset hasn’t been captured working';
  if (act === 'panels' && !c.panels) return 'Not offered yet: Unico’s cabinet restart hasn’t been captured working';
  return '';
}
// The service buttons, in the folded Service section under the Hardware card (app-devices.js; UI cleanup item 6).
function svHtml(d) {
  if (!d.hw || !DRV.of(d).caps(d).service) return '';
  return '<div class="row svc-row">' + ['restart', 'factory', 'panels'].map(function (a) {
    var why = svWhy(d, a);
    return '<button class="mini danger" data-hw="svc" data-act="' + a + '"' + (why ? ' disabled title="' + esc(why) + '"' : ' title="Asks first"') + '>' + SV_ACTS[a] + '…</button>';
  }).join('') + '</div>';
}
function svOpen(d, act) {
  var why = svWhy(d, act); if (why) return toast(why);
  if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running');
  var lv = act === 'factory' ? DRV.of(d).caps(d).service.factory : [];
  sv = { dev: d.id, act: act, level: lv[0] || '', text: '', bundle: true, busy: false, by: null };
  $('svcDlg').hidden = false; svRender();
  var c = $('svcCancel'); if (c) c.focus();
}
// Layout canvas cells → the cabinet keys svOpenCabinets takes ('card:port:index', the cable order Send uses); unwired
// cells and blanks have none.
function svCellKeys(cells) {
  var out = []; (cells || []).forEach(function (c) { var at = hltCellAt(c); if (at) out.push(at.card + ':' + at.port + ':' + at.index); });
  return out;
}
// Maintain (and the Layout canvas): restart the cabinets `keys` ('card:port:index' of the cabinet table), grouped per processor. Processors that
// aren't linked or can't restart cabinets are left out and named in the dialog.
function svOpenCabinets(keys) {
  if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running');
  var by = {}, skip = {}, first = null;
  keys.forEach(function (k) {
    var sp = k.split(':').map(Number), d = deviceOfCard(sp[0]); if (!d) return;
    var why = svWhy(d, 'panels'); if (why) { skip[d.id] = why; return; }
    (by[d.id] || (by[d.id] = [])).push({ card: cardsOfDevice(d).indexOf(sp[0]), port: sp[1], index: sp[2] });
    if (!first) first = d;
  });
  if (!first) { var w = Object.keys(skip); return toast(w.length ? deviceLabel(deviceById(w[0])) + ': ' + skip[w[0]] : 'Pick cabinets on a linked processor first'); }
  sv = { dev: first.id, act: 'cabs', level: '', text: '', bundle: true, busy: false, by: by, skip: skip };
  $('svcDlg').hidden = false; svRender();
  var c = $('svcCancel'); if (c) c.focus();
}
function svRender() {
  var d = deviceById(sv.dev), box = $('svcBody'); if (!d || !box) return;
  if (sv.act === 'cabs') return svRenderCabinets(box);
  var sim = d.hw.kind === 'offline', name = deviceLabel(d) + ' (' + d.hw.name + (sim ? '' : ', ' + d.hw.host) + ')', fam = sim ? simFamily(d) : d.hw.kind, un = hw.unsaved && hw.unsaved[d.id], h = '';
  $('svcTitle').textContent = SV_ACTS[sv.act] + ': ' + deviceLabel(d);
  if (sv.act === 'restart') {
    h += '<p><b>' + esc(name) + '</b> restarts. Every screen it drives goes dark until it has started again, and Open Nova loses it until then.</p>' +
      '<p>' + (un ? '⚠ Changes not saved on it are lost: ' + esc(un.why || 'edits') + '. Save first if you want to keep them.' : 'Everything it has is kept (what is saved on it comes back).') + '</p>';
  } else if (sv.act === 'panels') {
    h += '<p>Every receiving card on <b>' + esc(name) + '</b> restarts. All its cabinets go dark' + (fam === 'lct' ? ' for about 25 s' : ' for a moment') + ' and come back with what is stored on the cards.</p>' +
      '<p>Receiving-card changes that weren’t saved (brightness, colour, a receiving-card file sent without Save) go back to what was saved.' + (un ? ' ⚠ Unsaved here: ' + esc(un.why || 'edits') + '.' : '') + '</p>';
  } else {
    var L = SV_LEVELS[fam] || {}, levels = DRV.of(d).caps(d).service.factory;
    h += '<p><b>' + esc(name) + '</b> is reset to its factory settings. <b>This can’t be undone</b> from Open Nova.</p>';
    h += levels.length > 1 ? '<div class="svc-levels">' + levels.map(function (k) {
      return '<label class="svc-level"><input type="radio" name="svcLevel" value="' + k + '"' + (k === sv.level ? ' checked' : '') + '> <b>' + esc(L[k].name) + '</b><br><span class="hint">' + esc(L[k].text) + '</span></label>';
    }).join('') + '</div>' : '<p>' + esc(L[sv.level].text) + '</p>';
    if (fam === 'unico') h += '<p class="hint">The processor restarts at the end, as with Restart.</p>';
    h += '<label class="chk"><input type="checkbox" id="svcBundle"' + (sv.bundle ? ' checked' : '') + '> First download a support bundle (a read-back of every linked processor: its layout, backup pairs, device info — to compare with or rebuild from)</label>' +
      '<label class="rcv-ovr-row">Type <b>RESET</b> to unlock <input id="svcText" type="text" maxlength="20" autocomplete="off" spellcheck="false" value="' + esc(sv.text) + '"></label>';
  }
  if (sim) h += '<p class="hint">Simulated: nothing is sent; the simulated processor only pretends.</p>';
  if (sv.busy) h += '<p class="hint">Working… keep it powered and connected.</p>';
  box.innerHTML = h;
  var ok = sv.act !== 'factory' || sv.text.trim().toUpperCase() === 'RESET';
  $('svcFoot').innerHTML = '<button id="svcCancel" class="primary-outline"' + (sv.busy ? ' disabled' : '') + '>Cancel</button>' +
    '<button id="svcGo" class="danger"' + (ok && !sv.busy ? '' : ' disabled') + '>' + (sv.act === 'factory' ? 'Factory reset' : sv.act === 'panels' ? 'Restart the cabinets' : 'Restart') + '</button>';
}
function svRenderCabinets(box) {
  var ids = Object.keys(sv.by), n = ids.reduce(function (a, k) { return a + sv.by[k].length; }, 0), h = '', anyLct = false, anySim = false;
  $('svcTitle').textContent = 'Restart ' + n + ' cabinet' + (n === 1 ? '' : 's');
  h += '<p>These receiving cards restart' + (ids.length > 1 ? ', on ' + ids.length + ' processors' : '') + ':</p><ul>' + ids.map(function (k) {
    var d = deviceById(k), fam = d.hw.kind === 'offline' ? simFamily(d) : d.hw.kind, t = sv.by[k];
    if (fam === 'lct') anyLct = true; if (d.hw.kind === 'offline') anySim = true;
    return '<li><b>' + esc(deviceLabel(d)) + '</b>: ' + (t.length > 6 ? t.length + ' cabinets' : t.map(function (x) { return esc(portLabel(cardsOfDevice(d)[x.card], x.port)) + ' #' + (x.index + 1); }).join(', ')) + '</li>';
  }).join('') + '</ul>';
  h += '<p>They go dark' + (anyLct ? ' for about 25 s' : ' for a moment') + ' and come back with what is stored on them, whether it came from an .rcfgx or an NCP. Changes not saved on the cards (brightness, colour, a file sent without Save) go back to what was saved.</p>';
  Object.keys(sv.skip || {}).forEach(function (k) { h += '<p class="hint">Left out: ' + esc(deviceLabel(deviceById(k))) + ' — ' + esc(sv.skip[k]) + '</p>'; });
  if (anySim) h += '<p class="hint">Simulated: nothing is sent; the simulated processor only pretends.</p>';
  if (sv.busy) h += '<p class="hint">Working… keep it powered and connected.</p>';
  box.innerHTML = h;
  $('svcFoot').innerHTML = '<button id="svcCancel" class="primary-outline"' + (sv.busy ? ' disabled' : '') + '>Cancel</button>' +
    '<button id="svcGo" class="danger"' + (sv.busy ? ' disabled' : '') + '>Restart ' + (n === 1 ? 'the cabinet' : 'the ' + n + ' cabinets') + '</button>';
}
// One processor after another, so each NovaLCT wait (≈25 s) shows in the recording as its own block.
function svRunCabinets() {
  var ids = Object.keys(sv.by), by = sv.by, res = [];
  if (!hwBegin('service')) return;
  sv.busy = true; svRender();
  return ids.reduce(function (p, k) {
    return p.then(function () {
      var d = deviceById(k);
      log('hw_service', { processor: deviceLabel(d), action: 'cabinets', cabinets: by[k].length, target: d.hw.host });
      return DRV.of(d).restartPanels(d, by[k]).then(function (r) { return r; }, function (e) { return { ok: false, error: e.message }; }).then(function (r) {
        log('hw_service_done', { processor: deviceLabel(d), action: 'cabinets', ok: r.ok, error: r.error }); r.d = d; res.push(r);
      });
    });
  }, Promise.resolve()).then(function () {
    hwEnd('service'); sv.busy = false; $('svcDlg').hidden = true;
    toast(res.map(function (r) { return deviceLabel(r.d) + ': ' + (r.ok ? r.text || 'done' : r.error || 'failed'); }).join(' · '));
  });
}
function svRun() {
  if (sv.act === 'cabs') return sv.busy ? undefined : svRunCabinets();
  var d = deviceById(sv.dev); if (!d || sv.busy) return;
  if (sv.act === 'factory' && sv.text.trim().toUpperCase() !== 'RESET') return toast('Type RESET first');
  var why = svWhy(d, sv.act); if (why) return toast(why);
  var act = sv.act, level = sv.level, x = DRV.of(d);
  var first = act === 'factory' && sv.bundle && typeof supportBundle === 'function' ? Promise.resolve(supportBundle()) : Promise.resolve();
  if (!hwBegin('service')) return;
  sv.busy = true; svRender();
  log('hw_service', { processor: deviceLabel(d), action: act, level: level || undefined, target: d.hw.host });
  return first.then(function () {
    return act === 'restart' ? x.restart(d) : act === 'factory' ? x.factoryReset(d, level) : x.restartPanels(d);
  }).then(function (r) { return r; }, function (e) { return { ok: false, error: e.message }; }).then(function (r) {
    hwEnd('service'); sv.busy = false; $('svcDlg').hidden = true;
    log('hw_service_done', { processor: deviceLabel(d), action: act, ok: r.ok, error: r.error });
    if (r.ok && act !== 'panels') {   // what Open Nova knew about it is stale now
      hwForget(d); if (hw.applied) liveSet(d, undefined);
      if (hw.unsaved && hw.unsaved[d.id]) { delete hw.unsaved[d.id]; hwUnsavedStore(); if (typeof renderUnsaved === 'function') renderUnsaved(); }
    }
    toast(deviceLabel(d) + ': ' + (r.ok ? r.text || 'done' : r.error || 'failed') + (r.ok && act === 'factory' ? ' — send the layout again when it is back' : ''));
    renderHwCard(devSelected());
  });
}
function bindService() {
  var dlg = $('svcDlg'); if (!dlg) return;
  dlg.addEventListener('click', function (e) {
    if ((e.target.id === 'svcCancel' || e.target.id === 'svcClose' || e.target === dlg) && !sv.busy) { dlg.hidden = true; return; }
    if (e.target.id === 'svcGo' && !e.target.disabled) return svRun();
  });
  dlg.addEventListener('change', function (e) {
    if (e.target.name === 'svcLevel') { sv.level = e.target.value; return svRender(); }
    if (e.target.id === 'svcBundle') sv.bundle = e.target.checked;
  });
  dlg.addEventListener('input', function (e) {   // no redraw while typing, just the button
    if (e.target.id !== 'svcText') return;
    sv.text = e.target.value; var b = $('svcGo'); if (b) b.disabled = sv.busy || sv.text.trim().toUpperCase() !== 'RESET';
  });
  dlg.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !sv.busy) dlg.hidden = true; });
}
