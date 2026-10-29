// app-manual-wiring.js - Manual wiring edits: ensureManual, renumber, curPort, portKeys,
// unwire, addToCurrentPort, arrowStep, pattern fill of a selection (patternFill,
// applyPattern), reversePort, toggleHole and pruneScreen.
// Depends on: app-core (P, ui, fmt, toast, commit), app-capacity (rectOf, rectUnion, rectArea,
// portCap, portLabel, cardProblem, advancePort, screenById), app-geometry (cellGeom),
// app-autowire (autoAssign), app-render (renderAll).
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ manual wiring ops
function ensureManual(s) {
  if (s.wiring.mode === 'manual') return;
  s.manual = autoAssign(s); s.wiring.mode = 'manual';
}
function renumber(s, sender, port) {
  var list = Object.keys(s.manual).filter(function (k) { var a = s.manual[k]; return a.sender === sender && a.port === port; })
    .sort(function (a, b) { return s.manual[a].connect - s.manual[b].connect; });
  list.forEach(function (k, i) { s.manual[k].connect = i; });
}
function curPort() { return { sender: ui.mSender || 0, port: ui.mPort || 0 }; }

function portKeys(s, sender, port) {
  return Object.keys(s.manual).filter(function (k) { var a = s.manual[k]; return a.sender === sender && a.port === port; })
    .sort(function (a, b) { return s.manual[a].connect - s.manual[b].connect; });
}
function unwire(s, k) {
  var prev = s.manual[k];
  if (!prev) return false;
  delete s.manual[k]; renumber(s, prev.sender, prev.port);
  return true;
}
// Put panel k at the end of the current port (click / arrow keys).
// Ignored if it's already on the current port. Never overwrites: a panel on another port is
// refused (only serpentine patterns overwrite). Refused too if the port is full.
function addToCurrentPort(s, k) {
  ensureManual(s);
  if (s.holes[k]) return 'that position is a blank';
  var cp = curPort(), prev = s.manual[k];
  if (prev && prev.sender === cp.sender && prev.port === cp.port) return null;
  if (prev) return 'That cabinet is already on ' + portLabel(prev.sender, prev.port) + ' — select it and press Delete, or use a pattern to overwrite';
  var bad = cardProblem(cp);
  if (bad) return bad;
  var geom = {}; cellGeom(s).forEach(function (g) { geom[g.k] = g; });
  var rect = portKeys(s, cp.sender, cp.port).reduce(function (r, kk) { return rectUnion(r, rectOf(geom[kk])); }, null);
  rect = rectUnion(rect, rectOf(geom[k]));
  if (rectArea(rect) > portCap(rect)) return portLabel(cp.sender, cp.port) + ' is full (' + fmt(rectArea(rect)) + ' > ' + fmt(portCap(rect)) + ' px) — Tab to the next port';
  s.manual[k] = { sender: cp.sender, port: cp.port, connect: portKeys(s, cp.sender, cp.port).length };
  return null;
}
// Arrow keys: step from the current port's last panel to its neighbour and add it.
// A blank in the way or the screen edge swallows the key.
function arrowStep(s, key) {
  var d = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[key];
  var cp = curPort(), run = portKeys(s, cp.sender, cp.port);
  if (!run.length) return 'Click a cabinet first, then use the arrow keys';
  var geom = cellGeom(s), last = geom.find(function (g) { return g.k === run[run.length - 1]; }), next = null;
  if (s.kind === 'complex') {        // freeform: whichever cabinet sits just past that edge
    var px = last.x + (d[0] > 0 ? last.w + 1 : d[0] < 0 ? -1 : last.w / 2);
    var py = last.y + (d[1] > 0 ? last.h + 1 : d[1] < 0 ? -1 : last.h / 2);
    next = geom.find(function (g) { return px >= g.x && px < g.x + g.w && py >= g.y && py < g.y + g.h; }) || null;
  } else {
    var c = last.c + d[0], r = last.r + d[1];
    if (c >= 0 && r >= 0 && c < s.cols && r < s.rows) next = geom.find(function (g) { return g.c === c && g.r === r; });
  }
  if (!next || next.hole) return null;
  return addToCurrentPort(s, next.k);
}
// ---- Pattern fill of a selection (same rules as LED Raster Designer's custom runs)
// corner: TL/TR/BL/BR, dir: 'H' rows or 'V' columns. Always serpentine.
// Organized: whole lines per port, each new port restarts on the start side; a line longer
//   than a port is cut from its start and the remainder carries on to the next port.
// Max capacity: one continuous snake cut where the capacity falls, mid-line included.
// Capacity is the rectangle rule (portCap vs the port's bounding-box area).
// Returns {error} or {chunks:[{sender,port,keys}]}; writes nothing on error.
// The panels (cell geometries) grouped into the pattern's lines, first line first, each line in
// its start-side-first order (the serpentine flips every other line when it is walked).
// Lattice: grid screens use their own column/row; freeform screens bucket by position.
function patternLines(s, picks, corner, dir) {
  var colOf, rowOf;
  if (s.kind === 'complex') {
    var xs = [], ys = [];
    picks.forEach(function (g) { if (xs.indexOf(g.x) < 0) xs.push(g.x); if (ys.indexOf(g.y) < 0) ys.push(g.y); });
    xs.sort(function (a, b) { return a - b; }); ys.sort(function (a, b) { return a - b; });
    colOf = function (g) { return xs.indexOf(g.x); }; rowOf = function (g) { return ys.indexOf(g.y); };
  } else { colOf = function (g) { return g.c; }; rowOf = function (g) { return g.r; }; }
  var vertical = dir === 'V';
  var fromRight = corner === 'TR' || corner === 'BR', fromBottom = corner === 'BL' || corner === 'BR';
  var lineOf = vertical ? colOf : rowOf, posOf = vertical ? rowOf : colOf;
  var lineRev = vertical ? fromRight : fromBottom, posRev = vertical ? fromBottom : fromRight;
  var byLine = {};
  picks.forEach(function (g) { (byLine[lineOf(g)] = byLine[lineOf(g)] || []).push(g); });
  return Object.keys(byLine).map(Number).sort(function (a, b) { return lineRev ? b - a : a - b; }).map(function (li) {
    return byLine[li].sort(function (a, b) { return posRev ? posOf(b) - posOf(a) : posOf(a) - posOf(b); });
  });
}

