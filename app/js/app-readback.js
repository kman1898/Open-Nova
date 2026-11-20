// app-readback.js - read the layout the processors hold back into the project ("Read from hardware").
// User, 2026-10-11 (at the real H2 / H5): "we need a read from hardware function in the app — or better yet it auto does it
// when you open it". Online, the project should show what the hardware holds; it never silently overwrites work:
//   - automatic: when a linked processor holds a layout and the project has no panels on its cards, it is read in by
//     itself (toast, Ctrl+Z undoes); when the project has panels there that differ, a bar asks: use the processor's, or keep
//     the project's. Once per processor per session (and after each Link).
//   - by hand: Hardware card ▸ Read layout (one processor), Project ▸ Read layout from processors (all linked ones).
// NovaLCT-protocol processors return each sending card's NSSD screens (drv-lct readLayout: Standard grids with blanks,
// Complex lists); Unico / COEX return a cabinet list, read in as one Complex screen per processor. The same screen spread
// over several sending cards (one UUID) is merged. As NovaLCT's Read from HW (2026-10-28): a processor's screens come back
// as that processor's screens, in its order (ScreenIndex), into its own screen tabs (same place and name; a screen Open
// Nova sent finds its tab by its UUID, lctUuid); a screen with the same ScreenIndex on another processor is another screen
// (a screen belongs to one processor). Backup pairs stored on the processor come along. Cabinets wired to processors that
// weren't read stay as they are. The result goes
// through scrModelToProject (the .scr importer's builder) and replaceProject (undoable).
// Owns: rb, rbModelOf, rbSig, rbProjectSig, rbApply, rbRead, rbAuto, rbBar, bindReadback.
// Depends on: app-core (P, ui, $, esc, toast, uid, replaceProject, ensureLct), app-log (log), drv-core (DRV),
// app-processors (cardsOfDevice, deviceLabel, lctDevMap), app-scr-io (toScrModel, scrModelToProject), app-hardware (hw, lctUuid), scr.js (SCR).
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var rb = { asked: {}, pending: null };   // asked[devId] = auto-check done this session; pending = {devs, results} for the bar

