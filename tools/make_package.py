"""make_package.py - one zip with everything needed to run Open Nova on macOS, Windows or Linux (docs/RUNNING.md).

    python tools/make_package.py [--with-project] [--out DIR]
    python tools/make_package.py --alpha [--unlock-code | --no-unlock-code] [--contact ADDRESS] [--out DIR]

Puts dist/OpenNova-YYYYMMDD.zip next to this folder: the launchers, the app (page, scripts, serve.py / serve.ps1, test
pages) and the helper (novalink + the Unico / COEX / file modules). Nothing else: no captures, samples, logs or fakes.
--with-project also copies the server's projects (app/data/projects/), so the other computer starts with them.
The .command / .sh launchers are stored as executable, so macOS and Linux keep the permission when unzipping.

--alpha (docs/DIAGNOSTICS.md "The alpha build"): dist/OpenNova-<version>-alpha.zip for testers. app/version.json in the zip is stamped: channel
"alpha", build = date + the first 8 hex of a SHA-256 over every packaged file, read-only until unlocked. Adds
README-ALPHA.md; leaves out the test pages and never takes projects, data, recordings, samples or test data.
--unlock-code asks for the code that switches sending on (Settings ▸ Alpha ▸ Allow sending) twice on the console, without
echo; only a random salt, SHA-256(salt + code) and the hash of the send token go into version.json (tools/alpha.py
make_unlock), the code itself is not written or logged anywhere.
Where the unlock comes from (user, 2026-10-28: one simple code for every alpha build, a speed bump against accidental
sends, not a real password): (1) the environment variable OPENNOVA_UNLOCK_CODE when set (never printed; no prompt),
else (2) the console prompt when --unlock-code is given, else (3) by default tools/alpha_unlock.json's "unlock" (the
shared code's salt + hashes only), so `--alpha` alone and CI need no secret. --no-unlock-code = a build that never
writes to processors.
--contact ADDRESS (or OPENNOVA_REPORT_CONTACT) = where testers send their reports (else version.json's reportContact).
Reproducible for CI: Python 3.9+ stdlib, paths relative to this folder only, the same on Linux / macOS / Windows; with
SOURCE_DATE_EPOCH set, the build date and every file time in the zip come from it (the same build id from the same sources).
"""
import datetime
import getpass
import hashlib
import json
import os
import sys
import time
import zipfile

NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(NOVA, 'tools'))
ROOT_FILES = ['opennova.py', 'Start Open Nova.command', 'Start Open Nova.bat', 'start-open-nova.sh', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE']
APP_FILES = ['index.html', 'app.css', 'polish.css', 'scr.js', 'scfg.js', 'hwsend.js', 'unicosend.js', 'serve.py', 'serve.ps1', 'version.json', 'icon.svg']
APP_DIRS = ['js', 'tests', 'looks', 'fonts']
TOOLS = ['novalink.py', 'unicolink.py', 'coexlink.py', 'rcvfile.py', 'rcvguard.py', 'rcvlib.py', 'vmpproject.py', 'netif.py', 'hweb.py',
         'wirelog.py', 'alpha.py', 'vendortap.py', 'tg_registers.json', 'wireshark/novastar.lua']
EXEC = ('.command', '.sh')
PRIVATE = ('app/data', 'diagnostics', 'Samples', 'test-data', 'tools/novalink_logs', 'tools/novalink_sim', 'alpha-settings.json', 'app/out')


def ask_code(ask):
    """The unlock code, typed twice without echo. Never printed, logged or written."""
    for _ in range(3):
        try: a = ask('Unlock code for sending (not shown): ')
        except EOFError: raise SystemExit('No console to type the unlock code: set OPENNOVA_UNLOCK_CODE (CI), or leave out --unlock-code (the shared code, tools/alpha_unlock.json).')
        if len(a) < 4: print('At least 4 characters, please.'); continue
        if ask('Type it again: ') != a: print('They don’t match — again.'); continue
        return a
    raise SystemExit('No unlock code set.')


def env_code():
    """OPENNOVA_UNLOCK_CODE, when set (CI). Never printed; a too-short one stops the build without showing it."""
    c = os.environ.get('OPENNOVA_UNLOCK_CODE')
    if c is None or c == '': return None
    if len(c) < 4: raise SystemExit('OPENNOVA_UNLOCK_CODE is too short (at least 4 characters).')
    return c


def shared_unlock():
    """tools/alpha_unlock.json's unlock: the one code every alpha build shares, as salt + hashes (the code is in no file)."""
    try:
        with open(os.path.join(NOVA, 'tools', 'alpha_unlock.json'), encoding='utf-8-sig') as f: u = json.load(f).get('unlock') or {}
    except (OSError, ValueError) as e: raise SystemExit('tools/alpha_unlock.json unreadable (%s): set OPENNOVA_UNLOCK_CODE, --unlock-code or --no-unlock-code' % e)
    if not (u.get('salt') and u.get('sha256') and u.get('tokenSha256')): raise SystemExit('tools/alpha_unlock.json has no complete unlock (salt, sha256, tokenSha256)')
    return {k: u[k] for k in ('salt', 'sha256', 'tokenSha256')}


def build_time():
    """SOURCE_DATE_EPOCH (reproducible builds) or now."""
    e = os.environ.get('SOURCE_DATE_EPOCH')
    return datetime.datetime.fromtimestamp(int(e), datetime.timezone.utc).replace(tzinfo=None) if e and e.isdigit() else datetime.datetime.now()


def main(argv, ask=getpass.getpass):
    with_project, alpha = '--with-project' in argv, '--alpha' in argv
    out = argv[argv.index('--out') + 1] if '--out' in argv else os.path.join(NOVA, 'dist')
    if alpha and with_project: raise SystemExit('--alpha never takes projects (nothing private goes to testers)')
    code = env_code() if alpha and '--no-unlock-code' not in argv else None
    with open(os.path.join(NOVA, 'app', 'version.json'), encoding='utf-8-sig') as f: ver = json.load(f)
    os.makedirs(out, exist_ok=True)
    bt, sde = build_time(), os.environ.get('SOURCE_DATE_EPOCH', '').isdigit()
    name = 'OpenNova-%s-alpha' % ver['version'] if alpha else 'OpenNova-' + bt.strftime('%Y%m%d')
    files = [(f, f) for f in ROOT_FILES] + [('docs/RUNNING.md', 'RUNNING.md'), ('docs/DIAGNOSTICS.md', 'DIAGNOSTICS.md'),
                                            ('docs/VENDOR_CAPTURE.md', 'VENDOR_CAPTURE.md')]
    if alpha: files.append(('docs/README-ALPHA.md', 'README-ALPHA.md'))
    files += [('app/' + f, 'app/' + f) for f in APP_FILES]
    for d in APP_DIRS:
        if alpha and d == 'tests': continue
        for f in sorted(os.listdir(os.path.join(NOVA, 'app', d))):
            if os.path.isfile(os.path.join(NOVA, 'app', d, f)): files.append(('app/%s/%s' % (d, f), 'app/%s/%s' % (d, f)))
    files += [('tools/' + f, 'tools/' + f) for f in TOOLS]
    if with_project:   # the server's project list (app/data/projects: index.json + <id>.json / .rev; not removed/)
        pd = os.path.join(NOVA, 'app', 'data', 'projects')
        if os.path.isdir(pd):
            files += [('app/data/projects/' + f, 'app/data/projects/' + f) for f in sorted(os.listdir(pd))
                      if os.path.isfile(os.path.join(pd, f)) and f.endswith(('.json', '.rev'))]
        else:          # an older server's single project (the new server moves it into the list at start)
            files += [('app/data/project.json', 'app/data/project.json'), ('app/data/project.rev', 'app/data/project.rev')]
    data = {}
    for src, arc in files:
        p = os.path.join(NOVA, *src.split('/'))
        if not os.path.isfile(p): raise SystemExit('missing: ' + src)
        if alpha and any(src == x or src.startswith(x + '/') for x in PRIVATE): raise SystemExit('private file in an alpha package: ' + src)
        with open(p, 'rb') as f: data[arc] = (f.read(), os.path.getmtime(p))
    if alpha:          # stamp version.json: build = date + hash of everything else; the unlock as salt + hashes only
        h = hashlib.sha256()
        for arc in sorted(data):
            if arc != 'app/version.json': h.update(arc.encode('utf-8') + b'\0' + data[arc][0])
        ver = dict(ver, channel='alpha', readOnly=True, build=bt.strftime('%Y%m%d') + '-' + h.hexdigest()[:8])
        if '--contact' in argv: ver['reportContact'] = argv[argv.index('--contact') + 1]
        elif os.environ.get('OPENNOVA_REPORT_CONTACT'): ver['reportContact'] = os.environ['OPENNOVA_REPORT_CONTACT']
        if '--no-unlock-code' in argv: ver['unlock'] = None
        elif code is not None or '--unlock-code' in argv:
            import alpha as al
            ver['unlock'] = al.make_unlock(code if code is not None else ask_code(ask))
            code = None
        else: ver['unlock'] = shared_unlock()
        data['app/version.json'] = ((json.dumps(ver, indent=1, ensure_ascii=False) + '\n').encode('utf-8'), time.time())
    if sde:            # reproducible: one fixed time for every file
        data = {k: (b, bt.replace(tzinfo=datetime.timezone.utc).timestamp()) for k, (b, _) in data.items()}
    zp = os.path.join(out, name + '.zip')
    if os.path.exists(zp):
        os.replace(zp, zp[:-4] + '_prev.zip')          # the previous build is kept, not deleted
    with zipfile.ZipFile(zp, 'w', zipfile.ZIP_DEFLATED) as z:
        for _, arc in files:
            b, mt = data[arc]
            info = zipfile.ZipInfo(name + '/' + arc, (datetime.datetime.fromtimestamp(mt, datetime.timezone.utc) if sde else datetime.datetime.fromtimestamp(mt)).timetuple()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3                     # Unix, so the permission bits below are honoured
            info.external_attr = (0o100755 if arc.endswith(EXEC) else 0o100644) << 16
            z.writestr(info, b)
    print('%s  (%d files, %d KB)%s' % (zp, len(files), os.path.getsize(zp) // 1024,
                                       '  version %s build %s, unlock code %s' % (ver['version'], ver['build'], 'set' if ver.get('unlock') else 'NONE') if alpha else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
