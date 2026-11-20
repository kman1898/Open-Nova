// app-screen.js - the Screen Settings tab (design phase 6; Unico "Screen Settings", VMP "Screen Settings"): colour,
// output and latency per screen, for every processor driving it.
//   - The wanted values live in the project, per screen (lct[i].color, only the ones you set; bit depth is the project's
//     bitDepth, the same field as on Layout, because it changes the port capacity). Undo works on them like on any edit.
//   - Brightness, gamma, colour temperature and gamut go out LIVE (user, 2026-10-11: "those should be sending every time I
//     touch the slider or up and down key or type and hit enter"): while a slider moves (always the latest value — one
//     write per processor in flight, the newest waits), on each arrow-key step, and on Enter / leaving a typed box. No
//     dialog. Bit depth and low latency (they change port capacity / the output) still go through Apply…, which lists
//     per processor what will change and asks first. What was applied is remembered per processor and screen in this
//     browser (hardware state, not project data), so each control shows wanted vs applied, and Revert puts them back.
//   - When the tab opens (and when a processor gets linked) each linked processor is READ (driver readColor, read-only):
//     what it holds becomes its applied value, so the controls start at the processor's real brightness / gamma /
//     colour temperature / gamut instead of the defaults (a wanted value set here still wins).
//   - A setting a processor refuses rolls the control back (Unico kept 10-bit silently after a rejection, UTOUR §6.8)
//     and the error is shown; applied changes make the processor "unsaved" (Save stays separate, app-save.js).
//   - Which settings a processor offers comes from its driver (caps.color / caps.lowLatency): brightness on NovaLCT-
//     protocol processors, all five on VX Pro; low latency only where it was seen live (LCT's two switches).
//   - Low latency (sending card) is checked first on every port pair of the screen (LCT only checks the first two,
//     docs\COLOR_BRIGHTNESS.md §6.9): each port must feed its own columns; touching is fine. On failure nothing is sent.
// Owns: SCR_FIELDS, SCR_GAMUTS, SCR_APPLIED_KEY, scr, scrLc, scrColor, scrWanted, scrDevices, scrKey, scrApplied, scrAppliedStore, scrRead,
// scrLowLatencyCheck, scrSupports, scrChanges, scrApply, scrApplyScreens, scrLive, scrRevert, scrSet, scrThumb, scrThumbSvg, SCR_PRIM, scrVisHtml, scrTargetHtml, renderScreenTab, bindScreen.
// Depends on: app-core (P, ui, $, esc, fmt, toast, commit), app-log (log), app-geometry (allCells), app-capacity
// (portColor, capacity), app-processors (deviceOfCard, cardsOfDevice, deviceLabel, procModel), app-hardware (hw),
// app-save (hwMarkUnsaved), drv-core (DRV), app-render (renderAll), app-tips (itip), scr.js (SCR), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// One entry per setting. cap = the driver capability (caps.color[cap], or caps.lowLatency for 'll'); act = screenSet action.
var SCR_FIELDS = [
  { k: 'brightness', grp: 'iq', label: 'Brightness', unit: '%', cap: 'brightness', act: 'brightness', def: 100, min: 0, max: 100, step: 1 },
  { k: 'gamma', grp: 'iq', label: 'Gamma', cap: 'gamma', act: 'gamma', def: 2.8, min: 1, max: 4, step: 0.1 },
  { k: 'colorTemp', grp: 'iq', label: 'Colour temperature', unit: 'K', cap: 'colorTemp', act: 'colortemp', def: 6500, min: 2000, max: 10000, step: 100 },
  { k: 'gamut', grp: 'iq', label: 'Gamut', cap: 'gamut', act: 'gamut', def: 'original' },
  { k: 'bitDepth', grp: 'out', label: 'Bit depth', unit: '-bit', cap: 'bitDepth', act: 'bitdepth', def: 8, keep: true },
  { k: 'llSender', grp: 'lat', label: 'Low latency — processor', cap: 'll', which: 'sender', def: false, keep: true },
  { k: 'llRx', grp: 'lat', label: 'Low latency — receiving cards', cap: 'll', which: 'rx', def: false, keep: true }
];
// One name per state everywhere (the list, the Gamut tile, the processors table, Dashboard, scenes: scrFmt); NovaLCT's
// buttons Off / PAL / NTSC are Native / Rec.709 / NTSC here (its names are in the list's tooltip).
var SCR_GAMUTS = [['original', 'Native'], ['rec709', 'Rec.709'], ['dcip3', 'DCI-P3'], ['dcip3d65', 'DCI-P3 D65'], ['rec2020', 'Rec.2020'], ['input', 'From input'], ['ntsc', 'NTSC']];
// What this screen's processors offer: caps.color.gamuts (NovaLCT: its Off / PAL / NTSC buttons), else all but NovaLCT's NTSC.
function scrGamuts(devs) {
  var ok = devs.map(function (e) { return (DRV.caps(e.d).color || {}).gamuts; }).filter(Boolean)[0];
  return SCR_GAMUTS.filter(function (g) { return ok ? ok.indexOf(g[0]) >= 0 : g[0] !== 'ntsc'; })
    .concat(ok ? (P.gamuts || []).map(function (e) { return ['c:' + e.id, e.name]; }) : []);   // named custom gamuts (app-gamut.js)
}
// Alpha, locked, with a real processor: the controls are shown but greyed, nothing would get through (app-alpha.js).
function scrLocked() { return typeof alphaGrey === 'function' && alphaGrey(); }
var SCR_APPLIED_KEY = 'opennova.screenApplied';
var scr = { tab: 'iq', busy: false, applied: null, errors: {}, bitWas: {}, live: {}, keepForm: false, read: {}, readDone: {}, shown: false };   // live[devId|k] = {busy, next}   // errors[devId|lcId|k] = last refusal; bitWas[lcId] = bit depth before this tab changed it
// read[link|lcId] = {values, notes, mixed, at, error} = what the processor said it holds (read when the tab opens / on link)

