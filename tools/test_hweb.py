"""Tests for hweb.py (the H series' web API: DES login form, saved logins on this computer only, chassis / output cards) and
novalink's MultiLink (one H chassis over several output-slot links), against stand-ins only (fake_hweb.py, small TG
servers on 127.0.0.1): nothing goes to real hardware.   python -I tools/test_hweb.py   (exit 0 = all passed)
"""
import glob
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import urllib.request

CFG = tempfile.mkdtemp(prefix='opennova_cfg_test_')
DIAG = tempfile.mkdtemp(prefix='opennova_diag_test_')
os.environ['OPENNOVA_CONFIG_DIR'] = CFG
os.environ['OPENNOVA_DIAG'] = DIAG
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hweb        # noqa: E402
import fake_hweb   # noqa: E402
import novalink    # noqa: E402
import wirelog     # noqa: E402

PW = 'pw-' + os.urandom(4).hex()   # a test password made up here
fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


# ---------------------------------------------------------------- DES / the web page's form
ok(hweb.des_block(bytes.fromhex('0123456789ABCDEF'), hweb._subkeys(bytes.fromhex('133457799BBCDFF1'))).hex().upper() == '85E813540F0AB405',
   'DES: the classic test vector')
ok(hweb.web_cipher('admin') == 'OlEjflmqZcU=', 'web form of "admin" is what the H web page sent')
ok(len(hweb.web_cipher('12345678')) == 24, 'PKCS7: a full block of padding after 8 bytes')

# ---------------------------------------------------------------- against the fake H
fake = fake_hweb.FakeH(model=29963, cards=[(1, 0x7B48)], password=PW)
srv = fake_hweb.serve(fake)
hweb.PORT = srv.server_address[1]
H = '127.0.0.1'
r = hweb.info(H)
ok(r == {'ok': False, 'login': False, 'error': r.get('error')} and fake.logins == 0, 'no saved login: nothing is sent, login:false')
r = hweb.login(H, 'admin', 'wrong')
ok(not r['ok'] and r['error'] == 'wrong password' and not hweb.has_login(H), 'wrong password: refused, not saved')
r = hweb.login(H, 'nobody', PW)
ok(not r['ok'] and 'user' in r['error'], 'unknown user: refused')
r = hweb.login(H, 'admin', PW)
ok(r['ok'] and r['modelId'] == 29963 and r['ledCards'] == [{'slot': 1, 'modelId': 0x7B48, 'dynSubpixel': 0}], 'login: saved, chassis model and LED cards read (%s)' % r.get('ledCards'))
ok(any(o['category'] == 7 for o in r['outputs']), 'the HDMI output card is listed but not counted as an LED card')
store = os.path.join(CFG, 'h-logins.json'); txt = open(store, encoding='utf-8').read()
ok(os.path.exists(store) and PW not in txt and hweb.web_cipher(PW) in txt, 'saved in the config dir in the web form only, not as typed')
if os.name == 'posix': ok(oct(os.stat(store).st_mode & 0o777) == '0o600', 'store is 0600')
n = fake.logins; r = hweb.info(H)
ok(r['ok'] and fake.logins == n, 'info reuses the session token')
fake.tokens.clear(); r = hweb.info(H)
ok(r['ok'] and fake.logins == n + 1, 'a refused token logs in again once')
ok(hweb.forget(H) and not hweb.has_login(H) and hweb.info(H)['login'] is False, 'forget removes it')
try: hweb._host_ok('usb:0483:5720@1-1'); ok(False, 'a USB location is not an H address')
except hweb.HWebError: ok(True, 'a USB location is not an H address')
os.environ['OPENNOVA_CONFIG_DIR'] = os.path.join(hweb.NOVA, 'app', 'data')
try: hweb.config_dir(); ok(False, 'a store inside the Open Nova folder is refused')
except hweb.HWebError: ok(True, 'a store inside the Open Nova folder (synced) is refused')
os.environ['OPENNOVA_CONFIG_DIR'] = CFG

# ---------------------------------------------------------------- MultiLink: one H over several links
def tg_server(model, seen):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(4)
    def run():
        while True:
            try: c, _ = s.accept()
            except OSError: return
            buf = b''
            while True:
                try: d = c.recv(65536)
                except OSError: break
                if not d: break
                buf += d
                while len(buf) >= 20:
                    n = struct.unpack_from('<H', buf, 16)[0]; op = buf[10]; ln = 20 + (n if op == 1 else 0)
                    if len(buf) < ln: break
                    req, buf = buf[:ln], buf[ln:]
                    dst, addr = req[5], struct.unpack_from('<I', req, 12)[0]
                    seen.append((dst, op, addr))
                    st, data = 0, b''
                    if op == 0: st, data = (0, struct.pack('<H', model)[:n]) if dst == 0 and addr == 2 else (2, b'')
                    elif dst not in (0, 255): st = 2
                    h = bytearray(req[:18]); h[0], h[1], h[2] = 0xAA, 0x55, st
                    struct.pack_into('<H', h, 16, len(data)); b = bytes(h) + data
                    c.sendall(b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF))
            c.close()
    threading.Thread(target=run, daemon=True).start()
    return s


