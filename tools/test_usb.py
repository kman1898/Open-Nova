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
    novalink._LIBUSB0[:] = [None]                       # no libusb0.dll (a real one in System32 is never used here)
    return fake


class FakeLibusb0:
    """libusb-win32's libusb0.dll as Python functions (what ctypes would call): devices 1 and 3 are 0483:5720 on libusb0.sys
    (file names like libusb0-0001--0x0483-0x5720, behind the Windows device prefix), device 2 is something else. Bus and device structs are built
    with the wrapper's own (byte-packed) types, so their layout is the one the code reads."""
    def __init__(self, devs, fail=None):
        self.devs, self.keep, self.opened, self.calls, self.fail, self.reads = devs, [], [], [], fail or {}, []
        handles = {}
        hv = lambda h: getattr(h, 'value', h)
        me = self

        def usb_init(): me.calls.append('init')
        def usb_find_busses(): return 1
        def usb_find_devices(): return 0
        def usb_get_version(): return None
        def usb_get_busses():
            C, L = ctypes, me.lib
            UDEV, UBUS = L.UDEV, L.UBUS
            CFG = dict(UDEV._fields_)['config']._type_; DEV = dict(UDEV._fields_)['descriptor']
            ALT = dict(CFG._fields_)['interface']._type_; IF = dict(ALT._fields_)['altsetting']._type_; EP = dict(IF._fields_)['endpoint']._type_
            bus = UBUS(); bus.dirname = b'bus-0'
            prev = None
            for n, (v, p) in ((1, (0x0483, 0x5720)), (2, (0x8086, 0x2934)), (3, (0x0483, 0x5720))):
                eps = (EP * 2)(); eps[0].bEndpointAddress, eps[0].wMaxPacketSize = 0x02, 512; eps[1].bEndpointAddress, eps[1].wMaxPacketSize = 0x86, 512
                itf = IF(); itf.bNumEndpoints, itf.bInterfaceClass, itf.bInterfaceSubClass, itf.bInterfaceProtocol = 2, 0xFF, 0x06, 0x50
                itf.endpoint = C.cast(eps, C.POINTER(EP))
                alt = ALT(); alt.altsetting = C.pointer(itf); alt.num_altsetting = 1
                cfg = CFG(); cfg.bNumInterfaces, cfg.bConfigurationValue, cfg.interface = 1, 1, C.pointer(alt)
                d = UDEV(); d.filename = b'\\\\.\\libusb0-%04d--0x%04x-0x%04x' % (n, v, p); d.devnum = n
                d.descriptor = DEV(idVendor=v, idProduct=p, bcdDevice=0x0404, bcdUSB=0x0200); d.config = C.pointer(cfg); d.bus = C.pointer(bus)
                if prev is None: bus.devices = C.pointer(d)
                else: prev.next = C.pointer(d)
                prev = d; me.keep += [eps, itf, alt, cfg, d]
            me.keep.append(bus)
            return C.pointer(bus)
        def usb_open(d):
            n = int(d.contents.filename.split(b'libusb0-')[1][:4])
            if n not in me.devs: return None
            me.opened.append(n); handles[0x200 + n] = me.devs[n]; return 0x200 + n
        def usb_close(h): handles[hv(h)].closed = True; me.calls.append('close'); return 0
        def usb_set_configuration(h, c): me.calls.append('config %d' % c); return me.fail.get('config', 0)
        def usb_claim_interface(h, i):
            me.calls.append('claim %d' % i)
            if me.fail.get('claim'): return me.fail['claim']
            handles[hv(h)].claimed = i; return 0
        def usb_release_interface(h, i): handles[hv(h)].claimed = None; me.calls.append('release'); return 0
        def usb_clear_halt(h, ep): handles[hv(h)].halts += 1; return 0
        def usb_bulk_write(h, ep, buf, n, ms):
            assert ep == 0x02, 'OUT on endpoint %02X' % ep
            handles[hv(h)].out(ctypes.string_at(buf, n)); return n
        def usb_bulk_read(h, ep, buf, n, ms):
            assert ep == 0x86, 'IN on endpoint %02X' % ep
            me.reads.append(n); dv = handles[hv(h)]
            end = time.time() + ms / 1000.0
            while not dv.inq:
                if time.time() >= end: return -116
                time.sleep(0.005)
            d = dv.inq.pop(0)
            if len(d) > n: return -5
            ctypes.memmove(buf, d, len(d)); return len(d)
        def usb_strerror(): return b'libusb0-dll:err [claim_interface] could not claim interface 0, win error: busy'
        for k, v in list(locals().items()):
            if k.startswith('usb_'): setattr(self, k, v)


