"""Tests for vendortap.py (Tools ▸ Vendor apps): detection parsing, the vendor logs (days, caps, scrubbing), capture import
into vendor/, a stand-in dumpcap, and the relay byte for byte against stand-in processors (NovaLCT TG with discovery, Unico
HTTP + WebSocket with discovery, COEX HTTP with the announcement), and that the relay records everything whole like
wirelog (5 MB bodies in side files, binary as base64, a 60 KB discovery answer, stray bytes, every ping, what is left at
the close; only passwords / tokens / logins masked). Never touches a real processor: every stand-in listens on
127.0.0.5, the relay on 127.0.0.42, on unusual ports.   python -I -X utf8 tools/test_vendortap.py   (exit 0 = all passed)
"""
import base64
import gzip
import hashlib
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time

TMP = tempfile.mkdtemp(prefix='opennova_vendor_test_')
os.environ['OPENNOVA_DIAG'] = os.path.join(TMP, 'diag')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wirelog    # noqa: E402
import vendortap as V   # noqa: E402

fails = []
DEV = '127.0.0.5'        # stand-in processors
RIP = '127.0.0.42'       # the relay


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


def tape_records(r):
    out = []
    for p in r.tape.files:
        with open(p, encoding='utf-8') as f: out += [json.loads(x) for x in f]
    return out


# ------------------------------------------------------------------ parsing
def t_parsing():
    tl = '"System Idle Process","0","Services","0","8 K"\n"NovaLCT.exe","4412","Console","1","120,332 K"\n"ucenter_win.exe","3656","Services","0","53,448 K"\n'
    p = V.parse_tasklist(tl)
    ok(len(p) == 3 and p[1] == {'name': 'NovaLCT.exe', 'pid': 4412, 'session': 'Console'}, 'tasklist CSV parsed')
    ns = ('\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n'
          '  TCP    0.0.0.0:19100          0.0.0.0:0              LISTENING       3676\n'
          '  TCP    192.168.0.20:50211     192.168.0.10:5200      ESTABLISHED     4412\n'
          '  TCP    127.0.0.1:50300        127.0.0.1:19999        ESTABLISHED     4412\n'
          '  TCP    [::]:8765              [::]:0                 LISTENING       7920\n'
          '  UDP    0.0.0.0:3800           *:*                                    4412\n')
    n = V.parse_netstat(ns)
    ok(len(n) == 5 and n[1]['remote'] == '192.168.0.10:5200' and n[1]['state'] == 'ESTABLISHED' and n[4]['proto'] == 'udp' and n[4]['pid'] == 4412, 'netstat -ano parsed (TCP + UDP)')
    to, ls = V._talks(n, {4412, 3676})
    ok(to == ['192.168.0.10:5200'] and ls == ['19100'], 'talks to: other computers only (loopback left out); listening ports')
    ps = V.parse_ps('  101 /Applications/Unico.app/Contents/MacOS/Unico\n  202 /usr/sbin/cfprefsd\n')
    ok(ps[0] == {'pid': 101, 'path': '/Applications/Unico.app/Contents/MacOS/Unico', 'name': 'Unico'}, 'ps -axo parsed')
    lo = V.parse_lsof('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nUnico 101 me 23u IPv4 0x1 0t0 TCP 192.168.1.5:50123->192.168.1.10:8088 (ESTABLISHED)\n')
    ok(lo == [{'proto': 'tcp', 'local': '192.168.1.5:50123', 'remote': '192.168.1.10:8088', 'state': 'ESTABLISHED', 'pid': 101}], 'lsof -nP -i parsed')
    dl = V.parse_dumpcap_list('1. \\Device\\NPF_{0A1B} (Ethernet0)\n2. \\Device\\NPF_Loopback (Adapter for loopback traffic capture)\n3. en0 [Up, Running]\n')
    ok([x['desc'] for x in dl] == ['Ethernet0', 'Adapter for loopback traffic capture', 'Up, Running'] and dl[0]['name'] == '\\Device\\NPF_{0A1B}', 'dumpcap -D parsed (Windows and macOS forms)')
    ok(V.version_from_name('NovaLCT V5.9.2') == '5.9.2' and V.version_from_name('Coex VMP V1.5.1') == '1.5.1' and V.version_from_name('Unico') == '', 'version from the installed-programs name')
    pv = b'MZ' + b'\0' * 100 + 'ProductVersion\0'.encode('utf-16-le') + b'\0\0' + '5.9.2.0\0'.encode('utf-16-le') + b'\0' * 20
    fx = b'MZ' + b'\0' * 50 + b'\xbd\x04\xef\xfe' + struct.pack('<III', 0x10000, (3 << 16) | 1, (1912 << 16) | 1001)
    ok(V.pe_version(pv) == '5.9.2.0' and V.pe_version(fx) == '3.1.1912.1001' and V.pe_version(b'MZ nothing') == '', 'executable version: ProductVersion text, else the fixed FileVersion')
    inst = [{'name': 'NovaLCT V5.9.2', 'version': '', 'location': 'C:\\x\\NovaLCT\\', 'publisher': 'Nova Star'},
            {'name': 'Unico V2.8.0', 'version': 'V2.8.0', 'location': '', 'publisher': '西安诺瓦星云科技股份有限公司'},
            {'name': 'VMP Player (another vendor)', 'version': '9', 'location': '', 'publisher': 'Someone Else'}]
    svc = [{'name': 'UCenter', 'path': 'C:\\Program Files\\UCenter\\ucenter\\ucenter_win.exe', 'state': 'running'}]
    procs = [{'name': 'NovaLCT.exe', 'pid': 4412}, {'name': 'ucenter_win.exe', 'pid': 3656}]
    apps = {a['id']: a for a in V.match_apps(inst, ['C:\\x\\NovaLCT\\Bin\\NovaLCT.exe', 'D:\\Lite\\Ucenter\\Ucenter_win.exe'], procs, n, svc)}
    ok(set(apps) == {'novalct', 'unico', 'ucenter'}, 'apps matched: NovaLCT, Unico, UCenter (another vendor’s "VMP" left out): %s' % sorted(apps))
    ok(apps['novalct']['version'] == '5.9.2' and apps['novalct']['running'] == [4412] and apps['novalct']['talksTo'] == ['192.168.0.10:5200']
       and apps['novalct']['path'].endswith('NovaLCT.exe'), 'NovaLCT: version, running PID, talks to the processor, exe path')
    ok(apps['ucenter']['service'] == 'UCenter (running)' and apps['ucenter']['path'].startswith('C:\\Program Files\\UCenter'), 'UCenter: the service and the path that runs')
    ok(apps['unico']['running'] == [] and apps['unico']['version'] == 'V2.8.0', 'Unico: installed, not running')