sa, sb = [], []
A, B = tg_server(0x7B46, sa), tg_server(0x7B48, sb)
spec = '%d+%d' % (A.getsockname()[1], B.getsockname()[1])
link = novalink.open_link('127.0.0.1', spec, timeout=1.0)
try:
    ok(novalink.senders_on(link) == [0x7B46, 0x7B48], 'MultiLink: sending cards numbered across the links in port order')
    sa.clear(); sb.clear()
    link.write(0, 1, 0, 0, 0x02000074, b'\x78')
    ok(sb == [(0, 1, 0x02000074)] and not sa, 'a write to sending card 1 goes to the second link as its card 0')
    sa.clear(); sb.clear()
    link.write(1, 255, 255, 65535, 0x02000100, b'\xFF')
    ok(sa == [(255, 1, 0x02000100)] and sb == [(255, 1, 0x02000100)], 'dst 255 (all sending cards) goes to every link')
    try: link.read(0, 2, 0, 0, 2, 2); ok(False, 'a card past the last link fails')
    except novalink.LinkError: ok(True, 'a card past the last link fails (LinkError)')
finally: link.close()
l2 = novalink.open_link('127.0.0.1', '%d*2+%d' % (A.getsockname()[1], B.getsockname()[1]), timeout=1.0)
try:
    sb.clear(); l2.write(0, 2, 0, 0, 0x02000074, b'\x00')
    ok(sb == [(0, 1, 0x02000074)], '"5201*2+5202": card 2 is the second link\'s card 0')
finally: l2.close()
t = novalink.open_link('127.0.0.1', A.getsockname()[1], wait=0.3); t.close()
ok(True, 'MultiLink released its links (the target opens again)')

# ---------------------------------------------------------------- the helper's routes; nothing of the login is recorded
ok(novalink._brief({'host': H, 'username': 'admin', 'password': PW})['req'] == {'host': H, 'username': '<hidden>', 'password': '<hidden>'},
   'the recorder\'s op line hides user and password')
hs = novalink.ThreadingHTTPServer(('127.0.0.1', 0), novalink.Handler); threading.Thread(target=hs.serve_forever, daemon=True).start()
def post(path, body):
    rq = urllib.request.Request('http://127.0.0.1:%d%s' % (hs.server_address[1], path), data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(rq, timeout=10) as x: return json.loads(x.read())
r = post('/api/hw/hweb/login', {'host': H, 'username': 'admin', 'password': PW})
ok(r['ok'] and r['modelId'] == 29963, 'route /api/hw/hweb/login')
ok(post('/api/hw/hweb/info', {'host': H})['ok'], 'route /api/hw/hweb/info')
ok(post('/api/hw/hweb/info', {'host': 'usb:0483:5720@1-1'})['ok'] is False, 'route refuses a non-IP host')
r = post('/api/hw/info', {'host': '127.0.0.1', 'port': spec})
ok(r.get('senders') == [0x7B46, 0x7B48], 'route /api/hw/info over a multi-link port spec')
ok(post('/api/hw/hweb/forget', {'host': H})['removed'] is True, 'route /api/hw/hweb/forget')
hs.shutdown()
blob = ''
for f in glob.glob(os.path.join(DIAG, '**', '*'), recursive=True):
    if os.path.isfile(f):
        with open(f, 'rb') as fh: blob += fh.read().decode('utf-8', 'replace')
http = [json.loads(l) for l in blob.splitlines() if l.startswith('{') and '"http"' in l]
ok(len(http) >= 6, 'the H web calls are in the recorder (%d http records)' % len(http))
ok(PW not in blob and hweb.web_cipher(PW) not in blob, 'the password (typed or web form) is nowhere in the recording')
ok(not any(t in blob for t in fake.tokens), 'no session token in the recording')
lg = [json.loads(h['req']['text']) for h in http if h['url'].endswith('/api/user/login')]
ok(lg and all(x['username'] == '<hidden>' and x['password'] == '<hidden>' and 'deviceId' in x for x in lg), 'login requests are recorded whole, user name and password masked')
ok(all(h.get('reqh', {}).get('token') in ('<hidden>', '') for h in http), 'the token header is masked in every recorded call')

srv.shutdown(); A.close(); B.close()
print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
