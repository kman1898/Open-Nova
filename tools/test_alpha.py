"""Tests for alpha.py (the early-alpha build) through novalink's real HTTP handler and a small stand-in processor: the
version source and recording / log headers, the read-only gate (reads, visible-only, writes refused / unlocked), consent,
the recorder that can't be switched off, first-contact snapshots (unknown model, helper bug), the problem report zip
(contents, REPORT.md, scrubbing, anonymising, session subfolders incl. vendor/), the download, retention, and the alpha
package (stamped version.json, unlock hash only, nothing private).   python -I -X utf8 tools/test_alpha.py   (exit 0 = all passed)
Nothing here touches the real diagnostics, logs, settings or Downloads: every folder is a temporary one.
"""
import io
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
import zipfile

TMP = tempfile.mkdtemp(prefix='opennova_alpha_test_')
CODE = 'test-only-code-7'           # a code for this test only (the real one is typed at package time, never stored)
for k, v in {'OPENNOVA_DIAG': 'diag', 'OPENNOVA_VERSION_FILE': 'version.json', 'OPENNOVA_ALPHA_SETTINGS': 'alpha-settings.json',
             'OPENNOVA_REPORT_DIR': 'reports', 'OPENNOVA_HELPER_LOGS': 'logs'}.items():
    os.environ[k] = os.path.join(TMP, v)
os.environ.pop('OPENNOVA_ALPHA', None)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import alpha      # noqa: E402
import wirelog    # noqa: E402

UNLOCK = alpha.make_unlock(CODE)
VER = {'name': 'Open Nova', 'version': '0.1.0-alpha.9', 'build': '20261028-test', 'channel': 'alpha', 'readOnly': True, 'unlock': UNLOCK,
       'reportContact': 'reports@example.invalid', 'keepDays': 14, 'keepMB': 2048}


def write_ver(**ch):
    with open(os.environ['OPENNOVA_VERSION_FILE'], 'w', encoding='utf-8') as f: json.dump(dict(VER, **ch), f)
    alpha._ver['v'] = None


write_ver()
import novalink   # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


# ------------------------------------------------------------------ a stand-in processor: answers every request
def reply(req, data=b''):
    h = bytearray(req[:18]); h[0], h[1], h[2] = 0xAA, 0x55, 0
    struct.pack_into('<H', h, 16, len(data)); b = bytes(h) + data
    return b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF)


def fake(srv):
    def one(c):
        buf = b''
        while True:
            try: d = c.recv(4096)
            except OSError: break
            if not d: break
            buf += d
            while len(buf) >= 20:
                n = struct.unpack_from('<H', buf, 16)[0] if buf[10] == 1 else 0
                req, buf = buf[:20 + n], buf[20 + n:]
                ln = struct.unpack_from('<H', req, 16)[0]
                c.sendall(reply(req, b'\x34\x12' if req[10] == 0 and ln == 2 else bytes(ln) if req[10] == 0 else b''))
        c.close()
    while True:
        c, _ = srv.accept(); threading.Thread(target=one, args=(c,), daemon=True).start()


ps = socket.socket(); ps.bind(('127.0.0.1', 0)); ps.listen(4); PPORT = ps.getsockname()[1]
threading.Thread(target=fake, args=(ps,), daemon=True).start()
wirelog.HEADER['text'] = '%s · helper pid %d · test' % (alpha.version_line(), os.getpid())
hs = ThreadingHTTPServer(('127.0.0.1', 0), novalink.Handler); HPORT = hs.server_address[1]
threading.Thread(target=hs.serve_forever, daemon=True).start()


def post(path, body):
    r = urllib.request.Request('http://127.0.0.1:%d%s' % (HPORT, path), data=json.dumps(body).encode(), method='POST', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=20) as x: return json.loads(x.read())
    except urllib.error.HTTPError as e: return json.loads(e.read())


def get(path):
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d%s' % (HPORT, path), timeout=10) as x: return x.status, x.read()
    except urllib.error.HTTPError as e: return e.code, e.read()


# ------------------------------------------------------------------ version + state
st = post('/api/hw/alpha/state', {})
ok(st.get('ok') and st['alpha'] and st['readOnly'] and st['version'] == '0.1.0-alpha.9' and st['unlock'] == UNLOCK and not st['consented'],
   'state: alpha, read-only, version from version.json, the unlock hash (not a code), no consent yet')
