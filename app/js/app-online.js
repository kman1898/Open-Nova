// app-online.js - Online / Offline, as in VMP (user, 2026-10-11: "We don't want them to add themselves to the project. We
// want them to be addable to the project … I should have one or the other available, just like with VMP"). A project is
// in one mode (P.mode; VMP: Tools ▸ Offline Mode, its tree says Online Project / Offline Project):
//   Online  - "+ Add processor" lists ONLY the processors found right now (NovaLCT network + USB / serial, Unico, COEX;
//             searched again every few seconds while the list is open). One click adds it with its real model, named by
//             the model ("H2", "VX1000", "H2 2" …), and links it; an unlinked processor of that model (designed offline) or
//             a "Pick a model" one (an import) is linked instead of adding one. An H chassis is ONE processor over all its
//             output-slot links (the helper's MultiLink, drv-lct.js); the chassis from the H's web API when its login is
//             saved on this computer, else the smallest H that holds the cards. Devices already in the project show as
//             "In project". Nothing is ever added by itself.
//   Offline - "+ Add processor" lists ONLY the model catalogue (app-devices.js); no search runs by itself.
// Never both. Linking a found device to a "Pick a model" processor (Hardware ▸ Link, an old project) sets its model from
// what the device reports (olFit). The H web login (H login… in the Hardware card) is entered here and kept by the helper
// on this computer only (tools/hweb.py), never in the project or the log.
// Owns: ol, olMode, olLinked, olWorkspace, olMoveOnline, olAfterLink, olSetMode, olSame, olInProject, olHCard, olModel, olWhere, olNonLed, olCards, olTarget, olFit, olLinkHw, olAdd,
// olFixLinked, olFoundHtml, olSearch, olAddAddress, olIsH, olWebRefresh, olChassis, hlOpen, hlSubmit, hlForget, bindOnline,
// OL_WAIT_MS, OL_GRACE_MS, OL_RETRY_MS, olDown, olAnswers, olConn, olConnected, olShown, olShownDevices, olGone, olLcShown,
// olPolls, olConnTick, olView, olGoneRender, olFindAgain.
// Depends on: app-core (P, ui, $, uid, esc, toast, commit, snapshot, save), app-log (log), drv-core (DRV), app-processors
// (PROC_MODELS, PROC_ORDER, OUTPUT_CARDS, procModel, procUnset, cardsOfDevice, cardList, applyCards, cardsForModel,
// chassisCardType, newProcName, deviceLabel, deviceById, wiredCards, cardName, cardChangeToast, setProcessorModel),
// app-hardware (hw, hwModelKey, hwForget, hwWhere, hwSenderName, renderHwCard, HW_BUSY_WORDS), app-save (liveSet),
// app-devices (devSelected, devPick, devRenderPicker), app-readback (rb, rbAuto), drv-lct / drv-coex (LCT_HOSTS_KEY,
// lctHosts, COEX_HOSTS_KEY, coexHosts), app-render (renderAll), app-sync (projWorkspace), app-health (hlt), app-hardware
// (hwErrText, hwDetect, hwWriting), app-processors (lctOwner, removeProcessor, procPanels), app-geometry (allCells), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var ol = { searching: false, at: 0, timer: null, hl: null, fixed: null, conn: {}, goneOpen: false };   // at = when the last search finished; hl = processor of the H
// login dialog; fixed = the project olFixLinked last looked at; conn[processor id] = olConn's state; goneOpen = Device's
// "not connected" fold is open

