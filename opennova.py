"""opennova.py - start Open Nova on Windows, macOS or Linux: the hardware helper (tools/novalink.py, 127.0.0.1:8790) and
the app server (app/serve.py, port 8765), then open the app in the browser. Python 3.9+ only, nothing to install.

    python3 opennova.py [--port 8765] [--helper-port 8790] [--data-dir DIR] [--local-only] [--bind all|localhost|<interface>] [--no-browser] [--alpha]

Double-click instead: "Start Open Nova.command" (macOS), "Start Open Nova.bat" (Windows), start-open-nova.sh (Linux).
A helper or server of this same build already running on those ports is reused, not started twice; an Open Nova of
another build there is named (close its window first); a port taken by another program = the next free one, said in one
line. Close the window (or Ctrl+C) to stop. A helper that doesn't start or stops doesn't stop the app: it stays open so
Help > Report a problem can still be made (app/serve.py makes it without the helper).
Everything this window shows (its own lines and the helper's / server's) is also kept in <data>/logs/console.txt for
Help > Report a problem (the one before in console-previous.txt).
--alpha = the alpha's behaviour without an alpha package (read-only until unlocked, intro, recorder always on; docs/DIAGNOSTICS.md "The alpha build");
the alpha package has it built in (app/version.json channel "alpha").
--bind: which networks can open the app (app/serve.py); without it, this computer's Settings > Network choice (every network by default).
"""
import datetime
import errno
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
# calls to this computer never go through a proxy (a corporate laptop's system proxy, or HTTP_PROXY, would take 127.0.0.1 too)
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))
SPARE = 20                         # a taken port: the next free one of the following SPARE
# the helper didn't start or stopped: the app server keeps going (it makes Help > Report a problem itself: app/serve.py helper_down)
NO_HELPER = 'Open Nova opens anyway so you can send us a report: Help \u25b8 Report a problem (it says what is missing).'


def fetch(url, data=None, timeout=1.5):
    """(status, body) from a server on this computer, or None when nothing answers."""
    try:
        rq = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'} if data is not None else {})
        with LOCAL.open(rq, timeout=timeout) as r: return r.status, r.read(65536).decode('utf-8', 'replace')
    except urllib.error.HTTPError as e: return e.code, ''
    except Exception:  # noqa: BLE001 - "not there" in every form
        return None


def alive(url, want=None):
    r = fetch(url)
    return bool(r) and r[0] == 200 and (want is None or want in r[1])


def wait(url, want, secs, proc=None):
    """Until url answers with want, at most secs; False at once if proc (the process that should answer) has ended."""
    end = time.time() + secs
    while time.time() < end:
        if alive(url, want): return True
        if proc is not None and proc.poll() is not None: return False
        time.sleep(0.3)
    return False


def running(kind, port):
    """The Open Nova answering on port: None (nothing, or another program), else {version, build} ({} when it can't say:
    then it is reused as before). kind 'app' = the app server (its /version.json), 'helper' = the hardware helper."""
    base = 'http://127.0.0.1:%d/' % port
    if kind == 'app':
        if not alive(base + 'index.html', 'Open Nova'): return None
        r = fetch(base + 'version.json')
    else:
        if not alive(base + 'api/hw/ping', 'novalink'): return None
        r = fetch(base + 'api/hw/alpha/state', b'{}')
    try:
        j = json.loads(r[1]) if r and r[0] == 200 else {}
        return {'version': j['version'], 'build': j['build']} if j.get('version') and j.get('build') else {}
    except (ValueError, TypeError, AttributeError): return {}