ok(st['line'] == 'Open Nova 0.1.0-alpha.9 (build 20261028-test, alpha)', 'version line: %s' % st['line'])
ok('/api/hw/detect' in st['policy']['read'] and st['policy']['readOps'] == ['note', 'sleep', 'r', 'stash'] and st['policy']['readWhen']['/api/hw/calib'] == ['op', ['read']]
   and '/api/hw/ber-clear' not in st['policy']['read'] and 'displayAddrs' not in st['policy'], 'the policy goes to the app (one source), no "visible" tier')
TOKEN = alpha.send_token(CODE, UNLOCK)
ok(alpha.check_code(CODE) and not alpha.check_code('wrong') and CODE not in json.dumps(st) and TOKEN not in json.dumps(st) and TOKEN != UNLOCK['sha256'],
   'unlock: salted SHA-256 checks the code; neither the code nor the send token is in the state (only their hashes)')
dev = dict(VER, channel='dev'); write_ver(channel='dev')
ok(not alpha.info()['alpha'] and not alpha.read_only(), 'channel dev = not the alpha, not read-only')
os.environ['OPENNOVA_ALPHA'] = '1'; ok(alpha.info()['alpha'] and alpha.read_only(), 'OPENNOVA_ALPHA=1 (opennova.py --alpha) = the alpha')
os.environ.pop('OPENNOVA_ALPHA'); write_ver()

# ------------------------------------------------------------------ the policy
C = alpha.classify
W = lambda dev, addr: {'op': 'w', 'dev': dev, 'dst': 0, 'port': 0, 'card': 0, 'addr': addr, 'hex': '00'}
RD = {'op': 'r', 'dev': 0, 'dst': 0, 'port': 0, 'card': 0, 'addr': 0x02200139, 'len': 1}
cases = [('/api/hw/detect', {}, 'read'), ('/api/hw/health', {}, 'read'), ('/api/unico/info', {}, 'read'), ('/api/coex/read-layout', {}, 'read'),
         ('/api/hw/diag/frames', {}, 'read'), ('/api/rcv/lib/list', {}, 'read'), ('/api/hw/calib', {'op': 'read'}, 'read'), ('/api/hw/identify', {}, 'read'),
         ('/api/hw/proxy', {'on': False}, 'read'), ('/api/hw/proxy', {}, 'read'), ('/api/hw/proxy', {'on': True}, 'write'),
         ('/api/hw/calib', {'op': 'save'}, 'write'), ('/api/hw/calib', {}, 'write'), ('/api/hw/rcv-send', {}, 'write'), ('/api/hw/gamma', {}, 'write'), ('/api/unico/send', {}, 'write'),
         ('/api/unico/save', {}, 'write'), ('/api/coex/screen', {'a': 'brightness'}, 'write'), ('/api/unico/factory-reset', {}, 'write'),
         ('/api/coex/preset-apply', {}, 'write'), ('/api/unico/backup-mode', {}, 'write'), ('/api/something/new', {}, 'write'), ('/api/hw/hweb/anything-new', {}, 'write'),
         # formerly "visible only" (shown on the wall, nothing stored) or counted as reads: now writes, each needs the code
         ('/api/hw/ber-clear', {}, 'write'), ('/api/coex/ber-clear', {}, 'write'),
         ('/api/unico/cabinets', {'action': 'pattern'}, 'write'), ('/api/unico/cabinets', {'action': 'display'}, 'write'), ('/api/unico/cabinets', {'action': 'mapping'}, 'write'),
         ('/api/coex/cabinets', {'action': 'identify'}, 'write'), ('/api/coex/cabinets', {'action': 'pattern'}, 'write'),
         ('/api/hw/run', {'plan': {'ops': [{'op': 'note', 'text': 'x'}, W(1, 0x02000101), W(1, 0x02000100)]}}, 'write'),   # test pattern
         ('/api/hw/run', {'plan': {'ops': [W(1, 0x02000100)]}}, 'write'), ('/api/hw/run', {'plan': {'ops': [W(1, 0x02000102)]}}, 'write'),   # blackout, freeze
         ('/api/hw/run', {'plan': {'ops': [W(1, 0x01000088)]}}, 'write'),                              # mapping
         ('/api/hw/run', {'plan': {'ops': [RD, {'op': 'stash', 'key': 'k', 'dst': 0, 'addr': 0x020000F0, 'len': 4}, {'op': 'sleep', 'ms': 1}]}}, 'read'),
         ('/api/hw/run', {'plan': {'ops': []}}, 'read'),
         ('/api/hw/run', {'plan': {'ops': [RD, {'op': 'unstash', 'key': 'k', 'dst': 0, 'addr': 0x020000F0}]}}, 'write'),
         ('/api/hw/run', {'plan': {'ops': [{'op': 'brand-new-op'}]}}, 'write'), ('/api/hw/run', {'plan': 'garbage'}, 'write'), ('/api/hw/run', {}, 'write'),
         ('/api/hw/run', {'plan': {'ops': [W(1, 0x02000101), W(1, 0x02000001)]}}, 'write'),
         ('/api/hw/run', {'plan': {'ops': [{'op': 'nssd', 'dst': 0, 'json': '{}'}]}}, 'write')]
