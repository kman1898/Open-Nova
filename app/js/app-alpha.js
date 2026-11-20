// app-alpha.js - the early-alpha build (docs/DIAGNOSTICS.md "The alpha build"): the version everywhere, the tester's intro, read-only until
// unlocked, first-contact snapshots of unknown processors, and Help ▸ Report a problem….
//   - Version: app/version.json (the one source; make_package.py --alpha stamps it) in the window title, Help ▸ About,
//     the log, every report / support bundle. The helper's own answer (/api/hw/alpha/state) says whether this is the alpha.
//   - Read-only (alpha only): every write to a processor needs the unlock code (user, 2026-10-28: "we need every save or
//     send what have you to be password protected") — Send, Save, blackout / freeze / normal, test patterns, identify,
//     mapping, the error Clear's counter reset, live colour, everything. Default-deny, the helper's policy (tools/alpha.py
//     classify, sent here): only listed reads pass. Refused here (DRV.post, no call; the helper is told so it is in the
//     recording) and by the helper. Settings ▸ Alpha ▸ Allow sending asks for the code: checked against version.json's
//     salted SHA-256, then the send token SHA-256(salt + code + "|send") is kept in this browser (the helper checks it
//     against tokenSha256; the token is in no file). Stays unlocked in this browser until Lock again or a new version.
//     A build packaged without a code never writes. Every unlock / lock is logged (never the code or the token).
//   - First contact (always): a processor found whose model the catalogue doesn't know gets its info read (read-only) and
//     the helper keeps a snapshot of everything said with it (diagnostics/<day>/first-contact/), once per model.
//   - Report a problem…: what the tester writes + the project, logs, recordings, processor read-backs (all read-only),
//     made into one .zip by the helper (REPORT.md on top, scrubbed, optionally anonymised) in Downloads. Then: its path,
//     Show in folder, Copy issue text (version, OS, processor families, the error; no addresses, serials or names) and,
//     once the repository is public (version.json repoPublic), a link to the GitHub issue page (only a link: nothing is
//     sent from here). The helper keeps the .zip small enough to e-mail and says how many files it left out.
//   - An unexpected error caught (a JS error, an unhandled promise failure, a helper bug, a driver's internal error — not a
//     processor that didn't answer): "Something went wrong — Make a report / Dismiss", once per distinct error a session,
//     held back while a processor operation runs or a send dialog is open, never taking focus. Make a report = the report
//     with that error at the top of REPORT.md (time, action, message, stack, the log and frames of the 30 s before it).
// Owns: alphaErr, alphaErrCaught, alphaErrBlocked, alphaErrShow, alphaErrChoose, alphaErrPayload, alphaIssueClean, alphaIssueText, alphaCopy,
// alpha, ALPHA_RO, ALPHA_UNLOCK_KEY, ALPHA_LIMITS, ALPHA_RO_SEL, ALPHA_POST, ALPHA_RENDER, ALPHA_DISCOVER, alphaSha256, alphaPost,
// alphaVersionText, alphaTitleText, alphaTitle, alphaLoad, alphaReadOnly, alphaToken, alphaTokenOk, alphaUnlocked, alphaClassify, alphaWhat,
// alphaApplyRO, alphaOwn, alphaContact, alphaDlg, alphaDlgClose, alphaIntro, alphaUnlockAsk, alphaLock, alphaEvent, alphaFirstContact,
// alphaReportOpen, alphaReportGo, alphaSummary, alphaKb, bindAlpha.
// Depends on: app-core (P, ui, $, esc, toast), app-log (log, logState, logAct, logActBody, logActNew, logFormat), drv-core (DRV), app-support (supGather),
// app-hardware (hw, hwModelKey), app-online (olModel, olMode), app-processors (procModel, procUnset, deviceLabel), app-render (renderAll),
// all at run time; loads after app-render.js and drv-core.js (it wraps renderAll, DRV.post and DRV.discoverAll).
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var alpha = { ver: null, st: null, events: [], fc: {}, busy: false, report: null, mode: '' };   // mode: which dialog is open
var ALPHA_RO = 'Writing to processors is off in this alpha — Settings ▸ Alpha ▸ Allow sending';
var ALPHA_UNLOCK_KEY = 'opennova.alphaUnlock';
// Known limits in this alpha: the same list as docs/README-ALPHA.md (keep both in step), shown in the intro (open on the first start).
var ALPHA_LIMITS = [
  ['Only the H2, H5 and H9 have been tried on real processors', ' (finding and reading them). MCTRL, VX, NovaPro, Unico and MX / CX processors have only been run against simulators so far. If something looks wrong, a report is the most useful thing you can send.'],
  ['USB (NovaPro HD, a VX’s USB-B port) is ready, but the first test on a real NovaPro HD is still to come.', ' Windows: install NovaLCT once (it brings the USB driver). Open Nova and NovaLCT can both use the controller. To record what NovaLCT does, Open Nova asks once to Install USB capture (then restart the computer) and once per start to Allow USB recording.'],
  ['USB on a Mac needs macOS 14 (Sonoma) or newer.', ' Network processors work on older versions. Linux needs libusb and a udev rule (RUNNING.md).'],
  ['Windows 10 or 11, 64-bit.', ' Windows 7 and 8 can’t run it. When Windows asks about Python and the network, tick both Private and Public, then Allow.'],
  ['Recording NovaStar’s own apps:', ' while NovaLCT, VMP or Unico is open, Open Nova records what it says to the processors. It only listens (Windows’ own packet recorder; Windows 10 version 2004 or newer) and never gets in the way. Windows asks once per start: Allow recording. Not tried yet with a real NovaLCT and processor. The Mac way (it asks for your password once) is untested. USB recording works on Windows only. The relay under Advanced is an experimental expert option. Recordings and Wireshark captures go into the report as they are (they may hold a login the NovaStar app sent). NovaStar apps’ logs go in only when you tick them.'],
  ['A controller on a COM port:', ' close NovaLCT first. It holds the port, and Open Nova tells you which one.'],
  ['Writing is off until you type the unlock code', ' (Settings ▸ Alpha ▸ Allow sending). Greyed buttons are locked, not broken. The unlock is per browser.'],
  ['Unzip to a normal folder on this computer,', ' not OneDrive or a network share. Your projects live in the Open Nova folder (app/data): when you update, copy that folder across.'],
  ['Browser:', ' current Chrome, Edge or Firefox, or Safari 16.4 or newer.']
];
// What the read-only alpha greys out (the helper refuses these anyway): Send, Save, Send backup, service, calibration
// changes, receiving-card files, Screen Settings Apply, scene recall, blackout / freeze / normal, the Test menu (patterns,
// identify, mapping), the dashboard's show buttons. (The Monitor's Clear stays: it clears Open Nova's own list; the
// processor's counters are then not reset, and it says so. Live colour edits stay editable in the project; each send is refused.)
var ALPHA_RO_SEL = '#btnSendHdr, #btnSendMenu, #btnSaveHw, #btnSaveMenu, #btnSaveBar, #mtRcv, #scApply, [data-rd="send"], [data-hw="svc"], #svcGo, [data-co="mode"], ' +
  '[data-co="reset"], [data-co="reload"], [data-co="save"], [data-co="module"], [data-co="flash"], [data-ps="recall"], ' +
  '#btnBlackout, #btnFreeze, #btnNormalHdr, #btnNormalBar, #btnTest, #btnTestHdr, #mbTestTool, [data-db="blackout"], [data-db="freeze"], [data-db="normal"], [data-db="scene"], [data-db="save"]';

