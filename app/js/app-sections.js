// app-sections.js - section, screen and sending-card actions shared by the side panels, the
// tree and the right-click menu: moveSectionTo, movePortsTo, clearAllPorts, freshPorts, duplicateSection,
// deleteSection, setWiringMode, closeScreen, lctNew, addLctScreen, moveLct, lctFitCard, lctShowFor, lctSetDev, lctMenu, addSendingCard, removeSendingCard,
// showScreen; the words for sections (cabCount, cabsText, secLabel, secsLabel) and groups (P.groups, s.group:
// groupById, groupOf, groupMembers, groupSelIds, groupsFix, groupNextName, groupSections, ungroupSections,
// renameGroup, selectGroup).
// Depends on: app-core (P, ui, uid, commit, toast, lctById), app-geometry (cardsUsed,
// cellsOf, allCells, screenBounds), app-capacity (nextFreePort, freePorts, portsOfSender), app-manual-wiring
// (ensureManual), app-render (renderAll).
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ---- Words. The UI never shows a section or its name (user, 2026-10-11: "It should just be cabinets. Then if we
// combine them they become groups."): a section is "these cabinets", or its group's name once grouped.
function cabCount(s) { return cellsOf(s).filter(function (c) { return !c.hole; }).length; }
function cabsText(n) { return n + ' cabinet' + (n === 1 ? '' : 's'); }
function secLabel(s) { var g = groupOf(s); return g ? g.name : cabsText(cabCount(s)); }
function secsLabel(list) {
  var g = list.length && groupOf(list[0]);
  if (g && groupMembers(g).length === list.length && list.every(function (x) { return x.group === g.id; })) return g.name;
  return cabsText(list.reduce(function (n, x) { return n + cabCount(x); }, 0));
}

// ---- Groups (Unico's Ctrl+G): cabinets combined into one named thing that selects and moves as one.
// Data: P.groups = [{ id, name }] and s.group = the group's id on each of its sections. Nothing else reads them:
// .scr / .scfg export, Send, read-back and live apply work on cabinets and ports, so grouping changes no byte sent.
// Older projects have neither field; a group with fewer than one section left, or a stale s.group, is dropped (groupsFix).
function groupById(id) { return id ? (P.groups || []).find(function (g) { return g.id === id; }) : null; }
function groupOf(s) { return s ? groupById(s.group) : null; }
function groupMembers(g) { return g ? P.screens.filter(function (s) { return s.group === g.id; }) : []; }
// The sections a click on s selects: its whole group, or just s.
function groupSelIds(s) { var g = groupOf(s); return g ? groupMembers(g).map(function (x) { return x.id; }) : [s.id]; }
function groupsFix() {
  if (!P.groups) return;
  P.screens.forEach(function (s) { if (s.group && !groupById(s.group)) delete s.group; });
  P.groups = P.groups.filter(function (g) { return groupMembers(g).length; });
}
function groupNextName() {
  var n = 1, names = {};
  (P.groups || []).forEach(function (g) { names[g.name] = 1; });
  while (names['Group ' + n]) n++;
  return 'Group ' + n;
}
// Ctrl+G: the selected cabinets (arrangeTargets, app-arrange.js) become one group; groups they were in are merged in.
function groupSections(list) {
  list = list || arrangeTargets();
  if (!list.length) return toast('Select cabinets first (Ctrl+click to select more)');
  var g0 = groupOf(list[0]);
  if (g0 && list.every(function (s) { return s.group === g0.id; }) && groupMembers(g0).length === list.length) return toast(g0.name + ' is already a group');
  var old = {}; list.forEach(function (s) { if (s.group) old[s.group] = 1; });
  // whole groups that are selected come along as they are; the new group takes the first old group's name
  var g = { id: uid(), name: g0 ? g0.name : groupNextName() };
  P.groups = (P.groups || []).filter(function (x) { return !old[x.id]; });
  P.screens.forEach(function (s) { if (old[s.group]) s.group = g.id; });
  list.forEach(function (s) { s.group = g.id; });
  P.groups.push(g);
  ui.selSecs = new Set(groupSelIds(list[0])); ui.sel = list[0].id;
  log('group', { group: g.name, sections: groupMembers(g).map(function (s) { return s.name; }), merged: Object.keys(old).length });
  commit(); renderAll();
  toast('Grouped ' + secsLabel(groupMembers(g)) + ' as ' + g.name + ' (Ctrl+Shift+G ungroups)');
  return g;
}
// Ctrl+Shift+G: the groups of the selected cabinets are taken apart (the cabinets stay where they are).
function ungroupSections(list) {
  list = list || arrangeTargets();
  var ids = {}; list.forEach(function (s) { if (s.group) ids[s.group] = 1; });
  var gone = (P.groups || []).filter(function (g) { return ids[g.id]; });
  if (!gone.length) return toast('Nothing to ungroup');
  P.screens.forEach(function (s) { if (ids[s.group]) delete s.group; });
  P.groups = P.groups.filter(function (g) { return !ids[g.id]; });
  log('ungroup', { groups: gone.map(function (g) { return g.name; }) });
  commit(); renderAll();
  toast('Ungrouped ' + gone.map(function (g) { return g.name; }).join(', '));
}
function renameGroup(g, name) {
  if (name == null) name = prompt('Group name:', g.name);
  if (name == null || !name.trim() || name.trim() === g.name) return;
  log('rename_group', { from: g.name, to: name.trim() });
  g.name = name.trim(); commit(); renderAll();
}
// Select a group's cabinets (tree click): its screen is shown, its sections become the selection.
function selectGroup(g) {
  var m = groupMembers(g); if (!m.length) return;
  if (m[0].screenId !== ui.viewScreen) showScreen(m[0].screenId);
  ui.selSecs = new Set(m.map(function (s) { return s.id; })); ui.sel = m[0].id;
  log('select_group', { group: g.name, sections: m.length });
  renderAll();
}

// ---- Section actions shared by the side panel and the right-click menu
function moveSectionTo(s, to) {
  if (to === '__new') { var cu = cardsUsed(cellsOf(s)); to = lctNew(cu.length ? deviceOfCard(cu[0]) : null).id; }   // the next screen of its processor
  if (to === s.screenId) return;
  var list = groupOf(s) ? groupMembers(groupOf(s)) : [s];   // a group moves as one
  var own = lctOwner(lctById(to)), bad = own && list.some(function (x) { return cardsUsed(cellsOf(x)).some(function (c) { var d = deviceOfCard(c); return d && d.id !== own.id; }); });
  if (bad) return toast(lctById(to).name + ' belongs to ' + deviceLabel(own) + ': these cabinets are wired to another processor (Move cabinets to ▸ New screen gives them one of their own)');
  log('move_section_to_screen', { section: s.name, sections: list.length, from: (lctById(s.screenId) || {}).name, to: lctById(to).name });
  list.forEach(function (x) { x.screenId = to; }); commit();
  ui.viewScreen = null; showScreen(to); ui.sel = s.id; ui.selSecs = new Set(groupSelIds(s)); renderAll();
  toast(secsLabel(list) + ' moved to ' + lctById(to).name);
}
// Same port numbers and cable order, on another sending card. A section spread over several
// cards keeps that spread: its lowest card goes to `to`, the others shift with it.
function movePortsTo(s, to) {
  var used = cardsUsed(cellsOf(s)), shift = to - (used.length ? used[0] : (s.wiring.sender || 0));
  if (!shift) return toast('These cabinets are already on ' + cardName(to, true));
  if (used.length && used[used.length - 1] + shift >= P.processors.length)
    return toast('These cabinets use ' + used.length + ' cards — add more cards or processors first');
  var ok = lctAllowedCards(s.screenId);   // a screen belongs to one processor: only its cards
  if (ok && used.concat(used.length ? [] : [s.wiring.sender || 0]).some(function (c) { return ok.indexOf(c + shift) < 0; }))
    return toast((lctById(s.screenId) || {}).name + ' belongs to ' + deviceLabel(lctOwner(lctById(s.screenId))) + ': its cabinets go on its own cards only');
  log('move_ports_to_card', { section: s.name, cards_before: used.map(function (c) { return c + 1; }), shift: shift, mode: s.wiring.mode });
  if (s.wiring.mode === 'auto') s.wiring.sender += shift;
  else Object.keys(s.manual).forEach(function (k) { s.manual[k].sender += shift; });
  ui.mSender = (ui.mSender || 0) + shift;
  if (ui.mSender < 0 || ui.mSender >= P.processors.length) ui.mSender = to;
  commit(); renderAll();
  var clash = {}, cellsBy = allCells();
  cellsBy[s.id].forEach(function (c) {
    if (c.sender == null) return;
    P.screens.forEach(function (o) {
      if (o !== s && cellsBy[o.id].some(function (d) { return d.sender === c.sender && d.port === c.port; })) clash[o.id] = o;
    });
  });
  var names = Object.keys(clash).map(function (id) { return secLabel(clash[id]); });
  toast('Cabinets now on ' + cardName(to, true) + (names.length ? ' — but they share ports with ' + names.join(', ') : ''));
}
function clearAllPorts(s) {
  log('clear_all_ports', { section: s.name, panels_wired: Object.keys(s.manual || {}).length });
  ensureManual(s); s.manual = {}; ui.selKeys = new Set();
  commit(); renderAll(); toast('Cleared all ports on these ' + cabsText(cabCount(s)) + ' (Ctrl+Z to undo)');
}
// A copied section gets ports nobody uses yet: auto wiring starts at the next free port; hand
// wiring keeps its shape, each of its ports moved onto a free one (in port order).
function freshPorts(d) {
  var nf = lctFreePort(d.screenId, null); d.wiring.sender = nf.sender; d.wiring.port = nf.port;   // on its screen's processor
  if (d.wiring.mode === 'manual') {
    var used = {}; Object.keys(d.manual).forEach(function (k) { var a = d.manual[k]; used[a.sender + ':' + a.port] = a; });
    var order = Object.keys(used).sort(function (x, y) { var a = used[x], c = used[y]; return a.sender - c.sender || a.port - c.port; });
    var free = freePorts(order.length, lctAllowedCards(d.screenId)), map = {};
    order.forEach(function (pk, i) { map[pk] = free[i]; });
    Object.keys(d.manual).forEach(function (k) { var a = d.manual[k], t = map[a.sender + ':' + a.port]; if (t) { a.sender = t.sender; a.port = t.port; } else delete d.manual[k]; });
  }
}
function duplicateSection(s) {
  var d = JSON.parse(JSON.stringify(s)); d.id = uid(); d.name = s.name + ' copy'; delete d.group;   // a copy is on its own
  var b = screenBounds(s); d.x = b.x + b.w;
  freshPorts(d);
  log('duplicate_section', { from: s.name, copy_at: d.x + ',' + d.y, mode: d.wiring.mode });
  P.screens.push(d); ui.sel = d.id; ui.selSecs = new Set(); commit(); renderAll();
}
// Delete s — with the rest of the selection (a group, or Ctrl+clicked cabinets) when s is part of it.
function deleteSection(s) {
  var list = ui.selSecs && ui.selSecs.has(s.id) ? arrangeTargets() : [s];
  if (list.indexOf(s) < 0) list = [s];
  var what = secsLabel(list), gone = {};
  list.forEach(function (x) { gone[x.id] = 1; });
  log('delete_section', { sections: list.map(function (x) { return x.name; }), screen: (lctById(s.screenId) || {}).name });
  P.screens = P.screens.filter(function (x) { return !gone[x.id]; }); ui.sel = null; ui.selSecs = new Set(); ui.tool = null;
  groupsFix(); commit(); renderAll();
  toast('Deleted ' + what + ' (Ctrl+Z to undo)');
}
function setWiringMode(s, mode) {
  if (s.wiring.mode === mode || (mode === 'auto' && s.kind === 'complex')) return;
  log('wiring_mode', { section: s.name, from: s.wiring.mode, to: mode });
  if (mode === 'manual') ensureManual(s); else s.wiring.mode = 'auto';
  commit(); renderAll();
}

function closeScreen(id) {
  if (P.lct.length < 2) return;
  var lc = lctById(id), secs = P.screens.filter(function (s) { return s.screenId === id; });
  if (secs.length && !confirm('Close ' + lc.name + '? Its ' + cabsText(secs.reduce(function (n, s) { return n + cabCount(s); }, 0)) + ' will be deleted (Ctrl+Z brings them back).')) return log('close_screen', { screen: lc.name, cancelled: true });
  log('close_screen', { screen: lc.name, sections_deleted: secs.map(function (s) { return s.name; }) });
  var ow = lctOwner(lc), rest = ow ? lctScreensOf(ow).filter(function (l) { return l.id !== id; }) : [], stay = rest.filter(function (l) { return l.id === ui.viewScreen; })[0] || rest[0];
  P.screens = P.screens.filter(function (s) { return s.screenId !== id; });
  P.lct = P.lct.filter(function (l) { return l.id !== id; });
  P.processors.forEach(function (c) { if (c.screen === id) { if (stay) c.screen = stay.id; else delete c.screen; } });   // its cards stay on the processor's screen, no new one comes back
  if (ui.viewScreen === id) { ui.viewScreen = stay ? stay.id : null; ui.sel = null; ui.view = null; }
  commit(); renderAll();
  toast('Closed ' + lc.name);
}
// A new screen tab for processor d (NovaLCT: the next screen of that processor's configuration): it goes right after d's last
// screen, so the project's screen order stays d's NovaLCT order (lctScreensOf), and an empty one stays listed under d
// (lc.dev). No d: at the end. Not committed.
function lctNew(d) {
  var n = P.lct.length + 1, names = P.lct.map(function (l) { return l.name; });
  while (names.indexOf('Screen ' + n) >= 0) n++;
  var lc = { id: uid(), name: 'Screen ' + n }, mine = d ? lctScreensOf(d) : [], at = mine.length ? P.lct.indexOf(mine[mine.length - 1]) + 1 : P.lct.length;
  if (d) lc.dev = d.id;
  P.lct.splice(at, 0, lc);
  return lc;
}
// "+ Screen": the next screen of the active processor (the one of the active card on Layout, else the one picked in the tree /
// on the Device tab); its first card becomes the active one, so what is drawn next lands on that processor.
function addLctScreen() {
  var d = typeof pipeActive === 'function' ? pipeActive() : deviceOfCard(ui.mSender || 0) || devSelected();
  var lc = lctNew(d || null), cards = d ? cardsOfDevice(d) : [];
  if (cards.length && cards.indexOf(ui.mSender || 0) < 0) { ui.mSender = cards[0]; ui.mPort = 0; }
  log('add_screen', { screen: lc.name, processor: d ? deviceLabel(d) : undefined, lct_index: d ? lctScreensOf(d).indexOf(lc) + 1 : undefined });
  commit(); ui.viewScreen = null; showScreen(lc.id);
  return lc;
}
// Earlier / Later in its processor's NovaLCT order (dir -1 / 1): swaps places with the processor's screen before / after it
// (the next Send numbers them that way). A screen without a processor moves among all screens.
function moveLct(lc, dir) {
  var ds = lctDevMap()[lc.id] || [], list = ds.length ? lctScreensOf(ds[0]) : P.lct.slice(), i = list.indexOf(lc), o = list[i + dir];
  if (!o) return;
  var a = P.lct.indexOf(lc), b = P.lct.indexOf(o);
  P.lct[a] = o; P.lct[b] = lc;
  log('move_screen', { screen: lc.name, processor: ds[0] ? deviceLabel(ds[0]) : undefined, to: i + dir + 1, of: list.length });
  commit(); renderAll();
  toast(lc.name + (ds[0] ? ' is now screen ' + (i + dir + 1) + ' of ' + deviceLabel(ds[0]) : ' moved') + ' (sent in this order)');
}
// The active card stays on the shown screen's processor (fixSel calls this on every render): a screen belongs to one
// processor, so the card pickers, the port list and drawing all work on that processor's cards.
function lctFitCard() {
  var lc = lctById(ui.viewScreen); if (!lc) return;
  var cab = lctCabDevs(null, lc.id), own = lctOwner(lc, cab), d = deviceOfCard(ui.mSender || 0);
  if (own && d && d.id !== own.id && !cab[lc.id].some(function (x) { return x.id === d.id; })) {
    var cards = cardsOfDevice(own);
    if (cards.length) { ui.mSender = cards[0]; ui.mPort = firstFreePort(cards[0], portUsage(allCells())); }
  }
  lctFollowCard();
}
// H series: which screen a sending card draws on is the user's choice (2026-11-06: "when i select the second card i should see
// that cards screen"; "put the second sending card or fifth sending card ... on the same screen or a different screen if I
// want"). P.processors[i].screen = the chosen screen; a card with none gets a screen of its own when it is selected. A screen
// is on its chosen cards and the cards its cabinets are wired to, so one that already spans cards stays as it is.
function cardHasScreen(d) { return !!d && procModel(d.model).family === 'H series'; }
function lctCards(lc) {
  var on = {};
  P.processors.forEach(function (c, i) { if (c.screen === lc.id) on[i] = 1; });
  P.screens.forEach(function (s) { if (s.screenId === lc.id) cellsOf(s).forEach(function (c) { if (c.sender != null && !c.hole) on[c.sender] = 1; }); });
  return Object.keys(on).map(Number);
}
// The screen card is on: the one chosen, else the first with its cabinets.
function cardScreen(card) {
  var d = deviceOfCard(card), c = P.processors[card], lc = c && lctById(c.screen);
  return lc || (d ? lctScreensOf(d).filter(function (x) { return lctCards(x).indexOf(card) >= 0; })[0] : null) || null;
}
// fixSel, on every render: whichever of the active card and the shown screen just changed, the other follows it (every place
// that picks a card or a screen only sets ui.mSender / ui.viewScreen). An empty shown screen takes the card as it is.
function lctFollowCard() {
  var seen = ui.cardSeen, card = ui.mSender || 0, view = ui.viewScreen, d = deviceOfCard(card), lc = lctById(view);
  ui.cardSeen = { card: card, view: view };
  if (!seen || (seen.card === card && seen.view === view) || !cardHasScreen(d) || !lc) return;
  var own = lctOwner(lc), mine = lctCards(lc), to = cardScreen(card);
  if ((own && own.id !== d.id) || mine.indexOf(card) >= 0 || (!mine.length && !to)) return;
  if (seen.card === card) {
    if (mine.length) { ui.mSender = mine[0]; ui.mPort = firstFreePort(mine[0], portUsage(allCells())); ui.cardSeen.card = mine[0]; }
    return;
  }
  if (!to) {
    to = lctNew(d); P.processors[card].screen = to.id;
    log('add_screen', { screen: to.name, processor: deviceLabel(d), card: card + 1, why: 'a sending card gets its own screen' }); commit();
  }
  ui.viewScreen = to.id; ui.view = null; ui.selKeys = new Set(); ui.selScreen = null; ui.sel = null; ui.cardSeen.view = to.id;
}
// Put card on screen `to` ('__new' = a new one). Its cabinets go with it, beside what the screen already shows; cabinets that
// share a section (or a group) with another card stay where they are. A screen left with nothing is closed.
function cardToScreen(card, to) {
  var d = deviceOfCard(card); if (!cardHasScreen(d)) return;
  var dest = to === '__new' ? lctNew(d) : lctById(to); if (!dest) return;
  var alone = function (s) { var u = cardsUsed(cellsOf(s)); return u.length === 1 && u[0] === card; };
  var here = P.screens.filter(function (s) { return s.screenId !== dest.id && cardsUsed(cellsOf(s)).indexOf(card) >= 0; });
  var go = here.filter(function (s) { return (groupOf(s) ? groupMembers(groupOf(s)) : [s]).every(alone); }), from = {};
  var there = P.screens.filter(function (s) { return s.screenId === dest.id; });
  var right = there.reduce(function (m, s) { var b = screenBounds(s); return Math.max(m, b.x + b.w); }, 0);
  var left = go.reduce(function (m, s) { return Math.min(m, screenBounds(s).x); }, Infinity);
  go.forEach(function (s) { from[s.screenId] = 1; s.screenId = dest.id; if (there.length) s.x += right - left; });
  var was = P.processors[card].screen; if (was) from[was] = 1;
  P.processors[card].screen = dest.id;
  P.lct = P.lct.filter(function (lc) { return !from[lc.id] || lc.id === dest.id || P.lct.length < 2 || lctCards(lc).length || P.screens.some(function (s) { return s.screenId === lc.id; }); });
  ui.mSender = card; ui.mPort = firstFreePort(card, portUsage(allCells())); ui.viewScreen = dest.id; ui.view = null; ui.sel = null; ui.selKeys = new Set(); ui.selScreen = null;
  log('card_to_screen', { card: card + 1, processor: deviceLabel(d), screen: dest.name, sections_moved: go.length, sections_left: here.length - go.length });
  commit(); renderAll();
  toast(cardName(card) + ' is on ' + dest.name + (here.length > go.length ? ' — cabinets sharing a section with another card stayed where they were' : ''));
}
// Screen ▸ for a card: its processor's screens (● = it is on that one), or a new one.
function cardScreenItems(card) {
  var d = deviceOfCard(card), now = cardScreen(card);
  return lctScreensOf(d).map(function (lc) { return { label: (now === lc ? '● ' : '    ') + lc.name, disabled: now === lc, act: function () { cardToScreen(card, lc.id); } }; })
    .concat([{ label: 'New screen', act: function () { cardToScreen(card, '__new'); } }]);
}
// The screen to draw on with sending card `card`: the one shown when it is that card's processor's (or nobody's yet), else
// that processor's first screen, else a new screen for it. It becomes the shown screen.
function lctShowFor(card) {
  var d = deviceOfCard(card), cur = lctById(ui.viewScreen); if (!d) return cur;
  var own = lctOwner(cur), lc = !own || own.id === d.id ? cur : lctScreensOf(d)[0];
  if (!lc) { lc = lctNew(d); log('add_screen', { screen: lc.name, processor: deviceLabel(d), why: 'its first screen' }); commit(); }
  if (lc !== cur) { ui.viewScreen = lc.id; ui.view = null; ui.selKeys = new Set(); ui.selScreen = null; ui.sel = null; }
  return lc;
}
// Give screen lc to processor d: the whole screen moves. Auto-wired cabinets start again on d's first free port; hand wiring
// can't carry over to other cards, so it is cleared (asks first).
function lctSetDev(lc, d) {
  var own = lctOwner(lc); if (own && own.id === d.id) return;
  var secs = P.screens.filter(function (s) { return s.screenId === lc.id; }), cards = cardsOfDevice(d);
  var hand = secs.filter(function (s) { return s.wiring.mode !== 'auto' || s.kind === 'complex'; }).reduce(function (n, s) { return n + Object.keys(s.manual || {}).length; }, 0);
  if (!cards.length) return toast(deviceLabel(d) + ' has no cards');
  if (hand && !confirm('Move ' + lc.name + ' to ' + deviceLabel(d) + '?\n\nThe wiring of its ' + hand + ' hand-wired cabinet' + (hand === 1 ? '' : 's') + ' is cleared: wire them again on ' + deviceLabel(d) + '’s ports. Ctrl+Z undoes it.'))
    return log('screen_processor', { screen: lc.name, to: deviceLabel(d), cancelled: true });
  secs.forEach(function (s) {
    if (s.wiring.mode === 'auto' && s.kind !== 'complex') { var nf = nextFreePort(s.id, cards[0]); if (cards.indexOf(nf.sender) < 0) nf = { sender: cards[0], port: 0 }; s.wiring.sender = nf.sender; s.wiring.port = nf.port; }
    else s.manual = {};
  });
  lc.dev = d.id; ui.mSender = cards[0]; ui.mPort = 0;
  log('screen_processor', { screen: lc.name, from: own ? deviceLabel(own) : undefined, to: deviceLabel(d), hand_wiring_cleared: hand });
  commit(); renderAll();
  toast(lc.name + ' is now ' + deviceLabel(d) + '’s' + (hand ? ' — wire its ' + hand + ' hand-wired cabinets again' : ''));
}
// Right-click a screen in the tree: its place in the processor's order, a new screen of that processor.
function lctMenu(e, lc, d) {
  e.preventDefault();
  var ds = lctDevMap()[lc.id] || [], own = d || ds[0], list = own ? lctScreensOf(own) : P.lct, i = list.indexOf(lc);
  openMenu(e.clientX, e.clientY, [
    { header: lc.name + (own ? ' · ' + deviceLabel(own) + ' screen ' + (i + 1) : '') },
    { label: 'Earlier', disabled: i <= 0, act: function () { moveLct(lc, -1); } },
    { label: 'Later', disabled: i < 0 || i >= list.length - 1, act: function () { moveLct(lc, 1); } },
    { label: 'Processor', sub: (typeof olShownDevices === 'function' ? olShownDevices() : P.devices).map(function (x) { return { label: (own && own.id === x.id ? '● ' : '    ') + deviceLabel(x), act: function () { lctSetDev(lc, x); } }; }) },
    { sep: true },
    { label: '+ Screen' + (own ? ' on ' + deviceLabel(own) : ''), act: function () { if (own) { ui.devSel = own.id; var c = cardsOfDevice(own); if (c.length && c.indexOf(ui.mSender || 0) < 0) { ui.mSender = c[0]; ui.mPort = 0; } } addLctScreen(); } }
  ]);
}

// ---- Sending cards (numbered like NovaLCT: card 1 = sender index 0, up to MAX_CARD_PORTS ports).
// They belong to processors (app-processors.js). Adding goes to the active card's processor
// (an H-series output card, or a card of a "Pick a model" processor); a fixed-model processor cascades
// another unit of the same model instead.
function addSendingCard() {
  var d = deviceOfCard(ui.mSender || 0) || P.devices[P.devices.length - 1];
  if (!d) return devOpenPicker();   // no processor yet: add one (app-devices.js)
  if (procModel(d.model).kind === 'fixed') return addProcessor(d.model, null, d);   // another unit, right after this one
  addOutputCard(d);
}
// Refused while anything is wired to it; the cards after it move up one number, wiring and all.
// The last card of a processor removes the processor.
function removeSendingCard(i) {
  if (!P.processors[i]) return;
  var d = deviceOfCard(i);
  if (!d) return;
  if (procModel(d.model).kind === 'fixed' || cardsOfDevice(d).length === 1) return removeProcessor(d);
  var cellsBy = allCells(), inUse = P.screens.some(function (s) { return cellsBy[s.id].some(function (c) { return c.sender === i; }); });
  if (inUse) { log('remove_card', { card: i + 1, refused: 'wired' }); return toast(cardName(i) + ' has cabinets wired to it — move or clear its ports first'); }
  var mine = cardsOfDevice(d), wasActive = (ui.mSender || 0) === i, gone = cardName(i, true);
  log('remove_card', { processor: deviceLabel(d), card: i + 1, renumbered: P.processors.length - 1 - i });
  var pinned = applyCards(cardList().filter(function (c) { return c.old !== i; }));
  // the removed card was the active one: stay on this processor (its previous card, else its next)
  if (wasActive) { ui.mSender = i > mine[0] ? i - 1 : i; ui.mPort = 0; }
  if ((ui.mPort || 0) >= portsOfSender(ui.mSender)) ui.mPort = 0;
  commit(); renderAll();
  cardChangeToast('Removed ' + gone + ' from ' + deviceLabel(d) + (i < P.processors.length ? '; later cards were renumbered' : ''), pinned);
}

function showScreen(id) {
  if (id === ui.viewScreen) return;
  log('show_screen', { screen: (lctById(id) || {}).name });
  ui.viewScreen = id; ui.view = null;
  ui.selKeys = new Set(); ui.selScreen = null; ui.sel = null;
  renderAll();
}
