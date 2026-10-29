// drv-lct.js - driver for NovaLCT-protocol processors (MCTRL, NovaPro, VX classic, H series …): TG frames through
// the helper (tools\novalink.py, /api/hw/*): UDP 3800 discovery, receiving-card probing per port, hwsend.js plans
// for Send (checked against LCT's own Sends, docs\APP_SEND.md). Moved here unchanged from app-hardware.js (design
// phase 3). Send never includes the receiving-card Save (that stays a separate, deliberate step).
// Addresses typed with "Add by address…" (opennova.lctHosts) are asked directly on every Find: a processor on another
// subnet or across a VPN (Tailscale) doesn't hear the broadcast.
// Owns: DRV_LCT, LCT_HOSTS_KEY, lctHosts.
// Depends on: drv-core (DRV, drvResult), hwsend.js (HWSEND), app-core (P), app-processors (cardsOfDevice),
// app-hardware (hw, hwSenderName, hwSendModel, hwModelKey), app-online (olHCard), app-redundancy (rdReduPending, rdReduSet,
// rdSentSet: a backup Send not saved yet / last sent), all at run time.
// Classic script, not an ES module (see app-core.js); every top-level name is a shared global.
'use strict';

var LCT_HOSTS_KEY = 'opennova.lctHosts';
function lctHosts() { try { return JSON.parse(localStorage.getItem(LCT_HOSTS_KEY) || '[]') || []; } catch (e) { return []; } }

