"""serve.py - Open Nova's app server for Windows, macOS and Linux (Python 3.8+, stdlib only). Same endpoints, files and
behaviour as serve.ps1 (Windows PowerShell), which stays for the existing Windows setup.

    python3 serve.py [port] [--local-only] [--bind all|localhost|<interface>] [--data-dir DIR] [--log-max-mb 20] [--helper-port 8790]

Usually started by ..\\opennova.py together with the hardware helper (tools/novalink.py).
http://localhost:port/ here, http://<this-computer's-ip>:port/ from other devices (unless --local-only).
Which networks it listens on: Settings > Network "App reachable from" (this computer's tools/netif.py settings, read at
start), or --bind: all = every interface (the default, IPv4 + IPv6), localhost = this computer only (= --local-only),
an interface name ("Ethernet 2", en7, eth0) or one of its IPv4 addresses = that network and this computer. What it listens
on is written to the settings folder (network-applied-<port>.json) for the dialog's "now" line.

Shared projects (as Unico's project list / VMP's projects): the server keeps a list of projects, one of them "current";
every browser that opens the app from this server works on the current one, and switching switches every browser.
  <DataDir>/projects/index.json   {"current":"<id>","projects":[{"id","name","created","opened","mode"}]}  (ms since 1970)
  <DataDir>/projects/<id>.json    one project; <id>.rev its revision number
  <DataDir>/projects/removed/     Remove moves a project's files here (<name>_<id>.json / .rev) - nothing is deleted
At start an old single <DataDir>/project.json (+ project.rev) becomes a project of the list (moved in, nothing lost), and
project files in projects/ the index doesn't know are added back to it.
Workspaces, as VMP's Online Project / Offline Project: every project is "online" or "offline" (its "mode", kept in the index;
the app lists only the current project's workspace). A project without one gets it from its file: its "mode" when set,
else online when a processor is linked to hardware, offline when it has processors but none linked, online when empty.

Endpoints
  GET  /<file>              static files under this folder
  GET  /api/project         the current project (404 if none yet); headers X-Rev = its revision, X-Project = its id
  PUT  /api/project         save a project (body = JSON; headers X-Client = sender id, X-Project = the project's id - the
                            current one when missing, 410 when it was removed -, X-Project-Name = its name, URL-encoded,
                            kept in the index, X-Project-Mode = online / offline, its workspace) -> 200, X-Rev, X-Project;
                            every live-update listener then gets
                            data: {"rev":n,"from":"<X-Client>","project":"<id>"}
  GET  /api/projects        {"current":"<id>","projects":[{"id","name","rev","bytes","modified","opened","mode"}]}
  POST /api/projects/new?name=N&mode=M  body = the new project (JSON; M = its workspace, else from the body) -> it becomes
                            current -> {"ok","id","current","rev"}
  POST /api/projects/open?id=X       make X current (404 unknown)
  POST /api/projects/remove?id=X     move X to removed/ (409 for the only project); the most recently opened one (of X's
                            workspace when it has another) becomes current if X was.
  GET  /api/projects/removed         {"removed":[{"file","id","name","bytes","modified","mode"}]} (projects/removed/, newest first)
  POST /api/projects/restore?file=F  move removed/F.json (+ .rev) back into the list (its old id when free) and make it
                            current (404 unknown). These four: only from the app's own page (Origin), and every
                            live-update listener gets data: {"switch":"<current id>","rev":n,"from":"<X-Client>"}
  GET  /api/errors?project=X        the monitor errors kept until the user's Clear (app-health.js), per project, beside it in
                            <id>.errors.json (not in the project: no unsaved mark, no undo) -> {"project","rev","held":{key:
                            record},"gone":{key:t},"base":{key:{...}}} (X = the current one when missing; 404 unknown)
  POST /api/errors?project=X        body {"held":{key: record | null},"gone":{key:t},"base":{key: {...} | null}} = only what
                            changed (null = cleared; gone keeps the newest time) -> {"ok","project","rev","held":n}; keeps every
                            open error and the newest 500 ended ones (1000 gone times); only from the app's own page (Origin);
                            every live-update listener gets data: {"errors":rev,"from":"<X-Client>","project":"<id>"}. 410 unknown
                            project. Remove / restore move the file with its project (removed/<name>_<id>.errors).
  GET  /api/preview?project=X&screen=L   the Layout canvas's content-preview picture of screen L (app-preview.js), a JPEG beside
                            the project (<id>.preview.<L>.jpg; never in the project, never sent to a processor) -> image/jpeg, 404 none
  PUT  /api/preview?project=X&screen=L   body = the JPEG (the app scales it to <= 2048 px; max 8 MB) -> {"ok","project","screen","bytes"};
                            only from the app's own page (Origin); every live-update listener gets data: {"preview":"<L>","project":
                            "<id>","from":"<X-Client>"}. Remove / restore move the pictures with their project.
  GET  /api/events          Server-Sent Events stream of those saves and switches (": ping" every 15 s)
  PUT  /out/<path>          test hook: write a file into app/out (this computer only, else 403)
  POST /api/log             client log batch: NDJSON (max 500 lines, 64 KB each; lines not {…} are skipped) -> 204
  GET  /api/logs?lines=N&since=MS&until=MS&q=TEXT   read the log (see serve.ps1)
  DELETE /api/logs          empty the current log file (archives kept) -> 204 (this computer only)
  POST /api/logs/reveal     open the log folder in Explorer / Finder / the file manager -> 204 (this computer only)
  *    /api/(hw|unico|coex|rcv)/…   passed to the hardware helper on 127.0.0.1:<helper-port>, only from the app's own
                            page (Origin = http://<Host>) and only with a JSON body.

Log file: <DataDir>/logs/open_nova.log, one JSON object per line, as serve.ps1 writes it; rotated over --log-max-mb
(the newest 2 archives are kept).
"""
import datetime
import json
import os
import queue
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

