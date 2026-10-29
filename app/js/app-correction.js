// app-correction.js - the Correction tab (Unico / VMP "Correction"), kept to what the user allowed (docs/OPEN_NOVA_DESIGN.md
// §0: no coefficient upload, editing, erasing or generation — a wrong write can ruin a wall's calibration).
//   - Read (automatic once per screen, Read again any time; nothing is written): per cabinet of the screen picked in the
//     tree, whether calibration is on and which kind, and where the processor tells it, whether the card holds
//     coefficients (flat / calibrated) and has module flash. The map colours the cabinets; click cabinets to pick them.
//   - Calibration switch Off / Brightness / Brightness + chroma, on the processors whose switch was seen live (NovaLCT,
//     Unico); COEX shows it greyed "not confirmed yet". Goes out on click like the vendor apps; Save stays separate.
//   - NovaLCT-protocol processors only (captured from NovaLCT, docs/CAPTURE_CALIBRATION.md): Reset to flat (typed RESET;
//     working memory only, LCT's identity reset without its hour-long wait), Reload from cards (= undo while not saved),
//     Save to cards (typed SAVE: the only step that stores coefficients), Module flash: Flash check and Load from modules
//     (for a swapped module: load, look, then Save to cards). Picked cabinets, else the whole screen.
// Families answer through their driver's correctionCaps / correction (drv-lct / drv-unico / drv-coex); others show nothing.
// Owns: cor, COR_MODES, COR_COLORS, COR_WORDS, corLc, corCaps, corCabinets, corGroups, corCab, corScope, corRead, corRun,
// corSwitch, corTargets, corCount, corReset, corReload, corSave, corModule, corFlashCheck, corSum, renderCorrection, bindCorrection.
// Depends on: app-core (P, ui, $, esc, fmt, toast), app-log (log), app-geometry (allCells), app-hardware (hw, hwPortCells,
// hwBegin, hwEnd, HW_BUSY_WORDS), app-save (hwMarkUnsaved), app-processors (deviceOfCard, deviceById, cardsOfDevice,
// deviceLabel, procModel), app-capacity (portLabel), drv-core (DRV), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// data[devId] = {at, by: {'card:port:index': cab}, error}; sel[key] = 1 (picked cabinets); pending[devId] = what changed
// the coefficients without a save; flash[devId] = the last flash check; auto[screen|dev] = read once already.
var cor = { data: {}, sel: {}, busy: '', pending: {}, flash: {}, auto: {} };
var COR_MODES = [['off', 'Off'], ['brightness', 'Brightness'], ['chroma', 'Brightness + chroma']];
var COR_COLORS = { off: '#8a8f98', brightness: '#e0a84a', chroma: '#2fae6a', 'full-grayscale': '#8e6cf0', 'low-grayscale': '#3e9be0', on: '#2fae6a' };
var COR_WORDS = { off: 'Off', brightness: 'Brightness', chroma: 'Brightness + chroma', 'full-grayscale': 'Full-grayscale', 'low-grayscale': 'Low-grayscale', on: 'On' };

function corLc() { return lctById(ui.viewScreen) || P.lct[0]; }
function corCaps(d) { var x = d && d.hw && DRV.of(d); return x && x.correctionCaps ? x.correctionCaps(d) : null; }
// The cabinets of screen lc, addressed as Display & Test does (the export's cable order): [{key, d, card (on its link),
// port, index, w, h (its rectangle in the sending card's image), x, y, cw, ch (on the canvas), sender}].
function corCabinets(lc) {
  var by = allCells(), pc = hwPortCells(), out = [];
  P.screens.forEach(function (s) {
    if (s.screenId !== lc.id) return;
    (by[s.id] || []).forEach(function (c) {
      if (c.hole || c.sender == null) return;
      var d = deviceOfCard(c.sender), list = pc[c.sender + ':' + c.port] || [], i = 0;
      while (i < list.length && !(list[i].x === c.x && list[i].y === c.y)) i++;
      if (!d || i >= list.length) return;
      var card = cardsOfDevice(d).indexOf(c.sender);
      out.push({ key: d.id + '|' + card + ':' + c.port + ':' + i, d: d, card: card, port: c.port, index: i, sender: c.sender,
        w: list[i].width, h: list[i].height, x: c.x, y: c.y, cw: c.w, ch: c.h });
    });
  });
  return out;
}
// Per processor: [{d, cabs}] in project order.
function corGroups(cabs) {
  var by = {};
  cabs.forEach(function (c) { (by[c.d.id] || (by[c.d.id] = [])).push(c); });
  return P.devices.filter(function (d) { return by[d.id]; }).map(function (d) { return { d: d, cabs: by[d.id] }; });
}
function corCab(c) { var x = cor.data[c.d.id]; return x && x.by ? x.by[c.card + ':' + c.port + ':' + c.index] : null; }
// What a coefficient step works on: the picked cabinets of this screen, else all of them.
function corScope(cabs) { var s = cabs.filter(function (c) { return cor.sel[c.key]; }); return s.length ? s : cabs; }

