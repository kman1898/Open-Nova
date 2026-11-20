"""Tests for usbauto.py (the USB coordinator, docs/USB_CAPTURE.md): a fake world (process list, NovaStar USB device,
the bridge, USBPcap) and a fake clock walk it through every transition — device here and NovaLCT closed (bridge armed),
NovaLCT connecting through the bridge, NovaLCT not connecting within LCT_CONNECT_WAIT (released + passive capture),
NovaLCT already holding the device at start, NovaLCT closing (capture stopped, device taken back, bridge again), NovaLCT
restarting (also between two looks), the consent rule (no prompt before "Allow USB recording", none after a refusal),
USBPcap not installed / restart needed / a failed start, the device unplugged mid-way, a COM controller, a relay started
by hand, macOS / Linux. Then novalink's yield (Open Nova doesn't open a device NovaLCT has) and the helper route. No
hardware, no driver, no UAC.   python -I -X utf8 tools/test_usbauto.py   (exit 0 = all passed)
"""
import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix='opennova_usbauto_test_')
os.environ['OPENNOVA_DIAG'] = os.path.join(TMP, 'diag')
os.environ['OPENNOVA_USB_AUTO'] = '0'
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usbauto as A   # noqa: E402

fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what); sys.stdout.flush()
    if not cond: fails.append(what)


USB = {'host': 'usb:0483:5720@libusb0-0001', 'label': 'USB 1', 'kind': 'usb', 'modelId': 0x1206}


class Fake:
    """The world: what the coordinator sees and what it did (calls)."""
    win = True

    def __init__(self):
        self.t, self.procs, self.devs = 1000.0, {}, [dict(USB)]
        self.rel, self.rid, self.arm_err, self.calls, self.marks = None, 0, '', [], []
        self.yielded = {}
        self.inst = {'state': 'ready', 'say': 'Ready.'}
        self.cap = None                 # {'running', 'state'}
        self.cap_next = 'capturing'     # what the next cap_start gives: capturing / waiting / refused / failed
        self.installer = None

    def now(self): return self.t

    def processes(self): return {k: list(v) for k, v in self.procs.items()}

    def devices(self): return [dict(d) for d in self.devs]

    def relay(self): return dict(self.rel) if self.rel else None

    def arm(self, host):
        self.calls.append(('arm', host))
        if self.arm_err: return {'ok': False, 'error': self.arm_err}
        self.rid += 1
        self.rel = {'_obj': self.rid, 'opened': 0, 'clients': 0, 'model': 'NovaPro HD' if host.startswith('usb:') else '', 'answer': 'rpProMI:NovaPro HD (USB via Open Nova relay)'}
        return {'ok': True, 'relay': {k: v for k, v in self.rel.items() if k != '_obj'}}

    def disarm(self): self.calls.append(('disarm',)); self.rel = None

    def yield_link(self, host, why): self.calls.append(('yield', host)); self.yielded[host] = why

    def unyield(self, host): self.calls.append(('unyield', host)); self.yielded.pop(host, None)

    def cap_detect(self): self.calls.append(('detect',)); return dict(self.inst)

    def cap_start(self):
        self.calls.append(('start',))
        st = self.cap_next
        if st in ('capturing', 'waiting'):
            self.cap = {'running': True, 'state': st}; return {'ok': True, 'state': st, 'running': True}
        if st == 'refused':
            self.cap = None; return {'ok': False, 'state': 'refused', 'say': 'answered No'}
        return {'ok': False, 'state': st, 'say': 'USBPcapCMD stopped at once: boom'}

    def cap_status(self): return dict(self.cap) if self.cap else {'running': False, 'state': 'idle'}

    def cap_stop(self):
        self.calls.append(('stop',)); self.cap = None
        return {'ok': True, 'total': 42, 'state': 'stopped'}

    def cap_install(self):
        self.calls.append(('install',)); self.installer = 'running'; return {'ok': True, 'say': 'Windows asks…'}

    def cap_install_status(self):
        return {'running': self.installer == 'running', 'result': {'ok': True, 'rebootNeeded': True} if self.installer == 'done' else None}

    def mark(self, text): self.marks.append(text)

    # helpers for the tests
    def lct(self, *pids): self.procs = {'novalct.exe': list(pids)} if pids else {}

    def go(self, c, s=A.POLL_S, n=1):
        for _ in range(n):
            self.t += s; c.tick()
        return c.status()

    def did(self, name): return [x for x in self.calls if x[0] == name]


