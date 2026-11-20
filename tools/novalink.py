"""novalink: sends Open Nova hardware plans (app\\hwsend.js) to NovaStar processors over TCP or a USB / serial COM port.

Protocol per docs\\HW_PROTOCOL.md (classic TG frame, verified against NovaLCT and the fake processor):
  request  55 AA, 00, serial, FE, dst, dev, port, card u16, op (0 read / 1 write), r2, addr u32, len u16, [data], sum u16
  reply    AA 55, status (0 = ok), serial, ..., len u16, [data], sum u16;  sum = 0x5555 + bytes from offset 2
One request in flight, 3 s timeout, 256-byte payloads.

  python novalink.py serve [--port 8790] [--app-port 8775]   local HTTP helper for the app (127.0.0.1 only; --app-port: the app server's
                                                    port when it isn't 8765 / 8766, for pages that call the helper directly)
  python novalink.py run <plan.json> --host H --port P [--log file]
  python novalink.py sim <plan.json> --out <dir>    run the plan against an in-memory processor, dump sender pages
  python novalink.py discover                       UDP 3800 search (NovaLCT protocol processors)
  python novalink.py detect --host H --port P [--cards 0:20,1:20] [--probe 0.5]   receiving cards per port, in cable order
  python novalink.py serial [--probe 1]             list serial ports and NovaStar USB devices; --probe asks each (read-only)
  --host serial:COM3 (or serial:/dev/cu.usbserial-0001) in place of an IP = that USB / serial port (docs\\USB_SERIAL.md)
  --host usb:0483:5720@20-1.2 (or just usb:) = NovaStar's own USB device, via libusb-1.0 (docs\\USB_NOVA_DEVICE.md);
      usb:0483:5720@libusb0-0001 = one on NovaLCT's Windows driver, via libusb0.dll

The helper also serves /api/hw/{discover,info,detect} and /api/unico/{discover,info,detect,send,backup-mode} for Unico-family processors (VX Pro): see unicolink.py,
and /api/coex/* for COEX controllers (MX40 Pro, MX6000 Pro …): see coexlink.py, and /api/hw/hweb/{login,info,forget} for the
H series' own web API (chassis model, output slots; the login stays on this computer): see hweb.py.
A port "5201+5202" = one H chassis over several links (MultiLink: one per output slot).
One persistent connection per processor, shared by every request (the link pool, see open_link; /api/hw/links shows it);
writes (Send, Save, gamma, .rcfgx / NCP, calibration, error clear) hold it exclusively. /api/hw/proxy = an optional local proxy port
over that one connection (off unless asked).

Sends only to the host:port it is given. It never runs the receiving-card Save (0x01000011) unless a plan asks.
"""
import errno, itertools, json, lzma, math, os, socket, struct, sys, time, datetime, threading
if os.environ.get('OPENNOVA_STARTUP_TRACE'):   # tools/smoke_package.py: where a start that never answers is stuck
    import faulthandler; faulthandler.dump_traceback_later(float(os.environ['OPENNOVA_STARTUP_TRACE']), repeat=True)
import wirelog   # the flight recorder: every frame to / from a processor (docs/DIAGNOSTICS.md)
import alpha     # version, the alpha's read-only gate, first-contact snapshots, the problem report (docs/DIAGNOSTICS.md "The alpha build")
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
# Pages allowed to call the helper straight from the browser (the app itself goes through its server's proxy, which sends no
# Origin): the app server on this computer = localhost / 127.0.0.1 / [::1] / each of its own addresses (LAN, a VPN such as
# Tailscale; netif.addresses) on the app's ports. Worked out when the helper starts, again (at most every 30 s) when an
# unknown Origin comes in, so an address that turns up later (Wi-Fi, VPN) is picked up; any other Origin is refused.
APP_PORTS = [8765, 8766]          # opennova.py / serve.py, the test instance; serve --app-port N or OPENNOVA_APP_PORTS add more
ALLOWED_ORIGINS, _ORIGINS_AT = set(), [0.0]
CHUNK = 256


def allowed_origins(ports=None):
    import netif
    hosts = ['localhost', '127.0.0.1', '[::1]'] + netif.addresses()
    return {'http://%s:%d' % (h, p) for h in hosts for p in (ports or APP_PORTS)}


def origin_ok(o):
    """Is Origin o one of the app's own pages on this computer (see ALLOWED_ORIGINS)?"""
    if o in ALLOWED_ORIGINS: return True
    if time.time() - _ORIGINS_AT[0] > 30:
        _ORIGINS_AT[0] = time.time()
        try: ALLOWED_ORIGINS.update(allowed_origins())
        except Exception: pass   # noqa: BLE001 — no address list: localhost only, below
        ALLOWED_ORIGINS.update('http://%s:%d' % (h, p) for h in ('localhost', '127.0.0.1', '[::1]') for p in APP_PORTS)
    return o in ALLOWED_ORIGINS


def sum16(b, seed):
    return (seed + sum(b)) & 0xFFFF


# ------------------------------------------------------------------ links
class LinkError(Exception):
    pass


class LinkLost(LinkError):
    """The connection itself went (closed, reset, unplugged): the link pool reconnects on the next request."""


class LinkBusy(LinkError):
    """Another operation holds the processor (a Send, a Save …): "busy: <operation> is running on <target>"."""


class NoCard(LinkError):
    """A receiving-card read the sending card answered with ack 1 (timeout, DETECT_LCT: AckResults 1): no card answered at
    that place. The expected end of every chain walk (detect, monitoring, identify) and a dead primary port that the
    backup then serves, so the recorder notes it on the reply and doesn't count it as a link error (an H9 tester's report:
    35,000 "errors", nearly all of these). Callers treat it like any LinkError."""
    TEXT = 'no receiving card answered (status 1)'


def _keepalive(s):
    """The OS TCP keep-alive NovaLCT turns on (idle 30 s, then every 5 s, HW_PROTOCOL.md §4.1): a dead peer shows up
    without a single extra frame (LCT sends no heartbeat frame either)."""
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        if hasattr(socket, 'SIO_KEEPALIVE_VALS'): s.ioctl(socket.SIO_KEEPALIVE_VALS, (1, 30000, 5000))
        else:
            for o, v in (('TCP_KEEPIDLE', 30), ('TCP_KEEPALIVE', 30), ('TCP_KEEPINTVL', 5)):
                if hasattr(socket, o): s.setsockopt(socket.IPPROTO_TCP, getattr(socket, o), v)
    except (OSError, ValueError): pass


NO_REPLY_WAIT = 0.3   # s: how long a no-reply write waits for an answer that may come anyway (TcpLink.write)
OWED_WAIT = 1.5       # s after it was sent: how long the next request waits for the late answer to a read that timed out


class TcpLink:
    """One TCP link to a processor. Every frame sent and received, every error, goes to wirelog (the recorder)."""
    def __init__(self, host, port, timeout=3.0):
        import netif   # host "ip%interface" = through that interface only (a processor sharing its IP with one on another network)
        self.tag = '%s:%s' % (host, port); t0 = time.time(); ip, zone = netif.split_host(host)
        try: self.s = netif.connect((ip, port), timeout, zone)
        except OSError as e:
            wirelog.conn(self.tag, 'connect failed', str(e), (time.time() - t0) * 1000, via=zone); raise
        try: self.local = self.s.getsockname()[0]
        except OSError: self.local = ''
        wirelog.conn(self.tag, 'open', ms=(time.time() - t0) * 1000, via='%s %s' % (netif.owner(self.local) or '?', self.local))
        self.s.settimeout(timeout)
        _keepalive(self.s)
        self.serial = 0
        self.buf = b''
        self.last = None   # the request waiting for its reply (for the error record)
        # Reads that timed out but may still be answered: {serial: time sent}. An H9 answers a read past the end of a cabled
        # chain with status 1 only after ~500 ms, and answers in order: a request sent before that answer waits behind it
        # and times out too (tester report 2026-11-20: detect gave up on the end probe after ~60 ms, so the first cabinet of
        # the NEXT port timed out and the port showed 0 cards, 14 the next time). So the next request waits for the owed
        # answer first (_settle). late: None = not known yet, True = this processor does answer late, False = it stays
        # silent (no wait then: a processor whose cards past the end never answer keeps its fast detect).
        self.owed, self.late = {}, None

    lock = None   # the target's lock, when opened through open_link (released on close)
    owed = None   # TCP only (set in __init__): the serial / USB links built on this class don't wait for owed answers
    late = False

    def _owe(self, serial):
        if self.owed is not None: self.owed[serial] = getattr(self, 'sent_at', time.time())

    def _paid(self, serial):
        if self.owed and self.owed.pop(serial, None) is not None: self.late = True

    def close(self, why=None):
        if getattr(self, 'buf', b''): wirelog.stray(self.tag, self.buf, 'left over at close'); self.buf = b''   # nothing received goes unrecorded
        try: self.s.close()
        except OSError: pass
        wirelog.conn(self.tag, 'close' + (' (%s)' % why if why else ''))
        if self.lock: self.lock.release(); self.lock = None

    def _fail(self, text, lost=False):
        wirelog.err(self.tag, text, self.last)
        raise (LinkLost if lost else LinkError)(text)

    def _settle(self):
        """Before a new request: wait (up to OWED_WAIT after each was sent) for the late answers still owed, so the new
        request isn't queued behind them in the processor. They are recorded as stale replies."""
        deadline = max(self.owed.values()) + OWED_WAIT; old = self.s.gettimeout()
        try:
            while self.owed:
                while len(self.buf) >= 2:
                    i = self.buf.find(b'\xAA\x55')
                    if i < 0: break
                    if i > 0: wirelog.stray(self.tag, self.buf[:i]); self.buf = self.buf[i:]
                    if len(self.buf) < 20: break
                    n = struct.unpack_from('<H', self.buf, 16)[0]
                    if len(self.buf) < 20 + n: break
                    r = self.buf[:20 + n]; self.buf = self.buf[20 + n:]
                    wirelog.tg(self.tag, 'rx', r, stale=True)
                    self._paid(r[3])
                if not self.owed: break
                left = deadline - time.time()
                if left <= 0:
                    if self.late is None: self.late = False      # it stays silent: don't wait for it again
                    self.owed.clear(); break
                self.s.settimeout(left)
                try: d = self.s.recv(65536)
                except socket.timeout: continue
                except OSError as e: self._fail('receive failed: %s' % e, True)
                if not d: self._fail('connection closed', True)
                self.buf += d
        finally: self.s.settimeout(old)

    def _send(self, f):
        if self.owed and self.late is not False: self._settle()
        if self.owed: self.owed.clear()
        self.last = f; self.sent_at = time.time()
        wirelog.tg(self.tag, 'tx', f)
        try: self.s.sendall(f)
        except OSError as e: self._fail('send failed: %s' % e, True)

    def raw(self, frame, timeout=None):
        """One request frame from elsewhere (the proxy port), sent with this link's next serial number (sum fixed up);
        -> the whole reply frame, its status left as the processor gave it. None when nothing answers in time."""
        self.serial = (self.serial + 1) & 0xFF
        f = bytearray(frame); f[3] = self.serial; struct.pack_into('<H', f, len(f) - 2, sum16(f[2:-2], 0x5555))
        self._send(bytes(f))
        old = self.s.gettimeout(); self.s.settimeout(timeout or old)
        try: return self._reply(self.serial, full=True)
        except LinkError as e:
            if isinstance(e, LinkLost): raise
            return None
        finally: self.s.settimeout(old)

    def _frame(self, dev, dst, port, card, op, r2, addr, length, data=b''):
        self.serial = (self.serial + 1) & 0xFF
        h = bytes([0x55, 0xAA, 0, self.serial, 0xFE, dst, dev, port]) + struct.pack('<HBBIH', card, op, r2, addr, length) + data
        return h + struct.pack('<H', sum16(h[2:], 0x5555)), self.serial

    def _reply(self, serial, full=False, quiet=False):
        deadline = time.time() + self.s.gettimeout()
        while True:
            i = self.buf.find(b'\xAA\x55')
            if i > 0:
                wirelog.stray(self.tag, self.buf[:i]); self.buf = self.buf[i:]; i = 0      # an H's echo of our request, or junk
            if i >= 0 and len(self.buf) - i >= 20:
                n = struct.unpack_from('<H', self.buf, i + 16)[0]
                if len(self.buf) - i >= 20 + n:
                    r = self.buf[i:i + 20 + n]; self.buf = self.buf[i + 20 + n:]
                    if r[3] != serial:                                                       # stale reply
                        wirelog.tg(self.tag, 'rx', r, stale=True)
                        self._paid(r[3])
                        continue
                    wirelog.tg(self.tag, 'rx', r)
                    if struct.unpack_from('<H', r, len(r) - 2)[0] != sum16(r[2:-2], 0x5555): self._fail('bad reply checksum')
                    if full: return r
                    if r[2] == 1 and self.last and len(self.last) > 6 and self.last[6] == 1: raise NoCard(NoCard.TEXT)   # noted on the reply (wirelog.tg)
                    if r[2] != 0: self._fail('processor answered status %d' % r[2])
                    return r[18:18 + n]
            if time.time() > deadline:
                if quiet: raise LinkError('no reply (timeout)')
                self._owe(serial); self._fail('no reply (timeout)')
            try: d = self.s.recv(65536)
            except socket.timeout:
                if quiet: raise LinkError('no reply (timeout)')
                self._owe(serial); self._fail('no reply (timeout)')
            except OSError as e: self._fail('receive failed: %s' % e, True)
            if not d: self._fail('connection closed', True)
            self.buf += d

    def write(self, dev, dst, port, card, addr, data, r2=0, no_reply=False):
        f, ser = self._frame(dev, dst, port, card, 1, r2, addr, len(data), data)
        self._send(f)
        if not no_reply: self._reply(ser); return
        # "No reply expected" (0x01000000 SortCommand to every card) — but a VX4S-N over USB answers it anyway, ~51 ms later,
        # and loses the next frame if that goes out first (tester report 2026-11-20: both Sends stopped on their first
        # port-flag write, sent 50 ms after the SortCommand; NovaLCT's own writes there answered at once). So wait for that
        # answer, up to NO_REPLY_WAIT, at least the 50 ms of before; none coming is not an error and isn't recorded as one.
        t = time.time(); old = self.s.gettimeout(); self.s.settimeout(NO_REPLY_WAIT)
        try: self._reply(ser, full=True, quiet=True)
        except LinkLost: raise
        except LinkError:
            if getattr(self.s, 'dirty', False): self.s.dirty = False   # USB: nothing pending, no clear-halt needed
        finally: self.s.settimeout(old)
        left = 0.05 - (time.time() - t)
        if left > 0: time.sleep(left)

    def read(self, dev, dst, port, card, addr, length, r2=0, timeout=None):
        f, ser = self._frame(dev, dst, port, card, 0, r2, addr, length)
        self._send(f)
        if timeout is None: return self._reply(ser)
        old = self.s.gettimeout(); self.s.settimeout(timeout)
        try: return self._reply(ser)
        finally: self.s.settimeout(old)


# ------------------------------------------------------------------ USB / serial COM links (docs\USB_SERIAL.md)
# A controller's USB-B port that shows up as a virtual COM port (CP210x / FTDI / CDC) carries the very same TG frames as
# TCP, no wrapper: 115200 8N1, no flow control, DTR / RTS off, then LCT's "1 Mbps" = 1,048,576 if nobody answered
# (as NovaLCT opens a controller's COM port).
# Target strings: "serial:COM3", "serial:/dev/cu.usbserial-0001", "serial:COM3@1048576" (other speed).
SERIAL_BAUDS = (115200, 1048576)
# One connection per target ("host:port", "serial:<port>", "usb:…@<location>"): a VX1000 takes only one TCP connection and
# drops the others (live, 2026-10-11: detect + health + read-layout at once -> "connection closed" / timeouts), and a COM
# port opens only once. open_link shares that one connection between requests (the link pool, below); the target's lock
# here is held by whoever has the port open (the pool, or a probe), so nothing opens it twice.
LINK_WAIT = 20.0
_LOCKS, _LOCK_GUARD = {}, threading.Lock()


def _target_lock(key):
    with _LOCK_GUARD: return _LOCKS.setdefault(key, threading.Lock())


def _take(key, wait):
    lock = _target_lock(key)
    if not lock.acquire(timeout=wait):
        wirelog.conn(key, 'connect failed', 'processor busy (another request kept it %g s)' % wait)
        raise LinkError('processor busy: another request is using %s (waited %g s)' % (key, wait))
    return lock


def serial_target(host):
    """'serial:COM3@1048576' -> ('COM3', 1048576); not a serial target -> None"""
    if not str(host).startswith('serial:'): return None
    name, _, b = str(host)[7:].rpartition('@')
    return (name, int(b)) if name and b.isdigit() else (str(host)[7:], SERIAL_BAUDS[0])


class _SerialBase:
    """Just enough of a socket for TcpLink's framing: sendall / recv (socket.timeout when nothing arrives) / timeouts."""
    def gettimeout(self): return self.timeout
    def settimeout(self, t): self.timeout = t

    def recv(self, n):
        end = time.time() + self.timeout
        while True:
            d = self._read(n, min(0.05, max(0.0, end - time.time())))
            if d is None: return b''                      # the port went away (unplugged)
            if d: return d
            if time.time() >= end: raise socket.timeout('timed out')


class _WinSerial(_SerialBase):
    """A COM port through kernel32 (ctypes): 8N1, no flow control, DTR / RTS off (.NET SerialPort's defaults, so LCT's)."""
    def __init__(self, name, baud, timeout):
        import ctypes
        from ctypes import wintypes as W
        class DCB(ctypes.Structure):
            _fields_ = [('DCBlength', W.DWORD), ('BaudRate', W.DWORD), ('flags', W.DWORD), ('wReserved', W.WORD), ('XonLim', W.WORD),
                        ('XoffLim', W.WORD), ('ByteSize', W.BYTE), ('Parity', W.BYTE), ('StopBits', W.BYTE), ('XonChar', ctypes.c_char),
                        ('XoffChar', ctypes.c_char), ('ErrorChar', ctypes.c_char), ('EofChar', ctypes.c_char), ('EvtChar', ctypes.c_char), ('wReserved1', W.WORD)]
        k = ctypes.WinDLL('kernel32', use_last_error=True); H, P = W.HANDLE, ctypes.c_void_p
        for f, a in (('CreateFileW', [W.LPCWSTR, W.DWORD, W.DWORD, P, W.DWORD, W.DWORD, H]), ('GetCommState', [H, P]), ('SetCommState', [H, P]),
                     ('SetCommTimeouts', [H, P]), ('SetupComm', [H, W.DWORD, W.DWORD]), ('PurgeComm', [H, W.DWORD]),
                     ('ReadFile', [H, P, W.DWORD, P, P]), ('WriteFile', [H, P, W.DWORD, P, P]), ('CloseHandle', [H])):
            getattr(k, f).argtypes = a; getattr(k, f).restype = W.BOOL
        k.CreateFileW.restype = H
        self.k, self.ct, self.W, self.timeout = k, ctypes, W, timeout
        h = k.CreateFileW('\\\\.\\' + name, 0xC0000000, 0, None, 3, 0, None)   # GENERIC_READ | WRITE, not shared, OPEN_EXISTING
        if h in (None, P(-1).value): self._err('open %s' % name)
        self.h = h
        try:
            dcb = DCB(); dcb.DCBlength = ctypes.sizeof(DCB)
            if not k.GetCommState(h, ctypes.byref(dcb)): self._err('GetCommState')
            dcb.BaudRate, dcb.flags, dcb.ByteSize, dcb.Parity, dcb.StopBits = baud, 1, 8, 0, 0   # fBinary only: DTR / RTS disabled
            if not k.SetCommState(h, ctypes.byref(dcb)): self._err('%d baud' % baud)
            # ReadFile returns as soon as a byte is there, else after 50 ms; writes give up after 1 s (LCT's write timeout)
            to = (W.DWORD * 5)(0xFFFFFFFF, 0xFFFFFFFF, 50, 0, 1000)
            if not k.SetCommTimeouts(h, ctypes.byref(to)): self._err('SetCommTimeouts')
            k.SetupComm(h, 65536, 65536); k.PurgeComm(h, 0x0C)   # drop anything stale in both directions
        except OSError: self.close(); raise

    def _err(self, what):
        raise OSError(self.ct.get_last_error(), '%s: %s' % (what, self.ct.FormatError(self.ct.get_last_error()).strip()))

    def _read(self, n, wait):   # the 50 ms read timeout is the wait
        buf, got = self.ct.create_string_buffer(n), self.W.DWORD()
        if not self.k.ReadFile(self.h, buf, n, self.ct.byref(got), None): self._err('read')
        return buf.raw[:got.value]

    def sendall(self, b):
        got = self.W.DWORD()
        if not self.k.WriteFile(self.h, b, len(b), self.ct.byref(got), None): self._err('write')
        if got.value != len(b): raise OSError('write timed out (%d of %d bytes)' % (got.value, len(b)))

    def close(self):
        if getattr(self, 'h', None) is not None: self.k.CloseHandle(self.h); self.h = None


class _PosixSerial(_SerialBase):
    """A tty on macOS / Linux (termios): raw 8N1, no flow control, DTR / RTS dropped, exclusive. macOS takes any speed;
    Linux only the standard ones (no 1,048,576)."""
    def __init__(self, path, baud, timeout):
        import termios, fcntl
        self.timeout = timeout
        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        try:
            if hasattr(termios, 'TIOCEXCL'): fcntl.ioctl(self.fd, termios.TIOCEXCL)
            a = termios.tcgetattr(self.fd)
            sp = getattr(termios, 'B%d' % baud, baud if sys.platform == 'darwin' else None)
            if sp is None: raise OSError('%d baud isn’t available on this system' % baud)
            a[0], a[1], a[3] = termios.IGNPAR, 0, 0                         # raw: no input / output / line processing
            a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL             # 8N1, no RTS/CTS, no hang-up on close
            a[4] = a[5] = sp; a[6][termios.VMIN] = 0; a[6][termios.VTIME] = 0
            termios.tcsetattr(self.fd, termios.TCSANOW, a); termios.tcflush(self.fd, termios.TCIOFLUSH)
            try: fcntl.ioctl(self.fd, getattr(termios, 'TIOCMBIC', 0x8004746B if sys.platform == 'darwin' else 0x5417), struct.pack('I', 6))   # DTR | RTS off
            except OSError: pass                                            # (a pty has no modem lines)
        except Exception: os.close(self.fd); raise

    def _read(self, n, wait):
        import select
        if not select.select([self.fd], [], [], wait)[0]: return b''
        try: return os.read(self.fd, n) or None
        except BlockingIOError: return b''

    def sendall(self, b):
        import select
        end = time.time() + 1.0
        while b:
            if not select.select([], [self.fd], [], max(0.0, end - time.time()))[1]: raise OSError('write timed out')
            try: b = b[os.write(self.fd, b):]
            except BlockingIOError: pass

    def close(self):
        if getattr(self, 'fd', None) is not None: os.close(self.fd); self.fd = None


