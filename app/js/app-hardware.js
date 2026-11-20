// app-hardware.js - the link to real processors, through the local helper (tools\novalink.py, which also
// runs tools\unicolink.py; http://127.0.0.1:8790): find processors on the network, link one to a
// processor of the project, detect the panels it sees on each port, and send the layout.
// Unico-family processors (VX Pro …) go over their REST API (tools\unicolink.py); NovaLCT-protocol ones (H series,
// MCTRL, VX …) over the TG frames (tools\novalink.py: UDP 3800 discovery, receiving-card probing per port,
// hwsend.js plans for Send). The processor's own cards are numbered 0… on its link, in the project's card order.
// Live detection: while a processor is linked (and the app is visible) the panels it sees are re-read every few seconds,
// like Unico and VMP, so panels plugged in or unplugged show up without pressing anything: Unico-family processors scan
// by themselves (they push "cabinet/info" 852224 with the changed ports), so we re-read their list; NovaLCT-protocol
// ones are re-checked cheaply by the helper (link bits + the end of each known chain, full walk only where it changed).
// The result lives in hw.live[device id] (hardware state, not project data: no undo step, not synced) as per card,
// per port [{w, h, name}] in cable order. The port list shows "placed / detected" and flags what doesn't match; the
// Hardware card lists detected groups (same panel, consecutive ports, same count) with Quick add (one column per port).
// A change is announced with a toast ("Card 1 port 3: 10 panels (+2)") and logged.
// How each kind of processor is reached lives in the drivers (drv-core.js + drv-lct / drv-unico / drv-coex / drv-offline);
// this file is the UI around them (design phase 3). The Hardware card has no Send button any more (user, 2026-10-11: send only
// from the header Send ▾, to all or to one — app-save.js); hwSend / hwSendAll stay here and are what Send ▾ calls.
// Owns: HW_BG_MS, hwBackground, hwErrText, hwForget, hwBegin, hwEnd, HW_BUSY_WORDS, hwWriting, HW_HELPER, hwLiveDiff, hwTick, hw, hwSenderName, hwPairs, hwPing, hwModelKey, hwDetectedOf, hwPortDetected,
// hwTileText, hwPortCells, hwTileProblem, hwGroups, hwPanelFor, hwQuickAdd, hwFind, hwLink, hwUnlink,
// hwSimulate, hwDetect, lctUuid, hwSendModel, hwSendCheck, hwSend, renderHwCard, bindHardware, hwWhere, hwLinkCards.
// Depends on: app-core (P, ui, $, uid, esc, fmt, toast, commit), app-log (log), app-processors
// (PROC_MODELS, procModel), app-devices (devSelected, cardsOfDevice is in app-processors),
// app-scr-io (toScrModel), app-capacity (portLabel), app-quickadd (qa, setQuickAdd),
// app-render (renderAll), app-backup (P.backup pairs), unicosend.js (UNICOSEND), hwsend.js (HWSEND), all at run time.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

var HW_HELPER = DRV.HELPER;   // same machine that serves the app (drv-core.js), so it works from other devices too
var hw = { helper: null, found: [], busy: '', last: '', live: {}, watch: {} };   // helper: null unknown / true / false

function hwPing() {
  return fetch(HW_HELPER + '/api/hw/ping').then(function (r) { return r.json(); })
    .then(function (j) { hw.helper = !!j.ok; }, function () { hw.helper = false; })
    .then(function () { var d = devSelected && devSelected(); if (d) renderHwCard(d); });
}

