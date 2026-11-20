"""Tests for netcap.py + netcap_worker.py (passive network recording of NovaLCT / VMP / Unico, docs/VENDOR_CAPTURE.md §0b).

The REAL worker runs (as this user, not elevated) against a stand-in pktmon (a small script written here that keeps its
state in a file: status / filter add / filter remove / start / stop / etl2pcap, with "packets" that are a ready-made
.pcapng), and a fake world for the coordinator (which programs run, Windows' prompt). Covered: nothing before "Allow
recording" (the consent rule), the prompt answered No (never asked again this session), start -> recording -> the app
closes -> stop + convert + decode into vendor/captures (.pcapng + .nwl, records tagged with the program, duplicate packets
counted once), two files (rotation), a report while recording (cut: saved so far, recording goes on), pktmon busy for
someone else (left alone), an earlier crashed Open Nova recording (stopped + converted), the helper's process gone (pktmon
stopped, files converted), a failed start + "Allow recording" again, filters (32 at most, all removed after), unsupported
computers, OPENNOVA_NET_CAPTURE=0, the helper routes, and Windows' real connection table read (iphlpapi, read-only).
No UAC prompt, no real pktmon, no hardware.   python -I -X utf8 tools/test_netcap.py   (exit 0 = all passed)
"""
import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import time

TMP = tempfile.mkdtemp(prefix='opennova_netcap_test_')
os.environ['OPENNOVA_DIAG'] = os.path.join(TMP, 'diag')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netcap as N   # noqa: E402
import wirelog       # noqa: E402

fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what); sys.stdout.flush()
    if not cond: fails.append(what)


# ------------------------------------------------------------------ packets: a NovaLCT session as a .pcapng
def tg_frame(serial, addr, data=b'', op=1, dev=0, reply=False, status=0):
    if reply: h = bytearray(b'\xAA\x55') + bytes([status, serial, 0x00, 0xFE])
    else: h = bytearray(b'\x55\xAA') + bytes([0, serial, 0xFE, 0x00])
    h += bytes([dev, 0]) + struct.pack('<HBBIH', 0, op, 0, addr, len(data) if (op == 1 or reply) else 2)
    b = bytes(h) + (data if (op == 1 or reply) else b'')
    return b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF)


def ip_pkt(src, dst, proto, l4, ipid):
    ip = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(l4), ipid, 0x4000, 64, proto, 0, socket.inet_aton(src), socket.inet_aton(dst))
    return b'\x00\x11\x22\x33\x44\x55\x66\x77\x88\x99\xaa\xbb\x08\x00' + ip + l4


def tcp(sp, dp, seq, data):
    return struct.pack('!HHIIBBHHH', sp, dp, seq, 0, 0x50, 0x18, 65535, 0, 0) + data


def udp(sp, dp, data):
    return struct.pack('!HHHH', sp, dp, 8 + len(data), 0) + data


def pcapng(pkts):
    """[(t, bytes)] -> a .pcapng (Ethernet), as pktmon etl2pcap writes one."""
    def blk(bt, body):
        body += b'\0' * ((-len(body)) % 4)
        return struct.pack('<II', bt, len(body) + 12) + body + struct.pack('<I', len(body) + 12)
    out = blk(0x0A0D0D0A, struct.pack('<IHHq', 0x1A2B3C4D, 1, 0, -1)) + blk(1, struct.pack('<HHI', 1, 0, 0))
    for t, p in pkts:
        us = int(t * 1e6)
        out += blk(6, struct.pack('<IIIII', 0, us >> 32, us & 0xFFFFFFFF, len(p), len(p)) + p)
    return out


PC, H = '192.168.0.20', '192.168.0.10'
LCT_PORT, ON_PORT = 51000, 52000           # NovaLCT's and Open Nova's own connections to the H's 5201
MX, VMP_PORT = '192.168.0.11', 53000       # an MX40 Pro (COEX) and VMP's connection to its REST port 8001