// One processor's read-back -> screens in the .scr model's shape, with global card numbers, in the processor's own order
// (ScreenIndex: NovaLCT's Screen 1, 2 … of it). Each carries dev (the processor), uuid (NSSD) and index.
function rbModelOf(d, r) {
  var cards = cardsOfDevice(d), B = SCR.EMPTY_SENDER, out = [];
  var glob = function (dev) { return dev === 255 || cards[dev] == null ? B : cards[dev]; };
  if (r.cards) {
    var byId = {}, list = [];
    r.cards.forEach(function (c) {   // a screen on several sending cards is listed on each (one UUID): one screen
      (c.screens || []).forEach(function (s) {
        var k = s.UUID || 'i' + s.ScreenIndex, m = byId[k];
        if (!m) { m = byId[k] = { s: s, cabs: [], n: list.length }; list.push(m); }
        m.cabs = m.cabs.concat(s.CabinetInDevice || []);
      });
    });
    // each card lists only its own screens (card 2 may hold Screen 2 before card 1's Screen 3): the processor's order
    list.sort(function (a, b) { return (a.s.ScreenIndex || 0) - (b.s.ScreenIndex || 0) || a.n - b.n; });
    list.forEach(function (m) {
      var s = m.s;
      if (s.ScrType === 1 && s.CabinetCol && s.CabinetRow) {
        var tally = {}, have = {};
        m.cabs.forEach(function (k) { if (k.DevID !== 255) tally[k.Width + 'x' + k.Height] = (tally[k.Width + 'x' + k.Height] || 0) + 1; });
        var wh = (Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0] || '128x128').split('x').map(Number);
        var cells = m.cabs.map(function (k) {
          have[k.ColIndexInScreen + ',' + k.RowIndexInScreen] = 1;
          return { col: k.ColIndexInScreen, row: k.RowIndexInScreen, sender: glob(k.DevID), port: k.DevID === 255 ? 1 : k.NetPort, connect: k.DevID === 255 ? 1 : k.ConnectID,
            x: k.XPos, y: k.YPos, width: k.Width, height: k.Height, dvi: k.DviIndex || 1, xInPort: k.ColIndexInScreen, yInPort: k.RowIndexInScreen };
        });
        for (var rr = 0; rr < s.CabinetRow; rr++) for (var cc = 0; cc < s.CabinetCol; cc++) if (!have[cc + ',' + rr])   // not listed = blank
          cells.push({ col: cc, row: rr, sender: B, port: 1, connect: 1, x: (s.ScrX || 0) + cc * wh[0], y: (s.ScrY || 0) + rr * wh[1], width: wh[0], height: wh[1], dvi: 1, xInPort: cc, yInPort: rr });
        var dl = s.DVIlist || {}, xy = function (n) { return String(dl[n] || '0, 0').split(',').map(function (v) { return parseInt(v, 10) || 0; }); };
        var o1 = xy('1'), o2 = xy('2'), o3 = xy('3'), o4 = xy('4');   // the screen's DVI offsets (NSSD DVIlist "x, y"), sent back as they came
        out.push({ type: SCR.TYPE.Standard, x: s.ScrX || 0, y: s.ScrY || 0, cols: s.CabinetCol, rows: s.CabinetRow, virtualMode: s.VirMode || 0, adjust: { name: '' }, cells: cells,
          dviOffsets: { x1: o1[0], y1: o1[1], x2: o2[0], y2: o2[1], x3: o3[0], y3: o3[1], x4: o4[0], y4: o4[1] }, dev: d, uuid: s.UUID, index: s.ScreenIndex || 0 });
      } else {
        out.push({ type: SCR.TYPE.Complex, virtualMode: s.VirMode || 0, adjust: { name: '' }, dev: d, uuid: s.UUID, index: s.ScreenIndex || 0,
          regions: m.cabs.map(function (k) { return { sender: glob(k.DevID), port: k.NetPort, connect: k.ConnectID, x: k.XPos, y: k.YPos, xInPort: 0, yInPort: 0, width: k.Width, height: k.Height }; }) });
      }
    });
    return out;
  }
  if ((r.cabinets || []).length) out.push({ type: SCR.TYPE.Complex, virtualMode: 0, adjust: { name: '' }, dev: d, index: 0,   // Unico / COEX: one screen per processor
    regions: r.cabinets.map(function (c) { return { sender: glob(c.card || 0), port: c.port, connect: c.index, x: c.x, y: c.y, xInPort: 0, yInPort: 0, width: c.w, height: c.h }; }) });
  return out;
}
// What a processor holds vs what the project has on its cards: sorted "card:port:cable:x:y:w:h" lists.
function rbSig(d, r) {
  var cards = cardsOfDevice(d);
  return (r.cabinets || []).map(function (c) { return [cards[c.card || 0], c.port, c.index, c.x, c.y, c.w, c.h].join(':'); }).sort().join('|');
}
function rbProjectSig(d) {
  var cards = cardsOfDevice(d), out = [];
  toScrModel().screens.forEach(function (s) {
    (s.cells || s.regions || []).forEach(function (c) { if (cards.indexOf(c.sender) >= 0) out.push([c.sender, c.port, c.connect, c.x, c.y, c.width, c.height].join(':')); });
  });
  return out.sort().join('|');
}
// Replace what the project has on these processors with what they hold. results = [{d, r (readLayout), bk (readBackup)}].
function rbApply(results, why) {
  var devs = results.map(function (x) { return x.d; }), cardsRead = [];
  devs.forEach(function (d) { cardsRead = cardsRead.concat(cardsOfDevice(d)); });
  var screens = [];
  results.forEach(function (x) { screens = screens.concat(rbModelOf(x.d, x.r)); });
  var built = scrModelToProject({ screens: screens, dvi: { graphicsWidth: P.canvasW, graphicsHeight: P.canvasH }, warnings: [] }, P.name);
  var np = JSON.parse(JSON.stringify(P)), cellsBy = allCells(), dm = lctDevMap(cellsBy), readId = {};
  devs.forEach(function (d) { readId[d.id] = 1; });
  // The project's cabinets on the processors read go (a screen belongs to one processor: its sections are that
  // processor's alone); other processors' screens are not touched.
  np.screens = np.screens.filter(function (s) { return !(cellsBy[s.id] || []).some(function (c) { return !c.hole && c.sender != null && cardsRead.indexOf(c.sender) >= 0; }); });
  // Screen tabs, NovaLCT style: a processor's screens come back as ITS screens, in its order. A tab of a read processor that
  // is now empty is a slot: its place (and name) is reused for that processor's screens in order. A screen whose NSSD UUID
  // is the one Open Nova sent for a project screen (lctUuid of that screen and processor) goes back to that tab. Others get
  // the next slot, else a new tab right after the processor's screens. Tabs of other processors (and empty ones of none)
  // stay as they are.
  var kept = {}; np.screens.forEach(function (s) { kept[s.screenId] = 1; });
  // a processor with no screen yet takes the first empty screen of nobody, so reading doesn't leave it behind
  var slotOf = {}, list = [], spare = screens.length && !np.lct.some(function (lc) { return (dm[lc.id] || []).some(function (x) { return x.id === devs[0].id; }); }) ? devs[0] : null;
  np.lct.forEach(function (lc) {
    var ow = kept[lc.id] ? null : (dm[lc.id] || []).filter(function (x) { return readId[x.id]; })[0];
    if (!ow && spare && !kept[lc.id] && !(dm[lc.id] || []).length && !lc.dev) { ow = spare; spare = null; }
    list.push(ow ? { slot: ow.id, lc: lc } : { lc: lc });
    if (ow) slotOf[lc.id] = ow.id;
  });
  var tab = [], placed = {}, n = np.lct.length, names = np.lct.map(function (l) { return l.name; });
  results.forEach(function (x) {
    var mine = [], free = list.filter(function (e) { return e.slot === x.d.id; }).map(function (e) { return e.lc; }), want = [];
    screens.forEach(function (s, i) { if (s.dev === x.d) mine.push(i); });
    var byUuid = {}; np.lct.forEach(function (lc) { byUuid[lctUuid(lc, x.d)] = lc; });
    mine.forEach(function (i) { var lc = screens[i].uuid && byUuid[String(screens[i].uuid).toLowerCase()]; if (lc && !placed[lc.id]) { tab[i] = lc; placed[lc.id] = 1; free = free.filter(function (f) { return f !== lc; }); } });
    placed = {};
    mine.forEach(function (i) {
      if (!tab[i]) {
        if (free.length) tab[i] = free.shift();
        else { while (names.indexOf('Screen ' + (++n)) >= 0); names.push('Screen ' + n); tab[i] = { id: uid(), name: 'Screen ' + n, fresh: true }; }
      }
      if (!kept[tab[i].id] && !placed[tab[i].id]) want.push(tab[i]);   // needs a place in the list (a kept tab has one)
      placed[tab[i].id] = 1;
      if (!(dm[tab[i].id] || []).length || slotOf[tab[i].id] || tab[i].fresh) tab[i].dev = x.d.id;   // an empty one stays under it
    });
    // a tab it takes from elsewhere (by UUID: a screen given to another processor since) leaves its old place
    list = list.filter(function (e) { return e.done || e.slot === x.d.id || want.indexOf(e.lc) < 0; });
    // this processor's slots, in list order, take its screens in its order; the rest go after its last slot (or at the end)
    var at = [];
    list.forEach(function (e, k) { if (e.slot === x.d.id) at.push(k); });
    var base = at.length ? at[at.length - 1] + 1 : list.length;
    want.forEach(function (lc, j) {
      if (j < at.length) list[at[j]] = { lc: lc, done: true };
      else list.splice(base + j - at.length, 0, { lc: lc, done: true });
    });
    list.forEach(function (e) { if (e.slot === x.d.id) e.gone = true; });   // slots it didn't need: closed
  });
  np.lct = list.filter(function (e) { return !e.gone || e.done; }).map(function (e) { delete e.lc.fresh; return e.lc; });
  built.proj.screens.forEach(function (s) {
    s.screenId = tab[s.srcIndex].id; s.name = 'Section ' + (np.screens.length + 1); delete s.srcIndex;
    np.screens.push(s);
  });
  // panel types: reuse the project's own when the size matches
  var pmap = {};
  built.proj.panels.forEach(function (p) {
    var same = np.panels.filter(function (q) { return q.w === p.w && q.h === p.h; })[0];
    if (same) pmap[p.id] = same.id; else { np.panels.push(p); pmap[p.id] = p.id; }
  });
  np.screens.forEach(function (s) { if (pmap[s.panelId]) s.panelId = pmap[s.panelId]; });
  // backup pairs stored on the processors
  np.backup = np.backup || { mode: 'none', pairs: [], cards: [] };
  np.backup.pairs = (np.backup.pairs || []).filter(function (q) { return cardsRead.indexOf(q.ms) < 0 && cardsRead.indexOf(q.bs) < 0; });
  results.forEach(function (x) {
    var cards = cardsOfDevice(x.d);
    ((x.bk && x.bk.pairs) || []).forEach(function (q) { if (cards[q[0]] != null && cards[q[2]] != null) np.backup.pairs.push({ ms: cards[q[0]], mp: q[1], bs: cards[q[2]], bp: q[3] }); });
  });
  if (np.backup.pairs.length && (!np.backup.mode || np.backup.mode === 'none')) np.backup.mode = 'port';
  if (!np.lct.length) np.lct.push({ id: uid(), name: 'Screen 1' });
  var cabs = screens.reduce(function (a, s) { return a + (s.cells || s.regions).filter(function (c) { return c.sender !== SCR.EMPTY_SENDER; }).length; }, 0);
  log('read_layout', { processors: devs.map(deviceLabel), screens: screens.length, cabinets: cabs, pairs: np.backup.pairs.length, why: why });
  replaceProject(ensureLct(np));
  if (tab[0] && lctById(tab[0].id)) { ui.viewScreen = tab[0].id; renderAll(); }   // the read processor's first screen
  toast('Read ' + devs.map(deviceLabel).join(', ') + ' from the hardware: ' + screens.length + ' screen' + (screens.length === 1 ? '' : 's') + ', ' + cabs + ' cabinet' + (cabs === 1 ? '' : 's') + ' — Ctrl+Z to undo');
}
// Read (and apply) the layout of these processors; null = every linked one that can.
function rbRead(devs, apply) {
  devs = (devs || P.devices).filter(function (d) { return d.hw && DRV.of(d).readLayout; });
  // a simulated processor holds exactly what the project places (drv-offline.js): reading it in changes nothing
  var sim = devs.filter(function (d) { return DRV.caps(d).simulated; }); devs = devs.filter(function (d) { return sim.indexOf(d) < 0; });
  if (sim.length) { log('read_layout', { processors: sim.map(deviceLabel), simulated: true }); if (!devs.length) toast(sim.map(deviceLabel).join(', ') + ' (simulated) already hold' + (sim.length === 1 ? 's' : '') + ' this project’s layout — nothing changed'); }
  if (!devs.length) { if (!sim.length) toast('No linked processor can report its layout'); return Promise.resolve([]); }
  return Promise.all(devs.map(function (d) {
    var x = DRV.of(d);
    return Promise.all([x.readLayout(d), x.readBackup ? x.readBackup(d).catch(function () { return null; }) : null]).then(function (a) { return { d: d, r: a[0], bk: a[1] }; },
      function (e) { return { d: d, r: { ok: false, error: e.message } }; });
  })).then(function (res) {
    var bad = res.filter(function (x) { return !x.r.ok; });
    bad.forEach(function (x) { toast(deviceLabel(x.d) + ': couldn’t read its layout — ' + x.r.error); });
    var good = res.filter(function (x) { return x.r.ok; });
    if (apply && good.length) rbApply(good, 'by hand');
    return good;
  });
}
// Automatic, once per processor per session and after each Link: empty project there -> read it in; different -> ask.
function rbAuto(d) {
  if (!d || !d.hw || rb.asked[d.id] || !DRV.of(d).readLayout || DRV.caps(d).simulated) return;
  if (typeof olConnected === 'function' && !olConnected(d)) return;   // online: once it answers (app-online.js olConnTick asks again)
  rb.asked[d.id] = 1;
  DRV.of(d).readLayout(d).then(function (r) {
    if (!r.ok || !(r.cabinets || []).length) return;   // nothing stored there: keep the project as it is
    var hwSig = rbSig(d, r), pjSig = rbProjectSig(d);
    if (hwSig === pjSig) return;
    var x = DRV.of(d);
    return (x.readBackup ? x.readBackup(d).catch(function () { return null; }) : Promise.resolve(null)).then(function (bk) {
      if (!pjSig) return rbApply([{ d: d, r: r, bk: bk }], 'automatic: nothing in the project on this processor');
      rb.pending = { d: d, r: r, bk: bk }; rbBar();
    });
  }, function () { /* helper gone: the Hardware card says so */ });
}
function rbBar() {
  var bar = $('rbBar'); if (!bar) return;
  var p = rb.pending; bar.hidden = !p;
  if (p) $('rbText').textContent = deviceLabel(p.d) + ' holds a different layout than this project (' + (p.r.cabinets || []).length + ' cabinets on the processor).';
}
function bindReadback() {
  var bar = $('rbBar'); if (!bar) return;
  $('rbUse').onclick = function () { var p = rb.pending; rb.pending = null; rbBar(); if (p) rbApply([p], 'chosen from the bar'); };
  $('rbKeep').onclick = function () { var p = rb.pending; rb.pending = null; rbBar(); if (p) log('read_layout_kept_project', { processor: deviceLabel(p.d) }); };
  var b = $('btnReadLayout'); if (b) b.onclick = function () { rbRead(null, true); };
  // at start: once the helper answers, check every linked processor
  var tries = 0, t = setInterval(function () {
    if (hw.helper === true) { clearInterval(t); P.devices.forEach(function (d) { rbAuto(d); }); }
    else if (++tries > 30) clearInterval(t);
  }, 1000);
}
