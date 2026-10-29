// app-rcvguard.js - sending a receiving-card file (.rcfgx / NCP) with the file guard (docs/RCV_FILE_GUARD.md; design P12).
// User, 2026-10-10: "When sending rcfgx or NCP, we need to throw up a message and say … the file you're sending doesn't
// match the panel and show why. That way you can't accidentally send the wrong one."
// Tools ▸ Maintain ▸ Send receiving-card file…: pick the file → the helper says what it is for (tools/rcvfile.py) → each
// linked processor's cards say what they are (drv-*.identify, read-only) → the helper's rules (tools/rcvguard.py) compare
// them → this dialog. Cancel is the default; BLOCK never offers "Send anyway"; a mixed wall can be sent to the matching
// cabinets only. A BLOCK can be overridden (user, 2026-10-11: "we need the override for blocked files"): Override… opens a
// panel that lists what is overridden and needs OVERRIDE typed, then the usual confirm; it is logged with the reasons and
// the note. A hard BLOCK (the file can't go through this path at all: 4th-generation package through NovaLCT, a non-NCP
// file to NCP-only cards on an MX, a damaged file — rcvguard.HARD_RULES) has no override. Neither NovaLCT, Unico nor VMP checks any of this before sending (RCV_FILE_GUARD.md §3, §3b).
// The send itself is the driver's sendRcvFile (NovaLCT: the .rcfgx replay, as LCT does it); never followed by a Save.
// Owns: rg, RCV_LEVEL, rcvB64, rcvStart, rcvCards, rcvPick, rcvLoad, rcvCheck, rcvWhere, rcvRender, rcvSecs, rcvOvrOk, rcvSend,
// bindRcvGuard.
// Depends on: app-core (P, $, esc, toast), app-log (log), drv-core (DRV), app-hardware (hw, hwDetect, hwPortCells),
// app-processors (cardsOfDevice, deviceLabel, procFamily, procModel), app-capacity (portLabel), app-save (hwMarkUnsaved),
// all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var rg = { name: '', data: '', ident: null, cabinet: 0, pick: {}, res: {}, busy: '', gen: 0, checked: null, ovr: null };
// rg.gen = ticket of the current file / check (a late answer of an older one is dropped); rg.checked = the cabinet and
// processors the shown verdicts are for (a send refuses anything else); rg.ovr = the open override panel {text, note} or null.

