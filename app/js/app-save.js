// app-save.js - the commit model (design phase 4): how a layout reaches the processors and when it is stored.
//   - Send: explicit, per processor (header Send ▾ or the Hardware card) for processors whose own tool sends on demand
//     (NovaLCT-protocol ones: caps.applyMode 'send'). Send never stores anything in flash.
//   - Live apply: processors whose own tool applies every edit as it happens (Unico, COEX: applyMode 'live') get each
//     change of their layout automatically, a moment after the edit (only what's linked, not simulated, and only
//     when its own layout changed). Switch off per processor in its Hardware card.
//   - Save: the ONLY path that stores in flash (LCT's Save sequence, Unico's cabinet/solid). After a Send or a live
//     apply the processor is "unsaved": a banner lists them with a Save button. Save always asks first.
//   - Compare: project vs hardware for one processor (placed vs detected per port; Unico also positions).
// Owns: LIVE_KEY, LIVE_STALE, liveSlot, liveKey, liveStore, liveSet, liveLoad, UNSAVED_KEY, hwUnsavedStore, hwUnsaved, hwMarkUnsaved, hwSaveDevices, liveApplySchedule, liveApplyNow, hwCompare, renderUnsaved,
// openSendMenu, bindSave; hw.unsaved, hw.applied, hw.applying.
// Depends on: app-core (P, ui, $, esc, log, toast), app-hardware (hw, hwSend, hwSendModel, hwPairs, hwPortCells,
// renderHwCard), drv-core (DRV), app-context-menu (openMenu), app-processors (cardsOfDevice, portLabel in
// app-capacity), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var UNSAVED_KEY = 'opennova.unsaved';   // kept in this browser so a reload still shows the reminder
function hwUnsavedStore() { try { localStorage.setItem(UNSAVED_KEY, JSON.stringify(hw.unsaved || {})); } catch (e) { /* storage unavailable */ } }
function hwUnsaved() { return (P.devices || []).filter(function (d) { return d.hw && hw.unsaved && hw.unsaved[d.id]; }); }
function hwMarkUnsaved(d, why) {
  if (!DRV.caps(d).save) return;
  hw.unsaved = hw.unsaved || {};
  hw.unsaved[d.id] = { at: Date.now(), why: why };
  hwUnsavedStore(); renderUnsaved();
}

// ------------------------------------------------------------------ Save
function hwSaveDevices(list) {
  list = list.filter(function (d) { return d.hw && DRV.caps(d).save; });
  if (!list.length) return toast('Nothing to save: no linked processor');
  if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running');
  var names = list.map(function (d) { return deviceLabel(d); }).join(', ');
  if (!confirm('Save to ' + names + '?\n\nThis stores the current settings in the processor' + (list.length > 1 ? 's’' : '’s') +
      ' flash (and the receiving cards’), so they stay after a power cycle — and a power cycle can no longer undo a mistake.')) return;
  if (!hwBegin('save')) return; renderUnsaved();
  return list.reduce(function (p, d) {
    return p.then(function () {
      return DRV.of(d).save(d).then(function (r) {
        log('hw_save', { processor: d.name, ok: r.ok, error: r.error, frames: r.frames });
        if (r.ok && hw.unsaved) { delete hw.unsaved[d.id]; hwUnsavedStore(); }
        toast(deviceLabel(d) + ': ' + (r.text || (r.ok ? 'saved' : 'save failed: ' + r.error)));
      }, function (e) { hw.helper = false; toast('Helper not reachable: ' + e.message); });
    });
  }, Promise.resolve()).then(function () { hwEnd('save'); renderUnsaved(); var d = devSelected && devSelected(); if (d) renderHwCard(d); });
}
// The header's Save: all processors of the project, or one of them (● = has changes not saved yet).
function openSaveMenu(btn) {
  var linked = (P.devices || []).filter(function (d) { return d.hw && DRV.caps(d).save; }), r = btn.getBoundingClientRect(), items = [{ header: 'Save to the processors’ flash' }];
  if (!linked.length) items.push({ label: 'No processor linked — Processors ▸ Hardware', disabled: true });
  if (linked.length > 1) items.push({ label: 'Save all processors (' + linked.length + ')', act: function () { hwSaveDevices(linked); } });
  linked.forEach(function (d) { items.push({ label: 'Save ' + deviceLabel(d) + (hw.unsaved && hw.unsaved[d.id] ? '  ●' : ''), act: function () { hwSaveDevices([d]); } }); });
  openMenu(r.left, r.bottom + 4, items);
}

