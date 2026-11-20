// drv-offline.js - a simulated processor (no hardware). In an offline project every processor is simulated by itself
// (simEnsure, before each render: no Link step; user, 2026-10-28: "off-line mode should let me do pretty much everything
// you can do in normal mode, including calibration"); in an online project a processor can still be linked to it by hand
// (Hardware ▸ Simulate). It offers what the real driver of its model offers (same caps, same buttons, same option lists) and
// answers from an in-memory processor kept per processor for this session (DRV_OFFLINE.st, never stored, never sent):
//   - detect / identify / read-back: exactly the panels and backup pairs the project places (so placed / detected match);
//     Send checks the layout the way the real driver would (the LCT plan or the Unico layout) without sending anything.
//   - Monitor: every port fine, temperatures and supply voltages that vary smoothly over the wall (the heat map shows a
//     believable picture) and drift slowly; one cabinet per processor starts with a few bit errors that stay until Clear.
//   - Screen settings, calibration (switch, reset, reload, save to cards, flash check, load from modules), presets,
//     schedules, backup Send / verify, service: they change the in-memory state and answer like the real ones.
// Every text says "Simulated"; nothing goes to the helper (no DRV.post), so the alpha's read-only gate never sees it.
// Owns: DRV_OFFLINE, simEnsure, simLink, simFamily.
// Depends on: drv-core (DRV, drvResult), app-core (P), app-log (log), app-processors (cardsOfDevice, procFamily, procModel,
// procUnset, cardName, OUTPUT_CARDS), app-hardware (hw, hwPortCells, hwPairs, hwSendModel, hwDetect), app-online (olMode), unicosend.js
// (UNICOSEND), app-display (renderDisplayBar), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// The family of the real processor a simulated one stands for ('lct' | 'unico' | 'coex').
function simFamily(d) { return procFamily(procModel(d && d.model)); }
function simLink(d) { return { kind: 'offline', host: 'simulated', port: 0, sn: '', name: 'Simulated ' + procModel(d.model).name, modelId: procModel(d.model).modelId, senders: [] }; }
// Offline project: every processor with a model and no link is simulated (detected once, quietly). Runs before each render.
function simEnsure() {
  if (typeof olMode !== 'function' || olMode() !== 'offline') return;
  var made = 0;
  (P.devices || []).forEach(function (d) {
    if (d.hw || procUnset(d)) return;
    d.hw = simLink(d); made++;
    log('hw_simulate', { processor: d.name, auto: true });
    setTimeout(function () { if (d.hw && d.hw.kind === 'offline' && typeof hwDetect === 'function') hwDetect(d, true); }, 0);
  });
  if (made && typeof renderDisplayBar === 'function') setTimeout(renderDisplayBar, 0);   // Blackout / Freeze / Normal: something to show on now
}