bad = ['%s %s -> %s' % (p, b, C(p, b)) for p, b, want in cases if C(p, b) != want]
ok(not bad, 'classify, default-deny: reads / writes, no visible tier, unknown routes and ops are writes (%s)' % (bad or '%d cases' % len(cases)))

# ------------------------------------------------------------------ the gate, end to end through the helper
plan_w = {'ops': [{'op': 'note', 'text': 'Send layout'}, W(1, 0x02000001)]}
r1 = post('/api/hw/run', {'host': '127.0.0.1', 'port': PPORT, 'plan': plan_w})
ok(r1.get('readOnly') and not r1.get('ok') and r1['error'].startswith('Writing to processors is off'), 'a write is refused while locked: %s' % r1.get('error'))
r2 = post('/api/hw/run', {'host': '127.0.0.1', 'port': PPORT, 'plan': plan_w, 'alphaUnlock': 'not-the-hash'})
ok(r2.get('readOnly'), 'a wrong unlock token is refused too')
r2b = post('/api/hw/run', {'host': '127.0.0.1', 'port': PPORT, 'plan': plan_w, 'alphaUnlock': UNLOCK['sha256']})
ok(r2b.get('readOnly'), 'the hash in version.json (readable by anyone) is not a token that writes')
r3 = post('/api/hw/run', {'host': '127.0.0.1', 'port': PPORT, 'plan': plan_w, 'alphaUnlock': TOKEN, '_action': 'tst-1', '_actionWhat': 'Send to the stand-in'})
ok(r3.get('ok') and r3.get('frames') == 1, 'with the send token from the code the write goes out (%s)' % r3)
link = '127.0.0.1:%d' % PPORT
txn = lambda: len([r for r in wirelog.frames(0, wirelog.RING) if r['kind'] == 'tg' and r.get('link') == link and r['dir'] == 'tx'])
before = txn()
was_visible = [('test pattern', '/api/hw/run', {'plan': {'ops': [W(1, 0x02000101), W(1, 0x02000100)]}}),
               ('blackout', '/api/hw/run', {'plan': {'ops': [W(1, 0x02000100)]}}), ('freeze', '/api/hw/run', {'plan': {'ops': [W(1, 0x02000102)]}}),
               ('normal', '/api/hw/run', {'plan': {'ops': [W(1, 0x02000102), W(1, 0x02000101), W(1, 0x02000100)]}}),
               ('mapping', '/api/hw/run', {'plan': {'ops': [W(1, 0x01000088)]}}),
               ('identify (COEX)', '/api/coex/cabinets', {'action': 'identify', 'on': True}), ('test pattern (Unico)', '/api/unico/cabinets', {'action': 'pattern', 'mode': 4}),
               ('error Clear', '/api/hw/ber-clear', {'targets': None}), ('error Clear (COEX)', '/api/coex/ber-clear', {}),
               ('live colour', '/api/hw/gamma', {'targets': [], 'gamma': 2.2}), ('live colour (COEX)', '/api/coex/screen', {'action': 'brightness', 'value': 50}),
               ('a route nobody listed', '/api/hw/brand-new-thing', {}), ('proxy port on', '/api/hw/proxy', {'on': True})]
refused = [what for what, p, b in was_visible if post(p, dict(b, host='127.0.0.1', port=PPORT)).get('readOnly')]
ok(len(refused) == len(was_visible) and txn() == before,
   'locked: every formerly "visible" action, the error Clear, live colour, an unknown route are refused, nothing reaches the processor (%s)' %
   ([w for w, _, _ in was_visible if w not in refused] or '%d refused' % len(refused)))
r5 = post('/api/hw/info', {'host': '127.0.0.1', 'port': PPORT})
ok(r5.get('ok') and r5['senders'][:1] == [0x1234], 'reads go out while locked (ModelID 0x1234)')
r6 = post('/api/hw/alpha/refused', {'path': '/api/hw/run', 'host': '192.0.2.9', 'what': 'Blackout', '_action': 'tst-2'})
ws = alpha.writes()
ok([w['allowed'] for w in ws][:4] == [False, False, False, True] and all(not w['allowed'] for w in ws[4:]) and len(ws) == 4 + len(was_visible) + 1
   and ws[3]['act'] == 'tst-1' and ws[-1]['where'] == 'app' and ws[-1]['act'] == 'tst-2' and r6.get('ok'),
   'every write is noted for the report with its action (refused / sent; refused in the app too)')
