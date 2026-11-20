// app-maintain.js - the Maintain tab (design phase 12; Tools ▸ Maintain as in Unico / VMP), read-only part:
//   - the cabinet table: every placed panel with its processor, port and cable position, place and size, what the
//     processor detects there (cabinet / receiving card / firmware where the processor reports them) and its live
//     health (feed side, temperature, voltage) and its errors kept until Clear (right-click a row); filter, sort, CSV;
//   - the configuration check: per processor, the receiving-card configurations / firmware found (a mixed wall is listed),
//     panels placed but not detected or of another size;
//   - the show report: panels per type, processors / cards / ports with their load, backup — a printable HTML file.
// Writes to cabinets: the receiving-card file send (app-rcvguard.js) and Restart cabinets (Unico's / VMP's Maintain ▸
// Cabinet ▸ Restart): click rows to pick them (Ctrl/⌘ adds, Shift a range), then Restart cabinets… or right-click a row;
// it asks first (app-service.js svOpenCabinets). Coefficient reset and the like stay out (scope).
// Owns: mt, MT_COLS, mtRows, mtCsv, mtCheckHtml, mtReportHtml, mtDownload, mtPick, mtRestart, renderMaintain, bindMaintain.
// Depends on: app-core (P, ui, $, esc, fmt, toast), app-log (log), app-geometry (allCells), app-capacity (portUsage,
// portLabel, panelOf, capacity), app-hardware (hwPortCells, hwPortDetected), app-health (hlt, hltCabinet is not used:
// rows map by card / port / index), app-processors (deviceOfCard, cardsOfDevice, deviceLabel, procModel), app-service
// (svOpenCabinets), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var mt = { q: '', sort: 0, dir: 1, sel: new Set(), last: '' };   // sel: picked rows ('card:port:index')
var MT_COLS = ['Processor', 'Port', '#', 'X', 'Y', 'Size', 'Detected', 'Receiving card', 'Firmware', 'Feed', 'Temp', 'Voltage', 'Errors'];

function mtRows() {
  var cells = hwPortCells(), rows = [], gone = typeof olGone === 'function' ? olGone() : [];
  Object.keys(cells).sort(function (a, b) { var x = a.split(':'), y = b.split(':'); return x[0] - y[0] || x[1] - y[1]; }).forEach(function (k) {
    var sp = k.split(':'), card = +sp[0], port = +sp[1], d = deviceOfCard(card);
    if (d && gone.indexOf(d) >= 0) return;   // online: a processor that isn't connected (app-online.js)
    var det = hwPortDetected(card, port), h = d && hlt.by[d.id];
    cells[k].forEach(function (c, i) {
      var x = det ? det[i] : null, hc = null;
      if (h) { if (!h.idx) { h.idx = {}; h.cabinets.forEach(function (z) { h.idx[z.card + ':' + z.port + ':' + z.index] = z; }); } hc = h.idx[card + ':' + port + ':' + i]; }
      var held = typeof hltHeldAt === 'function' ? hltHeldAt(card, port, i) : [];   // errors kept until Clear (app-health)
      var lvl = det && !x ? 'err' : x && (x.w !== c.width || x.h !== c.height) ? 'err' : hc && (hc.dark || hc.tempStatus === 'error' || hc.voltStatus === 'error') ? 'err' :
        held.some(function (r) { return !r.ended && r.level === 'error'; }) ? 'err' :
        hc && (hc.side === 'backup' || hc.tempStatus === 'warning' || hc.voltStatus === 'warning' || hc.bitErrors) || held.length ? 'warn' : '';
      rows.push({ lvl: lvl, dev: d ? d.id : null, cab: card + ':' + port + ':' + i, v: [d ? deviceLabel(d) : '—', portLabel(card, port), i + 1, c.x, c.y, c.width + '×' + c.height,
        !det ? 'not detected yet' : !x ? 'missing' : (x.w !== c.width || x.h !== c.height ? x.w + '×' + x.h + ' ≠ ' : '') + (x.name || x.w + '×' + x.h),
        x ? x.card || '' : '', x ? x.fw || '' : '', hc ? (hc.dark ? 'dark' : hc.side) : '', hc && hc.temp != null ? tempFmt(hc.temp) : '', hc && hc.voltage ? hc.voltage.toFixed(2) + ' V' : '', held.length ? hltHeldText(held) : ''] });
    });
  });
  return rows;
}
function mtCsv(rows) {
  var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  return [MT_COLS].concat(rows.map(function (r) { return r.v; })).map(function (r) { return r.map(q).join(','); }).join('\r\n');
}
function mtDownload(text, type, name) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type }));
  a.download = (P.name || 'project').replace(/[^\w.-]+/g, '_') + name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