class SerialLink(TcpLink):
    """One link over a USB / serial COM port: TcpLink's framing and recorder hooks on a serial port instead of a socket.
    The port is held from open to close (its target lock; locked = the caller holds it already). port_obj: a test stand-in."""
    def __init__(self, name, baud=SERIAL_BAUDS[0], timeout=3.0, wait=LINK_WAIT, locked=False, port_obj=None):
        self.tag = 'serial:%s' % name; t0 = time.time()
        self.lock = None if locked else _take(self.tag, wait)
        try: self.s = port_obj or (_WinSerial if sys.platform == 'win32' else _PosixSerial)(name, baud, timeout)
        except Exception as e:
            if self.lock: self.lock.release(); self.lock = None
            wirelog.conn(self.tag, 'connect failed', str(e), (time.time() - t0) * 1000); raise
        wirelog.conn(self.tag, 'open %d 8N1' % baud, ms=(time.time() - t0) * 1000)
        self.serial = 0
        self.buf = b''
        self.last = None


# ------------------------------------------------------------------ the link pool: one persistent connection per target
# Opening and closing a connection per request costs a handshake each time, and on a single-connection device (VX1000;
# likely VX400 / VX600, MCTRL, Pro UHD) a close followed at once by the next open can collide. So the helper keeps ONE
# connection per target, opened on first use and shared by every request (open_link returns a handle on it):
#  - frame level: each request -> reply exchange is atomic on the shared link (serial numbers stay unique per link);
#    different targets run fully in parallel;
#  - operation level: a Send / Save plan, gamma, an .rcfgx / NCP send, a calibration write takes the link exclusively
#    (open_link(..., exclusive='a send')). Requests that were already running pause between frames until it ends (their
#    frames never land between its frames); new ones wait BUSY_WAIT s, then get "busy: a send is running on <target>".
#  - NovaLCT keeps its link open too, with the OS TCP keep-alive on and no heartbeat frame (HW_PROTOCOL.md §4.1): the
#    same here (_keepalive), but a link nobody used for LINK_IDLE s is closed, so NovaLCT can have the processor then.
#  - a connection the processor dropped is noticed before the next frame (a peek, no traffic) and opened again; a read
#    that finds it gone mid-exchange is asked once more on the new one. A target that can't be reached is tried again
#    after BACKOFF s (0.5 … 8), never sooner than RECONNECT_GAP s after a close. Every open / close / reconnect / busy
#    refusal goes to the recorder.
# OPENNOVA_LINK_IDLE=0 closes a connection as soon as no request holds it (the old one-per-request behaviour, shared).
LINK_IDLE = float(os.environ.get('OPENNOVA_LINK_IDLE', 60))
BUSY_WAIT = 3.0          # a new request waits this long for an exclusive operation, then "busy"
EXCL_PAUSE = 900.0       # a request already running waits at most this long for one
RECONNECT_GAP = 0.3
BACKOFF = (0.5, 1, 2, 4, 8)
_POOL, _POOL_GUARD, _SEQ, _REAPER = {}, threading.Lock(), itertools.count(1), []


def _alive(raw):
    """Is a TCP link's connection still there? A non-blocking peek: no traffic, waiting bytes stay put. Other links: yes."""
    s = getattr(raw, 's', None)
    if not isinstance(s, socket.socket): return True
    old = s.gettimeout()
    try:
        s.settimeout(0.0)
        return s.recv(1, socket.MSG_PEEK) != b''
    except (BlockingIOError, InterruptedError): return True
    except OSError: return False
    finally:
        try: s.settimeout(old)
        except OSError: pass


class _Shared:
    """One target's connection in the pool (see above). raw = the TcpLink / SerialLink / UsbLink, or None while closed."""
    def __init__(self, key):
        self.key, self.raw, self.lock, self.params = key, None, None, None
        self.io, self.cv = threading.Lock(), threading.Condition()
        self.users, self.owner, self.op, self.since = 0, None, '', 0
        self.used = self.closed = self.next_try = 0.0
        self.fails, self.opens, self.err, self.why = 0, 0, '', ''

    def _connect(self, h):
        now = time.time()
        if now < self.next_try:
            if self.next_try - now > BUSY_WAIT:
                raise LinkError('%s did not answer (%s); next try in %.0f s' % (self.key, self.err, self.next_try - now))
            time.sleep(self.next_try - now)
        gap = self.closed + RECONNECT_GAP - time.time()
        if gap > 0: time.sleep(gap)
        w = usb_yielded(self.key)                         # NovaLCT has the device (tools/usbauto.py): not opened
        if w:
            wirelog.conn(self.key, 'refused: %s' % w)
            raise LinkBusy(w)
        lock = _target_lock(self.key)                     # a probe may hold the port for a moment
        if not lock.acquire(timeout=min(h.wait, LINK_WAIT)):
            raise LinkBusy('busy: %s is in use (a probe?)' % self.key)
        if self.opens: wirelog.conn(self.key, 'reconnect after: %s' % (self.why or 'close'))
        try: raw = h.opener()
        except BaseException as e:
            lock.release(); self.fails += 1; self.err = str(e)
            self.next_try = time.time() + BACKOFF[min(self.fails, len(BACKOFF)) - 1]
            raise
        self.raw, self.lock, self.params, self.fails, self.next_try, self.used = raw, lock, h.params, 0, 0.0, time.time()
        self.opens += 1

    def _drop(self, why):
        raw, self.raw = self.raw, None
        if raw is None: return
        self.why = why
        try: raw.close(why)
        except Exception: pass
        self.closed = time.time()
        if self.lock: self.lock.release(); self.lock = None

    def _ready(self, h):
        """Connected (again, when the processor closed it meanwhile). True = opened just now."""
        if self.raw is not None and self.params != h.params:
            with self.cv: alone = self.users == 1 and self.owner in (None, h)
            if alone: self._drop('opened again with %s' % (h.params,))
        if self.raw is not None and not _alive(self.raw): self._drop('closed by the processor')
        if self.raw is not None: return False
        self._connect(h); return True

    def ready(self, h):
        with self.io: self._ready(h)

    def gate(self, h):
        """Wait while another request holds the link exclusively: one that ran before it pauses until it ends, a new one
        waits BUSY_WAIT s (its own wait, if shorter), then LinkBusy. A refused request stays refused: detect / health
        take a failed read for "no card there", so its next frames fail at once and its close() raises the refusal."""
        if h.refused: raise LinkBusy(h.refused)
        with self.cv:
            if self.owner is None or self.owner is h: return
            t0 = time.time()
            while self.owner is not None and self.owner is not h:
                left = t0 + (EXCL_PAUSE if h.born < self.since else min(h.wait, BUSY_WAIT)) - time.time()
                if left <= 0:
                    wirelog.conn(self.key, 'refused: %s is running' % self.op)
                    h.refused = 'busy: %s is running on %s' % (self.op, self.key)
                    raise LinkBusy(h.refused)
                self.cv.wait(min(left, 1.0))

    def run(self, h, fn, retry=False):
        """fn(raw) = one request -> reply exchange, atomic on the shared connection. retry: once more on a new connection
        when the old one turns out gone (reads only: a write may have arrived)."""
        self.gate(h)
        with self.io:
            for again in (False, True):
                fresh = self._ready(h); raw = self.raw
                old = raw.s.gettimeout(); raw.s.settimeout(h.timeout)
                try: return fn(raw)
                except LinkLost as e:
                    self._drop('lost: %s' % e)
                    if fresh or again or not retry: raise
                finally:
                    self.used = time.time()
                    if self.raw is raw:
                        try: raw.s.settimeout(old)
                        except OSError: pass

    def take(self, h, name, wait):
        with self.cv:
            end = time.time() + wait
            while self.owner is not None and self.owner is not h:
                if end - time.time() <= 0:
                    wirelog.conn(self.key, 'refused: %s is running' % self.op)
                    raise LinkBusy('busy: %s is running on %s' % (self.op, self.key))
                self.cv.wait(min(end - time.time(), 1.0))
            first = self.owner is None
            self.owner, self.op, self.since = h, name, next(_SEQ)
        if first: wirelog.conn(self.key, 'exclusive: %s' % name)

    def give(self, h):
        with self.cv:
            if self.owner is not h: return
            self.owner, self.op = None, ''; self.cv.notify_all()
        wirelog.conn(self.key, 'exclusive end')

    def release(self, h):
        self.give(h)
        with self.cv: self.users -= 1
        if LINK_IDLE <= 0: close_links(0, self.key, 'released')


class PooledLink:
    """What open_link returns: one request's hold on its target's shared connection, with TcpLink's read / write.
    close() lets go of it (and of an exclusive hold); the connection stays open for the next request (LINK_IDLE).
    When an exclusive operation refused the request, close() raises that LinkBusy (after letting go), so a route that
    shrugged off the failed reads still answers "busy" instead of a half-read result."""
    lock = None

    def __init__(self, sh, opener, params, timeout, wait):
        self.sh, self.tag, self.opener, self.params, self.timeout, self.wait = sh, sh.key, opener, params, timeout, wait
        self.born, self.op, self.done, self.refused = next(_SEQ), None, False, ''
        with sh.cv: sh.users += 1

    def ready(self): self.sh.ready(self)

    def read(self, dev, dst, port, card, addr, length, r2=0, timeout=None):
        return self.sh.run(self, lambda L: L.read(dev, dst, port, card, addr, length, r2, timeout), True)

    def write(self, dev, dst, port, card, addr, data, r2=0, no_reply=False):
        return self.sh.run(self, lambda L: L.write(dev, dst, port, card, addr, data, r2, no_reply))

    def raw(self, frame, timeout=None):
        return self.sh.run(self, lambda L: L.raw(frame, timeout))

    def exclusive(self, name, wait=None):
        """Take the link for one operation (a Send, a Save …): nobody else's frames until shared() / close()."""
        self.sh.take(self, name, self.wait if wait is None else wait); self.op = name
        return self

    def shared(self): self.sh.give(self); self.op = None

    def close(self):
        if not self.done: self.done = True; self.sh.release(self)
        if self.refused: raise LinkBusy(self.refused)

    def __enter__(self): return self

    def __exit__(self, *a): self.close()


def _pool_get(key):
    with _POOL_GUARD:
        sh = _POOL.get(key)
        if sh is None:
            sh = _POOL[key] = _Shared(key)
            if not _REAPER and LINK_IDLE > 0:
                def reap():
                    while True:
                        time.sleep(max(1.0, min(5.0, LINK_IDLE / 4)))
                        close_links(LINK_IDLE, why='unused %g s' % LINK_IDLE)
                _REAPER.append(threading.Thread(target=reap, daemon=True)); _REAPER[0].start()
        return sh


def close_links(idle=0.0, key=None, why='closed'):
    """Close the pooled connections no request holds that were unused for idle s (the reaper: LINK_IDLE; tests and
    /api/hw/links: 0 = now). -> the targets closed."""
    out = []
    for sh in list(_POOL.values()):
        if (key is not None and sh.key != key) or sh.raw is None or sh.users or sh.owner is not None: continue
        if time.time() - sh.used < idle or not sh.io.acquire(blocking=False): continue
        try:
            if sh.raw is not None and not sh.users and sh.owner is None: sh._drop(why); out.append(sh.key)
        finally: sh.io.release()
    return out


# NovaLCT's turn (tools/usbauto.py): while NovaLCT has a USB / COM controller, Open Nova doesn't open it again (its own
# requests are refused with this text, its searches answer from the last probe) and closes its idle connection to it.
YIELD = {}   # target ("usb:0483:5720@…" / "serial:COM3") -> why


def usb_yield(host, why):
    """why = Open Nova lets go of host (closed now when unused, never opened until usb_yield(host, None)); None = may use it again."""
    t = serial_target(host)
    key = 'serial:%s' % t[0] if t else str(host)
    if why: YIELD[key] = why; close_links(0, key, why); wirelog.conn(key, 'yielded: %s' % why)
    elif YIELD.pop(key, None) is not None: wirelog.conn(key, 'taken back')


def usb_yielded(key):
    """The reason Open Nova leaves key alone now ('' = none). Asked again by usbauto every look: an in-flight request's
    connection is closed once it ends."""
    if not YIELD: return ''
    t = serial_target(key)
    k = 'serial:%s' % t[0] if t else str(key)
    w = YIELD.get(k, '')
    if w: close_links(0, k, w)
    return w


def links_status():
    """The pool for /api/hw/links: per target open or not, requests holding it, the exclusive operation, reconnects."""
    now = time.time()
    return [{'target': s.key, 'open': s.raw is not None, 'users': s.users, 'exclusive': s.op or None, 'opens': s.opens,
             'idle': round(now - s.used, 1) if s.used else None, 'lastClose': s.why or None, 'error': s.err or None}
            for s in list(_POOL.values())]


def _target(host, port, timeout):
    """open_link's target -> (pool key, opener of a new connection, its parameters)"""
    t = serial_target(host)
    if t: return 'serial:%s' % t[0], (lambda: SerialLink(t[0], t[1], timeout, locked=True)), (t[1],)
    loc = usb_target(host)
    if loc is not None:
        if not loc:                                      # "usb:" = the first NovaStar USB device
            ds = usb_list()
            if not ds: raise LinkError('no NovaStar USB device (0483:5720) on this computer')
            loc = ds[0]['location']
        return 'usb:%04x:%04x@%s' % (NOVA_VID, NOVA_PID, loc), (lambda: UsbLink(loc, timeout, locked=True)), ()
    return '%s:%s' % (host, int(port)), (lambda: TcpLink(host, int(port), timeout)), ()


def open_link(host, port=None, timeout=3.0, wait=LINK_WAIT, exclusive=None):
    """The link for a helper request: "serial:<port>[@baud]" = a USB / serial COM port, "usb:0483:5720@<bus-ports>" =
    NovaStar's own USB device, port "5201+5202" = an H over several links (MultiLink), anything else = TCP host:port.
    A handle on the target's one shared connection (the link pool), connected when it returns; close() releases it.
    exclusive = the operation's name ("a send"): no other request's frames reach the processor until close()."""
    if isinstance(port, str) and ('+' in port or '*' in port): link = MultiLink(host, port, timeout, wait)
    else:
        key, opener, params = _target(host, port, timeout)
        link = PooledLink(_pool_get(key), opener, params, timeout, wait)
    try:
        if exclusive: link.exclusive(exclusive)
        link.ready()
    except BaseException: link.close(); raise
    return link


# ------------------------------------------------------------------ proxy port (off unless asked: /api/hw/proxy)
PROXIES = {}   # listen port -> {listen, target, clients, frames}


def proxy_start(host, port, listen=0, timeout=1.0):
    """A local TCP port (127.0.0.1 only) that answers TG frames as the processor does, carried over the pool's one
    connection, so another tool can talk to a single-connection processor while Open Nova holds it. Each request frame
    (its sum checked) goes out with the shared link's next serial number; the reply goes back with the client's own
    serial (sum fixed up); a request nothing answers gets no reply, as on the wire. A client's frames pause while an
    Open Nova Send / Save holds the link. Unverified with NovaLCT itself: LCT finds processors by UDP 3800 and connects
    to port 5200 (HW_PROTOCOL.md §4.1), so it can't simply be pointed at this port. -> the port listened on."""
    if isinstance(port, str) and ('+' in port or '*' in port): raise LinkError('one link per proxy port (not %s)' % port)
    srv = socket.socket(); srv.bind(('127.0.0.1', int(listen or 0))); srv.listen(4)
    lp = srv.getsockname()[1]
    info = PROXIES[lp] = {'listen': lp, 'target': '%s:%s' % (host, port), 'clients': 0, 'frames': 0, 'sock': srv}

    def client(c, peer):
        tag = 'proxy %d <- %s:%d' % (lp, peer[0], peer[1])
        try: link = open_link(host, port, timeout=timeout)
        except Exception as e: wirelog.conn(tag, 'connect failed', str(e)); c.close(); return
        wirelog.conn(tag, 'open'); info['clients'] += 1; buf = b''
        try:
            while True:
                try: d = c.recv(65536)
                except OSError: break
                if not d: break
                buf += d
                while True:
                    i = buf.find(b'\x55\xAA')
                    if i < 0: buf = buf[-1:]; break
                    buf = buf[i:]
                    if len(buf) < 20: break
                    n = 20 + (struct.unpack_from('<H', buf, 16)[0] if buf[10] == 1 else 0)
                    if len(buf) < n: break
                    f, buf = buf[:n], buf[n:]
                    if struct.unpack_from('<H', f, n - 2)[0] != sum16(f[2:-2], 0x5555):
                        wirelog.record('junk', link=tag, hex=f.hex(), n=len(f), note='bad sum: not forwarded'); continue
                    try: r = link.raw(f, timeout)
                    except LinkError: r = None
                    info['frames'] += 1
                    if r is None: continue
                    r = bytearray(r); r[3] = f[3]; struct.pack_into('<H', r, len(r) - 2, sum16(r[2:-2], 0x5555))
                    try: c.sendall(bytes(r))
                    except OSError: break
        finally:
            try: link.close()
            except LinkBusy: pass
            c.close(); info['clients'] -= 1; wirelog.conn(tag, 'close')

    def accept():
        while True:
            try: c, peer = srv.accept()
            except OSError: return
            threading.Thread(target=client, args=(c, peer), daemon=True).start()
    threading.Thread(target=accept, daemon=True).start()
    wirelog.conn('proxy %d' % lp, 'listening for %s:%s' % (host, port))
    return lp


def proxy_stop(listen=None):
    """Stop listening (one port, or all); clients already connected finish on their own. -> ports stopped"""
    out = []
    for lp in [int(listen)] if listen else list(PROXIES):
        p = PROXIES.pop(lp, None)
        if p:
            try: p['sock'].close()
            except OSError: pass
            wirelog.conn('proxy %d' % lp, 'stopped'); out.append(lp)
    return out


class MultiLink:
    """One processor reached over several TCP links: an H chassis lists one TG port per output slot (H_SUB_CARD 5201…; live
    2026-10-11: 4 links on the H2 and H5, one sending card behind each populated one, empty slots don't answer). The app
    keeps such an H as ONE processor whose sending cards are numbered across the links in port order; the port it sends is
    a spec: "5201+5202" (one sending card behind each link) or "5201*2+5203" (two cascaded behind 5201). A frame to sending
    card n goes to the link holding it, renumbered to its place there; dst 255 (every sending card) goes to every link.
    [I] whether NovaLCT addresses a 2-card H this way (and what DevID its layout records carry) needs a live check."""
    def __init__(self, host, spec, timeout=3.0, wait=LINK_WAIT):
        self.parts, self.links, self.tag = [], [], '%s:%s' % (host, spec)
        for tok in str(spec).split('+'):
            p, _, n = tok.partition('*'); self.parts.append((int(p), max(1, int(n or 1))))
        try:
            for p, _ in self.parts: self.links.append(open_link(host, p, timeout, wait))
        except BaseException: self.close(); raise

    def _route(self, dst):
        if dst == 0xFF: return None
        k = dst
        for link, (_, n) in zip(self.links, self.parts):
            if k < n: return link, k
            k -= n
        raise LinkError('no sending card %d on %s' % (dst, self.tag))

    def write(self, dev, dst, port, card, addr, data, r2=0, no_reply=False):
        r = self._route(dst)
        if r: return r[0].write(dev, r[1], port, card, addr, data, r2, no_reply)
        for link in self.links: link.write(dev, dst, port, card, addr, data, r2, no_reply)

    def read(self, dev, dst, port, card, addr, length, r2=0, timeout=None):
        r = self._route(dst) or (self.links[0], dst)
        return r[0].read(dev, r[1], port, card, addr, length, r2, timeout)

    def ready(self): pass   # each part connected when it was opened

    def exclusive(self, name, wait=None):
        """Every link of the chassis, in port order (see PooledLink.exclusive)."""
        try:
            for link in self.links: link.exclusive(name, wait)
        except BaseException:
            for link in self.links: link.shared()
            raise
        return self

    def shared(self):
        for link in self.links: link.shared()

    def close(self):
        busy = None
        for link in self.links:
            try: link.close()
            except LinkBusy as e: busy = busy or e   # every part let go first (PooledLink.close)
        self.links = []
        if busy: raise busy


def serial_ports():
    """This computer's serial ports, listed only (nothing is opened). Windows: HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM (the
    driver says the chip: Silabser = CP210x, VCP = FTDI, USBSER = USB CDC); macOS: /dev/cu.* (Bluetooth and debug
    consoles left out); Linux: /dev/ttyUSB*, /dev/ttyACM*."""
    out = []
    if sys.platform == 'win32':
        import winreg
        try: k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'HARDWARE\DEVICEMAP\SERIALCOMM')
        except OSError: return []
        with k:
            for i in range(256):
                try: dev, name, _ = winreg.EnumValue(k, i)
                except OSError: break
                if 'bth' not in dev.lower(): out.append({'name': str(name), 'label': str(name), 'driver': dev.split('\\')[-1]})
        return sorted(out, key=lambda p: (len(p['name']), p['name']))
    import glob
    for pat in (['/dev/cu.*'] if sys.platform == 'darwin' else ['/dev/ttyUSB*', '/dev/ttyACM*']):
        for p in sorted(glob.glob(pat)):
            if not any(s in p.lower() for s in ('bluetooth', 'debug-console', 'wlan-debug')):
                out.append({'name': p, 'label': os.path.basename(p), 'driver': ''})
    return out


SER_SEEN = {}   # port -> its last probe answer (a port Open Nova is using right now answers from here)


def probe_serial(p, timeout=1.0):
    """Is there a NovaLCT-protocol controller on serial port p? One read of sender 0's ModelID (0x00000002, 2 B: LCT's first
    handshake read, 1 s) at 115200, then at 1,048,576. Read-only: LCT's arrange-address
    write before it (0x01000000 to dst FF) is left out. -> {name, label, answered, modelId, baud, host} or {…, error}"""
    name, lock = p['name'], _target_lock('serial:%s' % p['name'])
    if usb_yielded('serial:%s' % name): return dict(SER_SEEN.get(name) or {'answered': False}, name=name, label=p.get('label', name), busy=True)   # NovaLCT's turn
    if not lock.acquire(blocking=False): return dict(SER_SEEN.get(name) or {'answered': False}, name=name, label=p.get('label', name), busy=True)
    r = {'name': name, 'label': p.get('label', name), 'driver': p.get('driver', ''), 'answered': False}
    try:
        for baud in SERIAL_BAUDS:
            try: link = SerialLink(name, baud, timeout, locked=True)
            except (OSError, LinkError) as e:   # can't open (NovaLCT holding it?) / speed not available
                r.setdefault('error', str(e)); n = getattr(e, 'errno', None)
                # Windows: 5 = access denied (another program has it open); macOS / Linux: EBUSY; Linux EACCES = not in dialout
                if n == 13 and sys.platform.startswith('linux'): r['cause'] = 'perm'
                elif n in (5, 16) or (n == 13 and sys.platform == 'win32'): r['cause'] = 'inuse'
                break
            try:
                b = link.read(0, 0, 0, 0, 0x00000002, 2); m = b[0] | (b[1] << 8)
                if m not in (0, 0xFFFF):
                    r.update(answered=True, modelId=m, baud=baud, host='serial:%s' % name + ('' if baud == SERIAL_BAUDS[0] else '@%d' % baud)); r.pop('error', None); break
            except LinkError as e: r.setdefault('error', str(e))
            finally: link.close()
    finally: lock.release()
    SER_SEEN[name] = r
    return r


