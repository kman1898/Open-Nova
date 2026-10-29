"""Tests for novalink's USB / serial links (docs/USB_SERIAL.md) with stand-in ports only: no real COM port is opened.
A fake controller behind a loopback port object: frames byte-identical to TCP, replies in dribbles and after junk, a
timeout, the recorder (link "serial:FAKE1", .pcap export), the probe (115200, the 1,048,576 fallback, busy), target strings,
the one-link-per-target lock (TCP and serial), a pty on macOS / Linux, and on Windows a missing COM port failing cleanly.
    python -I tools/test_serial.py   (exit 0 = all passed)
"""
import os
import socket
import struct
import sys
import tempfile
import threading
import time

TMP = tempfile.mkdtemp(prefix='opennova_serial_test_')
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
    """The fake controller: 0x00000002 -> ModelID 0x620C (VX1000); a write -> ack; 0x0BAD0000 -> silence."""
    addr = struct.unpack_from('<I', req, 12)[0]
    if addr == 0x0BAD0000: return b''
    if req[10] == 1: return reply(req)
    if addr == 0x00000002: return reply(req, data=b'\x0C\x62')
    return reply(req, data=bytes(struct.unpack_from('<H', req, 16)[0]))


class FakePort(novalink._SerialBase):
    """A loopback 'COM port' with the controller behind it. Replies come back a few bytes at a time, after junk.
    Answers only at `speed` (another baud = silence, like a real UART at the wrong rate)."""
    speed = 115200
    opened = []

    def __init__(self, name, baud, timeout):
        self.name, self.baud, self.timeout, self.out, self.closed = name, baud, timeout, bytearray(), False
        FakePort.opened.append((name, baud))

    def sendall(self, b):
        if self.baud != self.speed: return
        r = answer(bytes(b))
        if r: self.out += b'\x00\xFF' + r                    # junk before the frame

    def _read(self, n, wait):
        if not self.out: time.sleep(wait); return b''
        d = bytes(self.out[:min(n, 5)]); del self.out[:len(d)]  # dribbles of 5 bytes
        return d

    def close(self): self.closed = True


# ------------------------------------------------------------------ frames and replies over the fake port
link = novalink.SerialLink('FAKE1', port_obj=FakePort('FAKE1', 115200, 3.0))
b = link.read(0, 0, 0, 0, 0x00000002, 2)
ok(b == b'\x0C\x62', 'ModelID read over serial: %s' % b.hex())
ok(novalink.senders_on(link, limit=2) == [0x620C, 0x620C], 'senders_on over serial (the fake answers every dst)')
link.write(1, 0, 1, 0xFFFF, 0x02000001, b'\x80')
ok(True, 'write acknowledged over serial')
try: link.read(0, 0, 0, 0, 0x0BAD0000, 4, timeout=0.3); ok(False, 'timeout on silence')
except novalink.LinkError as e: ok('timeout' in str(e), 'no reply -> LinkError timeout (%s)' % e)
link.close()
ok(link.s.closed and link.lock is None, 'close closes the port (no lock held: it was given a port object)')

# the bytes on the wire are the TCP ones
srv = socket.socket(); srv.bind(('127.0.0.1', 0)); srv.listen(4); tport = srv.getsockname()[1]
def tcp_fake():
    while True:
        try: c, _ = srv.accept()
        except OSError: return
        def serve(c):
            buf = b''
            while True:
                try: d = c.recv(4096)
                except OSError: return
                if not d: return
                buf += d
                while len(buf) >= 20 and len(buf) >= 20 + (struct.unpack_from('<H', buf, 16)[0] if buf[10] == 1 else 0):
                    n = 20 + (struct.unpack_from('<H', buf, 16)[0] if buf[10] == 1 else 0)
                    r = answer(buf[:n]); buf = buf[n:]
                    if r: c.sendall(r)
        threading.Thread(target=serve, args=(c,), daemon=True).start()
threading.Thread(target=tcp_fake, daemon=True).start()
t = novalink.open_link('127.0.0.1', tport); s = novalink.SerialLink('FAKE2', port_obj=FakePort('FAKE2', 115200, 3.0))
for L in (t, s):
    L.read(0, 0, 0, 0, 0x00000002, 2); L.write(0, 0xFF, 0, 0, 0x01000000, b'\x00', no_reply=True); L.write(1, 2, 3, 7, 0x02000100, b'\xFF')