// SHA-256 of a string (UTF-8) as hex: crypto.subtle only exists on https / localhost, and the app is opened over the LAN.
function alphaSha256(s) {
  var f = alphaSha256, K = f.K, i, j;
  if (!K) {
    K = f.K = []; f.H = [];
    for (var p = 2, n = 0; n < 64; p++) {
      for (j = 2; j * j <= p && p % j; j++);
      if (j * j > p) { if (n < 8) f.H[n] = (Math.pow(p, 1 / 2) % 1) * 4294967296 | 0; K[n++] = (Math.pow(p, 1 / 3) % 1) * 4294967296 | 0; }
    }
  }
  var str = unescape(encodeURIComponent(String(s))), L = str.length, w = [], h = f.H.slice();
  for (i = 0; i < L; i++) w[i >> 2] |= str.charCodeAt(i) << ((3 - i % 4) * 8);
  w[L >> 2] |= 0x80 << ((3 - L % 4) * 8);
  var nw = (((L + 8) >> 6) + 1) * 16;
  w[nw - 1] = L * 8;
  for (j = 0; j < nw; j += 16) {
    var W = [], a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], g = h[5], k = h[6], m = h[7];
    for (i = 0; i < 64; i++) {
      if (i < 16) W[i] = w[j + i] | 0;
      else {
        var x = W[i - 15], y = W[i - 2];
        W[i] = (W[i - 16] + ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + W[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10))) | 0;
      }
      var t1 = (m + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & g) ^ (~e & k)) + K[i] + W[i]) | 0;
      var t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      m = k; k = g; g = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h = [a, b, c, d, e, g, k, m].map(function (v, q) { return (v + h[q]) | 0; });
  }
  return h.map(function (v) { return ('0000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
}

// Straight to the helper (not DRV.post: no journal entry, no gate), with the user action it belongs to.
function alphaPost(path, body) {
  return fetch(DRV.HELPER + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(logActBody(body || {})) }).then(function (r) { return r.json(); });
}
function alphaVersionText() {
  var v = alpha.st || alpha.ver;
  return v ? 'Open Nova ' + v.version + ' (build ' + v.build + (alpha.st && alpha.st.alpha ? ', alpha' : '') + ')' : 'Open Nova (version unknown)';
}
function alphaTitleText() { var v = alpha.st || alpha.ver; return 'Open Nova' + (v ? ' ' + v.version : ''); }
function alphaTitle() { if (!/alarm/.test(document.title)) document.title = alphaTitleText(); }

function alphaLoad() {
  var ver = fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (v) { alpha.ver = v; alphaTitle(); }, function () { /* opened as a file */ });
  var st = alphaPost('/api/hw/alpha/state', {}).then(function (s) {
    if (!s || !s.ok) return;
    alpha.st = s; alphaTitle();
    document.body.classList.toggle('is-alpha', !!s.alpha);
    if ($('mbReport')) $('mbReport').hidden = !s.alpha;
    if ($('mbAlphaSub')) $('mbAlphaSub').hidden = !s.alpha;
    var u = null; try { u = JSON.parse(localStorage.getItem(ALPHA_UNLOCK_KEY) || 'null'); } catch (e) { /* storage unavailable */ }
    if (u && (u.version !== s.version || u.build !== s.build)) { try { localStorage.removeItem(ALPHA_UNLOCK_KEY); } catch (e) { /* ignore */ } alphaEvent('locked (a new version)'); }
    alphaApplyRO();
    if (s.alpha && !s.consented) alphaIntro(true);
  }, function () { /* an older helper, or none: not the alpha */ });
  return Promise.all([ver, st]).then(function () {
    var v = alpha.st || alpha.ver || {};
    log('app_version', { version: v.version, build: v.build, channel: v.channel, alpha: !!(alpha.st && alpha.st.alpha), readOnly: alphaReadOnly(), unlocked: alphaUnlocked(),
      page: alpha.ver && alpha.st && alpha.ver.build !== alpha.st.build ? 'the page (' + alpha.ver.build + ') and the helper (' + alpha.st.build + ') are different builds' : undefined });
  });
}