ops = [r for r in wirelog.frames(0, 5000) if r['kind'] == 'op' and r.get('route') == '/api/hw/run' and r['phase'] == 'start']
ok(ops and all('alphaUnlock' not in json.dumps(r) for r in ops) and any(r['kind'] == 'mark' and 'Refused (read-only alpha)' in r['text'] for r in wirelog.frames(0, 5000)),
   'the unlock token isn\'t recorded; refusals are marked in the recording')
allrec = wirelog.frames(0, wirelog.RING)
ok(TOKEN not in json.dumps(allrec) and not any('_action' in json.dumps(r.get('req') or {}) for r in allrec), 'neither the send token nor the _action field lands in a request record')
# the action id: the app's click (tst-1) -> the helper request -> its frames -> the report
a1 = [r for r in allrec if r.get('act') == 'tst-1']
kinds = set((r['kind'], r.get('phase') or r.get('dir')) for r in a1)
ok({('op', 'start'), ('op', 'end'), ('tg', 'tx'), ('tg', 'rx')} <= kinds and [r for r in a1 if r['kind'] == 'op' and r['phase'] == 'start'][0].get('what') == 'Send to the stand-in'
   and not [r for r in allrec if r['kind'] == 'tg' and min(x['seq'] for x in a1) < r['seq'] < max(x['seq'] for x in a1) and r.get('act') != 'tst-1'],
   'action tst-1: its request (start / end, with what it was) and every frame it caused carry the id (%s)' % sorted(kinds))
hx = urllib.request.Request('http://127.0.0.1:%d/api/hw/info' % HPORT, data=json.dumps({'host': '127.0.0.1', 'port': PPORT}).encode(), method='POST',
                            headers={'Content-Type': 'application/json', 'X-OpenNova-Action': 'hdr-9'})
with urllib.request.urlopen(hx, timeout=10) as x: x.read()
ok(any(r.get('act') == 'hdr-9' and r['kind'] == 'tg' for r in wirelog.frames(0, wirelog.RING)), 'the action id can come as the X-OpenNova-Action header too')
ok(any(r.get('act') == 'tst-2' and r['kind'] == 'mark' and 'in the app' in r['text'] for r in wirelog.frames(0, wirelog.RING)), 'a write the app refused is in the recording with its action')
write_ver(unlock=None)
ok(post('/api/hw/run', {'host': '127.0.0.1', 'port': PPORT, 'plan': plan_w, 'alphaUnlock': TOKEN}).get('readOnly')
   and post('/api/hw/run', {'host': '127.0.0.1', 'port': PPORT, 'plan': plan_w, 'alphaUnlock': 'confirmed'}).get('readOnly'), 'a build packaged without a code never writes')
write_ver(readOnly=False)
ok(post('/api/hw/run', {'host': '127.0.0.1', 'port': PPORT, 'plan': plan_w}).get('ok'), 'readOnly false in version.json: writes go out without unlock')
write_ver()

# ------------------------------------------------------------------ consent, recorder, headers
s2 = post('/api/hw/alpha/set', {'consent': {'name': 'Tess Tester', 'contact': 'tess@example.invalid'}})
ok(s2['consented'] and s2['tester']['name'] == 'Tess Tester' and json.load(open(os.environ['OPENNOVA_ALPHA_SETTINGS'], encoding='utf-8'))['consent']['contact'] == 'tess@example.invalid',
   'consent + tester details kept on this computer')
en = post('/api/hw/diag/enable', {'on': False})
ok(en.get('refused') and wirelog.status()['enabled'], 'the alpha recorder can\'t be switched off')
cur = wirelog.status()['file']
with open(cur, encoding='utf-8') as f: first = json.loads(f.readline())
ok(first['kind'] == 'mark' and first['source'] == 'header' and 'Open Nova 0.1.0-alpha.9' in first['text'], 'every recording starts with the version (%s)' % first['text'][:60])
lp = novalink.logfile()
with open(lp, encoding='utf-8') as f: ok(f.readline().startswith('# Open Nova 0.1.0-alpha.9') and os.path.dirname(lp) == os.environ['OPENNOVA_HELPER_LOGS'], 'the helper log starts with the version')

