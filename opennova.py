"""opennova.py - start Open Nova on Windows, macOS or Linux: the hardware helper (tools/novalink.py, 127.0.0.1:8790) and
the app server (app/serve.py, port 8765), then open the app in the browser. Python 3.9+ only, nothing to install.

    python3 opennova.py [--port 8765] [--helper-port 8790] [--data-dir DIR] [--local-only] [--bind all|localhost|<interface>] [--no-browser] [--alpha]

Double-click instead: "Start Open Nova.command" (macOS), "Start Open Nova.bat" (Windows), start-open-nova.sh (Linux).
A helper or server already running on those ports is reused, not started twice. Close the window (or Ctrl+C) to stop.
--alpha = the alpha's behaviour without an alpha package (read-only until unlocked, intro, recorder always on; docs/DIAGNOSTICS.md "The alpha build");
the alpha package has it built in (app/version.json channel "alpha").
--bind: which networks can open the app (app/serve.py); without it, this computer's Settings > Network choice (every network by default).
"""
import os
import subprocess
import sys
import time
import urllib.request
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))


def alive(url, want=None):
    try:
        with urllib.request.urlopen(url, timeout=1.5) as r:
            body = r.read(400).decode('utf-8', 'replace')
            return r.status == 200 and (want is None or want in body)
    except Exception:  # noqa: BLE001 - "not there" in every form
        return False


def wait(url, want, secs, proc=None):
    """Until url answers with want, at most secs; False at once if proc (the process that should answer) has ended."""
    end = time.time() + secs
    while time.time() < end:
        if alive(url, want): return True
        if proc is not None and proc.poll() is not None: return False
        time.sleep(0.3)
    return False


def main(argv):
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
    py, kids = sys.executable, []
    if opts.get('--alpha'): os.environ['OPENNOVA_ALPHA'] = '1'          # passed on to the helper and the server
    try:
        import json
        with open(os.path.join(HERE, 'app', 'version.json'), encoding='utf-8-sig') as f: v = json.load(f)
        print('Open Nova %s (build %s%s)' % (v.get('version'), v.get('build'), ', alpha' if v.get('channel') == 'alpha' or opts.get('--alpha') else ''))
    except (OSError, ValueError, AttributeError):
        pass
    flags = {'creationflags': 0x00000200} if sys.platform == 'win32' else {}   # Windows: Ctrl+C reaches us, not the children first
    try:
        if alive('http://127.0.0.1:%d/api/hw/ping' % hport, 'novalink'):
            print('Hardware helper already running on port %d — using it.' % hport)
        else:
            kids.append(subprocess.Popen([py, os.path.join(HERE, 'tools', 'novalink.py'), 'serve', '--port', str(hport), '--app-port', str(port)], cwd=os.path.join(HERE, 'tools'), **flags))
            # a slow or busy computer (a first start on macOS lists the network services) can take a while: up to 60 s
            if not wait('http://127.0.0.1:%d/api/hw/ping' % hport, 'novalink', 60, kids[-1]):
                print('The hardware helper didn\'t start%s (see the messages above).' % ('' if kids[-1].poll() is None else ': it stopped with code %s' % kids[-1].returncode)); return 1
        url = 'http://localhost:%d/' % port
        if alive(url + 'index.html', 'Open Nova'):
            print('Open Nova is already being served on port %d — using it.' % port)
        else:
            cmd = [py, os.path.join(HERE, 'app', 'serve.py'), str(port), '--helper-port', str(hport)]
            if opts.get('--data-dir'): cmd += ['--data-dir', opts['--data-dir']]
            if opts.get('--local-only'): cmd.append('--local-only')
            if opts.get('--bind'): cmd += ['--bind', opts['--bind']]   # else serve.py reads Settings > Network itself
            kids.append(subprocess.Popen(cmd, cwd=os.path.join(HERE, 'app'), **flags))
            if not wait(url + 'index.html', 'Open Nova', 60, kids[-1]):
                print('The app server didn\'t start (is port %d used by something else? try --port 8775).' % port); return 1
        print('\nOpen Nova is running: %s\nLeave this window open while you work; close it (or press Ctrl+C) to stop.\n' % url); sys.stdout.flush()
        if not opts.get('--no-browser'): webbrowser.open(url)
        if not kids:
            return 0
        while all(k.poll() is None for k in kids): time.sleep(0.5)
        print('A part of Open Nova stopped (see the messages above).'); return 1
    except KeyboardInterrupt:
        return 0
    finally:
        for k in kids:
            if k.poll() is None:
                k.terminate()
                try: k.wait(5)
                except subprocess.TimeoutExpired: k.kill()


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
