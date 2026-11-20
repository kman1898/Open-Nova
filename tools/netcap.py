"""netcap.py - network recording of NovaStar's own apps, passive: what NovaLCT, VMP and Unico say to the processors is recorded
while the tester works in them as usual, and Open Nova is never in the way. Stdlib only. Docs: docs/VENDOR_CAPTURE.md §0b.

User, 2026-11-17: "we dont want to get in his way at all that is the whole point". No relay, no second processor entry in the
vendor app, nothing in the traffic's path: Windows' own packet recorder (pktmon, Windows 10 2004+ / 11, built in) listens,
the way Wireshark does. If recording fails, the vendor app never notices. The relay (vendortap) stays as the expert option.

How (Windows): pktmon only lets administrators record, so the helper (never elevated) starts tools/netcap_worker.py ONCE per
session through Windows' permission prompt — the tester's one "Allow recording" — and tells it on / off / cut / quit through a
control file. The worker records only the NovaStar ports (PORTS: pktmon allows 32 single-port filters), whole packets, one copy
per network adapter, into diagnostics/netcap-work/<session>/run<N>/; when the vendor app closes it stops and converts to .pcapng.
The helper moves each .pcapng to diagnostics/<day>/vendor/captures/ and decodes it next to it into the recorder's .nwl
(wirelog.from_capture: Tools ▸ Diagnostics opens it, Report a problem carries it). Each record says which program on this
computer it was (app: NovaLCT / VMP / Unico / Open Nova …, from Windows' connection table, sampled while recording).
macOS [I] untested: tcpdump, started the same way once with the tester's admin password (osascript), files kept as .pcap.
Linux: NovaStar's apps don't run there: off.

The coordinator (run(), a helper thread like tools/usbauto.py) looks every POLL_S s:
  off / idle      no NovaStar app open (or OPENNOVA_NET_CAPTURE=0, or Linux): nothing shown
  needs-consent   NovaLCT / VMP / Unico open, not allowed yet this session: the line offers "Allow recording"
  asking          Windows' prompt (or the Mac's password dialog) is up
  starting / recording   the worker records (from the moment the app is seen; it goes on while the app stays open)
  saving          the app closed: the recording is stopped, converted and decoded
  saved           done (shown a few minutes): the files are in vendor/captures
  refused         the prompt was answered No: not asked again this session (start Open Nova again)
  busy            pktmon is recording for another program: left alone
  failed          it didn't start / stopped by itself: "Allow recording" tries again (a new prompt)
  unsupported     an app is open but this computer has no usable recorder (Windows before 10 2004 …)
Every change is a recorder mark (source 'vendor').

  PORTS                    the ports recorded (VENDOR_CAPTURE.md §3, cut to pktmon's 32 filters)
  Coordinator(env) / Env   the logic and the real world (tests pass a fake one)
  status() / allow() / flush(timeout)   the app's line, its button, Report a problem's "what was recorded so far"
  handle(path, body)       /api/hw/vendor/net-auto, net-auto-allow, net-status (vendortap.handle passes them on)
  report_md()              REPORT.md's lines
"""
import json
import os
import shlex
import socket
import struct
import subprocess
import sys
import threading
import time

import wirelog

IS_WIN, IS_MAC = sys.platform == 'win32', sys.platform == 'darwin'
HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, 'netcap_worker.py')

# NovaLCT: discovery UDP 3800, TG on TCP 5200 (MCTRL / VX …) and 5201+ (one per H output slot; an H20 has the most);
# Unico: 5600 discovery, 8088 REST + WebSocket, 15200 central control; VMP / COEX: 54622-54624 + 54700 announcements,
# 8001 REST + WS, 9001 HTTPS. pktmon: at most 32 filters, single ports (no ranges) -> 3800 + 5200-5220 + 3 + 6 = 31.
PORTS = [3800] + list(range(5200, 5221)) + [5600, 8088, 15200, 54622, 54623, 54624, 54700, 8001, 9001]
POLL_S = 2.5
PART_MB = 32             # one recorded file at most (each is decoded into memory: keep it modest)
MAX_MB = 4000            # one recording stops by itself beyond this
SAVED_SHOW_S = 300       # "recording saved" stays on the line this long
# the apps whose being open starts a recording (their services — UCenter, XCenter — run all the time and don't)
APP_EXES = {'novalct.exe': 'NovaLCT', 'novalct lite.exe': 'NovaLCT Lite', 'vmp.exe': 'VMP', 'unico.exe': 'Unico'}
MAC_APPS = {'NovaLCT': 'NovaLCT', 'VMP': 'VMP', 'Coex VMP': 'VMP', 'Unico': 'Unico'}
PKTMON_MIN_BUILD = 19041  # Windows 10 2004: pktmon start --capture, etl2pcap


