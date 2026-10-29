// app-scfg.js - NovaLCT .scfg ("System configuration file") export / import: buildScfg,
// exportScfg (the Export .scfg dialog), importScfg (Open… a .scfg: its screens come in like a
// .scr), and scfgSrc, the receiving-card parameters (+ sending-card settings) to put in the file.
// A .scfg = our .scr (exactly what Export .scr writes) + receiving-card parameters + redundancy
// pairs. NovaLCT's Load Configuration File sends the receiving-card parameters to EVERY receiving
// card, then the screens, then saves — so they are only ever copied from a real file the user
// picks (the show's .rcfgx, or an LCT .scfg), never made up. The file has no processor model: LCT
// sends to whatever is connected on the COM port chosen there.
// Owns: SCFG_RX_KEY, scfgSrc, scfgLoadRx, scfgSetRx, buildScfg, importScfg, scfgRedundancy,
// scfgPairText, scfgRxText, scfgDialog, scfgRender, exportScfg, scfgDoExport; the #scfgDlg dialog
// (built on first use, reusing the Logs window's .logdlg / .logbox styles).
// Depends on: scfg.js (SCFG), scr.js (SCR), app-core (P, $, esc, fmt, toast), app-log (log),
// app-scr-io (toScrModel, importScr, download), app-geometry (allCells), app-capacity (problems,
// portUsage), app-processors (procModel, deviceLabel, cardsOfDevice), P.backup (app-backup.js:
// port-backup pairs become the .scfg's redundancy list), all at run time.
// exportScfg is bound in app-forms.js (header button), importScfg from its Open… handler.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// Where the non-layout parts of the next .scfg come from. rx = receiving-card parameters
// ({ attrs, inner } from SCFG); rxFrom = its file name; keep = sending-card settings of an opened
// .scfg ({ from, redundancy, captureFrame, syncVideo }) or null. rx is remembered in this browser
// (it is too big for the project, which is synced and kept 80 times for undo).
var SCFG_RX_KEY = 'opennova.scfg.rx';
var scfgSrc = { rx: null, rxFrom: '', keep: null, useKeep: true, loaded: false };

function scfgLoadRx() {
  if (scfgSrc.loaded) return;
  scfgSrc.loaded = true;
  try {
    var o = JSON.parse(localStorage.getItem(SCFG_RX_KEY) || 'null');
    if (o && typeof o.inner === 'string') { scfgSrc.rx = { attrs: o.attrs || '', inner: o.inner }; scfgSrc.rxFrom = o.from || ''; }
  } catch (e) { /* storage unavailable */ }
}
function scfgSetRx(rx, from) {
  scfgSrc.rx = rx; scfgSrc.rxFrom = from; scfgSrc.loaded = true;
  try { localStorage.setItem(SCFG_RX_KEY, JSON.stringify({ attrs: rx.attrs, inner: rx.inner, from: from })); } catch (e) { /* too big / unavailable: this session only */ }
}

// The current project as .scfg text. opts: { rx (default: scfgSrc.rx), redundancy ([] = none),
// captureFrame, syncVideo }. ScreenCfgInfo is the same .scr that Export .scr writes.
function buildScfg(opts) {
  opts = opts || {};
  scfgLoadRx();
  var model = toScrModel(), scr = SCR.build(model);
  var text = SCFG.build({ scr: scr, rx: opts.rx || scfgSrc.rx, redundancy: opts.redundancy || [],
    captureFrame: opts.captureFrame, syncVideo: opts.syncVideo });
  return { text: text, bytes: SCFG.toBytes(text), scr: scr, model: model };
}

