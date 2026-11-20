// drv-unico.js - driver for VX Pro / HC20 Pro: UServer's REST API through the helper (tools\unicolink.py,
// /api/unico/*). Moved here unchanged from app-hardware.js (design phase 3). H series is never driven this
// way (the user: H in Unico is out of scope until Unico supports it).
// Owns: DRV_UNICO.
// Depends on: drv-core (DRV, drvResult), unicosend.js (UNICOSEND), app-core (P), app-processors (procModel),
// app-hardware (hwSendModel), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var DRV_UNICO = {
  liveMs: 3000,
  caps: function () { return { link: true, detect: true, live: true, send: true, monitor: true, save: true, readLayout: true, applyMode: 'live', display: true, patterns: true, mapping: true,
    color: { brightness: true, gamma: true, colorTemp: true, gamut: true, bitDepth: true }, verify: { backup: true, primary: true },
    presets: { what: 'layers (source, position, size) and audio', rename: true, delete: true },
    schedule: { add: true, remove: true, enable: true }, rcvFile: { ncp: true, rcfgx: false, why: 'Unico’s own .rcfgx send hasn’t been captured yet' },   // live = like Unico itself
    service: { restart: true, factory: ['keepUser', 'keepIp', 'all'], panels: false } }; },   // cabinet restart: not captured
  // H series answers Unico discovery too, but isn't driven this way (user: H in Unico is out of scope until Unico
  // supports it): H2 29965, H5 29963, H9 15728932, H9 Enh 15728931, H15 29966, H15 Enh 29968, H20 29982.
  H_MODELS: [29965, 29963, 15728932, 15728931, 29966, 29968, 29982],
  discover: function (o) {
    return DRV.post('unico', '/api/unico/discover', { timeout: o.timeout || 2 }).then(function (r) {
      DRV.noteWhy(r.search);   // found nothing: what the helper's searches met (app-online.js olWhy)
      return (r.devices || []).filter(function (x) { return DRV_UNICO.H_MODELS.indexOf(x.modelId) < 0; })
        .map(function (x) { x.kind = 'unico'; return x; });
    });
  },
  // Unico processors scan by themselves; "Detect now" asks for a rescan first (refresh).
  // An NCP to receiving cards as Unico does it (after the file guard, app-rcvguard.js); targets carry the cabinet IDs. No save.
  // Device Restart / Factory Reset as Unico's Device tab (UNICO_UI_TOUR §6.14, NovaStar's simulator [R]); only through
  // app-service.js's caution dialog. level: keepUser | keepIp | all.
  restart: function (d) {
    return DRV.post('unico', '/api/unico/restart', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? 'Restarting' + (r.dropped ? ' (it dropped the connection as it went down)' : '') : 'Restart failed: ' + r.error });
    });
  },
  factoryReset: function (d, level) {
    return DRV.post('unico', '/api/unico/factory-reset', { host: d.hw.host, port: d.hw.port, level: level }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? 'Factory reset sent — it restarts now' : 'Factory reset failed: ' + r.error });
    });
  },
  sendRcvFile: function (d, o) {
    var ids = []; o.targets.forEach(function (t) { (t.cabinetIds || [t.cabinetId]).forEach(function (x) { if (x != null) ids.push(String(x)); }); });
    return DRV.post('unico', '/api/unico/rcv-send', { host: d.hw.host, port: d.hw.port, data: o.data, name: o.name, cabinet: o.cabinet || 0, cabinetIds: ids, verdict: o.verdict })
      .then(function (r) { return drvResult(r.ok, { error: r.error, text: r.ok ? r.cabinets + ' cabinet(s)' : '' }); });
  },
  // What each receiving card is (read-only, for the .rcfgx / NCP guard). -> {ok, cards:[{dst, port, index, cabinetId, id}]}
  identify: function (d) {
    return DRV.post('unico', '/api/unico/identify', { host: d.hw.host, port: d.hw.port })
      .then(function (r) { return r.ok ? drvResult(true, { cards: r.cards }) : drvResult(false, { error: r.error || 'identify failed' }); });
  },
  detect: function (d, o) {
    return DRV.post('unico', '/api/unico/detect', { host: d.hw.host, port: d.hw.port, refresh: !o.auto }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error || 'detect failed' });
      var ports = {};
      r.detected.ports.forEach(function (p) { ports[p.port] = p.cabinets.map(function (c) { return { w: c.width, h: c.height, name: c.cabinet || '', card: c.card || '', fw: c.firmware || '', chip: c.chip || '' }; }); });
      return drvResult(true, { cards: [{ ports: ports }] });
    });
  },
  planSend: function (d, o) {
    var L, model = hwSendModel(d);
    if (!model.screens.length) return drvResult(true, { clear: true, count: 0,   // nothing placed: clear the processor's layout
      confirm: 'Clear the screen layout on ' + d.hw.name + ' (' + d.hw.host + ')?\n\nNo cabinets of this processor are placed in the project, so every cabinet comes off its screen.' });
    try { L = UNICOSEND.buildLayout(model); } catch (e) { return drvResult(false, { error: e.message }); }
    var pairs = o.pairs || [];
    L.portBackup = pairs.map(function (q) { return [q.pp, q.bp]; });
    if (procModel(d.model).canSetCanvas) L.canvas = { width: P.canvasW, height: P.canvasH };   // Match Screen's size (set only if it differs)
    return drvResult(true, { payload: L, count: L.cabinets.length,
      confirm: 'Send the layout to ' + d.hw.name + ' (' + d.hw.host + ')?\n\n' + L.cabinets.length + ' cabinets on ' + L.ports +
        ' ports' + (pairs.length ? ', ' + pairs.length + ' port backup pairs' : '') + '. This replaces the screen layout on the processor' + (pairs.length ? ' and its port backup.' : ' and clears its port backup.') });
  },
  send: function (d, plan, dry) {
    if (plan.clear) return DRV.post('unico', '/api/unico/clear', { host: d.hw.host, port: d.hw.port, dry: !!dry }).then(function (r) {
      return drvResult(r.ok, { error: r.error, count: 0, warnings: [], text: r.ok ? (dry ? 'Check ok (nothing sent): would clear ' + r.cleared + ' cabinets' : 'Cleared: ' + r.cleared + ' cabinets taken off the screen') : 'Failed: ' + r.error });
    });
    return DRV.post('unico', '/api/unico/send', { host: d.hw.host, port: d.hw.port, layout: plan.payload, dry: !!dry }).then(function (r) {
      return drvResult(r.ok, { warnings: r.warnings || [], log: r.log, error: r.error, count: plan.count,
        text: r.ok ? (dry ? 'Check ok (nothing sent)' : 'Sent: ' + r.cabinets + ' cabinets, read back OK') : 'Failed: ' + (r.error || 'read-back mismatch') });
    });
  },
  save: function (d) {   // Unico's Save = PUT cabinet/solid
    return DRV.post('unico', '/api/unico/save', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? 'Saved on the processor (' + r.screens + ' screen' + (r.screens === 1 ? '' : 's') + ')' : 'Save failed: ' + r.error });
    });
  },
  readLayout: function (d) {
    return DRV.post('unico', '/api/unico/read-layout', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      return r.ok ? drvResult(true, { cabinets: r.cabinets }) : drvResult(false, { error: r.error || 'read failed' });
    });
  },
  // display / test on cabinets (helper /api/unico/cabinets): display-mode 0 normal 1 black 2 frozen; test-pattern 1 normal,
  // 4 red, 5 green, 6 blue, 7 white, 8 / 9 lines, 10 diagonal, 12 gradient, 13 ageing [R UTOUR, C UNICO_OPERATIONS §4.2d].
  CODES: { normal: 1, red: 4, green: 5, blue: 6, white: 7, hlines: 8, vlines: 9, slash: 10, gray: 12, mixed: 13, locate: 5 },
  cab: function (d, body, what) {
    body.host = d.hw.host; body.port = d.hw.port;
    return DRV.post('unico', '/api/unico/cabinets', body).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? what + (r.cabinets ? ' (' + r.cabinets + ' cabinets)' : '') : what + ' failed: ' + r.error });
    });
  },
  tg: function (targets) { return targets ? targets.map(function (t) { return { port: t.port, index: t.index }; }) : null; },
  display: function (d, mode, targets) {
    var m = mode === 'blackout' ? 1 : mode === 'freeze' ? 2 : 0;
    var r = DRV_UNICO.cab(d, { action: 'display', mode: m, targets: DRV_UNICO.tg(targets) }, mode === 'normal' ? 'Normal' : mode === 'blackout' ? 'Blackout' : 'Freeze');
    // Normal also ends a test pattern (Unico keeps the two apart)
    return mode === 'normal' ? r.then(function (x) { return DRV_UNICO.cab(d, { action: 'pattern', mode: 1, targets: DRV_UNICO.tg(targets) }, 'Normal').then(function () { return x; }); }) : r;
  },
  pattern: function (d, code, targets) {
    var c = DRV_UNICO.CODES[code]; if (!c) return DRV.unsupported('That test pattern');
    return DRV_UNICO.cab(d, { action: 'pattern', mode: c, targets: DRV_UNICO.tg(targets) }, 'Test pattern ' + code);
  },
  // Screen settings (helper /api/unico/screen; a refused value comes back as an error and the Screen tab rolls back).
  GAMUTS: { rec709: 1, dcip3: 2, dcip3d65: 15, rec2020: 3, original: 11, input: 255 },
  screenSet: function (d, action, value) {
    var v = action === 'gamut' ? DRV_UNICO.GAMUTS[value] : value;
    if (v === undefined) return DRV.unsupported('That setting');
    return DRV.post('unico', '/api/unico/screen', { host: d.hw.host, port: d.hw.port, action: action, value: v }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? action + ' set' : action + ' refused: ' + r.error });
    });
  },
  // What the processor holds now (read-only, GET screen/list-detail — Unico's own call, seen live on NovaStar's simulator:
  // adjustment.brightness / gamma / colorTemperature, selectGamut.presetGamut, colorDepth.preset). -> {ok, values, notes, mixed}.
  readColor: function (d) {
    return DRV.post('unico', '/api/unico/screen-read', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error || 'read failed' });
      var g = null, notes = {};
      Object.keys(DRV_UNICO.GAMUTS).forEach(function (k) { if (DRV_UNICO.GAMUTS[k] === r.gamut) g = k; });
      if (g === null && r.gamut != null) notes.gamut = r.gamut === 12 ? 'a custom gamut' : r.gamut === 254 ? 'set by colour temperature' : 'gamut type ' + r.gamut;
      return drvResult(true, { values: { brightness: r.brightness, gamma: r.gamma, colorTemp: r.colorTemp, gamut: g, bitDepth: r.bitDepth }, notes: notes,
        mixed: r.mixed ? ['brightness', 'gamma', 'colorTemp', 'gamut'] : [] });
    });
  },
  presets: function (d) {
    return DRV.post('unico', '/api/unico/presets', { host: d.hw.host, port: d.hw.port }).then(function (r) { return drvResult(r.ok, { presets: r.presets || [], error: r.error }); });
  },
  presetSave: function (d, name, flags) {
    return DRV.post('unico', '/api/unico/preset-save', { host: d.hw.host, port: d.hw.port, name: name, flags: flags }).then(function (r) { return drvResult(r.ok, { slot: r.slot, error: r.error }); });
  },
  presetApply: function (d, p) {
    return DRV.post('unico', '/api/unico/preset-apply', { host: d.hw.host, port: d.hw.port, id: p.id, slot: p.slot }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  // Schedules and preset delete: confirmed live on NovaStar's VX2000 Pro simulator (2026-10-10, docs/RE_TOOLKIT.md).
  scheduleAdd: function (d, e) {
    return DRV.post('unico', '/api/unico/schedule-add', { host: d.hw.host, port: d.hw.port, start: e.start, end: e.end, brightness: e.brightness, repeat: e.repeat }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  scheduleDelete: function (d, id) {
    return DRV.post('unico', '/api/unico/schedule-delete', { host: d.hw.host, port: d.hw.port, id: id }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  scheduleEnable: function (d, on) {
    return DRV.post('unico', '/api/unico/schedule-enable', { host: d.hw.host, port: d.hw.port, enable: !!on }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  presetDelete: function (d, p) {
    return DRV.post('unico', '/api/unico/preset-delete', { host: d.hw.host, port: d.hw.port, id: p.id }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  schedules: function (d) {
    return DRV.post('unico', '/api/unico/schedules', { host: d.hw.host, port: d.hw.port }).then(function (r) { return drvResult(r.ok, { enable: r.enable, brightness: r.brightness || [], error: r.error }); });
  },
  presetRename: function (d, p, name) {
    return DRV.post('unico', '/api/unico/preset-rename', { host: d.hw.host, port: d.hw.port, id: p.id, name: name }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  readBackup: function (d) {   // the port backup pairs on the processor: [[card, masterPort, backupPort]] (card = its own, 0…)
    return DRV.post('unico', '/api/unico/read-backup', { host: d.hw.host, port: d.hw.port }).then(function (r) { return drvResult(r.ok, { pairs: r.pairs || [], roles: r.deviceBackup || [], error: r.error }); });
  },
  // Backup verify (helper /api/unico/backup-mode → PUT screen/netport-backup-enable [R UTOUR §7]): 1 backup ports only,
  // 2 primary only, 0 normal.
  verifyBackup: function (d, mode) {
    var m = mode === 'backup' ? 1 : mode === 'primary' ? 2 : 0;
    return DRV.post('unico', '/api/unico/backup-mode', { host: d.hw.host, port: d.hw.port, mode: m }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? (m === 1 ? 'Showing the backup ports' : m === 2 ? 'Showing the primary ports' : 'Backup back to normal') : 'Failed: ' + r.error });
    });
  },
  mapping: function (d, on) { return DRV_UNICO.cab(d, { action: 'mapping', on: !!on }, 'Mapping ' + (on ? 'on' : 'off')); },
  deviceInfo: function (d) {
    return DRV.post('unico', '/api/unico/info', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error });
      var i = r.info;
      return drvResult(true, { rows: [['Name', i.name], ['Model ID', i.modelId], ['Serial', i.sn], ['Firmware', i.version || '—'], ['MAC / IP', (i.mac || '—') + ' · ' + (i.ip || '—')],
        ['Ports', i.ports.length], ['LED screens', i.screens.map(function (s) { return s.name; }).join(', ') || '—'], ['Placed cabinets', i.placedCabinets.length],
        ['State', i.status === 9 ? 'busy (processor backup sync)' : 'ready']], inputs: [] });
    }).then(function (res) {   // inputs + EDID timing (read-only); a failure leaves the rest
      if (!res.ok) return res;
      return DRV.post('unico', '/api/unico/inputs', { host: d.hw.host, port: d.hw.port }).then(function (x) {
        if (x.ok) res.inputs = (x.inputs || []).map(DRV.inputRow); return res;
      }, function () { return res; });
    });
  },
  monitor: function (d) {
    return DRV.post('unico', '/api/unico/health', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      return r.ok ? drvResult(true, { health: r.health }) : drvResult(false, { error: r.error || 'health failed' });
    });
  },
  // The user's Clear: Unico's own "Clear Errors" (POST ucenter/monitor/cabinet/error-bit/delete) was never seen live
  // (UNICO_MONITORING_CALIBRATION) — so nothing goes to the processor: Open Nova clears its own record
  // and counts the bit errors from here on (app-health baseline).
  clearErrors: function () { return Promise.resolve(drvResult(true, { hw: false, text: 'cleared in Open Nova only — Unico’s error clear hasn’t been seen live yet, so the processor’s counters were not touched' })); },
  // Correction tab (app-correction.js, helper /api/hw/calib): read = cabinet/info-v2's correction switches per cabinet [R
  // fields]; switch = PUT screen/correction/switch on every LED screen [R route and bodies, UNICO_UI_TOUR §4-5]. Which of
  // switchMode 4 / 0 is brightness-only vs brightness + chroma wasn't seen live, so the tab reads back after.
  // No coefficient operations (Unico's were never captured).
  correctionCaps: function () { return { read: true, modes: ['off', 'brightness', 'chroma'], modesNote: 'The switch was seen live from Unico; which mode number is brightness-only hasn’t been seen live, so Open Nova reads it back after switching.' }; },
  correction: function (d, op, o) {
    if (op !== 'read' && op !== 'switch') return DRV.unsupported('That correction step');
    return DRV.post('unico', '/api/hw/calib', { kind: 'unico', host: d.hw.host, port: d.hw.port, op: op, mode: (o || {}).mode }).then(function (r) {
      return r.ok ? drvResult(true, { cabinets: r.cabinets || [], writes: op === 'switch' ? 1 : 0 }) : drvResult(false, { error: r.error || op + ' failed' });
    });
  }
};
DRV.register('unico', DRV_UNICO);
