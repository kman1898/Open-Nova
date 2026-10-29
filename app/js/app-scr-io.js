// app-scr-io.js - NovaLCT .scr export / import: toScrModel, mergeSections, sectionToScr,
// exportScr, importScr, scrModelToProject (screen list -> project), and the download helper (also used by Save project).
// Depends on: scr.js (SCR), app-core (P, uid, key, fmt, toast, newProject, ensureLct,
// replaceProject, MAX_CARD_PORTS), app-geometry (allCells), app-capacity (problems, portUsage).
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ .scr export / import
function toScrModel() {
  var cellsBy = allCells();
  return {
    dvi: {
      portCols: 1, portRows: 1,
      // an imported file's stored size is kept unless the canvas was edited
      graphicsWidth: P.fileDvi && P.fileDvi.shownW === P.canvasW ? P.fileDvi.w : P.canvasW,
      graphicsHeight: P.fileDvi && P.fileDvi.shownH === P.canvasH ? P.fileDvi.h : P.canvasH
    },
    dviOffsetsHdr: P.dviOffsetsHdr,
    // One LCT screen per screen tab. A screen with one section exports that section as-is
    // (so imported files round-trip byte for byte); several sections are merged into one grid.
    screens: P.lct.map(function (lc) {
      var secs = P.screens.filter(function (s) { return s.screenId === lc.id; });
      if (!secs.length) return null;
      var lcName = bkExportName(lc);   // a backup copy keeps its source's name (app-backup.js)
      var name = /^Screen \d+$/.test(lcName || '') ? '' : (lcName || '').slice(0, 10);   // default names aren't written
      // (a Self draw section always goes through the merge: aligned panels become a Standard grid)
      return secs.length === 1 && !secs[0].drawn ? sectionToScr(secs[0], cellsBy[secs[0].id], name) : mergeSections(secs, cellsBy, name);
    }).filter(Boolean)
  };
}

// What NovaLCT will see for one LCT screen — the whole screen is either Standard (one grid,
// gaps as blanks) or Complex (cabinets placed freely) — decided exactly as toScrModel exports
// it. Returns null for a screen with no panels, else { kind, cols, rows, cabinets }.
function lctScreenType(lcId, cellsBy) {
  var secs = P.screens.filter(function (s) { return s.screenId === lcId; });
  if (!secs.length) return null;
  var m = secs.length === 1 && !secs[0].drawn ? sectionToScr(secs[0], cellsBy[secs[0].id], '') : mergeSections(secs, cellsBy, '');
  if (m.type === SCR.TYPE.Standard) return { kind: 'Standard', cols: m.cols, rows: m.rows, cabinets: m.cols * m.rows };
  return { kind: 'Complex', cabinets: m.regions.length };
}

// Several sections -> one LCT screen. Standard grid when every panel sits on one lattice
// (columns/rows from all panel edges; gaps become blank spacer cells, like LCT's own files);
// otherwise a Complex (freeform) screen. Ports that run through several sections are
// numbered in section order.
function mergeSections(secs, cellsBy, name) {
  var items = [];
  secs.forEach(function (s, si) {
    cellsBy[s.id].forEach(function (c) {
      if (c.hole) return;
      items.push({ si: si, x: c.x, y: c.y, w: c.w, h: c.h, sender: c.sender, port: c.port, connect: c.connect });
    });
  });
  var byPort = {};
  items.forEach(function (it) { if (it.sender != null) (byPort[it.sender + ':' + it.port] = byPort[it.sender + ':' + it.port] || []).push(it); });
  Object.keys(byPort).forEach(function (k) {
    byPort[k].sort(function (a, b) { return a.si - b.si || a.connect - b.connect; }).forEach(function (it, i) { it.connect = i; });
  });
  var adjust = Object.assign(SCR.defaultAdjust(), { name: name });
  var uniq = function (arr) { return arr.filter(function (v, i) { return arr.indexOf(v) === i; }).sort(function (a, b) { return a - b; }); };
  var xs = uniq([].concat.apply([], items.map(function (it) { return [it.x, it.x + it.w]; })));
  var ys = uniq([].concat.apply([], items.map(function (it) { return [it.y, it.y + it.h]; })));
  var grid = {}, lattice = items.length > 0;
  items.forEach(function (it) {
    var c0 = xs.indexOf(it.x), c1 = xs.indexOf(it.x + it.w), r0 = ys.indexOf(it.y), r1 = ys.indexOf(it.y + it.h);
    if (c1 - c0 !== 1 || r1 - r0 !== 1 || grid[c0 + ',' + r0]) lattice = false;
    else grid[c0 + ',' + r0] = it;
  });
  var wire = function (it) {
    var off = it.sender == null;
    return { sender: off ? SCR.EMPTY_SENDER : it.sender, port: off ? 1 : it.port, connect: off ? 1 : it.connect };
  };
  if (lattice) {
    var cells = [];
    for (var c = 0; c < xs.length - 1; c++) for (var r = 0; r < ys.length - 1; r++) {
      var it = grid[c + ',' + r], wd = it ? wire(it) : { sender: SCR.EMPTY_SENDER, port: 1, connect: 1 };
      cells.push({ col: c, row: r, sender: wd.sender, port: wd.port, connect: wd.connect, x: xs[c], y: ys[r],
        xInPort: c, yInPort: r, width: xs[c + 1] - xs[c], height: ys[r + 1] - ys[r], dvi: 1 });
    }
    return { type: SCR.TYPE.Standard, virtualMode: 0, x: xs[0], y: ys[0], cols: xs.length - 1, rows: ys.length - 1, adjust: adjust, cells: cells };
  }
  return {
    type: SCR.TYPE.Complex, virtualMode: 0, adjust: adjust,
    regions: items.map(function (it) {
      var wd = wire(it);
      return { sender: wd.sender, port: wd.port, connect: wd.connect, x: it.x, y: it.y, xInPort: 0, yInPort: 0, width: it.w, height: it.h };
    })
  };
}

