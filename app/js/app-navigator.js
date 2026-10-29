// app-navigator.js - the Layout canvas's navigator (docs/PRO_LOOK_PLAN.md §5.3): a small map at the bottom right of the
// canvas — the canvas outline, the cabinets of the screen shown in their port colours, a blue box = what the view shows,
// the zoom in %. Drag the box to pan, click elsewhere to centre there; it writes ui.view as zoom() does. Its own pointer
// events stop at the box, so the canvas tools, Quick add and Space-pan never see them. View ▾ / View ▸ Navigator, remembered
// per browser (on by default); hidden in windows under 900 px. The map is rebuilt only when the project or the screen
// changes; the box moves on every renderCanvas.
// Owns: NAV_KEY, nav, navShown, navToggle, navMap, navUpdate, navPoint, bindNavigator.
// Depends on: app-core ($, P, ui, log, esc), app-render (renderCanvas, el), app-geometry (allCells, visibleScreens),
// app-capacity (portColor), app-forms (uiZoom), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var NAV_KEY = 'opennova.navigator';
var nav = { on: true, folded: false, key: '', vb: null, drag: null };

function navShown() { return nav.on && innerWidth / uiZoom() >= 900 && ui.tab === 'layout'; }
function navToggle(on) {
  nav.on = on == null ? !nav.on : !!on;
  log('navigator_toggle', { on: nav.on });
  try { localStorage.setItem(NAV_KEY, nav.on ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  if ($('showNav')) $('showNav').checked = nav.on;
  navUpdate(allCells());
}
// the mini map: canvas outline + the screen's cabinets; viewBox = the canvas and the cabinets with a margin
function navMap(cellsBy) {
  var x0 = 0, y0 = 0, x1 = P.canvasW, y1 = P.canvasH, s = '';
  visibleScreens().forEach(function (sc) {
    (cellsBy[sc.id] || []).forEach(function (c) {
      if (c.hole) return;
      x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.w); y1 = Math.max(y1, c.y + c.h);
      s += '<rect x="' + c.x + '" y="' + c.y + '" width="' + c.w + '" height="' + c.h + '" fill="' + (c.sender == null ? '#666' : portColor(c.sender, c.port)) + '"/>';
    });
  });
  var m = Math.max(x1 - x0, y1 - y0) * 0.06;
  nav.vb = { x: x0 - m, y: y0 - m, w: x1 - x0 + 2 * m, h: y1 - y0 + 2 * m };
  var sw = nav.vb.w / 180;
  return '<rect class="nav-cv" x="0" y="0" width="' + P.canvasW + '" height="' + P.canvasH + '" stroke-width="' + sw + '" stroke-dasharray="' + 3 * sw + ' ' + 2 * sw + '"/>' +
    '<g class="nav-cabs" stroke="#000" stroke-opacity=".5" stroke-width="' + sw * 0.5 + '">' + s + '</g><rect class="nav-view" stroke-width="' + 1.5 * sw + '"/>';
}
function navUpdate(cellsBy) {
  var vp = $('viewport'); if (!vp) return;
  var box = $('navigator');
  if (!navShown()) { if (box) box.hidden = true; return; }
  if (!box) {
    box = document.createElement('div'); box.id = 'navigator'; box.className = 'nav-box heat-plate';
    box.innerHTML = '<div class="nav-h"><span>Navigator</span><span class="grow"></span><span class="nav-z"></span><button type="button" class="nav-fold" title="Fold / unfold" aria-label="Fold the navigator">▾</button></div>' +
      '<svg class="nav-map" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Navigator: drag the box to pan"></svg>';
    vp.appendChild(box);
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'click', 'dblclick', 'contextmenu', 'mousedown'].forEach(function (t) { box.addEventListener(t, function (e) { e.stopPropagation(); }); });
    box.querySelector('.nav-fold').onclick = function () { nav.folded = !nav.folded; box.classList.toggle('folded', nav.folded); log('navigator_fold', { folded: nav.folded }); };
    var map = box.querySelector('.nav-map');
    map.addEventListener('pointerdown', function (e) {
      if (!ui.view || e.button > 0) return;
      var p = navPoint(e), v = ui.view, inside = p.x >= v.x && p.x <= v.x + v.w && p.y >= v.y && p.y <= v.y + v.h;
      if (!inside) { v.x = p.x - v.w / 2; v.y = p.y - v.h / 2; renderCanvas(allCells()); }   // centre there, then drag on
      nav.drag = { x: p.x, y: p.y, vx: v.x, vy: v.y };
      map.setPointerCapture(e.pointerId); e.preventDefault();
    });
    map.addEventListener('pointermove', function (e) {
      if (!nav.drag) return;
      var p = navPoint(e); ui.view.x = nav.drag.vx + (p.x - nav.drag.x); ui.view.y = nav.drag.vy + (p.y - nav.drag.y);
      renderCanvas(allCells());
    });
    var end = function () { if (nav.drag) { nav.drag = null; log('navigator_pan', {}); } };
    map.addEventListener('pointerup', end); map.addEventListener('pointercancel', end);
  }
  box.hidden = false; box.classList.toggle('folded', nav.folded);
  var svg = box.querySelector('.nav-map'), key = ui.lastSnap + '|' + ui.viewScreen + '|' + P.canvasW + 'x' + P.canvasH;
  if (key !== nav.key && !nav.drag) { nav.key = key; svg.innerHTML = navMap(cellsBy || allCells()); svg.setAttribute('viewBox', nav.vb.x + ' ' + nav.vb.y + ' ' + nav.vb.w + ' ' + nav.vb.h); }
  // the view box: the main SVG's viewBox (after its aspect fix)
  var vb = ($('svg').getAttribute('viewBox') || '').split(' ').map(Number), r = svg.querySelector('.nav-view');
  if (r && vb.length === 4) { r.setAttribute('x', vb[0]); r.setAttribute('y', vb[1]); r.setAttribute('width', vb[2]); r.setAttribute('height', vb[3]); }
  var z = box.querySelector('.nav-z'), zt = Math.round((ui.pxPerUnit || 0) / uiZoom() * 100) + ' %';
  if (z.textContent !== zt) z.textContent = zt;
}
// a pointer position in the map's canvas units (getScreenCTM includes the interface size's zoom)
function navPoint(e) {
  var svg = $('navigator').querySelector('.nav-map'), m = svg.getScreenCTM(), p = svg.createSVGPoint();
  p.x = e.clientX; p.y = e.clientY;
  return m ? p.matrixTransform(m.inverse()) : { x: 0, y: 0 };
}
function bindNavigator() {
  try { nav.on = localStorage.getItem(NAV_KEY) !== '0'; } catch (e) { /* storage unavailable */ }
  var c = $('showNav'); if (!c) return;
  c.checked = nav.on;
  c.addEventListener('change', function () { navToggle(c.checked); });
}
