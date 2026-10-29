"""Tests for novalink's NovaStar USB link (0483:5720, docs/USB_NOVA_DEVICE.md) with a fake libusb only: no real USB device
is listed, opened or sent to. The fake stands in for the libusb-1.0 library itself (the ctypes calls), with a controller
behind it that speaks the USBC framing in each of the ways the code allows: the reply straight after the write block (LCT's
"new" flow), mass-storage style (status first, then an A3 read block: LCT's "old" flow), a stale status, a status in the
same transfer as the reply, replies split over several transfers, junk, silence, and LCT's ComMode (no USBC block).
    python -I tools/test_usb.py   (exit 0 = all passed)
"""
import ctypes
import os
import struct
import sys
import tempfile
import threading
import time

TMP = tempfile.mkdtemp(prefix='opennova_usb_test_')
os.environ['OPENNOVA_DIAG'] = TMP
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import novalink   # noqa: E402
import wirelog    # noqa: E402

fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


def reply(req, status=0, data=b''):
    h = bytearray(req[:18]); h[0], h[1], h[2] = 0xAA, 0x55, status
    struct.pack_into('<H', h, 16, len(data)); b = bytes(h) + data
    return b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF)


def answer(req):
    """The controller: 0x00000002 -> ModelID 0x620C (VX1000); a write -> ack; 0x0BAD0000 -> silence; else n bytes 0..255."""
    addr = struct.unpack_from('<I', req, 12)[0]
    if addr == 0x0BAD0000: return b''
    if req[10] == 1: return reply(req)
    if addr == 0x00000002: return reply(req, data=b'\x0C\x62')
    n = struct.unpack_from('<H', req, 16)[0]
    return reply(req, data=bytes(i & 0xFF for i in range(n)))


def csw(tag, status=0, residue=0):
    return b'USBS' + struct.pack('<IIB', tag, residue, status)


class Device:
    """A 0483:5720 controller at the USB level. flow: 'new' (reply right after the frame), 'bot' (status, then wait for an
    A3 block), 'stale' (reply, then a status the next command finds first), 'trail' (reply + status in one transfer),
    'com' (no USBC blocks). chunk: the most bytes one IN transfer carries. junk: bytes in front of each reply."""
    def __init__(self, flow='new', chunk=0, junk=b''):
        self.flow, self.chunk, self.junk = flow, chunk, junk
        self.outs, self.frames, self.cbws, self.inq = [], [], [], []
        self.want, self.data, self.halts, self.closed, self.claimed = 0, b'', 0, False, None
        self.pending = b''

    def queue(self, b):
        while b:
            n = self.chunk or len(b); self.inq.append(b[:n]); b = b[n:]

    def out(self, b):
        self.outs.append(b)
        if getattr(self, 'silent', False): return          # takes everything, answers nothing
        if self.flow == 'com':
            if b: self.frames.append(b); self.queue(self.junk + answer(b))
            return
        if self.want:                                       # the frame after a write block
            self.data += b
            if len(self.data) >= self.want:
                f, self.data, self.want = self.data, b'', 0
                self.frames.append(f); r = self.junk + answer(f)
                tag = struct.unpack_from('<I', self.cbws[-1], 4)[0]
                if self.flow == 'new': self.queue(r)
                elif self.flow == 'stale': self.queue(r); self.inq.append(csw(tag))
                elif self.flow == 'trail': self.queue(r + csw(tag))
                elif self.flow == 'bot': self.pending = r; self.inq.append(csw(tag))
            return
        if not b: return                                    # the empty packet after a 64-multiple
        assert b[:4] == b'USBC' and len(b) == 31, 'expected a USBC block, got %s' % b.hex()
        self.cbws.append(b)
        n, flags, cb0 = struct.unpack_from('<I', b, 8)[0], b[12], b[15]
        if cb0 == 0xA2: self.want = n
        elif cb0 == 0xA3:                                    # old flow: the data asked for, then the status
            tag = struct.unpack_from('<I', b, 4)[0]
            self.queue(self.pending[:n]); self.inq.append(csw(tag, residue=max(0, n - len(self.pending)))); self.pending = b''


