// app-processors.js - processors (NovaLCT "devices") and the sending cards they hold.
// P.processors stays the flat list of sending cards numbered as NovaLCT numbers them
// (card 1 = index 0); P.devices is the cascade order of the processors, and every card has
// .dev = the id of the processor it belongs to. A processor's cards are always consecutive and
// in cascade order, so inserting / removing / reordering renumbers the wiring (remapSenders).
// Kinds of processor (PROC_MODELS):
//   fixed   - its sending cards and port counts come from the model (MCTRL4K, VX1000 …);
//             adding another one cascades it after the last card.
//   chassis - H series: you add output cards (16 / 20-port, fiber …) up to its slot count.
//   custom  - "Pick a model": the model isn't known yet (a .scr import, a project from before processors existed); its
//             cards take any port count 1-40. Never offered as a choice (user, 2026-10-11: "I should only be able to put
//             possible processors"); Send is refused until a real model is set (procUnset). A new project has no processor.
// Owns: cardIsReal, cardName, procUnset, PROC_MODELS, PROC_ORDER, OUTPUT_CARDS, NON_LED_CARDS, H_CARDS, fixedModel, hChassis, procModel, procFamily,
// procFreeTopology, loadModeOfCard,
// procModelOptions, chassisCardType, remapProjectSenders, ensureDevices, newProcName, deviceById,
// deviceOfCard, cardsOfDevice, deviceLabel, cardTypeLabel, screenProcessorRule, lctCabDevs, lctOwner, lctDevMap, lctScreensOf,
// lctMixed, lctAllowedCards, lctNormalize, lctSplitShared, remapSenders, wiredCards,
// snapshotAutoSections, keepAutoWiring, sameCard, cardChangeToast, applyCards, cardList,
// cardsForModel, addProcessor, addOutputCard, procPanels, removeProcessor, setProcessorModel,
// setOutputCardType, setCardPorts, moveProcessor.
// Depends on: app-core (P, ui, uid, clamp, commit, toast, log, MAX_CARD_PORTS), app-geometry
// (allCells), app-autowire (autoAssign), app-manual-wiring (ensureManual), app-selfdraw
// (sdDropPanels), app-render (renderAll), all at run time.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// Port counts and ModelIDs are NovaLCT V5.9.2's own; see
// docs/PROCESSOR_CATALOG.md. ModelIDs are what each sending card reports (for auto-detect).
// H-series output (sending) cards: each is its own sending card in LCT, so a chassis can mix them.
var OUTPUT_CARDS = {
  h16:       { name: 'H 16-port (RJ45)', ports: 16, modelId: 0x7B46 },
  h20:       { name: 'H 20-port (RJ45)', ports: 20, modelId: 0x7B48 },
  h4fiber:   { name: 'H 4× fiber (32 ports)', ports: 32, modelId: 0x7B4A },   // 16 unless working mode 0x020001DA = 0xAA
  mx4x10g:   { name: 'MX 4×10G fibre (40 ports)', ports: 40, modelId: 42048 },               // COEX: 10 virtual 1G ports per fibre
  mx1x40g:   { name: 'MX 1×40G fibre (8 × 5G)', ports: 8, modelId: 42049, portGbps: 5 },
  mx8x5g:    { name: 'MX 8×5G RJ45 (8 × 5G)', ports: 8, modelId: 42055, portGbps: 5 },
  h8fiber:   { name: 'H 8× fiber (40 ports, LCT)', ports: 40, modelId: 0x7B4F },
  hp16:      { name: 'H Planar 16-port', ports: 16, modelId: 0x9046 },
  hp20:      { name: 'H Planar 20-port', ports: 20, modelId: 0x9048 },
  hp4fiber:  { name: 'H Planar 4× fiber (32 ports)', ports: 32, modelId: 0x904A }
};
// H cards that answer on a TG port but aren't LED outputs (never a processor of their own, never asked for a sending card's
// tables). 0x7B47 = 31559, the H's MVR (preview) card: an H9 tester's showed up at its own address on TCP 5200, answering
// the search with "App,01 61" and no H_SUB_CARD list (2026-11-19).
var NON_LED_CARDS = { 0x7B47: 'H MVR card (preview) — not an LED output' };
// Cards offered in the H chassis. Unico's chassis files allow only 0x7B40-0x7B4E in output slots
// (16-port, 20-port, 4× fiber …). The 8× fiber card (0x7B4F) is known to NovaLCT but not to
// Unico's slot lists, so it is offered with "(LCT)". The Planar cards stay only in the legacy
// "H series" entry.
var H_CARDS = ['h16', 'h20', 'h4fiber', 'h8fiber'];