function scrLc() { return lctById(ui.viewScreen) || P.lct[0]; }
function scrField(k) { return SCR_FIELDS.filter(function (f) { return f.k === k; })[0]; }
// What the controls show: the wanted value, else what the first processor holds (read from it or applied from here),
// else the default.
function scrColor(lc) {
  var c = lc.color || {}, out = {}, devs = scrDevices(lc);
  SCR_FIELDS.forEach(function (f) {
    if (f.k === 'bitDepth') { out[f.k] = P.bitDepth; return; }
    if (f.k in c) { out[f.k] = c[f.k]; return; }
    var v = devs.map(function (e) { return e.d.hw && scrSupports(e.d, f) ? scrApplied(e.d, lc)[f.k] : undefined; }).filter(function (x) { return x !== undefined && x !== null; })[0];
    out[f.k] = v !== undefined ? v : f.def;
  });
  return out;
}
// The settings that will be sent: only the ones set here (a processor's own values are never overwritten by defaults).
function scrWanted(lc) {
  var c = lc.color || {}, out = {};
  Object.keys(c).forEach(function (k) { if (scrField(k)) out[k] = k === 'bitDepth' ? P.bitDepth : c[k]; });
  return out;
}

// The processors driving screen lc, with the ports (their own card numbering) and the cells (for the low-latency check).
function scrDevices(lc) {
  var by = {}, cellsBy = allCells();
  P.screens.forEach(function (s) {
    if (s.screenId !== lc.id) return;
    (cellsBy[s.id] || []).forEach(function (c) {
      if (c.hole || c.sender == null) return;
      var d = deviceOfCard(c.sender); if (!d) return;
      var e = by[d.id] || (by[d.id] = { d: d, ports: [], seen: {}, cells: 0 });
      var card = cardsOfDevice(d).indexOf(c.sender), k = card + ':' + c.port;
      if (!e.seen[k]) { e.seen[k] = 1; e.ports.push({ card: card, port: c.port }); }
      e.cells++;
    });
  });
  return (typeof olShownDevices === 'function' ? olShownDevices() : P.devices).filter(function (d) { return by[d.id]; }).map(function (d) { return by[d.id]; });   // online: the connected ones (app-online.js)
}

// ------------------------------------------------------------------ applied values (this browser)
function scrKey(d, lc) { return d.id + '@' + (d.hw ? d.hw.host + ':' + d.hw.port : 'none') + '|' + lc.id; }   // per link: a simulated link doesn't inherit the real one's values
function scrApplied(d, lc) {
  if (!scr.applied) { try { scr.applied = JSON.parse(localStorage.getItem(SCR_APPLIED_KEY) || '{}') || {}; } catch (e) { scr.applied = {}; } }
  var k = scrKey(d, lc);
  return scr.applied[k] || (scr.applied[k] = {});
}
function scrAppliedStore() { try { localStorage.setItem(SCR_APPLIED_KEY, JSON.stringify(scr.applied || {})); } catch (e) { /* storage unavailable */ } }

// ------------------------------------------------------------------ read what the processors hold (read-only)
// Once per processor link and screen each time the tab opens (and for a processor linked while it is open): the driver's
// readColor (NovaLCT card registers, Unico screen/list-detail, COEX displayparams + output). A value read becomes the
// processor's "applied" value (the table and the controls start from it); a setting being sent live right now is left
// alone. Nothing is written; a processor that can't be read keeps "—".
function scrRead(lc) {
  if (scr.busy) return Promise.resolve();
  return Promise.all(scrDevices(lc).map(function (e) {
    var d = e.d, x = d.hw && DRV.of(d), key = scrKey(d, lc);
    if (!x || !x.readColor || scr.readDone[key]) return;
    scr.readDone[key] = 1;
    var call; try { call = x.readColor(d, e.ports); } catch (err) { call = Promise.resolve({ ok: false, error: err.message }); }
    return Promise.resolve(call).then(function (r) { return r; }, function (err) { return { ok: false, error: 'helper: ' + err.message }; }).then(function (r) {
      var got = [];
      scr.read[key] = { at: Date.now(), values: (r && r.values) || {}, notes: (r && r.notes) || {}, mixed: (r && r.mixed) || [], error: r && !r.ok ? (r.error || 'read failed') : '' };
      if (r && r.ok) {
        var ap = scrApplied(d, lc);
        Object.keys(r.values || {}).forEach(function (k) {
          var f = scrField(k), v = r.values[k], st = scr.live[d.id + '|' + lc.id + '|' + k];
          if (!f || !scrSupports(d, f) || v === null || v === undefined || (st && st.busy)) return;   // shown in the table only
          ap[k] = v; got.push(k);
        });
        scrAppliedStore();
      }
      log('screen_read', { screen: lc.name, device: deviceLabel(d), ok: !!(r && r.ok), read: got, values: r && r.values, error: r && r.error });
      if (r && r.record) gmLogCard(d, lc, r.record);   // what NovaLCT stored, against our maths (app-gamut.js)
      if (ui.tab !== 'screen') return;
      var a = document.activeElement, using = a && a.closest && a.closest('#scForm') && /^(INPUT|SELECT)$/.test(a.tagName);
      scr.keepForm = !!using; renderScreenTab(); scr.keepForm = false;   // a control being used stays put
    });
  }));
}
// Read back: ask the processors again and show, setting by setting, what is set here against what they hold.
function scrReadBack() {
  var lc = scrLc(); if (!lc) return;
  var devs = scrDevices(lc).filter(function (e) { return e.d.hw && DRV.of(e.d).readColor; });
  if (!devs.length) return toast('Nothing to read: no linked processor drives ' + lc.name);
  var was = {}, want = scrWanted(lc);
  devs.forEach(function (e) { var k = scrKey(e.d, lc); was[k] = JSON.parse(JSON.stringify(scrApplied(e.d, lc))); delete scr.readDone[k]; });
  return scrRead(lc).then(function () {
    var rows = [];
    devs.forEach(function (e) {
      var key = scrKey(e.d, lc), rd = scr.read[key] || { values: {}, notes: {} };
      if (rd.error) return rows.push({ s: deviceLabel(e.d), a: '—', b: '—', ok: false, why: rd.error });
      SCR_FIELDS.forEach(function (f) {
        if (!(f.k in rd.values)) return;
        var here = f.k in want ? want[f.k] : was[key][f.k], v = rd.values[f.k], known = v !== null && v !== undefined;
        rows.push({ s: f.label + (devs.length > 1 ? ' · ' + deviceLabel(e.d) : ''), a: here === undefined ? '—' : scrFmt(f, here), b: known ? scrFmt(f, v) : '—', ok: known && (here === undefined || here === v),
          why: !known ? rd.notes[f.k] || 'not known' : rd.mixed.indexOf(f.k) >= 0 ? 'its ports differ' : 'differs' });
      });
    });
    $('cmpTitle').textContent = 'Read back: ' + lc.name;
    $('cmpBody').innerHTML = '<table class="cmp"><tr><th>Setting</th><th>Set here</th><th>On the processor</th><th></th></tr>' + rows.map(function (r) {
      return '<tr class="' + (r.ok ? 'ok' : 'bad') + '"><td>' + esc(r.s) + '</td><td>' + esc(r.a) + '</td><td>' + esc(r.b) + '</td><td>' + (r.ok ? '✓' : '⚠ ' + esc(r.why)) + '</td></tr>';
    }).join('') + '</table>';
    $('cmpDlg').hidden = false;
    log('screen_read_back', { screen: lc.name, settings: rows.length, differences: rows.filter(function (r) { return !r.ok; }).length });
  });
}