// ------------------------------------------------------------------ read-only until unlocked
function alphaReadOnly() { return !!(alpha.st && alpha.st.readOnly); }
// The send token kept in this browser after the code was typed ('' = locked). A build without a code never unlocks.
function alphaToken() {
  if (!alpha.st) return '';
  var u = null; try { u = JSON.parse(localStorage.getItem(ALPHA_UNLOCK_KEY) || 'null'); } catch (e) { return ''; }
  return u && u.version === alpha.st.version && u.build === alpha.st.build && u.token ? u.token : '';
}
function alphaTokenOk(tok, u) { return !!(tok && u && (u.tokenSha256 ? alphaSha256(tok) === u.tokenSha256 : u.sha256 && tok === u.sha256)); }
function alphaUnlocked() { return !!alpha.st && alphaTokenOk(alphaToken(), alpha.st.unlock); }
// The helper's policy (tools/alpha.py classify), the same here, default-deny: 'read' only for what the policy lists.
function alphaClassify(path, body) {
  var pol = alpha.st && alpha.st.policy; if (!pol) return 'read';   // not the alpha (or an older helper): nothing to gate
  path = String(path).split('?')[0]; body = body && typeof body === 'object' ? body : {};
  if ((pol.read || []).indexOf(path) >= 0 || (pol.readPrefix || []).some(function (x) { return path.indexOf(x) === 0; })) return 'read';
  var w = (pol.readWhen || {})[path];
  if (w) { var v = body[w[0]]; return w[1].indexOf(v === undefined ? null : v) >= 0 ? 'read' : 'write'; }
  if (path === '/api/hw/run') {
    var ops = body.plan && body.plan.ops;
    if (!Array.isArray(ops)) return 'write';
    return ops.every(function (o) { return o && (pol.readOps || []).indexOf(o.op) >= 0; }) ? 'read' : 'write';
  }
  return 'write';
}
var ALPHA_POST = DRV.post;
DRV.post = function (family, path, body) {
  if (!alphaReadOnly() || alphaClassify(path, body) === 'read') return ALPHA_POST(family, path, body);
  var tok = alphaToken();
  if (!alphaTokenOk(tok, alpha.st.unlock)) {   // refused here, no call to the processor; the helper notes it (recording + report)
    DRV.note({ t: new Date().toISOString(), family: family, path: path, ok: false, ms: 0, error: ALPHA_RO, act: logAct.cur && logAct.cur.id });
    log('alpha_refused', { path: path, host: body && body.host });
    alphaPost('/api/hw/alpha/refused', { path: path, host: body && body.host, port: body && body.port, what: alphaWhat(path, body) }).catch(function () { /* helper away */ });
    return Promise.resolve({ ok: false, readOnly: true, error: ALPHA_RO });
  }
  var b = {}; for (var k in body || {}) b[k] = body[k];
  b.alphaUnlock = tok;
  return ALPHA_POST(family, path, b);
};
// A few words on a refused request for the report (the helper's describe() does the same for what reaches it).
function alphaWhat(path, body) {
  body = body || {};
  if (path === '/api/hw/run') {
    var ops = (body.plan && body.plan.ops) || [], note = ops.filter(function (o) { return o && o.op === 'note'; })[0];
    return 'plan: ' + ops.filter(function (o) { return o && o.op !== 'note'; }).length + ' ops' + (note ? ' — ' + String(note.text).slice(0, 60) : '');
  }
  return ['action', 'op', 'a', 'mode', 'name', 'level', 'on'].filter(function (k) { return body[k] != null && body[k] !== ''; }).map(function (k) { return String(body[k]).slice(0, 40); }).join(' ');
}
// Grey out what writes, with the reason as the tooltip (and back when unlocked). Run after every render and DOM change.
// Writes greyed out: locked, unless the project's processors are all simulated (drv-offline.js: nothing leaves the app), which
// keeps its buttons; DRV.post above still refuses every write to a real processor.
function alphaGrey() {
  var sim = (P.devices || []).length && P.devices.every(function (d) { return d.hw && d.hw.kind === 'offline'; });
  return alphaReadOnly() && !alphaUnlocked() && !sim;
}
function alphaApplyRO() {
  var on = alphaReadOnly() && !alphaUnlocked(), grey = alphaGrey();
  Array.prototype.forEach.call(document.querySelectorAll(ALPHA_RO_SEL), function (b) {
    if (grey) {
      if (!b.dataset.ro) { b.dataset.ro = b.disabled ? 'was' : '1'; b.dataset.roTitle = b.title || ''; }
      if (!b.disabled) b.disabled = true;
      if (b.title !== ALPHA_RO) b.title = ALPHA_RO;
      b.classList.add('ro-off');
    } else if (b.dataset.ro) {
      if (b.dataset.ro === '1') b.disabled = false;
      b.title = b.dataset.roTitle || ''; delete b.dataset.ro; delete b.dataset.roTitle; b.classList.remove('ro-off');
    }
  });
  var ro = $('mbRO'); if (ro) { ro.hidden = !on; }
  var a = $('mbAllowSend');
  if (a) { a.textContent = alphaReadOnly() && !on ? 'Lock again' : 'Allow sending…'; a.title = on ? 'Switch sending to processors on (asks for the unlock code)' : 'Back to read-only'; }
}
// A write control's own state, set by its module (off + the tooltip): on the button, or — while greyed above — into what
// alphaApplyRO gives back, so a state from before the greying (e.g. "nothing linked" at start-up) never sticks.
function alphaOwn(b, off, tip) {
  if (!b) return;
  if (b.dataset.ro) { b.dataset.ro = off ? 'was' : '1'; if (tip != null) b.dataset.roTitle = tip; return; }
  if (b.disabled !== !!off) b.disabled = !!off;
  if (tip != null && b.title !== tip) b.title = tip;
}
var ALPHA_RENDER = renderAll;
renderAll = function () { var r = ALPHA_RENDER.apply(this, arguments); if (alphaReadOnly()) alphaApplyRO(); return r; };

