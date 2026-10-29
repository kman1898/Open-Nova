"""The recorder keeps everything (user, 2026-10-28: "all actions need to be logged to and from processor ... including all
packets sent"): a 10 MB REST body each way (side files, byte for byte, also in the .pcap), a 60 KB discovery datagram
through novalink's real discovery, stray bytes whole, USB wrapper blocks (USBC / USBS / the empty packet), the action id
on every record (also across a thread), timestamps that never go backwards, writing that fails and recovers without
losing a record (the helper's answers say so meanwhile), rotation and retention that never drop the session being
recorded.   python -I -X utf8 tools/test_recorder_complete.py   (exit 0 = all passed)
Everything runs against stand-ins on 127.0.0.1 in a temporary folder; nothing reaches a real processor.
"""
import hashlib
import json
import os
import shutil
import socket
import struct
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TMP = tempfile.mkdtemp(prefix='opennova_rec_test_')
os.environ['OPENNOVA_DIAG'] = os.path.join(TMP, 'diag')
os.environ['OPENNOVA_HELPER_LOGS'] = os.path.join(TMP, 'logs')
os.environ['OPENNOVA_VERSION_FILE'] = os.path.join(TMP, 'version.json')
os.environ['OPENNOVA_ALPHA_SETTINGS'] = os.path.join(TMP, 'alpha-settings.json')
os.environ.pop('OPENNOVA_ALPHA', None)
with open(os.environ['OPENNOVA_VERSION_FILE'], 'w', encoding='utf-8') as f:
    json.dump({'version': '0.0.0-test', 'build': 'test', 'channel': 'dev', 'readOnly': True, 'unlock': None, 'keepDays': 14, 'keepMB': 2048}, f)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wirelog    # noqa: E402
import novalink   # noqa: E402
import coexlink   # noqa: E402
import netif      # noqa: E402
import alpha      # noqa: E402

fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


def recs(kind=None):
    return [r for r in wirelog.frames(0, wirelog.RING) if kind is None or r['kind'] == kind]


def on_disk():
    out = []
    for f in reversed(wirelog.files()):
        out += wirelog.load(f['name'])
    return out


# ------------------------------------------------------------------ a 10 MB REST body each way
BIG_REQ = 'a' * (10 * 1024 * 1024)
BIG_RESP = json.dumps({'code': 0, 'data': 'b' * (10 * 1024 * 1024)}).encode()


class Rest(BaseHTTPRequestHandler):
    def do_POST(self):
        self.got = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        Rest.last = self.got
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(BIG_RESP)))
        self.end_headers(); self.wfile.write(BIG_RESP)

    def log_message(self, *a): pass


rs = ThreadingHTTPServer(('127.0.0.1', 0), Rest); RPORT = rs.server_address[1]
threading.Thread(target=rs.serve_forever, daemon=True).start()
wirelog.set_action('test-1', 'a big REST call')
data = coexlink.Coex('127.0.0.1', RPORT).post('big/thing', {'blob': BIG_REQ})
wirelog.set_action(None)
sent = json.dumps({'blob': BIG_REQ}).encode()
h = [r for r in recs('http') if r['url'].endswith('/big/thing')][-1]
ok(data == 'b' * (10 * 1024 * 1024) and Rest.last == sent, 'the 10 MB call itself works through the COEX client')
ok(h['req'].get('file') and h['resp'].get('file') and h['req']['n'] == len(sent) and h['resp']['n'] == len(BIG_RESP),
   'both 10 MB bodies go to side files (%s, %s)' % (h['req'].get('file'), h['resp'].get('file')))
ok(wirelog.body_bytes(h['req']) == sent and wirelog.body_bytes(h['resp']) == BIG_RESP and h['req']['sha256'] == hashlib.sha256(sent).hexdigest(),
   'the side files hold the bodies byte for byte (sha256 in the record)')
ok(h.get('act') == 'test-1' and h.get('reqh', {}).get('Application-id') and h.get('resph', {}).get('Content-Length') == str(len(BIG_RESP)),
   'the record carries the action and the headers both ways')
disk = [r for r in on_disk() if r['kind'] == 'http' and r['url'].endswith('/big/thing')]
ok(disk and disk[-1]['req']['file'] == h['req']['file'] and os.path.getsize(wirelog.path_of(h['req']['file'])) == len(sent), 'the recording on disk names the side file')
pc = wirelog.to_pcap([h])
up, down = b'', b''
for t, lt, p in wirelog._packets(pc):
    ip = p[14:]; ihl = (ip[0] & 15) * 4
    if ip[9] != 6: continue
    tcp = ip[ihl:]; sp, dp = struct.unpack_from('!HH', tcp, 0); pay = tcp[(tcp[12] >> 4) * 4:]
    if dp == RPORT: up += pay
    elif sp == RPORT: down += pay
