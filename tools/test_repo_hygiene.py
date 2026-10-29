"""Guards for what goes into the (later public) repository: the files .gitignore lets in (tools/repo_files.py) hold no private
data, and every file the app needs at run time is among them, so a package built from a checkout can't miss one.
    python -I -X utf8 tools/test_repo_hygiene.py      (exit 0 = all passed; 77 = git isn't installed, nothing checked)

Private = the user's network (the VM's 192.168.2.x addresses; a 192.168.0.x other than the example addresses below),
anything under the private folders (Samples, captures, diagnostics, test data, fakes, project data …), vendor / recording
files (.nwl .pcap .pcapng .rcfgx .ncp .scr .scfg …), mail addresses, saved logins (h-logins.json, alpha-settings.json; where
this computer has an H login store, none of its values may appear in a tracked file), citations of decompiled NovaStar
code (LCA:11512, SC:…, TGP:…, DataClass:…, Foo.cs:60, "[C]", "decompiled", tools/re/…, Nova.X.Y namespaces, …Accessor
classes, vendor .dll names) and names of the user's recordings (redund_h20x4, h20_20260927_005736, lct-B.pcapng …; the
tests that open a private recording by name, tools/test_*.py, may name it). Where a comment needs its source, the source
goes into docs/CODE_SOURCES.md (private, never tracked) and the comment says in plain words what the code does and why.
DECOMPILED_ENFORCED = True since 2026-10-28 (every citation moved out): any citation fails.
"""
import ast
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import repo_files   # noqa: E402

NOVA = repo_files.NOVA
fails = []


def ok(cond, what, lines=()):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond:
        fails.append(what)
        for ln in list(lines)[:60]: print('      ' + ln)
        if len(lines) > 60: print('      … %d more' % (len(lines) - 60))


files = repo_files.tracked()
if files is None:
    print('SKIP every check (git is not installed: the whitelist can\'t be worked out)'); sys.exit(77)
print('%d files in the repository' % len(files))

# ------------------------------------------------------------------ paths and file types
PRIVATE_DIRS = ('Samples/', 'captures/', 'diagnostics/', 'test-data/', 'superseded/', 'dist/', 'library/', 'app/data/', 'app/data-home/',
                'app/out/', 'app/samples/', 'tools/FakeProcessor/', 'tools/FakeUServer/', 'tools/novalink_logs/', 'tools/novalink_sim/',
                'tools/re/', 'tools/unico/', 'tools/vmp/', 'tools/catalog/', 'tools/lcthost/', 'tools/scr_complex/')
PRIVATE_EXT = ('.nwl', '.nwl.gz', '.pcap', '.pcapng', '.rcfgx', '.ncp', '.scr', '.scfg', '.uscr', '.rcvp', '.bin', '.zip', '.dll', '.exe',
               '.cs', '.il', '.pdb')
PRIVATE_NAMES = ('h-logins.json', 'alpha-settings.json', 'project.json', 'index.json', 'code_sources.md')   # the private citations
bad = [f for f in files if any(('/' + f).find('/' + d) >= 0 for d in PRIVATE_DIRS)]
ok(not bad, 'nothing under Samples / captures / diagnostics / test data / fakes / project data / research folders', bad)
bad = [f for f in files if f.lower().endswith(PRIVATE_EXT)]
ok(not bad, 'no recordings, captures, vendor files (.nwl .pcap .rcfgx .ncp .scr .scfg …), binaries or zips', bad)
bad = [f for f in files if os.path.basename(f).lower() in PRIVATE_NAMES]
ok(not bad, 'no saved logins, alpha settings, project files or the private code-sources notes (docs/CODE_SOURCES.md)', bad)
big = [f for f in files if os.path.isfile(os.path.join(NOVA, f)) and os.path.getsize(os.path.join(NOVA, f)) > 2_000_000]
ok(not big, 'no file over 2 MB (a capture or a sample slipping in)', big)

# ------------------------------------------------------------------ contents
texts, nul, pngs = {}, [], []
for f in files:
    p = os.path.join(NOVA, f)
    if not os.path.isfile(p) or f.endswith('.woff2'): continue
    with open(p, 'rb') as fh: b = fh.read()
    if f.endswith('.png'): pngs.append((f, b)); continue        # pictures: checked below, not read as text
    if b'\0' in b: nul.append(f)
    texts[f] = b.decode('utf-8', 'replace')
ok(not nul, 'no NUL bytes in a text file (%d files)' % len(texts), nul)
# pictures (the README's logo and screenshots) live in assets/ and carry no text: a screenshot tool or an editor can
# write the file it came from, a user name or a comment into a PNG's text chunks
bad = [f for f, _b in pngs if not f.startswith('assets/')]
ok(not bad, 'pictures only under assets/ (%d)' % len(pngs), bad)


