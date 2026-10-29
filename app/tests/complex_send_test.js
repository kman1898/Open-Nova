// node app/tests/complex_send_test.js — Send of Complex (freeform) screens: hwsend.js against NovaLCT's own Send of a
// Complex layout to an H_20 card (recorded 2026-09-27, byte-compared outside this test), plus the read-back
// (app-readback.js rbModelOf) of what the Send stores.
var path = require('path'), fs = require('fs'), vm = require('vm'), H = require(path.join(__dirname, '..', 'hwsend.js'));
var fails = 0;
function ok(cond, text) { console.log((cond ? 'PASS ' : 'FAIL ') + text); if (!cond) fails++; }
function hx(n, len) { var s = ''; for (var i = 0; i < len; i++) s += ('0' + ((n >> (8 * i)) & 255).toString(16)).slice(-2); return s; }
function writes(p, addr, dst) { return p.ops.filter(function (o) { return o.op === 'w' && o.dev === 0 && o.addr === addr && (dst == null || o.dst === dst); }); }
function nssd(p, d) { var o = p.ops.filter(function (x) { return x.op === 'nssd' && x.dst === d; })[0]; return o && JSON.parse(o.json).ScreenDataInSoftSpace; }
function plan(model, id, o) { o = o || {}; return H.buildSendPlan(model, { modelId: id || 0x7B48, senders: o.senders || 2, backup: o.backup || [], freeRoute: !!o.freeRoute, now: new Date(2026, 9, 11, 12, 0, 0) }); }

// a Complex screen: a staggered row on card 1 port 1 (cabinets at different heights, so no grid) and two on card 2 port 1
function cx(type) {
  return { type: type || 2, virtualMode: 0, cells: [
    { sender: 0, port: 0, connect: 0, x: 100, y: 0, width: 128, height: 128 },
    { sender: 0, port: 0, connect: 1, x: 228, y: 40, width: 128, height: 128 },
    { sender: 0, port: 0, connect: 2, x: 356, y: 80, width: 128, height: 128 },
    { sender: 1, port: 0, connect: 1, x: 600, y: 300, width: 128, height: 256 },
    { sender: 1, port: 0, connect: 0, x: 728, y: 300, width: 128, height: 256 }] };
}
function std(d, x0) {   // a 2 x 1 Standard screen on card d
  return { type: 1, x: x0, y: 0, cols: 2, rows: 1, cells: [0, 1].map(function (i) { return { row: 0, col: i, x: x0 + i * 256, y: 0, width: 256, height: 256, sender: d, port: 1, connect: i }; }) };
}

// --- one Complex screen on two cards (H_20, a video model)
var p = plan({ screens: [cx()] });
ok(writes(p, 0x0200004A, 0)[0].hex === '01' && writes(p, 0x0200004A, 1)[0].hex === '01', '0x0200004A <- 01 on every card that drives a Complex screen');
ok(!writes(p, 0x020000F0).length, 'first screen Complex: no 0x020000F0 (LCT writes the virtual-pixel state only when screen 1 is Standard)');
ok(writes(p, 0x02000028, 0)[0].hex === hx(100, 2) && writes(p, 0x0200002A, 0)[0].hex === hx(0, 2) && writes(p, 0x0200002C, 0)[0].hex === hx(384, 2) && writes(p, 0x02000026, 0)[0].hex === hx(208, 2),
  'video model, Complex only: each card keeps its own cabinets’ box as window (card 1: 100,0 384 x 208)');
