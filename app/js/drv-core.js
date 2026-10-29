// drv-core.js - the driver layer (docs/OPEN_NOVA_DESIGN.md §3): one interface for every kind of processor,
// so the tabs never care how a processor is reached. A driver is picked automatically — never asked of the
// user and never shown — from the link (d.hw.kind, set by discovery) or else the model (procFamily):
//   lct     NovaLCT-protocol senders (MCTRL, NovaPro, VX classic, H …) through tools\novalink.py   (drv-lct.js)
//   unico   VX Pro / HC20 Pro through UServer's REST API (tools\unicolink.py)                      (drv-unico.js)
//   coex    MX through XCenter / NeoController REST — not linked yet (design phase 7)              (drv-coex.js)
//   offline a simulated processor: no hardware, "detects" what the project places                   (drv-offline.js)
// Every method returns a Promise and never throws for a device problem: failures come back as
// { ok: false, error, unsupported? }; internal: true = a bug, not the processor (DRV.internal, the 'internal' event).
// Every helper call goes into DRV.journal (last 500) and the 'journal' event.
// Driver methods (missing = unsupported): caps(d) -> {link, detect, live, send, monitor, simulate};
//   discover({timeout}) -> [found{kind, ip, port, deviceName, modelId, SN, senders?}];
//   detect(d, {auto, known, pairs}) -> {ok, cards:[{ports:{p:[{w,h,name}]}, error?}]};
//   planSend(d, {dry, pairs}) -> {ok, confirm, payload, summary} | {ok:false, error};
//   planBackup(d, {pairs, prev}) -> {ok, payload, pairs, kind} (caps.backupSend: the port backup alone, NovaLCT's redundancy Send);
//   send(d, plan, dry) -> {ok, text, warnings, log, count};
//   monitor(d, {known, pairs}) -> {ok, health};   clearErrors(d, targets|null) -> {ok, hw (written to the processor), text};
//   save(d) -> {ok, text} (the ONLY persist path, never inside send);
//   readLayout(d) -> {ok, cabinets:[{port, index, x, y, w, h}]};   liveMs = pause between live checks;
//   caps.applyMode 'send' (explicit Send) | 'live' (edits applied as they happen, like Unico / VMP).
//   display(d, 'normal'|'blackout'|'freeze', targets) / pattern(d, code, targets) / mapping(d, on) -> {ok, text, writes};
//   targets = null (everything) or [{card (0… on the link), port, index (cable position)}].
// Owns: DRV, drvResult.
// Depends on: app-core (P), app-log (log, logAct, logActBody), app-processors (procFamily, procModel), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

function drvResult(ok, extra) { var r = { ok: !!ok }; for (var k in extra || {}) r[k] = extra[k]; return r; }

