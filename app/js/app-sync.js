// app-sync.js - the shared projects on the server (serve.ps1 / serve.py): the sync state object, pushing
// every save up (schedulePush / pushProject), pulling other browsers' saves (busyHere,
// pullProject, retryPending), the live Server-Sent Events connection (listen) and syncStart; and the
// server's project list in Project ▾ (projShared, projSwitched, projMenuFill, projOpen, projNew,
// projDuplicate, projRename, projRemove, projRestore = the removed ones back), as Unico's project list / VMP's projects, and
// the online / offline workspaces (projShow, projWorkspace; VMP: Online Project / Offline Project).
// Registers document listeners at load (pointerdown/up/cancel/move, focusout,
// visibilitychange); they only read/write ui and sync when they fire.
// Depends on: app-core ($, P, ui, snapshot, saveLocal, ensureLct, fixSel), app-context-menu
// (closeMenu), app-render (renderAll), app-health (hltErrLoad, hltErrEvent: the kept monitor errors, when loaded),
// app-online (olMode, olWorkspace), all at run time.
// syncStart is called from main.js.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ---- Shared project on the server (serve.ps1), the way LED Raster Designer does it: the
// server's copy IS the project. A browser shows whatever the server has, sends every change up
// (latest save wins), and the server pushes each save to every other open browser at once over
// a live connection (Server-Sent Events). Undo/redo stay per browser and simply save the
// restored project. Opened as a plain file (no server), the project lives in this browser only.
// The server keeps a list of projects with one "current" for everybody: sync.project = its id here
// ('' = an old server, or nothing there yet). Every save names its project, so a save that arrives
// after another browser switched lands in the project it was made in.
var sync = { on: false, rev: 0, dirty: false, busy: false, t: null, pending: false, project: '', own: null,
  id: Math.random().toString(36).slice(2, 10) };