// ------------------------------------------------------------------ the mode = the workspace
// Online and offline are separate workspaces, as in VMP (user, 2026-10-28: "when I disable off-line mode, all of those should
// go away"): every project is in one (P.mode; the server keeps it in its list, serve.py), File lists only the current one's
// projects, and Tools ▸ Enter / Exit offline mode opens the other workspace's last-used project (projWorkspace,
// app-sync.js) — nothing is deleted. A project made before the workspaces: online when a processor is linked, offline when
// it has processors but none linked, online when empty (the same rule as the server's).
function olMode() {
  if (P.mode === 'online' || P.mode === 'offline') return P.mode;
  if ((P.devices || []).some(function (d) { return d.hw && d.hw.kind !== 'offline'; })) return 'online';
  return (P.devices || []).length ? 'offline' : 'online';
}
function olLinked(d) { return !!(d.hw && d.hw.kind !== 'offline'); }
// Tools ▸ Enter / Exit offline mode, File ▸ Online projects | Offline projects: the other workspace. Leaving offline with
// every processor linked to hardware first offers to move this project to online.
function olWorkspace(m, via) {
  var was = olMode();
  if ((m !== 'online' && m !== 'offline') || m === was) return;
  if (was === 'offline' && P.devices.length && P.devices.every(olLinked) && olMoveOnline(via)) return;
  log('workspace', { to: m, from: was, project: P.name, via: via });
  projWorkspace(m, function (made) {   // app-sync.js
    if (was === 'offline') toast('Offline project kept — Tools ▸ Enter offline mode to return to it');
    else toast(made ? 'Offline mode: a new offline project' : 'Offline mode: “' + P.name + '”');
    if (made) devOpenPicker({ first: true });   // "Which processors are you using?" (app-devices.js)
  });
}
// An offline project whose processors are all linked to real hardware may move to online — only when the user says so.
function olMoveOnline(via) {
  if (!confirm('Every processor in “' + P.name + '” is linked to hardware.\n\nMove this project to online? It then lists with the online projects.\n(Cancel keeps it offline.)')) {
    log('project_move_online', { project: P.name, declined: true, via: via }); return false;
  }
  P.mode = 'online';
  log('project_move_online', { project: P.name, processors: P.devices.length, via: via });
  commit(); renderAll(); toast('“' + P.name + '” is now an online project');
  return true;
}
// After a processor of an offline project is linked (Hardware ▸ Link, app-hardware.js): the last one linked offers the move.
function olAfterLink() {
  if (olMode() !== 'offline' || !P.devices.length) return;
  var left = P.devices.filter(function (d) { return !olLinked(d); }).length;
  if (!left) olMoveOnline('link');
}
// The Add processor dialog's Online | Offline: only for a project without processors (a new one), which then belongs to
// that workspace. A project with processors changes workspace only through Tools ▸ Offline mode (olWorkspace).
function olSetMode(m, via) {
  if (m !== 'online' && m !== 'offline') return;
  var was = olMode();
  if (m !== was && P.devices.length) return toast('This project has processors — Tools ▸ ' + (m === 'offline' ? 'Enter' : 'Exit') + ' offline mode opens the ' + m + ' projects');
  P.mode = m;
  log('project_mode', { mode: m, was: was, via: via });
  commit();
  if (m !== was) toast(m === 'online' ? 'Online: Add processor lists what is found on the network' : 'Offline: Add processor lists the model catalogue; nothing is searched');
  if (m === 'online') olSearch(false);
  renderAll();
  if (typeof devPick !== 'undefined' && devPick.open) devRenderPicker();
}