// Pattern pad with nothing selected: re-order the ACTIVE port's panels in that pattern (same
// port, same panels — just the cable order). Uses the selected section if the port is on it,
// otherwise the first section on this screen that has it.
function repatternActivePort(corner, dir, raster) {
  var cp = curPort(), label = portLabel(cp.sender, cp.port);
  var has = function (sc) { return cellsOf(sc).some(function (c) { return c.sender === cp.sender && c.port === cp.port; }); };
  var vis = visibleScreens(), s = screenById(ui.sel);
  if (!s || vis.indexOf(s) < 0 || !has(s)) s = vis.filter(has)[0];
  if (!s) return toast('Select cabinets to fill, or pick a port that has cabinets (' + label + ' has none on this screen)');
  ensureManual(s);
  var geom = {}; cellGeom(s).forEach(function (g) { geom[g.k] = g; });
  var keys = portKeys(s, cp.sender, cp.port);
  var order = [];
  patternLines(s, keys.map(function (k) { return geom[k]; }), corner, dir)
    .forEach(function (line, li) { (li % 2 && !raster ? line.slice().reverse() : line).forEach(function (g) { order.push(g.k); }); });
  order.forEach(function (k, i) { s.manual[k].connect = i; });
  var elsewhere = vis.filter(function (o) { return o !== s && has(o); }).length;
  log('repattern_port', { port: label, section: s.name, corner: corner, dir: dir, raster: !!raster, panels: order.length, other_sections_with_port: elsewhere });
  commit(); renderAll();
  toast(label + ' redrawn: ' + patternTitle(corner, dir, raster).toLowerCase() + (elsewhere ? ' (only in ' + secLabel(s) + ')' : ''));
}

function patternFill(s, keys, corner, dir, raster) {
  var geom = {}; cellGeom(s).forEach(function (g) { geom[g.k] = g; });
  var picks = keys.filter(function (k) { return geom[k] && !s.holes[k]; }).map(function (k) { return geom[k]; });
  if (!picks.length) return { error: 'no cabinets selected' };
  var lines = patternLines(s, picks, corner, dir);
  var orient = function (line, parity) { return parity % 2 && !raster ? line.slice().reverse() : line; };
  var fits = function (r) { return rectArea(r) <= portCap(r); };
  for (var i = 0; i < picks.length; i++) {
    var b0 = rectOf(picks[i]);
    if (!fits(b0)) return { error: 'one cabinet (' + picks[i].w + '×' + picks[i].h + ') is bigger than a port' };
  }

  var runs = [], cur = [], rect = null, lineInRun = 0;
  var close = function () { if (cur.length) runs.push(cur); cur = []; rect = null; lineInRun = 0; };
  var addOne = function (g) {         // cabinet by cabinet, cutting where the cap falls
    var next = rectUnion(rect, rectOf(g));
    if (cur.length && !fits(next)) { runs.push(cur); cur = [g]; rect = rectOf(g); lineInRun = 0; }
    else { cur.push(g); rect = next; }
  };
  if (s.wiring.split === 'fill') {
    lines.forEach(function (line, li) { orient(line, li).forEach(addOne); });
    close();
  } else {
    lines.forEach(function (line) {
      var lr = line.reduce(function (r, g) { return rectUnion(r, rectOf(g)); }, null);
      if (!fits(lr)) {                  // line longer than a port: cut it from its start
        close();
        orient(line, 0).forEach(addOne);
        close();
        return;
      }
      var next = rectUnion(rect, lr);
      if (cur.length && !fits(next)) close();
      orient(line, lineInRun).forEach(function (g) { cur.push(g); });
      rect = rectUnion(rect, lr); lineInRun++;
    });
    close();
  }

  // Ports from the current one onward, within the processors that exist.
  var sp = { sender: ui.mSender || 0, port: ui.mPort || 0 }, chunks = [];
  var bad = cardProblem(sp);
  if (bad) return { error: bad };
  for (var r = 0; r < runs.length; r++) {
    if (r) sp = advancePort(sp);
    if (sp.sender >= P.processors.length) return { error: 'selection needs ' + runs.length + ' ports but the processors run out at ' + portLabel(chunks[chunks.length - 1].sender, chunks[chunks.length - 1].port) };
    chunks.push({ sender: sp.sender, port: sp.port, keys: runs[r].map(function (g) { return g.k; }) });
  }
  return { chunks: chunks };   // selected panels on other ports are overwritten by applyPattern
}