function syncState(text, cls) {
  var el = $('syncState'); if (!el) return;
  el.hidden = false; el.textContent = text; el.className = 'sync' + (cls ? ' ' + cls : '');
  el.title = cls === 'off' ? 'Opened without the server: the project is saved in this browser only'
    : 'Every browser that opens this app from the same server sees and edits the same project';
}
function schedulePush() {
  if (!sync.on) return;
  sync.dirty = true; clearTimeout(sync.t); sync.t = setTimeout(pushProject, 150);
}
function pushProject() {
  if (!sync.on || !sync.dirty) return;
  if (sync.busy) { clearTimeout(sync.t); sync.t = setTimeout(pushProject, 100); return; }
  sync.busy = true; sync.dirty = false;
  fetch('api/project', { method: 'PUT', body: ui.lastSnap || snapshot(), headers: { 'Content-Type': 'application/json', 'X-Client': sync.id,
    'X-Project': sync.project, 'X-Project-Name': encodeURIComponent(P.name || ''), 'X-Project-Mode': typeof olMode === 'function' ? olMode() : '' } })
    .then(function (r) {
      sync.busy = false;
      if (r.status === 410) {   // removed in another browser meanwhile: the edit has nowhere to go; show the current project
        log('sync_push_refused', { project: sync.project, name: P.name, why: 'the project was removed in another browser' });
        toast('“' + P.name + '” was removed in another browser — your last edit to it wasn’t kept');
        sync.dirty = false; clearTimeout(sync.t); pullProject(); return;
      }
      if (!r.ok) throw new Error('Server error ' + r.status);
      sync.rev = +r.headers.get('X-Rev'); if (!sync.project) sync.project = r.headers.get('X-Project') || '';
      syncState('Shared');
      retryPending();
    })
    .catch(function (err) {
      sync.busy = false; sync.dirty = true;
      log('sync_push_failed', { error: err.message, retry_in_s: 3 });
      syncState((/^Server error/.test(err.message) ? err.message : 'Server unreachable') + ' — saved in this browser', 'err');
      clearTimeout(sync.t); sync.t = setTimeout(pushProject, 3000);
    });
}
// Another browser saved: fetch the project and show it. Waits while this browser is in the
// middle of something (a drag, a text field, an open menu, its own unsent change).
function busyHere() {
  var a = document.activeElement, typing = a && /INPUT|SELECT|TEXTAREA/.test(a.tagName);
  return ui.pointerDown || typing || !$('ctxMenu').hidden || sync.dirty || sync.busy;
}
function pullProject() {
  if (busyHere()) {
    if (!sync.pending) log('sync_pull_deferred', { dragging: !!ui.pointerDown, typing: !!(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)), unsent_edit: sync.dirty || sync.busy });
    sync.pending = true; return;
  }
  sync.pending = false; sync.busy = true;
  fetch('api/project', { cache: 'no-store' }).then(function (r) {
    var rev = +r.headers.get('X-Rev'), pid = r.headers.get('X-Project') || '';
    if (!r.ok) { sync.busy = false; sync.rev = rev; return; }
    return r.text().then(function (t) {
      sync.busy = false;
      if (sync.dirty) { sync.pending = true; return; }   // an edit started meanwhile: it wins (and goes to its own project)
      if (sync.project && pid && pid !== sync.project) {  // the current project changed (New / Open / Remove)
        var mine = sync.own === pid; sync.own = null;
        projSwitched(t, pid, rev, mine ? 'opened here' : 'switched in another browser');
        var after = mine && projAfter; projAfter = null;
        if (after) after(); else if (!mine) toast('Project “' + P.name + '” opened — switched in another browser');
        return;
      }
      sync.rev = rev; if (pid) sync.project = pid;
      if (t === ui.lastSnap) return;
      var before = ui.lastSnap;
      P = ensureLct(JSON.parse(t)); ui.lastSnap = snapshot(); saveLocal();
      log('sync_pulled', { rev: rev, note: 'edit from another browser' }); logChange(before);
      closeMenu(); ui.autoErr = {}; fixSel(); renderAll();
      syncState('Shared');
    });
  }).catch(function (err) { sync.busy = false; sync.pending = true; log('sync_pull_failed', { error: String(err && err.message || err) }); });
}
function retryPending() { if (sync.pending) setTimeout(function () { if (sync.pending) pullProject(); }, 50); }
function listen() {
  if (!window.EventSource) { setInterval(pullProject, 3000); return; }   // very old browser: poll
  var es = new EventSource('api/events');
  es.onopen = function () {      // (re)connected: catch up (the project, the kept monitor errors)
    log('sync_connected', { rev: sync.rev }); syncState('Shared'); pullProject();
    if (typeof hltErrLoad === 'function') hltErrLoad();
  };
  es.onerror = function () { log('sync_disconnected', { state: es.readyState === 2 ? 'closed' : 'reconnecting' }); syncState('Reconnecting…', 'err'); };
  es.onmessage = function (ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.switch !== undefined) { if (m.switch !== sync.project && m.from !== sync.id) pullProject(); return; }   // New / Open / Remove elsewhere (ours: handled where it was asked)
    if (m.errors !== undefined) { if (m.from !== sync.id && typeof hltErrEvent === 'function') hltErrEvent(m); return; }   // kept monitor errors (app-health.js)
    if (m.preview !== undefined) { if (m.from !== sync.id && typeof pvEvent === 'function') pvEvent(m); return; }   // a content-preview picture (app-preview.js)
    if (m.project && sync.project && m.project !== sync.project) return;   // a save to another project (made before a switch)
    if (m.from === sync.id) { sync.rev = Math.max(sync.rev, m.rev); return; }   // our own save
    if (m.rev !== sync.rev) pullProject();
  };
}
function syncStart() {
  if (!/^https?:$/.test(location.protocol)) { log('sync_start', { mode: 'this browser only', why: 'opened as a file' }); syncState('This browser only', 'off'); return; }
  fetch('api/project', { cache: 'no-store' }).then(function (r) {
    sync.on = true;
    sync.rev = +r.headers.get('X-Rev') || 0; sync.project = r.headers.get('X-Project') || '';
    if (r.status === 404) {        // nothing on the server yet: the first browser shares its project
      log('sync_start', { mode: 'shared', server_project: 'none yet', action: P.screens.length ? 'sharing this browser\'s project "' + P.name + '"' : 'waiting (this browser\'s project is empty)' });
      if (P.screens.length) { sync.dirty = true; pushProject(); } else syncState('Shared');
      return;
    }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text().then(function (t) {
      log('sync_start', { mode: 'shared', rev: sync.rev, action: t === ui.lastSnap ? 'already up to date' : 'opened the server\'s project' + (P.screens.length ? ' (this browser\'s "' + P.name + '" kept one undo away)' : '') });
      if (t !== ui.lastSnap) {
        // The server's project is the one everybody sees. What this browser had open is kept
        // one Ctrl+Z away, in case it was work that never reached the server.
        if (P.screens.length) ui.undo.push(ui.lastSnap);
        P = ensureLct(JSON.parse(t)); ui.lastSnap = snapshot(); saveLocal();
        ui.view = null; ui.autoErr = {}; fixSel(); renderAll();
      }
      syncState('Shared');
    });
  }).then(listen).catch(function (err) {
    sync.on = false; syncState('This browser only', 'off');
    log('sync_start', { mode: 'this browser only', why: String(err && err.message || err) });
  });
}

