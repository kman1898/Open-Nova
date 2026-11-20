"""hweb.py - the H series' own web API (HTTP port 80: what the H's web page and Unico's "splicer" pages use), read-only.
Open Nova uses it for what the TG link can't say (docs/OPEN_NOVA_DESIGN.md, online Add processor): which chassis this is and which
output cards sit in which slot. Stdlib only (Mac, Windows, Linux).

Protocol (the H web page's own traffic, seen on an H2 / H5 with V2.2.0.1, 2026-10-11; the same calls as Unico 2.8's splicer pages):
  POST /api/user/login {username, password, verifyId: '', verifyCode: '', deviceId: 0}: username and password each
       DES-ECB / PKCS7 with the web page's fixed key, base64 (checked: "admin" -> OlEjflmqZcU= as in the capture).
       Reply {status, msg, data: {token, userName, isAdmin …}}; status 0 = ok, 101 = no such user, 102 = wrong password.
  every other call: header "token: <data.token>", body {deviceId: 0}:
  POST /api/main/initStatus    -> data.mainModelId (29965 = 0x750D H2, 29963 = 0x750B H5), hwVersion, softwareVersion
  POST /api/output/readAllList -> data [{outputId, slotId, modelId, cardCategory (1 = LED, 7 = HDMI out), interfaceId,
       isSubcardSupportDynamicSubpixel, dynamicSubpixelMode, name}] (one entry per output connector)
Every call goes into the recorder (wirelog 'http'); the login request is recorded as "<login>" and tokens as "<token>".

Logins are kept on THIS computer only, never in a project and never under the Open Nova folder (it may be a synced
folder such as Nextcloud): <config dir>/h-logins.json, where the config dir is %APPDATA%\\OpenNova (Windows),
~/Library/Application Support/OpenNova (macOS), $XDG_CONFIG_HOME/opennova or ~/.config/opennova (Linux);
OPENNOVA_CONFIG_DIR overrides it (tests). The file holds, per H address, the user name and password in the web page's
own DES form — what the H asks for. The key is public (it's in the H's web page), so the file is as good as a saved
password: it is created 0600 on Mac / Linux and nothing of it is ever logged. A login is only ever sent to the address it
was saved for.

    python hweb.py info <host>          what the H reports (uses the saved login)
    python hweb.py forget <host>        remove the saved login for <host>
"""
import base64
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request

import wirelog

HERE = os.path.dirname(os.path.abspath(__file__))
NOVA = os.path.dirname(HERE)
WEB_KEY = b'mHAxsLYz'            # the H web page's DES key (the same in the web page and in Unico 2.8)
TIMEOUT = 3.0
PORT = int(os.environ.get('OPENNOVA_HWEB_PORT') or 80)   # 80 on every H; another only for a stand-in (tests)
_TOKENS, _LOCK = {}, threading.Lock()   # host -> token of the current web session (memory only)


class HWebError(Exception):
    pass


# ------------------------------------------------------------------ DES (FIPS 46-3), encryption only
_IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
       57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7]
_FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
       36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25]
_E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25,
      24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1]
_P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25]
_PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
        63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4]
_PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
        41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32]
_SH = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1]
_S = [
    '14 4 13 1 2 15 11 8 3 10 6 12 5 9 0 7 0 15 7 4 14 2 13 1 10 6 12 11 9 5 3 8 4 1 14 8 13 6 2 11 15 12 9 7 3 10 5 0 15 12 8 2 4 9 1 7 5 11 3 14 10 0 6 13',
    '15 1 8 14 6 11 3 4 9 7 2 13 12 0 5 10 3 13 4 7 15 2 8 14 12 0 1 10 6 9 11 5 0 14 7 11 10 4 13 1 5 8 12 6 9 3 2 15 13 8 10 1 3 15 4 2 11 6 7 12 0 5 14 9',
    '10 0 9 14 6 3 15 5 1 13 12 7 11 4 2 8 13 7 0 9 3 4 6 10 2 8 5 14 12 11 15 1 13 6 4 9 8 15 3 0 11 1 2 12 5 10 14 7 1 10 13 0 6 9 8 7 4 15 14 3 11 5 2 12',
    '7 13 14 3 0 6 9 10 1 2 8 5 11 12 4 15 13 8 11 5 6 15 0 3 4 7 2 12 1 10 14 9 10 6 9 0 12 11 7 13 15 1 3 14 5 2 8 4 3 15 0 6 10 1 13 8 9 4 5 11 12 7 2 14',
    '2 12 4 1 7 10 11 6 8 5 3 15 13 0 14 9 14 11 2 12 4 7 13 1 5 0 15 10 3 9 8 6 4 2 1 11 10 13 7 8 15 9 12 5 6 3 0 14 11 8 12 7 1 14 2 13 6 15 0 9 10 4 5 3',
    '12 1 10 15 9 2 6 8 0 13 3 4 14 7 5 11 10 15 4 2 7 12 9 5 6 1 13 14 0 11 3 8 9 14 15 5 2 8 12 3 7 0 4 10 1 13 11 6 4 3 2 12 9 5 15 10 11 14 1 7 6 0 8 13',
    '4 11 2 14 15 0 8 13 3 12 9 7 5 10 6 1 13 0 11 7 4 9 1 10 14 3 5 12 2 15 8 6 1 4 11 13 12 3 7 14 10 15 6 8 0 5 9 2 6 11 13 8 1 4 10 7 9 5 0 15 14 2 3 12',
    '13 2 8 4 6 15 11 1 10 9 3 14 5 0 12 7 1 15 13 8 10 3 7 4 12 5 6 11 0 14 9 2 7 11 4 1 9 12 14 2 0 6 10 13 15 3 5 8 2 1 14 7 4 10 8 13 15 12 9 0 3 5 6 11']
