// app-pipeline.js - the pro look's header (docs/PRO_LOOK_PLAN.md §2, user 2026-10-28: "the tiles should really be the tabs"):
// one row — the module tabs drawn as tiles (index.html's .modtabs: same ids, role="tab", Alt+1…9), each with one short live
// status line (renderTabs), then Override (Pattern ▾, Blackout, Freeze, Normal: global, every linked processor, as the
// safety rules want) and System (Send ▾, Save ▾) and Export (index.html's #pipe, the action row of every look; handlers in
// app-display.js / app-save.js). Read-only: the status lines only report; Send / Save reach a processor only through their
// own confirmations. Honest (§2.4): no "OFF" for Blackout / Freeze (Open Nova only knows what it set itself), values only
// when set here or read from a processor, "verified" = this session, errors never cleared here.
// Scope: Send / Save (and the Device tab's status line) act on the processor being worked on — on Layout the one of the
// active card / port, elsewhere the one picked in the tree / Device tab — or on the processors picked together with Ctrl/⌘-
// or Shift-click (the tree's Processors view, or the Device tile's right-click switcher; ui.devMulti, app-devices.js).
// Refresh: renderAll calls renderPipe(use, cellsBy); renderUnsaved, renderDisplayBar, rdVerifyBar and watchAlert call
// renderPipe() (safety / Save states change at once); a 1 s tick covers monitoring results that don't re-render. Classic
// look: nothing is drawn (the status lines are hidden there); only the Pattern tile's click is bound (hidden there too).
// Pictograms (DESIGN_SYSTEM.md item 1): each tab tile also carries a small picture drawn from the same data (.tpic, pro look
// only; looks/pro-tiles.css): Device the rear panel with its ports lit, Layout the screen shown in port colours, Correction
// that wall by calibration state, Screen Settings the gamma curve at the brightness, Backup the pair with its check, Preset
// the scene number, Monitor a heat map or a pulse (red on an error), Schedule the next event.
// Owns: pipe, PIPE_LED, PIPE_HEAT, proLook, setLook, mountHeader, fitPipe, pipeActive, pipeScope, pipeUse, pipeSwitcher, pipeAct,
// pipeScreenDevs, pipeN, pipeSvg, pipeRect, pipePic, pipeShown, pipeWall, pipeRear, pipeLayoutPic, pipeCorPic, pipeGammaPic, pipeBackupPic,
// pipePresetPic, pipeMonitorPic, pipeSchedulePic, pipeNextEvent, pipeTabSet, renderTabs, pipeSet, pipeStatic, renderPipe, pipeTick, bindPipeline.
// Depends on: app-core ($, ui, P, log, toast), app-geometry (allCells), app-capacity (portUsage, problems, portsOfSender,
// portColor), app-processors (deviceOfCard, deviceById, deviceLabel, cardsOfDevice, procModel), app-devices (devShow, devSelected, devMultiPick, devMultiClear,
// ui.devMulti), app-tree (activateCard), app-context-menu (openMenu, ui.menuEvent), app-hardware (hw, hwPairs, hwSendAll),
// app-save (hwUnsaved, hwSaveDevices), app-screen (scr, scrLc, scrColor, scrField, scrFmt, scrSupports, scrApplied, scrKey,
// scrRead), app-correction (cor, COR_WORDS), app-presets (scn, sceneById), app-schedule (sch), app-display (disp, dispLinked,
// openTestMenu), app-redundancy (rd), app-health (hlt), app-heat (heatMax, heatItems), app-watch (watch, watchAck), drv-core (DRV), app-shell
// (setTab), app-forms (uiZoom), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var pipe = { mounted: false, tick: null, snap: null, use: null, cellsBy: null, by: null, readKey: '', alerts: 0 };
var PIPE_LED = { ok: 'ok', warn: 'warn', err: 'bad' };

function proLook() { return document.documentElement.dataset.look === 'pro'; }
// View ▸ Look ›: 'pro' (the default) | 'classic' (the look before 2026-10-28: polish.css alone). Remembered per browser and
// applied before first paint (index.html), so the page reloads.
function setLook(n) {
  n = n === 'classic' ? 'classic' : 'pro';
  if ((document.documentElement.dataset.look || 'classic') === n) return;
  log('ui_look', { from: document.documentElement.dataset.look || 'classic', to: n });
  try { localStorage.setItem('opennova.look', n); } catch (e) { /* storage unavailable */ }
  location.reload();
}
// Pro look: the sync dot goes to the menu bar's right end (the header is tabs + actions only). Once (a look change reloads).
function mountHeader() {
  var r = document.querySelector('.menubar .mb-right');
  if (!r || !proLook() || pipe.mounted) return;
  pipe.mounted = true;
  r.insertBefore($('syncState'), r.firstChild);
}
// What fits (fitHeader calls this in the pro look, on resize and on Interface / Text size): full tiles (icon, name, status,
// lit bar) — the action groups wrap under the tabs on a narrower window; one-line tiles only when even the tabs don't fit at
// their smallest (a phone) or the window is very short.
function fitPipe() {
  var h = document.querySelector('header.bar'), t = h && h.querySelector('.modtabs'), p = $('pipe');
  if (!p || !t || !proLook()) return;
  h.classList.remove('compact', 'wrap');
  if (innerHeight / uiZoom() < 560 || t.scrollWidth > t.clientWidth + 1) h.classList.add('compact');
  else if (p.offsetTop > t.offsetTop + 4) h.classList.add('wrap');   // the action groups went under the tabs: each row fills the width (looks/pro-tiles.css)
}

