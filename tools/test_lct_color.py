"""NovaLCT colour on the Screen Settings tab, checked against NovaLCT's own captures (no hardware, no helper):
  - colour temperature: Open Nova's writes (app\\js\\drv-lct.js screenSet 'colortemp') = NovaLCT's frames in
    FakeProcessor\\captures\\color_h20x2_20260927_172218 (3200 K then 6500 K, screen on d0 P1-4), byte for byte
    (frame header, address, data; the serial number and so the checksum left out);
  - the read-back (novalink.color_read + drv-lct.js colorOf): register bytes -> brightness %, gamma, colour temperature
    (NovaLCT's table match), gamut (0x02000130 + the 0x12009000 record NovaLCT wrote for PAL / NTSC).
    python -I -X utf8 tools\\test_lct_color.py      (exit code 0 = all passed; needs node)
"""
import json
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import novalink   # noqa: E402

CAP = os.path.join(HERE, 'FakeProcessor', 'captures')
DRV = os.path.join(HERE, '..', 'app', 'js', 'drv-lct.js')
fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


def raw_frames(path):
    """Request frames of a capture as raw bytes (55 AA … checksum), in order."""
    raw = open(path, 'rb').read(); i = 0; out = []
    while i + 20 <= len(raw):
        if raw[i] != 0x55 or raw[i + 1] != 0xAA: i += 1; continue
        op, dev = raw[i + 10], raw[i + 6]; ln = raw[i + 16] | raw[i + 17] << 8
        total = 20 + ln if op else 20
        if op > 1 or dev > 4 or i + total > len(raw): i += 1; continue
        if (0x5555 + sum(raw[i + 2:i + total - 2])) & 0xFFFF != raw[i + total - 2] | raw[i + total - 1] << 8: i += 1; continue
        out.append(raw[i:i + total]); i += total
    return out


def frame(dev, dst, port, card, addr, data):
    """A write frame as novalink sends it (Link._frame), serial 0."""
    h = bytes([0x55, 0xAA, 0, 0, 0xFE, dst, dev, port]) + struct.pack('<HBBIH', card, 1, 0, addr, len(data)) + data
    return h + struct.pack('<H', novalink.sum16(h[2:], 0x5555))


def unserial(f):
    f = bytearray(f); f[3] = 0
    struct.pack_into('<H', f, len(f) - 2, novalink.sum16(bytes(f[2:-2]), 0x5555))
    return bytes(f)


def node(js):
    """Run js with drv-lct.js loaded (stubs for the app's globals); it prints JSON."""
    pre = ("var vm = require('vm'), fs = require('fs'); var out = [];"
           "var ctx = { console: console, P: { bitDepth: 8 }, hwPairs: function () { return []; }, cardsOfDevice: function () { return [0]; },"
           " localStorage: { getItem: function () { return null; } },"
           " DRV: { register: function () {}, post: function (f, p, b) { out.push({ path: p, body: b }); return Promise.resolve(ctx.REPLY || { ok: true }); },"
           "        unsupported: function (w) { return Promise.resolve({ ok: false, error: w }); } },"
           " drvResult: function (ok, x) { var r = { ok: !!ok }; for (var k in x || {}) r[k] = x[k]; return r; } };"
           "vm.createContext(ctx); vm.runInContext(fs.readFileSync(%s, 'utf8') + '\\n;this.DRV_LCT = DRV_LCT;', ctx);" % json.dumps(DRV))
    r = subprocess.run(['node', '-e', pre + js], capture_output=True, text=True, encoding='utf-8')
    if r.returncode: raise RuntimeError(r.stderr)
    return json.loads(r.stdout)


# ------------------------------------------------------------------ colour temperature = NovaLCT's frames
# The captures are private (tools/FakeProcessor/captures, not in the repository): without them the byte-for-byte compare is
# left out (SKIP) and the read-back below uses records made here with the same targets.
CT_CAP = os.path.join(CAP, 'color_h20x2_20260927_172218', 'frames_L0.bin')
groups = []
if os.path.isfile(CT_CAP):
    cap = raw_frames(CT_CAP)
    ct = [f for f in cap if f[10] == 1 and f[6] == 1 and struct.unpack_from('<I', f, 12)[0] in (0x02000002, 0x02000003, 0x02000004, 0x02000005)]
    groups = [ct[i:i + 16] for i in range(0, 32, 16)]   # the first two changes: 3200 K, 6500 K (later ones = Factory Setting sliders)
    ok(len(ct) >= 32 and [g[0][18] for g in groups] == [0xFE, 0xFF], 'capture: two colour-temperature changes of 16 frames (R FE = 3200 K, FF = 6500 K)')