def fresh():
    f = Fake(); return f, A.Coordinator(f)


# ------------------------------------------------------------------ 1: device here, NovaLCT closed
f, c = fresh()
s = c.tick()
ok(s['state'] == 'armed' and f.did('arm') == [('arm', USB['host'])], '1: device here, NovaLCT closed -> the bridge is armed for it (%s)' % s['state'])
ok(s['say'] == 'NovaPro HD on USB · ready for Open Nova and NovaLCT' and s['action'] is None, '1: status line: %r' % s['say'])
ok(not f.yielded and not f.did('start') and not f.did('detect'), '1: Open Nova keeps using it; no capture, USBPcap not even asked')
f.go(c, n=5)
ok(len(f.did('arm')) == 1, '1: armed once, not again every look')
ok(any('bridge armed' in m for m in f.marks) and any('no-device -> armed' in m for m in f.marks), '1: the state change and the arming are recorded (marks)')

# ------------------------------------------------------------------ 2: NovaLCT starts and connects through the bridge
f.lct(4242); s = f.go(c)
ok(s['state'] == 'waiting' and s['say'] == 'NovaLCT is open · waiting for it to connect through Open Nova', '2: NovaLCT seen -> waiting (%s)' % s['say'])
f.rel['opened'] = 1; f.rel['clients'] = 1; s = f.go(c)
ok(s['state'] == 'bridged' and s['say'] == 'NovaLCT connected through Open Nova · recording', '2: NovaLCT connected -> %r' % s['say'])
f.rel['clients'] = 0; s = f.go(c, n=10)
ok(s['state'] == 'bridged' and not f.yielded and not f.did('start'), '2: stays bridged while NovaLCT runs (also after it disconnects), never released, no USB capture')
ok(any('NovaLCT started' in m for m in f.marks) and any('NovaLCT connected through the bridge' in m for m in f.marks), '2: NovaLCT start + connect recorded')

# ------------------------------------------------------------------ 5 (from 2): NovaLCT exits -> bridge fresh
n0 = len(f.did('arm'))
f.lct(); s = f.go(c)
ok(s['state'] == 'armed' and len(f.did('arm')) == n0 + 1 and f.did('disarm'), '5: NovaLCT closed -> the bridge starts again fresh (a new recording) (%s)' % s['state'])

# ------------------------------------------------------------------ 3: NovaLCT doesn't connect within the wait
f, c = fresh(); c.tick()
f.lct(7); f.go(c)
s = f.go(c, s=A.LCT_CONNECT_WAIT - 0.5)
ok(s['state'] == 'waiting' and not f.yielded, '3: %g s after NovaLCT started: still waiting, device still Open Nova\'s' % (A.LCT_CONNECT_WAIT - 0.5))
s = f.go(c, s=1.0)
ok(s['state'] == 'released' and f.yielded.get(USB['host']) and f.did('disarm'), '3: after %g s -> released: the bridge stopped and Open Nova\'s link lets go (%s)' % (A.LCT_CONNECT_WAIT, s['state']))
ok(s['sub'] == 'needs-consent' and s['action'] == 'allow' and not f.did('start'), '3: USBPcap ready but no consent yet: no capture, no prompt, the button is "allow"')
ok(s['say'] == 'NovaLCT has the NovaPro HD · not recorded yet', '3: status line: %r' % s['say'])
f.go(c, n=8)
ok(not f.did('start') and len(f.did('arm')) == 1, '3: nothing starts by itself while the tester hasn\'t allowed it; the bridge isn\'t re-armed while NovaLCT runs')
ok(len(f.did('detect')) <= 4, '3: USBPcap is asked at most every %g s (%d times in %d s)' % (A.CAP_DETECT_EVERY, len(f.did('detect')), 9 * A.POLL_S))
s = c.allow()
ok(s['ok'] and f.did('start') and s['state'] == 'released' and s['sub'] == 'capturing', '7: "Allow USB recording" -> the capture starts at once (%s)' % s['sub'])
ok(s['say'] == 'NovaLCT has the NovaPro HD · recording' and s['action'] is None, '3: status line: %r' % s['say'])
ok(any('allowed USB recording' in m for m in f.marks) and any('USB capture started' in m for m in f.marks), '7: the consent and the capture start are recorded')