# ------------------------------------------------------------------ scrubbing + logs
def t_scrub():
    cases = [
        ('user = {"username":"admin","password":"MTIzNDU2","captcha":"x"}', '"password":"<hidden>"', 'MTIzNDU2'),
        ('{\\"token\\":\\"abc123def\\",\\"a\\":1}', '\\"token\\":\\"<hidden>\\"', 'abc123def'),
        ('GroupRule:{Device:[]} Token:fake-43f626d9319ba164c4b88e3a}', 'Token:<hidden>', 'fake-43f6'),
        ('login password=hunter22&next=1', 'password=<hidden>', 'hunter22'),
        ('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y', 'Authorization: <hidden>', 'eyJhbGci'),
        ('licenseKey = ABCD-EFGH-1234', 'licenseKey = <hidden>', 'ABCD-EFGH'),
        ('device token store successful:fake-43f626d9319ba164c', 'successful:<hidden>', 'fake-43f6'),
    ]
    for src, want, gone in cases:
        out = V.scrub(src)
        ok(want in out and gone not in out, 'scrubbed: %s -> %s' % (src[:40], out[:60]))
    keep = 'at System.ServiceModel.Security.SecurityTokenAuthenticator.Open(TimeSpan timeout); getDeviceToken, device.go:522; supports License applications.'
    ok(V.scrub(keep) == keep, 'left alone: TokenAuthenticator, getDeviceToken, "License applications"')


def t_logs():
    base = os.path.join(TMP, 'vendorlogs'); a = os.path.join(base, 'AppA', 'log'); b = os.path.join(base, 'AppB', 'logs', 'sub')
    os.makedirs(a); os.makedirs(b)
    now = time.time()
    def put(p, data, age_days=0):
        with open(p, 'wb') as f: f.write(data)
        os.utime(p, (now - age_days * 86400, now - age_days * 86400))
    put(os.path.join(a, 'new.log'), b'line one\n{"password":"s3cret!!"}\nline three\n')
    put(os.path.join(a, 'old.log'), b'old stuff\n', age_days=10)
    put(os.path.join(a, 'big.log'), b''.join(b'%06d xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n' % i for i in range(20000)))   # ~1 MB
    put(os.path.join(a, 'rot.log.1'), b'rotated Token:abcdefgh1234\n')
    put(os.path.join(a, 'older.log'), b'y' * 50000 + b'\n', age_days=1)
    put(os.path.join(b, 'ucenter.log.gz'), gzip.compress(b'gz line\nsecret=topsecret99\n'))
    put(os.path.join(b, 'image.png'), b'\x89PNG not a log')
    put(os.path.join(b, 'utf16.log'), 'wide text log\r\n'.encode('utf-16'))
    places = [('AppA', a), ('AppB', os.path.join(base, 'AppB', 'logs')), ('Gone', os.path.join(base, 'nothere'))]
    out = dict(V.report_logs(days=3, max_each=64 * 1024, max_total=200 * 1024, places=places))
    names = sorted(out)
    ok('vendor/logs/INDEX.md' in out, 'INDEX.md is there')
    ok(not any('old.log' in n for n in names) and not any('image.png' in n for n in names), 'older than the days, and non-logs, left out')
    ok(any(n.endswith('AppB/AppB-logs/sub/ucenter.log') for n in names), '.gz unpacked, named by its place: %s' % [n for n in names if 'ucenter' in n])
    big = [t for n, t in out.items() if n.endswith('big.log')]
    ok(big and len(big[0]) <= 64 * 1024 and big[0].startswith('0') and big[0].rstrip().endswith('x') and '019999' in big[0], 'a big file: only its end, whole lines (%d bytes)' % (len(big[0]) if big else -1))
    allt = ''.join(out.values())
    ok('s3cret!!' not in allt and 'topsecret99' not in allt and 'abcdefgh1234' not in allt and allt.count('<hidden>') >= 3, 'passwords / tokens / secrets hidden in the logs')
    ok(any('wide text log' in t for t in out.values()), 'a UTF-16 log is read as text')
    ok('the last 64 KB' in out['vendor/logs/INDEX.md'] or 'the last 63 KB' in out['vendor/logs/INDEX.md'], 'INDEX says a file was cut')
    small = dict(V.report_logs(days=3, max_each=64 * 1024, max_total=40 * 1024, places=places))
    ok(sum(len(t) for n, t in small.items() if n != 'vendor/logs/INDEX.md') <= 40 * 1024 + 2000 and 'left out' in small['vendor/logs/INDEX.md'], 'the total cap holds; what didn’t fit is listed as left out')
    keep, V.LOG_PLACES = V.LOG_PLACES, places
    try: pl = {x['app']: x for x in V.log_places(3)}
    finally: V.LOG_PLACES = keep
    ok(set(pl) == {'AppA', 'AppB'} and pl['AppA']['files'] == 5 and pl['AppA']['recent'] == 4, 'log folders listed with counts (missing ones skipped): %s' % {k: (v['files'], v['recent']) for k, v in pl.items()})