def install0(devs, fail=None, devs1=None):
    """novalink.libusb0() -> a _Libusb0 over FakeLibusb0 (built through the real constructor); libusb-1.0 = FakeLibusb with
    devs1 (its own 0483:5720 at 1-3 / 1-4.2), as on a Windows PC that has both."""
    f1 = install(devs1 or {})
    fake = FakeLibusb0(devs, fail)
    real = ctypes.CDLL
    ctypes.CDLL = lambda path: fake
    try: lib = novalink._Libusb0('fake-libusb0')
    finally: ctypes.CDLL = real
    fake.lib = lib
    novalink._LIBUSB0[:] = [lib]
    return fake, f1


class FakeSys:
    """sys for novalink with another platform / version (the per-system paths and messages)."""
    def __init__(self, platform, version=sys.version): self.platform, self.version = platform, version
    def __getattr__(self, k): return getattr(sys, k)


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
seen = novalink.USB_SEEN.pop('usb:0483:5720@1-3'); n0 = len(d1.frames)
r = novalink.probe_usb(ds[0], 0.3)   # held open before any probe (tools/usbauto.py arms the bridge first): asked through the pool
ok(r['answered'] and r['modelId'] == 0x620C and len(d1.frames) == n0 + 1 and fake.opened.count(1) == 2, 'probe: held open with no probe yet -> one ModelID read through the pool, not a second open')
novalink.USB_SEEN['usb:0483:5720@1-3'] = seen
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
n0 = len(d1.frames)
novalink.usb_yield('usb:0483:5720@1-3', 'NovaLCT has it')   # tools/usbauto.py: NovaLCT's turn
r = novalink.probe_usb(ds[0], 0.3)
ok(r.get('busy') and r.get('yielded') and len(d1.frames) == n0 and not novalink.close_links(0), 'probe: yielded to NovaLCT -> nothing sent, the idle connection already closed')
try: novalink.open_link('usb:0483:5720@1-3', wait=0.3); ok(False, 'yielded: a request is refused without opening it')
except novalink.LinkBusy as e: ok('NovaLCT has it' in str(e) and fake.opened.count(1) == 2, 'yielded: a request is refused without opening it (%s)' % e)
novalink.usb_yield('usb:0483:5720@1-3', None)
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

# ------------------------------------------------------------------ Windows: libusb0.dll (NovaLCT's driver), same framing
ds1 = Device('new')
f0, f1 = install0({1: Device('new'), 3: Device('bot')}, devs1={1: ds1})
ds, err = novalink.usb_devices()
ok(err == '' and [d['host'] for d in ds] == ['usb:0483:5720@libusb0-0001', 'usb:0483:5720@libusb0-0003'] and all(d['lib'] == 'libusb0' for d in ds),
   'libusb0: its two 0483:5720 devices, not the other one, and libusb-1.0 (which lists them too, unusable) not asked (%s)' % [d['host'] for d in ds])
ok(f1.inits == 0 and ds[0]['epOut'] == 0x02 and ds[0]['epIn'] == 0x86 and ds[0]['matched'] and ds[0]['maxPacket'] == 512 and ds[0]['config'] == 1,
   'libusb0: endpoints from the FF/06/50 interface of the packed structs (02 / 86, 512 B)')
ok(f0.opened == [] and [d['label'] for d in ds] == ['USB 1', 'USB 3'], 'libusb0: listing opens nothing; labels "USB 1", "USB 3"')
L = novalink.open_link('usb:0483:5720@libusb0-0001')
dv = f0.devs[1]
ok(f0.opened == [1] and f0.calls[-2:] == ['config 1', 'claim 0'], 'libusb0: open, configuration 1, then interface 0 (LCT\'s order) %s' % f0.calls)
ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62' and dv.cbws[-1][15] == 0xA2, 'libusb0: ModelID read behind the USBC write block')
ok(L.read(0, 0, 0, 0, 0x03000000, 1500) == bytes(i & 0xFF for i in range(1500)), 'libusb0: a 1500-byte read')
L.write(0, 0, 0, 0, 0x01000020, bytes(44))
ok(len(dv.frames[-1]) == 64 and dv.outs[-1] == b'', 'libusb0: a 64-byte frame is followed by an empty packet')
ok(f0.reads and max(f0.reads) <= 0x10000, 'libusb0: no read asks for more than 64 KiB (%d)' % max(f0.reads or [0]))
try: L.read(0, 0, 0, 0, 0x0BAD0000, 4, timeout=0.3); ok(False, 'libusb0: silence -> timeout')
except novalink.LinkError as e: ok('timeout' in str(e), 'libusb0: silence (-116) -> LinkError timeout')
h0 = dv.halts
ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62' and dv.halts == h0 + 2, 'libusb0: after a timeout, endpoints cleared, then reads again')
L.close()
ok(novalink.close_links(0, 'usb:0483:5720@libusb0-0001') == ['usb:0483:5720@libusb0-0001'] and dv.closed and f0.calls[-2:] == ['release', 'close'],
   'libusb0: closing releases the interface, then closes')