# ------------------------------------------------------------------ 5: NovaLCT exits -> capture stopped + imported, device back, bridge
n0 = len(f.did('arm'))
f.lct(); s = f.go(c)
ok(f.did('stop') and not f.yielded and len(f.did('arm')) == n0 + 1 and s['state'] == 'armed', '5: NovaLCT closed -> capture stopped (decoded), device taken back, bridge armed again (%s)' % s['state'])
ok(any('42 records' in m for m in f.marks) and any('took the device back' in m for m in f.marks), '5: recorded: the capture\'s records, the take-back')

# ------------------------------------------------------------------ restart: consent stands for the session, no new click
f.lct(8); f.go(c); s = f.go(c, s=A.LCT_CONNECT_WAIT)
ok(s['sub'] == 'capturing' and len(f.did('start')) == 2, '7: NovaLCT again, not connecting: the capture starts by itself (consent stands this session)')
f.lct(9); s = f.go(c)                         # closed and opened again between two looks: new pids
ok(len(f.did('stop')) == 2 and s['state'] in ('waiting', 'armed') and not f.yielded, 'restart between two looks (new pids): treated as close + open: capture stopped, device back, bridge armed (%s)' % s['state'])
ok(any('NovaLCT restarted' in m for m in f.marks), 'restart recorded')
s = f.go(c, s=A.LCT_CONNECT_WAIT)
ok(s['state'] == 'released' and s['sub'] == 'capturing', 'restarted NovaLCT not connecting -> released and recorded again')
f.cap = {'running': False, 'state': 'stopped'}; s = f.go(c)       # the 8 h / 1 GB limit ended it
ok(len(f.did('stop')) == 3 and len(f.did('start')) == 4 and s['sub'] == 'capturing', 'a capture that ended by itself is decoded and the next one starts (consent stands)')

# ------------------------------------------------------------------ 4: NovaLCT already had the device when Open Nova started
f, c = fresh(); f.lct(11); f.arm_err = 'Couldn’t open the NovaStar USB device (busy). If NovaLCT is running, close NovaLCT…'
s = c.tick()
ok(s['state'] == 'released' and f.yielded.get(USB['host']) and len(f.did('arm')) == 1, '4: NovaLCT holds it at start (open fails busy) -> no fight: released at once (%s)' % s['state'])
f.go(c, n=6)
ok(len(f.did('arm')) == 1, '4: and the bridge isn\'t tried again while NovaLCT runs')
f.inst = {'state': 'not-installed', 'say': 'needs USBPcap'}; c.cap_next = 0; c.cap_state = ''; s = f.go(c)
ok(s['sub'] == 'not-installed' and s['action'] == 'install' and s['say'] == 'NovaLCT has the NovaPro HD · not recorded yet', '4: USBPcap missing -> one step: "install" (%s)' % s['sub'])
s = c.install()
ok(s['ok'] and f.did('install') and s['sub'] == 'installing' and s['action'] is None, 'Install USB capture -> its installer runs, status "installing" (%s)' % s['sub'])
f.installer = 'done'; f.inst = {'state': 'reboot', 'say': 'restart'}; s = f.go(c)
ok(s['sub'] == 'reboot' and s['action'] is None and s['say'] == 'NovaLCT has the NovaPro HD · restart the computer once to record it', 'installed, restart needed -> says so, no button (%r)' % s['say'])
ok(not f.did('start'), 'reboot-needed: no capture tried')

