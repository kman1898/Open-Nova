"""Tests for the project list of app/serve.py and app/serve.ps1 (the same behaviour in both): migration of an old single
project.json, save / new / open / remove / removed list / restore, the live-update events, the 410 / 409 / 403 answers, the index rebuilt from
the project files, and the monitor errors kept beside each project (/api/errors: merge, Clear, cap, events, remove / restore,
restart), and the online / offline workspaces (mode per project, migration, New / save / Remove / Restore). Each server is started on a free port with its own temporary data folder (never app/data).
    python -I tools/test_projects.py [--py-only]      (exit code 0 = all passed; serve.ps1 only where PowerShell runs)
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
import urllib.error
import urllib.request
from urllib.parse import quote

APP = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'app')
fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond:
        fails.append(what)


def free_port():
    s = socket.socket(); s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]; s.close(); return p


class Srv:
    def __init__(self, kind, data):
        self.kind, self.data, self.port = kind, data, free_port()
        if kind == 'py':
            cmd = [sys.executable, '-I', os.path.join(APP, 'serve.py'), str(self.port), '--local-only', '--data-dir', data, '--helper-port', '1']
        else:
            cmd = ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', os.path.join(APP, 'serve.ps1'), str(self.port),
                   '-LocalOnly', '-DataDir', data, '-HelperPort', '1']
        self.p = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.base = 'http://127.0.0.1:%d/' % self.port
        for _ in range(150):
            try:
                urllib.request.urlopen(self.base + 'api/projects', timeout=2).read(); return
            except (urllib.error.URLError, OSError):
                time.sleep(0.1)
        raise SystemExit('%s server did not start' % kind)

    def stop(self):
        self.p.kill(); self.p.wait()

    def req(self, method, path, body=None, headers=None, timeout=10):
        r = urllib.request.Request(self.base + path, data=body, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(r, timeout=timeout) as res: return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def listing(self):
        return json.loads(self.req('GET', 'api/projects')[2])


class Events:
    """Collects the data: lines of /api/events in a thread."""
    def __init__(self, srv):
        self.got, self.res = [], urllib.request.urlopen(srv.base + 'api/events', timeout=30)
        threading.Thread(target=self.run, daemon=True).start()
        time.sleep(0.3)

    def run(self):
        try:
            for raw in self.res:
                l = raw.decode('utf-8').strip()
                if l.startswith('data: '): self.got.append(json.loads(l[6:]))
        except (OSError, ValueError):
            pass

    def wait(self, pred, what):
        for _ in range(50):
            if any(pred(m) for m in self.got): return ok(True, what)
            time.sleep(0.1)
        ok(False, what + ' (got %r)' % self.got[-3:])


def proj(name, extra=0):
    return json.dumps({'version': 1, 'name': name, 'screens': [], 'panels': [], 'n': extra}).encode('utf-8')


def rec(t, ended=None):          # a kept monitor error as app-health.js sends it
    return {'key': 'k', 'dev': 'd1', 'card': 0, 'port': 0, 'index': 1, 'kind': 'bit errors', 'text': 'bit errors (4)', 'level': 'warning', 't': t, 'ended': ended, 'n': 1}


def post_errors(s, pid, change, hdr=None):
    return s.req('POST', 'api/errors' + ('?project=' + pid if pid else ''), json.dumps(change).encode('utf-8'), hdr)


def run(kind):
    print('--- serve.%s' % ('py' if kind == 'py' else 'ps1'))
    tmp = tempfile.mkdtemp(prefix='on_projects_')
    try:
        d1 = os.path.join(tmp, 'legacy'); os.makedirs(d1)
        with open(os.path.join(d1, 'project.json'), 'wb') as f: f.write(proj('Legacy show'))
        with open(os.path.join(d1, 'project.rev'), 'w') as f: f.write('7')
        s = Srv(kind, d1)
        try:
            st, h, b = s.req('GET', 'api/project')
            id1 = h.get('X-Project', '')
            ok(st == 200 and json.loads(b)['name'] == 'Legacy show' and h.get('X-Rev') == '7' and len(id1) == 8, 'migration: the old project.json is the current project, rev kept')
            ok(not os.path.exists(os.path.join(d1, 'project.json')) and os.path.exists(os.path.join(d1, 'projects', id1 + '.json')), 'migration: file moved into projects/')
            L = s.listing()
            ok(L['current'] == id1 and [p['name'] for p in L['projects']] == ['Legacy show'] and L['projects'][0]['rev'] == 7, 'listing after migration')
            ev = Events(s)
            st, h, b = s.req('PUT', 'api/project', proj('Bühne 1'), {'X-Client': 'c1', 'X-Project': id1, 'X-Project-Name': quote('Bühne 1')})
            ok(st == 200 and h.get('X-Rev') == '8' and h.get('X-Project') == id1, 'save: rev 8')
            ok(s.listing()['projects'][0]['name'] == 'Bühne 1', 'save: the name (UTF-8) reaches the index')
            ev.wait(lambda m: m.get('rev') == 8 and m.get('project') == id1 and m.get('from') == 'c1', 'save event names its project')
            # monitor errors kept until the user's Clear: per project, beside it (never in it), merged per key, capped
            st, h, b = s.req('GET', 'api/errors')
            e = json.loads(b)
            ok(st == 200 and e['project'] == id1 and e['rev'] == 0 and e['held'] == {} and e['gone'] == {}, 'errors: none yet for the current project')
            st, h, b = post_errors(s, id1, {'held': {'a': rec(1), 'b': rec(2, 5)}, 'gone': {'g': 10}, 'base': {'d1|0|0|1': {'bitErrors': 4}}},
                                   {'X-Client': 'c1', 'Content-Type': 'application/json'})
            r = json.loads(b)
            ok(st == 200 and r['ok'] and r['rev'] == 1 and r['held'] == 2 and r['project'] == id1, 'errors: two records kept (%s)' % b)
            ok(os.path.exists(os.path.join(d1, 'projects', id1 + '.errors.json')), 'errors: stored in projects/<id>.errors.json')
            ev.wait(lambda m: m.get('errors') == 1 and m.get('project') == id1 and m.get('from') == 'c1', 'errors: event names its project and sender')
            post_errors(s, id1, {'held': {'a': None, 'b': rec(2, 6)}, 'gone': {'g': 3}}, {'X-Client': 'c2'})
            e = json.loads(s.req('GET', 'api/errors?project=' + id1)[2])
            ok(sorted(e['held']) == ['b'] and e['held']['b']['ended'] == 6 and e['held']['b']['text'] == 'bit errors (4)' and e['gone'] == {'g': 10} and
               e['base'] == {'d1|0|0|1': {'bitErrors': 4}} and e['rev'] == 2, 'errors: Clear (null) removes one, the other updated, gone keeps the newest time, base kept')
            st, h, b = s.req('GET', 'api/project')
            ok(h.get('X-Rev') == '8' and 'held' not in json.loads(b), 'errors: the project itself is untouched (still rev 8)')
            ok(post_errors(s, '', {}, {'Origin': 'http://evil.example'})[0] == 403, 'errors: from another site: 403')
            ok(s.req('POST', 'api/errors', b'[1]')[0] == 400 and s.req('POST', 'api/errors', b'nope')[0] == 400, 'errors: not a JSON object: 400')
            ok(post_errors(s, 'nope', {})[0] == 410 and s.req('GET', 'api/errors?project=nope')[0] == 404, 'errors: unknown project: 410 / 404')
            # the Layout canvas's content-preview picture per project and screen, beside it (never in it): /api/preview
            jpg = b'\xff\xd8\xff\xe0' + bytes(range(256)) * 4
            st, h, b = s.req('PUT', 'api/preview?project=%s&screen=L1' % id1, jpg, {'X-Client': 'c1', 'Content-Type': 'image/jpeg'})
            ok(st == 200 and json.loads(b) == {'ok': True, 'project': id1, 'screen': 'L1', 'bytes': len(jpg)}, 'preview: kept (%s)' % b[:80])
            ok(os.path.exists(os.path.join(d1, 'projects', id1 + '.preview.L1.jpg')), 'preview: stored as projects/<id>.preview.<screen>.jpg')
            ev.wait(lambda m: m.get('preview') == 'L1' and m.get('project') == id1 and m.get('from') == 'c1', 'preview: event names the screen, project and sender')
            st, h, b = s.req('GET', 'api/preview?project=%s&screen=L1' % id1)
            ok(st == 200 and b == jpg and h.get('Content-Type', '').startswith('image/jpeg'), 'preview: served back as image/jpeg')
            ok(s.req('GET', 'api/preview?project=%s&screen=L2' % id1)[0] == 404 and s.req('GET', 'api/preview?project=nope&screen=L1')[0] == 404, 'preview: none / unknown project: 404')
            ok(s.req('PUT', 'api/preview?project=%s&screen=L1' % id1, b'not a jpeg')[0] == 400, 'preview: not a JPEG: 400')
            ok(s.req('PUT', 'api/preview?project=%s&screen=L1' % id1, jpg, {'Origin': 'http://evil.example'})[0] == 403, 'preview: from another site: 403')
            ok(s.req('GET', 'api/project')[1].get('X-Rev') == '8', 'preview: the project itself is untouched (still rev 8)')
            many = dict(('e%03d' % i, rec(i, 1000 + i)) for i in range(510)); many['open1'] = rec(1)
            post_errors(s, id1, {'held': many, 'gone': dict(('g%04d' % i, i + 100) for i in range(1005))})
            e = json.loads(s.req('GET', 'api/errors?project=' + id1)[2])
            ended = [k for k, v in e['held'].items() if v.get('ended')]
            ok(len(ended) == 500 and 'open1' in e['held'] and 'b' not in e['held'] and 'e009' not in e['held'] and 'e010' in e['held'] and 'e509' in e['held'],
               'errors: cap keeps every open error and the newest 500 ended (%d ended)' % len(ended))
            ok(len(e['gone']) == 1000 and 'g' not in e['gone'] and 'g0004' not in e['gone'] and 'g0005' in e['gone'], 'errors: the newest 1000 gone times kept (%d)' % len(e['gone']))
            st, h, b = s.req('POST', 'api/projects/new?name=' + quote('Second'), proj('Second'), {'X-Client': 'c2', 'Content-Type': 'application/json'})
            r = json.loads(b); id2 = r.get('id')
            ok(st == 200 and r['ok'] and r['current'] == id2 and id2 != id1 and r['rev'] == 1, 'new: created and current')
            ev.wait(lambda m: m.get('switch') == id2 and m.get('from') == 'c2', 'new: switch event')
            st, h, b = s.req('GET', 'api/project')
            ok(json.loads(b)['name'] == 'Second' and h.get('X-Project') == id2 and h.get('X-Rev') == '1', 'GET serves the new current project')
            st, h, b = s.req('PUT', 'api/project', proj('Bühne 1', 2), {'X-Client': 'c1', 'X-Project': id1})
            ok(st == 200 and h.get('X-Project') == id1 and h.get('X-Rev') == '9', 'late save of the old project lands in it')
            st, h, b = s.req('GET', 'api/project')
            ok(json.loads(b)['name'] == 'Second', '... and does not touch the current one')
            st, h, b = s.req('POST', 'api/projects/open?id=' + id1, b'', {'X-Client': 'c2'})
            ok(st == 200 and json.loads(b)['current'] == id1, 'open: switches')
            ev.wait(lambda m: m.get('switch') == id1 and m.get('rev') == 9, 'open: switch event with its rev')
            ok(s.req('POST', 'api/projects/open?id=nope', b'')[0] == 404, 'open unknown: 404')
            ok(s.req('POST', 'api/projects/open?id=' + id2, b'', {'Origin': 'http://evil.example'})[0] == 403, 'other site: 403')
            st, h, b = s.req('POST', 'api/projects/remove?id=' + id1, b'', {'X-Client': 'c2'})
            ok(st == 200 and json.loads(b)['current'] == id2, 'remove current: the other one becomes current')
            rem = os.path.join(d1, 'projects', 'removed')
            ok(sorted(os.listdir(rem)) == sorted(['B_hne 1_%s.json' % id1, 'B_hne 1_%s.rev' % id1, 'B_hne 1_%s.errors' % id1, 'B_hne 1_%s.preview.L1.jpg' % id1]),
               'remove: files (and its kept errors and preview pictures) moved to removed/ (%s)' % os.listdir(rem))
            ok([p['id'] for p in s.listing()['projects']] == [id2], 'remove: gone from the list')
            ok(s.req('POST', 'api/projects/remove?id=' + id2, b'')[0] == 409, 'remove the only project: 409')
            st, h, b = s.req('PUT', 'api/project', proj('x'), {'X-Project': id1})
            ok(st == 410 and h.get('X-Project') == id2, 'save to a removed project: 410')
            st, h, b = s.req('PUT', 'api/project', proj('Second', 3), {'X-Client': 'old'})
            ok(st == 200 and h.get('X-Project') == id2 and h.get('X-Rev') == '2', 'save without X-Project goes to the current one')
            ok(s.req('POST', 'api/projects/new', b'not json')[0] == 400, 'new without a JSON body: 400')
            R = json.loads(s.req('GET', 'api/projects/removed')[2])['removed']
            ok([(r['file'], r['id'], r['name']) for r in R] == [('B_hne 1_' + id1, id1, 'Bühne 1')], 'removed: listed with its name (%r)' % R)
            ok(s.req('POST', 'api/projects/restore?file=' + quote('../index'), b'')[0] == 404, 'restore outside removed/: 404')
            ok(s.req('POST', 'api/projects/restore?file=nope_12345678', b'')[0] == 404, 'restore unknown: 404')
            ok(s.req('POST', 'api/projects/restore?file=' + quote(R[0]['file']), b'', {'Origin': 'http://evil.example'})[0] == 403, 'restore from another site: 403')
            st, h, b = s.req('POST', 'api/projects/restore?file=' + quote(R[0]['file']), b'', {'X-Client': 'c3'})
            r = json.loads(b)
            ok(st == 200 and r['id'] == id1 and r['current'] == id1 and r['rev'] == 9, 'restore: back with its old id and rev, current')
            ev.wait(lambda m: m.get('switch') == id1 and m.get('from') == 'c3', 'restore: switch event')
            ok(os.listdir(rem) == [] and os.path.exists(os.path.join(d1, 'projects', id1 + '.json')), 'restore: files moved back')
            ok(len(json.loads(s.req('GET', 'api/errors?project=' + id1)[2])['held']) == 501, 'restore: its kept errors are back')
            ok(s.req('GET', 'api/preview?project=%s&screen=L1' % id1)[2] == jpg, 'restore: its preview picture is back')
            st, h, b = s.req('GET', 'api/project')
            ok(json.loads(b)['n'] == 2 and h.get('X-Project') == id1, 'restore: its content is served')
            ok(sorted(p['name'] for p in s.listing()['projects']) == ['Bühne 1', 'Second'], 'restore: listed again')
            ok(s.req('POST', 'api/projects/remove?id=' + id1, b'')[0] == 200 and len(os.listdir(rem)) == 4, 'remove again after a restore')
            time.sleep(0.05)
            id3 = json.loads(s.req('POST', 'api/projects/new?name=Third', proj('Third'))[2])['id']
            s.req('POST', 'api/projects/remove?id=' + id3, b'')
            R = json.loads(s.req('GET', 'api/projects/removed')[2])['removed']
            ok([r['name'] for r in R] == ['Third', 'Bühne 1'], 'removed: newest first (%r)' % [r['name'] for r in R])
            os.replace(os.path.join(rem, 'Third_%s.json' % id3), os.path.join(tmp, 'third.json'))   # out of the way of the checks below
            os.replace(os.path.join(rem, 'Third_%s.rev' % id3), os.path.join(tmp, 'third.rev'))
            post_errors(s, id2, {'held': {'x': rec(7)}})
        finally:
            s.stop()
        # restart: an orphan project file is found, an index entry without a file is dropped, and a lost index is rebuilt
        with open(os.path.join(d1, 'projects', 'abcd1234.json'), 'wb') as f: f.write(proj('Copied in'))
        s = Srv(kind, d1)
        try:
            L = s.listing()
            ok(L['current'] == id2 and sorted(p['name'] for p in L['projects']) == ['Copied in', 'Second'], 'restart: orphan file added, current kept')
            e = json.loads(s.req('GET', 'api/errors')[2])
            ok(e['project'] == id2 and list(e['held']) == ['x'] and e['rev'] == 1, 'restart: the kept errors survive (and their file is no project)')
        finally:
            s.stop()
        shutil.move(os.path.join(d1, 'projects', 'index.json'), os.path.join(tmp, 'index.bak'))
        s = Srv(kind, d1)
        try:
            L = s.listing()
            ok(sorted(p['name'] for p in L['projects']) == ['Copied in', 'Second'] and L['current'] in (id2, 'abcd1234'), 'lost index: rebuilt from the files')
            ok(s.req('GET', 'api/project')[0] == 200, 'lost index: a current project is served')
        finally:
            s.stop()
        # empty data folder: nothing yet, the first save creates the first project
        d2 = os.path.join(tmp, 'empty'); os.makedirs(d2)
        s = Srv(kind, d2)
        try:
            st, h, b = s.req('GET', 'api/project')
            ok(st == 404 and h.get('X-Project', '') == '' and h.get('X-Rev') == '0', 'empty: 404, no current')
            st, h, b = s.req('PUT', 'api/project', proj('First'), {'X-Client': 'c', 'X-Project-Name': 'First'})
            pid = h.get('X-Project', '')
            ok(st == 200 and len(pid) == 8 and h.get('X-Rev') == '1', 'empty: the first save creates a project')
            L = s.listing()
            ok(L['current'] == pid and [p['name'] for p in L['projects']] == ['First'], 'empty: listed and current')
        finally:
            s.stop()
        workspaces(kind, tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def wproj(name, devices=None, mode=None):
    o = {'version': 1, 'name': name, 'screens': [], 'panels': [], 'devices': devices or []}
    if mode: o['mode'] = mode
    return json.dumps(o).encode('utf-8')


LINKED = [{'id': 'd1', 'model': 'h2', 'hw': {'kind': 'lct', 'host': '192.0.2.9', 'port': 5200}}]
UNLINKED = [{'id': 'd1', 'model': 'mctrl4k'}]
SIMULATED = [{'id': 'd1', 'model': 'mctrl4k', 'hw': {'kind': 'offline', 'host': 'simulated'}}]


def workspaces(kind, tmp):
    # Online / offline workspaces (as VMP's Online Project / Offline Project): every project has a mode in the list; old
    # projects get it from their content; saves and New carry it; Remove picks the next one in the same workspace; the
    # removed list and Restore keep it; the kept errors stay with their project whatever is open.
    d = os.path.join(tmp, 'ws'); pd = os.path.join(d, 'projects'); os.makedirs(pd)
    files = {'aaaa0001': wproj('Linked', LINKED), 'aaaa0002': wproj('Designed', UNLINKED), 'aaaa0003': wproj('Empty'),
             'aaaa0004': wproj('Marked offline', LINKED, 'offline'), 'aaaa0005': wproj('Simulated', SIMULATED)}
    for k, v in files.items():
        with open(os.path.join(pd, k + '.json'), 'wb') as f: f.write(v)
    with open(os.path.join(pd, 'index.json'), 'w', encoding='utf-8') as f:   # an index of before the workspaces (no "mode")
        json.dump({'current': 'aaaa0001', 'projects': [{'id': k, 'name': k, 'created': 1, 'opened': i + 1} for i, k in enumerate(sorted(files))]}, f)
    s = Srv(kind, d)
    try:
        L = s.listing(); M = dict((p['id'], p.get('mode')) for p in L['projects'])
        ok(M == {'aaaa0001': 'online', 'aaaa0002': 'offline', 'aaaa0003': 'online', 'aaaa0004': 'offline', 'aaaa0005': 'offline'},
           'workspace: old projects get online / offline from their content (%r)' % M)
        with open(os.path.join(pd, 'index.json'), encoding='utf-8-sig') as f: I = json.load(f)
        ok(all(p.get('mode') in ('online', 'offline') for p in I['projects']), 'workspace: written into the index')
        st, h, b = s.req('PUT', 'api/project', wproj('Empty', UNLINKED), {'X-Client': 'c', 'X-Project': 'aaaa0003', 'X-Project-Mode': 'offline'})
        ok(st == 200 and dict((p['id'], p['mode']) for p in s.listing()['projects'])['aaaa0003'] == 'offline', 'workspace: a save with X-Project-Mode moves it')
        s.req('PUT', 'api/project', wproj('Empty', LINKED), {'X-Client': 'c', 'X-Project': 'aaaa0003'})
        ok(dict((p['id'], p['mode']) for p in s.listing()['projects'])['aaaa0003'] == 'offline', 'workspace: a save without it keeps the workspace')
        s.req('PUT', 'api/project', wproj('Empty'), {'X-Client': 'c', 'X-Project': 'aaaa0003', 'X-Project-Mode': 'sideways'})
        ok(dict((p['id'], p['mode']) for p in s.listing()['projects'])['aaaa0003'] == 'offline', 'workspace: an unknown mode is ignored')
        st, h, b = s.req('POST', 'api/projects/new?name=Q&mode=offline', wproj('Q'), {'X-Client': 'c'})
        q = json.loads(b)['id']
        st, h, b = s.req('POST', 'api/projects/new?name=Off', wproj('Off', mode='offline'), {'X-Client': 'c'})   # as the app makes one
        off = json.loads(b)['id']
        st, h, b = s.req('POST', 'api/projects/new?name=On', wproj('On', LINKED), {'X-Client': 'c'})
        on = json.loads(b)['id']
        M = dict((p['id'], p['mode']) for p in s.listing()['projects'])
        ok(M[q] == 'offline' and M[off] == 'offline' and M[on] == 'online', 'workspace: New takes ?mode=, else the body')
        # errors kept for the offline project while an online one is open: they stay with it
        post_errors(s, off, {'held': {'w': rec(3)}}, {'X-Client': 'c'})
        st, h, b = s.req('GET', 'api/errors?project=' + off)
        ok(s.listing()['current'] == on and st == 200 and list(json.loads(b)['held']) == ['w'], 'workspace: the offline project keeps its errors while an online one is open')
        # Remove the open offline project: the next one is the most recently opened OFFLINE one, not the newer online one
        s.req('POST', 'api/projects/open?id=aaaa0002', b'', {'X-Client': 'c'}); time.sleep(0.02)
        s.req('POST', 'api/projects/open?id=aaaa0001', b'', {'X-Client': 'c'}); time.sleep(0.02)
        s.req('POST', 'api/projects/open?id=' + off, b'', {'X-Client': 'c'})
        st, h, b = s.req('POST', 'api/projects/remove?id=' + off, b'', {'X-Client': 'c'})
        ok(st == 200 and json.loads(b)['current'] == 'aaaa0002', 'workspace: Remove opens the last-used project of the same workspace (%s)' % b)
        R = json.loads(s.req('GET', 'api/projects/removed')[2])['removed']
        ok([(r['id'], r.get('mode')) for r in R] == [(off, 'offline')], 'workspace: the removed list names the workspace (%r)' % R)
        st, h, b = s.req('POST', 'api/projects/restore?file=' + quote(R[0]['file']), b'', {'X-Client': 'c'})
        M = dict((p['id'], p['mode']) for p in s.listing()['projects'])
        ok(st == 200 and M.get(off) == 'offline', 'workspace: Restore keeps it offline')
        ok(list(json.loads(s.req('GET', 'api/errors?project=' + off)[2])['held']) == ['w'], 'workspace: its errors came back with it')
    finally:
        s.stop()
    s = Srv(kind, d)
    try:
        M = dict((p['id'], p['mode']) for p in s.listing()['projects'])
        ok(M['aaaa0003'] == 'offline' and M['aaaa0001'] == 'online', 'workspace: kept over a restart')
    finally:
        s.stop()


def helper_down():
    """serve.py with no helper (port 1): Help > Report a problem still makes a .zip (tools/alpha.py run by the server), the
    alpha state answers, the download works; everything goes into temporary folders (never Downloads / diagnostics)."""
    print('--- serve.py without the helper: Report a problem')
    tmp = tempfile.mkdtemp(prefix='on_nohelper_')
    env = {'OPENNOVA_REPORT_DIR': 'reports', 'OPENNOVA_DIAG': 'diag', 'OPENNOVA_ALPHA_SETTINGS': 'alpha-settings.json',
           'OPENNOVA_HELPER_LOGS': 'hlogs', 'OPENNOVA_CONSOLE_LOG': 'console.txt'}
    old = {k: os.environ.get(k) for k in env}
    for k, v in env.items(): os.environ[k] = os.path.join(tmp, v)
    with open(os.environ['OPENNOVA_CONSOLE_LOG'], 'w', encoding='utf-8') as f: f.write("The hardware helper didn't start: it stopped with code 1\n")
    s = None
    try:
        s = Srv('py', os.path.join(tmp, 'data'))
        J = {'Content-Type': 'application/json'}
        st, h, b = s.req('POST', 'api/hw/alpha/state', b'{}', J)
        ok(st == 200 and json.loads(b).get('version') and 'not running' in json.loads(b).get('helperDown', ''), 'no helper: the server answers the alpha state, saying the helper is down')
        body = {'text': 'nothing works', 'include': {'project': True, 'recordings': True, 'logs': True, 'processors': True, 'system': True},
                'files': [{'name': 'project.json', 'text': '{"name":"Gig"}'}], 'summary': {'app': {'browser': 'TestBrowser/1'}}}
        t0 = time.time(); st, h, b = s.req('POST', 'api/hw/report', json.dumps(body).encode('utf-8'), J, timeout=180)   # This computer: netsh, tasklist …
        r = json.loads(b) if st == 200 else {}
        ok(r.get('ok') and r.get('helperDown') and os.path.dirname(r.get('path', '')) == os.environ['OPENNOVA_REPORT_DIR'], 'no helper: Report a problem still makes the .zip (%.1f s; %s %s)' % (time.time() - t0, st, b[:200] if not r.get('ok') else ''))
        if r.get('ok'):
            import zipfile
            z = zipfile.ZipFile(r['path']); T = {n.split('/', 1)[1]: z.read(n) for n in z.namelist()}; md = T['REPORT.md'].decode('utf-8')
            ok('The hardware helper was not running' in md and 'nothing works' in md and 'app/project.json' in T and '## This computer' in md
               and "didn't start" in T.get('logs/console.txt', b'').decode('utf-8'), 'no helper: REPORT.md says the helper part is missing; the app files, This computer and the start window are in it')
            z.close()
            st, h, b = s.req('GET', 'api/hw/report/download?name=' + quote(r['name']))
            ok(st == 200 and b == open(r['path'], 'rb').read(), 'no helper: Download a copy works')
        st, h, b = s.req('POST', 'api/hw/discover', b'{}', J)
        ok(st == 502 and 'not running' in json.loads(b).get('error', ''), 'no helper: other hardware calls still say the helper is not running')
    finally:
        if s: s.stop()
        for k, v in old.items():
            if v is None: os.environ.pop(k, None)
            else: os.environ[k] = v
        shutil.rmtree(tmp, ignore_errors=True)


def main(argv):
    run('py')
    helper_down()
    if '--py-only' not in argv and shutil.which('powershell.exe'): run('ps1')
    print('%d failed' % len(fails) if fails else 'all passed')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