# ------------------------------------------------------------------ first contact
wirelog.udp('rx', ('192.168.0.11', 3800), b'rpProMI:UNKNOWN-BOX', 'nova')
wirelog.conn('192.168.0.11:5200', 'open', ms=3.2)
fc = post('/api/hw/alpha/first-contact', {'key': 'lct-0x1234', 'reason': 'model not in the catalogue', 'host': '192.168.0.11', 'family': 'lct',
                                          'data': {'found': {'ip': '192.168.0.11', 'modelId': 0x1234}, 'info': {'ok': True, 'senders': [0x1234]}}})
fc2 = post('/api/hw/alpha/first-contact', {'key': 'lct-0x1234', 'reason': 'again', 'host': '192.168.0.11'})
ok(fc.get('file', '').startswith(time.strftime('%Y-%m-%d') + '/first-contact/') and fc2.get('skipped'), 'first contact saved once (%s; then %s)' % (fc.get('file'), fc2.get('skipped')))
doc = json.load(open(os.path.join(os.environ['OPENNOVA_DIAG'], fc['file']), encoding='utf-8'))
ok(doc['data']['info']['senders'] == [0x1234] and any(r['kind'] == 'udp' for r in doc['records']) and any(r['kind'] == 'conn' for r in doc['records']),
   'the snapshot holds the app\'s info read and every record for that address (discovery reply, connection)')
bug = post('/api/hw/nprj', {'data': '!!not base64!!'})
errs = [f for f in os.listdir(os.path.join(alpha.day_dir(), 'first-contact')) if 'error-api-hw-nprj' in f]
ok(not bug.get('ok') and errs and wirelog.helper_errors() and wirelog.helper_errors()[-1].get('where'), 'a helper bug: kept with its traceback + a snapshot (%s)' % errs)

# ------------------------------------------------------------------ the problem report
vend = os.path.join(alpha.day_dir(), 'vendor'); os.makedirs(vend, exist_ok=True)
with open(os.path.join(vend, 'novalct-session.txt'), 'w', encoding='utf-8') as f: f.write('LCT talked to 192.168.0.11 with {"password":"vendorpw"}\n')
with open(os.path.join(vend, 'capture.pcap'), 'wb') as f: f.write(b'\xd4\xc3\xb2\xa1' + bytes(range(256)))
HOME = os.path.expanduser('~')
proj = json.dumps({'name': 'Gig', 'devices': [{'hw': {'host': '192.168.0.11', 'port': 5200}}], 'note': 'saved in ' + HOME})
hexip = '192.168.0.11'.encode().hex()
payload = {'text': 'Sent the layout to the H2 and port 3 went dark', 'anonymise': True,
           'include': {'project': True, 'recordings': True, 'logs': True, 'processors': True, 'system': True},
           'files': [{'name': 'project.json', 'text': proj},
                     {'name': 'browser-log.ndjson', 'text': '{"action":"hweb_login","details":{"username":"admin","password":"hunter2","token":"abc.def"}}\n'
                                                           '{"action":"x","details":{"body":"{\\"password\\":\\"inner-secret\\"}","hdr":"Authorization: Bearer sekret123"}}\n'
                                                           '{"action":"y","details":{"url":"http://10.1.2.3/api?token=qqq&x=1","raw":"' + hexip + '"}}'}],
           'summary': {'app': {'browser': 'TestBrowser/1', 'url': 'http://192.168.0.20:8765/', 'project': 'Gig', 'unlocked': False,
                               'lockEvents': [{'t': '10:00:00', 'what': 'unlocked'}, {'t': '10:05:00', 'what': 'locked'}]},
                       'found': [{'kind': 'lct', 'ip': '192.168.0.11', 'port': 5200, 'name': 'NovaLCT processor', 'modelId': 0x1234, 'senders': [0x1234], 'known': False, 'why': ''},
                                 {'kind': 'unico', 'ip': '172.16.5.4', 'port': 8001, 'name': 'VX1000 Pro', 'modelId': 29959, 'known': True, 'model': 'VX1000 Pro', 'firmware': 'V1.2'}],
                       'devices': [{'name': 'H2', 'modelName': 'H2', 'known': True, 'link': {'kind': 'lct', 'host': '192.168.0.12', 'port': '5201+5202', 'senders': [0x7B4A]},
                                    'firmware': 'web V1.5', 'cards': ['A8s Plus · FPGA 4.6.1.0 / MCU 1.2 ×24'], 'detected': '24 cabinets'}],
                       'errors': [{'t': 'now', 'action': 'client_error', 'text': 'x is undefined'}],
                       'failedCalls': [{'t': 'now', 'path': '/api/hw/detect', 'ms': 3000, 'error': 'timed out'}]}}
