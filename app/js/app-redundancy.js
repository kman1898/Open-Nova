// app-redundancy.js - the Backup tab (design phase 8; Unico / VMP "Backup"): the backup plan per processor and Verify.
//   - Centre: one card per processor — its role (primary ports / backup card), the pairs it holds, problems, and
//     Verify (a toggle: the processor shows the picture through its backup ports to look at the wall; a bar on every tab
//     while it is on). Verify is live only, never saved.
//   - Right: the backup plan itself (app-backup.js's card, moved here from Layout; Layout keeps a one-line summary).
//   - Send backup (NovaLCT-protocol processors, like NovaLCT's Redundancy page Send; docs\APP_SEND.md "Redundancy Send"):
//     the port backup alone, per processor or to all; never followed by a Save (the processor is marked unsaved, and the
//     Save writes NovaLCT's REDU pairs record first — rdReduPending). With no pairs it clears them as NovaLCT's Delete.
//     The layout Send keeps the backup ports in step by itself (NovaLCT's layout Send does the same copy).
//     Unico / COEX processors take the pairs with the layout (applied live, as Unico and VMP apply them on every change).
//   - The guard is the plan's own check: a backup port or card that already has panels of its own is an error (VMP wipes
//     them silently).
// Owns: rd, rdDeviceHtml, rdVerify, rdVerifyBar, rdRead, rdAdopt, renderRedundancy, bindRedundancy,
// RD_REDU_KEY, RD_SENT_KEY, rdStore, rdSlot, rdReduPending, rdReduSet, rdSentGet, rdSentSet, rdBackupShown, rdLinkPairs, rdBackupPlan,
// rdBackupConfirm, rdSendBackup, rdSendBackupAll.
// Depends on: app-core (P, ui, $, esc, toast), app-log (log), app-backup (bkRead, bkPortIssues, bkCardIssues),
// app-capacity (portLabel, portUsage), app-geometry (allCells), app-processors (cardsOfDevice, deviceLabel, procModel),
// app-hardware (hw, hwPairs, hwBegin, hwEnd, hwWhere, HW_BUSY_WORDS), app-save (hwMarkUnsaved),
// drv-core (DRV), app-render (renderAll), app-tips (itip), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var rd = { state: {}, busy: {}, msg: {}, verified: {}, read: {}, roles: {} };   // roles[devId] = NovaLCT device-backup role per sending card (read)   // read[devId] = pairs read from the processor [{ms, mp, bs, bp}] (project card numbers)   // verified[devId] = when Verify backup last succeeded (pre-show check)   // state[devId] = 'backup' | 'primary' while a verify is on; msg[devId] = {level, text}