// ---- The server's project list (Project ▾), as Unico's project list / VMP's projects. One project is current for every
// browser: New, Duplicate, Open and Remove switch all of them; Rename is the project's name (saved like any edit).
// Switching never sends anything to the processors; each project keeps its own processor links; undo stays per project.
function projShared() { return sync.on && !!sync.project; }
function projSwitched(t, pid, rev, why) {   // show project pid (its JSON text t) instead of the one this browser had
  var was = P.name;
  sync.project = pid; sync.rev = rev; sync.pending = false;
  projShow(t);
  log('project_switched', { to: P.name, id: pid, rev: rev, from_project: was, why: why, workspace: typeof olMode === 'function' ? olMode() : undefined });
}
function projShow(t) {   // project JSON text t replaces the open one: nothing of the old one stays (undo, selection, bars)
  P = ensureLct(JSON.parse(t)); ui.lastSnap = snapshot(); saveLocal();
  ui.undo = []; ui.redo = [];   // Ctrl+Z must never bring another project's content into this one
  ui.viewScreen = null; ui.mSender = 0; ui.mPort = 0; ui.sel = null; ui.tool = null; ui.view = null;
  ui.selKeys = new Set(); ui.selScreen = null; ui.autoErr = {};
  if (typeof liveLoad === 'function') { liveLoad(); renderUnsaved(); }              // app-save.js (+ its "not saved" bar)
  if (typeof rb !== 'undefined' && rb.pending) { rb.pending = null; rbBar(); }       // app-readback.js: about the old project
  if (typeof devPick !== 'undefined' && devPick.open) devClosePicker();              // app-devices.js: it would act on the new project
  if (typeof hltErrLoad === 'function') hltErrLoad();                                 // app-health.js: that project's kept errors
  closeMenu(); fixSel(); renderAll(); if (sync.on) syncState('Shared');
  if (typeof setTab === 'function') setTab('dashboard');   // another project opens on its dashboard, as in VMP (app-shell.js)
}
// Tools ▸ Enter / Exit offline mode (app-online.js olWorkspace): open workspace m's most recently used project, or a new
// empty one when it has none; the project left stays in its own workspace (nothing deleted). done(made) after the switch.
// Without the server's list the other workspace's project is kept in this browser (WS_KEY + mode).
var WS_KEY = 'opennova.workspace.';
function projWorkspace(m, done) {
  var fresh = function () { var pj = ensureLct(newProject()); pj.name = m === 'offline' ? 'Offline project' : 'Online project'; pj.mode = m; return pj; };
  if (!projShared()) {
    var keep = null;
    try { localStorage.setItem(WS_KEY + olMode(), ui.lastSnap || snapshot()); keep = JSON.parse(localStorage.getItem(WS_KEY + m) || 'null'); } catch (e) { /* storage unavailable */ }
    var made = !(keep && keep.screens), was = P.name;
    if (made) keep = fresh(); keep.mode = m;
    projShow(JSON.stringify(keep));
    log('project_switched', { to: P.name, from_project: was, why: 'workspace ' + m, made: made, shared: false });
    if (done) done(made);
    return;
  }
  projFlush(function () {
    fetch('api/projects', { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('server error ' + r.status); return r.json(); }).then(function (L) {
      var pick = L.projects.filter(function (p) { return p.mode === m && p.id !== sync.project; }).sort(function (a, b) { return b.opened - a.opened; })[0];
      if (!pick) return projCreate(fresh(), function () { if (done) done(true); }, m);
      return projApi('open?id=' + encodeURIComponent(pick.id)).then(function () { sync.own = pick.id; projAfter = function () { if (done) done(false); }; pullProject(); });
    }).catch(function (e) { toast('Couldn’t switch: ' + e.message); });
  });
}
var projAfter = null;   // what projWorkspace does once the project it opened has arrived (pullProject)
// once this browser's unsent edit has reached the server (it belongs to the project it was made in)
function projFlush(fn, n) {
  if (!sync.dirty && !sync.busy) return fn();
  if ((n || 0) > 100) return toast('The server isn’t answering — try again');
  if (sync.dirty && !sync.busy) { clearTimeout(sync.t); pushProject(); }
  setTimeout(function () { projFlush(fn, (n || 0) + 1); }, 100);
}
function projApi(path, body) {
  return fetch('api/projects/' + path, { method: 'POST', body: body || '', headers: { 'Content-Type': 'application/json', 'X-Client': sync.id } })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok || !j.ok) throw new Error(j.error || 'server error ' + r.status); return j; }); });
}
var projList = [];   // the server's list as last read (Project ▾)
// view 'removed': the list shows the removed projects (projects/removed on the server), a click restores one. Only the
// open workspace's projects are listed (VMP: Online Project / Offline Project); its header switches workspace.
function projMenuFill(view) {
  var box = $('projList'), on = projShared(), ws = olMode();   // app-online.js
  ['btnProjDup', 'btnProjRemove', 'btnProjRemoved', 'fileIntoRow'].forEach(function (id) { if ($(id)) $(id).hidden = !on; });
  var fo = $('fileOpen') && $('fileOpen').parentNode;   // without the list, Open file… goes into this project
  if (fo && fo.dataset.off) { fo.dataset.on = fo.dataset.on || fo.title; fo.title = on ? fo.dataset.on : fo.dataset.off; }
  if (!box) return;
  box.hidden = !on; if (!on) return;
  if (on && $('btnProjRemoved')) fetch('api/projects/removed', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (R) {
    var rm = (R && R.removed || []).filter(function (p) { return !p.mode || p.mode === ws; }), n = rm.length;
    $('btnProjRemoved').hidden = !n; $('btnProjRemoved').textContent = 'Removed (' + n + ')';
    if (view !== 'removed') return;
    box.innerHTML = '<div class="proj-head">Removed ' + ws + ' projects<button class="proj-back" data-projback title="Back to the projects">‹ Back</button></div>' + rm.map(function (p) {
      return '<button role="menuitem" class="proj-row" data-restore="' + esc(p.file) + '" title="' + esc('Restore — it comes back into the list and every browser on this server switches to it · removed ' +
        new Date(p.modified).toLocaleString()) + '"><span class="proj-tick">↺</span>' + esc(p.name) + '</button>';
    }).join('');
  }).catch(function () { $('btnProjRemoved').hidden = true; });
  if (view === 'removed') return;
  fetch('api/projects', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (L) {
    if (!L) { box.hidden = true; return; }
    projList = L.projects.filter(function (p) { return p.id === sync.project || (p.mode || 'online') === ws; })
      .sort(function (a, b) { return (b.id === L.current) - (a.id === L.current) || b.opened - a.opened; });
    box.innerHTML = '<div class="proj-head proj-ws" role="group" aria-label="Online or offline projects">' + ['online', 'offline'].map(function (m) {
      return '<button data-ws="' + m + '"' + (m === ws ? ' class="on" aria-pressed="true" title="The ' + m + ' projects, listed below"' : ' aria-pressed="false" title="' +
        (m === 'offline' ? 'Enter offline mode: the projects designed without hardware' : 'Exit offline mode: the projects with real processors') + ' (Tools ▸ ' + (m === 'offline' ? 'Enter' : 'Exit') + ' offline mode)"') +
        '>' + (m === 'online' ? 'Online' : 'Offline') + ' projects</button>';
    }).join('') + '</div>' + projList.map(function (p) {
      var cur = p.id === sync.project;
      return '<button role="menuitemradio" aria-checked="' + cur + '" class="proj-row' + (cur ? ' on' : '') + '" data-pid="' + esc(p.id) + '" title="' +
        esc((cur ? 'Open now' : 'Open this project — every browser on this server switches to it') + (p.modified ? ' · saved ' + new Date(p.modified).toLocaleString() : '')) +
        '"><span class="proj-tick">' + (cur ? '✓' : '') + '</span>' + esc(p.name) + '</button>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-ws]'), function (b) {
      b.onclick = function (e) { if (b.dataset.ws === olMode()) return e.stopPropagation(); olWorkspace(b.dataset.ws, 'File ▸ ' + b.textContent); };   // app-online.js
    });
    $('btnProjRemove').disabled = L.projects.length < 2;
    $('btnProjRemove').title = L.projects.length < 2 ? 'The only project can’t be removed (make another one first)' : 'Remove this project from the list — its file moves to the server’s projects/removed folder (nothing is deleted)';
  }).catch(function () { box.hidden = true; });
}
function projOpen(id) {
  if (!projShared() || id === sync.project) return;
  var p = projList.filter(function (x) { return x.id === id; })[0];
  log('project_open', { id: id, name: p && p.name, from_project: P.name });
  projFlush(function () {
    projApi('open?id=' + encodeURIComponent(id)).then(function () { sync.own = id; pullProject(); },
      function (e) { toast('Couldn’t open the project: ' + e.message); });
  });
}
// New / Duplicate: the project is made here and handed to the server, which makes it current for everybody.
// A new project belongs to the open workspace (mode: another one, projWorkspace).
function projCreate(pj, then, mode) {
  pj.mode = mode || olMode();   // app-online.js
  projFlush(function () {
    var t = JSON.stringify(pj);
    projApi('new?name=' + encodeURIComponent(pj.name || '') + '&mode=' + pj.mode, t).then(function (j) {
      projSwitched(t, j.id, j.rev, 'created here'); if (then) then();
    }, function (e) { toast('Couldn’t create the project: ' + e.message); });
  });
}
function projNew() {
  var nm = prompt('New project name:', 'Project ' + (projList.length + 1)); if (nm == null) return log('new_project', { cancelled: true });
  var pj = ensureLct(newProject()); pj.name = nm.trim() || 'Untitled';
  log('new_project', { name: pj.name, previous: P.name, shared: true });
  projCreate(pj, function () { devOpenPicker({ first: true }); });   // "Which processors are you using?" (app-devices.js)
}
function projDuplicate() {
  var nm = prompt('Name of the copy:', P.name + ' copy'); if (nm == null) return;
  var pj = JSON.parse(ui.lastSnap || snapshot()); pj.name = nm.trim() || P.name + ' copy';
  log('duplicate_project', { from: P.name, to: pj.name });
  projCreate(pj, function () { toast('Duplicated — now in “' + P.name + '”'); });
}
function projRename() {
  var nm = prompt('Project name:', P.name); if (nm == null || !nm.trim() || nm.trim() === P.name) return;
  log('rename_project', { from: P.name, to: nm.trim() });
  P.name = nm.trim(); commit(); renderAll();   // the save carries the name to the server's list
}
function projRemove() {
  if (!projShared() || projList.length < 2) return;
  if (!confirm('Remove project “' + P.name + '”?\n\nIt leaves the list and its file moves to the server’s projects/removed folder — nothing is deleted. ' +
      'Every browser switches to the most recently opened other project.')) return log('remove_project', { cancelled: true });
  var id = sync.project, nm = P.name;
  projFlush(function () {
    projApi('remove?id=' + encodeURIComponent(id)).then(function (j) {
      log('remove_project', { id: id, name: nm, now: j.current }); sync.own = j.current; pullProject();
      toast('Removed “' + nm + '” (kept in the server’s projects/removed folder)');
    }, function (e) { toast('Couldn’t remove the project: ' + e.message); });
  });
}

function projRestore(file) {
  if (!projShared()) return;
  log('restore_project', { file: file, from_project: P.name });
  projFlush(function () {
    projApi('restore?file=' + encodeURIComponent(file)).then(function (j) {
      sync.own = j.id; pullProject(); toast('Restored — now in the list again and open');
    }, function (e) { toast('Couldn’t restore the project: ' + e.message); });
  });
}

document.addEventListener('pointerdown', function () { ui.pointerDown = true; }, true);
document.addEventListener('pointerup', function () { ui.pointerDown = false; retryPending(); }, true);
document.addEventListener('pointercancel', function () { ui.pointerDown = false; retryPending(); }, true);
document.addEventListener('pointermove', function (e) { if (!e.buttons && ui.pointerDown) { ui.pointerDown = false; retryPending(); } }, true);   // released outside the window
document.addEventListener('focusout', retryPending);
document.addEventListener('visibilitychange', function () { if (!document.hidden && sync.on) pullProject(); });