class FakeLibusb:
    """libusb-1.0's C functions as Python functions (the same arguments ctypes would pass): two 0483:5720 devices on bus 1
    ports 3 and 4.2, and a hub that isn't one. Plain functions, so the code's argtypes / restype setting works."""
    def __init__(self, devs):
        self.devs, self.keep, self.opened, self.exits, self.inits = devs, [], [], 0, 0
        ids = {1: (0x0483, 0x5720, 1, [3]), 2: (0x8086, 0x2934, 1, []), 3: (0x0483, 0x5720, 1, [4, 2])}
        handles = {}
        hv = lambda h: getattr(h, 'value', h)
        me = self

        def setp(ref, addr): ctypes.cast(ctypes.addressof(ref._obj), ctypes.POINTER(ctypes.c_void_p))[0] = addr

        def libusb_init(ref): me.inits += 1; ref._obj.value = 0x1000; return 0
        def libusb_exit(ctx): me.exits += 1
        def libusb_get_device_list(ctx, ref):
            arr = (ctypes.c_void_p * 4)(1, 2, 3, None); me.keep.append(arr); setp(ref, ctypes.addressof(arr)); return 3
        def libusb_free_device_list(lst, unref): pass
        def libusb_get_device_descriptor(d, ref):
            v, p, _, _ = ids[d]; dd = ref._obj; dd.idVendor, dd.idProduct, dd.bcdDevice, dd.bcdUSB = v, p, 0x0404, 0x0200; return 0
        def libusb_get_bus_number(d): return ids[d][2]
        def libusb_get_port_numbers(d, arr, n):
            for i, x in enumerate(ids[d][3]): arr[i] = x
            return len(ids[d][3])
        def libusb_get_config_descriptor(d, i, ref):
            C, L = ctypes, me.lib
            EP = L.CFG._fields_[8][1]._type_._fields_[0][1]._type_._fields_[9][1]._type_   # CFG.interface -> ALT.altsetting -> IF.endpoint
            IF = L.CFG._fields_[8][1]._type_._fields_[0][1]._type_; ALT = L.CFG._fields_[8][1]._type_
            eps = (EP * 2)(); eps[0].bEndpointAddress, eps[0].wMaxPacketSize = 0x02, 512; eps[1].bEndpointAddress, eps[1].wMaxPacketSize = 0x86, 512
            itf = (IF * 1)(); itf[0].bInterfaceNumber, itf[0].bNumEndpoints = 0, 2
            itf[0].bInterfaceClass, itf[0].bInterfaceSubClass, itf[0].bInterfaceProtocol = 0xFF, 0x06, 0x50
            itf[0].endpoint = C.cast(eps, C.POINTER(EP))
            alt = (ALT * 1)(); alt[0].altsetting = C.cast(itf, C.POINTER(IF)); alt[0].num_altsetting = 1
            cfg = L.CFG(); cfg.bNumInterfaces, cfg.bConfigurationValue = 1, 1; cfg.interface = C.cast(alt, C.POINTER(ALT))
            me.keep += [eps, itf, alt, cfg]; setp(ref, C.addressof(cfg)); return 0
        def libusb_free_config_descriptor(c): pass
        def libusb_open(d, ref):
            if d not in me.devs: return -3
            me.opened.append(d); handles[0x100 + d] = me.devs[d]; ref._obj.value = 0x100 + d; return 0
        def libusb_close(h): handles[hv(h)].closed = True
        def libusb_get_configuration(h, ref): ref._obj.value = 1; return 0
        def libusb_set_configuration(h, c): raise AssertionError('set_configuration on a configured device')
        def libusb_claim_interface(h, i): handles[hv(h)].claimed = i; return 0
        def libusb_release_interface(h, i): handles[hv(h)].claimed = None; return 0
        def libusb_set_auto_detach_kernel_driver(h, on): return -12
        def libusb_clear_halt(h, ep): handles[hv(h)].halts += 1; return 0
        def libusb_bulk_transfer(h, ep, buf, n, ref, ms):
            dv = handles[hv(h)]
            if ep == 0x02: dv.out(ctypes.string_at(buf, n)); ref._obj.value = n; return 0
            assert ep == 0x86, 'IN on endpoint %02X' % ep
            end = time.time() + ms / 1000.0
            while not dv.inq:
                if time.time() >= end: ref._obj.value = 0; return -7
                time.sleep(0.005)
            d = dv.inq.pop(0)
            if len(d) > n: return -8
            ctypes.memmove(buf, d, len(d)); ref._obj.value = len(d); return 0
        def libusb_error_name(rc): return {-3: b'LIBUSB_ERROR_ACCESS', -7: b'LIBUSB_ERROR_TIMEOUT', -8: b'LIBUSB_ERROR_OVERFLOW'}.get(rc, b'LIBUSB_ERROR_OTHER')
        for k, v in list(locals().items()):
            if k.startswith('libusb_'): setattr(self, k, v)


