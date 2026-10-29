// app-backup.js - redundancy planning: the right panel's Backup card, and the backup badges in
// the tree and the port list. Project data: P.backup = { mode, pairs, cards } (card / port
// numbers 0-based, like the wiring).
//   mode 'port'  Port backup: pairs = [{ ms, mp, bs, bp }] = primary sending card / port -> backup
//                sending card / port. Picked like NovaLCT's redundancy Add dialog: a primary set
//                (card + ports) and a backup set (card + first port), added as pairs; or Auto (a card's
//                first half -> its second half, or card -> card port for port); or pairs clicked by
//                hand in the diagram. bkPairErr holds the rules the Send checks. Only project data for a
//                later hardware send (LCT's redundancy table 0x02300000, Unico PUT
//                screen/netport-backup): the .scr doesn't change, because the processor copies the
//                primary's layout onto the backup ports itself.
//   mode 'card'  Sending-card backup: cards = [{ ms, bs }]. A backup card needs its own mapping,
//                so "Create backup screens" adds, for every LCT screen that uses a primary card,
//                a copy screen (lct.backupOf = source screen id) whose sections (section.backupOf
//                = source section id) sit at the same place with the same ports, pattern and
//                cable order, on the backup card. Re-running updates those copies; they export as
//                ordinary extra screens (3 screens -> 6 in the .scr).
//   mode 'none'  (or no P.backup) nothing; the lists are kept.
// Owns: BACKUP_MODES, bkCardWord, renderBackup, backupRole, backupTileBadge, backupTreeBadge, backupProblems,
// remapBackup, bkExportName, bkRead, bkData, bkSetMode, bkPrimaryUse, bkCardBusy, bkPairErr, bkAddPairs, bkRemovePairs,
// bkSetText, bkAutoList, bkSetList, bkCardIssues, bkPortIssues, bkCopySection, bkSameAsg,
// bkPlan, bkAddCards, bkBuildScreens, bkDropBackupScreen, bkRemoveScreens, bkSuggestCards,
// bkPortHtml, bkDiagram, bkCardHtml, bkOnClick, bkOnChange; ui.bkA / ui.bkB
// (primary / backup card: the sets and the port diagram), ui.bkPf / ui.bkPt / ui.bkBf (the sets' ports, 0-based;
// null = Auto's), ui.bkArm (primary port picked, waiting for its backup).
// Depends on: app-core (P, ui, $, uid, int, esc, log, commit, toast, keysText, lctById), app-capacity
// (portsOfSender, portLabel, portColor, portUsage, screenById), app-geometry (allCells,
// cellsOf), app-autowire (autoAssign), app-processors (deviceOfCard, procModel, cardsOfDevice,
// addProcessor, addOutputCard), app-devices (cardOptionGroups: the card pickers, grouped by processor),
// app-render (renderAll), app-tips (itip), all at run time.
// Called from: renderAll (renderBackup), app-tree (backupTreeBadge), app-portlist
// (backupTileBadge), app-capacity problems (backupProblems), app-processors
// remapProjectSenders (remapBackup), app-scr-io toScrModel (bkExportName).
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

var BACKUP_MODES = [
  ['none', 'None', 'No backup'],
  ['port', 'Port', 'Port backup: every primary port gets a spare port that takes over if its cable fails. The processor copies the layout onto the spare ports itself, so the .scr doesn’t change.'],
  ['card', 'Sending card', 'A whole spare card (or processor) with its own copy of the screens: each screen is exported twice, the copy on the backup.']
];

// The whole-card backup mode's name: "Sending card" only when an H series / MX chassis is in the project, else "Processor".
function bkCardWord() { return P.processors.some(function (c, i) { var d = deviceOfCard(i); return d && procModel(d.model).kind === 'chassis'; }) ? 'Sending card' : 'Processor'; }