ROOT = os.path.realpath(os.path.dirname(os.path.abspath(__file__)))   # real path: requested files are compared with it
MAX_BODY = 64 * 1024 * 1024
LOG_TAIL = 4 * 1024 * 1024
TYPES = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
         '.md': 'text/plain; charset=utf-8', '.scr': 'application/octet-stream', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.jpg': 'image/jpeg',
         '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'}
HELPER_TIMEOUT = 15 * 60          # a Save waits for the receiving cards (up to 10 min)
HELPER_RX = re.compile(r'^api/(hw|unico|coex|rcv)/')
TS_RX = re.compile(r'^\{\s*"timestamp"\s*:\s*"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})"')
ID_RX = re.compile(r'^[a-z0-9]{1,32}$')
REMOVED_RX = re.compile(r'_([a-z0-9]{1,32})(?:_\d{8}_\d{6})?$')   # <name>_<id>[_<stamp>] in projects/removed/
REMOVED_FILE_RX = re.compile(r'^[A-Za-z0-9 _.-]{1,120}$')
ERR_ENDED_MAX, ERR_GONE_MAX = 500, 1000     # kept monitor errors: every open one + the newest 500 ended; cleared alarm-log times


def ms_now():
    return int(time.time() * 1000)


def clean_name(s):
    return re.sub(r'[\x00-\x1f\x7f]', '', s or '').strip()[:120]


def file_name(s):               # a project name as part of a file name (removed/)
    return re.sub(r'[^A-Za-z0-9 _.-]', '_', s).strip(' .')[:60].strip(' .') or 'project'


def read_int(path):
    try:
        with open(path, encoding='utf-8-sig') as f: return int(f.read().strip() or 0)
    except (OSError, ValueError): return 0


def name_in(path):              # the "name" a project file carries ('' if none / unreadable)
    return meta_in(path)[0]


def mode_of(o):                 # a project's workspace (see the top): its "mode", else from its processors' links
    if not isinstance(o, dict): return 'online'
    if o.get('mode') in ('online', 'offline'): return o['mode']
    devs = [d for d in (o.get('devices') if isinstance(o.get('devices'), list) else []) if isinstance(d, dict)]
    if any(isinstance(d.get('hw'), dict) and d['hw'].get('kind') != 'offline' for d in devs): return 'online'
    return 'offline' if devs else 'online'


def mode_in(data):              # the workspace of a project sent as bytes
    try: return mode_of(json.loads(data.decode('utf-8-sig')))
    except ValueError: return 'online'


def meta_in(path):              # (name, workspace) of a project file (('', 'online') if unreadable)
    try:
        with open(path, encoding='utf-8-sig') as f: o = json.load(f)
    except (OSError, ValueError): return '', 'online'
    return (clean_name(o['name']) if isinstance(o, dict) and isinstance(o.get('name'), str) else ''), mode_of(o)


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def errors_merge(doc, ch):
    # One browser's changes into the kept errors: records set / cleared (null) by key, cleared alarm-log times (newest
    # wins), counter baselines; then the cap (every open error, the newest ended ones). Returns [set, cleared].
    n = [0, 0]
    for part in ('held', 'base'):
        for k, v in (ch.get(part) if isinstance(ch.get(part), dict) else {}).items():
            if len(k) > 400: continue
            if isinstance(v, dict): doc[part][k] = v; n[0] += part == 'held'
            elif v is None and k in doc[part]: del doc[part][k]; n[1] += part == 'held'
    for k, v in (ch.get('gone') if isinstance(ch.get('gone'), dict) else {}).items():
        if num(v) and len(k) <= 400: doc['gone'][k] = max(num(doc['gone'].get(k)), v)
    ended = [k for k, r in doc['held'].items() if isinstance(r, dict) and num(r.get('ended'))]
    if len(ended) > ERR_ENDED_MAX:
        for k in sorted(ended, key=lambda k: -num(doc['held'][k].get('ended')))[ERR_ENDED_MAX:]: del doc['held'][k]
    if len(doc['gone']) > ERR_GONE_MAX:
        for k in sorted(doc['gone'], key=lambda k: -num(doc['gone'][k]))[ERR_GONE_MAX:]: del doc['gone'][k]
    doc['rev'] += 1
    return n