// ------------------------------------------------------------------ what was found
// Is project link h the device behind discovery entry x?
function olSame(h, x) {
  if (!h || h.kind === 'offline' || h.kind !== x.kind) return false;
  if (x.kind === 'unico' || x.kind === 'coex') return !!(x.SN && h.sn === x.SN) || (h.host === x.ip && h.port === x.port);
  return h.host === x.ip;   // NovaLCT: one IP (or one USB / serial location) = one processor, whatever links it has
}
function olInProject(x) { return (P.devices || []).filter(function (d) { return olSame(d.hw, x); })[0] || null; }
function olHCard(id) { return PROC_MODELS.h.cardTypes.filter(function (t) { return OUTPUT_CARDS[t].modelId === id; })[0] || null; }
// The model of x (a discovery entry, or a link {kind, senders, modelId, web}): {key, types (H output cards) | null, guess
// (the chassis is the smallest that holds the cards)}, or null when the catalogue doesn't know it (never a generic one).
function olModel(x) {
  if (!x) return null;
  if (x.kind === 'unico' || x.kind === 'coex') { var k = hwModelKey(x.modelId); return k ? { key: k, types: null } : null; }
  var S = x.senders && x.senders.length ? x.senders : x.modelId != null ? [x.modelId] : [];
  if (!S.length) return null;
  var types = S.map(olHCard);
  if (types.every(Boolean)) {
    var fits = function (key) { var m = PROC_MODELS[key]; return m && m.kind === 'chassis' && m.slots >= types.length && types.every(function (t) { return m.cardTypes.indexOf(t) >= 0; }); };
    var wk = x.web && hwModelKey(x.web.modelId);
    if (wk && fits(wk)) return { key: wk, types: types };
    var g = PROC_ORDER.filter(fits)[0];
    return g ? { key: g, types: types, guess: true } : null;
  }
  var k2 = hwModelKey(S[0]);
  return k2 ? { key: k2, types: null } : null;
}
function olWhere(x) { return x.usb ? 'USB' : x.ip; }
// x is only cards that aren't LED outputs (NON_LED_CARDS, app-processors.js): their name, else ''
function olNonLed(x) {
  var S = x && x.kind === 'lct' ? (x.senders && x.senders.length ? x.senders : x.modelId != null ? [x.modelId] : []) : [];
  return S.length && S.every(function (s) { return NON_LED_CARDS[s]; }) ? NON_LED_CARDS[S[0]] : '';
}
// The cards a processor d of model m gets (an H: its output cards as found).
function olCards(d, m) {
  var M = procModel(m.key);
  if (m.types) return m.types.slice(0, M.slots).map(function (t) { return { ports: OUTPUT_CARDS[t].ports, type: t, dev: d.id, old: null }; });
  return cardsForModel(d, m.key);
}
// What one click on found entry x does: {inp: in the project already} | {why: can't; unknown: a model we don't know yet} | {m, how: 'add' | 'link' | 'set', d}.
function olTarget(x) {
  if (!x) return { why: 'gone' };
  var inp = olInProject(x); if (inp) return { inp: inp };
  if (x.error) return { why: x.error };
  var nl = olNonLed(x); if (nl) return { why: nl, nonLed: true };   // an H's MVR card: known, but nothing to add
  var m = olModel(x);
  if (!m) return { unknown: true, why: 'not known to Open Nova yet' + (x.modelId != null ? ' (ModelID 0x' + (+x.modelId).toString(16).toUpperCase() + ')' : '') + ' — Help ▸ Report a problem sends us what we need to add it' };
  var open = (P.devices || []).filter(function (d) { return !olLinked(d); });   // a simulated one (drv-offline.js) is open too
  var same = open.filter(function (d) { return d.model === m.key; })[0], pick = open.filter(procUnset)[0];
  return same ? { m: m, how: 'link', d: same } : pick ? { m: m, how: 'set', d: pick } : { m: m, how: 'add', d: null };
}
// Make processor d model m (cards as the device has them; the wiring stays on the same card / port numbers). No undo step
// of its own (the caller commits). -> {err} when a wired port wouldn't exist any more, else {pinned}.
function olFit(d, m) {
  var M = procModel(m.key), idx = cardsOfDevice(d), wired = wiredCards(), fresh;
  if (d.model === m.key && !m.types) return { pinned: [] };
  if (m.types || M.kind !== 'chassis') fresh = olCards(d, m);
  else fresh = idx.length ? idx.slice(0, M.slots).map(function (i) {   // a chassis that doesn't list its cards (COEX): keep them
    var t = chassisCardType(M, P.processors[i].type, wired[i] || 1); return { ports: OUTPUT_CARDS[t].ports, type: t, dev: d.id, old: null };
  }) : olCards(d, m);
  var bad = [];
  idx.forEach(function (i, k) {
    if (!wired[i]) return;
    if (!fresh[k]) bad.push(cardName(i, true) + ' has cabinets, but a ' + M.name + ' has ' + fresh.length + ' card' + (fresh.length === 1 ? '' : 's'));
    else if (fresh[k].ports < wired[i]) bad.push(cardName(i, true) + ' uses port ' + wired[i] + ', but ' + (fresh[k].type ? 'its ' + OUTPUT_CARDS[fresh[k].type].name : 'a ' + M.name) + ' has ' + fresh[k].ports);
  });
  if (bad.length) return { err: bad.join('; ') };
  fresh.forEach(function (c, k) { c.old = k < idx.length ? idx[k] : null; });
  var cards = cardList(), at = idx.length ? idx[0] : cards.length;
  cards.splice(at, idx.length);   // a processor's cards are consecutive (ensureDevices)
  Array.prototype.splice.apply(cards, [at, 0].concat(fresh));
  var old = procModel(d.model).name, auto = !d.name || d.name === old || /^Processor \d+$/.test(d.name) ||
    new RegExp('^' + old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\d+$').test(d.name);
  d.model = m.key;
  if (auto) d.name = newProcName(P.devices.filter(function (o) { return o !== d; }), m.key);
  return { pinned: applyCards(cards) };
}
// Link processor d to found entry x (start from what the processor has).
function olLinkHw(d, x) {
  d.hw = { kind: x.kind, host: x.ip, port: x.port, sn: x.SN, name: x.deviceName, modelId: x.modelId, senders: x.senders };
  if (x.web) d.hw.web = x.web;
  hwForget(d); if (hw.applied) liveSet(d, undefined);   // app-save.js
}
// One click in the online list: add the processor found (or link / name the project's waiting one). One undo step.
function olAdd(x) {
  if (hw.busy) return toast('Wait — ' + (HW_BUSY_WORDS[hw.busy] || hw.busy) + ' is still running');
  var t = olTarget(x);
  if (t.inp) return toast(deviceLabel(t.inp) + ' is already in this project');
  if (!t.m) return toast(t.unknown ? (x && x.deviceName || 'This processor') + ' is ' + t.why : 'Can’t add ' + (x && x.deviceName || 'it') + ': ' + t.why);
  var d = t.d, pinned, before = d ? deviceLabel(d) : '';
  if (t.how === 'add') {
    d = { id: uid(), model: t.m.key, name: newProcName(P.devices, t.m.key) };
    P.devices.push(d);
    pinned = applyCards(cardList().concat(olCards(d, t.m)));
  } else {
    var r = olFit(d, t.m);
    if (r.err) { log('add_found_processor', { found: x.deviceName, at: olWhere(x), into: before, refused: r.err }); return toast('Can’t use ' + before + ' for the ' + procModel(t.m.key).name + ': ' + r.err); }
    pinned = r.pinned;
  }
  olLinkHw(d, x);
  P.procsChosen = true;
  var mine = cardsOfDevice(d);
  ui.devSel = d.id; ui.mSender = mine[0]; ui.mPort = 0;
  log('add_found_processor', { processor: deviceLabel(d), model: procModel(d.model).name, how: t.how, into: t.how === 'add' ? undefined : before, kind: x.kind,
    at: x.ip + (x.kind === 'lct' ? '' : ':' + x.port), link: hwWhere(x.ip, x.port), cards: t.m.types ? t.m.types.map(function (ty) { return OUTPUT_CARDS[ty].name; }) : undefined,
    chassis: t.m.guess ? 'smallest that holds the cards (no H login saved)' : undefined });
  commit(); renderAll();
  cardChangeToast((t.how === 'add' ? 'Added ' : 'Linked ') + deviceLabel(d) + (t.how === 'set' && before !== deviceLabel(d) ? ' (was ' + before + ')' : '') + ' · ' + olWhere(x) +
    (t.m.guess ? ' — the chassis is a guess; H login… in Hardware reads it' : ''), pinned);
  if (typeof rbAuto === 'function') { rb.asked[d.id] = 0; setTimeout(function () { rbAuto(d); }, 1500); }   // read its layout (app-readback.js)
  if (olIsH(d) && !d.hw.web) olWebRefresh(d);
  if (typeof devPick !== 'undefined' && devPick.open) devRenderPicker();
  return d;
}
// Projects whose "Pick a model" processor is linked (made before 2026-10-11): the link names the model. Once, at start.
function olFixLinked() {
  var done = [];
  (P.devices || []).forEach(function (d) {
    if (!procUnset(d) || !d.hw || d.hw.kind === 'offline') return;
    var m = olModel(d.hw), before = deviceLabel(d), r = m && olFit(d, m);
    if (r && !r.err) done.push(before + ' → ' + deviceLabel(d));
    log('model_from_link', { processor: before, model: m ? procModel(m.key).name : undefined, refused: r && r.err, unknown: m ? undefined : true });
  });
  if (done.length) { commit(); renderAll(); toast('Model set from the link: ' + done.join(', ')); }
}

// ------------------------------------------------------------------ the online list (in the Add processor picker)
function olFoundHtml() {
  if (hw.helper === false) return '<p class="hint">The helper isn’t running, so nothing can be found. Start Open Nova’s helper (tools\\novalink.py serve), or switch to Offline to design without hardware.</p>';
  var list = (hw.found || []).filter(function (x) { return x && x.ip; }), h = '';
  list.forEach(function (x) {
    var t = olTarget(x), i = hw.found.indexOf(x), m = t.m || (t.inp ? { key: t.inp.model } : null);
    var name = m ? procModel(m.key).name : t.nonLed ? 'H MVR card' : x.deviceName || 'Processor';
    var sub = [hwWhere(x.ip, x.port)];
    if (x.iface && typeof nwShort === 'function') sub.push(nwShort(x.iface));   // the network it answered on (app-network.js)
    if (x.kind === 'unico' || x.kind === 'coex') {   // their own name (set in Unico / VMP) and serial number
      if (x.deviceName && x.deviceName !== name) sub.push(x.deviceName);
      if (x.SN) sub.push('SN ' + x.SN);
    } else if (t.m && t.m.types) {   // an H: its output cards, "2 × H 4× fiber (32 ports)"
      var n = {}, order = [];
      t.m.types.forEach(function (ty) { if (!n[ty]) { n[ty] = 0; order.push(ty); } n[ty]++; });
      sub.push(order.map(function (ty) { return (n[ty] > 1 ? n[ty] + ' × ' : '') + OUTPUT_CARDS[ty].name; }).join(' + ') + (t.m.guess ? ' · chassis guessed (H login… reads it)' : ''));
    }
    var act = t.inp ? 'In project as ' + deviceLabel(t.inp) : t.unknown ? 'Not known to Open Nova yet — Help ▸ Report a problem sends us what we need to add it' : t.nonLed ? 'Preview card, not an LED output' : !t.m ? 'Can’t add: ' + t.why : t.how === 'add' ? 'Add' : 'Link to ' + deviceLabel(t.d);
    var ok = !t.inp && !!t.m;
    h += '<button class="dp-model dp-found' + (t.inp ? ' in' : '') + '" data-found="' + i + '"' + (ok ? '' : ' disabled') + ' title="' +
      esc(ok ? act + ': ' + name + ' at ' + olWhere(x) + ' joins the project, linked' : t.unknown ? 'N' + t.why.slice(1) : act) + '"><b>' + esc(name) + '</b><span>' + esc(sub.join(' · ')) + '</span>' +
      (x.conflict ? '<span class="rcv-bad">⚠ ' + esc(x.conflict) + '</span>' : '') + '<span class="dp-act">' + esc(act) + '</span></button>';
  });
  if (!list.length) h = '<p class="hint">' + (ol.searching || !ol.at ? 'Searching…' : 'No processors found. Are they on, and on this network (or plugged in by USB)? A processor on another network: Add by address…') + '</p>';
  if (!list.length && !ol.searching && ol.at) { var why = olWhy(DRV.why); h += '<p class="hint ol-why" title="' + esc(why.more) + '">' + esc(why.line) + '</p>'; }
  return h;
}
// Why a search found nothing, in one short line (the likely causes on a fresh computer: the firewall / macOS Local Network
// permission, NovaLCT or VMP on this computer holding a search port, a search that couldn't be sent) plus the adapters
// searched; everything the helper said in the tooltip. w = DRV.why (the helper's 'search' replies, drv-core.js).
function olWhy(w) {
  w = w || { problems: [], searched: [] };
  var plat = w.platform || (/Mac/.test(navigator.platform || '') ? 'darwin' : /Win/.test(navigator.platform || '') ? 'win32' : 'linux');
  var pr = w.problems || [], parts = [];
  var nr = pr.filter(function (p) { return p.code === 'noroute'; })[0];
  if (plat === 'darwin') parts.push(nr ? 'macOS blocked the search: System Settings ▸ Privacy & Security ▸ Local Network ▸ allow Terminal (or Python)'
    : 'macOS Local Network permission (Privacy & Security ▸ Local Network ▸ Terminal or Python)');
  else if (plat === 'win32') parts.push('Windows Firewall blocking Python (allow it on Private and Public networks)');
  else parts.push('a firewall (ufw / firewalld) blocking UDP replies');
  var own = pr.filter(function (p) { return p.code === 'port'; }).map(function (p) { return p.text.replace(' on this computer', ''); });
  if (own.length) parts.push(own.join(', ') + ' (close NovaLCT / VMP here)');
  var other = pr.filter(function (p) { return p.code !== 'port' && p !== nr; })[0];
  if (other) parts.push(other.text);
  var s = (w.searched || []).map(function (a) { return a.name + ' (' + a.ip + ')'; });
  return { line: 'Possible causes: ' + parts.join(' · ') + (s.length ? ' · searched ' + s.join(', ') : ''),
    more: pr.length ? pr.map(function (p) { return p.text; }).join('\n') : 'The search reported no errors.' };
}
// One search (opening the online list = a search the user asked for: COM ports are probed too; refreshes are background).
function olSearch(background) {
  if (ol.searching || hw.helper === false) return;
  ol.searching = true;
  if (background) hw.bgAt = Date.now();   // counts as the background search (app-hardware.js hwBackground)
  return DRV.discoverAll({ timeout: 2, background: !!background }).then(function (found) {
    if (found.failed && found.failed === found.tried) hw.helper = false;
    hw.found = found; hw.searched = true;
    if (!background) log('find_processors', { via: 'add processor (online)', found: found.map(function (x) { return x.deviceName + ' ' + hwWhere(x.ip, x.port) + ' (' + x.kind + ')'; }) });
  }, function () { /* helper away */ }).then(function () {
    ol.searching = false; ol.at = Date.now();
    if (typeof devPick !== 'undefined' && devPick.open) devRenderPicker();
    renderHwCard(devSelected());
  });
}
// A processor on another network / over a VPN doesn't hear the search: its address is asked directly on every search.
function olAddAddress() {
  var ad = prompt('Processor address — an IP for NovaLCT processors (H, MCTRL, VX …); ip:port for an MX controller (port 8001):', '');
  if (!ad || !ad.trim()) return;
  ad = ad.trim();
  var cx = ad.indexOf(':') >= 0, ip = ad.split(':')[0];
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return toast('That isn’t an IP address (like 192.168.0.10)');
  var key = cx ? COEX_HOSTS_KEY : LCT_HOSTS_KEY, list = cx ? coexHosts() : lctHosts();
  if (list.indexOf(ad) < 0) list.push(ad);
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (x) { /* storage unavailable */ }
  log(cx ? 'coex_add_address' : 'lct_add_address', { address: ad, via: 'add processor (online)' });
  olSearch(false);
}

// ------------------------------------------------------------------ connected = answering now (online projects only)
// User, 2026-11-10 (the app reopened his online project with an H2 that wasn't plugged in: Monitor "1 error", "timed out"
// every few seconds): "it needs to only show connected when i am in online mode. offline mode can show things like that once
// enabled". In an online project a linked processor is shown only while it answers its live detect (app-hardware.js
// hw.watch) or health read (app-health.js hlt.watch). At start, or on a new link, it is "connecting" (shown) until the first
// answer or failure, at most OL_WAIT_MS; a shown one goes after OL_GRACE_MS of failing without an answer in between (one
// timeout doesn't hide a wall). Not connected = left out of every surface (tree, Device, header tiles, Layout, Screen
// Settings, Monitor, Maintain, Dashboard, Send / Save, Backup, Presets) and not polled; nothing in the project changes. Its
// only mention: Device's "N processors not connected ▸" fold (address, Remove from project, Find again). A search that
// finds it again (the background one every minute, the Add processor list, Find again) lets the polls try for OL_RETRY_MS;
// its first answer shows it again. Offline projects, simulated and unlinked processors: always shown.
var OL_WAIT_MS = 6000, OL_GRACE_MS = 15000, OL_RETRY_MS = 20000;
// a read that failed because the processor (or the helper) can't be reached; any other error is an answer of sorts
function olDown(e) { e = String(e || ''); return !!e && (hwErrText(e) !== e || /did not answer|not answering|no NovaStar USB|could not open|no such device/i.test(e)); }
// when d's live reads last answered / last failed to reach it (ms, 0 = never)
function olAnswers(d) {
  var r = { ok: 0, bad: 0 };
  [hw.watch[d.id], typeof hlt !== 'undefined' ? hlt.watch[d.id] : null].forEach(function (w) {
    if (!w || !w.done) return;
    if (w.err && olDown(w.err)) r.bad = Math.max(r.bad, w.done); else r.ok = Math.max(r.ok, w.done);
  });
  return r;
}
// 'yes' | 'connecting' | 'no'. Moves on as answers come in; olConnTick logs each change once.
function olConn(d) {
  if (!d || !olLinked(d) || olMode() !== 'online') return 'yes';
  var now = Date.now(), k = d.hw.kind + '|' + d.hw.host + '|' + d.hw.port, c = ol.conn[d.id], a = olAnswers(d);
  if (!c || c.key !== k) c = ol.conn[d.id] = { st: 'connecting', t0: now, at: now, key: k, told: '', fail: 0, retry: 0, found: hw.found };
  if (c.found !== hw.found) {   // a search finished since: found again → the polls may try it
    c.found = hw.found;
    if (c.st === 'no' && (hw.found || []).some(function (x) { return x && olSame(d.hw, x); })) c.retry = now;
  }
  var to = function (st) { c.st = st; c.at = now; c.fail = 0; };
  if (c.st === 'connecting') { if (a.ok >= c.t0) to('yes'); else if (a.bad >= c.t0 || now - c.t0 > OL_WAIT_MS) to('no'); }
  else if (c.st === 'yes') {
    if (a.bad > a.ok) { if (!c.fail) c.fail = now; if (now - c.fail >= OL_GRACE_MS) to('no'); } else c.fail = 0;
  } else if (a.ok > c.at) to('yes');
  return c.st;
}
function olConnected(d) { return olConn(d) === 'yes'; }
function olShown(d) { return olConn(d) !== 'no'; }
function olShownDevices() { return (P.devices || []).filter(olShown); }
function olGone() { return olMode() === 'online' ? (P.devices || []).filter(function (d) { return !olShown(d); }) : []; }
// a screen is shown unless it belongs to a processor that isn't (an empty screen belongs to nobody)
function olLcShown(lc, gone) {
  gone = gone || olGone(); if (!lc || !gone.length) return true;
  var o = lctOwner(lc); return !o || gone.indexOf(o) < 0;
}
// the live detect / health polls run for d (app-hardware.js hwTick, app-health.js hltTick): not while it isn't connected,
// except for a while after a search found it again
function olPolls(d) {
  if (olConn(d) !== 'no') return true;
  var c = ol.conn[d.id]; return !!(c && c.retry && Date.now() - c.retry < OL_RETRY_MS);
}
// Every second (bindOnline): log each change once, a short toast when one comes back, and redraw.
function olConnTick() {
  if (olMode() !== 'online') return;
  var changed = false;
  (P.devices || []).forEach(function (d) {
    if (!olLinked(d)) return;
    var st = olConn(d), c = ol.conn[d.id];
    if (c.retry && c.retried !== c.retry && st === 'no' && !hwWriting()) { c.retried = c.retry; hwDetect(d, true); }   // found again: ask now, not after the back-off
    if (st === 'connecting' || st === c.told) return;
    var back = c.told === 'no';
    c.told = st; changed = true;
    log(st === 'yes' ? 'processor_connected' : 'processor_not_connected', { processor: deviceLabel(d), at: hwWhere(d.hw.host, d.hw.port) });
    if (back) toast(deviceLabel(d) + ' connected');
    if (st === 'yes' && typeof rbAuto === 'function') rbAuto(d);   // its layout, as at start (app-readback.js; once per session)
  });
  if (changed) renderAll();
}
// renderAll's first step (app-render.js): what is worked on stays on shown processors (the screen on Layout, the active
// card, the ones picked together); the canvas says so when no linked processor is connected.
function olView() {
  var gone = olGone(), off = function (d) { return !!d && gone.indexOf(d) >= 0; };
  if (gone.length) {
    var lc = lctById(ui.viewScreen);
    if (lc && !olLcShown(lc, gone)) {
      var to = P.lct.filter(function (l) { return olLcShown(l, gone); })[0];
      if (to) { ui.viewScreen = to.id; ui.view = null; ui.selKeys = new Set(); ui.selScreen = null; ui.sel = null; }
    }
    if (off(deviceOfCard(ui.mSender || 0))) {
      var own = lctOwner(lctById(ui.viewScreen)), sd = own && !off(own) ? own : olShownDevices().filter(function (x) { return cardsOfDevice(x).length; })[0];
      if (sd) { ui.mSender = cardsOfDevice(sd)[0]; ui.mPort = 0; }
    }
    if (ui.devMulti && ui.devMulti.length) { ui.devMulti = ui.devMulti.filter(function (id) { return !off(deviceById(id)); }); if (ui.devMulti.length < 2) ui.devMulti = []; }
  }
  var vp = $('viewport'), e = $('olEmpty'), none = gone.length > 0 && !olShownDevices().some(olLinked);
  if (vp && !e && none) {
    e = document.createElement('div'); e.id = 'olEmpty'; e.className = 'ol-empty';
    e.innerHTML = '<p><span>No processors connected</span><button class="primary" title="The processors found on the network and USB right now">+ Add processor</button></p>';
    e.querySelector('button').onclick = function () { log('no_processors_add', { via: 'canvas' }); devOpenPicker(); };
    vp.appendChild(e);
  }
  if (e) e.hidden = !none;
  document.body.classList.toggle('ol-none', none);   // Layout's port list and side panel have nothing to show (app.css)
}
// Device: one quiet line under the processor cards, "1 processor not connected ▸", folding open to the list (address,
// Remove from project) and Find again. Nothing else mentions them.
function olGoneRender() {
  var cards = $('devCards'); if (!cards) return;
  var box = $('olGone'), gone = olGone();
  if (!box) {
    box = document.createElement('div'); box.id = 'olGone'; box.className = 'ol-gone';
    cards.parentNode.insertBefore(box, cards.nextSibling);
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-olg]'); if (!b || b.disabled) return;
      var a = b.dataset.olg;
      if (a === 'fold') { ol.goneOpen = !ol.goneOpen; log('card_fold', { card: 'not connected', folded: !ol.goneOpen }); return olGoneRender(); }
      if (a === 'find') return olFindAgain();
      var d = deviceById(b.dataset.id); if (!d || a !== 'remove') return;
      if (!procPanels(d).n && !confirm('Remove ' + deviceLabel(d) + ' from this project?\n\nCtrl+Z brings it back.')) return log('remove_processor', { processor: deviceLabel(d), cancelled: true, via: 'not connected' });
      removeProcessor(d);   // asks first itself when cabinets are wired (app-processors.js)
    });
  }
  box.hidden = !gone.length;
  if (!gone.length) { box.innerHTML = ''; return; }
  var looking = ol.searching || gone.some(function (d) { return olPolls(d); });
  box.innerHTML = '<button class="ol-g-head" data-olg="fold" aria-expanded="' + ol.goneOpen + '" title="In this project, but not answering now. They show again by themselves when they answer.">' +
    gone.length + ' processor' + (gone.length === 1 ? '' : 's') + ' not connected ' + (ol.goneOpen ? '▾' : '▸') + '</button>' +
    (ol.goneOpen ? '<div class="ol-g-list">' + gone.map(function (d) {
      return '<div class="ol-g-row"><b>' + esc(deviceLabel(d)) + '</b><span class="hint">' + esc(procModel(d.model).name + ' · ' + hwWhere(d.hw.host, d.hw.port)) + '</span>' +
        '<button class="mini" data-olg="remove" data-id="' + esc(d.id) + '" title="Take it out of this project (asks first; Ctrl+Z brings it back)">Remove from project</button></div>';
    }).join('') + '<div class="ol-g-foot"><button class="mini" data-olg="find"' + (looking ? ' disabled' : '') + ' title="Search the network and ask them again">' + (looking ? 'Looking…' : 'Find again') + '</button></div></div>' : '');
}
// Find again: a search, and the polls ask each one not connected once more (its first answer shows it again).
function olFindAgain() {
  var gone = olGone(), now = Date.now();
  gone.forEach(function (d) { var c = ol.conn[d.id]; if (c) c.retry = now; });
  log('find_again', { processors: gone.map(function (d) { return deviceLabel(d) + ' ' + hwWhere(d.hw.host, d.hw.port); }) });
  olSearch(false);
  olGoneRender();
  setTimeout(olGoneRender, OL_RETRY_MS + 100);   // "Looking…" ends
}