function rdDeviceHtml(d, b) {
  var cards = cardsOfDevice(d), c = DRV.caps(d), v = c.verify || {}, st = rd.state[d.id], busy = rd.busy[d.id], m = rd.msg[d.id];
  var mine = function (i) { return cards.indexOf(i) >= 0; };
  var pairs = b.mode === 'port' ? b.pairs.filter(function (q) { return mine(q.ms) || mine(q.bs); }) : [];
  var cps = b.mode === 'card' ? b.cards.filter(function (q) { return mine(q.ms) || mine(q.bs); }) : [];
  var isBackupCard = cps.some(function (q) { return mine(q.bs); }), isPrimary = pairs.length || cps.some(function (q) { return mine(q.ms); });
  var h = '<div class="rd-dev"><h3>' + esc(deviceLabel(d)) + '<span class="hint">' + esc(procModel(d.model).name) + ' · ' + (procModel(d.model).kind === 'fixed' ? '' : cards.length + (procModel(d.model).kind === 'chassis' ? ' sending card' : ' card') + (cards.length === 1 ? '' : 's') + ' · ') +
    (d.hw ? (c.simulated ? 'simulated' : esc(d.hw.host)) : 'not linked') + '</span>' +
    (pairs.length ? '<span class="rd-role p">Port backup</span>' : '') + (cps.some(function (q) { return mine(q.ms); }) ? '<span class="rd-role p">' + (procModel(d.model).kind === 'fixed' ? 'Primary processor' : 'Primary card') + '</span>' : '') +
    (isBackupCard ? '<span class="rd-role b">' + (procModel(d.model).kind === 'fixed' ? 'Backup processor' : 'Backup card') + '</span>' : '') + (!isPrimary && !isBackupCard ? '<span class="rd-role">No backup</span>' : '') +
    (d.hw && pairs.length && c.applyMode === 'live' && !rdBackupShown(d) ? itip('The pairs go with the layout (applied live, as ' + (DRV.familyOf(d) === 'coex' ? 'VMP' : 'Unico') + ' does).') : '') + '</h3>';
  // pair chips: "P1 → P11" on a one-card processor (its name is the card's heading), full labels otherwise
  var pl = function (s, p) { return cards.length === 1 && s === cards[0] ? 'P' + (p + 1) : portLabel(s, p); };
  if (pairs.length) h += '<div class="rd-pairs">' + pairs.map(function (q) { return '<span class="rd-pair">' + esc(pl(q.ms, q.mp)) + ' → ' + esc(pl(q.bs, q.bp)) + '</span>'; }).join('') + '</div>';
  if (cps.length) h += '<div class="rd-pairs">' + cps.map(function (q) { return '<span class="rd-pair">' + esc(cardName(q.ms)) + ' → ' + esc(cardName(q.bs, true)) + '</span>'; }).join('') + '</div>';
  if (pairs.some(function (q) { return mine(q.ms) !== mine(q.bs); })) h += '<p class="rd-msg err">Some pairs reach another processor: a processor can only back up its own ports.</p>';
  if (d.hw && (pairs.length || cps.length || rd.state[d.id])) {   // verify on: the way back stays reachable even with no pairs left
    // Verify is one toggle (UI cleanup item 9, as Unico's Verify Backup): pressed = the picture through the backup ports
    // only, press again = back to normal; while it is on the bar above every tab says so (rdVerifyBar). Unico also
    // verifies the primary ports alone: a second toggle there.
    var dis = busy ? ' disabled' : '';
    h += '<div class="rd-act">' +
      (v.backup || st === 'backup' ? '<button data-rd="verify" data-dev="' + d.id + '" aria-pressed="' + (st === 'backup') + '"' + (st === 'backup' ? ' class="on"' : '') + dis + ' title="' +
        (st === 'backup' ? 'On: the picture goes through the backup ports only. Press to go back to normal (primary with automatic take-over).' : 'Show the picture through the backup ports only: unplug nothing, just look at the wall. Press again to go back to normal.') + '">Verify</button>' : '') +
      (v.primary || st === 'primary' ? '<button data-rd="vprimary" data-dev="' + d.id + '" aria-pressed="' + (st === 'primary') + '"' + (st === 'primary' ? ' class="on"' : '') + dis + ' title="' +
        (st === 'primary' ? 'On: primary ports only. Press to go back to normal.' : 'Primary ports only. Press again to go back to normal.') + '">Verify primary</button>' : '') +
      (v.backup || v.primary || st ? '' : '<span class="hint">Verify isn’t available for this processor yet.</span>') +
      (st ? '<span class="rd-role b">' + (st === 'backup' ? 'On backup ports' : 'On primary ports') + '</span>' : '') +
      (cps.length && !pairs.length && v.backup && DRV.familyOf(d) === 'lct' ? itip(bkCardWord() + ' backup: verify works on port pairs; to test a backup card, unplug the primary card’s cable and watch the wall.') : '') + '</div>';
  } else if (pairs.length || cps.length) h += '<p class="hint">Not linked — link it (Device ▸ Hardware) to verify.</p>';
  if (rdBackupShown(d)) {   // NovaLCT's redundancy Send: per processor; with nothing to send it clears what the processor holds
    var pend = rdReduPending(d) != null;
    h += '<div class="rd-act" style="margin-top:6px"><button data-rd="send" data-dev="' + d.id + '"' + (busy || hw.busy ? ' disabled' : '') +
      ' title="' + esc(pairs.length ? 'Send these ' + pairs.length + ' pairs to the processor (the backup ports get their primary ports’ layout), like NovaLCT’s Redundancy Send. The layout isn’t sent; nothing is saved.' :
        'No pairs: removes the port backup the processor holds, like NovaLCT’s Delete. Nothing is saved.') + '">' + (hw.busy === 'send' && rd.busy[d.id] ? 'Sending…' : pairs.length ? 'Send backup' : 'Clear backup on processor') + '</button>' +
      (pend ? '<span class="rd-msg warn" title="Save stores the pairs (and everything else) in the processor’s flash">Backup sent — not saved yet</span>' : '') + '</div>';
  }
  if (d.hw && DRV.of(d).readBackup) {
    var got = rd.read[d.id];
    h += '<div class="rd-act" style="margin-top:6px"><button class="mini" data-rd="read" data-dev="' + d.id + '" title="Read the port backup pairs the processor has now (read-only)">Read from processor</button>';
    if (got) {
      var key = function (q) { return q.ms + ':' + q.mp + '>' + q.bs + ':' + q.bp; }, a = got.map(key).sort().join(','), b = pairs.map(key).sort().join(',');
      h += a === b ? '<span class="rd-msg ok">same as the plan</span>' : '<span class="rd-msg warn">differs from the plan</span><button class="mini" data-rd="adopt" data-dev="' + d.id + '" title="Replace this processor’s pairs in the plan with the ones read">Use these</button>';
      h += '</div><div class="rd-pairs">' + (got.length ? got.map(function (q) { return '<span class="rd-pair">' + esc(portLabel(q.ms, q.mp)) + ' → ' + esc(portLabel(q.bs, q.bp)) + '</span>'; }).join('') : '<span class="hint">The processor has no port backup.</span>') + '</div>';
      var ro = (rd.roles[d.id] || []).filter(function (x) { return x.role !== 'none' && x.role !== 'fresh'; });
      if (ro.length) h += '<p class="hint">Processor backup: ' + ro.map(function (x) {
        if (x.master != null) return 'this processor is the ' + esc(x.role) + ' (master ' + esc(x.master) + ', backup ' + esc((x.backups || []).join(', ') || '—') + ')';   // Unico
        return esc(cardName(cardsOfDevice(d)[x.sender] != null ? cardsOfDevice(d)[x.sender] : x.sender)) + ' = ' + esc(x.role);   // NovaLCT, per sending card
      }).join(', ') + '</p>';
    } else h += '</div>';
  }
  if (m) h += '<p class="rd-msg ' + esc(m.level) + '">' + esc(m.text) + '</p>';
  return h + '</div>';
}

