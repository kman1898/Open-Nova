// app-health.js - live health of linked processors (docs\HEALTH_UNICO.md, HEALTH_LCT.md, HEALTH_VMP.md): the Health tab
// (summary per processor, ports with their redundancy state, the event log) and the Layout canvas's "Live" overlay
// (panels coloured by status / feed side or bit errors, with the data break marked on the chain; Temperature / Voltage are
// the interpolated heat image of app-heat.js, drawn under see-through cabinets).
// Data: the helper's /api/unico/health (Unico-family) or /api/hw/health (NovaLCT protocol: link / backup / pair bits
// per port, the monitoring bytes per cabinet via the primary, then via the backup port -> feed side and break position)
// in one neutral shape. Polled every few seconds while the Health tab is shown or the overlay is on, and the app is
// visible. Health is hardware state: kept in hlt (never in the project, no undo); only the kept errors are shared, beside
// the project on the app server (hltErr*: every browser sees the same list, it survives reloads and restarts).
// The cabinets map onto the project's panels by sending card / port / cable position (as the export merges sections).
// Errors are kept until the user clears them, as in NovaLCT / VMP / Unico (user, 2026-10-11): one record per condition and
// place (hlt.held) stays in the event list and marked on the map after the condition ends ("ended hh:mm", outlined mark);
// only Clear (per cabinet, per processor, all) removes it, and zeroes the processor's bit-error counters where its clear
// was seen live (drv clearErrors). Live values (temperature, link, feed side) keep following the readings.
// Owns: HLT_MS, HLT_COL, HLT_ENDS, hlt, hltPoll, hltTick, hltNorm, hltKind, hltLatch, hltList, hltRanges, hltPlaces, hltCounts,
// hltDevs, hltPl, hltCabClass, HLT_OPT, hltOptOf, hltCardModel, hltFiber, hltMapGap, hltTile, hltHeldAt,
// hltHeldText, hltWhere, hltCellAt, hltClear, hltClearTip, hltClearMenu, hltBaseline, hltRedraw, hltCabinet, hltCellFill, hltHeat,
// hltSrv, hltSrvOn, hltErrReady, hltErrMark, hltErrPush, hltErrLoad, hltErrReset, hltErrApply, hltErrEvent,
// renderHealthOverlay, renderHealth, hltPortBad, hltDeviceHtml, hltState, hltMapHtml, bindHealth. Limits, °C/°F, history, bit-error
// view and alerts: app-watch.js.
// Depends on: app-core (P, ui, $, esc, toast), app-log (log), app-processors (cardsOfDevice, deviceOfCard, deviceById,
// procModel), app-capacity (portLabel), app-hardware (hw, hwPairs, hwPortCells, setTab is app-devices), drv-core (DRV.of(d).monitor,
// .clearErrors), app-render (el, renderAll), app-context-menu (openMenu), app-watch (watchText, watchAlert, watchAck), app-forms (viewLive),
// app-heat (heatMax), app-online (olMode), all at run time.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

var HLT_MS = { unico: 3000, lct: 5000 };
// status colours shared by all three systems (green / amber / red / grey, as Unico and VMP use them)
var HLT_COL = { primary: '#2fae6a', none: '#2fae6a', backup: '#e0a84a', dark: '#e05252', warning: '#e0a84a', error: '#e05252', unknown: '#808080', beyond: '#6b4a5a' };
// by[device id] = normalised snapshot; log = the event list as shown (built from held by hltList); held[key] = one error
// kept until Clear {key, dev, devName, card, port, index, kind, text, level, t, ended, n, pt}; base[dev|card|port|index] =
// counter values a Clear couldn't zero on the processor (counted from there); gone[key] = newest processor alarm-log time
// already cleared (Unico's log keeps old entries); rev = bumped when held changes (map redraw)
var hlt = { by: {}, log: [], seen: {}, held: {}, base: {}, gone: {}, rev: 0, watch: {}, view: 'off', okOpen: {} };   // okOpen[device id] = its healthy ports shown
// a processor's own "back to normal" entries (Unico's alarm log) -> the conditions they end
var HLT_ENDS = { 'data link restored': /^data link broken/, 'voltage normal': /^voltage (high|low)/, 'temperature normal': /^temperature (high|low)/,
  'bit errors cleared': /^bit errors$/, 'primary clean': /^bit errors on primary/, 'backup clean': /^bit errors on backup/, 'fed from primary': /^fed from backup/,
  'port connected': /^port disconnected/, 'fibre connected': /^fibre disconnected/ };

