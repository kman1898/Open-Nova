"""Tests for novalink's link pool (one persistent connection per target, shared by every request) against stand-in
controllers that accept only ONE TCP connection at a time, as a VX1000 does (a second one is closed at once and counted):
many requests at once through the helper's HTTP routes (detect + health + read-layout + info + a long Send), no second
connection ever, the Send's frames never interleaved with anyone else's, a drop (between requests and mid-exchange) ->
reconnect, an exclusive operation making new requests "busy" while running ones pause, two targets in parallel, idle
close, refused targets, and the optional proxy port. No real hardware.
    python -I tools/test_linkpool.py   (exit 0 = all passed)
"""
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import urllib.request
import urllib.error

TMP = tempfile.mkdtemp(prefix='opennova_linkpool_test_')
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


class Fake:
    """A single-connection controller: sender memory (dev 0, read / write), receiving cards (dev 1) on ports 1-2, three
    each (128 x 128, 30 °C, 5.0 V), silence past them. Ports 1-2 linked (0x02000000 +31). latency s per frame.
    kill_on: read addresses that make it drop the connection instead of answering ({addr: how many times})."""
    def __init__(self, latency=0.002):
        self.srv = socket.socket(); self.srv.bind(('127.0.0.1', 0)); self.srv.listen(8)
        self.port = self.srv.getsockname()[1]
        self.latency, self.mem, self.log, self.kill_on = latency, {}, [], {}
        self.accepted = self.rejected = self.live = 0
        self.cur, self.lock = None, threading.Lock()
        self.page(0, 0x02000000)[31] = 0x03
        threading.Thread(target=self.accept, daemon=True).start()

    def page(self, dst, addr):
        return self.mem.setdefault((dst, addr & 0xFFFF0000), bytearray(65536))

    def accept(self):
        while True:
            try: c, _ = self.srv.accept()
            except OSError: return
            with self.lock:
                if self.live: self.rejected += 1; c.close(); continue    # one connection only: the second is dropped
                self.live = 1; self.accepted += 1; self.cur = c; conn = self.accepted
            threading.Thread(target=self.serve, args=(c, conn), daemon=True).start()

    def kick(self):
        try: self.cur.shutdown(socket.SHUT_RDWR)
        except OSError: pass

    def answer(self, f):
        dst, dev, port, card = f[5], f[6], f[7], struct.unpack_from('<H', f, 8)[0]
        op, addr, n = f[10], struct.unpack_from('<I', f, 12)[0], struct.unpack_from('<H', f, 16)[0]
        if dev == 0:
            if dst not in (0, 0xFF): return b''                       # one sending card
            if op == 1:
                for d in ([0] if dst == 0xFF else [dst]):
                    for i, b in enumerate(f[18:18 + n]): a = addr + i; self.page(d, a)[a & 0xFFFF] = b
                return reply(f)
            pg = self.page(0 if dst == 0xFF else dst, addr); o = addr & 0xFFFF
            return reply(f, data=bytes(pg[o:o + n]))
        if op == 1: return reply(f)
        if port not in (0, 1) or card >= 3: return b''
        b = bytearray(n)
        if addr == 0x02000000 and n > 0x1B: b[0x17], b[0x19] = 128, 128
        if addr == 0x0A000000 and n >= 4: b[0:4] = bytes([0x80, 60, 0, 0x80 | 50])
        return reply(f, data=bytes(b))

    def serve(self, c, conn):
        buf = b''
        try:
            while True:
                try: d = c.recv(65536)
                except OSError: break
                if not d: break
                buf += d
                while len(buf) >= 20:
                    n = 20 + (struct.unpack_from('<H', buf, 16)[0] if buf[10] == 1 else 0)
                    if len(buf) < n: break
                    f, buf = buf[:n], buf[n:]
                    addr = struct.unpack_from('<I', f, 12)[0]
                    with self.lock: self.log.append((conn, f[6], f[10], addr, f[3]))
                    if f[10] == 0 and self.kill_on.get(addr): self.kill_on[addr] -= 1; raise ConnectionAbortedError
                    if self.latency: time.sleep(self.latency)
                    r = self.answer(f)
                    if r: c.sendall(r)
        except OSError: pass
        finally:
            c.close()
            with self.lock: self.live = 0