// ------------------------------------------------------------------ checks
// LCT's sending-card low-latency rule, on every port pair (docs\COLOR_BRIGHTNESS.md §6.9): each port's horizontal load
// range [minX, maxX] must not share a start or an end with another port's, nor overlap it. Touching is allowed.
function scrLowLatencyCheck(lc) {
  var cellsBy = allCells(), span = {}, keys = [];
  P.screens.forEach(function (s) {
    if (s.screenId !== lc.id) return;
    (cellsBy[s.id] || []).forEach(function (c) {
      if (c.hole || c.sender == null) return;
      var k = c.sender + ':' + c.port, r = span[k];
      if (!r) { r = span[k] = { k: k, sender: c.sender, port: c.port, x0: c.x, x1: c.x + c.w }; keys.push(k); }
      r.x0 = Math.min(r.x0, c.x); r.x1 = Math.max(r.x1, c.x + c.w);
    });
  });
  var bad = [];
  for (var i = 0; i < keys.length; i++) for (var j = i + 1; j < keys.length; j++) {
    var a = span[keys[i]], b = span[keys[j]];
    if (a.x0 === b.x0 || a.x1 === b.x1 || (b.x0 < a.x1 && b.x1 > a.x0)) bad.push([a, b]);
  }
  var name = function (r) { return portLabel(r.sender, r.port) + ' (X ' + r.x0 + '–' + r.x1 + ')'; }, more = bad.length > 1 ? ' (+' + (bad.length - 1) + ' more pair' + (bad.length > 2 ? 's' : '') + ')' : '';
  if (keys.length < 2) return { ok: true, text: keys.length ? 'One port drives this screen: nothing to compare.' : 'No cabinets are wired on this screen yet.' };
  if (!bad.length) return { ok: true, text: 'OK: all ' + keys.length + ' ports feed their own columns.' };
  // short: the one line under the switch; text: the whole reason (its tooltip, and Apply's skip line)
  return { ok: false, bad: bad, short: 'Can’t be switched on: ' + portLabel(bad[0][0].sender, bad[0][0].port) + ' and ' + portLabel(bad[0][1].sender, bad[0][1].port) + ' overlap' + more,
    text: 'Can’t be switched on: ' + name(bad[0][0]) + ' and ' + name(bad[0][1]) + ' cover the same columns' + more +
    '. For low latency every port must feed its own vertical strip (ports stacked in rows always fail).' };
}

// Does processor d offer setting f? (from its driver; unlinked processors answer for their model)
function scrSupports(d, f) {
  var c = DRV.caps(d), x = DRV.of(d);
  if (f.cap === 'll') return !!(c.lowLatency && x.lowLatency) && !(f.which === 'rx' && c.lowLatencyOne);   // COEX: one switch only
  return !!(c.color && c.color[f.cap] && x.screenSet);
}
function scrFmt(f, v) {
  if (v === undefined || v === null) return '—';
  if (f.k === 'gamut') { var ce = gmEntry(v), g = SCR_GAMUTS.filter(function (x) { return x[0] === v; })[0]; return ce ? ce.name : g ? g[1] : v; }
  if (f.cap === 'll') return v ? 'On' : 'Off';
  return v + (f.unit === '%' ? ' %' : f.unit === 'K' ? ' K' : f.unit || '');
}

// What Apply would send to each processor driving lc: [{d, e, linked, send:[{f,v}], skip:[{f,why}]}].
function scrChanges(lc) {
  var want = scrWanted(lc), ll = null;
  return scrDevices(lc).map(function (e) {
    var d = e.d, ap = scrApplied(d, lc), out = { d: d, e: e, linked: !!d.hw, send: [], skip: [] };
    Object.keys(want).forEach(function (k) {
      var f = scrField(k), v = want[k];
      if (ap[k] === v) return;
      if (!scrSupports(d, f)) { out.skip.push({ f: f, why: 'not available on this processor yet' }); return; }
      if (k === 'llSender' && v && DRV.caps(d).llCheck) { ll = ll || scrLowLatencyCheck(lc); if (!ll.ok) { out.skip.push({ f: f, why: ll.text }); return; } }   // LCT's rule (COEX firmware checks nothing)
      out.send.push({ f: f, v: v });
    });
    return out;
  });
}

