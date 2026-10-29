// app-vendor.js - Tools ▸ Vendor Apps: learn how NovaStar's own apps (NovaLCT, VMP, Unico) talk to processors Open Nova
// hasn't met yet (tools/vendortap.py, docs/VENDOR_CAPTURE.md). User, 2026-10-28: "what about a tool in it that will detect LCT,
// VMP and Unico to diagnose what all they send and receive from there too".
//   - On this computer: which of them are installed / running, versions, whom they talk to (read-only).
//   - Their logs: listed here; Help ▸ Report a problem has the opt-in box (vndLogsWanted remembers the choice).
//   - Wireshark capture: the filter per family and the steps; Add capture… imports a .pcap / .pcapng into the day's
//     diagnostics/<day>/vendor/ (decoded like the recorder's .nwl, the original kept) so the next report carries it.
//     With dumpcap here, Start / Stop runs it (never elevated: when it needs admin, the steps are the way).
//   - Relay (experimental — needs a live check): Open Nova stands in for the processor, passes every byte on unchanged and
//     records both directions into vendor/relay/ (opens in Tools ▸ Diagnostics).
// Owns: vnd, VND_FAM, vndPost, vndLogsWanted, vndKb, vndOpen, vndClose, vndLoad, vndRender, vndSteps, vndImport, vndCapture,
// vndRelay, vndPoll, vndBindDlg, bindVendor.
// Depends on: app-core ($, esc, toast), app-log (log), drv-core (DRV), app-rcvguard (rcvB64), app-shell (setTab),
// app-diag (dgOpen), all at run time. Builds its own dialog (#vndDlg) on first open.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var vnd = { det: null, logs: null, files: [], ifaces: null, cap: null, fam: 'lct', ip: '', iface: '', minutes: 30,
  kind: 'lct', target: '', relayIp: '', busy: '', timer: 0, open: {} };
var VND_FAM = [['lct', 'NovaLCT'], ['unico', 'Unico'], ['coex', 'VMP / COEX'], ['host', 'One processor']];

function vndPost(path, body) {   // straight to the helper (not DRV.post: nothing here writes to a processor)
  return fetch(DRV.HELPER + '/api/hw/vendor/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json(); });
}
// Help ▸ Report a problem's "NovaStar apps' logs" box starts ticked when the tester asked for it here (this browser only).
function vndLogsWanted() { try { return localStorage.getItem('on.vendorLogs') === '1'; } catch (e) { return false; } }
function vndKb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(n ? 1 : 0, Math.round(n / 1024)) + ' KB'; }

