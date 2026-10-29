"""The CI workflows (.github/workflows) and the tests agree: every script / test / page a workflow names exists and is in the
repository, every test file is run by some job, and the jobs keep the shape docs/TESTING.md describes. A workflow that
names a file that isn't there, or a test that no job runs, passes silently on GitHub: this is the only place that sees it.
    python -I -X utf8 tools/test_workflows.py      (exit 0 = all passed)
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
NOVA = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import browser_tests   # noqa: E402
import repo_files      # noqa: E402
import run_tests       # noqa: E402

WF = os.path.join(NOVA, '.github', 'workflows')
fails = []


def ok(cond, what, lines=()):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond:
        fails.append(what)
        for ln in lines: print('      ' + ln)


def read(p):
    with open(p, encoding='utf-8') as f: return f.read()


wfs = {n: read(os.path.join(WF, n)) for n in sorted(os.listdir(WF)) if n.endswith(('.yml', '.yaml'))} if os.path.isdir(WF) else {}
ok(set(wfs) >= {'ci.yml', 'release.yml'}, 'workflows: %s' % ', '.join(wfs))
ci, rel = wfs.get('ci.yml', ''), wfs.get('release.yml', '')
tracked = repo_files.tracked()


def jobs(text):
    """{job id: its text} - the blocks under "jobs:" indented by two spaces."""
    body = text.split('\njobs:\n', 1)[-1]
    out, cur = {}, None
    for ln in body.split('\n'):
        m = re.match(r'^  ([\w-]+):\s*$', ln)
        if m: cur = m.group(1); out[cur] = ''
        elif cur: out[cur] += ln + '\n'
    return out


J = jobs(ci)
ok({'version-check', 'lint', 'lint-windows', 'test', 'browser', 'build', 'smoke'} <= set(J), 'ci.yml jobs: %s' % ', '.join(J))

# ---- every file a workflow names exists and is in the repository
named = set()
for n, t in wfs.items():
    for m in re.finditer(r'(?<![\w/.-])((?:tools|app|docs)/[\w./-]+\.(?:json|py|js|html|ps1|md))\b', t):
        named.add((n, m.group(1)))
missing = ['%s: %s' % (n, p) for n, p in sorted(named) if not os.path.isfile(os.path.join(NOVA, p))]
ok(not missing, 'every file a workflow names exists (%d named)' % len(named), missing)
if tracked is not None:
    untracked = ['%s: %s' % (n, p) for n, p in sorted(named) if p not in tracked]
    ok(not untracked, 'and is in the repository (the .gitignore whitelist lets it in)', untracked)
    for p in ('.github/workflows/ci.yml', '.github/workflows/release.yml', 'tools/run_tests.py', 'tools/browser_tests.py', 'tools/smoke_package.py'):
        ok(p in tracked, '%s is in the repository' % p)
else:
    print('SKIP whether the named files are in the repository (git is not installed)')

# ---- every test file is run by some job
on_disk = [rel for _k, rel in run_tests.tests()]
if tracked is not None:
    left = [f for f in sorted(set(f for f in os.listdir(HERE) if re.match(r'^test_\w+\.py$', f))) if repo_files.ignored('tools/' + f)]
    ok(not left, 'every tools/test_*.py here is in the repository, so CI runs it too (else whitelist it in .gitignore)', left)
    left = [f for f in tracked if (re.match(r'^tools/test_\w+\.py$', f) or re.match(r'^app/tests/\w+_test\.js$', f)) and f not in on_disk]
    ok(not left, 'run_tests.py finds every Python and node test in the repository (%d)' % len(on_disk), left)
t = J.get('test', '')
ok('tools/run_tests.py' in t and all(o in t for o in ('ubuntu-latest', 'macos-15', 'windows-latest')),
   'the test job runs tools/run_tests.py on Linux, macOS and Windows')
ok(re.search(r'python:\s*"3\.9"', t) is not None, 'and once on Python 3.9 (the oldest the app supports)')
ok(re.search(r'run_tests\.py[^\n]*--only', ci + rel) is None, 'no workflow narrows run_tests.py with --only (it would drop tests silently)')
pages = sorted(f[len('app/tests/'):] for f in (tracked or []) if re.match(r'^app/tests/[\w-]+\.html$', f)) or \
    sorted(f for f in os.listdir(os.path.join(NOVA, 'app', 'tests')) if f.endswith('.html'))
orphan = [p for p in pages if p not in browser_tests.PAGES and p not in browser_tests.MANUAL]
ok(not orphan, 'every app/tests/*.html is a browser test (browser_tests.PAGES) or a listed manual tool (MANUAL)', orphan)
gone = [p for p in list(browser_tests.PAGES) + list(browser_tests.MANUAL) if not os.path.isfile(os.path.join(NOVA, 'app', 'tests', p))]
ok(not gone, 'every page browser_tests.py lists exists', gone)
b = J.get('browser', '')
sh = re.search(r'shard:\s*\[([\d,\s]+)\]', b)
n = re.search(r'--shard \$\{\{ matrix\.shard \}\}/(\d+)', b)
shards = sorted(int(x) for x in sh.group(1).split(',')) if sh else []
ok('tools/browser_tests.py' in b and n and shards == list(range(1, int(n.group(1)) + 1)) and '--pages' not in b,
   'the browser job runs every page: shards %s of %s, no --pages filter' % (shards, n.group(1) if n else '?'))
ok('--helper' in b, 'the browser job starts the helper too (no hardware on the runners)')

# ---- packages and the smoke test
bd, sm = J.get('build', ''), J.get('smoke', '')
ok('tools/make_package.py --out' in bd and 'tools/make_package.py --alpha' in bd, 'build: make_package.py, the package and the alpha package')
ok(re.search(r'needs:\s*\[([^\]]*)\]', bd) and set(re.search(r'needs:\s*\[([^\]]*)\]', bd).group(1).replace(' ', '').split(',')) >=
   {'version-check', 'lint', 'lint-windows', 'test', 'browser'}, 'build waits for every check')
ok("github.event_name != 'pull_request'" in bd, 'build runs on pushes (main / alpha), by hand and for a release, not for pull requests')
ok('tools/smoke_package.py' in sm and all(o in sm for o in ('ubuntu-latest', 'macos-15', 'windows-latest')) and 'needs: build' in sm,
   'smoke: each package unzipped and started on Linux, macOS and Windows')
ok('secrets.' not in ci + rel, 'no workflow needs a secret (the alpha unlock is the shared one in tools/alpha_unlock.json)')

# ---- shape (as LED Raster Designer's CI)
for n, t in wfs.items():
    ok(re.search(r'^permissions:\s*\n\s+contents:\s*read', t, re.M) is not None, '%s: permissions contents: read' % n)
    loose = re.findall(r'uses:\s*([\w./-]+)(?:@(\S+))?', t)
    bad = ['%s@%s' % (a, v) for a, v in loose if not a.startswith('./') and not re.match(r'^v\d+', v or '')]
    ok(not bad, '%s: every action pinned to a major version' % n, bad)
ok(re.search(r'concurrency:\s*\n\s+group:[^\n]+\n\s+cancel-in-progress:\s*true', ci) is not None, 'ci.yml: a newer run for the same ref cancels the older one')
ok(re.search(r'tags:\s*\["v\*"\]', rel) is not None and 'uses: ./.github/workflows/ci.yml' in rel and 'workflow_call' in ci,
   'release.yml: on tags v*, runs all of ci.yml first')
ok("contains(github.ref_name, '-alpha')" in rel and "contains(github.ref_name, '-beta')" in rel and 'prerelease:' in rel,
   'release.yml: -alpha / -beta tags are pre-releases')
ok('app/version.json' in J.get('tag', '') or 'app/version.json' in rel, 'release.yml: the tag must match app/version.json')
doc = os.path.join(NOVA, 'docs', 'TESTING.md')
ok(os.path.isfile(doc) and all(x in read(doc) for x in ('run_tests.py', 'browser_tests.py', 'smoke_package.py', 'test_repo_hygiene')),
   'docs/TESTING.md explains the runners')

print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
