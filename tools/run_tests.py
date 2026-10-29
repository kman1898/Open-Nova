"""run_tests.py - run every Open Nova test from the command line and say per file whether it passed (docs/TESTING.md).

    python tools/run_tests.py [--only TEXT] [--list] [--timeout SECONDS] [--json FILE]

Runs, one after another, from the project folder (Windows, macOS, Linux; Python 3.9+, nothing to install):
  - every helper / server test   tools/test_*.py      as  python -I -X utf8 tools/test_x.py
  - every plan test (node)       app/tests/*_test.js  as  node app/tests/x_test.js
The browser pages (app/tests/*.html) need a browser: tools/browser_tests.py (CI's browser job runs them).

A test file passes when it exits 0 and printed no line starting "FAIL". It is SKIPPED when it exits 77 (everything it
checks needs private data that isn't here — recordings, captures, Samples, the fakes) and says why on a "SKIP ..." line;
a file that runs but leaves parts out prints "SKIP <what> (<why>)" for each part and still passes. Never silently: every
SKIP line is listed in the summary. Exit code: 0 = no file failed, 1 = at least one failed (or none was found).
--only TEXT runs the files whose path contains TEXT; --list only lists them; --json FILE also writes the results there.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
try: sys.stdout.reconfigure(errors='replace')   # a Windows console can't show every character the tests print
except AttributeError: pass
SKIPPED = 77                       # the exit code of a test that has nothing it can run here (as automake's)
GH = os.environ.get('GITHUB_ACTIONS') == 'true'


def tests():
    """[(kind, path relative to NOVA)] - every Python and node test, sorted."""
    out = []
    for kind, folder, rx in (('python', 'tools', r'^test_\w+\.py$'), ('node', os.path.join('app', 'tests'), r'^\w+_test\.js$')):
        d = os.path.join(NOVA, folder)
        if os.path.isdir(d):
            out += [(kind, os.path.join(folder, f).replace(os.sep, '/')) for f in sorted(os.listdir(d)) if re.match(rx, f)]
    return out


def command(kind, rel):
    if kind == 'python': return [sys.executable, '-I', '-X', 'utf8', rel]
    return [shutil.which('node') or 'node', rel]


def run_one(kind, rel, timeout):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', PYTHONIOENCODING='utf-8')
    t0 = time.time()
    try:
        p = subprocess.run(command(kind, rel), cwd=NOVA, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        code, text = p.returncode, p.stdout.decode('utf-8', 'replace')
    except subprocess.TimeoutExpired as e:
        code, text = None, (e.stdout or b'').decode('utf-8', 'replace') + '\n(timed out after %d s)' % timeout
    except OSError as e:           # node not installed, ...
        code, text = None, 'could not start: %s' % e
    lines = text.replace('\r\n', '\n').split('\n')
    fails = [ln for ln in lines if ln.startswith('FAIL')]
    skips = [ln[5:].strip() for ln in lines if ln.startswith('SKIP')]
    passes = sum(1 for ln in lines if ln.startswith('PASS'))
    if code == SKIPPED and not fails: status = 'skip'
    elif code == 0 and not fails: status = 'pass'
    else: status = 'fail'
    return {'file': rel, 'kind': kind, 'status': status, 'code': code, 'seconds': round(time.time() - t0, 1), 'passed': passes,
            'failed': fails, 'skips': skips, 'output': text}


def main(argv):
    a, only, timeout, jpath, listing = list(argv), None, 900, None, False
    while a:
        k = a.pop(0)
        if k == '--only' and a: only = a.pop(0)
        elif k == '--timeout' and a: timeout = int(a.pop(0))
        elif k == '--json' and a: jpath = a.pop(0)
        elif k == '--list': listing = True
        else: print(__doc__); return 2
    todo = [t for t in tests() if not only or only in t[1]]
    if listing:
        for kind, rel in todo: print('%-7s %s' % (kind, rel))
        return 0
    if not todo:
        print('no tests found' + (' matching %r' % only if only else '')); return 1
    print('Open Nova tests: %d files, Python %s on %s\n' % (len(todo), sys.version.split()[0], sys.platform)); sys.stdout.flush()
    res = []
    for kind, rel in todo:
        if GH: print('::group::%s' % rel)
        r = run_one(kind, rel, timeout); res.append(r)
        if GH: print(r['output']); print('::endgroup::')
        extra = ', %d part(s) skipped' % len(r['skips']) if r['skips'] and r['status'] == 'pass' else ''
        print('%-4s  %-40s %6.1f s  %d checks%s' % (r['status'].upper(), rel, r['seconds'], r['passed'], extra))
        if r['status'] == 'skip':
            for s in r['skips'] or ['(no reason given)']: print('        skipped: %s' % s)
        if r['status'] == 'fail':
            shown = r['failed'] or [ln for ln in r['output'].rstrip().split('\n')][-25:]
            print('        exit code %s' % r['code'])
            for ln in shown: print('        | ' + ln.rstrip())
            if r['failed'] and not GH:   # the end of the output too (a traceback after the FAIL lines)
                tail = r['output'].rstrip().split('\n')[-6:]
                for ln in tail: print('        . ' + ln.rstrip())
            if GH: print('::error file=%s::%s' % (rel, (r['failed'] or ['exit code %s' % r['code']])[0].replace('\n', ' ')[:300]))
        sys.stdout.flush()
    n = {s: sum(1 for r in res if r['status'] == s) for s in ('pass', 'skip', 'fail')}
    print('\n%d passed, %d skipped, %d failed (%d files, %.0f s)' % (n['pass'], n['skip'], n['fail'], len(res), sum(r['seconds'] for r in res)))
    parts = [(r['file'], s) for r in res if r['status'] == 'pass' for s in r['skips']]
    if parts:
        print('\nParts left out (private data not here):')
        for f, s in parts: print('  %s: %s' % (f, s))
    if n['fail']:
        print('\nFailed: ' + ', '.join(r['file'] for r in res if r['status'] == 'fail'))
    if jpath:
        with open(jpath, 'w', encoding='utf-8') as f:
            json.dump([{k: v for k, v in r.items() if k != 'output'} for r in res], f, indent=1)
    return 1 if n['fail'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