def png_chunks(b):
    out, i = [], 8
    while i + 8 <= len(b):
        n = int.from_bytes(b[i:i + 4], 'big'); out.append(b[i + 4:i + 8].decode('latin-1')); i += 12 + n
    return out


bad = ['%s: %s' % (f, ', '.join(sorted(set(c for c in png_chunks(b) if c in ('tEXt', 'zTXt', 'iTXt', 'eXIf')))))
       for f, b in pngs if not b.startswith(b'\x89PNG\r\n\x1a\n') or set(png_chunks(b)) & {'tEXt', 'zTXt', 'iTXt', 'eXIf'}]
ok(not bad, 'no text or EXIF in a picture (strip it before adding one)', bad)


def grep(rx, allow=None, only=None):
    """['file:line: text'] for every match of rx (allow(match) -> True = fine), in the tracked text files (only = a filter)."""
    out = []
    for f, t in texts.items():
        if only and not only(f): continue
        for i, ln in enumerate(t.split('\n'), 1):
            for m in re.finditer(rx, ln):
                if allow and allow(m): continue
                out.append('%s:%d: %s' % (f, i, ln.strip()[:150])); break
    return out


# Example addresses the code and docs use as placeholders ("an IP address like 192.168.0.10"). Never add a real device's
# address here; the documentation ranges 192.0.2.x / 198.51.100.x / 203.0.113.x are always fine.
PLACEHOLDERS = {'192.168.0.1', '192.168.0.10', '192.168.0.11', '192.168.0.12', '192.168.0.20', '192.168.0.255'}
REAL = set()   # addresses from this computer's H login store (below): never allowed, even when they look like an example
STORE = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~/.config'), 'OpenNova' if os.name == 'nt' else 'opennova', 'h-logins.json')
if sys.platform == 'darwin': STORE = os.path.expanduser('~/Library/Application Support/OpenNova/h-logins.json')
secrets = []
try:
    with open(STORE, encoding='utf-8') as fh: store = json.load(fh)
    for host, v in (store.items() if isinstance(store, dict) else []):
        REAL.add(str(host).split(':')[0])
        for x in (v.values() if isinstance(v, dict) else [v]):
            if isinstance(x, str) and len(x) >= 6: secrets.append(x)
except (OSError, ValueError):
    store = None
net = grep(r'\b192\.168\.(?:0|2)\.\d{1,3}\b', allow=lambda m: m.group(0) in PLACEHOLDERS and m.group(0) not in REAL)
ok(not net, 'no address of the user\'s network (the VM\'s 192.168.2.x, a 192.168.0.x that isn\'t an example placeholder)', net)
ok(not grep(r'[\w.+-]+@(?:gmail|googlemail|hotmail|outlook|icloud|yahoo)\.com\b'), 'no personal mail address',
   grep(r'[\w.+-]+@(?:gmail|googlemail|hotmail|outlook|icloud|yahoo)\.com\b'))
home = grep(r'(?i)C:[\\/]+Users[\\/]+(?!<|%|you|name|\w+\\?\.\w)[\w ]+[\\/]|/Users/(?!<|you|name)[\w.]+/|/home/(?!runner|<|you|user\b)[\w.]+/')
ok(not home, 'no path of this computer\'s user folder (C:\\Users\\<name>, /Users/<name>)', home)
# names of the user's own sample files and their folders (show names, client folders): only where they are on this computer
names = set()
for d in (os.path.join(NOVA, 'app', 'samples'), os.path.join(NOVA, 'Samples')):
    for root, dirs, fs in os.walk(d):
        for n in dirs + fs:
            stem = os.path.splitext(n)[0].strip()
            if root == d and n in ('RCFGX NCP', 'SCR'): continue                    # the folder layout itself
            if stem in ('System Config Test', 'Receiving Card'): continue           # generic words, not a show or a client
            if len(stem) >= 8 and not re.match(r'^[\w.-]*$', stem) or len(stem) >= 14: names.add(stem)
if names:
    hit = ['%s: "%s"' % (f, n) for f, t in texts.items() for n in sorted(names) if n in t]
    ok(not hit, 'no name of a show / client sample file or folder (%d names from app/samples and Samples)' % len(names), hit)
else:
    print('SKIP show / client names (app/samples and Samples are not here: CI never has them)')
if store is not None:
    leak = [f for f, t in texts.items() if any(s in t for s in secrets)]
    ok(not leak, 'none of the %d values in this computer\'s H login store appears in a tracked file (values not shown)' % len(secrets), leak)
else:
    print('SKIP H login values (no H login store on this computer: CI never has one)')