var DRV_LCT = {
  liveMs: 4000,
  caps: function () { return { link: true, detect: true, live: true, send: true, monitor: true, save: true, applyMode: 'send', display: true, patterns: true, mapping: true,
    color: { brightness: true, colorTemp: true, gamma: true }, lowLatency: true, llCheck: true, verify: { backup: true, primary: false }, backupSend: true, rcvFile: { rcfgx: true, ncp: true }, readLayout: true,
    service: { restart: false, factory: ['all'], panels: true } }; },   // NovaLCT has no restart command for the processor itself
  // One entry per processor: each link is asked which sending cards it has (ModelIDs), then the links of one IP are one
  // processor (an H lists one link per output slot, H_SUB_CARD 5201…, empty slots don't answer): its port becomes a spec
  // "5201+5202" (the helper's MultiLink; "5201*2" = two cascaded cards behind one link) and its senders all cards in port
  // order. An H's chassis comes from its web API (x.web: model, LED cards per slot) when its login is saved on this computer
  // (app-online.js, tools/hweb.py); nothing is sent to the H web page otherwise. USB / serial ports too (docs\USB_SERIAL.md):
  // the helper asks each COM port for a ModelID (read-only); one that answers is a link like any other, host
  // "serial:COM3" (port 0), named e.g. "VX1000 · USB (COM3)". An older helper without the route just finds none.
  // COM ports are asked only on a Find the user pressed (o.background = the automatic search): a probe goes to every COM
  // port, and other serial gear on the computer shouldn't get one every minute; NovaStar's own USB device (0483:5720, not a
  // COM port; docs\USB_NOVA_DEVICE.md, host "usb:0483:5720@1-3", named e.g. "VX1000 · USB") is asked on every search.
  // r.usbError says why it can't be used (libusb missing …). The background search doesn't re-ask links already linked.
  discover: function (o) {
    var usb = DRV.post('lct', '/api/hw/serial-ports', { probe: true, timeout: 1, usbOnly: !!o.background }).then(function (r) {
      var nu = (r.usb || []).filter(function (p) { return p.answered; }).map(function (p) { p.nova = true; return p; });
      var bad = (r.usb || []).filter(function (p) { return !p.answered && p.error && !p.busy; })[0];
      if (!o.background && typeof toast === 'function' && (bad || (r.usbError && r.novaUsb))) toast(bad ? 'NovaStar ' + bad.label + ': ' + bad.error : r.usbError);
      return (r.ports || []).filter(function (p) { return p.answered; }).concat(nu);
    }, function () { return []; });
    var known = {}; (P.devices || []).forEach(function (d) { if (o.background && d.hw && d.hw.kind === 'lct') known[d.hw.host] = d.hw; });
    return Promise.all([DRV.post('lct', '/api/hw/discover', { timeout: o.timeout || 2, probe: lctHosts() }), usb]).then(function (rr) {
      var r = rr[0], links = []; (r.devices || []).forEach(function (x) { x.links.forEach(function (port) {
        links.push({ kind: 'lct', ip: x.ip, port: port, iface: x.iface || '', addr: x.addr, conflict: x.conflict });   // the network it answered on (Settings ▸ Network)
      }); });
      rr[1].forEach(function (p) { links.push({ kind: 'lct', ip: p.host, port: 0, usb: p.label, nova: p.nova, modelId: p.modelId }); });
      var usbName = function (x) { if (x.usb) x.deviceName = (x.senders.length ? x.deviceName : hwSenderName(x.modelId)) + ' · USB' + (x.nova ? '' : ' (' + x.usb + ')'); delete x.nova; return x; };
      var named = function (x) { x.deviceName = x.senders.length ? hwSenderName(x.senders[0]) + (x.senders.length > 1 ? ' ×' + x.senders.length : '') : 'NovaLCT processor'; return x; };
      return Promise.all(links.map(function (x) {
        var k = known[x.ip];
        if (k) { x.senders = (k.senders || []).slice(); x.port = k.port; x.SN = ''; x.deviceName = k.name; x.linked = true; return x; }   // in the project already
        return DRV.post('lct', '/api/hw/info', { host: x.ip, port: x.port }).then(function (i) {
          x.senders = i.senders || []; x.modelId = x.senders.length || !x.usb ? x.senders[0] : x.modelId;
          named(x); x.SN = ''; return usbName(x);
        }, function () { x.senders = []; x.deviceName = 'NovaLCT processor'; return usbName(x); });
      })).then(function (all) {
        var by = {}, out = [];
        all.forEach(function (x) { if (!by[x.ip]) { by[x.ip] = []; out.push(x.ip); } by[x.ip].push(x); });
        return Promise.all(out.map(function (ip) {
          var g = by[ip], x = g[0];
          if (g.length > 1 && !x.linked) {   // one processor over several links (an H's output slots)
            var full = g.filter(function (y) { return y.senders.length; });
            x = full[0] || g[0];
            if (full.length > 1) {
              x.port = full.map(function (y) { return y.port + (y.senders.length > 1 ? '*' + y.senders.length : ''); }).join('+');
              x.senders = [].concat.apply([], full.map(function (y) { return y.senders; })); x.modelId = x.senders[0]; named(x);
            }
            x.links = g.map(function (y) { return { port: y.port, senders: y.senders }; });
          }
          if (x.linked || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || !x.senders.some(olHCard)) { delete x.linked; return x; }
          return DRV.post('lct', '/api/hw/hweb/info', { host: ip }).then(function (w) {   // the H's chassis (saved login only)
            hw.hweb = hw.hweb || {}; hw.hweb[ip] = { login: !!w.login, error: w.ok ? '' : w.error };
            if (w.ok) { x.web = { modelId: w.modelId, ledCards: w.ledCards || [], sw: w.softwareVersion || '' }; var mk = hwModelKey(w.modelId); if (mk) x.deviceName = PROC_MODELS[mk].name; }
            return x;
          }, function () { return x; });
        }));
      });
    });
  },
  // auto = a live re-check: the helper re-walks only what changed since `known`; chains are followed through their backup port.
  // What each receiving card is (read-only, for the .rcfgx / NCP guard): the cards of the last detection, read one by one.
  // full = also the firmware versions (an NCP may carry firmware). -> {ok, cards:[{dst, port, index, id|null}]}
  // An .rcfgx to receiving cards (after the file guard, app-rcvguard.js): the file's register script replayed to each target
  // {dst, port, card|null} as NovaLCT does; an NCP goes parameters only (the guard blocks other firmware); no Save.
  // ---------------------------------------------------------------- service (only through app-service.js's caution dialog)
  // Factory reset = NovaLCT's Sending Card tab ▸ Restore Factory (CAPTURE_MCTRL4K_SEND.md, "Restore Factory" [R]): sending
  // cards 0x01000002 <- 00 (r2 7), then the stored backup pairs (REDU 0x05065000), screen layout (NSSD 0x05000000, every
  // sending card) and SSPE 0x05066000 are cleared. Receiving cards untouched; no save follows (the reset is the commit).
  factoryReset: function (d) {
    var w = function (dst, addr, hex, r2) { var o = { op: 'w', dev: 0, dst: dst, port: 0, card: 0, addr: addr, hex: hex }; if (r2) o.r2 = r2; return o; };
    return DRV_LCT.runRx(d, [{ op: 'note', text: 'Factory reset (NovaLCT Restore Factory)' }, w(255, 0x01000002, '00', 7),
      w(0, 0x05065000, '00000000'), w(255, 0x05000000, '00000000'), w(0, 0x05066000, '00000000')], 'Factory reset');
  },
  // Restart the receiving cards: the two restarts NovaLCT sends at the end of an NCP send (CAPTURE_NCP_SEND.md §2 [R]), to
  // every card on every port: MCU 0x01000080 <- 00, wait 11 s, FPGA 0x0100000B <- 00, wait 12 s (Config.xml WaitTime).
  restartPanels: function (d) {
    var all = [{ dst: 255, port: 255, card: 65535 }];
    return DRV_LCT.runRx(d, [{ op: 'note', text: 'Restart receiving cards' }].concat(DRV_LCT.rxOps(all, 0x01000080, '00'), [{ op: 'sleep', ms: 11000 }],
      DRV_LCT.rxOps(all, 0x0100000B, '00'), [{ op: 'sleep', ms: 12000 }]), 'Receiving cards restarted');
  },
  // .rcfgx = its register script per target; NCP = parameters only, as LCT's Smart send (CAPTURE_NCP_SEND §3-§5.1). An NCP
  // takes ~35 s per target, so it goes one helper call per target (each well inside the helper's 15-minute limit).
  sendRcvFile: function (d, o) {
    var groups = o.kind === 'ncp' ? o.targets.map(function (t) { return [t]; }) : [o.targets], frames = 0, done = 0;
    return groups.reduce(function (p, ts) {
      return p.then(function (r) {
        if (r && !r.ok) return r;
        return DRV.post('lct', '/api/hw/rcv-send', { host: d.hw.host, port: d.hw.port, data: o.data, name: o.name, cabinet: o.cabinet || 0, targets: ts, verdict: o.verdict })
          .then(function (x) { if (x.ok) { frames += x.frames; done++; } return x; });
      });
    }, Promise.resolve(null)).then(function (r) {
      var part = !r.ok && done ? ' (after ' + done + ' of ' + groups.length + ' targets)' : '';
      return drvResult(r.ok, { error: r.error && r.error + part, text: r.ok ? frames + ' frames' : '' });
    });
  },
  identify: function (d, o) {
    var lv = hw.live[d.id]; if (!lv) return Promise.resolve(drvResult(false, { error: 'detect the cabinets first' }));
    var chains = lv.cards.map(function (c, i) { var ports = {}; Object.keys(c.ports || {}).forEach(function (p) { if (c.ports[p].length) ports[p] = c.ports[p].length; }); return { dst: i, ports: ports }; });
    return DRV.post('lct', '/api/hw/identify', { host: d.hw.host, port: d.hw.port, chains: chains, full: !!(o && o.full), pairs: hwPairs(d) })
      .then(function (r) { return r.ok ? drvResult(true, { cards: r.cards }) : drvResult(false, { error: r.error || 'identify failed' }); });
  },
  detect: function (d, o) {
    return DRV.post('lct', '/api/hw/detect', { host: d.hw.host, port: d.hw.port, known: o.known || null, pairs: o.pairs || [],
      cards: cardsOfDevice(d).map(function (c, i) { return { dst: i, ports: P.processors[c].ports }; }) }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error || 'detect failed', busy: !!r.busy });
      return drvResult(true, { cards: r.cards.map(function (c) { return { ports: c.ports || {}, error: c.error }; }) });
    });
  },
  planSend: function (d, o) {
    var id = (d.hw.senders || [])[0], n = (d.hw.senders || []).length || cardsOfDevice(d).length, plan;
    // every model in NovaLCT's lists can be sent (hwsend.js profiles); one whose Send hasn't been compared with a NovaLCT
    // capture yet ('code') says so in the confirmation. Unknown ModelIDs and the models LCT sends another way are refused.
    if (!HWSEND.MODELS[id]) return drvResult(false, { error: HWSEND.refusal(id), plain: true });
    // REDU (the pairs record) goes with it only while a backup Send isn't saved yet, as NovaLCT's (app-redundancy rdReduPending)
    var redu = typeof rdReduPending === 'function' && rdReduPending(d) != null;
    // ALL of this processor's screens go in this one Send (NovaLCT: Screen 1, 2 … of its configuration, one NSSD record per
    // sending card listing them in order); a screen belongs to one processor (hwSend checks that first)
    var model = hwSendModel(d), scr = model.screens.map(function (s, i) { return (i + 1) + ' ' + (s.name || 'Screen ' + (i + 1)) + ' (' + (s.type === 1 ? 'Standard' : 'Complex') + ')'; });
    try { plan = HWSEND.buildSendPlan(model, { modelId: id, senders: n, backup: o.pairs || [], freeRoute: !!(d.hw && d.hw.freeRoute), redu: redu }); } catch (e) { return drvResult(false, { error: e.message }); }
    plan.backupPairs = (o.pairs || []).slice();
    return drvResult(true, { payload: plan, count: plan.cabinets, pairs: plan.pairs, screens: scr,
      confirm: 'Send the layout to ' + d.hw.name + ' (' + hwWhere(d.hw.host, d.hw.port) + ')?\n\n' + plan.cabinets + ' cabinets' +
        (plan.pairs ? ', ' + plan.pairs + ' port backup pairs' : '') + '. This replaces the screen layout and the port backup on the processor. (No Save: the receiving-card save stays separate.)' +
        (scr.length > 1 ? '\n\nIts ' + scr.length + ' screens go together, in this order: ' + scr.join(' · ') : '') +
        (plan.verified === 'code' ? '\n\nThe ' + plan.model + ' Send is built from NovaLCT’s model list; it hasn’t been compared with NovaLCT’s own Send yet.' : '') });
  },
  // "Send backup" (Backup tab) = NovaLCT's redundancy page Send (hwsend.js buildRedundancyPlan): the port backup only — the
  // backup cards get the primaries' blocks with the backup ports flagged and filled, then the pair table; never a Save
  // (NovaLCT writes the REDU record on its Save; so does Open Nova's Save, from rdReduPending). No pairs = clear them as
  // NovaLCT's Delete does: o.prev = the pairs the processor holds (read or last sent), else the helper reads its REDU record.
  planBackup: function (d, o) {
    var id = (d.hw.senders || [])[0], n = (d.hw.senders || []).length || cardsOfDevice(d).length, plan;
    if (!HWSEND.MODELS[id]) return drvResult(false, { error: HWSEND.refusal(id), plain: true });
    try { plan = HWSEND.buildRedundancyPlan(hwSendModel(d), { modelId: id, senders: n, backup: o.pairs || [], freeRoute: !!(d.hw && d.hw.freeRoute), prev: o.prev || null }); } catch (e) { return drvResult(false, { error: e.message }); }
    return drvResult(true, { payload: plan, count: 0, pairs: plan.pairs, kind: plan.redundancy });
  },
  // Dry run = the helper's in-memory processor (simulate).
  send: function (d, plan, dry) {
    var req = dry ? DRV.post('lct', '/api/hw/simulate', { plan: plan.payload }) : DRV.post('lct', '/api/hw/run', { host: d.hw.host, port: d.hw.port, plan: plan.payload });
    return req.then(function (r) {
      if (r.ok && !dry && plan.payload && plan.payload.redu && typeof rdReduSet === 'function') rdReduSet(d, null);   // the Send's commit wrote REDU
      if (r.ok && !dry && plan.payload && (plan.payload.backupPairs || []).length && typeof rdSentSet === 'function') rdSentSet(d, plan.payload.backupPairs);   // a layout Send with pairs leaves them on the cards
      return drvResult(r.ok, { log: r.log, error: r.error, frames: r.frames, count: plan.count,
        text: r.ok ? (dry ? 'Check ok (nothing sent): ' + r.frames + ' frames on the helper’s pretend processor' : 'Sent: ' + r.frames + ' frames, all acknowledged') : 'Failed: ' + r.error });
    });
  },
  // The explicit Save (hwsend.js buildSavePlan): stores sending-card, distributor and receiving-card parameters in flash.
  save: function (d) {
    var px = 0, cells = hwPortCells(), mine = cardsOfDevice(d);   // the screen pixels this processor drives (LCT's wait)
    Object.keys(cells).forEach(function (k) { if (mine.indexOf(+k.split(':')[0]) >= 0) cells[k].forEach(function (c) { px += c.width * c.height; }); });
    var redu = typeof rdReduPending === 'function' ? rdReduPending(d) : null;   // pairs of a backup Send not saved yet: REDU first, as NovaLCT
    var plan = HWSEND.buildSavePlan({ pixels: px, senders: (d.hw.senders || []).length || mine.length, redu: redu });
    return DRV.post('lct', '/api/hw/run', { host: d.hw.host, port: d.hw.port, plan: plan }).then(function (r) {
      if (r.ok && redu && typeof rdReduSet === 'function') rdReduSet(d, null);
      return drvResult(r.ok, { error: r.error, frames: r.frames, log: r.log, text: r.ok ? 'Saved: ' + r.frames + ' frames acknowledged (waited ' + Math.round(plan.waitMs / 1000) + ' s for the receiving cards)' : 'Save failed: ' + r.error });
    });
  },
  // ---------------------------------------------------------------- display / test (receiving cards, device 1)
  // LCT's own writes (docs\CAPTURE_LCT_DIALOGS.md, CAPTURE_MCTRL4K_SEND.md): blackout 0x02000100 FF, freeze 0x02000102 FF
  // (port all, per primary card), self-test 0x02000101 code then 0x02000100 00, Normal = freeze 00, self-test 01 then 00,
  // blackout 00. Per (sender, port, card) or full broadcast; a port's writes are repeated on its backup port.
  CODES: { normal: 1, red: 2, green: 3, blue: 4, white: 5, hlines: 6, vlines: 7, slash: 8, gray: 9, mixed: 10, locate: 3 },
  rxAddrs: function (d, targets) {
    if (!targets) return [{ dst: 255, port: 255, card: 65535 }];
    var out = [], seen = {}, pairs = hwPairs(d);
    var add = function (dst, port, card) { var k = dst + ':' + port + ':' + card; if (!seen[k]) { seen[k] = 1; out.push({ dst: dst, port: port, card: card }); } };
    targets.forEach(function (t) {
      add(t.card, t.port, t.index);
      pairs.forEach(function (q) { if (q.ps === t.card && q.pp === t.port) add(q.bs, q.bp, t.index); });
    });
    return out;
  },
  runRx: function (d, ops, what) {
    var n = (d.hw.senders || []).length || cardsOfDevice(d).length;
    return DRV.post('lct', '/api/hw/run', { host: d.hw.host, port: d.hw.port, plan: { senders: n, ops: ops } }).then(function (r) {
      var nw = ops.filter(function (o) { return o.op === 'w'; }).length;   // notes and waits aren't writes
      return drvResult(r.ok, { error: r.error, writes: nw, text: r.ok ? what + ' (' + nw + ' write' + (nw === 1 ? '' : 's') + ' acknowledged)' : what + ' failed: ' + r.error });
    });
  },
  rxOps: function (addrs, addr, hex) { return addrs.map(function (a) { return { op: 'w', dev: 1, dst: a.dst, port: a.port, card: a.card, addr: addr, hex: hex }; }); },
  display: function (d, mode, targets) {
    var A = DRV_LCT.rxAddrs(d, targets), ops = [], cards = targets ? targets.map(function (t) { return t.card; }).filter(function (c, i, a) { return a.indexOf(c) === i; }) : [255];
    var freeze = function (hex) { return cards.map(function (c) { return { op: 'w', dev: 1, dst: c, port: 255, card: 65535, addr: 0x02000102, hex: hex }; }); };
    if (mode === 'blackout') ops = DRV_LCT.rxOps(A, 0x02000100, 'FF');
    else if (mode === 'freeze') ops = freeze('FF');
    else ops = freeze('00').concat(DRV_LCT.rxOps(A, 0x02000101, '01'), DRV_LCT.rxOps(A, 0x02000101, '00'), DRV_LCT.rxOps(A, 0x02000100, '00'));
    return DRV_LCT.runRx(d, ops, mode === 'normal' ? 'Normal' : mode === 'blackout' ? 'Blackout' : 'Freeze');
  },
  pattern: function (d, code, targets) {
    var c = DRV_LCT.CODES[code]; if (!c) return DRV.unsupported('That test pattern');
    var A = DRV_LCT.rxAddrs(d, targets), hx = ('0' + c.toString(16).toUpperCase()).slice(-2);
    return DRV_LCT.runRx(d, DRV_LCT.rxOps(A, 0x02000101, hx).concat(DRV_LCT.rxOps(A, 0x02000100, '00')), 'Test pattern ' + code);
  },
  // Screen settings. Brightness as LCT's Brightness window (docs\COLOR_BRIGHTNESS.md §2.1 [R]): per (sender, port) of the
  // screen, all cards, mirrored to the backup port: rx 0x02000001 = v (0-255) then 0x020001E3 = F0 F0 F0 00. Colour
  // temperature = NovaLCT's frames byte for byte (tools\test_lct_color.py); gamma = the helper's closed form (16-bit cards).
  // Gamut and input bit depth are not offered (COLOR_BRIGHTNESS.md §5.2: the matrix needs the panel's measured primaries).
  // NovaLCT's colour temperature table (Bin\CommonData\ColorTRGBMapping.bin, deg_2 rows): 1700-9900 K in 100 K steps ->
  // per-colour brightness [R, G, B]; 6500 K = 255 / 255 / 255 (COLOR_BRIGHTNESS.md §4, 3200 K = FE B3 42 on the wire [R]).
  CT: [[254,90,1],[254,98,3],[254,106,5],[254,113,8],[254,120,12],[254,127,16],[254,133,20],[254,139,24],[254,145,28],[254,151,30],[254,156,38],[254,161,44],[254,166,49],[254,170,55],[254,175,60],[254,179,66],[254,183,73],[254,186,79],[254,190,85],[254,193,91],[254,197,97],[254,199,104],[254,202,110],[254,205,116],[254,208,122],[254,210,129],[254,213,135],[254,215,141],[254,217,147],[254,222,155],[254,228,164],[254,231,171],[254,229,174],[254,227,177],[254,228,183],[254,230,189],[254,231,195],[254,233,200],[254,234,206],[254,235,212],[254,236,217],[254,237,220],[254,238,223],[254,239,229],[254,241,236],[254,242,242],[254,243,248],[254,244,252],[255,255,255],[247,238,254],[243,234,254],[239,231,254],[235,228,254],[231,225,254],[227,222,254],[224,220,254],[221,217,254],[218,215,254],[215,212,254],[212,210,254],[209,208,254],[207,206,254],[204,203,254],[202,201,254],[200,200,254],[198,198,254],[195,196,254],[194,195,254],[192,193,254],[190,191,254],[188,190,254],[186,188,254],[184,186,254],[183,185,254],[181,183,254],[179,182,254],[178,181,254],[177,180,254],[175,178,254],[174,177,254],[173,176,254],[171,175,254],[170,174,254]],
  screenSet: function (d, action, value, ports) {
    if (action === 'colortemp') {   // per port: R and VR (= R) on all ports, then G, then B — as NovaLCT does [R]
      var K = Math.max(1700, Math.min(9900, Math.round(value / 100) * 100)), rgb = DRV_LCT.CT[(K - 1700) / 100];
      var AC = DRV_LCT.rxAddrs(d, ports.map(function (p) { return { card: p.card, port: p.port, index: 65535 }; })), hx = function (n) { return ('0' + n.toString(16).toUpperCase()).slice(-2); };
      var ops = [].concat(
        [].concat.apply([], AC.map(function (a) { return DRV_LCT.rxOps([a], 0x02000002, hx(rgb[0])).concat(DRV_LCT.rxOps([a], 0x02000005, hx(rgb[0]))); })),
        DRV_LCT.rxOps(AC, 0x02000003, hx(rgb[1])), DRV_LCT.rxOps(AC, 0x02000004, hx(rgb[2])));
      return DRV_LCT.runRx(d, ops, 'Colour temperature ' + K + ' K');
    }
    if (action === 'gamma') {   // the helper reads the cards' grey depth first and only writes 16-bit cards (the confirmed case)
      if ((P.bitDepth || 8) !== 8) return DRV.unsupported('Gamma on NovaLCT processors with a ' + P.bitDepth + '-bit source (confirmed for 8-bit only)');
      var prim = ports.map(function (p) { return { dst: p.card, port: p.port }; }), all = prim.slice(), seen = {};
      prim.forEach(function (t) { seen[t.dst + ':' + t.port] = 1; });
      hwPairs(d).forEach(function (q) { prim.forEach(function (t) { if (q.ps === t.dst && q.pp === t.port && !seen[q.bs + ':' + q.bp]) { seen[q.bs + ':' + q.bp] = 1; all.push({ dst: q.bs, port: q.bp, backupOf: [t.dst, t.port] }); } }); });   // the helper reads through it when the primary is down
      return DRV.post('lct', '/api/hw/gamma', { host: d.hw.host, port: d.hw.port, targets: all, gamma: value }).then(function (r) {
        var sk = (r.skipped || []).length ? ' — not on ' + r.skipped.join('; ') : '';
        return drvResult(r.ok, { error: r.error, writes: r.frames, warnings: r.skipped || [], text: r.ok ? 'Gamma ' + value + ' on ' + r.ports + ' port' + (r.ports === 1 ? '' : 's') + sk : 'Gamma failed: ' + r.error });
      });
    }
    if (action !== 'brightness') return DRV.unsupported('That setting');
    var v = Math.max(0, Math.min(255, Math.round(value * 255 / 100))), hx = ('0' + v.toString(16).toUpperCase()).slice(-2);
    var A = DRV_LCT.rxAddrs(d, ports.map(function (p) { return { card: p.card, port: p.port, index: 65535 }; }));
    var ops = [];
    A.forEach(function (a) { ops.push.apply(ops, DRV_LCT.rxOps([a], 0x02000001, hx).concat(DRV_LCT.rxOps([a], 0x020001E3, 'F0F0F000'))); });
    return DRV_LCT.runRx(d, ops, 'Brightness ' + value + ' %');
  },
  // What the cards hold now (read-only, /api/hw/color-read: card 0 of each port of the screen, through the backup port when
  // the primary doesn't answer), read as NovaLCT's windows read it (docs\COLOR_BRIGHTNESS.md §1): brightness = 0x02000001
  // as % (LCT's label v·100/255); gamma = 0x02000000 & 0x3F / 10 (254 / 255 = a custom table; with a 10 / 12-bit source,
  // sender 0x03100109 = 5A / 78, LCT shows the sending card's gamma, not read here); colour temperature = the first row of
  // the 83-row table equal to R / G / B (as LCT's colour window shows it; none = adjusted by hand); gamut (shown, not settable yet):
  // 0x02000130 FF = colour space off (Original), 02 + the 0x12009000 record's target = NovaLCT's PAL (Rec.709 primaries) or
  // NTSC / custom. -> {ok, values {k: v}, notes {k: why}, mixed [k]} (mixed = the ports hold different values).
  readColor: function (d, ports) {
    var prim = ports.map(function (p) { return { dst: p.card, port: p.port }; }), all = prim.slice(), seen = {};
    prim.forEach(function (t) { seen[t.dst + ':' + t.port] = 1; });
    hwPairs(d).forEach(function (q) { prim.forEach(function (t) { if (q.ps === t.dst && q.pp === t.port && !seen[q.bs + ':' + q.bp]) { seen[q.bs + ':' + q.bp] = 1; all.push({ dst: q.bs, port: q.bp, backupOf: [t.dst, t.port] }); } }); });
    return DRV.post('lct', '/api/hw/color-read', { host: d.hw.host, port: d.hw.port, targets: all }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error || 'read failed' });
      var per = (r.ports || []).filter(function (e) { return e.hex; }).map(function (e) { return DRV_LCT.colorOf(e); });
      if (!per.length) return drvResult(false, { error: (r.ports && r.ports[0] && r.ports[0].error) || 'no receiving card answered' });
      var values = {}, notes = {}, mixed = [];
      ['brightness', 'gamma', 'colorTemp', 'gamut'].forEach(function (k) {
        values[k] = per[0].v[k]; if (per[0].n[k]) notes[k] = per[0].n[k];
        if (per.some(function (x) { return x.v[k] !== per[0].v[k]; })) mixed.push(k);
      });
      return drvResult(true, { values: values, notes: notes, mixed: mixed, ports: per.length });
    });
  },
  // One port's read (hex of 0x02000000.., 0x02000130, the 0x12009000 record, sender 0x03100109) -> {v: values, n: notes}.
  colorOf: function (e) {
    var b = [], i, v = {}, n = {};
    for (i = 0; i < e.hex.length; i += 2) b.push(parseInt(e.hex.substr(i, 2), 16));
    v.brightness = Math.round(b[1] * 100 / 255);
    if (b[0] === 254 || b[0] === 255) { v.gamma = null; n.gamma = 'a custom gamma table'; }
    else if (e.src === 0x5A || e.src === 0x78) { v.gamma = null; n.gamma = 'a ' + (e.src === 0x5A ? 10 : 12) + '-bit source: the gamma is on the processor'; }
    else if ((b[0] & 0x3F) < 10 || (b[0] & 0x3F) > 40) { v.gamma = null; n.gamma = 'no gamma value on the cards'; }
    else v.gamma = (b[0] & 0x3F) / 10;
    v.colorTemp = null;
    for (i = 0; i < DRV_LCT.CT.length; i++) if (DRV_LCT.CT[i][0] === b[2] && DRV_LCT.CT[i][1] === b[3] && DRV_LCT.CT[i][2] === b[4]) { v.colorTemp = 1700 + i * 100; break; }
    if (v.colorTemp === null) n.colorTemp = 'R / G / B ' + b[2] + ' / ' + b[3] + ' / ' + b[4] + ' (not a table temperature)';
    var g = e.gamut ? parseInt(e.gamut, 16) : null; v.gamut = null;
    if (g === 0xFF) v.gamut = 'original';
    else if (g === 0x02 && e.record) {   // target xy at [40..51] as u16 LE ·10000; NovaLCT's PAL = Rec.709 primaries
      var u = function (o) { return parseInt(e.record.substr(o * 2 + 2, 2) + e.record.substr(o * 2, 2), 16); };
      var pal = [6400, 3300, 3000, 6000, 1500, 600], hit = pal.every(function (x, j) { return u(40 + 2 * j) === x; });
      if (hit) v.gamut = 'rec709'; else n.gamut = 'a NovaLCT colour space other than PAL / Rec.709';
    } else n.gamut = g === null ? 'not read' : 'colour space register ' + ('0' + g.toString(16).toUpperCase()).slice(-2);
    return { v: v, n: n };
  },
  // Low latency = LCT's two separate switches (docs\CAPTURE_LCT_DIALOGS.md [R]): sending card 0x02000074 = 78 / 00 once per
  // used port (to its sender), receiving cards 0x020001D5 = 55 / 00 per port.
  lowLatency: function (d, which, on, ports) {
    var ops = [];
    if (which === 'sender') ports.forEach(function (p) { ops.push({ op: 'w', dev: 0, dst: p.card, port: 0, card: 0, addr: 0x02000074, hex: on ? '78' : '00' }); });
    else ops = DRV_LCT.rxOps(DRV_LCT.rxAddrs(d, ports.map(function (p) { return { card: p.card, port: p.port, index: 65535 }; })), 0x020001D5, on ? '55' : '00');
    return DRV_LCT.runRx(d, ops, 'Low latency (' + (which === 'sender' ? 'processor' : 'receiving cards') + ') ' + (on ? 'on' : 'off'));
  },
  // The port backup pairs stored on the processor (REDU record, read as NovaLCT does) and each sending card's
  // device-backup role (0x0200009D). Read-only. Pairs: [card, port, backupCard, backupPort] on this link (0…).
  // The screen layout the processor holds (each sending card's NSSD record, what NovaLCT's "Read from HW" reads [R]):
  // {ok, cards: [{dst, screens} | {dst, empty} | {dst, error}], cabinets: [{card, port, index, x, y, w, h}]} — card =
  // the processor's own card order; cabinets is the shape Compare and the pre-show check use for every family.
  readLayout: function (d) {
    var n = (d.hw.senders || []).length || cardsOfDevice(d).length;
    return DRV.post('lct', '/api/hw/read-layout', { host: d.hw.host, port: d.hw.port, senders: n }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error || 'read failed' });
      var cabs = [];
      (r.cards || []).forEach(function (c) { (c.screens || []).forEach(function (s) { (s.CabinetInDevice || []).forEach(function (k) {
        if (k.DevID !== 255) cabs.push({ card: k.DevID, port: k.NetPort, index: k.ConnectID, x: k.XPos, y: k.YPos, w: k.Width, h: k.Height });
      }); }); });
      return drvResult(true, { cards: r.cards, cabinets: cabs });
    });
  },
  readBackup: function (d) {
    var n = (d.hw.senders || []).length || cardsOfDevice(d).length;
    return DRV.post('lct', '/api/hw/read-backup', { host: d.hw.host, port: d.hw.port, senders: n }).then(function (r) {
      return drvResult(r.ok, { pairs: r.pairs || [], roles: r.deviceBackup || [], note: r.note, error: r.error });
    });
  },
  // Backup verify = LCT's "Hot Backup Verification" (docs\CAPTURE_MCTRL4K_SEND.md [R]): each sending card holding pairs is
  // asked 0x02200139 (01 = supports it), then 0x020000AF = 01 switches it to its backup ports, 00 back. Live only, no save.
  // LCT's UI only allows pairs on one card; whether cards honour it across cards is untested on hardware (we say so).
  verifyBackup: function (d, mode) {
    if (mode === 'primary') return DRV.unsupported('Showing the primary ports only');
    var pairs = hwPairs(d), senders = [];
    pairs.forEach(function (q) { [q.ps, q.bs].forEach(function (s) { if (senders.indexOf(s) < 0) senders.push(s); }); });
    var n = (d.hw.senders || []).length || cardsOfDevice(d).length, on = mode === 'backup';
    var write = function (list) {
      return DRV_LCT.runRx(d, list.map(function (s) { return { op: 'w', dev: 0, dst: s, port: 0, card: 0, addr: 0x020000AF, hex: on ? '01' : '00' }; }), on ? 'Backup verify on' : 'Backup verify off');
    };
    // back to normal on EVERY sending card of the link: pairs may have been removed since verify was switched on
    if (!on) { var all = []; for (var i = 0; i < n; i++) all.push(i); return write(all); }
    if (!pairs.length) return Promise.resolve(drvResult(false, { error: 'no port backup pairs on this processor' }));
    return DRV.post('lct', '/api/hw/run', { host: d.hw.host, port: d.hw.port, plan: { senders: n, ops: senders.map(function (s) { return { op: 'r', dev: 0, dst: s, port: 0, card: 0, addr: 0x02200139, len: 1 }; }) } }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error });
      var ok = senders.filter(function (s) { return (r.tail || []).some(function (l) { return new RegExp('R d' + s + ' 0x02200139 -> 01').test(l); }); });
      if (!ok.length) return drvResult(false, { error: 'the processor doesn’t offer backup verification (0x02200139 isn’t 01)' });
      return write(ok).then(function (x) { if (ok.length < senders.length) x.text += ' — not supported on ' + (senders.length - ok.length) + ' card(s)'; x.cross = pairs.some(function (q) { return q.ps !== q.bs; }); return x; });
    });
  },
  mapping: function (d, on) {   // the cards draw their port / chain number (needs function-table support on the cards)
    return DRV_LCT.runRx(d, DRV_LCT.rxOps([{ dst: 255, port: 255, card: 65535 }], 0x01000088, on ? '05' : '01'), 'Mapping ' + (on ? 'on' : 'off'));
  },
  // Device info, read-only: the sending cards and each one's function table (0x02020020, as NovaLCT reads it on connect).
  // Free topology = FreeRoute (byte 4 bit 6, CROSS_TOOL §3.1): shown, and stored as d.hw.freeRoute; the capacity rule
  // still follows the Free topology switch until the H test confirms what the bit means.
  deviceInfo: function (d) {
    return DRV.post('lct', '/api/hw/info', { host: d.hw.host, port: d.hw.port, functions: true }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error });
      var fs = r.functions || [], rows = [['Link', hwWhere(d.hw.host, d.hw.port)],
        (r.senders || []).some(olHCard) ? ['Sending cards', r.senders.map(function (id, k) { return (k + 1) + ': ' + hwSenderName(id); }).join('; ')]   // H: its output cards
          : ['Model', (r.senders || []).map(hwSenderName).join(' + ') || 'didn’t answer']];   // a fixed processor (several: cascaded on this link)
      var fr = fs.map(function (f) { return f && !f.error ? f.freeRoute : null; });
      rows.push(['Free topology (FreeRoute)', fr.length ? fr.map(function (v, k) { return (fr.length > 1 ? (k + 1) + ': ' : '') + (v === null ? 'couldn’t read' : v ? 'reported' : 'not reported'); }).join('; ') +
        ' · Open Nova counts ' + (procFreeTopology(d) ? 'cabinet areas' : 'rectangles') + ' (Processor properties ▸ Free topology)' : 'not read']);
      fs.forEach(function (f, k) { rows.push(['Function table ' + (fs.length > 1 ? 'card ' + (k + 1) : ''), f && f.hex ? f.hex.toUpperCase().match(/../g).join(' ') : (f && f.error) || '—']); });
      if (fr.some(function (v) { return v !== null; })) d.hw.freeRoute = fr.every(function (v) { return v === true; });
      return drvResult(true, { rows: rows, inputs: [] });
    });
  },
  // The user's Clear (Monitor), as NovaLCT's "Clear Errors" (docs\CAPTURE_BER.md [R]): rx 0x01000076 <- 05 zeroes the cards'
  // bit-error counts — per cabinet (+ the same index on its backup port, rxAddrs) or one broadcast for the whole processor.
  // targets = null or [{card (0… on the link), port, index}]. Never saves. The next poll reads the counters again.
  clearErrors: function (d, targets) {
    return DRV.post('lct', '/api/hw/ber-clear', { host: d.hw.host, port: d.hw.port, targets: targets ? DRV_LCT.rxAddrs(d, targets) : null }).then(function (r) {
      if (DRV_LCT.extrasAt) delete DRV_LCT.extrasAt[d.id];
      return drvResult(r.ok, { hw: true, busy: !!r.busy, error: r.error, written: r.written || 0,
        text: r.ok ? 'bit-error counters cleared (0x01000076 ← 05, ' + (targets ? r.written + ' card address' + (r.written === 1 ? '' : 'es') : 'all cards') + ')' + (r.failed ? ', ' + r.failed + ' didn’t answer' : '') : 'clear failed: ' + r.error });
    });
  },
  // Health; every 30 s also the bit errors / disconnects / power supplies (3 more reads per cabinet — app-health keeps
  // the last values in between).
  monitor: function (d, o) {
    var cards = cardsOfDevice(d), now = Date.now(), ex = DRV_LCT.extrasAt || (DRV_LCT.extrasAt = {});
    var extras = !ex[d.id] || now - ex[d.id] > 30000; if (extras) ex[d.id] = now;
    return DRV.post('lct', '/api/hw/health', { host: d.hw.host, port: d.hw.port, known: o.known || {}, pairs: o.pairs || [], extras: extras,
      cards: cards.map(function (c, i) { return { dst: i, ports: P.processors[c].ports }; }) }).then(function (r) {
      if (r.ok && r.health) r.health.extras = extras;   // this poll read bit errors / disconnects / power supplies (app-health)
      if (r.busy && extras) delete ex[d.id];             // the helper's link is held by a Send / Save: read them next time
      return r.ok ? drvResult(true, { health: r.health }) : drvResult(false, { error: r.error || 'health failed', busy: !!r.busy });
    });
  },
  // ---------------------------------------------------------------- Correction tab (app-correction.js, helper /api/hw/calib)
  // NovaLCT's calibration windows as captured (docs\CAPTURE_CALIBRATION.md [R]): the Online Calibration switch (0x02000051
  // + 0x010000B3 per port, card all, primaries only), Reset Coeffs. (0x01000024 op 2, identity, per card), View Receiving
  // Card (0x01000006), View Module Calib. (0x01000007), Save Calibration Coef. / Save to HW (0x01000004), Flash Check
  // (0x01000074 + module topology). No upload, edit, erase or module-flash write (OPEN_NOVA_DESIGN §0). Read = per card the
  // switch byte, the function table (module flash) and two coefficient samples (flat / calibrated / empty).
  correctionCaps: function () { return { read: true, modes: ['off', 'brightness', 'chroma'], reset: true, reload: true, save: true, module: true, flashCheck: true }; },
  // op: read | switch (o.mode) | reset | reload | module | save (o.whole = per port, card all) | flashcheck;
  // o.targets = [{card (0… on the link), port, index, w, h}] -> {ok, writes, cabinets: [{card, port, index, mode, coef, moduleFlash, error, bad}]}
  correction: function (d, op, o) {
    o = o || {};
    var tg = (o.targets || []).map(function (t) { return { dst: t.card, port: t.port, index: t.index, w: t.w, h: t.h }; });
    return DRV.post('lct', '/api/hw/calib', { host: d.hw.host, port: d.hw.port, op: op, mode: o.mode, whole: !!o.whole, targets: tg, pairs: op === 'read' ? hwPairs(d) : [] }).then(function (r) {
      if (!r.ok) return drvResult(false, { error: r.error || op + ' failed' });
      return drvResult(true, { writes: r.writes || 0, busy: !!r.busy, cabinets: (r.cards || []).map(function (c) {
        return { card: c.dst, port: c.port, index: c.index, mode: c.state, coef: c.coef, moduleFlash: c.moduleFlash, via: c.via, error: c.error, modules: c.modules, bad: c.bad };
      }) });
    });
  }
};
DRV.register('lct', DRV_LCT);