// ------------------------------------------------------------------ live apply
var LIVE_APPLY_MS = 1200;
function liveApplySchedule() {
  if (!(P.devices || []).some(function (d) { return d.hw && d.hw.kind !== 'offline' && DRV.caps(d).applyMode === 'live'; })) return;
  clearTimeout(hw.liveTimer);
  hw.liveTimer = setTimeout(liveApplyNow, LIVE_APPLY_MS);
}
// What was last applied to each processor, as a short fingerprint of its layout + port / card backup (the same for a
// manual Send and for live apply). Kept per link in localStorage, so a reload carries on from what the processor has
// instead of silently skipping the first edit. LIVE_STALE = the processor's layout is known to differ (resend on the
// next edit); no entry = start from what's there (just linked / live apply just switched on).
var LIVE_KEY = 'opennova.liveApplied', LIVE_STALE = 'stale';
function liveSlot(d) { return d.id + '@' + d.hw.host + ':' + d.hw.port; }
function liveKey(d) {
  var k; try { k = JSON.stringify([hwSendModel(d), hwPairs(d), P.backup && P.backup.mode === 'card' ? (P.backup.cards || []).filter(function (q) { return cardsOfDevice(d).indexOf(q.ms) >= 0; }).map(function (q) { return q.ms + '>' + q.bs; }).join() || null : null]); } catch (e) { return null; }
  var h = 2166136261; for (var i = 0; i < k.length; i++) { h ^= k.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }   // FNV-1a
  return h.toString(36) + '.' + k.length;
}
function liveStore() {
  var all = {}; try { all = JSON.parse(localStorage.getItem(LIVE_KEY) || '{}') || {}; } catch (e) { /* storage unavailable */ }
  (P.devices || []).forEach(function (d) { if (!d.hw) return; if (hw.applied[d.id] === undefined) delete all[liveSlot(d)]; else all[liveSlot(d)] = hw.applied[d.id]; });
  try { localStorage.setItem(LIVE_KEY, JSON.stringify(all)); } catch (e) { /* storage unavailable */ }
}
function liveSet(d, v) { if (v === undefined) delete hw.applied[d.id]; else hw.applied[d.id] = v; if (d.hw) liveStore(); }
function liveApplyNow() {
  hw.applied = hw.applied || {};
  if (hw.busy) { liveApplySchedule(); return; }     // a Send / Save / file send is running: after it
  (P.devices || []).forEach(function (d) {
    if (!d.hw || d.hw.kind === 'offline' || d.hw.liveApply === false || DRV.caps(d).applyMode !== 'live' || procUnset(d)) return;   // "Pick a model": nothing is sent
    if (hw.applying && hw.applying[d.id]) { liveApplySchedule(); return; }   // one at a time; try again shortly
    var key = liveKey(d); if (!key) return;   // layout + port / card backup
    if (hw.applied[d.id] === undefined) { liveSet(d, key); return; }  // first look after linking: nothing to apply yet
    if (hw.applied[d.id] === key) return;
    var pairs = hwPairs(d); if (pairs.cross.length) return;
    var drv = DRV.of(d), plan = drv.planSend(d, { dry: false, pairs: pairs });
    if (!plan.ok) { log('live_apply', { processor: d.name, skipped: plan.error }); return; }
    // what a Send would ask (e.g. clearing the whole screen when its last section is gone) is asked here too
    if (plan.confirm && !confirm(plan.confirm)) {
      d.hw.liveApply = false; commit(); log('live_apply', { processor: d.name, declined: plan.confirm });
      toast(deviceLabel(d) + ': not applied — live apply paused for it (turn it back on in Processors ▸ Hardware)');
      var s0 = devSelected && devSelected(); if (s0) renderHwCard(s0); return;
    }
    hw.applying = hw.applying || {}; hw.applying[d.id] = true; renderUnsaved();
    drv.send(d, plan, false).then(function (r) {
      log('live_apply', { processor: d.name, ok: r.ok, panels: plan.count, error: r.error, warnings: r.warnings });
      if (r.ok) { liveSet(d, key); hwMarkUnsaved(d, 'edits applied live'); }
      else { d.hw.liveApply = false; commit(); toast(deviceLabel(d) + ': applying the edit failed (' + (r.error || 'read-back mismatch') + ') — live apply paused for it'); }
    }, function (e) { hw.helper = false; log('live_apply', { processor: d.name, error: e.message }); })
      .then(function () { hw.applying[d.id] = false; renderUnsaved(); var s = devSelected && devSelected(); if (s) renderHwCard(s); });
  });
}

