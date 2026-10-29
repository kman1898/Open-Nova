// app-diag.js - Tools ▸ Diagnostics: the helper's flight recorder (tools/wirelog.py, docs/DIAGNOSTICS.md) in the app.
// User, 2026-10-11: "when i connect via my mac to the H's we will need to make sure we have a way to analyze anything
// sent from it to and from the H. So we need real diagnostics."
// Live: every frame / REST call / discovery packet the helper exchanges with a processor, decoded (register names,
// sending card / port / card 1-based as everywhere in the app), round-trip times, errors with the request they belong
// to, the app's actions and notes. Old recordings and Wireshark / tcpdump captures (.pcap / .pcapng) open in the same
// view. Downloads: the recording (.nwl, JSON lines) or a .pcap for Wireshark, plus the Wireshark plug-in (novastar.lua).
// Polls the helper once a second only while this tab is shown and not paused; its calls stay out of DRV.journal.
// Actions: every record the helper made for an app request carries that click's id (act, app-log.js logAct); the action
// filter shows one click and everything it caused (requests, frames, web calls, USB blocks, errors).
// Owns: dg, DG_KINDS, dgPost, dgMark, dgTime, dgPoll, dgOpen, dgImport, dgDownload, dgMatch, dgHex, dgPair, dgRowHtml,
// dgDetailHtml, dgStatsHtml, dgActs, renderDiag, bindDiag.
// Depends on: app-core (ui, $, esc, toast), app-log (log), drv-core (DRV), app-support (rcvB64 via app-rcvguard), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var dg = { mode: 'live', name: '', seq: 0, frames: [], status: null, files: [], q: '', kinds: { tg: 1, err: 1, http: 1, udp: 1, op: 1, mark: 1, conn: 1 },
  link: '', act: '', errOnly: false, paused: false, sel: 0, busy: '', at: 0, total: 0, tableKey: '' };
var DG_MAX = 20000;   // records kept in the page
var DG_KINDS = [['tg', 'Frames'], ['http', 'Web'], ['udp', 'Discovery'], ['err', 'Errors'], ['conn', 'Connections'], ['op', 'App requests'], ['mark', 'Notes']];