# ------------------------------------------------------------------ capture import + dumpcap stand-in
def tg_frame(serial, addr, data=b'', op=1, dev=0, reply=False, status=0):
    if reply: h = bytearray(b'\xAA\x55') + bytes([status, serial, 0x00, 0xFE])
    else: h = bytearray(b'\x55\xAA') + bytes([0, serial, 0xFE, 0x00])
    h += bytes([dev, 0]) + struct.pack('<HBBIH', 0, op, 0, addr, len(data) if (op == 1 or reply) else 2)
    b = bytes(h) + (data if (op == 1 or reply) else b'')
    return b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF)


def sample_pcap():
    t = 1761600000.0
    recs = [{'seq': 1, 't': t, 'kind': 'udp', 'dir': 'tx', 'peer': '192.168.0.10:3800', 'hex': b'rqProMI:'.hex(), 'proto': 'nova'},
            {'seq': 2, 't': t + .01, 'kind': 'udp', 'dir': 'rx', 'peer': '192.168.0.10:3800', 'hex': b'rpProMI:Hello'.hex(), 'proto': 'nova'}]
    q = tg_frame(1, 0x00000002, op=0); r = tg_frame(1, 0x00000002, b'\x4A\x7B', reply=True)
    recs += [{'seq': 3, 't': t + .1, 'kind': 'tg', 'link': '192.168.0.10:5200', 'dir': 'tx', 'hex': q.hex()},
             {'seq': 4, 't': t + .12, 'kind': 'tg', 'link': '192.168.0.10:5200', 'dir': 'rx', 'hex': r.hex()}]
    return wirelog.to_pcap(recs)


def t_import():
    pc = sample_pcap()
    r = V.import_capture('lct session.pcap', pc)
    ok(r['ok'] and r['total'] >= 4 and r['kinds'].get('tg') == 2 and r['kinds'].get('udp') == 2, 'pcap imported: 2 frames, 2 discovery packets (%s)' % r.get('kinds'))
    p = os.path.join(wirelog.DIAG_DIR, *r['nwl'].split('/'))
    ok(r['nwl'].startswith(time.strftime('%Y-%m-%d') + '/vendor/captures/') and os.path.isfile(p), 'the .nwl is in <day>/vendor/captures/: %s' % r['nwl'])
    recs = wirelog.load(r['nwl'])
    tg = [x for x in recs if x['kind'] == 'tg']
    ok(tg and tg[0]['dir'] == 'tx' and tg[1]['dir'] == 'rx' and 'ModelID' in tg[0].get('sum', '') + tg[0]['d'].get('name', '') or tg and tg[1].get('rtt') is not None,
       'decoded like the recorder’s (direction, names, round trip); Diagnostics opens it by name')
    orig = os.path.join(wirelog.DIAG_DIR, *r['original'].split('/'))
    ok(r['original'].endswith('.pcap') and open(orig, 'rb').read() == pc, 'the original capture is kept, unchanged')
    bad = V.handle('/api/hw/vendor/import', {'name': 'x.txt', 'data': base64.b64encode(b'hello, not a capture at all').decode()})
    ok(not bad['ok'] and 'not a Wireshark' in bad['error'], 'a file that isn’t a capture is refused')
    files = V.vendor_files()
    ok(any(f['name'] == r['nwl'] and f['kind'] == 'recording' for f in files), 'vendor_files lists it')


FAKE_DUMPCAP = r'''import sys, time, signal
a = sys.argv[1:]
if '-D' in a:
    print('1. \\Device\\NPF_{TEST} (Test adapter)'); print('2. \\Device\\NPF_Loopback (Adapter for loopback traffic capture)'); sys.exit(0)
if a[a.index('-i') + 1] == 'deny':
    print('dumpcap: The capture session could not be initiated (Access is denied; Npcap is restricted to administrators)'); sys.exit(2)
open(a[a.index('-w') + 1], 'wb').write(bytes.fromhex(open(%r).read()))
while True: time.sleep(0.2)
'''