// Processor models. cards = sending cards inside one unit (fixed); ports = per card;
// family = heading in the pickers (from the name: "VX1000" → VX, "MCTRL4K" → MCTRL …).
function fixedModel(name, ports, modelId) {
  var fam = /^MCTRL/.test(name) ? 'MCTRL' : /^(NovaPro|4K-Prime)/.test(name) ? 'NovaPro' : /^VX/.test(name) ? 'VX' :
    /^VC?\d/.test(name) ? 'V / VC Pro' : /^K\d/.test(name) ? 'K series' : 'Other';
  return { name: name, kind: 'fixed', cards: 1, ports: ports, modelId: modelId, family: fam };
}
// H-series chassis. LCT has no chassis model (each output card is a cascaded sender on one
// link). Slot counts are the max number of output (sending) cards from Unico's
// userver\dcsxml\sdk_config\device\specific\*_spec.xml "OutputCards MaxQTY". One output slot more
// exists for the MVR (preview) card on H5/H9/H15/H20; H2's MVR goes in a mixed slot. H9 is taken
// from the identical-layout H9_10X5 spec, and H20 (20) is inferred because its spec file is a copy
// of H9's.
function hChassis(name, slots, modelId, cards) { return { name: name, kind: 'chassis', slots: slots, cardTypes: cards || H_CARDS, modelId: modelId, family: 'H series' }; }
var PROC_MODELS = {
  custom:      { name: 'Pick a model', kind: 'custom', family: 'Generic' },   // not a choice: the model isn't known yet
  h2:          hChassis('H2', 2, 0x750D),
  h5:          hChassis('H5', 3, 0x750B),
  h9:          hChassis('H9', 5, 0x750A),
  h9enh:       hChassis('H9 Enhanced', 5, 0xF00123),   // LCT's "H9 Pro", Unico's "H9 Enh" (15728931); 5 LED sending cards per NovaStar's specs
  h15:         hChassis('H15', 10, 0x750E),
  h15pro:      hChassis('H15 Pro', 16, 0x7510),
  h20:         hChassis('H20', 20, 0x751E),
  mctrl300:    fixedModel('MCTRL300 / MSD300', 2, 0x0001),
  mctrl500:    fixedModel('MCTRL500', 4, 0x0101),
  mctrl600:    fixedModel('MCTRL600 / 660', 4, 0x1101),
  mctrl660pro: fixedModel('MCTRL660 Pro', 6, 0x1107),
  mctrl700:    fixedModel('MCTRL700', 6, 0x9101),
  mctrl700pro: fixedModel('MCTRL700 Pro', 6, 0x1116),
  mctrlr5:     fixedModel('MCTRL R5', 8, 0x1104),
  mctrl4k:     fixedModel('MCTRL4K', 16, 0x1103),
  mctrl1600:   fixedModel('MCTRL1600', 16, 0x1105),
  mctrl2000:   fixedModel('MCTRL2000', 20, 0x1115),
  novaprohd:   fixedModel('NovaPro HD', 4, 0x6101),
  novaprouhd:  fixedModel('NovaPro UHD', 16, 0x7504),
  uhdjr:       fixedModel('NovaPro UHD Jr', 16, 0x6205),
  vx4s:        fixedModel('VX4S', 4, 0x6107),
  vx4sn:       fixedModel('VX4S-N', 4, 0x612A),
  vx6s:        fixedModel('VX6s', 6, 0x6203),
  vx16s:       fixedModel('VX16s', 16, 0x620B),
  vx400:       fixedModel('VX400', 4, 0x6211),
  vx400pro:    fixedModel('VX400 Pro', 4, 0x6229),
  vx600:       fixedModel('VX600', 6, 0x620E),
  vx600pro:    fixedModel('VX600 Pro', 6, 0x622A),
  vx1000:      fixedModel('VX1000', 10, 0x620C),
  vx1000pro:   fixedModel('VX1000 Pro', 10, 0x622B),
  vx2000pro:   fixedModel('VX2000 Pro', 20, 0x622C),
  hc20pro:     fixedModel('HC20 Pro', 20, 0x6236),   // named "VX2000Plus" only in NovaLCT's old NSCardTypeXML
  k8:          fixedModel('K8', 8, 0x621B),
  k16:         fixedModel('K16', 16, 0x6204),
  k20:         fixedModel('K20', 20, 0x621C),
  k40:         fixedModel('K40', 40, 0x621D),
  // V / VC Pro: port counts from Unico (UNICO_SERVER.md §3.3). V6/V8/V10/V16/V24/V32 and VC10 Pro dropped 2026-10-10 (no public trace; user)
  v12:         fixedModel('V12', 12, 0x6222),
  v40:         fixedModel('V40', 40, 0x6226),
  vc6pro:      fixedModel('VC6 Pro', 6, 0x6227),
  // MX (COEX, VMP): 20 Ethernet ports, seen live in VMP V1.5.1 (docs\VMP_TOUR.md); ModelID = VMP's modelID.
  mx40pro:     Object.assign(fixedModel('MX40 Pro', 20, 0x1415), { family: 'MX' }),
  // MX chassis: output slots and cards from VMP's config (docs\VMP_COEX.md: MX6000 Pro 8 slots, MX2000 Pro 2; 42048 = 40 × 1G
  // ports, 42049 / 42055 = 8 × 5G). Driven by drv-coex.js; the MX6000 Pro is checked on VMP's own controller emulator.
  mx6000pro:   { name: 'MX6000 Pro', kind: 'chassis', slots: 8, cardTypes: ['mx4x10g', 'mx1x40g', 'mx8x5g'], modelId: 0x1501, family: 'MX' },
  mx2000pro:   { name: 'MX2000 Pro', kind: 'chassis', slots: 2, cardTypes: ['mx4x10g', 'mx1x40g', 'mx8x5g'], modelId: 0x1502, family: 'MX' },
  cx40pro:     Object.assign(fixedModel('CX40 Pro', 6, 0x1212), { family: 'MX', portGbps: 5 }),
  mx30:        Object.assign(fixedModel('MX30', 10, 0x1412), { family: 'MX' }),
  mx20:        Object.assign(fixedModel('MX20', 6, 0x1411), { family: 'MX' }),
  kc40:        Object.assign(fixedModel('KC40', 20, 0x1422), { family: 'MX' }),
  ku20:        Object.assign(fixedModel('KU20', 6, 0x1410), { family: 'MX' })
};
// Order in the pickers.
var PROC_ORDER = Object.keys(PROC_MODELS).filter(function (k) { return k !== 'custom'; });   // real processors only (custom = not chosen yet)
// Keys from the first version of this file (not offered any more, still loaded).
PROC_MODELS.msd300 = PROC_MODELS.mctrl300;
PROC_MODELS.vx2000plus = PROC_MODELS.hc20pro;
PROC_MODELS.h = hChassis('H series', 20, null, H_CARDS.concat(['hp16', 'hp20', 'hp4fiber']));
// canSetInputEdid: NovaLCT can set this model's input resolution (Source Configuration → Set = an
// EDID written to sender 0x08000000). LCT disables it for every H output card and for the models
// listed here (CAPTURE_MCTRL4K_SEND.md "Source Configuration"); they take their size from the
// processor. Match Screen (app-screenfit.js) is offered only when every processor can.
Object.keys(PROC_MODELS).forEach(function (k) {
  var m = PROC_MODELS[k];
  m.canSetInputEdid = m.kind !== 'chassis' && ['hc20pro', 'vx2000plus', 'k8', 'k16', 'k20', 'k40', 'v12',
    'v40', 'vc6pro', 'vx16s', 'vx400pro', 'vx600pro', 'vx1000pro', 'vx2000pro'].indexOf(k) < 0;
});
// canSetCanvas: the model's own tool sets its canvas size even though NovaLCT can't. Unico's Match Screen = PUT
// screen/canvas/window with a custom W x H, seen live on the VX2000 Pro simulator (docs\PANEL_DETECT.md, APP_SEND.md);
// the other VX Pro models are probably the same but not checked, so they stay off.
PROC_MODELS.vx2000pro.canSetCanvas = true;
// [value, text, group] rows for the model pickers.
function procModelOptions() { return PROC_ORDER.map(function (k) { return [k, PROC_MODELS[k].name, PROC_MODELS[k].family]; }); }

