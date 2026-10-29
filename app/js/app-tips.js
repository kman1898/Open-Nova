// app-tips.js - the ⓘ tip: help text that used to sit on screen as grey hint lines (UI cleanup, docs/UI_STREAMLINE_PROPOSAL.md
// item 1). Hover shows it (title), a click or tap opens it as a small popover (touch has no hover), Esc / a click elsewhere
// closes it. Safety text (proposal §2) never goes into a tip.
// Owns: itip, bindTips.
// Depends on: app-core (esc, keysText), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

// HTML for an ⓘ with text t (plain text; line breaks kept). Put it right after the label or title it explains.
function itip(t) {
  t = keysText(t);   // Ctrl → ⌘ on a Mac (app-core.js)
  return '<button type="button" class="itip" aria-label="More info" title="' + esc(t) + '" data-itip="' + esc(t) + '">ⓘ</button>';
}
function bindTips() {
  var pop = null;
  function close() { if (pop) { pop.remove(); pop = null; } }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.itip');
    if (!b) { if (pop && !pop.contains(e.target)) close(); return; }
    e.preventDefault(); e.stopPropagation();
    var again = pop && pop.owner === b; close(); if (again) return;
    pop = document.createElement('div'); pop.className = 'itip-pop'; pop.owner = b; pop.setAttribute('role', 'note');
    pop.textContent = keysText(b.getAttribute('data-itip'));   // tips written straight into index.html too
    document.body.appendChild(pop);
    var z = typeof uiZoom === 'function' ? uiZoom() : 1, r = b.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
    var vw = window.innerWidth / z, vh = window.innerHeight / z, x = r.left / z, y = r.bottom / z + 4;
    if (x + w > vw - 8) x = Math.max(8, vw - 8 - w);
    if (y + h > vh - 8) y = Math.max(8, r.top / z - 4 - h);
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
  }, true);
  // on window, not document: the tab shortcuts (app-shell.js) stop keys at window capture on every tab but Layout
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pop) { close(); e.stopPropagation(); } }, true);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
}