def session(t0, serial0=1, with_dup=True):
    q, r = tg_frame(serial0, 0x00000002, op=0), tg_frame(serial0, 0x00000002, b'\x4A\x7B', reply=True)
    q2, r2 = tg_frame(serial0 + 1, 0x0A000000, op=0), tg_frame(serial0 + 1, 0x0A000000, b'\x01\x02', reply=True)
    p = [(t0, ip_pkt(PC, H, 17, udp(55000, 3800, b'rqProMI:'), 100 + serial0)),
         (t0 + .01, ip_pkt(H, PC, 17, udp(3800, 55000, b'rpProMI:App,0161'), 200 + serial0)),
         (t0 + .1, ip_pkt(PC, H, 6, tcp(LCT_PORT, 5201, 1000 * serial0, q), 300 + serial0)),
         (t0 + .12, ip_pkt(H, PC, 6, tcp(5201, LCT_PORT, 5000 * serial0, r), 400 + serial0)),
         (t0 + .2, ip_pkt(PC, H, 6, tcp(ON_PORT, 5201, 7000 * serial0, q2), 500 + serial0)),
         (t0 + .22, ip_pkt(H, PC, 6, tcp(5201, ON_PORT, 9000 * serial0, r2), 600 + serial0))]
    if with_dup: p.insert(1, (t0 + .001, p[0][1]))     # pktmon logs a packet once per edge: the same IP packet twice
    return pcapng(p)


def coex_session(t0):
    """VMP + an MX40 Pro: the controller's announcement (UDP 54622, broadcast), VMP's REST call on 8001 and its answer,
    and a TLS start on 9001 (HTTPS: recorded, but encrypted)."""
    ann = b'{"data":[{"apiPort":8001,"mac":"00:11:22:33:44:55","authType":0}]}'
    req = b'GET /api/v1/device/hw HTTP/1.1\r\nHost: ' + MX.encode() + b':8001\r\n\r\n'
    body = b'{"code":0,"data":{"modelId":"MX40 Pro"}}'
    resp = b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n' % len(body) + body
    tls = b'\x16\x03\x01\x00\x30' + b'\x01' * 48
    return pcapng([(t0, ip_pkt(MX, '255.255.255.255', 17, udp(40000, 54622, ann), 700)),
                   (t0 + .002, ip_pkt(MX, '255.255.255.255', 17, udp(40000, 54622, ann), 700)),   # logged twice
                   (t0 + .1, ip_pkt(PC, MX, 6, tcp(VMP_PORT, 8001, 100, req), 701)),
                   (t0 + .12, ip_pkt(MX, PC, 6, tcp(8001, VMP_PORT, 900, resp), 702)),
                   (t0 + .3, ip_pkt(PC, MX, 6, tcp(VMP_PORT + 1, 9001, 100, tls), 703))])