rep = post('/api/hw/report', payload)
ok(rep.get('ok') and rep['name'].startswith('OpenNova-report-0.1.0-alpha.9-') and rep['name'].endswith('-H2.zip') and os.path.dirname(rep['path']) == os.environ['OPENNOVA_REPORT_DIR'],
   'report saved: %s' % rep.get('name'))
z = zipfile.ZipFile(rep['path']); names = z.namelist(); top = names[0].split('/')[0] + '/'
T = {n[len(top):]: z.read(n) for n in names}
md = T['REPORT.md'].decode('utf-8')
ok(names[0].endswith('/REPORT.md') and all(n.startswith(top) for n in names), 'REPORT.md first, everything in one folder')
want = ['app/project.json', 'app/browser-log.ndjson', 'recordings/recorder-status.json', 'helper/version.json', 'helper/helper-errors.json']
miss = [w for w in want if w not in T]
ok(not miss and any(n.startswith('recordings/') and n.endswith('.nwl') for n in T) and any(n.startswith('logs/helper/') for n in T), 'contents: app files, recordings, helper logs (%s)' % (miss or 'all'))
ok(any(n.endswith('/vendor/novalct-session.txt') for n in T) and any(n.endswith('/vendor/capture.pcap') for n in T) and any('/first-contact/' in n for n in T),
   'session subfolders go in whole: vendor/ (text + binary) and first-contact/')
pc = [v for n, v in T.items() if n.endswith('capture.pcap')][0]
ok(pc == b'\xd4\xc3\xb2\xa1' + bytes(range(256)), 'a binary session file goes in byte for byte')
for frag in ['0.1.0-alpha.9', 'build 20261028-test', 'locked (read-only)', 'Sent the layout to the H2', 'UNKNOWN MODELS', '0x1234', '**NO**', 'File "',
             'REFUSED (read-only)', 'REFUSED (read-only, in the app)', '| tst-1 | write |', '## Actions', '| tst-1 | Send to the stand-in |', '[action tst-1]',
             'unlocked; ', 'Helper errors (last', 'binascii', 'Connection timeline', 'discovery reply from device-A',
             'A8s Plus', 'web V1.5', '0x7B4A', 'x is undefined', 'timed out', 'Tess Tester', 'Files in this report', '(binary, not scrubbed']:
    if frag not in md: ok(False, 'REPORT.md has "%s"' % frag)
ok(all(f in md for f in ['UNKNOWN MODELS', 'REFUSED (read-only)', 'File "', 'Tess Tester']), 'REPORT.md: version, what happened, unknown models flagged, writes, errors, tracebacks, timeline, tester')
alltext = b'\n'.join(v for n, v in T.items() if not n.endswith('.pcap')).decode('utf-8', 'replace')
leaks = [s for s in ['hunter2', 'abc.def', 'inner-secret', 'sekret123', 'qqq', 'vendorpw', '"username":"admin"', CODE] if s in alltext]
ok(not leaks, 'passwords, tokens, logins, Authorization headers, ?token= scrubbed everywhere (%s)' % (leaks or 'none'))
ipl = [s for s in ['192.168.0.11', '192.168.0.12', '172.16.5.4', '10.1.2.3', '192.168.0.20', hexip, HOME, HOME.replace('\\', '\\\\')] if s in alltext]
ok(not ipl, 'anonymised: no private IP (also not as hex), no home folder (%s)' % (ipl or 'none'))
dA = md.count('device-A'); pj = T['app/project.json'].decode('utf-8'); vt = [v for n, v in T.items() if n.endswith('novalct-session.txt')][0].decode('utf-8')
ok(dA >= 2 and 'device-A' in pj and 'device-A' in vt and '"note": "saved in ~"' in pj.replace('"note":"', '"note": "'), 'the same address is the same name in every file (device-A), home folder = ~')
ok('8765' in md and 'device-' in md.split('App address')[1][:40], 'the app address is anonymised too, port kept')
rep2 = post('/api/hw/report', dict(payload, anonymise=False, include={'project': False, 'recordings': False, 'logs': False, 'processors': True, 'system': False}))
z2 = zipfile.ZipFile(rep2['path']); T2 = {n.split('/', 1)[1]: z2.read(n) for n in z2.namelist()}; md2 = T2['REPORT.md'].decode('utf-8')
ok('192.168.0.11' in md2 and not any(n.startswith(('recordings/', 'logs/')) or n.endswith('vendor/novalct-session.txt') for n in T2) and 'TestBrowser' not in md2 and 'Tess Tester' not in md2,
   'not anonymised: addresses stay; unticked parts (recordings, logs, system, tester) left out')