// ------------------------------------------------------------------ scope: the processor being worked on, or several
function pipeActive() {
  var d = ui.tab === 'layout' ? deviceOfCard(ui.mSender || 0) : null;
  return d || (P.devices.length ? devSelected() : null) || null;
}
function pipeScope() {
  var m = (ui.devMulti || []).map(deviceById).filter(Boolean);
  if (m.length > 1) return m;
  var a = pipeActive(); return a ? [a] : [];
}
// one processor becomes the active one (the switcher; on Layout a card of it becomes the active card)
function pipeUse(d) {
  log('pipe_processor', { processor: deviceLabel(d) });
  ui.devMulti = []; ui.devSel = d.id;
  if (ui.tab === 'layout' && deviceOfCard(ui.mSender || 0) !== d) {
    var c = cardsOfDevice(d), on = c.filter(function (i) { return Object.keys(pipe.use || {}).some(function (k) { return +k.split(':')[0] === i; }); })[0];
    if (c.length) return activateCard(ui.viewScreen, on != null ? on : c[0]);
  }
  renderAll();
}
// the Device tile's right-click menu: every processor of the project; Ctrl/⌘ / Shift held = pick several (stays open)
function pipeSwitcher(btn, at) {
  var r = at || btn.getBoundingClientRect(), multi = ui.devMulti && ui.devMulti.length > 1 ? ui.devMulti : [], act = pipeActive();
  var items = [{ header: P.devices.length > 1 ? 'Processor worked on — Ctrl / Shift: several' : 'Processor' }];
  P.devices.forEach(function (d) {
    var on = multi.length ? multi.indexOf(d.id) >= 0 : d === act;
    items.push({ label: (on ? (multi.length ? '✓ ' : '● ') : '    ') + deviceLabel(d) + (d.hw ? '' : ' (not linked)'), title: 'Work on ' + deviceLabel(d) + ' (Send / Save act on it)', act: function () {
      var e = ui.menuEvent;
      if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) { devMultiPick(d, e.shiftKey); pipeSwitcher(btn, r); return; }
      pipeUse(d);
    } });
  });
  if (multi.length) items.push({ sep: true }, { label: 'Back to one processor', key: 'Esc', act: devMultiClear });
  if (!P.devices.length) items.push({ label: 'No processor yet', disabled: true });
  items.push({ sep: true }, { label: 'Open Device', act: function () { devShow(act || P.devices[0]); } });
  openMenu(r.left, r.bottom + 4, items);
}
// the Send / Save tiles' own click: the processors worked on (the ▾ label keeps the menu: all, or one); the usual
// confirmation names exactly which processors
function pipeAct(what) {
  var list = pipeScope().filter(function (d) { return d.hw && (what === 'send' || DRV.caps(d).save); });
  log('pipe_click', { tile: what, processors: list.map(deviceLabel) });
  if (!list.length) return toast((what === 'send' ? 'Send' : 'Save') + ': ' + (pipeScope().map(deviceLabel).join(', ') || 'no processor') + ' isn’t linked — the ▾ menu has the others');
  if (what === 'save') return hwSaveDevices(list);
  return hwSendAll(list);
}

