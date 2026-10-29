// app-tree.js - the left column's project tree, NovaStar VMP style: the project row (double-
// click renames), one node per LCT screen (click shows it, the arrow folds it, double-click
// renames, × closes, right-click reorders it within its processor; its tags are the processor it belongs to — NovaLCT keeps
// a processor's screens together, lctDevMap — and the NovaLCT screen type — the WHOLE screen is Standard or
// Complex, as exported), and under each screen, Unico style "Screen 1 → Processor 1 → Sending
// card 1": its processors (click = draw on its first card, ▾ folds it, double-click renames,
// Edit opens it in the Processors tab), under each its sending cards (click = show that screen
// and make the card the active one for drawing; the tag and the little bar show which of its
// ports that screen uses; ▸ unfolds the ports it uses there — self-drawn ones included — click
// one to draw on it). Sections aren't listed (user, 2026-10-11: no other app shows them): every wired
// panel appears under its port. Groups (Ctrl+G, app-sections.js) are: right under their screen, click = select the
// group's cabinets, double-click = rename.
// Owns: renderTree, activateCard, firstFreePort, treeAddMenu; ui.treeClosed (folded screens),
// ui.treeDevClosed (folded processors), ui.treeCardClosed (folded cards).
// Depends on: app-core (P, ui, $, esc, log, commit, lctById), app-capacity (portsOfSender,
// portColor, portLabel, portUsage, screenById), app-geometry (allCells), app-sections
// (showScreen, closeScreen, addLctScreen, addSendingCard), app-processors, app-devices (setTab,
// devShow, devOpenPicker), app-render (renderAll) and app-context-menu (openMenu), all at run
// time. renderTree is called from renderAll.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// First port of a sending card with nothing wired to it on any screen (0 if all are used).
function firstFreePort(sender, use) {
  var n = portsOfSender(sender);
  for (var p = 0; p < n; p++) if (!use[sender + ':' + p]) return p;
  return 0;
}

// Show screen lctId and make sending card `sender` the active one (ui.mSender / ui.mPort).
// Picking another card (or the same card on another screen) jumps to its first free port;
// clicking the card that is already active keeps the current port.
function activateCard(lctId, sender) {
  // a screen belongs to one processor: another processor's card opens that processor's first screen (a new one if none)
  var d = deviceOfCard(sender), own = lctOwner(lctById(lctId));
  if (d && own && d.id !== own.id) { var to = lctScreensOf(d)[0]; if (!to) { to = lctNew(d); commit(); } lctId = to.id; }
  if (!(lctId === ui.viewScreen && sender === (ui.mSender || 0))) {
    ui.mSender = sender; ui.mPort = firstFreePort(sender, portUsage(allCells()));
  }
  log('select_card', { screen: (lctById(lctId) || {}).name, card: sender + 1, port: portLabel(ui.mSender, ui.mPort) });
  if (lctId !== ui.viewScreen) showScreen(lctId); else renderAll();
}

// The tree's "+" menu. "+ Processor…" opens the Processors tab's picker (app-devices.js).
function treeAddMenu(x, y) {
  var d = deviceOfCard(ui.mSender || 0), m = d && procModel(d.model), ad = typeof pipeActive === 'function' ? pipeActive() : d;
  openMenu(x, y, [
    { header: 'Add' },
    { label: '+ Screen' + (ad ? ' on ' + deviceLabel(ad) : ''), act: function () { addLctScreen(); } },   // its next screen (app-sections.js)
    { label: '+ Processor…', act: function () { setTab('devices'); devOpenPicker(); } },
    m ? { label: m.kind === 'fixed' ? '+ Another ' + m.name : m.kind === 'chassis' ? '+ Output card to ' + deviceLabel(d) : '+ Card to ' + deviceLabel(d),
      disabled: !!(m.kind === 'chassis' && cardsOfDevice(d).length >= m.slots), act: function () { addSendingCard(); } } : null
  ].filter(Boolean));
}