# ------------------------------------------------------------------ the stand-in pktmon
STANDIN = os.path.join(TMP, 'pktmon_standin.py')
PMSTATE = os.path.join(TMP, 'pktmon_state.json')
with open(STANDIN, 'w', encoding='utf-8') as f:
    f.write(r'''import json, os, shutil, sys
S = os.environ.get('PM_STATE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pktmon_state.json')
st = json.load(open(S)) if os.path.isfile(S) else {}
st.setdefault('running', False); st.setdefault('log', ''); st.setdefault('filters', []); st.setdefault('calls', [])
a = sys.argv[1:]
st['calls'].append(' '.join(a)); rc = 0
def save(): json.dump(st, open(S, 'w'))
if a[:1] == ['status']:
    print('Packet Monitor is running.\n\nLogger Parameters:\n    Logger name:        PktMon\n    Log file:           %s\n    Max file size:      32 MB' % st['log'] if st['running'] else 'Packet Monitor is not running.')
elif a[:2] == ['filter', 'remove']: st['filters'] = []; print('Removed all filters.')
elif a[:2] == ['filter', 'add']:
    if len(st['filters']) >= 32: print('Error: too many filters'); rc = 1
    else: st['filters'].append(a[2:])
elif a[:1] == ['start']:
    if st['running']: print('Error: An instance of PktMon is already running.'); rc = 1
    elif st.get('fail_start'): print('Error: the driver failed to start'); rc = 1
    else:
        f = a[a.index('-f') + 1]; st['running'] = True; st['log'] = f; st['starts'] = st.get('starts', 0) + 1
        src = st.get('packets') or []
        for i, p in enumerate(src):   # the "packets": ready-made .pcapng files, one per multi-file part
            shutil.copyfile(p, f if i == 0 else f[:-4] + '_%d.etl' % i)
        if not src: open(f, 'wb').write(b'ETL')
elif a[:1] == ['stop']:
    if not st['running']: print('Packet Monitor is not running.'); rc = 1
    else: st['running'] = False; st['stops'] = st.get('stops', 0) + 1; print('Flushing logs...\nMerging metadata...')
elif a[:1] == ['etl2pcap']:
    src, out = a[1], a[a.index('--out') + 1]
    data = open(src, 'rb').read()
    if data == b'ETL': data = open(st['empty'], 'rb').read() if st.get('empty') else b''
    open(out, 'wb').write(data); print('Processed %d packets' % 1)
else: print('unknown'); rc = 2
save(); sys.exit(rc)
''')
os.environ['PM_STATE'] = PMSTATE


def pm_state(**kw):
    st = json.load(open(PMSTATE)) if os.path.isfile(PMSTATE) else {}
    if kw: st.update(kw); json.dump(st, open(PMSTATE, 'w'))
    return st


PKTS = []
for i, t0 in enumerate((1761600000.0, 1761600100.0)):
    p = os.path.join(TMP, 'part%d.pcapng' % i)
    with open(p, 'wb') as f: f.write(session(t0, serial0=1 + 2 * i))
    PKTS.append(p)
COEX = os.path.join(TMP, 'coex.pcapng')
with open(COEX, 'wb') as f: f.write(coex_session(1761600200.0))
EMPTY = os.path.join(TMP, 'empty.pcapng')
with open(EMPTY, 'wb') as f: f.write(pcapng([]))


# ------------------------------------------------------------------ the fake world (the worker is real)
class Fake(N.Env):
    win, mac = True, False

    def __init__(self):
        self.procs, self.sup, self.launches, self.uac, self.marks, self.parent = [], (True, ''), 0, 'yes', [], None
        self.t = time.time()

    def disabled(self): return os.environ.get('OPENNOVA_NET_CAPTURE') == '0'

    def supported(self): return self.sup

    def processes(self): return list(self.procs)

    def owners(self, procs): return {LCT_PORT: 'NovaLCT', ON_PORT: 'Open Nova', 55000: 'NovaLCT', VMP_PORT: 'VMP'} if procs else {}

    def launch(self, d):
        self.launches += 1
        if self.uac == 'no': return {'ok': False, 'state': 'refused', 'error': 'Windows’ prompt was answered No'}
        args = [sys.executable, '-I', N.WORKER, '--dir', d, '--parent', str(self.parent or os.getpid()), '--ports', ','.join(map(str, N.PORTS)),
                '--partmb', '32', '--pktmon', STANDIN]
        p = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=open(os.path.join(TMP, 'worker_err.txt'), 'a'))
        return {'ok': True, 'handle': p}

    def alive(self, handle, ws): return handle.poll() is None if hasattr(handle, 'poll') else True

    def mark(self, text): self.marks.append(text)


def until(c, cond, secs=20.0, what=''):
    t0 = time.time()
    while time.time() - t0 < secs:
        s = c.tick()
        if cond(s): return s
        time.sleep(0.25)
    print('   (timed out waiting for %s: state %s, worker %s, error %s)' % (what, c.state, (c.ws or {}).get('state'), c.error))
    return c.status()


LCT = {'name': 'NovaLCT.exe', 'pid': 4242}