ok(not [s for s in ['hunter2', 'inner-secret', 'sekret123'] if s in b'\n'.join(T2.values()).decode('utf-8', 'replace')], 'scrubbed without anonymising too')
code, body = get('/api/hw/report/download?name=' + rep['name'])
ok(code == 200 and body == open(rep['path'], 'rb').read(), 'download a copy of the report')
ok(get('/api/hw/report/download?name=..%2F..%2Fversion.json')[0] == 404 and get('/api/hw/report/download?name=OpenNova-report-x.zip')[0] == 404, 'only reports by name, nothing else')

# ------------------------------------------------------------------ scrub / anonymise units
sc = alpha.scrub('{"Password": "a", "accessToken":"b", "user":"kept"} cookie: s=1 &password=zz')
ok('"a"' not in sc and '"b"' not in sc and 'kept' in sc and 's=1' not in sc and 'zz' not in sc, 'scrub: %s' % sc)
an = alpha.Anon(['8.8.8.8 127.0.0.1 192.168.0.255 100.64.1.2 1192.168.0.1 10.0.0.1.5 172.32.0.1'])
out = an.text('8.8.8.8 127.0.0.1 192.168.0.255 100.64.1.2 1192.168.0.1 172.32.0.1')
ok(out == '8.8.8.8 127.0.0.1 device-A device-B 1192.168.0.1 172.32.0.1', 'anonymise only private addresses, whole ones: %s' % out)

# ------------------------------------------------------------------ retention (alpha only)
old = os.path.join(os.environ['OPENNOVA_DIAG'], '2020-01-01'); os.makedirs(old, exist_ok=True)
open(os.path.join(old, 'x.nwl'), 'w').write('{}\n')
oldlog = os.path.join(os.environ['OPENNOVA_HELPER_LOGS']); os.makedirs(oldlog, exist_ok=True)
lf = os.path.join(oldlog, '20200101.txt'); open(lf, 'w').write('old'); os.utime(lf, (time.time() - 40 * 86400,) * 2)
write_ver(channel='dev'); ok(alpha.prune() == [] and os.path.isdir(old), 'dev build: nothing is removed')
write_ver(); rm = alpha.prune()
ok('2020-01-01' in rm and not os.path.isdir(old) and not os.path.exists(lf) and os.path.exists(cur), 'alpha: recordings and helper logs older than keepDays removed, today\'s kept')
write_ver(keepMB=0); rm2 = alpha.prune()
ok(os.path.exists(cur) and rm2 and not os.path.exists(os.path.join(vend, 'capture.pcap')), 'over keepMB: the oldest go, never the file being recorded')
write_ver()

# ------------------------------------------------------------------ the alpha package
sys.path.insert(0, HERE)
import make_package   # noqa: E402
out = os.path.join(TMP, 'dist')
for k in ('OPENNOVA_UNLOCK_CODE', 'OPENNOVA_REPORT_CONTACT', 'SOURCE_DATE_EPOCH'): os.environ.pop(k, None)
# by default (no env, no --unlock-code) every alpha build carries the one shared code: tools/alpha_unlock.json's hashes
shared = json.load(open(os.path.join(HERE, 'alpha_unlock.json'), encoding='utf-8'))['unlock']
out_def = os.path.join(TMP, 'dist-default'); asked_def = []
buf = io.StringIO(); so = sys.stdout; sys.stdout = buf
try: make_package.main(['--alpha', '--out', out_def], ask=lambda p: asked_def.append(p) or 'xxxx')
finally: sys.stdout = so
rv0 = json.load(open(os.path.join(os.path.dirname(HERE), 'app', 'version.json'), encoding='utf-8'))
zd = zipfile.ZipFile(os.path.join(out_def, 'OpenNova-%s-alpha.zip' % rv0['version'])); vd = json.loads(zd.read(zd.namelist()[0].split('/')[0] + '/app/version.json'))
ok(not asked_def and vd['unlock'] == {k: shared[k] for k in ('salt', 'sha256', 'tokenSha256')} and not alpha.check_code('test-only-wrong-code', vd['unlock'])
   and b'alpha_unlock.json' not in b''.join(n.encode() for n in zd.namelist()),
   '--alpha alone: no prompt, the package carries tools/alpha_unlock.json\'s hashes (a wrong code doesn\'t check)')
