"""fake_hweb.py - a stand-in for an H series' web API (tools/hweb.py), for tests and for trying Open Nova without an H.
Answers only what Open Nova reads, shaped like an H2 / H5 (web UI V2.2.0.1): /api/user/login (user name
and password in the web page's DES form), /api/main/initStatus, /api/output/readAllList; any other call or a missing /
wrong token -> status 1. Stdlib only.

    python fake_hweb.py [--bind 127.0.0.1] [--port 18080] [--model 29963] [--cards 1:0x7B46,2:0x7B48] [--password test1234]
--model = mainModelId (29965 H2, 29963 H5); --cards = slot:ModelID of each LED output card (an HDMI output card is added
in the next slot). The user is "admin". Point the helper at it with OPENNOVA_HWEB_PORT=<port> (hweb.PORT).
"""
import json
import os
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hweb   # noqa: E402  (web_cipher)


class FakeH:
    def __init__(self, model=29963, cards=((1, 0x7B46),), user='admin', password='test1234'):
        self.model, self.cards, self.tokens, self.logins = model, list(cards), set(), 0
        self.cred = (hweb.web_cipher(user), hweb.web_cipher(password))

    def answer(self, path, body, token):
        if path == '/api/user/login':
            if body.get('username') != self.cred[0]: return {'status': 101, 'msg': 'no user', 'data': None}
            if body.get('password') != self.cred[1]: return {'status': 102, 'msg': 'wrong password', 'data': None}
            t = uuid.uuid4().hex * 3; self.tokens.add(t); self.logins += 1
            return {'status': 0, 'msg': 'Success', 'data': {'token': t, 'userName': 'admin', 'isAdmin': 1, 'deviceId': 0}}
        if token not in self.tokens: return {'status': 1, 'msg': 'token invalid', 'data': None}
        if path == '/api/main/initStatus':
            return {'status': 0, 'msg': 'Success', 'data': {'mainModelId': self.model, 'hwVersion': 'V2.2.0.1', 'softwareVersion': '2.2.0.1',
                                                          'initStatus': 1, 'initDetail': {'rate': 100}}}
        if path == '/api/output/readAllList':
            out, oid = [], 0
            for slot, mid in self.cards:
                for i in range(4):
                    out.append({'outputId': oid, 'slotId': slot, 'interfaceId': i, 'modelId': mid, 'cardCategory': 1, 'name': 'output %d-%d' % (slot + 1, i + 1),
                                'isSubcardSupportDynamicSubpixel': 1 if mid == 0x7B46 else 0, 'dynamicSubpixelMode': 0}); oid += 1
            last = max([s for s, _ in self.cards] or [0]) + 1
            out.append({'outputId': oid, 'slotId': last, 'interfaceId': 0, 'modelId': 31553, 'cardCategory': 7, 'name': 'output %d-1' % (last + 1),
                        'isSubcardSupportDynamicSubpixel': 0, 'dynamicSubpixelMode': 0})
            return {'status': 0, 'msg': 'Success', 'data': out}
        return {'status': 1, 'msg': 'not in the fake', 'data': None}


def serve(fake, bind='127.0.0.1', port=0):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            try: body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            except ValueError: body = {}
            b = json.dumps(fake.answer(self.path, body, self.headers.get('token') or '')).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)

        def log_message(self, *a): pass
    srv = ThreadingHTTPServer((bind, port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main(argv):
    a = dict(zip(argv[0::2], argv[1::2]))
    cards = [(int(x.split(':')[0]), int(x.split(':')[1], 0)) for x in a.get('--cards', '1:0x7B46').split(',') if x]
    f = FakeH(int(a.get('--model', 29963)), cards, password=a.get('--password', 'test1234'))
    srv = serve(f, a.get('--bind', '127.0.0.1'), int(a.get('--port', 18080)))
    print('fake H web API on http://%s:%d (model %d, LED cards %s)' % (srv.server_address[0], srv.server_address[1], f.model, cards)); sys.stdout.flush()
    try: threading.Event().wait()
    except KeyboardInterrupt: pass
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