// ------------------------------------------------------------------ read
function corRead(auto) {
  var lc = corLc(); if (!lc || cor.busy) return Promise.resolve(false);
  var groups = corGroups(corCabinets(lc)).filter(function (g) { var k = corCaps(g.d); return k && k.read; });
  if (!groups.length) { if (!auto) toast('No linked processor here reports calibration (link one in Device ▸ Hardware)'); return Promise.resolve(false); }
  cor.busy = 'read'; renderCorrection();
  return Promise.all(groups.map(function (g) {
    cor.auto[lc.id + '|' + g.d.id] = 1;
    return DRV.of(g.d).correction(g.d, 'read', { targets: g.cabs }).then(function (r) { return r; }, function (e) { return { ok: false, error: 'helper: ' + e.message }; }).then(function (r) {
      var x = cor.data[g.d.id] = { at: Date.now(), by: {}, error: r.ok ? '' : r.error };
      (r.cabinets || []).forEach(function (c) { x.by[c.card + ':' + c.port + ':' + c.index] = c; });
      log('correction_read', { screen: lc.name, processor: deviceLabel(g.d), ok: !!r.ok, cabinets: (r.cabinets || []).length, error: r.error, auto: !!auto });
      return r.ok;
    });
  })).then(function (oks) { cor.busy = ''; renderCorrection(); return oks.every(Boolean); });
}