class Server:
    def __init__(self, port, data_dir, log_max_mb, helper_port, local_only):
        self.port, self.helper_port, self.local_only = port, helper_port, local_only
        self.data = os.path.abspath(data_dir or os.path.join(ROOT, 'data'))
        os.makedirs(self.data, exist_ok=True)
        self.log_dir = os.path.join(self.data, 'logs'); os.makedirs(self.log_dir, exist_ok=True)
        self.log_file = os.path.join(self.log_dir, 'open_nova.log')
        self.log_max = int(log_max_mb * 1024 * 1024)
        self.log_lock, self.proj_lock, self.sse_lock = threading.Lock(), threading.Lock(), threading.Lock()
        self.sse = []                 # one queue per open live-update connection
        self.pdir = os.path.join(self.data, 'projects'); self.idxf = os.path.join(self.pdir, 'index.json')
        self.idx, self.revs = {'current': '', 'projects': []}, {}
        self.load_projects()

    # ---------------------------------------------------------------- project list
    def pfile(self, pid, ext='.json'): return os.path.join(self.pdir, pid + ext)

    def entry(self, pid):
        for p in self.idx['projects']:
            if p['id'] == pid: return p
        return None

    def new_id(self):
        while True:
            pid = os.urandom(4).hex()
            if not self.entry(pid) and not os.path.exists(self.pfile(pid)): return pid

    def add_entry(self, pid, name, mode='online'):
        n = ms_now(); e = {'id': pid, 'name': name or 'Project %d' % (len(self.idx['projects']) + 1), 'created': n, 'opened': n, 'mode': mode}
        self.idx['projects'].append(e); return e

    def latest(self, mode=None):        # the most recently opened project's id (of that workspace when it has one; '' if none)
        ps = [p for p in self.idx['projects'] if p['mode'] == mode] or self.idx['projects']
        return max(ps, key=lambda p: p['opened'])['id'] if ps else ''

    def write_idx(self):
        tmp = self.idxf + '.tmp'
        with open(tmp, 'w', encoding='utf-8', newline='\n') as f: json.dump(self.idx, f, ensure_ascii=False, separators=(',', ':'))
        os.replace(tmp, self.idxf)

    def write_file(self, path, data):
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f: f.write(data)
        os.replace(tmp, path)

    def load_projects(self):
        # The index; project files it doesn't know (index lost, or copied in) are added back; an old single project.json
        # is moved in as one more project. Entries whose file is gone are dropped. Nothing is ever deleted here.
        os.makedirs(self.pdir, exist_ok=True)
        if os.path.exists(self.idxf):
            try:
                with open(self.idxf, encoding='utf-8-sig') as f: x = json.load(f)
                for p in x.get('projects') or []:
                    if isinstance(p, dict) and ID_RX.match(str(p.get('id', ''))) and not self.entry(p['id']):
                        self.idx['projects'].append({'id': p['id'], 'name': clean_name(str(p.get('name') or '')) or p['id'],
                                                     'created': int(p.get('created') or 0), 'opened': int(p.get('opened') or 0),
                                                     'mode': p.get('mode') if p.get('mode') in ('online', 'offline') else ''})
                self.idx['current'] = str(x.get('current') or '')
            except (OSError, ValueError, TypeError, AttributeError) as e:
                self.log('projects_index_unreadable', {'file': self.idxf, 'error': str(e)})
        for p in list(self.idx['projects']):
            if not os.path.exists(self.pfile(p['id'])):
                self.idx['projects'].remove(p); self.log('project_missing', {'id': p['id'], 'name': p['name']})
        for f in sorted(os.listdir(self.pdir)):
            pid = f[:-5]
            if f.endswith('.json') and f != 'index.json' and ID_RX.match(pid) and not self.entry(pid):
                nm, md = meta_in(self.pfile(pid))
                e = self.add_entry(pid, nm, md); self.log('project_found', {'id': pid, 'name': e['name'], 'mode': md})
        legacy = os.path.join(self.data, 'project.json')
        if os.path.exists(legacy):           # the single shared project of earlier versions
            pid, lrev = self.new_id(), os.path.join(self.data, 'project.rev')
            (name, md), rev = meta_in(legacy), read_int(lrev)
            os.replace(legacy, self.pfile(pid))
            if os.path.exists(lrev): os.replace(lrev, self.pfile(pid, '.rev'))
            else:
                with open(self.pfile(pid, '.rev'), 'w', encoding='utf-8') as f: f.write(str(rev))
            e = self.add_entry(pid, name, md)
            if not self.entry(self.idx['current']): self.idx['current'] = pid
            self.log('projects_migrated', {'from': legacy, 'id': pid, 'name': e['name'], 'rev': rev})
        for p in self.idx['projects']:       # projects of before the workspaces: online or offline from their content
            if not p['mode']:
                p['mode'] = meta_in(self.pfile(p['id']))[1]; self.log('project_workspace', {'id': p['id'], 'name': p['name'], 'mode': p['mode'], 'why': 'from its content'})
        if not self.entry(self.idx['current']): self.idx['current'] = self.latest()
        for p in self.idx['projects']: self.revs[p['id']] = read_int(self.pfile(p['id'], '.rev'))
        self.write_idx()

    def listing(self):
        with self.proj_lock:
            out = []
            for p in self.idx['projects']:
                try: st = os.stat(self.pfile(p['id'])); size, mod = st.st_size, int(st.st_mtime * 1000)
                except OSError: size, mod = 0, 0
                out.append({'id': p['id'], 'name': p['name'], 'rev': self.revs.get(p['id'], 0), 'bytes': size, 'modified': mod, 'opened': p['opened'], 'mode': p['mode']})
            return {'current': self.idx['current'], 'projects': out}

    def removed(self):                  # projects/removed/: [{file (no .json), id, name, bytes, modified, mode}], newest first
        rdir, out = os.path.join(self.pdir, 'removed'), []
        if os.path.isdir(rdir):
            for f in os.listdir(rdir):
                if not f.endswith('.json'): continue
                p = os.path.join(rdir, f); m = REMOVED_RX.search(f[:-5])
                try: st = os.stat(p)
                except OSError: continue
                nm, md = meta_in(p)
                out.append({'file': f[:-5], 'id': m.group(1) if m else '', 'name': nm or f[:-5], 'bytes': st.st_size, 'modified': int(st.st_mtime * 1000), 'mode': md})
        out.sort(key=lambda r: -r['modified'])
        return {'removed': out}

    def errors_read(self, pid):         # <id>.errors.json (empty when none / unreadable)
        doc = {'rev': 0, 'held': {}, 'gone': {}, 'base': {}}
        try:
            with open(self.pfile(pid, '.errors.json'), encoding='utf-8-sig') as f: x = json.load(f)
            if isinstance(x, dict):
                doc['rev'] = int(num(x.get('rev')))
                for k in ('held', 'gone', 'base'):
                    if isinstance(x.get(k), dict): doc[k] = x[k]
        except (OSError, ValueError): pass
        return doc

    # ---------------------------------------------------------------- log
    @staticmethod
    def now():
        return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:23]

    def archives(self):
        return sorted(f for f in os.listdir(self.log_dir) if re.match(r'^open_nova_\d{8}_\d{6}(_\d+)?\.log$', f))

    def add_lines(self, lines):
        with self.log_lock:
            try:
                if os.path.exists(self.log_file) and os.path.getsize(self.log_file) > self.log_max:
                    stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S'); dest = os.path.join(self.log_dir, 'open_nova_%s.log' % stamp); k = 1
                    while os.path.exists(dest): dest = os.path.join(self.log_dir, 'open_nova_%s_%d.log' % (stamp, k)); k += 1
                    os.replace(self.log_file, dest)
                    for old in self.archives()[:-2]:          # keep the newest 2 archives (as serve.ps1)
                        try: os.remove(os.path.join(self.log_dir, old))
                        except OSError: pass
            except OSError: pass
            try:
                with open(self.log_file, 'a', encoding='utf-8', newline='\n') as f: f.write('\n'.join(lines) + '\n')
            except OSError: pass

    def log(self, action, details=None, source='server'):
        try:
            line = '{"timestamp":"%s","source":%s,"action":%s,"details":%s}' % (
                self.now(), json.dumps(source), json.dumps(action), json.dumps(details if details is not None else {}, ensure_ascii=False, separators=(',', ':')))
            self.add_lines([line.replace('\r', '').replace('\n', '')])
        except (TypeError, ValueError): pass

    def read_log(self, mx, needle, since, until, filtered):
        out, matched = [], 0
        if os.path.exists(self.log_file):
            with open(self.log_file, 'rb') as f:
                skip = False
                if not filtered and os.path.getsize(self.log_file) > LOG_TAIL: f.seek(-LOG_TAIL, 2); skip = True
                lo = needle.lower() if needle else ''
                for i, raw in enumerate(f):
                    if skip and i == 0: continue             # partial first line
                    l = raw.decode('utf-8', 'replace').rstrip('\r\n')
                    if not l or (lo and lo not in l.lower()): continue
                    if since or until:
                        if l.startswith('{"timestamp":"') and len(l) >= 38: ts = l[14:37]
                        else:
                            m = TS_RX.match(l[:60])
                            if not m: continue
                            ts = m.group(1)
                        if since and ts < since: continue
                        if until and ts > until: continue
                    matched += 1; out.append(l)
                    if len(out) > mx: out.pop(0)
        return out, matched

    # ---------------------------------------------------------------- live updates
    def event(self, data):
        with self.sse_lock:
            for q in list(self.sse): q.put(data)

    def pinger(self):
        while True:
            time.sleep(15); self.event(None)