function procModel(k) { return PROC_MODELS[k] || PROC_MODELS.custom; }
// How the processor is driven (internal only, never shown): 'unico' (VX Pro / HC20 Pro: UServer REST),
// 'coex' (MX: VMP / XCenter REST) or 'lct' (everything NovaLCT drives: MCTRL, NovaPro, VX classic, H …).
function procFamily(m) {
  var n = (m && m.name) || '';
  return /^(MX|KU|KC|CX)\d/.test(n) ? 'coex' : /VX\d+ Pro$|^HC20 Pro$/.test(n) ? 'unico' : 'lct';
}
// Free topology = a port's load is only its cabinets' own pixels, gaps free (all three tools have it):
// MX always (VMP merges the cabinets into row / column blocks, each at least 128 px wide); VX Pro by
// Unico's "Free Topology" switch, on by default; LCT-driven senders only when the sending card reports
// FreeRouting (d.hw.freeRoute, read on link), so off by default. Needs receiving cards that support it (docs\CROSS_TOOL.md).
// d.freeTopology = the user's choice (null = the default).
function procFreeTopology(d) {
  var f = procFamily(procModel(d && d.model));
  if (f === 'coex') return true;
  if (d && typeof d.freeTopology === 'boolean') return d.freeTopology;
  return f === 'unico' || (f === 'lct' && !!(d && d.hw && d.hw.freeRoute));
}
// How the load of one sending card's ports is counted: 'rect' (bounding rectangle), 'area' (Σ cabinet
// areas) or 'blocks' (MX: merged blocks, min 128 px wide).
function loadModeOfCard(i) {
  var d = deviceOfCard(i), f = procFamily(procModel(d && d.model));
  if (!procFreeTopology(d)) return 'rect';
  return f === 'coex' ? 'blocks' : 'area';
}
// Output card type for a chassis card: keep `cur` when this chassis takes it and it has at least
// `need` ports; otherwise the first type with enough ports (16-port RJ45 first), else the largest.
function chassisCardType(m, cur, need) {
  if (cur && m.cardTypes.indexOf(cur) >= 0 && OUTPUT_CARDS[cur].ports >= need) return cur;
  return m.cardTypes.find(function (k) { return OUTPUT_CARDS[k].ports >= need; }) ||
    m.cardTypes.slice().sort(function (a, b) { return OUTPUT_CARDS[b].ports - OUTPUT_CARDS[a].ports; })[0];
}

// Renumber the wiring stored in project pj. map[oldIndex] = newIndex; a card that is gone has no
// entry (callers make sure nothing is wired to it). Wiring that points past the old last card
// (a card that isn't added) moves by the change in card count, so it never lands on a real card.
function remapProjectSenders(pj, map, oldLen, newLen) {
  function m(i) { return i >= oldLen ? i + (newLen - oldLen) : map[i] == null ? i : map[i]; }
  pj.screens.forEach(function (s) {
    s.wiring.sender = m(s.wiring.sender);
    Object.keys(s.manual || {}).forEach(function (k) { s.manual[k].sender = m(s.manual[k].sender); });
  });
  remapBackup(pj, m, map, oldLen);   // backup pairs follow their cards (app-backup.js)
  return m;
}