// ------------------------------------------------------------------ polling
function hltPoll(d) {
  var w = hlt.watch[d.id] || (hlt.watch[d.id] = {});
  if (w.inflight) return;
  w.inflight = true;
  var gen = (hw.gen || {})[d.id] || 0, cg = w.cgen || 0, known = {}, lv = hw.live[d.id];
  if (lv) lv.cards.forEach(function (c, i) { Object.keys(c.ports).forEach(function (p) { known[i + ':' + p] = c.ports[p]; }); });
  // only pairs whose primary port carries panels: an unused pair has nothing to lose ("redundancy lost" was noise, H5 2026-10-11)
  var cells = hwPortCells(), cards = cardsOfDevice(d);
  var pairs = hwPairs(d).filter(function (q) { return (cells[cards[q.ps] + ':' + q.pp] || []).length; });
  return DRV.of(d).monitor(d, { known: known, pairs: pairs }).then(function (r) {   // the processor's driver (drv-*.js)
    // the helper's one link to this processor is held by a Send / Save (from this or another window): skip this round
    // quietly and keep the last reading — not an error, not an event
    if (r.busy) { w.busy = true; return; }
    if (!r.ok) throw new Error(r.error || 'health failed');
    w.busy = false;
    if (gen !== ((hw.gen || {})[d.id] || 0) || !d.hw) return;   // relinked / unlinked meanwhile: not this link's reading
    if (cg !== (w.cgen || 0)) return;                            // read before a Clear: its counters are stale
    var h = hltNorm(d, r.health);
    hlt.by[d.id] = h; w.err = '';
    if (typeof watchRecord === 'function') watchRecord(d, h);   // history (app-watch.js)
    if (hltErrReady()) hltLatch(d, h);   // not before the server's kept list is here (a reload must not raise them as new)
  }).catch(function (e) {   // a refused reply (r.ok false) lands here too; the raw text goes to the log once per change
    if (w.err !== e.message) log('health_poll_error', { processor: d.name, error: e.message });
    w.err = e.message;
  })
    .then(function () {   // only readings changed: the canvas (and the pipeline strip) are enough, not a whole renderAll
      w.inflight = false; w.done = Date.now(); if (ui.tab === 'health') renderHealth(); if (ui.tab === 'maintain') renderMaintain();
      if (hlt.view !== 'off') { renderCanvas(allCells()); if (typeof renderPipe === 'function') renderPipe(); }
    });
}
// card numbers on the link (0…) -> the project's sending cards; Unico has one card
function hltNorm(d, h) {
  var cards = cardsOfDevice(d), g = function (x) { return cards[x.card || 0]; };
  h.ports.forEach(function (p) { p.card = g(p); if (p.backup) p.backup.card = cards[p.backup.card || 0]; });
  h.cabinets.forEach(function (c) { c.card = g(c); });
  h.events.forEach(function (e) { e.card = g(e); });
  h.at = Date.now();
  // values read only every few polls (NovaLCT bit errors / disconnects / power supplies): keep the last ones in between
  // (the counters as the processor gave them: *Raw)
  var prev = hlt.by[d.id];
  if (prev && prev.cabinets) {
    var pk = {}; prev.cabinets.forEach(function (c) { pk[c.card + ':' + c.port + ':' + c.index] = c; });
    h.cabinets.forEach(function (c) {
      var o = pk[c.card + ':' + c.port + ':' + c.index]; if (!o) return;
      ['berEnabled', 'psu'].forEach(function (k) { if (c[k] === undefined && o[k] !== undefined) c[k] = o[k]; });
      ['bitErrors', 'disconnects'].forEach(function (k) { if (c[k] === undefined && o[k + 'Raw'] !== undefined) c[k] = o[k + 'Raw']; });
    });
  }
  // counters since the last Clear: a Clear that couldn't zero them on the processor left a baseline (a lower reading =
  // the counter restarted, e.g. a card reset: the baseline goes)
  h.cabinets.forEach(function (c) {
    var b = hlt.base[d.id + '|' + c.card + '|' + c.port + '|' + c.index];
    ['bitErrors', 'disconnects'].forEach(function (k) {
      if (c[k] == null) return;
      c[k + 'Raw'] = c[k];
      if (b && b[k] != null) { if (c[k] < b[k]) { delete b[k]; hltErrMark('base', d.id + '|' + c.card + '|' + c.port + '|' + c.index); } else c[k] -= b[k]; }
    });
  });
  // bit errors, failed power supplies and dark cabinets as events per cabinet, from the (kept) readings, so they hold
  // between the polls that read them; the readers' own versions of these (no processor time) are replaced
  h.events = h.events.filter(function (e) { return e.t || !/^bit errors$|^power supply .* failed|cabinet\(s\) not answering/.test(e.text); });
  h.cabinets.forEach(function (c) {
    var at = { card: c.card, port: c.port, index: c.index };
    if (c.dark) h.events.push(Object.assign({ level: 'error', text: 'not answering on either side' }, at));
    if (c.bitErrors) h.events.push(Object.assign({ level: 'warning', text: 'bit errors (' + (c.bitErrorsRaw === 65535 ? '65535+' : c.bitErrors) + ')' }, at));
    if (c.psu && c.psu.indexOf(0) >= 0) h.events.push(Object.assign({ level: 'error', text: 'power supply ' + c.psu.map(function (v, k) { return v === 0 ? k + 1 : null; }).filter(Boolean).join(', ') + ' failed' }, at));
  });
  if (typeof watchApply === 'function') watchApply(h);   // the user's alarm limits (app-watch.js)
  // the same wording for every system, from the cabinets' feed sides: some on primary and some on backup = a data break
  // before the first backup-fed cabinet; all on backup = the primary port failed. Backup port from the project's pairs
  // when the processor doesn't say (Unico).
  var pairs = (P.backup && P.backup.mode === 'port' ? P.backup.pairs : []) || [];
  h.ports.forEach(function (p) {
    var cs = h.cabinets.filter(function (c) { return c.card === p.card && c.port === p.port && !c.dark; });
    var b = cs.filter(function (c) { return c.side === 'backup'; }), pr = cs.filter(function (c) { return c.side === 'primary'; });
    if (b.length && pr.length) { p.breakBefore = Math.min.apply(null, b.map(function (c) { return c.index; })); p.link = 'data break before cabinet ' + (p.breakBefore + 1) + ', split feed'; }
    else if (b.length && !pr.length) p.link = 'primary failed, running on backup';
    if (!p.backup) {
      var q = pairs.filter(function (x) { return x.ms === p.card && x.mp === p.port; })[0];
      if (q) p.backup = { card: q.bs, port: q.bp, link: null };
    }
    if (!p.cabinets) p.cabinets = h.cabinets.filter(function (c) { return c.card === p.card && c.port === p.port; }).length;
  });
  h.ports = h.ports.filter(function (p) { return p.cabinets || !/^(ok|redundant, ok)$/.test(p.link); });
  hltFiber(d, h);    // a whole fibre (OPT) down: one event, not one per port (H cards with OPT outputs)
  hltMapGap(d, h);   // the cables answer with more / fewer cabinets than the layout maps on a port
  var n ={ total: h.cabinets.length, backup: 0, dark: 0, warn: 0, err: 0 };
  h.cabinets.forEach(function (c) {
    if (c.dark) n.dark++; else if (c.side === 'backup') n.backup++;
    if (c.tempStatus === 'error' || c.voltStatus === 'error' || (c.psu && c.psu.indexOf(0) >= 0)) n.err++; else if (c.tempStatus === 'warning' || c.voltStatus === 'warning') n.warn++;
  });
  h.sum = n;
  return h;
}
// H output cards with fibre (OPT) outputs: which Ethernet ports one OPT carries (docs\H_SERIES_CARDS.md). [ports per OPT,
// OPTs that carry ports]. H_16xRJ45+2xFiber (0x7B46, the H9's card): OPT1 copies ports 1–8, OPT2 ports 9–16 — run as
// primary and backup when ports 9–16 back up 1–8 (an H9 tester, 2026-11-19: OPT1 = primary, OPT2 = backup). H_4xFiber
// (0x7B4A): OPT1–4 = ports 1–8 … 25–32 (independent; copy / backup mode uses OPT1–2 = ports 1–16). H_8xFiber
// (0x7B4F, 4xFiber Enhanced): OPT1–4 = ports 1–10 … 31–40 (OPT5–8 are its own backups: no ports of their own).
var HLT_OPT = { 0x7B46: [8, 2], 0x7B4A: [8, 4], 0x7B4F: [10, 4] };
function hltOptOf(modelId, port) {
  var g = HLT_OPT[modelId]; if (!g || port == null || port < 0 || port >= g[0] * g[1]) return null;
  var k = Math.floor(port / g[0]); return { opt: k + 1, from: k * g[0], to: k * g[0] + g[0] - 1 };
}
// The ModelID of a project sending card: what the link reported, else the card type placed in the chassis.
function hltCardModel(d, card) {
  var ci = cardsOfDevice(d).indexOf(card), s = d.hw && d.hw.senders && d.hw.senders[ci];
  if (s) return s;
  var t = P.processors[card] && P.processors[card].type;
  return t && typeof OUTPUT_CARDS !== 'undefined' && OUTPUT_CARDS[t] ? OUTPUT_CARDS[t].modelId : null;
}
// A fibre down = every port of one OPT that carries cabinets has no link (the reader's "primary port failed, all cabinets
// on backup", or "redundancy lost: backup port N has no link" on the backup side). Then ONE event for the card instead of
// one per port, and those ports say so (no break mark at cabinet 1: nothing broke in the chain). Fewer than two carrying
// ports, or only some of them down: the per-port events stay (that is a cable, not the fibre).
function hltFiber(d, h) {
  var groups = {}, order = [];
  h.ports.forEach(function (p) {
    if (!p.cabinets) return;
    var o = hltOptOf(hltCardModel(d, p.card), p.port); if (!o) return;
    var k = p.card + '|' + o.opt;
    if (!groups[k]) { groups[k] = { card: p.card, o: o, ports: [] }; order.push(k); }
    groups[k].ports.push(p);
  });
  var evAt = function (p, re) { return h.events.filter(function (e) { return e.card === p.card && e.port === p.port && re.test(e.text || ''); }); };
  var drop = function (list) { h.events = h.events.filter(function (e) { return list.indexOf(e) < 0; }); };
  order.forEach(function (k) {
    var g = groups[k], ps = g.ports, o = g.o, range = 'ports ' + (o.from + 1) + '–' + (o.to + 1);
    if (ps.length < 2) return;
    // the backup ports' own OPT, when they are on this card and all in one (H9: ports 9–16 = OPT2)
    var bks = ps.map(function (p) { var b = p.backup && p.backup.card === g.card ? hltOptOf(hltCardModel(d, g.card), p.backup.port) : null; return b ? 'OPT' + b.opt : ''; });
    var bkOpt = bks[0] && bks.every(function (x) { return x === bks[0]; }) && bks[0] !== 'OPT' + o.opt ? bks[0] : '';
    var dead = ps.map(function (p) { return evAt(p, /^primary port failed/); });
    if (dead.every(function (l) { return l.length; })) {
      drop([].concat.apply([], dead));
      ps.forEach(function (p) { p.link = 'OPT' + o.opt + ' fiber: no link — running on backup' + (bkOpt ? ' (' + bkOpt + ')' : ''); p.opt = 'OPT' + o.opt; delete p.breakBefore; });
      h.events.push({ level: 'error', card: g.card, port: null, index: null, cardWide: true,
        text: 'OPT' + o.opt + ' fiber: no link — ' + range + ' running on backup' + (bkOpt ? ' (' + bkOpt + ')' : '') });
      return;
    }
    if (!bkOpt) return;
    var lost = ps.map(function (p) { return p.backup && p.backup.link === false ? evAt(p, /^redundancy lost/) : null; });
    if (lost.every(function (l) { return l; })) {
      drop([].concat.apply([], lost));
      ps.forEach(function (p) { p.backupOpt = bkOpt; });
      h.events.push({ level: 'warning', card: g.card, port: null, index: null, cardWide: true, text: bkOpt + ' fiber: no link — no backup for ' + range });
    }
  });
}
// Layout vs cables, per port: the detection found a different number of receiving cards than the project maps there. One
// warning per port, kept like the others; the mapped cabinets past the cable's count are drawn "not answering — mapping has
// more cabinets than the cable" (hltCabinet). Monitoring itself reads what the cables have (the detection), so nothing on
// the wall goes unread.
// Two ports whose cables answer with each other's mapped counts are CROSSED: the map and the cabling disagree, and the
// counts can't tell which is wrong (an H9 tester, 2026-11-19: OPT1 unplugged, so the counts came through the backups; the
// screen layout read from the H9 gave port 1 10 and port 5 5, but backup port 9 reached 5 cards and port 13 reached 10.
// First taken for swapped cables; the tester's NovaLCT screen (2026-11-20) has port 1 on the 5, so the layout was the odd
// one out). One error for the pair instead of two count warnings, and each reading goes on the cabinets that cable
// reaches: what was read for port 1 is drawn on the layout's port-5 run, and back.
var HLT_CAB_EVENT = /^(temperature|supply voltage|bit errors|power supply|not answering)/;
function hltViaOf(list) { return list && list.length && list.every(function (x) { return x.via === 'backup'; }) ? 'backup' : 'primary'; }
// The port of the same card this port is crossed with (map vs cables): the counts cross over exactly (and only one port
// fits), both read the same way (primary / backup). Else null.
function hltSwapOf(card, port) {
  var cells = hwPortCells(), n = function (p) { return (cells[card + ':' + p] || []).length; };
  var me = hwPortDetected(card, port);
  if (!me || !n(port) || me.length === n(port)) return null;
  var hits = Object.keys(cells).filter(function (k) { return +k.split(':')[0] === card; }).map(function (k) { return +k.split(':')[1]; })
    .filter(function (q) {
      var o = q !== port && hwPortDetected(card, q);
      return o && n(q) && o.length !== n(q) && o.length === n(port) && me.length === n(q) && hltViaOf(o) === hltViaOf(me);
    });
  return hits.length === 1 ? { port: hits[0], backup: hltViaOf(me) === 'backup' } : null;
}
function hltMapGap(d, h) {
  var cells = hwPortCells(), mine = cardsOfDevice(d), lv = hw.live && hw.live[d.id];
  h.swapOf = {};
  if (!lv || !lv.cards) return;
  var keys = {}, done = {};
  var bkPort = function (card, port) {
    var p = h.ports.filter(function (x) { return x.card === card && x.port === port; })[0];
    if (p && p.backup) return p.backup.port;
    var q = ((P.backup && P.backup.mode === 'port' ? P.backup.pairs : []) || []).filter(function (x) { return x.ms === card && x.mp === port; })[0];
    return q ? q.bp : null;
  };
  Object.keys(cells).forEach(function (k) { if (mine.indexOf(+k.split(':')[0]) >= 0) keys[k] = 1; });
  lv.cards.forEach(function (c, ci) { Object.keys(c.ports || {}).forEach(function (p) { if ((c.ports[p] || []).length && mine[ci] != null) keys[mine[ci] + ':' + p] = 1; }); });
  Object.keys(keys).sort(function (x, y) { return (+x.split(':')[0] - +y.split(':')[0]) || (+x.split(':')[1] - +y.split(':')[1]); }).forEach(function (k) {
    var sp = k.split(':'), card = +sp[0], port = +sp[1], c = lv.cards[mine.indexOf(card)];
    if (!c || !c.ports) return;
    var mapped = (cells[k] || []).length, list = c.ports[port] || [], ans = list.length;
    if (mapped === ans || !mapped) return;   // nothing mapped on that port: the layout isn't there yet (Quick add offers it)
    var sw = hltSwapOf(card, port);
    if (sw) {
      h.swapOf[k] = sw.port;
      if (done[card + ':' + sw.port]) return;
      done[k] = 1;
      var a = port, b = sw.port, ba = bkPort(card, a), bb = bkPort(card, b), nb = (cells[card + ':' + b] || []).length;
      var text = sw.backup && ba != null && bb != null
        ? 'Ports ' + (a + 1) + ' and ' + (b + 1) + ' crossed: backup port ' + (ba + 1) + ' reaches ' + nb + ' cabinets (port ' + (a + 1) + ' has ' + mapped + ' mapped), port ' + (bb + 1) + ' reaches ' + mapped + ' (port ' + (b + 1) + ' has ' + nb + ' mapped)'
        : 'Ports ' + (a + 1) + ' and ' + (b + 1) + ' crossed: port ' + (a + 1) + '’s cable reaches ' + nb + ' cabinets (' + mapped + ' mapped), port ' + (b + 1) + '’s reaches ' + mapped + ' (' + nb + ' mapped)';
      h.events.push({ level: 'error', card: card, port: a, index: null, swap: true, text: text });
      return;
    }
    var bp = hltViaOf(list) === 'backup' ? bkPort(card, port) : null;
    h.events.push({ level: 'warning', card: card, port: port, index: null,
      text: mapped + ' cabinet' + (mapped === 1 ? '' : 's') + ' mapped, ' + ans + ' answer' + (ans === 1 ? 's' : '') + (bp != null ? ' on its backup cable (port ' + (bp + 1) + ')' : '') });
  });
  if (!Object.keys(h.swapOf).length) return;
  var move = function (x) { var q = h.swapOf[x.card + ':' + x.port]; if (q != null) { x.port = q; x.swapped = true; } };
  h.cabinets.forEach(move);
  h.events.forEach(function (e) { if (e.index != null && !e.swap && HLT_CAB_EVENT.test(e.text || '')) move(e); });
  delete h.idx;
}
// What a condition is without its changing numbers: "temperature 68.0 °C" and "… 71.5 °C" are one condition, so are
// "bit errors (3)" and "bit errors (40)".
function hltKind(text) { return String(text).replace(/\s*\([\d+]+\)$/, '').replace(/\d+(\.\d+)?/g, '#'); }
// Errors are kept until the user's Clear (hlt.held): a condition seen for the first time, or again after it ended, alerts
// and is logged; one no longer reported is marked ended at that time — still listed, still marked. Never removed here.
function hltLatch(d, h) {
  var now = Date.now(), w = hlt.watch[d.id] || {}, quiet = !!w.quiet, cur = {}, ends = {}, rank = { warning: 1, error: 2 };
  w.quiet = false;   // the first reading after a Clear re-raises what is still there without a new alarm sound
  var at = function (e) { return d.id + '|' + e.card + '|' + e.port + '|' + e.index + '|'; };
  // the processor's own "back to normal" entries (Unico's alarm log, with its times)
  h.events.forEach(function (e) { var re = HLT_ENDS[e.text]; if (re && e.t) (ends[at(e)] = ends[at(e)] || []).push({ re: re, t: e.t }); });
  h.events.forEach(function (e) {
    if (e.level === 'ok' || HLT_ENDS[e.text]) return;
    var k = at(e) + hltKind(e.text), c = cur[k];
    if (e.t) {   // an alarm-log entry: already cleared, or answered by a later "back to normal"
      if (hlt.gone[k] && e.t <= hlt.gone[k]) return;
      if ((ends[at(e)] || []).some(function (x) { return x.re.test(e.text) && x.t >= e.t; })) return;
    }
    if (!c || (e.t || 0) >= (c.t || 0)) cur[k] = { e: e, level: c && c.level === 'error' ? 'error' : e.level === 'error' ? 'error' : 'warning' };
    else if (e.level === 'error') c.level = 'error';
  });
  Object.keys(cur).forEach(function (k) {
    var e = cur[k].e, lv = cur[k].level, r = hlt.held[k], t0 = e.t ? e.t * 1000 : now, news = '';
    if (!r) { r = hlt.held[k] = { key: k, dev: d.id, devName: deviceLabel(d), card: e.card, port: e.port, index: e.index, kind: hltKind(e.text), level: lv, t: t0, ended: null, n: 1 }; news = 'new'; if (e.cardWide) r.cardWide = true; }
    else if (r.ended) { r.ended = null; r.n++; r.t = t0; r.level = lv; news = 'again'; }
    else if (rank[lv] > rank[r.level]) { r.level = lv; news = 'worse'; }
    r.text = e.text;   // the live value while it lasts (temperature, count); frozen when it ends
    if (e.t && e.t > (r.pt || 0)) { r.pt = e.t; hltErrMark('held', k); }   // (a Clear in another browser must hide this entry too)
    if (!news) return;
    hltErrMark('held', k);
    var entry = { t: r.t, dev: r.devName, level: r.level, where: hltWhere(r), text: r.text };
    if (!quiet && typeof watchAlert === 'function') watchAlert(entry);   // banner / beep / notification
    log('health_event', { processor: d.name, level: r.level, where: entry.where, text: r.text, what: news });
  });
  Object.keys(hlt.held).forEach(function (k) {
    var r = hlt.held[k]; if (r.dev !== d.id || r.ended || cur[k]) return;
    var ok = (ends[at(r)] || []).filter(function (x) { return x.re.test(r.text); }).map(function (x) { return x.t * 1000; });
    r.ended = ok.length ? Math.max.apply(null, ok) : now; hltErrMark('held', k);
    log('health_event_ended', { processor: d.name, where: hltWhere(r), text: r.text });
  });
  hltList();
}
// The event list as shown, from hlt.held: per-cabinet errors of one kind on one port in one line ("cabinets 3–5, 9 · bit
// errors"); the ones still going first, then the ended ones, newest first. Also indexes the held errors per cabinet.
function hltList() {
  var grp = {}, out = [], idx = {};
  Object.keys(hlt.held).forEach(function (k) {
    var r = hlt.held[k];
    if (r.index != null) { var ck = r.card + ':' + r.port + ':' + r.index; (idx[ck] = idx[ck] || []).push(r); }
    var g = r.index == null || /temperature|voltage/.test(r.kind) ? k : [r.dev, r.card, r.port, r.text.replace(/\s*\([\d+]+\)$/, ''), r.ended ? 'e' : 'a'].join('|');
    (grp[g] = grp[g] || []).push(r);
  });
  Object.keys(grp).forEach(function (g) {
    var rs = grp[g].sort(function (a, b) { return a.index - b.index; }), f = rs[0], many = rs.length > 1;
    var ts = rs.map(function (r) { return r.t; });
    out.push({ t: Math.min.apply(null, ts), last: Math.max.apply(null, ts), dev: f.devName, devId: f.dev, card: f.card, port: f.port, index: many ? null : f.index,
      level: rs.some(function (r) { return r.level === 'error'; }) ? 'error' : 'warning', n: Math.max.apply(null, rs.map(function (r) { return r.n; })),
      ended: f.ended ? Math.max.apply(null, rs.map(function (r) { return r.ended; })) : null,
      where: hltWhere({ card: f.card, port: f.port, index: many ? null : f.index, cardWide: f.cardWide }),
      text: many ? 'cabinets ' + hltRanges(rs.map(function (r) { return r.index; })) + ' · ' + f.text.replace(/\s*\([\d+]+\)$/, '') : f.text });
  });
  out.sort(function (a, b) { return (a.ended ? 1 : 0) - (b.ended ? 1 : 0) || b.last - a.last; });
  hlt.log = out; hlt.heldIdx = idx; hlt.rev++;
  return out;
}
// [2, 3, 4, 8] (0-based) -> "3–5, 9"
function hltRanges(a) {
  var s = [], i = 0;
  while (i < a.length) { var j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; s.push(j > i ? (a[i] + 1) + '–' + (a[j] + 1) : String(a[i] + 1)); i = j + 1; }
  return s.join(', ');
}
// One count per fact, computed here for every surface (Monitor tile, the per-processor counts, the cabinet map's badges,
// the port table, Dashboard), always with the same words:
//   errors / warnings = places (a cabinet, a port, a processor) with an error / only warnings going on NOW;
//   to clear = places with errors kept until the user's Clear, going on or ended (they stay until he clears them).
// Places are counted, not records: one cabinet with bit errors and a hot temperature is one warning. Only this project's
// processors count. keep(r): only those kept records (one processor, one port, one screen's cabinets).
function hltPlaces(keep) {
  var at = {}, ids = {};
  hltDevs().forEach(function (d) { ids[d.id] = 1; });
  Object.keys(hlt.held).forEach(function (k) {
    var r = hlt.held[k]; if (!ids[r.dev] || (keep && !keep(r))) return;
    var p = r.dev + '|' + r.card + '|' + r.port + '|' + r.index, a = at[p] || (at[p] = { live: '' });
    if (!r.ended && a.live !== 'error') a.live = r.level === 'error' ? 'error' : 'warning';
  });
  return at;
}
function hltCounts(keep) {
  var at = hltPlaces(keep), n = { err: 0, warn: 0, clear: 0 };
  Object.keys(at).forEach(function (p) { n.clear++; if (at[p].live === 'error') n.err++; else if (at[p].live) n.warn++; });
  return n;
}
// The processors Monitor speaks of: online, the connected ones (app-online.js: one not connected is "not connected" on
// Device, not a fault here; its kept errors wait until it is back), offline all.
function hltDevs() { return typeof olShownDevices === 'function' ? olShownDevices() : (P.devices || []); }
function hltPl(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }   // "1 warning", "2 errors"
// One cabinet's class for the counts: a kept error going on now, else what its reading says. pl = hltPlaces().
function hltCabClass(devId, card, port, index, x, pl) {
  var a = pl[devId + '|' + card + '|' + port + '|' + index];
  if (a && a.live) return a.live === 'error' ? 'err' : 'warn';
  var st = hltState(x); return st.backup ? 'backup' : st.cls;
}
// The Monitor tile's status line (app-pipeline.js renderTabs): {text, cls, tip, pic}. Nothing to say (no processor linked,
// no cabinets, no reading yet) is an empty line, never "OK".
function hltTile(linked) {
  linked = linked || hltDevs().filter(function (d) { return d.hw; });
  var mute = function (d) { return (hlt.watch[d.id] || {}).err || (hw.watch[d.id] || {}).err; };
  var n = hltCounts(), quiet = linked.filter(mute), bk = 0, read = 0, cabs = 0, cells = hwPortCells();
  linked.forEach(function (d) {
    var h = hlt.by[d.id], mine = cardsOfDevice(d); if (h && h.sum) { bk += h.sum.backup; read++; }
    Object.keys(cells).forEach(function (k) { if (mine.indexOf(+k.split(':')[0]) >= 0) cabs += cells[k].length; });
  });
  var hot = typeof heatMax === 'function' && linked.length ? heatMax() : null;
  var hoff = hw.helper === false && !(typeof olMode === 'function' && olMode() === 'offline');   // offline: simulated processors need no helper
  var text = hoff ? 'helper off' : !linked.length ? '' : n.err ? hltPl(n.err, 'error') : quiet.length ? quiet.length + ' no reply' : n.warn ? hltPl(n.warn, 'warning') :
    n.clear ? n.clear + ' to clear' : bk ? bk + ' on backup' : cabs && read ? 'OK' : '';
  var cls = hoff || n.err || quiet.length ? 'bad' : n.warn || n.clear || bk ? 'warn' : text ? 'ok' : linked.length && !cabs ? 'dim' : '';
  var tip = hoff ? 'The helper isn’t running: no processor can be reached' : !linked.length ? 'No processor linked' : !cabs ? 'No cabinets placed' :
    !read && !text ? 'No reading yet' : [hltPl(n.err, 'error'), hltPl(n.warn, 'warning'), n.clear + ' to clear (kept until you clear them on Monitor)'].join(' · ') +
    (bk ? ' · ' + bk + ' cabinets on backup' : '') + (quiet.length ? ' · not answering: ' + quiet.map(deviceLabel).join(', ') : '') + (hot ? ' · hottest ' + hot.text + ' (' + hot.label + ')' : '');
  return { text: text, cls: cls, tip: tip, pic: cls === 'ok' || cls === 'warn' || cls === 'bad' ? cls : 'none' };
}
// The held errors of one cabinet (card = the project's sending card), and their wording for a tooltip / table cell.
function hltHeldAt(card, port, index) { return (hlt.heldIdx || {})[card + ':' + port + ':' + index] || []; }
function hltHeldText(rs) {
  var tm = function (t) { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
  return rs.map(function (r) { return watchText(r.text) + (r.ended ? ' (ended ' + tm(r.ended) + ')' : ' (since ' + tm(r.t) + ')'); }).join(' · ');
}
function hltWhere(e) {
  if (e.port == null) return e.cardWide && e.card != null ? portLabel(e.card, 0).replace(/ ?P1$/, '') : '';   // a whole card (a fibre)
  // The event already names its processor: drop portLabel's processor prefix (fixed processors, several in the project).
  var pl = portLabel(e.card || 0, e.port), d = typeof deviceOfCard === 'function' ? deviceOfCard(e.card || 0) : null, pre = d ? deviceLabel(d) + ' ' : '';
  if (pre && pl.indexOf(pre) === 0) pl = pl.slice(pre.length);
  return pl + (e.index != null ? ' · cabinet ' + (e.index + 1) : '');
}
// The user's Clear, as NovaLCT / VMP / Unico offer it: scope = {dev, cab: {card (project), port, index}} one cabinet,
// {dev} one processor, null everything. Removes the held errors (list and map marks) and has the processor zero its
// bit-error counters where that clear was seen live (drv clearErrors: NovaLCT protocol, COEX); elsewhere, or when it
// fails, Open Nova counts from the values now (hltBaseline). Never saves.
function hltClear(scope) {
  var cab = scope && scope.cab, gone = 0, ids = {};
  hltDevs().forEach(function (d) { ids[d.id] = 1; });
  Object.keys(hlt.held).forEach(function (k) {
    var r = hlt.held[k];
    if (!scope && !ids[r.dev] && deviceById(r.dev)) return;   // online: a processor not connected keeps its own (app-online.js)
    if (scope && (r.dev !== scope.dev.id || cab && !(r.card === cab.card && r.port === cab.port && r.index === cab.index))) return;
    if (r.pt) { hlt.gone[k] = Math.max(hlt.gone[k] || 0, r.pt); hltErrMark('gone', k, true); }   // that alarm-log entry stays gone
    delete hlt.held[k]; gone++; hltErrMark('held', k, true);   // every browser's list (at once)
  });
  hltList();
  if (!scope && typeof watchAck === 'function') watchAck();
  var what = cab ? portLabel(cab.card, cab.port) + ' · cabinet ' + (cab.index + 1) : scope ? deviceLabel(scope.dev) : 'all';
  var said = 'Cleared ' + gone + ' error' + (gone === 1 ? '' : 's') + ' (' + what + ')';
  var devs = (scope ? [scope.dev] : hltDevs()).filter(function (d) { return d && d.hw; });
  hltRedraw();
  if (!devs.length) { log('health_clear', { scope: what, held: gone, hw: false }); toast(said); return Promise.resolve(); }
  return Promise.all(devs.map(function (d) {
    var w = hlt.watch[d.id] || (hlt.watch[d.id] = {}), cards = cardsOfDevice(d);
    w.cgen = (w.cgen || 0) + 1; w.quiet = true;
    var tg = cab ? [{ card: cards.indexOf(cab.card), port: cab.port, index: cab.index }] : null;
    var done = function (r) {
      var zeroed = !!(r.ok && r.hw);
      hltBaseline(d, cab, zeroed);
      w.cgen++; w.quiet = true;   // a reading taken while the clear ran has the old counts
      log('health_clear', { processor: d.name, scope: what, held: gone, hw: zeroed, result: r.text || r.error });
      return deviceLabel(d) + ': ' + (r.ok ? r.text : 'counters not cleared (' + (r.busy ? 'a Send / Save holds the link' : r.error) + ') — Open Nova counts from now');
    };
    return DRV.of(d).clearErrors(d, tg && tg[0].card >= 0 ? tg : null).then(done, function (e) { return done({ ok: false, error: 'helper: ' + e.message }); });
  })).then(function (msgs) { toast(said + ' · ' + msgs.join(' · ')); hltRedraw(); });
}
// After a Clear: the bit-error counters are 0 on the processor (zeroed) or count from their value now. Disconnections
// always count from now: whether 0x01000076 zeroes them too isn't known (a lower reading later drops the baseline).
function hltBaseline(d, cab, zeroed) {
  var h = hlt.by[d.id]; if (!h) return;
  h.cabinets.forEach(function (c) {
    if (cab && !(c.card === cab.card && c.port === cab.port && c.index === cab.index)) return;
    var k = d.id + '|' + c.card + '|' + c.port + '|' + c.index, b = hlt.base[k] || (hlt.base[k] = {});
    if (c.bitErrorsRaw != null) { if (zeroed) { c.bitErrorsRaw = 0; delete b.bitErrors; } else b.bitErrors = c.bitErrorsRaw; c.bitErrors = 0; }
    if (c.disconnectsRaw != null) { b.disconnects = c.disconnectsRaw; c.disconnects = 0; }
    hltErrMark('base', k, true);
  });
}

// ------------------------------------------------------------------ kept errors on the app server
// The held errors, the cleared alarm-log times (gone) and the counter baselines (base) live on the app server per project,
// beside it (serve.py / serve.ps1 /api/errors -> projects/<id>.errors.json; not in the project: no unsaved mark, no undo),
// so a reload, another browser or a restart of Open Nova shows the same list; only the user's Clear removes them. A browser
// sends only the keys it changed (a moment later; a Clear at once) and the server merges; another browser's change arrives
// as a live-update event (app-sync.js listen) and is read back. known = the keys the server has (as last read or sent),
// sending = the records of the change on its way, ready = the server's list is here (latching waits for it).
var hltSrv = { proj: '', rev: 0, t: null, busy: false, loading: false, again: false, ready: false, dirty: { held: {}, gone: {}, base: {} }, sending: {}, known: {} };
function hltSrvOn() { return typeof sync !== 'undefined' && sync.on && !!sync.project; }
function hltErrReady() {
  if (!hltSrvOn()) return true;   // opened as a file / no project on the server yet: this page only
  if (hltSrv.proj !== sync.project && !hltSrv.loading) hltErrLoad();
  return hltSrv.ready && hltSrv.proj === sync.project;
}
function hltErrMark(part, k, now) {
  if (!hltSrvOn()) return;
  hltSrv.dirty[part][k] = 1;
  clearTimeout(hltSrv.t); hltSrv.t = setTimeout(hltErrPush, now ? 0 : 1000);
}
function hltErrPush() {
  var S = hltSrv, dt = S.dirty, pid = S.proj || sync.project;
  if (!hltSrvOn() || !Object.keys(dt.held).length && !Object.keys(dt.gone).length && !Object.keys(dt.base).length) return;
  if (S.busy) { clearTimeout(S.t); S.t = setTimeout(hltErrPush, 300); return; }
  var body = { held: {}, gone: {}, base: {} };
  Object.keys(dt.held).forEach(function (k) { body.held[k] = hlt.held[k] || null; });
  Object.keys(dt.gone).forEach(function (k) { if (hlt.gone[k]) body.gone[k] = hlt.gone[k]; });
  Object.keys(dt.base).forEach(function (k) { body.base[k] = hlt.base[k] || null; });
  S.dirty = { held: {}, gone: {}, base: {} }; S.sending = body.held; S.busy = true;
  return fetch('api/errors?project=' + encodeURIComponent(pid), { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'X-Client': sync.id } })
    .then(function (r) {
      if (r.status === 404 || r.status === 410) return null;   // an older server without the list, or the project was removed meanwhile
      if (!r.ok) throw new Error('server error ' + r.status);
      return r.json();
    }).then(function (j) {
      S.busy = false; S.sending = {};
      if (!j || S !== hltSrv) return;
      S.rev = Math.max(S.rev, j.rev);
      Object.keys(body.held).forEach(function (k) { if (body.held[k]) S.known[k] = 1; else delete S.known[k]; });
    }).catch(function (e) {
      S.busy = false; S.sending = {};
      if (S !== hltSrv) return;
      ['held', 'gone', 'base'].forEach(function (p) { Object.keys(body[p]).forEach(function (k) { S.dirty[p][k] = 1; }); });
      log('health_errors_send_failed', { error: e.message, retry_in_s: 5 });
      clearTimeout(S.t); S.t = setTimeout(hltErrPush, 5000);
    });
}
// The server's list for the current project (at start, on reconnect, after another browser's change, on a project switch).
function hltErrLoad() {
  if (!hltSrvOn()) return Promise.resolve();
  if (hltSrv.proj && hltSrv.proj !== sync.project) hltErrReset();   // another project: its own list
  if (hltSrv.loading) { hltSrv.again = true; return Promise.resolve(); }
  var S = hltSrv, pid = sync.project; S.proj = pid; S.loading = true;
  return fetch('api/errors?project=' + encodeURIComponent(pid), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (doc) { if (doc && S === hltSrv) hltErrApply(doc); },
      function (e) { log('health_errors_load_failed', { error: String(e && e.message || e) }); })
    .then(function () { S.loading = false; S.ready = true; if (S.again && S === hltSrv) { S.again = false; hltErrLoad(); } });
}
// Switching projects: what is still unsent goes to the project it belongs to; then an empty list until the new one's arrives.
function hltErrReset() {
  hltErrPush(); clearTimeout(hltSrv.t);
  hltSrv = { proj: '', rev: 0, t: null, busy: false, loading: false, again: false, ready: false, dirty: { held: {}, gone: {}, base: {} }, sending: {}, known: {} };
  hlt.held = {}; hlt.gone = {}; hlt.base = {};
  hltList(); hltRedraw();
}
// The server's list in: its records win, except the ones this browser changed and hasn't sent yet (or is sending); a
// record the server had and no longer has was cleared in another browser; one it never had was found here first (sent up).
function hltErrApply(doc) {
  var S = hltSrv, held = doc.held || {}, cleared = [];
  if (doc.rev < S.rev) return;   // older than what this browser already sent
  S.rev = doc.rev;
  var mine = function (k) { return S.dirty.held[k] || S.sending[k] !== undefined; };
  Object.keys(hlt.held).forEach(function (k) {
    if (held[k] || mine(k)) return;
    if (S.known[k]) { cleared.push(hlt.held[k]); delete hlt.held[k]; } else hltErrMark('held', k);
  });
  Object.keys(held).forEach(function (k) { if (!mine(k) && held[k] && typeof held[k] === 'object') hlt.held[k] = held[k]; });
  S.known = {}; Object.keys(held).forEach(function (k) { S.known[k] = 1; });
  Object.keys(doc.gone || {}).forEach(function (k) { hlt.gone[k] = Math.max(hlt.gone[k] || 0, doc.gone[k]); });
  Object.keys(doc.base || {}).forEach(function (k) { if (!S.dirty.base[k]) hlt.base[k] = doc.base[k]; });
  // cleared elsewhere: no alarm when a reading here raises it again, readings started before are dropped, and the counters
  // kept between readings are forgotten (the next real read counts with that browser's baseline)
  cleared.forEach(function (r) {
    var w = hlt.watch[r.dev] || (hlt.watch[r.dev] = {}), h = hlt.by[r.dev];
    w.quiet = true; w.cgen = (w.cgen || 0) + 1;
    if (h && r.index != null) h.cabinets.forEach(function (c) {
      if (c.card === r.card && c.port === r.port && c.index === r.index) ['bitErrors', 'disconnects', 'bitErrorsRaw', 'disconnectsRaw'].forEach(function (x) { delete c[x]; });
    });
  });
  if (cleared.length) log('health_clear_elsewhere', { held: cleared.length, note: 'cleared in another browser' });
  hltList(); hltRedraw();
}
// app-sync.js: data: {"errors":rev,"from","project"} from another browser
// (not read yet here: e.g. this browser started before the server had any project)
function hltErrEvent(m) { if (m.project === sync.project && (m.project !== hltSrv.proj || m.errors > hltSrv.rev)) hltErrLoad(); }
// What Clear does on this processor, for its tooltips.
function hltClearTip(d) {
  var f = d && d.hw ? DRV.familyOf(d) : null;
  return f === 'lct' ? 'Also zeroes the receiving cards’ bit-error counters, as NovaLCT’s Clear Errors. Doesn’t save.' :
    f === 'coex' ? 'Also zeroes the cabinets’ packet-loss counters, as VMP’s clear. Doesn’t save.' :
    f === 'unico' ? 'Open Nova’s record only: Unico’s own clear hasn’t been seen live yet, so its counters stay; Open Nova counts on from now.' :
    'Open Nova’s record only (not linked).';
}
// Right-click on a cabinet (Monitor map, Maintain table, Layout canvas): clear it, or its whole processor.
function hltClearMenu(x, y, cab, more) {   // more: extra items after the clear ones (Maintain's Restart)
  var d = deviceOfCard(cab.card), rs = hltHeldAt(cab.card, cab.port, cab.index); if (!d) return;
  openMenu(x, y, [{ header: portLabel(cab.card, cab.port) + ' · cabinet ' + (cab.index + 1) + (rs.length ? ' · ' + rs.length + ' error' + (rs.length > 1 ? 's' : '') : '') },
    { label: 'Clear errors on this cabinet', act: function () { hltClear({ dev: d, cab: cab }); } },
    { label: 'Clear errors on ' + deviceLabel(d), act: function () { hltClear({ dev: d }); } }].concat(more || []));
}
function hltRedraw() {
  if (ui.tab === 'health') renderHealth();
  if (ui.tab === 'maintain' && typeof renderMaintain === 'function') renderMaintain();
  if (hlt.view !== 'off') renderAll();
}
function hltTick() {
  // Monitoring runs all the time while processors are linked, whatever tab is open or whether the window is in front
  // (user, 2026-10-11: "monitoring should be happening no matter what"); it only waits while a Send / Save / service runs.
  if (hwWriting()) return;
  (P.devices || []).forEach(function (d) {
    if (!d.hw || (hw.helper === false && d.hw.kind !== 'offline')) return;   // a simulated processor needs no helper
    if (typeof olPolls === 'function' && !olPolls(d)) return;   // online, not connected: not asked until a search finds it (app-online.js)
    var w = hlt.watch[d.id] || (hlt.watch[d.id] = {}), gap = HLT_MS[d.hw.kind] || 5000;
    if (w.inflight || (w.done && Date.now() - w.done < (w.err ? gap * 3 : gap))) return;
    hltPoll(d);
  });
}

