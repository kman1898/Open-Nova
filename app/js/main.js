// main.js - boot: load the project from this browser's storage (load), set up the UI
// (bindForms, bindCanvas), first render, start server sync, and the window.OpenNova test
// hook. Must load last: this is the only file that runs app code at load time.
// Depends on: every app-*.js file.
// Classic script, not an ES module: modules do not load from file://, and the app must run
// when index.html is double-clicked. Every top-level var/function in these files is one
// shared global, so a name must be defined in exactly one file (tests/check-modules.html checks).
'use strict';

// ------------------------------------------------------------------ boot
function load() {
  try { var raw = localStorage.getItem(STORE_KEY); if (raw) { var pj = JSON.parse(raw); if (pj && pj.screens) return ensureLct(pj); } } catch (e) { /* ignore */ }
  return null;
}
P = load() || newProject();
ui.lastSnap = snapshot();
if (IS_MAC) {   // help text and tooltips name the Mac keys
  Array.prototype.forEach.call(document.querySelectorAll('.hint, label, [title]'), function (n) {
    if (n.title) n.title = keysText(n.title);
    if (n.classList.contains('hint') && !n.children.length) n.textContent = keysText(n.textContent);
  });
  // tooltips drawn later by the tabs, and the confirm / alert questions, too
  document.addEventListener('pointerover', function (e) {
    var n = e.target.closest && e.target.closest('[title]'), k = n && keysText(n.title);
    if (n && k !== n.title) n.title = k;
  }, true);
  var nativeConfirm = window.confirm, nativeAlert = window.alert;
  window.confirm = function (m) { return nativeConfirm.call(window, m == null ? m : keysText(m)); };
  window.alert = function (m) { return nativeAlert.call(window, m == null ? m : keysText(m)); };
}
log('client_ready', { ua: navigator.userAgent, platform: navigator.platform, url: location.href,
  window: innerWidth + '×' + innerHeight, project: P.name, screens: P.lct.length, sections: P.screens.length });
// Trace mode stays on across reloads (so a problem at start-up can be traced too).
try { if (localStorage.getItem('opennova.trace') === 'on') logSetTrace(true); } catch (e) { /* storage unavailable */ }
bindTips();        // the ⓘ help tips (app-tips.js)
bindForms(); bindCanvas();
$('btnLogs').onclick = logOpenViewer;
bindScreenFit();   // Match Screen, rotation buttons, Coords (app-screenfit.js)
bindArrange();     // multi-select, align / distribute / lock, grid (app-arrange.js)
bindDevices();     // the Processors tab (app-devices.js)
bindShell();       // the tabs, the menu bar (app-menubar.js), Alt+1…9, "?" sheet and key guard (app-shell.js; after bindDevices so its picker gets keys first)
bindHardware();    // the Processors tab's Hardware card: find / link / detect / send (app-hardware.js)
bindOnline();      // Online / Offline (what Add processor lists), the H login dialog (app-online.js)
bindNetwork();     // Settings ▸ Network…: interfaces searched, what can open the app; hot-plug check (app-network.js)
bindSave();        // Send ▾ / Save / unsaved banner / live apply / Compare (app-save.js)
bindDisplay();     // Blackout / Freeze / Normal, Test ▾, Identify, Mapping (app-display.js)
bindPipeline();    // the pro look's header: pipeline strip + view-tabs row (app-pipeline.js)
bindControls();    // the pro look's segmented buttons, spin boxes, slider fill (app-controls.js)
bindPreview();     // View ▸ Content: a picture under the cabinets (app-preview.js)
bindNavigator();   // View ▸ Navigator: the small map at the canvas's bottom right (app-navigator.js)
bindHealth();      // the Monitor tab and the Layout canvas's Live view (app-health.js)
bindSupport();      // Tools ▸ Support bundle (app-support.js)
bindService();      // Processors ▸ Hardware ▸ Service: restart / factory reset behind a caution dialog (app-service.js)
bindDiag();         // Tools ▸ Diagnostics: the helper's flight recorder (app-diag.js)
bindReadback();     // read the layout the processors hold (by hand, and automatically when nothing would be lost) (app-readback.js)
bindLibrary();      // Tools ▸ Cabinet library (app-library.js)
bindRcvGuard();    // Maintain ▸ Send receiving-card file, with the file guard (app-rcvguard.js)
bindWatch();       // Monitor alarm limits, °C / °F, history, alerts (app-watch.js)
bindScreen();      // the Screen Settings tab (app-screen.js)
bindCorrection();  // the Correction tab (app-correction.js)
bindRedundancy();  // the Backup tab's Verify buttons (app-redundancy.js)
bindPresets();     // the Preset tab's scenes (app-presets.js)
bindMaintain();    // Tools ▸ Maintain (app-maintain.js)
bindDashboard();   // the project dashboard (app-dashboard.js)
bindInterchange(); // File ▸ Import Project File… / Import Screen Config File… (app-interchange.js)
bindSchedule();    // the Schedule tab (app-schedule.js)
bindAlpha();       // version, the alpha's intro / read-only / Report a problem, first-contact snapshots (app-alpha.js)
bindVendor();      // Tools ▸ Vendor Apps: NovaLCT / VMP / Unico here, their logs, Wireshark captures, the relay (app-vendor.js)
bindLut3d();       // File ▸ Open LUT…: a 3-D LUT as a small 3-D picture, view only (app-lut3d.js)
fixSel();
renderAll();
devFirstRun();     // a project with nothing set up yet: "Which processors are you using?"
syncStart();

window.OpenNova = window.LEDMapper = { get project() { return P; }, importScr: importScr, toScrModel: toScrModel, allCells: allCells, render: renderAll,
  ops: { reversePort: reversePort, toggleHole: toggleHole, addToCurrentPort: addToCurrentPort, arrowStep: arrowStep, autoAssign: autoAssign, commit: commit,
    portUsage: portUsage, problems: problems, portCap: portCap, capacity: capacity, newScreen: newScreen },
  select: function (screenId, keys, sender, port) {
    ui.sel = screenId; ui.selScreen = screenId; ui.selKeys = new Set(keys);
    if (sender != null) { ui.mSender = sender; ui.mPort = port; }
    renderAll();
  },
  applyPattern: function (c, d, r) { applyPattern(c, d, r); },
  setProject: function (pj) { P = ensureLct(pj); ui.lastSnap = snapshot(); fixSel(); renderAll(); } };
