"""netcap_worker.py - the one elevated part of network recording (tools/netcap.py starts it; never run by hand).

User, 2026-11-17: "we dont want to get in his way at all that is the whole point". NovaLCT / VMP / Unico talk to the processor
directly, as always; this only listens, the way Wireshark does. If anything here fails, the vendor app never notices.

Windows: pktmon (Windows 10 2004+ / 11, built in; nothing installed). Only administrators may start it, so Open Nova's helper
starts THIS script once per session through Windows' permission prompt (ShellExecute "runas", the tester's one "Allow
recording"); the helper itself is never elevated. macOS [I] untested: tcpdump, started the same way with the tester's
admin password (osascript), one tcpdump per network interface, files handed to the tester's user (-Z).

What it does, and nothing else (it never runs anything the helper asks for: the commands are fixed here, the helper's
control file only says on / off / cut / quit):
  - at start: pktmon already running? Ours from an earlier session that crashed (its log file is in our netcap-work
    folder) -> stopped and converted. Anyone else's -> state "busy", nothing touched, exit.
  - "on": packet filters for the NovaStar ports (pktmon allows 32; single ports, no ranges), then
    pktmon start --capture --comp nics --pkt-size 0 -f <run>\\nova.etl -s <MB> -m multi-file   (whole packets, one copy
    per network adapter, a new file every <MB>)
  - "off": pktmon stop, each .etl -> .pcapng (pktmon etl2pcap; the .etl, our own temporary file, goes once its .pcapng is
    written), filters removed. The helper picks the .pcapng files up (worker.json "converted") and decodes them.
  - "cut": off + on (Report a problem while recording: what is recorded so far goes into the report)
  - "quit", or the helper's process gone (Open Nova closed or crashed): off, then exit. pktmon is never left running.
Status: <dir>/worker.json (rewritten whole, atomically), a log: <dir>/worker.log. Stdlib only, run with python -I.
"""
import glob
import json
import os
import subprocess
import sys
import time

IS_WIN = sys.platform == 'win32'
TICK = 0.5
A = {}
S = {'state': 'starting', 'pid': os.getpid(), 'at': 0, 'run': 0, 'runDir': '', 'bytes': 0, 'error': '', 'converted': [],
     'started': 0, 'backend': 'pktmon' if IS_WIN else 'tcpdump', 'cut': 0}
LOG = []


def args(argv):
    a, i = {}, 0
    while i < len(argv):
        if argv[i].startswith('--') and i + 1 < len(argv): a[argv[i][2:]] = argv[i + 1]; i += 2
        else: i += 1
    return a


def log(t):
    line = time.strftime('%H:%M:%S ') + t
    LOG.append(line)
    try:
        with open(os.path.join(A['dir'], 'worker.log'), 'a', encoding='utf-8') as f: f.write(line + '\n')
    except OSError: pass


def save():
    S['at'] = time.time(); S['log'] = LOG[-12:]
    p = os.path.join(A['dir'], 'worker.json')
    try:
        with open(p + '.tmp', 'w', encoding='utf-8') as f: json.dump(S, f)
        os.replace(p + '.tmp', p)
        if A.get('uid'): _chown(p)
    except OSError: pass


def _chown(p):
    try: os.chown(p, int(A['uid']), -1)
    except (OSError, ValueError, AttributeError): pass


def control():
    try:
        with open(os.path.join(A['dir'], 'control.json'), encoding='utf-8') as f: c = json.load(f)
        return c if isinstance(c, dict) else {}
    except (OSError, ValueError):
        return {}


# ------------------------------------------------------------------ the helper still there?
_parent = {'h': None}


def parent_alive():
    pid = int(A.get('parent') or 0)
    if not pid: return True
    if IS_WIN:
        import ctypes
        from ctypes import wintypes as W
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.OpenProcess.restype = W.HANDLE; k.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]
        k.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
        if _parent['h'] is None:
            h = k.OpenProcess(0x00100000, False, pid)       # SYNCHRONIZE: held, so a reused pid can't fool us
            if not h: return False
            _parent['h'] = h
        return k.WaitForSingleObject(_parent['h'], 0) != 0   # WAIT_OBJECT_0 = it has ended
    try: os.kill(pid, 0); return True
    except PermissionError: return True
    except OSError: return False


# ------------------------------------------------------------------ running pktmon (or a stand-in, for the tests)
def pm(*a, timeout=120):
    exe = A['pktmon']
    cmd = ([sys.executable, exe] if exe.endswith('.py') else [exe]) + list(a)
    try:
        r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, timeout=timeout,
                           **({'creationflags': 0x08000000} if IS_WIN else {}))
        out = r.stdout.decode('utf-8', 'replace') if r.stdout else ''
        try: out = r.stdout.decode('oem') if IS_WIN and r.stdout else out
        except (UnicodeDecodeError, LookupError): pass
        return r.returncode, out.strip()
    except (OSError, subprocess.SubprocessError) as e:
        return -1, str(e)