// ------------------------------------------------------------------ the canvas overlay
// Which health cabinet a project panel is: its card / port, and its place in the port's chain as exported.
function hltCellAt(c) {
  if (c.sender == null || c.hole) return null;
  var list = hwPortCells()[c.sender + ':' + c.port] || [];
  for (var j = 0; j < list.length; j++) if (list[j].x === c.x && list[j].y === c.y) return { card: c.sender, port: c.port, index: j };
  return null;
}
function hltCabinet(c) {
  var at = hltCellAt(c); if (!at) return null;
  var d = P.devices.filter(function (x) { return cardsOfDevice(x).indexOf(c.sender) >= 0; })[0];
  var h = d && hlt.by[d.id]; if (!h) return null;
  var i = at.index;
  if (!h.idx) { h.idx = {}; h.cabinets.forEach(function (x) { h.idx[x.card + ':' + x.port + ':' + x.index] = x; }); }
  var x = h.idx[c.sender + ':' + c.port + ':' + i];
  if (x) return x;
  var det = typeof hwPortDetected === 'function' ? hwPortDetected(c.sender, c.port) : null;
  return det && i >= det.length ? { missing: true, beyond: true, det: det.length } : { missing: true };   // mapped past what the cable has
}
// -20 … 80 °C -> blue … red (the flat heat colours before app-heat.js; kept for callers outside this file)
function hltHeat(t) {
  if (t == null) return HLT_COL.unknown;
  var f = Math.max(0, Math.min(1, (t + 20) / 100));
  return 'hsl(' + Math.round(240 - 240 * f) + ',75%,50%)';
}
// Fill for a panel while the overlay is on, or null to keep the port colour.
function hltCellFill(c) {
  if (hlt.view === 'off') return null;
  if (hlt.view === 'temp' || hlt.view === 'volt') return 'rgba(0,0,0,0)';   // the heat image shows through (app-heat.js); still hit-testable
  var x = hltCabinet(c); if (!x) return null;
  if (hlt.view === 'ber') return watchBerFill(x);   // bit errors: flat per cabinet (counts are events, not interpolated)
  if (x.missing) return x.beyond ? HLT_COL.beyond : HLT_COL.unknown;
  if (x.dark) return HLT_COL.dark;
  if (x.tempStatus === 'error' || x.voltStatus === 'error' || (x.psu && x.psu.indexOf(0) >= 0)) return HLT_COL.error;
  if (x.tempStatus === 'warning' || x.voltStatus === 'warning') return x.side === 'backup' ? HLT_COL.backup : '#c8b400';
  return x.side === 'backup' ? HLT_COL.backup : HLT_COL.primary;
}
// After the panels are drawn: hatch the backup-fed ones, mark the break (a red bar before the first backup-fed cabinet of
// a port whose primary link is up) and write the temperature in each panel in heat-map mode.
function renderHealthOverlay(svg, cellsBy, unit) {
  if (hlt.view === 'off') return;
  var over = el('g', { 'pointer-events': 'none' }, svg);
  visibleScreens().forEach(function (s) {
    (cellsBy[s.id] || []).forEach(function (c) {
      var x = hltCabinet(c); if (!x || x.missing) return;
      // fed from the backup port: hatched in every live view (fine light lines over the heat image, so it isn't hidden)
      if (x.side === 'backup' && !x.dark)
        el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, fill: hlt.view === 'status' ? 'url(#hltHatch)' : 'url(#hltHatchFine)', 'stroke-width': 0 }, over);
      var held = hltHeldAt(c.sender, c.port, x.index);   // errors kept until Clear: a dot, hollow once ended
      if (held.length) {
        var live = held.some(function (r) { return !r.ended; }), mc = held.some(function (r) { return r.level === 'error'; }) ? HLT_COL.error : '#f2b33d';
        el('circle', { cx: c.x + c.w - 9 * unit, cy: c.y + 9 * unit, r: 5 * unit, fill: live ? mc : 'none', stroke: live ? '#fff' : mc, 'stroke-width': 2 * unit }, over);
      }
      var h = P.devices.map(function (d) { return hlt.by[d.id]; }).filter(Boolean);
      h.forEach(function (hh) {
        hh.ports.forEach(function (p) {
          if (p.card === c.sender && p.port === c.port && p.breakBefore != null && x.index === p.breakBefore)
            el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, fill: 'none', stroke: HLT_COL.dark, 'stroke-width': 4 * unit, 'stroke-dasharray': (6 * unit) + ' ' + (3 * unit) }, over);
        });
      });
    });
  });
  var defs = el('defs', {}, svg), pat = el('pattern', { id: 'hltHatch', width: 10 * unit, height: 10 * unit, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
  el('rect', { x: 0, y: 0, width: 4 * unit, height: 10 * unit, fill: 'rgba(0,0,0,.28)' }, pat);
  var fine = el('pattern', { id: 'hltHatchFine', width: 7 * unit, height: 7 * unit, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(-45)' }, defs);
  el('rect', { x: 0, y: 0, width: unit, height: 7 * unit, fill: 'rgba(255,255,255,.32)' }, fine);
  if (typeof heatOverlay === 'function') heatOverlay(svg, cellsBy, unit);   // the readings and MAX / MIN on the heat image (app-heat.js)
}

// ------------------------------------------------------------------ the cabinet map (Monitor tab, like VMP / Unico)
// Every screen drawn with its cabinets coloured by live state, the cable run of each port, and the break marked where a
// chain splits between primary and backup (or the primary port is dead). Hover a cabinet for its details.
function hltState(x) {
  if (!x) return { fill: '#3a4252', text: 'not linked / no reading', cls: 'na' };
  if (x.missing && x.beyond) return { fill: HLT_COL.beyond, text: 'not answering — mapping has more cabinets than the cable (' + x.det + ' answer on this port)', cls: 'beyond' };
  if (x.missing) return { fill: '#4a5262', text: 'not answering (no reading)', cls: 'na' };
  if (x.dark) return { fill: HLT_COL.dark, text: 'DARK — not answering on either side', cls: 'err' };
  var t = x.side === 'backup' ? 'fed from BACKUP' : 'on primary';
  if (x.psu && x.psu.indexOf(0) >= 0) return { fill: HLT_COL.error, text: t + ' · power supply ' + x.psu.map(function (v, k) { return v === 0 ? k + 1 : null; }).filter(Boolean).join(', ') + ' FAILED', cls: 'err' };
  if (x.tempStatus === 'error' || x.voltStatus === 'error') return { fill: HLT_COL.error, text: t + ' · temperature / voltage error', cls: 'err' };
  if (x.tempStatus === 'warning' || x.voltStatus === 'warning') return { fill: '#d4a017', text: t + ' · temperature / voltage warning', cls: 'warn' };
  return { fill: x.side === 'backup' ? HLT_COL.backup : HLT_COL.primary, text: t, cls: x.side === 'backup' ? 'warn' : 'ok', backup: x.side === 'backup' };
}
function hltMapHtml() {
  var cellsBy = allCells(), ports = hwPortCells(), out = '', pl = hltPlaces();   // the badges count as the Monitor tile does
  var hs = hltDevs().map(function (d) { return hlt.by[d.id]; }).filter(Boolean), gone = typeof olGone === 'function' ? olGone() : [];
  var portInfo = function (card, port) { for (var i = 0; i < hs.length; i++) for (var j = 0; j < hs[i].ports.length; j++) { var p = hs[i].ports[j]; if (p.card === card && p.port === port) return p; } return null; };
  P.lct.forEach(function (lc) {
    if (gone.length && !olLcShown(lc, gone)) return;
    var cells = [];
    P.screens.forEach(function (s) { if (s.screenId === lc.id) (cellsBy[s.id] || []).forEach(function (c) { if (!c.hole) cells.push(c); }); });
    if (!cells.length) return;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    cells.forEach(function (c) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); });
    var W = x1 - x0, H = y1 - y0, pad = Math.max(W, H) * 0.03, u = Math.max(W, H) / 700;   // u = one screen pixel at ~700 px wide
    var svg = '<svg class="hm-svg" viewBox="' + (x0 - pad) + ' ' + (y0 - pad) + ' ' + (W + 2 * pad) + ' ' + (H + 2 * pad) + '" preserveAspectRatio="xMidYMid meet">' +
      '<defs><pattern id="hmHatch" width="' + 12 * u + '" height="' + 12 * u + '" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="' + 5 * u + '" height="' + 12 * u + '" fill="rgba(0,0,0,.30)"/></pattern><pattern id="hmHatchFine" width="' + 8 * u + '" height="' + 8 * u + '" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="' + 1.2 * u + '" height="' + 8 * u + '" fill="rgba(255,255,255,.32)"/></pattern></defs>';
    var counts = { ok: 0, warn: 0, err: 0, backup: 0, na: 0, beyond: 0, held: 0 }, seenPorts = {}, mv = hlt.mapView || 'status';
    // Temperature / Voltage: the same interpolated image as the Layout canvas (app-heat.js) under see-through cabinets
    var him = (mv === 'temp' || mv === 'volt') && typeof heatImage === 'function' ? heatImage('map:' + lc.id, cells, mv) : null, hset = {};
    if (him) { svg += '<defs><filter id="hmTxt" x="-30%" y="-40%" width="160%" height="180%"><feDropShadow dx="0" dy="' + u + '" stdDeviation="' + u + '" flood-color="#000" flood-opacity="1" result="a"/><feDropShadow in="a" dx="0" dy="0" stdDeviation="' + 1.5 * u + '" flood-color="#000" flood-opacity="1"/></filter></defs>' + heatImgTag(him);
      him.items.forEach(function (it) { if (it.w) hset[it.c.k + '@' + it.c.x + ',' + it.c.y] = it; }); }
    cells.forEach(function (c) {
      var x = hltCabinet(c), st = hltState(x), view = mv, hit = him && hset[c.k + '@' + c.x + ',' + c.y];
      var fill = view === 'ber' ? watchBerFill(x) : hit ? 'rgba(0,0,0,0)' : st.fill;
      var list = ports[c.sender + ':' + c.port] || [], idx = -1;
      for (var j = 0; j < list.length; j++) if (list[j].x === c.x && list[j].y === c.y) { idx = j; break; }
      var dv = deviceOfCard(c.sender), pk = (dv && dv.id) + '|' + c.sender + '|' + c.port + '|' + idx;
      counts[hltCabClass(dv && dv.id, c.sender, c.port, idx, x, pl)]++;
      if (pl[pk]) counts.held++;
      var tip = portLabel(c.sender, c.port) + ' · cabinet ' + (idx + 1) + ' — ' + st.text + (x && x.temp != null && !x.missing ? ' · ' + tempFmt(x.temp) : '') + (x && x.voltage ? ' · ' + x.voltage.toFixed(2) + ' V' : '') + (x && x.bitErrors ? ' · bit errors ' + (x.bitErrors === 65535 ? '65535+ (counter full)' : x.bitErrors) : '') + (x && x.disconnects ? ' · ' + x.disconnects + ' disconnect' + (x.disconnects === 1 ? '' : 's') : '') + (x && x.psu ? ' · power ' + x.psu.map(function (v) { return v === 1 ? 'ok' : v === 0 ? 'FAILED' : '?'; }).join(' / ') : '');
      // errors kept until Clear: an outline and a corner dot, solid while it lasts, dashed / hollow once it ended
      var held = hltHeldAt(c.sender, c.port, idx), live = held.filter(function (r) { return !r.ended; }), mark = '';
      if (held.length) {
        var mc = held.some(function (r) { return r.level === 'error'; }) ? HLT_COL.error : '#f2b33d';
        tip += '\nKept until Clear: ' + hltHeldText(held) + '\nRight-click to clear';
        var sw = Math.max(4 * u, Math.min(c.w, c.h) * 0.05), rr = Math.max(6 * u, Math.min(c.w, c.h) * 0.09);   // visible however small the map is drawn
        mark = '<rect x="' + (c.x + sw) + '" y="' + (c.y + sw) + '" width="' + Math.max(0, c.w - 2 * sw) + '" height="' + Math.max(0, c.h - 2 * sw) + '" fill="none" stroke="' + mc + '" stroke-width="' + sw + '"' + (live.length ? '' : ' stroke-dasharray="' + 2 * sw + ' ' + 1.5 * sw + '"') + '/>' +
          '<circle class="hm-mark" cx="' + (c.x + c.w - sw - rr * 1.4) + '" cy="' + (c.y + sw + rr * 1.4) + '" r="' + rr + '" fill="' + (live.length ? mc : 'none') + '" stroke="' + (live.length ? '#fff' : mc) + '" stroke-width="' + rr * 0.4 + '"/>';
      }
      svg += '<g class="hm-cab" data-cab="' + c.sender + ':' + c.port + ':' + idx + '"><title>' + esc(tip) + '</title><rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" fill="' + fill + '" stroke="#0b0e14" stroke-width="' + 2 * u + '"/>' +
        (st.backup && view !== 'ber' ? '<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" fill="url(#' + (view === 'status' ? 'hmHatch' : 'hmHatchFine') + ')"/>' : '') +
        (x && x.dark ? '<path d="M' + (c.x + c.w * .25) + ' ' + (c.y + c.h * .25) + 'L' + (c.x + c.w * .75) + ' ' + (c.y + c.h * .75) + 'M' + (c.x + c.w * .75) + ' ' + (c.y + c.h * .25) + 'L' + (c.x + c.w * .25) + ' ' + (c.y + c.h * .75) + '" stroke="#fff" stroke-width="' + 3 * u + '"/>' : '') + mark;
      if (Math.min(c.w, c.h) / u > 26) svg += '<text x="' + (c.x + 4 * u) + '" y="' + (c.y + 12 * u) + '" font-size="' + 10 * u + '" fill="#fff" font-weight="700" stroke="#000" stroke-width="' + 2 * u + '" paint-order="stroke">' + 'P' + (c.port + 1) + '·' + (idx + 1) + '</text>' +
        (hit ? '<text x="' + (c.x + c.w / 2) + '" y="' + (c.y + c.h * 0.68) + '" text-anchor="middle" dominant-baseline="central" font-size="' + 13 * u + '" fill="#fff" font-weight="700" filter="url(#hmTxt)">' + (view === 'volt' ? hit.v.toFixed(2) : tempFmt(hit.v, 1, true)) + '</text>' : view === 'ber' && x && x.bitErrors ? '<text x="' + (c.x + c.w / 2) + '" y="' + (c.y + c.h * 0.68) + '" text-anchor="middle" dominant-baseline="central" font-size="' + 13 * u + '" fill="#fff" font-weight="700" stroke="#000" stroke-width="' + 2.5 * u + '" paint-order="stroke">' + x.bitErrors + '</text>' : '');
      seenPorts[c.sender + ':' + c.port] = 1;
    });
    // cable runs, and the break: where the primary feed stops (a split chain), or before the first cabinet (primary dead)
    Object.keys(seenPorts).forEach(function (k) {
      var list = ports[k] || [], sp = k.split(':'), p = portInfo(+sp[0], +sp[1]);
      if (list.length > 1) svg += '<polyline points="' + list.map(function (c) { return (c.x + c.width / 2) + ',' + (c.y + c.height / 2); }).join(' ') + '" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="' + 2 * u + '" stroke-linejoin="round"/>';
      if (list.length) svg += '<circle cx="' + (list[0].x + list[0].width / 2) + '" cy="' + (list[0].y + list[0].height / 2) + '" r="' + 5 * u + '" fill="#fff"/>';   // cable in
      if (!p) return;
      var bk = p.breakBefore != null ? p.breakBefore : /primary failed/.test(p.link || '') ? 0 : null;
      if (bk == null) return;
      var a = list[bk - 1], b = list[bk], mx, my;
      if (b && a) { mx = (a.x + a.width / 2 + b.x + b.width / 2) / 2; my = (a.y + a.height / 2 + b.y + b.height / 2) / 2; }
      else if (b) { mx = b.x + b.width / 2; my = b.y + 8 * u; }
      else return;
      svg += '<g class="hm-break"><title>' + esc(portLabel(+sp[0], +sp[1]) + ': ' + (bk ? 'data break between cabinets ' + bk + ' and ' + (bk + 1) + ' — cabinets ' + (bk + 1) + '–' + list.length + ' fed from the backup port' : 'primary port dead — the whole chain is fed from the backup port')) + '</title>' +
        '<circle cx="' + mx + '" cy="' + my + '" r="' + 11 * u + '" fill="' + HLT_COL.dark + '" stroke="#fff" stroke-width="' + 2.5 * u + '"/>' +
        '<path d="M' + (mx - 5 * u) + ' ' + (my - 5 * u) + 'L' + (mx + 5 * u) + ' ' + (my + 5 * u) + 'M' + (mx + 5 * u) + ' ' + (my - 5 * u) + 'L' + (mx - 5 * u) + ' ' + (my + 5 * u) + '" stroke="#fff" stroke-width="' + 3 * u + '"/></g>';
    });
    svg += '</svg>';
    out += '<div class="hm-screen"><div class="hm-h"><b>' + esc(lc.name) + '</b><span class="hint">' + cells.length + ' cabinets</span>' +
      (counts.err ? '<span class="hm-pill err">' + hltPl(counts.err, 'error') + '</span>' : '') + (counts.warn ? '<span class="hm-pill warn">' + hltPl(counts.warn, 'warning') + '</span>' : '') +
      (counts.backup ? '<span class="hm-pill warn">' + counts.backup + ' on backup</span>' : '') +
      (counts.ok ? '<span class="hm-pill ok">' + counts.ok + ' OK</span>' : '') + (counts.na ? '<span class="hm-pill na">' + counts.na + ' no reading</span>' : '') +
      (counts.beyond ? '<span class="hm-pill beyond" title="Mapped in the layout, but the cable on that port has fewer cabinets: check the layout or which cable is in which port">' + counts.beyond + ' not on the cable</span>' : '') +
      (counts.held ? '<span class="hm-pill held" title="Cabinets with errors kept until you clear them: right-click a cabinet, or Clear all in Events">' + counts.held + ' to clear</span>' : '') + '</div>' + svg + '</div>';
  });
  if (!out) return '';
  var v = hlt.mapView || 'status';
  return '<div class="hm-card"><div class="hm-top"><b class="dv-h">Cabinet map</b><span class="grow"></span>' +
    '<div class="seg hm-seg"><button data-hm="status"' + (v === 'status' ? ' class="on"' : '') + '>Status</button><button data-hm="temp"' + (v === 'temp' ? ' class="on"' : '') + '>Temperature</button><button data-hm="volt"' + (v === 'volt' ? ' class="on"' : '') + ' title="Supply voltage per cabinet">Voltage</button><button data-hm="ber"' + (v === 'ber' ? ' class="on"' : '') + ' title="Bit errors per cabinet (signal problems on the cable)">Bit errors</button></div></div>' +
    ((v === 'temp' || v === 'volt') && typeof heatLegendBar === 'function' ? (function () {   // the heat image's scale (one per screen; the first one's here)
      var e = heat.img[Object.keys(heat.img).filter(function (k) { return k.indexOf('map:') === 0 && heat.img[k].mode === v; })[0]];
      return '<div class="hm-legend hm-heatleg"><span>' + (v === 'volt' ? 'Supply V · fixed' : 'Temperature ' + tempUnit() + ' · ' + heat.scale) + '</span>' + (e ? heatLegendBar(v, e.lo, e.hi, 260) : '') +
        '<span><i style="background:#4a5262"></i>no reading</span><span><i style="background:' + HLT_COL.dark + '"></i>dark</span><span><i class="hm-hatch" style="background:#7a3d8c"></i>fed from backup</span><span><b class="hm-x">✕</b>break</span></div>';
    })() :
    v === 'ber' ?'<div class="hm-legend"><span><i style="background:' + HLT_COL.primary + '"></i>none</span><span><i style="background:#d4a017"></i>1–9</span><span><i style="background:#e07a3a"></i>10–99</span><span><i style="background:' + HLT_COL.error + '"></i>100+</span><span><i style="background:#3a4252"></i>no reading</span></div>' :
    v === 'temp' ? '<div class="hm-legend"><span><i class="hm-heat"></i>' + tempFmt(-20, 0) + ' … ' + tempFmt(80, 0) + '</span><span><i style="background:' + HLT_COL.dark + '"></i>dark</span><span><b class="hm-x">✕</b>break</span></div>' :
    '<div class="hm-legend"><span><i style="background:' + HLT_COL.primary + '"></i>on primary</span><span><i class="hm-hatch" style="background:' + HLT_COL.backup + '"></i>fed from backup</span>' +
    '<span><i style="background:' + HLT_COL.dark + '"></i>dark / fault</span><span><i style="background:#3a4252"></i>no reading</span><span title="Mapped in the layout, but the cable on that port has fewer cabinets"><i style="background:' + HLT_COL.beyond + '"></i>not on the cable</span><span><b class="hm-x">✕</b>break</span><span><b class="hm-dot">●</b>cable in</span>' +
    '<span title="Errors stay marked until you clear them (right-click the cabinet); dashed once the problem stopped"><i class="hm-held"></i>error · <i class="hm-held ended"></i>ended, until Clear</span></div>') + '<div class="hm-screens">' + out + '</div></div>';
}

// ------------------------------------------------------------------ the Health tab
// A port with something to look at: no / broken link, cabinets dark, on backup or warning, or errors kept until Clear.
function hltPortBad(h, p) {
  if (!/^(ok|redundant, ok)$/.test(p.link)) return true;
  if (h.cabinets.some(function (c) { return c.card === p.card && c.port === p.port && (c.dark || c.side === 'backup' || (c.tempStatus && c.tempStatus !== 'ok') || (c.voltStatus && c.voltStatus !== 'ok') || (c.psu && c.psu.indexOf(0) >= 0)); })) return true;
  return Object.keys(hlt.held).some(function (k) { var r = hlt.held[k]; return r.card === p.card && r.port === p.port; });
}
function hltDeviceHtml(d) {
  var h = hlt.by[d.id], w = hlt.watch[d.id] || {}, m = procModel(d.model).name;
  var out = '<section class="hl-dev"><div class="hl-dev-h"><b title="' + esc(deviceLabel(d) + ' · ' + m + ' · ' + d.hw.name) + '">' + esc(d.name || 'Processor') + '</b> · ' +
    esc((m && m !== d.name ? m + ' · ' : '') + hwWhere(d.hw.host, d.hw.port)) + (h ? ' <span class="hint">· ' + Math.round((Date.now() - h.at) / 1000) + ' s ago</span>' : '') +
    ' <button class="mini hl-clr" data-hlclear="' + esc(d.id) + '" title="' + esc('Clear this processor’s errors: the events, the marks on the map. ' + hltClearTip(d)) + '">Clear errors</button></div>';
  if (w.err) out += '<p class="hl-err" title="' + esc(w.err) + '">⚠ ' + esc(hwErrText(w.err)) + ' — retrying</p>';   // the same words as the Hardware card (hwErrText, app-hardware.js)
  if (!h) return out + '<p class="hint">Reading…</p></section>';
  var n = h.sum, c = hltCounts(function (r) { return r.dev === d.id; });   // warnings / errors as the Monitor tile counts them
  out += '<div class="hl-tiles">' +
    '<div class="hl-tile ok"><b>' + (n.total - n.backup - n.dark) + '</b><span>on primary</span></div>' +
    '<div class="hl-tile' + (n.backup ? ' warn' : '') + '"><b>' + n.backup + '</b><span>on backup</span></div>' +
    '<div class="hl-tile' + (n.dark ? ' err' : '') + '"><b>' + n.dark + '</b><span>dark</span></div>' +
    '<div class="hl-tile' + (c.warn ? ' warn' : '') + '"><b>' + c.warn + '</b><span>warnings</span></div>' +
    '<div class="hl-tile' + (c.err ? ' err' : '') + '"><b>' + c.err + '</b><span>errors</span></div></div>' +
    (typeof watchHistHtml === 'function' ? watchHistHtml(d) : '');
  // the port table: the ports with a problem only (red / amber, first), the healthy ones behind "N ports OK ▸" (item 8)
  var bad = h.ports.filter(function (p) { return hltPortBad(h, p); }), okN = h.ports.length - bad.length, open = !!(hlt.okOpen || {})[d.id];
  var rows = open ? h.ports : bad;
  if (rows.length) {
    out += '<table class="hl-ports"><thead><tr><th>Port</th><th>State</th><th>Cabinets</th><th>Backup port</th><th>Temp (max)</th></tr></thead><tbody>';
    rows.slice().sort(function (a, b) { return (bad.indexOf(b) >= 0) - (bad.indexOf(a) >= 0) || a.card - b.card || a.port - b.port; }).forEach(function (p) {
      var cs = h.cabinets.filter(function (c) { return c.card === p.card && c.port === p.port && c.temp != null; });
      var tmax = cs.length ? Math.max.apply(null, cs.map(function (c) { return c.temp; })) : null;
      var linkBad = !/^(ok|redundant, ok)$/.test(p.link);
      var cls = bad.indexOf(p) < 0 ? '' : /failed|dark|no link|no signal/.test(p.link) || h.cabinets.some(function (c) { return c.card === p.card && c.port === p.port && c.dark; }) ? ' class="err"' : ' class="warn"';
      var held = hltCounts(function (r) { return r.dev === d.id && r.card === p.card && r.port === p.port; }).clear;
      out += '<tr' + cls + '><td>' + esc(portLabel(p.card, p.port)) + '</td><td>' + esc(p.link) + (!linkBad && held ? ' · ' + held + ' to clear' : '') + '</td><td>' + (p.cabinets || cs.length || '') + '</td><td>' +
        (p.backup ? esc(portLabel(p.backup.card, p.backup.port)) + (p.backup.link === false ? ' (no link)' : '') : '—') + '</td><td>' + tempFmt(tmax) + '</td></tr>';
    });
    out += '</tbody></table>';
  }
  if (okN) out += '<button class="mini hl-okbtn" data-hlok="' + esc(d.id) + '" aria-expanded="' + open + '">' + (open ? 'Hide the ' + okN + ' OK port' + (okN === 1 ? '' : 's') + ' ▾' : okN + ' port' + (okN === 1 ? '' : 's') + ' OK ▸') + '</button>';
  return out + '</section>';
}
function renderHealth() {
  var box = $('hlBody'); if (!box || ui.tab !== 'health') return;
  var linked = hltDevs().filter(function (d) { return d.hw; });
  var h = linked.length ? linked.map(hltDeviceHtml).join('') :
    '<p class="hint">No processor linked — link one in Device ▸ Hardware.</p>';
  box.innerHTML = (typeof preHtml === 'function' ? preHtml() : '') + h;   // the pre-show check's result on top (app-preshow.js)
  // the cabinet map: redrawn only when a reading, the layout or the view changed (so hovering a cabinet doesn't flicker)
  var hm = $('hmBody');
  if (hm) {
    if (renderHealth.snap !== ui.lastSnap) { renderHealth.snap = ui.lastSnap; renderHealth.rev = (renderHealth.rev || 0) + 1; }   // any commit, even same-length
    var key = (hlt.mapView || 'status') + '|' + watch.set.unit + '|' + (typeof heat !== 'undefined' ? heat.pal + heat.scale : '') + '|' + renderHealth.rev + '|' + hlt.rev + '|' + hltDevs().map(function (d) { var x = hlt.by[d.id]; return d.id + (x ? x.at : 0); }).join(',');
    if (hm.dataset.key !== key) { hm.dataset.key = key; hm.innerHTML = hltMapHtml(); }
  }
  // the held errors: still going first, then ended ("ended hh:mm", greyed) — all until the user's Clear
  var ids = {}; hltDevs().forEach(function (d) { ids[d.id] = 1; });
  var shownLog = hlt.log.filter(function (e) { return ids[e.devId] || !deviceById(e.devId); });   // online: not a processor that isn't connected
  $('hlLog').innerHTML = shownLog.length ? shownLog.map(function (e) {
    var a = typeof alarmInfo === 'function' ? alarmInfo(e.text) : null;   // cause / suggestion (app-alarms.js)
    return '<li class="' + esc(e.level) + (e.ended ? ' ended' : '') + '"' + (a ? ' title="' + esc(a.cause + ' ' + a.suggestion) + '"' : '') + '><time>' + esc(new Date(e.t).toLocaleTimeString()) + '</time> <b>' + esc(e.dev) + '</b> ' + esc(e.where) + (e.where ? ' · ' : '') + esc(watchText(e.text)) +
      (e.n > 1 ? ' <span class="hl-n" title="Came back after it had ended">×' + e.n + '</span>' : '') +
      (e.ended ? ' <span class="hl-ended">ended ' + esc(new Date(e.ended).toLocaleTimeString()) + '</span>' : '') +
      (a ? '<span class="hl-fix">' + esc(a.suggestion) + '</span>' : '') + '</li>';
  }).join('') : '<li class="hint">No errors.</li>';
}
function bindHealth() {
  var lv = $('liveView');
  if (lv) lv.onchange = function () {
    hlt.view = lv.value; log('live_view', { view: hlt.view }); renderAll();
    if (hlt.view !== 'off') hltDevs().forEach(function (d) { if (d.hw && !hlt.by[d.id]) hltPoll(d); });
  };
  var sc = $('hlShowCanvas');
  if (sc) sc.onclick = function () {   // a shortcut to Layout's View ▸ Live ▸ status (app-forms.js viewLive)
    if (typeof viewLive === 'function') return viewLive('status');
    hlt.view = 'status'; if (lv) lv.value = 'status'; setTab('layout');
  };
  var pb = $('hlPre');
  if (pb) pb.onclick = function () { preCheck(); };
  var cv = $('hlCsv');
  if (cv) cv.onclick = function () { if (!hlt.log.length) return toast('No events to export'); alarmsDownload(); };
  $('hlBody').addEventListener('click', function (e) {
    var c = e.target.closest('[data-hlclear]');
    if (c) { var d = deviceById(c.dataset.hlclear); if (d) { log('health_clear_click', { scope: 'processor', processor: d.name }); hltClear({ dev: d }); } return; }
    var ok = e.target.closest('[data-hlok]');   // "N ports OK ▸": show / hide the healthy ports
    if (ok) { hlt.okOpen[ok.dataset.hlok] = !hlt.okOpen[ok.dataset.hlok]; renderHealth(); return; }
    var b = e.target.closest('[data-pre]'); if (!b) return;
    if (b.dataset.pre === 'report') preReportDownload(); else { pre.result = null; renderHealth(); }
  });
  var hmb = $('hmBody');
  if (hmb) hmb.addEventListener('click', function (e) {
    var b = e.target.closest('[data-hm]'); if (!b) return;
    hlt.mapView = b.dataset.hm; log('cabinet_map_view', { view: hlt.mapView }); renderHealth();
  });
  if (hmb) hmb.addEventListener('contextmenu', function (e) {   // right-click a cabinet: clear it / its processor
    var g = e.target.closest('[data-cab]'); if (!g) return;
    var sp = g.dataset.cab.split(':').map(Number); if (sp[2] < 0) return;
    e.preventDefault(); hltClearMenu(e.clientX, e.clientY, { card: sp[0], port: sp[1], index: sp[2] });
  });
  var cl = $('hlClear');
  if (cl) cl.onclick = function () { log('health_clear_click', { scope: 'all' }); hltClear(null); };
  setInterval(hltTick, 1000);
  setInterval(function () { if (ui.tab === 'health' && !document.hidden) renderHealth(); }, 1000);   // "n s ago"
  if (typeof bindHeat === 'function') bindHeat();   // the heat map's legend (app-heat.js)
}