ok(writes(p, 0x02000024, 0)[0].hex === hx(384, 2) && writes(p, 0x02000028, 1)[0].hex === hx(600, 2) && writes(p, 0x0200002C, 1)[0].hex === hx(256, 2), 'card 2 window 600,300 256 x 256');
ok(writes(p, 0x020001EC, 0)[0].hex === hx(856, 2) + hx(556, 2), 'screen size 0x020001EC = the Complex screen’s right / bottom edge (856, 556)');
var t = writes(p, 0x03000000, 1)[0].hex;
ok(t.substr(0, 8) === hx(128, 2) + hx(0, 2) && t.substr(8, 8) === hx(0, 2) + hx(0, 2), 'coordinate table in cable order (card 2: cable 0 at +128, cable 1 at 0)');
var n0 = nssd(p, 0), n1 = nssd(p, 1);
ok(n0.length === 1 && n1.length === 1 && n0[0].UUID === n1[0].UUID, 'NSSD: the screen on both cards, one UUID');
var s0 = n0[0];
ok(s0.ScrType === 2 && s0.DviSelect === 88 && s0.ScrX === 0 && s0.ScrY === 0 && s0.CabinetCol === 0 && s0.CabinetRow === 0 && JSON.stringify(s0.DVIlist) === '{}' && s0.ScreenIndex === 0,
  'NSSD Complex record: ScrType 2, DviSelect 88, ScrX/Y and columns/rows 0, DVIlist {} (as NovaLCT stored it)');
ok(JSON.stringify(Object.keys(s0)) === JSON.stringify(['UUID', 'ScrType', 'DviSelect', 'VirMode', 'ScrX', 'ScrY', 'CabinetCol', 'CabinetRow', 'PortCols', 'PortRows', 'DeviceID', 'CabinetWidth', 'CabinetHeight', 'OnePortLoadInfo', 'CabinetInDevice', 'ScreenIndex', 'DVIlist']), 'NSSD key order as LCT');
ok(n1[0].CabinetInDevice.map(function (c) { return c.ConnectID; }).join() === '1,0' && n1[0].CabinetInDevice.every(function (c) { return c.RowIndexInScreen === 0 && c.ColIndexInScreen === 0 && c.DviIndex === 0 && c.GroupID === 0; }),
  'NSSD cabinets in the screen’s own order, row / column / DVI index 0');
ok(nssd(plan({ screens: [cx(3)] }), 0)[0].ScrType === 2, 'LCT’s irregular type 3 goes out as Complex (ScrType 2)');

// --- mixed: Standard on card 1 first, Complex on card 2
var m = plan({ screens: [std(0, 0), { type: 2, cells: cx().cells.filter(function (c) { return c.sender === 1; }) }] });
ok(writes(m, 0x0200004A, 0)[0].hex === '00' && writes(m, 0x0200004A, 1)[0].hex === '01', 'mixed: 0x0200004A 00 on the Standard card, 01 on the Complex card');
ok(writes(m, 0x020000F0).length === 2, 'mixed, Standard first: 0x020000F0 on both cards');
ok(nssd(m, 0)[0].ScrType === 1 && nssd(m, 0)[0].DviSelect === 5 && nssd(m, 1)[0].ScrType === 2 && nssd(m, 1)[0].ScreenIndex === 1, 'mixed NSSD: Standard on card 1 (DviSelect 5 as before), Complex on card 2 (ScreenIndex 1)');
// video window: a card with no Standard screen stops NovaLCT's window pass (it fails there), later cards keep their own box
function stdb(d, x0) { var s = std(d, x0); s.cols = 3; s.cells.push({ row: 0, col: 2, x: x0 + 512, y: 0, width: 256, height: 256, sender: 255, port: 255, connect: 0 }); return s; }   // + a blank cell
var cxOn = function (d) { return { type: 2, cells: cx().cells.filter(function (c) { return c.sender === d; }) }; };
var v1 = plan({ screens: [stdb(0, 0), cxOn(1)] });
ok(writes(v1, 0x0200002C, 0)[0].hex === hx(768, 2) && writes(v1, 0x0200002C, 1)[0].hex === hx(256, 2), 'video window: Standard card 1 = its screen box (768, blank included), Complex card 2 = its own box');
var v = plan({ screens: [stdb(1, 1000), cxOn(0)] });
ok(writes(v, 0x0200002C, 0)[0].hex === hx(384, 2) && writes(v, 0x0200002C, 1)[0].hex === hx(512, 2), 'video window: Complex card 1 first stops LCT’s screen-box pass, so Standard card 2 keeps its own box (512, not 768)');