function dgPost(path, body) {   // straight to the helper, not through DRV.post (a poll a second would fill the journal); a note keeps its action
  return fetch(DRV.HELPER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(logActBody(body || {})) }).then(function (r) { return r.json(); });
}
// A note in the recording (the app's own actions call this too: Send, Save, file sends, service …). Never fails loudly.
function dgMark(text, source) { try { dgPost('/api/hw/diag/mark', { text: text, source: source || 'app' }).catch(function () { /* helper not running */ }); } catch (e) { /* ignore */ } }
function dgTime(t) {
  var d = new Date(t * 1000), p = function (n, w) { return ('00' + n).slice(-(w || 2)); };
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
}
function dgPoll() {
  if (ui.tab !== 'diag' || document.hidden) return;
  var now = Date.now();
  if (dg.mode === 'live' && !dg.paused && !dg.busy) {
    dg.busy = 'poll';
    dgPost('/api/hw/diag/frames', { since: dg.seq, limit: 3000 }).then(function (r) {
      dg.busy = '';
      if (!r.ok || dg.mode !== 'live') return;
      if (r.seq < dg.seq) { dg.frames = []; }          // the helper restarted: a new recording
      if (r.frames.length) {
        var gap = r.frames[0].seq - dg.seq - 1;   // more happened than the helper keeps in memory (the recording has it all)
        if (dg.seq && gap > 0) dg.frames.push({ seq: r.frames[0].seq - 0.5, t: r.frames[0].t, kind: 'mark', source: 'app', text: gap + ' records not shown here (the page was hidden or busy) — they are in the recording: Download, or Open a recording' });
        dg.frames = dg.frames.concat(r.frames).slice(-DG_MAX); dg.seq = r.frames[r.frames.length - 1].seq; renderDiag();
      }
      else dg.seq = r.seq;
    }, function () { dg.busy = ''; dg.status = { ok: false, error: 'the helper isn’t running' }; renderDiag(); });
  }
  if (now - dg.at > 3000) {
    dg.at = now;
    dgPost('/api/hw/diag/status', {}).then(function (s) { dg.status = s; renderDiag(); }, function () { dg.status = { ok: false, error: 'the helper isn’t running' }; renderDiag(); });
  }
}
// Open a recording (name from the list) or go back to live.
function dgOpen(name) {
  if (!name) { dg.mode = 'live'; dg.name = ''; dg.frames = []; dg.seq = 0; dg.sel = 0; renderDiag(); return dgPoll(); }
  dg.mode = 'file'; dg.name = name; dg.frames = []; dg.sel = 0; dg.busy = 'load'; renderDiag();
  return dgPost('/api/hw/diag/load', { name: name, max: DG_MAX }).then(function (r) {
    dg.busy = ''; if (!r.ok) { toast('Couldn’t open it: ' + r.error); return dgOpen(''); }
    dg.frames = r.frames; dg.total = r.total; renderDiag();
    if (r.total > r.frames.length) toast('Showing the first ' + r.frames.length + ' of ' + r.total + ' records — download it for the rest');
  }, function (e) { dg.busy = ''; toast('Helper not reachable: ' + e.message); });
}
// A Wireshark / tcpdump capture: decoded by the helper, kept under diagnostics/imported, shown here.
function dgImport(file) {
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) return toast('That capture is over 200 MB — cut it down in Wireshark first (File ▸ Export Specified Packets)');
  dg.busy = 'import'; renderDiag();
  file.arrayBuffer().then(function (buf) { return dgPost('/api/hw/diag/import', { name: file.name, data: rcvB64(buf) }); }).then(function (r) {
    dg.busy = '';
    if (!r.ok) return toast('Couldn’t read that capture: ' + r.error);
    log('diag_import', { file: file.name, records: r.total, kept: r.name });
    dg.mode = 'file'; dg.name = r.name; dg.frames = r.frames; dg.total = r.total; dg.sel = 0; dg.files = []; renderDiag();
    toast(r.total + ' records from ' + file.name + (r.frames.length ? '' : ' — no NovaStar traffic found in it'));
  }, function (e) { dg.busy = ''; renderDiag(); toast('Import failed: ' + e.message); });
}
function dgDownload(fmt) {
  var name = dg.mode === 'file' ? dg.name : dg.status && dg.status.file ? dg.status.file.replace(/\\/g, '/').split('/').slice(-2).join('/') : '';
  if (fmt === 'plugin') name = 'plugin';
  if (!name) return toast('Nothing recorded yet');
  var url = DRV.HELPER + (fmt === 'plugin' ? '/api/hw/diag/plugin' : '/api/hw/diag/download?fmt=' + fmt + '&name=' + encodeURIComponent(name));
  fetch(url).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); }).then(function (b) {
    var a = document.createElement('a'), base = name.split('/').pop().replace(/\.nwl(\.gz)?$/, '');
    a.href = URL.createObjectURL(b);
    a.download = fmt === 'plugin' ? 'novastar.lua' : fmt === 'pcap' ? base + '.pcap' : name.split('/').pop();
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    log('diag_download', { name: name, fmt: fmt });
  }).catch(function (e) { toast('Download failed: ' + e.message); });
}
function dgText(r) {
  return r.kind === 'tg' ? r.sum || r.hex : r.kind === 'http' ? r.method + ' ' + (r.url || '') + (r.status != null ? ' → ' + r.status : '') :
    r.kind === 'udp' ? (r.dir === 'tx' ? 'to ' : 'from ') + r.peer + (r.iface ? ' (' + r.iface + ')' : '') + ' ' + (r.text || r.n + ' B') : r.kind === 'err' ? (r.link === 'helper' ? 'helper bug: ' : '') + r.error + (r.req ? ' — ' + r.req : '') :
    r.kind === 'conn' ? r.event + (r.error ? ': ' + r.error : '') + (r.ms != null ? ' (' + r.ms + ' ms)' : '') : r.kind === 'op' ? r.route + ' ' + r.phase +
    (r.phase === 'end' ? (r.ok ? ' ok' : ' FAILED') + ' ' + r.ms + ' ms' + (r.error ? ' — ' + r.error : '') : r.req && r.req.host ? ' ' + r.req.host + (r.req.port ? ':' + r.req.port : '') : '') :
    r.kind === 'mark' ? '— ' + r.text + ' —' : r.kind === 'echo' ? 'echo: ' + (r.sum || r.hex) + (r.change ? ' (' + r.change + ')' : '') :
    r.kind === 'junk' ? r.n + ' stray bytes' + (r.note ? ' (' + r.note + ')' : '') + ': ' + r.hex.slice(0, 48) :
    r.kind === 'usb' ? 'USB ' + r.what + (r.len != null ? ' ' + (r.read ? 'read' : 'write') + ' ' + r.len + ' B' : '') + (r.status != null ? ' status ' + r.status + (r.residue ? ' residue ' + r.residue : '') : '') + (r.tag != null ? ' tag ' + r.tag : '') :
    r.kind === 'ws' ? 'WebSocket ' + (r.dir === 'tx' ? '→ ' : '← ') + (r.nova ? r.nova.map(function (x) { return x[0] + ' ' + x[1].slice(0, 80); }).join(' | ') : r.text || (r.op === 9 ? 'ping' : r.op === 10 ? 'pong' : r.n + ' B')) : JSON.stringify(r);
}
function dgBad(r) { return r.kind === 'err' || r.kind === 'junk' || r.error || (r.d && (r.d.status || r.d.badsum)) || (r.kind === 'op' && r.phase === 'end' && !r.ok) || (r.kind === 'http' && r.status >= 400) || (r.kind === 'usb' && r.status); }
function dgMatch(r) {
  if (!dg.kinds[r.kind === 'junk' ? 'err' : r.kind === 'echo' || r.kind === 'usb' ? 'tg' : r.kind === 'ws' ? 'http' : r.kind]) return false;   // echoes / USB wrapper blocks are frames, stray bytes a problem, WebSocket frames (vendor relay) web
  if (dg.errOnly && !dgBad(r)) return false;
  if (dg.link && r.link !== dg.link && r.peer !== dg.link) return false;
  if (dg.act && r.act !== dg.act) return false;
  if (dg.q) { var q = dg.q.toLowerCase(); if ((dgText(r) + ' ' + (r.link || '') + ' ' + (r.hex || '')).toLowerCase().indexOf(q) < 0) return false; }
  return true;
}
// "0000  55 AA 00 01 FE …  U.... " lines
function dgHex(hex) {
  var b = hex.match(/../g) || [], out = [];
  for (var i = 0; i < b.length; i += 16) {
    var row = b.slice(i, i + 16);
    out.push(('000' + i.toString(16).toUpperCase()).slice(-4) + '  ' + row.join(' ').toUpperCase() + '   '.repeat(16 - row.length) + '  ' +
      row.map(function (x) { var c = parseInt(x, 16); return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'; }).join(''));
  }
  return out.join('\n');
}
// the request / reply that belongs with frame r (same link and serial, nearest in time)
function dgPair(r) {
  if (r.kind !== 'tg' || !r.d) return null;
  var i = dg.frames.indexOf(r), step = r.dir === 'tx' ? 1 : -1;
  for (var j = i + step, n = 0; j >= 0 && j < dg.frames.length && n < 4000; j += step, n++) {
    var x = dg.frames[j]; if (x.kind === 'tg' && x.link === r.link && x.d && x.d.serial === r.d.serial && x.dir !== r.dir) return x;
  }
  return null;
}
function dgRowHtml(r) {
  var arrow = r.kind === 'tg' || r.kind === 'udp' || r.kind === 'usb' ? (r.dir === 'tx' ? '→' : '←') : r.kind === 'echo' ? '↩' : r.kind === 'http' ? '⇄' : r.kind === 'mark' ? '✎' : r.kind === 'op' ? '◆' : r.kind === 'conn' ? '⚭' : '!';
  var late = r.stale ? 'stale reply' : r.late ? 'late reply' : '';
  return '<tr data-dgseq="' + r.seq + '" class="dg-' + r.kind + (dgBad(r) ? ' dg-bad' : '') + (late ? ' dg-stale' : '') + (r.seq === dg.sel ? ' on' : '') + '">' +
    '<td class="dg-t">' + dgTime(r.t) + '</td><td class="dg-a">' + arrow + '</td><td class="dg-l" title="' + esc(r.link || r.peer || '') + '">' + esc(r.link || r.peer || '') + '</td>' +
    '<td class="dg-w">' + esc(dgText(r)) + (late ? ' <span class="hint">(' + late + ')</span>' : '') + '</td><td class="dg-r">' + (r.rtt != null ? r.rtt + ' ms' : r.kind === 'http' && r.ms != null ? r.ms + ' ms' : '') + '</td></tr>';
}
function dgDetailHtml(r) {
  var h = '<div class="dg-detail"><p><b>' + esc(dgTime(r.t)) + '</b> · ' + esc(r.kind) + (r.link ? ' · ' + esc(r.link) : '') + '</p><p>' + esc(dgText(r)) + '</p>' +
    (r.act ? '<p class="hint">App action ' + esc(r.act) + (dgActs()[r.act] ? ': ' + esc(dgActs()[r.act].what) : '') + ' <a href="#" data-dgact="' + esc(r.act) + '">show only this action</a></p>' : '');
  if (r.d) h += '<table class="hw-info">' + Object.keys(r.d).map(function (k) { return '<tr><th>' + esc(k) + '</th><td>' + esc(String(r.d[k])) + '</td></tr>'; }).join('') + '</table>';
  if (r.rtt != null) h += '<p class="hint">Answered after ' + r.rtt + ' ms' + (r.late ? ' — after the helper had stopped waiting' : '') + '</p>';
  var pr = dgPair(r), go = function (x) { return ' <a href="#" data-dggo="' + x.seq + '">show</a>'; };
  var echo = r.kind === 'tg' && r.dir === 'tx' && !pr && dg.frames.filter(function (x) { return x.kind === 'echo' && x.of === r.seq; })[0];
  if (r.kind === 'tg') h += pr ? '<p class="hint">' + (r.dir === 'tx' ? 'Reply' : 'Request') + ' (' + dgTime(pr.t) + '): ' + esc(pr.sum || '') + go(pr) + '</p>' :
    echo ? '<p class="hint">' + (echo.change ? 'No reply: the processor sent it back with ' + esc(echo.change) + ' — no such sending card.' : 'The processor sent it back (echo).') + go(echo) + '</p>' :
    r.dir === 'tx' ? '<p class="rcv-bad">No reply recorded for this request.</p>' : '';
  if (r.kind === 'echo') {
    var of = r.of != null && dg.frames.filter(function (x) { return x.seq === r.of; })[0];
    h += '<p class="hint">Our own request, sent back by the processor (H series: broadcast writes, and requests for a sending card that isn’t there). Not an error.</p>' +
      (of ? '<p class="hint">Request (' + dgTime(of.t) + '): ' + esc(of.sum || '') + go(of) + '</p>' : '');
  }
  if (r.note) h += '<p class="hint">' + esc(r.note === 'drained' ? 'Found while emptying the USB link before the next request' : r.note) + '</p>';
  if (r.where) h += '<p class="hint">Where in the helper:</p><pre class="dg-hex">' + esc([].concat(r.where).join('\n')) + '</pre>';
  if (r.hex) h += '<pre class="dg-hex">' + esc(dgHex(r.hex)) + '</pre>';
  if (r.kind === 'http') {
    var body = function (b, t) {
      if (!b) return ''; var s = b.text != null ? b.text : '';
      if (b.b64 != null) { try { s = dgHex(Array.prototype.map.call(atob(b.b64.slice(0, 80000)), function (c) { return ('0' + c.charCodeAt(0).toString(16)).slice(-2); }).join('')); } catch (e) { s = b.b64.slice(0, 60000); } }
      else { try { s = JSON.stringify(JSON.parse(s), null, 1); } catch (e) { /* not JSON */ } }
      return '<p class="hint">' + t + ' (' + b.n + ' B' + (b.cut ? ', first 256 KB (an older recording)' : b.file ? ', whole in ' + esc(b.file) + '; the start shown' : b.b64 != null ? ', binary' : '') + ')</p><pre class="dg-hex">' + esc(s.slice(0, 60000)) + '</pre>';
    };
    var heads = function (o, t) { return o ? '<p class="hint">' + t + '</p><pre class="dg-hex">' + esc(Object.keys(o).map(function (k) { return k + ': ' + o[k]; }).join('\n')) + '</pre>' : ''; };
    h += '<p>' + esc(r.method + ' ' + r.url) + '</p>' + (r.status != null ? '<p>Status ' + r.status + (r.ms != null ? ' · ' + r.ms + ' ms' : '') + '</p>' : '') + (r.error ? '<p class="rcv-bad">' + esc(r.error) + '</p>' : '') +
      heads(r.reqh, 'Sent headers') + body(r.req, 'Sent') + heads(r.resph, 'Answer headers') + body(r.resp, 'Answer');
  }
  if (r.kind === 'op' && r.req) h += '<pre class="dg-hex">' + esc(JSON.stringify(r.req, null, 1)) + '</pre>';
  return h + '</div>';
}
function dgStatsHtml() {
  var s = dg.status;
  if (!s) return '<p class="hint">Asking the helper…</p>';
  if (!s.ok) return '<p class="rcv-bad">' + esc(s.error || 'no answer') + '</p>';
  var links = Object.keys(s.links || {}), we = s.writeError;
  return (we ? '<p class="rcv-bad">⚠ The recording can’t be written since ' + esc(dgTime(we.since)) + ': ' + esc(we.error) + ' — ' + we.held + ' records held in memory' + (we.lost ? ', ' + we.lost + ' lost' : '') + '. Free some disk space.</p>' : '') +
    '<p class="hint">Pick a row' + itip('Click a row for its bytes, decoded fields and the matching request / reply.') + '</p>' +
    (links.length ? '<table class="mt-tbl dg-stats"><thead><tr><th>Link</th><th>Sent</th><th>Got</th><th>Errors</th><th>Reply ms (avg / max)</th></tr></thead><tbody>' +
      links.map(function (k) {
        var L = s.links[k];
        return '<tr' + (L.err ? ' class="dg-bad"' : '') + '><td>' + esc(k) + '</td><td>' + L.tx + '</td><td>' + L.rx + '</td><td>' + L.err + (L.last_err ? '<br><span class="hint">' + esc(L.last_err) + '</span>' : '') + '</td><td>' +
          (L.rtt_avg != null ? L.rtt_avg + ' / ' + L.rtt_max : '—') + '</td></tr>';
      }).join('') + '</tbody></table>' : '<p class="hint">No processor traffic since the helper started.</p>') +
    '<p class="hint">Since the helper started: ' + Object.keys(s.counts || {}).map(function (k) { return k + ' ' + s.counts[k]; }).join(' · ') + '</p>';
}
function renderDiag() {
  var box = $('dgBody'); if (!box || ui.tab !== 'diag') return;
  var s = dg.status;
  $('dgRec').checked = !!(s && s.enabled);
  $('dgState').textContent = dg.mode === 'file' ? 'Viewing ' + dg.name + ' (' + (dg.total || dg.frames.length) + ' records)' :
    !s ? '' : !s.ok ? '⚠ ' + (s.error || 'helper not answering') : s.enabled ? '● Recording · ' + (s.file || '').replace(/\\/g, '/').split('/').slice(-2).join('/') : 'Not recording (live view only)';
  if (s && s.ok && s.writeError && dg.mode === 'live') $('dgState').textContent = '⚠ Recording can’t be written: ' + s.writeError.error;
  $('dgState').className = 'hint' + (s && s.ok && s.enabled && dg.mode === 'live' ? ' dg-on' : '');
  $('dgPause').textContent = dg.paused ? 'Resume' : 'Pause';
  $('dgPause').disabled = dg.mode !== 'live';
  $('dgLive').hidden = dg.mode === 'live';
  // the link filter: every link seen
  var links = {}; dg.frames.forEach(function (r) { var l = r.link || r.peer; if (l) links[l] = 1; });
  var ls = $('dgLink'), cur = dg.link;
  ls.innerHTML = '<option value="">All links</option>' + Object.keys(links).sort().map(function (l) { return '<option' + (l === cur ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('');
  var acts = dgActs(), as = $('dgAct');
  if (as) as.innerHTML = '<option value="">All actions</option>' + Object.keys(acts).sort(function (a, b) { return acts[b].t - acts[a].t; }).map(function (k) {
    return '<option value="' + esc(k) + '"' + (k === dg.act ? ' selected' : '') + '>' + esc(dgTime(acts[k].t) + ' ' + (acts[k].what || k) + ' (' + acts[k].n + ')') + '</option>';
  }).join('');
  $('dgKinds').innerHTML = DG_KINDS.map(function (k) { return '<label class="chk"><input type="checkbox" data-dgkind="' + k[0] + '"' + (dg.kinds[k[0]] ? ' checked' : '') + '> ' + k[1] + '</label>'; }).join('') +
    '<label class="chk"><input type="checkbox" id="dgErr"' + (dg.errOnly ? ' checked' : '') + '> Problems only</label>';
  // the table is rebuilt only when what it shows changed (a status update mustn't eat a click or move the scroll)
  var last = dg.frames.length ? dg.frames[dg.frames.length - 1].seq : 0;
  var key = [dg.mode, dg.name, dg.frames.length, last, dg.q, dg.link, dg.act, dg.errOnly, JSON.stringify(dg.kinds), dg.busy === 'load' || dg.busy === 'import'].join('|');
  if (key !== dg.tableKey) {
  dg.tableKey = key;
  var rows = dg.frames.filter(dgMatch), shown = rows.slice(-1500);
  var keep = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;   // follow the end unless scrolled up
  box.innerHTML = (dg.busy === 'load' || dg.busy === 'import' ? '<p class="hint">Reading…</p>' : '') +
    (rows.length > shown.length ? '<p class="hint">Showing the last ' + shown.length + ' of ' + rows.length + ' matching records — narrow the filter, or download the recording.</p>' : '') +
    (shown.length ? '<table class="mt-tbl dg-tbl"><thead><tr><th>Time</th><th></th><th>Link</th><th>What</th><th>Reply</th></tr></thead><tbody>' + shown.map(dgRowHtml).join('') + '</tbody></table>' :
      '<p class="hint">' + (dg.frames.length ? 'Nothing matches the filter.' : dg.mode === 'live' ? 'Nothing yet' + itip('Link a processor or press Find processors: every byte exchanged shows up here.') : 'This recording is empty.') + '</p>');
  if (keep && dg.mode === 'live') box.scrollTop = box.scrollHeight;
  }
  var on = box.querySelector('tr.on'); if (on && +on.dataset.dgseq !== dg.sel) on.classList.remove('on');
  var cur = dg.sel && box.querySelector('[data-dgseq="' + dg.sel + '"]'); if (cur) cur.classList.add('on');
  var sel = dg.sel && dg.frames.filter(function (r) { return r.seq === dg.sel; })[0];
  $('dgSide').innerHTML = sel ? '<p><a href="#" data-dgclose>← Summary</a></p>' + dgDetailHtml(sel) : dgStatsHtml();
}
// The app actions in the records: id -> {t (first record), what (the request's description or the route), n records}.
function dgActs() {
  if (dg.actsKey === dg.frames.length + '|' + dg.name) return dg.acts;
  var m = {};
  dg.frames.forEach(function (r) {
    if (!r.act) return;
    var a = m[r.act] || (m[r.act] = { t: r.t, what: '', n: 0 }); a.n++;
    if (!a.what && r.kind === 'op' && r.phase === 'start') a.what = r.what || r.route;
  });
  dg.acts = m; dg.actsKey = dg.frames.length + '|' + dg.name; return m;
}
function dgFiles() {
  return dgPost('/api/hw/diag/files', {}).then(function (r) {
    dg.files = r.files || [];
    var sel = $('dgFiles');
    sel.innerHTML = '<option value="">Open a recording…</option>' + dg.files.map(function (f) {
      return '<option value="' + esc(f.name) + '">' + esc(f.name) + ' · ' + Math.max(1, Math.round(f.size / 1024)) + ' KB' + (f.current ? ' (now)' : '') + '</option>';
    }).join('');
  }, function () { /* helper not running: the status line says so */ });
}
function bindDiag() {
  var box = $('dgBody'); if (!box) return;
  $('dgRec').onchange = function () {
    var on = this.checked;
    dgPost('/api/hw/diag/enable', { on: on }).then(function (s) { dg.status = s; log('diag_recording', { on: on }); renderDiag(); });
  };
  $('dgPause').onclick = function () { dg.paused = !dg.paused; renderDiag(); };
  $('dgLive').onclick = function () { dgOpen(''); };
  $('dgNote').onclick = function () { var t = prompt('Note for the recording (what you are about to do, what you see):', ''); if (t && t.trim()) { dgMark(t.trim(), 'user'); toast('Note added'); } };
  $('dgFiles').onfocus = dgFiles;
  $('dgFiles').onchange = function () { if (this.value) dgOpen(this.value); this.value = ''; };
  $('dgImportBtn').onclick = function () { var f = $('dgImportFile'); f.value = ''; f.click(); };
  $('dgImportFile').onchange = function () { dgImport(this.files[0]); };
  $('dgDlNwl').onclick = function () { dgDownload('nwl'); };
  $('dgDlPcap').onclick = function () { dgDownload('pcap'); };
  $('dgDlLua').onclick = function () { dgDownload('plugin'); };
  $('dgFolder').onclick = function () { dgPost('/api/hw/diag/open-folder', {}).then(function (r) { if (!r.ok) toast(r.error); }); };
  $('dgFilter').oninput = function () { dg.q = this.value; renderDiag(); };
  $('dgLink').onchange = function () { dg.link = this.value; renderDiag(); };
  if ($('dgAct')) $('dgAct').onchange = function () { dg.act = this.value; renderDiag(); };
  $('dgKinds').addEventListener('change', function (e) {
    if (e.target.id === 'dgErr') dg.errOnly = e.target.checked;
    else if (e.target.dataset.dgkind) dg.kinds[e.target.dataset.dgkind] = e.target.checked ? 1 : 0;
    renderDiag();
  });
  box.addEventListener('click', function (e) { var tr = e.target.closest('[data-dgseq]'); if (tr) { dg.sel = +tr.dataset.dgseq; renderDiag(); } });
  $('dgSide').addEventListener('click', function (e) {
    if (e.target.closest('[data-dgclose]')) { e.preventDefault(); dg.sel = 0; return renderDiag(); }
    var ac = e.target.closest('[data-dgact]'); if (ac) { e.preventDefault(); dg.act = ac.dataset.dgact; log('diag_action_filter', { act: dg.act }); return renderDiag(); }
    var g = e.target.closest('[data-dggo]'); if (g) { e.preventDefault(); dg.sel = +g.dataset.dggo; renderDiag(); var tr = box.querySelector('[data-dgseq="' + dg.sel + '"]'); if (tr) tr.scrollIntoView({ block: 'center' }); }
  });
  setInterval(dgPoll, 1000);
}
