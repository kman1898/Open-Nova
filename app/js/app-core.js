/* Open Nova — open-source control for Nova LED processors: maps panels onto ports, drives the hardware, exports NovaLCT .scr files. */
// app-core.js - constants, app state (P, ui, IS_MAC, keysText), tiny helpers (uid, $, clamp,
// int, key, fmt, esc, toast), project creation / migration (newProject, ensureLct, lctById,
// newScreen) and persistence / undo (snapshot, commit, saveLocal, save, undo, redo,
// replaceProject, fixSel).
// Loads first, right after scr.js (global SCR). Nothing here runs at load beyond plain value
// initialisers; the boot sequence is in main.js.
// Calls into later files at run time only: log, logChange (app-log: every commit, undo, redo
// and message is logged), schedulePush (app-sync), nextFreePort, screenById
// (app-capacity), visibleScreens (app-geometry), renderAll (app-render), ensureDevices
// (app-processors).
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ constants
var STORE_KEY = 'opennova.project.v1';
// Sending cards as NovaLCT numbers them; each can have up to 40 ports.
var MAX_CARD_PORTS = 40;
var SVGNS = 'http://www.w3.org/2000/svg';
// Mac: shortcuts use ⌘ (Ctrl works too) and Option. (Trackpad: scrolling zooms, like on the PC.)
var IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
// Shortcut names in help text, written for Windows, shown the Mac way on a Mac.
function keysText(t) {
  if (!IS_MAC) return t;
  return String(t).replace(/Ctrl\+Alt\+/g, '⌘⌥').replace(/Ctrl\+Shift\+Z/g, '⌘⇧Z').replace(/Ctrl\+Y/g, '⌘⇧Z').replace(/Ctrl\+/g, '⌘')
    .replace(/Ctrl-/g, '⌘-').replace(/\bAlt\b/g, 'Option').replace(/\bDel\b/g, 'Delete');
}

// ------------------------------------------------------------------ state
var P;                    // project (persisted)
var ui = {
  sel: null,              // selected screen id
  tool: null,             // null | 'draw' | 'hole'
  view: null,             // viewBox {x,y,w,h}
  showWires: true, showLabels: true,
  autoErr: {},            // screen id -> problems found while auto-cutting ports
  viewScreen: null,       // id of the LCT screen (tab) being shown
  selKeys: new Set(),     // manual-mode panel selection (keys) on screen selScreen
  selScreen: null,
  marquee: null,          // selection box while dragging, canvas coords
  magnet: true,           // snap moving screens to neighbours / canvas edges
  snapGuides: null,
  undo: [], redo: []
};

function uid() { return Math.random().toString(36).slice(2, 9); }
function $(id) { return document.getElementById(id); }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function int(v, d) { var n = parseInt(v, 10); return isNaN(n) ? d : n; }
function key(c, r) { return c + ',' + r; }
function fmt(n) { return n.toLocaleString('en-US'); }

function esc(t) { return String(t).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }

function toast(msg) {
  log('message', { text: String(msg) });
  var t = $('toast'); t.textContent = keysText(msg); t.hidden = false;
  clearTimeout(ui.toastT); ui.toastT = setTimeout(function () { t.hidden = true; }, 3200);
}

function newProject() {
  var panel = { id: uid(), name: 'Cabinet 176', w: 176, h: 176 };
  return {
    version: 1, name: 'Untitled', canvasW: 3840, canvasH: 2160, bitDepth: 8, refresh: 60,
    devices: [],               // processors, in cascade order (app-processors.js): none until one is added (user, 2026-10-11:
                               // no generic processor); procsChosen = true once the "Which processors?" question was answered
    processors: [],            // their cards (sending cards on a chassis), numbered as in NovaLCT; card.dev = its processor
    panels: [panel],
    lct: [{ id: uid(), name: 'Screen 1' }],   // LCT screens (the tabs)
    screens: []                               // sections: panel blocks, each on one LCT screen (screenId)
  };
}