// Open… of a .scfg: its screens replace the project (as a .scr would); its receiving-card
// parameters and sending-card settings are kept for the next Export .scfg.
function importScfg(buf, fileName, asNew) {
  var s;
  try { s = SCFG.parse(buf); if (!s.scr) throw new Error('no screen configuration inside'); }
  catch (err) { log('import_scfg_failed', { file: fileName, bytes: buf.byteLength, error: err.message }); throw err; }
  var sum = s.rx ? SCFG.rxSummary(s.rx) : null;
  log('import_scfg', { file: fileName, bytes: buf.byteLength, scrBytes: s.scr.length, redundancy: s.redundancy, captureFrame: s.captureFrame,
    syncVideo: s.syncVideo ? s.syncVideo.length : 0, rx: sum, warnings: s.warnings });
  importScr(s.scr, fileName.replace(/\.scfg$/i, '') + '.scr', asNew);
  if (s.rx && s.rx.inner.indexOf('<StandardLedModuleProp') >= 0) scfgSetRx(s.rx, fileName);
  scfgSrc.keep = { from: fileName, redundancy: s.redundancy || [], captureFrame: s.captureFrame, syncVideo: s.syncVideo };
  scfgSrc.useKeep = true;
}

// The redundancy pairs to write: this project's port backup (P.backup, app-backup.js) when it is
// on, else the pairs of an opened .scfg (when "keep" is ticked), else none. Returns { pairs, from }.
// (Sending-card backup is not written: how LCT lists it in ReduInfoList isn't confirmed.)
function scfgRedundancy() {
  var b = P.backup;
  if (b && b.mode === 'port') return { from: 'project', pairs: (b.pairs || []).map(function (q) { return { masterSender: q.ms, masterPort: q.mp, slaveSender: q.bs, slavePort: q.bp }; }) };
  var k = scfgSrc.useKeep ? scfgSrc.keep : null;
  return k ? { from: k.from, pairs: k.redundancy } : { from: null, pairs: [] };
}
// "SC1 P1 → SC3 P1" for zero-based redundancy pairs.
function scfgPairText(r) { return 'SC' + (r.masterSender + 1) + ' P' + (r.masterPort + 1) + ' → SC' + (r.slaveSender + 1) + ' P' + (r.slavePort + 1); }
function scfgRxText(rx) {
  var s = SCFG.rxSummary(rx), bits = [];
  if (s.card) bits.push(s.card + (s.firmware ? ' ' + s.firmware : ''));
  if (s.width && s.height) bits.push('cabinet ' + s.width + '×' + s.height);
  if (s.moduleW && s.moduleH) bits.push('module ' + s.moduleW + '×' + s.moduleH + (s.scan ? ' ' + s.scan.replace('Scan_', '1/') + ' scan' : ''));
  if (s.chip) bits.push(s.chip);
  if (s.brightness != null) bits.push('brightness ' + s.brightness);
  if (s.savedBy) bits.push('saved by ' + s.savedBy);
  return bits.join(' · ');
}

