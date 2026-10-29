// Builds the register writes for "Send to processor" from a parsed .scr model (scr.js), the way NovaLCT V5.9.2 does
// its "Send to HW" (docs\CAPTURE_MCTRL4K_SEND.md, HW_OPERATIONS.md §2.1; verified against LCT captures of the same
// show file on the fake processor). The plan is plain data; tools\novalink.py sends it.
//
// Plan ops (all numbers plain, data as hex strings):
//   {op:'w', dev, dst, port, card, addr, hex, r2?, noReply?}  write (the helper splits > 256 B into 256-B frames)
//   {op:'r', dev, dst, port, card, addr, len}                 read (result logged only)
//   {op:'sleep', ms}
//   {op:'copy', from, to, ranges:[[addr,len,waitMs?]], slots:[[sender,src,dst,len]], set:[[addr,hex]]}
//                                                              read every range of sender `from`, patch in `slots` (bytes
//                                                              `src` of `sender` as read -> `dst`) and `set`, write them all
//                                                              to sender `to` in range order (LCT's backup-card copy, reduOps)
//   {op:'reduclear', senders, table}                           NovaLCT's Delete of every pair the processor's REDU record holds
//                                                              (backup port flag 00 on its card), then `table` to all
//   {op:'stash', dst, addr, len, key} / {op:'unstash', dst, addr, key}  read sending card bytes now, write them later
//   {op:'roles', senders, ports}                              read each card's 0x0200009D: 5A -> every port flag 00,
//                                                              A5 -> every port flag 80 (LCT's sending-card backup roles)
//   {op:'nssd', dst, json}                                     pack the NSSD layout record and write it at 0x05000000
//   {op:'note', text}                                          log line
// dev: 0 sending card, 1 receiving card, 3 distributor, 4 3D sender. dst 255 / port 255 / card 65535 = all.
// Never includes the Save sequence (receiving-card 0x01000011): Save stays a separate button (user rule).
(function (root) {
  'use strict';

  var ALL = 255, ALLCARDS = 65535, BC = { port: 255, card: 65535 };   // BC: LCT sends these with port and card = all too [R]
  // Send profiles: every sending-card / controller model NovaLCT V5.9.2 knows, with what its Send does differently per
  // model (docs\APP_SEND.md "Send profiles"). [name, ports, gates]:
  //   save   0x0200004A per card, then LCT's own save after the Send: SSPE, NSSD, sending-card commit. Without it LCT's
  //          Send ends at 0x020000AE (seen on the MSD300).
  //   sync   0x020000D4 video sync after the Send; see syncOp below.
  //   video  output window = the screen's box; otherwise the card's own cabinets' box.
  //   3d     0x02000089 (the 3D output offset).
  //   rotate 0x02700000 <- 00 to every card first (rotation off).
  // Ports = NovaLCT's port count per model. Names of the catalog's models are the app's. H9: NovaLCT counts it as a video
  // model, but both of its Sends to an H9 wrote the card's own box, so it isn't video here (H9 Planar by analogy [I]);
  // 0x02000089 came in one of them only (right after an MCTRL4K session), not in the other H9 recordings and not in
  // NovaLCT's Send to the real H2's 0x7B46 card: left out.
  var LCT_MODELS = {
    0x0001: ['MSD300 / MCTRL300', 2, ''], 0x0074: ['C3', 2, ''], 0x0101: ['MCTRL500', 4, ''],
    0x1101: ['MCTRL600 / 660', 4, 'save'], 0x1102: ['E500', 4, ''], 0x1103: ['MCTRL4K', 16, 'save 3d'],
    0x1104: ['MCTRL R5', 8, 'save rotate'], 0x1106: ['KT3', 4, 'save'], 0x1107: ['MCTRL660 Pro', 6, 'save'],
    0x1108: ['MCTRL660 ROE', 4, 'save'], 0x1109: ['PJ1', 6, 'save'], 0x110A: ['KT8', 8, 'save 3d'],
    0x1110: ['KT8E', 16, 'save 3d'], 0x1112: ['KT16C', 8, 'save 3d'], 0x1113: ['KT16E', 32, 'save 3d'],
    0x1116: ['MCTRL700 Pro', 6, 'save'], 0x1180: ['MTX4000', 20, 'save'], 0x1303: ['MCTRL600 A', 4, 'save'],
    0x1305: ['ASD200', 2, ''], 0x1306: ['KT16E CE', 24, 'save'], 0x1307: ['MP8 JF', 16, 'save'],
    0x1308: ['E510', 6, 'save'], 0x1309: ['MSD700 1', 6, 'save'], 0x2102: ['TVSend 4K', 4, 'save'],
    0x2103: ['Mee200', 16, 'save 3d'], 0x2104: ['Mee400', 32, 'save 3d'], 0x2105: ['Mee400C', 8, 'save 3d'],
    0x2107: ['Mee310', 12, ''], 0x2109: ['AMPS200N', 6, ''], 0x2110: ['ArtMorph PLAY', 6, ''],
    0x2111: ['Mee350', 12, ''], 0x2112: ['Mee400HPro', 32, 'save 3d'], 0x211D: ['KT20L', 1, 'save 3d'],
    0x5201: ['SX100', 1, 'save'], 0x6101: ['NovaPro HD', 4, 'save sync'], 0x6102: ['VP200', 4, 'save sync'],
    0x6103: ['V800', 2, 'save'], 0x6104: ['V900', 4, 'save sync'], 0x6105: ['VX2', 2, 'save sync'],
    0x6106: ['VX4', 4, 'save sync'], 0x6107: ['VX4S', 4, 'save sync'], 0x6108: ['V700', 2, 'save sync'],
    0x6109: ['VX5', 4, 'save sync'], 0x6110: ['Nova3DHD', 8, ''], 0x6112: ['K4', 4, 'save sync'],
    0x6113: ['K4S', 4, 'save sync'], 0x6114: ['VD43', 4, 'save sync'], 0x6115: ['TVctrl 230R', 6, 'save sync'],
    0x6116: ['VX2U', 2, 'save sync'], 0x6117: ['VX4U', 4, 'save sync'], 0x6118: ['K2U', 2, 'save sync'],
    0x6119: ['K4U', 4, 'save sync'], 0x6120: ['VX2S', 2, 'save sync'], 0x6121: ['NovaProHD II', 8, 'save'],
    0x6122: ['K4A', 4, 'save'], 0x6123: ['VS0', 2, 'save'], 0x6124: ['V760', 2, 'save sync'],
    0x6125: ['VD28', 2, 'save sync'], 0x6126: ['V960', 4, 'save sync'], 0x6127: ['VX1', 2, 'save sync'],
    0x6128: ['VX400S', 4, 'save sync'], 0x6129: ['K4S N', 4, 'save sync'], 0x612A: ['VX4S-N', 4, 'save sync'],
    0x6201: ['VX6', 6, 'save'], 0x6202: ['VX5S', 6, 'save'], 0x6203: ['VX6s', 6, 'save'],
    0x6204: ['K16', 16, 'save video'], 0x6205: ['Pro UHD Jr', 16, 'save video'], 0x6206: ['K6s', 6, 'save'],
    0x6207: ['V1060', 6, 'save'], 0x6208: ['V1260', 16, 'save'], 0x6209: ['Prime 4K', 16, 'save video'],
    0x620A: ['UTA3000', 6, 'save'], 0x620B: ['VX16s', 16, 'save'], 0x620C: ['VX1000', 10, 'save sync'],
    0x620D: ['V1160', 10, 'save sync'], 0x620E: ['VX600', 6, 'save sync'], 0x620F: ['V1060n', 6, 'save sync'],
    0x6210: ['DS D43V32', 32, 'save'], 0x6211: ['VX400', 4, 'save sync'], 0x6212: ['V2460', 24, 'save'],
    0x6213: ['VX400SN', 4, 'save'], 0x6214: ['V1260n', 16, 'save'], 0x6215: ['VC10', 10, 'save sync'],
    0x6216: ['DSP600', 6, 'save sync'], 0x6217: ['DSP400', 4, 'save sync'], 0x6218: ['VC2', 2, 'save sync'],
    0x6219: ['VC4', 4, 'save sync'], 0x621A: ['VC24', 24, 'save'], 0x621B: ['K8', 8, 'save'],
    0x621C: ['K20', 20, 'save'], 0x621D: ['K40', 40, 'save'], 0x621E: ['VC6', 6, 'save sync'],
    0x621F: ['V6', 6, 'save'], 0x6220: ['V8', 8, 'save'], 0x6221: ['V10', 10, 'save'],
    0x6222: ['V12', 12, 'save'], 0x6223: ['V16', 16, 'save'], 0x6224: ['V24', 24, 'save'],
    0x6225: ['V32', 32, 'save'], 0x6226: ['V40', 40, 'save'], 0x6227: ['VC6 Pro', 6, 'save'],
    0x6228: ['VC10Pro', 10, 'save'], 0x6229: ['VX400 Pro', 4, 'save'], 0x622A: ['VX600 Pro', 6, 'save'],
    0x622B: ['VX1000 Pro', 10, 'save'], 0x622C: ['VX2000 Pro', 20, 'save'], 0x622D: ['VX200s N', 2, 'save sync'],
    0x622E: ['VC16', 16, 'save'], 0x622F: ['CMS130', 2, 'save sync'], 0x6230: ['CMS260', 4, 'save'],
    0x6231: ['SGS3400 10', 10, 'save'], 0x6232: ['SGS3400 20', 20, 'save'], 0x6233: ['PD3 S10', 10, 'save'],
    0x6234: ['PD3 S20', 20, 'save'], 0x6235: ['VC4S', 4, 'save'], 0x6236: ['HC20 Pro', 20, 'save'],
    0x6237: ['VX1000Plus', 10, 'save'], 0x6238: ['CMS650', 10, 'save'], 0x6239: ['CMS390', 6, 'save'],
    0x624A: ['VC24Pro', 24, 'save'], 0x624B: ['VC16Pro', 16, 'save'], 0x624E: ['V980', 6, 'save sync'],
    0x7101: ['VS1', 4, 'save sync'], 0x7102: ['VS2', 2, 'save'], 0x7103: ['VS3', 2, 'save'],
    0x7109: ['MCTRL4K ViewPro', 1, 'save'], 0x7302: ['Thundervier S1', 1, ''], 0x7504: ['NovaPro UHD', 16, 'save'],
    0x7B46: ['H9 / H_16', 16, 'save'], 0x7B48: ['H_20', 20, 'save video'], 0x7B4A: ['H 4xFiber', 32, 'save video'],
    0x7B4F: ['H 8xFiber', 40, 'save video'], 0x7D41: ['MGT1000', 10, 'save'], 0x7D46: ['MGT400', 4, 'save'],
    0x7D47: ['MGT600', 6, 'save'], 0x7D48: ['MGT1600', 16, 'save'], 0x7D49: ['SGS1000', 10, 'save'],
    0x7D4A: ['SGS1600', 16, 'save'], 0x7D4B: ['MGT2000', 20, 'save'], 0x7D4C: ['SGS2000', 20, 'save'],
    0x7D4E: ['SGS400', 4, 'save'], 0x7D4F: ['SGS600', 6, 'save'], 0x8200: ['TAISHAN 8xFiber', 40, 'save video'],
    0x8201: ['TAISHAN 4xFiber', 20, 'save video'], 0x9046: ['H9 Planar', 16, 'save'], 0x9048: ['H_20 Planar', 20, 'save video'],
    0x904A: ['H Planar 4xFiber', 32, 'save video'], 0x9101: ['MCTRL700', 6, ''], 0x9611: ['T80', 4, ''],
    0x9999: ['TwoInOne', 20, 'save']
  };
  // NovaLCT sends these another way: a different Send when the input is DVI …
  var LCT_DVI = {
    0x1105: 'MCTRL1600', 0x110D: 'LP10SD1600', 0x1115: 'MCTRL2000', 0x1302: 'SD2000E', 0x130C: 'KT16 ZM',
    0x130E: 'FTSC4000 E', 0x7505: 'E8000 1', 0x7647: 'E8000 2', 0x7648: 'E8000 3'
  };
  // … or they are asynchronous players (NovaLCT's hardware list marks them: it sets a resolution instead).
  var LCT_ASYNC = {
    0x2106: 'Mee210', 0x2108: 'TU20Pro', 0x210A: 'TU15Pro', 0x210B: 'TU15', 0x210C: 'TU20', 0x210E: 'SMP4Pro',
    0x210F: 'SMP6Pro', 0x2114: 'TU30Pro', 0x2115: 'TU30', 0x2116: 'TU40Pro', 0x2117: 'TU40', 0x2119: 'TV4',
    0x211B: 'TU4K', 0x211C: 'TU4KPro', 0x211E: 'SMP20Pro', 0x9601: 'JZ AX100', 0x9602: 'T3', 0x9604: 'T6',
    0x9605: 'T1', 0x9606: 'T2', 0x9608: 'T8', 0x9609: 'JT100', 0x960A: 'T1 4G', 0x960B: 'T2 4G', 0x960C: 'T4',
    0x960D: 'TCC50', 0x960F: 'TCC60 YJ', 0x9612: 'JT50', 0x9613: 'TCC70', 0x9614: 'T4A', 0x9615: 'LCC70',
    0x9616: 'T3H', 0x9617: 'T4H', 0x9618: 'T6H', 0x9619: 'T8H', 0x961B: 'T40', 0x961C: 'T50', 0x961D: 'T60',
    0x961E: 'JT20', 0x9620: 'T30', 0x9621: 'JT200', 0x9622: 'DS D40T02 N', 0x9623: 'DS D43T02 N',
    0x9624: 'DS D40T04 N', 0x9625: 'DS D43T04 N', 0x9626: 'DS D40T01', 0x9627: 'DS D43T01', 0x9628: 'T10 O',
    0x9629: 'T30 J', 0x962A: 'T50 J', 0x962B: 'T60 J', 0x962D: 'DS D40T01 N', 0x962E: 'DS D40A03',
    0x962F: 'DS D43T01 N', 0x9637: 'TCC160', 0x9638: 'AD20', 0x9639: 'T10Plus', 0x963A: 'T20 O', 0x963B: 'T16Pro',
    0x963C: 'JT50Plus', 0x963E: 'T10', 0x963F: 'T20', 0x9641: 'LYD NTB10', 0x9642: 'LYD NTB20', 0x9643: 'TN65',
    0x9644: 'TB40Plus', 0x9645: 'TB40N', 0x9646: 'TCC80', 0x9647: 'N4H', 0x9648: 'T10N', 0x9649: 'T20N'
  };
  // Byte-compared with NovaLCT's own Send of the same layout to the fake processor.
  var CAPTURED = { 0x1103: 1, 0x7B46: 1, 0x7B48: 1, 0x7B4A: 1, 0x7B4F: 1, 0x6205: 1, 0x620C: 1, 0x0001: 1 };
  var MODELS = {};
  Object.keys(LCT_MODELS).forEach(function (k) {
    var r = LCT_MODELS[k], g = ' ' + r[2] + ' ';
    MODELS[k] = { name: r[0], ports: r[1], save: g.indexOf(' save ') >= 0, sync: g.indexOf(' sync ') >= 0, video: g.indexOf(' video ') >= 0,
      threeD: g.indexOf(' 3d ') >= 0, rotate: g.indexOf(' rotate ') >= 0, verified: CAPTURED[k] ? 'capture' : 'code' };
  });
  // Why a ModelID can't be sent (null = it can).
  function refusal(id) {
    if (MODELS[id]) return null;
    var hx = '0x' + (id || 0).toString(16).toUpperCase();
    if (LCT_DVI[id]) return 'NovaLCT sends the ' + LCT_DVI[id] + '’s layout another way (it depends on its DVI input); Open Nova doesn’t build that Send yet';
    if (LCT_ASYNC[id]) return 'The ' + LCT_ASYNC[id] + ' is an asynchronous player (NovaLCT sets its resolution instead); Open Nova doesn’t send layouts to it';
    return 'Open Nova doesn’t know sending card ModelID ' + hx + ' (it isn’t in NovaLCT’s model lists), so it won’t send to it';
  }

  function hex(bytes) { return Array.prototype.map.call(bytes, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
  function u16(v) { return [v & 255, (v >> 8) & 255]; }
  function u32(v) { return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
  function bcd(n) { return ((Math.floor(n / 10) % 10) << 4) | (n % 10); }

  // per-port register addresses, p = 0-based port: NovaLCT's layout for any port count (the flag, port block and
  // cards-per-port addresses go on in a new bank at port 4, 8 and 16)
  function flagAddr(p) { return p < 4 ? 0x02000018 + p : p < 8 ? 0x02000098 + p - 4 : p < 16 ? 0x02000100 + p - 8 : 0x02010040 + p - 16; }
  function blockAddr(p) { return p < 4 ? 0x02000050 + 9 * p : p < 8 ? 0x020000B0 + 9 * (p - 4) : p < 16 ? 0x02000130 + 9 * (p - 8) : 0x02010240 + 9 * (p - 16); }
  function countAddr(p) { return p < 8 ? 0x03100000 + 0x20 * p : p < 16 ? 0x03100200 + 0x20 * (p - 8) : 0x03100300 + 0x20 * (p - 16); }
  function coordAddr(p) { return 0x03000000 + p * 0x1000; }

  // Free route (sender FreeRoute bit, 0x02020024 byte 4 bit 6): NovaLCT packs each port's cabinets into rectangles and the
  // receiving-card coordinates point into that packed picture (byte-identical to NovaLCT's Send to the real H2,
  // recorded 2026-10-11).
  // 1. rows: cabinets with the same Y, by X; touching same-height neighbours merge into one segment;
  // 2. areas: consecutive segments with the same X and width that touch vertically merge;
  // 3. packed coordinates: X - area.X, Y stacked area under area (an area inside the next one doesn't add height);
  // 4. an area inside another takes that one's rectangle; one more record = the widest area (not in 220W mode).
  // complex (a Complex screen's port, as NovaLCT packs those): before step 3 an
  // area inside another area of the port is dropped (of equal ones the first stays), so it adds no record and no height.
  function freeRoute(list, complex) {
    var ys = [], segs = [], areas = [], recs, pos = [], acc = 0, best = { w: 0 };
    function box(c) { return { x: c.x, y: c.y, w: c.width, h: c.height }; }
    function inside(o, i) { return i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h; }
    function same(a, b) { return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h; }
    list.forEach(function (c) { if (ys.indexOf(c.y) < 0) ys.push(c.y); });
    ys.sort(function (a, b) { return a - b; }).forEach(function (y) {
      var row = list.filter(function (c) { return c.y === y; }).sort(function (a, b) { return a.x - b.x; });
      segs.push(box(row[0]));
      for (var l = 0; l < row.length - 1; l++) {
        if (row[l].height === row[l + 1].height && row[l].x + row[l].width === row[l + 1].x) segs[segs.length - 1].w += row[l + 1].width;
        else segs.push(box(row[l + 1]));
      }
    });
    areas.push(Object.assign({}, segs[0]));
    for (var m = 0; m < segs.length - 1; m++) {
      var a = segs[m], b = segs[m + 1];
      if (a.x === b.x && a.w === b.w && a.y + a.h === b.y) areas[areas.length - 1].h += b.h; else areas.push(Object.assign({}, b));
    }
    if (complex) {
      var drop = [];
      areas.forEach(function (r, n) {
        areas.forEach(function (o, k) {
          if (n === k || !inside(r, o)) return;
          if (!inside(o, r) || !drop.some(function (q) { return same(q, r); })) { if (drop.indexOf(o) < 0) drop.push(o); }
        });
      });
      areas = areas.filter(function (r) { return drop.indexOf(r) < 0; });
    }
    areas.forEach(function (r, n) {
      list.forEach(function (c, i) { if (!pos[i] && inside(r, box(c))) pos[i] = { x: c.x - r.x, y: c.y - r.y + acc }; });
      var nx = areas[n + 1];
      if (nx && !inside(nx, r) && !inside(r, nx)) acc += r.h;
    });
    recs = areas.map(function (r) { return Object.assign({}, r); });
    recs.forEach(function (r) { recs.forEach(function (o) { if (inside(r, o)) { o.x = r.x; o.y = r.y; o.w = r.w; o.h = r.h; } }); });
    recs.forEach(function (r) { if (r.w > best.w) best = Object.assign({}, r); });
    recs.push(best);
    return { recs: recs, pos: pos };
  }
  function frRecord(r) { return [0].concat(u16(r.w), u16(r.h), u16(r.x), u16(r.y), [0, 0, 0, 0, 0, 0, 0]); }

  function uuid() {
    var b = new Uint8Array(16);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.random() * 256 | 0;
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = hex(b); return h.substr(0, 8) + '-' + h.substr(8, 4) + '-' + h.substr(12, 4) + '-' + h.substr(16, 4) + '-' + h.substr(20);
  }

  // Complex = LCT type 2, or 3 (its irregular screen, which it sends as a Complex one); everything else with cells is Standard
  function isComplex(s) { return s.type === 2 || s.type === 3; }

  function bbox(list) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    list.forEach(function (c) { x0 = Math.min(x0, c.x); y0 = Math.min(y0, c.y); x1 = Math.max(x1, c.x + c.width); y1 = Math.max(y1, c.y + c.height); });
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, x1: x1, y1: y1 };
  }

  // NSSD ScreenDataInSoftSpace lists per sending card (as NovaLCT writes them): each card stores the
  // screens it drives; a Standard screen's blank cells (sender 255) go to the card of the screen's first real cabinet.
  // Cabinets are listed row-major. Key order matches LCT's JSON.
  // A Complex screen (as NovaLCT's Send of a Complex layout to an H_20 card writes it, recorded 2026-09-27): ScrType 2,
  // its cabinets per card in the screen's own order, and nothing else filled in: DviSelect stays NovaLCT's
  // default 88 (DVI), ScrX / ScrY / CabinetCol / CabinetRow 0, DVIlist {}, row / column / DVI index 0. (A Standard screen's
  // DviSelect is the card's video input 0x02000023 as LCT read it when the screen was edited: the fakes answer 5 = HDMI,
  // the real H 95 = DP. Nothing reads it back but an empty branch, so 5 stays.)
  // Several screens (one processor's Screen 1, 2 …, as NovaLCT's multi-screen Sends): ScreenIndex = the screen's place in
  // model.screens (0…, the processor's own numbering), each card's list in that order, a screen on several cards listed on
  // each with its own cabinets (byte-compared: NovaLCT's Sends of 2–8 screens to five H_20 cards). s.uuid = the screen's UUID (the
  // app keeps one per screen, as NovaLCT does), else a new one.
  function nssdScreens(model) {
    var per = {};
    model.screens.forEach(function (s, si) {
      if (s.type === 0) throw new Error('Screen ' + (si + 1) + ' is a Simple screen; Open Nova sends Standard and Complex screens only');
      if (isComplex(s)) {
        var cid = s.uuid || uuid();
        (s.cells || s.regions || []).forEach(function (c) {
          if (c.sender === 255) return;
          var list = per[c.sender] || (per[c.sender] = []), scr = list.filter(function (x) { return x.UUID === cid; })[0];
          if (!scr) {
            scr = { UUID: cid, ScrType: 2, DviSelect: 88, VirMode: s.virtualMode || 0, ScrX: 0, ScrY: 0, CabinetCol: 0, CabinetRow: 0,
              PortCols: 0, PortRows: 0, DeviceID: 0, CabinetWidth: 0, CabinetHeight: 0, OnePortLoadInfo: [], CabinetInDevice: [], ScreenIndex: si, DVIlist: {} };
            list.push(scr);
          }
          scr.CabinetInDevice.push({ DevID: c.sender, NetPort: c.port, ConnectID: c.connect, XPos: c.x, YPos: c.y, Width: c.width, Height: c.height,
            GroupID: 0, RowIndexInScreen: 0, ColIndexInScreen: 0, DviIndex: 0 });
        });
        return;
      }
      var cells = s.cells.slice().sort(function (a, b) { return a.row - b.row || a.col - b.col; });
      var first = cells.filter(function (c) { return c.sender !== 255; })[0];
      var blankTo = first ? first.sender : 0;
      var o = s.dviOffsets || {}, dviList = { '1': (o.x1 || 0) + ', ' + (o.y1 || 0), '2': (o.x2 || 0) + ', ' + (o.y2 || 0),
        '3': (o.x3 || 0) + ', ' + (o.y3 || 0), '4': (o.x4 || 0) + ', ' + (o.y4 || 0) };
      var id = s.uuid || uuid();
      cells.forEach(function (c) {
        var d = c.sender === 255 ? blankTo : c.sender;
        var list = per[d] || (per[d] = []);
        var scr = list.filter(function (x) { return x.UUID === id; })[0];
        if (!scr) {
          scr = { UUID: id, ScrType: 1, DviSelect: 5, VirMode: s.virtualMode || 0, ScrX: s.x, ScrY: s.y, CabinetCol: s.cols, CabinetRow: s.rows,
            PortCols: 0, PortRows: 0, DeviceID: 0, CabinetWidth: 0, CabinetHeight: 0, OnePortLoadInfo: [], CabinetInDevice: [],
            ScreenIndex: si, DVIlist: dviList };
          list.push(scr);
        }
        scr.CabinetInDevice.push({ DevID: c.sender, NetPort: c.port, ConnectID: c.connect, XPos: c.x, YPos: c.y, Width: c.width, Height: c.height,
          GroupID: 0, RowIndexInScreen: c.row, ColIndexInScreen: c.col, DviIndex: c.dvi != null ? c.dvi : 1 });
      });
    });
    return per;
  }

  // opts: { modelId, senders (cascaded sending cards on the link), backup: [{ps, pp, bs, bp}] (0-based), now: Date }
  function buildSendPlan(model, opts) {
    var M = MODELS[opts.modelId];
    if (!M) throw new Error(refusal(opts.modelId));
    var nSenders = opts.senders || 1, pairs = opts.backup || [];
    var ops = [];
    function w(dst, addr, bytes, extra) { var o = { op: 'w', dev: 0, dst: dst, port: 0, card: 0, addr: addr, hex: hex(bytes) }; for (var k in extra || {}) o[k] = extra[k]; ops.push(o); }
    function rxw(dst, port, card, addr, bytes, extra) { var o = { op: 'w', dev: 1, dst: dst, port: port, card: card, addr: addr, hex: hex(bytes) }; for (var k in extra || {}) o[k] = extra[k]; ops.push(o); }

    // cabinets per (sender, port), in cable order
    // Complex screens (type 2, and 3 = LCT's irregular screen, which it also sends as a Complex one): cxCard / cxPort mark the
    // sending cards and ports that drive one (0x0200004A flag, free-route packing)
    var cabs = [], cxCard = {}, cxPort = {};
    model.screens.forEach(function (s, si) {
      if (s.type === 0) throw new Error('Screen ' + (si + 1) + ' is a Simple screen; Open Nova sends Standard and Complex screens only');
      (s.cells || s.regions || []).forEach(function (c) {
        if (c.sender === 255) return;
        cabs.push(c);
        if (isComplex(s)) { cxCard[c.sender] = 1; cxPort[c.sender + ':' + c.port] = 1; }
      });
    });
    if (!cabs.length) throw new Error('No cabinets to send');
    var bySender = {};
    cabs.forEach(function (c) {
      if (c.sender >= nSenders) throw new Error('The show file uses sending card ' + (c.sender + 1) + ' but the processor has ' + nSenders);
      if (c.port >= M.ports) throw new Error('The show file uses port ' + (c.port + 1) + ' but ' + M.name + ' has ' + M.ports);
      var s = bySender[c.sender] || (bySender[c.sender] = {}); (s[c.port] || (s[c.port] = [])).push(c);
    });
    var senders = Object.keys(bySender).map(Number).sort(function (a, b) { return a - b; });
    senders.forEach(function (d) { Object.keys(bySender[d]).forEach(function (p) { bySender[d][p].sort(function (a, b) { return a.connect - b.connect; }); }); });

    // screen bounding boxes (blank cells included), for the video-model output window (Standard screens only) and the
    // screen size 0x020001EC (a Complex screen: its cabinets' box, as NovaLCT works it out)
    var screenBoxes = model.screens.map(function (s) {
      var all = s.cells || s.regions || [], b = bbox(all);
      return { std: !isComplex(s), w: b.x1 - s.x, h: b.y1 - s.y, x1: b.x1, y1: b.y1, senders: all.filter(function (c) { return c.sender !== 255; }).map(function (c) { return c.sender; }) };
    });

    // Backup pairs (port backup): NovaLCT's layout Send mirrors each primary port onto its backup port as it goes (the
    // backup card's virtual-pixel byte, output window, port rectangle + card count, coordinate table), then runs its
    // redundancy Send's copy (reduOps) before 0x020000AE — see reduOps and docs\APP_SEND.md "Redundancy Send".
    pairCheck(pairs, M, nSenders, bySender);

    ops.push({ op: 'note', text: 'Send ' + model.screens.length + ' screen(s), ' + cabs.length + ' cabinets to ' + M.name + ' x' + nSenders + (pairs.length ? ', ' + pairs.length + ' backup pairs' : '') });
    w(ALL, 0x01000000, [0], { noReply: true });                       // arrange addresses
    for (var p = 0; p < M.ports; p++) w(ALL, flagAddr(p), [0]);       // per-port master/backup flags off
    if (M.rotate) w(ALL, 0x02700000, [0]);                             // MCTRL R5: rotation off first, as NovaLCT
    // complex-screen flag: 1 on a card that drives a Complex screen (01 in NovaLCT's Send of a Complex layout)
    if (M.save) senders.forEach(function (d) { w(d, 0x0200004A, [cxCard[d] ? 1 : 0]); });
    // The pair NovaLCT mirrors a card / a port onto: the first pair whose primary is that card / that card and port.
    var slaveOf = {}, slotOf = {};
    pairs.forEach(function (q) { if (slaveOf[q.ps] == null) slaveOf[q.ps] = q.bs; if (!slotOf[q.ps + ':' + q.pp]) slotOf[q.ps + ':' + q.pp] = q; });
    // virtual pixels off: only when the first screen is Standard, as NovaLCT (its Complex Send writes no 0x020000F0).
    // A card's backup card always gets the screen's virtual-pixel mode = the primary card's own 0x020000F0 as NovaLCT read
    // it when it loaded the screen, i.e. before this Send: FF in two of its recorded redundancy Sends (same card: d0 <- 00
    // then FF), 00 in another.
    // Open Nova reads it just before (op 'stash') and writes that.
    if (!isComplex(model.screens[0])) {
      senders.forEach(function (d) { if (slaveOf[d] != null) ops.push({ op: 'stash', dst: d, addr: 0x020000F0, len: 1, key: 'vm' + d }); });
      senders.forEach(function (d) { w(d, 0x020000F0, [0]); if (slaveOf[d] != null) ops.push({ op: 'unstash', dst: slaveOf[d], addr: 0x020000F0, key: 'vm' + d }); });
    }

    // output (DVI) window per sending card. Video models: W / H = the largest Standard screen box of the card
    // (as NovaLCT); NovaLCT has no case for Complex screens, so the first card (in card order [I]) with no
    // Standard screen throws there and it and every later card keep their own cabinets' box.
    var vstop = false;
    senders.forEach(function (d) {
      var all = []; Object.keys(bySender[d]).forEach(function (p) { all = all.concat(bySender[d][p]); });
      var b = bbox(all), W = b.w, H = b.h;
      if (M.video && !vstop) {
        var boxes = screenBoxes.filter(function (sb) { return sb.std && sb.senders.indexOf(d) >= 0; });
        if (!boxes.length) vstop = true;
        else { W = Math.max.apply(null, boxes.map(function (sb) { return sb.w; })); H = Math.max.apply(null, boxes.map(function (sb) { return sb.h; })); }
      }
      bySender[d].win = { x: b.x, y: b.y, w: W, h: H };
    });
    // 3D models: the right edge (X + width) of the last card's window, DVI 1 (as NovaLCT; left/right 3D, the default)
    if (M.threeD) { var lw = bySender[senders[senders.length - 1]].win; w(ALL, 0x02000089, u16(lw.x + lw.w).concat([0, 0, 0, 0, 0, 0]), BC); }
    // (each card's window again on its backup card, as NovaLCT)
    senders.forEach(function (d) {
      var v = bySender[d].win, W = v.w;
      [d].concat(slaveOf[d] != null ? [slaveOf[d]] : []).forEach(function (t) {
        w(t, 0x02000028, u16(v.x)); w(t, 0x0200002A, u16(v.y));
        w(t, 0x02000024, u16(W % 8 ? (Math.floor(W / 8) + 1) * 8 : W)); w(t, 0x02000026, u16(v.h)); w(t, 0x0200002C, u16(W));
      });
    });

    // port rectangles (relative to the card's window), cards per port, enable; a backup port gets the same rectangle and
    // card count, no enable (as NovaLCT's Send does for a backup port)
    senders.forEach(function (d) {
      Object.keys(bySender[d]).filter(function (k) { return k !== 'win'; }).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
        var list = bySender[d][p], b = bbox(list), a = blockAddr(p), win = bySender[d].win, q = slotOf[d + ':' + p];
        list.box = b;
        if (opts.freeRoute) { list.fr = freeRoute(list, !!cxPort[d + ':' + p]); list.xy = list.fr.pos; }
        else list.xy = list.map(function (c) { return { x: c.x - b.x, y: c.y - b.y }; });
        w(d, a + 5, u16(b.x - win.x)); w(d, a + 7, u16(b.y - win.y)); w(d, a + 1, u16(b.w)); w(d, a + 3, u16(b.h));
        w(d, countAddr(p), u16(list.length)); w(d, a, [0]);
        if (q) {
          var s = blockAddr(q.bp);
          w(q.bs, s + 5, u16(b.x - win.x)); w(q.bs, s + 7, u16(b.y - win.y)); w(q.bs, s + 1, u16(b.w)); w(q.bs, s + 3, u16(b.h));
          w(q.bs, countAddr(q.bp), u16(list.length));
        }
      });
    });

    // free route: each port's records at 0x03200000 + port * 0x4000, then the record count per port (as NovaLCT: all
    // records first, then the counts)
    if (opts.freeRoute) senders.forEach(function (d) {
      var ports = Object.keys(bySender[d]).filter(function (k) { return k !== 'win'; }).map(Number).sort(function (a, b) { return a - b; });
      ports.forEach(function (p) { bySender[d][p].fr.recs.forEach(function (r, i) { w(d, 0x03200000 + p * 0x4000 + i * 16, frRecord(r)); }); });
      ports.forEach(function (p) { w(d, 0x02030000 + 2 * p, u16(bySender[d][p].fr.recs.length)); });
    });

    // receiving-card coordinate tables: 1024 x {X,Y} relative to the port rectangle (free route: in the packed picture),
    // cyclic over the port's cards
    function coordTable(list) {
      var t = new Uint8Array(4096);
      for (var i = 0; i < 1024; i++) { var c = list.xy[i % list.length]; t.set(u16(c.x), 4 * i); t.set(u16(c.y), 4 * i + 2); }
      return t;
    }
    senders.forEach(function (d) {
      Object.keys(bySender[d]).filter(function (k) { return k !== 'win'; }).map(Number).sort(function (a, b) { return a - b; }).forEach(function (p) {
        var t = coordTable(bySender[d][p]), q = slotOf[d + ':' + p];
        w(d, coordAddr(p), t);
        if (q) w(q.bs, coordAddr(q.bp), t);   // the backup port's copy, as NovaLCT
      });
    });

    // receiving cards: scale off per port, then each card's cabinet size
    senders.forEach(function (d) { Object.keys(bySender[d]).filter(function (k) { return k !== 'win'; }).map(Number).forEach(function (p) { rxw(d, p, ALLCARDS, 0x0200009A, [0]); }); });
    senders.forEach(function (d) {
      Object.keys(bySender[d]).filter(function (k) { return k !== 'win'; }).map(Number).forEach(function (p) {
        bySender[d][p].forEach(function (c, i) { rxw(d, p, i, 0x02000017, u16(c.width)); rxw(d, p, i, 0x02000019, u16(c.height)); });
      });
    });
    ops.push({ op: 'sleep', ms: 50 });
    rxw(ALL, ALL, ALLCARDS, 0x01000012, [0xAA], { r2: 8 });            // receiving cards recalculate
    ops.push({ op: 'sleep', ms: 3000 });
    // screen size per card: the right / bottom edge of the screens it drives (as NovaLCT's Send)
    senders.forEach(function (d) {
      var sb = screenBoxes.filter(function (b) { return b.senders.indexOf(d) >= 0; });
      w(d, 0x020001EC, u16(Math.max.apply(null, sb.map(function (b) { return b.x1; }))).concat(u16(Math.max.apply(null, sb.map(function (b) { return b.y1; })))));
    });
    // port backup: NovaLCT's redundancy copy (reduOps): the primary ports' flags, the backup cards' copy, the pair table
    // and 0x020000D4 — then the one 0x020000AE (NovaLCT's Sends with backup pairs, also to the real H5 2026-10-11)
    if (pairs.length) ops.push.apply(ops, reduOps(M, opts.modelId, pairs, nSenders, !!opts.freeRoute));
    w(ALL, 0x020000AE, [1]);
    if (M.sync) ops.push(syncOp(model, pairs));
    if (!M.save) return result();   // LCT's Send ends here on these models: no SSPE / NSSD / commit (seen on the MSD300)

    // software space: (REDU), SSPE, invalidate + screen flag, NSSD per card, then LCT's built-in commit. REDU only while a
    // backup Send isn't saved yet (opts.redu: NovaLCT's Save writes it first; in its recordings a Send after an unsaved
    // backup Send carries REDU, a Send after the pairs were saved doesn't)
    // First LCT's sending-card backup roles again (as NovaLCT's Send does): each
    // card's 0x0200009D is read, a primary (5A) gets every port flag 00, a backup card (A5) every port 80 — the layout
    // Send zeroed them all at its start.
    ops.push({ op: 'roles', senders: nSenders, ports: M.ports });
    if (opts.redu) w(ALL, 0x05065000, reduRecord(pairs));
    var sspe = new Uint8Array(256); sspe.set([0x53, 0x53, 0x50, 0x45, 0xEA, 0x03]);
    w(0, 0x05066000, sspe);
    ops.push({ op: 'r', dev: 0, dst: 0, port: 0, card: 0, addr: 0x02100000, len: 2 });
    w(ALL, 0x05000000, [0, 0, 0, 0], BC);
    w(ALL, 0x02100000, [0x55, 0]);
    var nssd = nssdScreens(model);
    Object.keys(nssd).map(Number).sort(function (a, b) { return a - b; }).forEach(function (d) {
      ops.push({ op: 'nssd', dst: d, json: JSON.stringify({ ScreenDataInSoftSpace: nssd[d] }) });
    });
    w(ALL, 0x01000001, [0], { r2: 6 });                                // sending-card flash commit
    ops.push({ op: 'w', dev: 3, dst: ALL, port: ALL, card: ALLCARDS, addr: 0x05000000, hex: '00', r2: 6 });
    ops.push({ op: 'w', dev: 4, dst: ALL, port: ALL, card: ALLCARDS, addr: 0x01000011, hex: '00', r2: 6 });
    var t = opts.now || new Date();
    w(ALL, 0x02000011, [bcd(t.getFullYear() % 100), bcd(t.getMonth() + 1), bcd(t.getDate()), bcd(t.getHours()), bcd(t.getMinutes()), bcd(t.getSeconds())]);
    return result();
    function result() { return { model: M.name, modelId: opts.modelId, verified: M.verified, senders: nSenders, cabinets: cabs.length, pairs: pairs.length, freeRoute: !!opts.freeRoute, redu: !!(opts.redu && M.save), ops: ops }; }
  }

  // ---------------------------------------------------------------- port backup (NovaLCT's redundancy)
  // The rules NovaLCT's Send needs (bySender = the layout's cards / ports, or null): cards and ports exist, a port doesn't
  // back itself up (NovaLCT stops there), a backup port carries no panels, a backup on another card needs
  // a card without screens (its whole block is overwritten with the primary's).
  function pairCheck(pairs, M, n, bySender) {
    var where = function (s, p) { return 'sending card ' + (s + 1) + ' port ' + (p + 1); };
    pairs.forEach(function (q) {
      if (q.bs >= n || q.ps >= n) throw new Error('Backup pair uses a sending card the processor does not have');
      if (q.pp >= M.ports || q.bp >= M.ports) throw new Error('Backup pair uses port ' + (Math.max(q.pp, q.bp) + 1) + ' but ' + M.name + ' has ' + M.ports);
      if (q.ps === q.bs && q.pp === q.bp) throw new Error('A port can’t back itself up (' + where(q.ps, q.pp) + ')');
      if (!bySender) return;
      if (q.ps === q.bs) { if (bySender[q.ps] && bySender[q.ps][q.bp]) throw new Error(where(q.bs, q.bp) + ' drives panels itself, so it can’t also be the backup of port ' + (q.pp + 1)); return; }
      if (bySender[q.bs]) throw new Error('Sending card ' + (q.bs + 1) + ' drives screens, so it cannot be a backup card');
    });
  }
  // The blocks NovaLCT reads from a primary card and writes to its backup card, in write order [addr, len, wait ms after]:
  // the parameter block (2nd half
  // with > 8 ports or these models), ports 17+ (flags, DVI, rectangles), the coordinate tables, free route (count, records,
  // 3 s), the screen size (not VX6s / K6s), the cards per port last.
  var REDU_P16 = { 0x1105: 1, 0x130E: 1, 0x110D: 1, 0x1115: 1, 0x130C: 1, 0x1302: 1, 0x7B46: 1, 0x9046: 1, 0x7B48: 1, 0x9048: 1, 0x7505: 1, 0x7647: 1, 0x7648: 1 };
  var REDU_DVI = {}; Object.keys(REDU_P16).forEach(function (k) { if (+k !== 0x9048) REDU_DVI[k] = 1; });   // the H / DVI senders (all of REDU_P16 but the H_20 Planar), as NovaLCT
  function reduRanges(M, id, fr) {
    var r = [[0x02000000, 256]];
    if (M.ports > 8 || REDU_P16[id]) r.push([0x02000100, 256]);
    if (M.ports > 16) r.push([0x02010040, 80], [0x02010140, 192], [0x02010240, 512]);
    r.push([0x03000000, 4096 * (id === 0x7302 ? 2 : M.ports)]);
    if (fr) r.push([0x02030000, 256, 50], [0x03200000, 16384 * M.ports, 3000]);
    if (id !== 0x6203 && id !== 0x6206) r.push([0x020001EC, 4]);
    r.push([0x03100000, M.ports > 8 ? 512 + 32 * (M.ports - 8) : 512]);
    return r;
  }
  // NovaLCT's redundancy Send (as recorded with four H_20 cards 2026-09-27 and on the real H5 2026-10-11): the
  // sender-function read, each pair's primary port flag 00, then per backup card (in
  // the order the pairs name them) its new block = the first primary's block as read now, with each pair's backup port
  // flagged 0x80 and the primary port's rectangle (9 B), card count (32 B), coordinate table (and free-route count and
  // records) copied into the backup port's slot; then the pair table to
  // all (refused by the H: status 154, NovaLCT carries on) and each backup card's 0x020000D4 = its new block's (the primary's).
  // Same card (P1 -> P11): the card is its own backup card. Not done: the virtual-pixel registers (Open Nova sends no
  // virtual-pixel screens).
  function reduOps(M, id, pairs, n, fr) {
    var ops = [{ op: 'r', dev: 0, dst: 0, port: 0, card: 0, addr: 0x02020020, len: 64 }], slaves = [], seed = {}, ranges = reduRanges(M, id, fr);
    function w(dst, addr, bytes, extra) { var o = { op: 'w', dev: 0, dst: dst, port: 0, card: 0, addr: addr, hex: hex(bytes) }; for (var k in extra || {}) o[k] = extra[k]; ops.push(o); }
    pairs.forEach(function (q) { w(q.ps, flagAddr(q.pp), [0]); if (slaves.indexOf(q.bs) < 0) { slaves.push(q.bs); seed[q.bs] = q.ps; } });
    slaves.forEach(function (bs) {
      var slots = [], set = [];
      pairs.forEach(function (q) {
        if (q.bs !== bs) return;
        set.push([flagAddr(q.bp), '80']);
        // the port's DVI byte (0x020001B7 + p, ports 17+ at 0x02010140 + p - 16) on the H / DVI senders (NovaLCT's Send to
        // the real H2, 2026-10-11); a pair of two ports 17+ keeps the backup's own, as in LCT
        var dvi = function (p) { return p < 16 ? 0x020001B7 + p : 0x02010140 + p - 16; };
        if (REDU_DVI[id] && (q.pp < 16 || q.bp < 16)) slots.push([q.ps, dvi(q.pp), dvi(q.bp), 1]);
        slots.push([q.ps, blockAddr(q.pp), blockAddr(q.bp), 9], [q.ps, countAddr(q.pp), countAddr(q.bp), 32], [q.ps, coordAddr(q.pp), coordAddr(q.bp), 4096]);
        if (fr) slots.push([q.ps, 0x02030000 + 2 * q.pp, 0x02030000 + 2 * q.bp, 2], [q.ps, 0x03200000 + 16384 * q.pp, 0x03200000 + 16384 * q.bp, 16384]);
      });
      ops.push({ op: 'copy', from: seed[bs], to: bs, ranges: ranges, slots: slots, set: set });
    });
    w(ALL, 0x02300000, reduTable(pairs, n), { tolerate: true });
    slaves.forEach(function (bs) { ops.push({ op: 'copy', from: seed[bs], to: bs, ranges: [[0x020000D4, 5]] }); });
    return ops;
  }
  // NovaLCT's Delete (Redundancy page, as recorded): each removed pair's backup port flag 00 on its backup card, then the
  // table of the pairs that stay.
  function reduDeleteOps(remove, keep, n) {
    var ops = remove.map(function (q) { return { op: 'w', dev: 0, dst: q.bs, port: 0, card: 0, addr: flagAddr(q.bp), hex: '00' }; });
    ops.push({ op: 'w', dev: 0, dst: ALL, port: 0, card: 0, addr: 0x02300000, hex: hex(reduTable(keep, n)), tolerate: true });
    return ops;
  }
  // "Send backup" = NovaLCT's redundancy page Send (Sending Card ▸ Redundancy ▸ Send): every port flag 00 to all cards,
  // reduOps, 50 ms, 0x020000AE. No layout, no REDU record, no Save:
  // NovaLCT writes REDU only when you press its Save — Open Nova's Save does the same
  // (buildSavePlan opts.redu). model (optional) = the layout, for the rules a backup needs (pairCheck).
  // No pairs (everything cleared): NovaLCT's Delete of the pairs the processor holds (opts.prev; null = read from its REDU
  // record, op 'reduclear'), then the empty table; LCT's own Send refuses an empty list.
  // opts.remove: LCT's Delete of just those pairs, opts.backup = the pairs that stay.
  // opts: { modelId, senders, backup: [{ps, pp, bs, bp}], freeRoute, prev, remove }
  function buildRedundancyPlan(model, opts) {
    var M = MODELS[opts.modelId];
    if (!M) throw new Error(refusal(opts.modelId));
    var n = opts.senders || 1, pairs = opts.backup || [], ops = [], by = null;
    if (model) {
      by = {};
      model.screens.forEach(function (s) { (s.cells || s.regions || []).forEach(function (c) { if (c.sender !== 255) (by[c.sender] || (by[c.sender] = {}))[c.port] = 1; }); });
    }
    pairCheck(pairs, M, n, by);
    var res = function (kind) { return { redundancy: kind, model: M.name, modelId: opts.modelId, verified: M.verified, senders: n, pairs: pairs.length, ops: ops }; };
    if (opts.remove) { ops = reduDeleteOps(opts.remove, pairs, n); return res('delete'); }
    if (!pairs.length) {
      ops.push({ op: 'note', text: 'Clear the port backup on ' + M.name + ' x' + n });
      if (opts.prev) ops = ops.concat(reduDeleteOps(opts.prev, [], n));
      else ops.push({ op: 'reduclear', senders: n, table: hex(reduTable([], n)) });
      return res('clear');
    }
    ops.push({ op: 'note', text: 'Send port backup: ' + pairs.length + ' pairs to ' + M.name + ' x' + n });
    for (var p = 0; p < M.ports; p++) ops.push({ op: 'w', dev: 0, dst: ALL, port: 0, card: 0, addr: flagAddr(p), hex: '00' });
    ops = ops.concat(reduOps(M, opts.modelId, pairs, n, !!opts.freeRoute));
    ops.push({ op: 'sleep', ms: 50 }, { op: 'w', dev: 0, dst: ALL, port: 0, card: 0, addr: 0x020000AE, hex: '01' });
    return res('send');
  }

  // Video sync 0x020000D4 <- {enable u8, total W u16, total H u16} on the models with video sync ('sync' above).
  // The values are the screen's "Enable sync" + total size boxes: LCT fills them from the screen's first sending card's own
  // 0x020000D4 when it reads a size there, else from its graphics size, which is 3840 x 1920 when it
  // has none — enable off. LCT uses ONE shared entry for every card in its per-card list, so
  // every entry carries the last card it set (the last screen's last card, or that card's backup card) and the last screen's
  // values: the write goes to that one card, once per card in the list. VX1000 x2 capture: d1 <- 00 00 0F 80 07 twice [R].
  // The helper reads `from` and writes what it holds if both sizes are non-zero, else `hex` (op 'sync', novalink.py).
  function syncOp(model, pairs) {
    var keys = {}, to = 0, from = null, n = 0;
    model.screens.forEach(function (s) {
      var ss = []; (s.cells || s.regions || []).forEach(function (c) { if (c.sender !== 255 && ss.indexOf(c.sender) < 0) ss.push(c.sender); });
      ss.sort(function (a, b) { return a - b; });   // LCT's per-screen card order: ascending [I]
      if (ss.length) from = ss[0];
      ss.forEach(function (d) {
        keys[d] = 1; to = d;
        pairs.forEach(function (q) { if (q.ps === d && q.bs !== d) { keys[q.bs] = 1; to = q.bs; } });
      });
    });
    Object.keys(keys).forEach(function () { n++; });
    return { op: 'sync', from: from || 0, to: to, times: n, hex: hex([0].concat(u16(3840), u16(1920))) };
  }

  // 0x02300000: 9A, N, 00, N x {u16 offset, u8 count}, then per card the pairs it takes part in, 4 B each [ps,pp,bs,bp];
  // no pairs: 9A 00 00 + 3N zeros (as NovaLCT's Delete of the last pair)
  function reduTable(pairs, n) {
    if (!pairs.length) { var z = [0x9A, 0, 0]; for (var i = 0; i < 3 * n; i++) z.push(0); return z; }
    var lists = []; for (var d = 0; d < n; d++) lists.push(pairs.filter(function (q) { return q.ps === d || q.bs === d; }));
    var out = [0x9A, n, 0], off = 3 + 3 * n, body = [];
    lists.forEach(function (l) { out = out.concat(u16(off), [l.length]); l.forEach(function (q) { body.push(q.ps, q.pp, q.bs, q.bp); }); off += 4 * l.length; });
    return out.concat(body);
  }
  // 0x05065000 "REDU": magic, u16 1001, u16 sum of the bytes from offset 8, u16 payload length, 16 B per pair
  function reduRecord(pairs) {
    var body = u16(16 * pairs.length);
    pairs.forEach(function (q) { body = body.concat(u32(q.ps), u32(q.pp), u32(q.bs), u32(q.bp)); });
    var sum = body.reduce(function (a, b) { return a + b; }, 0) & 0xFFFF;
    return [0x52, 0x45, 0x44, 0x55, 0xE9, 0x03].concat(u16(sum), body);
  }

  // every port of each primary card backed up on the same port of another card: primaries[i] -> backups[i]
  function portBackupPairs(primaries, backups, ports) {
    var pairs = [];
    primaries.forEach(function (ps, i) { for (var p = 0; p < ports; p++) pairs.push({ ps: ps, pp: p, bs: backups[i], bp: p }); });
    return pairs;
  }

  // The explicit Save button (NovaLCT's Save, docs\HW_OPERATIONS.md §2.2 step 4): sending-card
  // flash commit, distributor, then the receiving cards store their parameters (0x01000011, device 1, full broadcast) —
  // LCT then waits W × H × 70 / 1024 ms (screen pixels) before the 3D emitter's commit. Only ever built for the Save
  // button, never as part of a Send (user rule: Save is separate).
  // opts.redu = the port backup pairs after a backup Send that isn't saved yet: NovaLCT's Save writes them first as the
  // REDU record, to all sending cards (its Saves after a backup Send, also on the real H5 2026-10-11); [] writes the
  // empty record (REDU E9 03 00 00 00 00, as NovaLCT after the last pair is deleted).
  function buildSavePlan(opts) {
    var px = Math.max(0, opts.pixels || 0), ms = Math.min(600000, Math.max(1000, Math.ceil(px * 70 / 1024)));   // LCT's own wait; never shorter
    var redu = opts.redu ? [{ op: 'w', dev: 0, dst: ALL, port: 0, card: 0, addr: 0x05065000, hex: hex(reduRecord(opts.redu)) }] : [];
    return { save: true, senders: opts.senders || 1, pixels: px, waitMs: ms, redu: !!opts.redu, ops: redu.concat([
      { op: 'note', text: 'Save: store the parameters in flash (sending cards, distributor, receiving cards)' },
      { op: 'w', dev: 0, dst: ALL, port: 0, card: 0, addr: 0x01000001, hex: '00', r2: 6 },
      { op: 'w', dev: 3, dst: ALL, port: 0, card: 0, addr: 0x05000000, hex: '00', r2: 6 },   // as Send's built-in commit
      { op: 'w', dev: 1, dst: ALL, port: ALL, card: ALLCARDS, addr: 0x01000011, hex: '00', r2: 6 },
      { op: 'sleep', ms: ms },
      { op: 'w', dev: 4, dst: ALL, port: 0, card: 0, addr: 0x01000011, hex: '00', r2: 6 }
    ]) };
  }

  var api = { buildSendPlan: buildSendPlan, buildRedundancyPlan: buildRedundancyPlan, reduRanges: reduRanges, freeRoute: freeRoute, buildSavePlan: buildSavePlan, portBackupPairs: portBackupPairs, nssdScreens: nssdScreens, reduTable: reduTable, reduRecord: reduRecord, MODELS: MODELS, refusal: refusal, syncOp: syncOp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.HWSEND = api;
})(this);