// P.backup without changing the project (for drawing) / created on first use (for edits).
function bkRead() {
  var b = P.backup || {};
  return { mode: b.mode || 'none', pairs: b.pairs || [], cards: b.cards || [] };
}
function bkData() {
  if (!P.backup) P.backup = { mode: 'none', pairs: [], cards: [] };
  if (!P.backup.pairs) P.backup.pairs = [];
  if (!P.backup.cards) P.backup.cards = [];
  return P.backup;
}
function bkSetMode(m) {
  var b = bkData();
  if (b.mode === m) return;
  log('backup_mode', { from: b.mode, to: m, pairs: b.pairs.length, card_pairs: b.cards.length });
  b.mode = m; ui.bkArm = null;
  commit(); renderAll();
}
// card index -> highest port number (1-based) wired by the project's own sections (backup copies left out)
function bkPrimaryUse(cellsBy) {
  var out = {};
  P.screens.forEach(function (s) {
    if (s.backupOf) return;
    cellsBy[s.id].forEach(function (c) { if (c.sender != null) out[c.sender] = Math.max(out[c.sender] || 0, c.port + 1); });
  });
  return out;
}
function bkUniq(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

// ------------------------------------------------------------------ roles and badges
// What port (sender, port) is in the active backup mode: null, or { backup: true/false, s, p } =
// the port it backs up / the port backing it up (card: true for a sending-card backup).
function backupRole(sender, port) {
  var b = P.backup, i;
  if (!b) return null;
  if (b.mode === 'port') {
    for (i = 0; i < (b.pairs || []).length; i++) {
      var q = b.pairs[i];
      if (q.bs === sender && q.bp === port) return { backup: true, s: q.ms, p: q.mp };
      if (q.ms === sender && q.mp === port) return { backup: false, s: q.bs, p: q.bp };
    }
  } else if (b.mode === 'card') {
    for (i = 0; i < (b.cards || []).length; i++) {
      var c = b.cards[i];
      if (c.bs === sender) return { backup: true, s: c.ms, p: port, card: true };
      if (c.ms === sender) return { backup: false, s: c.bs, p: port, card: true };
    }
  }
  return null;
}
// Port list tile badge: "B" on a backup port, "P" on a primary port that has a backup.
function backupTileBadge(sender, port) {
  var r = backupRole(sender, port);
  if (!r) return '';
  var tip = r.backup ? 'Backup port for ' + portLabel(r.s, r.p) + (r.card ? ' (' + bkCardWord().toLowerCase() + ' backup)' : '') + ' — keep it free of cabinets'
    : 'Backed up by ' + portLabel(r.s, r.p) + (r.card ? ' (' + bkCardWord().toLowerCase() + ' backup)' : '');
  return '<span class="pt-bk' + (r.backup ? '' : ' pri') + '" title="' + esc(tip) + '">' + (r.backup ? 'B' : 'P') + '</span>';
}
// Tree badge for a screen (kind 'lct', x = screen id) or a sending card (kind 'card', x = index).
function backupTreeBadge(kind, x) {
  if (kind === 'lct') {
    var lc = lctById(x);
    if (!lc || !lc.backupOf) return '';
    var src = lctById(lc.backupOf);
    return '<span class="tn-bk" title="' + esc('Backup copy of ' + (src ? src.name : 'a screen that was closed') + ' on the backup card(s). Backup card → Update backup screens refreshes it.') + '">B</span>';
  }
  var b = bkRead();
  if (b.mode === 'card') {
    var c = b.cards.find(function (k) { return k.bs === x || k.ms === x; });
    if (!c) return '';
    return c.bs === x ? '<span class="tn-bk" title="Backup for ' + cardName(c.ms, true) + '">B</span>'
      : '<span class="tn-bk pri" title="Backed up by ' + cardName(c.bs, true) + '">P</span>';
  }
  if (b.mode === 'port') {
    var bak = b.pairs.filter(function (q) { return q.bs === x; }), pri = b.pairs.filter(function (q) { return q.ms === x; });
    if (bak.length) return '<span class="tn-bk" title="' + esc(bak.length + ' backup port' + (bak.length === 1 ? '' : 's') + ' on this card: ' +
      bak.slice(0, 8).map(function (q) { return 'P' + (q.bp + 1) + ' for ' + portLabel(q.ms, q.mp); }).join(', ') + (bak.length > 8 ? ' …' : '')) + '">B</span>';
    if (pri.length) return '<span class="tn-bk pri" title="' + pri.length + ' port' + (pri.length === 1 ? '' : 's') + ' on this card have a backup port">P</span>';
  }
  return '';
}

// Name a screen is exported with (app-scr-io toScrModel). A backup screen still named
// "<source> (backup)" is written with its source's name, so it is an exact copy in NovaLCT (LCT
// keeps only 10 characters: "Main (back" would be no help); a backup screen renamed by hand keeps
// the new name.
function bkExportName(lc) {
  var src = lc.backupOf && lctById(lc.backupOf);
  return src && lc.name === src.name + ' (backup)' ? src.name : lc.name;
}

// Problems for the status line and the export check (cheap: runs on every redraw).
function backupProblems(use) {
  var b = bkRead(), out = [];
  if (b.mode === 'port') {
    b.pairs.forEach(function (q) {
      var lb = portLabel(q.bs, q.bp);
      if (q.bs >= P.processors.length) out.push('Backup port ' + lb + ': there is no ' + cardName(q.bs, true));
      else if (q.bp >= portsOfSender(q.bs)) out.push('Backup port ' + lb + ': ' + cardName(q.bs, true) + ' has only ' + portsOfSender(q.bs) + ' ports');
      else if (q.ms === q.bs && q.mp === q.bp) out.push(lb + ' can’t back itself up');
      else if (q.ms < P.processors.length && deviceOfCard(q.ms) !== deviceOfCard(q.bs)) out.push(portLabel(q.ms, q.mp) + ' → ' + lb + ' reaches another processor');
      else if (use[q.bs + ':' + q.bp]) out.push(lb + ' is the backup of ' + portLabel(q.ms, q.mp) + ' but has cabinets wired');
      else if (q.ms !== q.bs && bkCardBusy(q.bs, use)) out.push(cardName(q.bs) + ' backs up ' + cardName(q.ms, true) + ' but has cabinets of its own: a backup on another card needs a free card');
    });
  } else if (b.mode === 'card') {
    b.cards.forEach(function (c) {
      var own = Object.keys(use).filter(function (k) {
        var u = use[k];
        return u.sender === c.bs && Object.keys(u.screens).some(function (id) { var s = screenById(id); return s && !s.backupOf; });
      });
      if (own.length) out.push(cardName(c.bs) + ' is the backup of ' + cardName(c.ms, true) + ' but has cabinets of its own wired');
    });
  }
  return out;
}

// Sending cards were renumbered (app-processors remapProjectSenders): mw(old) = new number;
// map[old] is missing for a card that was removed, and its pairs are dropped. A card number past
// the last card (a backup card that isn't added yet) keeps its number, so adding cards makes it real.
function remapBackup(pj, mw, map, oldLen) {
  var b = pj.backup;
  if (!b) return;
  function gone(i) { return i < oldLen && map[i] == null; }
  function m(i) { return i >= oldLen ? i : mw(i); }
  var n0 = (b.pairs || []).length + (b.cards || []).length;
  b.pairs = (b.pairs || []).filter(function (q) { return !gone(q.ms) && !gone(q.bs); })
    .map(function (q) { return { ms: m(q.ms), mp: q.mp, bs: m(q.bs), bp: q.bp }; });
  b.cards = (b.cards || []).filter(function (c) { return !gone(c.ms) && !gone(c.bs); })
    .map(function (c) { return { ms: m(c.ms), bs: m(c.bs) }; });
  var dropped = n0 - b.pairs.length - b.cards.length;
  if (dropped) log('backup_pairs_dropped', { pairs: dropped, reason: 'their sending card was removed' });
}

// ------------------------------------------------------------------ port backup
// card i drives panels on any port
function bkCardBusy(i, use) { return Object.keys(use).some(function (k) { return use[k].sender === i; }); }
// The rules a list of new pairs must keep — the ones the LCT Send checks (hwsend.js), shown here before a Send: the
// ports exist, a port can't back itself up, both ends on one processor, a backup port carries no panels and isn't
// also a primary in the list, and a backup on another sending card needs a card without panels (NovaLCT copies the
// primary card's whole layout onto it). '' = fine.
function bkPairErr(list, use) {
  var pri = {}, i, q;
  for (i = 0; i < list.length; i++) {
    q = list[i];
    if (q.ms >= P.processors.length || q.bs >= P.processors.length) return 'that card isn’t added';
    if (q.mp >= portsOfSender(q.ms)) return cardName(q.ms) + ' has ' + portsOfSender(q.ms) + ' ports';
    if (q.bp >= portsOfSender(q.bs)) return cardName(q.bs) + ' has ' + portsOfSender(q.bs) + ' ports';
    if (q.ms === q.bs && q.mp === q.bp) return 'a port can’t back itself up';
    if (deviceOfCard(q.ms) !== deviceOfCard(q.bs)) return 'the backup must be on the same processor';
    pri[q.ms + ':' + q.mp] = 1;
  }
  var both = list.filter(function (q) { return pri[q.bs + ':' + q.bp]; });
  if (both.length) return portLabel(both[0].bs, both[0].bp) + ' would be a primary and a backup';
  var busy = list.filter(function (q) { return use[q.bs + ':' + q.bp]; }).map(function (q) { return portLabel(q.bs, q.bp); });
  if (busy.length) return busy.slice(0, 4).join(', ') + (busy.length > 4 ? ' …' : '') + (busy.length > 1 ? ' have' : ' has') + ' cabinets: a backup port must be free';
  var cross = list.filter(function (q) { return q.ms !== q.bs && bkCardBusy(q.bs, use); })[0];
  if (cross) return cardName(cross.bs) + ' has cabinets: a backup on another card needs a free card (or use free ports on the same card)';
  return '';
}
// Add pairs (list of {ms, mp, bs, bp}); any old pair that uses one of their ports is replaced. Refused when they
// break a rule (bkPairErr).
function bkAddPairs(list, what) {
  if (!list.length) return toast('Nothing to pair');
  var b = bkData(), err = bkPairErr(list, portUsage(allCells()));
  if (err) { log('backup_pairs', { what: what, refused: err }); return toast('Can’t pair: ' + err); }
  function hit(q, n) {
    return (q.ms === n.ms && q.mp === n.mp) || (q.bs === n.bs && q.bp === n.bp) || (q.ms === n.bs && q.mp === n.bp) || (q.bs === n.ms && q.bp === n.mp);
  }
  var before = b.pairs.length;
  b.pairs = b.pairs.filter(function (q) { return !list.some(function (n) { return hit(q, n); }); })
    .concat(list.map(function (n) { return { ms: n.ms, mp: n.mp, bs: n.bs, bp: n.bp }; }));
  b.pairs.sort(function (x, y) { return x.ms - y.ms || x.mp - y.mp; });
  var replaced = before - (b.pairs.length - list.length);
  log('backup_pairs', { what: what, added: list.length, replaced: replaced, total: b.pairs.length,
    first: portLabel(list[0].ms, list[0].mp) + ' → ' + portLabel(list[0].bs, list[0].bp) });
  commit(); renderAll();
  return true;
}
function bkRemovePairs(test, what) {
  var b = bkData(), n = b.pairs.length;
  b.pairs = b.pairs.filter(function (q) { return !test(q); });
  if (b.pairs.length === n) return;
  log('backup_pairs_removed', { what: what, removed: n - b.pairs.length, left: b.pairs.length });
  commit(); renderAll();
  toast('Removed ' + (n - b.pairs.length) + ' backup pair' + (n - b.pairs.length === 1 ? '' : 's') + ' (Ctrl+Z to undo)');
}
// "S1 P1–P8 → S1 P9–P16" for a run of pairs (consecutive ports on both sides)
function bkSetText(list) {
  var a = list[0], z = list[list.length - 1];
  if (!a) return '';
  return portLabel(a.ms, a.mp) + (z !== a ? '–P' + (z.mp + 1) : '') + ' → ' + portLabel(a.bs, a.bp) + (z !== a ? '–P' + (z.bp + 1) : '');
}
// Auto, the user's way: on one card the first half backed up by the second (P1 -> P(n/2+1) …, Unico's Split);
// card A -> another card B port for port (1 -> 1 … N -> N, N = the smaller card's ports).
function bkAutoList(A, B) {
  var nA = portsOfSender(A), h = Math.floor(nA / 2), n = A === B ? h : Math.min(nA, portsOfSender(B)), list = [];
  for (var p = 0; p < n; p++) list.push({ ms: A, mp: p, bs: B, bp: A === B ? p + h : p });
  return list;
}
// The two sets, as in NovaLCT's redundancy Add dialog (primary card + ports, backup card + port, there one pair at a
// time): primary ports f…t of card A -> backup ports bf… of card B. Unset ports start as Auto's.
function bkSetList(A, B) {
  var auto = bkAutoList(A, B), a = auto[0] || { mp: 0, bp: 0 }, z = auto[auto.length - 1] || a, nA = portsOfSender(A);
  var f = ui.bkPf != null ? ui.bkPf : a.mp, t = ui.bkPt != null ? ui.bkPt : z.mp, bf = ui.bkBf != null ? ui.bkBf : a.bp;
  f = Math.max(0, Math.min(f, nA - 1)); t = Math.max(f, Math.min(t, nA - 1)); bf = Math.max(0, Math.min(bf, Math.max(0, portsOfSender(B) - 1)));
  var list = [];
  for (var p = f; p <= t; p++) list.push({ ms: A, mp: p, bs: B, bp: bf + p - f });
  return { f: f, t: t, bf: bf, list: list };
}
function bkPortIssues(use) {
  var b = bkRead(), err = backupProblems(use).slice(), warn = [], seenB = {}, seenP = {};
  b.pairs.forEach(function (q) {
    var pk = q.ms + ':' + q.mp, bk = q.bs + ':' + q.bp;
    if (seenB[bk]) err.push(portLabel(q.bs, q.bp) + ' is the backup of two ports');
    if (seenP[pk]) err.push(portLabel(q.ms, q.mp) + ' has two backup ports');
    seenB[bk] = 1; seenP[pk] = 1;
  });
  b.pairs.forEach(function (q) {
    if (seenB[q.ms + ':' + q.mp]) err.push(portLabel(q.ms, q.mp) + ' is both a primary and a backup port');
  });
  if (b.pairs.some(function (q) { return q.ms !== q.bs; }))
    warn.push('Pairs across two cards work, but NovaLCT’s Verify backup only tests pairs on one card.');
  bkUniq(b.pairs.map(function (q) { return q.bs; }).concat(b.pairs.map(function (q) { return q.ms; }))).forEach(function (i) {
    if ((P.processors[i] || {}).type === 'h4fiber')
      warn.push(cardName(i) + ' is a 4× fiber card: it has 32 ports only when set to 32-port mode, otherwise 16. Check the card before pairing ports 17–32.');
  });
  return { err: bkUniq(err), warn: bkUniq(warn) };
}

// ------------------------------------------------------------------ sending-card backup
// The backup copy of section s (cells = cellsOf(s)): same place and cable order, senders mapped
// through map (primary -> backup); panels on a card without a backup become blanks. An auto
// section stays auto when its copy wires exactly the same way, else the copy is Manual.
// null when s uses none of the primary cards.
function bkCopySection(s, cells, map, screenId, id) {
  if (!cells.some(function (c) { return c.sender != null && map[c.sender] != null; })) return null;
  var d = JSON.parse(JSON.stringify(s)), want = {}, holes = false;
  d.id = id || uid(); d.screenId = screenId; d.backupOf = s.id;
  d.holes = d.holes || {};
  if (map[s.wiring.sender] != null) d.wiring.sender = map[s.wiring.sender];
  cells.forEach(function (c) {
    if (c.sender == null) return;
    if (map[c.sender] != null) want[c.k] = { sender: map[c.sender], port: c.port, connect: c.connect };
    else { d.holes[c.k] = true; holes = true; }
  });
  if (s.wiring.mode === 'auto' && s.kind !== 'complex' && !holes && map[s.wiring.sender] != null) {
    d.wiring.sender = map[s.wiring.sender];
    var same = bkSameAsg(autoAssign(d), want);
    if (!id) delete ui.autoErr[d.id];   // (a trial id; allCells redoes it once the copy is in the project)
    if (same) return d;
  }
  d.wiring.mode = 'manual'; d.manual = want;
  return d;
}
function bkSameAsg(a, b) {
  var ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(function (k) {
    var x = a[k], y = b[k];
    return y && x.sender === y.sender && x.port === y.port && x.connect === y.connect;
  });
}
// What "Create backup screens" would do: entries [{ src, bl (its backup screen or null), copies
// (null when src uses no primary card), unbacked (other cards src uses), fresh (bl already
// matches) }] and stale backup screens whose source is gone.
function bkPlan(cellsBy) {
  var map = {}, entries = [], stale = [];
  bkRead().cards.forEach(function (c) { map[c.ms] = c.bs; });
  P.lct.forEach(function (lc) {
    if (lc.backupOf) { if (!lctById(lc.backupOf)) stale.push(lc); return; }
    var bl = P.lct.find(function (l) { return l.backupOf === lc.id; }) || null;
    var old = bl ? P.screens.filter(function (s) { return s.screenId === bl.id && s.backupOf; }) : [];
    var copies = [], unbacked = {};
    P.screens.forEach(function (s) {
      if (s.screenId !== lc.id || s.backupOf) return;
      var prev = old.find(function (o) { return o.backupOf === s.id && copies.every(function (d) { return d.id !== o.id; }); });
      var d = bkCopySection(s, cellsBy[s.id], map, bl ? bl.id : null, prev ? prev.id : null);
      cellsBy[s.id].forEach(function (c) { if (c.sender != null && map[c.sender] == null) unbacked[c.sender] = 1; });
      if (d) copies.push(d);
    });
    if (!copies.length) copies = null;
    var fresh = copies ? !!bl && JSON.stringify(copies) === JSON.stringify(old) : !bl;
    entries.push({ src: lc, bl: bl, copies: copies, unbacked: Object.keys(unbacked).map(Number).sort(function (a, b) { return a - b; }), fresh: fresh });
  });
  return { entries: entries, stale: stale };
}
function bkCardIssues(cellsBy) {
  var b = bkRead(), err = [], warn = [], missing = [], prim = bkPrimaryUse(cellsBy), cnt = {}, cntB = {};
  b.cards.forEach(function (c) { cnt[c.ms] = (cnt[c.ms] || 0) + 1; cntB[c.bs] = (cntB[c.bs] || 0) + 1; });
  b.cards.forEach(function (c) {
    var A = cardName(c.ms), B = cardName(c.bs);   // "Sending card 2" on a chassis, the processor's name on a fixed one
    if (c.ms === c.bs) { err.push(A + ' can’t be its own backup'); return; }
    if (cnt[c.ms] > 1) err.push(A + ' has two backups');
    if (cntB[c.bs] > 1) err.push(B + ' is the backup of two cards');
    if (cnt[c.bs]) err.push(B + ' is both a primary and a backup');
    if (c.ms >= P.processors.length) err.push(A + ' isn’t added');
    else if (!prim[c.ms]) warn.push(A + ' has no cabinets yet — nothing to copy');
    if (c.bs >= P.processors.length) missing.push(c.bs);
    else {
      if (prim[c.bs]) err.push(B + ' already drives cabinets of its own — a backup must be free');
      else if (prim[c.ms] && portsOfSender(c.bs) < prim[c.ms]) err.push(B + ' has ' + portsOfSender(c.bs) + ' ports, but ' + cardName(c.ms, true) + ' uses up to port ' + prim[c.ms]);
      if (P.processors[c.ms] && portsOfSender(c.bs) !== portsOfSender(c.ms))
        warn.push(A + ' and ' + cardName(c.bs, true) + ' have different port counts (' + portsOfSender(c.ms) + ' and ' + portsOfSender(c.bs) + ')');
    }
    [c.ms, c.bs].forEach(function (i) {
      if ((P.processors[i] || {}).type === 'h4fiber') warn.push(cardName(i) + ' is a 4× fiber card: 32 ports only in 32-port mode, otherwise 16');
    });
  });
  return { err: bkUniq(err), warn: bkUniq(warn), missing: bkUniq(missing).sort(function (a, b) { return a - b; }) };
}
// Add sending cards until every card in `missing` exists, each like its primary card: another
// output card in the same H chassis (or a new chassis when it's full), another unit of a fixed
// model, or another "Pick a model" card. Each add is its own undo step (app-processors).
function bkAddCards(missing) {
  var b = bkRead(), need = Math.max.apply(null, missing), guard = 0;
  while (P.processors.length <= need && guard++ < 64) {
    var n = P.processors.length, pr = b.cards.find(function (c) { return c.bs === n; }), ms = pr ? pr.ms : 0;
    var like = deviceOfCard(ms) || P.devices[P.devices.length - 1], last = P.devices[P.devices.length - 1];
    if (!like) break;   // no processor at all: nothing to copy the kind from
    var m = procModel(like.model);
    var type = (P.processors[ms] || {}).type;
    if (m.kind === 'fixed') addProcessor(like.model);
    else if (last.model === like.model && (m.kind !== 'chassis' || cardsOfDevice(last).length < m.slots)) addOutputCard(last, type);
    else addProcessor(like.model, type);
    if (P.processors.length === n) break;   // nothing was added (shouldn't happen)
  }
  log('backup_add_cards', { wanted: missing.map(function (i) { return i + 1; }), cards_now: P.processors.length });
}
// A backup screen is no longer needed: drop its backup sections, and the screen itself unless
// someone put other sections on it.
function bkDropBackupScreen(bl) {
  P.screens = P.screens.filter(function (s) { return !(s.screenId === bl.id && s.backupOf); });
  if (P.screens.some(function (s) { return s.screenId === bl.id; }) || P.lct.length < 2) delete bl.backupOf;
  else P.lct = P.lct.filter(function (l) { return l !== bl; });
  return 1;
}
function bkBuildScreens() {
  var b = bkRead();
  if (!b.cards.length) return toast('Add a card pair first');
  var cellsBy = allCells(), is = bkCardIssues(cellsBy);
  if (is.err.length) { log('backup_screens', { refused: is.err }); return toast('Can’t make backup screens: ' + is.err[0]); }
  if (is.missing.length) {
    var names = is.missing.map(function (i) { return cardName(i); }).join(', ');
    if (!confirm(names + (is.missing.length > 1 ? ' aren’t' : ' isn’t') + ' added yet.\n\nAdd ' + (is.missing.length > 1 ? 'them' : 'it') +
      ' now, the same kind as the primary card, and then make the backup screens?')) return log('backup_screens', { cancelled: 'cards not added: ' + names });
    bkAddCards(is.missing);
    cellsBy = allCells(); is = bkCardIssues(cellsBy);
    if (is.missing.length || is.err.length) return toast('Can’t make backup screens: ' + (is.err[0] || cardName(is.missing[0], true) + ' couldn’t be added'));
  }
  var plan = bkPlan(cellsBy), made = [], updated = [], removed = [];
  plan.entries.forEach(function (en) {
    if (!en.copies) { if (en.bl) { removed.push(en.bl.name); bkDropBackupScreen(en.bl); } return; }
    var bl = en.bl;
    if (!bl) { bl = { id: uid(), name: en.src.name + ' (backup)', backupOf: en.src.id }; P.lct.push(bl); made.push(bl.name); }
    else updated.push(bl.name);
    P.screens = P.screens.filter(function (s) { return !(s.screenId === bl.id && s.backupOf); });
    en.copies.forEach(function (d) { d.screenId = bl.id; P.screens.push(d); });
  });
  plan.stale.forEach(function (bl) { removed.push(bl.name); bkDropBackupScreen(bl); });
  if (!made.length && !updated.length && !removed.length) return toast('No screen uses a primary card yet — wire cabinets to it first');
  log('backup_screens', { made: made, updated: updated, removed: removed,
    cards: b.cards.map(function (c) { return (c.ms + 1) + '→' + (c.bs + 1); }) });
  commit(); renderAll();
  toast((made.length ? 'Made ' + made.length + ' backup screen' + (made.length === 1 ? '' : 's') : '') +
    (updated.length ? (made.length ? ', updated ' : 'Updated ') + updated.length : '') +
    (removed.length ? ((made.length || updated.length) ? ', removed ' : 'Removed ') + removed.length + ' no longer needed' : '') + ' (Ctrl+Z to undo)');
}
function bkRemoveScreens() {
  var bls = P.lct.filter(function (l) { return l.backupOf; });
  if (!bls.length) return toast('There are no backup screens');
  log('backup_screens_removed', { screens: bls.map(function (l) { return l.name; }) });
  bls.forEach(bkDropBackupScreen);
  commit(); renderAll();
  toast('Removed ' + bls.length + ' backup screen' + (bls.length === 1 ? '' : 's') + ' (Ctrl+Z to undo)');
}
// Every card with panels backed up by the cards right after the last one used
// (cards 1-3 -> 4-6), keeping existing pairs of those primaries.
function bkSuggestCards() {
  var prim = bkPrimaryUse(allCells()), used = Object.keys(prim).map(Number).sort(function (a, b) { return a - b; });
  if (!used.length) return toast('Nothing has cabinets wired yet');
  var next = used[used.length - 1] + 1, b = bkData();
  var had = {}; (b.cards || []).forEach(function (q) { had[q.ms] = q.bs; });   // keep the pairs these primaries already have
  var taken = {}; Object.keys(had).forEach(function (k) { taken[had[k]] = 1; });
  b.cards = used.map(function (ms) {
    if (had[ms] != null) return { ms: ms, bs: had[ms] };
    while (taken[next] || prim[next]) next++;
    taken[next] = 1; return { ms: ms, bs: next++ };
  });
  log('backup_cards_suggest', { cards: b.cards.map(function (c) { return (c.ms + 1) + '→' + (c.bs + 1); }) });
  commit(); renderAll();
}

// ------------------------------------------------------------------ the Backup card
function renderBackup(use) {
  var box = $('bkBody');
  if (!box) return;
  var b = bkRead(), h = '';
  $('bkSub').textContent = b.mode === 'port' ? 'port · ' + b.pairs.length + ' pair' + (b.pairs.length === 1 ? '' : 's')
    : b.mode === 'card' ? 'card · ' + b.cards.length + ' pair' + (b.cards.length === 1 ? '' : 's') : '';
  h += '<div class="seg" role="group" aria-label="Backup mode">' + BACKUP_MODES.map(function (m) {
    return '<button data-act="mode" data-v="' + m[0] + '"' + (m[0] === b.mode ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"') + ' title="' + esc(m[2]) + '">' + (m[0] === 'card' ? bkCardWord() : m[1]) + '</button>';
  }).join('') + '</div>';
  if (b.mode === 'port') h += bkPortHtml(b, use);
  else if (b.mode === 'card') h += bkCardHtml(b);
  else h += '<p class="hint">No backup.' + itip('Port: each port gets a spare port that takes over if its cable fails; the processor copies the layout onto it, so the .scr doesn’t change.\n' +
    bkCardWord() + ': a whole spare one, which needs its own copy of every screen (made for you).') + '</p>';
  box.innerHTML = keysText(h);
  box.onclick = bkOnClick;
  box.onchange = bkOnChange;
}
function bkPortHtml(b, use) {
  var n = P.processors.length;
  var A = ui.bkA != null && ui.bkA < n ? ui.bkA : b.pairs.length ? b.pairs[0].ms : (ui.mSender || 0);
  if (A >= n) A = 0;
  var B = ui.bkB != null && ui.bkB < n ? ui.bkB : (b.pairs.find(function (q) { return q.ms === A; }) || {}).bs;
  if (B == null || B >= n) B = A + 1 < n && deviceOfCard(A + 1) === deviceOfCard(A) && !bkCardBusy(A + 1, use) ? A + 1 : A;   // the next card of the processor if free, else A's own ports
  ui.bkA = A; ui.bkB = B;
  if (ui.bkArm != null && ui.bkArm >= portsOfSender(A)) ui.bkArm = null;
  // the two sets (NovaLCT's Add dialog), Add, and Auto; the rules show here, before any Send
  var set = bkSetList(A, B), err = bkPairErr(set.list, use), auto = bkAutoList(A, B), aerr = auto.length ? bkPairErr(auto, use) : 'too few ports';
  function num(act, v, max, tip) { return '<input type="number" data-act="' + act + '" min="1" max="' + max + '" value="' + (v + 1) + '" aria-label="' + tip + '" title="' + tip + '">'; }
  var h = '<div class="bk-set">' +
    '<span>Primary</span><div><select data-act="pa" aria-label="Primary card" title="Card whose ports carry the picture">' + cardOptionGroups(A, n) + '</select>' +
    '<span class="bk-pp">' + num('pf', set.f, portsOfSender(A), 'First primary port') + '–' + num('pt', set.t, portsOfSender(A), 'Last primary port') + '</span></div>' +
    '<span>Backup</span><div><select data-act="pb" aria-label="Backup card" title="Card whose ports take over: the same card (its free ports) or another card">' + cardOptionGroups(B, n) + '</select>' +
    '<span class="bk-pp">' + num('bf', set.bf, portsOfSender(B), 'First backup port') + '–<span class="bk-to" title="Last backup port">P' + (set.bf + set.list.length) + '</span></span></div></div>';
  h += '<div class="row"><button data-act="addset" class="primary"' + (err ? ' disabled' : '') + ' title="' + esc(err ? 'Can’t add: ' + err : 'Pair ' + bkSetText(set.list) + ' (pairs already on these ports are replaced)') + '">Add ' + set.list.length + ' pair' + (set.list.length === 1 ? '' : 's') + '</button>' +
    '<button data-act="auto"' + (aerr ? ' disabled' : '') + ' title="' + esc(aerr ? 'Can’t: ' + aerr : (A === B ? 'The first half of the ports backed up by the second half' : 'Port for port') + '; the processor copies the layout onto the backup ports itself') + '">Auto: ' + esc(!auto.length ? '—' : A === B ? 'P1–P' + auto.length + ' → P' + (auto[0].bp + 1) + '–P' + (auto[auto.length - 1].bp + 1) : 'P1–P' + auto.length + ' → ' + portLabel(B, 0) + '–P' + auto.length) + '</button>' +
    itip('Or click a top port (primary) in the diagram, then its backup below; click a backup to unpair.') + '</div>';
  if (err) h += '<p class="hint bk-err">' + esc(err.charAt(0).toUpperCase() + err.slice(1)) + '</p>';
  if (ui.bkArm != null) h += '<p class="hint"><b>Now click the backup port for ' + portLabel(A, ui.bkArm) + '.</b></p>';
  h += bkDiagram(A, B, b, use);
  // all pairs, grouped by card pair
  var groups = {}, order = [];
  b.pairs.forEach(function (q) { var k = q.ms + '>' + q.bs; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(q); });
  if (order.length) {
    h += '<div class="bk-list">';
    order.forEach(function (k) {
      var g = groups[k], q0 = g[0], z = g[g.length - 1], run = g.length > 1 && g.every(function (q, i) { return i === 0 || (q.mp === g[i - 1].mp + 1 && q.bp === g[i - 1].bp + 1); });
      var txt = run ? (q0.mp === q0.bp ? 'P' + (q0.mp + 1) + '–P' + (z.mp + 1) + ', port for port' : 'P' + (q0.mp + 1) + '–P' + (z.mp + 1) + ' → P' + (q0.bp + 1) + '–P' + (z.bp + 1))
        : g.slice(0, 4).map(function (q) { return 'P' + (q.mp + 1) + '→P' + (q.bp + 1); }).join(', ') + (g.length > 4 ? ' …' : '');
      var on = q0.ms === A && q0.bs === B;
      h += '<div class="bk-li' + (on ? ' on' : '') + '" data-act="pview" data-ms="' + q0.ms + '" data-bs="' + q0.bs + '" title="Click to show these cards in the diagram">' +
        '<b>' + esc(cardName(q0.ms)) + (q0.bs === q0.ms ? '' : ' → ' + esc(cardName(q0.bs, true))) + '</b><span title="' + esc(g.map(function (q) { return 'P' + (q.mp + 1) + '→P' + (q.bp + 1); }).join(', ')) + '">' + g.length + ' · ' + txt + '</span>' +
        '<button class="mini" data-act="pdel" data-ms="' + q0.ms + '" data-bs="' + q0.bs + '" title="Remove these pairs">×</button></div>';
    });
    h += '</div><div class="row"><button data-act="pclear" class="danger" title="Remove every backup pair">Clear all pairs</button></div>';
  } else h += '<p class="hint">No pairs yet.</p>';
  var is = bkPortIssues(use);
  is.err.forEach(function (t) { h += '<p class="hint bk-err">⚠ ' + esc(t) + '</p>'; });
  is.warn.forEach(function (t) { h += '<p class="hint bk-warn">' + esc(t) + '</p>'; });
  return h;
}
// Primary row over backup row, 10 ports per row, a line between each pair (like Unico).
function bkDiagram(A, B, b, use) {
  var nA = portsOfSender(A), nB = portsOfSender(B), n = Math.max(nA, nB), per = 10, bw = 24, bh = 18, step = 27, gap = 16, grpH = 2 * bh + gap + 10;
  if (!n) return '';
  var groups = Math.ceil(n / per), W = per * step - 3, H = groups * grpH - 10;
  function pos(row, p) { return { x: (p % per) * step, y: Math.floor(p / per) * grpH + (row ? bh + gap : 0) }; }
  var s = '<svg class="bk-svg" viewBox="-2 -2 ' + (W + 4) + ' ' + (H + 4) + '" role="img" aria-label="Port pairs, ' + cardName(A, true) + ' over ' + cardName(B, true) + '">';
  b.pairs.forEach(function (q) {
    if (q.ms !== A || q.bs !== B) return;
    var a = pos(0, q.mp), c = pos(1, q.bp);
    s += '<line x1="' + (a.x + bw / 2) + '" y1="' + (a.y + bh) + '" x2="' + (c.x + bw / 2) + '" y2="' + c.y + '"/>';
  });
  function box(row, card, p) {
    var o = pos(row, p), r = null, k = card + ':' + p, cls = 'bk-box ' + (row ? 'bak' : 'pri'), tip = portLabel(card, p);
    b.pairs.forEach(function (q) {
      if (q.ms === card && q.mp === p) r = r || { pri: true, q: q };
      if (q.bs === card && q.bp === p) r = { pri: false, q: q };
    });
    if (r && r.pri && row === 0) { cls += r.q.bs === B ? ' paired' : ' elsewhere'; tip += ' → backed up by ' + portLabel(r.q.bs, r.q.bp); }
    else if (r && !r.pri && row === 1) { cls += r.q.ms === A ? ' paired' : ' elsewhere'; tip += ' = backup of ' + portLabel(r.q.ms, r.q.mp) + ' (click to unpair)'; }
    else if (r) { cls += ' other'; tip += r.pri ? ' is a primary (backed up by ' + portLabel(r.q.bs, r.q.bp) + ')' : ' is a backup (of ' + portLabel(r.q.ms, r.q.mp) + ')'; }
    if (use[k]) { tip += ' · ' + use[k].cabs + ' cabinet(s) wired'; if (row) cls += ' busy'; }
    if (!row && ui.bkArm === p) cls += ' arm';
    tip += row ? (ui.bkArm != null ? ' · click to make it the backup of ' + portLabel(A, ui.bkArm) : '') : ' · click, then click its backup port below';
    var fill = !row && use[k] ? ' style="fill:' + portColor(card, p) + ';fill-opacity:.4"' : '';
    return '<g class="' + cls + '" data-act="' + (row ? 'bp' : 'pp') + '" data-port="' + p + '"><title>' + esc(tip) + '</title>' +
      '<rect x="' + o.x + '" y="' + o.y + '" width="' + bw + '" height="' + bh + '" rx="3"' + fill + '/>' +
      '<text x="' + (o.x + bw / 2) + '" y="' + (o.y + bh / 2 + 3.5) + '">' + (p + 1) + '</text></g>';
  }
  for (var p = 0; p < nA; p++) s += box(0, A, p);
  for (p = 0; p < nB; p++) s += box(1, B, p);
  return s + '</svg>';
}
function bkCardHtml(b) {
  var n = P.processors.length, cellsBy = allCells(), h = '';
  b.cards.forEach(function (c, i) {
    h += '<div class="bk-crow"><select data-act="cms" data-i="' + i + '" aria-label="Primary card" title="Primary card">' + cardOptionGroups(c.ms, Math.max(n, c.ms + 1)) + '</select>' +
      '<span>→</span><select data-act="cbs" data-i="' + i + '" aria-label="Backup card" title="Backup card (a card that isn’t added yet can be added when you make the backup screens)">' +
      cardOptionGroups(c.bs, Math.max(n, c.bs + 1) + 4) + '</select>' +
      '<button class="mini" data-act="cdel" data-i="' + i + '" title="Remove this card pair">×</button></div>';
  });
  h += '<div class="row"><button data-act="cadd" title="Add a primary card → backup card pair">+ Card pair</button>' +
    '<button data-act="csuggest" title="Every card that has cabinets gets a backup card, numbered right after the last one used (e.g. cards 1–3 backed up by 4–6)">Back up every used card</button>' +
    itip('Each backup ' + (P.processors.some(function (c, i) { return cardIsReal(i); }) ? 'card' : 'processor') + ' gets its own copy of every screen on its primary: same place, ports, pattern and cable order — only the card number changes. The .scr then has each of those screens twice.') + '</div>';
  var is = bkCardIssues(cellsBy), plan = bkPlan(cellsBy);
  is.err.forEach(function (t) { h += '<p class="hint bk-err">⚠ ' + esc(t) + '</p>'; });
  is.warn.forEach(function (t) { h += '<p class="hint bk-warn">' + esc(t) + '</p>'; });
  if (is.missing.length) h += '<p class="hint">' + esc(is.missing.map(function (i) { return cardName(i); }).join(', ')) + (is.missing.length > 1 ? ' aren’t' : ' isn’t') + ' added yet; added when you make the backup screens.</p>';
  var withCopies = plan.entries.filter(function (e) { return e.copies; }), have = P.lct.filter(function (l) { return l.backupOf; }).length;
  var fresh = b.cards.length && plan.entries.every(function (e) { return e.fresh; }) && !plan.stale.length;
  plan.entries.forEach(function (e) {
    if (e.copies && e.unbacked.length) h += '<p class="hint bk-warn">' + esc(e.src.name) + ' also uses ' + esc(e.unbacked.map(function (i) { return cardName(i, true); }).join(', ')) +
      ', which has no backup: those cabinets are blank on its backup screen.</p>';
  });
  h += '<p class="hint">' + (!b.cards.length ? 'Pick the cards to back up.' : !withCopies.length ? 'No screen uses a primary card yet.'
    : withCopies.length + ' screen' + (withCopies.length === 1 ? '' : 's') + ' on the primary cards → ' + (have ? have + ' backup screen' + (have === 1 ? '' : 's') + ', ' + (fresh ? 'up to date.' : '<b>out of date</b> — click Update.') : 'no backup screens yet.')) + '</p>';
  h += '<div class="row"><button data-act="build" class="' + (have && fresh ? '' : 'primary') + '"' + (b.cards.length ? '' : ' disabled') + ' title="For every screen on a primary card, make (or refresh) a copy screen on the backup card">' + (have ? 'Update backup screens' : 'Create backup screens') + '</button></div>';
  if (have) h += '<div class="row"><button data-act="cremove" class="danger" title="Delete the backup screens (Ctrl+Z brings them back)">Remove backup screens</button></div>';
  return h;
}
function bkOnClick(e) {
  var t = e.target.closest('[data-act]');
  if (!t || t.tagName === 'SELECT') return;
  var act = t.dataset.act, b = bkRead(), A = ui.bkA || 0, B = ui.bkB || 0, p = +t.dataset.port, i = +t.dataset.i;
  switch (act) {
    case 'mode': return bkSetMode(t.dataset.v);
    case 'addset':
      var st = bkSetList(A, B).list;
      if (bkAddPairs(st, 'set ' + bkSetText(st))) toast(bkSetText(st) + ' paired');
      return;
    case 'auto':
      var al = bkAutoList(A, B); ui.bkPf = ui.bkPt = ui.bkBf = null;
      if (bkAddPairs(al, 'auto ' + bkSetText(al))) toast(bkSetText(al) + ' paired');
      return;
    case 'pp':
      ui.bkArm = ui.bkArm === p ? null : p;
      return renderBackup(portUsage(allCells()));
    case 'bp':
      if (ui.bkArm != null) {
        var arm = ui.bkArm; ui.bkArm = null;
        if (!bkAddPairs([{ ms: A, mp: arm, bs: B, bp: p }], 'custom')) renderBackup(portUsage(allCells()));
        return;
      }
      var q = b.pairs.find(function (x) { return x.bs === B && x.bp === p; });
      if (q) return bkRemovePairs(function (x) { return x === q; }, 'unpair ' + portLabel(q.ms, q.mp) + ' → ' + portLabel(B, p));
      return toast('Click a port in the top row first, then its backup port here');
    case 'pview':
      if (e.target.closest('button')) return;
      ui.bkA = +t.dataset.ms; ui.bkB = +t.dataset.bs; ui.bkArm = null;
      return renderBackup(portUsage(allCells()));
    case 'pdel':
      var ms = +t.dataset.ms, bs = +t.dataset.bs;
      return bkRemovePairs(function (x) { return x.ms === ms && x.bs === bs; }, cardName(ms, true) + ' → ' + cardName(bs, true));
    case 'pclear': return bkRemovePairs(function () { return true; }, 'all');
    case 'cadd':
      var d = bkData(), prim = bkPrimaryUse(allCells()), taken = {};
      d.cards.forEach(function (c) { taken[c.ms] = taken[c.bs] = 1; });
      var ms2 = Object.keys(prim).map(Number).sort(function (x, y) { return x - y; }).find(function (k) { return !taken[k]; });
      if (ms2 == null) ms2 = 0;
      var bs2 = Math.max.apply(null, [P.processors.length - 1].concat(Object.keys(prim).map(Number), Object.keys(taken).map(Number))) + 1;
      for (var k = ms2 + 1; k < P.processors.length; k++) if (!prim[k] && !taken[k]) { bs2 = k; break; }
      d.cards.push({ ms: ms2, bs: bs2 });
      log('backup_card_pair_add', { primary: ms2 + 1, backup: bs2 + 1 });
      commit(); return renderAll();
    case 'cdel':
      var dd = bkData(), gone = dd.cards.splice(i, 1)[0];
      if (gone) { log('backup_card_pair_remove', { primary: gone.ms + 1, backup: gone.bs + 1 }); commit(); renderAll(); }
      return;
    case 'csuggest': return bkSuggestCards();
    case 'build': return bkBuildScreens();
    case 'cremove': return bkRemoveScreens();
  }
}
function bkOnChange(e) {
  var t = e.target, act = t.dataset && t.dataset.act, v = int(t.value, 0);
  if (act === 'pa') {   // the backup card follows when it was the same card or is on another processor
    if (ui.bkB === ui.bkA || deviceOfCard(ui.bkB) !== deviceOfCard(v)) ui.bkB = null;
    ui.bkA = v; ui.bkArm = null; ui.bkPf = ui.bkPt = ui.bkBf = null; return renderAll();
  }
  if (act === 'pb') { ui.bkB = v; ui.bkPf = ui.bkPt = ui.bkBf = null; return renderAll(); }
  if (act === 'pf' || act === 'pt' || act === 'bf') {   // the sets' ports (1-based in the box)
    var cur = bkSetList(ui.bkA || 0, ui.bkB || 0);
    ui.bkPf = cur.f; ui.bkPt = cur.t; ui.bkBf = cur.bf;
    ui['bk' + { pf: 'Pf', pt: 'Pt', bf: 'Bf' }[act]] = Math.max(0, int(t.value, 1) - 1);
    if (act === 'pf' && ui.bkPt < ui.bkPf) ui.bkPt = ui.bkPf;
    return renderBackup(portUsage(allCells()));
  }
  if (act === 'cms' || act === 'cbs') {
    var c = bkData().cards[+t.dataset.i];
    if (!c) return;
    log('backup_card_pair_set', { pair: +t.dataset.i + 1, which: act === 'cms' ? 'primary' : 'backup', card: v + 1 });
    if (act === 'cms') c.ms = v; else c.bs = v;
    commit(); renderAll();
  }
}