// ------------------------------------------------------------------ compare project vs hardware
function hwCompare(d) {
  if (!d || !d.hw) return;
  var rows = [], cards = cardsOfDevice(d), placed = hwPortCells(), drv = DRV.of(d);
  var placedOf = function (ci, p) { return placed[cards[ci] + ':' + p] || []; };
  var done = function (title) {
    $('cmpTitle').textContent = title;
    $('cmpBody').innerHTML = rows.length ? '<table class="cmp"><tr><th>Port</th><th>Project</th><th>Processor</th><th></th></tr>' + rows.map(function (r) {
      return '<tr class="' + (r.ok ? 'ok' : 'bad') + '"><td>' + esc(r.port) + '</td><td>' + esc(r.a) + '</td><td>' + esc(r.b) + '</td><td>' + (r.ok ? '✓' : '⚠ ' + esc(r.why || '')) + '</td></tr>';
    }).join('') + '</table>' : '<p class="hint">Nothing placed and nothing on the processor.</p>';
    $('cmpDlg').hidden = false;
    log('hw_compare', { processor: d.name, ports: rows.length, differences: rows.filter(function (r) { return !r.ok; }).length });
  };
  var addPorts = function (got) {   // got[ci][port] = [{w,h,x?,y?}]
    cards.forEach(function (card, ci) {
      var ports = {}; Object.keys(got[ci] || {}).forEach(function (p) { ports[p] = 1; });
      Object.keys(placed).forEach(function (k) { if (+k.split(':')[0] === card) ports[k.split(':')[1]] = 1; });
      Object.keys(ports).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
        var a = placedOf(ci, p), b = (got[ci] || {})[p] || [], why = '';
        if (a.length !== b.length) why = (b.length > a.length ? b.length - a.length + ' more on the processor' : a.length - b.length + ' missing on the processor');
        else a.forEach(function (c, i) {
          var x = b[i]; if (why || !x) return;
          if (x.w !== c.width || x.h !== c.height) why = 'cable position ' + (i + 1) + ' is ' + x.w + '×' + x.h + ' there';
          else if (x.x != null && (x.x !== c.x || x.y !== c.y)) why = 'cable position ' + (i + 1) + ' sits at ' + x.x + ',' + x.y + ' there';
        });
        rows.push({ port: portLabel(card, p), a: a.length + ' cabinets', b: b.length + ' cabinets', ok: !why, why: why });
      });
    });
  };
  if (drv.readLayout) {
    return drv.readLayout(d).then(function (r) {
      if (!r.ok) return toast('Compare: ' + r.error);
      var got = cardsOfDevice(d).map(function () { return {}; });   // per output card (Unico: one; COEX: card in slot order)
      r.cabinets.sort(function (a, b) { return (a.card || 0) - (b.card || 0) || a.port - b.port || a.index - b.index; })
        .forEach(function (c) { var g = got[c.card || 0] || (got[c.card || 0] = {}); (g[c.port] || (g[c.port] = [])).push({ w: c.w, h: c.h, x: c.x, y: c.y }); });
      addPorts(got);
      done('Project vs ' + deviceLabel(d) + ' (what the processor has placed)');
    }, function (e) { toast('Helper not reachable: ' + e.message); });
  }
  var lv = hw.live[d.id];
  if (!lv) return toast('Detect first (Hardware card ▸ Detect now), then compare');
  addPorts(lv.cards.map(function (c) { return c.ports; }));
  done('Project vs ' + deviceLabel(d) + ' (cabinets the processor detects)');
}

