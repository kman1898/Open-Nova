// app-log.js - troubleshooting log, modelled on LED Raster Designer's (sendClientLog + a log
// file on the server + a viewer). One entry = {action, details, client, os, clientTime}.
//  - log(action, details): keeps the last LOG_KEEP entries in this browser and, when the app is
//    served by serve.ps1, sends them in batches (NDJSON, POST api/log) to the server's log file,
//    which PC and Mac share (each entry says which machine: os + client id).
//  - Automatic: JS errors and unhandled promise failures, every button click and form change,
//    every message shown to the user (toast), and for every committed edit a before -> after
//    summary of what changed (logChange, called by commit).
//  - App actions: every click / change / shortcut gets an id (logAct, logActNew); entries made in it carry it
//    (e.act), and so do the helper calls it makes (logActBody → the helper's recording), see "app actions" below.
//  - Trace mode (Logs window, "Trace every function call"): wraps every app function so each
//    call is logged with its arguments, except the ones that run on every redraw / mouse move.
//  - The Logs window (Logs button): server file or this browser's entries, filters, copy,
//    download, clear.
// Loads right after app-core.js. Nothing runs at load beyond listeners and plain values.
// Calls into later files at run time only: sync (app-sync), screenById etc. via the project data.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

var LOG_KEEP = 3000;           // entries kept in this browser
var LOG_TRACE_PER_SEC = 150;   // trace mode: at most this many call entries per second
var logState = { buf: [], queue: [], t: null, server: /^https?:$/.test(location.protocol),
  trace: false, wrapped: null, traceSec: 0, traceN: 0, traceDropped: 0 };
// The app action now running (docs/DIAGNOSTICS.md "Actions"): {id: "<tab>-<n>", what, at, by}. See logActNew below.
var logAct = { tab: Math.random().toString(36).slice(2, 6), n: 0, cur: null };

// ------------------------------------------------------------------ writing entries
function log(action, details) {
  try {
    var e = { action: action, details: details || {}, client: (typeof sync !== 'undefined' && sync.id) || '',
      os: IS_MAC ? 'Mac' : 'PC', clientTime: new Date().toISOString() };
    if (logAct.cur) e.act = logAct.cur.id;   // the user action this happened in (the helper's recording carries the same id)
    var line = JSON.stringify(e).replace(/[\r\n]/g, ' ');
    logState.buf.push(line);
    if (logState.buf.length > LOG_KEEP) logState.buf.splice(0, logState.buf.length - LOG_KEEP);
    if (!logState.server) return;
    logState.queue.push(line);
    if (logState.queue.length >= 200) logFlush();
    else if (!logState.t) logState.t = setTimeout(logFlush, 1000);
  } catch (err) { /* logging must never break the app */ }
}
function logFlush(leaving) {
  clearTimeout(logState.t); logState.t = null;
  if (!logState.queue.length) return;
  var body = logState.queue.join('\n'); logState.queue = [];
  try {
    if (leaving && navigator.sendBeacon) { navigator.sendBeacon('api/log', new Blob([body], { type: 'text/plain' })); return; }
    fetch('api/log', { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: body, keepalive: body.length < 60000 })
      .catch(function () { /* server away: the entries are still in this browser's buffer */ });
  } catch (err) { /* ignore */ }
}
// Short, loggable description of a value (no whole projects in the log).
function logBrief(v) {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '…' : v;
  if (typeof v === 'function') return 'function ' + (v.name || '');
  if (v instanceof Event) return v.type + ' event';
  if (v instanceof Set) return 'Set(' + v.size + ')';
  if (v instanceof ArrayBuffer) return 'ArrayBuffer(' + v.byteLength + ' bytes)';
  if (v instanceof Uint8Array) return 'bytes(' + v.length + ')';
  if (v instanceof Element) return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + '>';
  if (Array.isArray(v)) return 'array(' + v.length + ')';
  if (v.id && v.name != null) return (v.cols != null || v.regions ? 'section' : 'item') + ' "' + v.name + '" (' + v.id + ')';
  if (v.x != null && v.y != null && Object.keys(v).length <= 4) return '{x:' + Math.round(v.x) + ',y:' + Math.round(v.y) + '}';
  if (v.sender != null && v.port != null) return portLabel(v.sender, v.port);
  var ks = Object.keys(v); return '{' + ks.slice(0, 6).join(',') + (ks.length > 6 ? ',…' : '') + '}';
}