def probe_serial_all(ports=None, timeout=1.0):
    """probe_serial on every port at once (a port without a controller costs up to 2 x timeout)."""
    ports = serial_ports() if ports is None else ports
    out = [None] * len(ports)
    def one(i): out[i] = probe_serial(ports[i], timeout)
    ts = [threading.Thread(target=wirelog.bind(one), args=(i,), daemon=True) for i in range(len(ports))]   # the app action goes along
    for t in ts: t.start()
    for t in ts: t.join()
    return out


def nova_usb():
    """Is NovaStar's own USB device here (0483:5720 "Nova ProHD" / "NovaStar MTP", docs\\USB_NOVA_DEVICE.md)? Asked without
    libusb, so the app can say why a plugged-in controller isn't listed when libusb is missing (UsbLink). Read-only. Windows only knows
    whether it was ever plugged in (its Enum key); macOS / Linux see it now."""
    try:
        if sys.platform == 'win32':
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Enum\USB\VID_0483&PID_5720'): return True
        if sys.platform == 'darwin':
            import subprocess
            o = subprocess.run(['ioreg', '-p', 'IOUSB', '-l', '-w0'], capture_output=True, text=True, timeout=5).stdout
            return any('"idVendor" = 1155' in b and '"idProduct" = 22304' in b for b in o.split('+-o '))
        import glob
        rd = lambda f: open(f).read().strip()
        return any(rd(f) == '0483' and rd(f[:-8] + 'idProduct') == '5720' for f in glob.glob('/sys/bus/usb/devices/*/idVendor'))
    except Exception:
        return False


# ------------------------------------------------------------------ NovaStar's own USB device 0483:5720 (docs\USB_NOVA_DEVICE.md)
# Not a COM port: a vendor-class interface (FF/06/50) with two bulk endpoints that speaks USB mass-storage "bulk-only"
# framing. Each TG frame goes out behind a 31-byte "USBC" command block (CB[0] = A2 "write"), the reply comes back on the
# IN pipe as a plain AA 55 frame; a device that answers with a 13-byte "USBS" status first is asked with an A3 "read" block
# (LCT's "old" flow). This is NovaLCT's shipped USB mode (its "U-disk" mode; see the ComMode note below). Raw USB through ctypes: libusb-1.0 (the Windows / Mac packages carry it in libusb/; Linux: the system's)
# or, on Windows, libusb-win32's libusb0.dll for a device on NovaLCT's driver. Target: "usb:0483:5720@<bus-ports>" (libusb-1.0)
# or "usb:0483:5720@libusb0-<n>" (libusb0.dll).
NOVA_VID, NOVA_PID = 0x0483, 0x5720
USB_MODE = os.environ.get('OPENNOVA_USB_MODE', 'udisk')   # 'com' = LCT's ComMode: no USBC block (not LCT's shipped setting)
USB_IN_SIZE = 0x10200          # one IN transfer: the largest reply (20 + 65535 B) rounded up to whole 512-B packets
USB_IO_MS = 1000               # LCT's per-transfer timeout


def usb_target(host):
    """'usb:0483:5720@20-1.2' -> '20-1.2' (the bus-ports location); 'usb:' or 'usb:0483:5720' -> '' (the first one); else None"""
    if not str(host).startswith('usb:'): return None
    return str(host)[4:].rpartition('@')[2] if '@' in str(host) else ''


def usb_cbw(n, read=False, tag=0):
    """LCT's 31-byte USBC block: tag, data length, flags (80 = IN), LUN 0, CB length 16,
    CB[0] = A3 (read) / A2 (write), CB[7] = 1."""
    return b'USBC' + struct.pack('<IIBBB', tag & 0xFFFFFFFF, n, 0x80 if read else 0, 0, 16) + bytes([0xA3 if read else 0xA2, 0, 0, 0, 0, 0, 0, 1]) + bytes(8)


def _bundled_libusb():
    """The libusb-1.0 the Windows / Mac package carries (<package>/libusb/<system>-<arch>/, put there by make_package.py from
    tools/usb_libs.json): this Python's architecture first (the other one just fails to load)."""
    pkg = os.path.dirname(HERE)
    if sys.platform == 'win32':
        ds, f = (['windows-arm64', 'windows-x64'] if 'ARM64' in sys.version.upper() else ['windows-x64', 'windows-arm64']), 'libusb-1.0.dll'
    elif sys.platform == 'darwin':
        import platform
        ds, f = (['macos-arm64', 'macos-x86_64'] if platform.machine() == 'arm64' else ['macos-x86_64', 'macos-arm64']), 'libusb-1.0.0.dylib'
    else: return []
    return [os.path.join(pkg, 'libusb', d, f) for d in ds]


def _libusb_paths():
    import ctypes.util
    p = [os.environ.get('OPENNOVA_LIBUSB', '')] + _bundled_libusb()
    if sys.platform == 'win32':
        p += [os.path.join(d, 'libusb-1.0.dll') for d in (HERE, os.path.dirname(HERE))] + [ctypes.util.find_library('libusb-1.0') or '']
        # NovaStar ships libusb 1.0.26 (x64) with VMP / LCT's MonitorManager: a last resort
        p += [os.path.join(os.environ.get('ProgramFiles(x86)', ''), 'Nova Star', 'Coex VMP', 'Bin', 'xcenter', 'libusb-1.0.dll'),
              os.path.join(os.environ.get('APPDATA', ''), 'Nova Star', 'NovaLCT', 'Bin', 'MonitorManager', 'xcenter', 'libusb-1.0.dll')]
    elif sys.platform == 'darwin':
        p += [d + n for d in ('/opt/homebrew/lib/', '/usr/local/lib/', '/opt/local/lib/') for n in ('libusb-1.0.0.dylib', 'libusb-1.0.dylib')]
    else: p += ['libusb-1.0.so.0', 'libusb-1.0.so']
    return [x for x in p + [ctypes.util.find_library('usb-1.0') or ''] if x]


def _libusb0_paths():
    """Windows: libusb-win32's libusb0.dll. NovaLCT's USB driver (Nova_ProHD.inf, libusb0.sys 1.2.6.0) copies it into System32
    (SysWOW64 for 32-bit) when the device is first installed, so the plain name finds it wherever that driver is bound."""
    return [x for x in (os.environ.get('OPENNOVA_LIBUSB0', ''), 'libusb0.dll') if x]


# What's wrong with NovaStar USB and the one thing to do, in plain words (docs\USB_NOVA_DEVICE.md §4 "Messages"). We never
# install a driver ourselves (that needs admin rights): on Windows NovaLCT's installer brings the right one.
USB_FIX = {
    'driver': 'Windows has no USB driver on it that Open Nova can use. Install NovaLCT once (it installs the USB driver), '
              'or set the device to WinUSB with Zadig.',
    'busy': 'Another program is using it. Close NovaLCT / VMP, then Find again.',
    'udev': 'Linux doesn’t let Open Nova open it. Add this line to /etc/udev/rules.d/60-novastar.rules, then unplug it and plug '
            'it in again: SUBSYSTEM=="usb", ATTR{idVendor}=="0483", ATTR{idProduct}=="5720", MODE="0660", TAG+="uaccess"',
    'lib-win': 'Open Nova’s libusb-1.0.dll is missing. Use the Windows package of Open Nova, unzipped whole (it has a libusb folder).',
    'lib-mac': 'Open Nova’s libusb is missing. Use the Mac package of Open Nova (it has a libusb folder), or install it with '
               'Homebrew: brew install libusb',
    'lib-linux': 'It needs libusb. Install it: sudo apt install libusb-1.0-0 (or your distribution’s libusb package).',
}


def nova_usb_drivers():
    """Windows: the driver Windows bound to each 0483:5720 it has seen ('libusb0' = NovaLCT's, 'WinUSB', '' = none), read-only
    from the registry (Enum\\USB\\VID_0483&PID_5720\\<instance>\\Service). Elsewhere: []."""
    if sys.platform != 'win32': return []
    out = []
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Enum\USB\VID_0483&PID_5720') as k:
            for i in range(winreg.QueryInfoKey(k)[0]):
                with winreg.OpenKey(k, winreg.EnumKey(k, i)) as s:
                    try: out.append(str(winreg.QueryValueEx(s, 'Service')[0] or ''))
                    except OSError: out.append('')
    except OSError: pass
    return out


def usb_fix(cause):
    """USB_FIX's text for a cause: 'driver', 'busy', 'udev', or 'lib' (no USB library loads: per system; on Windows by the
    driver Windows bound, since NovaLCT's driver brings its own libusb0.dll and WinUSB needs the package's libusb-1.0.dll)."""
    if cause == 'lib':
        if sys.platform == 'darwin': return USB_FIX['lib-mac']
        if sys.platform != 'win32': return USB_FIX['lib-linux']
        drv = [d.lower() for d in nova_usb_drivers()]
        return USB_FIX['lib-win'] if 'winusb' in drv and 'libusb0' not in drv else USB_FIX['driver']
    return USB_FIX.get(cause, '')


def _usb_error(what, detail, cause=''):
    """OSError for a failed USB step: the plain words first (USB_FIX), the library's own name for it in brackets (for the log)."""
    fix = usb_fix(cause) if cause else ''
    return OSError('%s (USB %s: %s)' % (fix, what, detail) if fix else 'USB %s: %s' % (what, detail))


_USB_NOTES = set()


def _usb_note(event, error=None, **extra):
    """Into the recorder (link usb:0483:5720) once per distinct event: which USB library loaded, or why USB can't be used,
    so a problem report shows the cause."""
    k = (event, error, tuple(sorted(extra.items())))
    if k in _USB_NOTES: return
    _USB_NOTES.add(k)
    wirelog.conn('usb:%04x:%04x' % (NOVA_VID, NOVA_PID), event, error, **extra)


_LIBUSB, _LIBUSB0 = [], []


def libusb():
    """The libusb-1.0 library (loaded once) or LinkError saying what to do."""
    if _LIBUSB: return _LIBUSB[0]
    for p in _libusb_paths():
        try: _LIBUSB.append(_Libusb(p))
        except (OSError, AttributeError): continue           # not there / not libusb-1.0 / wrong architecture
        _usb_note('USB library libusb-1.0', path=p); return _LIBUSB[0]
    raise LinkError('NovaStar USB: ' + usb_fix('lib'))


def libusb0():
    """Windows: libusb0.dll (loaded once) when it is there, else None. Elsewhere None."""
    if not _LIBUSB0:
        lib = None
        for p in (_libusb0_paths() if sys.platform == 'win32' else []):
            try: lib = _Libusb0(p)
            except (OSError, AttributeError): continue
            _usb_note('USB library libusb0', path=p, version=lib.version); break
        _LIBUSB0.append(lib)
    return _LIBUSB0[0]


def usb_libs():
    """The USB libraries to ask, in order: Windows: libusb0.dll first when it is there (the device is then on NovaLCT's
    libusb0.sys), then libusb-1.0 (WinUSB; macOS / Linux: the only one). LinkError (what to do) when none loads."""
    libs = [x for x in [libusb0()] if x]
    try: libs.append(libusb())
    except LinkError:
        if not libs: raise
    return libs


def usb_list():
    """Every 0483:5720 (descriptors only, nothing opened) from the first library that lists one. On Windows a device on
    NovaLCT's driver is listed by libusb0 and (unusable) by libusb-1.0 too, so libusb-1.0 is asked only when libusb0 has none."""
    err = None
    for lib in usb_libs():
        try: ds = lib.devices()
        except OSError as e: err = err or e; continue
        if ds: return ds
    if err: raise err
    return []


def usb_open(location):
    """The device at location ('' = the first one) opened through the library that lists it: 'libusb0-…' = libusb0.dll."""
    if not location:
        ds = usb_list()
        if not ds: raise LinkError('no NovaStar USB device (0483:5720) on this computer')
        location = ds[0]['location']
    lib = libusb0() if location.startswith('libusb0-') else libusb()
    if lib is None: raise OSError('no NovaStar USB device (0483:5720) at ' + location)
    return lib.open(location)


def _usb_structs(C, pack=0):
    """The descriptor structs (EP, IF, ALT, CFG, DEV): field for field the same in libusb-1.0 and libusb-win32, which packs
    every struct to 1 byte (lusb0_usb.h #include <pshpack1.h>)."""
    P, I, U8, U16 = C.c_void_p, C.c_int, C.c_uint8, C.c_uint16
    def S(name, fields): return type(name, (C.Structure,), dict({'_pack_': pack, '_layout_': 'ms'} if pack else {}, _fields_=fields))
    EP = S('EP', [('bLength', U8), ('bDescriptorType', U8), ('bEndpointAddress', U8), ('bmAttributes', U8), ('wMaxPacketSize', U16),
                  ('bInterval', U8), ('bRefresh', U8), ('bSynchAddress', U8), ('extra', P), ('extra_length', I)])
    IF = S('IF', [('bLength', U8), ('bDescriptorType', U8), ('bInterfaceNumber', U8), ('bAlternateSetting', U8), ('bNumEndpoints', U8),
                  ('bInterfaceClass', U8), ('bInterfaceSubClass', U8), ('bInterfaceProtocol', U8), ('iInterface', U8),
                  ('endpoint', C.POINTER(EP)), ('extra', P), ('extra_length', I)])
    ALT = S('ALT', [('altsetting', C.POINTER(IF)), ('num_altsetting', I)])
    CFG = S('CFG', [('bLength', U8), ('bDescriptorType', U8), ('wTotalLength', U16), ('bNumInterfaces', U8), ('bConfigurationValue', U8),
                    ('iConfiguration', U8), ('bmAttributes', U8), ('MaxPower', U8), ('interface', C.POINTER(ALT)), ('extra', P), ('extra_length', I)])
    DEV = S('DEV', [('bLength', U8), ('bDescriptorType', U8), ('bcdUSB', U16), ('bDeviceClass', U8), ('bDeviceSubClass', U8),
                    ('bDeviceProtocol', U8), ('bMaxPacketSize0', U8), ('idVendor', U16), ('idProduct', U16), ('bcdDevice', U16),
                    ('iManufacturer', U8), ('iProduct', U8), ('iSerialNumber', U8), ('bNumConfigurations', U8)])
    return EP, IF, ALT, CFG, DEV


def _usb_endpoints(cfg=None):
    """LCT's choice in a configuration descriptor (CFG, or None): the interface FF/06/50; OUT = an endpoint without bit 7, IN =
    with it. Not found -> EP 01 / 81 on interface 0, like LCT."""
    out = {'iface': 0, 'epOut': 0x01, 'epIn': 0x81, 'maxPacket': 0, 'matched': False}
    if cfg is None: return out
    out['config'] = cfg.bConfigurationValue
    for i in range(cfg.bNumInterfaces):
        it = cfg.interface[i]
        for a in range(it.num_altsetting):
            s = it.altsetting[a]
            if (s.bInterfaceClass, s.bInterfaceSubClass, s.bInterfaceProtocol) != (0xFF, 0x06, 0x50): continue
            out.update(iface=s.bInterfaceNumber, matched=True)
            for e in range(s.bNumEndpoints):
                ep = s.endpoint[e]
                out['epIn' if ep.bEndpointAddress & 0x80 else 'epOut'] = ep.bEndpointAddress; out['maxPacket'] = ep.wMaxPacketSize
            return out
    return out


class _Libusb:
    """libusb-1.0 through ctypes: list 0483:5720 devices (descriptors only) and open one (_LibusbDev)."""
    name = 'libusb-1.0'

    def __init__(self, path):
        import ctypes as C
        L = (C.WinDLL if sys.platform == 'win32' else C.CDLL)(path)   # LIBUSB_CALL = WINAPI on Windows
        P, I, U8, PP = C.c_void_p, C.c_int, C.c_uint8, C.POINTER(C.c_void_p)
        EP, IF, ALT, CFG, DEV = _usb_structs(C)
        for f, a, r in (('libusb_init', [PP], I), ('libusb_exit', [P], None), ('libusb_get_device_list', [P, C.POINTER(PP)], C.c_ssize_t),
                        ('libusb_free_device_list', [PP, I], None), ('libusb_get_device_descriptor', [P, C.POINTER(DEV)], I),
                        ('libusb_get_bus_number', [P], U8), ('libusb_get_port_numbers', [P, C.POINTER(U8), I], I),
                        ('libusb_get_config_descriptor', [P, U8, C.POINTER(C.POINTER(CFG))], I), ('libusb_free_config_descriptor', [C.POINTER(CFG)], None),
                        ('libusb_open', [P, PP], I), ('libusb_close', [P], None), ('libusb_get_configuration', [P, C.POINTER(I)], I),
                        ('libusb_set_configuration', [P, I], I), ('libusb_claim_interface', [P, I], I), ('libusb_release_interface', [P, I], I),
                        ('libusb_set_auto_detach_kernel_driver', [P, I], I), ('libusb_clear_halt', [P, C.c_ubyte], I),
                        ('libusb_bulk_transfer', [P, C.c_ubyte, P, I, C.POINTER(I), C.c_uint], I), ('libusb_error_name', [I], C.c_char_p)):
            getattr(L, f).argtypes = a; getattr(L, f).restype = r
        self.L, self.C, self.DEV, self.CFG, self.path = L, C, DEV, CFG, path

    def err(self, what, rc):
        name = (self.L.libusb_error_name(rc) or b'?').decode()
        win = sys.platform == 'win32'   # NOT_SUPPORTED / NOT_FOUND on Windows: no driver, or one libusb-1.0 can't use
        cause = {'LIBUSB_ERROR_ACCESS': 'udev' if sys.platform.startswith('linux') else 'busy', 'LIBUSB_ERROR_BUSY': 'busy',
                 'LIBUSB_ERROR_NOT_SUPPORTED': 'driver' if win else '', 'LIBUSB_ERROR_NOT_FOUND': 'driver' if win else ''}.get(name, '')
        return _usb_error(what, name, cause)

    def _scan(self, location=None):
        """location None: every 0483:5720 device's descriptors (nothing opened; the OS's cached descriptors). A location
        ('' = the first device): that device opened -> _LibusbDev."""
        C, L = self.C, self.L
        ctx, lst, out, keep = C.c_void_p(), C.POINTER(C.c_void_p)(), [], False
        rc = L.libusb_init(C.byref(ctx))
        if rc: raise self.err('init', rc)
        try:
            n = L.libusb_get_device_list(ctx, C.byref(lst))
            if n < 0: raise self.err('device list', n)
            try:
                for i in range(n):
                    d, dd = lst[i], self.DEV()
                    if L.libusb_get_device_descriptor(d, C.byref(dd)) or (dd.idVendor, dd.idProduct) != (NOVA_VID, NOVA_PID): continue
                    pn = (C.c_uint8 * 8)(); k = L.libusb_get_port_numbers(d, pn, 8)
                    info = dict(self._endpoints(d), location='%d-%s' % (L.libusb_get_bus_number(d), '.'.join(str(pn[j]) for j in range(max(k, 0)))),
                                vid=dd.idVendor, pid=dd.idProduct, bcdDevice=dd.bcdDevice, bcdUSB=dd.bcdUSB, lib=self.name)
                    if location is None: out.append(info); continue
                    if location and info['location'] != location: continue
                    h = C.c_void_p(); rc = L.libusb_open(d, C.byref(h))
                    if rc: raise self.err('open %s' % info['location'], rc)
                    dev = _LibusbDev(self, ctx, h, info); keep = True
                    return dev
            finally: L.libusb_free_device_list(lst, 1)
            if location is not None: raise OSError('no NovaStar USB device (0483:5720)%s' % (' at ' + location if location else ''))
            return out
        finally:
            if not keep: L.libusb_exit(ctx)

    def _endpoints(self, d):
        """LCT's endpoint choice in the device's first configuration (_usb_endpoints)."""
        C = self.C
        cfg = C.POINTER(self.CFG)()
        if self.L.libusb_get_config_descriptor(d, 0, C.byref(cfg)): return _usb_endpoints()
        try: return _usb_endpoints(cfg.contents)
        finally: self.L.libusb_free_config_descriptor(cfg)

    def devices(self): return self._scan()

    def open(self, location):
        """The device at location ('' = the first one), configured (only if it isn't already) and its interface claimed."""
        return self._scan(location or '')


class _LibusbDev:
    """One opened 0483:5720 device: bulk_out / bulk_in (socket.timeout when nothing came) / clear_halt / close."""
    def __init__(self, lib, ctx, h, info):
        self.lib, self.L, self.C, self.ctx, self.h, self.info = lib, lib.L, lib.C, ctx, h, info
        self.ep_out, self.ep_in, self.iface = info['epOut'], info['epIn'], info['iface']
        try:
            self.L.libusb_set_auto_detach_kernel_driver(h, 1)          # Linux only; elsewhere "not supported", ignored
            cur = self.C.c_int(0)
            if not self.L.libusb_get_configuration(h, self.C.byref(cur)) and cur.value != info.get('config', 1):
                rc = self.L.libusb_set_configuration(h, info.get('config', 1))   # LCT: configuration 1
                if rc: raise lib.err('set configuration', rc)
            rc = self.L.libusb_claim_interface(h, self.iface)
            if rc: raise lib.err('claim interface %d' % self.iface, rc)
        except BaseException: self.L.libusb_close(h); self.h = None; raise   # (the caller ends the libusb session)

    def _xfer(self, ep, buf, n, ms):
        got = self.C.c_int(0)
        rc = self.L.libusb_bulk_transfer(self.h, ep, buf, n, self.C.byref(got), int(ms))
        return rc, got.value

    def bulk_out(self, b, ms=USB_IO_MS):
        buf = self.C.create_string_buffer(bytes(b), max(len(b), 1))
        rc, got = self._xfer(self.ep_out, buf, len(b), ms)
        if rc == -7: raise socket.timeout('USB write timed out (%d of %d bytes)' % (got, len(b)))
        if rc: raise self.lib.err('write', rc)

    def bulk_in(self, n=USB_IN_SIZE, ms=USB_IO_MS):
        buf = self.C.create_string_buffer(n)
        rc, got = self._xfer(self.ep_in, buf, n, max(1, ms))
        if rc == -7 and not got: raise socket.timeout('timed out')
        if rc and rc != -7: raise self.lib.err('read', rc)
        return buf.raw[:got]

    def clear_halt(self):
        for ep in (self.ep_out, self.ep_in): self.L.libusb_clear_halt(self.h, ep)

    def close(self):
        if self.h is None: return
        try: self.L.libusb_release_interface(self.h, self.iface)
        finally: self.L.libusb_close(self.h); self.L.libusb_exit(self.ctx); self.h = None