def no_console(p): raise EOFError
try: make_package.main(['--alpha', '--unlock-code', '--out', out], ask=no_console); msg = ''
except SystemExit as e: msg = str(e)
ok('OPENNOVA_UNLOCK_CODE' in msg, 'no console to type the code (CI): it stops and names the environment variable')
# CI: the code from the environment (a GitHub Actions secret), never asked, never printed; SOURCE_DATE_EPOCH = a fixed build date
out_ci = os.path.join(TMP, 'dist-ci')
os.environ.update(OPENNOVA_UNLOCK_CODE=CODE, OPENNOVA_REPORT_CONTACT='ci@example.invalid', SOURCE_DATE_EPOCH='1800000000')
buf = io.StringIO(); so = sys.stdout; sys.stdout = buf; asked_ci = []
try: make_package.main(['--alpha', '--out', out_ci], ask=lambda p: asked_ci.append(p) or 'xxxx')
finally:
    sys.stdout = so
    for k in ('OPENNOVA_UNLOCK_CODE', 'OPENNOVA_REPORT_CONTACT', 'SOURCE_DATE_EPOCH'): os.environ.pop(k, None)
real0 = json.load(open(os.path.join(os.path.dirname(HERE), 'app', 'version.json'), encoding='utf-8'))
zci = zipfile.ZipFile(os.path.join(out_ci, 'OpenNova-%s-alpha.zip' % real0['version'])); rci = zci.namelist()[0].split('/')[0] + '/'
vci = json.loads(zci.read(rci + 'app/version.json'))
ok(not asked_ci and CODE not in buf.getvalue() and alpha.check_code(CODE, vci['unlock']) and vci['unlock']['salt'] != shared['salt'] and vci['reportContact'] == 'ci@example.invalid'
   and CODE.encode() not in b''.join(zci.read(n) for n in zci.namelist()), 'CI: OPENNOVA_UNLOCK_CODE (overrides the shared code) / OPENNOVA_REPORT_CONTACT used without a prompt, the code printed and packaged nowhere')
ok(vci['build'].startswith('20270115-') and all(i.date_time[:3] == (2027, 1, 15) for i in zci.infolist()), 'SOURCE_DATE_EPOCH: build date and every file time fixed (%s)' % vci['build'])
asked = []
buf = io.StringIO(); so = sys.stdout; sys.stdout = buf
try: make_package.main(['--alpha', '--unlock-code', '--contact', 'alpha@example.invalid', '--out', out], ask=lambda p: asked.append(p) or CODE)
finally: sys.stdout = so
printed = buf.getvalue()
real = json.load(open(os.path.join(os.path.dirname(HERE), 'app', 'version.json'), encoding='utf-8'))
zp = os.path.join(out, 'OpenNova-%s-alpha.zip' % real['version'])
ok(os.path.isfile(zp) and len(asked) == 2 and CODE not in printed, 'dist/OpenNova-<version>-alpha.zip; the code asked twice, never printed')
pz = zipfile.ZipFile(zp); pn = pz.namelist(); root = pn[0].split('/')[0] + '/'
pv = json.loads(pz.read(root + 'app/version.json'))
ok(pv['channel'] == 'alpha' and pv['readOnly'] and pv['reportContact'] == 'alpha@example.invalid' and len(pv['build']) == 17 and pv['build'][8] == '-',
   'version.json stamped: alpha, read-only, contact, build %s' % pv['build'])
ok(alpha.check_code(CODE, pv['unlock']) and not alpha.check_code('nope', pv['unlock']) and set(pv['unlock']) == {'salt', 'sha256', 'tokenSha256'}
   and alpha._sha(alpha.send_token(CODE, pv['unlock'])) == pv['unlock']['tokenSha256'], 'only the salt + hashes of the code / send token are packaged')
blob = b''.join(pz.read(n) for n in pn)
ok(CODE.encode() not in blob, 'the code itself is nowhere in the package')
priv = [n for n in pn if any(n[len(root):].startswith(x) for x in ('app/data', 'diagnostics', 'Samples', 'test-data', 'app/tests', 'tools/novalink_logs', 'alpha-settings'))]
ok(not priv and root + 'README-ALPHA.md' in pn and root + 'tools/alpha.py' in pn and root + 'app/js/app-alpha.js' in pn, 'nothing private, no test pages; README-ALPHA.md, alpha.py, app-alpha.js in (%s)' % priv[:3])
ok((pz.getinfo(root + 'Start Open Nova.command').external_attr >> 16) & 0o111, 'the macOS launcher stays executable')
src_ver = json.load(open(os.path.join(os.path.dirname(HERE), 'app', 'version.json'), encoding='utf-8'))
ok(src_ver == real and src_ver.get('channel') != 'alpha', 'the source app/version.json is left as it was (dev)')

hs.shutdown()
shutil.rmtree(TMP, ignore_errors=True)
print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