L = novalink.open_link('usb:0483:5720@libusb0-0003')
ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62' and [c[15] for c in f0.devs[3].cbws] == [0xA2, 0xA3], 'libusb0: the old flow too (status, A3 block, data)')
L.close(); novalink.close_links()
recs = [r for r in wirelog.frames(0, 20000) if r.get('link') == 'usb:0483:5720@libusb0-0001']
ok(any(r['kind'] == 'conn' and 'USBC' in r.get('event', '') and r.get('lib') == 'libusb0' for r in recs) and
   any(r['kind'] == 'tg' and r['dir'] == 'rx' for r in recs), 'libusb0: open (with the library) and the frames are recorded')
r = novalink.probe_usb(dict(ds[0]), 0.3)
ok(r['answered'] and r['modelId'] == 0x620C, 'libusb0: probe finds the VX1000')
novalink.close_links()
f0, f1 = install0({1: Device('new')}, fail={'claim': -16})
try: novalink.open_link('usb:0483:5720@libusb0-0001', wait=0.3); ok(False, 'libusb0: a claimed device fails with what to do')
except OSError as e: ok(str(e).startswith(novalink.USB_FIX['busy']) and 'libusb0 -16' in str(e) and f0.devs[1].closed,
                        'libusb0: interface taken by another program -> "%s"' % e)
# libusb0.dll there but the device on another driver (WinUSB): libusb0 lists none, libusb-1.0 does
f0, f1 = install0({}, devs1={1: Device('new')})
f0.lib.L.usb_get_busses = lambda: None
ds, err = novalink.usb_devices()
ok(err == '' and [d['host'] for d in ds] == ['usb:0483:5720@1-3', 'usb:0483:5720@1-4.2'] and ds[0]['lib'] == 'libusb-1.0', 'libusb0 lists none -> libusb-1.0 (WinUSB) is asked')
L = novalink.open_link('usb:0483:5720@1-3'); ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62', 'and its device is opened through libusb-1.0'); L.close()
novalink.close_links()

# ------------------------------------------------------------------ the messages: plain words, the one thing to do, the cause recorded
real_sys = novalink.sys
try:
    for plat, name, cause in (('win32', 'LIBUSB_ERROR_NOT_SUPPORTED', 'driver'), ('win32', 'LIBUSB_ERROR_NOT_FOUND', 'driver'),
                              ('win32', 'LIBUSB_ERROR_ACCESS', 'busy'), ('linux', 'LIBUSB_ERROR_ACCESS', 'udev'),
                              ('darwin', 'LIBUSB_ERROR_ACCESS', 'busy'), ('linux', 'LIBUSB_ERROR_BUSY', 'busy'), ('linux', 'LIBUSB_ERROR_IO', '')):
        novalink.sys = FakeSys(plat)
        fake = install({})
        fake.lib.L.libusb_error_name = lambda rc, n=name: n.encode()
        e = str(fake.lib.err('open 1-3', -12))
        want = novalink.USB_FIX[cause] if cause else 'USB open 1-3'
        ok(e.startswith(want) and name in e, '%s %s -> %s' % (plat, name, e))
    novalink.sys = FakeSys('linux')
    ok('SUBSYSTEM=="usb", ATTR{idVendor}=="0483", ATTR{idProduct}=="5720"' in novalink.usb_fix('udev'),
       'Linux: the message gives the udev rule itself')
    ok(novalink.usb_fix('lib') == novalink.USB_FIX['lib-linux'] and 'apt install libusb-1.0-0' in novalink.usb_fix('lib'), 'Linux, no libusb: the apt hint')
    novalink.sys = FakeSys('darwin')
    ok(novalink.usb_fix('lib') == novalink.USB_FIX['lib-mac'], 'macOS, no libusb: the Mac package (or brew)')
    novalink.sys = FakeSys('win32')
    real_drv = novalink.nova_usb_drivers
    for drv, want in (([], 'driver'), ([''], 'driver'), (['libusb0'], 'driver'), (['WinUSB'], 'lib-win')):
        novalink.nova_usb_drivers = lambda d=drv: d
        ok(novalink.usb_fix('lib') == novalink.USB_FIX[want], 'Windows, no USB library, driver %s -> %s' % (drv or 'never seen', want))
    novalink.nova_usb_drivers = real_drv
    ok('Install NovaLCT once (it installs the USB driver)' in novalink.USB_FIX['driver'] and 'Zadig' in novalink.USB_FIX['driver'], 'Windows, no NovaStar driver: install NovaLCT once, or Zadig ▸ WinUSB')