# decompiled NovaStar code: file:line citations (LCA:11512, SC:149968, TGP:22349, DataClass:71801, UsbController.cs:60), "[C]" /
# "[C, …]" / "[C LCA…" (= from the code), the word "decompiled", the research toolkit's path, a .NET namespace (Nova.LCT.X),
# accessor / analyser classes, vendor .dll / .exe.config names (libusb's and Npcap's are fine), "X's code", app.asar, LCT's
# button handlers (crystalButton_…), a quoted Class.Method (CustomTransform.GetPortNumber)
DECOMPILED = (r'\b[A-Z][A-Za-z0-9]{1,15}:\d{3,}\b|\b(?:LCA|SC|TGP|DC|NL|HFM|S660|LSC):\s?\d+|\bS660:|\w\.cs\b(?::\d+)?'
              r'|\[C(?:\]|[,;:]\s*[A-Z]|\s+[A-Za-z]{3,})|(?i:\bdecompil\w*)|tools[\\/]+re[\\/]|\bapp\.asar\b'
              r'|\b(?:NovaLCT|LCT|VMP|Unico|NeoController)[\'’]s (?:own )?code\b|\bNova\.[A-Z]\w*\.[A-Z]|\b[A-Z]\w*(?:Accessor|Analyser)\w*\b'
              r'|\b(?!libusb|wpcap)[A-Za-z_][\w.]*\.dll\b|\b\w+\.exe\.config\b|crystalButton_\w+'
              r'|(?<![.$])\b[A-Z][a-z]\w*\.(?:Get|Set|Send|Read|Is|Has|Write|Load|Save|Convert|Update|Copy)[A-Z]\w*')   # Class.Method
DECOMPILED_ENFORCED = True        # 2026-10-28: every citation moved to docs/CODE_SOURCES.md (private, not tracked)
DECOMPILED_KNOWN = set()          # files allowed to cite while not enforced (none left)
dec = grep(DECOMPILED, only=lambda f: f not in ('tools/test_repo_hygiene.py', 'docs/TESTING.md'))   # these two describe the rule
by_file = {}
for d in dec: by_file.setdefault(d.split(':', 1)[0], []).append(d)
new = sorted(set(by_file) - DECOMPILED_KNOWN)
if not dec:
    ok(True, 'no citations of decompiled NovaStar code' + ('' if DECOMPILED_ENFORCED else ' (set DECOMPILED_ENFORCED = True now)'))
elif DECOMPILED_ENFORCED:
    ok(False, 'no citations of decompiled NovaStar code (%d lines in %d files)' % (len(dec), len(by_file)), dec)
else:
    ok(not new, 'no NEW file citing decompiled NovaStar code (outside the %d known ones)' % len(DECOMPILED_KNOWN), [x for f in new for x in by_file[f]])
    print('SKIP citations of decompiled NovaStar code: %d lines in %d files still to clean (not enforced yet: DECOMPILED_ENFORCED)' % (len(dec), len(by_file)))
    for f in sorted(by_file):
        print('XFAIL %s: %d' % (f, len(by_file[f])))
        for x in by_file[f]: print('        ' + x)

# names of the user's recordings / captures and the research tool that compares them: a comment says in plain words what was
# seen where ("NovaLCT's Send to the real H5, 2026-10-11"); only the tests that open a private recording by name (and SKIP
# without it) may name it
RECORDINGS = (r'\b[a-z][a-z0-9]*(?:_[a-z0-9]+)*_20\d{6}_\d{6}\b|\b(?:redund|hotbackup|color|workmode|lct)_h\d+x\d+\b|\blct-[A-Za-z]+\.pcapng\b'
              r'|\bh-webui\.pcapng\b|OpenNova-20\d{6}[\\/]|FakeProcessor[\\/]+captures|\bcompare_send\.py\b')
recs = grep(RECORDINGS, only=lambda f: not f.startswith('tools/test_') and f != 'docs/TESTING.md')
ok(not recs, 'no names of the user\'s recordings / captures outside the tests that open them', recs)

# ------------------------------------------------------------------ everything the app loads is in the repository
need = {}   # path -> who needs it


def want(path, who):
    path = os.path.normpath(path).replace(os.sep, '/')
    need.setdefault(path, who)


def css_refs(rel):
    """want() every @import / url() of a stylesheet, and follow the imported ones."""
    p = os.path.join(NOVA, rel)
    if not os.path.isfile(p): return
    t = open(p, encoding='utf-8').read()
    for m in re.finditer(r'''url\(\s*['"]?([^'")]+)['"]?\s*\)''', t):
        u = m.group(1)
        if u.startswith(('data:', 'http:', 'https:', '#')): continue
        ref = os.path.join(os.path.dirname(rel), u.split('?')[0].split('#')[0])
        if os.path.normpath(ref).replace(os.sep, '/') not in need:
            want(ref, rel)
            if ref.endswith('.css'): css_refs(os.path.normpath(ref).replace(os.sep, '/'))