# ------------------------------------------------------------------ 7: refusal: never asked again this session
f, c = fresh(); f.lct(12); f.arm_err = 'Couldn’t open the NovaStar USB device (busy)'; c.tick()
f.cap_next = 'waiting'; s = c.allow()
ok(s['sub'] == 'asking' and s['say'] == 'NovaLCT has the NovaPro HD · Windows is asking to allow USB recording', '7: allowed -> the Windows prompt is up: %r' % s['say'])
f.cap = {'running': False, 'state': 'refused'}; f.cap_next = 'refused'; s = f.go(c)
ok(s['sub'] == 'refused' and s['action'] is None and c.refused, '7: prompt answered No -> "not recorded", no button (%s)' % s['sub'])
n0 = len(f.did('start')); f.go(c, n=10)
ok(len(f.did('start')) == n0, '7: never asked again this session (no new start = no new prompt)')
r = c.allow()
ok(not r['ok'] and len(f.did('start')) == n0, '7: even "allow" again doesn\'t start one after a refusal this session')
f.lct(); f.arm_err = ''; f.go(c); f.lct(13); f.go(c); f.go(c, s=A.LCT_CONNECT_WAIT)
ok(len(f.did('start')) == n0 and c.status()['sub'] == 'refused', '7: also not after NovaLCT restarts')
f2, c2 = fresh(); f2.lct(1); f2.arm_err = 'Couldn’t open (busy)'; c2.tick(); c2.allow(); f2.cap_next = 'refused'
f2.cap = None; c2.cap_own = False; c2.consent = True
s = f2.go(c2)
ok(s['sub'] == 'refused' and c2.refused, '7: a start that comes back "refused" (usbcap remembered the No) -> refused too')

# ------------------------------------------------------------------ a failed start: no automatic retry, the button again
f, c = fresh(); f.lct(14); f.arm_err = 'Couldn’t open (busy)'; c.tick(); f.cap_next = 'failed'
s = c.allow()
ok(s['sub'] == 'failed' and s['action'] == 'allow' and 'boom' in s['tip'], 'failed start -> "not recorded", the button again, the reason in the tooltip (%s)' % s['sub'])
n0 = len(f.did('start')); f.go(c, n=6)
ok(len(f.did('start')) == n0, 'no automatic retry after a failed start (each prompt follows a click)')
f.cap_next = 'capturing'; s = c.allow()
ok(s['sub'] == 'capturing', 'a click starts it again')

# ------------------------------------------------------------------ the device unplugged mid-way
f, c = fresh(); c.tick(); f.devs = []; s = f.go(c)
ok(s['state'] == 'no-device' and f.did('disarm') and s['say'] == '', 'unplugged while armed -> bridge stopped, line hidden (%s)' % s['state'])
f.devs = [dict(USB)]; s = f.go(c)
ok(s['state'] == 'armed' and len(f.did('arm')) == 2, 'plugged in again -> armed again')
f.lct(20); f.go(c); f.rel['opened'] = 1; f.go(c); f.devs = []; s = f.go(c)
ok(s['state'] == 'no-device' and c.mode == 'bridge', 'unplugged while NovaLCT is bridged -> bridge stopped, NovaLCT\'s choice kept')
f.devs = [dict(USB)]; s = f.go(c)
ok(s['state'] == 'bridged' and len(f.did('arm')) == 3, 'plugged in again while bridged -> bridge again, still bridged (%s)' % s['state'])
f, c = fresh(); f.lct(21); f.arm_err = 'Couldn’t open (busy)'; c.tick(); c.allow()
f.devs = []; s = f.go(c)
ok(s['state'] == 'released' and s['sub'] == 'capturing' and not f.did('stop'), 'unplugged while released and recording -> the capture runs on (it sees a re-plug), no new prompt')
f.devs = [dict(USB)]; s = f.go(c)
ok(s['state'] == 'released' and len(f.did('start')) == 1, 'plugged in again -> still released, same capture')
f.lct(); f.arm_err = ''; s = f.go(c)
ok(s['state'] == 'armed' and f.did('stop'), 'NovaLCT closed after the re-plug -> capture stopped, armed')