// ------------------------------------------------------------------ H series: the chassis from its web API
function olIsH(d) {
  return !!(d && d.hw && d.hw.kind === 'lct' && /^\d{1,3}(\.\d{1,3}){3}$/.test(d.hw.host || '') &&
    (procModel(d.model).family === 'H series' || (d.hw.senders || []).some(olHCard)));
}
// The H's web info read with the saved login (nothing is sent when none is saved); then the chassis model.
function olWebRefresh(d) {
  if (!olIsH(d)) return Promise.resolve(null);
  return DRV.post('lct', '/api/hw/hweb/info', { host: d.hw.host }).then(function (r) {
    hw.hweb = hw.hweb || {}; hw.hweb[d.hw.host] = { login: !!r.login, error: r.ok ? '' : r.error };
    if (!r.ok || !d.hw) return r;
    d.hw.web = { modelId: r.modelId, ledCards: r.ledCards || [], sw: r.softwareVersion || '' };
    if (!olChassis(d)) { ui.lastSnap = snapshot(); save(); }   // what was read isn't an undo step
    renderHwCard(devSelected());
    return r;
  }, function () { return null; });
}
// The H web API named the chassis: make the processor that model when its cards fit (wiring stays), renaming an automatic name.
function olChassis(d) {
  var k = d.hw && d.hw.web && hwModelKey(d.hw.web.modelId), m = k && PROC_MODELS[k];
  if (!m || m.kind !== 'chassis' || k === d.model) return false;
  var idx = cardsOfDevice(d);
  if (idx.length > m.slots || idx.some(function (i) { return P.processors[i].type && m.cardTypes.indexOf(P.processors[i].type) < 0; })) return false;
  var old = procModel(d.model).name, auto = !d.name || d.name === old || new RegExp('^' + old.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\d+$').test(d.name) || /^Processor \d+$/.test(d.name);
  if (auto) d.name = newProcName(P.devices.filter(function (o) { return o !== d; }), k);
  log('h_chassis_from_web', { processor: deviceLabel(d), from: old, to: m.name });
  setProcessorModel(d, k);   // commits, renders, toasts "H2 → H5"
  return d.model === k;
}

// ------------------------------------------------------------------ H login dialog (the login goes to the helper only)
function hlOpen(d) {
  if (!olIsH(d)) return toast('H login is for H series processors on the network');
  ol.hl = d.id;
  $('hlTitle').textContent = 'H login: ' + deviceLabel(d);
  $('hlHint').textContent = 'The login of the H’s own web page. Open Nova reads its chassis model and output cards with it. Kept on this computer only (not in the project), sent only to ' + d.hw.host + '.';
  var st = hw.hweb && hw.hweb[d.hw.host];
  $('hlMsg').textContent = st && st.login ? 'A login is saved for ' + d.hw.host + '.' + (st.error ? ' Last try: ' + st.error : '') : '';
  $('hlPass').value = ''; $('hlDlg').hidden = false; $('hlPass').focus();
}
function hlSubmit() {
  var d = deviceById(ol.hl); if (!d || !d.hw) return;
  var host = d.hw.host, user = $('hlUser').value.trim() || 'admin', pass = $('hlPass').value;
  $('hlPass').value = '';   // not kept in the page
  if (!pass) { $('hlMsg').textContent = 'Type the password'; return; }
  $('hlGo').disabled = true; $('hlMsg').textContent = 'Logging in…';
  DRV.post('lct', '/api/hw/hweb/login', { host: host, username: user, password: pass }).then(function (r) { return r; }, function (e) { return { ok: false, error: 'helper: ' + e.message }; }).then(function (r) {
    $('hlGo').disabled = false;
    hw.hweb = hw.hweb || {}; hw.hweb[host] = { login: !!r.login, error: r.ok ? '' : r.error };
    log('h_login', { processor: deviceLabel(d), host: host, ok: !!r.ok, error: r.ok ? undefined : r.error, model: r.ok ? r.modelId : undefined });
    if (!r.ok) { $('hlMsg').textContent = r.error || 'login failed'; return; }
    $('hlDlg').hidden = true;
    d.hw.web = { modelId: r.modelId, ledCards: r.ledCards || [], sw: r.softwareVersion || '' };
    var k = hwModelKey(r.modelId);
    toast('Logged in to ' + (k ? PROC_MODELS[k].name : 'the H') + ' at ' + host + ' — saved on this computer');
    if (!olChassis(d)) { ui.lastSnap = snapshot(); save(); }
    renderHwCard(devSelected());
  });
}
function hlForget() {
  var d = deviceById(ol.hl); if (!d || !d.hw) return;
  var host = d.hw.host;
  DRV.post('lct', '/api/hw/hweb/forget', { host: host }).then(function (r) {
    if (hw.hweb) delete hw.hweb[host];
    log('h_login_forget', { processor: deviceLabel(d), host: host, removed: !!r.removed });
    $('hlMsg').textContent = r.removed ? 'Removed from this computer.' : 'Nothing was saved for ' + host + '.';
  }, function (e) { $('hlMsg').textContent = 'helper: ' + e.message; });
}

function bindOnline() {
  var dlg = $('hlDlg');
  if (dlg) {
    $('hlForm').addEventListener('submit', function (e) { e.preventDefault(); hlSubmit(); });
    $('hlForget').onclick = hlForget;
    dlg.addEventListener('click', function (e) { if (e.target.id === 'hlClose' || e.target === dlg) { $('hlPass').value = ''; dlg.hidden = true; } });
    dlg.addEventListener('keydown', function (e) { if (e.key === 'Escape') { $('hlPass').value = ''; dlg.hidden = true; } });
  }
  var om = $('btnOfflineMode');
  if (om) om.onclick = function () { olWorkspace(olMode() === 'offline' ? 'online' : 'offline', 'Tools ▸ Offline Mode'); };
  // while the online list is open it stays current (a search every few seconds); a project that arrives (start, another
  // browser, a switch) gets its linked "Pick a model" processors named once, and its workspace written into it (so a later
  // unlink doesn't move it; carried by the next save)
  ol.timer = setInterval(function () {
    if (ol.fixed !== P) { ol.fixed = P; if (!P.mode) P.mode = olMode(); olFixLinked(); }
    olConnTick();   // connected / not connected (online projects)
    if (typeof devPick === 'undefined' || !devPick.open || olMode() !== 'online' || document.hidden || hw.busy) return;
    if (Date.now() - ol.at > 5000) olSearch(true);
  }, 1000);
}