// ------------------------------------------------------------------ dialogs
function alphaDlg(title, body, foot) {
  $('alTitle').textContent = title; $('alBody').innerHTML = body; $('alFoot').innerHTML = foot; $('alDlg').hidden = false; $('alClose').hidden = alpha.mode === 'intro' && !(alpha.st && alpha.st.consented);
  var f = $('alDlg').querySelector('textarea, input:not([type=checkbox]), .primary'); if (f) setTimeout(function () { f.focus(); }, 0);
}
function alphaDlgClose() { $('alDlg').hidden = true; alpha.mode = ''; }
function alphaEvent(what) {
  alpha.events.push({ t: new Date().toLocaleTimeString(), what: what });
  log('alpha_' + what.split(' ')[0], { what: what });
  alphaPost('/api/hw/alpha/mark', { text: 'Writing ' + what + ' in a browser (' + ((typeof sync !== 'undefined' && sync.id) || '?') + ')' }).catch(function () { /* helper away */ });
}
// The one-screen intro (first start of the alpha, and Settings ▸ Alpha ▸ Intro and your details…).
function alphaIntro(first) {
  var s = alpha.st || {}, t = s.tester || {};
  alpha.mode = 'intro';
  alphaDlg('Open Nova ' + (s.version || '') + ' — alpha',
    '<p><b>Thank you for testing.</b> This alpha records the conversation between Open Nova and your processors, to help us fix things.</p>' +
    '<ul class="al-list"><li>Nothing is sent anywhere unless you send a report (Help ▸ Report a problem…).</li>' +
    '<li>Passwords and logins are never recorded.</li>' +
    '<li>Writing to processors is off: Open Nova finds, reads and monitors them. Anything that changes a processor — Send, Save, blackout, test patterns, identify, mapping, colour — needs the unlock code (Settings ▸ Alpha ▸ Allow sending).</li></ul>' +
    '<details class="al-limits"' + (first ? ' open' : '') + '><summary>Known limits in this alpha</summary><ul class="al-list">' +
      ALPHA_LIMITS.map(function (l) { return '<li><b>' + esc(l[0]) + '</b>' + esc(l[1]) + '</li>'; }).join('') + '</ul></details>' +
    '<div class="grid2 al-who"><label>Your name <input id="alName" type="text" autocomplete="name" value="' + esc(t.name || '') + '"></label>' +
    '<label>Contact <input id="alContact" type="text" autocomplete="email" placeholder="e-mail or phone (optional)" value="' + esc(t.contact || '') + '"></label></div>' +
    '<p class="hint">Optional: only goes into the reports you make.</p>',
    '<span class="grow"></span><button id="alGo" class="primary">' + (first ? 'Start' : 'Save') + '</button>');
  $('alGo').onclick = function () {
    var c = { name: $('alName').value.trim(), contact: $('alContact').value.trim() };
    alphaPost('/api/hw/alpha/set', { consent: c }).then(function (r) { if (r && r.ok) alpha.st = r; alphaApplyRO(); }, function () { /* helper away */ });
    log('alpha_intro', { first: !!first, name: !!c.name, contact: !!c.contact });
    alphaDlgClose();
  };
}
// Settings ▸ Alpha ▸ Allow sending…: the unlock code (or, with none packaged, a warning) — or Lock again.
function alphaUnlockAsk() {
  if (!alphaReadOnly()) return toast('Sending is on in this build');
  if (alphaUnlocked()) return alphaLock();
  var u = alpha.st.unlock;
  alpha.mode = 'unlock';
  if (!u || !u.salt) {   // packaged without a code: this build never writes
    alphaDlg('Allow sending', '<p>This build has no unlock code: it never writes to processors.</p>', '<span class="grow"></span><button id="alCancel" class="primary">OK</button>');
    $('alCancel').onclick = alphaDlgClose; log('alpha_unlock', { ok: false, why: 'no code in this build' }); return;
  }
  alphaDlg('Allow sending', '<p class="rcv-bad">⚠ Send, Save, blackout, test patterns, identify, mapping, colour, service and calibration will write to the processors. A mistake can change or break what a wall shows.</p>' +
    '<form id="alForm" autocomplete="off"><label>Unlock code <input id="alCode" type="password" autocomplete="off"></label></form><p id="alMsg" class="hint" role="status"></p>' +
    '<p class="hint">Stays on in this browser until Settings ▸ Alpha ▸ Lock again (or a new version).</p>',
    '<button id="alCancel">Cancel</button><span class="grow"></span><button id="alGo" class="danger">Allow sending</button>');
  var go = function () {
    var code = $('alCode').value, tok = alphaSha256(u.salt + code + '|send');   // the token the helper checks (tools/alpha.py send_token)
    if (alphaSha256(u.salt + code) !== u.sha256 || (u.tokenSha256 && !alphaTokenOk(tok, u))) {
      $('alMsg').textContent = 'That code isn’t right.'; $('alCode').select(); log('alpha_unlock', { ok: false }); return;
    }
    if (!u.tokenSha256) tok = u.sha256;   // a package made before the send token (2026-10-28)
    try { localStorage.setItem(ALPHA_UNLOCK_KEY, JSON.stringify({ version: alpha.st.version, build: alpha.st.build, token: tok, at: new Date().toISOString() })); } catch (e) { return toast('This browser can’t keep it (storage is off)'); }
    $('alCode').value = '';
    alphaEvent('unlocked');
    alphaDlgClose(); alphaApplyRO(); renderAll(); toast('Sending is on in this browser — Settings ▸ Alpha ▸ Lock again to stop');
  };
  $('alGo').onclick = go; $('alCancel').onclick = alphaDlgClose;
  $('alForm').onsubmit = function (e) { e.preventDefault(); go(); };
}
function alphaLock() {
  try { localStorage.removeItem(ALPHA_UNLOCK_KEY); } catch (e) { /* ignore */ }
  alphaEvent('locked'); alphaApplyRO(); renderAll(); toast('Read-only again: nothing is written to the processors');
}