finally: novalink.sys = real_sys

# ------------------------------------------------------------------ where libusb is looked for: the package's own copy first
pkg = os.path.dirname(novalink.HERE)
real_env = os.environ.pop('OPENNOVA_LIBUSB', None)
try:
    novalink.sys = FakeSys('win32', '3.14.0 (main) [MSC v.1944 64 bit (AMD64)]')
    p = novalink._libusb_paths()
    want = [os.path.join(pkg, 'libusb', 'windows-x64', 'libusb-1.0.dll'), os.path.join(pkg, 'libusb', 'windows-arm64', 'libusb-1.0.dll')]
    nova = [i for i, x in enumerate(p) if 'Nova Star' in x]
    ok(p[:2] == want and nova and min(nova) > 1, 'Windows x64: the package\'s libusb/windows-x64 first, then arm64, NovaStar\'s copies last (%s)' % p[:2])
    novalink.sys = FakeSys('win32', '3.14.0 (main) [MSC v.1944 64 bit (ARM64)]')
    ok(novalink._libusb_paths()[:2] == want[::-1], 'Windows ARM64: libusb/windows-arm64 first')
    ok(novalink._libusb0_paths() == ['libusb0.dll'], 'Windows: libusb0.dll by its name (System32, where NovaLCT\'s driver puts it)')
    import platform
    real_m = platform.machine
    for m, first in (('arm64', 'macos-arm64'), ('x86_64', 'macos-x86_64')):
        platform.machine = lambda m=m: m
        novalink.sys = FakeSys('darwin')
        p = novalink._libusb_paths()
        ok(p[0] == os.path.join(pkg, 'libusb', first, 'libusb-1.0.0.dylib') and len([x for x in p[:2] if os.sep + 'libusb' + os.sep in x]) == 2 and
           p.index('/opt/homebrew/lib/libusb-1.0.0.dylib') > 1, 'macOS %s: the package\'s %s first, then the other arch, then Homebrew' % (m, first))
    platform.machine = real_m
    novalink.sys = FakeSys('linux')
    ok(novalink._libusb_paths()[0] == 'libusb-1.0.so.0', 'Linux: the system\'s libusb (nothing bundled)')
    os.environ['OPENNOVA_LIBUSB'] = 'libusb_test.dll'
    ok(novalink._libusb_paths()[0] == 'libusb_test.dll', '$OPENNOVA_LIBUSB before everything')
finally:
    novalink.sys = real_sys
    os.environ.pop('OPENNOVA_LIBUSB', None)
    if real_env is not None: os.environ['OPENNOVA_LIBUSB'] = real_env

# ------------------------------------------------------------------ no libusb at all
novalink._LIBUSB[:] = []; novalink._LIBUSB0[:] = [None]
real = novalink._libusb_paths
novalink._libusb_paths = lambda: [os.path.join(TMP, 'no-such-libusb')]
try:
    ds, err = novalink.usb_devices()
    ok(ds == [] and err == 'NovaStar USB: ' + novalink.usb_fix('lib'), 'no libusb: an empty list and what to do (%s)' % err)
    ok(any(r['kind'] == 'conn' and r.get('event') == 'USB not usable' and r.get('error') == err for r in wirelog.frames(0, 50000)),
       'no libusb: the cause is in the recorder (and so in a problem report)')
    try: novalink.open_link('usb:', wait=0.3); ok(False, 'no libusb: open fails with what to do')
    except novalink.LinkError as e: ok(str(e) == err, 'no libusb: open fails with what to do')
finally: novalink._libusb_paths = real