function vndOpen() {
  var d = $('vndDlg');
  if (!d) {
    d = document.createElement('div'); d.id = 'vndDlg'; d.className = 'logdlg'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Vendor apps');
    d.innerHTML = '<div class="logbox keysbox vnd-box"><div class="loghead"><b>Vendor apps</b> <span class="hint">NovaLCT · VMP · Unico</span><span class="grow"></span>' +
      '<button id="vndClose" title="Close (Esc)">×</button></div><div id="vndBody" class="keysbody"></div>' +
      '<div class="rcv-foot"><button id="vndFolder" title="Open today’s vendor folder (diagnostics/&lt;day&gt;/vendor) on the computer running Open Nova">Folder</button>' +
      '<button id="vndRefresh" title="Look again">Refresh</button><span class="grow"></span><button id="vndDone" class="primary">Close</button></div></div>';
    document.body.appendChild(d); vndBindDlg(d);
  }
  d.hidden = false; log('vendor_open', {}); vndLoad(true);
}
function vndClose() { var d = $('vndDlg'); if (d) d.hidden = true; clearTimeout(vnd.timer); }
function vndLoad(refresh) {
  vnd.busy = 'load'; vndRender();
  return Promise.all([vndPost('detect', { refresh: !!refresh }), vndPost('logs', {}), vndPost('files', {}), vndPost('capture-status', {})]).then(function (r) {
    vnd.busy = ''; vnd.det = r[0]; vnd.logs = r[1]; vnd.files = (r[2] && r[2].files) || []; vnd.cap = r[3] && r[3].capture;
    if (vnd.det && vnd.det.capture && vnd.det.capture.dumpcap && !vnd.ifaces) vndPost('interfaces', {}).then(function (x) { vnd.ifaces = x; vndRender(); });
    vndRender(); vndPoll();
  }, function (e) { vnd.busy = ''; vnd.det = { ok: false, error: e.message }; vndRender(); });
}
function vndPoll() {   // relay / capture counters while the window is open and something runs
  clearTimeout(vnd.timer);
  var d = $('vndDlg'), run = vnd.det && (vnd.det.relays || []).length || vnd.cap && vnd.cap.running;
  if (!d || d.hidden || !run) return;
  vnd.timer = setTimeout(function () {
    Promise.all([vndPost('relay-status', {}), vndPost('capture-status', {})]).then(function (r) {
      if (vnd.det) vnd.det.relays = r[0].relays || []; vnd.cap = r[1].capture; vndRender(); vndPoll();
    }, function () { vndPoll(); });
  }, 2000);
}
// The capture steps for this family on the helper's computer.
function vndSteps(filter) {
  var c = vnd.det && vnd.det.capture || {}, mac = vnd.det && vnd.det.platform === 'darwin';
  var have = c.wireshark || c.dumpcap;
  var s = [have ? 'Open Wireshark' + (mac && c.bpfReadable === false ? ' (it asks once to install ChmodBPF so it may capture — say yes)' : '') + '.'
    : 'Install Wireshark from wireshark.org' + (mac ? ' (say yes to ChmodBPF)' : ' (with Npcap)') + ', then open it.'];
  s.push('Pick the network adapter that reaches the processor (the one with the moving line). The vendor app and the processor on this computer only: the loopback adapter.');
  s.push('Paste the filter into “Enter a capture filter…” and start (the blue fin).');
  s.push('In ' + (vnd.fam === 'host' ? 'the NovaStar app' : (VND_FAM.filter(function (f) { return f[0] === vnd.fam; })[0] || [0, 'the app'])[1]) +
    ': connect to the processor and do what you want us to learn (one thing at a time is easiest to read).');
  s.push('Stop (the red square), then File ▸ Save As… (.pcapng).');
  s.push('Here: <b>Add capture…</b> — it goes into your next problem report.');
  if (mac) s.push('Without Wireshark: Terminal, <code>sudo tcpdump -i en0 -w ~/Desktop/nova.pcap \'' + esc(filter) + '\'</code>, Ctrl+C to stop (you type your own password).');
  return '<ol class="vnd-steps">' + s.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol>';
}
function vndRender() {
  var box = $('vndBody'); if (!box) return;
  var D = vnd.det, h = '';
  if (!D) { box.innerHTML = '<p class="hint">Looking…</p>'; return; }
  if (!D.ok) { box.innerHTML = '<p class="hint bk-err">The helper didn’t answer: ' + esc(D.error || '') + '</p>'; return; }
  var sec = function (id, title, sum, body) {
    return '<details class="vnd-sec" data-vsec="' + id + '"' + (vnd.open[id] ? ' open' : '') + '><summary><b>' + title + '</b>' + (sum ? ' <span class="hint">' + sum + '</span>' : '') + '</summary>' + body + '</details>';
  };
  // on this computer
  h += '<h3>On this computer' + (vnd.busy === 'load' ? ' <span class="hint">looking…</span>' : '') + '</h3>';
  if (D.apps.length) {
    h += '<table class="vnd-apps"><thead><tr><th>App</th><th>Version</th><th>Running</th><th>Talks to</th></tr></thead><tbody>' + D.apps.map(function (a) {
      return '<tr><td title="' + esc((a.about ? a.name + ': ' + a.about + '\n' : '') + (a.path || '')) + '">' + esc(a.name) + '</td><td>' + esc(a.version || '—') + '</td><td>' +
        (a.running.length ? 'yes' : a.service ? '<span class="hint">service</span>' : '<span class="hint">no</span>') + '</td><td title="' +
        esc(a.listens.length ? 'Listens on ' + a.listens.join(', ') : '') + '">' + esc(a.talksTo.join(', ') || '—') + '</td></tr>';
    }).join('') + '</tbody></table>';
  } else h += '<p class="hint">No NovaLCT, VMP or Unico found here.' + (D.note ? ' ' + esc(D.note) : '') + '</p>';
  // their logs
  var L = vnd.logs && vnd.logs.places || [], rb = 0, rn = 0;
  L.forEach(function (p) { rb += p.recentBytes; rn += p.recent; });
  h += sec('logs', 'Their logs', L.length ? rn + ' files, ' + vndKb(rb) + ' changed in the last ' + (vnd.logs.days || 3) + ' days' : 'none found',
    (L.length ? '<ul class="vnd-list">' + L.map(function (p) { return '<li title="' + esc(p.path) + '">' + esc(p.app) + ': ' + esc(p.path.split(/[\\/]/).slice(-3).join('/')) +
      ' <span class="hint">' + p.recent + ' / ' + p.files + ' files' + (p.newest ? ', newest ' + esc(p.newest) : '') + '</span></li>'; }).join('') + '</ul>' : '') +
    '<label class="chk" title="Help ▸ Report a problem then starts with “NovaStar apps’ logs” ticked (this browser). They go in capped (40 MB) with passwords and keys hidden."><input type="checkbox" id="vndLogs"' +
    (vndLogsWanted() ? ' checked' : '') + '> Add them to problem reports</label>');
  // Wireshark
  var c = D.capture || {}, f = vnd.fam === 'host' ? (vnd.ip ? 'host ' + vnd.ip : 'host <processor IP>') : D.filters[vnd.fam];
  var tools = [c.wireshark ? 'Wireshark' : '', c.dumpcap ? 'dumpcap' : '', c.tcpdump ? 'tcpdump' : ''].filter(Boolean).join(', ');
  var np = c.npcap ? (c.npcap.installed ? (c.npcap.adminOnly ? 'Npcap for admins only' : 'Npcap') : 'no Npcap') : '';
  var cap = vnd.cap && vnd.cap.running ? vnd.cap : null;
  h += sec('cap', 'Wireshark capture', (tools || 'Wireshark not found') + (np ? ' · ' + np : '') + (cap ? ' · capturing' : ''),
    '<div class="seg vnd-fam" role="group" aria-label="What to capture">' + VND_FAM.map(function (x) { return '<button type="button" data-vfam="' + x[0] + '"' + (vnd.fam === x[0] ? ' class="on"' : '') + '>' + x[1] + '</button>'; }).join('') + '</div>' +
    (vnd.fam === 'host' ? '<label class="vnd-row">Processor IP <input id="vndHostIp" type="text" spellcheck="false" placeholder="192.168.0.10" value="' + esc(vnd.ip) + '" title="Everything to and from this one processor — best for a model or feature nobody has captured yet"></label>' : '') +
    '<div class="vnd-row"><code id="vndFilter" class="vnd-filter" title="Wireshark capture filter">' + esc(f) + '</code><button type="button" class="mini" id="vndCopy" title="Copy the filter">Copy</button></div>' +
    vndSteps(f) +
    '<div class="vnd-row"><label class="btn mini" title="A Wireshark / tcpdump file (.pcapng / .pcap): kept as it is and decoded next to it, in today’s vendor folder — the next problem report carries both (each up to 16 MB)">Add capture…<input type="file" id="vndFile" accept=".pcap,.pcapng,.cap" hidden></label>' +
    (vnd.busy === 'import' ? ' <span class="hint">reading…</span>' : '') + '</div>' +
    (c.dumpcap ? '<div class="vnd-row" title="dumpcap runs as you, never as administrator: if it can’t open the adapter, use the steps above">' +
      (cap ? '<span class="hint">Capturing on ' + esc(cap.iface) + ': ' + vndKb(cap.bytes) + ', ' + cap.seconds + ' s</span><span class="grow"></span><button type="button" id="vndCapStop" class="primary">Stop</button>' :
        '<select id="vndIface" title="Network adapter">' + ((vnd.ifaces && vnd.ifaces.interfaces) || []).map(function (i) { return '<option value="' + esc(i.name) + '"' + (vnd.iface === i.name ? ' selected' : '') + '>' + esc(i.desc || i.name) + '</option>'; }).join('') + '</select>' +
        '<label title="Stops by itself after this long">min <input id="vndMin" type="number" min="1" max="240" value="' + vnd.minutes + '"></label><button type="button" id="vndCapGo">Start here</button>') + '</div>' : ''));
  // relay
  var R = (D.relays || []), on = R.filter(function (r) { return r.kind === vnd.kind; })[0];
  h += sec('relay', 'Relay <span class="vnd-exp">experimental — needs a live check</span>', R.length ? R.map(function (r) { return r.name + ' running'; }).join(', ') : '',
    '<p class="hint" title="NovaLCT: the relay answers NovaLCT’s search from the relay address with the processor’s own reply. Unico: the same for UCenter. VMP: XCenter is told about the relay address. The vendor app may still find the real processor too — then use the relay’s entry, or a second network adapter / another computer for the vendor app. Nothing is changed on the way; what the vendor app sends is sent (Open Nova’s read-only lock doesn’t cover it).">' +
    'Open Nova stands in for the processor: the NovaStar app connects to the relay address, every byte goes on unchanged, both directions are recorded. Hover for the limits.</p>' +
    '<div class="vnd-row"><select id="vndKind" title="Which NovaStar app"' + (on ? ' disabled' : '') + '>' + VND_FAM.slice(0, 3).map(function (x) { return '<option value="' + x[0] + '"' + (vnd.kind === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>' +
    '<input id="vndTarget" type="text" spellcheck="false" placeholder="processor IP" title="The real processor’s address" value="' + esc(on ? on.target : vnd.target) + '"' + (on ? ' disabled' : '') + '>' +
    '<input id="vndRelayIp" type="text" spellcheck="false" placeholder="' + esc(D.relayIp || (D.platform === 'darwin' ? '127.0.0.1' : '127.0.0.42')) + '" title="The relay’s address on this computer: a 127.x address when the NovaStar app runs here, or this computer’s address on a second network adapter" value="' + esc(on ? on.relayIp : vnd.relayIp) + '"' + (on ? ' disabled' : '') + '>' +
    (on ? '<button type="button" id="vndRelayStop" class="primary">Stop</button>' : '<button type="button" id="vndRelayGo"' + (vnd.busy === 'relay' ? ' disabled' : '') + '>Start</button>') + '</div>' +
    R.map(function (r) {
      var cn = r.counts || {};
      return '<p class="hint vnd-st">' + esc(r.name) + ': ' + esc(r.relayIp) + ':' + esc(r.ports.join('+')) + ' → ' + esc(r.target) + ' · ' + r.clients + ' connected (' + r.opened + ' so far) · ' +
        (cn.tg || 0) + ' frames, ' + (cn.http || 0) + ' web calls, ' + (cn.ws || 0) + ' WebSocket · ' + vndKb(r.up) + ' up, ' + vndKb(r.down) + ' down' +
        (r.kind !== 'coex' ? ' · searches answered ' + r.answers : '') + (r.notes.length ? '<br>' + esc(r.notes.join(' · ')) : '') +
        (r.errors.length ? '<br><span class="bk-err">' + esc(r.errors[r.errors.length - 1]) + '</span>' : '') + '</p>';
    }).join(''));
  // recorded here
  var F = vnd.files || [];
  h += sec('files', 'Recorded', F.length ? F.length + ' file' + (F.length === 1 ? '' : 's') + ' in the last 3 days' : 'nothing yet',
    F.length ? '<ul class="vnd-list">' + F.slice(0, 40).map(function (x) {
      return '<li><span title="' + esc(x.name) + '">' + esc(x.name.split('/').slice(-2).join('/')) + '</span> <span class="hint">' + vndKb(x.size) + '</span>' +
        (x.kind === 'recording' ? ' <button type="button" class="mini" data-vopen="' + esc(x.name) + '" title="Open in Tools ▸ Diagnostics">Open</button>' : '') + '</li>';
    }).join('') + '</ul>' : '<p class="hint">Captures you add and relay recordings show here.</p>');
  box.innerHTML = h;
}
function vndImport(file) {
  if (!file) return;
  if (file.size > 300 * 1024 * 1024) return toast('That capture is over 300 MB — cut it down in Wireshark first (File ▸ Export Specified Packets)');
  vnd.busy = 'import'; vndRender();
  file.arrayBuffer().then(function (buf) { return vndPost('import', { name: file.name, data: rcvB64(buf) }); }).then(function (r) {
    vnd.busy = '';
    if (!r.ok) { vndRender(); return toast('Couldn’t add that capture: ' + r.error); }
    log('vendor_capture_add', { file: file.name, records: r.total, kinds: r.kinds, nwl: r.nwl });
    toast(file.name + ': ' + r.total + ' records' + (r.kinds && (r.kinds.tg || r.kinds.http || r.kinds.udp) ? '' : ' — no NovaStar traffic found in it (wrong adapter or filter?)') + '. It goes into your next report.');
    vnd.open.files = true; vndLoad(false);
  }, function (e) { vnd.busy = ''; vndRender(); toast('Adding the capture failed: ' + e.message); });
}
function vndCapture(go) {
  if (!go) {
    log('vendor_capture_stop', {});
    return vndPost('capture-stop', {}).then(function (r) {
      toast(r.ok ? 'Capture added: ' + r.total + ' records' : 'Capture: ' + r.error); vnd.cap = null; vnd.open.files = true; vndLoad(false);
    }, function (e) { toast(e.message); });
  }
  var f = vnd.fam === 'host' ? (vnd.ip ? 'host ' + vnd.ip : '') : vnd.det.filters[vnd.fam];
  vnd.iface = ($('vndIface') || {}).value || ''; vnd.minutes = +(($('vndMin') || {}).value) || 30;
  log('vendor_capture_start', { iface: vnd.iface, filter: f, minutes: vnd.minutes });
  vndPost('capture-start', { iface: vnd.iface, filter: f, minutes: vnd.minutes }).then(function (r) {
    if (!r.ok) return toast(r.error + (r.needsAdmin ? ' — use Wireshark with the steps instead' : ''));
    vnd.cap = r.capture; vndRender(); vndPoll();
  }, function (e) { toast(e.message); });
}
function vndRelay(go) {
  if (!go) {
    log('vendor_relay_stop', { kind: vnd.kind });
    return vndPost('relay-stop', { kind: vnd.kind }).then(function (r) { vnd.det.relays = r.relays || []; vnd.open.files = true; vndLoad(false); }, function (e) { toast(e.message); });
  }
  vnd.kind = $('vndKind').value; vnd.target = $('vndTarget').value.trim(); vnd.relayIp = $('vndRelayIp').value.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(vnd.target)) return toast('Type the processor’s IP address');
  vnd.busy = 'relay'; vndRender();
  log('vendor_relay_start', { kind: vnd.kind, target: vnd.target, relayIp: vnd.relayIp || 'default' });
  vndPost('relay-start', { kind: vnd.kind, target: vnd.target, relayIp: vnd.relayIp || undefined }).then(function (r) {
    vnd.busy = '';
    if (!r.ok) { vndRender(); return toast('Relay: ' + r.error); }
    vnd.det.relays = r.relays || [];
    var x = r.relay, app = (VND_FAM.filter(function (f) { return f[0] === x.kind; })[0] || [0, 'the app'])[1];
    toast('Relay on ' + x.relayIp + ' — now find the processor in ' + app + (x.kind === 'coex' ? ' (it appears at ' + x.relayIp + ':' + x.ports[0] + ')' : ' (use the one at ' + x.relayIp + ')'));
    vndRender(); vndPoll();
  }, function (e) { vnd.busy = ''; vndRender(); toast(e.message); });
}
function vndBindDlg(d) {
  d.addEventListener('click', function (e) {
    var t = e.target, id = t.id;
    if (id === 'vndClose' || id === 'vndDone' || t === d) return vndClose();
    if (id === 'vndRefresh') { vnd.ifaces = null; return vndLoad(true); }
    if (id === 'vndFolder') return vndPost('open-folder', {}).then(function (r) { if (!r.ok) toast(r.error); }, function (x) { toast(x.message); });
    if (t.dataset.vfam) { vnd.fam = t.dataset.vfam; return vndRender(); }
    if (id === 'vndCopy') {
      var txt = $('vndFilter').textContent;
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast('Filter copied'); }, function () { toast(txt); });
      else toast(txt);
      return log('vendor_filter_copy', { fam: vnd.fam });
    }
    if (id === 'vndCapGo') return vndCapture(true);
    if (id === 'vndCapStop') return vndCapture(false);
    if (id === 'vndRelayGo') return vndRelay(true);
    if (id === 'vndRelayStop') return vndRelay(false);
    if (t.dataset.vopen) { log('vendor_open_recording', { name: t.dataset.vopen }); vndClose(); setTab('diag'); return dgOpen(t.dataset.vopen); }
  });
  d.addEventListener('toggle', function (e) { if (e.target.dataset && e.target.dataset.vsec) vnd.open[e.target.dataset.vsec] = e.target.open; }, true);
  d.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'vndFile') { vndImport(t.files[0]); t.value = ''; }
    else if (t.id === 'vndLogs') { try { localStorage.setItem('on.vendorLogs', t.checked ? '1' : '0'); } catch (x) { /* private window */ } log('vendor_logs_in_reports', { on: t.checked }); }
    else if (t.id === 'vndKind') vnd.kind = t.value;
    else if (t.id === 'vndIface') vnd.iface = t.value;
  });
  d.addEventListener('input', function (e) {
    if (e.target.id === 'vndHostIp') { vnd.ip = e.target.value.trim(); var f = $('vndFilter'); if (f) f.textContent = vnd.ip ? 'host ' + vnd.ip : 'host <processor IP>'; }
    else if (e.target.id === 'vndTarget') vnd.target = e.target.value.trim();
    else if (e.target.id === 'vndRelayIp') vnd.relayIp = e.target.value.trim();
  });
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape') vndClose(); });
}
function bindVendor() { var b = $('mbVendor'); if (b) b.onclick = vndOpen; }