# ------------------------------------------------------------------ busy / error while NovaLCT is closed
f, c = fresh(); f.arm_err = 'Couldn’t open the NovaStar USB device (busy)'; s = c.tick()
ok(s['state'] == 'busy' and s['say'].endswith('is in use by another program · trying again'), 'busy, NovaLCT closed -> %r' % s['say'])
f.go(c, s=1.0); n1 = len(f.did('arm'))
ok(n1 == 1, 'no retry before %g s' % A.REARM_RETRY)
f.arm_err = ''; s = f.go(c, s=A.REARM_RETRY)
ok(s['state'] == 'armed' and len(f.did('arm')) == 2, 'retried after %g s -> armed' % A.REARM_RETRY)
f, c = fresh(); f.procs = {'marsserverprovider.exe': [5]}; f.arm_err = 'Couldn’t open the NovaStar USB device (busy)'; s = c.tick()
ok(s['state'] == 'released' and c.cause == 'holder', 'busy and a NovaLCT program (MarsServerProvider) runs -> released to it, recorded passively')
f.procs = {'marsserverprovider.exe': [5], 'novalct.exe': [6]}; f.go(c); f.procs = {'marsserverprovider.exe': [5]}; s = f.go(c)
ok(s['state'] == 'released' and f.yielded and c.mode == 'direct', 'NovaLCT opens and closes meanwhile -> still released while that program runs')
f.procs = {}; f.arm_err = ''; s = f.go(c)
ok(s['state'] == 'armed' and not f.yielded, 'that program closed -> taken back, armed')
f, c = fresh(); f.arm_err = 'the relay could not listen on 127.0.0.42 (ports [5200])'; s = c.tick()
ok(s['state'] == 'error' and 'NovaLCT can’t reach it through Open Nova' in s['say'] and 'could not listen' in s['tip'], 'bridge can\'t listen -> "error", Open Nova still uses it (%r)' % s['say'])
f.lct(30); s = f.go(c)
ok(s['state'] == 'released' and f.yielded, 'NovaLCT starts while the bridge can\'t run -> released at once (NovaLCT can\'t come through us)')

# ------------------------------------------------------------------ a COM controller, a relay started by hand, macOS
f, c = fresh(); f.devs = [{'host': 'serial:COM3', 'label': 'COM3', 'kind': 'com', 'modelId': None}]; s = c.tick()
ok(s['state'] == 'armed' and f.did('arm') == [('arm', 'serial:COM3')] and s['say'] == 'controller on COM3 · ready for Open Nova and NovaLCT', 'COM controller -> bridged too (%r)' % s['say'])
f.lct(40); f.go(c); s = f.go(c, s=A.LCT_CONNECT_WAIT)
ok(s['state'] == 'released' and s['sub'] == 'com' and not f.did('detect') and not f.did('start'), 'COM released -> no USB capture (USBPcap records the NovaStar USB device)')
f, c = fresh(); f.rel = {'_obj': 999, 'opened': 0, 'clients': 0}; s = c.tick()
ok(s['state'] == 'manual' and not f.did('arm') and not f.did('disarm'), 'a relay started by hand -> "manual", left alone')
f.rel = None; c.hand(); s = f.go(c)
ok(s['state'] == 'manual' and s['sub'] == 'paused' and not f.did('arm'), 'stopped by hand -> paused a while (%r)' % s['say'])
s = f.go(c, s=A.HAND_PAUSE)
ok(s['state'] == 'armed', '%g s later -> automatic again' % A.HAND_PAUSE)
f, c = fresh(); c.tick(); f.rel = None; c.hand(); s = f.go(c)
ok(s['state'] == 'manual' and len(f.did('arm')) == 1, 'our bridge stopped by hand -> not re-armed at once (no fight with the tester)')
f, c = fresh(); f.win = False; f.lct(1); s = c.tick()
ok(s['state'] == 'off' and not f.calls and s['say'] == '', 'macOS / Linux: off, nothing touched, nothing shown')

