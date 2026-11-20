"""make_package.py - one zip with everything needed to run Open Nova on macOS, Windows or Linux (docs/RUNNING.md).

    python tools/make_package.py [--with-project] [--out DIR]
    python tools/make_package.py --alpha [--unlock-code | --no-unlock-code] [--contact ADDRESS] [--out DIR] [--python]

Puts dist/OpenNova-YYYYMMDD.zip next to this folder: the launchers, the app (page, scripts, serve.py / serve.ps1, test
pages) and the helper (novalink + the Unico / COEX / file modules). Nothing else: no captures, samples, logs or fakes.
--with-project also copies the server's projects (app/data/projects/), so the other computer starts with them.
The .command / .sh launchers are stored as executable, so macOS and Linux keep the permission when unzipping.
--python also makes one package per system with Python inside (<name>-windows.zip, -mac.zip, -linux.zip): the same files
plus python-dist/ = the official Python archives the starters would otherwise download on the first start (python.org's
embeddable package for Windows 64-bit + ARM64; python-build-standalone for Mac Apple silicon + Intel and Linux x86-64 +
ARM64). The starters unpack the right one into python/ on the first start: no internet needed. Which archives and their
SHA-256 come from tools/get-python.ps1 / get-python.sh themselves (one place); they are cached in dist/python-cache/.
The Windows and Mac ones also carry libusb (NovaStar's own USB device): libusb/<system>-<arch>/, the files listed in
tools/usb_libs.json (one place: path, SHA-256, the published archive they come from, unmodified, with its SHA-256), cached
in dist/libusb-cache/. The official Windows build is a .7z: taking the DLL out of it needs 7-Zip (7z / 7za / 7zz, or
its usual folder in Program Files) or bsdtar (macOS tar), only the first time. Every package has libusb's licence in licenses/.

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
import re
import shutil
import urllib.request
import sys
import time
import zipfile

NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(NOVA, 'tools'))
ROOT_FILES = ['opennova.py', 'Start Open Nova.command', 'Start Open Nova.bat', 'start-open-nova.sh', 'LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE']
APP_FILES = ['index.html', 'app.css', 'polish.css', 'scr.js', 'scfg.js', 'hwsend.js', 'unicosend.js', 'serve.py', 'serve.ps1', 'version.json', 'icon.svg']
APP_DIRS = ['js', 'tests', 'looks', 'fonts']
TOOLS = ['novalink.py', 'unicolink.py', 'coexlink.py', 'rcvfile.py', 'rcvguard.py', 'rcvlib.py', 'vmpproject.py', 'netif.py', 'sysdiag.py', 'hweb.py',
         'wirelog.py', 'alpha.py', 'vendortap.py', 'usbcap.py', 'usbauto.py', 'netcap.py', 'netcap_worker.py', 'usbpcap.json', 'tg_registers.json', 'wireshark/novastar.lua', 'get-python.ps1', 'get-python.sh']
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


def python_archives():
    """[(system, file, url, sha256)]: the Python archives the starters fetch, read from the fetch scripts themselves."""
    out = []
    with open(os.path.join(NOVA, 'tools', 'get-python.ps1'), encoding='utf-8') as f: ps = f.read()
    ver = re.search(r"\$Version = '([\d.]+)'", ps).group(1)
    for kind, sha in re.findall(r"^\s+(amd64|arm64|win32) = '([0-9a-f]{64})'", ps, re.M):
        if kind == 'win32': continue                 # 32-bit Windows is rare: it still downloads on the first start
        n = 'python-%s-embed-%s.zip' % (ver, kind)
        out.append(('windows', n, 'https://www.python.org/ftp/python/%s/%s' % (ver, n), sha))
    with open(os.path.join(NOVA, 'tools', 'get-python.sh'), encoding='utf-8') as f: sh = f.read()
    v, r = re.search(r'^VERSION=(\S+)', sh, re.M).group(1), re.search(r'^RELEASE=(\S+)', sh, re.M).group(1)
    for system, t, sha in re.findall(r'^\s+(Darwin|Linux)/[^)]*\)\s+t=(\S+);\s+sum=([0-9a-f]{64})', sh, re.M):
        n = 'cpython-%s+%s-%s-install_only_stripped.tar.gz' % (v, r, t)
        out.append(('mac' if system == 'Darwin' else 'linux', n,
                    'https://github.com/astral-sh/python-build-standalone/releases/download/%s/%s' % (r, n.replace('+', '%2B')), sha))
    return out


def python_archive(cache, name, url, sha):
    """The archive from dist/python-cache (downloaded once), checked against its SHA-256 every time."""
    p = os.path.join(cache, name)
    if not os.path.isfile(p):
        os.makedirs(cache, exist_ok=True)
        print('downloading ' + url)
        with urllib.request.urlopen(url, timeout=120) as r, open(p + '.part', 'wb') as f: shutil.copyfileobj(r, f)
        os.replace(p + '.part', p)
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    if h.hexdigest() != sha: raise SystemExit('%s is not the published file (SHA-256 %s); delete it and build again' % (p, h.hexdigest()))
    return p


def usb_libs():
    """tools/usb_libs.json: {files: [{system, path, sha256, from: {url, sha256, member, headers}}], licenses, source}."""
    with open(os.path.join(NOVA, 'tools', 'usb_libs.json'), encoding='utf-8') as f: return json.load(f)


def usbpcap():
    """tools/usbpcap.json: USBPcap's official installer + its source, which the Windows package carries in usb-capture/."""
    with open(os.path.join(NOVA, 'tools', 'usbpcap.json'), encoding='utf-8') as f: return json.load(f)