def captures():
    d = os.path.join(wirelog.DIAG_DIR, time.strftime('%Y-%m-%d'), 'vendor', 'captures')
    return sorted(os.listdir(d)) if os.path.isdir(d) else []


def nwl(name):
    d = os.path.join(wirelog.DIAG_DIR, time.strftime('%Y-%m-%d'), 'vendor', 'captures')
    with open(os.path.join(d, name), encoding='utf-8') as f: return [json.loads(l) for l in f]


def t_decode():
    recs = wirelog.from_capture(session(1761600000.0))
    udps = [r for r in recs if r['kind'] == 'udp']
    ok(len(udps) == 2, 'the same IP packet logged twice (pktmon) counts once: %d discovery records' % len(udps))
    tg = [r for r in recs if r['kind'] == 'tg']
    ok(len(tg) == 4 and all(r.get('cli') for r in tg), 'TG frames decoded with the program side (cli): %s' % [r.get('cli') for r in tg])
    ok(any(r.get('rtt') is not None for r in tg), 'round-trip times as for any capture')
    ok(udps[0].get('cli') == '%s:55000' % PC, 'discovery records say the program side too: %s' % udps[0].get('cli'))


def t_consent_and_record():
    pm_state(running=False, log='', filters=[], calls=[], packets=PKTS, empty=EMPTY, fail_start=False)
    env = Fake(); c = N.Coordinator(env)
    s = c.tick()
    ok(s['state'] == 'idle' and not c.say, 'no NovaStar app open: nothing shown')
    env.procs = [LCT, {'name': 'UCenter_win.exe', 'pid': 9}]
    s = c.tick()
    ok(s['state'] == 'needs-consent' and s['action'] == 'allow' and 'NovaLCT is open · not recorded yet' == c.say, 'NovaLCT opens: "%s" + Allow recording' % c.say)
    for _ in range(3): c.tick()
    ok(env.launches == 0, 'no prompt before the tester allows it (consent rule)')
    s = c.allow()
    ok(s['ok'] and env.launches == 1, 'Allow recording: Windows’ prompt once (the worker started)')
    s = until(c, lambda s: s['state'] == 'recording', what='recording')
    ok(s['state'] == 'recording' and c.say.startswith('NovaLCT is open · recording'), 'recording: "%s"' % c.say)
    st = pm_state()
    ok(len(st['filters']) == len(N.PORTS) <= 32 and ['OpenNova5201', '-p', '5201'] in st['filters'], 'filters: %d single ports (pktmon allows 32), the H ports among them' % len(st['filters']))
    start = [x for x in st['calls'] if x.startswith('start')][-1]
    ok('--capture' in start and '--comp nics' in start and '--pkt-size 0' in start and '-m multi-file' in start and 'netcap-work' in start,
       'pktmon start: whole packets, one copy per adapter, a new file every 32 MB, into netcap-work: %s' % start[:160])
    for _ in range(4): c.tick(); time.sleep(0.2)
    ok(env.launches == 1, 'one prompt per session (no new prompt while it records)')
    env.procs = [{'name': 'UCenter_win.exe', 'pid': 9}]
    s = until(c, lambda s: s['state'] == 'saved', what='saved')
    ok(s['state'] == 'saved' and 'NovaLCT recording saved' in c.say, 'NovaLCT closed: stopped, converted, saved: "%s"' % c.say)
    st = pm_state()
    ok(not st['running'] and st['filters'] == [], 'pktmon stopped and its filters removed after the app closed')
    cap = captures()
    pc = [x for x in cap if x.endswith('.pcapng')]; nw = [x for x in cap if x.endswith('.nwl')]
    ok(len(pc) == 2 and len(nw) == 2 and all('NovaLCT_network' in x for x in pc) and sorted(x[:-7] for x in pc) == sorted(x[:-4] for x in nw),
       'two recorded files (rotation) -> vendor/captures, each with its .nwl of the same name: %s' % cap)
    recs = nwl(nw[0])
    head = recs[0]
    ok(head['kind'] == 'mark' and 'only listened' in head['text'] and 'NovaLCT (local ports' in head['text'], 'the .nwl says what it is: %s' % head['text'][:150])
    tg = [r for r in recs if r['kind'] == 'tg']
    ok({r.get('app') for r in tg} == {'NovaLCT', 'Open Nova'}, 'each frame says which program sent it: %s' % sorted({r.get('app') for r in tg}))
    ok(len([r for r in recs if r['kind'] == 'udp']) == 2, 'duplicates counted once in the saved recording')
    work = os.path.join(wirelog.DIAG_DIR, 'netcap-work')
    left = [os.path.join(r, f) for r, _, fs in os.walk(work) for f in fs if f.endswith(('.etl', '.pcapng'))]
    ok(not left, 'nothing left in netcap-work (the .etl files are ours and temporary): %s' % left)
    # the app opens again: same worker, no new prompt
    env.procs = [LCT]
    s = until(c, lambda s: s['state'] == 'recording', what='recording again')
    ok(s['state'] == 'recording' and env.launches == 1, 'NovaLCT opened again: recording again without a new prompt')
    # Report a problem while recording
    n0 = len(captures())
    r = c.flush(30)
    ok(r.get('flushed') and len(captures()) > n0, 'Report a problem while recording: what was recorded so far saved (%s s, %d new files)' % (r.get('seconds'), len(captures()) - n0))
    s = c.tick()
    ok(s['state'] == 'recording' and pm_state()['running'], 'the recording goes on after the report')
    route = N.handle('net-status', {})
    ok(route['ok'] and 'state' in route and route['ports'] == N.PORTS, 'helper route net-status')
    c.quit()
    t0 = time.time()
    while c.handle.poll() is None and time.time() - t0 < 15: time.sleep(0.2)
    ok(c.handle.poll() is not None and not pm_state()['running'], 'quit (Open Nova closing): worker ended, pktmon stopped')
    c.tick()


