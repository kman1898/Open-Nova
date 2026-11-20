// node app/tests/optfiber_test.js — an H9 tester's wall (2026-11-19, alpha.2): four H 16-port cards (0x7B46), ports 9–16 back up
// 1–8 on the same card, OPT1 = primary (ports 1–8), OPT2 = backup (9–16). OPT1's fibre wasn't plugged in: card 2's five ports had
// no link and ran on OPT2 -> ONE "OPT1 fiber" event, no per-port "primary port failed" and no break at cabinet 1. Card 1 had
// one port down and one up -> per-port, as before. Also the layout vs the cables: card 2's port 1 maps 10 and port 5 maps 5 (the
// user: "port 5 is the one that has 5 panels"), but backup port 9 reached 5 cards and port 13 reached 10 -> the backup cables
// of ports 1 and 5 are swapped (one error, each reading on the cabinet it came from); a plain count gap; the cabinets mapped
// past the cable; and the backup-side fibre. The fixture is the report's
// own shape (helper health reply, detection, layout counts); no tester data.
var vm = require('vm'), fs = require('fs'), path = require('path');
var fails = 0;
function ok(cond, text, more) { console.log((cond ? 'PASS ' : 'FAIL ') + text + (cond || more === undefined ? '' : '  ' + JSON.stringify(more))); if (!cond) fails++; }