// Projects from before processors existed (and .scr imports): one "Pick a model" processor holding
// every card. Also repairs data from other clients: cards without a processor go to a new "Pick a
// model" processor, each processor's cards are regrouped in cascade order (wiring renumbered),
// chassis cards get a valid output card type, and processors without cards are dropped.
// A project may have no processor at all (a new one); the unused "any model" processor every project used to start with
// (one card, no link, no screens) is dropped.
function ensureDevices(pj) {
  if (!pj.processors) pj.processors = [];
  if (!pj.devices || !pj.devices.length) pj.devices = [];
  if (pj.devices.length === 1 && pj.devices[0].model === 'custom' && !pj.devices[0].hw && pj.processors.length === 1 && !(pj.screens || []).length &&
      pj.processors[0].dev === pj.devices[0].id) { pj.devices = []; pj.processors = []; }
  var orphan = null;
  pj.processors.forEach(function (c) {
    if (pj.devices.some(function (d) { return d.id === c.dev; })) return;
    if (!orphan) { orphan = { id: uid(), model: 'custom' }; pj.devices.push(orphan); }
    c.dev = orphan.id;
  });
  // regroup: cards in cascade order, keeping their order within a processor
  var order = [];
  pj.devices.forEach(function (d) { pj.processors.forEach(function (c, i) { if (c.dev === d.id) order.push(i); }); });
  if (order.some(function (old, i) { return old !== i; })) {
    var map = {}; order.forEach(function (old, i) { map[old] = i; });
    remapProjectSenders(pj, map, pj.processors.length, pj.processors.length);
    pj.processors = order.map(function (old) { return pj.processors[old]; });
  }
  pj.processors.forEach(function (c) {
    var d = pj.devices.find(function (x) { return x.id === c.dev; }), m = procModel(d.model);
    if (m.kind === 'chassis' && !(c.type && OUTPUT_CARDS[c.type])) { c.type = chassisCardType(m, null, c.ports || 1); c.ports = OUTPUT_CARDS[c.type].ports; }
  });
  pj.devices = pj.devices.filter(function (d) { return pj.processors.some(function (c) { return c.dev === d.id; }); });
  // every processor has a name, like Unico's "Device1" (older projects: Processor 1, 2 … in cascade order)
  pj.devices.forEach(function (d) { if (!d.name) d.name = newProcName(pj.devices.filter(function (x) { return x.name; }), d.model); });
  return pj;
}
// Name for a new processor: "Processor N", N = one more than the processors in `devs`, skipping
// names already taken.
function newProcName(devs, model) {
  // the model's name ("H2"; a second one "H2 2"), as the user expects to see it (2026-10-11: "it should either show H2 or the
  // name of the processor"); "Processor N" only when the model isn't known
  var base = model && PROC_MODELS[model] && model !== 'custom' ? PROC_MODELS[model].name : 'Processor', has = {}, n = 1;
  devs.forEach(function (d) { if (d.name) has[d.name] = 1; });
  if (base !== 'Processor' && !has[base]) return base;
  n = base === 'Processor' ? devs.length + 1 : 2;
  while (has[base + ' ' + n]) n++;
  return base + ' ' + n;
}

// "Sending card" only means something on a chassis (H series, MX2000 Pro / MX6000 Pro: output cards in slots); a
// "Pick a model" processor's cards are "Card N". A fixed processor (MCTRL4K, VX1000, MX40 Pro …) has one card that is the processor itself, so
// it is never called "sending card 1" (user, 2026-10-11): its name is the processor's.
function cardIsReal(i) { var d = deviceOfCard(i), m = d ? procModel(d.model) : null; return !m || m.kind !== 'fixed'; }
// A chassis card is a "Sending card N"; a card of a "Pick a model" processor, or one no processor holds (wired but not
// added), is just "Card N".
function cardName(i, lower) {
  var d = deviceOfCard(i), m = d && procModel(d.model);
  if (d && !cardIsReal(i)) return deviceLabel(d);
  return (m && m.kind === 'chassis' ? (lower ? 'sending card ' : 'Sending card ') : (lower ? 'card ' : 'Card ')) + (i + 1);
}
// The processor's model isn't set yet ("Pick a model"): nothing is sent to it.
function procUnset(d) { return !!d && procModel(d.model).kind === 'custom'; }
function deviceById(id) { return P.devices.find(function (d) { return d.id === id; }); }
function deviceOfCard(i) { var c = P.processors[i]; return c ? deviceById(c.dev) : null; }
// Card indices of processor d, in order.
function cardsOfDevice(d) {
  var out = [];
  P.processors.forEach(function (c, i) { if (c.dev === d.id) out.push(i); });
  return out;
}
// "MCTRL4K 2" when there are several of the same model, else just the model name.
function deviceLabel(d) {
  var m = procModel(d.model), same = P.devices.filter(function (o) { return o.model === d.model; });
  if (d.name && !(/^Processor \d+$/.test(d.name) && d.model !== 'custom')) return d.name;   // an old automatic name shows the model
  return m.name + (same.length > 1 ? ' ' + (same.indexOf(d) + 1) : '');
}
function cardTypeLabel(c) { return c.type && OUTPUT_CARDS[c.type] ? OUTPUT_CARDS[c.type].name : ''; }

