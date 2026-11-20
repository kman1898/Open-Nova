"""alpha.py - what the early-alpha build adds to the helper (tools/novalink.py). Stdlib only; Mac, Windows, Linux.

The alpha goes to many testers with different processors; when something goes wrong, one file from them must carry
everything needed to fix it or to add a model Open Nova doesn't know yet (docs/DIAGNOSTICS.md "The alpha build").

  info()               the one version source, app/version.json: {version, build, channel, readOnly, unlock, reportContact,
                       keepDays, keepMB} + alpha (channel "alpha", or OPENNOVA_ALPHA=1 from `opennova.py --alpha`)
  version_line()       "Open Nova 1.2.3-alpha.4 (build 20261028-1a2b3c4d, alpha)": every log / recording header
  settings() / set_settings(changes)   this computer's alpha settings (alpha-settings.json next to the app): the
                       tester's consent to the intro, name and contact (optional)
  classify(path, body) 'read' | 'write', default-deny (user, 2026-10-28: "we need every save or send what have you to be
                       password protected"): 'read' only for a route on the READ allowlist (pure reads, or local: nothing
                       reaches a processor), a READ_WHEN route with its read value (calibration op read, proxy off), or a
                       /api/hw/run plan whose every op is a read (READ_OPS). Everything else is a write, unknown routes too:
                       Send, Save, blackout / freeze / normal, test patterns, identify on the wall, mapping, error Clear,
                       live colour, service, calibration, receiving-card files, presets, schedules, verify, the proxy port.
  gate(path, body)     the read-only alpha: None = go on, else the refusal. A write passes only with the unlock: body.alphaUnlock
                       = the token the browser derives from the unlock code (SHA-256(salt + code + "|send")), checked here
                       against version.json's unlock.tokenSha256 (the token itself is in no file). A build packaged without
                       a code never writes. Every write is noted for the report (allowed or refused, with its app action).
  first_contact(...)   a snapshot of everything said with a processor the app doesn't know (unknown model, a helper error):
                       diagnostics/<day>/first-contact/<time>_<key>.json, once per key and day
  prune()              alpha only: recordings and helper logs older than keepDays, then the oldest over keepMB, removed
  build_report(payload)  Help ▸ Report a problem: one .zip with REPORT.md on top, passwords / tokens / logins scrubbed,
                       private IP addresses optionally anonymised (192.168.0.11 -> device-A, the same in every file), saved
                       to Downloads (or Nova/reports). Session subfolders (first-contact/, vendor/, …) go in as they are.
                       At most REPORT_MAX_MB (e-mail): the essentials always, then processor snapshots, the newest
                       recordings, logs, session files, NovaStar apps' logs while they fit; REPORT.md names what was left out.
                       With "System": this computer (tools/sysdiag.py: OS, CPU, the Python, USB libraries tried, USB / COM
                       drivers, who holds the search ports, the firewall) and the start window's text (console.txt).
"""
import collections
import datetime
import hashlib
import json
import os
import platform
import re
import shutil
import sys
import threading
import time
import zipfile
import zlib

import wirelog

HERE = os.path.dirname(os.path.abspath(__file__))
NOVA = os.path.dirname(HERE)
VERSION_FILE = os.environ.get('OPENNOVA_VERSION_FILE') or os.path.join(NOVA, 'app', 'version.json')
SETTINGS_FILE = os.environ.get('OPENNOVA_ALPHA_SETTINGS') or os.path.join(NOVA, 'alpha-settings.json')
LOG_DIR = os.environ.get('OPENNOVA_HELPER_LOGS') or os.path.join(HERE, 'novalink_logs')
DEFAULTS = {'name': 'Open Nova', 'version': '0.0.0', 'build': 'dev', 'channel': 'dev', 'readOnly': True, 'unlock': None,
            'reportContact': '', 'repoPublic': False, 'keepDays': 14, 'keepMB': 2048}
REPORT_MAX_MB = 15        # a report's .zip at most: e-mail limits are 20-25 MB, and the attachment grows by a third on the way
CONSOLE_LOG = os.environ.get('OPENNOVA_CONSOLE_LOG') or os.path.join(NOVA, 'app', 'data', 'logs', 'console.txt')   # opennova.py's copy of its window
READ_ONLY_TEXT = 'Writing to processors is off in this alpha — Settings ▸ Alpha ▸ Allow sending'
SESSION_DIRS = ('first-contact', 'vendor', 'bodies')   # subfolders of a day's recording folder that a report carries whole (bodies/: big http bodies, wirelog)
STARTED = time.time()

_lock = threading.Lock()
_ver = {'mtime': None, 'v': None}
_writes = collections.deque(maxlen=300)
_fc_done = set()


# ------------------------------------------------------------------ version + settings
def info():
    try: mt = os.path.getmtime(VERSION_FILE)
    except OSError: mt = None
    if _ver['v'] is None or mt != _ver['mtime']:
        v = dict(DEFAULTS)
        try:
            with open(VERSION_FILE, encoding='utf-8-sig') as f: v.update(json.load(f))
        except (OSError, ValueError):
            pass
        _ver.update(mtime=mt, v=v)
    v = dict(_ver['v'])
    v['alpha'] = v.get('channel') == 'alpha' or os.environ.get('OPENNOVA_ALPHA', '').lower() in ('1', 'true', 'yes')
    return v


def version_line():
    v = info()
    return '%s %s (build %s%s)' % (v['name'], v['version'], v['build'], ', alpha' if v['alpha'] else '')


def read_only():
    v = info(); return bool(v['alpha'] and v.get('readOnly', True))


def settings():
    try:
        with open(SETTINGS_FILE, encoding='utf-8-sig') as f: s = json.load(f)
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def set_settings(ch):
    """Only the consent and the tester's own details (no codes, no passwords)."""
    with _lock:
        s = settings()
        if 'consent' in ch:
            c = ch['consent'] or {}
            s['consent'] = {'at': datetime.datetime.now().isoformat(timespec='seconds'), 'version': info()['version'],
                            'name': str(c.get('name') or '')[:120], 'contact': str(c.get('contact') or '')[:200]} if ch['consent'] else None
        tmp = SETTINGS_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f: json.dump(s, f, indent=1, ensure_ascii=False)
        os.replace(tmp, SETTINGS_FILE)
    return state()


def state():
    v, s = info(), settings()
    c = s.get('consent') or None
    return {'ok': True, 'version': v['version'], 'build': v['build'], 'channel': v['channel'], 'alpha': v['alpha'],
            'line': version_line(), 'readOnly': read_only(), 'unlock': v.get('unlock') or None, 'reportContact': v.get('reportContact') or '',
            'repoPublic': bool(v.get('repoPublic')),   # the GitHub issue link only once the repository is public (a 404 before)
            'keepDays': v['keepDays'], 'keepMB': v['keepMB'], 'consented': bool(c), 'tester': c,
            'policy': {'read': sorted(READ), 'readPrefix': list(READ_PREFIX), 'readWhen': {p: [k, list(ok)] for p, (k, ok) in READ_WHEN.items()},
                       'readOps': list(READ_OPS)}}