def install(devs):
    """novalink.libusb() -> a _Libusb whose library is the fake (built through the real constructor). The link pool's
    connections to the previous fake devices are closed first (it keeps one open per device between requests)."""
    novalink.close_links()
    fake = FakeLibusb(devs)
    real = ctypes.CDLL, getattr(ctypes, 'WinDLL', None)
    ctypes.CDLL = lambda path: fake
    if real[1]: ctypes.WinDLL = lambda path: fake
    try: lib = novalink._Libusb('fake-libusb')
    finally:
        ctypes.CDLL = real[0]
        if real[1]: ctypes.WinDLL = real[1]
    fake.lib = lib
    novalink._LIBUSB[:] = [lib]
    return fake


# ------------------------------------------------------------------ the USBC block (LCT's bytes)
b = novalink.usb_cbw(23, False, 0x12345678)
ok(b == bytes([85, 83, 66, 67, 0x78, 0x56, 0x34, 0x12, 23, 0, 0, 0, 0, 0, 16, 162, 0, 0, 0, 0, 0, 0, 1] + [0] * 8), 'write block: %s' % b.hex())
b = novalink.usb_cbw(22, True, 1)
ok(b[12] == 0x80 and b[15] == 0xA3 and b[8:12] == bytes.fromhex('16000000') and b[22] == 1, 'read block: %s' % b.hex())
ok(novalink.usb_target('usb:0483:5720@1-4.2') == '1-4.2' and novalink.usb_target('usb:') == '' and novalink.usb_target('usb:0483:5720') == ''
   and novalink.usb_target('serial:COM3') is None and novalink.usb_target('10.0.0.5') is None, 'usb_target')

# ------------------------------------------------------------------ listing + the new flow, over the fake libusb
dv1, dv3 = Device('new'), Device('bot')
fake = install({1: dv1, 3: dv3})
ds, err = novalink.usb_devices()
ok(err == '' and [d['host'] for d in ds] == ['usb:0483:5720@1-3', 'usb:0483:5720@1-4.2'], 'usb_devices: the two 0483:5720 devices, not the hub (%s)' % [d['host'] for d in ds])
ok(ds and ds[0]['epOut'] == 0x02 and ds[0]['epIn'] == 0x86 and ds[0]['iface'] == 0 and ds[0]['matched'] and ds[0]['maxPacket'] == 512 and ds[0]['bcdDevice'] == 0x0404,
   'endpoints from the FF/06/50 interface (02 / 86, 512 B)')
ok(fake.opened == [] and fake.inits == fake.exits, 'listing opens nothing and ends its libusb session')

