// tests/ui-lint.js - layout audit for the running app (load it in the app page's console or via a <script> tag):
//   await uiSweep()   -> {w, h, res: {tab: [problems]}}: every tab, then every ▾ menu / popover and every menu-bar menu and
//                        submenu opened in turn
//   uiLint()          -> [[kind, element, detail]] for what is on screen now
// Kinds: offscreen-x (outside the window and not in a scroll box), clipped-text (text cut off — fine when the element
// ends in "…" on purpose and has a title), overlap (sibling controls / tree rows drawn on top of each other),
// touching-selected (two selected tree rows with no gap: they read as one block), collapsed (a column or pane squeezed to
// almost nothing). Read-only; changes nothing but the tab.
'use strict';

function uiLint() {
  var out = [], W = innerWidth;
  var vis = function (e) { if (!e.offsetParent && getComputedStyle(e).position !== 'fixed') return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  var name = function (e) {
    var c = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return (e.id ? '#' + e.id : e.tagName.toLowerCase() + c) + ' "' + (e.textContent || e.value || e.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 28) + '"';
  };
  var scroller = function (e) { for (var p = e.parentElement; p; p = p.parentElement) { var cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) return p; } return null; };
  var skip = /^(SCRIPT|STYLE|OPTION)$/;
  var els = Array.prototype.filter.call(document.querySelectorAll('body *'), function (e) { return !skip.test(e.tagName) && !e.closest('[hidden]') && !e.closest('svg') && vis(e); });
  els.forEach(function (e) {
    var r = e.getBoundingClientRect();
    if (!scroller(e) && (r.left < -1 || r.right > W + 1)) out.push(['offscreen-x', name(e), Math.round(r.left) + '..' + Math.round(r.right)]);
    var cs = getComputedStyle(e);
    if (e.matches('button,label,.tn-name,.tn-tag,h3,h4,b,span,th,td,select,dt,dd') && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2 && cs.overflow !== 'visible' && e.children.length < 3)
      out.push(['clipped-text', name(e), e.clientWidth + '<' + e.scrollWidth + (e.closest('[title]') ? ' (has title)' : '')]);
  });
  // a main area squeezed to nothing (a column 0 px wide, or a scrolling pane in an "auto" row 0 px high)
  Array.prototype.forEach.call(document.querySelectorAll('main:not([hidden]) > section, main:not([hidden]) > aside'), function (e) {
    if (getComputedStyle(e).display === 'none' || e.closest('[hidden]')) return;
    var r = e.getBoundingClientRect();
    if (r.width < 120 || r.height < 60) out.push(['collapsed', name(e), Math.round(r.width) + '×' + Math.round(r.height)]);
  });
  var groups = new Map();
  els.filter(function (e) { return e.matches('button, select, input:not([type=checkbox]):not([type=radio]), .tn, label.chk'); })
    .forEach(function (e) { var p = e.parentElement; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(e); });
  groups.forEach(function (list) {
    for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
      var a = list[i].getBoundingClientRect(), b = list[j].getBoundingClientRect();
      var ox = Math.min(a.right, b.right) - Math.max(a.left, b.left), oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 2 && oy > 2) out.push(['overlap', name(list[i]), name(list[j])]);
      else if (list[i].matches('.tn.on') && list[j].matches('.tn.on') && Math.abs(a.bottom - b.top) < 1) out.push(['touching-selected', name(list[i]), name(list[j])]);
    }
  });
  var seen = {};
  return out.filter(function (x) { var k = x.join('|'); if (seen[k]) return false; seen[k] = 1; return true; });
}