def pm_status():
    """-> ('idle' | 'running', log file or '', text)"""
    rc, out = pm('status', timeout=30)
    for line in out.splitlines():
        t = line.strip()
        if t.lower().startswith('log file:'): return 'running', t.split(':', 1)[1].strip(), out
    return 'idle', '', out


def ours(path):
    return 'netcap-work' in path.replace('/', '\\').lower()


def etl_dir_of(path):
    return os.path.dirname(path) if path else ''


# ------------------------------------------------------------------ Windows: pktmon
def filters_on():
    pm('filter', 'remove')
    n = 0
    for port in [p for p in str(A.get('ports') or '').split(',') if p.strip().isdigit()][:32]:
        rc, out = pm('filter', 'add', 'OpenNova%s' % port, '-p', port, timeout=30)
        if rc == 0: n += 1
        else: log('filter %s not added: %s' % (port, out[-200:]))
    return n


def win_start():
    S['run'] += 1
    run = os.path.join(A['dir'], 'run%d' % S['run']); os.makedirs(run, exist_ok=True)
    n = filters_on()
    if not n: S['state'], S['error'] = 'failed', 'no packet filter could be set'; log(S['error']); return False
    rc, out = pm('start', '--capture', '--comp', 'nics', '--pkt-size', '0', '-f', os.path.join(run, 'nova.etl'),
                 '-s', str(int(A.get('partmb') or 32)), '-m', 'multi-file', timeout=60)
    if rc != 0:
        pm('filter', 'remove')
        low = out.lower()
        S['state'] = 'busy' if 'already' in low or 'in use' in low else 'failed'
        S['error'] = out[-400:] or 'pktmon start: exit code %s' % rc
        log('pktmon start failed (%s): %s' % (rc, out[-400:])); return False
    S['state'], S['runDir'], S['started'], S['error'] = 'capturing', run, time.time(), ''
    log('capturing into %s (%d filters)' % (run, n))
    return True


def convert(run):
    """Every .etl in run -> .pcapng next to it; the .etl goes once its .pcapng is there. -> [pcapng paths]"""
    done = []
    for etl in sorted(glob.glob(os.path.join(run, '*.etl')), key=os.path.getmtime):
        out = etl[:-4] + '.pcapng'
        rc, txt = pm('etl2pcap', etl, '--out', out, timeout=600)
        if os.path.isfile(out) and os.path.getsize(out) > 0:
            done.append(out)
            try: os.remove(etl)
            except OSError as e: log('kept %s: %s' % (etl, e))
        else: log('etl2pcap %s failed (%s): %s' % (os.path.basename(etl), rc, txt[-300:]))
    return done


def win_stop(why):
    S['state'] = 'converting'; save()
    rc, out = pm('stop', timeout=120)
    log('pktmon stop (%s): %s' % (why, (out.splitlines() or [''])[-1][:200]))
    pm('filter', 'remove')
    run = S['runDir']
    if run:
        conv = convert(run)
        S['converted'] = (S['converted'] + conv)[-200:]
        log('converted %d file(s) from %s' % (len(conv), os.path.basename(run)))
    S['state'], S['runDir'], S['bytes'] = 'idle', '', 0


def recover():
    """.etl files a crashed earlier session left in netcap-work (ours only): converted now."""
    root = os.path.dirname(A['dir'])
    for etl in glob.glob(os.path.join(root, '*', 'run*', '*.etl')):
        run = os.path.dirname(etl)
        if os.path.normcase(run).startswith(os.path.normcase(A['dir'])): continue
        conv = convert(run)
        if conv: S['converted'] = (S['converted'] + conv)[-200:]; log('recovered %d file(s) from %s' % (len(conv), run))


def win_main():
    st, path, out = pm_status()
    if st == 'running':
        if not ours(path):
            S['state'], S['error'] = 'busy', 'pktmon is already recording for another program (%s): left alone' % (path or 'unknown log file')
            log(S['error']); save(); return 3
        log('an earlier Open Nova recording was still running (%s): stopped' % path)
        pm('stop', timeout=120); pm('filter', 'remove')
        conv = convert(etl_dir_of(path))
        S['converted'] = conv
    recover()
    return loop(win_start, win_stop, win_bytes, win_alive)


def win_bytes():
    return sum(os.path.getsize(p) for p in glob.glob(os.path.join(S['runDir'], '*.etl')) if os.path.isfile(p)) if S['runDir'] else 0


_alive = {'next': 0}


def win_alive():
    """Still recording? (someone may have run pktmon stop) — asked every 10 s."""
    if time.time() < _alive['next']: return True
    _alive['next'] = time.time() + 10
    st, path, _ = pm_status()
    return st == 'running' and ours(path)


# ------------------------------------------------------------------ macOS [I]: tcpdump, one per interface
PROCS = []


def mac_ifaces():
    import socket
    try: names = [n for _, n in socket.if_nameindex()]
    except (OSError, AttributeError): names = ['en0']
    return [n for n in names if n.startswith(('en', 'bridge'))] or ['en0']