def _sha(s):
    return hashlib.sha256(s.encode('utf-8')).hexdigest()


def make_unlock(code):
    """The packaged form of an unlock code: a random salt, SHA-256(salt + code) (the browser checks the code with it) and
    tokenSha256 = SHA-256 of the send token SHA-256(salt + code + "|send") (the helper checks the browser's token with it).
    Neither the code nor the token is kept anywhere: reading version.json doesn't give a token that writes."""
    salt = os.urandom(16).hex()
    return {'salt': salt, 'sha256': _sha(salt + code), 'tokenSha256': _sha(_sha(salt + code + '|send'))}


def check_code(code, unlock=None):
    u = unlock if unlock is not None else info().get('unlock')
    return bool(u and u.get('salt') and _sha(u['salt'] + str(code)) == u.get('sha256'))


def send_token(code, unlock=None):
    """The token the browser sends with a write once the code was typed (app-alpha.js does the same)."""
    u = unlock if unlock is not None else info().get('unlock') or {}
    return _sha(u.get('salt', '') + str(code) + '|send')


# ------------------------------------------------------------------ the read-only gate (default-deny)
# Only these pass without the unlock: pure reads, and local things that never reach a processor. Anything not named here
# is a write, also a route added later and never listed: it needs the unlock until someone adds it here as a read.
# Detect (NovaLCT protocol) starts with LCT's broadcast "arrange addresses" (rx 0x01000000 = 00, nothing stored) and Unico /
# COEX detect ask the processor to refresh its cabinet list, as their own apps do on connect: listed as reads on purpose.
READ = {'/api/hw/ping', '/api/hw/discover', '/api/hw/links', '/api/hw/serial-ports', '/api/hw/info', '/api/hw/detect',
        '/api/hw/health', '/api/hw/color-read', '/api/hw/read-layout', '/api/hw/read-backup', '/api/hw/identify',
        '/api/hw/hweb/login', '/api/hw/hweb/info', '/api/hw/hweb/forget',
        '/api/hw/simulate', '/api/hw/nprj', '/api/hw/support', '/api/hw/report',          # local: no processor involved
        '/api/unico/discover', '/api/unico/info', '/api/unico/detect', '/api/unico/inputs', '/api/unico/identify', '/api/unico/health',
        '/api/unico/screen-read', '/api/unico/read-layout', '/api/unico/read-backup', '/api/unico/presets', '/api/unico/schedules',
        '/api/coex/discover', '/api/coex/info', '/api/coex/inputs', '/api/coex/identify', '/api/coex/detect', '/api/coex/read-layout',
        '/api/coex/read-backup', '/api/coex/health', '/api/coex/screen-read', '/api/coex/presets', '/api/coex/schedules'}
# local modules (never a processor): the recorder, this module, receiving-card file analysis / library, Tools ▸ Vendor apps
# (it sends nothing of Open Nova's own; its relay passes the NovaStar app's bytes on unchanged)
READ_PREFIX = ('/api/hw/diag/', '/api/hw/alpha/', '/api/rcv/', '/api/hw/vendor/')
READ_WHEN = {'/api/hw/calib': ('op', ('read',)),                 # the Correction tab's read; every other op writes
             '/api/hw/proxy': ('on', (False, None, 0, ''))}      # stopping the proxy port; starting it lets another tool write
READ_OPS = ('note', 'sleep', 'r', 'stash')                       # /api/hw/run plan ops that only read (novalink.run_plan)


def classify(path, body):
    """'read' | 'write' (see READ …): default-deny."""
    path = str(path).split('?')[0]; body = body if isinstance(body, dict) else {}
    if path in READ or path.startswith(READ_PREFIX): return 'read'
    if path in READ_WHEN:
        k, ok = READ_WHEN[path]
        return 'read' if body.get(k) in ok else 'write'
    if path == '/api/hw/run':
        plan = body.get('plan'); ops = plan.get('ops') if isinstance(plan, dict) else None
        if not isinstance(ops, list): return 'write'
        return 'read' if all(isinstance(o, dict) and o.get('op') in READ_OPS for o in ops) else 'write'
    return 'write'


def unlocked(body):
    """The browser's send token checks against version.json's unlock (no unlock packaged = never)."""
    tok = (body or {}).get('alphaUnlock'); u = info().get('unlock')
    if not tok or not isinstance(u, dict): return False
    if u.get('tokenSha256'): return _sha(str(tok)) == u['tokenSha256']
    return bool(u.get('sha256')) and str(tok) == u['sha256']   # a package made before tokenSha256 (2026-10-28)


def describe(path, body):
    try:
        if path == '/api/hw/run':
            plan = body.get('plan') or {}; ops = plan.get('ops') or []
            ks = sorted(set(str(o.get('op')) for o in ops) - set(READ_OPS))
            note = next((o.get('text') for o in ops if o.get('op') == 'note'), '') or ''
            regs = sorted(set(wirelog.reg_name(int(o.get('dev', 0)), int(o.get('addr', 0))) or '0x%08X' % int(o.get('addr', 0)) for o in ops if o.get('op') == 'w'))[:4]
            what = 'layout send' if 'nssd' in ks else 'save' if plan.get('waitMs') else 'write'
            return '%s (%s%s%s)' % (what, ', '.join(ks) or 'reads', ': ' + ', '.join(regs) if regs else '', '; ' + note[:60] if note else '')
        bits = [str(body[k])[:40] for k in ('action', 'op', 'a', 'mode', 'name', 'level', 'on') if body.get(k) not in (None, '')]
        return ' '.join(bits)
    except (AttributeError, TypeError, ValueError):
        return '(unreadable request)'


def gate(path, body):
    """None = go on; else the refusal to answer with. Every write is noted for the report (with its app action)."""
    body = body if isinstance(body, dict) else {}
    c = classify(path, body)
    if c == 'read': return None
    ok = not read_only() or unlocked(body)
    with _lock:
        _writes.append({'t': time.time(), 'path': path, 'kind': c, 'allowed': ok, 'unlocked': bool(ok and body.get('alphaUnlock')),
                        'host': str(body.get('host') or ''), 'what': describe(path, body), 'act': wirelog.action() or ''})
    if ok: return None
    wirelog.mark('Refused (read-only alpha): %s %s %s' % (path, body.get('host') or '', describe(path, body)), source='alpha')
    return {'ok': False, 'readOnly': True, 'error': READ_ONLY_TEXT}


def note_refused(body):
    """A write the app refused itself (read-only, no call to the processor): into the report's writes and the recording,
    with the app action it came from (the request this arrives on carries it)."""
    path = str(body.get('path') or '')[:80]
    with _lock:
        _writes.append({'t': time.time(), 'path': path, 'kind': 'write', 'allowed': False, 'unlocked': False, 'where': 'app',
                        'host': str(body.get('host') or ''), 'what': str(body.get('what') or '')[:120], 'act': wirelog.action() or ''})
    wirelog.mark('Refused (read-only alpha) in the app: %s %s %s' % (path, body.get('host') or '', str(body.get('what') or '')[:120]), source='alpha')
    return {'ok': True}