// One section -> one LCT screen, exactly as it was imported/built.
function sectionToScr(s, cells, name) {
  var adjust = Object.assign(SCR.defaultAdjust(), s.adjust || {}, { name: name });
      if (s.kind === 'complex') {
        return {
          type: s.complexType || SCR.TYPE.Complex, virtualMode: s.virtualMode || 0, adjust: adjust,
          regions: cells.map(function (c) {
            var off = c.sender == null, raw = (s.raw && s.raw[c.k]) || {};
            return { sender: off ? SCR.EMPTY_SENDER : c.sender,
              port: off ? (raw.holePort != null ? raw.holePort : 1) : c.port,
              connect: off ? (raw.holeConnect != null ? raw.holeConnect : 1) : c.connect,
              x: c.x, y: c.y, xInPort: raw.xInPort || 0, yInPort: raw.yInPort || 0, width: c.w, height: c.h };
          })
        };
      }
      return {
        type: SCR.TYPE.Standard, virtualMode: s.virtualMode || 0, x: s.x, y: s.y, cols: s.cols, rows: s.rows,
        virtual: s.virtual, dviOffsets: s.dviOffsets, adjust: adjust,
        cells: cells.map(function (c) {
          var off = c.sender == null, raw = (s.raw && s.raw[c.k]) || {};
          return { col: c.c, row: c.r, sender: off ? SCR.EMPTY_SENDER : c.sender,
            port: off ? (raw.holePort != null ? raw.holePort : 1) : c.port,
            connect: off ? (raw.holeConnect != null ? raw.holeConnect : 1) : c.connect,
            x: c.x, y: c.y, xInPort: raw.xInPort != null ? raw.xInPort : c.c, yInPort: raw.yInPort != null ? raw.yInPort : c.r,
            width: c.w, height: c.h, dvi: raw.dvi != null ? raw.dvi : 1 };
        })
      };
}

function exportScr() {
  if (!P.screens.length) return toast('Add cabinets first');
  var cellsBy = allCells(), probs = problems(cellsBy, portUsage(cellsBy));
  if (probs.length && !confirm('Export anyway?\n\n' + probs.slice(0, 12).join('\n') + (probs.length > 12 ? '\n…' : ''))) return log('export_scr', { cancelled: true, problems: probs.slice(0, 20) });
  var model = toScrModel(), bytes = SCR.build(model);
  SCR.parse(bytes); // self-check
  log('export_scr', { file: (P.name || 'screen') + '.scr', bytes: bytes.length, problems: probs.slice(0, 20),
    screens: model.screens.map(function (s) { return { name: s.adjust && s.adjust.name, type: s.type === SCR.TYPE.Standard ? 'standard ' + s.cols + '×' + s.rows : 'complex ' + (s.regions || []).length, at: s.x != null ? s.x + ',' + s.y : '' }; }),
    graphics: model.dvi.graphicsWidth + '×' + model.dvi.graphicsHeight });
  download(new Blob([bytes], { type: 'application/octet-stream' }), (P.name || 'screen') + '.scr');
  toast('Exported ' + (P.name || 'screen') + '.scr (' + fmt(bytes.length) + ' bytes)');
}