// ------------------------------------------------------------------ writes
// Run op on every processor of the screen that offers it (cap = the correctionCaps key), one after the other.
// opts(g) -> the driver options for that processor (null = skip it). Returns the results.
function corRun(op, cap, label, opts) {
  var lc = corLc(), groups = corGroups(corCabinets(lc)).filter(function (g) { var k = corCaps(g.d); return k && k[cap]; }), out = [];
  if (!groups.length) { toast(label + ': no linked processor here offers it'); return Promise.resolve(out); }
  HW_BUSY_WORDS.correction = 'a correction step';
  if (!hwBegin('correction')) return Promise.resolve(out);
  cor.busy = op; renderCorrection();
  return groups.reduce(function (p, g) {
    return p.then(function () {
      var o = opts(g); if (!o) return;
      return DRV.of(g.d).correction(g.d, op, o).then(function (r) { return r; }, function (e) { return { ok: false, error: 'helper: ' + e.message }; }).then(function (r) {
        r.d = g.d; r.n = (o.targets || g.cabs).length; out.push(r);
        log('correction_' + op, { screen: lc.name, processor: deviceLabel(g.d), mode: o.mode, cabinets: r.n, ok: !!r.ok, writes: r.writes, error: r.error });
      });
    });
  }, Promise.resolve()).then(function () {
    hwEnd('correction'); cor.busy = '';
    var bad = out.filter(function (r) { return !r.ok; });
    toast(bad.length ? '⚠ ' + label + ' — ' + bad.map(function (r) { return deviceLabel(r.d) + ': ' + r.error; }).join('; ') : label + (out.length > 1 ? ' on ' + out.length + ' processors' : ''));
    renderCorrection(); return out;
  });
}
function corSwitch(mode) {
  var lc = corLc(), want = COR_WORDS[mode];
  return corRun('switch', 'modes', 'Calibration ' + want.toLowerCase(), function (g) { return { mode: mode, targets: g.cabs }; }).then(function (rs) {
    rs.forEach(function (r) { if (r.ok) hwMarkUnsaved(r.d, 'Calibration switch'); });
    if (!rs.some(function (r) { return r.ok; })) return;
    return corRead().then(function () {   // what the processors now report (Unico's mode numbers weren't seen live)
      var off = corCabinets(lc).filter(function (c) { var x = corCab(c); return x && !x.error && x.mode !== mode && rs.some(function (r) { return r.ok && r.d === c.d; }); });
      if (off.length) toast('⚠ ' + off.length + ' cabinet' + (off.length === 1 ? '' : 's') + ' report' + (off.length === 1 ? 's' : '') + ' “' + COR_WORDS[corCab(off[0]).mode] + '” after switching to “' + want + '”');
    });
  });
}
function corTargets(g, cap) {   // the picked (else all) cabinets of processor g that a step may touch
  var s = corScope(corCabinets(corLc())).filter(function (c) { return c.d === g.d; });
  if (cap === 'module') s = s.filter(function (c) { var x = corCab(c); return x && x.moduleFlash; });
  return s.length ? s : null;
}
function corCount(cap) { var lc = corLc(), n = 0; corGroups(corScope(corCabinets(lc))).forEach(function (g) { var k = corCaps(g.d); if (k && k[cap]) n += (corTargets(g, cap) || []).length; }); return n; }
function corReset() {
  var n = corCount('reset'); if (!n) return toast('Nothing to reset here');
  var t = prompt('Reset the calibration coefficients of ' + n + ' cabinet' + (n === 1 ? '' : 's') + ' to flat (no correction)?\n\n' +
    'The wall shows uncorrected at once. Only the cards’ working memory changes: Reload from cards (or a power cycle) brings the stored coefficients back — until you press Save to cards.\n\nType RESET to go on:', '');
  if (t === null) return log('correction_reset', { cancelled: true });
  if (t.trim().toUpperCase() !== 'RESET') return toast('Not reset (RESET wasn’t typed)');
  return corRun('reset', 'reset', 'Reset to flat (not saved)', function (g) { return (function (s) { return s && { targets: s }; })(corTargets(g, 'reset')); }).then(function (rs) {
    rs.forEach(function (r) { if (r.ok) cor.pending[r.d.id] = 'reset to flat on ' + r.n + ' cabinet' + (r.n === 1 ? '' : 's'); }); return corRead();
  });
}
function corReload() {
  return corRun('reload', 'reload', 'Back to the coefficients stored on the cards', function (g) { var s = corTargets(g, 'reload'); return s && { targets: s }; }).then(function (rs) {
    rs.forEach(function (r) { if (r.ok) delete cor.pending[r.d.id]; }); return corRead();
  });
}
function corModule() {
  var n = corCount('module'); if (!n) return toast('None of these cabinets reports module flash (Read first)');
  if (!confirm('Load the coefficients stored on the modules into ' + n + ' receiving card' + (n === 1 ? '' : 's') + '?\n\nFor a swapped module: the wall changes now. Reload from cards undoes it; Save to cards keeps it.')) return log('correction_module', { cancelled: true });
  return corRun('module', 'module', 'Module coefficients loaded (not saved)', function (g) { var s = corTargets(g, 'module'); return s && { targets: s }; }).then(function (rs) {
    rs.forEach(function (r) { if (r.ok) cor.pending[r.d.id] = 'module coefficients loaded on ' + r.n + ' card' + (r.n === 1 ? '' : 's'); }); return corRead();
  });
}
function corSave() {
  var n = corCount('save'); if (!n) return toast('Nothing to save here');
  var what = Object.keys(cor.pending).map(function (id) { var d = deviceById(id); return d ? deviceLabel(d) + ': ' + cor.pending[id] : ''; }).filter(Boolean);
  var t = prompt('Store the coefficients ' + n + ' cabinet' + (n === 1 ? ' shows' : 's show') + ' now in the receiving cards’ flash?\n\n' + (what.length ? 'Changed since the last save: ' + what.join('; ') + '.\n\n' : '') +
    'This replaces the coefficients they load at power-up and can’t be undone from Open Nova.\n\nType SAVE to go on:', '');
  if (t === null) return log('correction_save', { cancelled: true });
  if (t.trim().toUpperCase() !== 'SAVE') return toast('Not saved (SAVE wasn’t typed)');
  return corRun('save', 'save', 'Coefficients saved on the cards', function (g) { var s = corTargets(g, 'save'); return s && { targets: s }; }).then(function (rs) {
    rs.forEach(function (r) { if (r.ok) delete cor.pending[r.d.id]; });
  });
}
function corFlashCheck() {
  if (!corCount('module')) return toast('None of these cabinets reports module flash (Read first)');
  return corRun('flashcheck', 'flashCheck', 'Flash check done', function (g) { var s = corTargets(g, 'module'); return s && { targets: s }; }).then(function (rs) {
    rs.forEach(function (r) { if (r.ok) cor.flash[r.d.id] = { at: Date.now(), cards: r.cabinets || [] }; }); renderCorrection();
  });
}

