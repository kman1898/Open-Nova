// app-controls.js - the pro look's controls (docs/PRO_LOOK_PLAN.md §4): segmented buttons for the short drop-downs, spin
// boxes for the number fields of the side panels, the filled part of the sliders. Proxies only: the <select> / <input>
// stays in the page with its id and stays the source of truth — a click sets its value and fires the same bubbling
// change / input events a person would, so every existing handler (onOut, onScr, #scForm's delegated listener) runs
// unchanged. Idempotent (an element done is marked data-ctl); pro look only; runs at the end of renderAll and when a side
// panel is rebuilt (MutationObserver), and leaves a control being used alone (#scForm keeps it: scr.keepForm).
// Spin boxes: hold = repeat every 120 ms, with one change at release (one undo step; live colour sends one at a time).
// Owns: CTL_SEG, ctl, ctlLabel, ctlSeg, ctlSegSync, ctlSpin, ctlSpinStep, ctlFill, ctlEnhance, bindControls.
// Depends on: app-core ($, esc, log), app-pipeline (proLook), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// the drop-downs drawn as segmented buttons (2–4 short choices); #wCorner is drawn as a 2 × 2 corner picker
var CTL_SEG = ['#bitDepth', '#wCorner', '#wDir', '#wPattern', '#wSplit', '#mSplit', '#sc_bitDepth'];
var ctl = { obs: null, queued: false };

function ctlLabel(o) { return o.textContent.replace(/\s*\(.*\)\s*$/, '').trim(); }   // "Columns (vertical)" → "Columns"
function ctlSeg(sel) {
  var g = document.createElement('div'), corner = sel.id === 'wCorner';
  g.className = corner ? 'ctl-corners' : 'seg ctl-seg'; g.setAttribute('role', 'radiogroup');
  g.setAttribute('aria-label', sel.getAttribute('aria-label') || (sel.closest('label') ? sel.closest('label').firstChild.textContent.trim() : sel.id));
  sel.dataset.ctl = 'seg'; sel.classList.add('ctl-hidden'); sel.insertAdjacentElement('afterend', g);
  g.addEventListener('click', function (e) {
    var b = e.target.closest('button[data-v]'); if (!b || sel.disabled || sel.value === b.dataset.v) return;
    sel.value = b.dataset.v; sel.dispatchEvent(new Event('change', { bubbles: true }));
    ctlSegSync(sel);
  });
  ctlSegSync(sel);
}
// the buttons follow the select: its options (rebuilt when they change), its value (undo), its disabled state
function ctlSegSync(sel) {
  var g = sel.nextElementSibling; if (!g || !(g.classList.contains('ctl-seg') || g.classList.contains('ctl-corners'))) return;
  var opts = Array.prototype.slice.call(sel.options), sig = opts.map(function (o) { return o.value + '=' + o.textContent; }).join('|');
  if (g.dataset.sig !== sig) {
    g.dataset.sig = sig;
    g.innerHTML = opts.map(function (o) {
      return '<button type="button" role="radio" data-v="' + esc(o.value) + '" title="' + esc(o.textContent) + '"' + (g.classList.contains('ctl-corners') ? ' aria-label="' + esc(o.textContent) + '"><i></i>' : '>' + esc(ctlLabel(o))) + '</button>';
    }).join('');
  }
  Array.prototype.forEach.call(g.children, function (b) {
    var on = b.dataset.v === sel.value;
    if (b.classList.contains('on') !== on) { b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); }
    if (b.disabled !== sel.disabled) b.disabled = sel.disabled;
  });
  if (sel.title && g.title !== sel.title) g.title = sel.title;
}
function ctlSpin(inp) {
  var w = document.createElement('span'), b = document.createElement('span');
  w.className = 'spin'; b.className = 'spin-b'; b.setAttribute('aria-hidden', 'true');
  b.innerHTML = '<i data-d="1"></i><i data-d="-1"></i>';
  inp.dataset.ctl = 'spin'; inp.parentNode.insertBefore(w, inp); w.appendChild(inp); w.appendChild(b);
}
// one step of a spin box: the field's own step (a frame rate's 0.001 steps by 1), inside min / max, no float dust
function ctlSpinStep(inp, d) {
  var st = parseFloat(inp.step), s = st >= 0.01 ? st : 1, v = parseFloat(inp.value), lo = parseFloat(inp.min), hi = parseFloat(inp.max);
  if (isNaN(v)) v = isNaN(lo) ? 0 : lo - d * s;
  v = Math.round((v + d * s) / s) * s;
  if (!isNaN(lo)) v = Math.max(lo, v);
  if (!isNaN(hi)) v = Math.min(hi, v);
  var dec = (String(s).split('.')[1] || '').length, t = dec ? v.toFixed(dec).replace(/\.?0+$/, '') : String(Math.round(v));
  if (t === inp.value) return false;
  inp.value = t; inp.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}
// the slider's filled part (WebKit / Blink draw none: the track's gradient reads --p; Firefox has its own progress)
function ctlFill(r) {
  var lo = parseFloat(r.min) || 0, hi = parseFloat(r.max), v = parseFloat(r.value), p = hi > lo ? (v - lo) / (hi - lo) * 100 : 0;
  r.style.setProperty('--p', Math.max(0, Math.min(100, p)).toFixed(2) + '%');
}
function ctlEnhance() {
  if (!proLook()) return;
  CTL_SEG.forEach(function (q) { var s = document.querySelector(q); if (!s) return; if (!s.dataset.ctl) ctlSeg(s); else ctlSegSync(s); });
  Array.prototype.forEach.call(document.querySelectorAll('.panel.right input[type=number]:not([data-ctl])'), function (i) {
    if (i.closest('.bk-pp, .plib, .spin')) return;   // the backup port pairs and the cabinet-type rows are too narrow
    ctlSpin(i);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.sc-range'), function (r) { if (r.dataset.k === 'colorTemp') r.classList.add('ct'); ctlFill(r); });
}
function bindControls() {
  if (!proLook()) return;
  document.addEventListener('input', function (e) { if (e.target.classList && e.target.classList.contains('sc-range')) ctlFill(e.target); }, true);
  // spin buttons: press = one step, hold = repeat; the change (undo step, Apply) once, at release
  document.addEventListener('pointerdown', function (e) {
    var i = e.target.closest && e.target.closest('.spin-b > i'), inp = i && i.parentNode.parentNode.querySelector('input');
    if (!inp || inp.disabled || inp.readOnly || e.button > 0) return;
    e.preventDefault();
    var d = +i.dataset.d, moved = ctlSpinStep(inp, d), t = setTimeout(function rep() { moved = ctlSpinStep(inp, d) || moved; t = setTimeout(rep, 120); }, 400);
    var end = function () {
      clearTimeout(t); document.removeEventListener('pointerup', end, true); document.removeEventListener('pointercancel', end, true);
      if (moved) { inp.dispatchEvent(new Event('change', { bubbles: true })); log('spin', { field: inp.id, value: inp.value }); }
    };
    document.addEventListener('pointerup', end, true); document.addEventListener('pointercancel', end, true);
  }, true);
  // the side panels rebuilt by their own render (#scForm, #bkBody, #dvHwBody …): enhance once, after the batch
  ctl.obs = new MutationObserver(function () {
    if (ctl.queued) return;
    ctl.queued = true; Promise.resolve().then(function () { ctl.queued = false; ctlEnhance(); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.panel.right'), function (p) { ctl.obs.observe(p, { childList: true, subtree: true }); });
  ctlEnhance();
}