# ------------------------------------------------------------------ the status shape the app reads
s = A.Coordinator(Fake()).tick()
ok(all(k in s for k in ('state', 'sub', 'say', 'tip', 'action', 'device', 'lct', 'history', 'timings')), 'status() has what the app reads')
ok(A.POLL_S <= 3 and A.LCT_CONNECT_WAIT == 15.0, 'timings: look every %g s, NovaLCT gets %g s' % (A.POLL_S, A.LCT_CONNECT_WAIT))

# ------------------------------------------------------------------ the real Env: cheap process list, NovaLCT names
if A.IS_WIN:
    import time
    t0 = time.time(); ps = A.win_processes(); dt = time.time() - t0
    ok(len(ps) > 5 and any(p['name'].lower() in ('python.exe', 'pythonw.exe', 'python3.exe') or p['pid'] == os.getpid() for p in ps), 'process list through Toolhelp32 (%d processes, %.0f ms)' % (len(ps), dt * 1000))
    ok(dt < 0.25, 'cheap enough to ask every %g s (%.0f ms)' % (A.POLL_S, dt * 1000))
    e = A.Env(); pr = e.processes()
    ok(isinstance(pr, dict) and all(k in A.holder_exes() or k in A.LCT_EXES for k in pr), 'Env.processes: the NovaLCT family only (%s)' % (sorted(pr) or 'none running'))
else:
    print('SKIP the Windows process list (not Windows)')
ok('novalct.exe' in A.holder_exes() and 'marsserverprovider.exe' in A.holder_exes(), 'the NovaLCT family comes from vendortap.APPS')

# ------------------------------------------------------------------ novalink: Open Nova doesn't open a device NovaLCT has
import novalink as nl   # noqa: E402
key = 'usb:0483:5720@test-1'
nl.usb_yield(key, 'NovaLCT is using the USB controller: Open Nova leaves it alone until NovaLCT closes')
try:
    nl.open_link(key, None, 0.5, wait=0.5); got = 'opened'
except nl.LinkBusy as e: got = str(e)
except Exception as e: got = '%s: %s' % (type(e).__name__, e)   # noqa: BLE001
ok(got.startswith('NovaLCT is using'), 'yielded -> open_link refuses with the plain reason, before touching USB (%s)' % got[:70])
r = nl.probe_usb({'host': key, 'name': 'test-1', 'label': 'USB test-1'})
ok(r.get('busy') and r.get('yielded') and not r.get('answered'), 'yielded -> the search\'s probe doesn\'t open it either')
nl.usb_yield(key, None)
try:
    nl.open_link(key, None, 0.5, wait=0.5); got = 'opened'
except Exception as e: got = '%s: %s' % (type(e).__name__, e)   # noqa: BLE001
ok(not got.startswith('NovaLCT is using'), 'taken back -> opened as usual (here: no such device: %s)' % got[:70])
nl.usb_yield('serial:COM77', 'NovaLCT has it')
ok(nl.usb_yielded('serial:COM77@1048576') == 'NovaLCT has it' and nl.usb_yielded('serial:COM78') == '', 'a COM port is yielded whatever speed it is asked at')
nl.usb_yield('serial:COM77', None)

# ------------------------------------------------------------------ the helper's route
import vendortap   # noqa: E402
r = vendortap.handle('/api/hw/vendor/usb-auto', {})
ok(r.get('ok') and 'state' in r and 'say' in r, 'route usb-auto answers (%s)' % r.get('state'))
r = vendortap.handle('/api/hw/vendor/usb-auto-nope', {})
ok(not r.get('ok'), 'unknown usb-auto route -> error')
A._started.clear(); A.run()
ok(not A._started.is_set(), 'OPENNOVA_USB_AUTO=0 keeps the coordinator off (tests, a helper that must not)')

print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