function rcvPick() { var f = $('rcvFile'); if (f) { f.value = ''; f.click(); } }
// A chosen file -> base64 -> what it is for (no device involved yet).
function rcvLoad(file) {
  if (!file) return;
  if (file.size > 45 * 1024 * 1024) return toast('That file is over 45 MB — too big to check here');
  var rd = new FileReader();
  rd.onload = function () { rcvStart(file.name, rcvB64(rd.result)); };
  rd.readAsArrayBuffer(file);
}
function rcvB64(buf) {
  var b = new Uint8Array(buf), s = '';
  for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
// The dialog for a file already in memory (picked, or from the cabinet library): what it is for, then the check.
// cabinet = which cabinet of an NCP; only = the processor ids to tick (default: every linked one).
function rcvStart(name, data, cabinet, only) {
  if (rg.busy === 'send') return toast('Wait for the send to finish');
  rg = { name: name, data: data, ident: null, cabinet: cabinet || 0, pick: {}, res: {}, busy: 'file', gen: rg.gen + 1, checked: null, ovr: null };
  var gen = rg.gen;
  P.devices.forEach(function (d) { if (d.hw && (!only || only.indexOf(d.id) >= 0)) rg.pick[d.id] = true; });
  $('rcvDlg').hidden = false; rcvRender();
  DRV.post('rcv', '/api/rcv/identity', { data: rg.data, name: rg.name }).then(function (r) {
    if (gen !== rg.gen) return;
    rg.ident = r; rg.busy = ''; log('rcv_file', { file: rg.name, kind: r.kind, ok: r.fileOk, error: r.error });
    if (rg.cabinet >= ((r.cabinets || []).length || 1)) rg.cabinet = 0;
    rcvRender(); if (r.fileOk) rcvCheck();
  }, function (e) { if (gen !== rg.gen) return; rg.busy = ''; rg.ident = { fileOk: false, error: 'the helper isn’t reachable (' + e.message + ')' }; rcvRender(); });
}
// What processor d's receiving cards are (read-only): {ok, fam, list: [{where, id, cabinetId, planned}], raw} or {ok:false, error}.
// NovaLCT detects afresh first, so the read covers exactly the cards there now. full = firmware too.
function rcvCards(d, full) {
  if (!d.hw) return Promise.resolve({ ok: false, error: 'not linked' });
  var cards = cardsOfDevice(d), placed = hwPortCells();
  var fam = d.hw.kind !== 'offline' ? d.hw.kind : procFamily(procModel(d.model));
  var go = function () {
    return DRV.of(d).identify ? DRV.of(d).identify(d, { full: !!full }) : Promise.resolve({ ok: false, error: 'this processor can’t report its cards yet' });
  };
  var settle = function (n) { return (hw.watch[d.id] || {}).inflight && n < 100 ? new Promise(function (ok) { setTimeout(ok, 100); }).then(function () { return settle(n + 1); }) : Promise.resolve(); };
  var first = fam === 'lct' ? settle(0).then(function () { return hwDetect(d, true); }).then(go) : go();
  return first.then(function (r) {
    if (!r.ok) return { ok: false, error: r.error };
    var list = r.cards.map(function (c) {
      var g = cards[c.dst || 0], cell = g != null ? (placed[g + ':' + c.port] || [])[c.index] : null;
      return { where: { proc: deviceLabel(d), card: g != null ? g : null, dst: c.dst || 0, port: c.port, index: c.index }, id: c.id, cabinetId: c.cabinetId,
        planned: cell ? { w: cell.width, h: cell.height } : null };
    });
    return { ok: true, fam: fam, list: list, raw: r.cards };
  }, function (e) { return { ok: false, error: e.message }; });
}
// Each chosen processor: its cards' identities, then the helper's verdict for this file.
function rcvCheck() {
  if (!rg.ident || !rg.ident.fileOk || rg.busy === 'send') return;
  var devs = P.devices.filter(function (d) { return rg.pick[d.id]; });
  var gen = ++rg.gen, cab = rg.cabinet, res = {};
  rg.res = {}; rg.checked = null; rg.ovr = null; rg.busy = 'check'; rcvRender();
  var full = rg.ident.kind === 'ncp' || rg.ident.kind === 'rcfgx';   // both compare firmware
  return Promise.all(devs.map(function (d) {
    if (!d.hw) { res[d.id] = { verdict: { level: 'block', title: 'Not connected: nothing was checked', groups: [], total: 0, sendable: 0 } }; return null; }
    return rcvCards(d, full).then(function (r) {
      if (!r.ok) { res[d.id] = { error: r.error }; return; }
      return DRV.post('rcv', '/api/rcv/check', { data: rg.data, name: rg.name, cabinet: cab, family: r.fam, cards: r.list }).then(function (x) {
        res[d.id] = x.ok ? { verdict: x.verdict, cards: r.list, raw: r.raw } : { error: x.error };
      });
    }).catch(function (e) { res[d.id] = { error: e.message }; });
  })).then(function () {
    if (gen !== rg.gen) return;                      // a newer check (other cabinet / processors / file) owns the dialog
    rg.res = res; rg.busy = ''; rg.checked = { cabinet: cab, devs: devs.map(function (d) { return d.id; }).sort().join(',') };
    log('rcv_check', { file: rg.name, cabinet: cab, result: Object.keys(rg.res).map(function (id) {
      var x = rg.res[id], d = deviceById(id); return deviceLabel(d) + ': ' + (x.error ? 'error ' + x.error : x.verdict.level + ' (' + x.verdict.sendable + '/' + x.verdict.total + ' sendable)');
    }) });
    rcvRender();
  });
}
// "S1 P2 · cabinets 1–3, S1 P4 · cabinet 7" from [{card, port, index}]
function rcvWhere(ws) {
  var by = {};
  ws.forEach(function (w) { var k = (w.card == null ? 'x' + w.dst : w.card) + ':' + w.port; (by[k] = by[k] || []).push(w.index); });
  var parts = Object.keys(by).sort(function (a, b) { var x = a.split(':'), y = b.split(':'); return x[0] - y[0] || x[1] - y[1]; }).map(function (k) {
    var xs = by[k].sort(function (a, b) { return a - b; }), runs = [], s = xs[0], p = xs[0];
    xs.slice(1).concat([null]).forEach(function (x) { if (x === p + 1) { p = x; return; } runs.push(s === p ? '' + (s + 1) : (s + 1) + '–' + (p + 1)); s = p = x; });
    var sp = k.split(':');
    return (sp[0][0] === 'x' ? 'output card ' + (+sp[0].slice(1) + 1) + ' (not in the project) P' + (+sp[1] + 1) : portLabel(+sp[0], +sp[1])) + ' · cabinet' + (xs.length > 1 ? 's ' : ' ') + runs.join(', ');
  });
  return parts.length > 4 ? parts.slice(0, 4).join('; ') + '; +' + (parts.length - 4) + ' more' : parts.join('; ');
}
var RCV_LEVEL = { ok: 0, info: 1, warn: 2, block: 3 };
function rcvRender() {
  var box = $('rcvBody'); if (!box) return;
  var id = rg.ident, h = '';
  h += '<div class="rcv-file"><b>' + esc(rg.name) + '</b><br>';
  if (!id) h += '<span class="hint">Reading the file…</span>';
  else if (!id.fileOk) h += '<span class="rcv-bad">✕ ' + esc(id.error) + '</span>';
  else {
    var cabs = id.cabinets || [];
    h += '<span class="hint">' + (id.kind === 'ncp' ? 'NCP cabinet package' : id.kind === 'rcfgx' ? '.rcfgx receiving-card configuration' : 'RCCB register script') + '</span>';
    if (cabs.length > 1) h += ' · <label>Cabinet <select id="rcvCab">' + cabs.map(function (c, i) { return '<option value="' + i + '"' + (i === rg.cabinet ? ' selected' : '') + '>' + esc((c.mfr ? c.mfr + ' ' : '') + (c.cabinet || 'cabinet ' + (i + 1))) + '</option>'; }).join('') + '</select></label>';
    if (rg.busy === 'send') h = h.replace('<select id="rcvCab">', '<select id="rcvCab" disabled>');
  }
  h += '</div>';
  // targets
  var linked = P.devices.filter(function (d) { return d.hw; });
  h += '<div class="rcv-targets"><span class="hint">Send to:</span> ' + (linked.length ? linked.map(function (d) {
    return '<label class="chk"><input type="checkbox" data-rcvdev="' + d.id + '"' + (rg.pick[d.id] ? ' checked' : '') + (rg.busy === 'send' ? ' disabled' : '') + '> ' + esc(deviceLabel(d)) + ' <span class="hint">' + esc(d.hw.name) + '</span></label>';
  }).join('') : '<span class="rcv-bad">No processor is linked — link one in Processors ▸ Hardware first. Nothing can be checked.</span>') + '</div>';
  if (rg.busy === 'check') h += '<p class="hint">Reading what the cabinets are and comparing…</p>';
  if (rg.busy === 'send') h += '<p class="hint">Sending… keep the processors powered and connected.</p>';
  var worst = 'ok', total = 0, match = 0, open = 0, over = 0, overWhy = [];
  Object.keys(rg.res).forEach(function (did) {
    var d = deviceById(did), x = rg.res[did];
    if (!d) return;
    if (x.error) { worst = 'block'; h += '<section class="rcv-dev"><h4>' + esc(deviceLabel(d)) + '</h4><p class="rcv-bad">Couldn’t read the cabinets: ' + esc(x.error) + ' — nothing was checked.</p></section>'; return; }
    var v = x.verdict;
    if (RCV_LEVEL[v.level] > RCV_LEVEL[worst]) worst = v.level;
    total += v.total; over += v.overridable || 0;
    h += '<section class="rcv-dev"><h4>' + esc(deviceLabel(d)) + ' <span class="hint">' + v.total + ' cabinet' + (v.total === 1 ? '' : 's') + '</span></h4>';
    if (!v.groups.length) h += '<p class="rcv-bad">' + esc(v.title) + '</p>';
    v.groups.forEach(function (g) {
      if (g.level === 'ok' || g.level === 'info') match += g.count;
      if (g.level !== 'block') open += g.count;
      if (g.level === 'block' && !g.hard) g.reasons.forEach(function (r) { if (r.level === 'block' && overWhy.indexOf(r.text) < 0) overWhy.push(r.text); });
      var head = g.level === 'block' ? (g.hard ? 'Can’t be sent' : 'Doesn’t match') : g.level === 'warn' ? 'Check' : 'Matches';
      h += '<div class="rcv-grp ' + g.level + '"><div class="rcv-gh"><b>' + head + ': ' + g.count + ' cabinet' + (g.count === 1 ? '' : 's') + '</b> <span class="hint">' + esc(rcvWhere(g.where)) +
        (g.level === 'block' && g.hard ? ' · no override' : '') + '</span></div>' +
        (g.id ? '<div class="hint">These cabinets: ' + esc([g.id.card, g.id.size, g.id.chip, g.id.scan ? '1/' + g.id.scan + ' scan' : null, g.id.cabinet].filter(Boolean).join(' · ') || 'nothing reported') + '</div>' : '') +
        '<ul>' + g.reasons.map(function (r) { return '<li class="' + r.level + '">' + esc(r.text) + '</li>'; }).join('') +
        g.unknown.map(function (u) { return '<li class="unknown">' + esc(u) + '</li>'; }).join('') + '</ul></div>';
    });
    h += '</section>';
  });
  // the file's identity (what it says it is for), from the first verdict
  var anyV = Object.keys(rg.res).map(function (k) { return rg.res[k].verdict; }).filter(Boolean)[0];
  if (anyV && anyV.file) h = h.replace('</div>', '<div class="rcv-for">The file is for: <b>' + esc(anyV.file) + '</b></div></div>');
  var done0 = id && id.fileOk && !rg.busy && Object.keys(rg.res).length;
  if (rg.ovr && !(done0 && worst === 'block' && over)) rg.ovr = null;
  if (rg.ovr) h += '<section class="rcv-ovr"><h4>Override the check</h4>' +
    '<p>This sends the file to <b>' + over + ' cabinet' + (over === 1 ? '' : 's') + ' the check blocked</b>' + (open ? ' as well as the ' + open + ' it didn’t' : '') + '. You are overriding:</p>' +
    '<ul>' + overWhy.slice(0, 8).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + (overWhy.length > 8 ? '<li>… and ' + (overWhy.length - 8) + ' more</li>' : '') + '</ul>' +
    '<p class="hint">A wrong receiving-card file can leave these cabinets dark or garbled until the right file is sent. Nothing is saved afterwards, so a power cycle brings back what they had.</p>' +
    '<label class="rcv-ovr-row">Why (kept in the log) <input id="rcvOvrNote" type="text" maxlength="200" placeholder="e.g. vendor confirmed this file for these cabinets" value="' + esc(rg.ovr.note) + '"></label>' +
    '<label class="rcv-ovr-row">Type <b>OVERRIDE</b> to unlock <input id="rcvOvrText" type="text" maxlength="20" autocomplete="off" spellcheck="false" value="' + esc(rg.ovr.text) + '"></label></section>';
  box.innerHTML = h;
  // title + buttons: Cancel is always there and the default; BLOCK never gets "Send anyway"
  var done = id && id.fileOk && !rg.busy && Object.keys(rg.res).length;
  $('rcvTitle').textContent = !done ? 'Send receiving-card file' : worst === 'block' ? 'This file doesn’t match the cabinets' : worst === 'warn' ? 'Check before sending' : 'The file matches the cabinets';
  $('rcvDlg').dataset.level = done ? worst : '';
  var devs = P.devices.filter(function (d) { return rg.pick[d.id] && rg.res[d.id] && rg.res[d.id].verdict; });
  var can = devs.length && devs.every(function (d) { var x = DRV.of(d); return x.sendRcvFile && (x.caps(d).rcvFile || {})[id.kind === 'ncp' ? 'ncp' : 'rcfgx']; });
  var kindKey = id && id.kind === 'ncp' ? 'ncp' : 'rcfgx', no = devs.filter(function (d) { return !(DRV.of(d).caps(d).rcvFile || {})[kindKey]; })[0];
  var why = can ? '' : ' title="' + esc(no && (DRV.of(no).caps(no).rcvFile || {}).why || 'Sending ' + (kindKey === 'ncp' ? 'NCP files' : '.rcfgx files') + ' to this processor isn’t built yet') + ' — the check above is what it would be checked against"';
  var b = '<button id="rcvCancel" class="primary-outline" autofocus>Cancel</button>';
  var pl = function (n) { return n + ' cabinet' + (n === 1 ? '' : 's'); };
  if (done && worst === 'block' && match) b += '<button data-rcvsend="match"' + (can ? '' : ' disabled') + why + '>Send to the ' + pl(match) + ' that match only</button>';
  if (done && worst === 'block' && open > match) b += '<button data-rcvsend="open" class="warn"' + (can ? '' : ' disabled') + why + '>Send to the ' + pl(open) + ' not blocked (incl. ' + (open - match) + ' with warnings)</button>';
  if (done && worst === 'warn' && match && match < total) b += '<button data-rcvsend="match"' + (can ? '' : ' disabled') + why + '>Send to the ' + pl(match) + ' that match only</button>';
  if (done && worst === 'warn') b += '<button data-rcvsend="open" class="warn"' + (can ? '' : ' disabled') + why + '>Send anyway (' + pl(open) + ')</button>';
  if (done && (worst === 'ok' || worst === 'info')) b += '<button data-rcvsend="all" class="primary"' + (can ? '' : ' disabled') + why + '>Send to ' + total + ' cabinet' + (total === 1 ? '' : 's') + '</button>';
  if (done && worst === 'block' && over && !rg.ovr) b += '<button data-rcvovr class="danger"' + (can ? '' : ' disabled') + why + '>Override…</button>';
  if (done && rg.ovr) b += '<button data-rcvsend="override" class="danger"' + (can && rcvOvrOk() ? '' : ' disabled') + why + '>Override and send to ' + pl(open + over) + '</button>';
  $('rcvFoot').innerHTML = b + (done ? '<span class="hint">Not saved afterwards: press Save when the cabinets look right (a power cycle undoes it until then).</span>' : '');
  var cb = $('rcvCancel'); if (cb && document.activeElement === document.body) cb.focus();
}
// Per write target: an NCP's parameter script with its busy polls (helper's estimate, ~35 s), an .rcfgx about 2 s.
function rcvSecs() { var c = rg.ident && rg.ident.kind === 'ncp' && (rg.ident.cabinets || [])[rg.cabinet]; return c && c.sendSeconds || (c ? 35 : 2); }
function rcvOvrOk() { return !!rg.ovr && rg.ovr.text.trim().toUpperCase() === 'OVERRIDE'; }
// mode: 'match' = only the groups that match; 'open' = every group that isn't blocked; 'all' = everything (all matched);
// 'override' = every group except a hard BLOCK (only with the override panel filled in)
function rcvSend(mode) {
  if (rg.busy) return toast('Wait — ' + (rg.busy === 'send' ? 'a send is running' : 'the check isn’t finished'));
  if (hw.busy) return toast('Another processor operation is running (' + hw.busy + ') — try again when it’s done');
  var devs = P.devices.filter(function (d) { return rg.pick[d.id] && rg.res[d.id] && rg.res[d.id].verdict; });
  var key = P.devices.filter(function (d) { return rg.pick[d.id]; }).map(function (d) { return d.id; }).sort().join(',');
  if (!rg.checked || rg.checked.cabinet !== rg.cabinet || rg.checked.devs !== key) { toast('The selection changed — checking again first'); return rcvCheck(); }
  if (mode === 'override' && !rcvOvrOk()) return toast('Type OVERRIDE first');
  var cab = rg.checked.cabinet, forced = 0, forcedWhy = [];
  var jobs = devs.map(function (d) {
    var x = rg.res[d.id], v = x.verdict, ok = function (g) {
      if (mode === 'override') return g.level !== 'block' || !g.hard;   // a hard BLOCK never
      return mode === 'match' ? g.level === 'ok' || g.level === 'info' : g.level !== 'block';   // BLOCK only by override
    };
    v.groups.forEach(function (g) {
      if (mode !== 'override' || g.level !== 'block' || g.hard) return;
      forced += g.count;
      g.reasons.forEach(function (r) { if (r.level === 'block') forcedWhy.push(deviceLabel(d) + ' ' + rcvWhere(g.where) + ': ' + r.text); });
    });
    var want = {}; v.groups.filter(ok).forEach(function (g) { g.where.forEach(function (w) { if (w.card != null) want[w.dst + ':' + w.port + ':' + w.index] = 1; }); });
    // per port: the whole port when every card on it is wanted (one broadcast), else card by card
    var perPort = {};
    x.cards.forEach(function (c) { var k = c.where.dst + ':' + c.where.port; (perPort[k] = perPort[k] || []).push(c); });
    var targets = [];
    Object.keys(perPort).forEach(function (k) {
      var cs = perPort[k], sel = cs.filter(function (c) { return want[c.where.dst + ':' + c.where.port + ':' + c.where.index]; });
      if (!sel.length) return;
      var dst = sel[0].where.dst, port = sel[0].where.port;
      if (sel.length === cs.length) targets.push({ dst: dst, port: port, card: null, cabinetIds: sel.map(function (c) { return c.cabinetId; }) });
      else sel.forEach(function (c) { targets.push({ dst: dst, port: port, card: c.where.index, cabinetId: c.cabinetId }); });
    });
    return { d: d, targets: targets, n: Object.keys(want).length, level: mode === 'override' && v.level === 'block' ? 'override' : v.level };
  }).filter(function (j) { return j.targets.length; });
  if (!jobs.length) return toast('Nothing to send');
  var n = jobs.reduce(function (a, j) { return a + j.n; }, 0);
  if (!confirm((forced ? 'OVERRIDE: this includes ' + forced + ' cabinet' + (forced === 1 ? '' : 's') + ' the check blocked.\n\n' : '') +
    'Send ' + rg.name + ' to ' + n + ' cabinet' + (n === 1 ? '' : 's') + '?\n\n' + jobs.map(function (j) { return '• ' + deviceLabel(j.d) + ': ' + j.n + ' (' + j.targets.length + ' write target' + (j.targets.length === 1 ? '' : 's') + ')'; }).join('\n') +
    '\n\nAbout ' + rcvSecs() + ' s per target. It is not saved afterwards.')) return;
  if (!hwBegin('send')) return;
  if (forced) log('rcv_override', { file: rg.name, cabinets: forced, note: rg.ovr.note.trim(), overridden: forcedWhy });
  rg.busy = 'send'; rcvRender();   // monitoring pauses meanwhile, as NovaLCT does
  var out = [];
  return jobs.reduce(function (p, j) {
    return p.then(function () {
      log('rcv_send', { file: rg.name, processor: deviceLabel(j.d), cabinets: j.n, targets: j.targets.length, mode: mode, guard: j.level });
      return DRV.of(j.d).sendRcvFile(j.d, { data: rg.data, name: rg.name, kind: rg.ident.kind, cabinet: cab, targets: j.targets, verdict: j.level }).then(function (r) {
        out.push(deviceLabel(j.d) + ': ' + (r.ok ? 'sent to ' + j.n : 'failed — ' + r.error));
        if (r.ok) hwMarkUnsaved(j.d, 'receiving-card file ' + rg.name);
      }, function (e) { out.push(deviceLabel(j.d) + ': failed — ' + e.message); });
    });
  }, Promise.resolve()).then(function () {
    rg.busy = ''; hwEnd('send'); $('rcvDlg').hidden = true; toast(out.join(' · ')); log('rcv_send_done', { result: out });
    if (typeof renderUnsaved === 'function') renderUnsaved();
  });
}
function bindRcvGuard() {
  var f = $('rcvFile'), dlg = $('rcvDlg'); if (!f || !dlg) return;
  f.onchange = function () { rcvLoad(f.files[0]); };
  var open = $('mtRcv'); if (open) open.onclick = rcvPick;
  dlg.addEventListener('click', function (e) {
    if (e.target.id === 'rcvCancel' || e.target.id === 'rcvClose' || e.target === dlg) { if (rg.busy !== 'send') dlg.hidden = true; return; }
    if (e.target.closest('[data-rcvovr]') && !e.target.disabled) { rg.ovr = { text: '', note: '' }; rcvRender(); var t = $('rcvOvrNote'); if (t) t.focus(); return; }
    var s = e.target.closest('[data-rcvsend]'); if (s && !s.disabled) return rcvSend(s.dataset.rcvsend);
  });
  dlg.addEventListener('input', function (e) {   // the override panel: no redraw while typing, just the button
    if (!rg.ovr) return;
    if (e.target.id === 'rcvOvrNote') rg.ovr.note = e.target.value;
    if (e.target.id === 'rcvOvrText') { rg.ovr.text = e.target.value; var b = dlg.querySelector('[data-rcvsend="override"]'); if (b) b.disabled = !rcvOvrOk() || !!b.title; }
  });
  dlg.addEventListener('change', function (e) {
    if (e.target.id === 'rcvOvrNote' || e.target.id === 'rcvOvrText') return;
    if (rg.busy === 'send') { rcvRender(); return; }   // locked while sending
    if (e.target.id === 'rcvCab') { rg.cabinet = +e.target.value; return rcvCheck(); }
    var c = e.target.closest('[data-rcvdev]'); if (c) { rg.pick[c.dataset.rcvdev] = c.checked; return rcvCheck(); }
  });
  dlg.addEventListener('keydown', function (e) { if (e.key === 'Escape' && rg.busy !== 'send') dlg.hidden = true; });
}