// ------------------------------------------------------------------ Apply / Revert
function scrApply() { var lc = scrLc(); if (lc) return scrApplyScreens([lc], lc.name); }
// Apply the wanted settings of several screens (a scene does all its screens at once): one confirmation listing every
// screen and processor, then the writes in order; per screen, a setting no processor took rolls back. Returns a promise.
function scrApplyScreens(lcs, title) {
  if (scr.busy) return Promise.resolve(false);
  var work = lcs.map(function (lc) { var plan = scrChanges(lc); return { lc: lc, plan: plan, go: plan.filter(function (p) { return p.linked && p.send.length; }) }; });
  var who = function (d) { return deviceLabel(d) + ' (' + procModel(d.model).name + (d.hw ? ', ' + (DRV.caps(d).simulated ? 'simulated' : d.hw.host) : '') + ')'; };
  var lines = work.map(function (w) {
    var t = w.plan.map(function (p) {
      if (!p.linked) return '  ' + who(p.d) + ': not linked — nothing sent (link it in Device → Hardware)';
      var x = p.send.length ? p.send.map(function (s) { return '    • ' + s.f.label + ' → ' + scrFmt(s.f, s.v) + (s.f.keep ? '  (check before a show)' : ''); }).join('\n') : '    nothing to change';
      if (p.skip.length) x += '\n' + p.skip.map(function (s) { return '    – ' + s.f.label + ': ' + s.why; }).join('\n');
      return '  ' + who(p.d) + ':\n' + x;
    }).join('\n');
    return (lcs.length > 1 ? w.lc.name + ':\n' : '') + (t || '  no processor drives it yet');
  });
  var total = work.reduce(function (n, w) { return n + w.go.length; }, 0);
  if (!total) {
    var any = work.some(function (w) { return w.plan.length; }), unl = work.some(function (w) { return w.plan.some(function (p) { return !p.linked; }); });
    toast(any ? 'Nothing to apply on ' + title + (unl ? ' (link the processors first)' : '') : 'No processor drives ' + title + ' yet');
    log('screen_apply', { screens: lcs.map(function (l) { return l.name; }), nothing: true }); return Promise.resolve(false);
  }
  if (!confirm((/^scene /.test(title) ? 'Recall ' : 'Apply to ') + title + '?\n\n' + lines.join('\n\n').replace(/^  /gm, lcs.length > 1 ? '  ' : '') + '\n\nThis changes the picture now. It isn’t stored on the processors until Save.')) {
    log('screen_apply', { screens: lcs.map(function (l) { return l.name; }), cancelled: true }); return Promise.resolve(null);   // null = cancelled (false = nothing sent)
  }
  scr.busy = true; renderScreenTab();
  var msgs = [], rolledAll = 0, chain = Promise.resolve();
  work.forEach(function (w) {
    var lc = w.lc; w.failed = {}; w.okKeys = {};
    w.go.forEach(function (p) {
      var drv = DRV.of(p.d), ap = scrApplied(p.d, lc), any = false;
      p.send.forEach(function (s) {
        chain = chain.then(function () {
          var call;   // a driver that throws (or lacks the call) counts as refused, never leaves Apply stuck
          try { call = s.f.cap === 'll' ? drv.lowLatency(p.d, s.f.which, !!s.v, p.e.ports) : drv.screenSet(p.d, s.f.act, s.v, p.e.ports); }
          catch (e) { call = Promise.resolve({ ok: false, error: e.message }); }
          return call.then(function (r) { return r; }, function (e) { return { ok: false, error: 'helper: ' + e.message }; }).then(function (r) {
            var ek = p.d.id + '|' + lc.id + '|' + s.f.k;
            if (r.ok) { ap[s.f.k] = s.v; w.okKeys[s.f.k] = 1; any = true; delete scr.errors[ek]; }
            else { w.failed[s.f.k] = 1; scr.errors[ek] = r.error || 'refused'; msgs.push(deviceLabel(p.d) + ': ' + s.f.label + ' — ' + (r.error || 'refused')); }
            log('screen_set', { screen: lc.name, device: deviceLabel(p.d), setting: s.f.k, value: s.v, ok: !!r.ok, error: r.error });
          });
        });
      });
      chain = chain.then(function () { if (any) hwMarkUnsaved(p.d, 'Screen settings'); });
    });
  });
  return chain.then(function () {
    scrAppliedStore();
    // Roll back a control that no processor took: back to what was applied before (or to unset).
    work.forEach(function (w) {
      var lc = w.lc, rolled = Object.keys(w.failed).filter(function (k) { return !w.okKeys[k]; });
      if (!rolled.length) return;
      rolledAll += rolled.length; lc.color = lc.color || {};
      rolled.forEach(function (k) {
        var prev = w.go.map(function (p) { return scrApplied(p.d, lc)[k]; }).filter(function (v) { return v !== undefined; })[0];
        if (k === 'bitDepth') { P.bitDepth = prev !== undefined ? prev : (scr.bitWas[lc.id] || P.bitDepth); delete lc.color.bitDepth; }
        else if (prev !== undefined) lc.color[k] = prev; else delete lc.color[k];
      });
    });
    if (rolledAll) commit();
    scr.busy = false;
    toast(msgs.length ? '⚠ ' + msgs[0] + (msgs.length > 1 ? ' (+' + (msgs.length - 1) + ' more)' : '') + (rolledAll ? ' — rolled back' : '') : (/^scene /.test(title) ? 'Recalled ' : 'Applied to ') + title + ' (not saved yet)');
    renderAll();
    return !msgs.length;
  }).catch(function (e) {   // anything unexpected: never leave "Applying…" stuck
    scr.busy = false; log('screen_apply', { error: e.message }); toast('Applying failed: ' + e.message); renderAll(); return false;
  });
}
// Live: send one setting of the current screen to every linked processor that offers it, now, without asking. Per
// processor and setting one write is in flight; a newer value waits and goes next (older waiting values are dropped).
function scrLive(k, v) {
  var lc = scrLc(), f = scrField(k); if (!lc || !f || f.keep || scrLocked()) return;
  lc.color = lc.color || {}; lc.color[k] = v;   // wanted (the undo step is taken when the control is released)
  scrDevices(lc).forEach(function (e) {
    var d = e.d; if (!d.hw || !scrSupports(d, f)) return;
    var key = d.id + '|' + lc.id + '|' + k, st = scr.live[key] || (scr.live[key] = {});
    if (st.busy && st.cur === v) { st.next = null; return; }   // that value is on its way already
    st.next = { v: v, ports: e.ports };
    if (st.busy) return;
    (function pump() {
      var job = st.next; st.next = null; if (!job) { st.busy = false; return; }
      st.busy = true; st.cur = job.v;
      var call; try { call = DRV.of(d).screenSet(d, f.act, job.v, job.ports); } catch (x) { call = Promise.resolve({ ok: false, error: x.message }); }
      Promise.resolve(call).then(function (r) { return r; }, function (x) { return { ok: false, error: 'helper: ' + x.message }; }).then(function (r) {
        var ap = scrApplied(d, lc);
        if (r && r.ok) { ap[k] = job.v; delete scr.errors[key]; hwMarkUnsaved(d, 'Screen settings'); scrAppliedStore(); }
        else { if (scr.errors[key] !== (r && r.error)) toast('⚠ ' + deviceLabel(d) + ': ' + f.label + ' — ' + ((r && r.error) || 'refused')); scr.errors[key] = (r && r.error) || 'refused'; }
        log('screen_set', { screen: lc.name, device: deviceLabel(d), setting: k, value: job.v, ok: !!(r && r.ok), error: r && r.error, live: true });
        scr.keepForm = true; renderScreenTab(); scr.keepForm = false;   // the processors table; the control being used stays put
        pump();
      });
    })();
  });
}
// Controls back to what was last applied (the first processor that has a value for a setting).
function scrRevert() {
  var lc = scrLc(); if (!lc) return;
  var devs = scrDevices(lc), c = {};
  SCR_FIELDS.forEach(function (f) {
    var v = devs.map(function (e) { return scrApplied(e.d, lc)[f.k]; }).filter(function (x) { return x !== undefined; })[0];
    if (v !== undefined) { c[f.k] = v; if (f.k === 'bitDepth') P.bitDepth = v; }
  });
  lc.color = c; log('screen_revert', { screen: lc.name }); commit(); renderAll();
}
// A control changed: store the wanted value (undoable). Bit depth is the project's (it changes the port capacity).
function scrSet(k, v) {
  var lc = scrLc(); if (!lc) return;
  lc.color = lc.color || {};
  if (k === 'bitDepth') { if (!(lc.id in scr.bitWas)) scr.bitWas[lc.id] = P.bitDepth; P.bitDepth = v; }
  lc.color[k] = v;
  log('screen_value', { screen: lc.name, setting: k, value: v });
  commit(); renderAll();
}

