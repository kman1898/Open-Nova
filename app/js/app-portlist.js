// app-portlist.js - the port list under the canvas, NovaStar VMP style: one tile per port of
// the active sending card (ui.mSender) with the port number, cabinets and load, coloured like
// the canvas. Click a tile = make it the active port (ui.mSender / ui.mPort, the port Manual
// and Self draw wire onto); right-click = select / reverse / clear that port on this screen.
// The pro look (docs/DESIGN_SYSTEM.md) gets the gallery's tiles: "12 cab · 67 %", a load bar in the port colour, "B3" on
// the backup of P3, lit red when the Monitor says the link is down and amber on a backup port that carries its primary.
// Owns: renderPortList, selectPort, portListMenu, ptLive; ui.plLastKey (last tile scrolled to).
// Pro look also: app-pipeline (proLook), app-backup (backupRole), app-processors (deviceOfCard, deviceLabel), app-health (hlt).
// Depends on: app-core (P, ui, $, esc, fmt, log, commit, toast, lctById), app-capacity
// (capacity, portsOfSender, portColor, portLabel), app-geometry (allCells, visibleScreens),
// app-hardware (hwTileText, hwPortDetected, hwTileProblem: placed / detected panels),
// app-manual-wiring (ensureManual, portKeys, reversePort), app-render (renderAll,
// senderOptions), app-tree (activateCard) and app-context-menu (openMenu), all at run time.
// renderPortList is called from renderAll and renderLight.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

function selectPort(sender, port, via) {
  ui.mSender = sender; ui.mPort = port;
  log('select_port', { port: portLabel(sender, port), via: via });
  renderAll();
}

// Right-click menu of a port tile: what that port does on the screen being shown.
function portListMenu(x, y, sender, port) {
  var lbl = portLabel(sender, port), cellsBy = allCells();
  var secs = visibleScreens().filter(function (s) { return cellsBy[s.id].some(function (c) { return c.sender === sender && c.port === port; }); });
  var man = secs.filter(function (s) { return s.wiring.mode === 'manual'; })[0];
  var scr = (lctById(ui.viewScreen) || {}).name || 'this screen';
  openMenu(x, y, [
    { header: lbl + ' · ' + scr + (secs.length ? ' · ' + secs.map(secLabel).join(', ') : ' · not used here') },
    { label: 'Select this port’s cabinets' + (man && secs.length > 1 ? ' (' + secLabel(man) + ')' : ''), disabled: !man, act: function () {
      var keys = portKeys(man, sender, port);
      log('select_port_panels', { port: lbl, section: man.name, panels: keys.length });
      ui.sel = man.id; ui.selScreen = man.id; ui.selKeys = new Set(keys); ui.mSender = sender; ui.mPort = port;
      renderAll();
    } },
    { sep: true },
    { label: 'Reverse ' + lbl, disabled: !secs.length, act: function () {
      log('reverse_port', { port: lbl, screen: scr, sections: secs.map(function (s) { return s.name; }) });
      secs.forEach(function (s) { reversePort(s, sender, port); });
      commit(); renderAll();
    } },
    { label: 'Clear ' + lbl + ' on this screen', disabled: !secs.length, act: function () {
      log('clear_port_on_screen', { port: lbl, screen: scr, sections: secs.map(function (s) { return s.name; }) });
      secs.forEach(function (s) {
        ensureManual(s);
        Object.keys(s.manual).forEach(function (k) { var a = s.manual[k]; if (a.sender === sender && a.port === port) delete s.manual[k]; });
      });
      commit(); renderAll();
      toast('Cleared ' + lbl + ' on ' + scr + ' (Ctrl+Z to undo)');
    } }
  ]);
}

// The pro look's lit tiles: what the Monitor's last reading says about this port — 'down' (its link failed) or 'live'
// (a backup port carrying a failed primary), else ''.
function ptLive(snd, p) {
  var d = deviceOfCard(snd), h = d && typeof hlt !== 'undefined' && hlt.by && hlt.by[d.id], st = '';
  if (!h || !h.ports) return '';
  h.ports.forEach(function (q) {
    if (q.card === snd && q.port === p && /failed|no link|no signal|dark/.test(q.link || '')) st = 'down';
    if (q.backup && q.backup.card === snd && q.backup.port === p && /running on backup|split feed/.test(q.link || '')) st = st || 'live';
  });
  return st;
}