_S = [[int(v) for v in s.split()] for s in _S]


def _perm(x, tab, n):
    out = 0
    for t in tab: out = (out << 1) | ((x >> (n - t)) & 1)
    return out


def _subkeys(key):
    k = _perm(int.from_bytes(key, 'big'), _PC1, 64); c, d = k >> 28, k & 0xFFFFFFF; out = []
    for s in _SH:
        c = ((c << s) | (c >> (28 - s))) & 0xFFFFFFF; d = ((d << s) | (d >> (28 - s))) & 0xFFFFFFF
        out.append(_perm((c << 28) | d, _PC2, 56))
    return out


def des_block(b, ks):
    x = _perm(int.from_bytes(b, 'big'), _IP, 64); l, r = x >> 32, x & 0xFFFFFFFF
    for k in ks:
        t = _perm(r, _E, 32) ^ k; f = 0
        for i in range(8):
            v = (t >> (42 - 6 * i)) & 63
            f = (f << 4) | _S[i][(((v & 32) >> 4) | (v & 1)) * 16 + ((v >> 1) & 15)]
        l, r = r, l ^ _perm(f, _P, 32)
    return _perm((r << 32) | l, _FP, 64).to_bytes(8, 'big')


def web_cipher(text, key=WEB_KEY):
    """The web page's form of a user name / password: DES-ECB, PKCS7, base64 (CryptoJS.DES.encrypt with a Utf8 key)."""
    data = text.encode('utf-8'); n = 8 - len(data) % 8; data += bytes([n]) * n; ks = _subkeys(key)
    return base64.b64encode(b''.join(des_block(data[i:i + 8], ks) for i in range(0, len(data), 8))).decode('ascii')


# ------------------------------------------------------------------ the saved logins (this computer only)
def config_dir():
    d = os.environ.get('OPENNOVA_CONFIG_DIR')
    if not d:
        if sys.platform == 'win32': d = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'OpenNova')
        elif sys.platform == 'darwin': d = os.path.expanduser('~/Library/Application Support/OpenNova')
        else: d = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'opennova')
    d = os.path.abspath(d)
    # never inside the Open Nova folder (a synced folder such as Nextcloud would carry the logins to other computers)
    if os.path.normcase(d + os.sep).startswith(os.path.normcase(NOVA + os.sep)):
        raise HWebError('the login store would be inside the Open Nova folder (%s) — set OPENNOVA_CONFIG_DIR elsewhere' % d)
    return d


def _store():
    return os.path.join(config_dir(), 'h-logins.json')


def _load():
    try:
        with open(_store(), encoding='utf-8') as f: j = json.load(f)
        return j if isinstance(j, dict) else {}
    except (OSError, ValueError): return {}


def _save(all_):
    p = _store(); os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + '.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as f: json.dump(all_, f)
    os.replace(tmp, p)
    try: os.chmod(p, 0o600)
    except OSError: pass


def has_login(host): return str(host) in _load()


def forget(host):
    a = _load(); had = a.pop(str(host), None) is not None
    if had: _save(a)
    with _LOCK: _TOKENS.pop(str(host), None)
    return had


# ------------------------------------------------------------------ the web API
def _host_ok(host):
    h = str(host or '')
    if not h or ':' in h or '/' in h or ' ' in h: raise HWebError('not an H address: %r' % h[:40])
    return h


_SECRET = re.compile(rb'("(?:token|accessToken|access_token|password|username)"\s*:\s*")[^"]*(")', re.I)


def _masked(raw):
    """The login's answer, whole, with its token (and any user name / password) masked: the only thing left out."""
    return _SECRET.sub(rb'\1<hidden>\2', raw or b'')


NOPROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # a processor on the show network: never through a (system) proxy


