"""Tests for the error-prompted problem report and its hand-off (tools/alpha.py, novalink's routes): REPORT.md's "Error that
prompted this report" (time, action, message, stack, the app log and the recorded frames of the 30 s before it under the
same or nearby action ids, nothing from other actions or older), a helper bug answered as internal (the app then offers a
report) while a processor not answering is not, and Show in folder (the command per OS; the route opens the report it
names, nothing else).   python -I -X utf8 tools/test_error_report.py   (exit 0 = all passed)
Nothing here touches the real diagnostics, logs, settings or Downloads (temporary folders), and no file manager opens
(the command is caught, not run).
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zipfile

TMP = tempfile.mkdtemp(prefix='opennova_errreport_test_')
for k, v in {'OPENNOVA_DIAG': 'diag', 'OPENNOVA_VERSION_FILE': 'version.json', 'OPENNOVA_ALPHA_SETTINGS': 'alpha-settings.json',
             'OPENNOVA_REPORT_DIR': 'reports', 'OPENNOVA_HELPER_LOGS': 'logs'}.items():
    os.environ[k] = os.path.join(TMP, v)
os.environ.pop('OPENNOVA_ALPHA', None)
with open(os.environ['OPENNOVA_VERSION_FILE'], 'w', encoding='utf-8') as f:
    json.dump({'name': 'Open Nova', 'version': '0.1.0-alpha.9', 'build': '20261029-test', 'channel': 'dev', 'readOnly': False, 'unlock': None}, f)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import alpha      # noqa: E402
import wirelog    # noqa: E402
import novalink   # noqa: E402
from http.server import ThreadingHTTPServer  # noqa: E402

fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


hs = ThreadingHTTPServer(('127.0.0.1', 0), novalink.Handler); HPORT = hs.server_address[1]
threading.Thread(target=hs.serve_forever, daemon=True).start()


def post(path, body):
    r = urllib.request.Request('http://127.0.0.1:%d%s' % (HPORT, path), data=json.dumps(body).encode(), method='POST', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=20) as x: return x.status, json.loads(x.read())
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read())


try:
    # ------------------------------------------------------------------ expected failures vs helper bugs
    import unicolink
    import coexlink
    ex = [alpha.unexpected(e) for e in (novalink.LinkError('x'), novalink.LinkBusy('x'), OSError('refused'), socket.timeout('timed out'),
                                         unicolink.UnicoError('HTTP 401'), coexlink.CoexError('code 5'), KeyError('ports'), TypeError('x'), ValueError('x'))]
    ok(ex == [False] * 6 + [True] * 3, 'a processor not answering / answering with an error is expected; a KeyError / TypeError / ValueError is a bug (%s)' % ex)
    code, bug = post('/api/hw/nprj', {'data': '!!not base64!!'})
    ok(code == 500 and bug.get('internal') is True and bug.get('where') and any('File "' in x for x in bug['where']),
       'a helper bug: HTTP 500 flagged internal, with its traceback (%s)' % {k: bug.get(k) for k in ('internal', 'error')})
    code, busy = post('/api/hw/info', {'host': '127.0.0.1', 'port': 1})   # nothing listens on port 1: refused, a processor not answering
    ok(not busy.get('ok') and not busy.get('internal'), 'a processor that doesn\'t answer is not flagged internal (%s %s)' % (code, busy.get('error')))

    # ------------------------------------------------------------------ REPORT.md: the error that prompted it
    now = time.time()
    wirelog.record('mark', source='app', text='older than 30 s', act='tq1-5', t=now - 45)
    wirelog.record('tg', link='192.168.0.11:5200', dir='tx', sum='W rx S1 P1 C* 0x02000001 GlobalBrightness = C0', act='tq1-5')
    wirelog.record('tg', link='192.168.0.11:5200', dir='rx', sum='-> ok', act='tq1-6')
    wirelog.record('op', route='/api/hw/run', phase='end', ok=False, error='KeyError: ports', act='tq1-6')
    wirelog.record('tg', link='192.168.0.11:5200', dir='tx', sum='FAR AWAY FRAME', act='tq1-40')       # another action: left out
    wirelog.record('tg', link='192.168.0.11:5200', dir='tx', sum='OTHER TAB FRAME', act='zz9-6')       # another browser tab: left out
    # the browser's clock is 1 h off: its own times, and "now" when the report was asked for, line it up with the helper's
    off = -3600.0
    prompt = {'t': (now + off) * 1000, 'now': (time.time() + off) * 1000, 'act': 'tq1-6', 'acts': ['tq1-2', 'tq1-3', 'tq1-4', 'tq1-5', 'tq1-6', 'tq1-7'],
              'what': '#btnSendHdr Send', 'kind': 'error', 'path': '', 'message': "TypeError: can't read 'ports' of undefined",
              'stack': "TypeError: can't read 'ports' of undefined\n    at hwSend (app-hardware.js:364:12)\n    at HTMLButtonElement.onclick (index.html:1:1)",
              'log': ['14:03:10.100 PC 1a2b   ui_click   [tq1-6] {"id":"btnSendHdr","text":"Send"}', '14:03:10.250 PC 1a2b   client_error [tq1-6] {"message":"TypeError"}']}
    code, rep = post('/api/hw/report', {'text': 'it broke', 'include': {'project': False, 'recordings': True, 'logs': False, 'processors': False, 'system': False},
                                        'files': [], 'summary': {'app': {}}, 'prompt': prompt})
    ok(code == 200 and rep.get('ok') and rep.get('os') and rep.get('version') == '0.1.0-alpha.9', 'report made, with OS and version for the issue text (%s, %s)' % (rep.get('name'), rep.get('os')))
    z = zipfile.ZipFile(rep['path']); md = z.read(z.namelist()[0]).decode('utf-8')
    sec = md.split('## Error that prompted this report', 1)[1].split('\n## ', 1)[0] if '## Error that prompted this report' in md else ''
    ok(sec and md.index('## Error that prompted this report') < md.index('## What happened'), 'REPORT.md: "Error that prompted this report" at the top, before What happened')
    want = ['| Action | tq1-6 — #btnSendHdr Send |', "can't read 'ports' of undefined", 'at hwSend (app-hardware.js:364:12)', 'JavaScript error', '(the browser\'s clock)',
            'actions tq1-2, tq1-3', '[tq1-6] {"id":"btnSendHdr"', 'GlobalBrightness = C0', '-> ok', 'request /api/hw/run end FAILED KeyError: ports', '[action tq1-5]']
    miss = [w for w in want if w not in sec]
    ok(not miss, 'the section has time, action, kind, message, stack, the app log and the frames of the 30 s before it (missing: %s)' % (miss or 'none'))
    out = [w for w in ['older than 30 s', 'FAR AWAY FRAME', 'OTHER TAB FRAME'] if w in sec]
    ok(not out, 'records older than 30 s, of far-off actions or of another tab are left out (%s)' % (out or 'none'))
    code, rep2 = post('/api/hw/report', {'text': 'no error', 'include': {'recordings': False, 'logs': False, 'processors': False, 'system': False, 'project': False}, 'files': [], 'summary': {}})
    z2 = zipfile.ZipFile(rep2['path']); md2 = z2.read(z2.namelist()[0]).decode('utf-8')
    ok('Error that prompted' not in md2, 'a report made from the menu (no error picked) has no such section')

    # ------------------------------------------------------------------ Show in folder
    f = rep['path'], os.path.dirname(rep['path'])
    cmds = {p: (alpha.reveal_cmd(f[0], p), alpha.reveal_cmd(f[1], p)) for p in ('win32', 'darwin', 'linux')}
    ok(cmds['win32'] == (['explorer', '/select,', f[0]], ['explorer', f[1]]) and cmds['darwin'] == (['open', '-R', f[0]], ['open', f[1]]) and
       cmds['linux'] == (['xdg-open', f[1]], ['xdg-open', f[1]]), 'reveal: Explorer selects the zip, Finder reveals it, Linux opens its folder')
    ran, real = [], subprocess.Popen
    subprocess.Popen = lambda cmd, *a, **k: ran.append(cmd)
    try:
        code, r1 = post('/api/hw/alpha/reveal', {'name': rep['name']})
        code2, r2 = post('/api/hw/alpha/reveal', {'name': '../version.json'})
        code3, r3 = post('/api/hw/alpha/reveal', {'name': 'OpenNova-report-nothere.zip'})
    finally:
        subprocess.Popen = real
    ok(r1.get('ok') and r1.get('path') == rep['path'] and ran == [alpha.reveal_cmd(rep['path'])], 'the route opens the file manager on the report (%s)' % ran)
    ok(not r2.get('ok') and not r3.get('ok') and len(ran) == 1, 'only a report this helper made, by name: nothing else opens (%s / %s)' % (r2.get('error'), r3.get('error')))
finally:
    hs.shutdown(); hs.server_close()

print('%d failed' % len(fails) if fails else 'all passed')
sys.exit(1 if fails else 0)