def t_vmp():
    """A second tester: VMP + an MX40 Pro. VMP's service (VMP_XCenter) runs all the time and doesn't start a recording;
    VMP's own window does. COEX ports filtered; the REST call on 8001 decoded, tagged VMP; 9001 (HTTPS) kept, not readable."""
    pm_state(running=False, log='', filters=[], calls=[], packets=[COEX], fail_start=False)
    env = Fake(); c = N.Coordinator(env)
    env.procs = [{'name': 'VMP_XCenter.exe', 'pid': 11}, {'name': 'NeoController.exe', 'pid': 12}]
    s = c.tick()
    ok(s['state'] == 'idle' and not c.say, 'only VMP’s service (XCenter) running: nothing recorded, nothing shown')
    env.procs.append({'name': 'VMP.exe', 'pid': 13})
    s = c.tick()
    ok(s['state'] == 'needs-consent' and c.say == 'VMP is open · not recorded yet', 'VMP’s window opens: "%s"' % c.say)
    c.allow()
    s = until(c, lambda s: s['state'] == 'recording', what='VMP recording')
    f = [x[2] for x in pm_state()['filters']]
    ok(s['state'] == 'recording' and all(p in f for p in ('54622', '54623', '54624', '54700', '8001', '9001')), 'recording VMP; the COEX ports are filtered: %s' % [p for p in f if int(p) > 8000])
    n0 = set(captures())
    env.procs = [{'name': 'VMP_XCenter.exe', 'pid': 11}]
    s = until(c, lambda s: s['state'] == 'saved', what='VMP saved')
    new = sorted(set(captures()) - n0)
    nw = [x for x in new if x.endswith('.nwl')]
    ok(s['state'] == 'saved' and 'VMP recording saved' in c.say and len(nw) == 1 and 'VMP_network' in nw[0], 'VMP closed: saved %s' % new)
    recs = nwl(nw[0]) if nw else []
    ann = [r for r in recs if r['kind'] == 'udp']
    ok(len(ann) == 1 and ann[0]['proto'] == 'coex' and '"apiPort":8001' in ann[0].get('text', ''), 'the MX’s announcement (UDP 54622) decoded once, as COEX: %s' % [(r['proto'], r.get('text', '')[:40]) for r in ann])
    http = [r for r in recs if r['kind'] == 'http']
    ok(len(http) == 2 and http[0]['url'].startswith('GET /api/v1/device/hw') and http[0]['link'] == MX + ':8001' and http[1]['url'].startswith('HTTP/1.1 200'),
       'VMP’s REST call on 8001 and its answer decoded: %s' % [r['url'][:40] for r in http])
    ok(all(r.get('app') == 'VMP' for r in http), 'each says it was VMP: %s' % [r.get('app') for r in http])
    ok(not any(':9001' in str(r.get('link', '')) for r in recs), '9001 (HTTPS) is in the .pcapng but not readable: no records from it')
    c.quit()
    t0 = time.time()
    while c.handle.poll() is None and time.time() - t0 < 15: time.sleep(0.2)
    c.tick()