// ------------------------------------------------------------------ Export .scfg dialog
function scfgDialog() {
  var d = $('scfgDlg');
  if (d) return d;
  d = document.createElement('div');
  d.id = 'scfgDlg'; d.className = 'logdlg'; d.hidden = true;
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Export .scfg');
  d.innerHTML =
    '<div class="logbox" style="height:auto;width:min(620px,100%);gap:8px">' +
      '<div class="loghead"><b>Export .scfg — NovaLCT system configuration</b><span class="grow"></span><button id="scfgClose" title="Close">×</button></div>' +
      '<div class="hint" style="margin:0">In NovaLCT: Screen Configuration → Load Configuration File → Send. LCT then sends, in this order: the ' +
        'receiving-card parameters below to <b>every</b> receiving card, this project\'s screens, the redundancy pairs — and saves. ' +
        'Use Export .scr to change only the layout.</div>' +
      '<div><b>Screens</b> <span id="scfgScr" class="hint"></span></div>' +
      '<div><b>Receiving-card parameters</b> <span class="hint">(required)</span><div id="scfgRx" class="hint" style="margin:2px 0 4px"></div>' +
        '<label class="btn" title="The show\'s receiving-card file: an .rcfgx, or an LCT .scfg (its receiving-card part is used)">Choose .rcfgx / .scfg…' +
        '<input type="file" id="scfgRxFile" accept=".rcfgx,.scfg,.xml" hidden></label></div>' +
      '<div><b>Redundancy</b><div id="scfgRedu" class="hint" style="margin:2px 0 0"></div></div>' +
      '<div id="scfgWarn" class="hint" style="color:var(--warn);margin:0"></div>' +
      '<div class="loghead"><span class="grow"></span><button id="scfgCancel">Cancel</button><button id="scfgGo" class="primary">Export .scfg</button></div>' +
    '</div>';
  document.body.appendChild(d);
  function close() { d.hidden = true; }
  $('scfgClose').onclick = close;
  $('scfgCancel').onclick = function () { log('export_scfg', { cancelled: true }); close(); };
  d.addEventListener('mousedown', function (e) { if (e.target === d) close(); });
  // While open, keys belong to the dialog (not the canvas shortcuts behind it).
  document.addEventListener('keydown', function (e) {
    if (d.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    e.stopPropagation();
  }, true);
  $('scfgRxFile').onchange = function () {
    var f = this.files[0]; this.value = '';
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var buf = rd.result, job;
      if (/\.scfg$/i.test(f.name)) job = Promise.resolve().then(function () {
        var s = SCFG.parse(buf);
        if (!s.rx || s.rx.inner.indexOf('<StandardLedModuleProp') < 0) throw new Error('it has no receiving-card parameters');
        return s.rx;
      });
      else if (/\.xml$/i.test(f.name)) job = Promise.resolve().then(function () { return SCFG.rxFromXml(buf); });
      else job = SCFG.rxFromRcfgx(buf);
      job.then(function (rx) {
        scfgSetRx(rx, f.name);
        log('scfg_rx_chosen', { file: f.name, bytes: f.size, rx: SCFG.rxSummary(rx) });
        scfgRender();
      }).catch(function (err) {
        log('scfg_rx_failed', { file: f.name, error: err.message });
        toast('Could not use ' + f.name + ': ' + err.message);
      });
    };
    rd.readAsArrayBuffer(f);
  };
  $('scfgGo').onclick = scfgDoExport;
  return d;
}

function scfgRender() {
  var cellsBy = allCells(), used = {}, maxCard = -1;
  P.screens.forEach(function (s) { cellsBy[s.id].forEach(function (c) { if (c.sender != null) { used[c.sender] = 1; maxCard = Math.max(maxCard, c.sender); } }); });
  var procs = P.devices.map(function (dv) {
    var m = procModel(dv.model), idx = cardsOfDevice(dv);
    return deviceLabel(dv) + (m.modelId != null ? ' (ModelID 0x' + m.modelId.toString(16).toUpperCase() + ')' : '') + ' = card' + (idx.length > 1 ? 's ' + (idx[0] + 1) + '–' + (idx[idx.length - 1] + 1) : ' ' + (idx[0] + 1));
  });
  $('scfgScr').innerHTML = esc(P.lct.filter(function (lc) { return P.screens.some(function (s) { return s.screenId === lc.id; }); }).length + ' screen(s), from this project (the same .scr as Export .scr)') +
    '<br>' + esc('Wired to ' + Object.keys(used).map(function (k) { return cardName(+k, true); }).join(', ') +
    '. ' + procs.join('; ') + '. The processor model is not stored in a .scfg — LCT sends to what is connected.');
  var warn = [];
  if (scfgSrc.rx) $('scfgRx').textContent = scfgRxText(scfgSrc.rx) + ' — from ' + (scfgSrc.rxFrom || 'an earlier file');
  else { $('scfgRx').textContent = 'None chosen yet. Pick the show\'s .rcfgx (or an LCT .scfg made for these cabinets).'; }
  var k = scfgSrc.keep, redu = $('scfgRedu'), rd = scfgRedundancy(), html = '';
  if (rd.from === 'project') html = esc('From this project\'s port backup: ' + (rd.pairs.length ? rd.pairs.map(scfgPairText).join(', ') : 'no pairs yet')) + '<br>';
  else if (P.backup && P.backup.mode === 'card') html = esc('This project uses ' + bkCardWord().toLowerCase() + ' backup, which is not written to a .scfg (how LCT lists it isn\'t confirmed).') + '<br>';
  if (k) {
    html += '<label class="chk"><input type="checkbox" id="scfgKeep"' + (scfgSrc.useKeep ? ' checked' : '') + '> ' +
      esc('Keep the settings of ' + k.from + ': ' + (rd.from === 'project' ? '' : (k.redundancy.length ? k.redundancy.map(scfgPairText).join(', ') : 'no redundancy pairs') + ', ') +
      (k.syncVideo ? 'video-sync data, ' : '') + 'capture frame ' + (k.captureFrame != null ? k.captureFrame : SCFG.DEFAULT_CAPTURE_FRAME)) + '</label>';
  } else if (rd.from !== 'project') html += esc('None. LCT sends an empty redundancy list with the screens (expected to leave no port pairs set).');
  redu.innerHTML = html;
  if (k) $('scfgKeep').onchange = function () { scfgSrc.useKeep = this.checked; scfgRender(); };
  rd.pairs.forEach(function (r) {
    [[r.masterSender, r.masterPort], [r.slaveSender, r.slavePort]].forEach(function (sp) {
      var card = P.processors[sp[0]];
      if (!card) warn.push('Redundancy ' + scfgPairText(r) + ': ' + cardName(sp[0], true) + ' is not in this project');
      else if (sp[1] >= card.ports) warn.push('Redundancy ' + scfgPairText(r) + ': ' + cardName(sp[0], true) + ' has ' + card.ports + ' ports');
    });
  });
  $('scfgWarn').textContent = warn.join(' · ');
  $('scfgGo').disabled = !scfgSrc.rx;
}