// Screens per processor (user, 2026-10-28: "multiple screens … need to be grouped under the same singular processor"; "A
// screen will not be spread across two processors. They will be two separate processors."). NovaLCT keeps a processor's
// screens in that processor's own configuration (its Screen 1 / Screen 2 … tabs: edited, sent, read back and saved
// together), so every screen belongs to exactly ONE processor: the one whose cards drive its cabinets; a screen without
// cabinets belongs to the processor it was added for (lc.dev, kept up to date by lctNormalize). Its cabinets can only be
// wired to that processor's cards (the card pickers offer only those, auto wiring stops at its last port, Move refuses
// others); a project that has a screen on two processors (an old file, an import) is split on load (lctSplitShared).
// The rule lives in one place, screenProcessorRule: 'one' for every family today. Unico's cross-device / Super Screens and
// a COEX screen over several controllers (same model + firmware) exist in their own apps but were never seen live (docs
// UNICO_UI.md, VMP_OPERATIONS.md §1.10): open them here only once confirmed live, with that same-model check.
function screenProcessorRule(fam) { return { lct: 'one', unico: 'one', coex: 'one' }[fam] || 'one'; }   // fam = procFamily(...)
// lctCabDevs -> { lctId: [processors whose cards its cabinets are on, cascade order] }; lctOwner = the screen's processor;
// lctDevMap -> { lctId: [its processor] or [] }; lctScreensOf(d) = d's screens in its NovaLCT order (the project's screen
// order, what one Send to d writes: Screen 1 first).
function lctCabDevs(cellsBy, only) {
  cellsBy = cellsBy || {};
  var on = {}, out = {};
  P.screens.forEach(function (s) {
    if (only && s.screenId !== only) return;
    var m = on[s.screenId] || (on[s.screenId] = {});
    (cellsBy[s.id] || cellsOf(s)).forEach(function (c) { var dv = c.sender != null && !c.hole ? deviceOfCard(c.sender) : null; if (dv) m[dv.id] = 1; });
  });
  P.lct.forEach(function (lc) { var m = on[lc.id] || {}; out[lc.id] = P.devices.filter(function (dv) { return m[dv.id]; }); });
  return out;
}
function lctOwner(lc, cab) {
  if (!lc) return null;
  var c = (cab || lctCabDevs(null, lc.id))[lc.id] || [];
  return c[0] || (lc.dev && deviceById(lc.dev)) || null;
}
function lctDevMap(cellsBy) {
  var cab = lctCabDevs(cellsBy || allCells()), out = {};
  P.lct.forEach(function (lc) { var o = lctOwner(lc, cab); out[lc.id] = o ? [o] : []; });
  return out;
}
function lctScreensOf(d, cellsBy, map) {
  map = map || lctDevMap(cellsBy);
  return P.lct.filter(function (lc) { return (map[lc.id] || []).some(function (x) { return x.id === d.id; }); });
}
// The screens whose cabinets are on more than one processor where the rule says one: [{ lc, devs }].
function lctMixed(cellsBy) {
  var cab = lctCabDevs(cellsBy || allCells());
  return P.lct.filter(function (lc) { var c = cab[lc.id]; return c.length > 1 && screenProcessorRule(procFamily(procModel(c[0].model))) === 'one'; })
    .map(function (lc) { return { lc: lc, devs: cab[lc.id] }; });
}
// The cards a cabinet of screen lcId may be wired to: its processor's (null = any: no processor yet).
function lctAllowedCards(lcId) {
  var lc = lctById(lcId), o = lctOwner(lc);
  return o ? cardsOfDevice(o) : null;
}
// lc.dev = the processor of every screen with cabinets (an empty one keeps the processor it had).
function lctNormalize() {
  var cab = lctCabDevs(allCells());
  P.lct.forEach(function (lc) { var c = cab[lc.id]; if (c.length === 1) lc.dev = c[0].id; else if (lc.dev && !deviceById(lc.dev)) delete lc.dev; });
}
// Project pj (being loaded, imported or read back): every screen with cabinets on several processors becomes one screen
// per processor, named "<name> – <processor>", in its place, cabinets where they were; a block of cabinets on several
// processors is split the same way (the others' cabinets become blanks in each part, a self-drawn one drops them;
// unwired cabinets stay with the first part). Nothing is cropped or rewired. Returns the texts of what was split
// (logged here, and a toast once the app shows the project).
function lctSplitShared(pj) {
  var keep = P, done = [];
  P = pj;
  try {
    if (!P.lct || !P.devices) return done;
    lctMixed().forEach(function (x) {
      var lc = x.lc, base = lc.name, tabs = {};
      x.devs.forEach(function (d, i) {
        if (!i) { tabs[d.id] = lc; return; }
        var nl = { id: uid(), name: base, dev: d.id };
        P.lct.splice(P.lct.indexOf(tabs[x.devs[i - 1].id]) + 1, 0, nl); tabs[d.id] = nl;
      });
      x.devs.forEach(function (d) { tabs[d.id].name = base + ' – ' + deviceLabel(d); tabs[d.id].dev = d.id; });
      P.screens.filter(function (s) { return s.screenId === lc.id; }).forEach(function (s) {
        if (s.kind !== 'complex' && !s.drawn) ensureManual(s);   // auto wiring would re-flow around the new blanks
        var cs = cellsOf(s), byDev = {};
        cs.forEach(function (c) { var dv = c.sender != null && !c.hole ? deviceOfCard(c.sender) : null; var k = dv ? dv.id : x.devs[0].id; (byDev[k] || (byDev[k] = [])).push(c.k); });
        var ids = Object.keys(byDev);
        if (ids.length < 2) { s.screenId = tabs[ids[0] || x.devs[0].id].id; return; }
        // one part per processor (copies made before any is trimmed), each keeps only its processor's cabinets
        var order = x.devs.filter(function (d) { return byDev[d.id]; });
        var parts = order.map(function (d, i) {
          if (!i) return s;
          var t = JSON.parse(JSON.stringify(s)); t.id = uid(); delete t.group; delete t.backupOf; P.screens.push(t); return t;
        });
        parts.forEach(function (t, i) {
          var d = order[i], drop = [];
          Object.keys(byDev).forEach(function (k) { if (k !== d.id) drop = drop.concat(byDev[k]); });
          if (t.drawn) sdDropPanels(t, drop);
          else drop.forEach(function (k) { t.holes[k] = true; delete t.manual[k]; });
          t.screenId = tabs[d.id].id;
        });
      });
      done.push(base + ' → ' + x.devs.map(function (d) { return tabs[d.id].name; }).join(', '));
    });
    if (done.length) log('screen_split', { why: 'a screen belongs to one processor', screens: done });
    lctNormalize();
  } finally { P = keep; }
  return done;
}
// Renumber the project's wiring and the ui state that holds card numbers (active card, the
// tree's folded cards) after the card list changed. See remapProjectSenders.
function remapSenders(map, oldLen, newLen) {
  var m = remapProjectSenders(P, map, oldLen, newLen);
  if (ui.mSender != null) ui.mSender = m(ui.mSender);
  if (ui.treeCardClosed) {
    var folded = {};
    Object.keys(ui.treeCardClosed).forEach(function (k) { var p = k.lastIndexOf(':'); folded[k.slice(0, p) + ':' + m(+k.slice(p + 1))] = ui.treeCardClosed[k]; });
    ui.treeCardClosed = folded;
  }
  return m;
}
// Which card indices have something wired to them (any screen).
function wiredCards() {
  var used = {}, cellsBy = allCells();
  P.screens.forEach(function (s) { cellsBy[s.id].forEach(function (c) { if (c.sender != null) used[c.sender] = Math.max(used[c.sender] || 0, c.port + 1); }); });
  return used;   // card index -> highest port number used (1-based)
}

