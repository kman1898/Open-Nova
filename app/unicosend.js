// Builds the layout for "Send to processor" on Unico-family processors (VX Pro …), which take the screen as a list of
// cabinets over REST instead of register writes (docs\UNICO_UI_TOUR.md §6.6, §7; tools\unicolink.py sends it).
// Every cabinet = {port, index, x, y, width, height}: port 0-based, index = its place in the port's cable chain (0-based,
// from the show file's connect order), x / y on the processor's canvas. The helper turns that into the device's
// POST screen/cabinets/topology (cabinetID = MAC low 3 bytes << 32 | slot << 24 | port << 16 | index).
// Optional port backup: [[masterPort, backupPort], …] (0-based), sent as custom pairs.
(function (root) {
  'use strict';

  // Unico-family models (modelId → name, output ports). Only the VX2000 Pro has been checked live (simulator).
  var MODELS = {
    25132: { name: 'VX2000 Pro', ports: 20, live: true },
    25131: { name: 'VX1000 Pro', ports: 10, live: false },
    25130: { name: 'VX600 Pro', ports: 6, live: false },
    25129: { name: 'VX400 Pro', ports: 4, live: false }
  };
  var LOAD_BASE = 655360;   // pixels per port at 100 % (8-bit); Unico rounds up; 10-bit halves it

  // opts: { senderPorts: n } flattens a multi-card show file (card d, port p → port d*n + p): for tests with H-series files.
  function buildLayout(model, opts) {
    opts = opts || {};
    var cabs = [];
    model.screens.forEach(function (s, si) {
      (s.cells || s.regions || []).forEach(function (c) { if (c.sender !== 255) cabs.push({ s: si, c: c }); });
    });
    if (!cabs.length) throw new Error('No cabinets to send');
    var senders = {};
    cabs.forEach(function (x) { senders[x.c.sender] = 1; });
    if (Object.keys(senders).length > 1 && !opts.senderPorts)
      throw new Error('The show file uses ' + Object.keys(senders).length + ' sending cards; a VX Pro has one output card');
    var byPort = {};
    cabs.forEach(function (x) {
      var p = opts.senderPorts ? x.c.sender * opts.senderPorts + x.c.port : x.c.port;
      (byPort[p] || (byPort[p] = [])).push(x.c);
    });
    var out = [], load = {};
    Object.keys(byPort).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
      var list = byPort[p].slice().sort(function (a, b) { return a.connect - b.connect; });
      load[p] = 0;
      list.forEach(function (c, i) {
        out.push({ port: p, index: i, x: c.x, y: c.y, width: c.width, height: c.height });
        load[p] += c.width * c.height;
      });
    });
    Object.keys(load).forEach(function (p) { load[p] = Math.ceil(load[p] * 100 / LOAD_BASE); });
    return { cabinets: out, ports: Object.keys(byPort).length, load: load };
  }

  // checks against a device's info (unicolink /api/unico/info): port count and canvas size
  function check(layout, info) {
    var problems = [], n = info.ports.length;
    layout.cabinets.forEach(function (c) { if (c.port >= n && problems.indexOf(c.port) < 0) problems.push(c.port); });
    var msgs = problems.map(function (p) { return 'Port ' + (p + 1) + ' does not exist (the processor has ' + n + ')'; });
    Object.keys(layout.load).forEach(function (p) { if (layout.load[p] > 100) msgs.push('Port ' + (+p + 1) + ' is at ' + layout.load[p] + ' % (8-bit)'); });
    return msgs;
  }

  // every used port backed up on the same-numbered port + offset (e.g. ports 1-10 → 11-20 on a VX2000 Pro)
  function portBackupPairs(layout, offset) {
    var used = {}; layout.cabinets.forEach(function (c) { used[c.port] = 1; });
    return Object.keys(used).map(Number).sort(function (a, b) { return a - b; }).map(function (p) { return [p, p + offset]; });
  }

  var api = { buildLayout: buildLayout, check: check, portBackupPairs: portBackupPairs, MODELS: MODELS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.UNICOSEND = api;
})(this);