var H16 = 0x7B46;
function load() {
  var ctx = { console: console, Object: Object, JSON: JSON, Math: Math, Date: Date, String: String, Promise: Promise, setTimeout: setTimeout, clearTimeout: clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app-health.js'), 'utf8'), ctx, { filename: 'app-health.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app-alarms.js'), 'utf8'), ctx, { filename: 'app-alarms.js' });
  // what app-health needs from the rest of the app
  vm.runInContext([
    "var OUTPUT_CARDS = { h16: { name: 'H 16-port (RJ45)', ports: 16, modelId: 0x7B46 }, h4fiber: { ports: 32, modelId: 0x7B4A }, h8fiber: { ports: 40, modelId: 0x7B4F } };",
    "var ui = { tab: 'health' }, logged = [];",
    "function log(a, d) { logged.push([a, d]); }",
    "function cardsOfDevice(d) { var o = []; P.processors.forEach(function (c, i) { if (c.dev === d.id) o.push(i); }); return o; }",
    "function deviceById(id) { return P.devices.filter(function (d) { return d.id === id; })[0]; }",
    "function deviceOfCard(i) { var c = P.processors[i]; return c ? deviceById(c.dev) : null; }",
    "function deviceLabel(d) { return d.name; }",
    "function portLabel(s, p) { return 'S' + (s + 1) + ' P' + (p + 1); }",
    "function hwPortCells() { return CELLS; }",
    "function hwPortDetected(card, port) { var d = deviceOfCard(card), lv = d && hw.live[d.id]; if (!lv) return null; var c = lv.cards[cardsOfDevice(d).indexOf(card)]; return c ? (c.ports[port] || []) : null; }",
    "function watchText(t) { return t; }"
  ].join('\n'), ctx);
  return ctx;
}

// ------------------------------------------------------------------ the fixture: card 2 (index 1) of the H9, as read
// mapped (the processor's NSSD): card 2 port 1 = 10 cabinets, ports 2–4 = 10, port 5 = 5. The cables (detection via the
// backup ports 9–13): port 1 = 5, ports 2–4 = 10, port 5 = 10.
var MAPPED = { 0: 10, 1: 10, 2: 10, 3: 10, 4: 5 }, SWAPPED = { 0: 5, 1: 10, 2: 10, 3: 10, 4: 10 }, CABLE = SWAPPED;
function cab(w, via) { return { w: w || 216, h: 216, via: via || 'primary' }; }
function chain(n, via) { var a = []; for (var i = 0; i < n; i++) a.push(cab(216, via)); return a; }
function setup(c, opt) {
  opt = opt || {};
  CABLE = opt.cable || SWAPPED;
  c.P = { devices: [{ id: 'h9', name: 'H9', model: 'h9', hw: { kind: 'lct', host: '192.0.2.10', port: 5201, senders: [H16, H16, H16, H16] } }],
    processors: [0, 1, 2, 3].map(function () { return { ports: 16, dev: 'h9', type: 'h16' }; }), backup: { mode: 'port', pairs: [] } };
  if (opt.noSenders) c.P.devices[0].hw.senders = [];
  var cells = {}, x = 0;
  Object.keys(MAPPED).forEach(function (p) { cells['1:' + p] = []; for (var i = 0; i < MAPPED[p]; i++) cells['1:' + p].push({ x: x, y: i * 216, width: 216, height: 216 }); x += 216; });
  cells['0:0'] = chain(14).map(function (q, i) { return { x: 2000, y: i * 216 }; }); cells['0:1'] = chain(14).map(function (q, i) { return { x: 2216, y: i * 216 }; });
  c.CELLS = cells;
  var ports1 = {}; Object.keys(CABLE).forEach(function (p) { ports1[p] = chain(CABLE[p], opt.via || 'backup'); });   // OPT1 out: read via 9–13
  c.hw = { live: { h9: { cards: [{ ports: { 0: chain(14), 1: chain(14) } }, { ports: ports1 }, { ports: { 0: chain(14), 1: chain(14) } }, { ports: {} }] } } };
}
// the helper's /api/hw/health reply (card numbers on the link), shaped as novalink.health returns it
function reply(o) {
  o = o || {};
  var ports = [], cabs = [], events = [];
  var port = function (card, p, n, st) {   // st: dead (no link, all on backup) | up | bkdown (backup no link) | break (link up, cabinet 1 only via backup)
    var bk = { card: card, port: p + 8, link: st !== 'bkdown', carrying: false };
    ports.push({ card: card, port: p, cabinets: n, onBackup: st === 'dead' || st === 'break', backup: bk,
      link: st === 'dead' ? 'primary failed, running on backup' : st === 'break' ? 'data break before cabinet 1, split feed' : st === 'bkdown' ? 'redundancy lost (backup cable)' : 'redundant, ok',
      breakBefore: st === 'break' ? 0 : null });
    for (var i = 0; i < n; i++) cabs.push({ card: card, port: p, index: i, side: st === 'dead' || (st === 'break' && i === 0) ? 'backup' : 'primary', dark: false, temp: 40, tempStatus: 'ok', voltage: 4.1, voltStatus: 'ok' });
    if (st === 'dead') events.push({ level: 'error', card: card, port: p, index: 0, text: 'primary port failed, all cabinets on backup' });
    if (st === 'break') events.push({ level: 'warning', card: card, port: p, index: 0, text: 'data break before cabinet 1, cabinets 1-14 on backup' });
    if (st === 'bkdown') events.push({ level: 'warning', card: card, port: p, index: null, text: 'redundancy lost: backup port ' + (p + 9) + ' has no link' });
  };
  port(0, 0, 14, 'dead'); port(0, 1, 14, o.card1Port2 || 'up');                          // card 1: one port down, one up
  [0, 1, 2, 3, 4].forEach(function (p) { port(1, p, CABLE[p], o.card2 || 'dead'); });  // card 2: OPT1 unplugged
  port(2, 0, 14, 'up'); port(2, 1, 14, 'break');                                          // card 3: a consistent fault at cabinet 1
  return { ports: ports, cabinets: cabs, events: events, device: {} };
}

// ------------------------------------------------------------------ OPT groups
var c = load();
ok(JSON.stringify(c.hltOptOf(H16, 0)) === JSON.stringify({ opt: 1, from: 0, to: 7 }) && c.hltOptOf(H16, 8).opt === 2 && c.hltOptOf(H16, 15).opt === 2 && c.hltOptOf(H16, 16) === null,
  'H 16-port card: OPT1 = ports 1–8, OPT2 = ports 9–16');
ok(c.hltOptOf(0x7B4A, 31).opt === 4 && c.hltOptOf(0x7B4F, 9).opt === 1 && c.hltOptOf(0x7B4F, 10).opt === 2 && c.hltOptOf(0x7B4F, 39).opt === 4 && c.hltOptOf(0x7B48, 0) === null,
  'H_4xFiber 8 ports per OPT, H_8xFiber 10; the 20-port RJ45 card has none');

// ------------------------------------------------------------------ the tester's wall
setup(c);
var h = c.hltNorm(c.P.devices[0], reply());
var ev = function (re) { return h.events.filter(function (e) { return re.test(e.text); }); };
var opt = ev(/^OPT1 fiber/);
ok(opt.length === 1 && opt[0].card === 1 && opt[0].port === null && opt[0].level === 'error' && opt[0].cardWide &&
   opt[0].text === 'OPT1 fiber: no link — ports 1–8 running on backup (OPT2)', 'card 2: ONE event "OPT1 fiber: no link — ports 1–8 running on backup (OPT2)"', opt);
ok(!ev(/^primary port failed/).some(function (e) { return e.card === 1; }), 'card 2: no per-port "primary port failed" left');
ok(ev(/^primary port failed/).filter(function (e) { return e.card === 0; }).length === 1, 'card 1: port 1 down, port 2 up -> its per-port event stays (a cable, not the fibre)');
ok(ev(/^data break before cabinet 1/).filter(function (e) { return e.card === 2 && e.port === 1; }).length === 1, 'card 3 port 2: the break before cabinet 1 stays an event (a consistent fault, not slowness)');
var p2 = h.ports.filter(function (p) { return p.card === 1; });
ok(p2.length === 5 && p2.every(function (p) { return p.opt === 'OPT1' && /^OPT1 fiber: no link — running on backup \(OPT2\)$/.test(p.link) && p.breakBefore == null; }),
  'card 2\'s ports say "OPT1 fiber: no link — running on backup (OPT2)", no break position', p2.map(function (p) { return p.link; }));
ok(h.cabinets.filter(function (x) { return x.card === 1; }).every(function (x) { return x.side === 'backup'; }) && h.sum.backup >= 45, 'the cabinets still show as on backup');
ok(c.alarmInfo(opt[0].text) && /fibre/.test(c.alarmInfo(opt[0].text).suggestion) && /SFP/.test(c.alarmInfo(opt[0].text).suggestion), 'Monitor explains it: check the fibre / SFP / converter');

// held (kept until Clear) and where it is
c.hltLatch(c.P.devices[0], h);
var held = Object.keys(c.hlt.held).map(function (k) { return c.hlt.held[k]; }).filter(function (r) { return /^OPT1 fiber/.test(r.text); });
ok(held.length === 1 && held[0].cardWide && c.hltWhere(held[0]) === 'S2', 'kept until Clear as one record, where = the card (S2)', held);
var line = c.hlt.log.filter(function (e) { return /^OPT1 fiber/.test(e.text); })[0];
ok(line && line.where === 'S2' && line.level === 'error', 'the event list: "H9 S2 · OPT1 fiber: no link — …"', line);

// ------------------------------------------------------------------ layout vs cables: the swapped backup cables
var gap = ev(/cabinets? mapped/), swp = ev(/swapped/);
ok(swp.length === 1 && swp[0].card === 1 && swp[0].port === 0 && swp[0].level === 'error' &&
   swp[0].text === 'Backup cables of ports 1 and 5 swapped: port 9 reaches port 5’s 5 cabinets, port 13 reaches port 1’s 10',
  'card 2: ONE error "Backup cables of ports 1 and 5 swapped: port 9 reaches port 5’s 5 cabinets, port 13 reaches port 1’s 10"', swp);
ok(gap.length === 0, 'no "mapped / answer" count warnings for the swapped pair', gap);
ok(c.alarmInfo(swp[0].text) && /Swap the two cables back/.test(c.alarmInfo(swp[0].text).suggestion), 'Monitor explains it: swap the two cables back, then Verify');
var on = function (port) { return h.cabinets.filter(function (x) { return x.card === 1 && x.port === port; }); };
ok(on(0).length === 10 && on(4).length === 5 && on(0).concat(on(4)).every(function (x) { return x.swapped && x.side === 'backup'; }),
  'the readings go where they came from: port 13\'s 10 on port 1\'s run, port 9\'s 5 on port 5\'s', [on(0).length, on(4).length]);
c.hlt.by.h9 = h;
var at = function (port, i) { return c.hltCabinet({ sender: 1, port: port, x: c.CELLS['1:' + port][i].x, y: c.CELLS['1:' + port][i].y }); };
var p1c8 = at(0, 7), p5c3 = at(4, 2);
ok(p1c8 && !p1c8.missing && p1c8.swapped, 'port 1 cabinet 8: its own reading (not "past the cable")', p1c8);
ok(p5c3 && !p5c3.missing && p5c3.swapped, 'port 5 cabinet 3: its own reading', p5c3);
ok(Object.keys(h.swapOf).length === 2 && h.swapOf['1:0'] === 4 && h.swapOf['1:4'] === 0, 'the swap is kept on the snapshot (1↔5)', h.swapOf);
// a temperature on what was read for port 5's index 7 is port 1's cabinet 8
c.hlt.held = {};
var rt = reply(); rt.cabinets.forEach(function (x) { if (x.card === 1 && x.port === 4 && x.index === 7) { x.temp = 70; x.tempStatus = 'warning'; } });
rt.events.push({ level: 'warning', card: 1, port: 4, index: 7, text: 'temperature 70.0 °C' });
var ht = c.hltNorm(c.P.devices[0], rt), te = ht.events.filter(function (e) { return /^temperature/.test(e.text); });
ok(te.length === 1 && te[0].port === 0 && te[0].index === 7, 'a cabinet event moves with its reading (port 5 #8 as read -> port 1 cabinet 8)', te);

// the same on the primaries (both ports up, cables crossed at the processor)
setup(c, { via: 'primary' });
c.hlt.held = {};
var hp = c.hltNorm(c.P.devices[0], reply({ card2: 'up' }));
var sp = hp.events.filter(function (e) { return /swapped/.test(e.text); });
ok(sp.length === 1 && sp[0].text === 'Cables of ports 1 and 5 swapped: port 1’s cable has port 5’s 5 cabinets, port 5’s has port 1’s 10', 'primary cables crossed: "Cables of ports 1 and 5 swapped: …"', sp);

// ------------------------------------------------------------------ layout vs cables: a plain count gap (port 1's backup has 5, port 5's has 5)
setup(c, { cable: { 0: 5, 1: 10, 2: 10, 3: 10, 4: 5 } });
c.hlt.held = {};
h = c.hltNorm(c.P.devices[0], reply());
gap = h.events.filter(function (e) { return /cabinets? mapped/.test(e.text); });
var g1 = gap.filter(function (e) { return e.card === 1 && e.port === 0; })[0];
ok(gap.length === 1 && g1 && g1.text === '10 cabinets mapped, 5 answer on its backup cable (port 9)' && g1.level === 'warning', 'card 2 port 1: "10 cabinets mapped, 5 answer on its backup cable (port 9)"', gap);
ok(!h.events.some(function (e) { return /swapped/.test(e.text); }), 'counts that don\'t cross over are not called a swap');
ok(c.alarmInfo(g1.text) && /which cable/.test(c.alarmInfo(g1.text).suggestion), 'Monitor explains the gap');
// the map: the mapped cabinets past the cable
c.hlt.by.h9 = h;
var past = at(0, 7), inside = at(0, 2);
ok(past && past.missing && past.beyond && past.det === 5, 'port 1 cabinet 8 (mapped, past the 5 on the cable): marked beyond the cable', past);
ok(inside && !inside.missing && inside.side === 'backup', 'port 1 cabinet 3: its reading', inside);
var st = c.hltState(past);
ok(st.cls === 'beyond' && /mapping has more cabinets than the cable/.test(st.text) && /5 answer/.test(st.text), 'drawn as "not answering — mapping has more cabinets than the cable", not a plain grey "no reading"', st);
ok(c.hltState({ missing: true }).cls === 'na', 'a cabinet with no reading for another reason stays "no reading"');
c.hlt.mapView = 'status';
var html = '';
vm.runInContext("function esc(s) { return String(s).replace(/[&<>\"]/g, function (ch) { return '&#' + ch.charCodeAt(0) + ';'; }); }" +
  "function tempFmt(t) { return t == null ? '—' : t.toFixed(1) + ' °C'; }", c);
c.P.lct = [{ id: 'l2', name: 'Screen 2' }]; c.P.screens = [{ id: 's2', screenId: 'l2' }];
c.allCells = function () {
  var out = [];
  Object.keys(MAPPED).forEach(function (p) { c.CELLS['1:' + p].forEach(function (q) { out.push({ k: 's2', x: q.x, y: q.y, w: 216, h: 216, sender: 1, port: +p }); }); });
  return { s2: out };
};
try { html = c.hltMapHtml(); } catch (e) { html = 'ERR ' + e.message; }
ok(html.indexOf('ERR') !== 0 && /5 not on the cable/.test(html) && /mapping has more cabinets than the cable/.test(html), 'the cabinet map: a "5 not on the cable" badge, the 5 cabinets explained', html.slice(0, 120));
ok(!/hm-break/.test(html), 'no break marks on card 2 (the fibre is down; nothing broke in the chains)');

// ------------------------------------------------------------------ the backup fibre
setup(c);
c.hlt.held = {};
var hb = c.hltNorm(c.P.devices[0], reply({ card2: 'bkdown' }));
var bk = hb.events.filter(function (e) { return /^OPT2 fiber/.test(e.text); });
ok(bk.length === 1 && bk[0].level === 'warning' && bk[0].text === 'OPT2 fiber: no link — no backup for ports 1–8' && bk[0].card === 1,
  'backup side: ONE warning "OPT2 fiber: no link — no backup for ports 1–8"', bk);
ok(!hb.events.some(function (e) { return e.card === 1 && /^redundancy lost/.test(e.text); }), 'no per-port "redundancy lost" left on card 2');
ok(hb.ports.filter(function (p) { return p.card === 1; }).every(function (p) { return p.backupOpt === 'OPT2'; }), 'card 2\'s ports know their backup fibre is down');

// ------------------------------------------------------------------ the card type from the project when the link didn't say
setup(c, { noSenders: true });
var hn = c.hltNorm(c.P.devices[0], reply());
ok(hn.events.filter(function (e) { return /^OPT1 fiber/.test(e.text); }).length === 1, 'card type from the project (h16) when the link reported no ModelIDs');

// ------------------------------------------------------------------ a card without fibre: per port, as before
setup(c);
c.P.devices[0].hw.senders = [0x7B48, 0x7B48, 0x7B48, 0x7B48]; c.P.processors.forEach(function (p) { p.type = 'h20'; });
var h20 = c.hltNorm(c.P.devices[0], reply());
ok(!h20.events.some(function (e) { return /fiber/.test(e.text); }) && h20.events.filter(function (e) { return e.card === 1 && /^primary port failed/.test(e.text); }).length === 5,
  'H 20-port (RJ45 only): five per-port events, no fibre wording');

console.log(fails ? fails + ' FAILED' : 'All passed');
process.exit(fails ? 1 : 0);