def log_stamp(ms):
    try: return datetime.datetime.fromtimestamp(int(ms) / 1000.0).strftime('%Y-%m-%d %H:%M:%S.%f')[:23]
    except (TypeError, ValueError, OverflowError, OSError): return ''


def reveal(path):
    if sys.platform == 'win32': subprocess.Popen(['explorer', path])
    elif sys.platform == 'darwin': subprocess.Popen(['open', path])
    else: subprocess.Popen(['xdg-open', path])


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    S = None                           # the Server

    def log_message(self, fmt, *args): pass

    def reply(self, code, ctype=None, body=b'', extra=None):
        self.send_response(code)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        if ctype: self.send_header('Content-Type', ctype)
        for k, v in (extra or {}).items(): self.send_header(k, v)
        self.end_headers()
        if body and self.command != 'HEAD': self.wfile.write(body)
        self.close_connection = True

    def json_reply(self, code, obj):
        self.reply(code, 'application/json; charset=utf-8', json.dumps(obj, ensure_ascii=False).encode('utf-8'))

    def ip(self):
        a = self.client_address[0]
        return a[7:] if a.startswith('::ffff:') else a

    def is_local(self):
        a = self.ip(); return a.startswith('127.') or a == '::1'

    def body(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_BODY: raise ValueError('too large')
        return self.rfile.read(n) if n > 0 else b''

    def do_GET(self): self.route()
    def do_HEAD(self): self.route()
    def do_POST(self): self.route()
    def do_PUT(self): self.route()
    def do_DELETE(self): self.route()

    def route(self):
        S = self.S
        try:
            if int(self.headers.get('Content-Length') or 0) > MAX_BODY: return self.reply(413)
            u = urlsplit(self.path); rel = unquote(u.path).lstrip('/') or 'index.html'
            m = self.command
            if HELPER_RX.match(rel): return self.helper(rel)
            if rel == 'api/log' and m == 'POST': return self.client_log()
            if rel == 'api/logs' and m == 'GET': return self.logs(parse_qs(u.query))
            if rel == 'api/logs' and m == 'DELETE':
                if not self.is_local(): return self.reply(403)
                open(S.log_file, 'wb').close(); S.log('logs_cleared', {'ip': self.ip()}); return self.reply(204)
            if rel == 'api/logs/reveal' and m == 'POST':
                if not self.is_local(): return self.reply(403)
                reveal(S.log_dir); return self.reply(204)
            if rel == 'api/events' and m == 'GET': return self.events()
            if rel == 'api/project' and m == 'GET':
                with S.proj_lock:
                    pid = S.idx['current']; hdr = {'X-Rev': str(S.revs.get(pid, 0)), 'X-Project': pid}
                    if not pid or not os.path.exists(S.pfile(pid)): return self.reply(404, 'text/plain', b'', hdr)
                    with open(S.pfile(pid), 'rb') as f: data = f.read()
                return self.reply(200, 'application/json', data, hdr)
            if rel == 'api/project' and m == 'PUT': return self.save_project()
            if rel == 'api/projects' and m == 'GET': return self.json_reply(200, S.listing())
            if rel == 'api/projects/removed' and m == 'GET':
                with S.proj_lock: return self.json_reply(200, S.removed())
            if rel.startswith('api/projects/') and m == 'POST': return self.project_action(rel[13:], parse_qs(u.query))
            if rel == 'api/errors' and m in ('GET', 'POST'): return self.errors(m, parse_qs(u.query))
            if rel == 'api/preview' and m in ('GET', 'PUT'): return self.preview(m, parse_qs(u.query))
            path = os.path.realpath(os.path.join(ROOT, rel))
            inside = path == ROOT or path.startswith(ROOT + os.sep)
            if m == 'PUT' and rel.startswith('out/'):          # test hook: this computer only
                if not self.is_local() or not path.startswith(os.path.join(ROOT, 'out') + os.sep): return self.reply(403)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'wb') as f: f.write(self.body())
                return self.reply(204)
            if m in ('GET', 'HEAD') and inside and os.path.isfile(path):
                ext = os.path.splitext(path)[1].lower()
                with open(path, 'rb') as f: data = f.read()
                return self.reply(200, TYPES.get(ext, 'application/octet-stream'), data)
            if rel.startswith('api/'): S.log('api_not_found', {'method': m, 'path': '/' + rel, 'ip': self.ip()})
            return self.reply(404, 'text/plain', b'Not found')
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except Exception as e:  # noqa: BLE001 - one bad request must never stop the server
            S.log('http_error', {'status': 500, 'method': self.command, 'path': self.path.split('?')[0], 'error': str(e), 'ip': self.ip()})
            try: self.reply(500, 'text/plain', str(e).encode('utf-8', 'replace'))
            except OSError: pass

    # ---------------------------------------------------------------- hardware helper pass-through
    def helper(self, rel):
        S = self.S
        # Only the app's own page may drive the hardware: a browser always sends Origin on a POST, another site's page
        # would carry its own origin, and a JSON body can't be sent cross-site without a preflight (never granted here).
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + (self.headers.get('Host') or ''):
            S.log('helper_refused', {'ip': self.ip(), 'path': rel, 'origin': origin})
            return self.json_reply(403, {'ok': False, 'error': 'refused: not the app\'s own page'})
        if self.command == 'POST' and not (self.headers.get('Content-Type') or '').startswith('application/json'):
            return self.json_reply(415, {'ok': False, 'error': 'JSON only'})
        data = self.body() if self.command in ('POST', 'PUT') else None
        q = urlsplit(self.path).query   # downloads carry their name in the query (diagnostics)
        req = urllib.request.Request('http://127.0.0.1:%d/%s%s' % (S.helper_port, rel, '?' + q if q else ''), data=data, method=self.command)
        if data is not None: req.add_header('Content-Type', 'application/json')
        try:
            with urllib.request.urlopen(req, timeout=HELPER_TIMEOUT) as r:
                return self.reply(r.status, 'application/json', r.read())
        except urllib.error.HTTPError as e:
            return self.reply(e.code, 'application/json', e.read())
        except socket.timeout:
            why = 'the hardware helper didn\'t answer within %d minutes (it may still be working)' % (HELPER_TIMEOUT // 60)
        except (urllib.error.URLError, OSError) as e:
            why = 'the hardware helper is not running (%s)' % str(getattr(e, 'reason', e)).replace('"', "'")
        return self.json_reply(502, {'ok': False, 'error': why})

    # ---------------------------------------------------------------- logs
    def client_log(self):
        S = self.S
        prefix = '{"timestamp":"%s","source":"client","ip":"%s",' % (S.now(), self.ip())
        text = self.body().decode('utf-8', 'replace').lstrip('\ufeff')
        out, n = [], 0
        for ln in text.split('\n'):
            ln = ln.replace('\r', '').strip()
            if not ln: continue
            n += 1
            if n > 500: break
            if len(ln) > 65536 or not ln.startswith('{') or not ln.endswith('}'): continue
            rest = ln[1:]
            out.append(prefix.rstrip(',') + '}' if rest.strip() == '}' else prefix + rest)
        if out: S.add_lines(out)
        return self.reply(204)

    def logs(self, q):
        S = self.S
        g = lambda k: (q.get(k) or [''])[0]
        try: mx = max(1, min(20000, int(g('lines'))))
        except ValueError: mx = 500
        since, until, needle = log_stamp(g('since')) if g('since') else '', log_stamp(g('until')) if g('until') else '', g('q')
        filtered = bool(since or until or needle)
        lines, matched = S.read_log(mx, needle, since, until, filtered)
        return self.json_reply(200, {'lines': lines, 'file_size_bytes': os.path.getsize(S.log_file) if os.path.exists(S.log_file) else 0,
                                     'file_path': S.log_file, 'dir_path': S.log_dir, 'archive_count': len(S.archives()),
                                     'matched_count': matched, 'returned_count': len(lines), 'filtered': filtered})

    # ---------------------------------------------------------------- project + live updates
    def save_project(self):
        # The server's copy is the project; the latest save wins and every other browser is told. A save names its
        # project (X-Project), so one that arrives after another browser switched projects still lands where it belongs.
        S = self.S
        data = self.body()
        frm = re.sub(r'[^A-Za-z0-9_-]', '', self.headers.get('X-Client') or '')
        want, name = (self.headers.get('X-Project') or '').strip(), clean_name(unquote(self.headers.get('X-Project-Name') or ''))
        mode = self.headers.get('X-Project-Mode') if self.headers.get('X-Project-Mode') in ('online', 'offline') else ''
        with S.proj_lock:
            if want and not S.entry(want):
                S.log('project_save_refused', {'project': want[:40], 'why': 'no such project (removed?)', 'from': frm, 'ip': self.ip()})
                return self.reply(410, 'text/plain', b'that project was removed', {'X-Project': S.idx['current']})
            pid = want or S.idx['current']
            try:
                if not pid:                      # nothing on the server yet: this becomes the first project
                    pid = S.new_id(); S.add_entry(pid, name, mode or mode_in(data)); S.idx['current'] = pid; S.write_idx()
                S.write_file(S.pfile(pid), data)
                S.revs[pid] = S.revs.get(pid, 0) + 1
                with open(S.pfile(pid, '.rev'), 'w', encoding='utf-8') as f: f.write(str(S.revs[pid]))
                e = S.entry(pid)
                if mode and e['mode'] != mode:   # the app moved it to the other workspace
                    S.log('project_workspace', {'id': pid, 'name': name or e['name'], 'mode': mode, 'was': e['mode'], 'from': frm}); e['mode'] = mode; S.write_idx()
                if name and e['name'] != name: e['name'] = name; S.write_idx()
            except OSError as e:
                S.log('project_save_failed', {'error': str(e), 'project': pid, 'ip': self.ip()}); raise
            rev = S.revs[pid]
        self.reply(200, 'text/plain', b'', {'X-Rev': str(rev), 'X-Project': pid})
        S.log('project_saved', {'rev': rev, 'bytes': len(data), 'project': pid, 'from': frm, 'ip': self.ip()})
        S.event('{"rev":%d,"from":"%s","project":"%s"}' % (rev, frm, pid))

    def project_action(self, act, q):
        # New / Open / Remove: the project every browser is on changes, so every browser is told to switch.
        S = self.S
        origin = self.headers.get('Origin')
        if origin and origin != 'http://' + (self.headers.get('Host') or ''):
            S.log('projects_refused', {'ip': self.ip(), 'action': act, 'origin': origin})
            return self.json_reply(403, {'ok': False, 'error': 'refused: not the app\'s own page'})
        g = lambda k: (q.get(k) or [''])[0]
        frm = re.sub(r'[^A-Za-z0-9_-]', '', self.headers.get('X-Client') or '')
        pid, info = g('id').strip(), {}
        with S.proj_lock:
            e = S.entry(pid) if pid else None
            if act == 'new':
                data = self.body()
                if not data.lstrip().startswith(b'{'): return self.json_reply(400, {'ok': False, 'error': 'the project must be JSON'})
                pid = S.new_id(); S.write_file(S.pfile(pid), data); S.revs[pid] = 1
                with open(S.pfile(pid, '.rev'), 'w', encoding='utf-8') as f: f.write('1')
                md = g('mode') if g('mode') in ('online', 'offline') else mode_in(data)
                e = S.add_entry(pid, clean_name(g('name')), md); S.idx['current'] = pid
                info = {'bytes': len(data)}
            elif act in ('open', 'remove'):
                if not e: return self.json_reply(404, {'ok': False, 'error': 'no such project'})
                if act == 'open': e['opened'] = ms_now(); S.idx['current'] = pid
                else:
                    if len(S.idx['projects']) < 2: return self.json_reply(409, {'ok': False, 'error': 'the only project can\'t be removed'})
                    rdir = os.path.join(S.pdir, 'removed'); os.makedirs(rdir, exist_ok=True)
                    base = os.path.join(rdir, '%s_%s' % (file_name(e['name']), pid))
                    if os.path.exists(base + '.json'): base += '_' + datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
                    os.replace(S.pfile(pid), base + '.json')
                    if os.path.exists(S.pfile(pid, '.rev')): os.replace(S.pfile(pid, '.rev'), base + '.rev')
                    if os.path.exists(S.pfile(pid, '.errors.json')): os.replace(S.pfile(pid, '.errors.json'), base + '.errors')
                    for pf in os.listdir(S.pdir):   # the content-preview pictures go with it
                        if pf.startswith(pid + '.preview.') and pf.endswith('.jpg'): os.replace(os.path.join(S.pdir, pf), base + pf[len(pid):])
                    S.idx['projects'].remove(e); S.revs.pop(pid, None); info = {'moved_to': base + '.json'}
                    if S.idx['current'] == pid: S.idx['current'] = S.latest(e['mode'])
            elif act == 'restore':               # a removed project back into the list (its old id when free), made current
                f = g('file'); rdir = os.path.join(S.pdir, 'removed'); src = os.path.join(rdir, f + '.json')
                if not REMOVED_FILE_RX.match(f) or f in ('.', '..') or not os.path.isfile(src):
                    return self.json_reply(404, {'ok': False, 'error': 'no such removed project'})
                mm = REMOVED_RX.search(f); pid = mm.group(1) if mm else ''
                if not pid or S.entry(pid) or os.path.exists(S.pfile(pid)): pid = S.new_id()
                name, md = meta_in(src); name = name or (f[:mm.start()] if mm else f)
                os.replace(src, S.pfile(pid))
                if os.path.exists(os.path.join(rdir, f + '.rev')): os.replace(os.path.join(rdir, f + '.rev'), S.pfile(pid, '.rev'))
                else:
                    with open(S.pfile(pid, '.rev'), 'w', encoding='utf-8') as fh: fh.write('1')
                S.revs[pid] = read_int(S.pfile(pid, '.rev'))
                if os.path.isfile(os.path.join(rdir, f + '.errors')) and not os.path.exists(S.pfile(pid, '.errors.json')):
                    os.replace(os.path.join(rdir, f + '.errors'), S.pfile(pid, '.errors.json'))
                for pf in os.listdir(rdir):
                    if pf.startswith(f + '.preview.') and pf.endswith('.jpg') and not os.path.exists(S.pfile(pid, pf[len(f):-4] + '.jpg')):
                        os.replace(os.path.join(rdir, pf), S.pfile(pid, pf[len(f):-4] + '.jpg'))
                e = S.add_entry(pid, name, md); S.idx['current'] = pid; info = {'from_file': f + '.json'}
            else:
                return self.json_reply(404, {'ok': False, 'error': 'unknown action'})
            S.write_idx()
            cur = S.idx['current']; rev = S.revs.get(cur, 0)
        info.update({'id': pid, 'name': e['name'], 'mode': e['mode'], 'current': cur, 'from': frm, 'ip': self.ip()})
        S.log({'new': 'project_created', 'open': 'project_opened', 'remove': 'project_removed', 'restore': 'project_restored'}[act], info)
        self.json_reply(200, {'ok': True, 'id': pid, 'current': cur, 'rev': rev})
        S.event('{"switch":"%s","rev":%d,"from":"%s"}' % (cur, rev, frm))

    def errors(self, m, q):
        # The monitor errors kept until the user's Clear, per project, beside it (not in it: no unsaved mark, no undo).
        # Every browser sends only what it changed; the server merges, so a Clear in one browser clears it in all.
        S = self.S
        frm = re.sub(r'[^A-Za-z0-9_-]', '', self.headers.get('X-Client') or '')
        if m == 'POST':
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + (self.headers.get('Host') or ''):
                S.log('errors_refused', {'ip': self.ip(), 'origin': origin})
                return self.json_reply(403, {'ok': False, 'error': 'refused: not the app\'s own page'})
        with S.proj_lock:
            pid = (q.get('project') or [''])[0].strip() or S.idx['current']
            if not pid or not S.entry(pid): return self.json_reply(404 if m == 'GET' else 410, {'ok': False, 'error': 'no such project'})
            doc = S.errors_read(pid)
            if m == 'GET': doc['project'] = pid; return self.json_reply(200, doc)
            try: ch = json.loads(self.body().decode('utf-8-sig'))
            except ValueError: ch = None
            if not isinstance(ch, dict): return self.json_reply(400, {'ok': False, 'error': 'the change must be a JSON object'})
            n = errors_merge(doc, ch)
            S.write_file(S.pfile(pid, '.errors.json'), json.dumps(doc, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            rev, held = doc['rev'], len(doc['held'])
        self.json_reply(200, {'ok': True, 'project': pid, 'rev': rev, 'held': held})
        S.log('errors_saved', {'project': pid, 'rev': rev, 'set': n[0], 'cleared': n[1], 'held': held, 'from': frm, 'ip': self.ip()})
        S.event('{"errors":%d,"from":"%s","project":"%s"}' % (rev, frm, pid))

    def preview(self, m, q):
        # The Layout canvas's content-preview picture per project and screen (PRO_LOOK_PLAN §5.2), beside the project: the
        # bytes stay out of the project (synced to every browser, kept in localStorage) and are never sent to a processor.
        S = self.S
        frm = re.sub(r'[^A-Za-z0-9_-]', '', self.headers.get('X-Client') or '')
        if m == 'PUT':
            origin = self.headers.get('Origin')
            if origin and origin != 'http://' + (self.headers.get('Host') or ''):
                S.log('preview_refused', {'ip': self.ip(), 'origin': origin})
                return self.json_reply(403, {'ok': False, 'error': 'refused: not the app\'s own page'})
        sid = re.sub(r'[^A-Za-z0-9_-]', '', (q.get('screen') or [''])[0])[:40]
        with S.proj_lock:
            pid = (q.get('project') or [''])[0].strip() or S.idx['current']
            if not pid or not S.entry(pid) or not sid: return self.json_reply(404, {'ok': False, 'error': 'no such project / screen'})
            f = S.pfile(pid, '.preview.%s.jpg' % sid)
            if m == 'GET':
                if not os.path.isfile(f): return self.reply(404, 'text/plain', b'no picture')
                with open(f, 'rb') as fh: data = fh.read()
                return self.reply(200, 'image/jpeg', data)
            data = self.body()
            if len(data) < 4 or data[:2] != b'\xff\xd8' or len(data) > 8 * 1024 * 1024:
                return self.json_reply(400, {'ok': False, 'error': 'a JPEG of at most 8 MB'})
            S.write_file(f, data)
        S.log('preview_saved', {'project': pid, 'screen': sid, 'bytes': len(data), 'from': frm, 'ip': self.ip()})
        self.json_reply(200, {'ok': True, 'project': pid, 'screen': sid, 'bytes': len(data)})
        S.event('{"preview":"%s","project":"%s","from":"%s"}' % (sid, pid, frm))

    def events(self):
        S = self.S
        q = queue.Queue()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream'); self.send_header('Cache-Control', 'no-store'); self.send_header('Connection', 'keep-alive')
        self.end_headers()
        self.wfile.write(b'retry: 2000\n\n'); self.wfile.flush()
        with S.sse_lock: S.sse.append(q); n = len(S.sse)
        S.log('events_connect', {'ip': self.ip(), 'open': n})
        try:
            while True:
                d = q.get()
                self.wfile.write(('data: %s\n\n' % d).encode('utf-8') if d else b': ping\n\n'); self.wfile.flush()
        except OSError:
            pass
        finally:
            with S.sse_lock:
                if q in S.sse: S.sse.remove(q)
                n = len(S.sse)
            S.log('events_disconnect', {'ip': self.ip(), 'open': n})
            self.close_connection = True


class DualStackServer(ThreadingHTTPServer):
    daemon_threads = True
    address_family = socket.AF_INET6

    def server_bind(self):
        try: self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)   # IPv4 and IPv6 on every interface
        except (OSError, AttributeError): pass
        super().server_bind()


def addresses(port):
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'tools'))
        import netif
        return ['http://%s:%d/' % (n['ip'], port) for n in netif.networks()]
    except Exception:  # noqa: BLE001 - only for the startup message
        return []