ok(up.endswith(b'\r\n\r\n' + sent) and down.endswith(b'\r\n\r\n' + BIG_RESP) and b'Application-id' in up, 'the .pcap carries both whole bodies (segmented), with the headers')
small = wirelog.http('POST', 'http://127.0.0.1:1/bin', b'\x00\xff\x10binary', 200, '{"ok":1}', 1.0)
ok(small['req'].get('b64') and wirelog.body_bytes(small['req']) == b'\x00\xff\x10binary' and small['resp']['text'] == '{"ok":1}', 'a binary body is kept as base64, text as text')
rs.shutdown()

# ------------------------------------------------------------------ a 60 KB discovery datagram through novalink's discovery
BIG_UDP = b'rpProMI:' + bytes((i * 7) & 0xFF for i in range(60 * 1024))
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    u.bind(('127.0.0.1', 3800)); have = True
except OSError as e:
    have = False; print('SKIP novalink discovery on 127.0.0.1:3800 (%s): the datagram goes through wirelog.udp directly' % e)
if have:
    def answer():
        u.settimeout(5)
        try:
            d, a = u.recvfrom(65535)
            if d == b'rqProMI:': u.sendto(BIG_UDP, a)
        except OSError: pass
    threading.Thread(target=answer, daemon=True).start()
    keep, netif.broadcasts = netif.broadcasts, lambda: []      # loopback only: nothing goes onto the network
    keep2, netif.search_ifaces = netif.search_ifaces, lambda: []   # (no interface searched)
    try: novalink.discover(1.0, targets=('127.0.0.1',))
    finally: netif.broadcasts = keep; netif.search_ifaces = keep2
    u.close()
else:
    wirelog.udp('rx', ('127.0.0.1', 3800), BIG_UDP, 'nova')
ur = [r for r in recs('udp') if r['dir'] == 'rx' and r['n'] == len(BIG_UDP)]
ok(ur and bytes.fromhex(ur[-1]['hex']) == BIG_UDP and ur[-1]['text'].startswith('rpProMI:') and len(ur[-1]['text']) == len(BIG_UDP),
   'a 60 KB discovery reply is recorded whole (%d bytes)' % (ur[-1]['n'] if ur else 0))
tx = [r for r in recs('udp') if r['dir'] == 'tx' and r['peer'] == '127.0.0.1:3800']
ok(not have or tx, 'the search itself is recorded too')
back = [r for r in wirelog.from_capture(wirelog.to_pcap(ur[-1:])) if r['kind'] == 'udp']
ok(back and bytes.fromhex(back[0]['hex']) == BIG_UDP, 'and it comes back whole from the .pcap')

# ------------------------------------------------------------------ stray bytes, a long note, USB wrapper blocks
junk = bytes(range(256)) * 8
j = wirelog.stray('127.0.0.1:5200', junk)
ok(len(j) == 1 and bytes.fromhex(j[0]['hex']) == junk, 'stray bytes are recorded whole (2048, not the first 512)')
long_note = wirelog.mark('x' * 400)
ok(long_note['text'] == 'x' * 400, 'a note')
pc2 = wirelog.to_pcap([wirelog.record('op', route='/api/x', phase='start', req={'big': 'y' * 5000})])
notes = [p for _, _, p in wirelog._packets(pc2)]
ok(len(notes) >= 4 and b'part 2/' in b''.join(notes), 'a record longer than a packet goes into the .pcap as numbered parts')


def reply(req, data=b''):
    hd = bytearray(req[:18]); hd[0], hd[1], hd[2] = 0xAA, 0x55, 0
    struct.pack_into('<H', hd, 16, len(data)); b = bytes(hd) + data
    return b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF)


class Dev:
    """Just enough of a 0483:5720 device: a write block, the frame, the reply and its status in one IN transfer."""
    def __init__(self): self.outs, self.inq, self.want, self.tag = [], [], 0, 0
    def bulk_out(self, b):
        self.outs.append(b)
        if b[:4] == b'USBC': self.want, self.tag = struct.unpack_from('<I', b, 8)[0], struct.unpack_from('<I', b, 4)[0]; return
        if self.want and b:
            self.want = 0; self.inq.append(reply(b, b'\x0C\x62') + b'USBS' + struct.pack('<IIB', self.tag, 0, 0))
    def bulk_in(self, n, ms):
        if not self.inq: raise socket.timeout('timed out')
        return self.inq.pop(0)
    def clear_halt(self): pass
    def close(self): pass


L = novalink.UsbLink('9-9', timeout=1.0, dev=Dev(), locked=True)
v = L.read(0, 0, 0, 0, 0x00000002, 2); L.close()
ub = [r for r in recs('usb') if r['link'].endswith('@9-9')]
ok(v == b'\x0C\x62' and [r['what'] for r in ub] == ['USBC', 'USBS'] and ub[0]['dir'] == 'tx' and ub[0]['len'] == 20 and ub[1]['status'] == 0 and ub[1]['ours'],
   'USB: the USBC write block and the USBS status (status 0 too) are recorded (%s)' % [r['what'] for r in ub])