// Where a link goes, for people: "192.168.0.10:5200", "USB COM3" for a USB / serial link (host "serial:COM3", drv-lct.js),
// "USB 1-3" for NovaStar's own USB device (host "usb:0483:5720@1-3": libusb's bus-ports; "@libusb0-0001" = "USB 1", a device
// on NovaLCT's Windows driver, tools\novalink.py _Libusb0).
function hwWhere(host, port) {
  var s = String(host || '');
  if (s === 'simulated') return 'simulated';   // drv-offline.js
  if (s.indexOf('usb:') === 0) return ('USB ' + (s.split('@')[1] || '').replace(/^libusb0-0*(?=\d)/, '')).trim();
  s = s.indexOf('serial:') === 0 ? s : s.split('%')[0];   // "ip%Ethernet 3": the interface is shown on its own (app-network.js nwOf)
  if (/[+*]/.test(String(port))) return s;   // an H over several output-slot links ("5201+5202", drv-lct.js)
  return s.indexOf('serial:') === 0 ? 'USB ' + s.slice(7).split('@')[0].replace(/^\/dev\//, '') : s + ':' + port;
}
// A sending card's ModelID as a name: an H output card or a processor model (both are in the app's catalogue).
function hwSenderName(id) {
  var t = Object.keys(OUTPUT_CARDS).filter(function (k) { return OUTPUT_CARDS[k].modelId === id; })[0];
  if (t) return OUTPUT_CARDS[t].name;
  var k = hwModelKey(id); return k ? PROC_MODELS[k].name : 'ModelID 0x' + (id || 0).toString(16).toUpperCase();
}
// The project's port backup pairs inside processor d, renumbered to its own cards (0…): [{ps, pp, bs, bp}].
// Pairs that reach another processor can't be sent to this one: they come back in .cross.
function hwPairs(d) {
  var cards = cardsOfDevice(d), b = P.backup, out = []; out.cross = [];
  if (!b || b.mode !== 'port') return out;
  (b.pairs || []).forEach(function (q) {
    var a = cards.indexOf(q.ms), z = cards.indexOf(q.bs);
    if (a < 0 && z < 0) return;
    if (a < 0 || z < 0) { out.cross.push(portLabel(q.ms, q.mp) + ' → ' + portLabel(q.bs, q.bp)); return; }
    out.push({ ps: a, pp: q.mp, bs: z, bp: q.bp });
  });
  return out;
}
// What a NovaLCT link holds, for people: an H's output cards ("2 output cards: H 16-port (RJ45) ×2"), else the model(s).
function hwLinkCards(S) {
  S = S || []; if (!S.length) return 'no card answered';
  if (S.some(olHCard)) return S.length + ' output card' + (S.length === 1 ? '' : 's');
  return S.map(hwSenderName).join(' + ');
}
// A link error for people (UI cleanup item 8), used by the Hardware card, Monitor and the pre-show check: an OS / network
// error ("[WinError 10061] No connection could be made …", "<urlopen error …>", timed out, refused) is "Not answering";
// anything else as it came. The raw text stays in the tooltip and the logs.
function hwErrText(e) {
  var t = String(e || '');
  if (/WinError|Errno|urlopen error|refused|timed? ?out|unreachable|No route|ECONN|EHOST|ETIMEDOUT|ENETUNREACH|getaddrinfo|reset by peer|forcibly closed|no response|not answering/i.test(t)) return 'Not answering';
  if (/^helper:|Failed to fetch|NetworkError/i.test(t)) return 'Open Nova’s helper isn’t answering';
  return t;
}
function hwModelKey(modelId) {
  return Object.keys(PROC_MODELS).filter(function (k) { return PROC_MODELS[k].modelId === modelId; })[0] || null;
}

// ------------------------------------------------------------------ detected panels
// d.hw.detected = { at, cards: [ { ports: { <port>: [ {w, h, name}, … in cable order ] } } ] } (cards in the
// processor's own order). hwDetectedOf(card) = that card's ports, by global sending-card index.
function hwDetectedOf(card) {
  var d = P.devices.filter(function (x) { return cardsOfDevice(x).indexOf(card) >= 0; })[0];
  var lv = d && d.hw && hw.live[d.id];
  if (!lv) return null;
  var c = lv.cards[cardsOfDevice(d).indexOf(card)];
  return c ? c.ports : null;
}
function hwPortDetected(card, port) { var ps = hwDetectedOf(card); return ps ? (ps[port] || []) : null; }
// "3/8" on a port tile once detected (placed / detected), "3/-" before.
function hwTileText(card, port, used) { var det = hwPortDetected(card, port); return used + '/' + (det ? det.length : '-'); }
// The project's panels per port in cable order, as the export merges them (toScrModel), cached until the next edit.
function hwPortCells() {
  if (hw.cellsSnap === ui.lastSnap && hw.cells) return hw.cells;
  var by = {};
  try {
    toScrModel().screens.forEach(function (s) {
      (s.cells || s.regions || []).forEach(function (c) { if (c.sender !== 255) (by[c.sender + ':' + c.port] || (by[c.sender + ':' + c.port] = [])).push(c); });
    });
  } catch (e) { by = {}; }
  Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return a.connect - b.connect; }); });
  hw.cells = by; hw.cellsSnap = ui.lastSnap;
  return by;
}
// What's wrong on a port compared with the detection, or '' (more panels placed than detected, or other sizes).
function hwTileProblem(card, port) {
  var det = hwPortDetected(card, port), cells = det ? (hwPortCells()[card + ':' + port] || []) : [];
  if (!det || !cells.length) return '';
  var sw = typeof hltSwapOf === 'function' ? hltSwapOf(card, port) : null;   // its cable and another port's go to each other's runs
  if (sw) return (sw.backup ? 'backup cable' : 'cable') + ' swapped with ' + portLabel(card, sw.port) + '’s';
  if (cells.length > det.length) return cells.length + ' cabinets placed, ' + det.length + ' detected';
  var bad = cells.filter(function (c, i) { var x = det[i]; return x && (x.w !== c.width || x.h !== c.height); });
  if (bad.length) { var c = bad[0], i = cells.indexOf(c), x = det[i];
    return bad.length + ' cabinet(s) differ in size from the detected ones (cable position ' + (i + 1) + ': ' + c.width + '×' + c.height + ' placed, ' + x.w + '×' + x.h + ' detected)'; }
  return '';
}
// Detected groups for Quick add: consecutive ports with the same panel size and the same count.
function hwGroups(d) {
  var out = [], dt = d.hw && hw.live[d.id];
  if (!dt) return out;
  cardsOfDevice(d).forEach(function (card, ci) {
    var ports = (dt.cards[ci] || {}).ports || {}, cur = null;
    Object.keys(ports).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
      var list = ports[p]; if (!list.length) { cur = null; return; }
      var f = list[0], same = list.every(function (x) { return x.w === f.w && x.h === f.h; });
      var k = same ? f.w + 'x' + f.h + '|' + list.length + '|' + f.name : null;
      if (cur && k && cur.k === k && p === cur.last + 1) { cur.last = p; cur.ports++; return; }
      cur = k ? { k: k, card: card, first: p, last: p, ports: 1, rows: list.length, w: f.w, h: f.h, name: f.name } : null;
      if (cur) out.push(cur);
      else out.push({ card: card, first: p, last: p, ports: 1, rows: list.length, mixed: true, name: f.name });
    });
  });
  return out;
}
function hwPanelFor(g) {
  var pn = P.panels.filter(function (p) { return p.w === g.w && p.h === g.h; })[0];
  if (!pn) { pn = { id: uid(), name: (g.name || 'Cabinet') + ' ' + g.w + '×' + g.h, w: g.w, h: g.h }; P.panels.push(pn); commit(); log('hw_panel_type_added', { name: pn.name }); }
  return pn;
}
// Start Quick add with a detected group: its panel, from its first port, one column per port, its count per column.
function hwQuickAdd(g) {
  if (g.mixed) return toast('Port ' + (g.first + 1) + ' has cabinets of different sizes — place them with Manual or Self draw');
  var pn = hwPanelFor(g);
  ui.drawPanelId = pn.id; ui.mSender = g.card; ui.mPort = g.first;
  lctShowFor(g.card);   // on a screen of that processor (a screen belongs to one processor, app-sections.js)
  if (typeof setTab === 'function') setTab('layout');
  setQuickAdd(true, 'detected cabinets');
  qa.opts.dir = 'V'; qa.preset = { cols: g.ports, rows: g.rows };
  log('hw_quick_add_detected', { ports: portLabel(g.card, g.first) + (g.ports > 1 ? ' – ' + portLabel(g.card, g.last) : ''), panel: pn.name, size: g.ports + '×' + g.rows });
  toast('Click where the wall goes: ' + g.ports + ' column' + (g.ports > 1 ? 's' : '') + ' × ' + g.rows + ' ' + pn.name + ', one port per column from ' + portLabel(g.card, g.first));
  renderAll();
}