def t_dumpcap():
    hexf = os.path.join(TMP, 'sample.hex')
    with open(hexf, 'w') as f: f.write(sample_pcap().hex())
    fd = os.path.join(TMP, 'fake_dumpcap.py')
    with open(fd, 'w', encoding='utf-8') as f: f.write(FAKE_DUMPCAP % hexf)
    os.environ['OPENNOVA_DUMPCAP'] = fd
    try:
        i = V.interfaces()
        ok(i['ok'] and [x['desc'] for x in i['interfaces']] == ['Test adapter', 'Adapter for loopback traffic capture'], 'interfaces from dumpcap -D')
        d = V.capture_start('deny', V.FILTERS['lct'], 1)
        ok(not d['ok'] and d.get('needsAdmin'), 'a capture that needs admin: no elevation, the error says so')
        s = V.capture_start('\\Device\\NPF_{TEST}', V.FILTERS['lct'], 1)
        ok(s['ok'] and s['capture']['running'], 'capture started (stand-in dumpcap)')
        r = V.capture_stop()
        ok(r['ok'] and r['kinds'].get('tg') == 2 and r['original'].endswith('_live.pcapng'), 'stopped and added like an import: %s' % r.get('nwl'))
    finally:
        os.environ.pop('OPENNOVA_DUMPCAP', None)


# ------------------------------------------------------------------ relay: NovaLCT TG
class TgDevice:
    """Stand-in processor: UDP discovery on DEV:udp (rpProMI with H_SUB_CARD ports), TCP on DEV:port; replies AA 55 to every
    request, and sends a request back (an H's echo) for address 0x0E000000. Keeps every byte it got."""
    def __init__(self, udp, tcp_ports):
        self.got, self.sent = b'', b''
        self.u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); self.u.bind((DEV, udp))
        self.text = b'rpProMI:' + b''.join(b'H_SUB_CARD@^^@%d' % p for p in tcp_ports)
        threading.Thread(target=self.udp, daemon=True).start()
        self.srvs = []
        for p in tcp_ports:
            s = socket.socket(); s.bind((DEV, p)); s.listen(4); self.srvs.append(s)
            threading.Thread(target=self.accept, args=(s,), daemon=True).start()

    def udp(self):
        while True:
            try: d, a = self.u.recvfrom(4096)
            except OSError: return
            if d.startswith(b'rqProMI'): self.u.sendto(self.text, a)

    def accept(self, s):
        while True:
            try: c, _ = s.accept()
            except OSError: return
            threading.Thread(target=self.serve, args=(c,), daemon=True).start()

    def serve(self, c):
        buf = b''
        while True:
            try: d = c.recv(65536)
            except OSError: return
            if not d: return
            self.got += d; buf += d
            while True:
                i = buf.find(b'\x55\xAA')
                if i < 0 or len(buf) - i < 20: break
                n = struct.unpack_from('<H', buf, i + 16)[0] if buf[i + 10] == 1 else 0
                if len(buf) - i < 20 + n: break
                req, buf = buf[i:i + 20 + n], buf[i + 20 + n:]
                addr = struct.unpack_from('<I', req, 12)[0]
                out = b''
                if addr == 0x0E000000: out += req                      # the H returns it (an echo)
                out += tg_frame(req[3], addr, b'\x4A\x7B' if req[10] == 0 else b'', reply=True)
                self.sent += out; c.sendall(out)

    def close(self):
        for s in self.srvs + [self.u]: s.close()


def t_relay_lct():
    dev = TgDevice(13800, [5231, 5232])
    r = V.Relay('lct', DEV, RIP, discovery=True, disc_port=13801, target_disc_port=13800).start()
    try:
        ok(sorted(r.ports) == [5231, 5232], 'learned the ports from the processor’s discovery answer: %s' % r.ports)
        app = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); app.bind(('127.0.0.1', 0)); app.settimeout(3)
        app.sendto(b'rqProMI:', ('127.0.0.1', 13801))                   # NovaLCT's loopback probe
        d, a = app.recvfrom(4096); app.close()
        ok(d == dev.text and a[0] == RIP, 'the vendor app got the processor’s own answer, unchanged, from the relay address %s' % a[0])
        c = socket.create_connection((RIP, 5231), 3); c.settimeout(3)
        frames = [tg_frame(1, 0x00000002, op=0), tg_frame(2, 0x02000001, b'\xFF'), tg_frame(3, 0x0E000000, b'\x01\x02')]
        blob = b''.join(frames) + b'\x00\x13\x37'                         # plus bytes that aren't a frame
        c.sendall(blob[:7]); time.sleep(0.05); c.sendall(blob[7:30]); time.sleep(0.05); c.sendall(blob[30:])   # split anywhere
        want = len(tg_frame(1, 2, b'\x4A\x7B', reply=True)) + len(tg_frame(2, 0x02000001, reply=True)) * 2 + len(frames[2])
        got = b''; end = time.time() + 3
        while len(got) < want and time.time() < end:
            try: got += c.recv(65536)
            except socket.timeout: break
        c.close(); time.sleep(0.3)
        ok(dev.got == blob, 'processor got exactly what the vendor app sent (%d bytes)' % len(dev.got))
        ok(got == dev.sent, 'vendor app got exactly what the processor sent (%d bytes)' % len(got))
        recs = tape_records(r)
        tg = [x for x in recs if x['kind'] == 'tg']
        ok(len([x for x in tg if x['dir'] == 'tx']) == 3 and len([x for x in tg if x['dir'] == 'rx']) == 3, 'recorded 3 requests and 3 replies')
        ok(all(x['link'] == '%s:5231' % DEV for x in tg) and any(x.get('rtt') is not None for x in tg if x['dir'] == 'rx'), 'recorded on the processor’s link, with round-trip times')
        ok(any(x['kind'] == 'echo' and x.get('of') for x in recs), 'the H-style echo recorded as an echo of its request')
        ok(any(x['kind'] == 'junk' and x['hex'] == '001337' for x in recs), 'the stray bytes recorded as junk')
        ok(any(x['kind'] == 'udp' and x['dir'] == 'rx' and 'H_SUB_CARD' in x.get('text', '') for x in recs), 'discovery recorded')
        ok(any(x['kind'] == 'conn' and x['event'] == 'open' and 'relay %s:5231' % RIP in x['via'] for x in recs), 'connection recorded with the relay path')
        loaded = wirelog.load(V._rel(r.tape.files[0]))
        ok(len(loaded) >= len(recs) - 1 and wirelog.to_pcap(loaded)[:4] == b'\xd4\xc3\xb2\xa1', 'the relay recording opens in Diagnostics and exports to Wireshark')
        st = r.status()
        ok(st['opened'] == 1 and st['up'] == len(blob) and st['down'] == len(got) and st['probes'] == 1 and st['answers'] == 1, 'status counts: %s' % {k: st[k] for k in ('opened', 'up', 'down', 'probes', 'answers')})
    finally:
        r.stop(); dev.close()
    try:
        socket.create_connection((RIP, 5231), 1).close(); ok(False, 'stopped relay no longer listens')
    except OSError:
        ok(True, 'stopped relay no longer listens')