function applyPattern(corner, dir, raster) {
  var s = screenById(ui.selScreen);
  if (!s || !ui.selKeys || !ui.selKeys.size) return repatternActivePort(corner, dir, raster);
  ensureManual(s);
  var res = patternFill(s, Array.from(ui.selKeys), corner, dir, raster);
  log('pattern_fill', { section: s.name, corner: corner, dir: dir, raster: !!raster, split: s.wiring.split, panels: ui.selKeys.size,
    from_port: portLabel(ui.mSender || 0, ui.mPort || 0), error: res.error,
    ports: res.chunks && res.chunks.map(function (c) { return portLabel(c.sender, c.port) + ' ×' + c.keys.length; }) });
  if (res.error) return toast('Cannot apply: ' + res.error);
  // Overwrite: the filled ports are replaced outright, and selected panels leave whatever port
  // they were on (those ports close up their numbering).
  var filled = {}; res.chunks.forEach(function (c) { filled[c.sender + ':' + c.port] = 1; });
  var touched = {};
  Object.keys(s.manual).forEach(function (k) {
    var a = s.manual[k], pk = a.sender + ':' + a.port;
    if (filled[pk]) delete s.manual[k];
    else if (ui.selKeys.has(k)) { touched[pk] = a; delete s.manual[k]; }
  });
  Object.keys(touched).forEach(function (pk) { renumber(s, touched[pk].sender, touched[pk].port); });
  res.chunks.forEach(function (c) { c.keys.forEach(function (k, i) { s.manual[k] = { sender: c.sender, port: c.port, connect: i }; }); });
  var first = res.chunks[0], last = res.chunks[res.chunks.length - 1];
  ui.mSender = last.sender; ui.mPort = last.port;
  ui.selKeys = new Set();
  commit(); renderAll();
  toast(res.chunks.length === 1 ? 'Wired ' + first.keys.length + ' cabinets to ' + portLabel(first.sender, first.port)
    : 'Filled ' + portLabel(first.sender, first.port) + ' to ' + portLabel(last.sender, last.port) + ' (' + (s.wiring.split === 'fill' ? 'packed full' : 'whole ' + (dir === 'V' ? 'columns' : 'rows')) + ')');
}

function reversePort(s, sender, port) {
  ensureManual(s);
  var ks = Object.keys(s.manual).filter(function (k) { var a = s.manual[k]; return a.sender === sender && a.port === port; });
  ks.forEach(function (k) { s.manual[k].connect = ks.length - 1 - s.manual[k].connect; });
}
function toggleHole(s, k) {
  if (s.holes[k]) delete s.holes[k];
  else {
    s.holes[k] = true;
    var prev = s.manual[k];
    if (prev) { delete s.manual[k]; renumber(s, prev.sender, prev.port); }
  }
}

function pruneScreen(s) {
  function inside(k) { var p = k.split(',').map(Number); return p[0] < s.cols && p[1] < s.rows; }
  ['holes', 'manual', 'override', 'raw'].forEach(function (f) { Object.keys(s[f] || {}).forEach(function (k) { if (!inside(k)) delete s[f][k]; }); });
  if (s.wiring.mode === 'manual') {
    var seen = {};
    Object.keys(s.manual).forEach(function (k) { var a = s.manual[k]; seen[a.sender + ':' + a.port] = a; });
    Object.keys(seen).forEach(function (k) { renumber(s, seen[k].sender, seen[k].port); });
  }
}