http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
hs = novalink.ThreadingHTTPServer(('127.0.0.1', 0), novalink.Handler); threading.Thread(target=hs.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % hs.server_address[1]


def post(path, body):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {'Content-Type': 'application/json'})
    try: return json.loads(http.open(req, timeout=120).read())
    except urllib.error.HTTPError as e: return json.loads(e.read())


def conns(tag):
    return [r['event'] for r in wirelog.frames(0, 100000) if r.get('kind') == 'conn' and r.get('link') == tag]


# ------------------------------------------------------------------ many requests at once, one connection
A = Fake(0.003)
H = {'host': '127.0.0.1', 'port': A.port}
CARDS = [{'dst': 0, 'ports': 4}]
KNOWN = {'0:0': [{'w': 128, 'h': 128, 'name': ''}] * 3, '0:1': [{'w': 128, 'h': 128, 'name': ''}] * 3}
screen = json.dumps({'ScreenDataInSoftSpace': [{'ScreenIndex': 0, 'Cabinets': list(range(40))}]})
SEND = {'senders': 1, 'ops': [{'op': 'note', 'text': 'fake send'}, {'op': 'nssd', 'dst': 0, 'json': screen}] +
        [{'op': 'w', 'dev': 0, 'dst': 0, 'port': 0, 'card': 0, 'addr': 0x02000100, 'hex': '%02x' % (i & 0xFF)} for i in range(250)]}
ok(novalink.plan_op(SEND) == 'a send' and novalink.plan_op({'ops': [{'op': 'r'}, {'op': 'note'}]}) is None and
   novalink.plan_op({'ops': [{'op': 'w'}], 'waitMs': 5000}) == 'a save', 'plan_op: send / read-only / save')

res, errs = {}, []
def job(name, path, body, delay=0.0):
    time.sleep(delay)
    r = post(path, dict(H, **body)); res[name] = r
    if not r.get('ok'): errs.append('%s: %s' % (name, r.get('error')))
jobs = [('send', '/api/hw/run', {'plan': SEND}, 0.15)]
for k in range(4):
    jobs += [('detect%d' % k, '/api/hw/detect', {'cards': CARDS}, 0.05 * k),
             ('health%d' % k, '/api/hw/health', {'cards': CARDS, 'known': KNOWN}, 0.05 * k),
             ('layout%d' % k, '/api/hw/read-layout', {'senders': 1}, 0.05 * k),
             ('info%d' % k, '/api/hw/info', {}, 0.05 * k)]