# ------------------------------------------------------------------ relay: Unico (HTTP + WebSocket) and COEX
def ws_frame(op, payload, mask=None):
    n = len(payload)
    m = 0x80 if mask else 0
    h = bytes([0x80 | op]) + (bytes([m | n]) if n < 126 else bytes([m | 126]) + struct.pack('>H', n) if n < 65536 else bytes([m | 127]) + struct.pack('>Q', n))
    if mask: return h + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return h + payload


class HttpDevice:
    """Stand-in Unico / COEX device on DEV:port: a JSON POST, a chunked GET, then a WebSocket (101) that answers with a
    binary NOVA push and a ping. Keeps every byte. Unico discovery on DEV:udp (NOVA reply naming the port)."""
    def __init__(self, port, udp=None):
        self.got, self.sent = b'', b''
        self.s = socket.socket(); self.s.bind((DEV, port)); self.s.listen(4); self.port = port
        threading.Thread(target=self.accept, daemon=True).start()
        self.u = None
        if udp:
            self.u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); self.u.bind((DEV, udp))
            self.reply = V.nova_frame([(0x00010001, 0, json.dumps({'SN': 'TESTSN1', 'modelId': 25132, 'protocols': [
                {'linkType': 'http', 'port': port}, {'linkType': 'websocket', 'port': port}, {'linkType': 'udp', 'port': 5600}]}).encode())], response=True)
            threading.Thread(target=self.udp, daemon=True).start()

    def udp(self):
        while True:
            try: d, a = self.u.recvfrom(4096)
            except OSError: return
            if V.is_probe('unico', d): self.u.sendto(self.reply, a)

    def accept(self):
        while True:
            try: c, _ = self.s.accept()
            except OSError: return
            threading.Thread(target=self.serve, args=(c,), daemon=True).start()

    def out(self, c, b): self.sent += b; c.sendall(b)

    def serve(self, c):
        buf = b''
        while True:
            try: d = c.recv(65536)
            except OSError: return
            if not d: return
            self.got += d; buf += d
            while b'\r\n\r\n' in buf:
                head, rest = buf.split(b'\r\n\r\n', 1); first = head.split(b'\r\n')[0]
                n = int(([l.split(b':')[1] for l in head.split(b'\r\n') if l.lower().startswith(b'content-length')] or [b'0'])[0])
                if len(rest) < n: break
                body, buf = rest[:n], rest[n:]
                if first.startswith(b'POST'):
                    j = b'{"code":0,"data":{"token":"tok-SECRET-123"},"message":"ok"}'
                    self.out(c, b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n' % len(j) + j)
                elif b'chunked' in first:
                    self.out(c, b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{"a":\r\n3\r\n12}\r\n0\r\n\r\n')
                elif b'/ws' in first:
                    k = [l.split(b':', 1)[1].strip() for l in head.split(b'\r\n') if l.lower().startswith(b'sec-websocket-key')][0]
                    acc = base64.b64encode(hashlib.sha1(k + b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest())
                    self.out(c, b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + b'\r\n\r\n')
                    push = V.nova_frame([(0x00102101, 0, b'{"seq":0,"sn":"TESTSN1"}'), (327936, 0, b'{"status":1}')])
                    self.out(c, ws_frame(2, push) + ws_frame(9, b''))
                    self.wsloop(c, buf); return
                else:
                    j = b'{"code":0,"data":{"mac":"02:00:00:00:51:41"}}'
                    self.out(c, b'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n' % len(j) + j)

    def wsloop(self, c, buf):
        while True:
            try: d = c.recv(65536)
            except OSError: return
            if not d: return
            self.got += d

    def close(self):
        self.s.close()
        if self.u: self.u.close()


def http_exchange(port, ws=True):
    c = socket.create_connection((RIP, port), 3); c.settimeout(3)
    sent = b''
    def send(b):
        nonlocal sent; sent += b; c.sendall(b)
    body = b'{"username":"admin","password":"MTIzNDU2"}'
    send(b'POST /unico/v1/system/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n' % len(body) + body)
    send(b'GET /unico/v1/chunked HTTP/1.1\r\nHost: x\r\nAuthorization: tok-SECRET-123\r\n\r\n')
    if ws:
        send(b'GET /unico/v1/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
    got = b''; end = time.time() + 2
    while time.time() < end:
        try: d = c.recv(65536)
        except socket.timeout: break
        if not d: break
        got += d
        if (not ws and got.count(b'HTTP/1.1') >= 2 and got.endswith(b'0\r\n\r\n')) or (ws and got.endswith(b'\x89\x00')): break
    if ws:
        send(ws_frame(1, b'{"hello":"device","password":"pw123456"}', mask=b'\x11\x22\x33\x44'))
        send(ws_frame(10, b'', mask=b'\x01\x02\x03\x04'))
        time.sleep(0.2)
    c.close(); time.sleep(0.3)
    return sent, got


def t_relay_unico():
    dev = HttpDevice(18088, udp=15600)
    r = V.Relay('unico', DEV, RIP, discovery=True, disc_port=15601, target_disc_port=15600).start()
    try:
        ok(r.ports == [18088], 'Unico: port learned from the NOVA discovery answer: %s' % r.ports)
        app = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); app.bind(('127.0.0.1', 0)); app.settimeout(3)
        probe = V.nova_frame([(0x00010001, 0, V.NOVA_SEARCH)], seq=77)
        app.sendto(probe, ('127.0.0.1', 15601)); d, a = app.recvfrom(4096); app.close()
        ok(d == dev.reply and a[0] == RIP, 'UCenter-style probe answered with the device’s own reply, from %s' % a[0])
        sent, got = http_exchange(18088)
        ok(dev.got == sent, 'device got exactly what the app sent (%d bytes, incl. WebSocket frames)' % len(dev.got))
        ok(got == dev.sent, 'app got exactly what the device sent (%d bytes)' % len(got))
        recs = tape_records(r)
        h = [x for x in recs if x['kind'] == 'http']
        ok(len(h) == 3 and [x['status'] for x in h] == [200, 200, 101], 'three HTTP calls paired with their answers: %s' % [(x['method'], x['url'], x['status']) for x in h])
        ok(h and h[0]['url'] == 'http://%s:18088/unico/v1/system/auth/login' % DEV, 'URL on the processor’s link')
        ok(h and h[1]['resp']['text'] == '{"a":12}', 'chunked answer put together')
        alltext = json.dumps(recs)
        ok('MTIzNDU2' not in alltext and 'tok-SECRET-123' not in alltext and 'pw123456' not in alltext, 'no login, token or password in the recording')
        w = [x for x in recs if x['kind'] == 'ws']
        ok(any(x['dir'] == 'rx' and x.get('nova') and x['nova'][1][0] == '0x%08X' % 327936 for x in w), 'WebSocket push decoded (NOVA frame, tag 327936)')
        ok(any(x['dir'] == 'tx' and x['op'] == 1 and 'hello' in x.get('text', '') for x in w), 'masked client text frame unmasked and recorded')
        ok(any(x['op'] == 9 for x in w) and any(x['op'] == 10 for x in w), 'ping / pong recorded')
    finally:
        r.stop(); dev.close()


def t_relay_coex():
    dev = HttpDevice(18001)
    lis = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); lis.bind(('127.0.0.1', 0)); lis.settimeout(4)
    r = V.Relay('coex', DEV, RIP, ports=[18001], announce_to=[('127.0.0.1', lis.getsockname()[1])], coex_mac='02:00:00:00:51:41').start()
    try:
        d, a = lis.recvfrom(4096)
        j = json.loads(d)
        ok(a[0] == RIP and j['data'][0]['apiPort'] == '18001' and j['data'][0]['mac'] == '02:00:00:00:51:41' and j['data'][0]['authType'] == 0,
           'COEX: XCenter-style announcement from the relay address: %s' % d.decode())
        sent, got = http_exchange(18001, ws=False)
        ok(dev.got == sent and got == dev.sent and got, 'COEX: HTTP passed both ways unchanged (%d / %d bytes)' % (len(sent), len(got)))
        ok(len([x for x in tape_records(r) if x['kind'] == 'http']) == 2, 'COEX: two calls recorded')
    finally:
        r.stop(); dev.close(); lis.close()


# ------------------------------------------------------------------ relay: everything recorded whole (as wirelog does)
def http_resp(ctype, body, extra=b''):
    return b'HTTP/1.1 200 OK\r\nContent-Type: %s\r\n%sContent-Length: %d\r\n\r\n' % (ctype, extra, len(body)) + body


class BodyDevice:
    """Stand-in HTTP device for the lossless checks: answers a path from `routes` (whole response bytes), /ws with 101 and
    then only listens, /noanswer never. Keeps every byte it got and sent."""
    def __init__(self, port, routes):
        self.routes, self.got, self.sent = routes, b'', b''
        self.s = socket.socket(); self.s.bind((DEV, port)); self.s.listen(4)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            try: c, _ = self.s.accept()
            except OSError: return
            threading.Thread(target=self.serve, args=(c,), daemon=True).start()

    def serve(self, c):
        buf, ws = b'', False
        while True:
            try: d = c.recv(1 << 20)
            except OSError: break
            if not d: break
            self.got += d
            if ws: continue
            buf += d
            while b'\r\n\r\n' in buf:
                head, rest = buf.split(b'\r\n\r\n', 1)
                n = int(([l.split(b':')[1] for l in head.split(b'\r\n') if l.lower().startswith(b'content-length')] or [b'0'])[0])
                if len(rest) < n: break
                buf = rest[n:]; path = head.split(b' ')[1].decode()
                out = b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n' if path == '/ws' else self.routes.get(path, b'')
                if out: self.sent += out; c.sendall(out)
                if path == '/ws': ws = True; break
        c.close()

    def close(self):
        self.s.close()


def side_or_inline(b):
    return wirelog.body_bytes(b)


def t_relay_lossless_http():
    big_req = b'{"password":"bigsecret9","blob":"' + b'a' * (5 * 1024 * 1024) + b'"}'
    big_resp = json.dumps({'code': 0, 'data': ''.join(chr(48 + i % 40) for i in range(5 * 1024 * 1024 + 7))}).encode()
    bin_req = bytes(range(256)) * 64 + b'\xff\xfe\x00'
    bin_resp = b'\x00\x01\xfe\xff' + bytes((i * 31 + 7) & 0xFF for i in range(70000))
    login_resp = b'{"code":0,"data":{"token":"tok-LOGIN-777","userName":"admin"}}'
    routes = {'/big': http_resp(b'application/json', big_resp), '/bin': http_resp(b'application/octet-stream', bin_resp),
              '/unico/v1/system/auth/login': http_resp(b'application/json', login_resp, b'Set-Cookie: sid=cookie-SECRET-1\r\n'),
              '/gz': http_resp(b'application/json', gzip.compress(b'{"zipped":true}'), b'Content-Encoding: gzip\r\n')}
    dev = BodyDevice(18090, routes)
    r = V.Relay('unico', DEV, RIP, ports=[18090], discovery=False).start()
    try:
        c = socket.create_connection((RIP, 18090), 3); c.settimeout(5)
        login = b'{"username":"admin","password":"hunter22"}'
        reqs = [b'POST /big HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n' % len(big_req) + big_req,
                b'POST /bin HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\n\r\n' % len(bin_req) + bin_req,
                b'POST /unico/v1/system/auth/login HTTP/1.1\r\nHost: x\r\nCookie: sid=cookie-SECRET-0\r\nContent-Length: %d\r\n\r\n' % len(login) + login,
                b'GET /gz HTTP/1.1\r\nHost: x\r\nAuthorization: tok-HEADER-SECRET\r\n\r\n']
        sent = b''.join(reqs); c.sendall(sent)
        want = sum(len(routes[p]) for p in ('/big', '/bin', '/unico/v1/system/auth/login', '/gz'))
        got = b''; end = time.time() + 20
        while len(got) < want and time.time() < end:
            try: got += c.recv(1 << 20)
            except socket.timeout: break
        up = b'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n'
        c.sendall(up); sent += up
        while not got.endswith(b'Connection: Upgrade\r\n\r\n') and time.time() < end:
            try: got += c.recv(65536)
            except socket.timeout: break
        time.sleep(0.3)
        ws_bin = bytes((i * 13 + 5) & 0xFF for i in range(100000))
        frames = [ws_frame(9, b'p%d' % i, mask=b'\x01\x02\x03\x04') for i in range(6)] + [ws_frame(2, ws_bin, mask=b'\x05\x06\x07\x08'),
                  ws_frame(1, b'{"cmd":"login","password":"pw-WS-555"}', mask=b'\x09\x0a\x0b\x0c')]
        for f in frames: c.sendall(f); sent += f
        time.sleep(0.3); c.close()
        c2 = socket.create_connection((RIP, 18090), 3)                       # a request the device never answers
        lone = b'POST /noanswer HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello'
        c2.sendall(lone); time.sleep(0.3); c2.close(); time.sleep(1.0)
        ok(dev.got == sent + lone and got == dev.sent, 'lossless relay: both ways passed on byte for byte (%d up, %d down)' % (len(sent) + len(lone), len(got)))
        recs = tape_records(r)
        h = {x['url'].split(':18090')[1]: x for x in recs if x['kind'] == 'http'}
        b = h.get('/big', {})
        day = time.strftime('%Y-%m-%d') + '/bodies/'
        ok(b.get('req', {}).get('file', '').startswith(day) and b.get('resp', {}).get('file', '').startswith(day),
           'a 5 MB body each way goes to a side file under <day>/bodies/ (%s, %s)' % (b.get('req', {}).get('file'), b.get('resp', {}).get('file')))
        ok(b and side_or_inline(b['resp']) == big_resp and b['resp']['n'] == len(big_resp), 'the big answer is in its side file byte for byte (%d bytes)' % len(big_resp))
        ok(b and side_or_inline(b['req']) == big_req.replace(b'bigsecret9', b'<hidden>'), 'the big request too, byte for byte, with only its password masked')
        bi = h.get('/bin', {})
        ok(bi.get('req', {}).get('b64') and side_or_inline(bi['req']) == bin_req and side_or_inline(bi.get('resp')) == bin_resp,
           'binary bodies are kept as base64 and come back whole (%d / %d bytes)' % (len(bin_req), len(bin_resp)))
        ok(h.get('/gz', {}).get('resp', {}).get('text') == '{"zipped":true}' and h['/gz']['resp'].get('gzip'), 'a gzipped answer is recorded unpacked (its wire size in "gzip")')
        lg = h.get('/unico/v1/system/auth/login', {})
        ok('"username":"<hidden>"' in lg.get('req', {}).get('text', '') and '"password":"<hidden>"' in lg.get('req', {}).get('text', '')
           and '"token":"<hidden>"' in lg.get('resp', {}).get('text', ''), 'login: user name, password and the token answered are masked')
        ok(lg.get('reqh', {}).get('Cookie') == '<hidden>' and lg.get('resph', {}).get('Set-Cookie') == '<hidden>' and h.get('/gz', {}).get('reqh', {}).get('Authorization') == '<hidden>'
           and h.get('/big', {}).get('reqh', {}).get('Content-Type') == 'application/json', 'headers recorded both ways, cookie / authorization masked')
        na = h.get('/noanswer', {})
        ok(na.get('status') is None and 'no answer' in na.get('error', '') and na.get('req', {}).get('text') == 'hello', 'a request that never got an answer is recorded when the connection closes')
        w = [x for x in recs if x['kind'] == 'ws' and x['dir'] == 'tx']
        ok(len([x for x in w if x['op'] == 9]) == 6, 'every ping recorded (%d of 6), not only the first few' % len([x for x in w if x['op'] == 9]))
        wb = [x for x in w if x['op'] == 2]
        ok(wb and wb[0]['n'] == len(ws_bin) and side_or_inline(wb[0].get('data')) == ws_bin, 'a 100 KB binary WebSocket frame is recorded whole (base64)')
        ok(any(x['op'] == 1 and '"password":"<hidden>"' in x.get('text', '') for x in w), 'a WebSocket text frame with a password: masked')
        alltext = json.dumps(recs) + ''.join(side_or_inline(x[k]).decode('latin1') for x in recs if x['kind'] == 'http' for k in ('req', 'resp') if x.get(k))
        gone = [s for s in ('hunter22', 'tok-LOGIN-777', 'bigsecret9', 'cookie-SECRET', 'tok-HEADER-SECRET', 'pw-WS-555') if s in alltext]
        ok(not gone, 'no password, token, cookie or login anywhere in the recording or its side files%s' % (': ' + ', '.join(gone) if gone else ''))
    finally:
        r.stop(); dev.close()


def t_relay_lossless_lct():
    big = b'rpProMI:' + b'x' * 60000 + b'H_SUB_CARD@^^@5233'          # a 60 KB discovery answer
    dev = TgDevice(13810, [5233]); dev.text = big
    r = V.Relay('lct', DEV, RIP, discovery=True, disc_port=13811, target_disc_port=13810).start()
    try:
        ok(r.ports == [5233], 'LCT: the port learned from a 60 KB discovery answer')
        app = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); app.bind(('127.0.0.1', 0)); app.settimeout(3)
        app.sendto(b'rqProMI:', ('127.0.0.1', 13811)); d, _ = app.recvfrom(65535); app.close()
        ok(d == big, 'the vendor app got the 60 KB answer unchanged')
        stray = bytes(i % 50 + 1 for i in range(5000))                    # no 55 AA / AA 55 in it
        tail = tg_frame(9, 0x02000001, b'\x01')[:10]                         # a frame cut off by the close
        c = socket.create_connection((RIP, 5233), 3); c.settimeout(3)
        c.sendall(stray + tg_frame(1, 0x00000002, op=0)); time.sleep(0.3); c.sendall(tail); time.sleep(0.3); c.close(); time.sleep(0.5)
        recs = tape_records(r)
        u = [x for x in recs if x['kind'] == 'udp' and x['dir'] == 'rx']
        ok(len(u) >= 2 and all(bytes.fromhex(x['hex']) == big and x['n'] == len(big) and len(x.get('text', '')) == len(big) for x in u),
           'every 60 KB discovery answer recorded whole (%d of them: hex and text)' % len(u))
        j = [x for x in recs if x['kind'] == 'junk']
        ok(any(bytes.fromhex(x['hex']) == stray and x['n'] == 5000 for x in j), 'stray TCP bytes recorded whole (5000, not the first 512)')
        ok(any(bytes.fromhex(x['hex']) == tail and 'closed' in x.get('note', '') for x in j), 'bytes left when the connection closed are recorded too')
        ok(dev.got == stray + tg_frame(1, 0x00000002, op=0) + tail, 'LCT: the processor got every byte unchanged')
    finally:
        r.stop(); dev.close()


def t_relay_refusals():
    for kind, tgt, ip, why in (('nova', DEV, RIP, 'kind'), ('lct', '', RIP, 'address'), ('lct', RIP, RIP, 'address'), ('lct', DEV, '0.0.0.0', 'one address')):
        r = V.relay_start({'kind': kind, 'target': tgt, 'relayIp': ip})
        ok(not r['ok'] and why in r['error'], 'refused: %s %r via %r (%s)' % (kind, tgt, ip, r['error']))
    st = V.relay_status()
    ok(st['ok'] and st['relays'] == [], 'nothing left running')


def t_report():
    md = '\n'.join(V.report_md({'apps': [{'name': 'NovaLCT', 'version': '5.9.2', 'running': [1], 'service': '', 'talksTo': ['192.168.0.10:5200'], 'listens': []}],
                                 'capture': {'wireshark': '', 'dumpcap': '', 'tcpdump': '', 'npcap': {'installed': False}}, 'note': ''}))
    ok('## NovaStar apps on this computer' in md and '| NovaLCT | 5.9.2 | yes (PID 1) | 192.168.0.10:5200 |' in md and 'vendor/captures/' in md, 'REPORT.md section')


for t in (t_parsing, t_scrub, t_logs, t_import, t_dumpcap, t_relay_lct, t_relay_unico, t_relay_coex, t_relay_lossless_http, t_relay_lossless_lct,
          t_relay_refusals, t_report):
    try: t()
    except Exception as e:  # noqa: BLE001
        import traceback; traceback.print_exc(); ok(False, '%s raised %s: %s' % (t.__name__, type(e).__name__, e))
print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