// Verify on one processor: 'backup' | 'primary' | 'normal'.
function rdVerify(d, mode) {
  var x = DRV.of(d); if (!x.verifyBackup) return;
  if (mode !== 'normal' && !confirm('Show the picture through the ' + mode + ' ports only on ' + deviceLabel(d) + '?\n\nThe wall changes now: where a ' + mode + ' cable is missing it goes dark. Press Verify again (or End verify in the bar) to switch back; nothing is saved.')) return;
  rd.busy[d.id] = true; renderRedundancy();
  x.verifyBackup(d, mode).then(function (r) { return r; }, function (e) { return { ok: false, error: 'helper: ' + e.message }; }).then(function (r) {
    rd.busy[d.id] = false;
    if (r.ok) {
      if (mode === 'normal') delete rd.state[d.id]; else rd.state[d.id] = mode;
      if (mode === 'backup') rd.verified[d.id] = Date.now();
      rd.msg[d.id] = r.cross && mode === 'backup' ? { level: 'warn', text: r.text + '. These pairs cross cards: NovaLCT only verifies pairs on one card, so check the wall — if nothing changed, this card doesn’t verify across cards.' } : { level: 'ok', text: r.text };
    } else rd.msg[d.id] = { level: 'err', text: (r.unsupported ? '' : 'Verify failed: ') + r.error };
    log('backup_verify', { processor: deviceLabel(d), mode: mode, ok: !!r.ok, error: r.error });
    toast(r.ok ? deviceLabel(d) + ': ' + r.text : '⚠ ' + deviceLabel(d) + ': ' + r.error);
    renderRedundancy();
  });
}