// ------------------------------------------------------------------ the tabs' status lines
// lc id -> {devs: [processor], cells}, from the cells renderAll already has
function pipeScreenDevs(cellsBy) {
  var by = {};
  P.lct.forEach(function (lc) { by[lc.id] = { devs: [], cells: 0 }; });
  P.screens.forEach(function (s) {
    var e = by[s.screenId]; if (!e) return;
    (cellsBy[s.id] || []).forEach(function (c) {
      if (c.hole) return;
      e.cells++;
      var d = c.sender != null && deviceOfCard(c.sender); if (d && e.devs.indexOf(d) < 0) e.devs.push(d);
    });
  });
  return by;
}
// ------------------------------------------------------------------ the tabs' pictograms (DESIGN_SYSTEM.md item 1)
// Every tab tile carries a picture drawn from the project and the processors' state, gallery-sized (≤ 54 × 26, as
// app/out/pro/pro.js PIC), redrawn with the status lines; the markup is only replaced when it changed. Fixed colours are the
// gallery's; what depends on the theme is a class (looks/pro-tiles.css .pk-*).
var PIPE_HEAT = [[0, [29, 17, 71]], [.3, [107, 29, 120]], [.55, [194, 56, 74]], [.8, [240, 140, 44]], [1, [251, 227, 155]]];
function pipeN(v) { return Math.round(v * 10) / 10; }
function pipeSvg(w, h, body) {   // its size inline: looks/pro.css sizes the tabs' own icons
  w = pipeN(w); h = pipeN(h);
  return '<svg style="width:' + w + 'px;height:' + h + 'px" viewBox="0 0 ' + w + ' ' + h + '">' + body + '</svg>';
}
function pipeRect(x, y, w, h, a) { return '<rect x="' + pipeN(x) + '" y="' + pipeN(y) + '" width="' + pipeN(w) + '" height="' + pipeN(h) + '" ' + (a || '') + '/>'; }
function pipePic(id, svg) {
  var b = $(id); if (!b) return;
  var e = b.querySelector('.tpic');
  if (!e) { e = document.createElement('span'); e.className = 'tpic'; e.setAttribute('aria-hidden', 'true'); b.insertBefore(e, b.firstChild); pipe.refit = true; }
  if (e._pk !== svg) { e._pk = svg; e.innerHTML = svg; }
}
// the cabinets of the screen shown (holes left out)
function pipeShown() {
  var lc = scrLc(), out = [];
  if (lc) P.screens.forEach(function (s) { if (s.screenId === lc.id) (pipe.cellsBy[s.id] || []).forEach(function (c) { if (!c.hole) out.push(c); }); });
  return out;
}
// cabinets fitted into at most W × H on a dark well, each drawn with f(c) = its attributes
function pipeWall(cells, W, H, f, top) {
  if (!cells.length) return pipeSvg(W, H, pipeRect(.5, .5, W - 1, H - 1, 'rx="1.5" class="pk-well"') + '<path d="M' + (W / 2 - 5) + ' ' + H / 2 + 'h10M' + W / 2 + ' ' + (H / 2 - 5) + 'v10" class="pk-grid"/>');
  var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  cells.forEach(function (c) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); });
  var k = Math.min((W - 2) / Math.max(1, x1 - x0), (H - 2) / Math.max(1, y1 - y0)), w = (x1 - x0) * k + 2, h = (y1 - y0) * k + 2, s = '';
  cells.forEach(function (c) { s += pipeRect(1 + (c.x - x0) * k + .25, 1 + (c.y - y0) * k + .25, Math.max(.6, c.w * k - .5), Math.max(.6, c.h * k - .5), f(c)); });
  return pipeSvg(w, h, pipeRect(.5, .5, w - 1, h - 1, 'class="pk-wallbg"') + s + (top || '') + pipeRect(.5, .5, w - 1, h - 1, 'class="pk-edge"'));
}
// Device: the processor's rear panel, its ports lit by use (green), backup (blue), over capacity (red); the power light
// green linked, red not answering, dark not linked
function pipeRear(d, power) {
  var s = pipeRect(.5, 2.5, 53, 21, 'rx="2" class="pk-chassis"') + pipeRect(2.5, 4.5, 49, 17, 'rx="1" class="pk-bezel"');
  if (!d) return pipeSvg(54, 26, s);
  var cards = cardsOfDevice(d), bk = {}, b = P.backup || {}, rows = [];
  if (b.mode === 'port') (b.pairs || []).forEach(function (p) { bk[p.bs + ':' + p.bp] = 1; });
  cards.forEach(function (i) {
    var n = portsOfSender(i) || 0, split = cards.length <= 2 && n > 6 ? 2 : 1, per = Math.ceil(n / split);
    for (var r = 0; r < split; r++) rows.push([i, r * per, Math.min(n, (r + 1) * per)]);
  });
  rows = rows.slice(0, 6);
  var rh = 13 / Math.max(1, rows.length);
  rows.forEach(function (r, ri) {
    var n = r[2] - r[1], pw = Math.min(3.4, (31 - (n - 1) * .8) / Math.max(1, n)), ph = Math.max(1, Math.min(2.6, rh - 1));
    for (var p = r[1]; p < r[2]; p++) {
      var u = pipe.use[r[0] + ':' + p], c = u && u.load > u.cap ? 'pk-bad' : u ? 'pk-ok' : bk[r[0] + ':' + p] ? 'pk-bk' : 'pk-off';
      s += pipeRect(20 + (p - r[1]) * (pw + .8), 6.5 + ri * rh + (rh - ph) / 2, pw, ph, 'rx=".4" class="' + c + '"');
    }
  });
  var h = procModel(d.model).kind === 'chassis';
  s += pipeRect(5, 7, 12, 8.5, 'rx="1" class="pk-lcd"') + (h ? '<path d="M6.5 13l2.3-2.8 1.9 1.9 2.3-3.2 1.9 4.1" class="pk-wave"/>' : '<path d="M6.5 12.2h9" class="pk-wave"/>') +
    '<circle cx="6.5" cy="18.5" r="1.1" class="pk-' + power + '"/><path d="M9.5 18.5h8" class="pk-groove"/>';
  return pipeSvg(54, 26, s);
}
// Layout: the screen shown as a mini wall in its port colours (red = over capacity, grey = not wired)
function pipeLayoutPic(cells) {
  return pipeWall(cells, 52, 26, function (c) {
    if (c.sender == null) return 'class="pk-free"';
    var u = pipe.use[c.sender + ':' + c.port];
    return 'fill="' + (u && u.load > u.cap ? '#f0484d' : portColor(c.sender, c.port)) + '" class="pk-cab"';
  });
}
// Correction: the same wall, each cabinet by what its processor reported: calibrated (green), off (grey), mixed on its
// port (amber), no answer (red), not read yet (empty)
function pipeCorPic(cells) {
  var per = {};
  (P.devices || []).forEach(function (d) {
    var x = cor.data[d.id]; if (!x || !x.by) return;
    var cards = cardsOfDevice(d), m = per[d.id] = { err: !!x.error };
    Object.keys(x.by).forEach(function (k) {
      var a = k.split(':'), key = cards[+a[0]] + ':' + a[1], o = m[key] || (m[key] = { on: 0, off: 0 }), md = x.by[k].mode;
      if (md) o[md === 'off' ? 'off' : 'on']++;
    });
  });
  return pipeWall(cells, 52, 26, function (c) {
    var d = c.sender != null && deviceOfCard(c.sender), m = d && per[d.id], o = m && m[c.sender + ':' + c.port];
    return 'class="' + (!m ? 'pk-cell' : m.err ? 'pk-cbad' : !o ? 'pk-cell' : o.on && o.off ? 'pk-cmix' : o.on ? 'pk-con' : 'pk-coff') + '"';
  });
}
// Screen Settings: the gamma curve, scaled by the brightness (its level dashed), tinted by the colour temperature
function pipeGammaPic(v) {
  var g = +v.gamma || 2.8, br = Math.max(0, Math.min(100, +v.brightness)) / 100, ct = +v.colorTemp || 6500, pts = [], i;
  if (isNaN(br)) br = 1;
  for (i = 0; i <= 18; i++) pts.push(pipeN(1 + i * 2) + ' ' + pipeN(25 - br * Math.pow(i / 18, g) * 24));
  var tint = ct < 6000 ? '#ffc27a' : ct > 7500 ? '#a9c8ff' : '';
  return pipeSvg(38, 26, pipeRect(.5, .5, 37, 25, 'rx="1.5" class="pk-well"') + '<path d="M10 1v24M19 1v24M28 1v24M1 7h36M1 13h36M1 19h36" class="pk-grid"/>' +
    '<path d="M1 25L' + pts.join('L') + 'V25z" class="pk-gfill"/>' + '<path d="M1 ' + pipeN(25 - br * 24) + 'h36" class="pk-level"/>' +
    '<path d="M' + pts.join('L') + '" class="pk-curve"' + (tint ? ' style="stroke:' + tint + '"' : '') + '/>');
}
// Backup: primary and backup, joined, and a check box: green verified this session, amber verify on / across processors
function pipeBackupPic(st) {
  return pipeSvg(46, 26, '<g' + (st === 'none' ? ' class="pk-dim"' : '') + '>' + pipeRect(1.5, 2.5, 14, 8, 'rx="1.2" class="pk-prim"') +
    pipeRect(1.5, 15.5, 14, 8, 'rx="1.2" class="pk-sec"') + '<path d="M15.5 6.5h7v13h-7M22.5 13h4" class="pk-wire"/>' +
    pipeRect(28.5, 5.5, 15, 15, 'rx="1.5" class="pk-box"') +
    (st === 'ok' || st === 'warn' ? '<path d="M32 13.5l3 3 5-6.5" class="pk-check' + (st === 'warn' ? ' warn' : '') + '"/>' : '') + '</g>');
}
// Preset: the scene recalled last as a numbered plate on the stack of scenes
function pipePresetPic(n, count) {
  return pipeSvg(40, 26, (count > 2 ? pipeRect(13.5, .5, 25, 17, 'rx="2" class="pk-plate2"') : '') + (count > 1 ? pipeRect(10, 3, 25.5, 18, 'rx="2" class="pk-plate2"') : '') +
    pipeRect(6.5, 5.5, 26, 19, 'rx="2" class="pk-plate' + (n ? ' on' : '') + '"') +
    '<text x="19.5" y="19.3" text-anchor="middle" class="pk-num' + (n ? '' : ' none') + '">' + (n || '–') + '</text>');
}
// Monitor: a mini heat map of the screen shown (temperatures, when readings came in), else a pulse line; red on an error
function pipeMonitorPic(cells, level) {
  var it = typeof heatItems === 'function' ? heatItems(cells, 'temp') : [], vals = it.filter(function (x) { return x.w; }).map(function (x) { return x.v; });
  var pulse = function (w, h) { var y = h / 2 + 1, k = w / 46; return '<path d="M1 ' + y + 'h' + pipeN(10 * k) + 'l' + pipeN(3 * k) + ' -8l' + pipeN(5 * k) + ' 15l' + pipeN(4 * k) + ' -11l' + pipeN(3 * k) + ' 4H' + (w - 1) + '" class="pk-pulse ' + level + '"/>'; };
  if (!vals.length) return pipeSvg(46, 26, pulse(46, 26));
  var lo = Math.min.apply(null, vals), hi = Math.max(lo + 4, Math.max.apply(null, vals)), map = {};
  it.forEach(function (x) { map[x.c.x + ',' + x.c.y] = x; });
  var svg = pipeWall(cells, 52, 26, function (c) {
    var x = map[c.x + ',' + c.y]; if (!x || !x.w) return 'class="pk-cell"';
    var f = (x.v - lo) / (hi - lo), i = 1; while (i < PIPE_HEAT.length - 1 && PIPE_HEAT[i][0] < f) i++;
    var a = PIPE_HEAT[i - 1], b = PIPE_HEAT[i], t = Math.max(0, Math.min(1, (f - a[0]) / (b[0] - a[0] || 1)));
    return 'fill="rgb(' + [0, 1, 2].map(function (j) { return Math.round(a[1][j] + (b[1][j] - a[1][j]) * t); }).join(',') + ')"';
  }, level === 'bad' ? '<g class="pk-over">' + pulse(52, 26) + '</g>' : '');
  return svg;
}
// Schedule: a clock at the next event's start (else now, dimmed) and its brightness as a level bar
function pipeSchedulePic(next) {
  var t = next ? next.h * 60 + next.m : new Date().getHours() * 60 + new Date().getMinutes(), ha = (t % 720) / 720 * 2 * Math.PI, ma = (t % 60) / 60 * 2 * Math.PI;
  var hand = function (a, r) { return 'L' + pipeN(13 + Math.sin(a) * r) + ' ' + pipeN(13 - Math.cos(a) * r); };
  var lv = next && next.b != null ? Math.max(0, Math.min(100, next.b)) / 100 : 0;
  return pipeSvg(38, 26, '<g' + (next ? '' : ' class="pk-dim"') + '><circle cx="13" cy="13" r="11.5" class="pk-face"/>' +
    '<path d="M13 3v2M13 21v2M3 13h2M21 13h2" class="pk-tick"/><path d="M13 13' + hand(ha, 5.5) + 'M13 13' + hand(ma, 8.5) + '" class="pk-hand"/><circle cx="13" cy="13" r="1.3" class="pk-pin"/>' +
    pipeRect(29.5, 2.5, 7, 21, 'rx="1.2" class="pk-well"') + (lv ? pipeRect(31, 22 - lv * 18, 4, lv * 18, 'rx=".6" class="pk-lv"') : '') + '</g>');
}
// the next brightness event of the linked processors (read on the Schedule tab): {h, m, b} or null
function pipeNextEvent(linked) {
  var now = new Date(), cur = now.getHours() * 60 + now.getMinutes(), best = null;
  linked.forEach(function (d) {
    var e = sch[d.id]; if (!e || !e.enable) return;
    (e.brightness || []).forEach(function (q) {
      var mt = /\b(\d{1,2}):(\d{2})/.exec(String(q.start || '')); if (!mt) return;
      var t = +mt[1] * 60 + +mt[2], dt = (t - cur + 1440) % 1440;
      if (!best || dt < best.dt) best = { h: +mt[1], m: +mt[2], b: q.sensor ? null : +q.brightness, dt: dt };
    });
  });
  return best;
}

