"""Starting Open Nova on a tester's computer (docs/ALPHA_READINESS.md B4-B6, C1, C2, C11): opennova.py and app/serve.py
with a system proxy set, with the app / helper port held by another program, with another Open Nova build still running
on it, and the same build (reused); the start window's text kept in <data>/logs/console.txt; "Start Open Nova.bat" (ASCII,
CRLF, pushd for a network share, the Windows 7 / 8 message, the firewall wording); the macOS starter's Local Network text.
Everything runs on free ports with temporary folders (never 8765 / 8790, never app/data); every process started here is
stopped before the end. No hardware.
    python -I -X utf8 tools/test_starter.py   (exit 0 = all passed)
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
NOVA = os.path.dirname(HERE)
TMP = tempfile.mkdtemp(prefix='opennova_starter_test_')
with open(os.path.join(NOVA, 'app', 'version.json'), encoding='utf-8-sig') as f: V = json.load(f)
NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))
fails = []


def ok(cond, what, detail=None):
    print(('PASS ' if cond else 'FAIL ') + what + ('' if cond or detail is None else '  -> %s' % (detail,))); sys.stdout.flush()
    if not cond: fails.append(what)


def free_block(n=3):
    """A port p with p … p+n-1 all free here."""
    import random
    for _ in range(200):   # below the systems' ephemeral ranges: a probe of a free port there can connect to itself
        p, good = random.randrange(20000, 32000), True
        for q in range(p, p + n):
            t = socket.socket()
            try: t.bind(('127.0.0.1', q))
            except OSError: good = False
            finally: t.close()
        if good: return p
    raise SystemExit('no free ports')


def get(url, data=None, timeout=3):
    rq = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'} if data is not None else {})
    with NOPROXY.open(rq, timeout=timeout) as r: return r.status, r.read()


class Squatter:
    """Another program on a port: an HTTP server answering pages of its own, or an Open Nova of build `build` (the app's
    index.html + version.json, or the helper's ping + alpha state)."""
    def __init__(self, port, kind='other', build=None):
        ver = {'version': V['version'], 'build': build}

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def _send(self, body, ctype='text/html'):
                b = body.encode(); self.send_response(200); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

            def do_GET(self):
                if kind == 'app' and self.path == '/index.html': return self._send('<title>Open Nova</title>')
                if kind == 'app' and self.path == '/version.json': return self._send(json.dumps(ver), 'application/json')
                if kind == 'helper' and self.path == '/api/hw/ping': return self._send(json.dumps({'ok': True, 'tool': 'novalink'}), 'application/json')
                self._send('<title>Some other app</title>')

            def do_POST(self):
                self.rfile.read(int(self.headers.get('Content-Length') or 0))
                if kind == 'helper' and self.path == '/api/hw/alpha/state': return self._send(json.dumps(dict(ver, ok=True)), 'application/json')
                self._send('{}', 'application/json')
        self.srv = ThreadingHTTPServer(('127.0.0.1', port), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown(); self.srv.server_close()


def stop(p):
    """Stop opennova.py and the helper + server it started."""
    if p.poll() is not None: return
    if os.name == 'nt': subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True)
    else:
        import signal
        p.send_signal(signal.SIGINT)
    try: p.wait(15)
    except subprocess.TimeoutExpired: p.kill(); p.wait(5)


def env(**more):
    e = dict(os.environ, OPENNOVA_DIAG=os.path.join(TMP, 'diag'), OPENNOVA_HELPER_LOGS=os.path.join(TMP, 'hlogs'),
             OPENNOVA_ALPHA_SETTINGS=os.path.join(TMP, 'alpha-settings.json'), OPENNOVA_LIBRARY=os.path.join(TMP, 'library'),
             OPENNOVA_CONFIG_DIR=os.path.join(TMP, 'config'), PYTHONDONTWRITEBYTECODE='1')
    for k in ('PYTHONIOENCODING', 'OPENNOVA_ALPHA', 'OPENNOVA_VERSION_FILE', 'OPENNOVA_CONSOLE_LOG'): e.pop(k, None)
    e.update(more)
    return e


def start(port, hport, data, extra_env=None, until=None, secs=90):
    """Run opennova.py; return (process, output so far) once `until` (a URL) answers, or once it ends."""
    out = os.path.join(TMP, 'out-%d.txt' % port)
    p = subprocess.Popen([sys.executable, '-I', os.path.join(NOVA, 'opennova.py'), '--no-browser', '--local-only', '--port', str(port), '--helper-port', str(hport),
                          '--data-dir', data], cwd=NOVA, stdout=open(out, 'wb'), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env(**(extra_env or {})))
    try:
        end = time.time() + secs
        while time.time() < end and p.poll() is None:
            if until:
                try:
                    if get(until, timeout=1)[0] == 200: break
                except Exception: pass  # noqa: BLE001 - not up yet, in any form
            time.sleep(0.3)
        time.sleep(0.5)
    except BaseException:
        stop(p); raise
    with open(out, 'rb') as f: return p, f.read().decode('utf-8', 'replace')


# ------------------------------------------------------------------ a system proxy (HTTP_PROXY to a dead port): nothing local goes through it
base = free_block(4)
data = os.path.join(TMP, 'data1')
dead = 'http://127.0.0.1:9'
p, out = start(base, base + 2, data, {'HTTP_PROXY': dead, 'http_proxy': dead, 'NO_PROXY': '', 'no_proxy': ''}, 'http://127.0.0.1:%d/index.html' % base)
try:
    up = False
    try: up = get('http://127.0.0.1:%d/api/hw/ping' % base, timeout=5)[0] == 200    # the server's relay to the helper
    except OSError: pass
    ok(p.poll() is None and up and 'Open Nova is running' in out, 'with HTTP_PROXY set (a corporate proxy): opennova.py starts both and the server reaches the helper', out[-600:])
    # the same build started again: reused, as before
    p2, out2 = start(base, base + 2, os.path.join(TMP, 'data2'), {'HTTP_PROXY': dead, 'http_proxy': dead})
    ok(p2.returncode == 0 and 'already running' in out2 and 'already being served' in out2, 'the same build started again: both reused, exit 0', out2[-400:])
    stop(p2)
finally:
    stop(p)
log = ''
try:
    with open(os.path.join(data, 'logs', 'console.txt'), encoding='utf-8') as f: log = f.read()
except OSError: pass
ok(('Open Nova %s (build %s' % (V['version'], V['build'])) in log and 'novalink helper on' in log and 'Serving ' in log,
   'console.txt in the data folder: the window\'s own lines and the helper\'s / server\'s', log[-400:])

# ------------------------------------------------------------------ app port held by another program: the next free one, one line
base = free_block(5)
sq = Squatter(base)
try:
    p, out = start(base, base + 3, os.path.join(TMP, 'data3'), None, 'http://127.0.0.1:%d/index.html' % (base + 1))
    try:
        up = False
        try: up = get('http://127.0.0.1:%d/index.html' % (base + 1))[0] == 200 and get('http://127.0.0.1:%d/api/hw/ping' % (base + 1))[0] == 200
        except OSError: pass
        ok(up and ('Port %d is used by another program: the app uses %d instead.' % (base, base + 1)) in out and 'Traceback' not in out and 'http://localhost:%d/' % (base + 1) in out,
           'app port taken by another program: one line, the app on the next port (with its helper), no traceback', out[-600:])
    finally: stop(p)
finally: sq.close()

# ------------------------------------------------------------------ helper port held: the helper moves; the server is told (--helper-port)
base = free_block(5)
sq = Squatter(base + 3)
try:
    p, out = start(base, base + 3, os.path.join(TMP, 'data4'), None, 'http://127.0.0.1:%d/index.html' % base)
    try:
        st = None
        try: st = json.loads(get('http://127.0.0.1:%d/api/hw/ping' % base)[1])
        except (OSError, ValueError): pass
        ok(st and st.get('tool') == 'novalink' and ('Port %d is used by another program: the hardware helper uses %d instead.' % (base + 3, base + 4)) in out and 'Traceback' not in out,
           'helper port taken: the helper on the next port, the server relays to it', out[-600:])
    finally: stop(p)
finally: sq.close()

# ------------------------------------------------------------------ an older Open Nova still running: named, not reused
base = free_block(4)
for kind, port in (('app', base), ('helper', base + 2)):
    sq = Squatter(port, kind, '20200101-0ldb0ld0')
    try:
        p, out = start(base, base + 2, os.path.join(TMP, 'data5'), secs=40)
        if p.poll() is None: stop(p)
        said = [w for w in ('An older', 'Another') if ('%s Open Nova (%s, build 20200101-0ldb0ld0) is still running: close its window, then start again.' % (w, V['version'])) in out]
        ok(p.returncode == 1 and said and (said[0] == 'An older' or not V['build'][:8].isdigit()) and 'using it' not in out,
           'another build\'s %s on the port: said plainly (older, when this build is dated), exit 1, nothing reused' % kind, out[-500:])
    finally: sq.close()
sys.path.insert(0, NOVA)
import opennova   # noqa: E402
ok(opennova.other_text({'version': '9.8.7-alpha.6', 'build': '20261101-aaaaaaaa'}, ('9.8.7-alpha.6', '20261116-bbbbbbbb')).startswith('An older Open Nova (9.8.7-alpha.6, build 20261101-aaaaaaaa)')
   and opennova.other_text({'version': '9.8.7-alpha.7', 'build': '20261201-cccccccc'}, ('9.8.7-alpha.6', '20261116-bbbbbbbb')).startswith('Another Open Nova'),
   'the words: "An older Open Nova (…, build …)" when its build date is earlier, else "Another Open Nova"')

# ------------------------------------------------------------------ serve.py alone on a taken port: one line, no traceback
base = free_block(2)
blocker = socket.socket(); blocker.bind(('127.0.0.1', base)); blocker.listen(1)
try:
    r = subprocess.run([sys.executable, '-I', os.path.join(NOVA, 'app', 'serve.py'), str(base), '--local-only', '--data-dir', os.path.join(TMP, 'data6')],
                       cwd=os.path.join(NOVA, 'app'), capture_output=True, timeout=60, env=env())
    text = (r.stdout + r.stderr).decode('utf-8', 'replace')
    ok(r.returncode == 1 and ("The app server can't use port %d" % base) in text and 'Traceback' not in text, 'serve.py on a taken port: one plain line, exit 1', text[-400:])
finally: blocker.close()

# ------------------------------------------------------------------ the starters' own text
bat = open(os.path.join(NOVA, 'Start Open Nova.bat'), 'rb').read()
ok(all(c < 128 for c in bat) and bat.count(b'\r\n') == bat.count(b'\n') and b'\0' not in bat, '"Start Open Nova.bat": ASCII with CRLF line endings')
ok(b'pushd "%~dp0"' in bat and b'cd /d' not in bat and bat.count(b'popd') >= 4, 'the .bat: pushd (a network share gets a drive letter), popd on every way out')
ok(b'BOTH Private and Public' in bat, 'the .bat: the firewall wording asks for Private and Public')
ok(bat.find(b'findstr') < bat.find(b'pushd') < bat.find(b'call :try'), 'the .bat: the Windows version check comes before anything else')
if os.name == 'nt':
    for wv, old in (('Microsoft Windows [Version 6.1.7601]', True), ('Microsoft Windows [Version 6.3.9600]', True), ('Microsoft Windows [Version 5.1.2600]', True)):
        r = subprocess.run(['cmd', '/d', '/c', 'call', os.path.join(NOVA, 'Start Open Nova.bat')], capture_output=True, stdin=subprocess.DEVNULL, timeout=30,
                           env=dict(os.environ, OPENNOVA_TEST_WINVER=wv), cwd=TMP)
        o = r.stdout.decode('ascii', 'replace')
        ok(r.returncode == 1 and 'Open Nova needs Windows 10 or 11' in o and 'Setting up' not in o, 'the .bat on "%s": the plain message, nothing else runs' % wv, o[-300:])
cmdf = open(os.path.join(NOVA, 'Start Open Nova.command'), encoding='utf-8').read()
ok('Python or Terminal' in cmdf and 'Local Network' in cmdf and '\r' not in cmdf, 'the macOS starter: the Local Network question may name Python or Terminal; how to switch it on later')

shutil.rmtree(TMP, ignore_errors=True)
print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
