// app-service.js - Processors ▸ Service (folded under the Hardware card): restart the processor, factory reset it, restart its receiving cards.
// User, 2026-10-11: "restart and factory reset need to be added but with caution menus aka ask before doing".
// Every action goes through this dialog: what happens, what is lost, Cancel as the default; a factory reset also needs RESET
// typed and offers a support bundle (read-back of every linked processor) first. Only what was seen working is offered:
// NovaLCT factory reset (Restore Factory [R]) and receiving-card restart (NCP send's restarts [R]); Unico Device Restart and
// Factory Reset (NovaStar's simulator [R]); COEX receiving-card restart (VMP on the emulator [R]). The rest is shown greyed
// with the reason. A simulated processor (drv-offline.js) offers what its real model offers and only pretends.
// Owns: sv, SV_ACTS, SV_LEVELS, svWhy, svHtml, svOpen, svRender, svRun, bindService.
// Depends on: app-core (P, $, esc, toast), app-log (log), drv-core (DRV), app-hardware (hw, hwBegin, hwEnd, hwForget,
// renderHwCard), app-save (hwUnsavedStore, liveSet, renderUnsaved), app-processors (deviceById, deviceLabel),
// app-support (supportBundle), drv-offline (simFamily), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var sv = { dev: '', act: '', level: '', text: '', bundle: true, busy: false };
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
  sv = { dev: d.id, act: act, level: lv[0] || '', text: '', bundle: true, busy: false };
  $('svcDlg').hidden = false; svRender();
  var c = $('svcCancel'); if (c) c.focus();
}
function svRender() {
  var d = deviceById(sv.dev), box = $('svcBody'); if (!d || !box) return;
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
function svRun() {
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