// one status line: text ('' = none), cls '' | dim | ok | warn | bad, tip appended to the tab's own tooltip
function pipeTabSet(id, text, cls, tip) {
  var b = $(id), e = b && b.querySelector('.tab-st'); if (!e) return;
  if (e.textContent !== text) e.textContent = text;
  var c = 'tab-st' + (cls ? ' ' + cls : ''); if (e.className !== c) e.className = c;
  e.hidden = !text;
  if (e.title !== (tip || text)) e.title = tip || text;
  if (b.dataset.st !== (cls || '')) b.dataset.st = cls || '';   // the tile's lit bar (looks/pro.css)
}
function renderTabs(scope) {
  var by = pipe.by, use = pipe.use, linked = (P.devices || []).filter(function (d) { return d.hw; });
  var mute = function (d) { return (hlt.watch[d.id] || {}).err || (hw.watch[d.id] || {}).err; };
  // Device: the processor worked on (or how many are picked)
  var d0 = scope[0], shown = pipeShown();
  // ports of the processor worked on: used (and backup) of all ("H5 · 8/36")
  var pu = 0, pt = 0, bks = {}, bb = P.backup || {};
  if (bb.mode === 'port') (bb.pairs || []).forEach(function (p) { bks[p.bs + ':' + p.bp] = 1; });
  if (d0) cardsOfDevice(d0).forEach(function (i) { var n = portsOfSender(i) || 0; pt += n; for (var p = 0; p < n; p++) if (use[i + ':' + p] || bks[i + ':' + p]) pu++; });
  if (scope.length > 1) pipeTabSet('tabDevices', scope.length + ' processors', '', 'Picked together (Send / Save act on them): ' + scope.map(deviceLabel).join(', ') + ' · Esc = one again');
  else if (d0) pipeTabSet('tabDevices', deviceLabel(d0) + (pt ? ' · ' + pu + '/' + pt : ''), !d0.hw ? 'dim' : mute(d0) ? 'bad' : 'ok',   // the bar: green linked, red not answering, dark not linked
    deviceLabel(d0) + ' · ' + (!d0.hw ? 'not linked' : mute(d0) ? 'not answering' : 'linked') + (pt ? ' · ' + pu + ' of ' + pt + ' ports used (backup included)' : '') + ' · the processor worked on (Send / Save act on it) · right-click: another, or several');
  else pipeTabSet('tabDevices', 'none yet', 'dim');
  pipePic('tabDevices', pipeRear(d0, !d0 || !d0.hw ? 'off' : mute(d0) ? 'bad' : 'ok'));
  // Layout: screens, cabinets, ports over capacity
  var cab = 0; Object.keys(by).forEach(function (k) { cab += by[k].cells; });
  var over = Object.keys(use).filter(function (k) { return use[k].load > use[k].cap; }).length, probs = problems(pipe.cellsBy, use) || [];
  pipeTabSet('tabLayout', over ? over + ' port' + (over === 1 ? '' : 's') + ' over' : cab ? cab + ' cab' : P.lct.length + ' screen' + (P.lct.length === 1 ? '' : 's'),
    over ? 'bad' : probs.length ? 'warn' : cab ? '' : 'dim', (probs.length ? probs[0] + ' · ' : '') + P.lct.length + ' screen' + (P.lct.length === 1 ? '' : 's') + ' · ' + cab + ' cabinets placed');
  pipePic('tabLayout', pipeLayoutPic(shown));
  // Correction: what the processors reported (read on the Correction tab), on or off
  var modes = {};
  linked.forEach(function (d) { var x = cor.data[d.id]; if (x && x.by && !x.error) Object.keys(x.by).forEach(function (k) { var m = x.by[k].mode; if (m) modes[m === 'off' ? 'off' : 'on'] = 1; }); });
  var mk = Object.keys(modes);
  pipeTabSet('tabCorrection', mk.length > 1 ? 'mixed' : mk[0] || '', mk[0] === 'off' && mk.length === 1 ? 'dim' : '', 'Calibration as the processors reported it');
  pipePic('tabCorrection', pipeCorPic(shown));
  // Screen Settings: brightness · gamma · colour temperature of the screen shown, only what is set here or read
  var lc = scrLc(), sv = [], amber = false, val = null;
  if (lc && by[lc.id]) {
    var devs = by[lc.id].devs, lnk = devs.filter(function (d) { return d.hw; }), want = lc.color || {};
    val = scrColor(lc);
    ['brightness', 'gamma', 'colorTemp'].forEach(function (k) {
      var f = scrField(k), held = lnk.some(function (d) { return scrSupports(d, f) && scrApplied(d, lc)[k] !== undefined; });
      if (k in want || held) sv.push(scrFmt(f, val[k]));
      if (k in want && lnk.some(function (d) { return scrSupports(d, f) && scrApplied(d, lc)[k] !== want[k]; })) amber = true;
    });
    // a processor linked, or another screen shown: read what it holds (read-only, once per link and screen: scr.readDone)
    var rk = lc.id + '|' + lnk.map(function (d) { return scrKey(d, lc); }).join(',');
    if (lnk.length && rk !== pipe.readKey) { pipe.readKey = rk; setTimeout(function () { if (!scr.busy) scrRead(lc); }, 0); }
  }
  // the tile shows brightness · gamma; the tooltip all three
  pipeTabSet('tabScreen', sv.slice(0, 2).join(' · '), amber ? 'warn' : '', lc ? lc.name + (sv.length ? ': ' + sv.join(' · ') : '') + (amber ? ' · not applied everywhere yet' : '') : '');
  pipePic('tabScreen', pipeGammaPic(val || {}));
  // Backup: the plan, verify on, verified this session
  var b = P.backup || {}, mode = b.mode || 'none', n = mode === 'port' ? (b.pairs || []).length : mode === 'card' ? (b.cards || []).length : 0;
  var verifying = Object.keys(rd.state).filter(function (k) { return rd.state[k]; }), ver = Object.keys(rd.verified).length;
  var cross = (P.devices || []).some(function (d) { return hwPairs(d).cross.length; });
  pipeTabSet('tabBackup', verifying.length ? 'verify on' : mode === 'none' || !n ? 'none' : n + (mode === 'port' ? (n === 1 ? ' pair' : ' pairs') : (n === 1 ? ' card' : ' cards')) + (ver ? ' ✓' : ''),
    verifying.length || cross ? 'warn' : mode === 'none' || !n ? 'dim' : ver ? 'ok' : '', verifying.length ? 'Verify is on: runs on the backup ports' : cross ? 'Pairs reach across processors' : ver ? 'Verified this session' : '');
  pipePic('tabBackup', pipeBackupPic(mode === 'none' || !n ? 'none' : verifying.length || cross ? 'warn' : ver ? 'ok' : 'plan'));
  // Preset: the scene recalled last (this session)
  var sc = scn.last && typeof sceneById === 'function' ? sceneById(scn.last) : null, scs = P.scenes || [];
  pipeTabSet('tabPresets', sc ? sc.name : scs.length ? scs.length + ' scene' + (scs.length === 1 ? '' : 's') : '', sc ? '' : 'dim', sc ? 'Last recalled: ' + sc.name : '');
  pipePic('tabPresets', pipePresetPic(sc ? scs.indexOf(sc) + 1 : 0, scs.length));
  // Monitor: errors held until Clear, processors not answering, warnings, cabinets on backup; the helper missing first
  var held = Object.keys(hlt.held).map(function (k) { return hlt.held[k]; }).filter(function (r) { return !r.ended; });
  var errs = held.filter(function (r) { return r.level === 'error'; }).length, warns = held.length - errs, bk = 0, quiet = linked.filter(mute);
  linked.forEach(function (d) { var h = hlt.by[d.id]; if (h && h.sum) bk += h.sum.backup; });
  var hot = typeof heatMax === 'function' && linked.length ? heatMax() : null;
  var hoff = hw.helper === false && !(typeof olMode === 'function' && olMode() === 'offline');   // offline: simulated processors need no helper
  var mv = hoff ? 'helper off' : !linked.length ? '' : errs ? errs + ' ERR' : quiet.length ? quiet.length + ' no reply' : warns ? warns + ' warn' : bk ? bk + ' on backup' : 'OK';
  var ml = hoff || errs || quiet.length ? 'bad' : warns || bk ? 'warn' : linked.length ? 'ok' : '';
  pipeTabSet('tabHealth', mv, ml, hoff ? 'The helper isn’t running: no processor can be reached' :
    errs + ' error' + (errs === 1 ? '' : 's') + ' · ' + warns + ' warning' + (warns === 1 ? '' : 's') + (bk ? ' · ' + bk + ' cabinets on backup' : '') +
    (quiet.length ? ' · not answering: ' + quiet.map(deviceLabel).join(', ') : '') + (hot ? ' · hottest ' + hot.text + ' (' + hot.label + ')' : '') + ' · errors stay until you clear them on Monitor');
  pipePic('tabHealth', pipeMonitorPic(linked.length ? shown : [], ml || 'none'));
  var mt = $('tabHealth');
  if (mt && watch.alerts > pipe.alerts) { mt.classList.remove('flash'); void mt.offsetWidth; mt.classList.add('flash'); }
  pipe.alerts = watch.alerts;
  // Schedule: what the processors said (read on the Schedule tab): the next event, else on / off
  var se = linked.map(function (d) { return sch[d.id] && sch[d.id].enable; }).filter(function (x) { return x !== undefined && x !== null; });
  var nx = pipeNextEvent(linked), nt = nx ? ('0' + nx.h).slice(-2) + ':' + ('0' + nx.m).slice(-2) : '';
  pipeTabSet('tabSchedule', nx ? nt + (nx.b != null ? ' · ' + nx.b + ' %' : '') : se.length ? (se.some(Boolean) ? 'on' : 'off') : '', se.some(Boolean) ? '' : 'dim',
    nx ? 'Next: ' + nt + (nx.b != null ? ', brightness ' + nx.b + ' %' : ', light sensor') + ' · the processors’ own brightness schedule' : 'The processors’ own brightness schedule');
  pipePic('tabSchedule', pipeSchedulePic(nx));
}