def t_refused():
    pm_state(running=False, log='', filters=[], calls=[])
    env = Fake(); env.uac = 'no'; env.procs = [LCT]; c = N.Coordinator(env)
    c.tick(); c.allow()
    s = until(c, lambda s: s['state'] == 'refused', 5, 'refused')
    ok(s['state'] == 'refused' and 'answered No' in c.say and not s['action'], 'prompt answered No: "%s"' % c.say)
    for _ in range(3): c.tick()
    r = c.allow()
    ok(env.launches == 1 and not r['ok'], 'not asked again this session (Allow refused: %s)' % r.get('error', '')[:60])


def t_busy():
    other = os.path.join(TMP, 'someone', 'their.etl')
    pm_state(running=True, log=other, filters=[['theirs', '-p', '443']], calls=[], packets=PKTS)
    env = Fake(); env.procs = [LCT]; c = N.Coordinator(env)
    c.tick(); c.allow()
    s = until(c, lambda s: s['state'] == 'busy', 15, 'busy')
    st = pm_state()
    ok(s['state'] == 'busy' and 'in use by another program' in c.say, 'pktmon recording for someone else: "%s"' % c.say)
    ok(st['running'] and st['log'] == other and st['filters'] == [['theirs', '-p', '443']] and not any(x.startswith(('stop', 'filter', 'start')) for x in st['calls']),
       'their recording left alone (no stop, no filter change): calls %s' % st['calls'])
    pm_state(running=False, log='', filters=[])


def t_crash_recovery_and_parent_gone():
    # an earlier Open Nova session crashed while pktmon recorded into netcap-work: stopped and converted by the next worker
    old = os.path.join(wirelog.DIAG_DIR, 'netcap-work', '20261101-120000-1', 'run1')
    os.makedirs(old, exist_ok=True)
    with open(os.path.join(old, 'nova.etl'), 'wb') as f: f.write(open(PKTS[0], 'rb').read())
    pm_state(running=True, log=os.path.join(old, 'nova.etl'), filters=[['OpenNova5201', '-p', '5201']], calls=[], packets=PKTS)
    dummy = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    env = Fake(); env.procs = [LCT]; env.parent = dummy.pid; c = N.Coordinator(env)
    n0 = len(captures())
    c.tick(); c.allow()
    s = until(c, lambda s: s['state'] == 'recording', 15, 'recording after recovery')
    calls = pm_state()['calls']
    ok(calls[:3] == ['status', 'stop', 'filter remove'], 'our own pktmon left by a crashed session: stopped first: %s' % calls[:4])
    time.sleep(1.0); c.tick()
    ok(len(captures()) >= n0 + 2, 'its recording converted and saved (%d new files: .pcapng + .nwl)' % (len(captures()) - n0))
    ok(not os.path.exists(os.path.join(old, 'nova.etl')), 'the crashed session’s .etl converted (and gone)')
    dummy.kill(); dummy.wait()
    t0 = time.time()
    while c.handle.poll() is None and time.time() - t0 < 15: time.sleep(0.2)
    st = pm_state()
    ok(c.handle.poll() is not None and not st['running'] and st['filters'] == [], 'the helper’s process gone: the worker stopped pktmon, removed its filters and ended')
    s = until(c, lambda s: s['state'] in ('failed', 'needs-consent'), 5, 'failed')
    ok(s['state'] == 'failed' and s['action'] == 'allow', 'the line says recording stopped, with Allow recording to start again: "%s"' % c.say)