// An auto-wired section stores only its first card; when it runs out of ports it carries on
// onto the next card by number, so renumbering or resizing cards could move its panels. Take a
// snapshot of every auto section's wiring before the change (snapshotAutoSections); afterwards
// (keepAutoWiring, m = old → new card number) any section whose panels would land on other
// cards or ports is switched to Manual with its old wiring, renumbered. Returns their names.
function snapshotAutoSections() {
  return P.screens.filter(function (s) { return s.wiring.mode === 'auto' && s.kind !== 'complex'; })
    .map(function (s) { return { s: s, asg: autoAssign(s) }; });
}
function keepAutoWiring(snap, m) {
  var names = [];
  snap.forEach(function (x) {
    var now = autoAssign(x.s), want = {}, moved = Object.keys(now).length !== Object.keys(x.asg).length;
    Object.keys(x.asg).forEach(function (k) {
      var a = x.asg[k], t = { sender: m(a.sender), port: a.port, connect: a.connect }, b = now[k];
      want[k] = t;
      if (!b || b.sender !== t.sender || b.port !== t.port || b.connect !== t.connect) moved = true;
    });
    if (moved) { x.s.manual = want; x.s.wiring.mode = 'manual'; names.push(secLabel(x.s)); }   // shown in the toast: no section names in the UI
  });
  if (names.length) log('pin_auto_sections', { sections: names, reason: 'their auto wiring would have moved to other cards/ports' });
  return names;
}
function sameCard(i) { return i; }
// Toast for a card change, noting sections that were switched to Manual to keep their wiring.
function cardChangeToast(msg, pinned) {
  toast(msg + (pinned && pinned.length ? ' · ' + pinned.join(', ') + (pinned.length > 1 ? ' were' : ' was') + ' switched to Manual to keep its wiring' : ''));
}

// Replace the card list with `cards` (objects, each carrying .old = its old index or null),
// renumbering the wiring to match. Returns the sections pinned to Manual.
function applyCards(cards) {
  var snap = snapshotAutoSections(), map = {}, oldLen = P.processors.length;
  cards.forEach(function (c, i) { if (c.old != null) map[c.old] = i; });
  var m = remapSenders(map, oldLen, cards.length);
  var was = P.processors;
  P.processors = cards.map(function (c) { var o = { ports: c.ports, dev: c.dev }, k = c.old != null && was[c.old]; if (c.type) o.type = c.type; if (k && k.screen) o.screen = k.screen; return o; });
  var pinned = keepAutoWiring(snap, m);
  if (ui.mSender == null || ui.mSender >= P.processors.length) ui.mSender = Math.max(0, P.processors.length - 1);
  if ((ui.mPort || 0) >= (P.processors[ui.mSender] || {}).ports) ui.mPort = 0;
  return pinned;
}
function cardList() { return P.processors.map(function (c, i) { return { ports: c.ports, dev: c.dev, type: c.type, old: i }; }); }
// New cards for processor d of model key (1 output card for a chassis).
function cardsForModel(d, key, cardType) {
  var m = procModel(key), out = [];
  if (m.kind === 'fixed') for (var i = 0; i < m.cards; i++) out.push({ ports: m.ports, dev: d.id, old: null });
  else if (m.kind === 'chassis') { var t = OUTPUT_CARDS[cardType] ? cardType : m.cardTypes[0]; out.push({ ports: OUTPUT_CARDS[t].ports, type: t, dev: d.id, old: null }); }
  else out.push({ ports: MAX_CARD_PORTS, dev: d.id, old: null });
  return out;
}

// Add a processor: at the end of the cascade, or right after processor `after` (then the cards
// after it are renumbered).
function addProcessor(key, cardType, after) {
  var d = { id: uid(), model: PROC_MODELS[key] ? key : 'custom', name: newProcName(P.devices, PROC_MODELS[key] ? key : 'custom') }, cards = cardList(), at = cards.length;
  if (after && P.devices.indexOf(after) >= 0) {
    P.devices.splice(P.devices.indexOf(after) + 1, 0, d);
    var ai = cardsOfDevice(after); at = ai[ai.length - 1] + 1;
  } else P.devices.push(d);
  Array.prototype.splice.apply(cards, [at, 0].concat(cardsForModel(d, d.model, cardType)));
  var pinned = applyCards(cards), mine = cardsOfDevice(d);
  ui.mSender = mine[0]; ui.mPort = 0;
  log('add_processor', { model: procModel(d.model).name, cards: mine.map(function (i) { return i + 1; }), after: after ? deviceLabel(after) : undefined });
  commit(); renderAll();
  cardChangeToast('Added ' + deviceLabel(d) + (deviceLabel(d) === procModel(d.model).name ? '' : ' (' + procModel(d.model).name + ')') +
    (cardIsReal(mine[0]) ? ' — ' + mine.map(function (i) { return cardName(i, true); }).join(', ') : '') +
    (mine[mine.length - 1] < P.processors.length - 1 ? '; later cards were renumbered' : ''), pinned);
  return d;
}

// Add a sending card to processor d (a chassis's output card, or a "Pick a model" card). It goes
// right after d's last card; later cards move up one number, wiring and all.
function addOutputCard(d, cardType) {
  var m = procModel(d.model), idx = cardsOfDevice(d);
  if (!idx.length) return;
  if (m.kind === 'fixed') return toast(m.name + ' has a fixed number of ports — add another ' + m.name + ' to cascade');
  if (m.kind === 'chassis' && idx.length >= m.slots) return toast(deviceLabel(d) + ' is full (' + m.slots + ' output cards)');
  var add;
  if (m.kind === 'chassis') {
    var t = [cardType, P.processors[idx[idx.length - 1]].type, m.cardTypes[0]].find(function (k) { return k && OUTPUT_CARDS[k] && m.cardTypes.indexOf(k) >= 0; });
    add = { ports: OUTPUT_CARDS[t].ports, type: t, dev: d.id, old: null };
  } else add = { ports: MAX_CARD_PORTS, dev: d.id, old: null };
  var cards = cardList(), at = idx[idx.length - 1] + 1;
  cards.splice(at, 0, add);
  var pinned = applyCards(cards);
  ui.mSender = at; ui.mPort = 0;
  log('add_card', { processor: deviceLabel(d), card: at + 1, type: add.type || 'any', renumbered: P.processors.length - 1 - at });
  commit(); renderAll();
  cardChangeToast('Added ' + cardName(at, true) + ' to ' + deviceLabel(d) + (at < P.processors.length - 1 ? '; later cards were renumbered' : ''), pinned);
}