function importScr(buf, fileName, asNew) {   // asNew: a new project in the list (importTake, app-interchange.js)
  var m;
  try { m = SCR.parse(buf); }
  catch (err) { log('import_scr_failed', { file: fileName, bytes: buf.byteLength, error: err.message }); throw err; }
  log('import_scr', { file: fileName, bytes: buf.byteLength, screens: m.screens.map(function (s) {
    return ['simple', 'standard', 'complex', 'irregular'][s.type] + (s.cols ? ' ' + s.cols + '×' + s.rows : s.regions ? ' ' + s.regions.length : '') + (s.adjust && s.adjust.name ? ' "' + s.adjust.name + '"' : '');
  }), graphics: m.dvi.graphicsWidth + '×' + m.dvi.graphicsHeight, warnings: m.warnings });
  var built = scrModelToProject(m, fileName.replace(/\.scr$/i, '')), proj = built.proj, skipped = built.skipped;
  importTake(ensureLct(proj), fileName, asNew, function () {
    toast('Imported ' + P.screens.length + ' screen(s)' + (skipped ? ', skipped ' + skipped + ' non-standard' : '') + (m.warnings.length ? ' — ' + m.warnings.join(', ') : '') + (asNew && projShared() ? ' as project “' + P.name + '”' : ''));
  });
}
// A screen list in the .scr model's shape (SCR.parse, or a processor's layout read back: app-readback.js) -> a new
// project: one LCT screen tab per screen, one section per screen, manual wiring as stored. Sections remember which
// screen of the list they came from (s.srcIndex) so a caller can regroup them. Returns { proj, skipped }.
function scrModelToProject(m, name) {
  var proj = newProject();
  proj.name = name;
  proj.panels = [];
  proj.lct = [];
  proj.dviOffsetsHdr = m.dviOffsetsHdr;
  function addLct(ms, i) {   // each screen in the file becomes one LCT screen tab
    var id = uid();
    proj.lct.push({ id: id, name: (ms.adjust && ms.adjust.name) || ('Screen ' + (i + 1)) });
    return id;
  }
  var maxPort = {}, bx = 0, by = 0, skipped = 0;
  function panelFor(w, h) {
    var pn = proj.panels.find(function (p) { return p.w === w && p.h === h; });
    if (!pn) { pn = { id: uid(), name: 'Cabinet ' + w + '×' + h, w: w, h: h }; proj.panels.push(pn); }
    return pn;
  }
  m.screens.forEach(function (ms, i) {
    if (ms.type === SCR.TYPE.Complex || ms.type === SCR.TYPE.CommonIrregular) {
      var live = ms.regions.filter(function (g) { return g.sender !== SCR.EMPTY_SENDER; });
      var ref = live.length ? live : ms.regions;
      var x0 = Math.min.apply(null, ref.map(function (g) { return g.x; }).concat([65535]));
      var y0 = Math.min.apply(null, ref.map(function (g) { return g.y; }).concat([65535]));
      if (!ms.regions.length) { x0 = 0; y0 = 0; }
      var tallyC = {};
      live.forEach(function (g) { var k = g.width + 'x' + g.height; tallyC[k] = (tallyC[k] || 0) + 1; });
      var bestC = (Object.keys(tallyC).sort(function (a, b) { return tallyC[b] - tallyC[a]; })[0] || '128x128').split('x').map(Number);
      var cs = {
        id: uid(), kind: 'complex', complexType: ms.type, name: 'Section 1', screenId: addLct(ms, i), x: x0, y: y0,
        panelId: panelFor(bestC[0], bestC[1]).id, holes: {}, manual: {}, override: {}, raw: {}, regions: [],
        wiring: { mode: 'manual', corner: 'TL', dir: 'V', pattern: 'serpentine', split: 'lines', max: 0, restart: 'continue', sender: 0, port: 0 },
        virtualMode: ms.virtualMode, adjust: ms.adjust
      };
      ms.regions.forEach(function (g, gi) {
        var k = String(gi);
        cs.regions.push({ dx: g.x - x0, dy: g.y - y0, w: g.width, h: g.height });
        var raw = {};
        if (g.xInPort) raw.xInPort = g.xInPort;
        if (g.yInPort) raw.yInPort = g.yInPort;
        if (g.sender === SCR.EMPTY_SENDER) {
          cs.holes[k] = true;
          if (g.port !== 1 || g.connect !== 1) { raw.holePort = g.port; raw.holeConnect = g.connect; }
        } else {
          cs.manual[k] = { sender: g.sender, port: g.port, connect: g.connect };
          maxPort[g.sender] = Math.max(maxPort[g.sender] || 0, g.port + 1);
          bx = Math.max(bx, g.x + g.width); by = Math.max(by, g.y + g.height);
        }
        if (Object.keys(raw).length) cs.raw[k] = raw;
      });
      if (!cs.adjust || !cs.adjust.name) cs.adjust = Object.assign({}, ms.adjust || {}, { name: '' });
      cs.srcIndex = i; proj.screens.push(cs);
      return;
    }
    if (ms.type !== SCR.TYPE.Standard) { skipped++; return; }
    var tally = {};
    ms.cells.forEach(function (c) { var k = c.width + 'x' + c.height; tally[k] = (tally[k] || 0) + (c.sender === 255 ? 1 : 100); });
    var best = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; })[0] || '128x128';
    var wh = best.split('x').map(Number);
    var panel = proj.panels.find(function (p) { return p.w === wh[0] && p.h === wh[1]; });
    if (!panel) { panel = { id: uid(), name: 'Cabinet ' + wh[0] + '×' + wh[1], w: wh[0], h: wh[1] }; proj.panels.push(panel); }
    var s = {
      id: uid(), name: 'Section 1', screenId: addLct(ms, i), x: ms.x, y: ms.y, cols: ms.cols, rows: ms.rows,
      panelId: panel.id, holes: {}, manual: {}, override: {},
      wiring: { mode: 'manual', corner: 'TL', dir: 'V', pattern: 'serpentine', split: 'lines', max: 0, restart: 'continue', sender: 0, port: 0 },
      virtualMode: ms.virtualMode, virtual: ms.virtual, dviOffsets: ms.dviOffsets, adjust: ms.adjust
    };
    s.raw = {};   // per-cell values NovaLCT stored that the editor doesn't model (kept for faithful re-export)
    ms.cells.forEach(function (c) {
      var k = key(c.col, c.row);
      if (c.x !== ms.x + c.col * panel.w || c.y !== ms.y + c.row * panel.h || c.width !== panel.w || c.height !== panel.h)
        s.override[k] = { dx: c.x - ms.x, dy: c.y - ms.y, w: c.width, h: c.height };
      var raw = {};
      if (c.dvi !== 1) raw.dvi = c.dvi;
      if (c.xInPort !== c.col) raw.xInPort = c.xInPort;
      if (c.yInPort !== c.row) raw.yInPort = c.yInPort;
      if (c.sender === SCR.EMPTY_SENDER && (c.port !== 1 || c.connect !== 1)) { raw.holePort = c.port; raw.holeConnect = c.connect; }
      if (Object.keys(raw).length) s.raw[k] = raw;
      if (c.sender === SCR.EMPTY_SENDER) { s.holes[k] = true; return; }
      s.manual[k] = { sender: c.sender, port: c.port, connect: c.connect };
      maxPort[c.sender] = Math.max(maxPort[c.sender] || 0, c.port + 1);
      bx = Math.max(bx, c.x + c.width); by = Math.max(by, c.y + c.height);
    });
    if (!s.adjust || !s.adjust.name) s.adjust = Object.assign({}, ms.adjust || {}, { name: '' });
    s.srcIndex = i; proj.screens.push(s);
  });
  var nS = Math.max.apply(null, [0].concat(Object.keys(maxPort).map(Number)));
  proj.processors = [];
  for (var si = 0; si <= nS; si++) proj.processors.push({ ports: Math.max(MAX_CARD_PORTS, maxPort[si] || 1) });
  proj.canvasW = m.dvi.graphicsWidth || bx || 3840;
  proj.canvasH = m.dvi.graphicsHeight || by || 2160;
  proj.fileDvi = { w: m.dvi.graphicsWidth, h: m.dvi.graphicsHeight, shownW: proj.canvasW, shownH: proj.canvasH };
  if (!proj.panels.length) proj.panels.push({ id: uid(), name: 'Cabinet 176', w: 176, h: 176 });
  return { proj: proj, skipped: skipped };
}

function download(blob, name) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