ts = [threading.Thread(target=job, args=j) for j in jobs]
t0 = time.time()
for t in ts: t.start()
for t in ts: t.join(120)
ok(not errs, 'detect + health + read-layout + info + a long Send at once: all succeed (%.1f s) %s' % (time.time() - t0, errs[:3]))
ok(A.accepted == 1 and A.rejected == 0, 'one connection for all of them, never a second (accepted %d, refused %d)' % (A.accepted, A.rejected))
d0 = res.get('detect0', {}).get('cards', [{}])[0].get('ports', {})
ok(len(d0.get('0', [])) == 3 and len(d0.get('1', [])) == 3, 'detect found 3 + 3 cabinets while sharing the link')
ok(all(c['temp'] == 30.0 for c in res.get('health0', {}).get('health', {}).get('cabinets', [])) and len(res['health0']['health']['cabinets']) == 6, 'health read all 6 cabinets')
ok(res.get('info0', {}).get('senders') == [0], 'info: sending card 0 (ModelID 0 in the fake memory)')
send_at = [i for i, x in enumerate(A.log) if x[1] == 0 and x[2] == 1 and (x[3] >> 16) in (0x0500, 0x0200) and x[3] != 0x01000000]
inside = A.log[send_at[0]:send_at[-1] + 1] if send_at else []
ok(len(send_at) > 250 and all(x[1] == 0 and x[2] == 1 for x in inside), "the Send's %d frames are never interleaved with another request's" % len(send_at))
sers = [x[4] for x in A.log]
ok(all(sers[i] != sers[i + 1] for i in range(len(sers) - 1)), 'serial numbers run on across requests on the one link (%d frames)' % len(sers))
lay = post('/api/hw/read-layout', dict(H, senders=1))
ok(lay.get('ok') and lay['cards'][0].get('screens', [{}])[0].get('Cabinets') == list(range(40)), 'read-layout after the Send reads back what it wrote')
st = post('/api/hw/links', {})
me = [x for x in st.get('links', []) if x['target'] == '127.0.0.1:%d' % A.port]
ok(me and me[0]['open'] and me[0]['users'] == 0 and me[0]['opens'] == 1 and not me[0]['exclusive'], '/api/hw/links: open, nobody holding it, opened once')
ev = conns('127.0.0.1:%d' % A.port)
ok(ev.count('open') == 1 and 'exclusive: a send' in ev and 'exclusive end' in ev, 'recorder: one open, the exclusive hold and its end (%s)' % ev[:6])

# ------------------------------------------------------------------ exclusive: new requests busy, running ones pause
novalink.BUSY_WAIT = 0.4
early = novalink.open_link('127.0.0.1', A.port)
early.read(0, 0, 0, 0, 0x02000000, 4)
ex = novalink.open_link('127.0.0.1', A.port, exclusive='a send')
paused = []
def run_early():
    t = time.time(); early.read(0, 0, 0, 0, 0x02000000, 4); paused.append(time.time() - t)
th = threading.Thread(target=run_early, daemon=True); th.start()
t0 = time.time(); r = post('/api/hw/health', dict(H, cards=CARDS, known=KNOWN)); dt = time.time() - t0
ok(not r.get('ok') and r.get('busy') and 'busy: a send is running on 127.0.0.1:%d' % A.port in r.get('error', '') and dt < 2.0,
   'a new request during an exclusive operation: "busy" after %.1f s (%s)' % (dt, r.get('error')))
try: novalink.open_link('127.0.0.1', A.port, exclusive='a save', wait=0.3); ok(False, 'a second exclusive operation waits, then busy')
except novalink.LinkBusy as e: ok('a send is running' in str(e), 'a second exclusive operation waits, then busy (%s)' % e)
for i in range(5): ex.write(0, 0, 0, 0, 0x02000100, b'\x01')
time.sleep(0.6)
ok(not paused, 'a request that was already running pauses (no frame between the operation\'s frames)')
ex.close(); th.join(3); early.close()
ok(paused and paused[0] >= 0.5, 'and goes on when the operation ends (waited %.1f s)' % (paused[0] if paused else -1))
ok(post('/api/hw/info', H).get('ok'), 'after it, requests run again')
novalink.BUSY_WAIT = 3.0

