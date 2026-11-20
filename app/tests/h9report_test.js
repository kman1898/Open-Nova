// node app/tests/h9report_test.js — what an H9 tester's report showed (2026-11-19): the supply-voltage limit (NovaLCT's 3.3 V,
// old saved 4.4 V moved over, a changed one kept), the voltage colour scale, and the H's MVR card (0x7B47) known but never a
// processor to add.
var vm = require('vm'), fs = require('fs'), path = require('path');
var fails = 0;
function ok(cond, text) { console.log((cond ? 'PASS ' : 'FAIL ') + text); if (!cond) fails++; }
function load(store) {
  var ctx = { console: console, Object: Object, JSON: JSON, Math: Math,
    localStorage: { getItem: function (k) { return k in store ? store[k] : null; }, setItem: function (k, v) { store[k] = String(v); }, removeItem: function (k) { delete store[k]; } } };
  vm.createContext(ctx);
  ['app-watch.js', 'app-heat.js', 'app-processors.js', 'app-online.js'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), ctx, { filename: f });
  });
  return ctx;
}

// ------------------------------------------------------------------ supply voltage limit
var c = load({});
c.watchLoad();
ok(c.watch.set.voltLow === 3.3, 'default low supply voltage = 3.3 V (NovaLCT\'s), not 4.4 V');
c.watch.set.voltLow = 4.0; c.watchSave();
var saved = JSON.parse(c.localStorage.getItem('opennova.watch'));
ok(saved.v === 2 && saved.voltLow === 4.0, 'saved with the settings version (2) and the value');

var old = load({ 'opennova.watch': JSON.stringify({ tempWarn: 70, tempErr: 80, voltLow: 4.4, unit: 'F', sound: false, notify: false }) });
old.watchLoad();
ok(old.watch.set.voltLow === 3.3 && old.watch.set.tempWarn === 70 && old.watch.set.unit === 'F', 'saved before version 2 with 4.4 V (the old default): 3.3 V now, the rest kept');
var chosen = load({ 'opennova.watch': JSON.stringify({ voltLow: 4.2 }) });
chosen.watchLoad();
ok(chosen.watch.set.voltLow === 4.2, 'an old setting that isn\'t the old default (4.2 V) is kept');
var v2 = load({ 'opennova.watch': JSON.stringify({ v: 2, voltLow: 4.4 }) });
v2.watchLoad();
ok(v2.watch.set.voltLow === 4.4, '4.4 V chosen after version 2 is kept');

// the limits applied to a reading: a 4.1 V ROE cabinet is fine, 3.1 V is low
var h = { cabinets: [{ card: 0, port: 0, index: 0, voltage: 4.1, voltStatus: 'ok', temp: 40, tempStatus: 'ok' },
  { card: 0, port: 0, index: 1, voltage: 3.1, voltStatus: 'ok', temp: 40, tempStatus: 'ok' }], events: [] };
c.watch.set.voltLow = 3.3; c.watchApply(h);
ok(h.cabinets[0].voltStatus === 'ok' && h.cabinets[1].voltStatus === 'warning' && h.events.length === 1 && /3\.10 V/.test(h.events[0].text),
  'a 4.1 V cabinet raises nothing; 3.1 V is flagged once');

// ------------------------------------------------------------------ voltage colour scale: the limit is on it, 4.1 V reads as normal
var sc = c.heatScale('volt', []);
ok(sc.lo <= 3.3 && sc.hi >= 5.0, 'voltage scale ' + sc.lo + '–' + sc.hi + ' V holds the 3.3 V limit and the 5 V nominal');
var at = function (v) { return (v - sc.lo) / (sc.hi - sc.lo); }, P = c.HEAT_PAL.volt;
var band = P.filter(function (s) { return s[1] === '#2a3646' || s[1] === '#30353d'; }).map(function (s) { return s[0]; });
ok(band.length === 2 && at(4.1) >= band[0] && at(4.1) <= band[1] && at(4.9) <= band[1], '4.1 V and 4.9 V fall in the neutral band of the palette');

// ------------------------------------------------------------------ the H's MVR card
ok(c.NON_LED_CARDS[0x7B47] && /MVR/.test(c.NON_LED_CARDS[0x7B47]), '0x7B47 is the H MVR card in the catalogue');
var mvr = { kind: 'lct', ip: '192.0.2.11', port: 5200, senders: [0x7B47], modelId: 0x7B47 };
ok(/MVR/.test(c.olNonLed(mvr)) && c.olNonLed({ kind: 'lct', senders: [0x7B46] }) === '' && c.olNonLed({ kind: 'lct', senders: [0x7B46, 0x7B47] }) === '',
  'olNonLed: only a link with nothing but non-LED cards');
c.P = { devices: [] };
var t = c.olTarget(mvr);
ok(t.nonLed && !t.unknown && !t.m && /MVR/.test(t.why), 'the MVR card is listed as known, but has nothing to add (not "unknown model")');

console.log(fails ? fails + ' FAILED' : 'All passed');
process.exit(fails ? 1 : 0);