var DRV = {
  // The app's own server passes /api/hw|unico|coex/* on to the helper (serve.ps1), so this works from any device that can
  // open the app; opened as a file, the helper is asked directly.
  HELPER: location.protocol === 'file:' || !location.hostname ? 'http://127.0.0.1:8790' : location.origin,
  families: {},
  journal: [],
  listeners: {},
  register: function (family, impl) { impl.family = family; DRV.families[family] = impl; },
  // The driver for processor d: its link decides (discovery found it as that kind), else its model.
  familyOf: function (d) {
    if (d && d.hw && d.hw.kind && DRV.families[d.hw.kind]) return d.hw.kind;
    return procFamily(procModel(d && d.model));
  },
  // Never fall back to the simulated driver: a driver that didn't load must fail loudly, not pretend to send.
  of: function (d) { var f = DRV.familyOf(d); return DRV.families[f] || DRV.missing(f); },
  missing: function (f) {
    var err = function () { var r = drvResult(false, { internal: true, error: 'the ' + f + ' driver didn’t load — reload the app (see Logs)' }); DRV.internal(r, 'driver ' + f); return Promise.resolve(r); };
    return { family: f, broken: true, caps: function () { return {}; }, detect: err, send: err, save: err, monitor: err, clearErrors: err, readLayout: err, display: err, pattern: err, mapping: err, screenSet: err, lowLatency: err, verifyBackup: err,
      planSend: function () { return drvResult(false, { error: 'the ' + f + ' driver didn’t load — reload the app (see Logs)' }); } };
  },
  caps: function (d) { var x = DRV.of(d); return x.caps ? x.caps(d) : {}; },
  on: function (ev, fn) { (DRV.listeners[ev] || (DRV.listeners[ev] = [])).push(fn); },
  emit: function (ev, data) { (DRV.listeners[ev] || []).forEach(function (fn) { try { fn(data); } catch (e) { /* a listener's problem */ } }); },
  // A call to the local helper. Resolves with its JSON reply; a network failure rejects (the helper isn't running).
  // It carries the user action it belongs to (app-log.js logActBody: _action, recorded by the helper on everything it
  // does for it); a call made in an action is in the app log too (helper_call / helper_done, with the same id).
  post: function (family, path, body) {
    var t0 = Date.now(), a = typeof logAct !== 'undefined' && logAct.cur, entry = { t: new Date(t0).toISOString(), family: family, path: path };
    if (a) { entry.act = a.id; body = logActBody(body); log('helper_call', { path: path, host: body && body.host, port: body && body.port }); }
    return fetch(DRV.HELPER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); })
      .then(function (j) { entry.ok = j.ok !== false; entry.ms = Date.now() - t0; entry.error = j.error; DRV.note(entry); DRV.recWarn(j); if (j && j.internal) DRV.internal(j, path); return j; },
        function (e) { entry.ok = false; entry.ms = Date.now() - t0; entry.error = 'helper: ' + e.message; DRV.note(entry); throw e; });
  },
  note: function (entry) {
    DRV.journal.push(entry); if (DRV.journal.length > 500) DRV.journal.shift();
    if (entry.act) log('helper_done', { path: entry.path, ok: entry.ok, ms: entry.ms, error: entry.error });
    DRV.emit('journal', entry);
  },
  // An unexpected error, not a processor's answer: a helper bug (its HTTP 500 says internal, with the traceback in where)
  // or a driver result flagged internal. The 'internal' event (app-alpha.js offers a report); never throws.
  internal: function (r, path) {
    var a = typeof logAct !== 'undefined' && logAct.cur;
    DRV.emit('internal', { path: path, error: String((r && r.error) || 'internal error'), where: (r && r.where) || [], act: a ? a.id : '', what: a ? a.what : '' });
  },
  // The helper can't write its recording (disk full, folder gone …): it says so in every answer; warn once a minute.
  recWarn: function (j) {
    var w = j && j.recorderError; if (!w || Date.now() - (DRV.recWarned || 0) < 60000) return;
    DRV.recWarned = Date.now(); log('recorder_error', w);
    if (typeof toast === 'function') toast('⚠ Diagnostics can’t be written (' + w.error + ') — ' + w.held + ' records held in memory. Free some disk space.');
  },
  // Test patterns every driver understands (neutral names; each driver maps them to its own codes).
  PATTERNS: [['red', 'Red', '#e5484d'], ['green', 'Green', '#30a46c'], ['blue', 'Blue', '#3e63dd'], ['white', 'White', '#f2f2f2'],
    ['hlines', 'Horizontal lines', ''], ['vlines', 'Vertical lines', ''], ['slash', 'Slashes', ''], ['gray', 'Gray levels', ''], ['mixed', 'Mixed / ageing', '']],
  // One input row for Device info: {name, signal, text} from the helper's /inputs reply (Unico / COEX).
  inputRow: function (x) {
    var e = x.edid, edid = e && e.supported === false ? 'no EDID' : e && e.width ? 'EDID ' + e.width + '×' + e.height + (e.rate ? ' @ ' + e.rate : '') + (e.custom ? ' (custom)' : '') : '';   // SDI: no EDID
    return { name: x.name, signal: x.signal, text: (x.signal ? x.width + '×' + x.height + (x.rate ? ' @ ' + x.rate + ' Hz' : '') : 'no signal') + (edid ? ' · ' + edid : '') };
  },
  unsupported: function (what) { return Promise.resolve(drvResult(false, { unsupported: true, error: what + ' isn’t available for this processor yet' })); },
  // Every family's discovery at once, in registration order; families that fail just find nothing.
  // The list's .failed = how many families couldn't reach the helper.
  discoverAll: function (opts) {
    var fams = Object.keys(DRV.families).filter(function (f) { return DRV.families[f].discover; }), failed = 0;
    return Promise.all(fams.map(function (f) {
      return DRV.families[f].discover(opts || {}).then(function (list) { return list || []; }, function () { failed++; return []; });
    })).then(function (lists) { var all = [].concat.apply([], lists); all.failed = failed; all.tried = fams.length; return all; });
  }
};