LIBUSB0_TIMEOUT = -116          # libusb-win32: -ETRANSFER_TIMEDOUT (error.h)
LIBUSB0_MAX_IO = 0x10000        # libusb-win32 1.2.6 splits bigger transfers at 64 KiB and loses the first part if the next times out


class _Libusb0:
    """Windows: libusb-win32's libusb0.dll (the libusb-0.1 API) through ctypes, for a 0483:5720 on NovaLCT's own driver
    (libusb0.sys). The same face as _Libusb: devices() (descriptors only) and open(location) -> _Libusb0Dev, so the USBC
    framing and the recorder hooks (_NovaUsbPort, UsbLink) are the same. Structs from libusb-win32's lusb0_usb.h: every one
    byte-packed, LIBUSB_PATH_MAX 512, unsigned long = 32 bits; functions cdecl. Location = the device's libusb0 number
    ('libusb0-0001', from its file name \\\\.\\libusb0-0001--0x0483-0x5720)."""
    name = 'libusb0'

    def __init__(self, path):
        import ctypes as C
        L = C.CDLL(path)
        P, I = C.c_void_p, C.c_int
        EP, IF, ALT, CFG, DEV = _usb_structs(C, 1)
        UDEV = type('usb_device', (C.Structure,), {'_pack_': 1, '_layout_': 'ms'})
        UBUS = type('usb_bus', (C.Structure,), {'_pack_': 1, '_layout_': 'ms'})
        UDEV._fields_ = [('next', C.POINTER(UDEV)), ('prev', C.POINTER(UDEV)), ('filename', C.c_char * 512), ('bus', C.POINTER(UBUS)),
                         ('descriptor', DEV), ('config', C.POINTER(CFG)), ('dev', P), ('devnum', C.c_uint8), ('num_children', C.c_uint8),
                         ('children', P)]
        UBUS._fields_ = [('next', C.POINTER(UBUS)), ('prev', C.POINTER(UBUS)), ('dirname', C.c_char * 512), ('devices', C.POINTER(UDEV)),
                         ('location', C.c_uint32), ('root_dev', C.POINTER(UDEV))]
        VER = type('usb_version', (C.Structure,), {'_fields_': [(k, I) for k in ('dll1', 'dll2', 'dll3', 'dll4', 'drv1', 'drv2', 'drv3', 'drv4')]})
        for f, a, r in (('usb_init', [], None), ('usb_find_busses', [], I), ('usb_find_devices', [], I), ('usb_get_busses', [], C.POINTER(UBUS)),
                        ('usb_open', [C.POINTER(UDEV)], P), ('usb_close', [P], I), ('usb_set_configuration', [P, I], I),
                        ('usb_claim_interface', [P, I], I), ('usb_release_interface', [P, I], I), ('usb_clear_halt', [P, C.c_uint], I),
                        ('usb_bulk_write', [P, I, P, I, I], I), ('usb_bulk_read', [P, I, P, I, I], I), ('usb_strerror', [], C.c_char_p),
                        ('usb_get_version', [], C.POINTER(VER))):
            getattr(L, f).argtypes = a; getattr(L, f).restype = r
        self.L, self.C, self.UDEV, self.UBUS, self.lock, self.path = L, C, UDEV, UBUS, threading.Lock(), path
        L.usb_init()
        v = L.usb_get_version()   # driver -1.-1.-1.-1 = libusb0.sys isn't running
        self.version = '%d.%d.%d.%d, driver %d.%d.%d.%d' % tuple(getattr(v.contents, k) for k, _ in VER._fields_) if v else '?'

    def err(self, what, rc):
        s = (self.L.usb_strerror() or b'').decode('latin-1', 'replace').strip()
        return _usb_error(what, 'libusb0 %d%s' % (rc, ', ' + s if s else ''), {-13: 'busy', -16: 'busy'}.get(rc, ''))

    def _walk(self):
        """(usb_device pointer, info) for each 0483:5720 libusb0 lists (only devices on its own driver). Under self.lock: the
        list is rebuilt on every call and the old pointers go with it."""
        L = self.L
        L.usb_find_busses(); L.usb_find_devices()
        b = L.usb_get_busses()
        while b:
            d = b.contents.devices
            while d:
                dc = d.contents; dd = dc.descriptor
                if (dd.idVendor, dd.idProduct) == (NOVA_VID, NOVA_PID):
                    fn = dc.filename.decode('latin-1', 'replace')
                    n = fn.split('libusb0-', 1)[1].split('-', 1)[0] if 'libusb0-' in fn else '%s-%d' % (b.contents.dirname.decode('latin-1', 'replace'), dc.devnum)
                    yield d, dict(_usb_endpoints(dc.config.contents if dc.config else None), location='libusb0-' + n, vid=dd.idVendor,
                                  pid=dd.idProduct, bcdDevice=dd.bcdDevice, bcdUSB=dd.bcdUSB, lib=self.name)
                d = dc.next
            b = b.contents.next

    def devices(self):
        with self.lock: return [info for _, info in self._walk()]

    def open(self, location):
        """The device at location ('' = the first one) opened, configuration set and its interface claimed (LCT's order)."""
        with self.lock:
            for d, info in self._walk():
                if location and info['location'] != location: continue
                h = self.L.usb_open(d)
                if not h: raise self.err('open %s' % info['location'], -1)
                return _Libusb0Dev(self, h, info)
        raise OSError('no NovaStar USB device (0483:5720)%s' % (' at ' + location if location else ''))


class _Libusb0Dev:
    """One 0483:5720 opened through libusb0.dll: the same face as _LibusbDev (bulk_out / bulk_in / clear_halt / close).
    LCT (LibUsbDotNet over libusb0.sys): SetConfiguration(1), then ClaimInterface."""
    def __init__(self, lib, h, info):
        self.lib, self.L, self.C, self.h, self.info = lib, lib.L, lib.C, h, info
        self.ep_out, self.ep_in, self.iface = info['epOut'], info['epIn'], info['iface']
        try:
            rc = self.L.usb_set_configuration(h, info.get('config', 1))
            if rc < 0: raise lib.err('set configuration', rc)
            rc = self.L.usb_claim_interface(h, self.iface)
            if rc < 0: raise lib.err('claim interface %d' % self.iface, rc)
        except BaseException: self.L.usb_close(h); self.h = None; raise

    def bulk_out(self, b, ms=USB_IO_MS):
        buf = self.C.create_string_buffer(bytes(b), max(len(b), 1))
        rc = self.L.usb_bulk_write(self.h, self.ep_out, buf, len(b), max(1, int(ms)))
        if rc == LIBUSB0_TIMEOUT: raise socket.timeout('USB write timed out (%d bytes)' % len(b))
        if rc < 0: raise self.lib.err('write', rc)

    def bulk_in(self, n=USB_IN_SIZE, ms=USB_IO_MS):
        n = min(n, LIBUSB0_MAX_IO)                            # a longer reply comes in two reads (the link joins them)
        buf = self.C.create_string_buffer(n)
        rc = self.L.usb_bulk_read(self.h, self.ep_in, buf, n, max(1, int(ms)))
        if rc == LIBUSB0_TIMEOUT: raise socket.timeout('timed out')
        if rc < 0: raise self.lib.err('read', rc)
        return buf.raw[:rc]

    def clear_halt(self):
        for ep in (self.ep_out, self.ep_in): self.L.usb_clear_halt(self.h, ep)

    def close(self):
        if self.h is None: return
        try: self.L.usb_release_interface(self.h, self.iface)
        finally: self.L.usb_close(self.h); self.h = None


class _NovaUsbPort(_SerialBase):
    """Just enough of a socket for TcpLink over a 0483:5720 device (dev: _LibusbDev or a test stand-in).
    sendall = [USBC A2 block] + frame (+ an empty packet when len % 64 == 0, as LCT); recv = one IN transfer, "USBS" status
    blocks taken out. The status of our own write block before any data -> LCT's old flow: an A3 block asking for the reply
    (20 + data length); the data follows, then a status, skipped when it turns up like any status that isn't for our write
    block (NovaLCT's USB exchange)."""
    def __init__(self, dev, timeout, mode=None, link='usb'):
        self.dev, self.timeout, self.mode, self.link = dev, timeout, mode or USB_MODE, link   # link: the recorder's name for it
        self.tag, self.wtag, self.frame, self.asked, self.dirty = 0, 0, b'', False, False
        self.drain()                                          # LCT empties the IN pipe on open

    def _out(self, b, wrapper=True):
        """One OUT transfer; the wrapper's own blocks (USBC, the empty packet) are recorded here, the frame by TcpLink."""
        if wrapper: wirelog.usb(self.link, 'tx', b)
        self.dev.bulk_out(b)

    def drain(self, ms=200, times=10):
        """Throw away what's waiting on the IN pipe (LCT: 1000 ms reads; 200 ms here, data already queued comes at once)."""
        for _ in range(times):
            try: d = self.dev.bulk_in(USB_IN_SIZE, ms)
            except socket.timeout: return
            if d: wirelog.stray(self.link, d, 'drained')        # mostly late replies to requests that timed out (USBS blocks too)

    def sendall(self, b):
        if self.dirty:                                         # after an error, as LCT
            self.dev.clear_halt(); wirelog.conn(self.link, 'USB clear halt + drain (after an error)'); self.drain(); self.dirty = False
        self.frame, self.asked = bytes(b), False
        try:
            if self.mode != 'com':
                self.tag = self.wtag = (self.tag + 0x1001) & 0xFFFFFFFF or 1   # LCT: a random tag; any the status can echo will do
                self._out(usb_cbw(len(b), False, self.tag))
            self._out(b, False)
            if len(b) % 64 == 0: self._out(b'')                # LCT sends an empty packet after a 64-multiple
        except (OSError, socket.timeout): self.dirty = True; raise

    def _ask(self):
        """LCT's old flow: an A3 (read) block for the reply's length: 20, plus the data length on a read. (LCT computes the
        data length from bytes 17-18 of the request, one byte off its u16 at 16-17; the right offset is used here.)"""
        f = self.frame
        n = 20 if len(f) > 10 and f[10] == 1 else 20 + (struct.unpack_from('<H', f, 16)[0] if len(f) >= 18 else 0)
        self.asked = True; self.tag = (self.tag + 0x1001) & 0xFFFFFFFF or 1
        self._out(usb_cbw(n, True, self.tag))

    def recv(self, n):
        end = time.time() + self.timeout
        while True:
            try: d = self.dev.bulk_in(USB_IN_SIZE, min(USB_IO_MS, max(1, (end - time.time()) * 1000)))
            except socket.timeout:
                if time.time() >= end: self.dirty = True; raise
                continue
            except OSError: self.dirty = True; raise
            csw = None
            if d[:4] == b'USBS' and len(d) >= 13: csw, d = d[:13], d[13:]
            elif len(d) >= 13 and d[-13:-9] == b'USBS': csw, d = d[-13:], d[:-13]
            if csw is not None:
                tag, residue, status = struct.unpack_from('<IIB', csw, 4)
                wirelog.usb(self.link, 'rx', csw, ours=tag == self.wtag)   # every status block, ok or not
                if not d and tag == self.wtag and self.mode != 'com' and not self.asked:
                    try: self._ask()
                    except (OSError, socket.timeout): self.dirty = True; raise
                if not d: continue                           # a status only (ours, or a stale one): keep reading
            if d: return d

    def close(self): self.dev.close()


class UsbLink(TcpLink):
    """One link over NovaStar's own USB device (0483:5720): TcpLink's framing and recorder hooks, frames wrapped as LCT does
    (_NovaUsbPort). location: libusb's bus-ports ('20-1.2'; '' = the first one). dev: a test stand-in for _LibusbDev."""
    def __init__(self, location='', timeout=3.0, wait=LINK_WAIT, locked=False, dev=None):
        t0 = time.time()
        if not location and dev is None:
            ds = usb_list()
            if not ds: raise LinkError('no NovaStar USB device (0483:5720) on this computer')
            location = ds[0]['location']
        self.tag = 'usb:%04x:%04x@%s' % (NOVA_VID, NOVA_PID, location)
        self.lock = None if locked else _take(self.tag, wait)
        try:
            self.s = _NovaUsbPort(dev or usb_open(location), timeout, link=self.tag)
        except Exception as e:
            if self.lock: self.lock.release(); self.lock = None
            wirelog.conn(self.tag, 'connect failed', str(e), (time.time() - t0) * 1000); raise
        wirelog.conn(self.tag, 'open (%s)' % ('USBC' if self.s.mode != 'com' else 'plain'), ms=(time.time() - t0) * 1000,
                     lib=(getattr(self.s.dev, 'info', None) or {}).get('lib'))
        self.serial = 0
        self.buf = b''
        self.last = None


def usb_devices():
    """NovaStar USB devices here, listed from descriptors only (nothing opened) -> ([{name, label, host, …}], error or '')."""
    try: ds = usb_list()
    except (LinkError, OSError) as e: _usb_note('USB not usable', str(e)); return [], str(e)   # once per cause, for the report
    short = lambda loc: str(int(loc[8:])) if loc.startswith('libusb0-') and loc[8:].isdigit() else loc   # "USB 1" for libusb0-0001
    return [dict(d, name=d['location'], label='USB ' + short(d['location']), host='usb:%04x:%04x@%s' % (NOVA_VID, NOVA_PID, d['location'])) for d in ds], ''


USB_SEEN = {}


def probe_usb(d, timeout=1.0):
    """Is a controller behind NovaStar USB device d? One read of sender 0's ModelID (0x00000002, 2 B, dst 0), as probe_serial."""
    w = usb_yielded(d['host'])
    if w: return dict(USB_SEEN.get(d['host']) or d, busy=True, yielded=w)
    lock = _target_lock(d['host'])
    if not lock.acquire(blocking=False):
        sh = _POOL.get(d['host'])
        if sh is None or sh.raw is None or USB_SEEN.get(d['host']): return dict(USB_SEEN.get(d['host']) or d, busy=True)
        r = dict(d, answered=False)                  # held open before any probe (the USB coordinator's bridge): ask through it once
        try:
            link = open_link(d['host'], None, timeout, wait=1.0)
            try: b = link.read(0, 0, 0, 0, 0x00000002, 2); m = b[0] | (b[1] << 8)
            finally: link.close()
            if m not in (0, 0xFFFF): r.update(answered=True, modelId=m)
            else: r['error'] = 'ModelID 0x%04X' % m
        except (OSError, LinkError) as e: return dict(USB_SEEN.get(d['host']) or d, busy=True, error=str(e))
        USB_SEEN[d['host']] = r
        return r
    r = dict(d, answered=False)
    try:
        try: link = UsbLink(d['name'], timeout, locked=True)
        except (OSError, LinkError) as e: r['error'] = str(e)
        else:
            try:
                b = link.read(0, 0, 0, 0, 0x00000002, 2); m = b[0] | (b[1] << 8)
                if m not in (0, 0xFFFF): r.update(answered=True, modelId=m)
                else: r['error'] = 'ModelID 0x%04X' % m
            except (LinkError, OSError) as e: r['error'] = str(e)
            finally: link.close()
    finally: lock.release()
    USB_SEEN[d['host']] = r
    return r


class SimLink:
    """In-memory processor: sender memory per card, receiving-card writes counted. For checking plans offline."""
    def __init__(self, senders):
        self.senders = senders; self.mem = {}; self.rx = {}

    def _page(self, dst, addr):
        key = (dst, addr & 0xFFFF0000)
        if key not in self.mem: self.mem[key] = bytearray(65536)
        return self.mem[key]

    def write(self, dev, dst, port, card, addr, data, r2=0, no_reply=False):
        if dev == 0:
            for d in (range(self.senders) if dst == 0xFF else [dst]):
                for i, b in enumerate(data):
                    a = addr + i; self._page(d, a)[a & 0xFFFF] = b
        elif dev == 1:
            self.rx[(dst, port, card, addr)] = bytes(data)

    def read(self, dev, dst, port, card, addr, length, r2=0, timeout=None):
        if dev != 0: return bytes(length)
        out = bytearray()
        for i in range(length):
            a = addr + i; out.append(self._page(0 if dst == 0xFF else dst, a)[a & 0xFFFF])
        return bytes(out)

    def close(self): pass


# ------------------------------------------------------------------ NSSD (sender software space at 0x05000000)
LZMA_FILTERS = [{'id': lzma.FILTER_LZMA1, 'dict_size': 1 << 20, 'lc': 3, 'lp': 0, 'pb': 2}]   # props 5D 00 00 10 00


def lz(b):
    return lzma.compress(b, format=lzma.FORMAT_RAW, filters=LZMA_FILTERS)


def pack_nssd(json_text):
    """NSSD container as LCT 5.9.2 writes it (docs\\CONFIG_FILE_FORMATS.md §5.6): 512-B header, props at +0x200,
    LZMA file-info JSON at +0x400, the LZMA ScreenDataType JSON at +0x2000. Checksums are 0x55AA + byte sums."""
    raw = json_text.encode('utf-8'); comp = lz(raw)
    info = json.dumps({'SectionFormat': [{'FileType': 'ScreenDataType', 'Addr': 0x05002000, 'SrcLength': len(raw),
                       'DestLength': len(comp), 'CheckSum': sum16(comp, 0x55AA), 'Version': '1001',
                       'DecompressProps': ']\u0000\u0000\u0010\u0000'}]}, separators=(',', ':')).encode('utf-8')
    infoc = lz(info)
    if 0x400 + len(infoc) > 0x2000: raise ValueError('NSSD file info too large')
    img = bytearray(0x2000 + len(comp))
    nc = bytes([5, 0, 0x5D, 0, 0, 0x10, 0])
    img[0x200:0x200 + len(nc)] = nc
    img[0x400:0x400 + len(infoc)] = infoc
    img[0x2000:] = comp
    img[0:4] = b'NSSD'
    struct.pack_into('<HHHIIH', img, 6, 1001, len(nc), sum16(nc, 0x55AA), len(infoc), len(info), sum16(infoc, 0x55AA))
    struct.pack_into('<H', img, 4, sum16(img[6:512], 0x55AA))
    return bytes(img)