def writes():
    with _lock: return list(_writes)


# ------------------------------------------------------------------ first contact
def day_dir(now=None):
    return os.path.join(wirelog.DIAG_DIR, time.strftime('%Y-%m-%d', time.localtime(now or time.time())))


def _related(host, limit=600):
    if not host: return []
    h = str(host).split(':')[0]
    def hit(r):
        return any(str(r.get(k) or '').split(':')[0] == h for k in ('link', 'peer')) or h in str(r.get('url') or '') or h in str(r.get('req') or '')[:300]
    return [r for r in wirelog.frames(0, wirelog.RING) if hit(r)][-limit:]


def first_contact(key, reason, data=None, host=None, family=''):
    """Everything said with an unknown processor (or around a helper error), once per key a day. Returns {ok, file|skipped}."""
    safe = re.sub(r'[^\w.-]+', '_', str(key)).strip('_')[:80] or 'unknown'
    d = os.path.join(day_dir(), 'first-contact')
    with _lock:
        if safe in _fc_done: return {'ok': True, 'skipped': 'already saved this run'}
        _fc_done.add(safe)
    os.makedirs(d, exist_ok=True)
    if any(f.endswith('_' + safe + '.json') for f in os.listdir(d)): return {'ok': True, 'skipped': 'already saved today'}
    v = info()
    doc = {'firstContact': str(key), 'family': family, 'reason': str(reason)[:500], 'when': datetime.datetime.now().isoformat(timespec='seconds'),
           'version': {k: v[k] for k in ('version', 'build', 'channel', 'alpha')}, 'host': host, 'data': data, 'records': _related(host)}
    p = os.path.join(d, time.strftime('%H%M%S_') + safe + '.json')
    with open(p, 'w', encoding='utf-8') as f: json.dump(doc, f, indent=1, ensure_ascii=False, default=str)
    wirelog.mark('First contact saved: %s (%s)' % (key, str(reason)[:120]), source='alpha')
    return {'ok': True, 'file': os.path.relpath(p, wirelog.DIAG_DIR).replace('\\', '/')}


def on_error(path, request, exc, where):
    """A helper bug (not a device's answer): what led to it, kept once per route and exception type. Network errors
    (refused, unreachable, timed out: OSError) are a processor not answering, not a bug: no snapshot."""
    if isinstance(exc, OSError): return {'ok': True, 'skipped': 'network error'}
    host =request.get('req', {}).get('host') if isinstance(request.get('req'), dict) else None
    key = 'error-%s-%s' % (str(path).strip('/').replace('/', '-'), type(exc).__name__)
    try: return first_contact(key, '%s: %s' % (type(exc).__name__, exc), {'request': request, 'traceback': where}, host=host, family='helper error')
    except OSError: return {'ok': False}


EXPECTED_ERRORS = ('LinkError', 'LinkLost', 'LinkBusy', 'UnicoError', 'CoexError')   # a processor's answer / not answering


def unexpected(exc):
    """True for a helper bug (the app then offers to make a report); False for the expected failures: a processor that
    didn't answer (OSError: refused, unreachable, timed out) or answered with an error (LinkError, UnicoError, CoexError)."""
    return not isinstance(exc, OSError) and not any(c.__name__ in EXPECTED_ERRORS for c in type(exc).__mro__)


def session_files(days=None):
    """[(name in the report, path)] of the session subfolders (first-contact/, vendor/ …) of the last `days` days."""
    days = info()['keepDays'] if days is None else days
    cut = time.strftime('%Y-%m-%d', time.localtime(time.time() - days * 86400))
    out = []
    if not os.path.isdir(wirelog.DIAG_DIR): return out
    for day in sorted(os.listdir(wirelog.DIAG_DIR)):
        if not re.match(r'^\d{4}-\d\d-\d\d$', day) or day < cut: continue
        for sub in SESSION_DIRS:
            base = os.path.join(wirelog.DIAG_DIR, day, sub)
            for root, _, fs in os.walk(base):
                for f in sorted(fs):
                    p = os.path.join(root, f)
                    out.append(('session/%s/%s' % (day, os.path.relpath(p, os.path.join(wirelog.DIAG_DIR, day)).replace('\\', '/')), p))
    return out


# ------------------------------------------------------------------ keeping the disk in check (alpha only)
def prune(now=None):
    v = info()
    if not v['alpha']: return []
    now = now or time.time(); cut = time.strftime('%Y-%m-%d', time.localtime(now - int(v['keepDays']) * 86400))
    removed, cur = [], wirelog.status().get('file')
    D = wirelog.DIAG_DIR
    days = sorted(x for x in (os.listdir(D) if os.path.isdir(D) else []) if re.match(r'^\d{4}-\d\d-\d\d$', x))
    for day in days:
        if day < cut:
            shutil.rmtree(os.path.join(D, day), ignore_errors=True); removed.append(day)
    files = []
    for day in days:
        for root, _, fs in os.walk(os.path.join(D, day)):
            for f in fs:
                p = os.path.join(root, f)
                try: files.append((os.path.getmtime(p), os.path.getsize(p), p))
                except OSError: pass
    total, cap = sum(x[1] for x in files), int(v['keepMB']) * 1024 * 1024
    mine = ('_%d.' % os.getpid(), '_%d_' % os.getpid())   # this helper run's recordings (rotated ones too) and side files
    for _, n, p in sorted(files):
        if total <= cap: break
        if cur and os.path.abspath(p) == os.path.abspath(cur): continue
        if any(m in os.path.basename(p) for m in mine): continue   # never the session being recorded
        try: os.remove(p); total -= n; removed.append(os.path.relpath(p, D))
        except OSError: pass
    if os.path.isdir(LOG_DIR):
        for f in os.listdir(LOG_DIR):
            p = os.path.join(LOG_DIR, f)
            try:
                if f.endswith('.txt') and os.path.getmtime(p) < now - int(v['keepDays']) * 86400: os.remove(p); removed.append('novalink_logs/' + f)
            except OSError: pass
    if removed: wirelog.mark('Alpha keeps %s days / %s MB of recordings: %d old item(s) removed' % (v['keepDays'], v['keepMB'], len(removed)), source='alpha')
    return removed


def prune_daily():
    def go():
        while True:
            try: prune()
            except Exception:  # noqa: BLE001 - housekeeping must never stop the helper
                pass
            time.sleep(6 * 3600)
    threading.Thread(target=go, daemon=True).start()