html = open(os.path.join(NOVA, 'app', 'index.html'), encoding='utf-8').read()
for m in re.finditer(r'''<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"'#?]+)''', html):
    u = m.group(1)
    if u.startswith(('data:', 'http:', 'https:')) or u.endswith('/'): continue   # "looks/' + n + '.css": the looks, below
    want('app/' + u, 'app/index.html')
    if u.endswith('.css'): css_refs('app/' + u)
looks = re.search(r'var L = \{([^}]*)\}', html)
for n in re.findall(r'(\w+)\s*:', looks.group(1) if looks else ''):          # the try-on looks (document.write)
    want('app/looks/%s.css' % n, 'app/index.html (looks)'); css_refs('app/looks/%s.css' % n)
want('app/fonts/fonts.css', 'the app\'s fonts'); css_refs('app/fonts/fonts.css')
for f in ('LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE'): want(f, 'the licence (MIT OR Apache-2.0)')
for f in ('DISCLAIMER.md', 'CONTRIBUTING.md', 'SECURITY.md', 'ROADMAP.md', '.github/pull_request_template.md', '.github/release-notes.md',
          '.github/ISSUE_TEMPLATE/bug.yml', '.github/ISSUE_TEMPLATE/feature.yml', '.github/ISSUE_TEMPLATE/config.yml'):
    want(f, 'the GitHub page (README, issue forms, pull request and release templates)')
for f in [f for f in files if f.endswith('.md') and (f.count('/') == 0 or f.startswith('.github/'))]:   # their local links and pictures
    for m in re.finditer(r'''\]\(\s*<?([^)\s>]+)|\b(?:src|href)=["']([^"']+)''', texts.get(f, '')):
        u = (m.group(1) or m.group(2)).split('#')[0].split('?')[0]
        if u and not re.match(r'^[a-z][\w+.-]*:', u): want(os.path.join(os.path.dirname(f), u), f + ' (a link)')
want('tools/alpha_unlock.json', 'make_package.py --alpha (the shared unlock, hashes only)')
for f in sorted(os.listdir(os.path.join(NOVA, 'app', 'fonts'))):      # each bundled font family ships with its OFL text
    if f.endswith('.woff2'): want('app/fonts/OFL-%s.txt' % f.split('-')[0], 'app/fonts/' + f)
want('app/version.json', 'app-alpha.js / serve.py / alpha.py')
for f in ('opennova.py', 'app/serve.py', 'app/serve.ps1', 'tools/novalink.py', 'tools/make_package.py', 'Start Open Nova.command',
          'Start Open Nova.bat', 'start-open-nova.sh', 'README.md'):
    want(f, 'the launchers / helper')
try:   # the package lists: everything make_package.py puts into a zip
    sys.path.insert(0, HERE)
    import make_package as mp   # noqa: E402
    for f in mp.ROOT_FILES: want(f, 'make_package ROOT_FILES')
    for f in mp.APP_FILES: want('app/' + f, 'make_package APP_FILES')
    for f in mp.TOOLS: want('tools/' + f, 'make_package TOOLS')
    for f in re.findall(r"'(docs/[\w.-]+\.md)'", open(os.path.join(HERE, 'make_package.py'), encoding='utf-8').read()): want(f, 'make_package docs')
except Exception as e:  # noqa: BLE001
    ok(False, 'make_package.py imports (%s)' % e)
# the helper's own modules: every local module a tracked tools/*.py imports, except inside try / except ImportError (a test
# that leaves that part out when a private research module isn't there)
mods = {os.path.splitext(f)[0] for f in os.listdir(HERE) if f.endswith('.py')}


def imported(node):
    if isinstance(node, ast.Import): return [a.name.split('.')[0] for a in node.names]
    if isinstance(node, ast.ImportFrom) and node.module and not node.level: return [node.module.split('.')[0]]
    return []


for f in [f for f in files if f.startswith('tools/') and f.endswith('.py')]:
    try: tree = ast.parse(texts.get(f, ''))
    except SyntaxError: continue
    optional = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Try) and any(isinstance(h.type, ast.Name) and h.type.id in ('ImportError', 'ModuleNotFoundError') for h in node.handlers):
            for b in node.body:
                for sub in ast.walk(b): optional.update(imported(sub))
    for node in ast.walk(tree):
        for n in imported(node):
            if n in mods and n not in optional: want('tools/%s.py' % n, f)
missing = ['%s (needed by %s)' % (p, w) for p, w in sorted(need.items()) if p not in files]
ok(not missing, 'every file the app, the helper and the package need is in the repository (%d checked)' % len(need), missing)
gone = ['%s (needed by %s)' % (p, w) for p, w in sorted(need.items()) if p in files and not os.path.isfile(os.path.join(NOVA, p))]
ok(not gone, 'and every one of them exists', gone)

print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