// ------------------------------------------------------------------ header + banner
function renderUnsaved() {
  var bar = $('unsavedBar'); if (!bar) return;
  var list = hwUnsaved(), applying = hw.applying && Object.keys(hw.applying).some(function (k) { return hw.applying[k]; });
  bar.hidden = !list.length && !applying;
  $('unsavedText').textContent = applying ? 'Applying edits to the processor…' :
    'Not saved on ' + list.map(function (d) { return deviceLabel(d); }).join(', ') + ' — a power cycle loses the live changes.';   // proposal §5 wording; stays visible on every tab (§2.3)
  $('btnSaveBar').disabled = !!hw.busy || !list.length;
  $('btnSaveHw').classList.toggle('warn', list.length > 0);
  if (typeof renderPipe === 'function') renderPipe();   // the Save tile (app-pipeline.js)
}
function openSendMenu(btn) {
  var linked = (P.devices || []).filter(function (d) { return d.hw; }), r = btn.getBoundingClientRect(), items = [{ header: 'Send layout' }];
  if (!linked.length) items.push({ label: 'No processor linked — Processors ▸ Hardware', disabled: true });
  if (linked.length > 1) items.push({ label: 'Send to all processors (' + linked.length + ')', act: hwSendAll });
  linked.forEach(function (d) {
    var live = DRV.caps(d).applyMode === 'live' && d.hw.kind !== 'offline' && d.hw.liveApply !== false;
    items.push({ label: (live ? 'Send now to ' : 'Send to ') + deviceLabel(d) + (live ? ' (edits apply live)' : ''), act: function () { hwSend(d, false); } });
    items.push({ label: 'Compare with ' + deviceLabel(d), act: function () { hwCompare(d); } });
  });
  openMenu(r.left, r.bottom + 4, items);
}
// what live apply / Send last put on each linked processor of this project (survives a reload; again after a project switch)
function liveLoad() {
  hw.applied = {};
  try {
    var la = JSON.parse(localStorage.getItem(LIVE_KEY) || '{}') || {};
    (P.devices || []).forEach(function (d) { if (d.hw && la[liveSlot(d)] !== undefined) hw.applied[d.id] = la[liveSlot(d)]; });
  } catch (e) { /* storage unavailable */ }
}
function bindSave() {
  hw.unsaved = {}; hw.applying = {};
  liveLoad();
  try { hw.unsaved = JSON.parse(localStorage.getItem(UNSAVED_KEY) || '{}') || {}; } catch (e) { /* storage unavailable */ }
  $('btnSendHdr').onclick = function (e) { e.stopPropagation(); openSendMenu(this); };
  $('btnSaveHw').onclick = function (e) { e.stopPropagation(); openSaveMenu(this); };   // all, or one processor
  $('btnSaveBar').onclick = function () { hwSaveDevices(hwUnsaved()); };
  $('cmpClose').onclick = function () { $('cmpDlg').hidden = true; };
  renderUnsaved();
}