L = novalink.open_link('usb:0483:5720@1-3')
ok(fake.opened == [1] and dv1.claimed == 0, 'open_link usb: opens the device at 1-3 and claims interface 0')
ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62', 'ModelID read, new flow (reply right after the frame)')
ok(dv1.cbws[-1][15] == 0xA2 and struct.unpack_from('<I', dv1.cbws[-1], 8)[0] == 20 and dv1.frames[-1][:2] == b'\x55\xAA', 'write block carries the frame length (20)')
L.write(1, 0, 1, 0xFFFF, 0x02000001, b'\x80')
ok(dv1.frames[-1][10] == 1, 'write acknowledged')
L.write(0, 0, 0, 0, 0x01000020, bytes(44))         # a 64-byte frame: LCT adds an empty packet
ok(len(dv1.frames[-1]) == 64 and dv1.outs[-1] == b'', 'a 64-byte frame is followed by an empty packet (%d outs)' % len(dv1.outs))
big = L.read(0, 0, 0, 0, 0x03000000, 1500)
ok(big == bytes(i & 0xFF for i in range(1500)), 'a 1500-byte read in one transfer')
try: L.read(0, 0, 0, 0, 0x0BAD0000, 4, timeout=0.3); ok(False, 'silence -> timeout')
except novalink.LinkError as e: ok('timeout' in str(e), 'silence -> LinkError timeout (%s)' % e)
h0 = dv1.halts
ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62' and dv1.halts == h0 + 2, 'after a timeout: endpoints cleared, then reads again')
L.close()
ok(not dv1.closed, 'close lets go of the request; the pool keeps the device open for the next one')
L2 = novalink.open_link('usb:0483:5720@1-3'); L2.read(0, 0, 0, 0, 0x00000002, 2); L2.close()
ok(fake.opened == [1], 'the next request uses the same open device')
ok(novalink.close_links(0, 'usb:0483:5720@1-3') == ['usb:0483:5720@1-3'] and dv1.closed and dv1.claimed is None,
   'closing the pooled link releases the interface and closes the device')

# ------------------------------------------------------------------ the old (mass-storage) flow
L = novalink.open_link('usb:0483:5720@1-4.2')
ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62', 'ModelID read, old flow (status, A3 block, data, status)')
ok([c[15] for c in dv3.cbws] == [0xA2, 0xA3] and struct.unpack_from('<I', dv3.cbws[1], 8)[0] == 22 and dv3.cbws[1][12] == 0x80,
   'old flow: A3 asks for 20 + 2 bytes, IN direction')
L.write(1, 0, 1, 0xFFFF, 0x02000001, b'\x80')
ok(struct.unpack_from('<I', dv3.cbws[-1], 8)[0] == 20 and [c[15] for c in dv3.cbws] == [0xA2, 0xA3] * 2, 'old flow: a write reply is 20 bytes; the old status is skipped, not taken for "ask again"')
ok(L.read(0, 0, 0, 0, 0x03000000, 600) == bytes(i & 0xFF for i in range(600)), 'old flow: 600-byte read')
L.close()

# ------------------------------------------------------------------ chunking, junk, stale and trailing status, ComMode
for flow, chunk, junk, what in (('new', 7, b'', 'reply split over 7-byte transfers'), ('new', 512, b'', 'reply in 512-byte transfers'),
                                ('new', 0, b'\x00\x11\x22', 'junk before the reply'), ('stale', 0, b'', 'a stale status before the next reply'),
                                ('trail', 0, b'', 'reply and its status in one transfer'), ('bot', 5, b'', 'old flow, dribbled over 5-byte transfers')):
    d = Device(flow, chunk, junk); install({1: d})
    L = novalink.open_link('usb:0483:5720@1-3')
    try:
        r = [L.read(0, 0, 0, 0, 0x00000002, 2), L.read(0, 0, 0, 0, 0x03000000, 1100), L.read(0, 0, 0, 0, 0x00000002, 2)]
        ok(r == [b'\x0C\x62', bytes(i & 0xFF for i in range(1100)), b'\x0C\x62'] and len(d.cbws) == len(d.frames) * (2 if flow == 'bot' else 1), what)
    except novalink.LinkError as e: ok(False, '%s (%s)' % (what, e))
    finally: L.close()
d = Device('com'); install({1: d})
novalink.USB_MODE = 'com'
try:
    L = novalink.open_link('usb:0483:5720@1-3')
    ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62' and not d.cbws, "ComMode: the frame alone, no USBC block")
    L.close()
finally: novalink.USB_MODE = 'udisk'

# stale data waiting at open is drained, not taken for a reply
d = Device('new'); d.inq.append(reply(b'\x55\xAA\x00\x01' + bytes(14), data=b'\xEE\xEE')); install({1: d})
L = novalink.open_link('usb:'); ok(L.tag == 'usb:0483:5720@1-3' and not d.inq, "usb: alone = the first device; stale data drained at open")
ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62', 'then reads normally'); L.close()