// Projects saved before screens/sections were split: each old screen becomes its own LCT screen.
function ensureLct(pj) {
  if (!pj.lct) {
    pj.lct = [];
    pj.screens.forEach(function (s, i) {
      var id = uid();
      pj.lct.push({ id: id, name: s.name || ('Screen ' + (i + 1)) });
      s.screenId = id; s.name = 'Section 1';
    });
  }
  if (!pj.lct.length) pj.lct.push({ id: uid(), name: 'Screen 1' });
  pj.screens.forEach(function (s) { if (!pj.lct.some(function (l) { return l.id === s.screenId; })) s.screenId = pj.lct[0].id; });
  pj = ensureDevices(pj);   // processors (app-processors.js)
  // a screen belongs to one processor: one on several (an old file, an import, a read-back) is split, and the user told
  var sp = typeof lctSplitShared === 'function' ? lctSplitShared(pj) : [];
  if (sp.length) setTimeout(function () { toast('A screen belongs to one processor, so ' + (sp.length === 1 ? 'a screen was' : sp.length + ' screens were') + ' split: ' + sp.join('; ')); }, 1200);
  return pj;
}
function lctById(id) { return P.lct.find(function (l) { return l.id === id; }); }

function newScreen(x, y) {
  var nf = lctFreePort(ui.viewScreen, null);   // on the shown screen's processor (app-capacity.js)
  return {
    id: uid(), name: 'Section ' + (visibleScreens().length + 1), screenId: ui.viewScreen, x: x || 0, y: y || 0, cols: 10, rows: 5,
    panelId: P.panels[0] && P.panels[0].id, holes: {}, manual: {}, override: {},
    wiring: { mode: 'auto', corner: 'TL', dir: 'V', pattern: 'serpentine', split: 'lines', max: 0, restart: 'continue', sender: nf.sender, port: nf.port }
  };
}

// ------------------------------------------------------------------ persistence / undo
function snapshot() { return JSON.stringify(P); }
function commit() {
  var before = ui.lastSnap;
  ui.undo.push(before);
  if (ui.undo.length > 80) ui.undo.shift();
  ui.redo = [];
  ui.lastSnap = snapshot();
  logChange(before);   // what this edit changed, before -> after
  save();
}
function saveLocal() { try { localStorage.setItem(STORE_KEY, ui.lastSnap || snapshot()); } catch (e) { /* storage unavailable */ } }
function save() { saveLocal(); schedulePush(); if (typeof liveApplySchedule === 'function') liveApplySchedule(); }   // live apply: app-save.js

function undo() {
  if (!ui.undo.length) return log('undo', { skipped: 'nothing to undo' });
  var before = snapshot();
  ui.redo.push(before); P = JSON.parse(ui.undo.pop()); ui.lastSnap = snapshot();
  log('undo', { left: ui.undo.length }); logChange(before);
  save(); fixSel(); renderAll();
}
function redo() {
  if (!ui.redo.length) return log('redo', { skipped: 'nothing to redo' });
  var before = snapshot();
  ui.undo.push(before); P = JSON.parse(ui.redo.pop()); ui.lastSnap = snapshot();
  log('redo', { left: ui.redo.length }); logChange(before);
  save(); fixSel(); renderAll();
}
// New / Open / Import: the old project stays one Ctrl+Z away; redo history is dropped.
function replaceProject(pj) {
  ui.undo.push(ui.lastSnap || snapshot()); if (ui.undo.length > 80) ui.undo.shift();
  ui.redo = [];
  P = pj; ui.lastSnap = snapshot(); save();
  log('project_replaced', { name: P.name, screens: P.lct.length, sections: P.screens.length, cards: P.processors.length });
  ui.viewScreen = null; ui.mSender = 0; ui.mPort = 0; ui.sel = null; ui.tool = null; ui.view = null;
  ui.selKeys = new Set(); ui.selScreen = null; ui.autoErr = {};
  renderAll();
}
function fixSel() {
  if (!lctById(ui.viewScreen)) ui.viewScreen = P.lct[0].id;
  var vis = visibleScreens();
  if (!vis.some(function (s) { return s.id === ui.sel; })) ui.sel = vis[0] ? vis[0].id : null;
  var ss = screenById(ui.selScreen);
  if (!ss || ss.wiring.mode !== 'manual') { ui.selKeys = new Set(); ui.selScreen = null; }
  if (!P.panels.some(function (p) { return p.id === ui.drawPanelId; })) ui.drawPanelId = P.panels[0] && P.panels[0].id;   // Self-draw panel (Panel library)
  // active sending card / port (undo, redo or a sync pull can remove cards)
  if (ui.mSender == null || ui.mSender >= P.processors.length) ui.mSender = Math.max(0, P.processors.length - 1);
  if ((ui.mPort || 0) >= (P.processors[ui.mSender] || {}).ports) ui.mPort = 0;
  if (typeof lctFitCard === 'function') lctFitCard();   // ... and on the shown screen's processor (app-sections.js)
}