def mac_filter():
    ports = [p for p in str(A.get('ports') or '').split(',') if p.strip().isdigit()]
    return ' or '.join('port %s' % p for p in ports) or 'port 5200'


def mac_start():
    S['run'] += 1
    run = os.path.join(A['dir'], 'run%d' % S['run']); os.makedirs(run, exist_ok=True); _chown(run)
    exe = A.get('tcpdump') or '/usr/sbin/tcpdump'
    for ifc in mac_ifaces():
        cmd = ([sys.executable, exe] if exe.endswith('.py') else [exe]) + ['-i', ifc, '-s', '0', '-U', '-n', '-C', str(int(A.get('partmb') or 32)),
                                                                          '-w', os.path.join(run, 'nova_%s.pcap' % ifc)]
        if A.get('user'): cmd += ['-Z', A['user']]
        cmd.append(mac_filter())
        try:
            PROCS.append(subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=open(os.path.join(run, 'tcpdump_%s.txt' % ifc), 'w'), stdin=subprocess.DEVNULL))
        except OSError as e: log('tcpdump on %s: %s' % (ifc, e))
    time.sleep(1.0)
    if not [p for p in PROCS if p.poll() is None]:
        S['state'], S['error'] = 'failed', 'tcpdump didn’t start'; log(S['error']); return False
    S['state'], S['runDir'], S['started'], S['error'] = 'capturing', run, time.time(), ''
    log('capturing on %s into %s' % (', '.join(mac_ifaces()), run))
    return True


def mac_stop(why):
    S['state'] = 'converting'; save()
    for p in PROCS:
        if p.poll() is None:
            p.terminate()
            try: p.wait(5)
            except subprocess.TimeoutExpired: p.kill()
    del PROCS[:]
    run = S['runDir']
    if run:
        files = sorted((p for p in glob.glob(os.path.join(run, 'nova_*.pcap*')) if os.path.getsize(p) > 24), key=os.path.getmtime)
        for p in files: _chown(p)
        S['converted'] = (S['converted'] + files)[-200:]
        log('stopped (%s): %d file(s)' % (why, len(files)))
    S['state'], S['runDir'], S['bytes'] = 'idle', '', 0


def mac_bytes():
    return sum(os.path.getsize(p) for p in glob.glob(os.path.join(S['runDir'], 'nova_*.pcap*'))) if S['runDir'] else 0


def mac_alive():
    return any(p.poll() is None for p in PROCS)


# ------------------------------------------------------------------ the loop (both)
def loop(start, stop, nbytes, alive):
    S['state'] = 'idle'; save()
    last_cut, maxb = None, int(A.get('maxmb') or 4000) << 20
    try:
        while True:
            if not parent_alive():
                log('Open Nova’s helper has gone')
                break
            c = control(); want = c.get('want', 'off')
            if want == 'quit': log('asked to quit'); break
            cut = c.get('cut', 0)
            if last_cut is None: last_cut = cut
            capturing = S['state'] == 'capturing'
            if want == 'on' and not capturing and S['state'] != 'busy':
                if S['state'] not in ('failed', 'full') or c.get('retry') != S.get('retried'):
                    S['retried'] = c.get('retry'); start()
            elif want == 'off' and capturing: stop('the vendor app closed')
            elif capturing and cut != last_cut: stop('cut for a report'); start()
            elif capturing and not alive():
                log('recording ended by someone else'); stop('ended outside Open Nova'); S['state'] = 'failed'; S['error'] = 'the recorder was stopped outside Open Nova'
            elif capturing:
                S['bytes'] = nbytes()
                if S['bytes'] > maxb: stop('over %d MB' % (maxb >> 20)); S['state'], S['error'] = 'full', 'stopped at %d MB' % (maxb >> 20)
            last_cut = cut; S['cut'] = cut
            save()
            time.sleep(TICK)
    finally:
        if S['state'] == 'capturing': stop('Open Nova closed' if not parent_alive() else 'quit')
        S['state'] = 'done'; save()
    return 0


def main(argv):
    A.update(args(argv))
    if not A.get('dir'): print('netcap_worker: --dir is needed (tools/netcap.py starts this)'); return 2
    os.makedirs(A['dir'], exist_ok=True)
    A.setdefault('pktmon', os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'pktmon.exe'))
    log('worker %d started (%s), helper pid %s' % (os.getpid(), S['backend'], A.get('parent')))
    try:
        if IS_WIN: return win_main()
        return loop(mac_start, mac_stop, mac_bytes, mac_alive)
    except Exception as e:  # noqa: BLE001 - say why, and never leave pktmon running
        S['state'], S['error'] = 'failed', '%s: %s' % (type(e).__name__, e); log('error: ' + S['error'])
        if IS_WIN and S['runDir']:
            try: pm('stop'); pm('filter', 'remove')
            except Exception: pass  # noqa: BLE001
        save()
        return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