# ------------------------------------------------------------------ probe, locks, recorder
d1, d3 = Device('new'), Device('new'); d3.silent = True   # 1-4.2 never answers
fake = install({1: d1, 3: d3})
ds, _ = novalink.usb_devices()
rs = [novalink.probe_usb(x, 0.3) for x in ds]
ok(rs[0]['answered'] and rs[0]['modelId'] == 0x620C and rs[0]['host'] == 'usb:0483:5720@1-3', 'probe: VX1000 on 1-3')
ok(not rs[1]['answered'] and 'timeout' in rs[1].get('error', ''), 'probe: a silent device is not a controller (%s)' % rs[1].get('error'))
ok(all(len(x.frames) == 1 and struct.unpack_from('<I', x.frames[0], 12)[0] == 2 and x.frames[0][10] == 0 for x in (d1,)) and
   all(f[:4] == b'USBC' or f == b'' or f[10] == 0 for f in d3.outs), 'probe sends one ModelID read and nothing else')
a = novalink.open_link('usb:0483:5720@1-3')
r = novalink.probe_usb(ds[0], 0.3)
ok(r.get('busy') and r['answered'] and r['modelId'] == 0x620C, 'probe: a device Open Nova is using answers from the last probe')
a.close()
r = novalink.probe_usb(ds[0], 0.3)
ok(r.get('busy') and r['answered'] and fake.opened.count(1) == 2, 'probe: a device the pool still holds open (idle) answers from the last probe too')
a = novalink.open_link('usb:0483:5720@1-3', exclusive='a send')
b2 = novalink.open_link('usb:0483:5720@1-3', wait=0.3)
t0 = time.time()
try: b2.read(0, 0, 0, 0, 0x00000002, 2); ok(False, 'during an exclusive operation a new request waits, then busy')
except novalink.LinkBusy as e: ok('busy' in str(e) and time.time() - t0 >= 0.25, 'during an exclusive operation a new request waits, then busy')
try: b2.close()
except novalink.LinkBusy: pass
got = []
def late():
    L = novalink.open_link('usb:0483:5720@1-3', wait=5); got.append(L.read(0, 0, 0, 0, 0x00000002, 2)); L.close()
th = threading.Thread(target=late)
th.start(); time.sleep(0.2); a.close(); th.join(3)
ok(got == [b'\x0C\x62'] and fake.opened.count(1) == 2, 'the waiting request goes on once the operation ends (same open device)')
try: novalink.open_link('usb:0483:5720@9-9', wait=0.3); ok(False, 'a missing location fails cleanly')
except OSError as e: ok('no NovaStar USB device' in str(e), 'a missing location fails cleanly (%s)' % e)

recs = [r for r in wirelog.frames(0, 20000) if r.get('link') == 'usb:0483:5720@1-3']
ok(any(r['kind'] == 'tg' and r['dir'] == 'rx' and r.get('rtt') is not None for r in recs), 'recorder: USB replies with round-trip times')
ok(any(r['kind'] == 'tg' and r['dir'] == 'tx' and r['hex'].startswith('55aa') for r in recs), 'recorder: the TG frame (not the USBC block) recorded')
ok(any(r['kind'] == 'conn' and 'USBC' in r.get('event', '') for r in recs), 'recorder: open recorded')
ok(any(r['kind'] == 'junk' for r in wirelog.frames(0, 20000) if r.get('link', '').startswith('usb:')), 'recorder: junk / drained bytes recorded')
pc = wirelog.to_pcap(wirelog.frames(0, 20000))
back = wirelog.from_capture(pc)
ok(sum(1 for r in back if r.get('kind') == 'tg') >= sum(1 for r in wirelog.frames(0, 20000) if r.get('kind') == 'tg'), '.pcap export / re-import with USB links')

# ------------------------------------------------------------------ no libusb
novalink._LIBUSB[:] = []
real = novalink._libusb_paths
novalink._libusb_paths = lambda: [os.path.join(TMP, 'no-such-libusb')]
try:
    ds, err = novalink.usb_devices()
    ok(ds == [] and 'libusb' in err and ('brew install libusb' in err if sys.platform == 'darwin' else 'libusb' in err), 'no libusb: an empty list and how to get it (%s)' % err)
    try: novalink.open_link('usb:', wait=0.3); ok(False, 'no libusb: open fails with the hint')
    except novalink.LinkError as e: ok('libusb' in str(e), 'no libusb: open fails with the hint')
finally: novalink._libusb_paths = real

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