function exportScfg() {
  if (!P.screens.length) return toast('Add cabinets first');
  scfgLoadRx();
  var d = scfgDialog();
  scfgRender();
  d.hidden = false;
  log('export_scfg_open', { rx: scfgSrc.rx ? scfgSrc.rxFrom : null, keep: scfgSrc.keep ? scfgSrc.keep.from : null });
}

function scfgDoExport() {
  if (!scfgSrc.rx) return toast('Choose the receiving-card file first');
  var cellsBy = allCells(), probs = problems(cellsBy, portUsage(cellsBy));
  if (probs.length && !confirm('Export anyway?\n\n' + probs.slice(0, 12).join('\n') + (probs.length > 12 ? '\n…' : ''))) return log('export_scfg', { cancelled: true, problems: probs.slice(0, 20) });
  var k = scfgSrc.useKeep ? scfgSrc.keep : null, rd = scfgRedundancy(), out;
  try {
    out = buildScfg({ redundancy: rd.pairs, captureFrame: k && k.captureFrame != null ? k.captureFrame : undefined, syncVideo: k ? k.syncVideo : null });
    // self-check: read it back; the screens must be the .scr byte for byte
    var back = SCFG.parse(out.text), same = back.scr && back.scr.length === out.scr.length && back.scr.every(function (b, i) { return b === out.scr[i]; });
    if (!same || !back.rx || back.redundancy == null) throw new Error('self-check failed');
    SCR.parse(back.scr);
  } catch (err) {
    log('export_scfg_failed', { error: err.message });
    return toast('Could not build the .scfg: ' + err.message);
  }
  var name = (P.name || 'screen') + '.scfg';
  log('export_scfg', { file: name, bytes: out.bytes.length, scrBytes: out.scr.length, rxFrom: scfgSrc.rxFrom, rx: SCFG.rxSummary(scfgSrc.rx),
    redundancy: rd.pairs.map(scfgPairText), redundancyFrom: rd.from, keepFrom: k ? k.from : null, problems: probs.slice(0, 20) });
  download(new Blob([out.bytes], { type: 'application/xml' }), name);
  $('scfgDlg').hidden = true;
  toast('Exported ' + name + ' (' + fmt(out.bytes.length) + ' bytes)');
}