def _post(host, path, body, token=None, login=False):
    url = 'http://%s%s/%s' % (host, '' if PORT == 80 else ':%d' % PORT, path.lstrip('/'))
    data = json.dumps(body, separators=(',', ':')).encode()
    r = urllib.request.Request(url, data=data, method='POST', headers={'Content-Type': 'application/json'})
    r.add_header('token', token or '')
    # the login's user name and password are never recorded (masked; the rest of the request is); the token header is masked too
    shown = json.dumps(dict(body, username='<hidden>', password='<hidden>'), separators=(',', ':')).encode() if login else data
    reqh = {'Content-Type': 'application/json', 'token': token or ''}
    t0 = time.time()
    try:
        with NOPROXY.open(r, timeout=TIMEOUT) as x: raw = x.read(); code = x.status; resph = dict(x.headers.items())
    except urllib.error.HTTPError as e:
        wirelog.http('POST', url, shown, e.code, _masked(e.read()) if login else e.read(), (time.time() - t0) * 1000, 'HTTP %d' % e.code, reqh, dict(e.headers.items()) if e.headers else None)
        raise HWebError('%s: HTTP %d' % (path, e.code))
    except OSError as e:
        wirelog.http('POST', url, shown, None, None, (time.time() - t0) * 1000, str(e), reqh)
        raise HWebError('%s: %s' % (path, getattr(e, 'reason', e)))
    try: j = json.loads(raw)
    except ValueError: j = None
    wirelog.http('POST', url, shown, code, _masked(raw) if login else raw, (time.time() - t0) * 1000, None, reqh, resph)
    if not isinstance(j, dict): raise HWebError('%s: the answer isn’t JSON' % path)
    return j


def _login(host, cred):
    j = _post(host, '/api/user/login', {'username': cred['u'], 'password': cred['p'], 'verifyId': '', 'verifyCode': '', 'deviceId': 0}, login=True)
    st = j.get('status')
    if st == 0 and isinstance(j.get('data'), dict) and j['data'].get('token'):
        with _LOCK: _TOKENS[host] = j['data']['token']
        return j['data']['token']
    raise HWebError({101: 'the H doesn’t know that user', 102: 'wrong password'}.get(st, 'login refused (status %s %s)' % (st, j.get('msg', ''))))


def _call(host, path, cred):
    """One read with the session token; a refused token logs in again once."""
    with _LOCK: tok = _TOKENS.get(host)
    if not tok: tok = _login(host, cred)
    j = _post(host, path, {'deviceId': 0}, tok)
    if j.get('status') != 0:
        tok = _login(host, cred); j = _post(host, path, {'deviceId': 0}, tok)
        if j.get('status') != 0: raise HWebError('%s: status %s %s' % (path, j.get('status'), j.get('msg', '')))
    return j.get('data')


def _read(host, cred):
    st = _call(host, '/api/main/initStatus', cred) or {}
    outs = _call(host, '/api/output/readAllList', cred) or []
    outs = [{'outputId': o.get('outputId'), 'slot': o.get('slotId'), 'modelId': o.get('modelId'), 'category': o.get('cardCategory'),
             'interface': o.get('interfaceId'), 'name': o.get('name') or (o.get('general') or {}).get('name'),
             'dynSubpixel': o.get('isSubcardSupportDynamicSubpixel'), 'dynSubpixelMode': o.get('dynamicSubpixelMode')}
            for o in (outs if isinstance(outs, list) else []) if isinstance(o, dict)]
    led = {}   # LED output cards by slot (cardCategory 1), in slot order
    for o in outs:
        if o['category'] == 1 and o['slot'] is not None and o['slot'] not in led: led[o['slot']] = {'slot': o['slot'], 'modelId': o['modelId'], 'dynSubpixel': o['dynSubpixel']}
    return {'ok': True, 'login': True, 'modelId': st.get('mainModelId'), 'hwVersion': st.get('hwVersion'), 'softwareVersion': st.get('softwareVersion'),
            'ledCards': [led[k] for k in sorted(led)], 'outputs': outs}


def info(host):
    """What the H reports, with the saved login. {ok:false, login:false} when none is saved (nothing is sent then)."""
    host = _host_ok(host); cred = _load().get(host)
    if not cred: return {'ok': False, 'login': False, 'error': 'no H login saved for %s on this computer' % host}
    try: return _read(host, cred)
    except HWebError as e:
        return {'ok': False, 'login': True, 'error': str(e)}


def login(host, username, password):
    """Try the login on that H; saved (this computer only) when the H accepts it. -> info(host) or {ok:false, error}."""
    host = _host_ok(host)
    cred = {'u': web_cipher(str(username or 'admin')), 'p': web_cipher(str(password or ''))}
    with _LOCK: _TOKENS.pop(host, None)
    try: _login(host, cred)
    except HWebError as e: return {'ok': False, 'login': False, 'error': str(e)}
    a = _load(); a[host] = cred; _save(a)
    try: return _read(host, cred)
    except HWebError as e: return {'ok': False, 'login': True, 'error': str(e)}


def main(argv):
    if len(argv) < 2 or argv[0] not in ('info', 'forget'): print(__doc__); return 2
    if argv[0] == 'info': print(json.dumps(info(argv[1]), indent=1)); return 0
    print('removed' if forget(argv[1]) else 'nothing saved for %s' % argv[1]); return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