t.close(); s.close()
tx = lambda tag: [r['hex'] for r in wirelog.frames(0, 5000) if r.get('kind') == 'tg' and r.get('link') == tag and r.get('dir') == 'tx']
ok(tx('127.0.0.1:%d' % tport) == tx('serial:FAKE2') and len(tx('serial:FAKE2')) == 3, 'serial frames byte-identical to TCP frames')

# ------------------------------------------------------------------ recorder
recs = [r for r in wirelog.frames(0, 5000) if r.get('link') == 'serial:FAKE1']
ok(any(r['kind'] == 'tg' and r['dir'] == 'rx' and r.get('rtt') is not None for r in recs), 'recorder: serial replies with round-trip times')
ok(any(r['kind'] == 'err' for r in recs), 'recorder: the serial timeout recorded')
ok(any(r['kind'] == 'junk' for r in recs), 'recorder: junk before a reply recorded')
pc = wirelog.to_pcap(wirelog.frames(0, 5000))
ok(len(pc) > 100, '.pcap export with serial links (%d B)' % len(pc))
back = wirelog.from_capture(pc)
ok(sum(1 for r in back if r.get('kind') == 'tg') >= sum(1 for r in wirelog.frames(0, 5000) if r.get('kind') == 'tg'), '.pcap re-import keeps every frame')

# ------------------------------------------------------------------ target strings
ok(novalink.serial_target('serial:COM3') == ('COM3', 115200), "serial_target('serial:COM3')")
ok(novalink.serial_target('serial:/dev/cu.usbserial-0001@1048576') == ('/dev/cu.usbserial-0001', 1048576), 'serial_target with @baud')
ok(novalink.serial_target('192.168.0.10') is None, 'an IP is not a serial target')