# ------------------------------------------------------------------ scrubbing + anonymising
_SCRUB = [
    (re.compile(r'(\\?"(?:password|passwd|pwd|pass|passcode|token|accessToken|access_token|refreshToken|authorization|secret|unlockCode|unlock|username|cookie|sessionId|session_id)\\?"\s*:\s*\\?")[^"\\]*(?:\\.[^"\\]*)*?(\\?")', re.I), r'\1<hidden>\2'),
    (re.compile(r"('(?:password|passwd|pwd|token|authorization|secret|username)'\s*:\s*')[^']*(')", re.I), r'\1<hidden>\2'),
    (re.compile(r'((?:authorization|cookie|set-cookie|x-auth-token)\s*:\s*)[^\r\n"\\]+', re.I), r'\1<hidden>'),
    (re.compile(r'([?&](?:token|password|pwd|access_token|sessionid|key)=)[^&\s"\\]+', re.I), r'\1<hidden>'),
]


def scrub(t):
    for rx, rep in _SCRUB: t = rx.sub(rep, t)
    return t


PRIVATE_IP = re.compile(r'(?<![\d.])(?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168|169\.254|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?!\d)(?!\.\d)')


def _letters(n):
    s = ''
    n += 1
    while n: n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s


class Anon:
    """Private IPv4 addresses -> device-A, device-B … in order of first appearance over all the texts (the same address is
    the same name in every file); the computer's home folder -> ~. Also the ASCII form inside hex dumps (as ****)."""
    def __init__(self, texts):
        self.map = {}
        for t in texts:
            for m in PRIVATE_IP.finditer(t):
                if m.group(0) not in self.map: self.map[m.group(0)] = 'device-' + _letters(len(self.map))
        homes = [os.path.expanduser('~')]
        if sys.platform == 'win32':   # also its short form (C:\Users\BLUEIR~1 in temp paths)
            try:
                import ctypes
                b = ctypes.create_unicode_buffer(520)
                if ctypes.windll.kernel32.GetShortPathNameW(homes[0], b, 520): homes.append(b.value)
            except (OSError, AttributeError, ValueError): pass
        self.homes = sorted({x for h in homes for x in (h, h.replace('\\', '/'), h.replace('\\', '\\\\'), h.replace('\\', '\\\\\\\\')) if len(x) > 3}, key=len, reverse=True)

    def text(self, t):
        for h in self.homes: t = t.replace(h, '~')
        t = PRIVATE_IP.sub(lambda m: self.map.get(m.group(0), 'device-?'), t)
        for ip in self.map:
            hx = ip.encode('ascii').hex()
            if hx in t: t = t.replace(hx, '2a' * len(ip))
        return t


# ------------------------------------------------------------------ the report
def report_dir():
    o = os.environ.get('OPENNOVA_REPORT_DIR')
    if o: return o
    dl = os.path.join(os.path.expanduser('~'), 'Downloads')
    return dl if os.path.isdir(dl) else os.path.join(NOVA, 'reports')


def _hex(v):
    try: return '0x%04X' % int(v)
    except (TypeError, ValueError): return str(v) if v not in (None, '') else '—'


def _cell(v):
    return str('—' if v in (None, '', []) else v).replace('|', '/').replace('\n', ' ')


def _hm(t):
    return datetime.datetime.fromtimestamp(t).strftime('%H:%M:%S.%f')[:12] if isinstance(t, (int, float)) else str(t or '')


def timeline(records, limit=200):
    out = []
    for r in records:
        k = r.get('kind')
        if k == 'conn': x = '%s %s%s%s' % (r.get('link'), r.get('event'), ' (%s ms)' % r['ms'] if r.get('ms') is not None else '', ': ' + r['error'] if r.get('error') else '')
        elif k == 'err': x = '%s ERROR %s%s' % (r.get('link'), r.get('error'), ' — ' + r['req'] if r.get('req') else '')
        elif k == 'mark': x = '%s: %s' % (r.get('source'), r.get('text'))
        elif k == 'udp' and r.get('dir') == 'rx': x = 'discovery reply from %s (%s)%s' % (r.get('peer'), r.get('proto'), ': ' + r['text'][:80] if r.get('text') else '')
        elif k == 'op' and r.get('phase') == 'end' and not r.get('ok', True): x = 'request %s failed: %s' % (r.get('route'), r.get('error', ''))
        elif k == 'http' and (r.get('error') or (r.get('status') or 200) >= 400): x = '%s %s -> %s %s' % (r.get('method'), r.get('url'), r.get('status'), r.get('error') or '')
        elif k == 'op' and r.get('phase') == 'start' and r.get('act'): x = 'request %s%s' % (r.get('route'), ' — ' + r['what'] if r.get('what') else '')
        elif k == 'usb' and r.get('status'): x = '%s USB status %s' % (r.get('link'), r.get('status'))
        else: continue
        out.append('%s  %-4s  %s%s' % (_hm(r.get('t')), k, x, '  [action %s]' % r['act'] if r.get('act') else ''))
    return out[-limit:]


def actions(records, limit=60):
    """Per app action (the click / menu in the app that caused them): what it was, the helper requests, the frames, web
    calls and discovery packets it caused, the errors among them and how its requests ended. Oldest first."""
    acts, order = {}, []
    for r in records:
        a = r.get('act')
        if not a: continue
        x = acts.get(a)
        if x is None:
            x = acts[a] = {'act': a, 't0': r.get('t'), 't1': r.get('t'), 'what': '', 'routes': [], 'hosts': [], 'tx': 0, 'rx': 0, 'echo': 0, 'junk': 0,
                           'usb': 0, 'http': 0, 'udp': 0, 'err': 0, 'failed': [], 'ok': 0, 'refused': 0}
            order.append(a)
        x['t1'] = r.get('t') or x['t1']; k = r.get('kind')
        if k == 'op' and r.get('phase') == 'start':
            if r.get('what') and not x['what']: x['what'] = r['what']
            if r.get('route') not in x['routes']: x['routes'].append(r.get('route'))
            h = ((r.get('req') or {}).get('host')) if isinstance(r.get('req'), dict) else None
            if h and h not in x['hosts']: x['hosts'].append(str(h))
        elif k == 'op' and r.get('phase') == 'end':
            if r.get('ok'): x['ok'] += 1
            else: x['failed'].append(str(r.get('error') or 'failed')[:120])
        elif k == 'tg':   # a "no receiving card here" reply (nocard: the end of a chain walk) isn't an error
            x['tx' if r.get('dir') == 'tx' else 'rx'] += 1; dd = r.get('d') or {}
            x['err'] += 1 if (dd.get('status') and not r.get('nocard')) or dd.get('badsum') else 0
        elif k in ('echo', 'junk', 'usb', 'http', 'udp'):
            x[k] += 1
            if k == 'http' and (r.get('error') or (r.get('status') or 200) >= 400): x['err'] += 1
            if k == 'usb' and r.get('status'): x['err'] += 1
        elif k == 'err': x['err'] += 1
        elif k == 'mark' and 'Refused (read-only alpha)' in str(r.get('text')): x['refused'] += 1
        elif k == 'mark' and not x['what'] and r.get('source') in ('app', 'user'): x['what'] = str(r.get('text'))[:120]
    out = []
    for a in order[-limit:]:
        x = acts[a]
        res = 'REFUSED (read-only)' if x['refused'] else ('FAILED: ' + '; '.join(x['failed'][:2])) if x['failed'] else 'ok' if x['ok'] else '—'
        out.append({'act': a, 'time': _hm(x['t0']), 'ms': round(((x['t1'] or 0) - (x['t0'] or 0)) * 1000), 'what': x['what'] or ', '.join(x['routes']) or '—',
                    'requests': ', '.join(x['routes']), 'hosts': ', '.join(x['hosts']), 'frames': '%d / %d' % (x['tx'], x['rx']) + (' (+%d echo)' % x['echo'] if x['echo'] else ''),
                    'other': ', '.join('%d %s' % (x[k], n) for k, n in (('http', 'web'), ('udp', 'discovery'), ('usb', 'USB blocks'), ('junk', 'stray')) if x[k]) or '—',
                    'errors': x['err'], 'result': res})
    return out