# ------------------------------------------------------------------ a VX4S-N as a tester's report shows it (2026-11-20)
class Vx4sN(Device):
    """Answers the SortCommand (0x01000000, sent as "no reply expected") ~51 ms late and loses any frame that arrives before
    that answer (the report: both Sends stopped on the port-flag write sent 50 ms after it). A 296 B read of 0x02000000
    -> status 4, 256 B is fine (Detect said "no answer", 0 ports). sort_answer=False: a unit that never answers it."""
    def __init__(self, sort_answer=True):
        Device.__init__(self, 'new'); self.later, self.busy, self.lost, self.sort_answer = [], 0, [], sort_answer
        dev = self
        class Q(list):
            def _due(q):
                while dev.later and dev.later[0][0] <= time.time(): list.append(q, dev.later.pop(0)[1])
            def __bool__(q): q._due(); return list.__len__(q) > 0
            def __len__(q): q._due(); return list.__len__(q)
        self.inq = Q()

    def out(self, b):
        if self.want and len(self.data) + len(b) >= self.want:
            f = self.data + b; addr, n = struct.unpack_from('<I', f, 12)[0], struct.unpack_from('<H', f, 16)[0]
            take = lambda: (setattr(self, 'data', b''), setattr(self, 'want', 0), self.frames.append(f))
            if time.time() < self.busy: take(); self.lost.append(f); return
            if addr == 0x01000000:
                take()
                if self.sort_answer: self.busy = time.time() + 0.051; self.later.append((self.busy, reply(f)))
                return
            if addr == 0x02000000 and f[10] == 0 and n == 296: take(); self.queue(reply(f, status=4)); return
        Device.out(self, b)


vx = Vx4sN(); fake = install({1: vx})
L = novalink.open_link('usb:0483:5720@1-3')
n_err = sum(1 for r in wirelog.frames(0, 50000) if r.get('kind') == 'err')
t0 = time.time()
L.write(0, 0xFF, 0, 0, 0x01000000, b'\x00', no_reply=True)
dt = time.time() - t0
try: L.write(0, 0xFF, 0, 0, 0x02000018, b'\x00'); took = True
except novalink.LinkError as e: took = False; print('   ', e)
ok(took and not vx.lost, 'VX4S-N: the port-flag write after the SortCommand is answered (it waits for the late answer, %.0f ms)' % (dt * 1000))
ok(0.05 <= dt < 0.25, 'VX4S-N: the SortCommand wait ends when its answer comes (%.0f ms), not at the full wait' % (dt * 1000))
ok(novalink.linked_ports(L, 0, 4) == [0, 1, 2, 3], 'VX4S-N: the port-link read asks 256 B (296 B gets status 4), its 4 ports read')
try: novalink.linked_ports(L, 0, 16); ok(True, 'a 16-port card: 256 B + 0x02000100 (no 296 B read)')
except novalink.LinkError as e: ok(False, 'a 16-port card: 256 B + 0x02000100 (no 296 B read): %s' % e)
ok(not any(struct.unpack_from('<H', f, 16)[0] == 296 for f in vx.frames if f[10] == 0), 'no 296 B read is sent any more')
L.close(); novalink.close_links()
vq = Vx4sN(sort_answer=False); fake = install({1: vq})
L = novalink.open_link('usb:0483:5720@1-3')
t0 = time.time(); L.write(0, 0xFF, 0, 0, 0x01000000, b'\x00', no_reply=True); dt = time.time() - t0
h0 = vq.halts
ok(L.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62' and vq.halts == h0, 'a unit that never answers the SortCommand: on after %.0f ms, no clear-halt, the next read fine' % (dt * 1000))
ok(sum(1 for r in wirelog.frames(0, 50000) if r.get('kind') == 'err') == n_err, 'an unanswered "no reply expected" write is not recorded as an error')
L.close(); novalink.close_links()

# ------------------------------------------------------------------ the libraries the packages carry load here (when built)
for f in ([os.path.join(pkg, 'libusb', 'windows-x64', 'libusb-1.0.dll')] if sys.platform == 'win32' and struct.calcsize('P') == 8 else []):
    if not os.path.isfile(f): print('SKIP %s isn\'t here (an unzipped Windows package has it)' % f); continue
    lib = novalink._Libusb(f); C = lib.C
    ctx, lst = C.c_void_p(), C.POINTER(C.c_void_p)()
    rc = lib.L.libusb_init(C.byref(ctx)); n = lib.L.libusb_get_device_list(ctx, C.byref(lst)) if rc == 0 else -1
    if n >= 0: lib.L.libusb_free_device_list(lst, 1)
    lib.L.libusb_exit(ctx)
    ok(rc == 0 and n >= 0, 'the bundled %s loads: libusb_init %d, %d USB devices listed' % (f, rc, n))

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