def t_failed_start_retry():
    pm_state(running=False, log='', filters=[], calls=[], packets=PKTS, fail_start=True)
    env = Fake(); env.procs = [LCT]; c = N.Coordinator(env)
    c.tick(); c.allow()
    s = until(c, lambda s: s['state'] == 'failed', 15, 'failed')
    ok(s['state'] == 'failed' and s['action'] == 'allow' and 'driver failed' in c.error, 'pktmon start failed: "%s" (%s)' % (c.say, c.error[:60]))
    ok(pm_state()['filters'] == [], 'filters removed after the failed start')
    pm_state(fail_start=False)
    c.allow()
    s = until(c, lambda s: s['state'] == 'recording', 15, 'recording after retry')
    ok(s['state'] == 'recording' and env.launches == 1, 'Allow recording again: the running worker tries again (no new prompt)')
    c.quit()
    t0 = time.time()
    while c.handle.poll() is None and time.time() - t0 < 15: time.sleep(0.2)
    c.tick()


def t_other():
    env = Fake(); env.sup = (False, 'needs Windows 10 version 2004 or newer'); env.procs = [LCT]; c = N.Coordinator(env)
    s = c.tick()
    ok(s['state'] == 'unsupported' and 'not recorded' in c.say and not s['action'], 'old Windows: "%s" (%s)' % (c.say, c.tip))
    env.procs = []
    ok(c.tick()['state'] == 'off', 'old Windows, no app open: nothing shown')
    os.environ['OPENNOVA_NET_CAPTURE'] = '0'
    env2 = Fake(); env2.procs = [LCT]; c2 = N.Coordinator(env2)
    ok(c2.tick()['state'] == 'off' and not c2.say, 'OPENNOVA_NET_CAPTURE=0: off')
    del os.environ['OPENNOVA_NET_CAPTURE']
    e = N.Env()
    apps = e.apps([{'name': 'NovaLCT.exe', 'pid': 1}, {'name': 'VMP.exe', 'pid': 2}, {'name': 'UCenter_win.exe', 'pid': 3}, {'name': 'Unico.exe', 'pid': 4}]) if e.win else {}
    if e.win:
        ok(apps == {'NovaLCT': [1], 'VMP': [2], 'Unico': [4]}, 'the apps that start a recording (not their services): %s' % apps)
        sup = e.supported()
        ok(sup[0] == (N.win_build() >= N.PKTMON_MIN_BUILD and bool(N.pktmon_path())), 'this PC: pktmon usable = %s (%s, build %d)' % (sup[0], N.pktmon_path(), N.win_build()))
        o = N.win_owners({os.getpid()})
        ok(isinstance(o, dict), 'Windows’ connection table read (iphlpapi, read-only): %d entries' % len(o))
        on = e.owners([{'name': 'python.exe', 'pid': os.getpid()}])
        ok(isinstance(on, dict), 'owners() works on this PC')
    ok(len(N.PORTS) <= 32 and 3800 in N.PORTS and 5201 in N.PORTS and 8088 in N.PORTS and 8001 in N.PORTS, 'ports: %d, NovaLCT + Unico + COEX' % len(N.PORTS))
    ok(N.handle('net-auto', {})['ok'], 'helper route net-auto')


def main():
    t_decode()
    t_consent_and_record()
    t_vmp()
    t_refused()
    t_busy()
    t_crash_recovery_and_parent_gone()
    t_failed_start_retry()
    t_other()
    print('\n%d failed' % len(fails) if fails else '\nall passed')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