// Per processor: the configurations found (cabinet file / receiving card / firmware) and the cabinets that don't match.
function mtCheckHtml(rows) {
  var h = '';
  (typeof olShownDevices === 'function' ? olShownDevices() : P.devices).forEach(function (d) {   // online: the connected ones (app-online.js)
    var mine = rows.filter(function (r) { return r.dev === d.id; });   // by id: two processors may share a name
    if (!mine.length) return;
    var groups = {};
    mine.forEach(function (r) { if (/^(not detected yet|missing)$/.test(r.v[6])) return; var k = [r.v[6].replace(/^.*≠ /, ''), r.v[7], r.v[8]].filter(Boolean).join(' · ') || 'unknown'; groups[k] = (groups[k] || 0) + 1; });
    var keys = Object.keys(groups), miss = mine.filter(function (r) { return r.v[6] === 'missing'; }).length, size = mine.filter(function (r) { return / ≠ /.test(r.v[6]); }).length;
    var none = mine.every(function (r) { return r.v[6] === 'not detected yet'; });
    h += '<h4>' + esc(deviceLabel(d)) + '</h4><ul>';
    if (!d.hw) h += '<li class="hint">Not linked — link it to compare with the hardware.</li>';
    else if (none) h += '<li class="hint">Not detected yet (Device → Hardware → Detect now).</li>';
    else {
      h += keys.length > 1 ? '<li><b>Mixed wall:</b> ' + keys.length + ' configurations</li>' : '';
      h += keys.map(function (k) { return '<li>' + groups[k] + ' × ' + esc(k) + '</li>'; }).join('');
      if (keys.length > 1) h += '<li class="hint">A receiving-card file sent to the whole wall would overwrite the minority — send per group.</li>';
      if (miss) h += '<li class="rd-msg err">' + miss + ' cabinet(s) placed but not detected</li>';
      if (size) h += '<li class="rd-msg err">' + size + ' cabinet(s) of another size than detected</li>';
      if (!miss && !size && keys.length <= 1) h += '<li class="rd-msg ok">Placed = detected</li>';
    }
    h += '</ul>';
  });
  return h || '<p class="hint">No cabinets placed yet.</p>';
}
function mtReportHtml() {
  var cellsBy = allCells(), use = portUsage(cellsBy), types = {};
  P.screens.forEach(function (s) {
    var p = panelOf(s), n = (cellsBy[s.id] || []).filter(function (c) { return !c.hole; }).length, k = (p.name || 'Cabinet') + ' (' + p.w + '×' + p.h + ')';
    types[k] = (types[k] || 0) + n;
  });
  var total = Object.keys(types).reduce(function (a, k) { return a + types[k]; }, 0);
  var procs = (typeof olShownDevices === 'function' ? olShownDevices() : P.devices).map(function (d) {
    var cards = cardsOfDevice(d), ports = Object.keys(use).filter(function (k) { return cards.indexOf(use[k].sender) >= 0; });
    var maxLoad = ports.reduce(function (m, k) { var u = use[k]; return Math.max(m, u.cap ? u.load / u.cap : 0); }, 0);
    return '<tr><td>' + esc(deviceLabel(d)) + '</td><td>' + esc(procModel(d.model).name) + '</td><td>' + cards.length + '</td><td>' + ports.length + '</td><td>' + Math.round(maxLoad * 100) + ' %</td><td>' +
      (d.hw ? esc(d.hw.name + ' · ' + d.hw.host) : 'not linked') + '</td></tr>';
  }).join('');
  var b = P.backup || {}, bk = b.mode === 'port' ? (b.pairs || []).length + ' port pairs' : b.mode === 'card' ? (b.cards || []).length + ' backup cards' : 'none';
  return '<!doctype html><meta charset="utf-8"><title>Show report — ' + esc(P.name) + '</title>' +
    '<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222}table{border-collapse:collapse;margin:6px 0 18px}td,th{padding:5px 10px;border-bottom:1px solid #ddd;text-align:left}</style>' +
    '<h1>' + esc(P.name) + '</h1><p>Show report · ' + esc(new Date().toLocaleString()) + ' · Open Nova</p>' +
    '<h2>Screens</h2><ul>' + P.lct.map(function (l) { return '<li>' + esc(l.name) + '</li>'; }).join('') + '</ul>' +
    '<h2>Cabinets</h2><table><tr><th>Type</th><th>Count</th></tr>' + Object.keys(types).map(function (k) { return '<tr><td>' + esc(k) + '</td><td>' + types[k] + '</td></tr>'; }).join('') +
    '<tr><th>Total</th><th>' + total + '</th></tr></table>' +
    '<h2>Processors</h2><table><tr><th>Name</th><th>Model</th><th>Cards</th><th>Ports used</th><th>Busiest port</th><th>Link</th></tr>' + procs + '</table>' +
    '<h2>Backup</h2><p>' + esc(bk) + '</p><p>Canvas ' + P.canvasW + ' × ' + P.canvasH + ' · ' + P.bitDepth + '-bit · ' + P.refresh + ' Hz</p>';
}
// Click a row: pick it alone (again: unpick); Ctrl/⌘ adds or removes it; Shift picks the range from the last one, in the order shown.
function mtPick(key, e) {
  if (e.shiftKey && mt.last) {
    var keys = Array.prototype.map.call($('mtBody').querySelectorAll('tr[data-cab]'), function (tr) { return tr.dataset.cab; });
    var a = keys.indexOf(mt.last), b = keys.indexOf(key);
    if (a >= 0 && b >= 0) { keys.slice(Math.min(a, b), Math.max(a, b) + 1).forEach(function (k) { mt.sel.add(k); }); return renderMaintain(); }
  }
  if (e.ctrlKey || e.metaKey) { if (mt.sel.has(key)) mt.sel.delete(key); else mt.sel.add(key); }
  else if (mt.sel.size === 1 && mt.sel.has(key)) mt.sel.clear();
  else { mt.sel.clear(); mt.sel.add(key); }
  mt.last = key; renderMaintain();
}
// Restart the picked cabinets (asked first by the dialog). Nothing picked = nothing: never every cabinet by default (user,
// Phase A decision D3); the button is greyed until rows are picked.
function mtRestart(keys) {
  if (!keys) keys = Array.from(mt.sel);
  if (!keys.length) return toast('Select cabinets first');
  svOpenCabinets(keys);
}
function renderMaintain() {
  var box = $('mtBody'); if (!box || ui.tab !== 'maintain') return;
  var rows = mtRows(), q = mt.q.toLowerCase(), have = new Set(rows.map(function (r) { return r.cab; }));
  mt.sel.forEach(function (k) { if (!have.has(k)) mt.sel.delete(k); });   // a cabinet that went away isn't picked any more
  var shown = q ? rows.filter(function (r) { return r.v.join(' ').toLowerCase().indexOf(q) >= 0; }) : rows;
  shown = shown.slice().sort(function (a, b) { var x = a.v[mt.sort], y = b.v[mt.sort]; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * mt.dir; });
  box.innerHTML = rows.length ? '<p class="hint">' + shown.length + ' of ' + rows.length + ' cabinets' + (mt.sel.size ? ' · ' + mt.sel.size + ' picked' : '') + itip('Red = missing / other size / fault · amber = on backup / warning. Click a column to sort; click rows to pick them (Ctrl/⌘ adds, Shift a range); right-click a cabinet to clear its errors or restart it.') + '</p>' +
    '<table class="mt-tbl"><tr>' + MT_COLS.map(function (c, i) { return '<th data-mt="' + i + '">' + esc(c) + (mt.sort === i ? (mt.dir > 0 ? ' ▴' : ' ▾') : '') + '</th>'; }).join('') + '</tr>' +
    shown.map(function (r) { return '<tr class="' + r.lvl + (mt.sel.has(r.cab) ? ' sel' : '') + '" data-cab="' + r.cab + '">' + r.v.map(function (v) { return '<td>' + esc(v) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>'
    : '<p class="hint">No cabinets placed yet.</p>';
  $('mtCheck').innerHTML = mtCheckHtml(rows);
  var rb = $('mtRestart');
  if (rb) { rb.textContent = mt.sel.size ? 'Restart ' + mt.sel.size + ' cabinet' + (mt.sel.size === 1 ? '' : 's') + '…' : 'Restart cabinets…'; rb.disabled = !mt.sel.size;
    rb.title = mt.sel.size ? 'Restart the picked cabinets’ receiving cards (asks first)' : 'Select cabinets first'; }
}
function bindMaintain() {
  var f = $('mtFilter'); if (!f) return;
  f.addEventListener('input', function () { mt.q = f.value; renderMaintain(); });
  f.addEventListener('keydown', function (e) { e.stopPropagation(); });
  $('mtBody').addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-cab]'); if (tr) return mtPick(tr.dataset.cab, e);
    var th = e.target.closest('[data-mt]'); if (!th) return;
    var i = +th.dataset.mt; if (mt.sort === i) mt.dir = -mt.dir; else { mt.sort = i; mt.dir = 1; }
    renderMaintain();
  });
  $('mtBody').addEventListener('contextmenu', function (e) {   // right-click a cabinet: clear its errors (app-health)
    var tr = e.target.closest('tr[data-cab]'); if (!tr || typeof hltClearMenu !== 'function') return;
    var k = tr.dataset.cab, sp = k.split(':').map(Number), many = mt.sel.size > 1 && mt.sel.has(k);
    var more = [{ sep: true }, { label: 'Restart this cabinet…', act: function () { mtRestart([k]); } }];
    if (many) more.push({ label: 'Restart the ' + mt.sel.size + ' picked cabinets…', act: function () { mtRestart(Array.from(mt.sel)); } });
    e.preventDefault(); hltClearMenu(e.clientX, e.clientY, { card: sp[0], port: sp[1], index: sp[2] }, more);
  });
  $('mtRestart').onclick = function () { mtRestart(); };
  $('mtCsv').onclick = function () { var r = mtRows(); if (!r.length) return toast('No cabinets placed yet'); log('maintain_csv', { rows: r.length }); mtDownload(mtCsv(r), 'text/csv', '_cabinets.csv'); };
  $('mtReport').onclick = function () { log('show_report', {}); mtDownload(mtReportHtml(), 'text/html', '_show_report.html'); };
}
