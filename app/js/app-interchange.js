// app-interchange.js - files from the other tools (design phase 13). For now: Unico's screen export (the JSON of
// GET screen/topology/export, docs\samples\unico_screen_config_export_vx2000pro.json) becomes a new screen in the open
// project: one free-form ("complex") section with every cabinet at its place, wired as on the Unico processor
// (port and cable order from the cabinet ID: (MAC & 0xFFFFFF) << 32 | slot << 24 | port << 16 | index).
// The cabinets go on the active sending card (Unico VX Pro processors have one). Rotation is kept only as a note.
// Opening any of these files (Project ▾ Open file…) makes a new project in the server's list (openFile, importTake).
// Owns: fileBase, importTake, openFile, importUscr, uscrPlace, uscrCabinets, importNprj, nprjToProject, bindInterchange.
// Depends on: app-core (P, ui, $, uid, toast, commit, replaceProject, newProject, ensureLct), app-log (log), app-sections
// (showScreen), app-render (renderAll), app-sync (projShared, projCreate), app-scr-io (importScr), app-scfg (importScfg),
// all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// [{x, y, w, h, port, index, angle}] from an export (an array of screens, or one screen object).
function uscrCabinets(j) {
  var list = Array.isArray(j) ? j : [j], out = [];
  list.forEach(function (scr) {
    var d = scr.data || scr;
    (d.canvasInfoList || []).forEach(function (cv) {
      var cp = cv.canvasPosition || { x: 0, y: 0 };
      (cv.topologyList || []).forEach(function (t) {
        var raw = t.cabinetID != null ? t.cabinetID : t.cid;
        if (raw == null || !/^\d+$/.test(String(raw))) return;   // no usable cabinet ID: skip it (BigInt would throw)
        var id = BigInt(String(raw)), pos = t.cabinetPosition || {}, sz = t.cabinetSize || {};
        out.push({ x: (pos.x || 0) + (cp.x || 0), y: (pos.y || 0) + (cp.y || 0), w: sz.width, h: sz.height,
          port: Number((id >> 16n) & 0xFFn), index: Number(id & 0xFFFFn), angle: t.angle || 0 });
      });
    });
  });
  return out;
}
// Project ▾ Open file… makes a new project in the server's list, named after the file, as VMP does; Import into this
// project… puts the file into the open one (Ctrl+Z undoes it). Without the server's list (the app opened as a file) both go
// into this project, as before. asNew = from Open file…; direct calls (tests) import into this project.
function fileBase(name) { return String(name || '').replace(/\.(ledmap\.json|json|scr|scfg|uscr|nprj)$/i, '').slice(0, 80) || 'Imported'; }
function importTake(pj, fileName, asNew, done) {
  if (asNew && projShared()) {
    pj.name = fileBase(fileName);
    log('import_new_project', { file: fileName, name: pj.name });
    return projCreate(pj, done);   // app-sync.js: every browser switches to it
  }
  replaceProject(pj); if (done) done();
}
function openFile(f, asNew) {
  var kind = (/\.(\w+)$/.exec(f.name) || ['', ''])[1].toLowerCase();
  log('open_file', { file: f.name, bytes: f.size, kind: kind, as: asNew && projShared() ? 'new project' : 'into this project' });
  if (kind === 'nprj') return importNprj(f, asNew);
  var rd = new FileReader();
  rd.onload = function () {
    try {
      if (kind === 'json' || kind === 'uscr') {
        var t = new TextDecoder().decode(rd.result), pj = null;
        if (kind === 'json') { try { pj = JSON.parse(t); } catch (e) { throw new Error('not JSON'); } }
        if (pj && pj.screens && pj.panels) importTake(ensureLct(pj), f.name, asNew, function () { toast('Opened ' + f.name + (asNew && projShared() ? ' as project “' + P.name + '”' : '')); });
        else importUscr(t, f.name, asNew);   // a Unico screen export saved as .json
      } else if (kind === 'scfg') importScfg(rd.result, f.name, asNew);   // app-scfg.js
      else importScr(rd.result, f.name, asNew);                             // app-scr-io.js
    } catch (err) { log('open_file_failed', { file: f.name, error: err.message, stack: String(err.stack || '').slice(0, 1500) }); toast('Could not open ' + f.name + ': ' + err.message); }
  };
  rd.readAsArrayBuffer(f);
}
function importUscr(text, fileName, asNew) {
  var j;
  // cabinet IDs are 64-bit: keep long numbers as text before JSON.parse rounds them (the low bits are the cable position)
  text = String(text).replace(/("(?:cid|cabinetID)"\s*:\s*)(\d{16,})/g, '$1"$2"');
  try { j = JSON.parse(text); } catch (e) { toast('This .uscr isn’t the JSON form of Unico’s screen export (other encodings aren’t known yet)'); log('import_uscr', { file: fileName, error: 'not JSON' }); return; }
  var cabs = uscrCabinets(j).filter(function (c) { return c.w > 0 && c.h > 0; });
  if (!cabs.length) { toast('No cabinets in ' + fileName + (/\.json$/i.test(fileName) ? ' (neither an Open Nova project nor a Unico screen export)' : '')); log('import_uscr', { file: fileName, cabinets: 0 }); return; }
  if (asNew && projShared()) {   // a new project with just this screen (on a "Pick a model" processor with the ports used: uscrPlace)
    var pj = ensureLct(newProject()); pj.lct[0].name = fileBase(fileName).slice(0, 40);
    return importTake(pj, fileName, true, function () { ui.mSender = 0; uscrPlace(cabs, fileName, P.lct[0]); });
  }
  uscrPlace(cabs, fileName, null);
}
// the cabinets into a new screen (or into screen lc0, still empty) on the active sending card
function uscrPlace(cabs, fileName, lc0) {
  var sender = ui.mSender != null && ui.mSender < P.processors.length ? ui.mSender : 0;
  var need = Math.max.apply(null, cabs.map(function (c) { return c.port + 1; }));
  if (!P.devices.length) {   // no processor yet: the screen's Unico processor, model unknown ("Pick a model" in Device)
    var nd = { id: uid(), model: 'custom', name: newProcName(P.devices, 'custom') };
    P.devices.push(nd); P.processors.push({ ports: Math.min(MAX_CARD_PORTS, Math.max(1, need)), dev: nd.id }); sender = 0;
  }
  var card = P.processors[sender], cdev = deviceOfCard(sender);
  if (card && card.ports < need && !(cdev && procModel(cdev.model).kind === 'custom')) {   // never grow a real model's card
    log('import_uscr', { file: fileName, refused: 'needs port ' + need + ', card has ' + card.ports });
    return toast('These cabinets use port ' + need + ' but ' + cardName(sender, true) + ' has ' + card.ports + ' ports — pick one with enough ports (click it in the tree) and import again');
  }
  var x0 = Math.min.apply(null, cabs.map(function (c) { return c.x; })), y0 = Math.min.apply(null, cabs.map(function (c) { return c.y; }));
  var tally = {}; cabs.forEach(function (c) { var k = c.w + 'x' + c.h; tally[k] = (tally[k] || 0) + 1; });
  var best = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0].split('x').map(Number);
  var panel = P.panels.filter(function (p) { return p.w === best[0] && p.h === best[1]; })[0];
  if (!panel) { panel = { id: uid(), name: 'Cabinet ' + best[0] + '×' + best[1], w: best[0], h: best[1] }; P.panels.push(panel); }
  var lc = lc0 || { id: uid(), name: fileName.replace(/\.(uscr|json)$/i, '').slice(0, 40) || 'Unico screen' };
  if (!lc0) P.lct.push(lc);
  var s = { id: uid(), kind: 'complex', name: 'Section 1', screenId: lc.id, x: x0, y: y0, panelId: panel.id, holes: {}, manual: {}, override: {}, raw: {}, regions: [],
    wiring: { mode: 'manual', corner: 'TL', dir: 'V', pattern: 'serpentine', split: 'lines', max: 0, restart: 'continue', sender: sender, port: 0 } };
  var maxPort = 0;
  cabs.sort(function (a, b) { return a.port - b.port || a.index - b.index; }).forEach(function (c, i) {
    s.regions.push({ dx: c.x - x0, dy: c.y - y0, w: c.w, h: c.h });
    s.manual[String(i)] = { sender: sender, port: c.port, connect: c.index };
    maxPort = Math.max(maxPort, c.port + 1);
  });
  if (P.processors[sender] && P.processors[sender].ports < maxPort) P.processors[sender].ports = maxPort;
  P.screens.push(s);
  var rot = cabs.filter(function (c) { return c.angle; }).length;
  log('import_uscr', { file: fileName, cabinets: cabs.length, ports: maxPort, card: sender + 1, rotated: rot });
  commit(); showScreen(lc.id); renderAll();
  toast('Imported ' + cabs.length + ' cabinets on ' + cardName(sender, true) + ' as “' + lc.name + '”' + (rot ? ' — ' + rot + ' rotated in Unico (rotation not kept)' : ''));
}
// VMP project (.nprj) -> a new Open Nova project (the old one stays one Ctrl+Z away, like Open). The helper reads the file
// (tools/vmpproject.py); here: a processor per controller (MX40 Pro …, or a chassis with its output cards by ModelID), a
// screen per VMP screen with its cabinets at their places in cable order (a section of free-placed cabinets), and the
// port backup pairs. The cabinets keep their port and cable position (connectID).
function nprjToProject(r) {
  var pj = newProject(); pj.name = r.project || 'VMP project'; pj.devices = []; pj.processors = []; pj.panels = []; pj.lct = []; pj.screens = [];
  var notes = [], pairs = [];
  r.controllers.forEach(function (c) {
    var key = hwModelKey(c.modelId), m = key ? PROC_MODELS[key] : null;
    if (!key) notes.push(c.name + ': model ' + c.modelId + ' isn’t in the catalogue (added as “Pick a model”)');
    var d = { id: uid(), model: key || 'custom', name: c.name || (m ? m.name : 'Processor'), procsChosen: true }, map = {};
    pj.devices.push(d);
    if (m && m.kind === 'chassis') {
      (c.outputCards.length ? c.outputCards : [{ id: 8, modelId: 0 }]).forEach(function (oc) {
        var t = Object.keys(OUTPUT_CARDS).filter(function (k) { return OUTPUT_CARDS[k].modelId === oc.modelId && m.cardTypes.indexOf(k) >= 0; })[0] || m.cardTypes[0];
        map[oc.id] = pj.processors.length; pj.processors.push({ ports: OUTPUT_CARDS[t].ports, type: t, dev: d.id });
      });
    } else {
      var n = m && m.kind === 'fixed' ? m.ports : MAX_CARD_PORTS;
      var ids = {}; c.screens.forEach(function (s) { s.cabinets.forEach(function (cb) { ids[cb.card] = 1; }); });
      var first = pj.processors.length; pj.processors.push({ ports: n, dev: d.id });
      Object.keys(ids).forEach(function (k) { map[k] = first; });
      map.any = first;
    }
    c.portBackup.forEach(function (q) {
      var ms = map[q.card] != null ? map[q.card] : map.any, bs = map[q.backupCard] != null ? map[q.backupCard] : map.any;
      if (ms != null && bs != null) pairs.push({ ms: ms, mp: q.port, bs: bs, bp: q.backupPort });
    });
    c.screens.forEach(function (s) {
      var lc = { id: uid(), name: s.name }; pj.lct.push(lc);
      var cabs = s.cabinets.filter(function (x) { return x.w > 0 && x.h > 0; });
      if (!cabs.length) return;
      var tally = {}; cabs.forEach(function (x) { var k = x.w + 'x' + x.h; tally[k] = (tally[k] || 0) + 1; });
      var best = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0].split('x').map(Number);
      var panel = pj.panels.filter(function (p) { return p.w === best[0] && p.h === best[1]; })[0];
      if (!panel) { panel = { id: uid(), name: 'Cabinet ' + best[0] + '×' + best[1], w: best[0], h: best[1] }; pj.panels.push(panel); }
      var x0 = Math.min.apply(null, cabs.map(function (x) { return x.x; })), y0 = Math.min.apply(null, cabs.map(function (x) { return x.y; }));
      var sec = { id: uid(), kind: 'complex', name: 'Section 1', screenId: lc.id, x: Math.max(0, x0), y: Math.max(0, y0), panelId: panel.id, holes: {}, manual: {}, override: {}, raw: {}, regions: [],
        wiring: { mode: 'manual', corner: 'TL', dir: 'V', pattern: 'serpentine', split: 'lines', max: 0, restart: 'continue', sender: map.any != null ? map.any : 0, port: 0 } };
      cabs.sort(function (a, b) { return a.card - b.card || a.port - b.port || a.connect - b.connect; }).forEach(function (x, i) {
        sec.regions.push({ dx: x.x - x0, dy: x.y - y0, w: x.w, h: x.h });
        var snd = map[x.card] != null ? map[x.card] : map.any;
        sec.manual[String(i)] = { sender: snd != null ? snd : 0, port: x.port, connect: x.connect };
      });
      if (cabs.some(function (x) { return x.angle; })) notes.push(s.name + ': rotated cabinets (rotation not kept)');
      pj.screens.push(sec);
    });
  });
  if (!pj.devices.length) throw new Error('no controllers in this project');
  if (!pj.panels.length) pj.panels.push({ id: uid(), name: 'Cabinet 176', w: 176, h: 176 });
  if (!pj.lct.length) pj.lct.push({ id: uid(), name: 'Screen 1' });
  pj.procsChosen = true;
  if (pairs.length) pj.backup = { mode: 'port', pairs: pairs, cards: [] };
  return { pj: ensureLct(pj), notes: notes, pairs: pairs.length };
}
function importNprj(file, asNew) {
  if (file.size > 45 * 1024 * 1024) return toast('That project is over 45 MB — too big to read here');
  toast('Reading ' + file.name + '…');
  return file.arrayBuffer().then(function (buf) { return DRV.post('lct', '/api/hw/nprj', { data: rcvB64(buf) }); }).then(function (r) {
    if (!r.ok) throw new Error(r.error || 'not readable');
    var x = nprjToProject(r), cabs = x.pj.screens.reduce(function (n, s) { return n + s.regions.length; }, 0);
    log('import_nprj', { file: file.name, vmp_project: r.project, controllers: r.controllers.length, screens: x.pj.lct.length, cabinets: cabs, pairs: x.pairs, notes: x.notes });
    importTake(x.pj, file.name, asNew, function () {
      renderAll();
      toast('Imported “' + (r.project || file.name) + '”' + (asNew && projShared() ? ' as project “' + P.name + '”' : '') + ': ' + r.controllers.length + ' processor(s), ' + x.pj.lct.length + ' screen(s), ' + cabs + ' cabinets' +
        (x.pairs ? ', ' + x.pairs + ' backup pairs' : '') + (x.notes.length ? ' — ' + x.notes[0] : '') + (asNew && projShared() ? '' : ' (Ctrl+Z goes back)'));
    });
  }).catch(function (e) { toast('Couldn’t import ' + file.name + ': ' + e.message); log('import_nprj', { file: file.name, error: e.message }); });
}
function bindInterchange() {   // Open file… = a new project named after the file; Import into this project… = into the open one
  $('fileOpen').onchange = function () { var f = this.files[0]; this.value = ''; if (f) openFile(f, true); };
  $('fileInto').onchange = function () { var f = this.files[0]; this.value = ''; if (f) openFile(f, false); };
}