def usbpcap_file(cache, url, sha):
    """One of USBPcap's published files from dist/usbpcap-cache (downloaded once), checked every time."""
    p = os.path.join(cache, url.rsplit('/', 1)[1])
    if not os.path.isfile(p) or _sha(p) != sha:
        os.makedirs(cache, exist_ok=True)
        print('downloading ' + url)
        r = urllib.request.Request(url, headers={'User-Agent': 'open-nova-build'})
        with urllib.request.urlopen(r, timeout=120) as x, open(p + '.part', 'wb') as f: shutil.copyfileobj(x, f)
        os.replace(p + '.part', p)
    if _sha(p) != sha: raise SystemExit('%s is not the published file (SHA-256 %s); delete it and build again' % (p, _sha(p)))
    return p


def _sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def _unpack_member(arc, member, dst):
    """member of the archive arc (.tar.gz: tarfile; .7z: 7-Zip, else bsdtar, e.g. macOS tar) -> the file dst."""
    import subprocess
    import tempfile
    if not arc.endswith('.7z'):
        import tarfile
        with tarfile.open(arc) as t, open(dst + '.part', 'wb') as f: shutil.copyfileobj(t.extractfile(member), f)
        os.replace(dst + '.part', dst); return
    sevens = [shutil.which(x) for x in ('7z', '7za', '7zz')] + [os.path.join(os.environ.get(v, ''), '7-Zip', '7z.exe') for v in ('ProgramFiles', 'ProgramFiles(x86)')]
    tar = shutil.which('bsdtar') or (shutil.which('tar') if sys.platform == 'darwin' else None)
    runs = [[t, 'x', '-y', '-o' + '{tmp}', arc, member] for t in sevens if t and os.path.isfile(t)] + ([[tar, '-xf', arc, '-C', '{tmp}', member]] if tar else [])
    for cmd in runs:
        tmp = tempfile.mkdtemp(prefix='opennova_libusb_')
        try:
            got = os.path.join(tmp, *member.split('/'))
            if subprocess.run([x.replace('{tmp}', tmp) for x in cmd], capture_output=True).returncode == 0 and os.path.isfile(got):
                shutil.move(got, dst); return
        finally: shutil.rmtree(tmp, ignore_errors=True)
    raise SystemExit('%s: taking %s out of it needs 7-Zip (7z / 7za / 7zz) or bsdtar; or put that file into %s as %s yourself'
                     % (arc, member, os.path.dirname(dst), os.path.basename(dst)))


def usb_lib(cache, e):
    """One tools/usb_libs.json file from dist/libusb-cache (made once from the downloaded archive), checked every time."""
    p = os.path.join(cache, e['path'].replace('/', '_'))
    if not os.path.isfile(p):
        src = e['from']
        arc = os.path.join(cache, src['sha256'] + ('.7z' if src['url'].endswith('.7z') else '.tar.gz'))   # named by its SHA-256
        if not os.path.isfile(arc) or _sha(arc) != src['sha256']:
            os.makedirs(cache, exist_ok=True)
            print('downloading ' + src['url'])
            r = urllib.request.Request(src['url'], headers=dict(src.get('headers') or {}, **{'User-Agent': 'open-nova-build'}))
            with urllib.request.urlopen(r, timeout=120) as x, open(arc + '.part', 'wb') as f: shutil.copyfileobj(x, f)
            os.replace(arc + '.part', arc)
        if _sha(arc) != src['sha256']: raise SystemExit('%s is not the published file (SHA-256 %s); delete it and build again' % (arc, _sha(arc)))
        _unpack_member(arc, src['member'], p)
    if _sha(p) != e['sha256']: raise SystemExit('%s is not %s from %s (SHA-256 %s); delete it and build again' % (p, e['from']['member'], e['from']['url'], _sha(p)))
    return p


