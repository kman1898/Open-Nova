// app-network.js - Settings ▸ Network… (user, 2026-10-28: "a way to set which network interface we are going to use. Or
// better yet be able to use all of them simultaneously just like Bitfocus Companion"). Open Nova searches every network
// interface at once by default (tools/netif.py: one discovery socket per interface); this dialog lists them (name, type,
// address, connected, processors found on each) with a tick per interface ("Search for processors on this network", all on
// by default, a new one too) and "App reachable from": every network / this computer only / one interface (+ this
// computer), which the app server applies at its next start (serve.py / serve.ps1 / opennova.py). Kept by the helper on
// THIS computer (its settings folder), never in the project. Found processors carry the interface they answered on
// (x.iface): the Add processor list, the Hardware card and Device info show it ("H5 · 192.168.0.11:5200 · Ethernet 2").
// Hot-plug: every 15 s the helper's change counter (/api/hw/net/state); a change is logged, toasted and starts a search.
// Owns: nw, NW_TYPES, nwOpen, nwClose, nwLoad, nwRender, nwSet, nwShort, nwFound, nwOf, nwInfoRow, nwPoll, bindNetwork.
// Depends on: app-core ($, esc, toast), app-log (log), app-tips (itip), drv-core (DRV), app-hardware (hw, hwWhere, HW_HELPER;
// hwBackground searches when hw.bgAt is 0), app-online (olSame), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var nw = { data: null, busy: false, err: '', seq: null, timer: null };   // data = the helper's last /api/hw/net/interfaces answer
var NW_TYPES = { ethernet: 'Ethernet', wifi: 'Wi-Fi', vpn: 'VPN', loopback: 'This computer', virtual: 'Virtual', bluetooth: 'Bluetooth', other: '' };

// An interface's name for people: macOS shows the hardware port ("USB 10/100/1000 LAN") rather than en7.
function nwShort(name) {
  var i = nw.data && (nw.data.interfaces || []).filter(function (x) { return x.name === name; })[0];
  return i && nw.data.platform === 'darwin' && i.label ? i.label : name || '';
}
// The processors the last search found on interface `name` (the app's own list, else the helper's addresses).
function nwFound(name, helperList) {
  var mine = (hw.found || []).filter(function (x) { return x && x.iface === name; }), ips = mine.map(function (x) { return x.addr || String(x.ip).split('%')[0]; });
  return mine.map(function (x) { return (x.deviceName || x.kind) + ' · ' + hwWhere(x.ip, x.port); })
    .concat((helperList || []).filter(function (f) { return ips.indexOf(f.ip) < 0; }).map(function (f) { return f.ip; }));
}
// The interface processor link h goes through: its zone ("ip%Ethernet 3"), else what the last search found it on.
function nwOf(h) {
  if (!h || !h.host) return '';
  var z = String(h.host).split('%')[1]; if (z) return z;
  var x = (hw.found || []).filter(function (f) { return typeof olSame === 'function' && olSame(h, f); })[0];
  return x && x.iface || '';
}
// Device info's row: ['Network', 'Ethernet 2'] (empty when unknown).
function nwInfoRow(d) { var n = nwOf(d && d.hw); return n ? [['Network', nwShort(n)]] : []; }

function nwLoad(fresh) {
  nw.busy = true; nwRender();
  return DRV.post('lct', '/api/hw/net/interfaces', { appPort: +location.port || 80, fresh: !!fresh }).then(function (r) {
    if (r.ok) { nw.data = r; nw.err = ''; if (r.state) nw.seq = r.state.seq; } else nw.err = r.error || 'not available';
  }, function (e) { nw.err = 'the helper isn’t running (' + e.message + ')'; }).then(function () { nw.busy = false; nwRender(); });
}
// One change: {disabled: [...]} or {bind: ...}, saved by the helper on this computer.
function nwSet(ch, what) {
  log('network_' + what, ch);
  return DRV.post('lct', '/api/hw/net/set', Object.assign({ appPort: +location.port || 80 }, ch)).then(function (r) {
    if (!r.ok) { toast('Network: ' + (r.error || 'not saved')); return; }
    nw.data = r; nwRender();
    if (what === 'search' && !(hw.bgAt > Date.now())) hw.bgAt = 0;   // search again soon with the new set (app-hardware.js)
  }, function (e) { toast('Network: the helper isn’t running (' + e.message + ')'); });
}

function nwOpen(data) {
  var dlg = $('nwDlg');
  if (!dlg) {
    dlg = document.createElement('div'); dlg.id = 'nwDlg'; dlg.className = 'logdlg'; dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-label', 'Network');
    dlg.innerHTML = '<div class="logbox keysbox nw-box"><div class="loghead"><b>Network</b><span class="grow"></span><button id="nwClose" title="Close (Esc)">×</button></div>' +
      '<div id="nwBody" class="keysbody"></div></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', function (e) { if (e.target.id === 'nwClose' || e.target === dlg) nwClose(); });
    dlg.addEventListener('change', function (e) {
      var t = e.target, s = nw.data && nw.data.settings;
      if (!s) return;
      if (t.dataset.nw === 'search') {
        var off = s.disabled.filter(function (n) { return n !== t.dataset.n; }); if (!t.checked) off.push(t.dataset.n);
        nwSet({ disabled: off, network: t.dataset.n, on: t.checked }, 'search');
      } else if (t.id === 'nwBind') nwSet({ bind: t.value }, 'bind');
    });
  }
  dlg.hidden = false;
  if (data) { nw.data = data; nw.err = ''; nwRender(); return; }   // tests / the UI sweep: a given list
  log('network_open', {});
  nwLoad(true);
}
function nwClose() { var d = $('nwDlg'); if (d) d.hidden = true; }