// ------------------------------------------------------------------ render
// "Brightness 12 · Off 4" for cabinets cabs; with n.unread the ones not read yet.
function corSum(cabs, f, words) {
  var by = {}, order = [];
  cabs.forEach(function (c) { var x = corCab(c), v = x ? (x.error ? 'no answer' : f(x)) : cor.data[c.d.id] ? 'not found' : 'not read'; if (v == null) v = '—'; if (!(v in by)) { by[v] = 0; order.push(v); } by[v]++; });
  return order.map(function (v) { return (words && words[v] || v) + ' ' + by[v]; }).join(' · ');
}
function renderCorrection() {
  var body = $('coBody'), form = $('coForm'); if (!body || !form || ui.tab !== 'correction') return;
  var lc = corLc(); if (!lc) { body.innerHTML = '<p class="hint">No screen.</p>'; form.innerHTML = ''; return; }
  var cabs = corCabinets(lc), groups = corGroups(cabs), linked = groups.filter(function (g) { var k = corCaps(g.d); return k && k.read; });
  // first visit of a screen: read by itself (read-only)
  if (!cor.busy && linked.some(function (g) { return !cor.auto[lc.id + '|' + g.d.id]; })) setTimeout(function () { corRead(true); }, 0);
  var picked = cabs.filter(function (c) { return cor.sel[c.key]; }).length;
  // centre: the map
  var h = '<div class="sc-card"><h3>' + esc(lc.name) + '<span class="hint">' + cabs.length + ' cabinet' + (cabs.length === 1 ? '' : 's') + (picked ? ' · ' + picked + ' picked' : '') + '</span></h3>';
  if (!cabs.length) h += '<p class="hint">No cabinets of this screen are wired to a processor yet (Layout tab).</p>';
  else {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    cabs.forEach(function (c) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.cw); y1 = Math.max(y1, c.y + c.ch); });
    var sw = Math.max(x1 - x0, y1 - y0) / 300;
    h += '<svg class="sc-thumb co-map" viewBox="' + x0 + ' ' + y0 + ' ' + (x1 - x0) + ' ' + (y1 - y0) + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Cabinets of ' + esc(lc.name) + ' by calibration">' +
      cabs.map(function (c) {
        var x = corCab(c), m = x && !x.error ? x.mode : null, sel = cor.sel[c.key];
        var tip = portLabel(c.sender, c.port) + ' #' + (c.index + 1) + ' · ' + (!x ? (cor.data[c.d.id] ? 'not found on the processor' : 'not read') :x.error ? 'no answer' : 'calibration ' + (COR_WORDS[m] || m || '?').toLowerCase() +
          (x.armed && m === 'off' ? ' (' + COR_WORDS[x.armed].toLowerCase() + ' selected)' : '') + (x.coef ? ' · coefficients ' + x.coef : '') + (x.moduleFlash != null ? ' · module flash ' + (x.moduleFlash ? 'yes' : 'no') : ''));
        return '<rect data-ck="' + esc(c.key) + '" x="' + c.x + '" y="' + c.y + '" width="' + c.cw + '" height="' + c.ch + '" fill="' + (m ? COR_COLORS[m] || '#888' : 'transparent') + '" fill-opacity="' + (m ? '.6' : '0') +
          '" stroke="' + (sel ? 'var(--accent, #3e8ef7)' : x && x.error ? '#e05252' : '#000') + '" stroke-opacity="' + (sel ? 1 : .4) + '" stroke-width="' + (sel ? sw * 3 : sw) + '"' + (m ? '' : ' stroke-dasharray="' + sw * 3 + '"') +
          ' style="cursor:pointer"><title>' + esc(tip) + '</title></rect>';
      }).join('') + '</svg>';
    h += '<p class="hint">' + COR_MODES.concat([['full-grayscale', 'Full-grayscale']]).map(function (m) { return '<span style="color:' + COR_COLORS[m[0]] + '">■</span> ' + m[1]; }).join(' &nbsp; ') +
      ' &nbsp; <span>⬚</span> not read' + (picked ? ' (<a href="#" data-co="clear">clear the pick</a>)' : '') + itip('Click cabinets to pick them for the coefficient steps (Reset, Reload, Save to cards, module flash); nothing picked = the whole screen.') + '</p>';
  }
  h += '</div>';
  // centre: per processor
  h += '<div class="sc-card"><h3>Processors<span class="hint">as they report it' + (cor.busy === 'read' ? ' · reading…' : '') + '</span>' +
    itip('Coefficients: “flat” = no correction stored, “calibrated” = the card holds coefficients (two pixels sampled per card). Upload and editing of coefficients stay out of Open Nova.') + '</h3>';
  if (!groups.length) h += '<p class="hint">No processor drives this screen yet.</p>';
  else {
    h += '<table class="sc-tbl"><tr><th>Processor</th><th>Calibration</th><th>Coefficients</th><th>Module flash</th></tr>';
    groups.forEach(function (g) {
      var d = g.d, k = corCaps(d), x = cor.data[d.id], c = DRV.caps(d);
      h += '<tr><td><b>' + esc(deviceLabel(d)) + '</b><br><span class="hint">' + esc(procModel(d.model).name) + ' · ' + (d.hw ? (c.simulated ? 'simulated' : esc(d.hw.host)) : 'not linked') + '</span></td>';
      if (!k) { h += '<td colspan="3" class="na">' + (!d.hw ? 'Link it to read its calibration (Device ▸ Hardware)' : c.simulated ? 'Simulated: nothing to read' : 'Not available for this processor yet') + '</td></tr>'; return; }
      if (x && x.error) { h += '<td colspan="3" class="err">' + esc(x.error) + '</td></tr>'; return; }
      h += '<td>' + esc(corSum(g.cabs, function (y) { return y.mode; }, COR_WORDS)) + '</td>' +
        '<td' + (cor.pending[d.id] ? ' class="diff" title="Not stored on the cards: Reload from cards or a power cycle undoes it"' : '') + '>' +
        (k.reset ? esc(corSum(g.cabs, function (y) { return y.coef || null; })) : '<span class="na">not reported</span>') + (cor.pending[d.id] ? '<br>' + esc(cor.pending[d.id]) + ', not saved' : '') + '</td>' +
        '<td>' + esc(corSum(g.cabs, function (y) { return y.moduleFlash == null ? null : y.moduleFlash ? 'yes' : 'no'; })) + '</td></tr>';
    });
    h += '</table>';
  }
  h += '</div>';
  // centre: the last flash check
  var fl = groups.filter(function (g) { return cor.flash[g.d.id]; });
  if (fl.length) {
    h += '<div class="sc-card"><h3>Flash check<span class="hint">module flash on the receiving cards</span></h3><ul>';
    fl.forEach(function (g) {
      var cs = cor.flash[g.d.id].cards, bad = cs.filter(function (c) { return c.error || (c.bad || []).length; });
      if (!bad.length) h += '<li>' + esc(deviceLabel(g.d)) + ': all ' + cs.length + ' card' + (cs.length === 1 ? '' : 's') + ' OK</li>';
      bad.forEach(function (c) {
        var where = portLabel(cardsOfDevice(g.d)[c.card], c.port) + ' #' + (c.index + 1);
        h += '<li class="err">' + esc(deviceLabel(g.d) + ' ' + where + ': ' + (c.error || c.bad.map(function (b) { return 'module ' + b.module + ' (' + b.x + ', ' + b.y + ', ' + b.w + '×' + b.h + ') ' + (b.expected === 'present' ? 'fault' : 'not expected') + ' [' + b.result + ']'; }).join('; '))) + '</li>';
      });
    });
    h += '</ul></div>';
  }
  body.innerHTML = h;
  // right: the controls
  var busy = !!cor.busy, f = '';
  var sw2 = groups.filter(function (g) { var k = corCaps(g.d); return k && k.modes; }), no = groups.filter(function (g) { var k = corCaps(g.d); return !k || !k.modes; });
  var cur = {}; cabs.forEach(function (c) { var x = corCab(c); if (x && !x.error) cur[x.mode] = 1; });
  // where the switches go: one "→ target" line at the top, as on Screen Settings (proposal §2.9)
  if (sw2.length) f += '<div class="sc-target" title="Calibration goes to">→ ' + sw2.map(function (g) { var k = corCaps(g.d); return '<span' + (k.modesNote ? ' title="' + esc(k.modesNote) + '"' : '') + '>' + esc(deviceLabel(g.d)) + '</span>'; }).join(', ') + '</div>';
  f += '<div class="sc-field' + (sw2.length ? '' : ' off') + '"><label><span>Calibration</span></label><div class="seg co-seg" role="group" aria-label="Calibration">' +
    COR_MODES.map(function (m) { var on = Object.keys(cur).length === 1 && cur[m[0]]; return '<button data-co="mode" data-mode="' + m[0] + '" class="' + (on ? 'on' : '') + '"' + (sw2.length && !busy ? '' : ' disabled') + ' title="' + (m[0] === 'off' ? 'Switch calibration off' : 'Switch ' + m[1].toLowerCase() + ' calibration on') + ' — goes out now; Save keeps it after a power cycle">' + m[1] + '</button>'; }).join('') + '</div>';
  no.forEach(function (g) { var k = corCaps(g.d); f += '<p class="hint">' + esc(deviceLabel(g.d)) + ': ' + esc(k ? k.modesWhy || 'not available' : g.d.hw ? 'not available' : 'not linked') + '</p>'; });
  f += '</div>';
  var cg = groups.filter(function (g) { var k = corCaps(g.d); return k && k.reset; });
  if (cg.length) {
    var n = corScope(cabs).filter(function (c) { return cg.some(function (g) { return g.d === c.d; }); }).length, pend = cg.some(function (g) { return cor.pending[g.d.id]; });
    var dis = busy ? ' disabled' : '';
    f += '<div class="sc-field"><label><span>Coefficients</span><span class="hint">' + (picked ? n + ' picked' : 'whole screen · ' + n) + '</span></label>' +
      '<div class="row"><button data-co="reset" class="danger"' + dis + ' title="Coefficients to flat (no correction) on these cabinets — working memory only; asks for RESET">Reset to flat…</button>' +
      '<button data-co="reload"' + dis + ' title="Back to the coefficients stored on the cards (undoes a reset or a module load that wasn’t saved)">Reload from cards</button></div>' +
      '<div class="row" style="margin-top:6px"><button data-co="save"' + (pend ? ' class="primary"' : '') + dis + ' title="Store what the cards show now in their flash (the coefficients they load at power-up); asks for SAVE">Save to cards…</button></div>' +
      (pend ? '<p class="hint chg">Changed, not stored: a power cycle undoes it.</p>' : '') + '</div>';
    var mf = corCount('module');
    f += '<div class="sc-field' + (mf ? '' : ' off') + '"><label><span>Module flash</span><span class="hint">' + (mf ? mf + ' card' + (mf === 1 ? '' : 's') : 'none reported') + '</span></label>' +
      '<div class="row"><button data-co="flash"' + (mf && !busy ? '' : ' disabled') + ' title="Check the modules’ flash on these cards (NovaLCT’s Flash Check)">Flash check</button>' +
      '<button data-co="module"' + (mf && !busy ? '' : ' disabled') + ' title="Load the coefficients stored on the modules into the cards (for a swapped module); Save to cards keeps them">Load from modules</button></div>' +
      (mf ? '' : '<p class="hint">Only cards that report module flash (Read first).</p>') + '</div>';
  } else if (groups.length) f += '<div class="sc-field off"><label><span>Coefficients</span></label><p class="hint">NovaLCT-protocol processors only' + itip('Coefficient reset and module flash were captured from NovaLCT only, not yet from Unico / VMP.') + '</p></div>';
  form.innerHTML = f;
  var rb = $('coRead'); if (rb) { rb.disabled = busy || !linked.length; rb.textContent = cor.busy === 'read' ? 'Reading…' : 'Read'; }
}

function bindCorrection() {
  var body = $('coBody'), form = $('coForm'); if (!body || !form) return;
  body.addEventListener('click', function (e) {
    var r = e.target.closest('[data-ck]');
    if (r) { var k = r.getAttribute('data-ck'); if (cor.sel[k]) delete cor.sel[k]; else cor.sel[k] = 1; return renderCorrection(); }
    if (e.target.closest('[data-co="clear"]')) { e.preventDefault(); cor.sel = {}; renderCorrection(); }
  });
  form.addEventListener('click', function (e) {
    var b = e.target.closest('[data-co]'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-co');
    if (a === 'mode') corSwitch(b.getAttribute('data-mode'));
    else if (a === 'reset') corReset();
    else if (a === 'reload') corReload();
    else if (a === 'save') corSave();
    else if (a === 'module') corModule();
    else if (a === 'flash') corFlashCheck();
  });
  $('coRead').onclick = function () { corRead(false); };
  // Esc clears the picked cabinets (on window, capture: the shell's key guard stops other tabs' keys from going further)
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && ui.tab === 'correction' && Object.keys(cor.sel).length) { cor.sel = {}; renderCorrection(); } }, true);
}
