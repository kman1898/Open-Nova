// app-autowire.js - Auto wiring: the cable path lines of a section (pathLines) and the port
// cutting (autoAssign: Organized = whole lines per port, Max capacity = one continuous
// serpentine), which also records problems in ui.autoErr.
// Depends on: app-core (ui, key, fmt), app-capacity (capacity, rectOf, rectUnion, rectArea,
// portCap, advancePort), app-geometry (cellGeom), app-processors (deviceOfCard, deviceLabel, procModel, procFamily,
// screenProcessorRule).
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// Cable path lines for auto wiring. Returns [[{c,r},...], ...]
function pathLines(s, restartEach) {
  var w = s.wiring, lines = [];
  var vertical = w.dir === 'V';
  var nLines = vertical ? s.cols : s.rows, len = vertical ? s.rows : s.cols;
  var fromRight = w.corner === 'TR' || w.corner === 'BR';
  var fromBottom = w.corner === 'BL' || w.corner === 'BR';
  for (var i = 0; i < nLines; i++) {
    var li = vertical ? (fromRight ? s.cols - 1 - i : i) : (fromBottom ? s.rows - 1 - i : i);
    var line = [];
    for (var j = 0; j < len; j++) {
      var jj = vertical ? (fromBottom ? s.rows - 1 - j : j) : (fromRight ? s.cols - 1 - j : j);
      line.push(vertical ? { c: li, r: jj } : { c: jj, r: li });
    }
    lines.push(line);
  }
  return lines;
}

// Compute auto-wired assignment: map key -> {sender,port,connect}.
// Problems found while cutting ports go to ui.autoErr[screen id].
//   Organized ('lines'): whole rows/columns per port while the port rectangle fits;
//                        the serpentine restarts on the starting side in every port.
//   Max capacity ('fill'): one continuous serpentine, cut when the growing rectangle no longer fits.
function autoAssign(s) {
  var w = s.wiring, maxN = w.max > 0 ? w.max : Infinity, errs = [];
  var geom = {}; cellGeom(s).forEach(function (g) { geom[g.k] = g; });
  var lines = pathLines(s);
  var live = function (pt) { return !s.holes[key(pt.c, pt.r)]; };
  var boxOf = function (pt) { return rectOf(geom[key(pt.c, pt.r)]); };
  var boxOfAll = function (pts) { return pts.reduce(function (r, p) { return rectUnion(r, boxOf(p)); }, null); };
  var fits = function (r) { return rectArea(r) <= portCap(r); };
  var serp = w.pattern === 'serpentine';
  var orient = function (line, parity) { return serp && parity % 2 === 1 ? line.slice().reverse() : line; };
  var dirWord = w.dir === 'V' ? 'Column' : 'Row';
  var groups = [];   // each group = ordered list of pts for one port

  if (capacity() === 0) errs.push('frame rate above 120 Hz is not supported');

  if (w.split === 'lines') {
    var cur = [], curRect = null, curLines = 0;
    var flush = function () { if (cur.length) groups.push(cur); cur = []; curRect = null; curLines = 0; };
    lines.forEach(function (line, li) {
      var livePts = line.filter(live);
      if (!livePts.length) return;
      var lineRect = boxOfAll(livePts);
      if (!fits(lineRect)) {
        errs.push(dirWord + ' ' + (li + 1) + ' alone is over port capacity (' + fmt(rectArea(lineRect)) + ' > ' + fmt(portCap(lineRect)) + ' px)');
        flush(); groups.push(orient(line, 0).filter(live)); return;
      }
      if (livePts.length > maxN) errs.push(dirWord + ' ' + (li + 1) + ' has ' + livePts.length + ' cabinets, more than the ' + maxN + ' per port limit');
      var next = rectUnion(curRect, lineRect);
      if (cur.length && (!fits(next) || cur.length + livePts.length > maxN)) { flush(); next = lineRect; }
      orient(line, curLines).filter(live).forEach(function (p) { cur.push(p); });
      curRect = next; curLines++;
    });
    flush();
  } else {
    var order = [];
    lines.forEach(function (line, li) { orient(line, li).forEach(function (p) { if (live(p)) order.push(p); }); });
    var port = [], rect = null;
    order.forEach(function (p) {
      var b = boxOf(p);
      if (!fits(b) && errs.indexOf('a cabinet is bigger than a port (' + fmt(rectArea(b)) + ' px)') < 0) errs.push('a cabinet is bigger than a port (' + fmt(rectArea(b)) + ' px)');
      var next = rectUnion(rect, b);
      if (port.length && (!fits(next) || port.length + 1 > maxN)) { groups.push(port); port = [p]; rect = b; }
      else { port.push(p); rect = next; }
    });
    if (port.length) groups.push(port);
  }
  ui.autoErr[s.id] = errs;

  // the ports run on from card to card, but not onto another processor's card (a screen belongs to one processor,
  // app-processors.js screenProcessorRule): what doesn't fit stays unwired, with a problem
  var map = {}, sp = { sender: w.sender, port: w.port }, home = deviceOfCard(w.sender), stop = false;
  groups.forEach(function (grp, gi) {
    if (gi) sp = advancePort(sp);
    var dv = deviceOfCard(sp.sender);
    if (!stop && home && dv && dv.id !== home.id && screenProcessorRule(procFamily(procModel(home.model))) === 'one') {
      stop = true; errs.push(deviceLabel(home) + ' has no free port left for the rest of these cabinets (they stay on its own ports)');
    }
    if (stop) return;
    grp.forEach(function (p, ci) { map[key(p.c, p.r)] = { sender: sp.sender, port: sp.port, connect: ci }; });
  });
  return map;
}
