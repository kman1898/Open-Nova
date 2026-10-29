// app-capacity.js - port capacity and port bookkeeping: capacity(), the port-rectangle helpers
// (rectOf, rectUnion, rectArea), portCap (low-latency derate), lookups (panelOf, screenById,
// portsOfSender), port labels / colours, stepSelectedPort, advancePort, portUsage (load counted per
// processor: rectangle, Σ areas or MX blocks — blocksLoad, MIN_BLOCK_W, loadModeText), problems,
// nextFreePort, freePorts and cardProblem.
// Depends on: scr.js (SCR.portCapacity), app-core (P, ui, fmt, lctById, MAX_CARD_PORTS),
// app-geometry (cellsOf), app-processors (loadModeOfCard), all at run time.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ derived data
// Table capacity for the project's bit depth and frame rate (0 above 120 Hz).
function capacity() { return SCR.portCapacity(P.bitDepth, P.refresh); }
var NO_LOW_LATENCY_CARDS = /^MRV3(28|36)\b/i;

// Port rectangles: a port reserves the bounding box of all its cabinets; its load is that area.
function rectOf(g) { return { x0: g.x, y0: g.y, x1: g.x + g.w, y1: g.y + g.h }; }
function rectUnion(a, b) {
  if (!a) return b; if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
function rectArea(r) { return r ? (r.x1 - r.x0) * (r.y1 - r.y0) : 0; }
// Capacity for a port occupying rect: table value, then the low-latency derate
// floor(cap × (1 − Y/H)), Y = top of the port's highest cabinet, H = canvas raster height.
function portCap(r) {
  var cap = capacity();
  if (!P.lowLatency || !r) return cap;
  var H = P.canvasH;
  if (!(H > 0)) return cap;
  return Math.max(0, Math.floor(cap * (1 - r.y0 / H)));
}
function panelOf(s) { return P.panels.find(function (p) { return p.id === s.panelId; }) || P.panels[0] || { w: 128, h: 128 }; }
function screenById(id) { return P.screens.find(function (s) { return s.id === id; }); }
function portsOfSender(i) { return P.processors[i] ? P.processors[i].ports : 0; }
function globalPortIndex(sender, port) { var n = 0; for (var i = 0; i < sender; i++) n += portsOfSender(i) || 16; return n + port; }
// The one port palette, used by every view (canvas, navigator, tree, port tiles, Quick add, rear panels). Classic: a
// golden-angle hue per port. Pro look (docs/DESIGN_SYSTEM.md): the gallery's muted --p1 … --p4 (app/out/pro/pro.css) and
// eight more hues of that family, then the twelve in a lighter, a deeper and a greyer tone, so 40+ ports stay apart. Counted
// per processor (its cards in order), as a screen is on one processor: every processor's P1 is the gallery's blue.
var PORT_HUES = ['#6f9cff', '#2fc7b0', '#e6a63a', '#c27cf0', '#ef7f9f', '#8fcf5a', '#4fbfe6', '#ee8a55', '#9d93ff', '#55cf8c', '#de80d6', '#d4c04a'];
function portColor(sender, port) {
  var g = globalPortIndex(sender, port);
  if (document.documentElement.dataset.look !== 'pro') return 'hsl(' + ((g * 137.508) % 360).toFixed(1) + ',70%,' + (g % 2 ? 58 : 68) + '%)';
  var c = P.processors[sender], i;
  if (c && c.dev) for (g = port, i = 0; i < sender; i++) if (P.processors[i] && P.processors[i].dev === c.dev) g += portsOfSender(i) || 16;
  var hex = PORT_HUES[g % 12], tone = Math.floor(g / 12) % 4;
  return tone ? hexMix(hex, ['', '#ffffff', '#000000', '#8a929d'][tone], [0, 0.42, 0.32, 0.5][tone]) : hex;
}
// a + (b − a) × f for two #rrggbb colours
function hexMix(a, b, f) {
  var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16), out = 0;
  for (var s = 16; s >= 0; s -= 8) { var x = (pa >> s) & 255, y = (pb >> s) & 255; out = out * 256 + Math.round(x + (y - x) * f); }
  return '#' + (0x1000000 + out).toString(16).slice(1);
}
// "S2 P5" = sending card 2, port 5 (1-based, as NovaLCT shows them)
function portLabel(sender, port) {
  if (typeof cardIsReal === 'function' && !cardIsReal(sender)) {   // a fixed processor: no "sending card" (app-processors.js)
    var d = deviceOfCard(sender);
    return (d && P.devices.length > 1 ? deviceLabel(d) + ' ' : '') + 'P' + (port + 1);
  }
  if (!P.processors.length && !sender) return 'P' + (port + 1);   // no processor yet: just the port
  return 'S' + (sender + 1) + ' P' + (port + 1);
}
// Step the selected (manual/drawing) port within the processors that exist. dir = +1 or -1.
function stepSelectedPort(dir) {
  var s = ui.mSender || 0, p = (ui.mPort || 0) + dir;
  if (p >= portsOfSender(s)) { if (s + 1 < P.processors.length) { s++; p = 0; } else p = portsOfSender(s) - 1; }
  if (p < 0) { if (s > 0) { s--; p = portsOfSender(s) - 1; } else p = 0; }
  ui.mSender = s; ui.mPort = Math.max(0, p);
}
function advancePort(sp) {
  var s = sp.sender, p = sp.port + 1;
  if (p >= (portsOfSender(s) || Infinity)) { s++; p = 0; }
  return { sender: s, port: p };
}