// The panels wired to processor d's cards. A section wired only to d goes whole (with its card-backup copies,
// section.backupOf: app-backup.js); a section shared with other processors loses only d's panels (they become
// blanks; a Drawn section drops them). { del: sections, cut: [{ s, keys }], n: panels in all }.
function procPanels(d) {
  var mine = {}, cellsBy = allCells(), out = { del: [], cut: [], n: 0 };
  cardsOfDevice(d).forEach(function (i) { mine[i] = 1; });
  function count(s) { return cellsBy[s.id].filter(function (c) { return !c.hole; }).length; }
  P.screens.forEach(function (s) {
    var on = cellsBy[s.id].filter(function (c) { return c.sender != null && mine[c.sender]; });
    if (!on.length) return;
    if (cellsBy[s.id].some(function (c) { return c.sender != null && !mine[c.sender]; })) out.cut.push({ s: s, keys: on.map(function (c) { return c.k; }) });
    else out.del.push(s);
  });
  P.screens.forEach(function (s) {
    if (!s.backupOf || out.del.indexOf(s) >= 0 || !out.del.some(function (x) { return x.id === s.backupOf; })) return;
    out.cut = out.cut.filter(function (x) { return x.s !== s; }); out.del.push(s);
  });
  out.del.forEach(function (s) { out.n += count(s); });
  out.cut.forEach(function (x) { out.n += x.keys.length; });
  return out;
}

// Remove a whole processor, and the panels wired to it (asks first; Ctrl+Z brings it all back).
function removeProcessor(d) {
  var idx = cardsOfDevice(d), pp = procPanels(d), name = deviceLabel(d), dm = lctDevMap();
  var tabs = P.lct.filter(function (lc) { return dm[lc.id].length === 1 && dm[lc.id][0] === d; });   // its own screens go with it (NovaLCT: its configuration)
  if (pp.n && !confirm('Remove ' + name + '?\n\nIts ' + pp.n + ' cabinet' + (pp.n === 1 ? '' : 's') + ' will be removed from the layout too.\n\nCtrl+Z brings them back.')) return log('remove_processor', { processor: name, cancelled: true, panels: pp.n });
  // take d's panels off first: nothing may stay wired to a card that's going (remapProjectSenders)
  P.screens = P.screens.filter(function (s) { return pp.del.indexOf(s) < 0; });
  pp.cut.forEach(function (x) {
    var s = x.s;
    if (s.drawn) return sdDropPanels(s, x.keys);   // app-selfdraw.js
    if (s.kind !== 'complex') ensureManual(s);   // the panels left keep their ports (auto wiring would re-flow around the new blanks)
    x.keys.forEach(function (k) { s.holes[k] = true; delete s.manual[k]; });
  });
  P.screens = P.screens.filter(function (s) { return !(s.drawn && !s.regions.length); });
  var gone = tabs.filter(function (lc) { return !P.screens.some(function (s) { return s.screenId === lc.id; }); });
  if (gone.length >= P.lct.length) gone = gone.slice(1);   // a project keeps one screen
  P.lct = P.lct.filter(function (lc) { return gone.indexOf(lc) < 0; });
  P.lct.forEach(function (lc) { if (lc.dev === d.id) delete lc.dev; });
  if (!lctById(ui.viewScreen)) { ui.viewScreen = null; ui.view = null; }
  if (!P.screens.some(function (s) { return s.id === ui.sel; })) { ui.sel = null; ui.tool = null; }
  if (pp.n) { ui.selKeys = new Set(); ui.selScreen = null; }
  var was = ui.mSender;   // before applyCards renumbers it (a later card's new number may fall inside the removed range)
  var pinned = applyCards(cardList().filter(function (c) { return c.dev !== d.id; }));
  P.devices.splice(P.devices.indexOf(d), 1);
  if (hw.unsaved && hw.unsaved[d.id]) { delete hw.unsaved[d.id]; hwUnsavedStore(); }   // as hwUnlink: its "not saved" reminder goes with it
  // the active card was one of the removed ones: make the card before them active
  if (idx.length && was >= idx[0] && was < idx[0] + idx.length) { ui.mSender = Math.max(0, idx[0] - 1); ui.mPort = 0; }
  log('remove_processor', { processor: name, cards: idx.map(function (i) { return i + 1; }), panels: pp.n, screens_closed: gone.map(function (lc) { return lc.name; }),
    sections_deleted: pp.del.map(function (s) { return s.name; }), sections_trimmed: pp.cut.map(function (x) { return x.s.name + ' (' + x.keys.length + ')'; }) });
  commit(); renderAll();
  cardChangeToast('Removed ' + name + (pp.n ? ' and its ' + pp.n + ' cabinet' + (pp.n === 1 ? '' : 's') + ' (Ctrl+Z to undo)' : '') +
    (idx[0] < P.processors.length ? '; later cards were renumbered' : ''), pinned);
}