function renderTree(use, cellsBy) {
  var box = $('tree');
  cellsBy = cellsBy || allCells();
  ui.treeClosed = ui.treeClosed || {};
  ui.treeCardClosed = ui.treeCardClosed || {};
  ui.treeDevClosed = ui.treeDevClosed || {};
  var q = ($('treeSearch').value || '').trim().toLowerCase();
  // Which ports each screen uses, per sending card: here[lctId][sender][port] = usage
  var here = {}, allByCard = {};
  Object.keys(use).forEach(function (k) {
    var u = use[k];
    allByCard[u.sender] = (allByCard[u.sender] || 0) + 1;
    Object.keys(u.lct || {}).forEach(function (l) {
      var m = here[l] || (here[l] = {});
      (m[u.sender] || (m[u.sender] = {}))[u.port] = u;
    });
  });
  var realCards = P.processors.filter(function (c, i) { return cardIsReal(i); }).length;   // fixed processors aren't counted as cards
  var hw2 = realCards ? realCards + ' card' + (realCards === 1 ? '' : 's') : P.devices.length + ' processor' + (P.devices.length === 1 ? '' : 's');
  var h = '<div class="tn tn-proj" data-kind="proj" role="treeitem" title="' + esc((P.name || 'Untitled') + ' — double-click to rename the project') + '">' +
    '<span class="tn-ico">▣</span><span class="tn-name">' + esc(P.name || 'Untitled') + '</span>' +
    '<span class="tn-tag">' + P.lct.length + ' screen' + (P.lct.length === 1 ? '' : 's') + ' · ' + hw2 + '</span></div>';
  var shown = 0, ldm = lctDevMap(cellsBy);   // each screen's processor(s) (app-processors.js)
  P.lct.forEach(function (lc) {
    if (q && lc.name.toLowerCase().indexOf(q) < 0) return;
    shown++;
    var cur = lc.id === ui.viewScreen, open = !ui.treeClosed[lc.id] || !!q, map = here[lc.id] || {};
    // NovaLCT sees the whole screen as ONE type: Standard (one grid) or Complex — as exported
    var ty = lctScreenType(lc.id, cellsBy);
    var tyText = ty ? ty.kind : 'empty';
    var tyTip = !ty ? 'no cabinets yet' : ty.kind === 'Standard' ? 'NovaLCT Standard screen: ' + ty.cols + ' × ' + ty.rows + ' grid (gaps are blanks)'
      : 'NovaLCT Complex screen: ' + ty.cabinets + ' cabinets placed freely (they don’t line up on one grid)';
    // the processor it belongs to (NovaLCT: one processor's screen n; a screen belongs to one processor)
    var ds = ldm[lc.id] || [], owTip = !ds.length ? 'no processor yet' : 'screen ' + (lctScreensOf(ds[0], null, ldm).indexOf(lc) + 1) + ' of ' + deviceLabel(ds[0]) + ' (sent in this order with its other screens)';
    h += '<div class="tn tn-lct' + (cur ? ' on' : '') + '" data-kind="lct" data-id="' + lc.id + '" role="treeitem" aria-expanded="' + open + '" aria-selected="' + cur + '"' +
      ' title="' + esc(lc.name + ' · ' + tyTip + ' · ' + owTip + ' · click to show, double-click to rename, right-click to reorder') + '">' +
      '<span class="tn-tw" data-act="toggle" title="' + (open ? 'Fold' : 'Unfold') + '">' + (open ? '▾' : '▸') + '</span>' +
      '<span class="tn-name">' + esc(lc.name) + '</span>' + backupTreeBadge('lct', lc.id) +   // backup copy (app-backup.js)
      (ds.length ? '<span class="tn-tag tn-own" title="' + esc(owTip) + '">' + esc(deviceLabel(ds[0])) + '</span>' : '') +
      '<span class="tn-type" title="' + esc(tyTip) + '">' + tyText + '</span>' +
      (P.lct.length > 1 ? '<span class="tn-x" data-act="close" title="Close this screen (deletes its cabinets; Ctrl+Z brings them back)">×</span>' : '') + '</div>';
    if (!open) return;
    // its groups of cabinets (named by the user; plain cabinets aren't listed)
    (P.groups || []).forEach(function (g) {
      var m = groupMembers(g).filter(function (s) { return s.screenId === lc.id; }); if (!m.length) return;
      var n = m.reduce(function (a, s) { return a + cabCount(s); }, 0), gOn = cur && ui.sel && m.some(function (s) { return s.id === ui.sel; });
      h += '<div class="tn tn-grp' + (gOn ? ' on' : '') + '" data-kind="grp" data-id="' + lc.id + '" data-grp="' + g.id + '" role="treeitem" aria-selected="' + !!gOn + '" title="' +
        esc(g.name + ' · ' + cabsText(n) + ' · click to select it, double-click to rename, Ctrl+Shift+G ungroups') + '">' +
        '<span class="tn-ico">▦</span><span class="tn-name">' + esc(g.name) + '</span><span class="tn-tag">' + cabsText(n) + '</span></div>';
    });
    // Screen → processor → sending card → port. Under a screen: its processor with every card; a screen of no processor yet
    // lists them all. Plus any card this screen is wired to (one that isn't added).
    var nCards = P.processors.length, show = {};
    ds.forEach(function (x) { show[x.id] = 1; });
    Object.keys(map).forEach(function (sd) { nCards = Math.max(nCards, +sd + 1); });
    for (var i = 0; i < nCards; i++) {
      var dv = deviceOfCard(i);
      if (dv && ds.length && !show[dv.id] && !map[i]) continue;
      // cards this screen is wired to that aren't added get their own heading
      if (i === P.processors.length) h += '<div class="tn tn-dev missing" role="treeitem" aria-selected="false" title="' + (P.devices.length ? 'Wired on this screen, but no processor has these cards — add a processor or card, or move these ports' :
        'No processor yet — add one in Device (+ Add processor)') + '"><span class="tn-ico">!</span><span class="tn-name">' + (P.devices.length ? 'Not added' : 'No processor') + '</span></div>';
      // processor row above its first card (click = make its first card active; ▾ folds it)
      if (dv && (i === 0 || P.processors[i - 1].dev !== dv.id)) {
        var di = cardsOfDevice(dv), dOn = cur && P.processors[ui.mSender || 0] && P.processors[ui.mSender || 0].dev === dv.id;
        var dk = lc.id + ':' + dv.id, dOpen = !ui.treeDevClosed[dk] || !!q, dmo = procModel(dv.model);   // (its own name: ldm above is the screens' processor map)
        var dUsed = di.filter(function (c) { return map[c]; }).length;
        h += '<div class="tn tn-dev' + (dOn ? ' on' : '') + '" data-kind="dev" data-id="' + lc.id + '" data-dev="' + dv.id + '" data-card="' + i + '" role="treeitem" aria-expanded="' + dOpen + '" aria-selected="' + !!dOn + '" title="' +
          esc(deviceLabel(dv) + ' · ' + dmo.name + (dmo.kind === 'fixed' ? '' : ' · ' + (di.length === 1 ? cardName(di[0], true) : (dmo.kind === 'chassis' ? 'sending cards ' : 'cards ') + (di[0] + 1) + '–' + (di[di.length - 1] + 1))) +
            ' · ' + (dUsed ? dUsed + ' used on ' + lc.name : 'not used on ' + lc.name) + ' · click to draw on its first card, double-click to rename') + '">' +
          '<span class="tn-tw" data-act="dtoggle" title="' + (dOpen ? 'Fold' : dmo.kind === 'fixed' ? 'Show its ports' : dmo.kind === 'chassis' ? 'Show its sending cards' : 'Show its cards') + '">' + (dOpen ? '▾' : '▸') + '</span>' +
          '<svg class="tn-dico" viewBox="0 0 16 12" aria-hidden="true"><rect x=".75" y="1.75" width="14.5" height="8.5" rx="1.2"/><path d="M3.5 5h1.6v2H3.5zM6.2 5h1.6v2H6.2zM8.9 5h1.6v2H8.9z"/></svg>' +
          '<span class="tn-name">' + esc(deviceLabel(dv)) + '</span>' + (dmo.kind === 'fixed' ? backupTreeBadge('card', di[0]) : '') + '<span class="tn-tag">' + esc(dmo.name) + '</span>' +
          '<span class="tn-go" data-act="devopen" title="Edit ' + esc(deviceLabel(dv)) + ' in Processors (model, output cards, cascade order)">Edit</span></div>';
      }
      if (dv && ui.treeDevClosed[lc.id + ':' + dv.id] && !q) continue;
      var real = cardIsReal(i);   // a fixed processor: its ports hang straight under it, no "Sending card 1" row
      var ports = map[i] ? Object.keys(map[i]).length : 0, act = cur && i === (ui.mSender || 0), np = portsOfSender(i), bar = '';
      for (var p = 0; p < np; p++) {
        if (map[i] && map[i][p]) bar += '<i style="background:' + portColor(i, p) + '"></i>';
        else bar += use[i + ':' + p] ? '<i class="else"></i>' : '<i></i>';
      }
      var tip = cardName(i) + (P.processors[i] && P.processors[i].type ? ' (' + cardTypeLabel(P.processors[i]) + ')' : '') + ': ' +(ports ? ports + ' port(s) on ' + lc.name : 'no ports on ' + lc.name) +
        ' · ' + (allByCard[i] || 0) + ' of ' + (np || '?') + ' used in the project · click to draw on it';
      var ck = lc.id + ':' + i, cOpen = ports > 0 && (!real || !ui.treeCardClosed[ck] || !!q);
      if (real) h += '<div class="tn tn-card' + (act ? ' on' : '') + (P.processors[i] ? '' : ' missing') + '" data-kind="card" data-id="' + lc.id + '" data-card="' + i + '" role="treeitem" aria-selected="' + act + '"' + (ports ? ' aria-expanded="' + cOpen + '"' : '') + ' title="' + esc(tip) + '">' +
        (ports ? '<span class="tn-tw" data-act="ctoggle" title="' + (cOpen ? 'Fold' : 'Show its ports') + '">' + (cOpen ? '▾' : '▸') + '</span>' : '<span class="tn-ico">▭</span>') +
        '<span class="tn-name">' + esc(cardName(i)) + (P.processors[i] ? '' : ' (not added)') + '</span>' + backupTreeBadge('card', i) +
        '<span class="tn-tag">' + (ports ? ports + ' port' + (ports === 1 ? '' : 's') : '—') + '</span>' +
        (np ? '<span class="tn-bar">' + bar + '</span>' : '') + '</div>';
      // its ports on this screen — every wired panel shows up here, however it was made
      // (imported, auto, manual or self-drawn)
      if (cOpen) Object.keys(map[i]).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
        var u = map[i][p], pAct = cur && i === (ui.mSender || 0) && p === (ui.mPort || 0), over = u.load > u.cap;
        var pct = u.cap ? Math.round(u.load / u.cap * 100) : 0, elsewhere = Object.keys(u.lct || {}).length > 1;
        h += '<div class="tn tn-port' + (pAct ? ' on' : '') + (over ? ' over' : '') + '" data-kind="port" data-id="' + lc.id + '" data-card="' + i + '" data-port="' + p + '" role="treeitem" aria-selected="' + pAct + '"' +
          ' title="' + esc(portLabel(i, p) + ': ' + u.cabs + ' cabinet(s) · rectangle ' + fmt(u.load) + ' of ' + fmt(u.cap) + ' px' + (elsewhere ? ' · also used on another screen' : '') + ' · click to draw on it') + '">' +
          '<span class="sw" style="background:' + portColor(i, p) + '"></span><span class="tn-name">P' + (p + 1) + '</span>' +
          '<span class="tn-tag">' + (elsewhere ? '⚠ ' : '') + u.cabs + ' cabinet' + (u.cabs === 1 ? '' : 's') + ' · ' + pct + '%</span></div>';
      });
    }
  });
  if (!shown) h += '<p class="hint tn-none">Nothing matches “' + esc(q) + '”.</p>';
  box.innerHTML = h;

  box.onclick = function (e) {
    var row = e.target.closest('.tn'); if (!row) return;
    var a = e.target.closest('[data-act]'), act = a && a.dataset.act, id = row.dataset.id;
    switch (row.dataset.kind) {
      case 'proj':   // the project row opens its dashboard, as VMP's does (after a beat, so a double-click can rename instead)
        clearTimeout(ui.projClickT); ui.projClickT = setTimeout(function () { setTab('dashboard'); }, 280); return;
      case 'lct':
        if (act === 'close') return closeScreen(id);
        if (act === 'toggle') {
          ui.treeClosed[id] = !ui.treeClosed[id];
          log('tree_fold', { screen: (lctById(id) || {}).name, folded: ui.treeClosed[id] });
          return renderTree(portUsage(allCells()));
        }
        return showScreen(id);   // (logs show_screen; nothing happens if already shown)
      case 'card':
        if (act === 'ctoggle') {
          var ck = id + ':' + row.dataset.card;
          ui.treeCardClosed[ck] = !ui.treeCardClosed[ck];
          return renderTree(portUsage(allCells()));
        }
        return activateCard(id, +row.dataset.card);
      case 'dev':
        if (act === 'devopen') return devShow(deviceById(row.dataset.dev));   // app-devices.js
        if (act === 'dtoggle') {
          var dk = id + ':' + row.dataset.dev;
          ui.treeDevClosed[dk] = !ui.treeDevClosed[dk];
          return renderTree(portUsage(allCells()));
        }
        return activateCard(id, +row.dataset.card);
      case 'grp':
        var gg = groupById(row.dataset.grp); if (gg) selectGroup(gg);
        return;
      case 'port':
        if (id !== ui.viewScreen) showScreen(id);
        return selectPort(+row.dataset.card, +row.dataset.port, 'tree');
    }
  };
  // right-click a screen: Earlier / Later in its processor's order, + Screen on that processor (app-sections.js lctMenu)
  box.oncontextmenu = function (e) { var row = e.target.closest('.tn-lct'), lc = row && lctById(row.dataset.id); if (lc) lctMenu(e, lc); };
  // Double-click renames. Bound on the tree (not on the rows): the first click of a
  // double-click re-renders the rows, so the second one lands on a new element.
  box.ondblclick = function (e) {
    if (e.target.closest('[data-act]')) return;
    var row = e.target.closest('.tn'); if (!row) return;
    var kind = row.dataset.kind, nm;
    if (kind === 'proj') {
      clearTimeout(ui.projClickT);
      nm = prompt('Project name:', P.name);
      if (nm == null || !nm.trim()) return;
      log('rename_project', { from: P.name, to: nm.trim() });
      P.name = nm.trim(); commit(); renderAll();
    } else if (kind === 'lct') {
      var lc = lctById(row.dataset.id);
      nm = lc && prompt('Screen name (LCT keeps the first 10 characters):', lc.name);
      if (nm == null || !nm.trim()) return;
      log('rename_screen', { from: lc.name, to: nm.trim() });
      lc.name = nm.trim(); commit(); renderAll();
    } else if (kind === 'grp') {
      var g = groupById(row.dataset.grp); if (g) renameGroup(g);
    } else if (kind === 'dev') {
      var dv = deviceById(row.dataset.dev);
      nm = dv && prompt('Processor name:', deviceLabel(dv));
      if (nm == null || !nm.trim()) return;
      log('rename_processor', { from: deviceLabel(dv), to: nm.trim() });
      dv.name = nm.trim(); commit(); renderAll();
    }
  };
}