else:
    print('SKIP colour temperature frames = NovaLCT\'s, byte for byte (capture color_h20x2 not here: private)')
for K, g in zip((3200, 6500), groups):
    plan = node("var d = { hw: { host: 'x', port: 5200, senders: [1] } };"
                "ctx.DRV_LCT.screenSet(d, 'colortemp', %d, [0, 1, 2, 3].map(function (p) { return { card: 0, port: p }; }))"
                ".then(function () { console.log(JSON.stringify(out[0].body.plan.ops)); });" % K)
    ours = [frame(o['dev'], o['dst'], o['port'], o['card'], o['addr'], bytes.fromhex(o['hex'])) for o in plan if o['op'] == 'w']
    theirs = [unserial(f) for f in g]
    ok(ours == theirs, '%d K: %d frames, every byte equal to NovaLCT\'s (order: R + VR per port, then G, then B)' % (K, len(ours)))
    if ours != theirs:
        for a, b in zip(ours, theirs):
            if a != b: print('   ours  ', a.hex(' ')); print('   NovaLCT', b.hex(' ')); break
tbl = node("console.log(JSON.stringify(ctx.DRV_LCT.CT));")
doc = {1700: (254, 90, 1), 2000: (254, 113, 8), 2500: (254, 145, 28), 3000: (254, 170, 55), 3500: (254, 190, 85), 4000: (254, 205, 116),
       4500: (254, 217, 147), 5000: (254, 227, 177), 5500: (254, 234, 206), 6000: (254, 239, 229), 6500: (255, 255, 255), 7000: (231, 225, 254),
       7500: (215, 212, 254), 8000: (202, 201, 254), 8500: (192, 193, 254), 9000: (183, 185, 254), 9500: (175, 178, 254), 9900: (170, 174, 254)}
