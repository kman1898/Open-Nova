"""smoke_package.py - does a built package start and serve the app? (docs/TESTING.md; CI runs it on Linux, macOS, Windows)

    python tools/smoke_package.py PACKAGE.zip [--dir UNZIPPED] [--version V] [--alpha] [--port P] [--helper-port H]

PACKAGE.zip = what tools/make_package.py built. The zip itself: the launchers, licences (LICENSE-MIT, LICENSE-APACHE,
NOTICE), the fonts with their OFL texts, the helper and the app are in it, nothing private (recordings, captures, vendor
files, project data), the .command / .sh launchers stored executable; --alpha: README-ALPHA.md, no test pages, version.json
stamped (channel alpha, build date-hash, an unlock of salt / sha256 / tokenSha256). Then the unzipped folder (--dir = one
unzipped by the system's own tool, else this unzips it into a temporary folder) is started as a user would:
python opennova.py --no-browser --local-only on free ports with a temporary data folder, and probed: / (the page),
/version.json (the version: --version, else this checkout's app/version.json), /api/projects, /js/app-core.js,
/fonts/fonts.css and a .woff2 (font/woff2), the helper through the server (/api/hw/ping, /api/hw/diag/status: reads only,
no processor). Then it is stopped (with its helper and server). Exit 0 = all passed.
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

NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
try: sys.stdout.reconfigure(errors='replace')   # a Windows console can't show every character the tests print
except AttributeError: pass
PRIVATE = re.compile(r'(^|/)(Samples|captures|diagnostics|test-data|data|data-home|out|samples|novalink_logs|novalink_sim|FakeProcessor|FakeUServer|re)/'
                     r'|\.(nwl|pcap|pcapng|rcfgx|ncp|scr|scfg|zip)$|(^|/)(alpha-settings|h-logins)\.json$')
fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what); sys.stdout.flush()
    if not cond: fails.append(what)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def req(url, data=None, timeout=5):
    """(status, content type, body); status None when nothing answers."""
    r = urllib.request.Request(url, data=data, method='POST' if data is not None else 'GET', headers={'Content-Type': 'application/json'} if data is not None else {})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as x: return x.status, x.headers.get('Content-Type', ''), x.read()
    except urllib.error.HTTPError as e: return e.code, e.headers.get('Content-Type', ''), e.read()
    except OSError: return None, '', b''


def stop(p):
    """Stop opennova.py and the helper + server it started."""
    if p.poll() is not None: return
    if os.name == 'nt': subprocess.run(['taskkill', '/PID', str(p.pid), '/T', '/F'], capture_output=True)
    else:
        import signal
        p.send_signal(signal.SIGINT)                 # opennova.py stops its children on Ctrl+C
    try: p.wait(15)
    except subprocess.TimeoutExpired: p.kill(); p.wait(5)


def main(argv):
    a, zp, folder, ver, alpha, port, hport = list(argv), None, None, None, False, None, None
    while a:
        k = a.pop(0)
        if k == '--dir' and a: folder = a.pop(0)
        elif k == '--version' and a: ver = a.pop(0)
        elif k == '--alpha': alpha = True
        elif k == '--port' and a: port = int(a.pop(0))
        elif k == '--helper-port' and a: hport = int(a.pop(0))
        elif not k.startswith('--') and zp is None: zp = k
        else: print(__doc__); return 2
    if not zp or not os.path.isfile(zp): print(__doc__); return 2
    if ver is None:
        with open(os.path.join(NOVA, 'app', 'version.json'), encoding='utf-8-sig') as f: ver = json.load(f)['version']
    tmp = tempfile.mkdtemp(prefix='opennova_smoke_')
    print('%s (%d KB), expecting version %s%s' % (os.path.basename(zp), os.path.getsize(zp) // 1024, ver, ', alpha' if alpha else ''))

    # ---- the zip
    with zipfile.ZipFile(zp) as z:
        infos = z.infolist()
        tops = {i.filename.split('/')[0] for i in infos}
        ok(len(tops) == 1, 'one top folder in the zip (%s)' % ', '.join(sorted(tops)))
        top = sorted(tops)[0]
        names = {i.filename[len(top) + 1:]: i for i in infos if not i.is_dir()}
        need = ['opennova.py', 'Start Open Nova.command', 'Start Open Nova.bat', 'start-open-nova.sh', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE',
                'RUNNING.md', 'app/index.html', 'app/serve.py', 'app/serve.ps1', 'app/version.json', 'app/js/main.js', 'app/fonts/fonts.css',
                'tools/novalink.py', 'tools/wirelog.py', 'tools/alpha.py', 'tools/tg_registers.json', 'tools/wireshark/novastar.lua']
        if alpha: need.append('README-ALPHA.md')
        miss = [n for n in need if n not in names]
        ok(not miss, 'the launchers, licences, app and helper are in it (%d files)%s' % (len(names), ': missing ' + ', '.join(miss) if miss else ''))
        fonts = sorted({n.split('/')[-1].split('-')[0] for n in names if n.startswith('app/fonts/') and n.endswith('.woff2')})
        nofl = [f for f in fonts if 'app/fonts/OFL-%s.txt' % f not in names]
        ok(fonts and not nofl, 'every bundled font family ships with its OFL licence (%s)%s' % (', '.join(fonts), ': missing ' + ', '.join(nofl) if nofl else ''))
        priv = [n for n in names if PRIVATE.search(n)]
        ok(not priv, 'nothing private in it (recordings, captures, vendor files, project data)%s' % (': ' + ', '.join(priv[:10]) if priv else ''))
        bits = {n: (names[n].external_attr >> 16) & 0o777 for n in names if n.endswith(('.command', '.sh'))}
        ok(bits and all(b == 0o755 for b in bits.values()), 'the .command / .sh launchers are stored executable (%s)' % ', '.join('%s %o' % kv for kv in bits.items()))
        v = json.loads(z.read(top + '/app/version.json').decode('utf-8-sig'))
        ok(v.get('version') == ver, 'version.json in the zip: %s' % v.get('version'))
        if alpha:
            u = v.get('unlock') or {}
            ok(v.get('channel') == 'alpha' and v.get('readOnly') is True and re.match(r'^\d{8}-[0-9a-f]{8}$', v.get('build', '')),
               'alpha stamp: channel %s, readOnly %s, build %s' % (v.get('channel'), v.get('readOnly'), v.get('build')))
            ok(all(re.match(r'^[0-9a-f]{16,}$', str(u.get(k, ''))) for k in ('salt', 'sha256', 'tokenSha256')), 'alpha unlock = salt / sha256 / tokenSha256 (hashes only)')
            ok(not any(n.startswith('app/tests/') for n in names), 'no test pages in the alpha package')
        if folder is None:
            z.extractall(tmp)
            folder = os.path.join(tmp, top)
            for n, i in names.items():   # zipfile doesn't restore permissions: as unzip / Finder would
                m = (i.external_attr >> 16) & 0o777
                if m and os.name != 'nt': os.chmod(os.path.join(folder, *n.split('/')), m)
    ok(os.path.isfile(os.path.join(folder, 'opennova.py')), 'unzipped: %s' % folder)
    if os.name != 'nt':
        ok(os.access(os.path.join(folder, 'start-open-nova.sh'), os.X_OK), 'start-open-nova.sh is executable after unzipping')

    # ---- start it as a user would, probe, stop
    port, hport = port or free_port(), hport or free_port()
    data = os.path.join(tmp, 'data')
    log = open(os.path.join(tmp, 'opennova.out'), 'wb')
    p = subprocess.Popen([sys.executable, '-u', 'opennova.py', '--no-browser', '--local-only', '--port', str(port), '--helper-port', str(hport), '--data-dir', data],
                         cwd=folder, stdout=log, stderr=subprocess.STDOUT, env=dict(os.environ, PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1'))
    base = 'http://127.0.0.1:%d/' % port
    try:
        st = None
        for _ in range(60):
            st, ct, body = req(base + 'index.html', timeout=2)
            if st == 200 or p.poll() is not None: break
            time.sleep(0.5)
        ok(st == 200 and p.poll() is None, 'opennova.py started the helper and the server (port %d, helper %d)' % (port, hport))
        st, ct, body = req(base)
        title = re.search(rb'<title>([^<]*)</title>', body or b'')
        ok(st == 200 and 'text/html' in ct and title and b'Open Nova' in title.group(1), 'GET / : %s, title "%s"' % (st, title.group(1).decode() if title else '-'))
        st, ct, body = req(base + 'version.json')
        sv = json.loads(body.decode('utf-8-sig')) if st == 200 else {}
        ok(sv.get('version') == ver and sv.get('name') == 'Open Nova', 'GET /version.json : Open Nova %s (build %s, %s) - the page shows it in its title' % (sv.get('version'), sv.get('build'), sv.get('channel')))
        st, ct, body = req(base + 'api/projects')
        try: pj = json.loads(body.decode('utf-8'))
        except ValueError: pj = None
        ok(st == 200 and 'json' in ct and isinstance(pj, dict), 'GET /api/projects : %s %s' % (st, ct))
        st, ct, body = req(base + 'js/app-core.js')
        ok(st == 200 and 'javascript' in ct and len(body) > 1000, 'GET /js/app-core.js : %s %s, %d B' % (st, ct, len(body)))
        st, ct, body = req(base + 'fonts/fonts.css')
        ok(st == 200 and 'text/css' in ct and b'@font-face' in body, 'GET /fonts/fonts.css : %s %s' % (st, ct))
        w = re.search(rb"url\('([^']+\.woff2)'\)", body or b'')
        st, ct, fb = req(base + 'fonts/' + w.group(1).decode()) if w else (None, '', b'')
        ok(st == 200 and ct == 'font/woff2' and fb[:4] == b'wOF2', 'GET a .woff2 : %s %s' % (st, ct))
        st, ct, body = req(base + 'api/hw/ping')
        ok(st == 200 and b'novalink' in body, 'the helper answers through the server (GET /api/hw/ping): %s' % st)
        st, ct, body = req(base + 'api/hw/diag/status', b'{}')
        try: ds = json.loads(body.decode('utf-8'))
        except ValueError: ds = {}
        ok(st == 200 and isinstance(ds, dict) and 'seq' in ds, 'POST /api/hw/diag/status (the recorder, read only): %s' % st)
        st, ct, body = req(base + 'no-such-file.js')
        ok(st == 404, 'a missing file is a 404, not a crash: %s' % st)
        ok(p.poll() is None, 'still running after the probes')
    finally:
        stop(p); log.close()
    time.sleep(0.5)
    ok(req(base + 'index.html', timeout=1)[0] is None and req('http://127.0.0.1:%d/api/hw/ping' % hport, timeout=1)[0] is None,
       'stopped: nothing left on ports %d / %d' % (port, hport))
    if fails:
        with open(os.path.join(tmp, 'opennova.out'), encoding='utf-8', errors='replace') as f: out = f.read()
        print('--- opennova.py said:\n' + out[-3000:])
    shutil.rmtree(tmp, ignore_errors=True)
    print('\n%d failed' % len(fails) if fails else '\nAll passed')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
