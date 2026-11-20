// app-preshow.js - the pre-show check (design phase 9): one button on the Monitor tab that goes through everything
// that can bite before doors open, per processor, and says what to do: not linked or not answering, panels placed
// ≠ detected, the processor's layout ≠ the project (where it can be read back), unsaved changes, backup not verified or
// its cables down, cabinets on backup / dark / hot / with bit errors, the project's own problems (capacity, wiring),
// and a blackout / freeze / test pattern still on. Read-only: it never writes to a processor.
// The result can be downloaded as an HTML report.
// Owns: pre, preCheck, preHtml, preReportDownload.
// Depends on: app-core (P, ui, $, esc, fmt, toast), app-log (log), app-geometry (allCells), app-capacity (portUsage,
// problems, portLabel), app-hardware (hw, hwPortCells, hwTileProblem, hwDetectedOf), app-health (hlt, hltPoll, hltWhere),
// app-redundancy (rd), app-display (disp), app-processors (cardsOfDevice, deviceLabel, procModel), drv-core (DRV), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var pre = { running: false, result: null };   // result = { at, items: [{level: ok|warn|err, dev, text, fix}] }

// Resolves once nothing is in flight for that test (a running reading must finish, so the check never judges stale data).
function preWait(busy) { return new Promise(function (ok) { (function loop(n) { if (!busy() || n > 600) ok(); else setTimeout(function () { loop(n + 1); }, 100); })(0); }); }
function preCheck() {
  if (pre.running) return pre.promise || Promise.resolve();
  pre.running = true; if (typeof renderHealth === 'function') renderHealth();
  var items = [], add = function (level, dev, text, fix) { items.push({ level: level, dev: dev, text: text, fix: fix || '' }); };
  var cellsBy = allCells(), use = portUsage(cellsBy), cells = hwPortCells();
  problems(cellsBy, use).forEach(function (p) { add('err', 'Project', p, 'Fix it on the Layout tab, then Send.'); });
  if (disp.mode !== 'normal' || disp.pattern) add('warn', 'Show', disp.pattern ? 'A test pattern is on' : disp.mode === 'blackout' ? 'Blackout is on' : 'Freeze is on', 'Press Normal (Alt+N).');
  var jobs = P.devices.map(function (d) {
    var name = deviceLabel(d), mine = cardsOfDevice(d);
    var placed = Object.keys(cells).filter(function (k) { return mine.indexOf(+k.split(':')[0]) >= 0; });
    if (!d.hw) { add('warn', name, 'Not linked — nothing on this processor was checked', 'Device tab → Hardware → Find processors.'); return Promise.resolve(); }
    if (DRV.caps(d).simulated) add('warn', name, 'Linked to a simulated processor', 'Link the real one before the show.');
    // health first (fresh read), then everything that uses it
    return preWait(function () { return (hw.watch[d.id] || {}).inflight; })
      .then(function () { return hw.live[d.id] ? null : hwDetect(d, true); })
      .then(function () { return preWait(function () { return (hlt.watch[d.id] || {}).inflight; }); })
      .then(function () { return hltPoll(d); }).then(function () {
      var w = hlt.watch[d.id] || {}, h = hlt.by[d.id];
      if (w.err) { add('err', name, hwErrText(w.err), 'Check the network and the processor’s power; is the helper running?'); return; }
      // placed vs detected
      if (!hw.live[d.id]) add('warn', name, 'Cabinets not detected yet', 'Hardware card → Detect now.');
      else placed.forEach(function (k) {
        var sp = k.split(':'), why = hwTileProblem(+sp[0], +sp[1]);
        var det = hwPortDetected(+sp[0], +sp[1]) || [], nm = (cells[k] || []).length;
        if (why) add('err', name, portLabel(+sp[0], +sp[1]) + ': ' + why, /crossed/.test(why) ? (alarmInfo('ports 1 and 2 crossed') || {}).suggestion : 'Check the cabling on that port, or fix the layout.');
        else if (det.length > nm) add('warn', name, portLabel(+sp[0], +sp[1]) + ': ' + nm + ' cabinets mapped, ' + det.length + ' answer', 'The cable has cabinets the layout doesn’t map (they’re still monitored): check which cable is in which port, or fix the layout and Send.');
        else if (!(hwPortDetected(+sp[0], +sp[1]) || []).length) add('err', name, portLabel(+sp[0], +sp[1]) + ': cabinets placed, none detected', 'Check the cable and power on that port.');
      });
      if (hw.unsaved && hw.unsaved[d.id]) add('warn', name, 'Changes not saved on the processor (' + (hw.unsaved[d.id].why || 'edits') + ')', 'Save, or a power cycle loses them.');
      // backup
      var pairs = P.backup && P.backup.mode === 'port' ? P.backup.pairs.filter(function (q) { return mine.indexOf(q.ms) >= 0; }) : [];
      if (pairs.length && !(rd.verified && rd.verified[d.id])) add('warn', name, pairs.length + ' backup pair(s) not verified this session', 'Backup tab → press Verify, look at the wall, then press Verify again.');
      if (h) {
        // a whole fibre down (app-health.js hltFiber) is one line, as on Monitor, not one per port
        h.events.forEach(function (e) {
          if (e.cardWide) add(e.level === 'error' ? 'err' : 'warn', name, hltWhere(e) + ': ' + e.text, (alarmInfo(e.text) || {}).suggestion || '');
        });
        h.ports.forEach(function (p) {
          if (p.backup && p.backup.link === false && !p.backupOpt) add('err', name, portLabel(p.card, p.port) + ': backup port ' + portLabel(p.backup.card, p.backup.port) + ' has no link', 'Plug in the backup cable.');
          if (!p.opt && !/^(ok|redundant, ok)$/.test(p.link || 'ok')) add('err', name, portLabel(p.card, p.port) + ': ' + p.link, (alarmInfo(p.link) || {}).suggestion || '');
        });
        var s = h.sum || {};
        if (s.dark) add('err', name, s.dark + ' cabinet(s) dark', (alarmInfo('dark') || {}).suggestion);
        if (s.backup) add('warn', name, s.backup + ' cabinet(s) fed from backup', (alarmInfo('running on backup') || {}).suggestion);
        if (s.err) add('err', name, s.err + ' cabinet(s) with temperature / voltage errors', 'See the Monitor events.');
        else if (s.warn) add('warn', name, s.warn + ' cabinet(s) with temperature / voltage warnings', 'See the Monitor events.');
        var be = h.cabinets.filter(function (c) { return c.bitErrors; }).length;
        if (be) add('warn', name, be + ' cabinet(s) report bit errors', (alarmInfo('bit errors') || {}).suggestion);
      }
      // the processor's own layout vs the project (drivers that can read it back)
      var drv = DRV.of(d);
      if (!drv.readLayout || DRV.caps(d).simulated) return;
      return drv.readLayout(d).then(function (r) {
        if (!r.ok) { add('warn', name, 'Couldn’t read the layout back: ' + r.error); return; }
        var got = {}; r.cabinets.forEach(function (c) { var k = mine[c.card || 0] + ':' + c.port; got[k] = (got[k] || 0) + 1; });
        var diff = Object.keys(cells).filter(function (k) { return mine.indexOf(+k.split(':')[0]) >= 0; }).concat(Object.keys(got))
          .filter(function (k, i, a) { return a.indexOf(k) === i && (cells[k] || []).length !== (got[k] || 0); });
        if (diff.length) add('err', name, 'The processor’s layout differs from the project on ' + diff.length + ' port(s) (' + diff.slice(0, 3).map(function (k) { return portLabel(+k.split(':')[0], +k.split(':')[1]); }).join(', ') + ')', 'Send the layout (or Compare to see the differences).');
      }, function (e) { add('warn', name, 'Couldn’t read the layout back: ' + e.message); });
    });
  });
  return (pre.promise = Promise.all(jobs).then(function () {
    var order = { err: 0, warn: 1, ok: 2 };
    items.sort(function (a, b) { return order[a.level] - order[b.level]; });
    if (!items.length) add('ok', 'All', 'Everything checked is fine', '');
    pre.result = { at: Date.now(), items: items }; pre.running = false;
    var n = items.filter(function (x) { return x.level === 'err'; }).length, m = items.filter(function (x) { return x.level === 'warn'; }).length;
    log('preshow_check', { errors: n, warnings: m });
    toast(n ? 'Pre-show check: ' + n + ' problem(s), ' + m + ' warning(s)' : m ? 'Pre-show check: ' + m + ' warning(s)' : 'Pre-show check: all fine');
    if (typeof renderHealth === 'function') renderHealth();
  }).catch(function (e) {   // never leave the check "running"
    pre.running = false; log('preshow_check', { error: e.message }); toast('Pre-show check failed: ' + e.message);
    if (typeof renderHealth === 'function') renderHealth();
  }));
}