// ------------------------------------------------------------------ what an edit changed
// Compares the project before (its saved JSON) with now and lists the differences in words.
function logChange(beforeSnap) {
  try {
    var a = beforeSnap ? JSON.parse(beforeSnap) : null, b = P, out = [];
    if (!a) return log('change', { what: ['new project'] });
    var val = function (x) { return x === undefined ? '—' : typeof x === 'object' ? JSON.stringify(x) : x; };
    ['name', 'canvasW', 'canvasH', 'bitDepth', 'refresh', 'lowLatency', 'rxCard'].forEach(function (k) {
      if (a[k] !== b[k]) out.push(k + ': ' + val(a[k]) + ' → ' + val(b[k]));
    });
    if (a.processors.length !== b.processors.length) out.push('cards: ' + a.processors.length + ' → ' + b.processors.length);
    b.processors.forEach(function (p, i) { if (a.processors[i] && a.processors[i].ports !== p.ports) out.push('card ' + (i + 1) + ' ports: ' + a.processors[i].ports + ' → ' + p.ports); });
    var devs = function (pj) { return (pj.devices || []).map(function (d) { return d.model + '×' + (pj.processors || []).filter(function (c) { return c.dev === d.id; }).length; }).join(', '); };
    if (devs(a) !== devs(b)) out.push('processors: ' + (devs(a) || '—') + ' → ' + devs(b));
    var byId = function (arr) { var m = {}; (arr || []).forEach(function (x) { m[x.id] = x; }); return m; };
    var diffList = function (label, A, B, fields) {
      var ma = byId(A), mb = byId(B);
      Object.keys(ma).forEach(function (id) { if (!mb[id]) out.push(label + ' removed: "' + ma[id].name + '"'); });
      Object.keys(mb).forEach(function (id) {
        var x = ma[id], y = mb[id];
        if (!x) { out.push(label + ' added: "' + y.name + '"'); return; }
        fields.forEach(function (f) { if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) out.push(label + ' "' + y.name + '" ' + f + ': ' + val(x[f]) + ' → ' + val(y[f])); });
      });
    };
    diffList('panel', a.panels, b.panels, ['name', 'w', 'h']);
    diffList('screen', a.lct, b.lct, ['name']);
    var sa = byId(a.screens), lctName = function (id) { var l = (b.lct || []).find(function (x) { return x.id === id; }) || (a.lct || []).find(function (x) { return x.id === id; }); return l ? l.name : id; };
    Object.keys(sa).forEach(function (id) { if (!b.screens.some(function (s) { return s.id === id; })) out.push('section removed: "' + sa[id].name + '" (' + lctName(sa[id].screenId) + ')'); });
    b.screens.forEach(function (s) {
      var o = sa[s.id], nm = 'section "' + s.name + '"';
      if (!o) { out.push('section added: "' + s.name + '" on ' + lctName(s.screenId) + ' at ' + s.x + ',' + s.y + (s.cols ? ' (' + s.cols + '×' + s.rows + ')' : '')); return; }
      if (o.name !== s.name) out.push('section "' + o.name + '" renamed → "' + s.name + '"');
      if (o.x !== s.x || o.y !== s.y) out.push(nm + ' moved ' + o.x + ',' + o.y + ' → ' + s.x + ',' + s.y);
      if (o.screenId !== s.screenId) out.push(nm + ' moved to screen ' + lctName(o.screenId) + ' → ' + lctName(s.screenId));
      ['cols', 'rows', 'panelId'].forEach(function (f) { if (o[f] !== s[f]) out.push(nm + ' ' + f + ': ' + val(o[f]) + ' → ' + val(s[f])); });
      Object.keys(s.wiring).forEach(function (f) { if (o.wiring[f] !== s.wiring[f]) out.push(nm + ' wiring.' + f + ': ' + val(o.wiring[f]) + ' → ' + val(s.wiring[f])); });
      var cellDiff = function (field, what) {
        var A = o[field] || {}, B = s[field] || {}, added = 0, removed = 0, changed = 0, eg = [];
        Object.keys(A).forEach(function (k) { if (!(k in B)) { removed++; if (eg.length < 4) eg.push(k + ' ✕'); } });
        Object.keys(B).forEach(function (k) {
          if (!(k in A)) { added++; if (eg.length < 4) eg.push(k + (B[k].sender != null ? ' → ' + portLabel(B[k].sender, B[k].port) + ' #' + (B[k].connect + 1) : '')); }
          else if (JSON.stringify(A[k]) !== JSON.stringify(B[k])) { changed++; if (eg.length < 4) eg.push(k + (B[k].sender != null ? ': ' + portLabel(A[k].sender, A[k].port) + ' #' + (A[k].connect + 1) + ' → ' + portLabel(B[k].sender, B[k].port) + ' #' + (B[k].connect + 1) : '')); }
        });
        if (added || removed || changed) out.push(nm + ' ' + what + ': +' + added + ' −' + removed + ' ~' + changed + (eg.length ? ' (e.g. ' + eg.join(', ') + ')' : ''));
      };
      cellDiff('manual', 'wiring');
      cellDiff('holes', 'blanks');
      cellDiff('override', 'cabinet sizes');
    });
    log('change', { what: out.length ? out.slice(0, 40).concat(out.length > 40 ? ['… ' + (out.length - 40) + ' more'] : []) : ['(no difference)'] });
  } catch (err) { log('change', { error: String(err && err.message || err) }); }
}