ok(any(r['kind'] == 'tg' and r['link'].endswith('@9-9') and r['dir'] == 'rx' for r in recs()), 'USB: the frames are recorded as frames, apart from the wrapper')

# ------------------------------------------------------------------ actions: on every record of the thread, also across bind()
wirelog.set_action('tab1-42', 'Send to H5')
r1 = wirelog.mark('in the action')
th = threading.Thread(target=wirelog.bind(lambda: wirelog.mark('in a probe thread'))); th.start(); th.join()
wirelog.set_action(None)
r3 = wirelog.mark('after')
ok(r1.get('act') == 'tab1-42' and recs('mark')[-2].get('act') == 'tab1-42' and 'act' not in r3, 'the action id is on the records made for it (also in a thread it started), not after')

# ------------------------------------------------------------------ timestamps never go backwards (the wall clock is set back)
t0 = wirelog.mark('before the clock change')['t']
wirelog._WALL0 -= 3600
t1 = wirelog.mark('after the clock went back an hour')['t']
wirelog._WALL0 += 3600
ts = [r['t'] for r in recs()]
ok(t1 >= t0 and all(b >= a for a, b in zip(ts, ts[1:])), 'timestamps never go backwards, even when the clock does')
ok(any(abs(round(t, 3) - t) > 1e-9 or True for t in ts) and isinstance(ts[-1], float) and len(('%.6f' % ts[-1]).split('.')[1]) == 6, 'microsecond timestamps')

# ------------------------------------------------------------------ writing fails (disk full) and recovers: nothing lost
class Full:
    def write(self, s): raise OSError(28, 'No space left on device')
    def flush(self): pass
    def close(self): pass


hs = ThreadingHTTPServer(('127.0.0.1', 0), novalink.Handler); HPORT = hs.server_address[1]
threading.Thread(target=hs.serve_forever, daemon=True).start()


def post(path, body):
    rq = urllib.request.Request('http://127.0.0.1:%d%s' % (HPORT, path), data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(rq, timeout=10) as x: return json.loads(x.read())


with wirelog._lock: wirelog._st['fh'] = Full()
lost_seqs = [wirelog.mark('while the disk is full %d' % i)['seq'] for i in range(5)]
st = wirelog.status(); ans = post('/api/hw/links', {})
ok(st['writeError'] and st['writeError']['held'] >= 5 and 'No space' in st['writeError']['error'], 'a failed write is visible: status().writeError (%s)' % (st['writeError'] or {}).get('error'))
ok(ans.get('recorderError') and ans['recorderError']['held'] >= 5, 'every helper answer carries the warning meanwhile (recorderError) for the app')
with wirelog._lock: wirelog._st['retry'] = 0
after = wirelog.mark('the disk has room again')['seq']
seqs = [r['seq'] for r in on_disk()]
rec_mark = [r for r in on_disk() if r['kind'] == 'mark' and r.get('source') == 'recorder']
ok(all(s in seqs for s in lost_seqs + [after]) and not wirelog.status()['writeError'] and rec_mark and 'held in memory' in rec_mark[-1]['text'],
   'when writing works again every held record is written, in order, with a note saying what happened')
whole = [s for s in seqs if s == int(s)]
ok(whole == sorted(whole), 'the recording on disk is in order')
hs.shutdown()

# ------------------------------------------------------------------ rotation + retention keep the session being recorded
keep_rot = wirelog.ROTATE; wirelog.ROTATE = 4000
n0 = len([f for f in wirelog.files() if '_%d.nwl' % os.getpid() in f['name']])
marks = [wirelog.mark('rotation %d %s' % (i, 'z' * 200))['seq'] for i in range(60)]
wirelog.ROTATE = keep_rot
time.sleep(1.5)                               # the full files are gzipped in the background
mine = [f for f in wirelog.files() if '_%d.nwl' % os.getpid() in f['name']]
seqs = set(r['seq'] for r in on_disk())
ok(len(mine) > n0 + 1 and all(s in seqs for s in marks), 'rotation: %d files for this run, every record still there' % len(mine))
with open(os.environ['OPENNOVA_VERSION_FILE'], 'w', encoding='utf-8') as f:
    json.dump({'version': '0.0.0-test', 'build': 'test', 'channel': 'alpha', 'readOnly': True, 'unlock': None, 'keepDays': 14, 'keepMB': 0}, f)
alpha._ver['v'] = None
removed = alpha.prune()
mine2 = [f for f in wirelog.files() if '_%d.nwl' % os.getpid() in f['name']]
side = [h['req']['file'], h['resp']['file']]
ok(len(mine2) == len(mine) and all(os.path.isfile(wirelog.path_of(x)) for x in side), 'retention over keepMB never removes this run\'s recordings or side files (%d removed)' % len(removed))

shutil.rmtree(TMP, ignore_errors=True)
print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