function portUsage(cellsBy) {
  var use = {};
  P.screens.forEach(function (s) {
    cellsBy[s.id].forEach(function (c) {
      if (c.sender == null) return;
      var k = c.sender + ':' + c.port;
      var u = use[k] || (use[k] = { sender: c.sender, port: c.port, cabs: 0, px: 0, rect: null, screens: {}, connects: {}, dup: 0 });
      u.cabs++; u.px += c.w * c.h; u.rect = rectUnion(u.rect, rectOf(c)); u.screens[s.id] = 1;
      (u.boxes || (u.boxes = [])).push({ x: c.x, y: c.y, w: c.w, h: c.h });
      u.lct = u.lct || {}; u.lct[s.screenId] = 1;
      var ck = s.id + ':' + c.connect;   // cable positions restart per section (merged in order on export)
      if (u.connects[ck]) u.dup++; u.connects[ck] = 1;
    });
  });
  // Per port, in order: table value -> low-latency derate -> compare with the load, counted as the
  // port's processor counts it (loadModeOfCard: bounding rectangle, Σ cabinet areas, or MX blocks).
  Object.keys(use).forEach(function (k) {
    var u = use[k];
    u.mode = loadModeOfCard(u.sender);
    u.load = u.mode === 'area' ? u.px : u.mode === 'blocks' ? blocksLoad(u.boxes) : rectArea(u.rect);
    u.cap = portCap(u.rect);
  });
  return use;
}
// MX (VMP) port load, as VMP counts it (docs\VMP_OPERATIONS.md §1.9): sort by y then x;
// merge runs of same-y same-height touching cabinets into rows, then same-x same-width touching rows
// into blocks; load = Σ max(block width, 128) × block height.
var MIN_BLOCK_W = 128;
function blocksLoad(boxes) {
  var b = (boxes || []).slice().sort(function (p, q) { return p.y - q.y || p.x - q.x; });
  var runs = [], r = null;
  b.forEach(function (c) {
    if (r && c.y === r.y && c.h === r.h && c.x === r.x + r.w) r.w += c.w;
    else { r = { x: c.x, y: c.y, w: c.w, h: c.h }; runs.push(r); }
  });
  var blocks = [], k = null;
  runs.forEach(function (c) {
    if (k && c.x === k.x && c.w === k.w && c.y === k.y + k.h) k.h += c.h;
    else { k = { x: c.x, y: c.y, w: c.w, h: c.h }; blocks.push(k); }
  });
  return blocks.reduce(function (s, x) { return s + Math.max(x.w, MIN_BLOCK_W) * x.h; }, 0);
}
// Words for how a port's load is counted (tooltips, problems).
function loadModeText(mode) {
  return mode === 'area' ? 'cabinet area (free topology)' : mode === 'blocks' ? 'cabinet blocks (free topology)' : 'rectangle';
}