def free(port):
    """Nothing listens on port on this computer and it can be listened on (every interface, IPv4 and IPv6, and loopback).
    Windows says "access permissions" (10013), not "in use", for a port another program holds."""
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5): return False
    except OSError: pass
    for fam, host in ((socket.AF_INET, '127.0.0.1'), (socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')):
        try: s = socket.socket(fam, socket.SOCK_STREAM)
        except OSError: continue                   # no IPv6 here
        try:
            if sys.platform != 'win32': s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)   # as the servers do: a port just closed is free
            s.bind((host, port))
        except OSError as e:
            if e.errno in (errno.EADDRINUSE, errno.EACCES) or getattr(e, 'winerror', None) in (10048, 10013): return False
        finally: s.close()
    return True


class OtherBuild(Exception):
    pass


def place(kind, port, mine):
    """Where the app server / helper goes: (port, reuse). The first of port, port+1 … that is this same build (reuse) or
    free; raises OtherBuild({version, build}) for an Open Nova of another build; (None, False) when none is free."""
    for p in range(port, port + SPARE):
        b = running(kind, p)
        if b is not None:
            if not b or not mine or (b['version'], b['build']) == mine: return p, True
            raise OtherBuild(b)
        if free(p): return p, False
    return None, False


def other_text(b, mine):
    older = mine and b['build'][:8].isdigit() and mine[1][:8].isdigit() and b['build'][:8] < mine[1][:8]
    return ('%s Open Nova (%s, build %s) is still running: close its window, then start again.'
            % ('An older' if older else 'Another', b['version'], b['build']))


class Tee:
    """sys.stdout / sys.stderr that also go into the console log (thread-safe; the log failing never stops the window)."""
    lock = threading.Lock()

    def __init__(self, stream, log):
        self.stream, self.log = stream, log

    def write(self, s):
        with Tee.lock:
            try: self.stream.write(s)
            except (OSError, ValueError, AttributeError): pass
            if self.log:
                try: self.log.write(s); self.log.flush()
                except (OSError, ValueError): pass
        return len(s)

    def flush(self):
        try: self.stream.flush()
        except (OSError, ValueError, AttributeError): pass

    def __getattr__(self, k):
        return getattr(self.stream, k)


def console_log(data):
    """<data>/logs/console.txt, opened for appending (the one before kept as console-previous.txt), or None."""
    d = os.path.join(data, 'logs')
    p = os.path.join(d, 'console.txt')
    try:
        os.makedirs(d, exist_ok=True)
        if os.path.isfile(p) and os.path.getsize(p) > 1024 * 1024: os.replace(p, os.path.join(d, 'console-previous.txt'))
        f = open(p, 'a', encoding='utf-8', errors='replace')
        f.write('\n==== %s · %s · Python %s (%s) · %s\n' % (datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'), HERE, sys.version.split()[0],
                                                       sys.executable, ' '.join(sys.argv[1:]) or 'no options'))
        return f
    except OSError: return None


def pump(proc):
    """A child's output (helper / server) into this window and the console log, line by line."""
    for line in iter(proc.stdout.readline, b''):
        sys.stdout.write(line.decode('utf-8', 'replace').replace('\r\n', '\n')); sys.stdout.flush()


def main(argv):
    for s in (sys.stdout, sys.stderr):   # a Windows console / redirected output that can't show a character must not stop us
        try: s.reconfigure(errors='replace')
        except (AttributeError, ValueError, OSError): pass
    if sys.version_info < (3, 9):
        print('Open Nova needs Python 3.9 or newer (this is %s). Install it from https://www.python.org/downloads/' % sys.version.split()[0]); return 1
    try:
        import lzma  # noqa: F401 - the helper packs NovaLCT screen layouts with it
    except ImportError:
        print('This Python has no lzma module, which Open Nova needs to send layouts.\n'
              'Install Python from https://www.python.org/downloads/ (it includes it), then start again.'); return 1
    a, opts = list(argv), {}
    while a:
        k = a.pop(0)
        if k in ('--local-only', '--no-browser', '--alpha'): opts[k] = True
        elif k in ('--port', '--helper-port', '--data-dir', '--bind') and a: opts[k] = a.pop(0)
        else: print(__doc__); return 2
    port, hport = int(opts.get('--port', 8765)), int(opts.get('--helper-port', 8790))
    data = os.path.abspath(opts.get('--data-dir') or os.path.join(HERE, 'app', 'data'))
    log = console_log(data)
    sys.stdout, sys.stderr = Tee(sys.stdout, log), Tee(sys.stderr, log)
    py, kids, no_helper = sys.executable, [], False
    if opts.get('--alpha'): os.environ['OPENNOVA_ALPHA'] = '1'          # passed on to the helper and the server
    if log: os.environ['OPENNOVA_CONSOLE_LOG'] = log.name              # Report a problem (tools/alpha.py) takes it
    mine = None
    try:
        with open(os.path.join(HERE, 'app', 'version.json'), encoding='utf-8-sig') as f: v = json.load(f)
        print('Open Nova %s (build %s%s)' % (v.get('version'), v.get('build'), ', alpha' if v.get('channel') == 'alpha' or opts.get('--alpha') else ''))
        mine = (v.get('version'), v.get('build'))
    except (OSError, ValueError, AttributeError):
        pass
    sys.stdout.flush()
    # the children: Windows: Ctrl+C reaches us, not them first; their output comes through us (window + console log)
    flags = {'creationflags': 0x00000200} if sys.platform == 'win32' else {}
    env = dict(os.environ, PYTHONUNBUFFERED='1', PYTHONIOENCODING='utf-8')
    try:
        try:
            port0, hport0 = port, hport
            port, app_up = place('app', port, mine)
            hport, helper_up = place('helper', hport, mine)
        except OtherBuild as e:
            print(other_text(e.args[0], mine)); return 1
        for what, p, p0 in (('app', port, port0), ('hardware helper', hport, hport0)):
            if p is None: print('Ports %d to %d are all used by other programs: start Open Nova with --%sport <a free port>.' % (p0, p0 + SPARE - 1, 'helper-' if what != 'app' else '')); return 1
            if p != p0: print('Port %d is used by another program: the %s uses %d instead.' % (p0, what, p))
        if helper_up:
            print('Hardware helper already running on port %d — using it.' % hport)
        else:
            kids.append(subprocess.Popen([py, os.path.join(HERE, 'tools', 'novalink.py'), 'serve', '--port', str(hport), '--app-port', str(port)], cwd=os.path.join(HERE, 'tools'),
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, **flags))
            threading.Thread(target=pump, args=(kids[-1],), daemon=True).start()
            # a slow or busy computer (a first start on macOS lists the network services) can take a while: up to 60 s
            if not wait('http://127.0.0.1:%d/api/hw/ping' % hport, 'novalink', 60, kids[-1]):
                time.sleep(0.3)
                print('The hardware helper didn\'t start%s (see the messages above).' % ('' if kids[-1].poll() is None else ': it stopped with code %s' % kids[-1].returncode))
                print(NO_HELPER); no_helper = True
        url ='http://localhost:%d/' % port
        if app_up:
            print('Open Nova is already being served on port %d — using it.' % port)
        else:
            cmd = [py, os.path.join(HERE, 'app', 'serve.py'), str(port), '--helper-port', str(hport)]
            if opts.get('--data-dir'): cmd += ['--data-dir', opts['--data-dir']]
            if opts.get('--local-only'): cmd.append('--local-only')
            if opts.get('--bind'): cmd += ['--bind', opts['--bind']]   # else serve.py reads Settings > Network itself
            kids.append(subprocess.Popen(cmd, cwd=os.path.join(HERE, 'app'), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, **flags))
            threading.Thread(target=pump, args=(kids[-1],), daemon=True).start()
            if not wait('http://127.0.0.1:%d/index.html' % port, 'Open Nova', 60, kids[-1]):
                time.sleep(0.3)
                print('The app server didn\'t start (see the messages above).'); return 1
        print('\nOpen Nova is running: %s\nLeave this window open while you work; close it (or press Ctrl+C) to stop.\n' % url); sys.stdout.flush()
        if not opts.get('--no-browser'): webbrowser.open(url)
        if not kids:
            return 0
        server = kids[-1] if not app_up else None   # ours: while it runs, a stopped helper doesn't end Open Nova (a report can still be made)
        said = no_helper
        while all(k.poll() is None for k in kids) or (server is not None and server.poll() is None):
            if server is not None and not said and any(k.poll() is not None for k in kids if k is not server):
                said = True; print('The hardware helper stopped (see the messages above). ' + NO_HELPER); sys.stdout.flush()
            time.sleep(0.5)
        time.sleep(0.3)
        print('A part of Open Nova stopped (see the messages above).'); return 1
    except KeyboardInterrupt:
        return 0
    finally:
        for k in kids:
            if k.poll() is None:
                k.terminate()
                try: k.wait(5)
                except subprocess.TimeoutExpired: k.kill()
        sys.stdout.flush()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