// ------------------------------------------------------------------ first contact
// A processor found that the catalogue doesn't know: its info (read-only), then the helper's snapshot. Once per model a session.
function alphaFirstContact(found) {
  (found || []).forEach(function (x) {
    if (!x || x.error || !x.ip) return;
    var m = olModel(x), why = '';
    if (!m && olNonLed(x)) return;   // an H's MVR card: known, not an LED output (app-processors.js NON_LED_CARDS)
    if (!m) why = x.modelId != null || (x.senders && x.senders.length) ? 'model not in the catalogue' : 'no model reported';
    else if (x.web && x.web.modelId != null && !hwModelKey(x.web.modelId)) why = 'H chassis model not in the catalogue';
    if (!why) return;
    var key = x.kind + '-' + (x.web && x.web.modelId != null ? 'web' + x.web.modelId : x.modelId != null ? '0x' + (+x.modelId).toString(16).toUpperCase() : 'none') +
      (x.senders && x.senders.length ? '-' + x.senders.map(function (s) { return (+s).toString(16).toUpperCase(); }).join('.') : '');
    if (alpha.fc[key]) return;
    alpha.fc[key] = 1;
    var info = x.kind === 'lct' ? ALPHA_POST('lct', '/api/hw/info', { host: x.ip, port: x.port, functions: true })
      : x.kind === 'unico' || x.kind === 'coex' ? ALPHA_POST(x.kind, '/api/' + x.kind + '/info', { host: x.ip, port: x.port }) : Promise.resolve(null);
    info.then(function (r) { return r; }, function (e) { return { ok: false, error: e.message }; }).then(function (r) {
      log('first_contact', { key: key, why: why, at: x.ip });
      return alphaPost('/api/hw/alpha/first-contact', { key: key, reason: why, host: x.ip, family: x.kind, data: { found: x, info: r } });
    }).catch(function () { /* helper away or older: nothing kept */ });
  });
}
var ALPHA_DISCOVER = DRV.discoverAll;
DRV.discoverAll = function (opts) { return ALPHA_DISCOVER(opts).then(function (all) { try { alphaFirstContact(all); } catch (e) { /* never in the way of a search */ } return all; }); };