// ------------------------------------------------------------------ trace every function call
// Functions that run on every redraw, mouse move or cell lookup: tracing them would bury
// everything else (and slow the canvas down), so they are never wrapped.
var LOG_TRACE_SKIP = /^(render|hover$|el$|\$$|key$|fmt$|clamp$|int$|esc$|uid$|cellGeom$|cellsOf$|allCells$|svgPoint$|cellAt$|screenAt$|screenBounds$|visibleScreens$|lctById$|screenById$|panelOf$|portColor$|portLabel$|globalPortIndex$|portsOfSender$|rect|capacity$|portCap$|autoAssign$|pathLines$|portUsage$|problems$|snapshot$|keysText$|magnetSnap$|cardsUsed$|log|busyHere$|syncState$|fitView$|senderOptions$|patternIcon$|patternTitle$|curPort$|portKeys$|cardProblem$|fixSel$|saveLocal$|schedulePush$|toast$|deviceOfCard$|deviceById$|cardsOfDevice$|deviceLabel$|procModel$|procModelOptions$|fillSelect$|cardTypeLabel$|firstFreePort$|chassisCardType$|dev(MiniSvg|RearSvg|ListHtml|CardHtml|Bands|PerRow|Selected|RangeText|IsBlank|Replaceable)$|cardOptionGroups$|newProcName$)/;
function logAppFunctionNames() {
  // Anything on window that a blank page doesn't have is ours.
  var f = document.createElement('iframe'), builtin = {};
  f.style.display = 'none'; document.body.appendChild(f);
  for (var o = f.contentWindow; o; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach(function (n) { builtin[n] = 1; });
  f.remove();
  return Object.getOwnPropertyNames(window).filter(function (n) {
    if (builtin[n] || LOG_TRACE_SKIP.test(n)) return false;
    try { return typeof window[n] === 'function' && !/^[A-Z]/.test(n); } catch (e) { return false; }
  });
}
function logSetTrace(on) {
  on = !!on;
  if (on === logState.trace) return;
  if (on) {
    logState.wrapped = {};
    logAppFunctionNames().forEach(function (n) {
      var orig = window[n];
      var w = function () {
        var now = Date.now(), s = Math.floor(now / 1000);
        if (s !== logState.traceSec) {
          if (logState.traceDropped) log('trace_dropped', { calls: logState.traceDropped, note: 'over ' + LOG_TRACE_PER_SEC + '/s' });
          logState.traceSec = s; logState.traceN = 0; logState.traceDropped = 0;
        }
        if (++logState.traceN <= LOG_TRACE_PER_SEC) log('call', { fn: n, args: Array.prototype.map.call(arguments, logBrief) });
        else logState.traceDropped++;
        return orig.apply(this, arguments);
      };
      try { window[n] = w; logState.wrapped[n] = orig; } catch (e) { /* not writable: skip */ }
    });
    logState.trace = true;
    log('trace_on', { functions: Object.keys(logState.wrapped).length });
  } else {
    Object.keys(logState.wrapped || {}).forEach(function (n) { try { window[n] = logState.wrapped[n]; } catch (e) { /* ignore */ } });
    logState.wrapped = null; logState.trace = false;
    log('trace_off');
  }
  try { localStorage.setItem('opennova.trace', on ? 'on' : 'off'); } catch (e) { /* storage unavailable */ }
}

// ------------------------------------------------------------------ app actions: one id per user action
// User, 2026-10-28: "all actions need to be logged to and from processor so that we can properly diagnose". Each user
// action (a click / pointer press, a form change, a key shortcut) gets an id "<tab>-<n>". Everything it causes carries
// that id: log entries (e.act), helper calls (DRV.post sends _action, the helper records it on the request and on every
// frame / web call it makes for it), steps chained on their answers (promise callbacks keep the id they were set up
// in) and short timers it starts (setTimeout). Repeating timers (setInterval: the monitor, the background search, the
// Diagnostics poll) run as no action, so their traffic never lands on a click.
function logActNew(what, by) {
  var a = { id: logAct.tab + '-' + (++logAct.n), what: String(what || '').replace(/\s+/g, ' ').trim().slice(0, 80), at: Date.now(), by: by };
  logAct.cur = a;
  var st = logActNew.st || window.setTimeout;   // the action is "now" until this task ends (callbacks keep their own)
  st.call(window, function () { if (logAct.cur === a) logAct.cur = null; }, 0);
  return a;
}
function logActWhat(t) {
  var b = t && t.closest && t.closest('button, a, [role=menuitem], .ctx-item, label, input, select, textarea, [data-tab], [title]');
  if (!b) return t && t.tagName ? '<' + t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') + '>' : '';
  var txt = (b.getAttribute('aria-label') || (b.tagName === 'INPUT' || b.tagName === 'SELECT' ? '' : b.textContent) || b.title || b.name || '').trim();
  return (b.id ? '#' + b.id + ' ' : '') + txt.slice(0, 60);
}
// A body for the helper with the current action's id (and what it was) added; the body itself is left as it was.
function logActBody(body) {
  var a = logAct.cur; if (!a) return body;
  var b = {}; for (var k in body || {}) b[k] = body[k];
  b._action = a.id; if (a.what) b._actionWhat = a.what;
  return b;
}
(function () {
  var keep = function (f, a) {   // f run with action a as the current one (and the previous one back after)
    return typeof f !== 'function' ? f : function () { var o = logAct.cur; logAct.cur = a; try { return f.apply(this, arguments); } finally { logAct.cur = o; } };
  };
  var then = Promise.prototype.then;
  Promise.prototype.then = function (ok, bad) { var a = logAct.cur; return then.call(this, keep(ok, a), keep(bad, a)); };
  var st = window.setTimeout, si = window.setInterval;
  logActNew.st = st;
  window.setTimeout = function (f) { var x = Array.prototype.slice.call(arguments); x[0] = keep(f, logAct.cur); return st.apply(window, x); };
  window.setInterval = function (f) { var x = Array.prototype.slice.call(arguments); x[0] = keep(f, null); return si.apply(window, x); };
  var last = { el: null, t: 0 };
  document.addEventListener('pointerdown', function (e) { if (!e.target.closest || !e.target.closest('#logDlg')) logActNew(logActWhat(e.target), 'pointer'); }, true);
  document.addEventListener('click', function (e) {   // a click right after its own press stays that press's action
    var a = logAct.cur;
    if (a && a.by === 'pointer' && Date.now() - a.at < 2000) { a.what = logActWhat(e.target) || a.what; return; }
    logActNew(logActWhat(e.target), 'click');
  }, true);
  document.addEventListener('change', function (e) { logActNew('change ' + logActWhat(e.target), 'change'); }, true);
  document.addEventListener('input', function (e) {   // a slider drag is one action (the same control within 1.5 s)
    var t = e.target; if (!t || !/range|number/.test(t.type || '')) return;
    if (last.el === t && Date.now() - last.t < 1500 && last.a) { logAct.cur = last.a; st.call(window, function () { if (logAct.cur === last.a) logAct.cur = null; }, 0); }
    else last.a = logActNew('set ' + logActWhat(t), 'input');
    last.el = t; last.t = Date.now();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.repeat || !(e.altKey || e.ctrlKey || e.metaKey || /^(Enter|Delete|Backspace|Escape|F\d+)$/.test(e.key))) return;
    logActNew('key ' + (e.ctrlKey ? 'Ctrl+' : '') + (e.metaKey ? 'Cmd+' : '') + (e.altKey ? 'Alt+' : '') + e.key, 'key');
  }, true);
})();

