// app-support.js - Tools ▸ Support bundle (design P13): one .zip with everything needed to understand a problem later —
// the project, this browser's log, the server's log, the helper's newest logs and versions, and per linked processor a
// read-only read-back (device info, detected panels, live health, the layout it has placed, its backup pairs), this helper
// run's diagnostics recording (tools/wirelog.py), the helper call journal, the Monitor events and the last pre-show check.
// Nothing is written to any processor; no password, token or login goes in (supScrub, on top of the recorder's own rule).
// Owns: SUP_CRC, supCrc32, supZip, supScrub, supGather, supportBundle, bindSupport.
// Depends on: app-core (P, ui, $, toast, snapshot), app-log (log, logState), drv-core (DRV), app-hardware (hw),
// app-health (hlt), app-preshow (pre), app-watch (watch), app-processors (deviceLabel, procModel), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var SUP_CRC = null;
function supCrc32(b) {
  if (!SUP_CRC) { SUP_CRC = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; SUP_CRC[n] = c >>> 0; } }
  var crc = 0xFFFFFFFF; for (var i = 0; i < b.length; i++) crc = SUP_CRC[(crc ^ b[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// A plain ZIP (stored, no compression) of [{name, text}] -> Blob. Enough for text files; every unzip tool opens it.
function supZip(files) {
  var enc = new TextEncoder(), parts = [], central = [], off = 0, now = new Date();
  var dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF,
    dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
  files.forEach(function (f) {
    var name = enc.encode(f.name), data = enc.encode(f.text), crc = supCrc32(data);
    var h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, data);
    var c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, off, true);
    central.push(c.buffer, name);
    off += 30 + name.length + data.length;
  });
  var csize = central.reduce(function (n, x) { return n + (x.byteLength || x.length); }, 0);
  var e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob(parts.concat(central, [e.buffer]), { type: 'application/zip' });
}
// Passwords, tokens and logins never go into a bundle: "password": "…" (also inside a recorded body) becomes "<hidden>".
function supScrub(t) {
  return String(t).replace(/(\\?"(?:password|passwd|pwd|token|authorization|secret|unlockCode)\\?"\s*:\s*\\?")[^"]*?(\\?")/gi, '$1<hidden>$2');
}
// What the browser side knows, gathered read-only, as [{name, text}] (+ reads: per processor id the read-backs, for the
// problem report's summary, app-alpha.js). o: project, logs, state (default on), helper (the helper's logs and this run's
// recordings — the problem report has the helper add those itself), readbacks (device info, layout, backup per linked
// processor), identify (receiving cards with firmware, read card by card: slower).
function supGather(o) {
  o = o || {};
  var on = function (k) { return o[k] !== false; };
  var J = function (x) { return JSON.stringify(x, null, 1); }, files = [], reads = {}, when = new Date();
  var safe = function (t) { return String(t || '').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'x'; };
  var wrap = function (p) { return Promise.resolve(p).then(function (r) { return r; }, function (e) { return { ok: false, error: e.message }; }); };
  var ver = typeof alpha !== 'undefined' && (alpha.st || alpha.ver) || null;
  if (on('project')) files.push({ name: 'project.json', text: (ui.lastSnap || JSON.stringify(P)) });
  if (on('logs')) files.push({ name: 'browser-log.ndjson', text: (logState.buf || []).map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join('\n') });
  if (on('state')) files.push({ name: 'state.json', text: J({ when: when.toISOString(), version: ver && { version: ver.version, build: ver.build, channel: ver.channel },
    page: location.href, browser: navigator.userAgent, screen: innerWidth + '×' + innerHeight,
    tab: ui.tab, display: typeof disp !== 'undefined' ? disp : null, busy: hw.busy, unsaved: hw.unsaved, preshow: pre.result,
    monitorSettings: typeof watch !== 'undefined' ? watch.set : null, events: hlt.log, journal: DRV.journal }) });
  var jobs = [];
  if (on('logs')) jobs.push(fetch('api/logs?lines=3000', { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : 'server log: HTTP ' + r.status; }, function (e) { return 'server log unavailable: ' + e.message; })
    .then(function (t) { files.push({ name: 'server-log.txt', text: t }); }));
  if (on('helper')) jobs.push(wrap(DRV.post('lct', '/api/hw/support', { files: 15 })).then(function (r) {
      if (!r.ok) { files.push({ name: 'helper/ERROR.txt', text: r.error || 'helper unavailable' }); return; }
      files.push({ name: 'helper/versions.json', text: J({ version: r.version, python: r.python, platform: r.platform, tools: r.tools }) });
      (r.logs || []).forEach(function (l) { files.push({ name: 'helper/logs/' + l.name, text: l.text }); });
      (r.recordings || []).forEach(function (l) {   // this helper run's diagnostics recording (tools/wirelog.py; Tools ▸ Diagnostics opens it)
        files.push({ name: 'diagnostics/' + l.name.replace(/\.gz$/, ''), text: l.text });
        if (l.cut) files.push({ name: 'diagnostics/' + l.name.replace(/\.gz$/, '') + '.CUT.txt', text: 'Only the end of this recording is here (the whole file is ' + l.n + ' bytes, in the helper’s diagnostics folder).' });
      });
      if (r.recorder) files.push({ name: 'diagnostics/recorder-status.json', text: J(r.recorder) });
    }));
  if (on('readbacks')) (P.devices || []).forEach(function (d, i) {
    var x = DRV.of(d), base = 'processors/' + (i + 1) + '-' + safe(deviceLabel(d)) + '/', got = reads[d.id] = {};
    files.push({ name: base + 'project.json', text: J({ device: d, model: procModel(d.model), detected: hw.live[d.id] || null, health: hlt.by[d.id] || null, info: hw.info && hw.info[d.id] || null }) });
    if (!d.hw) return;
    // read-only read-backs, each on its own (one failing doesn't stop the others)
    var asks = [['device-info', x.deviceInfo], ['layout-on-processor', x.readLayout], ['backup-on-processor', x.readBackup]];
    if (o.identify && hw.live[d.id]) asks.push(['receiving-cards', x.identify && function (dd) { return x.identify(dd, { full: true }); }]);
    asks.forEach(function (c) {
      if (!c[1]) return;
      jobs.push(wrap(c[1].call(x, d)).then(function (r) { got[c[0]] = r; files.push({ name: base + c[0] + '.json', text: J(r) }); }));
    });
  });
  return Promise.all(jobs).then(function () { return { files: files, reads: reads, when: when }; });
}
function supportBundle() {
  if (supportBundle.busy) return toast('The support bundle is still being made');
  supportBundle.busy = true; toast('Making the support bundle (read-only)…');
  var safe = function (t) { return String(t || '').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'x'; };
  return supGather({ identify: false }).then(function (g) {
    var files = g.files, when = g.when;
    files.push({ name: 'README.txt', text: 'Open Nova support bundle — ' + when.toString() + (typeof alphaVersionText === 'function' ? '\n' + alphaVersionText() : '') + '\n\n' +
      'project.json          the project as it was\nstate.json            display / busy / unsaved state, Monitor events, helper call journal, last pre-show check\n' +
      'browser-log.ndjson    this browser’s log\nserver-log.txt        the app server’s log\nhelper/               the hardware helper’s newest logs and file versions\n' +
      'diagnostics/          every byte exchanged with the processors since the helper started (open it in Tools ▸ Diagnostics)\n' +
      'processors/           per processor: the project’s view, and what was read back from it (read-only)\n' });
    files.forEach(function (f) { f.text = supScrub(f.text); });   // never a login: belt and braces (the recorder and logs already leave them out)
    var name = 'OpenNova-support-' + safe(P.name) + '-' + when.toISOString().slice(0, 16).replace(/[:T]/g, '') + '.zip';
    var a = document.createElement('a'); a.href = URL.createObjectURL(supZip(files)); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    log('support_bundle', { file: name, files: files.length });
    toast('Support bundle saved: ' + name + ' (' + files.length + ' files)');
  }).catch(function (e) { toast('Support bundle failed: ' + e.message); })
    .then(function () { supportBundle.busy = false; });
}
function bindSupport() { var b = $('btnSupport'); if (b) b.onclick = supportBundle; }