PROMPT_KINDS = {'error': 'JavaScript error', 'rejection': 'unhandled promise failure', 'helper': 'helper error (HTTP 500)', 'driver': 'driver internal error'}


def rec_line(r):
    """One recorded record as a line: time, kind, what, [action]."""
    k = r.get('kind')
    if k in ('tg', 'echo'): x = '%s %s %s' % (r.get('link'), r.get('dir', ''), r.get('sum') or str(r.get('hex', ''))[:80])
    elif k == 'http': x = '%s %s -> %s%s' % (r.get('method'), r.get('url'), r.get('status'), ' ' + str(r['error']) if r.get('error') else '')
    elif k == 'op': x = 'request %s %s%s' % (r.get('route'), r.get('phase'), '' if r.get('phase') == 'start' else ' ok' if r.get('ok') else ' FAILED ' + str(r.get('error', '')))
    elif k == 'err': x = '%s ERROR %s' % (r.get('link'), r.get('error'))
    elif k == 'mark': x = '%s: %s' % (r.get('source'), r.get('text'))
    elif k == 'udp': x = 'discovery %s %s (%s)' % (r.get('dir'), r.get('peer'), r.get('proto'))
    elif k == 'conn': x = '%s %s%s' % (r.get('link'), r.get('event'), ': ' + str(r['error']) if r.get('error') else '')
    else: x = '%s %s' % (r.get('link', ''), r.get('dir', ''))
    return '%s  %-4s  %s%s' % (_hm(r.get('t')), k, str(x)[:240], '  [action %s]' % r['act'] if r.get('act') else '')


def prompt_frames(pr, records, window=30.0, limit=300):
    """The recorded records of the `window` s before the error that prompted a report, under its action id or a nearby
    one (pr['acts'], picked by the app). pr['t'] / pr['now'] are the browser's clock (ms): the error and the moment the
    report was asked for, so a browser on another computer with its clock off still lands on the right records."""
    acts = set(str(a) for a in (pr.get('acts') or []) if a)
    if pr.get('act'): acts.add(str(pr['act']))
    try: t = float(pr['t']) / 1000.0 + ((time.time() - float(pr['now']) / 1000.0) if pr.get('now') else 0.0)
    except (KeyError, TypeError, ValueError): t = time.time()
    hit = [r for r in records if r.get('act') in acts and isinstance(r.get('t'), (int, float)) and t - window <= r['t'] <= t + 2]
    return [rec_line(r) for r in hit][-limit:]


def prompt_md(pr, frames):
    """REPORT.md's first section when an error caught in the app prompted the report: the error, then the app log and the
    recorded frames of the 30 s before it under the same or nearby action ids."""
    if not pr or not isinstance(pr, dict): return []
    try: when = datetime.datetime.fromtimestamp(float(pr['t']) / 1000.0).strftime('%Y-%m-%d %H:%M:%S.%f')[:23]
    except (KeyError, TypeError, ValueError, OSError): when = str(pr.get('t') or '?')
    acts = [str(a) for a in pr.get('acts') or [] if a]
    L = ['', '## Error that prompted this report', '', '| | |', '|---|---|',
         '| Time | %s (the browser\'s clock) |' % when,
         '| Action | %s%s |' % (_cell(pr.get('act') or 'none (not in a click)'), ' — ' + _cell(pr.get('what'))[:100] if pr.get('what') else ''),
         '| Kind | %s%s |' % (PROMPT_KINDS.get(pr.get('kind'), _cell(pr.get('kind'))), ' · ' + _cell(pr.get('path')) if pr.get('path') else ''),
         '| Message | %s |' % _cell(pr.get('message'))[:500], '']
    st = str(pr.get('stack') or '').strip()
    L += ['Stack:', '', '```'] + (st.splitlines()[:40] or ['(none)']) + ['```', '']
    lg = [str(x) for x in pr.get('log') or []][-200:]
    L += ['### The 30 s before it%s' % (' (actions %s)' % ', '.join(acts) if acts else ''), '', 'App log:', '', '```'] + (lg or ['(no entries)']) + ['```', '',
          'Recorded (helper):', '', '```'] + (frames or ['(nothing recorded under these actions)']) + ['```', '']
    return L


