"""app/version.json is the one version source: everything that shows or stamps a version reads it, and they agree.
    python -I -X utf8 tools/test_version.py      (exit 0 = all passed)
Checks: version.json itself; tools/alpha.py (helper, logs, recordings, reports); app/serve.py (served /version.json, the
server_start log line) and app/serve.ps1 where PowerShell runs; opennova.py (its first line); tools/make_package.py (the
alpha zip's name and its stamped version.json, built into a temporary folder with --no-unlock-code); and that no other
file in the repository spells the version out. Servers run on free ports with temporary data folders (never app/data).
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
NOVA = os.path.dirname(HERE)
sys.path.insert(0, HERE)
for k in ('OPENNOVA_VERSION_FILE', 'OPENNOVA_ALPHA', 'OPENNOVA_UNLOCK_CODE', 'OPENNOVA_REPORT_CONTACT', 'SOURCE_DATE_EPOCH'):
    os.environ.pop(k, None)
TMP = tempfile.mkdtemp(prefix='opennova_version_test_')
fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def get(url, timeout=2):
    with urllib.request.urlopen(url, timeout=timeout) as r: return r.status, r.read()


def wait(url, secs=60):
    end = time.time() + secs
    while time.time() < end:
        try: return get(url)
        except OSError: time.sleep(0.3)
    return None, b''


def stop(p):
    """Stop a process and its children (opennova.py starts two)."""
    if p.poll() is not None: return
    if os.name == 'nt': subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True)
    else:
        import signal
        p.send_signal(signal.SIGINT)          # opennova.py stops its helper and server on Ctrl+C
    try: p.wait(10)
    except subprocess.TimeoutExpired: p.kill(); p.wait(5)


with open(os.path.join(NOVA, 'app', 'version.json'), encoding='utf-8-sig') as f: V = json.load(f)
VER = V.get('version', '')
ok(V.get('name') == 'Open Nova' and re.match(r'^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$', VER or ''),
   'app/version.json: name "Open Nova", version %r is MAJOR.MINOR.PATCH[-alpha|beta|rc.N]' % VER)
ok(V.get('channel') in ('dev', 'alpha', 'beta', 'release') and V.get('build') and isinstance(V.get('readOnly'), bool),
   'version.json has channel, build, readOnly (channel %s, build %s)' % (V.get('channel'), V.get('build')))

import alpha   # noqa: E402
ok(alpha.VERSION_FILE == os.path.join(NOVA, 'app', 'version.json') and alpha.info()['version'] == VER, 'alpha.py reads it: %s' % alpha.info()['version'])
ok(alpha.version_line().startswith('Open Nova %s (build ' % VER), 'alpha.version_line(): %s' % alpha.version_line())

# ---- serve.py (and serve.ps1)
servers = [('serve.py', [sys.executable, '-I', os.path.join(NOVA, 'app', 'serve.py')], '--data-dir')]
ps = shutil.which('powershell.exe')   # Windows PowerShell, as test_projects.py (serve.ps1 is the Windows server)
if ps: servers.append(('serve.ps1', [ps, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', os.path.join(NOVA, 'app', 'serve.ps1')], '-DataDir'))
else: print('SKIP serve.ps1 (Windows PowerShell is not here: serve.ps1 runs on Windows)')
for name, cmd, dd in servers:
    port, data = free_port(), os.path.join(TMP, name)
    p = subprocess.Popen(cmd + [str(port), '--local-only' if name == 'serve.py' else '-LocalOnly', dd, data, '--helper-port' if name == 'serve.py' else '-HelperPort',
                                str(free_port())], cwd=os.path.join(NOVA, 'app'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        st, body = wait('http://127.0.0.1:%d/version.json' % port)
        ok(st == 200 and json.loads(body.decode('utf-8-sig')).get('version') == VER, '%s serves version.json with %s' % (name, VER))
        st, page = wait('http://127.0.0.1:%d/' % port)
        ok(st == 200 and b'<title>Open Nova</title>' in page, '%s serves the page (title Open Nova; the app adds the version)' % name)
        line = ''
        for _ in range(20):
            try:
                with open(os.path.join(data, 'logs', 'open_nova.log'), encoding='utf-8-sig') as f:
                    line = next((ln for ln in f if '"server_start"' in ln), '')
            except OSError: pass
            if line: break
            time.sleep(0.2)
        ok(('"%s (build ' % VER) in line, '%s logs the version at start (%s)' % (name, re.sub(r'.*"version":\s*', '', line.strip())[:60]))
    finally:
        stop(p)

# ---- opennova.py: its first line names the version
port, hport = free_port(), free_port()
p = subprocess.Popen([sys.executable, '-I', '-u', os.path.join(NOVA, 'opennova.py'), '--no-browser', '--local-only', '--port', str(port), '--helper-port', str(hport),
                      '--data-dir', os.path.join(TMP, 'opennova')], cwd=NOVA, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                     env=dict(os.environ, OPENNOVA_DIAG=os.path.join(TMP, 'diag'), OPENNOVA_HELPER_LOGS=os.path.join(TMP, 'hlogs'), PYTHONIOENCODING='utf-8',
                              OPENNOVA_ALPHA_SETTINGS=os.path.join(TMP, 'alpha-settings.json'), OPENNOVA_LIBRARY=os.path.join(TMP, 'library')))
try:
    first = p.stdout.readline().decode('utf-8', 'replace').strip()   # unbuffered (-u): its own first line comes first
    ok(first.startswith('Open Nova %s (build ' % VER), 'opennova.py says which version starts: %s' % first)
finally:
    stop(p)

# ---- make_package.py: the alpha zip is named after it and carries it
out = os.path.join(TMP, 'dist')
r = subprocess.run([sys.executable, '-I', os.path.join(HERE, 'make_package.py'), '--alpha', '--no-unlock-code', '--out', out], cwd=NOVA,
                   capture_output=True, text=True, encoding='utf-8', errors='replace')
zp = os.path.join(out, 'OpenNova-%s-alpha.zip' % VER)
ok(r.returncode == 0 and os.path.isfile(zp), 'make_package --alpha builds OpenNova-%s-alpha.zip%s' % (VER, '' if r.returncode == 0 else ' (%s)' % r.stderr.strip()[-200:]))
if os.path.isfile(zp):
    with zipfile.ZipFile(zp) as z:
        sv = json.loads(z.read('OpenNova-%s-alpha/app/version.json' % VER).decode('utf-8'))
    ok(sv['version'] == VER and sv['channel'] == 'alpha' and sv['unlock'] is None and re.match(r'^\d{8}-[0-9a-f]{8}$', sv['build']),
       'its version.json: %s, channel alpha, build %s (date + content hash), no unlock' % (sv['version'], sv['build']))

# ---- nobody else spells the version out (it would go stale on the next bump)
try:
    import repo_files
    files = repo_files.tracked()
except Exception:  # noqa: BLE001
    files = None
if files is None:
    print('SKIP the version is written only in app/version.json (git is not installed)')
else:
    hits = []
    for f in files:
        if f == 'app/version.json' or not f.endswith(('.py', '.js', '.html', '.ps1', '.md', '.json', '.yml', '.css', '.bat', '.command', '.sh', '.lua')): continue
        try:
            with open(os.path.join(NOVA, f), encoding='utf-8') as fh: t = fh.read()
        except (OSError, UnicodeDecodeError): continue
        if VER in t: hits.append(f)
    ok(not hits, 'the version %s is written only in app/version.json%s' % (VER, ' (also in: %s)' % ', '.join(hits) if hits else ''))

shutil.rmtree(TMP, ignore_errors=True)
print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