// ------------------------------------------------------------------ the action tiles (today's buttons: only value and light)
function pipeSet(b, v, led) {
  if (!b) return;
  var e = b.querySelector('.v'), l = b.querySelector('.led');
  if (e && e.textContent !== v) e.textContent = v;
  if (l) { var c = 'led' + (led ? ' ' + led : ''); if (l.className !== c) l.className = c; }
}
function pipeStatic(scope) {
  var ids = scope.map(function (d) { return d.id; }), linked = scope.filter(function (d) { return d.hw; }), none = !dispLinked().length, who = scope.map(deviceLabel).join(', ');
  var tp = $('btnTestHdr');
  if (tp) { tp.disabled = none || !!tp.dataset.ro; pipeSet(tp, disp.pattern || '', disp.pattern ? 'bad' : ''); tp.classList.toggle('on', !!disp.pattern); }
  ['btnBlackout', 'btnFreeze'].forEach(function (id) { var b = $(id); pipeSet(b, b.classList.contains('on') ? 'On' : '', b.classList.contains('on') ? 'bad' : ''); });
  // Save: what Open Nova sent and the processors worked on haven't stored in flash ("2 of 3 not saved"); the tile stays amber
  // while any processor has something not saved (renderUnsaved sets .warn: the save state is never hidden, §2.3)
  var all = hwUnsaved(), un = all.filter(function (d) { return ids.indexOf(d.id) >= 0; }), others = all.length - un.length, sv = $('btnSaveHw');
  pipeSet(sv, hw.busy === 'save' ? 'Saving…' : !linked.length ? (others ? others + ' other' + (others === 1 ? '' : 's') + ' not saved' : '—') :
    un.length ? (scope.length > 1 ? un.length + ' of ' + linked.length + ' not saved' : 'Not saved') : others ? others + ' other' + (others === 1 ? '' : 's') + ' not saved' : 'Saved', all.length ? 'warn' : '');
  if (sv && !sv.dataset.ro) { var st = 'Save ' + (who || 'the processor worked on') + ' (click; asks first) · Save ▾: all processors, or one · stores the settings in flash; never part of Send'; if (sv.title !== st) sv.title = st; }
  var live = linked.length && linked.every(function (d) { return DRV.caps(d).applyMode === 'live' && d.hw.kind !== 'offline' && d.hw.liveApply !== false; });
  var sd = $('btnSendHdr');
  pipeSet(sd, hw.busy === 'send' ? 'Sending…' : !linked.length ? 'Not linked' : live ? 'Live' : scope.length > 1 ? 'These ' + linked.length : 'This one', linked.length ? 'blue' : '');
  if (sd && !sd.dataset.ro) { var tt = 'Send the layout to ' + (who || 'the processor worked on') + ' (click; asks first) · Send ▾: all processors, one, or Compare'; if (sd.title !== tt) sd.title = tt; }
}
function renderPipe(use, cellsBy) {
  if (!proLook() || !$('pipe')) return;
  if (use && cellsBy) { pipe.use = use; pipe.cellsBy = cellsBy; pipe.snap = ui.lastSnap; pipe.by = pipeScreenDevs(cellsBy); }
  else if (!pipe.use || pipe.snap !== ui.lastSnap) { pipe.cellsBy = allCells(); pipe.use = portUsage(pipe.cellsBy); pipe.snap = ui.lastSnap; pipe.by = pipeScreenDevs(pipe.cellsBy); }
  var scope = pipeScope();
  renderTabs(scope);
  pipeStatic(scope);
  if (pipe.refit) { pipe.refit = false; fitPipe(); }   // the first pictograms changed the tiles' widths
}
// monitoring results that don't re-render (hltPoll only redraws the Monitor tab / the canvas, hwDetect only its card)
function pipeTick() { if (!document.hidden && proLook()) renderPipe(); }

