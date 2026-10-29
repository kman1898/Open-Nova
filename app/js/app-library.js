// app-library.js - Tools ▸ Cabinet library: the receiving-card files (.rcfgx / NCP / RCCB .bin) kept by the helper
// (tools/rcvlib.py, folder Nova\library), shared by every device that opens the app. User, 2026-10-10: "a RCFGX/NCP
// library that only works with the panels that match unless you override them" and "alert if two files have same RCFGX
// or NCP but differ on firmware".
// Pick a processor: its receiving cards are read once (read-only) and every file is checked against them with the file
// guard's rules; only the files that fit are shown unless "Show all (override)" is ticked. Firmware conflicts (the same
// cabinet in files of different firmware) are listed on the right and marked in the table. Send… opens the file guard
// dialog (app-rcvguard.js) — the library never sends past a BLOCK except through that dialog's typed override.
// Owns: lb, LB_LEVEL_TEXT, lbLevel, lbLoad, lbAdd, lbMatch, lbRows, renderLibrary, bindLibrary.
// Depends on: app-core (P, ui, $, esc, toast), app-log (log), drv-core (DRV), app-processors (deviceById, deviceLabel,
// procModel), app-rcvguard (rcvB64, rcvStart, rcvCards), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var lb = { files: [], conflicts: [], folder: '', loaded: false, busy: '', forDev: '', all: false, q: '', match: null, matchFor: '', error: '' };
var LB_LEVEL_TEXT = { ok: 'fits', info: 'fits', warn: 'check', part: 'fits some', block: 'doesn’t fit' };
// A file's standing against the panels: a mixed wall where some cabinets match is 'part' (fits N of M), not 'block'.
function lbLevel(m) { return !m ? '' : m.level !== 'block' ? m.level : m.sendable > 0 ? 'part' : 'block'; }