function nwRender() {
  var box = $('nwBody'); if (!box || $('nwDlg').hidden) return;
  var r = nw.data, h = '';
  if (!r) { box.innerHTML = '<p class="hint">' + esc(nw.busy ? 'Reading the interfaces…' : 'Can’t read the interfaces: ' + nw.err) + '</p>'; return; }
  var s = r.settings || { disabled: [], bind: 'all' };
  h += '<div class="nw-head"><span title="Ticked: Open Nova searches for processors there (all at once, like Companion). A network that turns up later is searched too.">Search</span>' +
    '<span>Network</span><span>Processors found</span></div>';
  (r.interfaces || []).forEach(function (i) {
    var lo = i.type === 'loopback', ips = (i.ipv4 || []).map(function (a) { return a.ip + '/' + a.prefix; }).join(', ');
    var vpn32 = (i.ipv4 || []).length && (i.ipv4 || []).every(function (a) { return !a.broadcast; });
    var sub = [NW_TYPES[i.type] || i.type, i.up ? ips || 'no IPv4 address' : 'not connected'].filter(Boolean);
    if (r.platform === 'darwin' && i.label && !lo) sub.unshift(i.name);
    var found = lo ? [] : nwFound(i.name, i.found);
    var name = r.platform === 'darwin' && i.label ? i.label : i.name;
    h += '<div class="nw-row' + (i.up ? '' : ' nw-down') + '">' +
      (lo ? '<span class="nw-chk" title="This computer (simulators, fakes): always asked">–</span>' :
        '<label class="nw-chk" title="Search for processors on this network"><input type="checkbox" data-nw="search" data-n="' + esc(i.name) + '"' + (i.search ? ' checked' : '') + ' aria-label="Search for processors on ' + esc(name) + '"></label>') +
      '<span class="nw-name"><b title="' + esc(i.label || i.name) + '">' + esc(name) + '</b><span class="hint">' + esc(sub.join(' · ')) +
        (vpn32 && !lo ? itip('A point-to-point address (a VPN such as Tailscale): nothing to broadcast to. Processors across it are asked by address (Add by address…).') : '') + '</span></span>' +
      '<span class="nw-found' + (found.length ? '' : ' hint') + '">' + (lo ? '' : found.length ? found.map(esc).join('<br>') : i.up && i.search && !vpn32 ? 'none' : '') + '</span></div>';
  });
  var opts = [['all', 'Every network'], ['localhost', 'This computer only']];
  (r.interfaces || []).forEach(function (i) {
    if (i.type !== 'loopback' && (i.ipv4 || []).length) opts.push([i.name, (r.platform === 'darwin' && i.label ? i.label : i.name) + ' (' + i.ipv4[0].ip + ') and this computer']);
  });
  if (!opts.some(function (o) { return o[0] === s.bind; })) opts.push([s.bind, s.bind + ' (not connected) and this computer']);
  var ap = r.applied, now = !ap ? '' : ap.choice === 'all' ? 'every network' : ap.hosts && ap.hosts.length > 1 ? ap.choice + ' and this computer' : 'this computer only';
  var note = (now ? 'Now: ' + now + '. ' : '') + (!ap || ap.choice !== s.bind ? 'Applies the next time Open Nova starts.' : '') + (ap && ap.note ? ' ' + ap.note : '');
  h += '<div class="nw-bind"><label title="Which networks can open Open Nova in a browser (other computers, tablets). Applies the next time Open Nova starts.' +
    (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1' ? ' You are on another device now: “This computer only” would lock it out after the restart.' : '') + '">App reachable from ' +
    '<select id="nwBind">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === s.bind ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>' +
    '<span class="hint">' + esc(note.trim()) + '</span></div>';
  if (!r.saved) h += '<p class="hint">⚠ This computer has no settings folder outside the Open Nova folder: changes last until the helper stops.</p>';
  box.innerHTML = h;
}

// Hot-plug: the helper's change counter every 15 s (cheap; not in the helper journal). A change: logged, a toast, a search.
function nwPoll() {
  if (document.hidden || hw.helper === false) return;
  fetch(HW_HELPER + '/api/hw/net/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function (r) { return r.json(); }).then(function (j) {
      if (!j || !j.ok) return;
      var was = nw.seq; nw.seq = j.seq;
      if (was == null || j.seq === was) return;
      var ev = (j.events || []).filter(function (e) { return e.seq > was; });
      log('network_change', { changes: ev.map(function (e) { return e.text; }) });
      if (ev.length) toast('Network: ' + ev.map(function (e) { return e.text; }).slice(0, 2).join(' · '));
      if (!(hw.bgAt > Date.now())) hw.bgAt = 0;   // look for processors on what changed (hwBackground, within 5 s)
      if ($('nwDlg') && !$('nwDlg').hidden) nwLoad(false);
    }, function () { /* the helper isn't there: hwPing says so */ });
}

function bindNetwork() {
  var b = $('mbNetwork'); if (b) b.addEventListener('click', function () { nwOpen(); });
  nw.timer = setInterval(nwPoll, 15000); setTimeout(nwPoll, 3000);
}