var DRV_OFFLINE = {
  liveMs: 4000,
  st: {},   // st[device id] = the simulated processor's state (this session only)
  real: function (d) { var r = d && DRV.families[simFamily(d)]; return r && r !== DRV_OFFLINE ? r : null; },
  // Whatever the real driver of this model offers (so every tab looks the same), simulated; edits go out with Send.
  caps: function (d) {
    var real = DRV_OFFLINE.real(d), rc = real && real.caps ? real.caps(d) : {}, c = {};
    for (var k in rc) c[k] = rc[k];
    c.link = true; c.detect = true; c.send = true; c.monitor = true; c.save = true; c.display = true; c.patterns = true; c.mapping = true;
    c.live = true; c.applyMode = 'send'; c.simulated = true;   // live = re-detect every few seconds (in memory)
    return c;
  },
  // A small stable number 0…1 from a text (the same wall always looks the same).
  rnd: function (s) {
    var x = 0x811c9dc5; s = String(s); for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193); }
    x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;   // mixed, so near texts differ
    return (x >>> 0) / 4294967296;
  },
  state: function (d) {
    var s = DRV_OFFLINE.st[d.id];
    if (!s) s = DRV_OFFLINE.st[d.id] = { t0: Date.now(), color: { brightness: 100, gamma: 2.8, colorTemp: 6500, gamut: simFamily(d) === 'lct' ? 'original' : 'rec709', llSender: false, llRx: false },
      cor: {}, presets: [], slot: 0, sched: { enable: false, list: [], id: 0 }, backup: null, ber: null, display: 'normal' };
    return s;
  },
  // Each cabinet of d as placed: [{card (on the link), port, index, c (the project's cell)}].
  cabs: function (d) {
    var by = hwPortCells(), out = [];
    cardsOfDevice(d).forEach(function (card, ci) {
      Object.keys(by).forEach(function (k) {
        var sp = k.split(':'); if (+sp[0] !== card) return;
        by[k].forEach(function (c, i) { out.push({ card: ci, port: +sp[1], index: i, c: c }); });
      });
    });
    return out;
  },
  key: function (t) { return t.card + ':' + t.port + ':' + t.index; },
  ok: function (text, extra) { var r = drvResult(true, extra || {}); r.text = 'Simulated: ' + text + ' — nothing sent'; return Promise.resolve(r); },
  where: function (targets) { return targets ? targets.length + ' cabinet' + (targets.length === 1 ? '' : 's') : 'everything'; },
  // ---------------------------------------------------------------- layout
  detect: function (d) {
    var out = cardsOfDevice(d).map(function () { return { ports: {} }; });
    DRV_OFFLINE.cabs(d).forEach(function (x) { (out[x.card].ports[x.port] || (out[x.card].ports[x.port] = [])).push({ w: x.c.width, h: x.c.height, name: 'simulated' }); });
    return Promise.resolve(drvResult(true, { cards: out }));
  },
  identify: function (d) {
    return Promise.resolve(drvResult(true, { cards: DRV_OFFLINE.cabs(d).map(function (x) { return { dst: x.card, port: x.port, index: x.index, id: { w: x.c.width, h: x.c.height, simulated: true } }; }) }));
  },
  // What the processor holds = what the project places (Compare shows it the same; Read layout changes nothing).
  readLayout: function (d) {
    return Promise.resolve(drvResult(true, { simulated: true, cabinets: DRV_OFFLINE.cabs(d).map(function (x) { return { card: x.card, port: x.port, index: x.index, x: x.c.x, y: x.c.y, w: x.c.width, h: x.c.height }; }) }));
  },
  readBackup: function (d) {
    var s = DRV_OFFLINE.state(d), pairs = s.backup || hwPairs(d);
    return Promise.resolve(drvResult(true, { pairs: pairs.map(function (q) { return [q.ps, q.pp, q.bs, q.bp]; }), roles: [] }));
  },
  planSend: function (d) {
    var fam = simFamily(d), n = 0, model = hwSendModel(d);
    try {
      if (fam === 'unico') n = UNICOSEND.buildLayout(model).cabinets.length;
      else model.screens.forEach(function (s) { n += s.cells.length; });
    } catch (e) { return drvResult(false, { error: e.message }); }
    return drvResult(true, { payload: model, count: n, confirm: null });
  },
  // Send backup (NovaLCT's redundancy Send, where the real model has it): the pairs only.
  planBackup: function (d, o) {
    var pairs = (o && o.pairs) || [];
    return drvResult(true, { payload: { sim: 'backup', pairs: pairs.map(function (q) { return { ps: q.ps, pp: q.pp, bs: q.bs, bp: q.bp }; }) }, count: 0, pairs: pairs.length, kind: 'port' });
  },
  send: function (d, plan) {
    var s = DRV_OFFLINE.state(d), p = plan.payload || {};
    if (p.sim === 'backup') {
      s.backup = p.pairs;
      return Promise.resolve(drvResult(true, { frames: 0, count: 0, warnings: [], text: 'Simulated: backup ' + (p.pairs.length ? p.pairs.length + ' pair' + (p.pairs.length === 1 ? '' : 's') : 'cleared') + ' — nothing sent' }));
    }
    s.backup = hwPairs(d).map(function (q) { return { ps: q.ps, pp: q.pp, bs: q.bs, bp: q.bp }; });   // a layout Send carries the pairs too
    return Promise.resolve(drvResult(true, { count: plan.count, frames: 0, warnings: [], text: 'Simulated: ' + plan.count + ' cabinets checked — nothing was sent (no hardware)' }));
  },
  save: function (d) { DRV_OFFLINE.state(d).saved = Date.now(); return Promise.resolve(drvResult(true, { frames: 0, text: 'Simulated Save — nothing was stored (no hardware)' })); },
  // ---------------------------------------------------------------- show / test
  display: function (d, mode, targets) { DRV_OFFLINE.state(d).display = mode; return DRV_OFFLINE.ok(mode + ' on ' + DRV_OFFLINE.where(targets), { writes: 0 }); },
  pattern: function (d, code, targets) {
    var real = DRV_OFFLINE.real(d);
    if (real && real.CODES && !real.CODES[code]) return DRV.unsupported('That test pattern');
    return DRV_OFFLINE.ok('test pattern ' + code + ' on ' + DRV_OFFLINE.where(targets), { writes: 0 });
  },
  mapping: function (d, on) { return DRV_OFFLINE.ok('mapping ' + (on ? 'on' : 'off'), { writes: 0 }); },
  verifyBackup: function (d, mode) {
    var v = DRV_OFFLINE.caps(d).verify || {};
    if (mode !== 'normal' && !v[mode]) return DRV.unsupported(mode === 'primary' ? 'Showing the primary ports only' : 'Backup verify');
    if (mode === 'backup' && simFamily(d) === 'lct' && !hwPairs(d).length) return Promise.resolve(drvResult(false, { error: 'no port backup pairs on this processor' }));
    DRV_OFFLINE.state(d).verify = mode;
    return DRV_OFFLINE.ok(mode === 'backup' ? 'showing the backup ports' : mode === 'primary' ? 'showing the primary ports' : 'backup back to normal');
  },
  // ---------------------------------------------------------------- screen settings
  ACTS: { brightness: 'brightness', gamma: 'gamma', colortemp: 'colorTemp', gamut: 'gamut', bitdepth: 'bitDepth' },
  screenSet: function (d, action, value) {
    var k = DRV_OFFLINE.ACTS[action], col = DRV_OFFLINE.caps(d).color || {};
    if (!k || !col[k]) return DRV.unsupported('That setting');
    if (k === 'gamut' && col.gamuts && col.gamuts.indexOf(value) < 0 && !gmEntry(value)) return DRV.unsupported('That colour space on a NovaLCT processor');
    if (k === 'gamma' && simFamily(d) === 'lct' && (P.bitDepth || 8) !== 8) return DRV.unsupported('Gamma on NovaLCT processors with a ' + P.bitDepth + '-bit source (confirmed for 8-bit only)');
    if (k === 'colorTemp' && simFamily(d) === 'lct') value = Math.max(1700, Math.min(9900, Math.round(value / 100) * 100));
    DRV_OFFLINE.state(d).color[k] = value;
    return DRV_OFFLINE.ok(action + ' ' + value, { writes: 0 });
  },
  lutApply: function (d, ports, fit) { DRV_OFFLINE.state(d).color.gamut = fit.matrix ? 'custom' : 'original'; return DRV_OFFLINE.ok('LUT', { writes: 0 }); },
  lowLatency: function (d, which, on) {
    var c = DRV_OFFLINE.caps(d);
    if (!c.lowLatency || (which !== 'sender' && c.lowLatencyOne)) return DRV.unsupported('A separate receiving-card switch');
    DRV_OFFLINE.state(d).color[which === 'sender' ? 'llSender' : 'llRx'] = !!on;
    return DRV_OFFLINE.ok('low latency (' + (which === 'sender' ? 'processor' : 'receiving cards') + ') ' + (on ? 'on' : 'off'), { writes: 0 });
  },
  readColor: function (d) {
    var s = DRV_OFFLINE.state(d), c = s.color, v = { brightness: c.brightness, gamma: c.gamma, colorTemp: c.colorTemp, gamut: c.gamut };
    if ((DRV_OFFLINE.caps(d).color || {}).bitDepth) v.bitDepth = P.bitDepth || 8;
    if (DRV_OFFLINE.caps(d).lowLatencyOne) v.llSender = c.llSender;
    return Promise.resolve(drvResult(true, { values: v, notes: {}, mixed: [], simulated: true }));
  },
  // ---------------------------------------------------------------- device info / service
  INPUTS: { unico: ['HDMI 2.0', 'DP 1.2', '12G-SDI'], coex: ['HDMI 2.0-1', 'HDMI 2.0-2', 'DP 1.4', '12G-SDI'] },
  deviceInfo: function (d) {
    var m = procModel(d.model), fam = simFamily(d), cards = cardsOfDevice(d), sn = 'SIM-' + d.id.slice(-6).toUpperCase(), rows;
    if (fam === 'lct') rows = [['Link', 'Simulated (no hardware)'], m.kind === 'chassis' ? ['Sending cards', cards.map(function (c, k) { return (k + 1) + ': ' + ((OUTPUT_CARDS[P.processors[c].type] || {}).name || cardName(c)); }).join('; ')] : ['Model', m.name]];
    else if (fam === 'unico') rows = [['Name', m.name], ['Model ID', m.modelId], ['Serial', sn], ['Firmware', 'simulated'], ['MAC / IP', 'simulated'], ['Ports', P.processors[cards[0]] ? P.processors[cards[0]].ports : 0],
      ['Placed cabinets', DRV_OFFLINE.cabs(d).length], ['State', 'ready (simulated)']];
    else rows = [['Name', m.name], ['Model', m.name + ' (' + m.modelId + ')'], ['Serial', sn], ['MAC', 'simulated'], ['Firmware', 'simulated'],
      ['Output cards', cards.map(function (c) { return cardName(c) + ' · ' + P.processors[c].ports + ' ports'; }).join('; ')], ['Lock', 'not locked']];
    var inputs = (DRV_OFFLINE.INPUTS[fam] || []).map(function (n, i) { return { name: n, signal: i === 0, text: i === 0 ? P.canvasW + '×' + P.canvasH + ' @ ' + (P.refresh || 60) + ' Hz (simulated)' : 'no signal' }; });
    return Promise.resolve(drvResult(true, { rows: rows, inputs: inputs, simulated: true }));
  },
  restart: function () { return DRV_OFFLINE.ok('restart'); },
  factoryReset: function (d) { var keep = DRV_OFFLINE.st[d.id] && DRV_OFFLINE.st[d.id].ber; delete DRV_OFFLINE.st[d.id]; DRV_OFFLINE.state(d).ber = keep; return DRV_OFFLINE.ok('factory reset'); },
  restartPanels: function (d, targets) { var n = targets && targets.length; return DRV_OFFLINE.ok(n ? n + ' cabinet' + (n === 1 ? '' : 's') + ' restarted' : 'cabinets restarted'); },
  sendRcvFile: function (d, o) { return DRV_OFFLINE.ok((o.kind === 'ncp' ? 'NCP' : '.rcfgx') + ' “' + o.name + '” to ' + (o.targets || []).length + ' target(s)'); },
  // ---------------------------------------------------------------- monitor
  // Temperature and supply voltage as smooth functions of the cabinet's place (the same for every processor, so a wall
  // spread over several is one picture) with a slow drift; status as the real readers give it.
  monitor: function (d) {
    var s = DRV_OFFLINE.state(d), fam = simFamily(d), cabs = DRV_OFFLINE.cabs(d), t = (Date.now() - s.t0) / 1000, ports = [], seen = {};
    if (!s.ber) {   // a few bit errors on one cabinet: kept until the user's Clear (they never clear by themselves)
      s.ber = {}; var pick = cabs[Math.floor(cabs.length * 0.6)]; if (pick) s.ber[DRV_OFFLINE.key(pick)] = 3 + Math.round(DRV_OFFLINE.rnd(d.id) * 20);
    }
    var pairs = hwPairs(d);
    var cabinets = cabs.map(function (x) {
      var c = x.c, cx = c.x + c.width / 2, cy = c.y + c.height / 2, n = DRV_OFFLINE.rnd(d.id + DRV_OFFLINE.key(x)) - 0.5, k = x.card + ':' + x.port;
      if (!seen[k]) ports.push(seen[k] = { card: x.card, port: x.port, link: pairs.some(function (q) { return q.ps === x.card && q.pp === x.port; }) ? 'redundant, ok' : 'ok', cabinets: 0 });
      seen[k].cabinets++;
      var temp = 36 + 4.5 * Math.sin(cx / 1400 + 0.7) * Math.cos(cy / 1100) + 3 * Math.max(0, 1 - cy / 2400) + 1.2 * Math.sin(t / 240 + cx / 3000) + n * 0.8;
      var volt = 5 + 0.05 * Math.sin(cx / 900 + cy / 700) - 0.03 * Math.max(0, 1 - cy / 2400) + n * 0.02;
      var o = { card: x.card, port: x.port, index: x.index, side: 'primary', dark: false, temp: Math.round(temp * 10) / 10, tempStatus: 'ok', voltage: Math.round(volt * 100) / 100, voltStatus: 'ok',
        bitErrors: s.ber[DRV_OFFLINE.key(x)] || 0 };
      if (fam === 'lct') { o.psu = [1, 1]; o.berEnabled = true; o.disconnects = 0; }
      return o;
    });
    var h = { at: Date.now(), ports: ports, cabinets: cabinets, events: [], simulated: true, extras: fam === 'lct' };
    if (fam !== 'lct') h.device = { temp: Math.round((41 + Math.sin(t / 300)) * 10) / 10, voltage: 12.1, fans: [] };
    return Promise.resolve(drvResult(true, { health: h }));
  },
  clearErrors: function (d, targets) {
    var s = DRV_OFFLINE.state(d), n = 0;
    Object.keys(s.ber || {}).forEach(function (k) { if (!targets || targets.some(function (t) { return DRV_OFFLINE.key(t) === k; })) { delete s.ber[k]; n++; } });
    return Promise.resolve(drvResult(true, { hw: true, written: n, text: 'simulated: bit-error counters cleared (' + (targets ? targets.length + ' cabinet' + (targets.length === 1 ? '' : 's') : 'all cabinets') + ') — nothing sent' }));
  },
  // ---------------------------------------------------------------- calibration (Correction tab)
  // The real model's buttons (NovaLCT: switch, reset, reload, save to cards, module flash; Unico: switch; COEX: read only).
  // Each cabinet: mode (off / brightness / chroma: per port, as the switch goes), coef in working memory and stored
  // (calibrated, or flat on the odd spare cabinet), module flash.
  correctionCaps: function (d) { var r = DRV_OFFLINE.real(d); return r && r.correctionCaps ? r.correctionCaps(d) : null; },
  corCab: function (d, t) {
    var s = DRV_OFFLINE.state(d), k = DRV_OFFLINE.key(t), x = s.cor[k];
    if (!x) {
      var r = DRV_OFFLINE.rnd(d.id + '|port ' + t.card + ':' + t.port), coef = DRV_OFFLINE.rnd(k + '|' + d.id) < 0.1 ? 'flat' : 'calibrated';
      x = s.cor[k] = { mode: r < 0.08 ? 'off' : r < 0.3 ? 'brightness' : 'chroma', coef: coef, stored: coef, moduleFlash: DRV_OFFLINE.rnd('m' + k + d.id) < 0.6 };
    }
    return x;
  },
  correction: function (d, op, o) {
    var k = DRV_OFFLINE.correctionCaps(d) || {}, fam = simFamily(d), tg = (o && o.targets) || [];
    var need = { read: 'read', 'switch': 'modes', reset: 'reset', reload: 'reload', save: 'save', module: 'module', flashcheck: 'flashCheck' }[op];
    if (!need || !k[need]) return DRV.unsupported('That correction step');
    var cabs = tg.map(function (t) { return { t: t, x: DRV_OFFLINE.corCab(d, t) }; });
    if (op === 'switch') cabs.forEach(function (c) { c.x.mode = o.mode; });
    else if (op === 'reset') cabs.forEach(function (c) { c.x.coef = 'flat'; });
    else if (op === 'reload') cabs.forEach(function (c) { c.x.coef = c.x.stored; });
    else if (op === 'save') cabs.forEach(function (c) { c.x.stored = c.x.coef; });
    else if (op === 'module') cabs.forEach(function (c) { if (c.x.moduleFlash) c.x.coef = 'calibrated'; });
    var out = cabs.map(function (c) {
      var r = { card: c.t.card, port: c.t.port, index: c.t.index, mode: c.x.mode };
      if (fam === 'lct') r.coef = c.x.coef;
      if (fam !== 'unico') r.moduleFlash = c.x.moduleFlash;
      if (op === 'flashcheck') { r.modules = 4; r.bad = []; }
      return r;
    });
    return Promise.resolve(drvResult(true, { simulated: true, writes: op === 'read' || op === 'flashcheck' ? 0 : cabs.length, cabinets: out }));
  },
  // ---------------------------------------------------------------- presets and schedules (where the real model has them)
  presets: function (d) { return Promise.resolve(drvResult(true, { presets: DRV_OFFLINE.state(d).presets.map(function (p) { var c = {}; for (var k in p) c[k] = p[k]; return c; }) })); },
  presetSave: function (d, name, flags) {
    var s = DRV_OFFLINE.state(d), slot = ++s.slot, f = flags ? { sourceData: !!flags.source, processingData: !!flags.processing, outputData: !!flags.output, screenData: !!flags.layout } : null;
    s.presets.push({ id: 'sim' + slot, slot: slot, name: name, flags: f, active: false });
    return Promise.resolve(drvResult(true, { slot: slot }));
  },
  presetApply: function (d, p) { DRV_OFFLINE.state(d).presets.forEach(function (q) { q.active = q.slot === p.slot; }); return Promise.resolve(drvResult(true, {})); },
  presetRename: function (d, p, name) { DRV_OFFLINE.state(d).presets.forEach(function (q) { if (q.slot === p.slot) q.name = name; }); return Promise.resolve(drvResult(true, {})); },
  presetDelete: function (d, p) { var s = DRV_OFFLINE.state(d); s.presets = s.presets.filter(function (q) { return q.slot !== p.slot; }); return Promise.resolve(drvResult(true, {})); },
  schedules: function (d) { var c = DRV_OFFLINE.state(d).sched; return Promise.resolve(drvResult(true, { enable: c.enable, brightness: c.list.slice() })); },
  scheduleAdd: function (d, e) { var c = DRV_OFFLINE.state(d).sched; c.list.push({ id: 'sim' + (++c.id), start: e.start, end: e.end, brightness: e.brightness, repeat: e.repeat || [] }); return Promise.resolve(drvResult(true, {})); },
  scheduleDelete: function (d, id) { var c = DRV_OFFLINE.state(d).sched; c.list = c.list.filter(function (q) { return String(q.id) !== String(id); }); return Promise.resolve(drvResult(true, {})); },
  scheduleEnable: function (d, on) { DRV_OFFLINE.state(d).sched.enable = !!on; return Promise.resolve(drvResult(true, {})); }
};
DRV.register('offline', DRV_OFFLINE);