ok(len(tbl) == 83 and all(tuple(tbl[(k - 1700) // 100]) == v for k, v in doc.items()), 'the 83-row table matches the rows in COLOR_BRIGHTNESS.md §4.1')


# ------------------------------------------------------------------ read-back
class Cards:
    """Receiving-card memory per (sender, port) (card 0 = what card 0 answers); a port in `dead` doesn't answer."""
    def __init__(self, mem, dead=(), src=None):
        self.mem, self.dead, self.src, self.reads = mem, set(dead), src, []

    def read(self, dev, dst, port, card, addr, length, r2=0, timeout=None):
        self.reads.append((dev, dst, port, addr, length))
        if dev == 0:
            if self.src is None: raise novalink.LinkError('no reply (timeout)')
            return bytes([self.src])
        if (dst, port) in self.dead: raise novalink.LinkError('no reply (timeout)')
        m = self.mem.get((dst, port), {})
        for base, data in m.items():
            if base <= addr and addr + length <= base + len(data): return bytes(data[addr - base:addr - base + length])
        return bytes(length)


def block(gamma, bright, r, g, b, grey=16):
    x = bytearray(0x30); x[0], x[1], x[2], x[3], x[4], x[5], x[0x25] = gamma, bright, r, g, b, r, grey
    return bytes(x)


rec = {}   # the 0x12009000 records NovaLCT wrote for PAL and NTSC (lct_h20x4 capture)
REC_CAP = os.path.join(CAP, 'lct_h20x4_20261006_214532', 'frames_L0.bin')
if os.path.isfile(REC_CAP):
    for f in raw_frames(REC_CAP):
        if f[10] == 1 and f[6] == 1 and struct.unpack_from('<I', f, 12)[0] == 0x12009000 and f[18 + 4] == 0:
            tx = struct.unpack_from('<H', f, 18 + 40)[0]
            rec.setdefault({6400: 'pal', 6700: 'ntsc'}.get(tx, tx), f[18:18 + 256])
    ok('pal' in rec and 'ntsc' in rec, 'capture: NovaLCT\'s colour-space records for PAL and NTSC found')
else:   # made here: 256 B with the target primaries (xy ·10000, u16 LE at [40..51], what colorOf reads), the rest 0
    print('SKIP colour-space records from NovaLCT\'s capture (lct_h20x4 not here: private); made-up records with the same targets used')
    for k, xy in (('pal', (6400, 3300, 3000, 6000, 1500, 600)), ('ntsc', (6700, 3300, 2100, 7100, 1400, 800))):
        r = bytearray(256); struct.pack_into('<6H', r, 40, *xy); rec[k] = bytes(r)

log = []
pal = {0x02000000: block(0x16, 0x8C, 254, 179, 66), 0x02000130: b'\x02', 0x12009000: rec['pal']}
link = Cards({(0, 0): pal, (0, 1): pal, (0, 3): pal}, dead=[(0, 1)], src=0x05)   # P2's cable is out: its backup is P4
targets = [{'dst': 0, 'port': 0}, {'dst': 0, 'port': 1}, {'dst': 0, 'port': 3, 'backupOf': [0, 1]}]
got = novalink.color_read(link, targets, log.append)
ok(len(got) == 2 and got[1]['via'] == [0, 3], 'a port whose card doesn\'t answer is read through its backup port')
ok(all(r[0] == 1 or r[3] == 0x03100109 for r in link.reads) and not any(r[3] in (0x02000001, 0x05000000) and r[0] == 1 and r[4] != 0x30 for r in link.reads),
   'reads only: 0x02000000 (0x30 B), 0x02000130, 0x12009000 (when 02), sender 0x03100109 once')
ok(sum(1 for r in link.reads if r[0] == 0) == 1, 'the sending card\'s gamma source depth is read once per sending card')

js = ("var e = %s; console.log(JSON.stringify(e.map(function (x) { return ctx.DRV_LCT.colorOf(x); })));")
cases = [dict(got[0])]
cases.append({'hex': block(0x16, 0x8C, 254, 179, 66).hex(), 'gamut': '02', 'record': rec['ntsc'].hex(), 'src': 5})
cases.append({'hex': block(0x1C, 0xFF, 255, 255, 255).hex(), 'gamut': 'ff', 'record': None, 'src': 0x5A})
cases.append({'hex': block(0xFE, 0x7B, 205, 195, 187).hex(), 'gamut': '00', 'record': None, 'src': 5})
v = node(js % json.dumps(cases))
ok(v[0]['v'] == {'brightness': 55, 'gamma': 2.2, 'colorTemp': 3200, 'gamut': 'rec709'}, 'read: 8C = 55 %%, 16 = gamma 2.2, FE B3 42 = 3200 K, colour space on with PAL = Rec.709 (%s)' % v[0]['v'])
ok(v[1]['v']['gamut'] == 'ntsc', 'read: colour space on with NTSC')
if os.path.isfile(REC_CAP):
    drv = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'js', 'drv-lct.js'), encoding='utf-8').read()
    ok(rec['pal'].hex().upper() in drv and rec['ntsc'].hex().upper() in drv, 'gamut: the records Open Nova writes = NovaLCT\'s PAL and NTSC, byte for byte')
ok(v[2]['v']['gamut'] == 'original' and v[2]['v']['colorTemp'] == 6500 and v[2]['v']['brightness'] == 100 and v[2]['v']['gamma'] is None and '10-bit' in v[2]['n']['gamma'],
   'read: FF = colour space off (Original), FF FF FF = 6500 K, a 10-bit source leaves gamma unknown')
ok(v[3]['v']['gamma'] is None and 'custom' in v[3]['n']['gamma'] and v[3]['v']['colorTemp'] is None and v[3]['v']['brightness'] == 48,
   'read: 254 = custom gamma table, hand-set R/G/B = no temperature, 7B = 48 %')
rt = node("var r = []; for (var p = 0; p <= 100; p++) { var b = Math.max(0, Math.min(255, Math.round(p * 255 / 100))); r.push(ctx.DRV_LCT.colorOf({ hex: ('0' + b.toString(16)).slice(-2).replace(/^/, '1c') + '00'.repeat(46), gamut: 'ff', src: 5 }).v.brightness === p); } console.log(JSON.stringify(r.every(Boolean)));")
ok(rt is True, 'every brightness % written from here reads back as the same %')

# Custom gamma tables (a LUT, app-lutfit.js): the same per-port checks as a gamma, the tables given, 0x02000000 = FE
class Card:
    def __init__(self): self.w = []
    def read(self, dev, dst, port, card, addr, n, timeout=1.0): return bytes(0x25) + bytes([16]) + bytes(n - 0x26)
    def write(self, dev, dst, port, card, addr, data, *a): self.w.append((addr, bytes(data)))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import novalink
tb = bytes(range(256)) * 6
c = Card(); novalink.set_gamma(c, [{'dst': 0, 'port': 1}], 0, lambda s: None, tb.hex())
ok(b''.join(d for a, d in c.w if 0x05000000 <= a < 0x05000600) == tb and (0x02000000, b'\xfe') in c.w and (0x060003CA, b'\x00') in c.w, 'custom gamma: the tables as given, then FE')
try: novalink.set_gamma(Card(), [{'dst': 0, 'port': 1}], 0, lambda s: None, 'AA'); ok(False, 'a short table is refused')
except novalink.LinkError: ok(True, 'a short table is refused')

print('\n%s (%d failed)' % ('ALL PASSED' if not fails else 'FAILED', len(fails)))
sys.exit(1 if fails else 0)