// ------------------------------------------------------------------ Help ▸ Report a problem…
// pre = an error caught (alphaErr.list) to preselect; the menu's click event is not one.
// Where reports go (version.json reportContact; the page's own copy when the helper is away), '' for a build without one.
function alphaContact() { var c = String(((alpha.st && alpha.st.reportContact) || (alpha.ver && alpha.ver.reportContact) || '')).trim(); return c && c.charAt(0) !== '(' ? c : ''; }
function alphaReportOpen(pre) {
  var c = alphaContact();
  pre = pre && pre.message != null && pre.id ? pre : null;
  alpha.mode = 'report';
  var box = function (id, label, tip) { return '<label class="chk" title="' + esc(tip) + '"><input type="checkbox" id="' + id + '" checked> ' + esc(label) + '</label>'; };
  var errs = alphaErr.list.slice().reverse();
  alphaDlg('Report a problem', (errs.length ? '<label class="al-what" title="Goes at the top of REPORT.md: its time, action, message, stack, and the log and recorded frames of the 30 s before it">Error to report' +
      '<select id="rpErr"><option value="">(none)</option>' + errs.map(function (e) {
        return '<option value="' + e.id + '"' + (pre && pre.id === e.id ? ' selected' : '') + '>' + esc(new Date(e.t).toTimeString().slice(0, 8) + ' — ' + e.message.slice(0, 70)) + '</option>';
      }).join('') + '</select></label>' : '') +
    '<label class="al-what">What were you doing, and what went wrong?<textarea id="rpText" rows="5" placeholder="e.g. Sent the layout to the H2 and port 3 went dark"></textarea></label>' +
    '<div class="al-inc"><b>Include</b>' +
    box('rpProject', 'The project', 'Screens, cabinets, wiring, processors as Open Nova has them') +
    box('rpRec', 'Recordings of this session', 'Everything Open Nova said to the processors and what they answered (Tools ▸ Diagnostics)') +
    box('rpLogs', 'Logs', 'Open Nova’s own logs: what you clicked, what happened') +
    box('rpProc', 'Processor info', 'Models, IDs, firmware, receiving cards, links, what the search found — read from the processors now, nothing written') +
    box('rpSys', 'System', 'OS, CPU, browser and Python; USB / COM drivers and libraries; the firewall’s rules for Open Nova’s Python; which programs use the search ports; the start window’s text; your name / contact from the intro') +
    // opt-in (app-vendor.js / tools/vendortap.py): NovaLCT / VMP / Unico's own log files, last 3 days, capped, scrubbed
    '<label class="chk" title="NovaLCT, VMP and Unico’s own log files from this computer (last 3 days, at most 40 MB, passwords and keys hidden) — Tools ▸ Vendor Apps"><input type="checkbox" id="rpVendor"' + (typeof vndLogsWanted === 'function' && vndLogsWanted() ? ' checked' : '') + '> NovaStar apps’ logs</label></div>' +
    '<label class="chk" title="Private addresses become device-A, device-B … the same in every file; your home folder becomes ~"><input type="checkbox" id="rpAnon"> Anonymise IP addresses</label>' +
    '<p class="hint">Passwords, tokens and logins are always left out. Nothing is uploaded: you get one .zip to send' + (c ? ' to <b>' + esc(c) + '</b>' : '') + '.</p>' +
    '<p id="rpMsg" class="hint" role="status"></p>',
    '<button id="alCancel">Cancel</button><span class="grow"></span><button id="alGo" class="primary">Make report</button>');
  $('alCancel').onclick = alphaDlgClose; $('alGo').onclick = alphaReportGo;
  log('report_open', { error: pre ? pre.id : undefined });
}
function alphaKb(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
// What the report's REPORT.md is made from (the helper adds its own side).
function alphaSummary(o, reads) {
  var hx = function (v) { return v == null ? null : +v; };
  var errs = [];
  (logState.buf || []).forEach(function (l) {
    var e; try { e = typeof l === 'string' ? JSON.parse(l) : l; } catch (x) { return; }
    if (e && /^client_(error|unhandled)/.test(e.action)) errs.push({ t: e.clientTime, action: e.action, text: (e.details && (e.details.message || e.details.reason)) || '' });
  });
  var cardsOf = function (r) {
    if (!r || !r.ok || !r.cards) return [];
    var by = {}, order = [];
    r.cards.forEach(function (c) {
      var id = c.id || {}, fw = id.fw || {};
      var k = (id.cardName || id.card || (id.modelId != null ? 'card 0x' + (+id.modelId).toString(16).toUpperCase() : 'no answer')) +
        (fw.fpga || fw.mcu ? ' · FPGA ' + (fw.fpga || '?') + ' / MCU ' + (fw.mcu || '?') : id.firmware ? ' · ' + id.firmware : '');
      if (!by[k]) { by[k] = 0; order.push(k); } by[k]++;
    });
    return order.map(function (k) { return k + ' ×' + by[k]; });
  };
  var fwOf = function (d, r) {
    var rows = r && r.ok && r.rows || [], f = rows.filter(function (x) { return /firmware|software|version/i.test(x[0]); }).map(function (x) { return x[1]; });
    if (d.hw && d.hw.web && d.hw.web.sw) f.push('web ' + d.hw.web.sw);
    return f.join('; ');
  };
  return {
    app: { url: location.href, browser: navigator.userAgent, screen: innerWidth + '×' + innerHeight + ' @' + (window.devicePixelRatio || 1), project: P.name,
      mode: typeof olMode === 'function' ? olMode() : '', tab: ui.tab, unlocked: alphaUnlocked(), lockEvents: alpha.events },
    found: o.processors ? (hw.found || []).map(function (x) {
      var m = !x.error && olModel(x), nl = !x.error && !m && olNonLed(x);
      return { kind: x.kind, ip: x.ip, port: x.port, name: x.deviceName, modelId: hx(x.modelId), senders: x.senders || [], sn: x.SN || '',
        firmware: (x.web && x.web.sw) || x.version || '', known: x.error ? null : !!(m || nl), model: m ? procModel(m.key).name : nl || '', why: x.error || '' };
    }) : [],
    devices: o.processors ? (P.devices || []).map(function (d) {
      var lv = hw.live[d.id], n = 0, rd = reads[d.id] || {};
      if (lv) lv.cards.forEach(function (c) { Object.keys(c.ports || {}).forEach(function (p) { n += c.ports[p].length; }); });
      return { name: deviceLabel(d), model: d.model, modelName: procModel(d.model).name, known: !procUnset(d),
        link: d.hw ? { kind: d.hw.kind, host: d.hw.host, port: d.hw.port, name: d.hw.name, modelId: hx(d.hw.modelId), senders: d.hw.senders || [], sn: d.hw.sn || '' } : null,
        detected: lv ? n + ' cabinets' : d.hw ? 'not detected yet' : '', firmware: fwOf(d, rd['device-info']), cards: cardsOf(rd['receiving-cards']) };
    }) : [],
    errors: errs.slice(-50),
    // Monitor's errors kept until Clear (app-health.js hlt.log: still going first), as the tester saw them
    monitor: o.processors && typeof hlt !== 'undefined' ? (hlt.log || []).slice(0, 60).map(function (e) {
      return { t: new Date(e.t).toISOString(), ended: e.ended ? new Date(e.ended).toISOString() : '', level: e.level, dev: e.dev, where: e.where, text: e.text, n: e.n || 1 };
    }) : [],
    failedCalls: DRV.journal.filter(function (e) { return !e.ok; }).slice(-50).map(function (e) { return { t: e.t, path: e.path, ms: e.ms, error: e.error }; })
  };
}
function alphaReportGo() {
  if (alpha.busy) return;
  var o = { project: $('rpProject').checked, recordings: $('rpRec').checked, logs: $('rpLogs').checked, processors: $('rpProc').checked, system: $('rpSys').checked,
    vendorLogs: !!($('rpVendor') && $('rpVendor').checked) };
  var text = $('rpText').value, anon = $('rpAnon').checked;
  var pe = $('rpErr') && $('rpErr').value ? alphaErr.list.filter(function (e) { return String(e.id) === $('rpErr').value; })[0] : null;
  alpha.busy = true; $('alGo').disabled = true; $('rpMsg').textContent = o.processors ? 'Reading the processors (read-only)…' : 'Making the report…';
  log('report_make', { include: o, anonymise: anon, chars: text.length, error: pe ? pe.id : undefined });
  supGather({ project: o.project, logs: o.logs, state: o.logs || o.system, helper: false, readbacks: o.processors, identify: o.processors }).then(function (g) {
    $('rpMsg').textContent = 'Making the report…';
    return alphaPost('/api/hw/report', { text: text, include: o, anonymise: anon, files: g.files, summary: alphaSummary(o, g.reads), prompt: alphaErrPayload(pe) });
  }).then(function (r) {
    alpha.busy = false;
    if (!r || !r.ok) { $('alGo').disabled = false; $('rpMsg').textContent = 'The report failed: ' + ((r && r.error) || 'no answer'); return; }
    alpha.report = r; log('report_saved', { file: r.name, bytes: r.bytes, files: r.files, unknown: r.unknown });
    var c = alphaContact(), gh = !!(alpha.st && alpha.st.repoPublic);   // the GitHub link only once the repository is public (a 404 before)
    $('alBody').innerHTML = '<p><b>Saved:</b> ' + esc(r.name) + ' (' + alphaKb(r.bytes) + ', ' + r.files + ' files)</p><p class="hint al-path">' + esc(r.path || r.dir) + ' — on the computer running Open Nova</p>' +
      (r.unknown ? '<p>It includes ' + r.unknown + ' processor snapshot' + (r.unknown === 1 ? '' : 's') + ' Open Nova didn’t know yet — thank you.</p>' : '') +
      (r.helperDown ? '<p class="rcv-bad">Open Nova’s hardware helper isn’t running, so the processor details are missing. The report has the rest — please send it anyway.</p>' : '') +
      (r.leftOut ? '<p class="hint">Kept small enough to e-mail: ' + r.leftOut + ' older file' + (r.leftOut === 1 ? '' : 's') + ' left out (listed in REPORT.md).</p>' : '') +
      '<p>Please send this file' + (c ? ' to <b>' + esc(c) + '</b>' : '') + '. Nothing was uploaded.</p>' +
      (gh ? '<p><a id="rpGh" href="https://github.com/kman1898/Open-Nova/issues/new/choose" target="_blank" rel="noopener noreferrer" title="Opens GitHub in your browser: paste the issue text there and attach the .zip">Open GitHub issue page</a></p>' : '');
    $('alFoot').innerHTML = '<button id="rpFolder" title="Open the folder on the computer running Open Nova">Show in folder</button><button id="rpIssue" title="A short summary for the issue: version, OS, processor families, the error — no addresses, serials or names">Copy issue text</button><button id="rpDl" title="A copy to this browser’s downloads (another computer or tablet)">Download a copy</button><span class="grow"></span><button id="alGo" class="primary">Done</button>';
    $('alGo').onclick = alphaDlgClose;
    if (gh) $('rpGh').onclick = function () { log('report_github_link', {}); };   // only a link the user opens: the app sends nothing
    $('rpIssue').onclick = function () { var t = alphaIssueText(r, pe); log('report_issue_text', { chars: t.length }); alphaCopy(t, gh ? 'Issue text copied — paste it into the GitHub issue and attach the .zip' : 'Issue text copied — paste it into your message with the .zip'); };
    $('rpFolder').onclick = function () { alphaPost('/api/hw/alpha/reveal', { name: r.name }).then(function (x) { if (!x.ok) toast(x.error); }, function (e) { toast(e.message); }); };
    $('rpDl').onclick = function () {
      var a = document.createElement('a'); a.href = DRV.HELPER + '/api/hw/report/download?name=' + encodeURIComponent(r.name); a.download = r.name;
      document.body.appendChild(a); a.click(); a.remove();
    };
  }, function (e) { alpha.busy = false; $('alGo').disabled = false; $('rpMsg').textContent = 'The report failed: ' + e.message + ' (is Open Nova’s helper running?)'; });
}

// ------------------------------------------------------------------ an unexpected error caught → make a report?
// list = the errors caught this session (newest last, at most 20); seen = how often each distinct error came (shown once);
// wait = one waiting to be shown (held back while a processor operation runs or a send dialog is open); cur = the one shown.
var alphaErr = { seen: {}, list: [], n: 0, wait: null, cur: null, t: 0 };
function alphaErrCaught(kind, message, stack, o) {
  o = o || {};
  message = String(message || 'error').slice(0, 500); stack = String(stack || '').slice(0, 4000);
  var at = stack.split('\n').filter(function (l) { return /:\d+/.test(l); })[0] || '';   // where it was thrown: the same error = the same place
  var key = kind + '|' + message + '|' + at.trim();
  if (alphaErr.seen[key]) { alphaErr.seen[key]++; return null; }
  alphaErr.seen[key] = 1;
  var a = logAct.cur, e = { id: ++alphaErr.n, t: Date.now(), kind: kind, message: message, stack: stack, path: o.path || '',
    act: o.act != null ? o.act : a ? a.id : '', what: o.what != null ? o.what : a ? a.what : '', actN: logAct.n };
  alphaErr.list.push(e); if (alphaErr.list.length > 20) alphaErr.list.shift();
  alphaErrShow(e);
  return e;
}
// Why the notice must wait: a processor operation running (a Send, a Save …) or a dialog of a send / this report open.
function alphaErrBlocked() {
  if (typeof hw !== 'undefined' && hw && hw.busy) return hw.busy;
  return ['rcvDlg', 'svcDlg', 'alDlg'].filter(function (id) { var x = $(id); return x && !x.hidden; })[0] || '';
}
function alphaErrShow(e) {
  if (e) alphaErr.wait = e;
  e = alphaErr.wait; if (!e || !$('errNote')) return;
  if (alphaErrBlocked()) {   // look again shortly (a plain timer: not part of any click)
    if (!alphaErr.t) alphaErr.t = logActNew.st.call(window, function () { alphaErr.t = 0; alphaErrShow(); }, 1500);
    return;
  }
  alphaErr.wait = null; alphaErr.cur = e;
  $('errNote').title = e.message;
  $('errNote').hidden = false;   // never focused: the user's work (and keys) stay where they were
  log('error_prompt', { error: e.id, kind: e.kind, message: e.message.slice(0, 200), errorAct: e.act || undefined, after: Date.now() - e.t });
}
function alphaErrChoose(report) {
  var e = alphaErr.cur; $('errNote').hidden = true; alphaErr.cur = null;
  log('error_prompt_choice', { error: e && e.id, choice: report ? 'make a report' : 'dismiss' });
  if (report && e) alphaReportOpen(e);
}
// What REPORT.md's "Error that prompted this report" is made from: the error, the actions around it (its own and the four
// before, one after; none = the five before it), and this browser's log of the 30 s before it under those actions.
function alphaErrPayload(e) {
  if (!e) return null;
  var m = /^(.*)-(\d+)$/.exec(e.act || ''), tab = m ? m[1] : logAct.tab, n = m ? +m[2] : e.actN, acts = [];
  for (var i = Math.max(1, n - 4); i <= n + (m ? 1 : 0); i++) acts.push(tab + '-' + i);
  var lines = (logState.buf || []).filter(function (l) {
    var x; try { x = JSON.parse(l); } catch (err) { return false; }
    var t = Date.parse(x.clientTime);
    return t >= e.t - 30000 && t <= e.t + 1000 && (x.act ? acts.indexOf(x.act) >= 0 : /^(client_|error_prompt|helper_)/.test(x.action));
  }).slice(-200).map(logFormat);
  return { t: e.t, now: Date.now(), act: e.act, acts: acts, what: e.what, kind: e.kind, path: e.path, message: e.message, stack: e.stack, log: lines };
}
// The issue text: nothing that points at a person or a wall — addresses, serials, MACs, e-mails, paths and the names
// in the project become placeholders.
function alphaIssueClean(s, devices) {
  s = String(s || '');
  (devices || P.devices || []).forEach(function (d) {
    [d.name, d.hw && d.hw.name, d.hw && d.hw.sn, d.hw && d.hw.host, P.name].forEach(function (v) {
      if (v && String(v).length > 2) s = s.split(String(v)).join(/^\d+\./.test(String(v)) ? '<ip>' : '<name>');
    });
  });
  return s.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, '<ip>').replace(/\b[0-9a-f]{2}([:-][0-9a-f]{2}){5}\b/gi, '<mac>').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<e-mail>')
    .replace(/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{8,}\b/g, '<serial>').replace(/([A-Za-z]:\\|\/(Users|home)\/)[^\s'"`]*/g, '<path>');
}
function alphaIssueText(r, e, devices) {
  devices = devices || P.devices || [];
  var fam = {}, order = [];
  devices.forEach(function (d) {
    var m = procModel(d.model), f = (m.family || 'Other') + (d.hw && d.hw.kind === 'offline' ? ' (simulated)' : ''), k = procUnset(d) ? 'model not picked' : m.name;
    if (!fam[f]) { fam[f] = {}; order.push(f); } fam[f][k] = (fam[f][k] || 0) + 1;
  });
  var v = alpha.st || alpha.ver || {}, ua = navigator.userAgent, br = (/(Edg|Firefox|Chrome|Safari)\/(\d+)/.exec(ua) || []).slice(1, 3).join(' ').replace('Edg', 'Edge');
  return ['**Open Nova** ' + (r.version || v.version || '?') + ' (build ' + (r.build || v.build || '?') + ')',
    '**OS:** ' + (r.os || '?') + (br ? ' · ' + br : ''),
    '**Processors:** ' + (order.length ? order.map(function (f) { return f + ': ' + Object.keys(fam[f]).map(function (k) { return k + ' ×' + fam[f][k]; }).join(', '); }).join('; ') : 'none in the project'),
    '**Error:** ' + (e ? '`' + alphaIssueClean(e.message, devices).replace(/`/g, '\'') + '` (' + e.kind + ')' : 'none caught'),
    '', '**What happened:** ', '', 'Report zip attached.'].join('\n');
}
function alphaCopy(text, done) {
  var ok = function () { toast(done); }, fallback = function () {
    var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); ok(); } catch (x) { toast('Copy failed'); } ta.remove();
  };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(ok, fallback); else fallback();
}
// The expected failures are not offered: a processor that didn't answer comes back as a result, and the helper not
// running (a failed fetch) is said where it happens.
window.addEventListener('error', function (e) {
  if (!e || (!e.message && !e.error)) return;
  alphaErrCaught('error', e.message || (e.error && e.error.message), e.error && e.error.stack ? e.error.stack : (e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno);
});
window.addEventListener('unhandledrejection', function (e) {
  var r = e && e.reason, msg = r && r.message ? r.message : String(r);
  if (/Failed to fetch|NetworkError|Load failed|helper not running/i.test(msg)) return;
  alphaErrCaught('rejection', msg, r && r.stack ? r.stack : '');
});
DRV.on('internal', function (x) { alphaErrCaught(/^driver /.test(x.path) ? 'driver' : 'helper', x.error, (x.where || []).join('\n'), { path: x.path, act: x.act, what: x.what }); });

function bindAlpha() {
  $('errNoteGo').onclick = function () { alphaErrChoose(true); };
  $('errNoteNo').onclick = function () { alphaErrChoose(false); };
  $('alClose').onclick = function () { if (alpha.mode === 'intro' && alpha.st && !alpha.st.consented) return; alphaDlgClose(); };
  $('mbReportItem').onclick = alphaReportOpen;
  $('mbReport').onclick = alphaReportOpen;
  $('mbAllowSend').onclick = alphaUnlockAsk;
  $('mbAlphaIntro').onclick = function () { alphaIntro(false); };
  $('mbRO').onclick = alphaUnlockAsk;
  // a greyed write control says why when clicked or tapped: a disabled button does nothing, and touch shows no tooltips
  // (the hit is looked up from the point: some browsers give a disabled button's events to its parent)
  var roSaid = 0;
  document.addEventListener('pointerdown', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.ro-off') : null;
    if (!b && e.isTrusted) { var el = document.elementFromPoint(e.clientX, e.clientY); b = el && el.closest ? el.closest('.ro-off') : null; }
    if (!b || !b.disabled || Date.now() - roSaid < 1500) return;
    roSaid = Date.now(); toast(ALPHA_RO); log('alpha_locked_click', { id: b.id || undefined });
  }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('alDlg').hidden && alpha.mode !== 'intro') alphaDlgClose(); });
  // buttons drawn later by the tabs: greyed as they appear (only while read-only)
  var queued = false;
  new MutationObserver(function () {
    if (queued || !alphaReadOnly()) return;
    queued = true; requestAnimationFrame(function () { queued = false; alphaApplyRO(); });
  }).observe(document.body, { childList: true, subtree: true });
  alphaLoad();
}
