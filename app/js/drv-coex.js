// drv-coex.js - driver for COEX controllers (MX40 Pro, MX6000 Pro, MX2000 Pro, CX40 Pro): the controller's own REST
// API through the helper (tools\coexlink.py, /api/coex/*), the calls VMP's XCenter makes (docs\COEX_DRIVER_API.md, all
// [R] on VMP's own controller emulator). Like VMP, every layout edit applies live (no Send on the controller); Save
// (device/cabinet/solid) stays a separate, deliberate step.
//   - Output cards are the controller's in slot order = the project's sending cards of this processor in order.
//   - Discovery: controllers announce themselves on UDP 54622 (broadcast on a real LAN). Addresses typed in
//     (opennova.coexHosts, "ip:port", default port 8001) are asked directly as well.
// Owns: DRV_COEX, COEX_HOSTS_KEY, coexHosts.
// Depends on: drv-core (DRV, drvResult), app-core (P), app-processors (cardsOfDevice), app-scr-io (toScrModel), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var COEX_HOSTS_KEY = 'opennova.coexHosts';
function coexHosts() { try { return JSON.parse(localStorage.getItem(COEX_HOSTS_KEY) || '[]') || []; } catch (e) { return []; } }

var DRV_COEX = {
  liveMs: 3000,
  caps: function () { return { link: true, detect: true, live: true, send: true, monitor: true, save: true, readLayout: true, applyMode: 'live', display: true, patterns: true, mapping: true,
    color: { brightness: true, gamma: true, colorTemp: true, gamut: true, bitDepth: true }, lowLatency: true, lowLatencyOne: true, verify: { backup: true, primary: false },
    presets: { what: 'inputs and layers, processing and screen settings (not the cabinet layout)', rename: false, delete: true, flags: true },
    schedule: { add: true, remove: true, enable: true }, rcvFile: { ncp: true, rcfgx: false, why: 'VMP’s own .rcfgx send hasn’t been captured yet' },
    service: { restart: false, factory: [], panels: true } }; },   // controller restart / reset: not captured from VMP yet
  discover: function (o) {
    return DRV.post('coex', '/api/coex/discover', { timeout: o.timeout || 2, probe: coexHosts() }).then(function (r) {
      DRV.noteWhy(r.search);   // found nothing: what the helper's searches met (app-online.js olWhy)
      return (r.devices || []).filter(function (x) { return !x.error; }).map(function (x) { x.kind = 'coex'; return x; });
    });
  },
  // Detected receiving cards per output card and port (the controller scans by itself; "Detect now" asks for a re-scan).
  // An NCP to receiving cards as VMP does it (after the file guard, app-rcvguard.js); targets carry the cabinet IDs. No save.
  // Restart the receiving cards as VMP's Maintain ▸ Cabinet ▸ Restart (VMP_TOUR, emulator [R]); only through app-service.js.
  // targets (Maintain: [{card, port, index}]) = those cabinets, by their cabinet IDs; none = every card found.
  restartPanels: function (d, targets) {
    return DRV.post('coex', '/api/coex/cabinet-restart', { host: d.hw.host, port: d.hw.port, targets: targets && targets.length ? targets : undefined }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? r.cards + ' receiving card' + (r.cards === 1 ? '' : 's') + ' restarting' : 'Restart failed: ' + r.error });
    });
  },
  sendRcvFile: function (d, o) {
    var ids = []; o.targets.forEach(function (t) { (t.cabinetIds || [t.cabinetId]).forEach(function (x) { if (x != null) ids.push(String(x)); }); });
    return DRV.post('coex', '/api/coex/rcv-send', { host: d.hw.host, port: d.hw.port, data: o.data, name: o.name, cabinet: o.cabinet || 0, cabinetIds: ids, verdict: o.verdict })
      .then(function (r) { return drvResult(r.ok, { error: r.error, text: r.ok ? r.cabinets + ' cabinet(s)' : '' }); });
  },
  // What each receiving card is (read-only, for the .rcfgx / NCP guard). -> {ok, cards:[{dst, port, index, cabinetId, id}]}
  identify: function (d) {
    return DRV.post('coex', '/api/coex/identify', { host: d.hw.host, port: d.hw.port })
      .then(function (r) { return r.ok ? drvResult(true, { cards: r.cards }) : drvResult(false, { error: r.error || 'identify failed' }); });
  },
  detect: function (d, o) {
    return DRV.post('coex', '/api/coex/detect', { host: d.hw.host, port: d.hw.port, refresh: !o.auto }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error || 'detect failed' });
      return drvResult(true, { cards: r.detected.cards.map(function (c) {
        var ports = {}; Object.keys(c.ports).forEach(function (p) { ports[p] = c.ports[p].map(function (x) { return { w: x.width, h: x.height, name: x.cabinet || x.card || '', card: x.card || '', fw: x.firmware || '' }; }); });
        return { ports: ports };
      }) });
    });
  },
  // The project's panels of this processor as {cabinets:[{card, port, index, x, y, width, height}], portBackup:[[card, mp, bp]],
  // cardBackup:[[master, backup]]}. Sending-card backup on COEX = the controller mirrors the card itself
  // (device/outputcard/backup), so the plan's backup copy screens (made for NovaLCT) are not sent.
  planSend: function (d, o) {
    var cards = cardsOfDevice(d), m = toScrModel(), cabs = [];
    // toScrModel leaves out screens without sections: index the same list (P.lct[si] was off by one after an empty one)
    var lcs = P.lct.filter(function (lc) { return P.screens.some(function (s) { return s.screenId === lc.id; }); });
    m.screens.forEach(function (s, si) {
      if (lcs[si] && lcs[si].backupOf) return;
      var by = {};
      (s.cells || s.regions || []).forEach(function (c) { var ci = cards.indexOf(c.sender); if (c.sender !== 255 && ci >= 0) (by[ci + ':' + c.port] || (by[ci + ':' + c.port] = [])).push(c); });
      Object.keys(by).forEach(function (k) {
        var ci = +k.split(':')[0];
        by[k].sort(function (a, b) { return a.connect - b.connect; }).forEach(function (c, i) {
          cabs.push({ card: ci, port: c.port, index: i, x: c.x, y: c.y, width: c.width, height: c.height });
        });
      });
    });
    var bk = P.backup && P.backup.mode === 'card' ? (P.backup.cards || []).filter(function (q) { return cards.indexOf(q.ms) >= 0 && cards.indexOf(q.bs) >= 0; }) : [];
    var cardBackup = bk.map(function (q) { return [cards.indexOf(q.ms), cards.indexOf(q.bs)]; });
    if (!cabs.length) return drvResult(true, { clear: true, count: 0,
      confirm: 'Clear the screen layout on ' + d.hw.name + ' (' + d.hw.host + ')?\n\nNo cabinets of this processor are placed in the project, so every cabinet comes off its screen.' });
    var pairs = (o.pairs || []).filter(function (q) { return q.ps === q.bs; });
    if ((o.pairs || []).length > pairs.length) return drvResult(false, { error: 'COEX port backup pairs must be on one output card (card backup is a separate mode)' });
    var L = { cabinets: cabs, portBackup: pairs.map(function (q) { return [q.ps, q.pp, q.bp]; }), cardBackup: cardBackup };
    return drvResult(true, { payload: L, count: cabs.length,
      confirm: 'Send the layout to ' + d.hw.name + ' (' + d.hw.host + ')?\n\n' + cabs.length + ' cabinets' + (pairs.length ? ', ' + pairs.length + ' port backup pairs' : '') +
        (cardBackup.length ? ', ' + cardBackup.length + ' backup card(s)' : '') + '. This replaces the screen layout on the controller (no Save).' });
  },
  send: function (d, plan, dry) {
    if (plan.clear) return DRV.post('coex', '/api/coex/clear', { host: d.hw.host, port: d.hw.port, dry: !!dry }).then(function (r) {
      return drvResult(r.ok, { error: r.error, count: 0, warnings: [], text: r.ok ? (dry ? 'Check ok (nothing sent): would clear ' + r.cleared + ' cabinets' : 'Cleared: ' + r.cleared + ' cabinets taken off the screen') : 'Failed: ' + r.error });
    });
    return DRV.post('coex', '/api/coex/send', { host: d.hw.host, port: d.hw.port, layout: plan.payload, dry: !!dry }).then(function (r) {
      return drvResult(r.ok, { warnings: r.warnings || [], log: r.log, error: r.error, count: plan.count,
        text: r.ok ? (dry ? 'Check ok (nothing sent)' : 'Sent: ' + r.cabinets + ' cabinets, read back OK') : 'Failed: ' + (r.error || 'read-back mismatch') });
    });
  },
  save: function (d) {   // VMP's "Save Rv-card Config": PUT device/cabinet/solid {idList, type 1}
    return DRV.post('coex', '/api/coex/save', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? 'Saved on the receiving cards (' + r.cabinets + ' cabinets)' : 'Save failed: ' + r.error });
    });
  },
  readLayout: function (d) {
    return DRV.post('coex', '/api/coex/read-layout', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      return r.ok ? drvResult(true, { cabinets: r.cabinets }) : drvResult(false, { error: r.error || 'read failed' });
    });
  },
  // display: device/displaymode (everything) or device/cabinet/displaymode (selected): 0 normal 1 black 2 frozen [R].
  // Test patterns = the receiving cards' self-test (device/cabinet/testpattern {testmode}). The codes are Unico's; the
  // controller maps testmode 1/4/5/6/7/8/9/10/12/13 to rx 0x02000101 =
  // 1 normal / 2 red / 3 green / 4 blue / 5 white / 6, 7 lines / 8 diagonal / 9 gradient / 10 ageing; any other value = red).
  CODES: { normal: 1, red: 4, green: 5, blue: 6, white: 7, hlines: 8, vlines: 9, slash: 10, gray: 12, mixed: 13, locate: 5 },
  cab: function (d, body, what) {
    body.host = d.hw.host; body.port = d.hw.port;
    return DRV.post('coex', '/api/coex/cabinets', body).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? what + (r.cabinets ? ' (' + r.cabinets + ' cabinets)' : '') : what + ' failed: ' + r.error });
    });
  },
  tg: function (targets) { return targets ? targets.map(function (t) { return { card: t.card, port: t.port, index: t.index }; }) : null; },
  display: function (d, mode, targets) {
    var m = mode === 'blackout' ? 1 : mode === 'freeze' ? 2 : 0;
    var r = DRV_COEX.cab(d, { action: 'display', mode: m, targets: DRV_COEX.tg(targets) }, mode === 'normal' ? 'Normal' : mode === 'blackout' ? 'Blackout' : 'Freeze');
    return mode === 'normal' ? r.then(function (x) { return DRV_COEX.cab(d, { action: 'pattern', mode: 1, targets: DRV_COEX.tg(targets) }, 'Normal').then(function () { return x; }); }) : r;
  },
  pattern: function (d, code, targets) {
    var c = DRV_COEX.CODES[code]; if (!c) return DRV.unsupported('That test pattern');
    return DRV_COEX.cab(d, { action: 'pattern', mode: c, targets: DRV_COEX.tg(targets) }, 'Test pattern ' + code);
  },
  mapping: function (d, on) { return DRV_COEX.cab(d, { action: 'mapping', on: !!on }, 'Mapping ' + (on ? 'on' : 'off')); },
  // Screen settings (docs §9 [R]): brightness / gamma per cabinet, colour temperature / gamut / bit depth per screen.
  screenSet: function (d, action, value) {
    return DRV.post('coex', '/api/coex/screen', { host: d.hw.host, port: d.hw.port, action: action, value: value }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? action + ' set' : action + ' refused: ' + r.error });
    });
  },
  // What the controller holds now (read-only: GET screen/displayparams + screen/output, VMP's own calls on the emulator).
  readColor: function (d) {
    return DRV.post('coex', '/api/coex/screen-read', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error || 'read failed' });
      var notes = {};
      if (!r.gamut && r.gamutName != null) notes.gamut = r.gamutName ? r.gamutName : 'no gamut chosen yet';
      var v = { brightness: r.brightness, gamma: r.gamma, colorTemp: r.colorTemp, gamut: r.gamut || null, bitDepth: r.bitDepth };
      if (r.lowLatency != null) v.llSender = !!r.lowLatency;
      return drvResult(true, { values: v, notes: notes, mixed: [] });
    });
  },
  // One low-latency switch on COEX (PUT screen/mode {lowLatency}): no separate receiving-card switch, no layout check.
  lowLatency: function (d, which, on) {
    if (which !== 'sender') return DRV.unsupported('A separate receiving-card switch');
    return DRV.post('coex', '/api/coex/screen', { host: d.hw.host, port: d.hw.port, action: 'lowlatency', value: !!on }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? 'Low latency ' + (on ? 'on' : 'off') : 'Low latency refused: ' + r.error });
    });
  },
  presets: function (d) {
    return DRV.post('coex', '/api/coex/presets', { host: d.hw.host, port: d.hw.port }).then(function (r) { return drvResult(r.ok, { presets: r.presets || [], error: r.error }); });
  },
  presetSave: function (d, name, flags) {
    return DRV.post('coex', '/api/coex/preset-save', { host: d.hw.host, port: d.hw.port, name: name, flags: flags }).then(function (r) { return drvResult(r.ok, { slot: r.slot, error: r.error }); });
  },
  presetApply: function (d, p) {
    return DRV.post('coex', '/api/coex/preset-apply', { host: d.hw.host, port: d.hw.port, id: p.id, slot: p.slot }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  // Brightness schedules on the controller (screen/schedule/*, [R] on the emulator incl. the Schedule switch).
  schedules: function (d) {
    return DRV.post('coex', '/api/coex/schedules', { host: d.hw.host, port: d.hw.port }).then(function (r) { return drvResult(r.ok, { enable: r.enable, brightness: r.brightness || [], presetCount: r.presetCount, diagnosticsCount: r.diagnosticsCount, error: r.error }); });
  },
  scheduleAdd: function (d, e) {
    return DRV.post('coex', '/api/coex/schedule-add', { host: d.hw.host, port: d.hw.port, start: e.start, end: e.end, brightness: e.brightness, repeat: e.repeat }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  scheduleDelete: function (d, id) {
    return DRV.post('coex', '/api/coex/schedule-delete', { host: d.hw.host, port: d.hw.port, id: id }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  scheduleEnable: function (d, on) {
    return DRV.post('coex', '/api/coex/schedule-enable', { host: d.hw.host, port: d.hw.port, enable: !!on }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  presetDelete: function (d, p) {
    return DRV.post('coex', '/api/coex/preset-delete', { host: d.hw.host, port: d.hw.port, slot: p.slot }).then(function (r) { return drvResult(r.ok, { error: r.error }); });
  },
  readBackup: function (d) {   // the port backup pairs on the processor: [[card, masterPort, backupPort]] (card = its own, 0…)
    return DRV.post('coex', '/api/coex/read-backup', { host: d.hw.host, port: d.hw.port }).then(function (r) { return drvResult(r.ok, { pairs: r.pairs || [], error: r.error }); });
  },
  // Backup verify: POST device/backup/verify verifyType 2 (backup only) / 0 (normal) [R].
  verifyBackup: function (d, mode) {
    if (mode === 'primary') return DRV.unsupported('Showing the primary ports only');
    return DRV.post('coex', '/api/coex/verify', { host: d.hw.host, port: d.hw.port, type: mode === 'backup' ? 2 : 0 }).then(function (r) {
      return drvResult(r.ok, { error: r.error, text: r.ok ? (mode === 'backup' ? 'Showing the backup ports' : 'Backup back to normal') : 'Failed: ' + r.error });
    });
  },
  // Device info (read-only): identity, firmware, output cards, inputs with signal, the VMP lock.
  deviceInfo: function (d) {
    return DRV.post('coex', '/api/coex/info', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error });
      var i = r.info, cap = i.capability || {};
      return drvResult(true, { rows: [['Name', i.customName || i.name], ['Model', i.name + ' (' + i.modelId + ')'], ['Serial', i.sn], ['MAC', i.mac], ['Firmware', i.version],
        ['Output cards', i.cards.map(function (c) { return c.name + ' · ' + c.ports.length + ' ports'; }).join('; ')],
        ['Max capacity', cap.maxCapacity ? cap.maxCapacity.toLocaleString('en-US') + ' px' : '—'], ['Low latency', cap.lowLatency ? 'supported' : 'no'],
        ['Lock', i.locked ? 'locked by ' + (i.lockedBy || 'another app') + ' — writes may be refused' : 'not locked']],
        inputs: i.inputs.map(function (x) { return { name: x.name, signal: x.signal, text: x.signal ? x.width + '×' + x.height + ' @ ' + x.rate + ' Hz' : 'no signal' }; }) });
    }).then(function (res) {   // richer: every input source with its EDID (read-only); falls back to the list above
      if (!res.ok) return res;
      return DRV.post('coex', '/api/coex/inputs', { host: d.hw.host, port: d.hw.port }).then(function (x) {
        if (x.ok && (x.inputs || []).length) res.inputs = x.inputs.map(DRV.inputRow); return res;
      }, function () { return res; });
    });
  },
  monitor: function (d) {
    return DRV.post('coex', '/api/coex/health', { host: d.hw.host, port: d.hw.port }).then(function (r) {
      return r.ok ? drvResult(true, { health: r.health }) : drvResult(false, { error: r.error || 'health failed' });
    });
  },
  // The user's Clear (Monitor): VMP's packet-loss clear, DELETE device/cabinet/errorbit {idList} [R, VMP_TOUR: all cabinets;
  // one cabinet = the same call with one id]. targets = null (every placed cabinet) or [{card, port, index}]. No save.
  clearErrors: function (d, targets) {
    return DRV.post('coex', '/api/coex/ber-clear', { host: d.hw.host, port: d.hw.port, targets: targets }).then(function (r) {
      return drvResult(r.ok, { hw: true, error: r.error, text: r.ok ? 'packet-loss counters cleared on ' + r.cabinets + ' cabinet' + (r.cabinets === 1 ? '' : 's') + ' (DELETE device/cabinet/errorbit)' : 'clear failed: ' + r.error });
    });
  },
  // Correction tab (app-correction.js, helper /api/hw/calib): read only — device/cabinet/displayparams' correction switches
  // and baseinfo's functionTable.moduleFlash per cabinet [R, VMP taps]. VMP's calibration switch (correctionop/cabinets/
  // correction/switches) was only seen live for Magic Gray, so the switch stays off until it is captured.
  correctionCaps: function () { return { read: true, modes: null, modesWhy: 'Not confirmed yet: VMP’s calibration switch hasn’t been captured live' }; },
  correction: function (d, op) {
    if (op !== 'read') return DRV.unsupported('That correction step');
    return DRV.post('coex', '/api/hw/calib', { kind: 'coex', host: d.hw.host, port: d.hw.port, op: 'read' }).then(function (r) {
      return r.ok ? drvResult(true, { cabinets: r.cabinets || [] }) : drvResult(false, { error: r.error || 'read failed' });
    });
  }
};
DRV.register('coex', DRV_COEX);