def report_md(p, h):
    """REPORT.md: the page someone reads first. p = the app's payload, h = what the helper adds."""
    v, S = h['info'], p.get('summary') or {}
    app, found, devs = S.get('app') or {}, S.get('found') or [], S.get('devices') or []
    L = ['# Open Nova problem report', '',
         '%s · build %s · %s · writing %s' % (v['version'], v['build'], 'alpha' if v['alpha'] else v['channel'],
                                             'UNLOCKED' if app.get('unlocked') else 'locked (read-only)' if h['readOnly'] else 'allowed (not an alpha read-only build)'),
         'Made %s on the helper\'s computer' % h['when']]
    t = h.get('tester') or {}
    if t.get('name') or t.get('contact'): L.append('Tester: %s %s' % (t.get('name') or '', '<%s>' % t['contact'] if t.get('contact') else ''))
    if contact_ok(v.get('reportContact')): L.append('Send this report to: %s' % v['reportContact'])
    if h.get('helperDown'):
        L += ['', '> **The hardware helper was not running** (%s). The app server made this report: the processor read-backs, '
              'the helper\'s errors and its list of writes are missing. The newest recordings on this computer and the start '
              'window\'s text are included.' % _cell(h['helperDown'])]
    L += prompt_md(p.get('prompt'), h.get('prompt') or [])
    L += ['', '## What happened', '', (p.get('text') or '(nothing written)').strip(), '']
    unknown = [x for x in found if x.get('known') is False] + [d for d in devs if d.get('known') is False]
    fc_new = [f for f in h['firstContacts'] if '_error-' not in f]
    if unknown or fc_new:
        L += ['## ⚠ UNKNOWN MODELS — support needed', '']
        for x in found:
            if x.get('known') is False:
                L.append('- **Found, not in the catalogue:** %s %s — %s, ModelID %s%s%s' % (x.get('kind'), _cell(x.get('ip')) + (':%s' % x['port'] if x.get('port') else ''),
                         _cell(x.get('name')), _hex(x.get('modelId')), ', cards ' + ' '.join(_hex(s) for s in x['senders']) if x.get('senders') else '',
                         ' (' + x['why'] + ')' if x.get('why') else ''))
        for d in devs:
            if d.get('known') is False: L.append('- **In the project, model unknown:** %s (%s)' % (_cell(d.get('name')), _cell(d.get('modelName'))))
        for f in fc_new: L.append('- First-contact snapshot: `%s`' % f)
        L.append('')
    L += ['## System', '', '| | |', '|---|---|',
          '| Open Nova | %s |' % h['line'], '| Helper OS | %s |' % h['platform'], '| Python | %s |' % h['python'],
          '| Browser | %s |' % _cell(app.get('browser')), '| Window | %s |' % _cell(app.get('screen')),
          '| App address | %s |' % _cell(app.get('url')), '| Project | %s (%s, %s) |' % (_cell(app.get('project')), _cell(app.get('mode')), _cell(app.get('tab'))),
          '| Recorder | %s |' % h['recorder'], '']
    L += ['## Processors found (discovery)', '']
    if found:
        L += ['| Kind | Address | Name | ModelID | Cards (ModelIDs) | Serial | Firmware | Known |', '|---|---|---|---|---|---|---|---|']
        for x in found:
            L.append('| %s | %s | %s | %s | %s | %s | %s | %s |' % (_cell(x.get('kind')), _cell(x.get('ip')) + (':%s' % x['port'] if x.get('port') not in (None, '') else ''),
                     _cell(x.get('name')), _hex(x.get('modelId')), ' '.join(_hex(s) for s in x.get('senders') or []) or '—', _cell(x.get('sn')),
                     _cell(x.get('firmware')), 'yes · ' + _cell(x.get('model')) if x.get('known') else '**NO**' if x.get('known') is False else '?'))
    else: L.append('Nothing found (or no search was run).')
    L += ['', '## Processors in the project', '']
    if devs:
        L += ['| Name | Model | Link | ModelIDs | Firmware | Receiving cards | Detected |', '|---|---|---|---|---|---|---|']
        for d in devs:
            k = d.get('link') or {}
            L.append('| %s | %s | %s | %s | %s | %s | %s |' % (_cell(d.get('name')), _cell(d.get('modelName')),
                     '%s %s%s' % (k.get('kind'), k.get('host'), ':%s' % k['port'] if k.get('port') not in (None, '', 0) else '') if k else 'not linked',
                     ' '.join(_hex(s) for s in k.get('senders') or []) or _hex(k.get('modelId')) if k else '—', _cell(d.get('firmware')),
                     _cell('; '.join(d.get('cards') or [])), _cell(d.get('detected'))))
    else: L.append('No processors in the project.')
    mon = S.get('monitor') or []
    if mon:   # Monitor's errors kept until Clear, as the tester saw them (still going first)
        L += ['', '## Monitor (errors kept until Clear)', '', '| Since | Ended | Level | Processor | Where | Event | Times |', '|---|---|---|---|---|---|---|']
        for e in mon[:60]:
            L.append('| %s | %s | %s | %s | %s | %s | %s |' % (_cell(str(e.get('t') or '')[11:19]), _cell(str(e.get('ended'))[11:19]) if e.get('ended') else 'going on',
                     _cell(e.get('level')), _cell(e.get('dev')), _cell(e.get('where')), _cell(e.get('text')), _cell(e.get('n') or 1)))
    W = h['writes']
    L += ['', '## Writes to processors this session', '']
    L.append('Writing was %s.%s' % ('unlocked in the browser that made this report' if app.get('unlocked') else 'locked (read-only)' if h['readOnly'] else 'allowed',
             ' Unlock / lock: ' + '; '.join('%s %s' % (e.get('t', ''), e.get('what', '')) for e in app.get('lockEvents') or []) if app.get('lockEvents') else ''))
    if W:
        L += ['', '| Time | Action | Kind | Request | Processor | What | Result |', '|---|---|---|---|---|---|---|']
        for w in W[-100:]:
            L.append('| %s | %s | %s | %s | %s | %s | %s |' % (_hm(w['t']), _cell(w.get('act')), w['kind'], w['path'], _cell(w['host']), _cell(w['what']),
                     ('sent (unlocked)' if w.get('unlocked') else 'sent') if w['allowed'] else 'REFUSED (read-only, in the app)' if w.get('where') == 'app' else 'REFUSED (read-only)'))
    else: L += ['', 'None.']
    st = h['status']; c = st.get('counts') or {}
    L += ['', '## Errors this session', '',
          'Recorder: %d frames, %d errors, %d echoes, %d late replies / junk, %d web calls, %d discovery packets.' % (
              c.get('tg', 0), c.get('err', 0), c.get('echo', 0), c.get('junk', 0), c.get('http', 0), c.get('udp', 0)), '']
    links = st.get('links') or {}
    if links:
        # "No card" = receiving-card reads answered "no card here" (ack 1): the end of every chain walk, not an error
        L += ['| Link | Sent | Received | Errors | No card (end of chain) | Reply ms (avg / max) | Last error |', '|---|---|---|---|---|---|---|']
        for k, x in sorted(links.items()):
            L.append('| %s | %s | %s | %s | %s | %s / %s | %s |' % (_cell(k), x['tx'], x['rx'], x['err'], x.get('nocard', 0), _cell(x.get('rtt_avg')), _cell(x.get('rtt_max')), _cell(x.get('last_err'))))
        L.append('')
    be, fc = S.get('errors') or [], S.get('failedCalls') or []
    if be:
        L += ['Browser errors (last %d):' % min(len(be), 20), ''] + ['- %s %s: %s' % (e.get('t', ''), e.get('action', ''), _cell(e.get('text'))[:300]) for e in be[-20:]] + ['']
    if fc:
        L += ['Failed helper calls (last %d):' % min(len(fc), 30), ''] + ['- %s %s (%s ms): %s' % (e.get('t', ''), e.get('path', ''), e.get('ms', ''), _cell(e.get('error'))[:300]) for e in fc[-30:]] + ['']
    he = h['helperErrors']
    L += ['## Helper errors (last %d, with tracebacks)' % len(he), '']
    if he:
        for e in he:
            L += ['### %s %s' % (_hm(e.get('t')), e.get('error', '')), '', '```'] + [str(x) for x in (e.get('where') or [])] + ['```', '']
    else: L += ['None.', '']
    fc_err = [f for f in h['firstContacts'] if '_error-' in f]
    if fc_err: L += ['What led to them (snapshots):', ''] + ['- `%s`' % f for f in fc_err] + ['']
    A = h.get('actions') or []
    L += ['## Actions (what you did in the app → what went to the processors)', '']
    if A:
        L += ['Each click / menu in the app has an action id; every request, frame and web call it caused carries it (Tools ▸',
              'Diagnostics ▸ All actions filters by it; `act` in the recordings).', '',
              '| Time | Action | What | Processor | Frames sent / got | Other | Errors | ms | Result |', '|---|---|---|---|---|---|---|---|---|']
        for x in A:
            L.append('| %s | %s | %s | %s | %s | %s | %s | %s | %s |' % (x['time'], x['act'], _cell(x['what'])[:80], _cell(x['hosts']), x['frames'], _cell(x['other']),
                     ('**%d**' % x['errors']) if x['errors'] else '0', x['ms'], _cell(x['result'])))
        L.append('')
    else: L += ['None recorded in this helper run (or the app is older than the action ids).', '']
    L += ['## Connection timeline (last 200)', '', '```'] + (h['timeline'] or ['(nothing yet)']) + ['```', '']
    L += h.get('vendor') or []     # NovaStar apps on this computer (tools/vendortap.py report_md)
    L += (h.get('network') or []) + ([''] if h.get('network') else [])   # Settings > Network: interfaces, what is searched (netif.report_md)
    L += (h.get('machine') or []) + ([''] if h.get('machine') else [])   # this computer: CPU, Python, USB libraries, drivers, ports, firewall (sysdiag)
    L += ['## Files in this report', ''] + ['- `%s`%s' % (n, ' (binary, not scrubbed / anonymised)' if b else '') for n, b in h['files']] + ['']
    if h.get('left'):
        L += ['## Left out (the report is kept under %d MB for e-mail)' % h.get('maxMB', REPORT_MAX_MB), '',
              'Still on the computer that made the report; ask the tester for them if they matter.', '']
        L += ['- `%s` (%s)' % (n, _mb(b)) for n, b in h['left']] + ['']
    return '\n'.join(L)