function bindPipeline() {
  mountHeader();
  // Pattern (both looks; hidden in classic) = Layout ▸ Test ▾'s menu
  $('btnTestHdr').onclick = function (e) { e.stopPropagation(); log('pipe_click', { tile: 'pattern' }); openTestMenu(this); };
  if (!proLook()) return;
  // the Device tile: right-click = the processor worked on, or several (the tree's Processors view does the same)
  $('tabDevices').oncontextmenu = function (e) { e.preventDefault(); pipeSwitcher(this); };
  // the Monitor tile carries the alarm count: opening it clears the "new since you looked" count (never the errors: only Clear)
  $('tabHealth').addEventListener('click', function () { if (watch.alerts) watchAck(); });
  // Send / Save: a click on the tile = the processors worked on (asks first); the "Send ▾" / "Save ▾" label, the keyboard and
  // the UI checks (no pointer) = the menu as before (all processors, or one)
  ['btnSendHdr', 'btnSaveHw'].forEach(function (id) {
    var b = $(id), menu = b.onclick;
    b.onclick = function (e) {
      if (!e.detail || e.target.closest('.t')) return menu.call(this, e);
      e.stopPropagation(); pipeAct(id === 'btnSendHdr' ? 'send' : 'save');
    };
  });
  pipe.tick = setInterval(pipeTick, 1000);
  if (typeof fitHeader === 'function') fitHeader();
}