def bind_plan(choice, local):
    """Settings > Network's "App reachable from" (or --bind / --local-only) -> netif.bind_plan: {choice, hosts, note}."""
    if local: return {'choice': 'localhost', 'hosts': ['127.0.0.1'], 'note': ''}
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(ROOT), 'tools'))
        import netif
        return netif.bind_plan(choice)
    except Exception as e:  # noqa: BLE001 - no settings: every interface, as before
        return {'choice': 'all', 'hosts': None, 'note': 'network settings not read (%s): every interface' % e}


def main(argv):
    port, a, opts = 8765, list(argv), {}
    if a and a[0].isdigit(): port = int(a.pop(0))
    while a:
        k = a.pop(0)
        if k == '--local-only': opts['local'] = True
        elif k in ('--data-dir', '--log-max-mb', '--helper-port', '--port', '--bind') and a: opts[k] = a.pop(0)
        else: print(__doc__); return 2
    port = int(opts.get('--port', port))
    plan = bind_plan(opts.get('--bind'), opts.get('local', False))
    S = Server(port, opts.get('--data-dir', ''), float(opts.get('--log-max-mb', 20)), int(opts.get('--helper-port', 8790)), plan['hosts'] == ['127.0.0.1'])
    Handler.S = S
    servers = []
    if plan['hosts'] is None:
        try: servers = [DualStackServer(('::', port), Handler)]
        except OSError: servers = [ThreadingHTTPServer(('0.0.0.0', port), Handler)]
    else:
        for h in plan['hosts']:                    # loopback first: localhost always works
            try: servers.append(ThreadingHTTPServer((h, port), Handler))
            except OSError as e:
                if h == '127.0.0.1': raise
                plan['note'] = (plan['note'] + '; ' if plan['note'] else '') + 'cannot listen on %s (%s)' % (h, e)
    for x in servers: x.daemon_threads = True
    httpd = servers[0]
    adds = [] if S.local_only else addresses(port) if plan['hosts'] is None else ['http://%s:%d/' % (h, port) for h in plan['hosts'][1:]]
    print('Serving %s on http://localhost:%d/' % (ROOT, port))
    for x in adds: print('                 and %s' % x)
    if plan['choice'] != 'all': print('Reachable from: %s (Settings > Network)' % ('this computer only' if S.local_only else plan['choice'] + ' and this computer'))
    if plan['note']: print('Note: %s' % plan['note'])
    try:
        import netif
        netif.save_applied(port, {'choice': plan['choice'], 'hosts': plan['hosts'], 'note': plan['note'], 'server': 'serve.py', 'pid': os.getpid(), 'at': ms_now()})
    except Exception: pass  # noqa: BLE001 - only for the dialog's "now" line
    print('Log file: %s' % S.log_file); sys.stdout.flush()
    try:   # which Open Nova this is (app/version.json, the one version source; make_package.py stamps it)
        with open(os.path.join(ROOT, 'version.json'), encoding='utf-8-sig') as f: ver = json.load(f)
        ver = '%s (build %s, %s)' % (ver.get('version'), ver.get('build'), ver.get('channel'))
    except (OSError, ValueError, AttributeError): ver = 'unknown'
    print('Open Nova %s' % ver)
    S.log('server_start', {'port': port, 'data_dir': S.data, 'log_file': S.log_file, 'addresses': adds, 'local_only': S.local_only, 'bind': plan['choice'], 'bind_note': plan['note'] or None,
                           'python': sys.version.split()[0], 'os': sys.platform, 'server': 'serve.py', 'version': ver})
    threading.Thread(target=S.pinger, daemon=True).start()
    for x in servers[1:]: threading.Thread(target=x.serve_forever, daemon=True).start()   # one interface: its address beside loopback
    try: httpd.serve_forever()
    except KeyboardInterrupt: pass
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