// Read the processor's pairs (its own card numbers → the project's) to compare with the plan.
function rdRead(d) {
  var cards = cardsOfDevice(d);
  DRV.of(d).readBackup(d).then(function (r) { return r; }, function (e) { return { ok: false, error: 'helper: ' + e.message }; }).then(function (r) {
    if (!r.ok) { rd.msg[d.id] = { level: 'err', text: 'Reading the backup failed: ' + r.error }; delete rd.read[d.id]; }
    // [card, port, backupPort] on one card (Unico / COEX) or [card, port, backupCard, backupPort] (NovaLCT: pairs may cross cards)
    else rd.read[d.id] = r.pairs.filter(function (q) { return cards[q[0]] != null && (q.length < 4 || cards[q[2]] != null); })
      .map(function (q) { return q.length >= 4 ? { ms: cards[q[0]], mp: q[1], bs: cards[q[2]], bp: q[3] } : { ms: cards[q[0]], mp: q[1], bs: cards[q[0]], bp: q[2] }; });
    if (r.ok) rd.roles[d.id] = r.roles || null;
    log('backup_read', { processor: deviceLabel(d), ok: !!r.ok, pairs: r.ok ? r.pairs.length : undefined, error: r.error });
    renderRedundancy();
  });
}
// The plan takes the pairs read from processor d (its other processors' pairs stay).
function rdAdopt(d) {
  var got = rd.read[d.id], cards = cardsOfDevice(d); if (!got) return;
  var b = P.backup || (P.backup = { mode: 'port', pairs: [], cards: [] });
  b.mode = 'port'; b.pairs = (b.pairs || []).filter(function (q) { return cards.indexOf(q.ms) < 0; }).concat(got.map(function (q) { return { ms: q.ms, mp: q.mp, bs: q.bs, bp: q.bp }; }));
  log('backup_adopt', { processor: deviceLabel(d), pairs: got.length }); commit(); renderAll();
  toast(deviceLabel(d) + ': the plan now has the processor’s ' + got.length + ' pair(s)');
}
// ------------------------------------------------------------------ Send backup (NovaLCT's redundancy Send)
// Kept in this browser per link (hardware state, not project data): RD_REDU_KEY = pairs of a backup Send not saved yet
// (as NovaLCT, whose Save then writes the REDU record first; a layout Send's commit too); RD_SENT_KEY = the pairs
// last sent (what a clear has to delete). Pairs as on the link: [{ps, pp, bs, bp}], cards 0… of the processor.
var RD_REDU_KEY = 'opennova.reduPending', RD_SENT_KEY = 'opennova.backupSent';
function rdStore(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) || '{}') || {};
    localStorage.setItem(key, JSON.stringify(val));
  } catch (e) { /* storage unavailable */ }
  return {};
}
function rdSlot(d) { return d.id + '@' + d.hw.host + ':' + d.hw.port; }
function rdReduPending(d) { if (!d || !d.hw) return null; var v = rdStore(RD_REDU_KEY)[rdSlot(d)]; return v === undefined ? null : v; }
function rdReduSet(d, pairs) { var a = rdStore(RD_REDU_KEY); if (pairs == null) delete a[rdSlot(d)]; else a[rdSlot(d)] = pairs; rdStore(RD_REDU_KEY, a); }
function rdSentGet(d) { var v = d && d.hw ? rdStore(RD_SENT_KEY)[rdSlot(d)] : undefined; return v === undefined ? null : v; }
function rdSentSet(d, pairs) { var a = rdStore(RD_SENT_KEY); a[rdSlot(d)] = pairs; rdStore(RD_SENT_KEY, a); }
// Send backup is offered for a linked processor that takes it (NovaLCT protocol) and has pairs in the plan, or pairs it
// holds that Open Nova knows of (sent, read, or a Send not saved yet): those are what a clear removes.
function rdBackupShown(d) {
  if (!d.hw || !DRV.caps(d).backupSend) return false;
  return !!(hwPairs(d).length || (rdSentGet(d) || []).length || (rd.read[d.id] || []).length || rdReduPending(d) != null);
}
// project-numbered pairs ({ms, mp, bs, bp}) -> the processor's own card numbers
function rdLinkPairs(d, list) {
  var cards = cardsOfDevice(d);
  return (list || []).filter(function (q) { return cards.indexOf(q.ms) >= 0 && cards.indexOf(q.bs) >= 0; })
    .map(function (q) { return { ps: cards.indexOf(q.ms), pp: q.mp, bs: cards.indexOf(q.bs), bp: q.bp }; });
}
// The plan for one processor, or {error}. The plan's rules first (bkPortIssues), so nothing goes out half-checked.
function rdBackupPlan(d) {
  var x = DRV.of(d); if (!d.hw || !x.planBackup) return { error: 'this processor takes its backup with the layout' };
  if (procUnset(d)) return { error: 'pick its model first (Device ▸ Processor properties)' };
  var pairs = hwPairs(d);
  if (pairs.cross.length) return { error: 'pairs reach another processor (' + pairs.cross.slice(0, 2).join(', ') + ')' };
  if (bkRead().mode === 'port') { var is = bkPortIssues(portUsage(allCells())); if (is.err.length) return { error: is.err[0] }; }
  var prev = pairs.length ? null : rdSentGet(d) || (rd.read[d.id] ? rdLinkPairs(d, rd.read[d.id]) : null);
  var p = x.planBackup(d, { pairs: pairs, prev: prev });
  if (!p.ok) return { error: p.error };
  p.list = pairs; p.prev = prev; return p;
}
function rdBackupConfirm(d, p) {
  var cards = cardsOfDevice(d), lab = function (q) { return portLabel(cards[q.ps], q.pp) + ' → ' + portLabel(cards[q.bs], q.bp); };
  var some = function (l) { return l.slice(0, 12).map(function (q) { return '  ' + lab(q); }).join('\n') + (l.length > 12 ? '\n  … and ' + (l.length - 12) + ' more' : ''); };
  if (p.list.length) return 'Send the port backup to ' + deviceLabel(d) + ' (' + hwWhere(d.hw.host, d.hw.port) + ')?\n\n' + p.list.length + ' pair' + (p.list.length === 1 ? '' : 's') + ':\n' + some(p.list) +
    '\n\nAs NovaLCT’s Redundancy Send: each backup port gets its primary port’s layout, then the pair table. The layout itself isn’t sent. Nothing is saved: press Save to keep it after a power cycle.';
  return 'Clear the port backup on ' + deviceLabel(d) + ' (' + hwWhere(d.hw.host, d.hw.port) + ')?\n\n' +
    (p.prev ? (p.prev.length ? 'It removes ' + p.prev.length + ' pair' + (p.prev.length === 1 ? '' : 's') + ':\n' + some(p.prev) : 'Open Nova knows of no pairs on it; the pair table is emptied.') : 'The pairs stored on the processor are read and removed.') +
    '\n\nAs NovaLCT’s Delete: the backup ports are switched off and the pair table emptied. Nothing is saved: press Save to keep it.';
}
// opts.plan / opts.noConfirm: rdSendBackupAll has planned and asked once for all.
function rdSendBackup(d, opts) {
  opts = opts || {};
  var p = opts.plan || rdBackupPlan(d);
  if (p.error) { toast('Send backup: ' + p.error); return Promise.resolve(false); }
  if (hw.busy) { toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running'); return Promise.resolve(false); }
  if (!opts.noConfirm && !confirm(rdBackupConfirm(d, p))) return Promise.resolve(false);
  if (!hwBegin('send')) return Promise.resolve(false);
  rd.busy[d.id] = true; renderRedundancy();
  return DRV.of(d).send(d, p, false).then(function (r) { return r; }, function (e) { hw.helper = false; return { ok: false, error: 'helper: ' + e.message }; }).then(function (r) {
    rd.busy[d.id] = false; hwEnd('send');
    log('backup_send', { processor: deviceLabel(d), kind: p.kind, pairs: p.list.length, cleared: p.prev ? p.prev.length : null, ok: !!r.ok, frames: r.frames, error: r.error, log: r.log });
    if (r.ok) {
      rdReduSet(d, p.list); rdSentSet(d, p.list); delete rd.read[d.id];
      if (typeof hwMarkUnsaved === 'function') hwMarkUnsaved(d, 'backup sent');
      rd.msg[d.id] = { level: 'ok', text: (p.list.length ? 'Backup sent: ' + p.list.length + ' pair' + (p.list.length === 1 ? '' : 's') : 'Backup cleared') + ' (' + r.frames + ' frames). Press Save to keep it.' };
    } else rd.msg[d.id] = { level: 'err', text: 'Send backup failed: ' + r.error };
    toast(deviceLabel(d) + ': ' + rd.msg[d.id].text);
    renderRedundancy();
    return !!r.ok;
  });
}
// Every linked processor that takes a backup Send: all planned first (one that can't stops it before anything goes out),
// one confirmation, then one after another. Never followed by a Save.
function rdSendBackupAll() {
  var list = (typeof olShownDevices === 'function' ? olShownDevices() : P.devices).filter(rdBackupShown);   // online: the connected ones (app-online.js)
  if (!list.length) return toast('No linked processor takes a backup Send');
  if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running');
  var plans = list.map(function (d) { return { d: d, p: rdBackupPlan(d) }; }), bad = plans.filter(function (x) { return x.p.error; });
  if (bad.length) return toast('Send backup to all stopped — nothing sent: ' + bad.map(function (x) { return deviceLabel(x.d) + ': ' + x.p.error; }).join(' · '));
  if (!confirm('Send the port backup to all ' + plans.length + ' processors?\n\n' + plans.map(function (x) {
    return '• ' + deviceLabel(x.d) + ' (' + hwWhere(x.d.hw.host, x.d.hw.port) + '): ' + (x.p.list.length ? x.p.list.length + ' pairs' : 'clear its pairs');
  }).join('\n') + '\n\nAs NovaLCT’s Redundancy Send; the layout isn’t sent. Nothing is saved: press Save when the wall looks right.')) return;
  log('backup_send_all', { processors: plans.map(function (x) { return deviceLabel(x.d); }) });
  var done = [];
  return plans.reduce(function (pr, x) {
    return pr.then(function () { return rdSendBackup(x.d, { plan: x.p, noConfirm: true }).then(function (ok) { done.push(deviceLabel(x.d) + (ok ? ' ✓' : ' ✗')); }); });
  }, Promise.resolve()).then(function () { toast('Send backup: ' + done.join(' · ')); });
}
function renderRedundancy() {
  var b = bkRead(), cellsBy = allCells(), use = portUsage(cellsBy);
  var iss = b.mode === 'port' ? bkPortIssues(use) : b.mode === 'card' ? bkCardIssues(cellsBy) : { err: [], warn: [] };
  rdVerifyBar();
  var box = $('rdBody'); if (!box || ui.tab !== 'backup') return;
  var h = '';
  if (iss.err.length) h += '<p class="rd-msg err">⚠ ' + iss.err.length + ' problem' + (iss.err.length === 1 ? '' : 's') + ' in the backup plan (listed on the right) — fix them before sending.</p>';
  var devsOn = (typeof olShownDevices === 'function' ? olShownDevices() : P.devices), sendable = devsOn.filter(rdBackupShown);   // online: the connected ones (app-online.js)
  if (sendable.length > 1) h += '<div class="rd-act" style="margin:0 0 10px"><button data-rd="sendall"' + (hw.busy ? ' disabled' : '') + ' title="Send each linked processor its port backup, one after another (asks once). Nothing is saved.">Send backup to all (' + sendable.length + ')</button></div>';
  h += devsOn.map(function (d) { return rdDeviceHtml(d, b); }).join('');
  box.innerHTML = h;
}
// The bar under the header while Verify is on, on every tab (like the display bar; Unico: "Examining backup for …"):
// which processor shows only its backup / primary ports, and the way back. Made here so the header markup stays as it is.
function rdVerifyBar() {
  var bar = $('rdVerifyBar'); if (!bar) return;
  var on = P.devices.filter(function (d) { return rd.state[d.id]; });
  if (typeof renderPipe === 'function') renderPipe();   // the Backup tile (app-pipeline.js)
  bar.hidden = !on.length; if (!on.length) return;
  $('rdVerifyText').textContent = 'Verify is on: ' + on.map(function (d) { return deviceLabel(d) + ' shows its ' + rd.state[d.id] + ' ports only'; }).join(' · ');
  $('rdVerifyEnd').disabled = on.some(function (d) { return rd.busy[d.id]; });
}
function bindRedundancy() {
  var box = $('rdBody'); if (!box) return;
  var db = $('displayBar');
  if (db && !$('rdVerifyBar')) {
    var bar = document.createElement('div');
    bar.id = 'rdVerifyBar'; bar.className = 'display-bar rd-verify-bar'; bar.setAttribute('role', 'alert'); bar.hidden = true;
    bar.innerHTML = '<span id="rdVerifyText"></span><button id="rdVerifyEnd" title="Back to normal (primary with automatic take-over) on every processor in Verify">End verify</button>';
    db.parentNode.insertBefore(bar, db.nextSibling);
    $('rdVerifyEnd').onclick = function () {
      log('backup_verify_end_click', {});
      P.devices.forEach(function (d) { if (rd.state[d.id] && !rd.busy[d.id]) rdVerify(d, 'normal'); });
    };
  }
  box.onclick = function (e) {
    var t = e.target.closest('[data-rd]'); if (!t) return;
    if (t.dataset.rd === 'sendall') return rdSendBackupAll();
    var d = P.devices.filter(function (x) { return x.id === t.dataset.dev; })[0]; if (!d) return;
    if (t.dataset.rd === 'send') return rdSendBackup(d);
    if (t.dataset.rd === 'read') return rdRead(d);
    if (t.dataset.rd === 'adopt') return rdAdopt(d);
    if (t.dataset.rd === 'verify') return rdVerify(d, rd.state[d.id] === 'backup' ? 'normal' : 'backup');   // the toggle
    if (t.dataset.rd === 'vprimary') return rdVerify(d, rd.state[d.id] === 'primary' ? 'normal' : 'primary');
    rdVerify(d, t.dataset.rd);
  };
}