// ------------------------------------------------------------------ automatic entries
window.addEventListener('error', function (e) {
  log('client_error', { message: e.message, file: (e.filename || '').split('/').pop(), line: e.lineno, col: e.colno,
    stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 2000) : '' });
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e.reason; log('client_unhandled_rejection', { reason: r && r.stack ? String(r.stack).slice(0, 2000) : String(r) });
});
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('button, .btn');
  if (!b || b.closest('#logDlg')) return;
  var where = b.closest('#ctxMenu') ? 'menu' : b.closest('#screenTabs') ? 'tabs' : b.closest('#patternPad') ? 'pattern pad' : b.closest('aside, header, .stage-tools') ? (b.closest('aside, header, .stage-tools').className.split(' ').pop()) : '';
  log('ui_click', { id: b.id || '', text: (b.textContent || b.title || '').trim().slice(0, 60) || b.title || '', where: where });
}, true);
document.addEventListener('change', function (e) {
  var t = e.target;
  if (!t || !/INPUT|SELECT|TEXTAREA/.test(t.tagName) || t.closest('#logDlg')) return;
  log('ui_change', { id: t.id || t.name || '', type: t.type || t.tagName.toLowerCase(),
    value: t.type === 'password' ? '(hidden)' : t.type === 'checkbox' ? t.checked : t.type === 'file' ? Array.prototype.map.call(t.files || [], function (f) { return f.name; }).join(', ') : String(t.value).slice(0, 120) });
}, true);
document.addEventListener('keydown', function (e) {
  var typing = document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (typing || e.repeat) return;
  if (/^(Tab|Delete|Backspace|Escape|Arrow\w+)$/.test(e.key) || ((e.ctrlKey || e.metaKey) && /^[zy]$/i.test(e.key)))
    log('key', { key: e.key, ctrl: e.ctrlKey || undefined, meta: e.metaKey || undefined, shift: e.shiftKey || undefined, alt: e.altKey || undefined });
}, true);
window.addEventListener('pagehide', function () { log('page_close'); logFlush(true); });
document.addEventListener('visibilitychange', function () { if (document.hidden) logFlush(true); });