// ------------------------------------------------------------------ render
// A small picture of the screen: its cabinets coloured by port.
function scrThumb(lc) {
  var t = scrThumbSvg(lc, allCells(), 'sc-thumb');
  if (!t) return '<p class="hint">No cabinets on this screen yet (Layout tab).</p>';
  return t.svg + '<p class="hint">' + fmt(t.w) + ' × ' + fmt(t.h) + ' px · ' + t.n + ' cabinets</p>';
}
// The picture alone (also the pipeline's screen tiles, app-pipeline.js): {svg, w, h, n} or null when there are no cabinets.
function scrThumbSvg(lc, cellsBy, cls) {
  var cells = [], x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  P.screens.forEach(function (s) { if (s.screenId === lc.id) (cellsBy[s.id] || []).forEach(function (c) { if (!c.hole) { cells.push(c); x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h); } }); });
  if (!cells.length) return null;
  var w = x1 - x0, h = y1 - y0, sw = Math.max(w, h) / 300;
  return { w: w, h: h, n: cells.length, svg: '<svg class="' + cls + '" viewBox="' + x0 + ' ' + y0 + ' ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Cabinets of ' + esc(lc.name) + ' by port">' +
    cells.map(function (c) { return '<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" fill="' + (c.sender == null ? '#888' : portColor(c.sender, c.port)) + '" fill-opacity=".55" stroke="#000" stroke-opacity=".35" stroke-width="' + sw + '"/>'; }).join('') +
    '</svg>' };
}
// The pro look's pictures of what the side column's controls hold (looks/pro-pages.css; hidden in Classic): brightness,
// the gamma curve, the colour temperature on its scale, the gamut's triangle in the CIE xy diagram. Redrawn with the middle,
// so they follow the sliders live.
var SCR_PRIM = { original: [[.695, .303], [.175, .722], [.137, .052]], rec709: [[.64, .33], [.30, .60], [.15, .06]], dcip3: [[.68, .32], [.265, .69], [.15, .06]],
  dcip3d65: [[.68, .32], [.265, .69], [.15, .06]], rec2020: [[.708, .292], [.17, .797], [.131, .046]], ntsc: [[.67, .33], [.21, .71], [.14, .08]] };
