"""browser_tests.py - run the app's browser test pages (app/tests/*.html) in headless Chromium (docs/TESTING.md).

    python tools/browser_tests.py [--pages a.html,b.html] [--shard K/N] [--out DIR] [--helper | --no-helper] [--timeout S]

Needs Playwright (CI: pip install playwright && playwright install chromium; the app itself never does). Starts, from
this folder, the app server (app/serve.py --local-only) and, in CI (or with --helper), the hardware helper (tools/novalink.py,
127.0.0.1 only) on free ports, every data / recording / log folder a temporary one, then opens each page and waits until it says it is done
(its title starts PASS / FAIL, or "UI sweep done"). A page fails on a line starting "FAIL", on a title FAIL, on a
script error in the page, or when it doesn't finish in time; "SKIP" lines (private fixtures not here) are listed. Every
request a page made to the helper's routes is listed too. The app searches the network as it boots, before a page can stub
it, so on a computer with real processors nearby the helper is left out (the default outside CI): those requests then get
the server's "helper not running" answer and nothing leaves the computer.
--shard K/N runs the K-th of N shares of the pages, split by their time limits (CI runs the shards as parallel jobs). Exit 0 = every page passed.
MANUAL lists the pages that are tools, not tests (they send to a processor): never run here.
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

NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
try: sys.stdout.reconfigure(errors='replace')   # a Windows console can't show every character the tests print
except AttributeError: pass
# page -> seconds it may take. ui_sweep opens the app at several widths, sizes and both themes.
PAGES = {'app_test.html': 300, 'check-modules.html': 120, 'offline_test.html': 120, 'online_test.html': 90,'save_rule_test.html': 60, 'scfg_test.html': 120, 'ui_sweep.html': 900}
MANUAL = {'hwsend_test.html': 'sends a show to a processor through the helper (manual tool)',
          'unicosend_test.html': 'sends a show to a Unico processor through the helper (manual tool)'}
DONE_JS = "() => /^(PASS|FAIL)\\b/.test(document.title) || /^UI sweep done/.test(document.title)"
HELPER_RX = re.compile(r'/api/(hw|unico|coex|rcv)/')


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


def wait_url(url, want, secs=30):
    end = time.time() + secs
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200 and want in r.read(2000).decode('utf-8', 'replace'): return True
        except OSError: pass
        time.sleep(0.3)
    return False


def stop(p):
    if p is None or p.poll() is not None: return
    p.terminate()
    try: p.wait(10)
    except subprocess.TimeoutExpired: p.kill()


def page_report(page):
    """[(kind, text)] of the result lines a test page shows (top document only; the app frame is the subject)."""
    txt = page.evaluate("() => document.body ? document.body.innerText : ''")
    return [ln.strip() for ln in txt.split('\n') if ln.strip()]


def main(argv):
    a, pages, shard, outdir, helper, headed, tmo = list(argv), None, None, None, bool(os.environ.get('CI')), False, None
    while a:
        k = a.pop(0)
        if k == '--pages' and a: pages = [p.strip() for p in a.pop(0).split(',') if p.strip()]
        elif k == '--shard' and a: shard = tuple(int(x) for x in a.pop(0).split('/'))
        elif k == '--out' and a: outdir = a.pop(0)
        elif k == '--timeout' and a: tmo = int(a.pop(0))
        elif k == '--no-helper': helper = False
        elif k == '--helper': helper = True
        elif k == '--headed': headed = True
        else: print(__doc__); return 2
    todo = pages or sorted(PAGES)
    unknown = [p for p in todo if p not in PAGES]
    if unknown: print('not a test page: %s (known: %s; manual: %s)' % (', '.join(unknown), ', '.join(sorted(PAGES)), ', '.join(sorted(MANUAL)))); return 2
    if shard:
        k, n = shard
        if not 1 <= k <= n: print('--shard K/N needs 1 <= K <= N'); return 2
        loads, mine = [0] * n, []   # heaviest page (its time limit) first onto the lightest shard: the same split in every job
        for p in sorted(todo, key=lambda p: (-PAGES[p], p)):
            i = min(range(n), key=lambda j: (loads[j], j)); loads[i] += PAGES[p]
            if i == k - 1: mine.append(p)
        todo = sorted(mine)
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print('Playwright is not installed: pip install playwright && python -m playwright install chromium'); return 2
    tmp = tempfile.mkdtemp(prefix='opennova_browser_')
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', OPENNOVA_DIAG=os.path.join(tmp, 'diag'), OPENNOVA_HELPER_LOGS=os.path.join(tmp, 'hlogs'),
               OPENNOVA_ALPHA_SETTINGS=os.path.join(tmp, 'alpha-settings.json'), OPENNOVA_REPORT_DIR=os.path.join(tmp, 'reports'),
               OPENNOVA_LIBRARY=os.path.join(tmp, 'library'), OPENNOVA_CONFIG_DIR=os.path.join(tmp, 'config'))
    port, hport = free_port(), free_port()
    hp = sp = None
    results, t_all = [], time.time()
    try:
        if helper:
            hp = subprocess.Popen([sys.executable, os.path.join(NOVA, 'tools', 'novalink.py'), 'serve', '--port', str(hport)], cwd=os.path.join(NOVA, 'tools'),
                                  env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if not wait_url('http://127.0.0.1:%d/api/hw/ping' % hport, 'novalink'): print('the helper did not start'); return 1
        sp = subprocess.Popen([sys.executable, os.path.join(NOVA, 'app', 'serve.py'), str(port), '--local-only', '--data-dir', os.path.join(tmp, 'data'),
                               '--helper-port', str(hport)], cwd=os.path.join(NOVA, 'app'), env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = 'http://127.0.0.1:%d/' % port
        if not wait_url(base + 'index.html', 'Open Nova'): print('the app server did not start'); return 1
        print('app on %s, helper %s; pages: %s\n' % (base, 'on 127.0.0.1:%d' % hport if helper else 'not started', ', '.join(todo))); sys.stdout.flush()
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not headed)
            for name in todo:
                ctx = browser.new_context(viewport={'width': 1400, 'height': 900})
                page = ctx.new_page()
                errors, calls = [], []
                page.on('pageerror', lambda e, errors=errors: errors.append(str(e)))
                ctx.on('request', lambda r, calls=calls: calls.append(r.method + ' ' + re.sub(r'^https?://[^/]+', '', r.url)) if HELPER_RX.search(r.url) else None)
                t0, status, why = time.time(), 'pass', ''
                try:
                    page.goto(base + 'tests/' + name, wait_until='load')
                    page.wait_for_function(DONE_JS, timeout=(tmo or PAGES[name]) * 1000, polling=500)
                except Exception as e:  # noqa: BLE001 - a timeout or a crash: the page failed
                    status, why = 'fail', 'did not finish: %s' % str(e).split('\n')[0][:200]
                title = page.title()
                lines = page_report(page)
                fails = [ln for ln in lines if ln.startswith('FAIL')]
                skips = [ln for ln in lines if ln.startswith('SKIP')]
                passes = sum(1 for ln in lines if ln.startswith('PASS'))
                if title.startswith('FAIL') or fails: status = 'fail'
                m = re.match(r'UI sweep done \((\d+)\)', title)
                if m and int(m.group(1)): why = '%s layout problem(s) (listed on the page)' % m.group(1)
                if errors: status = 'fail'
                secs = time.time() - t0
                print('%-4s  %-22s %6.1f s  %d checks  (%s)' % (status.upper(), name, secs, passes, title))
                for ln in fails[:40]: print('        | ' + ln[:300])
                for ln in skips: print('        skipped: ' + ln[5:].strip())
                for e in errors[:10]: print('        script error: ' + e[:300])
                if why: print('        ' + why)
                if calls:
                    uniq = sorted(set(calls))
                    print('        helper routes asked: ' + ', '.join(uniq[:20]) + (' …' if len(uniq) > 20 else ''))
                if m and int(m.group(1)) and outdir is None:
                    for ln in lines[-30:]: print('        ' + ln[:200])
                if outdir:
                    os.makedirs(outdir, exist_ok=True)
                    with open(os.path.join(outdir, name + '.txt'), 'w', encoding='utf-8') as f: f.write('\n'.join(lines))
                    if status == 'fail':
                        try: page.screenshot(path=os.path.join(outdir, name + '.png'), full_page=True)
                        except Exception: pass  # noqa: BLE001
                results.append({'page': name, 'status': status, 'seconds': round(secs, 1), 'checks': passes, 'failed': fails, 'skips': skips,
                                'errors': errors, 'helper': sorted(set(calls)), 'title': title})
                sys.stdout.flush()
                ctx.close()
            browser.close()
    finally:
        stop(sp); stop(hp)
        shutil.rmtree(tmp, ignore_errors=True)
    nf = sum(1 for r in results if r['status'] == 'fail')
    print('\n%d page(s) passed, %d failed (%.0f s)%s' % (len(results) - nf, nf, time.time() - t_all,
                                                     '; not run here (manual tools): ' + ', '.join(sorted(MANUAL)) if not pages else ''))
    if outdir:
        with open(os.path.join(outdir, 'results.json'), 'w', encoding='utf-8') as f: json.dump(results, f, indent=1)
    return 1 if nf or not results else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