# ------------------------------------------------------------------ drops: between requests, mid-exchange
A.kick(); time.sleep(0.2)
r = post('/api/hw/info', H)
ok(r.get('ok') and A.accepted == 2 and A.rejected == 0, 'dropped by the processor between requests: noticed, opened again (accepted %d, refused %d)' % (A.accepted, A.rejected))
A.kill_on[0x00000002] = 1
L = novalink.open_link('127.0.0.1', A.port)
try: v = L.read(0, 0, 0, 0, 0x00000002, 2); ok(v == b'\x00\x00' and A.accepted == 3, 'a read whose connection drops mid-exchange is asked again on a new one')
except novalink.LinkError as e: ok(False, 'a read whose connection drops mid-exchange is asked again on a new one (%s)' % e)
A.kill_on[0x00000003] = 2
try: L.write(0, 0, 0, 0, 0x02000100, b'\x02'); L.read(0, 0, 0, 0, 0x00000003, 2); ok(False, 'a second drop in the same read is not retried forever')
except novalink.LinkLost as e: ok(True, 'a read that drops twice in a row fails (LinkLost: %s)' % e)
v = L.read(0, 0, 0, 0, 0x02000100, 1); L.close()
ok(v == b'\x02' and A.rejected == 0, 'then the next request reconnects; the device never saw two connections at once')
ev = conns('127.0.0.1:%d' % A.port)
ok(any(e.startswith('reconnect after: closed by the processor') for e in ev) and any(e.startswith('reconnect after: lost:') for e in ev),
   'recorder: reconnects with the reason')

# ------------------------------------------------------------------ two targets in parallel; one target in series
B, C = Fake(0.03), Fake(0.03)
def reads(port, n, out):
    L = novalink.open_link('127.0.0.1', port)
    try:
        for _ in range(n): L.read(0, 0, 0, 0, 2, 2)
    finally: L.close()
    out.append(1)
novalink.open_link('127.0.0.1', B.port).close(); novalink.open_link('127.0.0.1', C.port).close()   # connected already
done = []; t0 = time.time()
ts = [threading.Thread(target=reads, args=(B.port, 10, done)), threading.Thread(target=reads, args=(C.port, 10, done))]
for t in ts: t.start()
for t in ts: t.join(10)
par = time.time() - t0
done = []; t0 = time.time()
ts = [threading.Thread(target=reads, args=(B.port, 10, done)) for _ in range(2)]
for t in ts: t.start()
for t in ts: t.join(10)
ser = time.time() - t0
ok(par < 0.5 and ser > 0.55, 'two targets run in parallel (%.2f s for 2 x 10 frames), one target one frame at a time (%.2f s)' % (par, ser))
ok(B.accepted == 1 and C.accepted == 1 and B.rejected + C.rejected == 0, 'one connection each')

# ------------------------------------------------------------------ idle close, refused target, LINK_IDLE 0
time.sleep(0.3)
closed = novalink.close_links(0.2)
ok('127.0.0.1:%d' % B.port in closed and 'unused' not in str(closed), 'connections unused for a while are closed (%s)' % closed)
ok(B.accepted == 1 and novalink._target_lock('127.0.0.1:%d' % B.port).acquire(blocking=False), 'closed: the target is free again')
novalink._target_lock('127.0.0.1:%d' % B.port).release()
dead = socket.socket(); dead.bind(('127.0.0.1', 0)); dport = dead.getsockname()[1]; dead.close()
for k in range(2):
    try: novalink.open_link('127.0.0.1', dport, timeout=0.5); ok(False, 'a refused target raises')
    except novalink.LinkBusy: ok(False, 'a refused target is not "busy"'); break
    except (OSError, novalink.LinkError): pass
else: ok(True, 'a refused target raises (twice, the second after the back-off)')
st = [x for x in post('/api/hw/links', {}).get('links', []) if x['target'] == '127.0.0.1:%d' % dport]
ok(st and not st[0]['open'] and st[0]['error'], '/api/hw/links shows the refused target with its error')
novalink.LINK_IDLE = 0
D = Fake(0)
L = novalink.open_link('127.0.0.1', D.port); L.read(0, 0, 0, 0, 2, 2); L.close(); time.sleep(0.4)
L = novalink.open_link('127.0.0.1', D.port); L.read(0, 0, 0, 0, 2, 2); L.close()
ok(D.accepted == 2 and D.rejected == 0, 'LINK_IDLE 0: closed as soon as nobody holds it (a connection per request, still one at a time)')
novalink.LINK_IDLE = 60