// Change processor d's model. Refused when a wired port wouldn't exist any more.
function setProcessorModel(d, key) {
  if (d.model === key || !PROC_MODELS[key]) return;
  var oldIdx = cardsOfDevice(d), wired = wiredCards(), fresh = cardsForModel(d, key), m = procModel(key);
  if (!oldIdx.length) return;
  if (m.kind === 'chassis') {   // keep the cards (up to the slot count); keep each card's type if this chassis takes it
    fresh = oldIdx.slice(0, m.slots).map(function (i) {
      var t = chassisCardType(m, P.processors[i].type, wired[i] || 1);
      return { ports: OUTPUT_CARDS[t].ports, type: t, dev: d.id, old: null };
    });
  } else if (m.kind === 'custom') {
    fresh = oldIdx.map(function (i) { return { ports: Math.max(P.processors[i].ports, wired[i] || 1), dev: d.id, old: null }; });
  }
  // More cards than one unit holds (e.g. an imported 2-card .scr → MCTRL4K): cascade as many
  // units as it takes, keeping every card.
  var extra = [];
  if (m.kind === 'fixed' && oldIdx.length > m.cards) {
    fresh = oldIdx.map(function (i, k) {
      var u = Math.floor(k / m.cards), dev = d;
      if (u > 0) { dev = extra[u - 1] || (extra[u - 1] = { id: uid(), model: key }); }
      return { ports: m.ports, dev: dev.id, old: null };
    });
  }
  var bad = [];
  oldIdx.forEach(function (i, k) {
    if (!wired[i]) return;
    if (!fresh[k]) bad.push(cardName(i, true) + ' would be gone');
    else if (fresh[k].ports < wired[i]) bad.push(cardName(i, true) + ' uses port ' + wired[i] + ' but a ' + m.name + ' card has ' + fresh[k].ports);
  });
  if (bad.length) { log('set_processor_model', { processor: deviceLabel(d), to: m.name, refused: bad }); return toast('Can’t switch to ' + m.name + ': ' + bad.join('; ')); }
  fresh.forEach(function (c, k) { c.old = oldIdx[k] != null ? oldIdx[k] : null; });
  var dropped = oldIdx.slice(fresh.length);   // unwired cards past a chassis's slot count
  var before = deviceLabel(d), cards = cardList(), at = oldIdx[0];
  cards.splice(at, oldIdx.length);   // d's cards are consecutive (ensureDevices keeps them so)
  Array.prototype.splice.apply(cards, [at, 0].concat(fresh));
  d.model = key;
  extra.forEach(function (e) { e.name = newProcName(P.devices.concat(extra.filter(function (x) { return x.name; })), e.model); });
  Array.prototype.splice.apply(P.devices, [P.devices.indexOf(d) + 1, 0].concat(extra));
  var pinned = applyCards(cards);
  log('set_processor_model', { processor: before, to: m.name, cards: cardsOfDevice(d).map(function (i) { return i + 1; }),
    cascaded: extra.length ? extra.length + 1 + ' units' : undefined, dropped: dropped.length ? dropped.map(function (i) { return i + 1; }) : undefined });
  commit(); renderAll();
  var msg = before + ' → ' + m.name;
  if (extra.length) msg = before + ' → ' + (extra.length + 1) + ' cascaded ' + m.name + ' units (one per ' + (m.cards === 1 ? 'card' : m.cards + ' cards') + ')';
  if (dropped.length) msg += ' · ' + m.name + ' holds ' + m.slots + ' output cards, so unused card' + (dropped.length > 1 ? 's ' : ' ') +
    dropped.map(function (i) { return i + 1; }).join(', ') + (dropped.length > 1 ? ' were' : ' was') + ' removed';
  cardChangeToast(msg, pinned);
}

// Change the type of output card i (H series).
function setOutputCardType(i, type) {
  var c = P.processors[i], d = deviceOfCard(i); if (!c || !d || !OUTPUT_CARDS[type]) return;
  var need = wiredCards()[i] || 0, t = OUTPUT_CARDS[type];
  if (need > t.ports) return toast(cardName(i) + ' uses port ' + need + ' — a ' + t.name + ' has ' + t.ports);
  var snap = snapshotAutoSections();
  log('set_output_card', { card: i + 1, from: cardTypeLabel(c), to: t.name });
  c.type = type; c.ports = t.ports;
  var pinned = keepAutoWiring(snap, sameCard);
  if (ui.mSender === i && (ui.mPort || 0) >= c.ports) ui.mPort = 0;
  commit(); renderAll();
  if (pinned.length) cardChangeToast(cardName(i) + ' is now a ' + t.name, pinned);
}

// Port count of a "Pick a model" card (the Ports field). Refused below the highest wired port.
function setCardPorts(i, n) {
  var c = P.processors[i]; if (!c) return;
  n = clamp(n, 1, MAX_CARD_PORTS);
  if (n === c.ports) return;
  var need = wiredCards()[i] || 0;
  if (n < need) { toast(cardName(i) + ' uses port ' + need + ' — it needs at least ' + need + ' ports'); renderAll(); return; }
  var snap = snapshotAutoSections();
  log('set_card_ports', { card: i + 1, from: c.ports, to: n });
  c.ports = n;
  var pinned = keepAutoWiring(snap, sameCard);
  if (ui.mSender === i && (ui.mPort || 0) >= n) ui.mPort = n - 1;
  commit(); renderAll();
  if (pinned.length) cardChangeToast(cardName(i) + ' now has ' + n + ' ports', pinned);
}

// Move processor d one place earlier (dir -1) or later (+1) in the cascade, or dir places (a
// card dragged in the Processors tab).
function moveProcessor(d, dir) {
  var k = P.devices.indexOf(d), j = k + dir;
  if (k < 0 || j < 0 || j >= P.devices.length) return;
  P.devices.splice(k, 1); P.devices.splice(j, 0, d);
  var cards = cardList(), order = [];
  P.devices.forEach(function (dv) { cards.forEach(function (c) { if (c.dev === dv.id) order.push(c); }); });
  var pinned = applyCards(order);
  log('move_processor', { processor: deviceLabel(d), to: j + 1 });
  commit(); renderAll();
  cardChangeToast(deviceLabel(d) + ' is now number ' + (j + 1) + ' in the cascade — cards renumbered', pinned);
}
