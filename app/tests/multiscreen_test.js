// node app/tests/multiscreen_test.js — several screens on one NovaLCT processor (hwsend.js): one Send writes them all, one
// NSSD record per sending card listing that card's screens in the processor's order (ScreenIndex 0…), a screen on two cards
// listed on both with its own cabinets, blanks with the card of the screen's first cabinet, a Complex screen's card flagged
// (0x0200004A), each screen's UUID kept. Byte comparisons against NovaLCT's own multi-screen Sends are done outside this test
// (private recordings).
var path = require('path'), H = require(path.join(__dirname, '..', 'hwsend.js'));
var fails = 0;
function ok(cond, text) { console.log((cond ? 'PASS ' : 'FAIL ') + text); if (!cond) fails++; }
var U0 = '11111111-2222-4333-8444-555555550000', U1 = '11111111-2222-4333-8444-666666660000';
// One processor with two sending cards (a screen belongs to one processor; its cards may share a screen):
// Screen 1: Standard 3 x 1 at (0, 0), cards 1 and 2, a blank at the right; Screen 2: Complex, two cabinets on card 2 port 2
function model() {
  var c = function (col, sender, port, connect) { return { row: 0, col: col, x: col * 128, y: 0, width: 128, height: 128, sender: sender, port: port, connect: connect, dvi: 1 }; };
  return { screens: [
    { type: 1, x: 0, y: 0, cols: 4, rows: 1, uuid: U0, dviOffsets: { x1: 10, y1: 20 }, cells: [c(0, 0, 0, 0), c(1, 0, 0, 1), c(2, 1, 0, 0), c(3, 255, 1, 1)] },
    { type: 2, virtualMode: 0, uuid: U1, cells: [
      { sender: 1, port: 1, connect: 0, x: 600, y: 300, xInPort: 0, yInPort: 0, width: 128, height: 128 },
      { sender: 1, port: 1, connect: 1, x: 760, y: 340, xInPort: 0, yInPort: 0, width: 128, height: 128 }] }] };
}
var per = H.nssdScreens(model());
ok(Object.keys(per).join() === '0,1', 'NSSD: one list per sending card that drives a screen (' + Object.keys(per).join() + ')');
ok(per[0].length === 1 && per[0][0].ScreenIndex === 0 && per[0][0].UUID === U0, 'card 1 lists Screen 1 only');
ok(per[1].length === 2 && per[1][0].ScreenIndex === 0 && per[1][1].ScreenIndex === 1 && per[1][0].UUID === U0 && per[1][1].UUID === U1,
  'card 2 lists Screen 1 then Screen 2, in the processor’s order, UUIDs kept');
var c0 = per[0][0].CabinetInDevice, c1 = per[1][0].CabinetInDevice;
ok(c0.length === 3 && c0[2].DevID === 255 && c1.length === 1 && c1[0].DevID === 1,
  'Screen 1 split by card: card 1 has its two cabinets + the blank (the screen’s first cabinet is on card 1), card 2 its one');
ok(per[0][0].ScrType === 1 && per[0][0].CabinetCol === 4 && per[1][0].CabinetCol === 4 && per[0][0].DVIlist['1'] === '10, 20',
  'Standard screen fields (type, grid, DVI offsets) on every card it is on');
ok(per[1][1].ScrType === 2 && per[1][1].CabinetInDevice.length === 2 && per[1][1].DviSelect === 88 && per[1][1].ScrX === 0,
  'Complex screen: its cabinets, NovaLCT’s defaults (DviSelect 88, no origin)');

var plan = H.buildSendPlan(model(), { modelId: 0x7B48, senders: 2, now: new Date(2026, 9, 28, 12, 0, 0) });
var ns = plan.ops.filter(function (o) { return o.op === 'nssd'; });
ok(ns.length === 2 && ns[0].dst === 0 && ns[1].dst === 1, 'one Send: one NSSD write per card, card 1 first');
var j1 = JSON.parse(ns[1].json).ScreenDataInSoftSpace;
ok(j1.map(function (s) { return s.ScreenIndex + ':' + s.UUID.slice(-4); }).join() === '0:0000,1:0000' && j1[1].UUID === U1, 'card 2’s record holds both screens in order');
var f4a = plan.ops.filter(function (o) { return o.op === 'w' && o.addr === 0x0200004A; }).map(function (o) { return o.dst + '=' + o.hex; }).join();
ok(f4a === '0=00,1=01', 'Complex flag 0x0200004A only on the card that drives the Complex screen (' + f4a + ')');
ok(plan.cabinets === 5 && /2 screen/.test(plan.ops[0].text), 'plan counts both screens’ cabinets: ' + plan.ops[0].text);

// reordered (Screen 2 first): the ScreenIndex and every card's list follow the new order
var m2 = model(); m2.screens.reverse();
var p2 = H.nssdScreens(m2);
ok(p2[1][0].UUID === U1 && p2[1][0].ScreenIndex === 0 && p2[1][1].UUID === U0 && p2[1][1].ScreenIndex === 1 && p2[0][0].ScreenIndex === 1,
  'reordered: Complex screen is now ScreenIndex 0 on card 2, the Standard one 1 on both cards');
// no UUID given: a new one per screen, the same on every card of that screen
var m3 = model(); delete m3.screens[0].uuid; delete m3.screens[1].uuid;
var p3 = H.nssdScreens(m3);
ok(p3[0][0].UUID === p3[1][0].UUID && p3[1][0].UUID !== p3[1][1].UUID && /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(p3[0][0].UUID), 'no UUID given: one fresh UUID per screen, shared by its cards');

if (fails) { console.log(fails + ' failed'); process.exit(1); }
console.log('all passed');