# ------------------------------------------------------------------ probe (the port class swapped for the fake)
real = novalink._WinSerial, novalink._PosixSerial
novalink._WinSerial = novalink._PosixSerial = FakePort
try:
    r = novalink.probe_serial({'name': 'FAKE3', 'label': 'FAKE3'}, timeout=0.3)
    ok(r['answered'] and r['modelId'] == 0x620C and r['host'] == 'serial:FAKE3' and r['baud'] == 115200, 'probe: VX1000 at 115200 (%s)' % r)
    FakePort.speed = 1048576; FakePort.opened = []
    r = novalink.probe_serial({'name': 'FAKE4'}, timeout=0.3)
    ok(r['answered'] and r['host'] == 'serial:FAKE4@1048576' and FakePort.opened == [('FAKE4', 115200), ('FAKE4', 1048576)], 'probe: falls back to 1,048,576 (%s)' % r.get('host'))
    FakePort.speed = 0
    r = novalink.probe_serial({'name': 'FAKE5'}, timeout=0.2)
    ok(not r['answered'] and 'timeout' in r.get('error', ''), 'probe: a silent port is not a controller (%s)' % r.get('error'))
    FakePort.speed = 115200
    l3 = novalink.open_link('serial:FAKE3')
    r = novalink.probe_serial({'name': 'FAKE3'}, timeout=0.3)
    ok(r.get('busy') and r['answered'] and r['modelId'] == 0x620C, 'probe: a port Open Nova is using answers from the last probe')
    l3.close()
    rs = novalink.probe_serial_all([{'name': 'FAKE6'}, {'name': 'FAKE7'}], timeout=0.3)
    ok([x['answered'] for x in rs] == [True, True], 'probe_serial_all: every port at once')
    # one connection per target (the link pool): a second request shares the open port; an exclusive operation makes a
    # new request wait, then "busy"; another port is not held up (more in test_linkpool.py)
    FakePort.opened = []
    a = novalink.open_link('serial:FAKE8')
    b2 = novalink.open_link('serial:FAKE8', wait=0.3)
    ok(b2.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62' and FakePort.opened == [('FAKE8', 115200)], 'serial: a second request shares the one open port')
    b2.close(); a.exclusive('a send')
    t0 = time.time(); c2 = novalink.open_link('serial:FAKE8', wait=0.3)
    try: c2.read(0, 0, 0, 0, 0x00000002, 2); ok(False, 'serial: during an exclusive operation a new request waits, then busy')
    except novalink.LinkBusy as e: ok('busy: a send is running' in str(e) and time.time() - t0 >= 0.25, 'serial: during an exclusive operation a new request waits, then busy (%s)' % e)
    try: c2.close(); ok(False, 'serial: the refused request\'s close() says busy')
    except novalink.LinkBusy: ok(True, 'serial: the refused request\'s close() says busy')
    other = novalink.open_link('serial:FAKE9', wait=0.3); other.close(); ok(True, 'serial: another port opens meanwhile')
    got = []
    def late():
        L = novalink.open_link('serial:FAKE8', wait=5); got.append(L.read(0, 0, 0, 0, 0x00000002, 2)); L.close()
    th = threading.Thread(target=late)
    th.start(); time.sleep(0.2); a.close(); th.join(3)
    ok(got == [b'\x0C\x62'], 'serial: the waiting request goes on once the operation ends')
    ok(novalink.close_links(0, 'serial:FAKE8') == ['serial:FAKE8'], 'serial: the pool closes the port when asked (nobody holds it)')
finally:
    novalink._WinSerial, novalink._PosixSerial = real

t1 = novalink.open_link('127.0.0.1', tport, exclusive='a save')
t1b = novalink.open_link('127.0.0.1', tport, wait=0.3)
try: t1b.read(0, 0, 0, 0, 0x00000002, 2); ok(False, 'TCP: during an exclusive operation a new request waits, then busy')
except novalink.LinkBusy as e: ok('busy' in str(e), 'TCP: during an exclusive operation a new request waits, then busy')
try: t1b.close()
except novalink.LinkBusy: pass
t2 = novalink.open_link('localhost', tport, wait=0.3); ok(True, 'TCP: another target opens meanwhile'); t2.close()
t1.close(); t3 = novalink.open_link('127.0.0.1', tport, wait=0.3); t3.read(0, 0, 0, 0, 0x00000002, 2); t3.close(); ok(True, 'TCP: exclusive hold released on close')
for k in range(2):   # a refused connection releases its lock: the second try is refused too, not "busy"
    try: novalink.open_link('127.0.0.1', 1, wait=0.3); ok(False, 'TCP: a refused connection raises'); break
    except novalink.LinkError: ok(False, 'TCP: a refused connection releases the lock'); break
    except OSError: pass
else: ok(True, 'TCP: a refused connection raises and releases the lock')
srv.close()

# ------------------------------------------------------------------ the real port classes, without real hardware
if sys.platform != 'win32' and hasattr(os, 'openpty'):
    m, sl = os.openpty(); path = os.ttyname(sl)
    def dev():   # the controller on the master side of a pty
        buf = b''
        while True:
            try: d = os.read(m, 4096)
            except OSError: return
            if not d: return
            buf += d
            while len(buf) >= 20:
                n = 20 + (struct.unpack_from('<H', buf, 16)[0] if buf[10] == 1 else 0)
                if len(buf) < n: break
                r = answer(buf[:n]); buf = buf[n:]
                if r: os.write(m, r)
    threading.Thread(target=dev, daemon=True).start()
    pl = novalink.open_link('serial:' + path)
    ok(pl.read(0, 0, 0, 0, 0x00000002, 2) == b'\x0C\x62', 'termios port on a pty: ModelID read (%s)' % path)
    pl.close()
else:
    from ctypes import wintypes as W
    ok(all(p['name'] != 'COM250' for p in novalink.serial_ports()), 'COM250 is not a port on this PC (safe to try)')
    try: novalink.open_link('serial:COM250', wait=0.3); ok(False, 'a missing COM port fails cleanly')
    except OSError as e: ok(True, 'a missing COM port fails cleanly (%s)' % e)
    ok(isinstance(novalink.serial_ports(), list), 'serial_ports lists (registry only): %s' % [p['name'] for p in novalink.serial_ports()])

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