def _vt():
    import vendortap
    return vendortap


def _work_root():
    return os.path.join(wirelog.DIAG_DIR, 'netcap-work')


def pktmon_path():
    root = os.environ.get('SystemRoot', r'C:\Windows')
    for sub in ('Sysnative', 'System32'):                    # a 32-bit Python on 64-bit Windows sees System32 as SysWOW64
        p = os.path.join(root, sub, 'pktmon.exe')
        if os.path.isfile(p): return p
    return ''


def win_build():
    try: return sys.getwindowsversion().build
    except AttributeError: return 0


def _owner_names():
    """exe (lower case) -> a name, for every NovaStar program vendortap knows, plus Open Nova's helper."""
    out = {}
    try:
        for a in _vt().APPS:
            for x in a['exe']: out[x.lower()] = a['name']
    except Exception:  # noqa: BLE001
        pass
    out.update(APP_EXES)
    return out


def win_owners(want_pids):
    """{local port: pid} of this computer's IPv4 TCP connections to / from PORTS and UDP sockets of want_pids (Windows'
    connection table, iphlpapi: no child process)."""
    import ctypes
    from ctypes import wintypes as W
    iph = ctypes.WinDLL('iphlpapi')
    out, ps = {}, set(PORTS)
    for fn, cls, row in ((iph.GetExtendedTcpTable, 5, 24), (iph.GetExtendedUdpTable, 1, 12)):   # *_OWNER_PID(_ALL)
        size = W.DWORD(0)
        fn(None, ctypes.byref(size), False, 2, cls, 0)
        if not size.value: continue
        buf = ctypes.create_string_buffer(size.value + 4096); size = W.DWORD(len(buf))
        if fn(buf, ctypes.byref(size), False, 2, cls, 0) != 0: continue
        raw = buf.raw; n = struct.unpack_from('<I', raw, 0)[0]
        for i in range(n):
            o = 4 + i * row
            if row == 24:
                _, _, lp, _, rp, pid = struct.unpack_from('<IIIIII', raw, o)
                lp, rp = socket.ntohs(lp & 0xFFFF), socket.ntohs(rp & 0xFFFF)
                if rp in ps or lp in ps: out[lp] = pid
            else:
                _, lp, pid = struct.unpack_from('<III', raw, o)
                if pid in want_pids: out[socket.ntohs(lp & 0xFFFF)] = pid
    return out