// --- Standard stays as it was
var s = plan({ screens: [std(0, 0)] }, 0x7B48, { senders: 1 });
ok(writes(s, 0x0200004A)[0].hex === '00' && writes(s, 0x020000F0).length === 1, 'Standard only: 0x0200004A 00, 0x020000F0 written');

// --- refusals
var e = ''; try { plan({ screens: [{ type: 0, x: 0, y: 0, sender: 0, ports: [] }] }); } catch (x) { e = x.message; }
ok(/Simple screen/.test(e), 'Simple screen refused: ' + e);

// --- free route: a Complex port drops an area that lies inside another one (ComplexLEDDisplayInfo.GeFreeRoutScanBoardInfos)
var lap = [{ sender: 0, port: 0, connect: 0, x: 0, y: 0, width: 256, height: 256 }, { sender: 0, port: 0, connect: 1, x: 64, y: 64, width: 128, height: 128 },
  { sender: 0, port: 0, connect: 2, x: 0, y: 256, width: 128, height: 128 }];
var fs1 = H.freeRoute(lap, false), fc = H.freeRoute(lap, true);
ok(fs1.recs.length === 4 && fc.recs.length === 3, 'free route: Standard keeps the inner area as a record (4), Complex drops it (3)');
ok(fc.pos[1].x === 64 && fc.pos[1].y === 64 && fc.pos[2].y === 256, 'free route Complex: inner cabinet at 64,64 in the outer area, next area stacked at 256');
ok(H.freeRoute([lap[0], lap[0]].map(function (c, i) { return Object.assign({}, c, { connect: i }); }), true).recs.length === 2, 'free route Complex: of two equal areas one stays');
var fr = plan({ screens: [{ type: 2, cells: lap }] }, 0x7B46, { senders: 1, freeRoute: true });
ok(writes(fr, 0x02030000)[0].hex === '0300', 'free route Complex Send: 3 records on port 1 (0x02030000 = 03 00)');

// --- backup with a Complex screen: the copy carries the flag; the backup card gets no NSSD of its own
var b = plan({ screens: [cx()] }, 0x7B48, { senders: 4, backup: H.portBackupPairs([0, 1], [2, 3], 1) });
var cp = b.ops.filter(function (o) { return o.op === 'copy' && o.ranges.length > 1; });   // (the others: 0x020000D4 after the table)
ok(cp.length === 2 && cp[0].ranges[0][0] === 0x02000000 && !nssd(b, 2) && !nssd(b, 3), 'backup: cards 3 / 4 get the copy (0x02000000.. incl. 0x0200004A), no NSSD of their own');

// --- read-back (app-readback.js rbModelOf) of what the Send stores gives the same cabinets back
var ctx = { SCR: require(path.join(__dirname, '..', 'scr.js')), cardsOfDevice: function () { return [4, 5]; }, console: console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'app-readback.js'), 'utf8'), ctx);
var back = ctx.rbModelOf({ id: 'x' }, { cards: [{ dst: 0, screens: n0 }, { dst: 1, screens: n1 }] });
var want = cx().cells.map(function (c) { return [c.sender + 4, c.port, c.connect, c.x, c.y, c.width, c.height].join(':'); }).sort().join('|');
var got = back.length === 1 && back[0].type === 2 ? back[0].regions.map(function (c) { return [c.sender, c.port, c.connect, c.x, c.y, c.width, c.height].join(':'); }).sort().join('|') : '';
ok(got === want, 'read-back: one Complex screen, the same ' + cx().cells.length + ' cabinets (cards renumbered to the project’s)');
process.exit(fails ? 1 : 0);