function scrVisHtml(val) {
  var b = Math.max(0, Math.min(100, +val.brightness || 0)), g = +val.gamma || 2.2, ct = +val.colorTemp || 6500, gm = val.gamut || 'original';
  var xy = function (q) { return (6 + q[0] * 86).toFixed(1) + ' ' + (58 - q[1] * 60).toFixed(1); };
  var loc = [[.174, .005], [.144, .030], [.091, .133], [.045, .295], [.008, .538], [.014, .750], [.074, .834], [.155, .806], [.230, .754], [.302, .692], [.373, .624], [.444, .555], [.512, .487], [.575, .424], [.627, .372], [.666, .334], [.692, .308], [.735, .265]];
  var crv = '', i; for (i = 0; i <= 24; i++) { var x = i / 24; crv += (i ? 'L' : 'M') + (6 + x * 84).toFixed(1) + ' ' + (54 - Math.pow(x, g) * 48).toFixed(1); }
  var rays = ''; for (i = 0; i < 8; i++) { var a = i * Math.PI / 4; rays += 'M' + (48 + Math.cos(a) * 15).toFixed(1) + ' ' + (30 + Math.sin(a) * 15).toFixed(1) + 'L' + (48 + Math.cos(a) * 21).toFixed(1) + ' ' + (30 + Math.sin(a) * 21).toFixed(1); }
  var pr = SCR_PRIM[gm] || gmPrims(gm), tri = pr ? '<path class="sc-tri" d="M' + pr.map(xy).join('L') + 'Z"/>' : '<text class="sc-na" x="48" y="34">from input</text>';
  var tile = function (t, pic, v, led) { return '<div class="sc-v"><span class="sc-vt">' + t + '</span><span class="sc-vp">' + pic + '</span><b>' + v + '</b><i class="sc-led" style="width:' + led + '%"></i></div>'; };
  return '<div class="sc-vis pro-only" aria-hidden="true">' +
    tile('Brightness', '<svg viewBox="0 0 96 60"><path class="sc-ray" d="' + rays + '" style="opacity:' + (0.25 + b / 133).toFixed(2) + '"/><circle class="sc-sun" cx="48" cy="30" r="10" style="opacity:' + (0.3 + b / 143).toFixed(2) + '"/></svg>', b + '<small> %</small>', b) +
    tile('Gamma', '<svg viewBox="0 0 96 60"><path class="sc-grid" d="M6 54H90M6 6V54M48 6V54M6 30H90"/><path class="sc-lin" d="M6 54L90 6"/><path class="sc-crv" d="' + crv + '"/></svg>', g.toFixed(1), Math.round((g - 1) / 3 * 100)) +
    tile('Colour temp', '<span class="sc-ct"><i style="left:' + Math.max(0, Math.min(100, (ct - 2000) / 80)).toFixed(1) + '%"></i></span>', ct + '<small> K</small>', Math.round((ct - 2000) / 80)) +
    tile('Gamut', '<svg viewBox="0 0 96 60"><path class="sc-loc" d="M' + loc.map(xy).join('L') + 'Z"/>' + tri + '<circle class="sc-wp" cx="' + xy([.3127, .329]).split(' ')[0] + '" cy="' + xy([.3127, .329]).split(' ')[1] + '" r="1.6"/></svg>', esc(scrFmt(scrField('gamut'), gm)), 100) +
    '</div>';
}
function scrFieldHtml(f, lc, val, devs) {
  var sup = devs.filter(function (e) { return scrSupports(e.d, f); }), off = devs.length && !sup.length, h = '';
  var want = scrWanted(lc), set = f.k in want;
  var changed = set && devs.some(function (e) { return e.d.hw && scrSupports(e.d, f) && scrApplied(e.d, lc)[f.k] !== want[f.k]; });
  var id = 'sc_' + f.k, dis = off || scr.busy || scrLocked() ? ' disabled' : '';
  var slider = f.k === 'brightness' || f.k === 'gamma' || f.k === 'colorTemp';
  var chg = changed ? '<span class="chg" title="Different from what was last applied">●</span>' : '';
  if (slider) {   // in the side column: name on top, the slider across the whole column, the value box and ↺ underneath
    // (user: "they can go back to the side column … they just needed to be able to do the entire side column"); the range
    // is in the tooltip and min / max (UI cleanup item 5)
    var range = ' title="' + esc(f.label + ': ' + f.min + ' – ' + f.max + (f.unit === '%' ? ' %' : f.unit === 'K' ? ' K' : '')) + '"';
    h += '<div class="sc-field sc-slide' + (off ? ' off' : '') + '"><div class="sc-head"><label for="' + id + '">' + esc(f.label) + '</label>' + chg + '</div>' +
      '<input type="range" class="sc-range" id="' + id + 'r" data-k="' + f.k + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + val + '"' + dis + range + ' aria-label="' + esc(f.label) + '">' +
      '<div class="sc-val"><input type="number" id="' + id + '" data-k="' + f.k + '" min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + val + '"' + dis + range + ' aria-label="' + esc(f.label) + ' value">' +
      (f.unit ? '<span class="unit">' + (f.unit === '%' ? '%' : f.unit) + '</span>' : '') +
      (f.k === 'gamma' || f.k === 'colorTemp' ? '<button type="button" class="sc-reset" data-screset="' + f.k + '"' + dis + ' title="Back to the default (' + scrFmt(f, f.def) + '), sent now" aria-label="Back to the default">↺</button>' : '') + '</div>';
  } else h += '<div class="sc-field' + (off ? ' off' : '') + '"><label for="' + id + '"><span>' + esc(f.label) +
    (f.k === 'llRx' ? itip('A separate switch, as in NovaLCT: the receiving cards scan with less delay. No layout check.') : '') + '</span>' +
    (changed ? '<span class="chg" title="Different from what was last applied">● not applied</span>' : '') + '</label>';
  if (slider) { /* drawn above */ }
  else if (f.k === 'gamut')
    h += '<select id="' + id + '" data-k="gamut"' + dis + (devs.some(function (e) { return (DRV.caps(e.d).color || {}).gamuts; }) ? ' title="NovaLCT’s buttons: Native = Off, Rec.709 = PAL, NTSC. Made from its default LED colours, Rec.709 and NTSC dim the wall (Rec.709: red 42 %, blue 29 %)."' : '') + '>' + scrGamuts(devs).map(function (g) { return '<option value="' + g[0] + '"' + (g[0] === val ? ' selected' : '') + '>' + esc(g[1]) + '</option>'; }).join('') + '</select>' + lfFieldHtml(lc, devs);
  else if (f.k === 'bitDepth') {
    h += '<select id="' + id + '" data-k="bitDepth"' + dis + '>' + [8, 10, 12].map(function (b) { return '<option value="' + b + '"' + (b === val ? ' selected' : '') + '>' + b + '-bit</option>'; }).join('') + '</select>';
    var cap = SCR.portCapacity(val, P.refresh);
    h += '<div class="sc-note">' + (cap ? fmt(cap) + ' px/port' : 'n/a') + ' at ' + val + '-bit' + itip('Port capacity at ' + P.refresh + ' Hz: ' + [8, 10, 12].map(function (b) { var c = SCR.portCapacity(b, P.refresh); return b + '-bit ' + (c ? fmt(c) + ' px' : 'n/a'); }).join(' · ') + '.\nThe same setting as Layout → Bit depth.') + '</div>';
  } else {
    // LCT's low-latency rule failing: the switch can't go on (greyed, the reason as its tooltip; switching off stays possible)
    var ck = f.k === 'llSender' && devs.some(function (e) { return DRV.caps(e.d).llCheck; }) ? scrLowLatencyCheck(lc) : null, no = ck && !ck.ok && !val;
    h += '<label class="chk"' + (no ? ' title="' + esc(ck.text) + '"' : '') + '><input type="checkbox" id="' + id + '" data-k="' + f.k + '"' + (val ? ' checked' : '') + (no && !dis ? ' disabled' : dis) + '> On</label>';
    if (ck) h += '<p class="sc-check ' + (ck.ok ? 'ok' : 'bad') + '"' + (ck.short ? ' title="' + esc(ck.text) + '"' : '') + '>' + esc(ck.short || ck.text) + '</p>';
  }
  // where it goes is the one "→ processor" line on top (scrTargetHtml); here only why a processor doesn't take it
  var grp = devs.some(function (e) { return SCR_FIELDS.some(function (g) { return g.grp === f.grp && scrSupports(e.d, g); }); });   // none at all: the target line says it
  if (grp && sup.length < devs.length) h += '<div class="sc-why">' + (sup.length ? 'Not on ' + devs.filter(function (e) { return sup.indexOf(e) < 0; }).map(function (e) { return esc(deviceLabel(e.d)); }).join(', ') : 'Not on ' + (devs.length === 1 ? 'this processor' : 'these processors')) + '</div>';
  return h + '</div>';
}
// The one line saying where the controls of this group go (proposal §2.9: one line, never none): "→ VX1000".
function scrTargetHtml(devs, fields) {
  if (!devs.length) return '<div class="sc-target none">No processor drives this screen yet</div>';
  var sup = devs.filter(function (e) { return fields.some(function (f) { return scrSupports(e.d, f); }); });
  if (!sup.length) return '<div class="sc-target none">Not on ' + (devs.length === 1 ? esc(deviceLabel(devs[0].d)) : 'these processors') + '</div>';
  return '<div class="sc-target" title="These settings go to">→ ' + sup.map(function (e) { return esc(deviceLabel(e.d)) + (e.d.hw ? '' : ' <span class="sc-unl">(not linked)</span>'); }).join(', ') + '</div>';
}
function renderScreenTab() {
  var body = $('scBody'); if (!body || ui.tab !== 'screen') { scr.shown = false; return; }
  var lc = scrLc(); if (!lc) { body.innerHTML = '<p class="hint">No screen.</p>'; return; }
  if (!scr.shown) { scr.shown = true; scr.readDone = {}; }   // the tab was just opened: read the processors again
  setTimeout(function () { scrRead(lc); }, 0);   // only links / screens not read since (scr.readDone)
  var val = scrColor(lc), devs = scrDevices(lc), fields = SCR_FIELDS.filter(function (f) { return f.grp === scr.tab; });
  // centre: the screen and, per processor, what was applied
  var h = '<div class="sc-card"><h3>' + esc(lc.name) + '<span class="hint">' + devs.length + ' processor' + (devs.length === 1 ? '' : 's') + ' driving it</span></h3>' + scrThumb(lc) + scrVisHtml(val) + '</div>';
  h += '<div class="sc-card"><h3>Processors<span class="hint">' + ({ iq: 'Image Quality', out: 'Output', lat: 'Latency' })[scr.tab] + '</span>' +
    itip('What each processor has (applied) and, after an arrow, what is wanted here but not applied yet. Read from each processor when this tab opens; “—” = not known. Changes are not stored on a processor until Save.') + '</h3>';
  if (!devs.length) h += '<p class="hint">No cabinets of this screen are wired to a processor yet.</p>';
  else {
    h += '<table class="sc-tbl"><tr><th>Processor</th><th>Link</th>' + fields.map(function (f) { return '<th>' + esc(f.label.replace('Low latency — ', 'LL ')) + '</th>'; }).join('') + '</tr>';
    devs.forEach(function (e) {
      var d = e.d, c = DRV.caps(d), ap = scrApplied(d, lc), want = scrWanted(lc);
      h += '<tr><td><b>' + esc(deviceLabel(d)) + '</b><br><span class="hint">' + esc(procModel(d.model).name) + ' · ' + e.ports.length + ' port' + (e.ports.length === 1 ? '' : 's') + '</span></td>' +
        '<td>' + (d.hw ? (c.simulated ? 'Simulated' : esc(d.hw.host)) + (hw.unsaved && hw.unsaved[d.id] ? '<br><span class="hint">unsaved</span>' : '') : '<span class="hint">not linked</span>') + '</td>';
      var rd = scr.read[scrKey(d, lc)];
      fields.forEach(function (f) {
        var err = scr.errors[d.id + '|' + lc.id + '|' + f.k], rv = rd && rd.values[f.k], note = rd && rd.notes[f.k];
        var src = rd && !rd.error && rv !== undefined && rv !== null && rv === ap[f.k] ? 'Read from the processor' + (rd.mixed.indexOf(f.k) >= 0 ? ' (its ports differ; the first shown)' : '') : 'Applied from here';
        if (!scrSupports(d, f)) {   // can't be set from here yet; what the processor holds is still shown
          h += rv !== undefined && rv !== null ? '<td class="na" title="Read from the processor; Open Nova can’t set it on this processor yet">' + esc(scrFmt(f, rv)) + '</td>' : '<td class="na"' + (note ? ' title="' + esc(note) + '"' : '') + '>n/a</td>';
          return;
        }
        var diff = f.k in want && ap[f.k] !== want[f.k];
        var why = ap[f.k] === undefined ? (rd && rd.error ? 'Couldn’t read: ' + rd.error : note ? 'Not known: ' + note : 'Not read or applied yet') : src;
        h += '<td class="' + (err ? 'err' : diff ? 'diff' : '') + '" title="' + esc(err ? 'Refused: ' + err : diff ? 'Wanted ' + scrFmt(f, want[f.k]) + ', not applied yet (now ' + scrFmt(f, ap[f.k]) + ')' : why) + '">' + esc(scrFmt(f, ap[f.k])) + (diff ? ' → ' + esc(scrFmt(f, want[f.k])) : '') + '</td>';
      });
      h += '</tr>';
    });
    h += '</table>';
  }
  h += '</div>';
  body.innerHTML = h;
  // right: the controls of the chosen group (a live update re-renders only the middle, never the slider in use)
  Array.prototype.forEach.call(document.querySelectorAll('#scSeg [data-sc]'), function (b) { var on = b.dataset.sc === scr.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
  // (Image Quality's "goes out as you move them" is the Live tag on its segment button, index.html)
  if (!scr.keepForm) $('scForm').innerHTML = (scrLocked() ? '<p class="hint">Locked: unlock sending to change these (Settings ▸ Alpha ▸ Allow sending).</p>' : '') + scrTargetHtml(devs, fields) + fields.map(function (f) { return scrFieldHtml(f, lc, val[f.k], devs); }).join('');
  var pending = scrChanges(lc).some(function (p) { return p.linked && p.send.length; });
  $('scApply').disabled = scr.busy || !pending; $('scApply').textContent = scr.busy ? 'Applying…' : 'Apply…';
  $('scRevert').disabled = scr.busy;
  // Image Quality is live (the sliders are the only control): no Apply / Revert there; Output and Latency keep them
  $('scApply').hidden = $('scRevert').hidden = scr.tab === 'iq';
}

function bindScreen() {
  var seg = $('scSeg'); if (!seg) return;
  $('scReadBack').onclick = function () { scrReadBack(); };
  seg.onclick = function (e) { var b = e.target.closest('[data-sc]'); if (!b) return; scr.tab = b.dataset.sc; renderScreenTab(); };
  var num = function (f, x) { var v = +x; if (isNaN(v)) return null; if (f.min != null) v = Math.max(f.min, Math.min(f.max, v)); if (f.step === 0.1) v = Math.round(v * 10) / 10; return v; };
  [$('scForm')].forEach(function (form) {   // all controls live in the right panel
    form.addEventListener('input', function (e) {   // a slider moving (mouse or arrow keys): the box follows, the value goes out live
      var t = e.target, k = t.dataset.k, f = scrField(k); if (!f || t.type !== 'range') return;
      var n = $('sc_' + k); if (n) n.value = t.value;
      var v = num(f, t.value); if (v !== null && !f.keep) scrLive(k, v);
    });
    form.addEventListener('keydown', function (e) {   // arrow keys in a number box: each step goes out (typing waits for Enter)
      var t = e.target, k = t.dataset.k, f = scrField(k); if (!f || f.keep || t.type !== 'number' || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      setTimeout(function () { var v = num(f, t.value); if (v === null) return; var r = $('sc_' + k + 'r'); if (r) r.value = v; scrLive(k, v); }, 0);
    });
    form.addEventListener('click', function (e) {   // Reset: the default value, sent now
      var b = e.target.closest('[data-screset]'); if (!b) return;
      var f = scrField(b.dataset.screset); if (!f) return;
      scrLive(f.k, f.def); scrSet(f.k, f.def); log('screen_reset', { setting: f.k, value: f.def });
    });
    form.addEventListener('change', function (e) {   // released / Enter / left the box / picked from a list: the undo step (+ send if not yet)
      var t = e.target, k = t.dataset.k, f = scrField(k); if (!f) return;
      var v = t.type === 'checkbox' ? t.checked : (k === 'gamut' ? t.value : num(f, t.value));
      if (v === null) return renderScreenTab();
      if (!f.keep) { var lc = scrLc(), sent = lc && scrDevices(lc).every(function (x) { return !x.d.hw || !scrSupports(x.d, f) || scrApplied(x.d, lc)[k] === v; }); if (!sent) scrLive(k, v); }
      scrSet(k, v);
    });
  });
  $('scApply').onclick = scrApply;
  $('scRevert').onclick = scrRevert;
}