def _session_records(sess):
    """This helper run's recordings (wirelog.session(), newest file first) as records, oldest first: the actions table
    sees more than the in-memory ring (a long Send has thousands of frames)."""
    out = []
    for r in reversed(sess or []):
        for line in r['text'].splitlines():
            try: out.append(json.loads(line))
            except ValueError: continue
    return out


def _mtime(path):
    try: return os.path.getmtime(path)
    except OSError: return 0.0


def _mb(n):
    return '%.1f MB' % (n / 1048576.0) if n >= 1048576 else '%d KB' % max(1, n // 1024)


def _fit(files, extra, cap):
    """The size cap: `files` (the essentials: REPORT.md, the app's side, the helper's) always go in; each of `extra`
    (priority order: processor snapshots, recordings newest first, logs, session files, NovaStar apps' logs) is appended
    to files while the compressed total stays under cap bytes. -> [(name, uncompressed bytes)] left out."""
    def z(b):
        b = b if isinstance(b, bytes) else b.encode('utf-8', 'replace')
        return len(zlib.compress(b, 6)) + 120 + len(b) // 4096   # + the zip entry's headers
    total, left = sum(z(b) for _, b in files) + 64 * 1024, []   # 64 KB: REPORT.md and the helper files added after
    for n, b in extra:
        k = z(b)
        if total + k > cap: left.append((n, len(b))); continue
        total += k; files.append((n, b))
    return left


def contact_ok(c):
    """A real report address (not empty, not the "(contact address to be filled in)" placeholder of a build without --contact)."""
    c = str(c or '').strip()
    return bool(c) and not c.startswith('(') and ('@' in c or '://' in c)


def _recent_recordings(n=2, max_each=8 * 1024 * 1024):
    """The newest n recordings on this computer, whoever made them (the helper isn't running: its run's files are among
    them), as wirelog.session() gives them."""
    import gzip
    out = []
    for f in sorted(wirelog.files(), key=lambda f: -f['mtime'])[:n]:
        try:
            p = wirelog.path_of(f['name'])
            with (gzip.open(p, 'rb') if p.endswith('.gz') else open(p, 'rb')) as fh: b = fh.read()
        except (OSError, KeyError): continue
        cut = len(b) > max_each
        if cut: b = b[-max_each:]; b = b[b.find(b'\n') + 1:]
        out.append({'name': f['name'], 'text': b.decode('utf-8', 'replace'), 'n': f['size'], 'cut': cut})
    return out


def _safe(t, n=40):
    return re.sub(r'[^\w.-]+', '_', str(t or '')).strip('_')[:n] or 'x'


def build_report(p, out_dir=None, helper_logs=8):
    """p = {text, include: {project, recordings, logs, processors, system}, anonymise, files: [{name, text}], summary,
    prompt?: the error that prompted it {t, now, act, acts, what, kind, path, message, stack, log}}.
    -> {ok, name, path, dir, bytes, files, unknown, os, version, build}"""
    inc = dict({'project': True, 'recordings': True, 'logs': True, 'processors': True, 'system': True}, **(p.get('include') or {}))
    v, now = info(), datetime.datetime.now()
    if inc['recordings'] and 'netcap' in sys.modules:   # a vendor app being recorded now: what is recorded so far goes in too
        try: sys.modules['netcap'].flush()
        except Exception as e:  # noqa: BLE001 - the report is made anyway
            wirelog.mark('Network recording not saved before the report: %s: %s' % (type(e).__name__, e), source='vendor')
    files = [('app/' + str(f.get('name', 'x')).lstrip('/'), str(f.get('text', ''))) for f in p.get('files') or [] if f and f.get('name')]
    extra = {'snap': [], 'rec': [], 'logs': [], 'session': [], 'vendor': []}   # in the report while they fit (REPORT_MAX_MB), in this order
    st = wirelog.status()
    down = str(p.get('helperDown') or '')   # made by the app server (app/serve.py helper_down): the helper isn't running
    sess = (_recent_recordings() if down else wirelog.session()) if inc['recordings'] else []
    if inc['recordings']:
        for r in sess:            # newest first
            extra['rec'].append(('recordings/' + r['name'].replace('.gz', ''), r['text']))
            if r['cut']: extra['rec'].append(('recordings/' + r['name'].replace('.gz', '') + '.CUT.txt', 'Only the end of this recording is here (the whole file is %d bytes).' % r['n']))
        files.append(('recordings/recorder-status.json', json.dumps(st, indent=1, default=str)))
    if inc['logs'] or inc['system']:   # the start window's text (opennova.py): start-up errors are printed there only
        for n in (CONSOLE_LOG, os.path.join(os.path.dirname(CONSOLE_LOG), 'console-previous.txt')):
            try:
                with open(n, 'rb') as f: b = f.read()
                files.append(('logs/' + os.path.basename(n), b[-200000:].decode('utf-8', 'replace')))
            except OSError: pass
    if inc['logs'] and os.path.isdir(LOG_DIR):
        for n in sorted((n for n in os.listdir(LOG_DIR) if n.endswith('.txt')), reverse=True)[:helper_logs]:
            try:
                with open(os.path.join(LOG_DIR, n), 'rb') as f: b = f.read()
                extra['logs'].append(('logs/helper/' + n, b[-400000:].decode('utf-8', 'replace')))
            except OSError: pass
    vend = []                     # NovaStar's own apps on this computer (tools/vendortap.py); their logs only when ticked (include.vendorLogs)
    if inc['system'] or inc.get('vendorLogs'):
        try:
            import vendortap
            if inc['system']: vend = vendortap.report_md()
            extra['vendor'] += vendortap.report_files(bool(inc.get('vendorLogs')))
        except Exception as e:  # noqa: BLE001 - the report is made anyway
            files.append(('vendor/ERROR.txt', 'NovaStar apps / logs not collected: %s: %s' % (type(e).__name__, e)))
    net = []                      # Settings > Network: this computer's interfaces, what is searched, the app's bind, changes
    if inc['system']:
        try:
            import netif
            net = netif.report_md(); files.append(('helper/network.json', json.dumps(netif.report(), indent=1, default=str)))
        except Exception as e:  # noqa: BLE001 - the report is made anyway
            files.append(('helper/network-ERROR.txt', 'Networks not collected: %s: %s' % (type(e).__name__, e)))
    machine = []                  # this computer: OS, CPU, the Python, USB libraries tried, USB / COM drivers, search ports, firewall
    if inc['system']:
        try:
            import sysdiag
            sd = sysdiag.report(); machine = sysdiag.report_md(sd)
            files.append(('helper/system.json', json.dumps(sd, indent=1, default=str)))
        except Exception as e:  # noqa: BLE001 - the report is made anyway
            files.append(('helper/system-ERROR.txt', 'This computer not described: %s: %s' % (type(e).__name__, e)))
    fcs = []
    for name, path in sorted(session_files(), key=lambda x: -_mtime(x[1])):   # newest first
        sub = name.split('/')[2]
        if (sub == 'first-contact' and not inc['processors']) or (sub != 'first-contact' and not inc['recordings']): continue
        try:
            if os.path.getsize(path) > 16 * 1024 * 1024: files.append((name + '.TOO-BIG.txt', 'Left out: %d bytes. It is in %s' % (os.path.getsize(path), path))); continue
            with open(path, 'rb') as f: b = f.read()
        except OSError: continue
        try: b = b.decode('utf-8')
        except UnicodeDecodeError: pass                                 # binary (a capture): as it is
        extra['snap' if sub == 'first-contact' else 'session'].append((name, b))
        if sub == 'first-contact': fcs.append(name)
    left = _fit(files, [x for k in ('snap', 'rec', 'logs', 'session', 'vendor') for x in extra[k]], int(p.get('maxMB') or REPORT_MAX_MB) * 1024 * 1024)
    fcs = [n for n in fcs if n not in {x[0] for x in left}]
    he = [dict(e) for e in wirelog.helper_errors()][-50:]
    recs = _session_records(sess) or wirelog.frames(0, wirelog.RING)
    tester = (settings().get('consent') or {}) if inc['system'] else {}
    h = {'info': v, 'line': version_line(), 'readOnly': read_only(), 'when': now.strftime('%Y-%m-%d %H:%M'), 'tester': tester,
         'platform': platform.platform() if inc['system'] else '(left out)', 'python': sys.version.split()[0] if inc['system'] else '(left out)',
         'recorder': 'the helper was not running' if down else '%s, file %s' % ('on' if st.get('enabled') else 'OFF', os.path.basename(st.get('file') or '') or '—'),
         'helperDown': down,
         'status': st, 'helperErrors': he, 'writes': writes(), 'timeline': timeline(wirelog.frames(0, wirelog.RING)), 'firstContacts': fcs,
         'actions': actions(recs), 'prompt': prompt_frames(p['prompt'], recs) if isinstance(p.get('prompt'), dict) else [],
         'files': [(n, isinstance(b, bytes)) for n, b in files], 'vendor': vend, 'network': net, 'machine': machine, 'left': left,
         'maxMB': int(p.get('maxMB') or REPORT_MAX_MB)}
    if not inc['system']: (p.get('summary') or {}).get('app', {}).update(browser='(left out)', screen='(left out)')
    files.insert(0, ('REPORT.md', report_md(p, h)))
    files.append(('helper/version.json', json.dumps(dict(v, line=version_line(), python=h['python'], platform=h['platform']), indent=1)))
    files.append(('helper/helper-errors.json', json.dumps(he, indent=1, default=str)))
    texts = [(n, scrub(b)) if isinstance(b, str) else (n, b) for n, b in files]
    if p.get('anonymise'):
        an = Anon([b for _, b in texts if isinstance(b, str)])
        texts = [(n, an.text(b)) if isinstance(b, str) else (n, b) for n, b in texts]
    S = p.get('summary') or {}
    model = next((d.get('modelName') for d in S.get('devices') or [] if d.get('link') and d.get('modelName')), None) or \
        next((x.get('model') or x.get('name') for x in S.get('found') or []), None) or 'no-processor'
    name = 'OpenNova-report-%s-%s-%s.zip' % (_safe(v['version'], 24), now.strftime('%Y%m%d-%H%M'), _safe(model, 30))
    d = out_dir or report_dir(); os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name); k = 2
    while os.path.exists(path): path = os.path.join(d, name[:-4] + '-%d.zip' % k); k += 1
    top = name[:-4] + '/'
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for n, b in texts: z.writestr(top + n, b if isinstance(b, bytes) else b.encode('utf-8'))
    wirelog.mark('Problem report saved: %s (%d files)' % (os.path.basename(path), len(texts)), source='alpha')
    return {'ok': True, 'name': os.path.basename(path), 'path': path, 'dir': d, 'bytes': os.path.getsize(path), 'files': len(texts),
            'os': '%s %s' % (platform.system(), platform.release()), 'version': v['version'], 'build': v['build'],   # for the app's issue text
            'unknown': len([x for x in S.get('found') or [] if x.get('known') is False]) + len([f for f in fcs if '_error-' not in f]),
            'leftOut': len(left), 'helperDown': down or None}


def report_path(name):
    """A report made by this helper, by file name (the download link)."""
    n = os.path.basename(str(name))
    p = os.path.join(report_dir(), n)
    if not re.match(r'^OpenNova-report-[\w.-]+\.zip$', n) or not os.path.isfile(p): raise KeyError('no such report')
    return p


def reveal_cmd(path, plat=None):
    """The command that opens the OS file manager on a file (selected where the OS can) or folder."""
    plat, f = plat or sys.platform, os.path.isfile(path)
    if plat == 'win32': return ['explorer', '/select,', path] if f else ['explorer', path]
    if plat == 'darwin': return ['open', '-R', path] if f else ['open', path]
    return ['xdg-open', os.path.dirname(path) if f else path]


def reveal(path):
    import subprocess
    subprocess.Popen(reveal_cmd(path))