async function uiSweep(tabs) {
  tabs = tabs || ['devices', 'layout', 'correction', 'screen', 'backup', 'presets', 'health', 'schedule', 'maintain', 'library', 'diag', 'dashboard'];
  var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }, res = {};
  var close = async function () {
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(120);
  };
  for (var t of tabs) {
    setTab(t); renderAll(); await wait(300);
    var list = uiLint().map(function (x) { return x.join(' | '); });
    var openers = Array.prototype.filter.call(document.querySelectorAll('button'), function (b) { return b.offsetParent && /▾|▼/.test(b.textContent); });
    for (var b of openers) {
      var base = new Set(list); b.click(); await wait(220);
      uiLint().map(function (x) { return x.join(' | '); }).filter(function (x) { return !base.has(x); }).forEach(function (x) { list.push('[open ' + (b.id || b.textContent.trim().slice(0, 12)) + '] ' + x); });
      await close();
    }
    // the menu bar (app-menubar.js): every menu, then each of its submenus (on narrow windows inside the ☰ list)
    var add = function (tag, base) { uiLint().map(function (x) { return x.join(' | '); }).filter(function (x) { return !base.has(x); }).forEach(function (x) { list.push('[' + tag + '] ' + x); }); };
    if (typeof mbOpen === 'function') for (var m of document.querySelectorAll('#menuBar .mb-top')) {
      var base2 = new Set(list); mbOpen(m.dataset.mb); await wait(220); add('menu ' + m.textContent, base2);
      for (var sb of document.getElementById(m.dataset.mb).querySelectorAll('.mb-subbtn')) {
        mbSubOpen(sb.parentNode); await wait(120); add('menu ' + m.textContent + ' › ' + sb.textContent.replace('›', '').trim(), base2);
      }
      mbClose(); await wait(60);
    }
    if (list.length) res[t] = list;
  }
  // Settings ▸ Network… (app-network.js) with a sample list (long names, a VPN, a disconnected one, the same IP twice)
  if (typeof nwOpen === 'function') {
    var nb = new Set(uiLint().map(function (x) { return x.join(' | '); })), ip = function (a, p, b) { return [{ ip: a, prefix: p, broadcast: b }]; };
    nwOpen({ ok: true, platform: 'win32', saved: true, settings: { disabled: ['Wi-Fi'], bind: 'Ethernet 3' }, applied: { choice: 'all', hosts: null, note: '' }, interfaces: [
      { name: 'Ethernet 2', label: 'Intel(R) Ethernet Connection (7) I219-V', type: 'ethernet', up: true, search: true, ipv4: ip('192.168.0.10', 24, '192.168.0.255'), found: [{ ip: '192.168.0.11', kind: 'lct' }, { ip: '192.168.0.12', kind: 'unico' }] },
      { name: 'Ethernet 3', label: 'Realtek USB GbE Family Controller #2', type: 'ethernet', up: true, search: true, ipv4: ip('192.168.0.20', 24, '192.168.0.255'), found: [{ ip: '192.168.0.11', kind: 'lct' }] },
      { name: 'Wi-Fi', label: 'Intel(R) Wi-Fi 6 AX201 160MHz', type: 'wifi', up: false, search: false, ipv4: [], found: [] },
      { name: 'Tailscale', label: 'Tailscale Tunnel', type: 'vpn', up: true, search: true, ipv4: ip('100.101.102.103', 32, ''), found: [] },
      { name: 'vEthernet (Default Switch)', label: 'Hyper-V Virtual Ethernet Adapter', type: 'virtual', up: true, search: true, ipv4: ip('172.20.16.1', 20, '172.20.31.255'), found: [] },
      { name: 'Loopback Pseudo-Interface 1', label: 'this computer', type: 'loopback', up: true, search: false, ipv4: ip('127.0.0.1', 8, ''), found: [] }] });
    await wait(150);
    var nl = uiLint().map(function (x) { return x.join(' | '); }).filter(function (x) { return !nb.has(x); }).map(function (x) { return '[Settings ▸ Network…] ' + x; });
    nwClose(); await wait(60);
    if (nl.length) res['network dialog'] = nl;
  }
  return { w: innerWidth, h: innerHeight, res: res };
}