// ------------------------------------------------------------------ actions
// One processor operation at a time (Find, Detect now, Send, Save, a receiving-card file): another is refused while one
// runs, and only the one that started clears the flag — so monitoring never restarts in the middle of another. The "not
// saved" bar's Save follows the flag at once (greyed with the reason while busy; app-save.js renderUnsaved).
function hwBegin(what) {
  if (hw.busy) { toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running'); return false; }
  hw.busy = what; if (typeof dgMark === 'function') dgMark('App: ' + (HW_BUSY_WORDS[what] || what) + ' started');   // a note in the recording (app-diag.js)
  if (typeof renderUnsaved === 'function') renderUnsaved();
  return true;
}
function hwEnd(what) {
  if (hw.busy !== what) return;
  hw.busy = ''; if (typeof dgMark === 'function') dgMark('App: ' + (HW_BUSY_WORDS[what] || what) + ' finished');
  if (typeof renderUnsaved === 'function') renderUnsaved();
}
var HW_BUSY_WORDS = { find: 'the search', detect: 'a detection', send: 'a send', dry: 'a dry run', save: 'a save', service: 'a restart / reset' };
// Background reads (live detect, health) pause while something writes to the processors.
function hwWriting() { return hw.busy === 'send' || hw.busy === 'save' || hw.busy === 'service'; }   // background reads wait (a restart reads as "no panels")
function hwFind() {
  if (!hwBegin('find')) return; renderHwCard(devSelected());
  return DRV.discoverAll({ timeout: 2 }).then(function (found) {
    if (found.failed && found.failed === found.tried) hw.helper = false;
    hw.found = found;
    log('hw_find', { found: hw.found.map(function (x) { return x.deviceName + ' ' + x.ip + ':' + x.port + ' (' + x.kind + ')'; }) });
  }).then(function () { hwEnd('find'); renderHwCard(devSelected()); });
}
// Forget everything read from processor d's old link: detection, health (canvas colours, map, events in progress),
// device info. The generation makes a detect / health read that was still running for the old link drop its answer.
function hwForget(d) {
  delete hw.live[d.id]; delete hw.watch[d.id]; if (hw.info) delete hw.info[d.id];
  hw.gen = hw.gen || {}; hw.gen[d.id] = (hw.gen[d.id] || 0) + 1;
  if (typeof hlt !== 'undefined') { delete hlt.by[d.id]; delete hlt.watch[d.id]; Object.keys(hlt.seen).forEach(function (k) { if (k.indexOf(d.id + '|') === 0) delete hlt.seen[k]; }); }
}
// Background search (design P10): every minute while nothing else runs, in an online project (app-online.js olMode) or one
// with a linked processor — a linked one that stops answering discovery is noted, and an IP conflict (two devices answering
// from one address: Unico by serial number, COEX by MAC) is flagged. Nothing found is added by itself (user, 2026-10-11:
// found processors are offered in Add processor, online mode).
var HW_BG_MS = 60000;
function hwBackground() {
  if (document.hidden || hw.busy || hw.helper === false || hw.bgBusy) return;
  if (typeof olMode === 'function' && olMode() !== 'online' && !(P.devices || []).some(function (d) { return d.hw && d.hw.kind !== 'offline'; })) return;   // offline: no searching
  if (hw.bgAt && Date.now() - hw.bgAt < HW_BG_MS) return;
  hw.bgBusy = true; hw.bgAt = Date.now();
  DRV.discoverAll({ timeout: 2, background: true }).then(function (found) {
    if (hw.busy) return;   // something started meanwhile: don't touch the list under it
    var before = (hw.conflicts || []).join('|');
    hw.found = found; hw.searched = true;
    hw.conflicts = found.filter(function (x) { return x.conflict; }).map(function (x) { return x.conflict; }).filter(function (c, i, a) { return a.indexOf(c) === i; });
    hw.seen = hw.seen || {};
    (P.devices || []).forEach(function (d) {
      if (!d.hw || d.hw.kind === 'offline') return;
      hw.seen[d.id] = found.some(function (x) { return x.ip === d.hw.host && (x.port === d.hw.port || x.kind === 'lct'); });
    });
    if (hw.conflicts.length && hw.conflicts.join('|') !== before) { toast('⚠ ' + hw.conflicts[0]); log('ip_conflict', { conflicts: hw.conflicts }); }
    renderHwCard(devSelected());
    if (typeof devPick !== 'undefined' && devPick.open) devRenderPicker();   // the online list (app-devices.js)
  }, function () { /* helper away: hwPing reports it */ }).then(function () { hw.bgBusy = false; });
}
// Link processor d to a simulated one (drv-offline.js): no hardware; it "detects" what the project places.
function hwSimulate(d) {
  if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running');
  d.hw = { kind: 'offline', host: 'simulated', port: 0, sn: '', name: 'Simulated ' + procModel(d.model).name, modelId: procModel(d.model).modelId, senders: [] };
  log('hw_simulate', { processor: d.name });
  hwForget(d);
  commit(); renderAll(); hwDetect(d, false);
}
function hwLink(d, x) {
  if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running');
  var key = hwModelKey(x.modelId), m = procModel(d.model), n = cardsOfDevice(d).length, set = '';
  if (procUnset(d)) {   // "Pick a model": what the device reports is the model (app-online.js; live 2026-10-11: a VX1000 on USB linked as 40 ports)
    var om = olModel(x), before = deviceLabel(d);
    if (!om) return toast((x.deviceName || 'That processor') + ': its model isn’t in the catalogue — pick the model in Processor properties first');
    var r = olFit(d, om);
    if (r.err) { log('hw_link', { processor: before, to: x.deviceName, refused: r.err }); return toast('Can’t link it as ' + procModel(om.key).name + ': ' + r.err); }
    set = procModel(om.key).name;
  } else {
    if ((x.kind === 'unico' || x.kind === 'coex') && key && key !== d.model && !confirm('The processor found is a ' + PROC_MODELS[key].name + ', this one is set as ' + m.name + '. Link it anyway?')) return;
    if (x.kind === 'lct' && x.senders && x.senders.length && x.senders.length < n &&
        !confirm('That link has ' + x.senders.length + ' card(s); ' + deviceLabel(d) + ' has ' + n + ' in the project. Link it anyway?')) return;
  }
  olLinkHw(d, x);   // an H's chassis from its web API comes along (x.web, drv-lct.js discover)
  log('hw_link', { processor: d.name, to: x.deviceName + ' ' + hwWhere(x.ip, x.port), sn: x.SN, model_set: set || undefined });
  commit(); renderAll(); hwDetect(d, false);
  if (set) toast('Linked ' + deviceLabel(d) + ' — model set to ' + set + ' from the processor');
  if (olIsH(d) && !d.hw.web) olWebRefresh(d);   // H: name the chassis when a login is saved (app-online.js)
  if (typeof rbAuto === 'function') { rb.asked[d.id] = 0; setTimeout(function () { rbAuto(d); }, 1500); }   // read its layout (app-readback.js)
  if (typeof olAfterLink === 'function') { var pj = P; setTimeout(function () { if (P === pj) olAfterLink(); }, 0); }   // offline, all linked: offer online (app-online.js)
}
function hwUnlink(d) { if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running'); log('hw_unlink', { processor: d.name }); if (hw.applied) liveSet(d, undefined); hwForget(d); delete d.hw; if (hw.unsaved) { delete hw.unsaved[d.id]; hwUnsavedStore(); } commit(); renderAll(); renderUnsaved(); }

// What changed between two detections, as short texts ("Card 1 port 3: 10 panels (+2)").
function hwLiveDiff(d, a, b) {
  var out = [], cards = cardsOfDevice(d);
  b.forEach(function (c, ci) {
    var pa = ((a || [])[ci] || {}).ports || {}, pb = c.ports || {}, keys = {};
    Object.keys(pa).concat(Object.keys(pb)).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).map(Number).sort(function (x, y) { return x - y; }).forEach(function (p) {
      var x = pa[p] || [], y = pb[p] || [];
      if (x.length === y.length && x.every(function (q, i) { return q.w === y[i].w && q.h === y[i].h; })) return;
      out.push((cards.length > 1 ? 'Card ' + (cards[ci] + 1) + ' p' : 'P') + 'ort ' + (p + 1) + ': ' + (y.length ? y.length + ' cabinet' + (y.length === 1 ? '' : 's') : 'nothing') +
        (y.length !== x.length ? ' (' + (y.length > x.length ? '+' : '') + (y.length - x.length) + ')' : ' (sizes changed)'));
    });
  });
  return out;
}
// One detection of processor d. auto = a live re-check (quiet unless something changed; the helper re-walks only what
// changed); otherwise "Detect now" (Unico: rescan first).
function hwDetect(d, auto) {
  if (!d.hw) return;
  var w = hw.watch[d.id] || (hw.watch[d.id] = {});
  if (w.inflight) return;
  if (!auto && !hwBegin('detect')) return;
  w.inflight = true;
  if (!auto) renderHwCard(d);
  var prev = hw.live[d.id], known = null, wasErr = !!w.err;
  if (auto && prev) {
    known = {}; prev.cards.forEach(function (c, i) { Object.keys(c.ports).forEach(function (p) { known[i + ':' + p] = c.ports[p]; }); });
  }
  var gen = (hw.gen || {})[d.id] || 0;
  var req = DRV.of(d).detect(d, { auto: !!auto, known: known, pairs: hwPairs(d) }).then(function (r) {   // drv-*.js
    if (gen !== ((hw.gen || {})[d.id] || 0) || !d.hw) throw new Error('the link changed while detecting');
    if (r.busy && auto) return null;   // the helper's link is held by a Send / Save: skip this live check quietly
    if (!r.ok) throw new Error(r.error || 'detect failed');
    return r.cards;
  });
  return req.then(function (cards) {
    if (!cards) return;
    var n = 0, np = 0;
    cards.forEach(function (c) { Object.keys(c.ports).forEach(function (p) { if (c.ports[p].length) { np++; n += c.ports[p].length; } }); });
    var diff = prev ? hwLiveDiff(d, prev.cards, cards) : null;
    hw.live[d.id] = { at: Date.now(), cards: cards, panels: n, ports: np };
    w.err = '';
    if (!auto || !prev || diff.length) {
      log('hw_detect', { processor: d.name, kind: d.hw.kind, live: !!auto, ports: np, panels: n, changes: diff || undefined,
        errors: cards.filter(function (c) { return c.error; }).map(function (c) { return c.error; }) });
      if (diff && diff.length) toast(deviceLabel(d) + ': ' + diff.slice(0, 3).join(' · ') + (diff.length > 3 ? ' · +' + (diff.length - 3) + ' more' : ''));
      else if (!auto) toast('Detected ' + n + ' cabinets on ' + np + ' ports of ' + deviceLabel(d));
      renderAll();
    } else renderHwCard(devSelected());
  }).catch(function (e) {
    if (!auto) toast('Detect failed: ' + e.message);
    if (w.err !== e.message) log('hw_detect', { processor: d.name, live: !!auto, error: e.message });
    w.err = e.message; renderHwCard(devSelected());
  }).then(function () {
    w.inflight = false; w.done = Date.now(); if (!auto) { hwEnd('detect'); renderHwCard(devSelected()); }
    if (wasErr !== !!w.err) renderUnsaved();   // it stopped or started answering: the "not saved" bar follows
  });
}
// Every second: re-check each linked processor whose live check is due (app visible, its Live switch on, no send running).
function hwTick() {
  if (document.hidden || hwWriting()) return;
  (P.devices || []).forEach(function (d) {
    if (!d.hw || d.hw.live === false || !DRV.caps(d).live || (hw.helper === false && d.hw.kind !== 'offline')) return;   // simulated: no helper needed
    if (typeof olPolls === 'function' && !olPolls(d)) return;   // online, not connected: not asked until a search finds it (app-online.js)
    var w = hw.watch[d.id] || (hw.watch[d.id] = {}), gap = DRV.of(d).liveMs || 4000;
    if (w.inflight || (w.done && Date.now() - w.done < (w.err ? gap * 3 : gap))) return;
    hwDetect(d, true);
  });
}

// NSSD UUID of screen lc sent to processor d: fixed per screen and processor (NovaLCT keeps a screen's UUID too), so a
// read-back finds the screen it came from (app-readback.js); a screen given to another processor gets a new one there.
function lctUuid(lc, d) {
  function fnv(s) { var x = 0x811c9dc5; for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; } return x; }
  var h = '';
  for (var i = 0; i < 4; i++) h += ('0000000' + fnv(i + ':' + lc.id).toString(16)).slice(-8);
  h = h.slice(0, 12) + '4' + h.slice(13, 16) + ((parseInt(h[16], 16) & 3) | 8).toString(16) + h.slice(17, 28) + ('000' + (fnv((d ? d.id : '') + '/' + lc.id) & 0xffff).toString(16)).slice(-4);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
// The layout for one processor: its screens (NovaLCT's Screen 1, 2 … of that processor, in the project's order: the
// screens without its cabinets are left out) with their cells, cards renumbered 0… Each screen carries its NSSD UUID and
// (not enumerable: the live-apply fingerprint, liveKey, ignores a rename) its project screen, lcId / name.
// A screen belongs to one processor and goes as it is (NovaLCT's own screen: blank rows / columns at its edges included,
// so its origin, size and output window match NovaLCT's Send of it); nothing is cropped. A screen still holding another
// processor's cabinets is refused before Send (hwSendCheck); here they would be Blank (sender 255 = NovaLCT's DevID 255)
// in a Standard screen and left out of a Complex one. The screen's own fields go along: NovaLCT can't read a layout record
// back without ScrX / ScrY / CabinetCol / CabinetRow.
function hwSendModel(d) {
  var cards = cardsOfDevice(d), m = toScrModel(), BLANK = 255;
  // toScrModel leaves out the screens without sections: the same list of screen tabs
  var lcs = P.lct.filter(function (lc) { return P.screens.some(function (s) { return s.screenId === lc.id; }); });
  return { screens: m.screens.map(function (s, si) {
    var all = s.cells || s.regions || [], mine = function (c) { return cards.indexOf(c.sender) >= 0; };
    var o = {}; for (var k in s) if (k !== 'cells' && k !== 'regions') o[k] = s[k];
    var lc = lcs[si], own = all.filter(mine);
    if (lc) { o.uuid = lctUuid(lc, d); Object.defineProperties(o, { lcId: { value: lc.id }, name: { value: lc.name } }); }
    if (!own.length) { o.cells = []; return o; }
    var copy = function (c, blank) { var x = {}; for (var k in c) x[k] = c[k]; x.sender = blank ? BLANK : cards.indexOf(c.sender); return x; };
    o.cells = s.cells ? all.map(function (c) { return copy(c, !mine(c)); }) : own.map(function (c) { return copy(c); });   // Complex: real cabinets only
    return o;
  }).filter(function (s) { return s.cells.length; }) };
}
// Why processor d can't be sent now (null = it can): one of its screens has another processor's cabinets too (a project
// edited before the rule; a load splits them, so this is a last guard).
function hwSendCheck(d) {
  var bad = lctMixed().filter(function (x) { return x.devs.some(function (y) { return y.id === d.id; }); }), other = [];
  bad.forEach(function (x) { x.devs.forEach(function (y) { if (y.id !== d.id && other.indexOf(y) < 0) other.push(y); }); });
  return bad.length ? bad.map(function (x) { return x.lc.name; }).join(', ') + ' also ' + (bad.length === 1 ? 'has' : 'have') + ' cabinets on ' + other.map(deviceLabel).join(', ') +
    ': a screen belongs to one processor — move those cabinets to a screen of their own (right-click ▸ Move cabinets to ▸ New screen)' : null;
}
// opts.plan / opts.noConfirm: hwSendAll has already planned and asked once for every processor
function hwSend(d, dry, opts) {
  opts = opts || {};
  if (!d.hw) return Promise.resolve(false);
  if (procUnset(d)) { toast('Pick the model of ' + deviceLabel(d) + ' first (Device ▸ Processor properties) — nothing was sent'); return Promise.resolve(false); }
  var why = hwSendCheck(d); if (why) { toast('Send stopped: ' + why); return Promise.resolve(false); }
  var pairs = hwPairs(d);
  if (pairs.cross.length) { toast('Send: port backup pairs reach another processor (' + pairs.cross.slice(0, 3).join(', ') + ') — a processor can only back up its own ports'); return Promise.resolve(false); }
  var drv = DRV.of(d), plan = opts.plan || drv.planSend(d, { dry: !!dry, pairs: pairs });   // drv-*.js
  if (!plan.ok) { toast(plan.plain ? plan.error : 'Send: ' + plan.error); return Promise.resolve(false); }
  if (hw.busy) { toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running'); return Promise.resolve(false); }
  if (!dry && !opts.noConfirm && plan.confirm && !confirm(plan.confirm)) return Promise.resolve(false);
  if (!hwBegin(dry ? 'dry' : 'send')) return Promise.resolve(false); renderHwCard(d);
  var okSent = false;
  return drv.send(d, plan, !!dry).then(function (r) {
    okSent = !!r.ok;
    hw.last = r.text + ((r.warnings || []).length ? '\n' + r.warnings.join('\n') : '');
    log('hw_send', { processor: d.name, kind: d.hw.kind, dry: !!dry, ok: r.ok, panels: plan.count, pairs: plan.pairs, frames: r.frames, warnings: r.warnings, error: r.error, log: r.log });
    if (r.ok && !dry) { var lk = liveKey(d); if (lk) liveSet(d, lk); hwMarkUnsaved(d, 'sent'); }   // app-save.js
    toast(hw.last.split('\n')[0] + ((r.warnings || []).length ? ' — ' + r.warnings.length + ' warning(s), see the Hardware card' : ''));
  }, function (e) { hw.helper = false; hw.last = 'Helper not reachable: ' + e.message; })
    .then(function () { hwEnd(dry ? 'dry' : 'send'); renderHwCard(d); return okSent; });
}
// Send to every linked processor of the project (user, 2026-10-11: "a send to all in project or individual processors"):
// all are planned first — one that can't be sent stops it before anything goes out — then one confirmation, then one
// after another. Never followed by a Save.
// only = [processor] (the pro look's Send tile: the processor shown, or the ones picked together): the same, for those.
function hwSendAll(only) {
  only = Array.isArray(only) ? only : null;
  var linked = (only || (typeof olShownDevices === 'function' ? olShownDevices() : P.devices) || []).filter(function (d) { return d.hw; });   // online: the connected ones (app-online.js)
  if (!linked.length) return toast('No processor linked — Device ▸ Hardware');
  var unset = linked.filter(procUnset);
  if (unset.length) return toast((only ? 'Send' : 'Send to all') + ' stopped — pick the model of ' + unset.map(deviceLabel).join(', ') + ' first (Device ▸ Processor properties)');
  if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running');
  var plans = linked.map(function (d) {
    var pairs = hwPairs(d), why = hwSendCheck(d);
    if (why) return { d: d, err: why };
    if (pairs.cross.length) return { d: d, err: 'port backup pairs reach another processor' };
    var p = DRV.of(d).planSend(d, { dry: false, pairs: pairs });
    return p.ok ? { d: d, plan: p } : { d: d, err: p.error };
  });
  var bad = plans.filter(function (x) { return x.err; });
  if (bad.length) return toast((only ? 'Send' : 'Send to all') + ' stopped — nothing sent: ' + bad.map(function (x) { return deviceLabel(x.d) + ': ' + x.err; }).join(' · '));
  if (!confirm((only ? 'Send the layout to ' + plans.map(function (x) { return deviceLabel(x.d); }).join(', ') + '?' : 'Send the layout to all ' + plans.length + ' processors of this project?') + '\n\n' +
      plans.map(function (x) { return '• ' + deviceLabel(x.d) + ' (' + x.d.hw.host + '): ' + (x.plan.count || 0) + ' cabinets' + (x.plan.pairs ? ', ' + x.plan.pairs + ' backup pairs' : '') +
        ((x.plan.screens || []).length > 1 ? '; its ' + x.plan.screens.length + ' screens together, in this order: ' + x.plan.screens.join(' · ') : ''); }).join('\n') +   // (drv-lct.js: all of its screens in one Send)
      '\n\nEach one replaces that processor’s layout. Nothing is saved afterwards: press Save when the wall looks right.')) return;
  log('hw_send_all', { processors: plans.map(function (x) { return deviceLabel(x.d); }) });
  var done = [];
  return plans.reduce(function (p, x) {
    return p.then(function () { return hwSend(x.d, false, { plan: x.plan, noConfirm: true }).then(function (ok) { done.push(deviceLabel(x.d) + (ok ? ' ✓' : ' ✗')); }); });
  }, Promise.resolve()).then(function () { toast((only ? 'Send: ' : 'Send to all: ') + done.join(' · ')); });
}

// ------------------------------------------------------------------ the Hardware card (processor properties)
function renderHwCard(d) {
  var box = $('dvHwBody'); if (!box || !d) return;
  var caps = DRV.caps(d), sim = d.hw && d.hw.kind === 'offline', h = '', busy = hw.busy;
  if (!d.hw && !DRV.families[DRV.familyOf(d)].discover) {   // no link for this kind yet (MX: design phase 7)
    box.innerHTML = '<p class="hint">Can’t be linked yet' + itip('Plan and export this processor now. Finding and linking it on the network comes in a later phase.') + '</p>' +
      '<div class="row"><button data-hw="simulate" title="Try the app with a simulated processor: no hardware, it detects what the project places">Simulate</button></div>';
    return;
  }
  if (hw.helper === false && !sim) h += '<p class="hint">The local helper isn’t running. Start <b>tools\\novalink.py serve</b> (launch config “novalink”) on this computer, then <button class="mini" data-hw="ping">Retry</button></p>';
  if (d.hw) {
    h += '<p class="hw-link"><b>' + esc(d.hw.name) + '</b>' + (sim ? itip('No hardware: it detects what the project places, and Send only checks the layout.') : ' · ' + esc(hwWhere(d.hw.host, d.hw.port)) + (typeof nwOf === 'function' && nwOf(d.hw) ? ' · ' + esc(nwShort(nwOf(d.hw))) : '') + '<br><span class="hint">' +
        (d.hw.kind === 'unico' || d.hw.kind === 'coex' ? 'SN ' + esc(d.hw.sn || '-') : hwLinkCards(d.hw.senders)) + '</span>') + '</p>' +
      '<div class="row">' + (caps.live ? '<label class="chk" title="Keep checking which cabinets the processor sees, every few seconds while the app is open (cabinets plugged in or unplugged show up by themselves)">' +
      '<input type="checkbox" data-hw="live"' + (d.hw.live === false ? '' : ' checked') + '> Live</label>' : '') +
      '<button data-hw="detect"' + (busy ? ' disabled' : '') + ' title="Check now (some processors rescan their ports first)">' + (busy === 'detect' ? 'Detecting…' : 'Detect now') + '</button>' +
      // ("Dry run" / "Check without sending" was removed 2026-10-11: Send runs the same checks before writing anything;
      // "Send layout" left this card 2026-10-11: the header Send ▾ sends to all or to one)
      (busy === 'send' ? '<span class="hint">Sending…</span>' : '') +
      (sim && typeof olMode === 'function' && olMode() === 'offline' ? '' : '<button class="mini" data-hw="unlink" title="Forget the link">×</button>') + '</div>' +   // offline: always simulated
      '<div class="row"><button data-hw="compare" title="Project vs what the processor has / detects, port by port">Compare</button>' +
      (caps.readLayout ? '<button data-hw="readlayout" title="Replace what the project has on this processor with the layout it holds (Ctrl+Z undoes it)">Read layout</button>' : '') +
      (caps.save ? '<button data-hw="save"' + (busy ? ' disabled' : '') + ' title="Store the settings in the processor’s flash (asks first). Never part of Send.">' + (hw.unsaved && hw.unsaved[d.id] ? 'Save ●' : 'Save') + '</button>' : '') +
      (caps.applyMode === 'live' && !sim ? '<label class="chk" title="Apply each edit to this processor a moment after you make it, as its own app does"><input type="checkbox" data-hw="liveapply"' + (d.hw.liveApply === false ? '' : ' checked') + '> Apply edits live</label>' : '') + '</div>';
    var hz = String(d.hw.host).split('%'), cf = !sim && (hw.conflicts || []).filter(function (c) { return c.indexOf(' ' + hz[0] + ' ') >= 0; })[0];
    if (cf) h += '<p class="rcv-bad">⚠ ' + esc(cf) + (hz[1] ? '. This one is linked through ' + esc(nwShort(hz[1])) + '.' : '. Commands may reach the wrong one — give each processor its own IP address' +
      (/Two networks/.test(cf) ? ', or link it again from the list to bind it to its network' : '') + '.') + '</p>';
    else if (!sim && hw.seen && hw.seen[d.id] === false) h += '<p class="hint">⚠ Not seen in the last network search (' + new Date(hw.bgAt).toLocaleTimeString() + ') — is it on and on this network?</p>';
    if (!sim && typeof adoptHtml === 'function') h += adoptHtml(d);   // the processor is another model / has other cards (app-adopt.js)
    if (hw.last) h += '<pre class="hw-out">' + esc(hw.last) + '</pre>';
    // Device info (read-only, on demand): identity, firmware, cards, inputs with their signal
    var di = hw.info && hw.info[d.id];
    var hl = !sim && olIsH(d), hs = hl && hw.hweb && hw.hweb[d.hw.host];
    h += '<div class="row"><button class="mini" data-hw="info" title="Read the processor’s identity, firmware, cards and inputs (read-only)">' + (di && di.busy ? 'Reading…' : di ? 'Refresh device info' : 'Device info') + '</button>' +
      (hl ? '<button class="mini" data-hw="hlogin" title="The login of the H’s own web page: Open Nova reads the chassis model and output cards with it. Kept on this computer only, sent only to this H.' +
        (d.hw.web ? ' Read: ' + esc(hwSenderName(d.hw.web.modelId)) + (d.hw.web.sw ? ', firmware ' + esc(d.hw.web.sw) : '') : '') + '">H login' + (d.hw.web || (hs && hs.login) ? ' ✓' : '…') + '</button>' : '') + '</div>';
    var mid = d.hw.modelId != null ? d.hw.modelId : procModel(d.model).modelId;   // ModelID moved here from Processor properties (UI cleanup item 6)
    if (di && di.r) h += di.r.ok ? '<table class="hw-info">' + (mid != null ? [['ModelID', '0x' + Number(mid).toString(16).toUpperCase()]] : []).concat(typeof nwInfoRow === 'function' ? nwInfoRow(d) : [], di.r.rows).map(function (x) { return '<tr><th>' + esc(x[0]) + '</th><td>' + esc(x[1]) + '</td></tr>'; }).join('') +
      (di.r.inputs.length ? '<tr><th>Inputs</th><td>' + di.r.inputs.map(function (x) { return '<span class="' + (x.signal ? '' : 'hint') + '">' + esc(x.name) + ': ' + esc(x.text) + '</span>'; }).join('<br>') + '</td></tr>' : '') + '</table>'
      : '<p class="hint" title="' + esc(di.r.error) + '">⚠ ' + esc(hwErrText(di.r.error)) + '</p>';
    // (Service — restart / factory reset — is in the folded Service section under this card: app-devices.js)
    var dt = hw.live[d.id], wt = hw.watch[d.id] || {};
    if (wt.err) h += '<p class="hint" title="' + esc(wt.err) + '">⚠ ' + esc(hwErrText(wt.err)) + (d.hw.live === false ? '' : ' — retrying') + '</p>';
    if (dt) {
      var gs = hwGroups(d), ago = Math.round((Date.now() - dt.at) / 1000);
      h += '<div class="sub-h">Detected: ' + dt.panels + ' cabinets on ' + dt.ports + ' ports · ' + (d.hw.live === false ? 'checked ' : 'live · ') + (ago < 2 ? 'just now' : ago + ' s ago') + '</div>' +
        (gs.length ? '' : '<p class="hint">No cabinets detected.</p>');
      gs.forEach(function (g, i) {
        h += '<div class="hw-grp"><span>' + (cardsOfDevice(d).length > 1 ? 'Card ' + (g.card + 1) + ' · ' : '') + (g.ports > 1 ? 'Ports ' + (g.first + 1) + '–' + (g.last + 1) : 'Port ' + (g.first + 1)) + ': ' +
          (g.mixed ? g.rows + ' cabinets, mixed sizes' : (g.ports > 1 ? g.rows + ' each · ' : g.rows + ' · ') + g.w + '×' + g.h) +
          (g.name ? ' <span class="hint">' + esc(g.name) + '</span>' : '') + '</span>' +
          '<button class="mini" data-hw="qa" data-g="' + i + '"' + (g.mixed ? ' disabled' : '') + ' title="Quick add these cabinets: one column per port">Quick add</button></div>';
      });
    }
  }
  if (!d.hw || sim) {   // a simulated one can still be linked to the real processor (Link replaces the simulation)
    h += (sim ? '<div class="row">' : '<p class="hint">Not linked to a real processor.</p><div class="row">') + '<button data-hw="find"' + (sim ? ' class="mini" title="Find the real processor on the network to link it (replaces the simulation)"' : '') + (busy ? ' disabled' : '') + '>' + (busy === 'find' ? 'Searching…' : 'Find processors') + '</button>' +
      (sim ? '' : '<button data-hw="simulate" title="Try the app with a simulated processor: no hardware, it detects what the project places">Simulate</button>') +
      (sim ? '' : DRV.familyOf(d) === 'coex' ? '<button data-hw="addaddr" title="A controller on another network segment isn’t heard by discovery: type its address (port 8001 unless you give one)">Add by address…</button>' :
        DRV.familyOf(d) === 'lct' ? '<button data-hw="addaddr" title="A processor on another network, or over a VPN such as Tailscale, doesn’t hear the search: type its IP address">Add by address…</button>' : '') + '</div>';
    if (hw.found.length) h += hw.found.map(function (x, i) {
      var key = hwModelKey(x.modelId);
      var sub = x.kind === 'unico' || x.kind === 'coex' ? (key ? PROC_MODELS[key].name : x.model || 'model ' + x.modelId) + ' · SN ' + x.SN : hwLinkCards(x.senders);
      var inp = olInProject(x);
      if (inp) sub += ' · in this project as ' + deviceLabel(inp);
      return '<div class="hw-grp"><span><b>' + esc(x.deviceName) + '</b> · ' + esc(hwWhere(x.ip, x.port)) + (x.iface && typeof nwShort === 'function' ? ' · ' + esc(nwShort(x.iface)) : '') + '<br><span class="hint">' + esc(sub) + '</span>' +
        (x.conflict ? '<br><span class="rcv-bad">⚠ ' + esc(x.conflict) + '</span>' : '') + '</span>' +
        '<button class="mini" data-hw="link" data-i="' + i + '">Link</button></div>';
    }).join('');
    else if (hw.found && busy !== 'find' && hw.searched) h += '<p class="hint">No processors answered.</p>';
  }
  box.innerHTML = h;
}

function bindHardware() {
  var box = $('dvHwBody'); if (!box) return;
  box.addEventListener('change', function (e) {
    if (e.target.matches('[data-hw="liveapply"]')) {
      var dl = devSelected(); if (!dl || !dl.hw) return;
      dl.hw.liveApply = e.target.checked ? undefined : false;
      if (e.target.checked && hw.applied) liveSet(dl, undefined);   // start from what's there now
      log('hw_live_apply', { processor: dl.name, on: e.target.checked }); commit(); renderHwCard(dl); return;
    }
    if (!e.target.matches('[data-hw="live"]')) return;
    var d = devSelected(); if (!d || !d.hw) return;
    d.hw.live = e.target.checked ? undefined : false;
    log('hw_live', { processor: d.name, on: e.target.checked });
    commit(); renderHwCard(d);
  });
  box.addEventListener('click', function (e) {
    var b = e.target.closest('[data-hw]'); if (!b) return;
    var d = devSelected(), a = b.dataset.hw;
    if (a === 'ping') return hwPing();
    if (a === 'find') { hw.searched = true; return hwFind(); }
    if (a === 'link') return hwLink(d, hw.found[+b.dataset.i]);
    if (a === 'simulate') return hwSimulate(d);
    if (a === 'addaddr') {   // remembered addresses are asked directly on every Find (drv-coex.js coexHosts, drv-lct.js lctHosts)
      var cx = DRV.familyOf(d) === 'coex';
      var ad = prompt(cx ? 'Controller address (ip or ip:port):' : 'Processor IP address (on another network, or over a VPN such as Tailscale):', ''); if (!ad || !ad.trim()) return;
      ad = ad.trim(); if (cx && ad.indexOf(':') < 0) ad += ':8001';
      if (!cx) { ad = ad.split(':')[0]; if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ad)) return toast('That isn’t an IP address (like 192.168.0.10)'); }
      var key = cx ? COEX_HOSTS_KEY : LCT_HOSTS_KEY, list = cx ? coexHosts() : lctHosts(); if (list.indexOf(ad) < 0) list.push(ad);
      try { localStorage.setItem(key, JSON.stringify(list)); } catch (x) { /* storage unavailable */ }
      log(cx ? 'coex_add_address' : 'lct_add_address', { address: ad }); hw.searched = true; return hwFind();
    }
    if (a === 'compare') return hwCompare(d);
    if (a === 'adopt') return hwAdopt(d);
    if (a === 'readlayout') return rbRead([d], true);
    if (a === 'svc') return svOpen(d, b.dataset.act);
    if (a === 'save') return hwSaveDevices([d]);
    if (a === 'unlink') return hwUnlink(d);
    if (a === 'hlogin') return hlOpen(d);   // app-online.js
    if (a === 'info') {
      var x = DRV.of(d); if (!x.deviceInfo) return toast('Device info isn’t available for this processor yet');
      hw.info = hw.info || {}; hw.info[d.id] = { busy: true, r: hw.info[d.id] && hw.info[d.id].r }; renderHwCard(d);
      return x.deviceInfo(d).then(function (r) { return r; }, function (e) { return { ok: false, error: 'helper: ' + e.message }; })
        .then(function (r) { hw.info[d.id] = { r: r }; log('hw_info', { processor: d.name, ok: r.ok }); renderHwCard(devSelected()); });
    }
    if (a === 'detect') return hwDetect(d, false);
    if (a === 'qa') return hwQuickAdd(hwGroups(d)[+b.dataset.g]);
  });
  hwPing();
  setInterval(hwTick, 1000);
  setInterval(hwBackground, 5000);   // decides itself when a search is due
  // projects saved by the first version kept a detection in the project: it's live state now
  (P.devices || []).forEach(function (d) { if (d.hw && d.hw.detected) delete d.hw.detected; });
}