// ------------------------------------------------------------------ the Logs window
function logOpenViewer() {
  var dlg = $('logDlg');
  if (!dlg.dataset.bound) { logBindViewer(); dlg.dataset.bound = '1'; }
  $('logSource').value = logState.server ? 'server' : 'local';
  $('logSource').querySelector('option[value=server]').disabled = !logState.server;
  $('logTrace').checked = logState.trace;
  dlg.hidden = false;
  log('logs_opened');
  logRefresh();
}
function logFormat(line) {
  try {
    // Browser entries show the moment they happened (clientTime); the server's timestamp is when
    // their batch arrived, up to a second later. Server entries show the server's time.
    var e = JSON.parse(line), ct = e.clientTime ? new Date(e.clientTime) : null, t;
    if (ct && !isNaN(ct)) t = ct.toTimeString().slice(0, 8) + '.' + String(ct.getMilliseconds()).padStart(3, '0');
    else t = e.timestamp ? e.timestamp.slice(11) : '';
    var who = e.source === 'server' ? 'server' : (e.os || '') + (e.client ? ' ' + e.client.slice(0, 4) : '');
    var d = e.details || {}, det;
    if (e.action === 'change' && d.what) det = d.what.join('\n' + ' '.repeat(34));
    else if (e.action === 'call') det = d.fn + '(' + (d.args || []).map(function (x) { return typeof x === 'string' ? JSON.stringify(x) : String(x); }).join(', ') + ')';
    else det = Object.keys(d).length ? JSON.stringify(d) : '';
    var pad = function (s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); };
    return pad(t, 13) + pad(who, 10) + pad(e.action, 11) + (e.act ? '[' + e.act + '] ' : '') + det;
  } catch (err) { return line; }
}
function logRefresh() {
  var src = $('logSource').value, n = +$('logLines').value, q = $('logSearch').value.trim(), span = +$('logSpan').value;
  var since = span ? Date.now() - span * 60000 : 0, pre = $('logText'), meta = $('logMeta');
  var show = function (lines, info) {
    var atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent = lines.map(logFormat).join('\n') || '(no entries)';
    meta.textContent = info;
    if (atEnd) pre.scrollTop = pre.scrollHeight;
    logState.shown = lines;
  };
  if (src === 'local') {
    var lines = logState.buf.filter(function (l) {
      if (q && l.toLowerCase().indexOf(q.toLowerCase()) < 0) return false;
      if (since) { var m = /"clientTime":"([^"]+)"/.exec(l); if (m && Date.parse(m[1]) < since) return false; }
      return true;
    });
    show(lines.slice(-n), 'This browser: ' + Math.min(n, lines.length) + ' of ' + lines.length + ' matching entries (kept: last ' + LOG_KEEP + ')');
    return;
  }
  logFlush();
  var url = 'api/logs?lines=' + n + (q ? '&q=' + encodeURIComponent(q) : '') + (since ? '&since=' + since : '');
  fetch(url, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(function (j) {
    show(j.lines || [], 'Server log (PC and Mac): ' + (j.returned_count || 0) + ' of ' + (j.matched_count || 0) + ' matching · ' +
      fmt(Math.round((j.file_size_bytes || 0) / 1024)) + ' KB · ' + (j.archive_count || 0) + ' archive(s) · ' + (j.file_path || ''));
  }).catch(function (err) {
    if (/HTTP 404/.test(err.message)) {   // an older serve.ps1 without a log: use this browser's entries
      logState.server = false;
      $('logSource').value = 'local'; $('logSource').querySelector('option[value=server]').disabled = true;
      return logRefresh();
    }
    meta.textContent = 'Could not read the server log (' + err.message + ') — switch to "This browser"';
  });
}
function logBindViewer() {
  $('logClose').onclick = function () { $('logDlg').hidden = true; clearInterval(logState.auto); $('logAuto').checked = false; };
  ['logSource', 'logLines', 'logSpan'].forEach(function (id) { $(id).onchange = logRefresh; });
  var deb; $('logSearch').oninput = function () { clearTimeout(deb); deb = setTimeout(logRefresh, 300); };
  $('logWrap').onchange = function () { $('logText').classList.toggle('wrap', $('logWrap').checked); };
  $('logAuto').onchange = function () { clearInterval(logState.auto); if ($('logAuto').checked) logState.auto = setInterval(logRefresh, 2000); };
  $('logTrace').onchange = function () { logSetTrace($('logTrace').checked); logRefresh(); };
  $('logRefresh').onclick = logRefresh;
  $('logCopy').onclick = function () {
    var text = $('logText').textContent;
    var done = function () { toast('Copied ' + (logState.shown || []).length + ' log lines'); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); } ta.remove(); }
  };
  $('logDownload').onclick = function () {
    var stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    download(new Blob([(logState.shown || []).join('\n') + '\n'], { type: 'text/plain' }), 'open-nova-log-' + stamp + '.log');
  };
  $('logClear').onclick = function () {
    if ($('logSource').value === 'local') { logState.buf = []; log('logs_cleared', { where: 'this browser' }); logRefresh(); return; }
    if (!confirm('Clear the server log file? (Archived logs are kept.)')) return;
    fetch('api/logs', { method: 'DELETE' }).then(function (r) {
      if (r.status === 403) toast('The server log can only be cleared on the computer running the server');
      logRefresh();
    });
  };
  $('logFolder').onclick = function () {
    fetch('api/logs/reveal', { method: 'POST' }).then(function (r) {
      if (r.status === 403) toast('The log folder opens only on the computer running the server');
    });
  };
}