function preHtml() {
  if (pre.running) return '<div class="pre-card"><b>Pre-show check</b> <span class="hint">checking…</span></div>';
  var r = pre.result; if (!r) return '';
  var n = r.items.filter(function (x) { return x.level === 'err'; }).length, m = r.items.filter(function (x) { return x.level === 'warn'; }).length;
  return '<div class="pre-card"><div class="pre-h"><b>Pre-show check</b><span class="hint">' + new Date(r.at).toLocaleTimeString() + ' · ' + (n ? n + ' problem' + (n === 1 ? '' : 's') : 'no problems') + (m ? ', ' + m + ' warning' + (m === 1 ? '' : 's') : '') + '</span>' +
    '<span class="grow"></span><button class="mini" data-pre="report" title="Download this check as an HTML report">Report</button><button class="mini" data-pre="close">Close</button></div>' +
    '<ul class="pre-list">' + r.items.map(function (x) {
      return '<li class="' + x.level + '"><span class="pre-dot"></span><span><b>' + esc(x.dev) + '</b> · ' + esc(x.text) + (x.fix ? '<br><span class="hint">' + esc(x.fix) + '</span>' : '') + '</span></li>';
    }).join('') + '</ul></div>';
}
function preReportDownload() {
  var r = pre.result; if (!r) return;
  var lv = { err: 'Problem', warn: 'Warning', ok: 'OK' };
  var html = '<!doctype html><meta charset="utf-8"><title>Pre-show check — ' + esc(P.name) + '</title>' +
    '<style>body{font:14px system-ui,sans-serif;margin:24px;color:#222}td,th{padding:6px 10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}.err{color:#b42318}.warn{color:#9a6700}.ok{color:#1a7f37}</style>' +
    '<h1>Pre-show check — ' + esc(P.name) + '</h1><p>' + esc(new Date(r.at).toLocaleString()) + ' · Open Nova</p>' +
    '<h2>Processors</h2><ul>' + P.devices.map(function (d) { return '<li>' + esc(deviceLabel(d)) + ' — ' + esc(procModel(d.model).name) + (d.hw ? ' · ' + esc(d.hw.name + ' ' + d.hw.host) : ' · not linked') + '</li>'; }).join('') + '</ul>' +
    '<h2>Results</h2><table><tr><th>Level</th><th>Where</th><th>What</th><th>What to do</th></tr>' + r.items.map(function (x) {
      return '<tr class="' + x.level + '"><td>' + lv[x.level] + '</td><td>' + esc(x.dev) + '</td><td>' + esc(x.text) + '</td><td>' + esc(x.fix) + '</td></tr>';
    }).join('') + '</table>';
  var a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = (P.name || 'project').replace(/[^\w.-]+/g, '_') + '_preshow_' + new Date(r.at).toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.html';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
}