def _unlz(comp, props):
    """Raw LZMA with NovaLCT's 5 props bytes (lc/lp/pb byte + u32 dictionary size)."""
    p0 = props[0]; dic = struct.unpack_from('<I', props, 1)[0]
    f = [{'id': lzma.FILTER_LZMA1, 'dict_size': dic or (1 << 20), 'lc': p0 % 9, 'lp': (p0 // 9) % 5, 'pb': p0 // 45}]
    return lzma.LZMADecompressor(format=lzma.FORMAT_RAW, filters=f).decompress(comp)


def _readn(link, dst, addr, n):
    out = b''
    for o in range(0, n, CHUNK): out += link.read(0, dst, 0, 0, addr + o, min(CHUNK, n - o))
    return out


def read_layout(link, senders):
    """The screen layout each sending card holds (the NSSD record NovaLCT's "Read from HW" reads, seen on the real H5
    2026-10-11; container as pack_nssd writes it): header 0x05000000, props 0x05000200, LZMA file info 0x05000400
    -> {SectionFormat: [{Addr, DestLength, DecompressProps}]} -> the LZMA screen JSON {ScreenDataInSoftSpace: [...]}.
    Read-only. Returns [{dst, screens: [...]} | {dst, empty: True} | {dst, error}]."""
    out = []
    for dst in range(int(senders or 1)):
        try:
            hdr = link.read(0, dst, 0, 0, 0x05000000, 32)
            if hdr[:4] != b'NSSD': out.append({'dst': dst, 'empty': True, 'note': 'no layout record (%s)' % hdr[:4].hex()}); continue
            ncl, infol = struct.unpack_from('<H', hdr, 8)[0], struct.unpack_from('<I', hdr, 12)[0]
            nc = link.read(0, dst, 0, 0, 0x05000200, max(7, ncl))
            props = bytes(nc[2:7])
            info = json.loads(_unlz(_readn(link, dst, 0x05000400, infol), props).split(b'\0')[0].decode('utf-8', 'replace'))
            screens = []
            for sec in info.get('SectionFormat') or []:
                if sec.get('FileType') != 'ScreenDataType': continue
                dp = (sec.get('DecompressProps') or '').encode('latin1')
                raw = _unlz(_readn(link, dst, int(sec['Addr']), int(sec['DestLength'])), dp if len(dp) >= 5 else props)
                j = json.loads(raw[:int(sec.get('SrcLength') or len(raw))].decode('utf-8', 'replace'))
                screens += j.get('ScreenDataInSoftSpace') or []
            out.append({'dst': dst, 'screens': screens})
        except (LinkError, ValueError, KeyError, lzma.LZMAError) as e:
            out.append({'dst': dst, 'error': str(e)})
    return out


# ------------------------------------------------------------------ plan runner
def flag_addr(p):
    """A port's master / backup flag byte on the sending card (hwsend.js flagAddr; new banks at port 4, 8, 16)."""
    return 0x02000018 + p if p < 4 else 0x02000098 + p - 4 if p < 8 else 0x02000100 + p - 8 if p < 16 else 0x02010040 + p - 16


def plan_op(plan):
    """What a plan does, for the link pool's exclusive hold and its "busy: … is running" answer. None = reads only (it
    shares the link like detect / health); any other op (w, copy, sync, nssd, reduclear …) counts as a write."""
    ks = set(op.get('op') for op in plan.get('ops') or []) - {'note', 'sleep', 'r'}
    if not ks: return None
    return 'a send' if 'nssd' in ks else 'a save' if plan.get('waitMs') else 'a write'


def run_plan(link, plan, log):
    t0 = time.time(); n = 0; stash = {}
    def say(s): log('%8.3f  %s' % (time.time() - t0, s))
    for op in plan['ops']:
        k = op['op']
        if k == 'note': say('# ' + op['text']); continue
        if k == 'stash':     # read now, written later by 'unstash' (hwsend.js: a backup card's 0x020000F0 = its primary's before the Send)
            stash[op['key']] = link.read(0, op['dst'], 0, 0, op['addr'], op['len']); n += 1
            say('R d%d 0x%08X -> %s (kept)' % (op['dst'], op['addr'], stash[op['key']].hex(' ').upper())); continue
        if k == 'unstash':
            link.write(0, op['dst'], 0, 0, op['addr'], stash[op['key']]); n += 1
            say('W dev0 d%d 0x%08X %s (kept value)' % (op['dst'], op['addr'], stash[op['key']].hex(' ').upper())); continue
        if k == 'sleep':
            if not isinstance(link, SimLink): time.sleep(op['ms'] / 1000.0)
            continue
        if k == 'w':
            data = bytes.fromhex(op['hex']); a = op['addr']
            for i in range(0, max(len(data), 1), CHUNK):
                try: link.write(op['dev'], op['dst'], op['port'], op['card'], a + i, data[i:i + CHUNK], op.get('r2', 0), op.get('noReply', False)); n += 1
                except LinkError as e:   # 'tolerate': a write the processor may refuse (NovaLCT carries on too, e.g. 0x02300000 on H)
                    if not op.get('tolerate') or 'status' not in str(e): raise
                    say('# 0x%08X refused (%s) — carrying on, as NovaLCT does' % (a + i, e)); n += 1
            if len(data) <= 8 or op['dev'] != 0:
                say('W dev%d d%d p%d c%d 0x%08X %s%s' % (op['dev'], op['dst'], op['port'], op['card'], a, data.hex(' ').upper(), ' r2=%d' % op['r2'] if op.get('r2') else ''))
            else:
                say('W dev%d d%d 0x%08X %d B' % (op['dev'], op['dst'], a, len(data)))
            continue
        if k == 'r':
            d = link.read(op['dev'], op['dst'], op['port'], op['card'], op['addr'], op['len']); n += 1
            say('R d%d 0x%08X -> %s' % (op['dst'], op['addr'], d.hex(' ').upper())); continue
        if k == 'copy':   # NovaLCT's backup-card copy (hwsend.js reduOps): read every range of `from` first, then patch, then write
            rs = op['ranges']; bufs = []
            for r in rs:
                buf = bytearray()
                for i in range(0, r[1], CHUNK): buf += link.read(0, op['from'], 0, 0, r[0] + i, min(CHUNK, r[1] - i)); n += 1
                bufs.append(buf)
            orig = [bytes(b) for b in bufs]
            def put(addr, data):
                for r, buf in zip(rs, bufs):
                    lo, hi = max(addr, r[0]), min(addr + len(data), r[0] + r[1])
                    if lo < hi: buf[lo - r[0]:hi - r[0]] = data[lo - addr:hi - addr]
            for s, sa, da, ln in op.get('slots', []):   # a primary port's data into its backup port's slot (as read, unpatched)
                got = next((o[sa - r[0]:sa - r[0] + ln] for r, o in zip(rs, orig) if s == op['from'] and r[0] <= sa and sa + ln <= r[0] + r[1]), None)
                if got is None:
                    got = b''
                    for i in range(0, ln, CHUNK): got += link.read(0, s, 0, 0, sa + i, min(CHUNK, ln - i)); n += 1
                put(da, got)
            for sa, sh in op.get('set', []): put(sa, bytes.fromhex(sh))
            for r, buf in zip(rs, bufs):
                for i in range(0, r[1], CHUNK): link.write(0, op['to'], 0, 0, r[0] + i, bytes(buf[i:i + CHUNK])); n += 1
                if len(r) > 2 and r[2] and not isinstance(link, SimLink): time.sleep(r[2] / 1000.0)
            say('COPY d%d -> d%d: %d ranges, %d slots, flags %s' % (op['from'], op['to'], len(rs), len(op.get('slots', [])) // 3, op.get('set'))); continue
        if k == 'roles':   # NovaLCT's sending-card backup roles after a layout Send (hwsend.js): 5A primary -> flags 00, A5 backup -> 80
            for d in range(int(op['senders'])):
                v = link.read(0, d, 0, 0, 0x0200009D, 1)[0]; n += 1
                if v in (0x5A, 0xA5):
                    for p in range(int(op['ports'])): link.write(0, d, 0, 0, flag_addr(p), bytes([0 if v == 0x5A else 0x80])); n += 1
                    say('ROLE d%d = %s: every port flag %s' % (d, 'primary' if v == 0x5A else 'backup', '00' if v == 0x5A else '80'))
            continue
        if k == 'reduclear':   # NovaLCT's Delete of every pair in the processor's REDU record, then the empty table (hwsend.js)
            got = read_backup(link, 1)['pairs']; n += 2
            for ps, pp, bs, bp in got:
                link.write(0, bs, 0, 0, flag_addr(bp), b'\x00'); n += 1
            try: link.write(0, 255, 0, 0, 0x02300000, bytes.fromhex(op['table'])); n += 1
            except LinkError as e:
                if 'status' not in str(e): raise
                say('# 0x02300000 refused (%s) — carrying on, as NovaLCT does' % e); n += 1
            say('CLEAR port backup: %d pair(s) from the REDU record, table emptied' % len(got)); continue
        if k == 'sync':   # NovaLCT's video-sync write (hwsend.js): the sender's own 0x020000D4 when it holds a size, else the default
            cur = link.read(0, op['from'], 0, 0, 0x020000D4, 5); n += 1
            data = cur if (cur[1] | cur[2]) and (cur[3] | cur[4]) else bytes.fromhex(op['hex'])
            for _ in range(int(op.get('times', 1))): link.write(0, op['to'], 0, 0, 0x020000D4, data); n += 1
            say('SYNC d%d 0x020000D4 -> %s, written to d%d x%d' % (op['from'], cur.hex(' ').upper(), op['to'], int(op.get('times', 1)))); continue
        if k == 'nssd':
            img = pack_nssd(op['json'])
            for i in range(0, len(img), CHUNK): link.write(0, op['dst'], 0, 0, 0x05000000 + i, img[i:i + CHUNK]); n += 1
            say('NSSD d%d: %d B (json %d B)' % (op['dst'], len(img), len(op['json']))); continue
        raise ValueError('unknown op ' + k)
    say('done: %d frames' % n)
    return n


def dump_sim(sim, out):
    os.makedirs(out, exist_ok=True)
    for (d, page), mem in sim.mem.items():
        with open(os.path.join(out, 'sim_sender_d%d_%08X.img' % (d, page)), 'wb') as f: f.write(mem)
    with open(os.path.join(out, 'sim_rx.json'), 'w') as f:
        json.dump(['%d/%d/%d/0x%08X=%s' % (k[0], k[1], k[2], k[3], v.hex()) for k, v in sim.rx.items()], f)


def logfile():
    """One log file per day (each request line stamped with its time and route). Until 2026-10-11 it was one file per
    request: ~11,000 files made listing them slow over the network share; those old files stay where they are."""
    d = alpha.LOG_DIR; os.makedirs(d, exist_ok=True)   # tools/novalink_logs (OPENNOVA_HELPER_LOGS in tests)
    p = os.path.join(d, datetime.datetime.now().strftime('%Y%m%d') + '.txt')
    if not os.path.exists(p):   # the first line says which Open Nova wrote it
        with open(p, 'a', encoding='utf-8') as f: f.write('# %s · Python %s · %s\n' % (alpha.version_line(), sys.version.split()[0], sys.platform))
    return p


# ------------------------------------------------------------------ discovery + panel detection (NovaLCT protocol)
DISC_PORT = 3800   # NovaLCT's discovery port (tests point it elsewhere)


def discover(timeout=2.0, targets=('255.255.255.255', '127.0.0.1'), probe=()):
    """LCT's discovery (docs\\HW_PROTOCOL.md): "rqProMI:" to UDP 3800, every "rpProMI:" reply is a device. H series list one
    TCP port per output card after "H_SUB_CARD@^^@" (4-character tokens); the others use TCP 5200. Sent on every network
    interface at once (netif.udp_search: one socket per interface, as Companion does; Settings > Network can leave one
    out) and to `probe`, addresses typed in the app (a processor on another subnet or across a VPN such as Tailscale answers
    a direct ask). Each device says which interface it answered on ('iface'); one IP answering on two interfaces = two
    isolated networks with the same address (netif.same_ip)."""
    import netif
    found = {}
    for d, addr, iface in netif.udp_search(DISC_PORT, b'rqProMI:', 'nova', timeout, targets, probe):
        if not d.startswith(b'rpProMI:'): continue
        text = d[8:].decode('ascii', 'replace')
        ports = [int(t) for t in text.replace('H_SUB_CARD@^^@', '_').split('_') if len(t) == 4 and t.isdigit()] if 'H_SUB_CARD' in text else [5200]
        found.setdefault((addr[0], iface), {'ip': addr[0], 'links': ports, 'text': text[:80], 'iface': iface})
    # a processor on this computer answers both the broadcast and the loopback probe: keep the network address
    lo = [k for k in found if k[0].startswith('127.') and any(not o[0].startswith('127.') and found[o]['text'] == found[k]['text'] for o in found)]
    for k in lo: del found[k]
    import vendortap   # a running Tools > Vendor Apps relay answers searches too: not a processor of ours
    return netif.same_ip([found[k] for k in sorted(found) if not vendortap.relayed(k[0])])


def senders_on(link, limit=32):
    """The cascaded sending cards behind one link: ModelID (sender 0x00000002, 2 B) for dst 0, 1, … until one fails."""
    out = []
    for d in range(limit):
        try: b = link.read(0, d, 0, 0, 0x00000002, 2, timeout=1.0)
        except LinkError: break
        out.append(b[0] | (b[1] << 8))
    return out


# H cards on a TG port that aren't LED sending cards (app-processors.js NON_LED_CARDS): no sending-card table to ask for
NON_LED_CARDS = {0x7B47: 'H MVR card (preview)'}


def sender_functions(link, dst):
    """The sending card's function table (0x02020020, 64 B; NovaLCT reads it on connect), read-only. FreeRoute = byte 4
    (0x02020024) bit 6: NovaLCT then counts port load by cabinet areas (free topology) (CROSS_TOOL §3.1); whether an H
    16-port card updated with Dynamic Sub-Pixels sets it is what the H test shows. {hex, freeRoute} or {error}.
    The H 16-port card (0x7B46, an H9 tester's, 2026-11-19) answers the 64-byte read with status 4 (unknown command): then
    the FreeRoute byte alone (0x02020024, 1 B) is asked; when that is refused too -> {error, unsupported: True}."""
    try: t = link.read(0, dst, 0, 0, 0x02020020, 64, timeout=1.5)
    except LinkError as e:
        if 'status 4' not in str(e): return {'error': str(e)}
        try: b = link.read(0, dst, 0, 0, 0x02020024, 1, timeout=1.5)
        except LinkError as e2: return {'error': 'not available on this card (%s)' % e2, 'unsupported': 'status 4' in str(e2)}
        return {'hex': '', 'byte4': '%02x' % b[0], 'freeRoute': bool(b[0] & 0x40)}
    return {'hex': t.hex(), 'freeRoute': bool(t[4] & 0x40)}


def linked_ports(link, dst, ports):
    """Port link bits (DETECT_LCT.md §1.3): ports 0-15 in the low nibble of sender bytes 0x02000000 + 31, 159, 294, 295;
    ports 16+ in 0x02010000, one byte per 4 ports (low nibble). Read as NovaLCT (and health) does: 256 B, plus 0x02000100
    for ports 9-16 — a VX4S-N answers one 296 B read with status 4 (tester report 2026-11-20: Detect said "no answer", 0
    ports, 0 panels, while the 256 B read answered every time)."""
    blk = link.read(0, dst, 0, 0, 0x02000000, 256)
    if ports > 8: blk += link.read(0, dst, 0, 0, 0x02000100, 256)
    if len(blk) < (296 if ports > 8 else 160): raise LinkError('short reply to the port-link read (%d B)' % len(blk))
    bits = [blk[31], blk[159]] + ([blk[294], blk[295]] if ports > 8 else [0, 0])
    out = [p for p in range(min(ports, 16)) if bits[p // 4] & (1 << (p % 4))]
    if ports > 16:
        more = link.read(0, dst, 0, 0, 0x02010000, 8)   # a card with 16 ports or fewer may answer short: those ports are off
        out += [p for p in range(16, ports) if (p - 16) // 4 < len(more) and more[(p - 16) // 4] & (1 << ((p - 16) % 4))]
    return out


class ReplyTimer:
    """How long present receiving cards take to answer, so the "is anybody past the end?" probe needn't wait a fixed
    0.5 s: a card past the end may stay silent (DETECT_LCT §6), and on a full 20 x 40-port chassis 800 such waits were
    400 s of a 495 s detect. Wait 8 x the slowest of the last 64 answers, 50 ms at least, the probe timeout at most.
    A present card that is late anyway only shortens that chain until the next live check walks the port again."""
    def __init__(self, cap):
        self.cap = cap; self.seen = []
    def read(self, link, dst, p, i, addr, n, timeout=None):
        t = time.time(); b = link.read(1, dst, p, i, addr, n, timeout=timeout or self.end())
        self.seen = (self.seen + [time.time() - t])[-64:]
        return b
    def end(self):
        return self.cap if not self.seen else min(self.cap, max(0.05, 8 * max(self.seen)))


ROTATE = {}   # live mode: where the end-of-chain probes carry on next time, per link


def port_unchanged(rt, link, dst, p, prev, probe_end):
    """Live re-check of one port the app already knows (prev = its last chain): the last known card still answers with
    the same size, and (when probe_end) nothing answers past the end."""
    n = len(prev)
    try:
        if n:
            b = rt.read(link, dst, p, n - 1, 0x02000000, 32, timeout=rt.cap)
            if (b[0x17] | (b[0x18] << 8), b[0x19] | (b[0x1A] << 8)) != (prev[-1]['w'], prev[-1]['h']): return False
    except LinkError: return False
    if not probe_end: return True
    # a card that does answer past the end, even late, means the chain grew (a late reply is dropped by its serial)
    try: rt.read(link, dst, p, n, 0x02000000, 1); return False
    except LinkError: return True


def detect(link, cards, log, probe_timeout=0.5, max_cards=255, known=None, key=None, end_budget=64, pairs=None):
    """known (optional, live mode) = {"dst:port": [chain]} from the last detect: ports that still look the same keep it
    (port_unchanged), only changed or newly linked ports are walked again.
    pairs (optional) = the project's port backup [{ps, pp, bs, bp}]: a primary chain that stops (data break) carries on via
    its backup port at the same index (cabinet 'via': 'backup'), a dead primary port is walked via its backup, and
    backup ports aren't listed on their own (they are the far end of the same chain)."""
    known = known or {}
    return _detect(link, cards, log, probe_timeout, max_cards, known, key, end_budget, pairs or [])


def _detect(link, cards, log, probe_timeout, max_cards, known, key=None, end_budget=64, pairs=()):
    """Which receiving cards answer on each port, in cable order, with their size (DETECT_LCT.md): per linked port, read
    card 0, 1, 2 … at 0x02000000 (32 B: presence + width / height at +0x17 / +0x19) until a read fails (no reply or a
    non-zero ack). The NCP cabinet type (0x06000200: 0x5A, type at +192) is read once per run of same-size cards.
    cards = [{dst, ports}] (sending cards and their port counts, from the project's model). Position can't be detected."""
    t0 = time.time(); out = []; rt = ReplyTimer(probe_timeout)
    if not known: link.write(0, 0xFF, 0, 0, 0x01000000, b'\x00', no_reply=True)   # arrange addresses, as LCT does on connect
    # live mode: every check reads all link bits and each known port's last card (unplugged panels, dead ports, newly
    # cabled ports all show at once); the end-of-chain probe (panels added at the end) covers end_budget ports per check,
    # rotating, so a 20 x 40-port chassis still answers in a few seconds
    allp = sorted(known)
    start = ROTATE.get(key, 0) % max(1, len(allp))
    probe_now = set(allp[start:start + end_budget] + allp[:max(0, start + end_budget - len(allp))]) if known else set()
    if known: ROTATE[key] = start + end_budget
    backup_of = {(q['ps'], q['pp']): (q['bs'], q['bp']) for q in pairs}
    is_backup = set(backup_of.values())
    def card_read(d, p, i, addr, ln, timeout=None, via=None):
        """read card i of the chain on (d, p): via the primary, or (via='backup' / when that fails) via its backup port"""
        bk = backup_of.get((d, p))
        if via != 'backup':
            try: return rt.read(link, d, p, i, addr, ln, timeout=timeout), 'primary'
            except LinkError:
                if not bk: raise
        if not bk: raise LinkError('no backup')
        return rt.read(link, bk[0], bk[1], i, addr, ln, timeout=timeout), 'backup'
    for c in cards:
        dst, nports = c['dst'], c['ports']
        try: lp = linked_ports(link, dst, nports)
        except LinkError as e: log('sending card %d: no answer (%s)' % (dst + 1, e)); out.append({'dst': dst, 'ports': {}, 'error': str(e)}); continue
        ports = {}
        walk = [p for p in lp if (dst, p) not in is_backup] + \
               [pp for (d, pp) in backup_of if d == dst and pp not in lp and pp < nports]      # dead primary: via its backup
        for p in sorted(walk):
            prev = known.get('%d:%d' % (dst, p))
            if prev is not None and (dst, p) not in backup_of and port_unchanged(rt, link, dst, p, prev, '%d:%d' % (dst, p) in probe_now):
                ports[p] = prev; continue
            chain, last, via = [], None, (None if p in lp else 'backup')
            for i in range(max_cards):
                try: b, side = card_read(dst, p, i, 0x02000000, 32, timeout=probe_timeout if i == 0 else None, via=via)
                except LinkError: break
                if len(b) < 0x1B: log('sending card %d port %d card %d: short reply (%d B), chain ends here' % (dst + 1, p + 1, i + 1, len(b))); break
                via = 'backup' if side == 'backup' else via
                w, h = b[0x17] | (b[0x18] << 8), b[0x19] | (b[0x1A] << 8)
                name = ''
                if (w, h) != last:
                    try:
                        n, _ = card_read(dst, p, i, 0x06000200, 224, timeout=probe_timeout, via=side)   # (a longer read)
                        if n[0] == 0x5A: name = n[192:224].split(b'\0')[0].decode('ascii', 'replace').strip()
                    except LinkError: pass
                elif chain: name = chain[-1]['name']
                chain.append({'w': w, 'h': h, 'name': name, 'via': side}); last = (w, h)
            ports[p] = chain
            log('sending card %d port %d: %d cards%s' % (dst + 1, p + 1, len(chain), (' %dx%d' % (chain[0]['w'], chain[0]['h'])) if chain else ''))
        out.append({'dst': dst, 'ports': ports, 'linked': lp})
    log('detect done in %.1f s' % (time.time() - t0))
    return out


# ------------------------------------------------------------------ gamma (docs\COLOR_BRIGHTNESS.md §3.1-3.4)
def gamma_lut(gamma, grey):
    """LUT[i] = round(P * (i/255)^gamma) << S, P = 2^grey - 1, S = 16 - grey (8-bit source, low-gray grade 0): the closed form
    matches NovaLCT's own gamma tables (0 mismatches) and the wire (gamma 1.9, 16-bit card: exact). R = G = B."""
    P, S = (1 << grey) - 1, 16 - grey
    one = b''.join(struct.pack('<H', int(math.floor(P * (i / 255.0) ** gamma + 0.5)) << S) for i in range(256))
    return one * 3


def set_gamma(link, targets, gamma, log, tables=None):
    """NovaLCT's gamma change (as recorded with two H_20 cards): per port (card 0xFFFF) the LUT 0x05000000 (1536 B, 6 x 256 B) then
    0x02000000 <- gamma x 10; then 0x060003CA <- 00 (low-gray grade 0) to every port. Only the case confirmed on the wire:
    cards with a 16-bit grey depth (read first, 0x02000000 +0x25, from card 0 of each primary port). Per port, not all or
    nothing (real H2 / H5, 2026-10-11: one port with nothing on it, or its primary cable out, stopped the whole change):
    a port whose card doesn't answer is read through its backup port (target {backupOf: [dst, port]}); a port with no
    answering card, or not 16-bit, is skipped and named. Only if no port can take it is it an error. No save.
    tables = NovaLCT's Custom gamma instead (recorded): 1536 B as hex, R, G, B, u16 LE, each colour its own; 0x02000000 <- FE.
    Returns (frames, written ports, skipped texts)."""
    prim = [t for t in targets if not t.get('backupOf')]
    def grey(dst, port):
        return link.read(1, dst, port, 0, 0x02000000, 0x30, timeout=1.0)[0x25]
    ok, skipped = [], []
    for t in prim:
        where = 'S%d P%d' % (t['dst'] + 1, t['port'] + 1)
        backs = [b for b in targets if b.get('backupOf') and tuple(b['backupOf']) == (t['dst'], t['port'])]
        g = None
        for dst, port in [(t['dst'], t['port'])] + [(b['dst'], b['port']) for b in backs]:
            try: g = grey(dst, port); break
            except LinkError: continue
        if g is None: skipped.append(where + ': no receiving card answered'); continue
        if g != 16: skipped.append(where + (': cards report %d-bit (gamma is confirmed for 16-bit only)' % g if g else ': cards report no grey depth')); continue
        ok.append(t); ok += backs
    if not ok:
        raise LinkError('no port could take gamma — ' + '; '.join(skipped))
    lut, g = (bytes.fromhex(tables), 0xFE) if tables else (gamma_lut(gamma, 16), max(10, min(40, int(round(gamma * 10)))))
    if len(lut) != 1536: raise LinkError('a custom gamma is 1536 bytes, not %d' % len(lut))
    n = 0
    for t in ok:
        for o in range(0, len(lut), CHUNK):
            link.write(1, t['dst'], t['port'], 0xFFFF, 0x05000000 + o, lut[o:o + CHUNK]); n += 1
        link.write(1, t['dst'], t['port'], 0xFFFF, 0x02000000, bytes([g])); n += 1
    for t in ok:
        link.write(1, t['dst'], t['port'], 0xFFFF, 0x060003CA, b'\x00'); n += 1
    log('%s -> %d port(s), %d frames; skipped: %s; not saved' % ('custom gamma' if tables else 'gamma %.1f' % gamma, len(ok), n, '; '.join(skipped) or 'none'))
    return n, len(ok), skipped


def color_read(link, targets, log):
    """Read-only: what the receiving cards of each port hold now, read as NovaLCT reads it when its Brightness / Advanced
    Colour windows open (docs\\COLOR_BRIGHTNESS.md §1, §4.1, §5.2; the same reads are in NovaLCT's recorded colour
    sessions): card 0 of the port, 0x02000000 (0x30 B: +0 gamma x 10, +1 brightness, +2..+5 R G B VR, +0x25 grey depth;
    the read set_gamma does first, done on the real H5), the colour-space switch 0x02000130 (1 B) and the 0x12009000
    record (256 B); per sending card the gamma source depth 0x03100109 (1 B). A port whose card doesn't
    answer is read through its backup port (target {backupOf}). Returns one entry per primary port: {dst, port, via, hex
    (the 0x30 B), gamut (1 B hex), record (hex or None), src (sender byte or None)} or {dst, port, error}."""
    prim = [t for t in targets if not t.get('backupOf')]
    src, out = {}, []
    for t in prim:
        backs = [b for b in targets if b.get('backupOf') and tuple(b['backupOf']) == (t['dst'], t['port'])]
        got = None
        for dst, port in [(t['dst'], t['port'])] + [(b['dst'], b['port']) for b in backs]:
            try: got = (dst, port, link.read(1, dst, port, 0, 0x02000000, 0x30, timeout=1.0)); break
            except LinkError: continue
        if got is None: out.append({'dst': t['dst'], 'port': t['port'], 'error': 'no receiving card answered'}); continue
        dst, port, blk = got
        e = {'dst': t['dst'], 'port': t['port'], 'via': [dst, port], 'hex': blk.hex(), 'gamut': None, 'record': None}
        try:
            g = link.read(1, dst, port, 0, 0x02000130, 1, timeout=1.0); e['gamut'] = g.hex()
            e['record'] = link.read(1, dst, port, 0, 0x12009000, 256, timeout=1.0).hex()   # also when off: the LEDs' colours for Custom gamut
        except LinkError: pass
        if t['dst'] not in src:
            try: src[t['dst']] = link.read(0, t['dst'], 0, 0, 0x03100109, 1)[0]
            except LinkError: src[t['dst']] = None
        e['src'] = src[t['dst']]
        out.append(e)
    log('colour read: %d port(s), %d answered' % (len(out), sum(1 for e in out if 'hex' in e)))
    return out


# ------------------------------------------------------------------ backup read-back (read-only)
ROLE = {0x5A: 'primary', 0xA5: 'backup', 0xFF: 'none', 0x00: 'fresh'}


def read_backup(link, senders):
    """The port backup pairs stored on the link, read the way NovaLCT does (seen in its redundancy recordings): sending card 0
    0x05065000, 10 B header "REDU" + u16 version + u16 + u16 payload length, then the payload = N x 16 B {u32 primary
    sender, u32 primary port, u32 backup sender, u32 backup port} (0-based). A cleared record reads 00 00 00 00. Plus each
    sending card's device-backup role at 0x0200009D (5A primary, A5 backup, FF none, 00 fresh) [R]. Nothing is written."""
    hdr = link.read(0, 0, 0, 0, 0x05065000, 10)
    pairs, note = [], None
    if hdr[:4] == b'REDU':
        n = struct.unpack_from('<H', hdr, 8)[0]
        data = b''
        for o in range(0, 10 + n, CHUNK):
            data += link.read(0, 0, 0, 0, 0x05065000 + o, min(CHUNK, 10 + n - o))
        body = data[10:10 + n]
        for i in range(0, len(body) - 15, 16):
            pairs.append(list(struct.unpack_from('<IIII', body, i)))
    else:
        note = 'no backup record on the processor' if hdr[:4] == bytes(4) else 'unknown record %s' % hdr[:4].hex()
    roles = []
    for dst in range(int(senders or 1)):
        try: roles.append({'sender': dst, 'role': ROLE.get(link.read(0, dst, 0, 0, 0x0200009D, 1)[0], 'unknown')})
        except LinkError as e: roles.append({'sender': dst, 'role': 'no answer', 'error': str(e)})
    return {'pairs': pairs, 'note': note, 'deviceBackup': roles}


# ------------------------------------------------------------------ receiving-card identity (docs\RCV_FILE_GUARD.md §2.1)
def _fw(b):
    """0x08000000 / 0x09000000 (256 B): version [4..7] a.b.c.d in hex digits, remark UTF-8 [8..129]"""
    if not b or len(b) < 8: return None, None
    ver = '%x.%x.%x.%x' % (b[4], b[5], b[6], b[7])   # hex digits: 0x98 = "98" (as LCT shows it)
    rem = b[8:130].split(b'\0')[0].decode('utf-8', 'replace').strip() or None
    return ver, rem


def identify(link, chains, log, full=False, pairs=None, probe_timeout=0.5):
    """Read-only: what each receiving card is (for the .rcfgx / NCP guard). chains = [{dst, ports: {port: count}}] from the
    app's last detect. Per card: 0x02000000 (48 B: size, module, chip, scan, decoder, grey), 0x00000000 (2 B ModelID),
    0x06000200 (320 B NCP block); with full: firmware 0x08000000 / 0x09000000 on every card. Cards on a dead primary are read via the backup port. Returns [{dst, port, index, id|None}]."""
    import rcvfile
    t0 = time.time(); out = []; rt = ReplyTimer(probe_timeout)
    backup_of = {(q['ps'], q['pp']): (q['bs'], q['bp']) for q in (pairs or [])}
    via_backup = set()   # ports whose cards answered only through the backup: the rest of that port is read there at once
    def rd(d, p, i, addr, ln):
        bk = backup_of.get((d, p))
        if bk and (d, p) in via_backup: return rt.read(link, bk[0], bk[1], i, addr, ln, timeout=probe_timeout)
        try: return rt.read(link, d, p, i, addr, ln, timeout=probe_timeout)
        except LinkError:
            if not bk: raise
            b = rt.read(link, bk[0], bk[1], i, addr, ln, timeout=probe_timeout)
            via_backup.add((d, p)); return b
    for c in chains:
        dst = int(c['dst'])
        for p, n in sorted(((int(k), int(v)) for k, v in (c.get('ports') or {}).items())):
            for i in range(n):
                try: blk = rd(dst, p, i, 0x02000000, 0x30)
                except LinkError:
                    out.append({'dst': dst, 'port': p, 'index': i, 'id': None}); continue
                ident = rcvfile._blank(); ident['gen'] = None; ident['ncp'] = None
                for k, v in rcvfile.block_identity(blk).items():
                    if k in ident: ident[k] = v
                try: m = rd(dst, p, i, 0x00000000, 2); ident['modelId'] = m[0] | (m[1] << 8)
                except LinkError: pass
                try:
                    nb = rcvfile.ncp_block_identity(rd(dst, p, i, 0x06000200, 320))
                    ident['ncp'] = nb['ncp']
                    if nb['ncp']:
                        for k in ('mfr', 'cabinet', 'cardName', 'ic', 'decoderName'):
                            if nb.get(k): ident[k] = nb[k]
                except LinkError: pass
                if ident.get('chip') == 0xFF: ident['chip'] = None
                if full:   # every card: a replaced card can run other firmware than its neighbours
                    try: fpga = _fw(rd(dst, p, i, 0x08000000, 256))
                    except LinkError: fpga = (None, None)
                    try: mcu = _fw(rd(dst, p, i, 0x09000000, 256))
                    except LinkError: mcu = (None, None)
                    ident['fw'] = {k: v for k, v in zip(('fpga', 'fpgaRemark', 'mcu', 'mcuRemark'), (fpga[0], fpga[1], mcu[0], mcu[1])) if v}
                out.append({'dst': dst, 'port': p, 'index': i, 'id': ident})
    log('identify: %d cards in %.1f s' % (len(out), time.time() - t0))
    return out


def rcv_send(link, data, name, targets, log, cabinet=0):
    """Send an .rcfgx to receiving cards as NovaLCT does (CAPTURE_MCTRL4K_SEND.md "RCFGX send"): every record of its RCCB
    script in file order, 256-byte frames with rising addresses, each record's delay honoured. targets = [{dst, port,
    card}] with card None = every card on that port (0xFFFF) and dst None = everything (FF / FF / FFFF). One target after
    the other. No Save: that stays the user's separate button. The app runs the file guard before calling this.
    An NCP goes **parameters only** (CAPTURE_NCP_SEND.md §3-§5.1, LCT's "Smart send"): its cabinet script with the busy polls
    (read the target's first card 0x02000001 every 200 ms up to Timeout + 10 s, then 1 s) and AfterTimeout waits. Never the
    firmware phases: receiving-card firmware stays out of scope, so the guard only lets an NCP through when the cards
    already run its firmware. LCT's NCP-internal commits (0x01000011 modes 0D / 03 / 05 / 00, 0x010000A8, 0x01000095) are
    records of the script and go as they are; the NCP panel's "Save to HW" that LCT's Smart send adds afterwards does not.
    As LCT's NCP send: a record without data is skipped, each poll waits up to 1 s for its answer, a failed write or a
    poll that never answers stops the send. Checked frame for frame (writes, busy polls, waits) against NovaLCT's three
    recorded NCP sends."""
    import rcvfile
    ncp = rcvfile.identity(data, name).get('kind') == 'ncp'
    recs = rcvfile.ncp_script(data, int(cabinet or 0)) if ncp else [(a, d, dl, 0, 0) for a, d, dl in rcvfile.script(data, name)]
    if ncp: recs = [r for r in recs if r[1]]
    t0 = time.time(); n = 0
    for t in targets:
        dst = 0xFF if t.get('dst') is None else int(t['dst'])
        port = 0xFF if t.get('dst') is None or t.get('port') is None else int(t['port'])
        card = 0xFFFF if t.get('card') is None else int(t['card'])
        log('%8.3f  %s -> d%s p%s c%s: %d records' % (time.time() - t0, 'NCP parameters' if ncp else 'rcfgx', dst, port, card, len(recs)))
        pd, pp, pc = (0 if dst == 0xFF else dst), (0 if port == 0xFF else port), (0 if card == 0xFFFF else card)
        for addr, d, delay, timeout, after in recs:
            for i in range(0, max(len(d), 1), CHUNK):
                link.write(1, dst, port, card, addr + i, d[i:i + CHUNK]); n += 1
            if delay: time.sleep(delay / 1000.0)
            if ncp and timeout:
                end = time.time() + timeout / 1000.0 + 10
                while True:
                    try: link.read(1, pd, pp, pc, 0x02000001, 16, timeout=1.0); break
                    except LinkError:
                        if time.time() > end: raise LinkError('the cards stayed busy after 0x%08X' % addr)
                        time.sleep(0.2)
                time.sleep(1.0)
            if ncp and after & 0x8000: time.sleep((after & 0x7FFF) / 1000.0)
    log('%8.3f  %s done: %d frames to %d target(s)%s' % (time.time() - t0, 'NCP' if ncp else 'rcfgx', n, len(targets), '' if ncp else '; not saved'))
    return n


# ------------------------------------------------------------------ health + redundancy (docs\HEALTH_LCT.md)
TEMP_WARN, TEMP_ERR, VOLT_LOW, VOLT_HIGH = 60.0, 75.0, 3.3, 5.5   # NovaMonitorManager's defaults (HEALTH_LCT §2.4)


def sender_port_states(link, dst, nports):
    """Per port: link bit, backup flag (bit7 of the port's flag byte) and the 2-bit redundancy pair (0b10 = this port carries
    redundant receiving cards), from the sending card's 0x02000000 block (+ 0x02010000 for ports 16+), HEALTH_LCT §1.1."""
    blk = link.read(0, dst, 0, 0, 0x02000000, 256) + link.read(0, dst, 0, 0, 0x02000100, 256)
    flag_at = lambda p: (0x18 + p) if p < 4 else (0x98 + p - 4) if p < 8 else (0x100 + p - 8)
    link_at = [0x1F, 0x9F, 0x126, 0x127]; pair_at = [0x1E, 0x9E, 0x120, 0x121]
    out = {}
    for p in range(min(nports, 16)):
        out[p] = {'link': bool(blk[link_at[p // 4]] >> (p % 4) & 1), 'backup': bool(blk[flag_at(p)] & 0x80),
                  'pair': (blk[pair_at[p // 4]] >> (2 * (p % 4))) & 3}
    if nports > 16:
        hi = link.read(0, dst, 0, 0, 0x02010000, 0x100) + link.read(0, dst, 0, 0, 0x02010200, 16)
        for p in range(16, nports):
            q = p - 16
            out[p] = {'link': bool(hi[q // 4] >> (q % 4) & 1), 'backup': bool(hi[0x40 + q] & 0x80),
                      'pair': (hi[0x100 + q // 4] >> (2 * (q % 4))) & 3}
    return out


def _card_status(b):
    """0x0A000000 bytes 0-3: temp flag (bit7 valid, bit0 negative), temp x0.5 °C, humidity (bit7 valid, %RH), supply
    voltage (bit7 valid, x0.1 V). None where the card has no sensor."""
    t = (b[1] * 0.5 * (-1 if b[0] & 1 else 1)) if b[0] & 0x80 else None
    return t, ((b[2] & 0x7F) if b[2] & 0x80 else None), (((b[3] & 0x7F) / 10.0) if b[3] & 0x80 else None)


def health(link, cards, pairs, known, log, probe_timeout=0.5, extras=False):
    """One health snapshot in Open Nova's neutral shape (as unicolink.health, plus the sending card per port / cabinet).
    cards = [{dst, ports}], pairs = [{ps, pp, bs, bp}] (the project's port backup, card numbers on this link),
    known = {"dst:port": chain} from detection (the cabinets to ask). Per cabinet: read the monitoring bytes via the
    primary port; once a read there fails (or the primary link is down), via the backup port with the same index
    (LCT's own fallback, HEALTH_LCT §1.3) -> side 'backup'; neither answers -> dark. LCT can't tell a mid-chain break from
    a dead primary port; with the primary link still up and cards answering only via the backup, it's a break, and it
    sits before the first cabinet fed from the backup.
    extras (every few polls, LCT's own sweep reads the same, MONITORING.md / CAPTURE_BER.md [R]): per port the card's
    capability table 0x02000220 (64 B, once); then per cabinet, where supported: bit errors 0x0200014A (3 B: [0] 05 =
    counting, [1..2] u16 count), disconnects 0x020004FB (1 B), power supplies 0x14000420 (8 B: 1 ok, 0 failed; dual-supply
    cards). Read-only: the counters are never cleared here (only the user's Clear does that: ber_clear)."""
    rt = ReplyTimer(probe_timeout); t0 = time.time()
    states = {}
    for c in cards:
        try: states[c['dst']] = sender_port_states(link, c['dst'], c['ports'])
        except LinkError as e: log('sending card %d: no answer (%s)' % (c['dst'] + 1, e)); states[c['dst']] = {}
    backup_of = {(q['ps'], q['pp']): (q['bs'], q['bp']) for q in pairs or []}
    ports, cabs, events = [], [], []
    for key in sorted(known or {}, key=lambda k: tuple(int(x) for x in k.split(':'))):
        d, p = (int(x) for x in key.split(':')); n = len(known[key])
        st = states.get(d, {}).get(p, {'link': False, 'backup': False, 'pair': 0})
        bk = backup_of.get((d, p)); bst = states.get(bk[0], {}).get(bk[1], {}) if bk else {}
        carrying = bool(bk) and bst.get('pair') == 2
        on_primary, first_backup, dark, capab = st['link'], None, 0, None
        for i in range(n):
            side, b = None, None
            if on_primary:
                try: b = rt.read(link, d, p, i, 0x0A000000, 4, timeout=probe_timeout if i == 0 else None); side = 'primary'
                except LinkError: on_primary = False
            if side is None and bk and bst.get('link'):
                try: b = rt.read(link, bk[0], bk[1], i, 0x0A000000, 4, timeout=probe_timeout if first_backup is None else None); side = 'backup'
                except LinkError: pass
            if side == 'backup' and first_backup is None: first_backup = i
            temp, hum, volt = _card_status(b) if b else (None, None, None)
            x = _card_extras(rt, link, (d, p) if side == 'primary' else bk, i, capab) if extras and side else None
            if x is not None: capab = x.pop('_capab', capab)
            ts = None if temp is None else 'error' if temp >= TEMP_ERR else 'warning' if temp >= TEMP_WARN else 'ok'
            vs = None if volt is None else 'warning' if (volt < VOLT_LOW or volt > VOLT_HIGH) else 'ok'
            cab = {'card': d, 'port': p, 'index': i, 'side': side or ('none' if not bk else 'none'), 'dark': side is None,
                   'temp': temp, 'tempStatus': ts, 'voltage': volt, 'voltStatus': vs, 'humidity': hum}
            if x: cab.update(x)
            cabs.append(cab)
            if x and x.get('psu') and 0 in x['psu']:
                events.append({'level': 'error', 'card': d, 'port': p, 'index': i, 'text': 'power supply %s failed' % ', '.join(str(k + 1) for k, v in enumerate(x['psu']) if v == 0)})
            if x and x.get('bitErrors'):
                events.append({'level': 'warning', 'card': d, 'port': p, 'index': i, 'text': 'bit errors'})
            if side is None: dark += 1
            if ts in ('warning', 'error'): events.append({'level': ts, 'card': d, 'port': p, 'index': i, 'text': 'temperature %.1f °C' % temp})
            if vs == 'warning': events.append({'level': 'warning', 'card': d, 'port': p, 'index': i, 'text': 'supply voltage %.1f V' % volt})
        if bk:
            if not st['link'] and first_backup is not None: state = 'primary failed, running on backup'
            elif first_backup is not None: state = 'data break before cabinet %d, split feed' % (first_backup + 1)
            elif not bst.get('link'): state = 'redundancy lost (backup cable)'
            else: state = 'redundant, ok'
        else: state = 'ok' if st['link'] else 'no link'
        if dark: state += ', %d cabinet(s) dark' % dark
        ports.append({'card': d, 'port': p, 'link': state, 'onBackup': first_backup is not None, 'cabinets': n,
                      'breakBefore': first_backup if (st['link'] and first_backup is not None) else None,
                      'backup': {'card': bk[0], 'port': bk[1], 'link': bool(bst.get('link')), 'carrying': carrying} if bk else None})
        if first_backup is not None:
            events.append({'level': 'error' if not st['link'] else 'warning', 'card': d, 'port': p, 'index': first_backup,
                           'text': 'primary port failed, all cabinets on backup' if not st['link'] else 'data break before cabinet %d, cabinets %d-%d on backup' % (first_backup + 1, first_backup + 1, n)})
        elif bk and not bst.get('link'):
            events.append({'level': 'warning', 'card': d, 'port': p, 'index': None, 'text': 'redundancy lost: backup port %d has no link' % (bk[1] + 1)})
        if dark: events.append({'level': 'error', 'card': d, 'port': p, 'index': None, 'text': '%d cabinet(s) not answering on either side' % dark})
    log('health done in %.1f s: %d cabinets, %d events' % (time.time() - t0, len(cabs), len(events)))
    return {'ports': ports, 'cabinets': cabs, 'device': {}, 'events': events}


def ber_clear(link, targets, log):
    """The user's Clear (Monitor): NovaLCT's "Clear Errors" (docs/CAPTURE_BER.md [R]) = rx 0x01000076 <- 05 ("clear and
    enable": the card zeroes its bit-error count). targets = [{dst, port, card}] (the app adds the backup port's address
    for a pair, as LCT does) or empty = one broadcast dall / pall / call. A card that doesn't answer is skipped and
    counted. Never saves. -> (written, failed)"""
    tg = targets or [{'dst': 0xFF, 'port': 0xFF, 'card': 0xFFFF}]
    ok = bad = 0
    for t in tg:
        d, p, c = int(t['dst']), int(t['port']), int(t['card'])
        try: link.write(1, d, p, c, 0x01000076, b'\x05'); ok += 1; log('W dev1 d%s p%s c%s 0x01000076 05' % ('all' if d == 0xFF else d, 'all' if p == 0xFF else p, 'all' if c == 0xFFFF else c))
        except LinkError as e: bad += 1; log('W dev1 d%d p%d c%d 0x01000076 05 -> no answer (%s)' % (d, p, c, e))
    return ok, bad


def _card_extras(rt, link, at, i, capab):
    """Bit errors / disconnects / power supplies of card i on (sender, port) at, as its capability table allows."""
    out = {}
    try:
        if capab is None:
            t = rt.read(link, at[0], at[1], i, 0x02000220, 64)
            capab = {'ber': bool(t[2] & 0x02), 'psu2': bool(t[2] & 0x04), 'disc': bool(t[16] & 0x02)} if len(t) > 16 else {}
            out['_capab'] = capab
        if capab.get('ber') or capab.get('disc'):   # LCT's bit-error dialog reads both on every card [R]; [0] = 05 says it counts
            b = rt.read(link, at[0], at[1], i, 0x0200014A, 3)
            out['berEnabled'] = b[0] == 0x05
            if b[0] == 0x05: out['bitErrors'] = b[1] | (b[2] << 8)    # FFFF = saturated
        if capab.get('disc'):
            out['disconnects'] = rt.read(link, at[0], at[1], i, 0x020004FB, 1)[0]
        if capab.get('psu2'):
            v = rt.read(link, at[0], at[1], i, 0x14000420, 8)
            out['psu'] = [1 if v[k] == 1 else 0 if v[k] == 0 else None for k in range(2)]   # two supplies; other values = unknown
    except LinkError:
        pass
    return out


# ------------------------------------------------------------------ Correction tab (/api/hw/calib, app-correction.js)
# Every register / value below is what NovaLCT 5.9.2 sent in docs\CAPTURE_CALIBRATION.md's captures [R]; layouts from
# docs\CALIBRATION.md. Scope (OPEN_NOVA_DESIGN §0): no coefficient upload / edit / erase / generation, nothing written to
# module flash, and no save inside another operation (save is its own op, its own button in the app).
#   read       per card, read-only: switch byte 0x02000051, function table 0x02000220 (19 B, as LCT's window reads it),
#              coefficient samples at 0x07000000 (32 B per pixel: the first pixel and the centre one)
#   switch     LCT's Online Calibration radios: 0x02000051 read from the first card, then per (sender, port), card all,
#              0x02000051 <- byte, 0x010000B3 <- 05 / 00 (brightness 03, chroma 01, off 00 with a 00 base). Refused while
#              full-grayscale (multi-layer, bit 4) is on: LCT's write would switch it off.
#   reset      Reset Coeffs.: one 0x01000024 op 2 per card over its whole rectangle (card-local), identity (2047)
#   reload     View Receiving Card: 0x01000006 <- 00 per card (card flash -> working memory; undoes an unsaved reset)
#   module     View Module Calib.: 0x01000007 <- 00 per card, then the busy check on the last card
#   save       0x01000004 <- 00 per port (card all, LCT's Save to HW after a reset) or per card (Save Calibration Coef.),
#              then the busy check on each port's first card
#   flashcheck 0x01000074 <- 04 per card, 1 s, busy check on the last card, then per card topology 0x03002000 + 0x03003010
# Busy check = read 0x02000200 (256 B, r2 = 9): the card is free when it answers.
CAL_IDENTITY = (2047, 0, 0, 0, 0, 2047, 0, 0, 0, 0, 2047, 0, 0, 0, 0, 2047)   # the 32-byte record, 16 LE words
CAL_SWITCH = {'off': 0x00, 'brightness': 0x03, 'chroma': 0x01}


def cal_coef(b):
    """One 32-byte coefficient record: 'flat' (identity), 'empty' (zeros: nothing loaded) or 'calibrated'."""
    if len(b) < 32: return None
    w = struct.unpack('<16H', b[:32])
    return 'flat' if w == CAL_IDENTITY else 'empty' if not any(w) else 'calibrated'


def cal_state(v):
    """0x02000051: bit0 on, bit1 brightness (0 = chroma), bit4 multi-layer / full-grayscale (CALIBRATION §5.4)."""
    if v & 0x10: return 'full-grayscale' if v & 1 else 'off'
    return 'off' if not v & 1 else 'brightness' if v & 2 else 'chroma'


def cal_busy(link, dst, port, card, tries, every):
    for k in range(tries):
        try: link.read(1, dst, port, card, 0x02000200, 256, 9, timeout=1.0); return True
        except LinkError:
            if k + 1 < tries: time.sleep(every)
    return False


def cal_ports(tg):
    out = []
    for t in tg:
        k = (int(t['dst']), int(t['port']))
        if k not in out: out.append(k)
    return out


def calib(link, body, log):
    """One Correction-tab operation: body = {op, targets: [{dst, port, index, w, h}], pairs?, mode?, whole?}."""
    op, tg, n, t0 = body['op'], body.get('targets') or [], 0, time.time()
    W = lambda d, p, c, a, b: link.write(1, int(d), int(p), int(c), a, b)
    if op == 'read':
        bk = {(q['ps'], q['pp']): (q['bs'], q['bp']) for q in body.get('pairs') or []}
        out = []
        for t in tg:
            d, p, i = int(t['dst']), int(t['port']), int(t['index']); r = {'dst': d, 'port': p, 'index': i}; at = (d, p)
            try: v = link.read(1, d, p, i, 0x02000051, 1, timeout=0.5)
            except LinkError:
                if (d, p) not in bk: r['error'] = 'no answer'; out.append(r); continue
                at = bk[(d, p)]
                try: v = link.read(1, at[0], at[1], i, 0x02000051, 1, timeout=0.5); r['via'] = 'backup'
                except LinkError: r['error'] = 'no answer'; out.append(r); continue
            r['raw'] = v[0]; r['state'] = cal_state(v[0])
            try:
                f = link.read(1, at[0], at[1], i, 0x02000220, 19)
                r['moduleFlash'] = bool(f[2] & 0x80); r['multiLayer'] = bool(f[6] & 0x40)
            except LinkError: pass
            w, h = int(t.get('w') or 0), int(t.get('h') or 0); kinds = []
            for px in ([0, (h // 2) * w + w // 2] if w and h else [0]):
                try: kinds.append(cal_coef(link.read(1, at[0], at[1], i, 0x07000000 + px * 32, 32)))
                except LinkError: pass
            kinds = [k for k in kinds if k]
            r['coef'] = None if not kinds else kinds[0] if len(set(kinds)) == 1 else 'calibrated' if 'calibrated' in kinds else 'mixed'
            out.append(r)
        log('calib read: %d cards in %.1f s' % (len(out), time.time() - t0))
        return {'ok': True, 'cards': out}
    if not tg: return {'ok': False, 'error': 'no cabinets to work on'}
    if op == 'switch':
        mode = body.get('mode')
        if mode not in CAL_SWITCH: return {'ok': False, 'error': 'unknown calibration mode %r' % mode}
        f = tg[0]
        try: base = link.read(1, int(f['dst']), int(f['port']), int(f.get('index', 0)), 0x02000051, 1)[0]
        except LinkError as e: return {'ok': False, 'error': 'the first cabinet didn’t answer (%s)' % e}
        if base & 0x10: return {'ok': False, 'error': 'full-grayscale calibration is on (0x02000051 = %02X): not switched here' % base}
        val, on = (base & 0xEC) | CAL_SWITCH[mode], mode != 'off'
        for d, p in cal_ports(tg): W(d, p, 0xFFFF, 0x02000051, bytes([val])); W(d, p, 0xFFFF, 0x010000B3, b'\x05' if on else b'\x00'); n += 2
        log('# calibration %s: 0x02000051 %02X -> %02X, 0x010000B3 <- %s on %d port(s), card all' % (mode, base, val, '05' if on else '00', n // 2))
        return {'ok': True, 'writes': n, 'value': val, 'base': base}
    if op == 'reset':
        for t in tg:
            w, h = int(t.get('w') or 0), int(t.get('h') or 0)
            if not (0 < w <= 4096 and 0 < h <= 4096): return {'ok': False, 'error': 'a cabinet has no size', 'writes': n}
            W(t['dst'], t['port'], t['index'], 0x01000024, struct.pack('<BHHHH', 2, 0, 0, w, h) + struct.pack('<16h', *CAL_IDENTITY)); n += 1
        log('# reset coefficients: 0x01000024 op 2 identity on %d card(s) in %.1f s (not saved)' % (n, time.time() - t0))
        return {'ok': True, 'writes': n}
    if op in ('reload', 'module'):
        a = 0x01000006 if op == 'reload' else 0x01000007
        for t in tg: W(t['dst'], t['port'], t['index'], a, b'\x00'); n += 1
        L = tg[-1]; free = op == 'reload' or cal_busy(link, int(L['dst']), int(L['port']), int(L['index']), 900, 0.5)
        log('# %s: 0x%08X <- 00 on %d card(s)%s' % (op, a, n, '' if free else ', the last card stayed busy'))
        return {'ok': True, 'writes': n, 'busy': not free}
    if op == 'save':
        if body.get('whole'):
            for d, p in cal_ports(tg): W(d, p, 0xFFFF, 0x01000004, b'\x00'); n += 1
        else:
            for t in tg: W(t['dst'], t['port'], t['index'], 0x01000004, b'\x00'); n += 1
        first = {}
        for t in tg: first.setdefault((int(t['dst']), int(t['port'])), int(t['index']))
        busy = [k for k, i in first.items() if not cal_busy(link, k[0], k[1], i, 600, 0.5)]
        log('# save coefficients: 0x01000004 <- 00, %d write(s)%s; %s' % (n, ' (per port, card all)' if body.get('whole') else '', 'all free' if not busy else '%d port(s) still busy' % len(busy)))
        return {'ok': not busy, 'writes': n, 'error': 'still writing flash on %d port(s)' % len(busy) if busy else None}
    if op == 'flashcheck':
        for t in tg: W(t['dst'], t['port'], t['index'], 0x01000074, b'\x04'); n += 1
        time.sleep(1.0)
        L = tg[-1]; cal_busy(link, int(L['dst']), int(L['port']), int(L['index']), 50, 0.2)
        out = []
        for t in tg:
            d, p, i = int(t['dst']), int(t['port']), int(t['index']); r = {'dst': d, 'port': p, 'index': i}; out.append(r)
            try: topo = b''.join(link.read(1, d, p, i, 0x03002000 + k, 256) for k in range(0, 4096, 256))
            except LinkError as e: r['error'] = 'no answer (%s)' % e; continue
            rows, cols = topo[2], topo[3]; m = rows * cols
            if topo[0] != 2 or topo[1] != 5 or not m or m * 16 >= 4096: r['error'] = 'no module-flash topology'; continue
            try: res = b''.join(link.read(1, d, p, i, 0x03003010 + k, min(256, m * 4 - k)) for k in range(0, m * 4, 256))
            except LinkError as e: r['error'] = 'no answer (%s)' % e; continue
            bad = []
            for k in range(m):   # column-major; topology record k + 1 sits at 16 (k + 1); result 5 = present + OK, 3 = absent
                rec = topo[16 * (k + 1):16 * (k + 2)]; there, res_k = rec[0] == 5, res[4 * k]
                if (there and res_k != 5) or (not there and res_k != 3):
                    x, y, mw, mh = struct.unpack_from('<HHHH', rec, 5)
                    bad.append({'module': k + 1, 'x': x, 'y': y, 'w': mw, 'h': mh, 'result': res_k, 'expected': 'present' if there else 'absent'})
            r.update({'modules': sum(1 for k in range(m) if topo[16 * (k + 1)] == 5), 'bad': bad})
        log('# flash check: %d card(s), %d with a fault, %.1f s' % (len(out), sum(1 for r in out if r.get('bad') or r.get('error')), time.time() - t0))
        return {'ok': True, 'writes': n, 'cards': out}
    return {'ok': False, 'error': 'unknown calibration operation %r' % op}


def calib_rest(body, log):
    """The Correction tab on Unico (VX Pro) and COEX (MX) processors. read = per cabinet the calibration switches the
    processor reports: Unico GET cabinet/info-v2 .cabinetCorrectionParam [R fields], COEX GET device/cabinet/displayparams
    + baseinfo .functionTable [R, VMP taps]. switch (Unico only) = PUT screen/correction/switch on every LED screen: the
    route and both bodies (switchMode 0 and 4, enable 0) were seen live from Unico [R UNICO_UI_TOUR §4-5]; which of 0 / 4
    is brightness-only wasn't seen live (4 = brightness, 0 = brightness + chroma, untested), so the app reads back after.
    COEX's calibration switch body was never seen live: not offered. -> {ok, cabinets: [{card, port, index, mode, armed,
    seams, moduleFlash}]} (card = output card in slot order, port / index 0-based; mode = off / brightness / chroma /
    full-grayscale / low-grayscale; armed = the type selected while the main switch is off)."""
    def sw(on, e, ms, ft):
        k = [m for f, m in (('chromaSwitchEnable', 'chroma'), ('brightnessCorrectionSwitchEnable', 'brightness'),
                             ('multilayerSwitchEnable', 'full-grayscale'), ('lowGraySwitchEnable', 'low-grayscale')) if e.get(f)]
        return {'mode': (k[0] if k else 'on') if on else 'off', 'armed': k[0] if k else None, 'seams': bool(ms),
                'moduleFlash': bool(ft.get('moduleFlash')) if ft else None}
    if body['kind'] == 'unico':
        import unicolink
        dev = unicolink.Unico(body['host'], int(body.get('port', 8088))).login(); info = dev.info()
        if body['op'] == 'switch':
            sids, m = [s['screenId'] for s in info['screens']], body.get('mode')
            if not sids: return {'ok': False, 'error': 'the processor has no LED screen'}
            b = {'screenIds': sids, 'enable': 0} if m == 'off' else {'screenIds': sids, 'enable': 1, 'switchMode': {'brightness': 4, 'chroma': 0}[m]}
            dev.put('screen/correction/switch', b); log('# calibration %s: PUT screen/correction/switch %s' % (m, json.dumps(b)))
            return {'ok': True, 'body': b}
        idx = {p['netportId']: p['index'] for p in info['ports']}; out = []
        for c in dev.get('cabinet/info-v2') or []:
            p = idx.get(c.get('netPortID'))
            if p is None: continue
            cp = c.get('cabinetCorrectionParam') or {}
            out.append(dict(sw(cp.get('correctionSwitch'), cp.get('correctionEffectSwitch') or {}, cp.get('edgecorrectionSwitch'),
                               (c.get('cabinetBaseInfo') or {}).get('functionTable')), card=0, port=p, index=c.get('cabinetIndex')))
        return {'ok': True, 'cabinets': out}
    if body['kind'] == 'coex':
        import coexlink
        if body['op'] != 'read': return {'ok': False, 'unsupported': True, 'error': 'not confirmed on COEX yet'}
        dev = coexlink.Coex(body['host'], int(body.get('port', 8001))); info = dev.info()
        pl = [{'outputCardID': c['id'], 'canvasID': c['canvasId'], 'outputIDs': c['ports']} for c in info['cards']]
        try: ft = {str(x['id']): x.get('functionTable') for x in dev.get('device/cabinet/baseinfo', {'type': 1, 'portList': pl}) or []}
        except Exception: ft = {}
        out = []
        for x in dev.get('device/cabinet/displayparams', {'type': 1, 'portList': pl}) or []:
            cid = int(x.get('cabinetID')); oid = (cid >> 16) & 0xFFFF
            ci = next((k for k, c in enumerate(info['cards']) if oid in c['ports']), None)
            if ci is None: continue
            out.append(dict(sw(x.get('correctionSwitch'), x.get('correctionEffectSwitch') or {}, x.get('edgeCorrectionSwitch'), ft.get(str(cid))),
                            card=ci, port=oid - (info['cards'][ci]['id'] << 8), index=cid & 0xFFFF))
        return {'ok': True, 'cabinets': out}
    return {'ok': False, 'error': 'unknown processor kind'}


# ------------------------------------------------------------------ HTTP helper
class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        o = self.headers.get('Origin')
        if o and origin_ok(o):
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-OpenNova-Action')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')

    def _json(self, code, obj):
        op = getattr(self, '_op', None)
        if op:   # the recorder: how the app's request ended
            self._op = None
            wirelog.op(op[0], 'end', code=code, ok=bool(obj.get('ok', code == 200)) if isinstance(obj, dict) else code == 200,
                       ms=round((time.time() - op[1]) * 1000, 1), **({'error': str(obj.get('error'))[:300]} if isinstance(obj, dict) and obj.get('error') else {}))
        w = wirelog.write_error() if isinstance(obj, dict) and 'recorderError' not in obj else None
        if w: obj = dict(obj, recorderError=w)   # the recording can't be written (disk full …): every answer says so, the app warns
        b = json.dumps(obj).encode()
        self.send_response(code); self._cors(); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

    def _bin(self, data, name):
        self.send_response(200); self.send_header('Content-Type', 'application/octet-stream')
        self.send_header('Content-Disposition', 'attachment; filename="%s"' % name); self.send_header('Content-Length', str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_GET(self):
        if self.path == '/api/hw/ping': return self._json(200, {'ok': True, 'tool': 'novalink'})
        if self.path == '/api/hw/diag/plugin':               # the Wireshark plug-in (tools/build_wireshark.py)
            with open(os.path.join(HERE, 'wireshark', 'novastar.lua'), 'rb') as f: return self._bin(f.read(), 'novastar.lua')
        if self.path.startswith('/api/hw/diag/download?'):   # a recording as .nwl (JSON lines) or .pcap (Wireshark)
            from urllib.parse import parse_qs, urlsplit
            q = parse_qs(urlsplit(self.path).query); name = (q.get('name') or [''])[0]; fmt = (q.get('fmt') or ['nwl'])[0]
            try:
                if fmt == 'pcap':
                    return self._bin(wirelog.to_pcap(wirelog.load(name)), os.path.basename(name).split('.')[0] + '.pcap')
                path = wirelog.path_of(name)
                with open(path, 'rb') as f: return self._bin(f.read(), os.path.basename(path))
            except (KeyError, OSError) as e:
                return self._json(404, {'ok': False, 'error': str(e)})
        if self.path.startswith('/api/hw/report/download?'):  # a problem report this helper made (tools/alpha.py)
            from urllib.parse import parse_qs, urlsplit
            try:
                path = alpha.report_path((parse_qs(urlsplit(self.path).query).get('name') or [''])[0])
                with open(path, 'rb') as f: return self._bin(f.read(), os.path.basename(path))
            except (KeyError, OSError) as e:
                return self._json(404, {'ok': False, 'error': str(e)})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        o = self.headers.get('Origin')
        def refuse(code, text):   # the body is read first: left unread, Windows aborts the connection and the reply is lost
            try: self.rfile.read(min(int(self.headers.get('Content-Length', 0) or 0), 1 << 20))
            except (OSError, ValueError): pass
            return self._json(code, {'error': text})
        if o is not None and not origin_ok(o): return refuse(403, 'origin not allowed')
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json': return refuse(415, 'JSON only')
        try: body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        except ValueError: return self._json(400, {'ok': False, 'error': 'the request body isn’t valid JSON'})
        if not isinstance(body, dict): return self._json(400, {'ok': False, 'error': 'the request body must be a JSON object'})
        # the app action behind this request (app-log.js: one click / menu / shortcut): on every record made while serving it
        act = str(body.pop('_action', None) or self.headers.get('X-OpenNova-Action') or '')
        act = ''.join(c for c in act if c.isalnum() or c in '-_.:')[:48]
        wirelog.set_action(act or None, body.pop('_actionWhat', None))
        try: return self._post(body)
        finally: wirelog.set_action(None)

    def _post(self, body):
        if self.path.startswith('/api/hw/diag/'): return self._diag(body)
        if self.path.startswith('/api/hw/alpha/') or self.path == '/api/hw/report': return self._alpha(body)
        if self.path.startswith('/api/hw/vendor/'): return self._vendor(body)   # Tools ▸ Vendor apps (vendortap.py): sends nothing of its own
        if self.path.startswith('/api/hw/net/'): return self._net(body)          # Settings ▸ Network (netif.py): this computer's interfaces
        no = alpha.gate(self.path, body)       # the read-only alpha: writes need the browser's unlock (tools/alpha.py)
        body.pop('alphaUnlock', None)
        self._op = (self.path, time.time()); wirelog.op(self.path, 'start', **dict(_brief(body), **({'what': wirelog.action_what()} if wirelog.action_what() else {})))
        if no: return self._json(200, no)
        lines = []; path = logfile(); stamp = datetime.datetime.now().strftime('%H:%M:%S')
        def log(s):
            lines.append(s)
            with open(path, 'a', encoding='utf-8') as f: f.write('%s %s%s %s\n' % (stamp, self.path, ' [action %s]' % wirelog.action() if wirelog.action() else '', s))   # one file a day: time + route (+ app action) per line
        try:
            if self.path == '/api/hw/simulate':
                sim = SimLink(body['plan']['senders']); n = run_plan(sim, body['plan'], log)
                # always under novalink_sim\ (a request must not pick a folder elsewhere on this PC)
                nm = os.path.basename(str(body.get('name') or '')).strip(' .') or datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
                out = os.path.join(HERE, 'novalink_sim', nm)
                dump_sim(sim, out)
                return self._json(200, {'ok': True, 'frames': n, 'out': out, 'log': path})
            if self.path == '/api/hw/run':
                log('# target %s:%s' % (body['host'], body['port']))
                link = open_link(body['host'], body.get('port'), exclusive=plan_op(body['plan']))
                try: n = run_plan(link, body['plan'], log)
                finally: link.close()
                return self._json(200, {'ok': True, 'frames': n, 'log': path, 'tail': lines[-12:]})
            if self.path == '/api/hw/discover':
                ds = discover(float(body.get('timeout', 2)), probe=body.get('probe') or ()); net_found('lct', ds)
                if not ds:   # nothing found: what the searches met (bind / send errors, the adapters searched, who holds a search port)
                    import netif
                    return self._json(200, {'ok': True, 'devices': ds, 'search': netif.search_report(owners=True)})
                return self._json(200, {'ok': True, 'devices': ds})
            if self.path == '/api/hw/links':                 # the link pool: open connections; close = close the unused ones now
                closed = close_links(0, body.get('target')) if body.get('close') else []
                return self._json(200, {'ok': True, 'links': links_status(), 'closed': closed,
                                        'proxies': [{k: v for k, v in p.items() if k != 'sock'} for p in PROXIES.values()]})
            if self.path == '/api/hw/proxy':                 # optional proxy port (off by default): on = start, else stop
                if body.get('on'): return self._json(200, {'ok': True, 'listen': proxy_start(body['host'], body.get('port'), int(body.get('listen') or 0))})
                return self._json(200, {'ok': True, 'stopped': proxy_stop(body.get('listen'))})
            if self.path == '/api/hw/serial-ports':          # USB / serial COM ports; probe = ask each for a controller (read-only)
                ports = serial_ports()
                if body.get('usbOnly'): ports = []          # the background search: only NovaStar's own USB device is asked
                if body.get('probe'): ports = probe_serial_all(ports, float(body.get('timeout', 1)))
                usb, uerr = usb_devices()                    # NovaStar's own USB device (libusb; descriptors only)
                if body.get('probe') and usb: usb = [probe_usb(d, float(body.get('timeout', 1))) for d in usb]
                return self._json(200, {'ok': True, 'ports': ports, 'novaUsb': nova_usb(), 'usb': usb, 'usbError': uerr})
            if self.path.startswith('/api/hw/hweb/'):       # the H series' own web API (tools/hweb.py): login kept on this computer only
                import hweb                                  # (nothing of the login goes into the log or the recorder: see _brief)
                try:
                    if self.path == '/api/hw/hweb/login': return self._json(200, hweb.login(body.get('host'), body.get('username'), body.get('password')))
                    if self.path == '/api/hw/hweb/info': return self._json(200, hweb.info(body.get('host')))
                    if self.path == '/api/hw/hweb/forget': return self._json(200, {'ok': True, 'removed': hweb.forget(body.get('host'))})
                except hweb.HWebError as e: return self._json(200, {'ok': False, 'error': str(e)})
                return self._json(404, {'ok': False, 'error': 'not found'})
            if self.path == '/api/hw/info':                  # the cascaded sending cards behind one link, with ModelIDs
                link = open_link(body['host'], body.get('port'))
                try:   # answered after close(): a request the link pool refused answers "busy" (PooledLink.close)
                    ss = senders_on(link)
                    r = {'ok': True, 'senders': ss} if not body.get('functions') else {'ok': True, 'senders': ss, 'functions': [
                        {'error': 'not a sending card (%s)' % NON_LED_CARDS[s]} if s in NON_LED_CARDS else sender_functions(link, d) for d, s in enumerate(ss)]}
                finally: link.close()
                return self._json(200, r)
            if self.path == '/api/hw/detect':
                log('# detect %s:%s' % (body['host'], body['port']))
                link = open_link(body['host'], body.get('port'))
                try: r = detect(link, body['cards'], log, float(body.get('probeTimeout', 0.5)), known=body.get('known'),
                                key='%s:%s' % (body['host'], body['port']), pairs=body.get('pairs'))
                finally: link.close()
                return self._json(200, {'ok': True, 'cards': r, 'log': path, 'tail': lines[-12:]})
            if self.path == '/api/hw/health':
                link = open_link(body['host'], body.get('port'))
                try: r = health(link, body['cards'], body.get('pairs'), body.get('known'), log, float(body.get('probeTimeout', 0.5)), bool(body.get('extras')))
                finally: link.close()
                return self._json(200, {'ok': True, 'health': r})
            if self.path == '/api/hw/ber-clear':             # the user's Clear: bit-error counters to 0 (0x01000076 <- 05), no save
                log('# clear errors %s:%s, %s' % (body['host'], body.get('port'), '%d card(s)' % len(body['targets']) if body.get('targets') else 'all cards'))
                link = open_link(body['host'], body.get('port'), exclusive='clearing the error counters')
                try: n, bad = ber_clear(link, body.get('targets'), log)
                finally: link.close()
                return self._json(200, {'ok': n > 0 or not bad, 'written': n, 'failed': bad, 'error': None if n or not bad else 'no card answered', 'tail': lines[-12:]})
            if self.path == '/api/hw/gamma':                 # gamma to receiving cards (16-bit cards only), no save
                link = open_link(body['host'], body.get('port'), exclusive='a gamma change')
                try: n, ports, skipped = set_gamma(link, body['targets'], float(body.get('gamma') or 0), log, body.get('tables'))
                finally: link.close()
                return self._json(200, {'ok': True, 'frames': n, 'ports': ports, 'skipped': skipped, 'tail': lines[-6:]})
            if self.path == '/api/hw/color-read':            # what the cards hold now (brightness, gamma, R/G/B, colour space), read-only
                link = open_link(body['host'], body.get('port'))
                try: r = color_read(link, body['targets'], log)
                finally: link.close()
                return self._json(200, {'ok': True, 'ports': r})
            if self.path == '/api/hw/read-layout':          # the screen layout each sending card holds (read-only)
                link = open_link(body['host'], body.get('port'))
                try: r = read_layout(link, body.get('senders') or 1)
                finally: link.close()
                return self._json(200, {'ok': True, 'cards': r})
            if self.path == '/api/hw/read-backup':           # port pairs (REDU) + device-backup roles, read-only
                link = open_link(body['host'], body.get('port'))
                try: r = read_backup(link, body.get('senders') or 1)
                finally: link.close()
                return self._json(200, dict(r, ok=True))
            if self.path == '/api/hw/nprj':                  # read a VMP project file (tools/vmpproject.py), no device involved
                import base64, vmpproject
                return self._json(200, dict(vmpproject.parse(base64.b64decode(body['data'])), ok=True))
            if self.path == '/api/hw/support':               # support bundle: the helper's newest logs, this run's recordings, versions (read-only)
                import platform, glob as _g
                d = alpha.LOG_DIR
                # names are timestamps (YYYYMMDD_HHMMSS.txt): newest by name, one listing — no per-file stat over the share
                files = [os.path.join(d, n) for n in sorted((n for n in os.listdir(d) if n.endswith('.txt')), key=lambda n: n[:-4] if '_' in n else n[:-4] + '_999999', reverse=True)[:int(body.get('files') or 15)]]
                out = []
                for f in files:
                    with open(f, 'rb') as fh:
                        b = fh.read()
                    out.append({'name': os.path.basename(f), 'text': b[-400000:].decode('utf-8', 'replace')})   # the end of a long log
                tools = {os.path.basename(f): datetime.datetime.fromtimestamp(os.path.getmtime(f)).isoformat(timespec='seconds')
                         for f in _g.glob(os.path.join(HERE, '*.py'))}
                rec = wirelog.session() if body.get('recordings', True) else []   # this run's diagnostics recording(s)
                return self._json(200, {'ok': True, 'logs': out, 'python': sys.version.split()[0], 'platform': platform.platform(), 'tools': tools, 'version': alpha.version_line(),
                                        'recordings': rec, 'recorder': wirelog.status()})
            if self.path == '/api/hw/calib':                 # Correction tab: calibration state + the kept operations (see calib)
                if body.get('kind') in ('unico', 'coex'): return self._json(200, dict(calib_rest(body, log), log=path, tail=lines[-12:]))
                log('# target %s:%s, calibration %s' % (body['host'], body.get('port'), body.get('op')))
                link = open_link(body['host'], body.get('port'), exclusive=None if body.get('op') == 'read' else 'calibration %s' % body.get('op'))
                try: r = calib(link, body, log)
                finally: link.close()
                return self._json(200, dict(r, log=path, tail=lines[-12:]))
            if self.path == '/api/hw/identify':              # read-only card identity for the .rcfgx / NCP guard
                link = open_link(body['host'], body.get('port'))
                try: r = identify(link, body['chains'], log, bool(body.get('full')), body.get('pairs'), float(body.get('probeTimeout', 0.5)))
                finally: link.close()
                return self._json(200, {'ok': True, 'cards': r})
            if self.path == '/api/hw/rcv-send':              # .rcfgx replay to receiving cards (after the app's file guard)
                import base64
                log('# receiving-card file %s -> %s:%s, %d target(s); guard %s' % (body.get('name'), body['host'], body['port'], len(body['targets']), body.get('verdict')))
                link = open_link(body['host'], body.get('port'), exclusive='a receiving-card file send')
                try: n = rcv_send(link, base64.b64decode(body['data']), body.get('name', ''), body['targets'], log, body.get('cabinet') or 0)
                finally: link.close()
                return self._json(200, {'ok': True, 'frames': n, 'log': path, 'tail': lines[-12:]})
            if self.path.startswith('/api/rcv/'):            # receiving-card files: what a file is for + the guard (rcvfile / rcvguard)
                import base64, rcvfile, rcvguard
                if self.path == '/api/rcv/identity':
                    r = rcvfile.identity(base64.b64decode(body['data']), body.get('name', ''))
                    return self._json(200, dict(r, ok=True, fileOk=r['ok']))
                if self.path.startswith('/api/rcv/lib/'):   # the shared file library (tools/rcvlib.py)
                    import rcvlib
                    if self.path == '/api/rcv/lib/list':
                        es = rcvlib.entries()
                        return self._json(200, {'ok': True, 'files': es, 'conflicts': rcvlib.conflicts(), 'folder': rcvlib.LIB_DIR})
                    if self.path == '/api/rcv/lib/add':
                        r = rcvlib.add(base64.b64decode(body['data']), body.get('name', ''))
                        log('# library add %s: %s' % (body.get('name'), 'duplicate' if r.get('duplicate') else r.get('error') or 'ok'))
                        return self._json(200, r)
                    if self.path == '/api/rcv/lib/get':
                        data, name = rcvlib.get(body['id'])
                        return self._json(200, {'ok': True, 'name': name, 'data': base64.b64encode(data).decode('ascii')})
                    if self.path == '/api/rcv/lib/remove':
                        log('# library remove %s' % body.get('id'))
                        return self._json(200, {'ok': rcvlib.remove(body['id'])})
                    if self.path == '/api/rcv/lib/match':
                        return self._json(200, {'ok': True, 'match': rcvlib.match(body.get('cards') or [], body.get('family') or 'lct')})
                    return self._json(404, {'ok': False, 'error': 'not found'})
                if self.path == '/api/rcv/check':
                    fid = rcvfile.identity(base64.b64decode(body['data']), body.get('name', ''))
                    v = rcvguard.check(fid, int(body.get('cabinet') or 0), body.get('cards') or [], body.get('family') or 'lct')
                    return self._json(200, {'ok': True, 'verdict': v, 'file': fid})
            if self.path.startswith('/api/unico/'):          # Unico-family processors (VX Pro …): tools\unicolink.py
                import unicolink
                r = unicolink.handle(self.path, body, log); r.setdefault('log', path); r.setdefault('tail', lines[-12:])
                if self.path == '/api/unico/discover': net_found('unico', r.get('devices'))
                return self._json(200, r)
            if self.path.startswith('/api/coex/'):           # COEX controllers (MX / CX): tools\coexlink.py
                import coexlink
                r = coexlink.handle(self.path, body, log); r.setdefault('log', path); r.setdefault('tail', lines[-12:])
                if self.path == '/api/coex/discover': net_found('coex', r.get('devices'))
                return self._json(200, r)
            self._json(404, {'error': 'not found'})
        except Exception as e:
            log('ERROR: %s' % e)
            extra = {'busy': True} if isinstance(e, LinkBusy) else {}
            if not isinstance(e, LinkError):     # a bug, not a device answer: keep where it happened (log + recorder)
                import traceback
                tb = traceback.format_exc().rstrip().splitlines()
                for ln in tb[-8:]: log('  ' + ln)
                wirelog.record('err', link='helper', error='%s %s: %s' % (self.path, type(e).__name__, e), where=tb[-7:])
                alpha.on_error(self.path, _brief(body), e, tb[-12:])   # a first-contact snapshot: what led to it
                if alpha.unexpected(e): extra = {'internal': True, 'where': tb[-7:]}   # the app offers a report (app-alpha.js)
            self._json(500, dict({'ok': False, 'error': str(e), 'log': path, 'tail': lines[-12:]}, **extra))

    def _diag(self, body):
        """Diagnostics (the recorder, tools/wirelog.py): status, live frames, recordings, notes, capture import."""
        try:
            p = self.path
            if p == '/api/hw/diag/status': return self._json(200, wirelog.status())
            if p == '/api/hw/diag/frames':
                return self._json(200, {'ok': True, 'seq': wirelog.status()['seq'], 'frames': wirelog.frames(int(body.get('since', 0)), int(body.get('limit', 500)))})
            if p == '/api/hw/diag/files': return self._json(200, {'ok': True, 'dir': wirelog.DIAG_DIR, 'files': wirelog.files()})
            if p == '/api/hw/diag/load':
                rs = wirelog.load(body['name'], int(body.get('limit', 200000)))
                return self._json(200, {'ok': True, 'name': body['name'], 'total': len(rs), 'frames': rs[int(body.get('offset', 0)):int(body.get('offset', 0)) + int(body.get('max', 20000))]})
            if p == '/api/hw/diag/mark': return self._json(200, {'ok': True, 'mark': wirelog.mark(body.get('text', ''), body.get('source', 'user'))})
            if p == '/api/hw/diag/enable':                   # the alpha's recorder can't be switched off (it says so)
                if alpha.info()['alpha'] and not body.get('on', True): return self._json(200, dict(wirelog.status(), refused='the alpha always records'))
                return self._json(200, wirelog.set_enabled(body.get('on', True)))
            if p == '/api/hw/diag/import':                   # a Wireshark / tcpdump capture, decoded and kept
                import base64
                import usbcap                            # a USBPcap capture (link type 249): NovaStar's USB device
                data = base64.b64decode(body['data'])
                rs = usbcap.from_pcap(data) if usbcap.is_usbpcap(data) else wirelog.from_capture(data)
                name = wirelog.save_import(body.get('name') or 'capture', rs)
                return self._json(200, {'ok': True, 'name': name, 'total': len(rs), 'frames': rs[:20000]})
            if p == '/api/hw/diag/open-folder':             # this computer only (the helper listens on 127.0.0.1)
                import subprocess
                d = wirelog.DIAG_DIR; os.makedirs(d, exist_ok=True)
                subprocess.Popen(['explorer', d] if sys.platform == 'win32' else ['open' if sys.platform == 'darwin' else 'xdg-open', d])
                return self._json(200, {'ok': True, 'dir': d})
            return self._json(404, {'ok': False, 'error': 'not found'})
        except (KeyError, ValueError, OSError) as e:
            return self._json(400, {'ok': False, 'error': str(e)})

    def _alpha(self, body):
        """The alpha's own calls (tools/alpha.py): version / state, the tester's consent, first-contact snapshots, the
        problem report and its folder. Never reaches a processor."""
        try:
            p = self.path
            if p == '/api/hw/alpha/state': return self._json(200, alpha.state())
            if p == '/api/hw/alpha/set': return self._json(200, alpha.set_settings(body))
            if p == '/api/hw/alpha/mark':                    # unlock / lock and other alpha events, into the recording (never a code)
                return self._json(200, {'ok': True, 'mark': wirelog.mark(str(body.get('text', ''))[:300], 'alpha')})
            if p == '/api/hw/alpha/refused': return self._json(200, alpha.note_refused(body))   # a write the app refused itself
            if p == '/api/hw/alpha/first-contact':
                return self._json(200, alpha.first_contact(body.get('key') or 'unknown', body.get('reason') or '', body.get('data'), body.get('host'), body.get('family') or ''))
            if p == '/api/hw/report': return self._json(200, alpha.build_report(body))
            if p == '/api/hw/alpha/reveal':                  # this computer only (the helper listens on 127.0.0.1)
                path = alpha.report_path(body['name']) if body.get('name') else alpha.report_dir()
                alpha.reveal(path); return self._json(200, {'ok': True, 'path': path})
            return self._json(404, {'ok': False, 'error': 'not found'})
        except Exception as e:  # noqa: BLE001 - answered as JSON; a bug is kept like any other helper bug
            if not isinstance(e, (KeyError, ValueError, OSError)):
                import traceback
                wirelog.record('err', link='helper', error='%s %s: %s' % (self.path, type(e).__name__, e), where=traceback.format_exc().rstrip().splitlines()[-7:])
            return self._json(400, {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})

    def _net(self, body):
        """Settings ▸ Network (tools/netif.py): the interfaces (name, type, addresses, up, searched, processors last found
        on each), this computer's settings, the hot-plug changes. Never reaches a processor."""
        import netif
        try:
            p = self.path
            if p == '/api/hw/net/state': return self._json(200, dict(netif.state(), ok=True))
            if p == '/api/hw/net/set':
                ch = {k: body[k] for k in ('disabled', 'bind') if k in body}
                st = netif.save_settings(ch)
                wirelog.mark('Settings > Network: %s' % ', '.join('%s %s' % (k, v) for k, v in sorted(ch.items())), 'net')
                return self._json(200, dict(net_info(body.get('appPort')), ok=True, settings=st))
            if p == '/api/hw/net/interfaces': return self._json(200, dict(net_info(body.get('appPort'), bool(body.get('fresh'))), ok=True))
            return self._json(404, {'ok': False, 'error': 'not found'})
        except (KeyError, ValueError, TypeError, OSError) as e:
            return self._json(400, {'ok': False, 'error': str(e)})

    def _vendor(self, body):
        """Tools ▸ Vendor apps (tools/vendortap.py): NovaStar's apps here, their logs, Wireshark captures, the experimental relay.
        Open Nova sends nothing of its own to a processor here; the relay passes on the vendor app's bytes unchanged."""
        try:
            import vendortap
            return self._json(200, vendortap.handle(self.path, body))
        except Exception as e:  # noqa: BLE001 - answered as JSON; a bug is kept like any other helper bug
            if not isinstance(e, (KeyError, ValueError, OSError)):
                import traceback
                wirelog.record('err', link='helper', error='%s %s: %s' % (self.path, type(e).__name__, e), where=traceback.format_exc().rstrip().splitlines()[-7:])
            return self._json(400, {'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})

    def log_message(self, *a): pass


# ------------------------------------------------------------------ networks (Settings > Network, hot-plug)
NET_FOUND = {}   # interface name -> {ip: {'kind', 'at'}}: what the searches of the last 10 minutes found on it


def net_found(kind, entries):
    """Remember which interface each processor a search found answered on (for Settings > Network and the report)."""
    now = time.time()
    for x in entries or ():
        n = x.get('iface')
        if n and x.get('ip'): NET_FOUND.setdefault(n, {})[x.get('addr') or x['ip']] = {'kind': kind, 'at': now}


def net_info(app_port=None, fresh=False):
    """/api/hw/net/interfaces: every interface (no MAC) with searched / found, the settings, what the app server on
    app_port listens on now (written by serve.py / serve.ps1 at start), the bind the settings ask for, the changes."""
    import netif
    ifs, st = netif.interfaces(fresh), netif.load_settings()
    now, off = time.time(), set(st['disabled'])
    out = []
    for i in ifs:
        f = {ip: v for ip, v in (NET_FOUND.get(i['name']) or {}).items() if now - v['at'] < 600}
        out.append(dict({k: v for k, v in i.items() if k != 'mac'}, search=i['name'] not in off and i['type'] != 'loopback',
                        found=[{'ip': ip, 'kind': v['kind']} for ip, v in sorted(f.items())]))
    try: port = int(app_port or 0)
    except (TypeError, ValueError): port = 0
    return {'interfaces': out, 'settings': st, 'plan': netif.bind_plan(), 'applied': netif.load_applied(port) if port else None,
            'platform': sys.platform, 'state': netif.state(), 'saved': bool(netif.config_dir())}


def net_changes(ev):
    """Hot-plug changes (netif.poll) -> the helper's log, the recording (a conn record, link "net:<interface>"), and the
    pooled connections that went out of an address that's gone (closed when unused; a request on one fails and reconnects)."""
    for e in ev:
        wirelog.conn('net:%s' % e['name'], 'interface %s' % e['text'], via=', '.join(e['ips']) or None)
        try:
            with open(logfile(), 'a', encoding='utf-8') as f: f.write('%s network: %s\n' % (datetime.datetime.now().strftime('%H:%M:%S'), e['text']))
        except OSError: pass
        if e['event'] == 'removed': NET_FOUND.pop(e['name'], None)
        for sh in list(_POOL.values()):
            if e['gone'] and sh.raw is not None and getattr(sh.raw, 'local', None) in e['gone']: close_links(0, sh.key, 'interface %s' % e['text'])


def net_watch(every=None):
    """A thread of the serving helper: the interfaces every netif.POLL s. One that appears (a USB Ethernet adapter, Wi-Fi
    joining, a VPN) is searched on by the next search without a restart; one that goes away is dropped from it."""
    import netif
    netif.poll()
    while True:
        time.sleep(every or netif.POLL)
        try: net_changes(netif.poll())
        except Exception as e:  # noqa: BLE001 - the watcher never stops
            wirelog.record('err', link='helper', error='network watch: %s: %s' % (type(e).__name__, e))


def _brief(body):
    """What the app asked for, without the bulky parts (file data, plans, layouts), for the recorder's op line."""
    out = {}
    for k, v in (body or {}).items():
        if k in ('password', 'username', 'token'): out[k] = '<hidden>'   # an H web login (hweb.py) is never recorded
        elif k in ('data', 'json'): out[k] = '<%d chars>' % len(str(v))
        elif isinstance(v, (str, int, float, bool)) or v is None: out[k] = v if not isinstance(v, str) else v[:120]
        elif isinstance(v, list): out[k] = '<%d items>' % len(v)
        elif isinstance(v, dict): out[k] = '<%s>' % ', '.join('%s %s' % (kk, len(vv) if isinstance(vv, (list, dict)) else vv) for kk, vv in list(v.items())[:6])
    return {'req': out}


def main(argv):
    if not argv or argv[0] in ('-h', '--help'): print(__doc__); return 0
    cmd = argv[0]; args = dict(zip(argv[1::2], argv[2::2])) if cmd == 'serve' else dict(zip(argv[2::2], argv[3::2]))
    if cmd == 'serve':
        port = int(args.get('--port', 8790))
        for x in (args.get('--app-port', '') + ',' + os.environ.get('OPENNOVA_APP_PORTS', '')).split(','):   # the app server's port(s)
            if x.strip().isdigit() and int(x) not in APP_PORTS: APP_PORTS.append(int(x))
        origin_ok('')                              # the allowed origins, from this computer's addresses now
        host = args.get('--host', '127.0.0.1')     # 0.0.0.0 = also from other devices (the app served on this PC's network address)
        wirelog.HEADER['text'] = '%s · helper pid %d · Python %s · %s' % (alpha.version_line(), os.getpid(), sys.version.split()[0], sys.platform)
        try: alpha.prune()                          # the alpha keeps keepDays / keepMB of recordings (version.json); not in dev
        except OSError: pass
        alpha.prune_daily()
        print('novalink helper on http://%s:%d — %s%s' % (host, port, alpha.version_line(), ' · read-only until unlocked' if alpha.read_only() else '')); sys.stdout.flush()
        threading.Thread(target=net_watch, daemon=True).start()   # interfaces that come and go (USB Ethernet, Wi-Fi, VPN)
        import usbauto                             # NovaStar USB controllers: Open Nova and NovaLCT both, recorded (Windows)
        threading.Thread(target=usbauto.run, daemon=True).start()
        import netcap                              # NovaLCT / VMP / Unico on the network: recorded, passively (pktmon / tcpdump)
        threading.Thread(target=netcap.run, daemon=True).start()
        try: srv = ThreadingHTTPServer((host, port), Handler)
        except OSError as e:   # one line, no traceback (opennova.py picks a free port first: this is a race or a start by hand)
            taken = e.errno in (errno.EADDRINUSE, errno.EACCES) or getattr(e, 'winerror', None) in (10048, 10013)
            print("The hardware helper can't use port %d: %s. Start it with --port <another port>." % (port, 'another program is using it' if taken else e))
            return 1
        if os.environ.get('OPENNOVA_STARTUP_TRACE'): import faulthandler; faulthandler.cancel_dump_traceback_later()   # it started
        srv.serve_forever(); return 0
    if cmd == 'serial':                                  # serial [--probe 1]: USB / serial ports, which answer (read-only)
        a = dict(zip(argv[1::2], argv[2::2]))
        for p in (probe_serial_all(None, float(a['--probe'])) if '--probe' in a else serial_ports()):
            print('%-28s %-10s %s' % (p['name'], p.get('driver', ''), ('ModelID 0x%04X at %d baud -> --host %s' % (p['modelId'], p['baud'], p['host'])) if p.get('answered')
                                       else p.get('error', 'busy (Open Nova is using it)' if p.get('busy') else '' if '--probe' in a else 'not asked')))
        usb, uerr = usb_devices()
        for d in ([probe_usb(x, float(a['--probe'])) for x in usb] if '--probe' in a else usb):
            print('%-28s %-10s %s' % (d['host'], 'if%d %s EP %02X/%02X %dB' % (d['iface'], 'FF/06/50' if d['matched'] else '?', d['epOut'], d['epIn'], d['maxPacket']),
                                       ('ModelID 0x%04X -> --host %s' % (d['modelId'], d['host'])) if d.get('answered')
                                       else d.get('error', 'busy (Open Nova is using it)' if d.get('busy') else '' if '--probe' in a else 'not asked')))
        if uerr and nova_usb(): print('NovaStar USB device 0483:5720 is here, but: %s' % uerr)
        return 0
    if cmd == 'discover':
        for d in discover(): print('%s  links %s  %s' % (d['ip'], d['links'], d['text']))
        return 0
    if cmd == 'detect':                                  # detect --host H --port P [--cards 0:20,1:20] [--probe 0.5]
        a = dict(zip(argv[1::2], argv[2::2])); link = open_link(a['--host'], a.get('--port'))
        try:
            cards = [{'dst': int(x.split(':')[0]), 'ports': int(x.split(':')[1])} for x in a['--cards'].split(',')] if '--cards' in a                 else [{'dst': i, 'ports': 20} for i in range(len(senders_on(link)))]
            detect(link, cards, print, float(a.get('--probe', 0.5)))
        finally: link.close()
        return 0
    plan = json.load(open(argv[1], encoding='utf-8'))
    if cmd == 'sim':
        sim = SimLink(plan['senders']); run_plan(sim, plan, print); dump_sim(sim, args['--out']); return 0
    if cmd == 'run':
        path = args.get('--log') or logfile()
        def log(s):
            print(s)
            with open(path, 'a', encoding='utf-8') as f: f.write(s + '\n')
        link = open_link(args['--host'], args.get('--port'), exclusive=plan_op(plan))
        try: run_plan(link, plan, log)
        finally: link.close()
        return 0
    print(__doc__); return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