function renderPortList(use) {
  var box = $('portTiles'), snd = ui.mSender || 0, cur = ui.mPort || 0, view = ui.viewScreen, n = portsOfSender(snd);
  var cap = capacity(), usedHere = 0, usedAll = 0, p, u, pro = typeof proLook === 'function' && proLook(), nBk = 0;
  for (p = 0; p < n; p++) { u = use[snd + ':' + p]; if (u) { usedAll++; if (u.lct[view]) usedHere++; } if (pro) { var br = backupRole(snd, p); if (br && br.backup) nBk++; } }
  if (pro) {   // "PORTS · H5 · SENDING CARD 1"  [4 of 16 used · 2 backup]  "659,722 px / port · 8-bit · 60 Hz"
    var dv = deviceOfCard(snd), dl = dv ? deviceLabel(dv) : '';
    $('plTitle').textContent = $('plTitle').title = 'Ports · ' + (dl && cardName(snd) !== dl ? dl + ' · ' : '') + cardName(snd);
    $('plCount').textContent = usedHere + ' of ' + n + ' used' + (nBk ? ' · ' + nBk + ' backup' : '') + (usedAll > usedHere ? ' · ' + (usedAll - usedHere) + ' on other screens' : '');
    $('plCap').textContent = cap ? fmt(cap) + ' px / port · ' + P.bitDepth + '-bit · ' + (+P.refresh || 60) + ' Hz' + (P.lowLatency ? ' · low latency' : '') : 'not supported above 120 Hz';
  } else {
    $('plTitle').textContent = 'Port List — ' + cardName(snd);
    $('plCount').textContent = '(' + usedHere + '/' + n + ')' + (usedAll > usedHere ? ' · ' + (usedAll - usedHere) + ' more on other screens' : '');
    $('plCap').textContent = cap ? fmt(cap) + ' px per port' + (P.lowLatency ? ' · low latency' : '') : 'not supported above 120 Hz';
  }
  senderOptions($('plCard'), snd);
  $('plCard').onchange = function () { activateCard(ui.viewScreen, int($('plCard').value, 0)); };
  if (!P.processors[snd]) {
    box.style.gridTemplateColumns = '';
    box.innerHTML = '<p class="hint">' + esc(cardName(snd)) + ' isn’t added — add it with + in the tree.</p>';
    return;
  }
  // Fibre output cards: 4 fibres, ports split evenly (4× fiber 32 = 8 per OPT, 8× fiber 40 = 10).
  var pc = P.processors[snd], fib = pc && /fiber/.test(pc.type || '') ? Math.max(1, Math.floor(n / 4)) : 0;
  var h = '';
  for (p = 0; p < n; p++) {
    u = use[snd + ':' + p];
    var lbl = portLabel(snd, p), col = portColor(snd, p), on = p === cur, cls = 'pt', style = '', tip, pct = 0, other = [];
    if (u) {
      pct = u.cap ? u.load / u.cap * 100 : Infinity;
      other = Object.keys(u.lct).filter(function (l) { return l !== view; }).map(function (l) { return (lctById(l) || {}).name || '?'; });
      cls += ' used' + (u.lct[view] ? ' here' : '') + (u.load > u.cap ? ' over' : '');
      style = ' style="background:' + col.replace('hsl(', 'hsla(').replace(')', ',' + (u.lct[view] ? '.26' : '.1') + ')') + '"';
      tip = lbl + ' · ' + u.cabs + ' cabinet' + (u.cabs === 1 ? '' : 's') + ' · rectangle ' + (u.rect.x1 - u.rect.x0) + '×' + (u.rect.y1 - u.rect.y0) + ' at y ' + u.rect.y0 +
        ' · counted by ' + loadModeText(u.mode) +
        ' · load ' + fmt(u.load) + ' / ' + fmt(u.cap) + ' px' + (isFinite(pct) ? ' (' + pct.toFixed(0) + '%)' : '') +
        (other.length ? ' · ⚠ also wired on ' + other.join(', ') + (u.lct[view] ? ' — one cable runs through both, the rectangle spans them' : '') : '');
    } else tip = lbl + ' · free';
    var det = hwPortDetected(snd, p), bad = hwTileProblem(snd, p);         // detected panels (app-hardware.js)
    if (det) tip += ' · detected ' + det.length + (det.length ? ' (' + det[0].w + '×' + det[0].h + (det[0].name ? ' ' + det[0].name : '') + ')' : '');
    if (bad) { cls += ' detbad'; tip += ' · ⚠ ' + bad; }
    if (on) cls += ' on';
    if (fib) { tip += ' · OPT ' + (Math.floor(p / fib) + 1); if (p % fib === 0) cls += ' opt-start'; }
    var meter = u ? Math.min(100, isFinite(pct) ? pct : 100) : 0, mcls = u && u.load > u.cap ? 'over' : pct > 90 ? 'hi' : '';
    if (pro) {   // gallery tile: number, backup badge "B3" (backs up P3), "12 cab · 67 %", the load bar in the port colour; lit when down / live
      var role = backupRole(snd, p), bk = !!(role && role.backup), lv = ptLive(snd, p), txt = '—', bar = meter, bcol = mcls === 'over' ? 'var(--danger)' : col;
      if (u) txt = '<b>' + u.cabs + '</b><span class="pt-cab"> cab</span> · ' + (isFinite(pct) ? pct.toFixed(0) + ' %' : '—');
      else if (bk) { txt = ''; bar = 100; bcol = ''; }
      if (lv) { txt = lv; if (lv === 'live') { bar = 100; bcol = ''; } }
      if (bk) tip += ' · backup of ' + portLabel(role.s, role.p) + (lv === 'live' ? ' · carrying it now' : ' · standby');
      else if (role) tip += ' · backed up by ' + portLabel(role.s, role.p);
      if (lv === 'down') tip += ' · link down (Monitor)';
      cls += (lv === 'down' ? ' bad' : lv === 'live' ? ' warn' : '') + (bk ? ' bk' : '');
      style = ' style="--pc:' + col + '"';
    }
    var head = '<div class="' + cls + '"' + (fib && p % fib === 0 ? ' data-opt="OPT ' + (Math.floor(p / fib) + 1) + '"' : '') + ' data-p="' + p + '" role="option" aria-selected="' + on + '" title="' + esc(tip) + '"' + style + '>';
    if (pro) {
      h += head + '<b class="pt-n">' + (p + 1) + '</b>' + (bk ? '<span class="pt-tag">B' + (role.s === snd ? role.p + 1 : esc(portLabel(role.s, role.p))) + '</span>' : '') +
        '<span class="pt-u' + (mcls === 'over' ? ' over' : '') + '">' + txt + '</span>' + (other.length ? '<span class="pt-warn">⚠</span>' : '') +
        '<i class="pt-meter"><i class="' + mcls + (bk && !u && lv !== 'live' ? ' standby' : '') + (lv === 'live' ? ' live' : '') + '" style="width:' + bar.toFixed(1) + '%' + (bcol ? ';background:' + bcol : '') + '"></i></i></div>';
      continue;
    }
    h += head +
      '<i class="pt-strip" style="background:' + col + '"></i>' +
      '<b class="pt-n">' + (p + 1) + '</b>' +
      '<span class="pt-info"><span class="pt-cabs">' + hwTileText(snd, p, u ? u.cabs : 0) + '</span><span class="pt-pct">' + (u ? (isFinite(pct) ? pct.toFixed(0) + '%' : '—') : '0%') + '</span></span>' +
      (other.length ? '<span class="pt-warn">⚠</span>' : '') + backupTileBadge(snd, p) +   // B / P (app-backup.js)
      '<i class="pt-meter"><i class="' + mcls + '" style="width:' + meter.toFixed(1) + '%"></i></i></div>';
  }
  box.style.gridTemplateColumns = pro ? 'repeat(' + Math.max(1, Math.ceil(n / 2)) + ', minmax(var(--tile-min, 64px), 1fr))' : 'repeat(' + Math.max(1, Math.ceil(n / 2)) + ', var(--tile-w))';
  box.innerHTML = h;
  // Keep the active tile in view when it changes (Tab / Shift+Tab, the tree, the canvas menu).
  var t = box.querySelector('.pt.on'), k = snd + ':' + cur + ':' + view;
  if (t && box.clientWidth && ui.plLastKey !== k) {
    if (t.offsetLeft < box.scrollLeft) box.scrollLeft = t.offsetLeft - 10;
    else if (t.offsetLeft + t.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = t.offsetLeft + t.offsetWidth - box.clientWidth + 10;
    ui.plLastKey = k;
  }
  box.onclick = function (e) {
    var tile = e.target.closest('.pt'); if (tile) selectPort(ui.mSender || 0, +tile.dataset.p, 'port_list');
  };
  box.oncontextmenu = function (e) {
    var tile = e.target.closest('.pt'); if (!tile) return;
    e.preventDefault();
    var sp = ui.mSender || 0, pp = +tile.dataset.p;
    if (pp !== (ui.mPort || 0)) selectPort(sp, pp, 'port_list_right_click');
    portListMenu(e.clientX, e.clientY, sp, pp);
  };
}