function lbLoad() {
  lb.busy = 'load'; renderLibrary();
  return DRV.post('rcv', '/api/rcv/lib/list', {}).then(function (r) {
    lb.busy = ''; lb.loaded = true; lb.error = r.ok ? '' : r.error;
    if (r.ok) { lb.files = r.files || []; lb.conflicts = r.conflicts || []; lb.folder = r.folder || ''; }
    renderLibrary();
  }, function (e) { lb.busy = ''; lb.error = 'the helper isn’t reachable (' + e.message + ')'; renderLibrary(); });
}
// Add files one after the other (each is read by the helper; a damaged one is refused with the reason).
function lbAdd(list) {
  list = Array.prototype.slice.call(list || []).filter(function (f) { return /\.(rcfgx|ncp|bin)$/i.test(f.name); });
  if (!list.length) return toast('No .rcfgx, .ncp or .bin files in that selection');
  var added = 0, dup = 0, bad = [];
  lb.busy = 'add'; renderLibrary();
  return list.reduce(function (p, f) {
    return p.then(function () {
      if (f.size > 45 * 1024 * 1024) { bad.push(f.name + ' (over 45 MB)'); return; }
      return f.arrayBuffer().then(function (buf) { return DRV.post('rcv', '/api/rcv/lib/add', { name: f.name, data: rcvB64(buf) }); }).then(function (r) {
        if (!r.ok) bad.push(f.name + ' — ' + (r.error || 'refused')); else if (r.duplicate) dup++; else added++;
      }, function (e) { bad.push(f.name + ' — ' + e.message); });
    });
  }, Promise.resolve()).then(function () {
    log('library_add', { added: added, duplicates: dup, refused: bad });
    toast('Added ' + added + ' file' + (added === 1 ? '' : 's') + (dup ? ', ' + dup + ' already in the library' : '') + (bad.length ? ', ' + bad.length + ' refused: ' + bad[0] + (bad.length > 1 ? ' …' : '') : ''));
    lb.match = null; return lbLoad();
  }).then(function () { if (lb.forDev) lbMatch(); });
}
// Read the chosen processor's cards and check every file against them.
function lbMatch() {
  var d = deviceById(lb.forDev); lb.match = null; lb.matchFor = '';
  if (!d) return renderLibrary();
  lb.busy = 'match'; renderLibrary();
  return rcvCards(d, true).then(function (r) {
    if (!r.ok) throw new Error(r.error);
    return DRV.post('rcv', '/api/rcv/lib/match', { cards: r.list, family: r.fam }).then(function (x) {
      if (!x.ok) throw new Error(x.error || 'match failed');
      lb.match = x.match; lb.matchFor = d.id; lb.cards = r.list.length;
      log('library_match', { processor: deviceLabel(d), cards: r.list.length, fits: Object.keys(x.match).filter(function (k) { return x.match[k].some(function (m) { return lbLevel(m) !== 'block'; }); }).length });
    });
  }).catch(function (e) { toast('Couldn’t read ' + deviceLabel(d) + '’s cabinets: ' + e.message); })
    .then(function () { lb.busy = ''; renderLibrary(); });
}
// One row per cabinet of each file: {f, ci, s (summary), m (match or null), conflict (other firmware text or '')}
function lbRows() {
  var conf = {};
  lb.conflicts.forEach(function (c) { c.files.forEach(function (x) { conf[x.id + ':' + x.cabinet] = c; }); });
  var rows = [];
  lb.files.forEach(function (f) {
    f.cabinets.forEach(function (s, ci) {
      var m = lb.match && lb.match[f.id] ? lb.match[f.id][ci] : null, c = conf[f.id + ':' + ci];
      rows.push({ f: f, ci: ci, s: s, m: m, conflict: c ? c.firmware.filter(function (v) { return v !== s.firmware; }).join(', ') : '' });
    });
  });
  var q = lb.q.trim().toLowerCase();
  if (q) rows = rows.filter(function (r) { return (r.f.name + ' ' + (r.s.text || '') + ' ' + (r.s.mfr || '') + ' ' + (r.s.cabinet || '') + ' ' + (r.s.card || '') + ' ' + (r.s.chip || '')).toLowerCase().indexOf(q) >= 0; });
  var rank = { ok: 0, info: 0, warn: 1, part: 2, block: 3 };
  if (lb.match) {
    if (!lb.all) rows = rows.filter(function (r) { return r.m && lbLevel(r.m) !== 'block'; });
    rows.sort(function (a, b) { return (rank[lbLevel(a.m) || 'block'] - rank[lbLevel(b.m) || 'block']) || a.f.name.localeCompare(b.f.name); });
  } else rows.sort(function (a, b) { return a.f.name.localeCompare(b.f.name); });
  return rows;
}
function renderLibrary() {
  var box = $('lbBody'); if (!box || ui.tab !== 'library') return;
  if (!lb.loaded && !lb.busy && !lb.error) { lbLoad(); return; }
  // the processor picker (linked processors only)
  var sel = $('lbFor'), linked = P.devices.filter(function (d) { return d.hw; });
  sel.innerHTML = '<option value="">Cabinets: — pick a processor —</option>' + linked.map(function (d) { return '<option value="' + d.id + '"' + (d.id === lb.forDev ? ' selected' : '') + '>Fits ' + esc(deviceLabel(d)) + '</option>'; }).join('');
  $('lbAll').checked = lb.all; $('lbAll').disabled = !lb.match;
  $('lbFolder').textContent = lb.folder ? lb.files.length + ' file' + (lb.files.length === 1 ? '' : 's') : '';
  $('lbFolder').title = lb.folder ? 'Kept in ' + lb.folder : '';
  if (lb.error) { box.innerHTML = '<p class="rcv-bad">' + esc(lb.error) + '</p>'; }
  else {
    var rows = lbRows(), total = lb.files.reduce(function (n, f) { return n + f.cabinets.length; }, 0), h = '';
    if (lb.busy === 'match') h += '<p class="hint">Reading the cabinets and checking every file…</p>';
    else if (lb.busy === 'add') h += '<p class="hint">Adding…</p>';
    else if (lb.match) h += '<p class="hint">' + (lb.all ? 'All ' + total + ' files, ' : rows.length + ' of ' + total + ' fit ') + esc(deviceLabel(deviceById(lb.matchFor) || {})) + '’s ' + lb.cards + ' cabinets' + (lb.all ? ' — the ones that don’t fit are red; sending one needs the check’s typed override' : ' — tick “Show all (override)” for the rest') + '.</p>';
    else if (lb.files.length) h += '<p class="hint">' + lb.files.length + ' file' + (lb.files.length === 1 ? '' : 's') + itip('Pick a processor above to see only the files that fit its cabinets.') + '</p>';
    if (!lb.files.length && !lb.busy) h += '<p class="hint">The library is empty — Add files… or Add folder…' + itip('Add .rcfgx / .ncp files (several at once, or a whole folder): they are checked and kept on this computer for every device that opens the app.') + '</p>';
    if (rows.length) {
      h += '<table class="mt-tbl lb-table"><thead><tr><th></th><th>File</th><th>Made for</th><th>Size · modules</th><th>Chip · scan</th><th>Firmware</th><th></th></tr></thead><tbody>' +
        rows.map(function (r) {
          var s = r.s, m = r.m, lv = lbLevel(m);
          var badge = m ? '<span class="lb-fit ' + lv + '" title="' + esc((m.reasons || []).join('\n') || m.title) + '">' + (lv === 'part' ? 'fits ' + m.sendable + ' of ' + m.total : LB_LEVEL_TEXT[lv]) + '</span>' : '';
          return '<tr class="' + (lv === 'block' ? 'bad' : '') + '"><td>' + badge + '</td>' +
            '<td><b>' + esc(r.f.name) + '</b><br><span class="hint">' + esc(r.f.kind === 'ncp' ? 'NCP' + (r.f.cabinets.length > 1 ? ' · cabinet ' + (r.ci + 1) + ' of ' + r.f.cabinets.length : '') : r.f.kind === 'rcfgx' ? '.rcfgx' : 'RCCB .bin') + ' · ' + Math.round(r.f.size / 1024) + ' KB</span></td>' +
            '<td>' + esc([s.mfr, s.cabinet].filter(Boolean).join(' · ') || '—') + '<br><span class="hint">' + esc(s.card || 'card not named') + '</span></td>' +
            '<td>' + (s.w ? s.w + '×' + s.h : '—') + '<br><span class="hint">' + (s.modW ? s.modW + '×' + s.modH + ' modules' : '') + '</span></td>' +
            '<td>' + esc(s.chip || '—') + '<br><span class="hint">' + (s.scan ? '1/' + s.scan + ' scan' : '') + '</span></td>' +
            '<td>' + esc(s.firmware || '—') + (r.conflict ? ' <span class="lb-conf" title="The same cabinet is in the library with firmware ' + esc(r.conflict) + '">⚠ also ' + esc(r.conflict) + '</span>' : '') + '</td>' +
            '<td class="lb-act"><button class="mini" data-lb="send" data-id="' + r.f.id + '" data-ci="' + r.ci + '" title="Check against the cabinets and send (the check decides)">Send…</button>' +
            '<button class="mini" data-lb="remove" data-id="' + r.f.id + '" title="Take it out of the library (the file is kept in library\\_removed)">×</button></td></tr>';
        }).join('') + '</tbody></table>';
    } else if (lb.files.length && lb.match && !lb.busy) h += '<p class="hint">No file in the library fits these cabinets. Tick “Show all (override)” to see why each one doesn’t.</p>';
    box.innerHTML = h;
  }
  // firmware conflicts
  var cf = $('lbConf');
  cf.innerHTML = lb.conflicts.length ? '<p class="hint">The same cabinet in files of different firmware — make sure the one you send matches the cards’ firmware.</p>' +
    lb.conflicts.map(function (c) {
      // one line per firmware with its file count; the file names fold out
      var by = {}; c.files.forEach(function (x) { var k = x.firmware || 'firmware not recorded'; (by[k] = by[k] || []).push(x.name); });
      return '<div class="rcv-grp warn"><div class="rcv-gh"><b>' + esc(c.label) + '</b></div>' + Object.keys(by).sort().map(function (k) {
        return '<details class="lb-fw"><summary><b>' + esc(k) + '</b> · ' + by[k].length + ' file' + (by[k].length === 1 ? '' : 's') + '</summary><ul>' +
          by[k].map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul></details>';
      }).join('') + '</div>';
    }).join('') : '<p class="hint">' + (lb.files.length ? 'No conflicts' + itip('No cabinet is in the library with two different firmware versions.') : 'Nothing yet.') + '</p>';
}
function bindLibrary() {
  var box = $('lbBody'); if (!box) return;
  $('lbAdd').onclick = function () { var f = $('lbFiles'); f.value = ''; f.click(); };
  $('lbAddDir').onclick = function () { var f = $('lbDir'); f.value = ''; f.click(); };
  $('lbFiles').onchange = function () { lbAdd(this.files); };
  $('lbDir').onchange = function () { lbAdd(this.files); };
  $('lbFor').onchange = function () { lb.forDev = this.value; lb.all = false; lbMatch(); };
  $('lbAll').onchange = function () { lb.all = this.checked; log('library_show_all', { on: lb.all }); renderLibrary(); };
  $('lbFilter').oninput = function () { lb.q = this.value; renderLibrary(); };
  $('lbReload').onclick = function () { lb.match = null; lbLoad().then(function () { if (lb.forDev) lbMatch(); }); };
  box.addEventListener('click', function (e) {
    var b = e.target.closest('[data-lb]'); if (!b) return;
    var f = lb.files.filter(function (x) { return x.id === b.dataset.id; })[0]; if (!f) return;
    if (b.dataset.lb === 'remove') {
      if (!confirm('Take “' + f.name + '” out of the library?\n\nThe file is kept in the library’s _removed folder.')) return;
      return DRV.post('rcv', '/api/rcv/lib/remove', { id: f.id }).then(function () { log('library_remove', { file: f.name }); lb.match = null; return lbLoad(); }).then(function () { if (lb.forDev) lbMatch(); });
    }
    if (b.dataset.lb === 'send') {
      b.disabled = true;
      DRV.post('rcv', '/api/rcv/lib/get', { id: f.id }).then(function (r) {
        b.disabled = false; if (!r.ok) return toast('Couldn’t read it from the library: ' + r.error);
        rcvStart(r.name, r.data, +b.dataset.ci, lb.forDev ? [lb.forDev] : null);   // the check dialog decides
      }, function (e) { b.disabled = false; toast('Helper not reachable: ' + e.message); });
    }
  });
}