function nextFreePort(exceptId, fromCard) {
  var used = {};
  P.screens.forEach(function (s) {
    if (s.id === exceptId) return;
    cellsOf(s).forEach(function (c) { if (c.sender != null) used[c.sender + ':' + c.port] = 1; });
  });
  for (var si = fromCard || 0; si < Math.max(1, P.processors.length) + 8; si++) {
    var n = portsOfSender(si) || 64;
    for (var p = 0; p < n; p++) if (!used[si + ':' + p]) return { sender: si, port: p };
  }
  return { sender: 0, port: 0 };
}
// The first n ports no section uses, in order (past the last card if they run out). cards = only these (a screen's
// processor's, lctAllowedCards): fewer come back when they run out.
function freePorts(n, cards) {
  var used = {}, out = [];
  P.screens.forEach(function (s) { cellsOf(s).forEach(function (c) { if (c.sender != null) used[c.sender + ':' + c.port] = 1; }); });
  for (var i = 0; out.length < n && (!cards || i < cards.length); i++) {
    var si = cards ? cards[i] : i, np = portsOfSender(si) || MAX_CARD_PORTS;
    for (var p = 0; p < np && out.length < n; p++) if (!used[si + ':' + p]) out.push({ sender: si, port: p });
  }
  return out;
}
// The next free port for cabinets on screen lcId: on its processor's cards (a screen belongs to one processor).
function lctFreePort(lcId, exceptId) {
  var ok = typeof lctAllowedCards === 'function' ? lctAllowedCards(lcId) : null, nf = nextFreePort(exceptId, ok ? ok[0] : 0);
  return ok && ok.indexOf(nf.sender) < 0 ? { sender: ok[0], port: 0 } : nf;
}

function problems(cellsBy, use) {
  var out = [];
  if (capacity() === 0) out.push('Frame rate above 120 Hz is not supported');
  if (P.lowLatency && NO_LOW_LATENCY_CARDS.test((P.rxCard || '').trim())) out.push(P.rxCard + ' receiving cards can’t run low latency');
  P.screens.forEach(function (s) {
    if (s.wiring.mode === 'auto' && s.kind !== 'complex') (ui.autoErr[s.id] || []).forEach(function (e) { out.push(secLabel(s) + ': ' + e); });   // (no section names in the UI)
  });
  Object.keys(use).forEach(function (k) {
    var u = use[k];
    if (u.load > u.cap) out.push(portLabel(u.sender, u.port) + ' over capacity (' + loadModeText(u.mode) + ' ' + fmt(u.load) + ' > ' + fmt(u.cap) + ' px)');
    if (u.sender >= P.processors.length) out.push(portLabel(u.sender, u.port) + ': ' + (P.devices.length ? cardName(u.sender, true) + ' isn’t added' : 'no processor yet — add one in Device'));
    else if (u.port >= portsOfSender(u.sender)) out.push(portLabel(u.sender, u.port) + ': ' + cardName(u.sender, true) + ' has only ' + portsOfSender(u.sender) + ' ports');
    if (Object.keys(u.lct).length > 1) out.push(portLabel(u.sender, u.port) + ' is used on more than one screen (' + Object.keys(u.lct).map(function (id) { return lctById(id).name; }).join(', ') + ')');
    if (u.dup) out.push(portLabel(u.sender, u.port) + ' has duplicate cable positions');
  });
  lctMixed(cellsBy).forEach(function (x) {   // a screen belongs to one processor (app-processors.js)
    out.push(x.lc.name + ' has cabinets on ' + x.devs.map(deviceLabel).join(' and ') + ' — a screen belongs to one processor: move some to a screen of their own (right-click ▸ Move cabinets to ▸ New screen)');
  });
  P.lct.forEach(function (lc) {   // sections overlapping on one screen (app-render.js overlapCells)
    var n = Object.keys(overlapCells(P.screens.filter(function (s) { return s.screenId === lc.id; }), cellsBy)).length;
    if (n) out.push(lc.name + ': ' + n + ' cabinets overlap other cabinets');
  });
  P.screens.forEach(function (s) {
    var n = cellsBy[s.id].filter(function (c) { return c.unassigned; }).length;
    if (n) out.push(secLabel(s) + ': ' + n + ' not on any port');
    if (cellsBy[s.id].some(function (c) { return c.x + c.w > 65535 || c.y + c.h > 65535; })) out.push(secLabel(s) + ': past 65,535 px, which a .scr can’t store');
  });
  return out.concat(backupProblems(use));   // wired backup ports etc. (app-backup.js)
}

// Why a port can't be drawn on (card not added / port past the card's last port), or null.
function cardProblem(sp) {
  if (!P.devices.length) return 'Add a processor first (Device ▸ + Add processor)';
  if (sp.sender >= P.processors.length) return cardName(sp.sender) + ' isn’t added — add a processor or card in Device';
  if (sp.port >= portsOfSender(sp.sender)) return cardName(sp.sender) + ' has only ' + portsOfSender(sp.sender) + ' ports';
  return null;
}