# ------------------------------------------------------------------ proxy port (optional)
P = post('/api/hw/proxy', dict(H, on=True))
ok(P.get('ok') and P.get('listen'), 'proxy started on 127.0.0.1:%s' % P.get('listen'))
held = novalink.open_link('127.0.0.1', A.port)   # Open Nova holds the link meanwhile
c = socket.create_connection(('127.0.0.1', P['listen']), timeout=3)
h = bytes([0x55, 0xAA, 0, 0x77, 0xFE, 0, 0, 0]) + struct.pack('<HBBIH', 0, 0, 0, 0x02000000, 32)
c.sendall(h + struct.pack('<H', (0x5555 + sum(h[2:])) & 0xFFFF))
buf = b''
while len(buf) < 52:
    d = c.recv(4096)
    if not d: break
    buf += d
ok(len(buf) == 52 and buf[:2] == b'\xAA\x55' and buf[3] == 0x77 and struct.unpack_from('<H', buf, 50)[0] == (0x5555 + sum(buf[2:50])) & 0xFFFF and buf[18 + 31] == 0x03,
   'proxy: the reply comes back with the client\'s serial (0x77) and a good sum')
bad = bytearray(h + b'\x00\x00'); c.sendall(bytes(bad)); c.settimeout(0.5)
try: c.recv(100); ok(False, 'proxy: a frame with a bad sum is not forwarded')
except socket.timeout: ok(True, 'proxy: a frame with a bad sum is not forwarded')
held.read(0, 0, 0, 0, 2, 2); held.close(); c.close()
ok(A.rejected == 0, 'proxy: the processor still sees one connection')
ok(post('/api/hw/proxy', {'on': False}).get('stopped') == [P['listen']], 'proxy stopped')

# ------------------------------------------------------------------ which pages may call the helper (Origin)
import netif   # noqa: E402
real = novalink.allowed_origins()
ok({'http://localhost:8765', 'http://127.0.0.1:8766', 'http://[::1]:8765'} <= real and all('http://%s:8765' % a in real for a in netif.addresses()),
   'allowed origins: localhost, 127.0.0.1, [::1] and each of this computer\'s addresses (%d) on the app ports' % len(netif.addresses()))
keep = netif.addresses
netif.addresses = lambda: ['192.0.2.7', '100.64.1.2']     # a LAN address and a Tailscale-like /32 one (stand-ins)
novalink.ALLOWED_ORIGINS.clear(); novalink._ORIGINS_AT[0] = 0.0
novalink.APP_PORTS.append(18775)                          # serve --app-port 18775


def ask(origin, method='POST'):
    req = urllib.request.Request(BASE + '/api/hw/ping', b'{}' if method == 'POST' else None, {'Content-Type': 'application/json', 'Origin': origin}, method=method)
    try: r = http.open(req, timeout=10); return r.status, r.headers.get('Access-Control-Allow-Origin')
    except urllib.error.HTTPError as e: return e.code, e.headers.get('Access-Control-Allow-Origin')


try:
    for o in ('http://192.0.2.7:8765', 'http://100.64.1.2:8766', 'http://127.0.0.1:8765', 'http://[::1]:8766', 'http://192.0.2.7:18775'):
        st, ac = ask(o)
        ok(st != 403 and ask(o, 'GET')[1] == o, 'the app from %s is accepted (POST %d, CORS header on GET)' % (o, st))
    for o in ('http://evil.example', 'http://192.0.2.8:8765', 'http://192.0.2.7:9999', 'null', 'https://127.0.0.1:8765'):
        st, ac = ask(o)
        ok(st == 403 and ask(o, 'GET')[1] is None, 'a foreign Origin %s is refused (POST %d, no CORS header)' % (o, st))
finally:
    netif.addresses = keep; novalink.APP_PORTS.remove(18775); novalink.ALLOWED_ORIGINS.clear(); novalink._ORIGINS_AT[0] = 0.0

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