class Env:
    """The real world for the Coordinator. Tests replace it with a fake that has the same methods."""
    win, mac = IS_WIN, IS_MAC

    def now(self): return time.time()

    def disabled(self): return os.environ.get('OPENNOVA_NET_CAPTURE') == '0'

    def supported(self):
        """-> (ok, why not)"""
        if self.win:
            if win_build() < PKTMON_MIN_BUILD: return False, 'needs Windows 10 version 2004 or newer (its packet recorder, pktmon)'
            if not pktmon_path(): return False, 'Windows’ packet recorder (pktmon.exe) isn’t on this computer'
            return True, ''
        if self.mac:
            return (True, '') if os.path.isfile('/usr/sbin/tcpdump') else (False, 'tcpdump isn’t on this Mac')
        return False, 'NovaStar’s apps don’t run on Linux'

    def processes(self):
        """[{name, pid}] of every process."""
        if self.win:
            import usbauto
            return usbauto.win_processes()
        vt = _vt()
        return vt.parse_ps(vt._run(['ps', '-axo', 'pid=,comm='], 10))

    def apps(self, procs):
        """{app name: [pids]} of the NovaStar apps open now (the ones that start a recording)."""
        out = {}
        for p in procs:
            n = str(p['name'])
            name = APP_EXES.get(n.lower()) if self.win else MAC_APPS.get(n.replace('.app', ''))
            if name: out.setdefault(name, []).append(p['pid'])
        return out

    def owners(self, procs):
        """{local port: program name} for the record tags (Windows only; {} elsewhere)."""
        if not self.win: return {}
        names, me = _owner_names(), os.getpid()
        pidname = {p['pid']: names.get(str(p['name']).lower()) for p in procs}
        pidname[me] = 'Open Nova'
        try: ports = win_owners(set(k for k, v in pidname.items() if v))
        except (OSError, AttributeError, ValueError):
            return {}
        return {lp: pidname.get(pid) or 'pid %d' % pid for lp, pid in ports.items() if pidname.get(pid) or pid}

    def launch(self, d):
        """Start the worker elevated (blocks while Windows' prompt / the Mac's password dialog is up).
        -> {ok, handle?} or {ok: False, state: 'refused' / 'failed', error}"""
        args = ['--dir', d, '--parent', str(os.getpid()), '--ports', ','.join(map(str, PORTS)), '--partmb', str(PART_MB), '--maxmb', str(MAX_MB)]
        if self.win:
            import usbcap
            exe = sys.executable
            w = os.path.join(os.path.dirname(exe), 'pythonw.exe')
            if os.path.isfile(w): exe = w                                  # no console window
            pm = pktmon_path()
            params = subprocess.list2cmdline(['-I', WORKER] + args + (['--pktmon', pm] if pm else []))
            h, err = usbcap._runas(exe, params, 0)
            if h: return {'ok': True, 'handle': h}
            if err == 1223: return {'ok': False, 'state': 'refused', 'error': 'Windows’ prompt was answered No'}
            return {'ok': False, 'state': 'failed', 'error': 'the recorder didn’t start (Windows error %s)' % err}
        if self.mac:   # [I] untested: the tester types their own password in macOS's dialog
            import pwd
            u = pwd.getpwuid(os.getuid())
            cmd = ' '.join(shlex.quote(x) for x in [sys.executable, '-I', WORKER] + args + ['--user', u.pw_name, '--uid', str(os.getuid())])
            script = 'do shell script "%s > /dev/null 2>&1 &" with administrator privileges with prompt "Open Nova records what NovaLCT, VMP and Unico say to your processors (it only listens)."' % (
                (cmd).replace('\\', '\\\\').replace('"', '\\"'))
            try: r = subprocess.run(['osascript', '-e', script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
            except (OSError, subprocess.SubprocessError) as e:
                return {'ok': False, 'state': 'failed', 'error': str(e)}
            if r.returncode == 0: return {'ok': True, 'handle': None}
            err = r.stderr.decode('utf-8', 'replace')
            return {'ok': False, 'state': 'refused' if '-128' in err else 'failed', 'error': err.strip()[-300:] or 'osascript: exit %d' % r.returncode}
        return {'ok': False, 'state': 'failed', 'error': 'not supported here'}

    def alive(self, handle, ws):
        """Is the worker still running?"""
        if self.win and handle:
            import ctypes
            from ctypes import wintypes as W
            k = ctypes.WinDLL('kernel32', use_last_error=True)
            k.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
            return k.WaitForSingleObject(handle, 0) != 0
        pid = (ws or {}).get('pid')
        if not pid: return True                     # not started yet (the Mac's dialog): asking
        try: os.kill(int(pid), 0); return True
        except PermissionError: return True         # root's process: it's there
        except OSError: return False

    def mark(self, text):
        wirelog.mark('Network recording: ' + text, source='vendor')


def _read_json(p):
    for _ in range(3):
        try:
            with open(p, encoding='utf-8') as f: return json.load(f)
        except FileNotFoundError: return None
        except (OSError, ValueError): time.sleep(0.05)
    return None


def _write_json(p, o):
    with open(p + '.tmp', 'w', encoding='utf-8') as f: json.dump(o, f)
    os.replace(p + '.tmp', p)


def _mb(n):
    return '%.1f MB' % (n / 1048576.0) if n >= 104858 else '%d KB' % max(1, n // 1024)


class Coordinator:
    def __init__(self, env=None):
        self.env = env or Env()
        self.lock = threading.RLock()
        self.state, self.say, self.tip, self.action = 'off', '', '', None
        self.consent, self.refused = False, False
        self.error = ''
        self.apps = {}              # {name: [pids]} open now
        self.names = []             # the apps of this recording (for the words, also after they closed)
        self.dir = None             # this session's worker folder
        self.handle = None
        self.launching = False
        self.ws = None              # the worker's last worker.json
        self.want = 'off'
        self.cut, self.retry = 0, 0
        self.imported = set()       # converted files already taken
        self.importing = 0
        self.saved = None           # {at, files, records}
        self.owners = {}            # local port -> program, gathered while recording
        self.history = []
        self.leftovers_done = False

    def _set(self, state):
        if state != self.state:
            self.history = (self.history + [{'at': round(self.env.now(), 1), 'state': state}])[-30:]
            self.env.mark('%s -> %s%s' % (self.state, state, ' (%s)' % ', '.join(self.names) if self.names else ''))
        self.state = state

    def _control(self, want):
        self.want = want
        if self.dir:
            try: _write_json(os.path.join(self.dir, 'control.json'), {'want': want, 'cut': self.cut, 'retry': self.retry, 'at': self.env.now()})
            except OSError as e: self.error = str(e)

    # ---- one look
    def tick(self):
        with self.lock:
            try: self._tick()
            except Exception as e:  # noqa: BLE001 - the coordinator never stops; the problem is recorded
                self.env.mark('error: %s: %s' % (type(e).__name__, e))
            self._words()
            return self.status()

    def _tick(self):
        env = self.env
        if env.disabled(): return self._set('off')
        if not self.leftovers_done:
            self.leftovers_done = True
            threading.Thread(target=self._leftovers, daemon=True).start()
        procs = env.processes()
        apps = env.apps(procs)
        if sorted(apps) != sorted(self.apps):
            opened, closed = sorted(set(apps) - set(self.apps)), sorted(set(self.apps) - set(apps))
            if opened: env.mark('%s open' % ', '.join(opened))
            if closed: env.mark('%s closed' % ', '.join(closed))
        self.apps = apps
        if apps: self.names = sorted(set(self.names) | set(apps)) if self.state in ('recording', 'starting') else sorted(apps)
        ok, why = env.supported()
        if not ok:
            self.error = why
            return self._set('unsupported' if apps else 'off')
        if self.dir: self.ws = _read_json(os.path.join(self.dir, 'worker.json'))
        ws = self.ws or {}
        running = self.handle is not None or (self.dir and not env.win and ws.get('pid'))
        if running and not self.launching and not env.alive(self.handle, ws):
            if ws.get('state') == 'busy': self.error = ws.get('error') or 'pktmon is in use by another program'
            elif ws.get('state') not in ('done',): self.error = ws.get('error') or 'the recorder stopped by itself'
            self.env.mark('the recorder ended (%s)' % (ws.get('state') or 'no status'))
            self._take(ws)
            self.handle, running = None, False
            if ws.get('state') == 'busy': self.consent = False; return self._set('busy' if apps else 'idle')
            if apps and self.state in ('recording', 'starting'): self.consent = False; return self._set('failed')
        if running: self._take(ws)
        if running and apps:
            owners = env.owners(procs)
            if owners: self.owners.update(owners)
        if apps:
            if self.refused: return self._set('refused')
            if not self.consent: return self._set('failed' if self.state == 'failed' else 'busy' if self.state == 'busy' else 'needs-consent')
            if self.launching: return self._set('asking')
            if not running:
                return self._launch()
            if self.want != 'on': self._control('on')
            st = ws.get('state')
            if st == 'capturing': return self._set('recording')
            if st == 'busy': self.error = ws.get('error', ''); return self._set('busy')
            if st in ('failed', 'full') and ws.get('retried', 0) == self.retry:   # the worker runs; "Allow recording" = try again
                self.error = ws.get('error', '')
                return self._set('failed')
            return self._set('starting')
        # no NovaStar app open
        if running and self.want != 'off': self._control('off')
        st = ws.get('state') if running else None
        if st in ('capturing', 'converting') or self.importing: return self._set('saving')
        if self.saved and env.now() - self.saved['at'] < SAVED_SHOW_S: return self._set('saved')
        return self._set('idle')

    def _launch(self):
        self.dir = os.path.join(_work_root(), time.strftime('%Y%m%d-%H%M%S') + '-%d' % os.getpid())
        os.makedirs(self.dir, exist_ok=True)
        self.ws, self.error, self.launching = None, '', True
        self._control('on')
        self.env.mark('asking for permission to record (%s)' % ', '.join(self.names))
        threading.Thread(target=self._launch_run, daemon=True).start()
        return self._set('asking')

    def _launch_run(self):
        try: r = self.env.launch(self.dir)
        except Exception as e:  # noqa: BLE001
            r = {'ok': False, 'state': 'failed', 'error': '%s: %s' % (type(e).__name__, e)}
        with self.lock:
            self.launching = False
            if r.get('ok'):
                self.handle = r.get('handle') if r.get('handle') is not None else 0   # 0: the Mac's (followed by its pid)
                self.env.mark('the recorder started')
            else:
                self.error = r.get('error', '')
                if r.get('state') == 'refused': self.refused = True
                self.consent = False
                self.env.mark('the recorder didn’t start: %s' % self.error)
                self._set('refused' if self.refused else 'failed')
            self._words()

    # ---- recorded files -> vendor/captures + .nwl
    def _take(self, ws):
        new = [p for p in (ws or {}).get('converted') or [] if p not in self.imported]
        if not new: return
        for p in new: self.imported.add(p)
        self.importing += 1
        threading.Thread(target=self._import, args=(new, list(self.names), dict(self.owners)), daemon=True).start()

    def _import(self, paths, names, owners):
        recs, files = 0, []
        try:
            for i, p in enumerate(paths):
                r = import_file(p, names, owners, i + 1, len(paths))
                if r.get('ok'): recs += r.get('total', 0); files.append(r.get('original'))
                self.env.mark('saved %s: %s' % (os.path.basename(p), r.get('nwl') or r.get('error')))
        finally:
            with self.lock:
                self.importing -= 1
                if files: self.saved = {'at': self.env.now(), 'files': (self.saved or {}).get('files', 0) + len(files) if self.saved and self.env.now() - self.saved['at'] < 60 else len(files),
                                        'records': recs, 'names': names}

    def _leftovers(self):
        """Recordings a previous session converted but never decoded (Open Nova closed while it was saving): taken now."""
        root = _work_root()
        if not os.path.isdir(root): return
        for s in sorted(os.listdir(root)):
            d = os.path.join(root, s)
            if not os.path.isdir(d) or (self.dir and os.path.normcase(d) == os.path.normcase(self.dir)): continue
            ws = _read_json(os.path.join(d, 'worker.json')) or {}
            if ws.get('state') not in ('done', 'busy', 'failed', None) and ws.get('at') and self.env.now() - ws['at'] < 30: continue   # still going?
            for r in sorted(os.listdir(d)):
                rd = os.path.join(d, r)
                if not os.path.isdir(rd): continue
                ps = sorted(os.path.join(rd, f) for f in os.listdir(rd) if f.endswith(('.pcapng', '.pcap')) or '.pcap' in f)
                ps = [p for p in ps if not p.endswith(('.tmp', '.txt'))]
                if ps:
                    self.env.mark('an earlier recording that wasn’t saved yet: %s' % ', '.join(os.path.basename(p) for p in ps))
                    for i, p in enumerate(ps): import_file(p, ['earlier session'], {}, i + 1, len(ps))
                try: os.rmdir(rd)                   # only when empty
                except OSError: pass

    # ---- the tester's button, Report a problem
    def allow(self):
        with self.lock:
            if self.refused:
                return dict(self.status(), ok=False, error='Windows’ prompt was answered No this session: recording stays off until Open Nova is started again.')
            self.consent, self.error = True, ''
            if self.state == 'failed' and self.handle is not None: self.retry += 1; self._control('on')   # the worker runs: it tries again
            if self.state in ('busy', 'failed'): self.state = 'needs-consent'
            self.env.mark('the tester allowed recording (this session)')
        return dict(self.tick(), ok=True)

    def flush(self, timeout=40.0):
        """Report a problem while recording: what is recorded so far is saved now (the recording goes on)."""
        with self.lock:
            if self.state != 'recording' or self.handle is None: return {'ok': True, 'flushed': False}
            n0 = len(((self.ws or {}).get('converted')) or [])
            self.cut += 1; self._control('on')
            self.env.mark('saving what is recorded so far (a problem report)')
        t0 = time.time()
        while time.time() - t0 < timeout:
            time.sleep(0.5)
            with self.lock:
                ws = _read_json(os.path.join(self.dir, 'worker.json')) or {}
                if ws.get('cut') == self.cut and ws.get('state') == 'capturing' and (len(ws.get('converted') or []) > n0 or time.time() - t0 > 5):
                    self.ws = ws; self._take(ws); break
        while self.importing and time.time() - t0 < timeout + 30: time.sleep(0.3)
        return {'ok': True, 'flushed': True, 'seconds': round(time.time() - t0, 1)}

    def quit(self):
        with self.lock:
            if self.dir and (self.handle is not None or not self.env.win): self._control('quit')

    # ---- what the app shows
    def _words(self):
        st, ns = self.state, self.names or sorted(self.apps)
        who = ' and '.join(ns) or 'NovaStar’s app'
        isopen = '%s %s open' % (who, 'are' if len(ns) > 1 else 'is')
        mac = not self.env.win
        ask = 'macOS asks for your password once' if mac else 'Windows asks for permission once'
        act, tip, say = None, '', ''
        ws = self.ws or {}
        if st in ('off', 'idle'): say = ''
        elif st == 'needs-consent':
            say, act = '%s · not recorded yet' % isopen, 'allow'
            tip = 'Open Nova records what %s says to your processors without getting in the way: it only listens, the way Wireshark does. %s (only administrators may record).' % (who, ask)
        elif st == 'asking': say, tip = '%s · %s' % (isopen, 'macOS is asking for your password' if mac else 'Windows is asking to allow recording'), \
            'Type your password: the recorder (tcpdump) needs it.' if mac else 'Click Yes (it names Python: Open Nova’s recorder).'
        elif st == 'starting': say = '%s · starting the recording…' % isopen
        elif st == 'recording':
            say = '%s · recording%s' % (isopen, ' (%s)' % _mb(ws.get('bytes') or 0) if ws.get('bytes') else '')
            tip = 'Open Nova listens; %s talks to the processors as always. When it closes the recording is saved (Tools ▸ Diagnostics) and goes into Report a problem.' % who
        elif st == 'saving': say = 'Saving the %s recording…' % who
        elif st == 'saved':
            s = self.saved or {}
            say = '%s recording saved' % ' and '.join(s.get('names') or self.names or ['NovaStar app'])
            tip = 'In diagnostics, vendor/captures (Tools ▸ Diagnostics opens it); Report a problem takes it along. %s records.' % s.get('records', 0)
        elif st == 'refused': say, tip = '%s · not recorded (%s)' % (isopen, 'the password dialog was cancelled' if mac else 'Windows’ prompt was answered No'), 'Start Open Nova again to be asked again.'
        elif st == 'busy': say, tip, act = '%s · not recorded: Windows’ packet recorder is in use by another program' % isopen, (self.error or '') + ' Open Nova leaves it alone; Allow recording tries again.', 'allow'
        elif st == 'failed': say, tip, act = '%s · not recorded: recording didn’t start' % isopen, self.error, 'allow'
        elif st == 'unsupported': say, tip = '%s · not recorded' % isopen, 'This computer can’t record it: %s.' % self.error
        self.say, self.tip, self.action = say, tip, act

    def status(self):
        ws = self.ws or {}
        return {'ok': True, 'state': self.state, 'say': self.say, 'tip': self.tip, 'action': self.action, 'apps': sorted(self.apps),
                'consent': self.consent, 'refused': self.refused, 'error': self.error, 'worker': {k: ws.get(k) for k in ('state', 'bytes', 'run', 'error', 'backend', 'log')} if ws else None,
                'saved': self.saved, 'ports': PORTS, 'history': list(self.history[-10:])}


def import_file(path, names, owners, n=1, of=1):
    """A recorded .pcapng / .pcap -> diagnostics/<day>/vendor/captures/<time>_<app>_network.<ext> + its .nwl (records tagged
    with the program on this computer: 'app'). -> vendortap.import_capture's answer."""
    vt = _vt()
    ext = '.pcapng' if path.endswith('.pcapng') else '.pcap'
    with _imp_lock:                                    # one at a time: names stay unique (two saves in the same second)
        d = vt.vendor_dir('captures')
        stem = time.strftime('%H%M%S_') + vt._safe('_'.join(names) or 'vendor', 30) + '_network' + ('_%d' % n if of > 1 else '')
        base, k = stem, 1
        while os.path.exists(os.path.join(d, base + ext)) or os.path.exists(os.path.join(d, base + '.nwl')):
            k += 1; base = '%s-%d' % (stem, k)
        dst = os.path.join(d, base + ext)
        try:
            os.replace(path, dst)
        except OSError:
            import shutil
            try: shutil.copyfile(path, dst)
            except OSError as e: return {'ok': False, 'error': 'couldn’t move %s: %s' % (path, e)}
        return _decode(vt, dst, base, ext, names, owners, n, of)


def _decode(vt, dst, base, ext, names, owners, n, of):
    try: size = os.path.getsize(dst)
    except OSError: size = 0
    if size > vt.IMPORT_MAX: return {'ok': False, 'error': 'too big to decode here (%s): kept as it is' % _mb(size), 'original': vt._rel(dst)}
    with open(dst, 'rb') as f: data = f.read()
    progs = {}
    for lp, name in (owners or {}).items(): progs.setdefault(name, []).append(lp)

    def tag(r):
        c = r.get('cli')
        if c and owners:
            try: who = owners.get(int(str(c).rsplit(':', 1)[1]))
            except (ValueError, IndexError): who = None
            if who: r['app'] = who
    head = 'Network recording of %s (%s%s, %s): only listened, nothing was in the way. Programs here: %s' % (
        ', '.join(names) or 'NovaStar apps', 'pktmon' if ext == '.pcapng' else 'tcpdump', ', part %d of %d' % (n, of) if of > 1 else '', _mb(size),
        '; '.join('%s (local ports %s)' % (k, ', '.join(map(str, sorted(v)[:12]))) for k, v in sorted(progs.items())) or 'not known')
    try: return vt.import_capture(os.path.basename(dst), data, keep_original=False, original_path=dst, tag=tag, head_text=head, base=base)
    except ValueError as e: return {'ok': False, 'error': 'not readable as a capture: %s' % e, 'original': vt._rel(dst)}


AUTO = None
_started = threading.Event()
_imp_lock = threading.Lock()


def get():
    global AUTO
    if AUTO is None: AUTO = Coordinator()
    return AUTO


def run(stop=None):
    """The helper's thread (novalink serve): a look every POLL_S s, for as long as the helper runs."""
    if _started.is_set(): return
    _started.set()
    c = get()
    if c.env.disabled() or not (c.env.win or c.env.mac): c.tick(); return
    while not (stop and stop.is_set()):
        c.tick()
        time.sleep(POLL_S if c.env.win else 5.0)


def flush(timeout=40.0):
    return AUTO.flush(timeout) if AUTO is not None else {'ok': True, 'flushed': False}


def _atexit():
    if AUTO is not None:
        try: AUTO.quit()
        except Exception: pass  # noqa: BLE001


import atexit   # noqa: E402 - the worker also stops by itself when the helper's process is gone
atexit.register(_atexit)


def report_md():
    if AUTO is None: return []
    a = AUTO.status()
    return ['Network recording (pktmon / tcpdump, passive): %s%s; %s; recent: %s' % (
        a['state'], ' — ' + AUTO.say if AUTO.say else '', 'allowed this session' if a['consent'] else 'not allowed this session' + (' (prompt answered No)' if a['refused'] else ''),
        ', '.join(h['state'] for h in a['history']) or '—') + (' Error: %s' % a['error'] if a['error'] else ''), '']


def handle(p, body):
    """vendortap.handle passes /api/hw/vendor/net-* here."""
    c = get()
    if p == 'net-auto': return dict(c.status(), ok=True, running=_started.is_set())
    if p == 'net-auto-allow': return c.allow()
    if p == 'net-status': return dict(c.status(), ok=True, running=_started.is_set(), supported=c.env.supported()[0], why=c.env.supported()[1])
    return {'ok': False, 'error': 'unknown: ' + p}