def with_python(zp, name, out):
    """<name>-windows/-mac/-linux.zip: the package zp plus python-dist/ with that system's Python archives."""
    cache, made = os.path.join(out, 'python-cache'), []
    arcs, usb = python_archives(), usb_libs()['files']
    for system in ('windows', 'mac', 'linux'):
        mine = [a for a in arcs if a[0] == system]
        dst = os.path.join(out, '%s-%s.zip' % (name, system))
        if os.path.exists(dst): os.replace(dst, dst[:-4] + '_prev.zip')
        with zipfile.ZipFile(zp) as src, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as z:
            for info in src.infolist(): z.writestr(info, src.read(info))
            for _, n, url, sha in mine:              # already compressed: stored as they are
                info = zipfile.ZipInfo(name + '/python-dist/' + n, time.localtime(os.path.getmtime(python_archive(cache, n, url, sha)))[:6])
                info.compress_type, info.create_system, info.external_attr = zipfile.ZIP_STORED, 3, 0o100644 << 16
                with open(os.path.join(cache, n), 'rb') as f: z.writestr(info, f.read())
            libs = [e for e in usb if e['system'] == system]
            for e in libs:                           # libusb for NovaStar's own USB device, as published
                lp = usb_lib(os.path.join(out, 'libusb-cache'), e)
                info = zipfile.ZipInfo(name + '/' + e['path'], time.localtime(os.path.getmtime(lp))[:6])
                info.compress_type, info.create_system, info.external_attr = zipfile.ZIP_DEFLATED, 3, 0o100644 << 16
                with open(lp, 'rb') as f: z.writestr(info, f.read())
            if system == 'windows':                  # USBPcap for USB capture, as published: the installer + its source (GPL-2.0 §3)
                up = usbpcap()
                for path, url, sha in ((up['path'], up['url'], up['sha256']), (up['sourcePath'], up['sourceUrl'], up['sourceSha256'])):
                    fp = usbpcap_file(os.path.join(out, 'usbpcap-cache'), url, sha)
                    info = zipfile.ZipInfo(name + '/' + path, time.localtime(os.path.getmtime(fp))[:6])
                    info.compress_type, info.create_system, info.external_attr = zipfile.ZIP_STORED, 3, 0o100644 << 16
                    with open(fp, 'rb') as f: z.writestr(info, f.read())
        made.append(dst)
        print('%s  (+ Python: %s%s, %d MB)' % (dst, ', '.join(n for _, n, _, _ in mine), ''.join(' + ' + e['path'] for e in libs), os.path.getsize(dst) >> 20))
    return made


def main(argv, ask=getpass.getpass):
    with_project, alpha = '--with-project' in argv, '--alpha' in argv
    out = argv[argv.index('--out') + 1] if '--out' in argv else os.path.join(NOVA, 'dist')
    if alpha and with_project: raise SystemExit('--alpha never takes projects (nothing private goes to testers)')
    code = env_code() if alpha and '--no-unlock-code' not in argv else None
    with open(os.path.join(NOVA, 'app', 'version.json'), encoding='utf-8-sig') as f: ver = json.load(f)
    os.makedirs(out, exist_ok=True)
    bt, sde = build_time(), os.environ.get('SOURCE_DATE_EPOCH', '').isdigit()
    name = 'OpenNova-%s-alpha' % ver['version'] if alpha else 'OpenNova-' + bt.strftime('%Y%m%d')
    files = [(f, f) for f in ROOT_FILES + usb_libs()['licenses'] + usbpcap()['licenses']] + [('docs/RUNNING.md', 'RUNNING.md'), ('docs/DIAGNOSTICS.md', 'DIAGNOSTICS.md'),
                                            ('docs/VENDOR_CAPTURE.md', 'VENDOR_CAPTURE.md'), ('docs/USB_CAPTURE.md', 'USB_CAPTURE.md')]
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
    if '--python' in argv:
        with_python(zp, name, out)
        if alpha:   # testers get only the full packages (user, 2026-11-17: "the alpha needs to be the full alpha for now"):
            part = os.path.join(out, 'build')   # the no-Python zip they're made from moves out of the way, kept
            os.makedirs(part, exist_ok=True)
            os.replace(zp, os.path.join(part, os.path.basename(zp)))
            print('(the no-Python %s is in %s: not for testers)' % (os.path.basename(zp), part))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
