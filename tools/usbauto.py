"""usbauto.py - the USB coordinator: a NovaStar controller on USB (NovaPro HD: USB only) is used by Open Nova AND by
NovaLCT, and everything NovaLCT says to it is recorded, without the tester choosing anything. Stdlib only.
Docs: docs/USB_CAPTURE.md and docs/VENDOR_CAPTURE.md (the automatic flow), docs/USB_NOVA_DEVICE.md (the device).

User, 2026-11-16: "i dont want them to have to choose the bridge. the app needs to be able to do both and smart enough to
understand the need to do both".

The helper starts run() (novalink serve). Every POLL_S it looks (cheap: the process list through Toolhelp32, the device
through cfgmgr32; no libusb walk unless the device just came) and moves between these states:

  no-device   no NovaStar USB device (0483:5720) and no COM controller Open Nova has identified: nothing to do (hidden)
  armed       the device is here and NovaLCT isn't running: Open Nova may use it, and the bridge (vendortap.BridgeRelay)
              is armed, so a NovaLCT opened later finds the controller through Open Nova (127.0.0.42) and is recorded
  waiting     NovaLCT runs and the bridge is armed: give it LCT_CONNECT_WAIT s to connect through it
  bridged     NovaLCT connected through the bridge: both work, everything is recorded (sticky until NovaLCT exits)
  released    NovaLCT didn't connect in time, or it already had the device (the bridge couldn't open it): the bridge
              and Open Nova's own link let go (novalink.usb_yield: Open Nova doesn't open it again while NovaLCT runs),
              and USBPcap records it passively (tools/usbcap.py) when installed and the tester allowed it this session;
              else the status says the one next step (Install USB capture / Allow USB recording)
  busy        the device couldn't be opened and no NovaLCT program runs: tried again every REARM_RETRY s
  error       the bridge couldn't start for another reason (its port taken …): Open Nova still uses the device itself
  manual      a NovaLCT relay started by hand (Vendor apps ▸ Advanced) runs: the coordinator stays out of its way
  off         not Windows (NovaLCT is Windows-only): Open Nova just uses the device; no bridge, no capture
NovaLCT exits -> its capture is stopped (and decoded), the device taken back, the bridge armed again.

Consent: USBPcap needs one UAC prompt per capture. None is ever shown before the tester's "Allow USB recording" (once
per helper session: allow()); after that the coordinator starts captures when it needs them. A prompt answered No ends
it for the session (usbcap's retry stays False). Every state change is a recorder mark (source 'vendor').
Only NovaLCT-family controllers get the bridge: NovaStar's USB device and COM ports Open Nova's own probe identified.

  STATE / status()         what the app shows (state, say, tip, action: 'install' / 'allow' / None)
  allow() / install()      the two one-time actions (the app's buttons)
  Coordinator(env)         the logic; Env = the real world (tests pass a fake one)
  handle(path, body)       /api/hw/vendor/usb-auto, usb-auto-allow, usb-auto-install
"""
import os
import sys
import threading
import time

IS_WIN = sys.platform == 'win32'

# Timings: easy to change after the live test on the tester's PC (NovaLCT may scan USB about every 30 s and may hold the
# device only while it is busy; neither is confirmed yet).
POLL_S = 2.5               # one look every this many seconds
LCT_CONNECT_WAIT = 15.0    # s NovaLCT gets to connect through the bridge before Open Nova lets go of the device
REARM_RETRY = 5.0          # s between tries to open the device for the bridge when it was busy (NovaLCT just closed …)
CAP_DETECT_EVERY = 10.0    # s between USBPcap state checks while a capture is wanted but can't run
HAND_PAUSE = 120.0         # s the coordinator stays out after the tester started / stopped a NovaLCT relay by hand
CAP_MINUTES, CAP_MB = 8 * 60, 1000   # one automatic capture's limits; when one ends by itself the next starts (consent stands)
# NovaLCT itself (the 15 s rule), and every program of its family that may hold the device (vendortap.APPS, family 'lct')
LCT_EXES = ('novalct.exe', 'novalct lite.exe')


def _vt():
    import vendortap
    return vendortap


def holder_exes():
    try: return tuple(x for a in _vt().APPS if a['family'] == 'lct' for x in a['exe'] if x.endswith('.exe'))
    except Exception:  # noqa: BLE001
        return LCT_EXES


def win_processes():
    """[{name, pid}] of every process: Toolhelp32 (a few ms, no child process); `tasklist` parsed by vendortap if that fails."""
    try:
        import ctypes
        from ctypes import wintypes

        class PE(ctypes.Structure):
            _fields_ = [('dwSize', wintypes.DWORD), ('cntUsage', wintypes.DWORD), ('th32ProcessID', wintypes.DWORD),
                        ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', wintypes.DWORD), ('cntThreads', wintypes.DWORD),
                        ('th32ParentProcessID', wintypes.DWORD), ('pcPriClassBase', ctypes.c_long), ('dwFlags', wintypes.DWORD),
                        ('szExeFile', ctypes.c_wchar * 260)]
        k = ctypes.WinDLL('kernel32', use_last_error=True)
        k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        k.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
        k.Process32FirstW.argtypes = k.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(PE)]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        h = k.CreateToolhelp32Snapshot(2, 0)                     # TH32CS_SNAPPROCESS
        if not h or h == wintypes.HANDLE(-1).value: raise OSError('no snapshot')
        out, e = [], PE(); e.dwSize = ctypes.sizeof(PE)
        try:
            ok = k.Process32FirstW(h, ctypes.byref(e))
            while ok:
                out.append({'name': e.szExeFile, 'pid': int(e.th32ProcessID)})
                ok = k.Process32NextW(h, ctypes.byref(e))
        finally: k.CloseHandle(h)
        if out: return out
    except (OSError, AttributeError, ValueError):
        pass
    vt = _vt()
    return vt.parse_tasklist(vt._run(['tasklist', '/FO', 'CSV', '/NH'], 15))


class Env:
    """The real world for the Coordinator. Tests replace it with a fake that has the same methods."""
    win = IS_WIN

    def now(self): return time.time()

    def processes(self):
        """{exe name (lower case): [pids]} of the NovaLCT family only."""
        want, out = set(holder_exes()) | set(LCT_EXES), {}
        for p in win_processes():
            n = str(p['name']).lower()
            if n in want: out.setdefault(n, []).append(p['pid'])
        return out

    def __init__(self):
        self._usb = {'present': None, 'list': []}

    def devices(self):
        """The NovaLCT-family controllers here now: NovaStar's USB device(s), then COM ports Open Nova's probe identified.
        [{host, label, kind: 'usb' / 'com', modelId?}]. The libusb listing only when cfgmgr32 says the device came (or can't say)."""
        nl = _vt()._links()                                     # the helper's own copy (it runs as __main__)
        out = []
        pres = None
        try:
            import usbcap
            pres = usbcap.nova_present()
        except Exception:  # noqa: BLE001
            pres = None
        if pres is False: self._usb = {'present': False, 'list': []}
        elif pres is None or self._usb['present'] is not True or not self._usb['list']:
            try: ds, _ = nl.usb_devices()
            except Exception:  # noqa: BLE001
                ds = []
            self._usb = {'present': pres, 'list': ds}
        for d in self._usb['list']:
            seen = nl.USB_SEEN.get(d['host']) or {}
            out.append({'host': d['host'], 'label': d.get('label') or 'USB', 'kind': 'usb', 'modelId': seen.get('modelId')})
        com = [(n, s) for n, s in sorted(getattr(nl, 'SER_SEEN', {}).items()) if s.get('answered') and s.get('host')]
        if com:                                                  # only ports still here (the registry's list)
            try: here = set(p['name'] for p in nl.serial_ports())
            except Exception:  # noqa: BLE001
                here = set()
            com = [(n, s) for n, s in com if n in here]
        for host, s in com:
            out.append({'host': s['host'], 'label': str(s.get('name') or host), 'kind': 'com', 'modelId': s.get('modelId')})
        return out

    def relay(self):
        """The NovaLCT relay running now (ours or one started by hand) -> its status, or None."""
        vt = _vt()
        with vt._lock: r = vt.RELAYS.get('lct')
        if r is None or r.stop_ev.is_set(): return None
        return dict(r.status(), _obj=id(r))

    def arm(self, host):
        """Start the bridge to host -> {ok, relay | error}."""
        vt = _vt()
        return vt.relay_start({'kind': 'lct', 'target': host})

    def disarm(self):
        _vt().relay_stop('lct')

    def yield_link(self, host, why):
        """Open Nova lets go of the device and doesn't open it again until unyield (novalink.usb_yield)."""
        nl = _vt()._links()                                     # the helper's own copy (it runs as __main__)
        nl.usb_yield(host, why)

    def unyield(self, host):
        nl = _vt()._links()                                     # the helper's own copy (it runs as __main__)
        nl.usb_yield(host, None)

    def cap_detect(self):
        import usbcap
        return usbcap.detect(devices=False)

    def cap_start(self):
        import usbcap
        return usbcap.start(minutes=CAP_MINUTES, max_mb=CAP_MB, consent=True)

    def cap_status(self):
        import usbcap
        return usbcap.status()

    def cap_stop(self):
        import usbcap
        return usbcap.stop()

    def cap_install(self):
        import usbcap
        return usbcap.install()

    def cap_install_status(self):
        import usbcap
        return usbcap.install_status()

    def mark(self, text):
        import wirelog
        wirelog.mark('USB auto: ' + text, source='vendor')


NAMES = {}   # device host -> the model its bridge learned (ModelID read), kept for the released states


def _dev_name(dev, relay=None):
    if dev is None: return 'controller'
    m = (relay or {}).get('model')
    if m: NAMES[dev['host']] = m
    m = m or NAMES.get(dev['host'])
    if not m and dev.get('modelId') is not None:
        try: m = _vt().model_name(dev['modelId'])
        except Exception:  # noqa: BLE001
            m = ''
    if dev['kind'] == 'com': return (m or 'controller') + ' on ' + dev['label'].split(' ')[0]
    return m or 'USB controller'


class Coordinator:
    def __init__(self, env=None):
        self.env = env or Env()
        self.lock = threading.RLock()
        self.state, self.sub, self.say, self.tip, self.action = 'off' if not self.env.win else 'no-device', '', '', '', None
        self.dev = None            # the controller looked after: {host, label, kind}
        self.lct_pids = None       # NovaLCT's pids while it runs (a new set = a restart)
        self.lct_since = 0.0       # when NovaLCT was first seen this run
        self.mode = None           # this NovaLCT run: None (deciding) / 'bridge' / 'direct' (released)
        self.cause = ''            # released because of: 'lct' (NovaLCT) / 'holder' (another NovaLCT program had it)
        self.ours = None           # id() of the relay this coordinator started
        self.armed_at = 0.0
        self.next_arm = 0.0
        self.arm_err = ''
        self.yielded = None        # the host Open Nova let go of
        self.consent = False       # the tester's "Allow USB recording" this session
        self.refused = False       # Windows' prompt answered No this session: never asked again
        self.cap_own = False       # a capture this coordinator started is running / waiting for the prompt
        self.cap_failed = ''       # a capture start failed this NovaLCT run (no automatic retry: the button again)
        self.cap_state, self.cap_say, self.cap_next = '', '', 0.0
        self.installing = False
        self.hand_until = 0.0      # a relay started / stopped by hand (Vendor apps ▸ Advanced): stay out until then
        self.history = []

    # ---- recording
    def _set(self, state, sub=''):
        if (state, sub) != (self.state, self.sub):
            self.history = (self.history + [{'at': round(self.env.now(), 1), 'state': state, 'sub': sub}])[-30:]
            self.env.mark('%s%s -> %s%s (%s)' % (self.state, '/' + self.sub if self.sub else '', state, '/' + sub if sub else '',
                                                  self.dev['host'] if self.dev else 'no device'))
        self.state, self.sub = state, sub

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
        if not env.win: return self._set('off')
        now = env.now()
        r = env.relay()
        if r is not None and r.get('_obj') != self.ours:            # a relay started by hand: not ours to touch
            self._lct_check(env.processes(), now)
            return self._set('manual')
        if r is None and self.ours is not None:                     # ours ended (stopped by hand / failed)
            self.ours = None
        if r is None and now < self.hand_until:                     # the tester works the relay by hand just now
            self._lct_check(env.processes(), now)
            return self._set('manual', 'paused')
        procs = env.processes()
        lct = self._lct_check(procs, now)
        holders = sorted(n for n in procs if n not in LCT_EXES)
        devs = env.devices()
        dev = next((d for d in devs if self.dev and d['host'] == self.dev['host']), None) or (devs[0] if devs else None)
        if dev is None:
            if self.dev is not None:
                env.mark('%s unplugged' % self.dev['host'])
                self._disarm('the device was unplugged')
            self.dev = None
            if self.mode == 'direct' and (lct or self.cause == 'holder'): return self._cap_keep()   # a capture runs on (it sees a re-plug)
            return self._set('no-device')
        if self.dev is None or self.dev['host'] != dev['host']:
            env.mark('%s here (%s)' % (dev['host'], dev['kind']))
        self.dev = dev
        if self.mode == 'direct' and self.cause == 'holder' and not lct and not holders:
            self._back('the NovaLCT program holding it closed')
        if not lct and self.mode != 'direct':                      # state 1: Open Nova uses it, the bridge waits for NovaLCT
            if self.yielded: self._back('NovaLCT is not running')
            if self.ours is None:
                if now < self.next_arm: return self._set('busy' if self.state == 'busy' else 'error' if self.state == 'error' else 'armed')
                res = self._arm(now)
                if not res.get('ok'):
                    if self._busy_err(res) and holders:          # another NovaLCT program has it: don't fight, record it
                        self.cause = 'holder'; return self._release('%s has the device' % holders[0])
                    self.next_arm = now + REARM_RETRY
                    return self._set('busy' if self._busy_err(res) else 'error')
            return self._set('armed')
        if not lct: return self._cap_keep()                        # released by a holder program that still runs
        # NovaLCT runs
        if self.mode == 'direct': return self._cap_keep()
        if self.mode == 'bridge' or (r is not None and r.get('_obj') == self.ours and (r.get('opened') or r.get('clients'))):
            if self.mode != 'bridge': env.mark('NovaLCT connected through the bridge')
            self.mode = 'bridge'
            if self.ours is None and now >= self.next_arm:         # re-plugged: the bridge again
                res = self._arm(now)
                if not res.get('ok'): self.next_arm = now + REARM_RETRY
            return self._set('bridged')
        if self.ours is None:                                      # NovaLCT runs and nothing is armed: try once, else it has it
            res = self._arm(now)
            if not res.get('ok'):
                self.cause = 'lct'
                return self._release('the bridge couldn’t open the device (%s)' % res.get('error', '') if self._busy_err(res) else 'the bridge couldn’t start (%s)' % res.get('error', ''))
        if now - max(self.lct_since, self.armed_at) >= LCT_CONNECT_WAIT:
            self.cause = 'lct'
            return self._release('NovaLCT didn’t connect through the bridge within %g s' % LCT_CONNECT_WAIT)
        return self._set('waiting')

    def _lct_check(self, procs, now):
        pids = sorted(p for n in LCT_EXES for p in procs.get(n, []))
        if self.lct_pids and pids and not set(pids) & set(self.lct_pids):   # closed and opened again between two looks
            self._lct_exit(); self.env.mark('NovaLCT restarted (pids %s)' % pids)
            self.lct_since = now
        elif pids and not self.lct_pids:
            self.env.mark('NovaLCT started (pids %s)' % pids); self.lct_since = now
        elif self.lct_pids and not pids:
            self.env.mark('NovaLCT closed'); self._lct_exit()
        self.lct_pids = pids or None
        return bool(pids)

    def _lct_exit(self):
        """NovaLCT closed: its capture stopped (and decoded), the device taken back (the bridge is armed by the next look)."""
        if self.cap_own and self.cause != 'holder': self._cap_stop('NovaLCT closed')
        if self.mode == 'bridge' and self.ours is not None:
            self._disarm('NovaLCT closed: the bridge starts again fresh')   # a new recording file for the next NovaLCT
        self.mode, self.cap_failed = 'direct' if self.cause == 'holder' else None, ''   # another NovaLCT program still has it
        if self.cause != 'holder': self._back('NovaLCT closed')
        self.next_arm = 0.0

    def _busy_err(self, res):
        e = str(res.get('error') or '')
        return 'Couldn’t open' in e or 'busy' in e.lower() or 'in use' in e.lower() or 'access' in e.lower()

    def _arm(self, now):
        res = self.env.arm(self.dev['host'])
        if res.get('ok'):
            self.ours, self.armed_at, self.arm_err = (res.get('relay') or {}).get('_obj') or self._relay_id(), now, ''
            _dev_name(self.dev, res.get('relay'))                  # remember its model name
            self.env.mark('bridge armed for %s (%s)' % (self.dev['host'], (res.get('relay') or {}).get('answer', '')))
        else:
            self.arm_err = str(res.get('error') or '')
            self.env.mark('bridge not armed: %s' % self.arm_err)
        return res

    def _relay_id(self):
        r = self.env.relay()
        return r.get('_obj') if r else None

    def _disarm(self, why):
        if self.ours is not None:
            self.env.disarm(); self.ours = None
            self.env.mark('bridge stopped: %s' % why)

    def _release(self, why):
        """Open Nova lets go of the device (the bridge and its own link), then records passively."""
        self._disarm(why)
        if self.dev is not None:
            self.env.yield_link(self.dev['host'], 'NovaLCT is using the %s: Open Nova leaves it alone until NovaLCT closes' % _dev_name(self.dev))
            self.yielded = self.dev['host']
        self.mode = 'direct'
        self.env.mark('released the device: %s' % why)
        return self._cap_keep()

    def _back(self, why):
        if self.yielded:
            self.env.unyield(self.yielded); self.env.mark('took the device back: %s' % why)
        self.yielded, self.cause = None, ''
        if self.mode == 'direct': self.mode = None
        if self.cap_own: self._cap_stop(why)

    # ---- passive capture while NovaLCT has the device
    def _cap_keep(self):
        """Released: keep a capture running when it can, else say why (the one next step)."""
        if self.dev is not None and self.dev['kind'] == 'com': return self._set('released', 'com')
        now = self.env.now()
        if self.cap_own:
            s = self.env.cap_status()
            if s.get('running'): return self._set('released', 'capturing' if s.get('state') == 'capturing' else 'asking')
            if s.get('state') == 'refused': self.refused = True
            res = self._cap_stop('it ended by itself (%s)' % s.get('state'))
            if self.refused: return self._set('released', 'refused')
            if s.get('state') == 'failed' or (res.get('state') == 'failed'):
                self.cap_failed = s.get('say') or res.get('error') or 'failed'
        if self.refused: return self._set('released', 'refused')
        if self.installing:
            ist = self.env.cap_install_status()
            if ist.get('running'): return self._set('released', 'installing')
            self.installing = False; self.cap_next = 0.0
            res = ist.get('result') or {}
            self.env.mark('USBPcap installer finished: %s' % ('restart needed' if res.get('rebootNeeded') else 'ok' if res.get('ok') else res.get('error') or res.get('say') or 'not installed'))
        if self.cap_failed and not self.consent: return self._set('released', 'failed')
        if now >= self.cap_next or not self.cap_state:
            d = self.env.cap_detect(); self.cap_next = now + CAP_DETECT_EVERY
            self.cap_state, self.cap_say = d.get('state', ''), d.get('say', '')
        if self.cap_state != 'ready':
            return self._set('released', {'not-installed': 'not-installed', 'reboot': 'reboot'}.get(self.cap_state, 'unavailable'))
        if not self.consent: return self._set('released', 'needs-consent')
        r = self.env.cap_start()
        st = r.get('state', '')
        if r.get('ok'):
            self.cap_own = True; self.env.mark('USB capture started (%s)' % st)
            return self._set('released', 'capturing' if st == 'capturing' else 'asking')
        if st == 'refused': self.refused = True; return self._set('released', 'refused')
        if st == 'needs-consent': self.consent = False; return self._set('released', 'needs-consent')
        if st in ('not-installed', 'reboot', 'no-cmd', 'unsupported'):
            self.cap_state, self.cap_say = st, r.get('say', ''); return self._cap_keep_state()
        if st == 'no-device': return self._set('released', 'no-device')
        self.cap_failed, self.consent = r.get('say') or r.get('error') or st, False   # a failed start: the tester clicks again
        self.env.mark('USB capture didn’t start: %s' % self.cap_failed)
        return self._set('released', 'failed')

    def _cap_keep_state(self):
        return self._set('released', {'not-installed': 'not-installed', 'reboot': 'reboot'}.get(self.cap_state, 'unavailable'))

    def _cap_stop(self, why):
        self.cap_own = False
        r = self.env.cap_stop() or {}
        self.env.mark('USB capture stopped (%s): %s' % (why, '%s records' % r['total'] if r.get('total') is not None else r.get('say') or r.get('error') or r.get('state')))
        return r

    def hand(self):
        """The tester started / stopped a NovaLCT relay by hand (vendortap's relay-start / relay-stop routes)."""
        with self.lock:
            self.hand_until = self.env.now() + HAND_PAUSE
            if self.ours is not None and self.env.relay() is None: self.ours = None
            self.env.mark('a NovaLCT relay was started / stopped by hand: automatic handling waits %g s' % HAND_PAUSE)

    # ---- the tester's two one-time actions
    def allow(self):
        """"Allow USB recording": the tester's OK for Windows' prompt, this helper session. Starts the capture now when one is wanted."""
        with self.lock:
            if self.refused:
                return dict(self.status(), ok=False, error='Windows’ prompt was answered No this session: USB recording stays off until Open Nova is started again.')
            self.consent, self.cap_failed, self.cap_next = True, '', 0.0
            self.env.mark('the tester allowed USB recording (this session)')
        return dict(self.tick(), ok=True)

    def install(self):
        """"Install USB capture": USBPcap's own installer (Windows' prompt, its pages); the state follows by itself."""
        with self.lock:
            r = self.env.cap_install()
            if r.get('ok'): self.installing = True; self.env.mark('the tester started the USB capture installer')
            self.cap_next = 0.0
        return dict(self.tick(), ok=bool(r.get('ok')), error=r.get('error'), message=r.get('say'))

    # ---- what the app shows
    def _words(self):
        st, sub, dv = self.state, self.sub, _dev_name(self.dev, self.env.relay() if self.state in ('armed', 'bridged', 'waiting') else None)
        act, tip = None, ''
        if st in ('off', 'no-device'): say = ''
        elif st == 'manual' and sub == 'paused': say, tip = 'USB handled by hand for now (Vendor apps ▸ Advanced)', 'A relay was started or stopped by hand: automatic handling starts again %g s later.' % HAND_PAUSE
        elif st == 'manual': say, tip = 'A NovaLCT relay started by hand is running (Vendor apps ▸ Advanced)', 'Automatic USB handling waits until it is stopped.'
        elif st == 'armed':
            say = '%s on USB · ready for Open Nova and NovaLCT' % dv if self.dev['kind'] == 'usb' else '%s · ready for Open Nova and NovaLCT' % dv
            tip = 'Open NovaLCT as usual: it finds the controller through Open Nova (127.0.0.42) and everything it sends is recorded.'
        elif st == 'waiting': say, tip = 'NovaLCT is open · waiting for it to connect through Open Nova', 'If it doesn’t within %g s, Open Nova lets go of the controller so NovaLCT can use it directly.' % LCT_CONNECT_WAIT
        elif st == 'bridged': say, tip = 'NovaLCT connected through Open Nova · recording', 'NovaLCT and Open Nova share the controller; both sides are recorded (Tools ▸ Diagnostics).'
        elif st == 'busy': say, tip = '%s is in use by another program · trying again' % dv, self.arm_err
        elif st == 'error': say, tip = '%s: NovaLCT can’t reach it through Open Nova' % dv, self.arm_err + ' Open Nova still uses it itself.'
        else:   # released
            who = 'NovaLCT has the %s' % dv
            say = {'capturing': who + ' · recording', 'asking': who + ' · Windows is asking to allow USB recording',
                   'needs-consent': who + ' · not recorded yet', 'not-installed': who + ' · not recorded yet',
                   'installing': who + ' · installing USB capture…', 'reboot': who + ' · restart the computer once to record it',
                   'refused': who + ' · not recorded (Windows’ prompt was answered No)', 'failed': who + ' · not recorded: USB recording didn’t start',
                   'unavailable': who + ' · not recorded', 'no-device': who + ' · not recorded (unplugged?)',
                   'com': who + ' · not recorded (USB recording is for NovaStar’s USB device)'}.get(sub, who)
            tip = {'capturing': 'USBPcap watches the USB traffic; NovaLCT keeps the controller. Open Nova uses it again when NovaLCT closes.',
                   'asking': 'Click Yes in Windows’ prompt: USBPcap only lets administrators record.',
                   'needs-consent': 'Windows asks for permission once (USBPcap only lets administrators record). NovaLCT keeps the controller.',
                   'not-installed': 'USBPcap (free, open source; the USB recorder Wireshark uses) is installed once, then the computer restarts.',
                   'failed': self.cap_failed, 'unavailable': self.cap_say, 'refused': 'Start Open Nova again to be asked again.'}.get(sub, '')
            act = 'allow' if sub in ('needs-consent', 'failed') else 'install' if sub == 'not-installed' else None
        self.say, self.tip, self.action = say, tip, act

    def status(self):
        return {'ok': True, 'state': self.state, 'sub': self.sub, 'say': self.say, 'tip': self.tip, 'action': self.action,
                'device': dict(self.dev) if self.dev else None, 'lct': bool(self.lct_pids), 'mode': self.mode, 'consent': self.consent,
                'refused': self.refused, 'capturing': self.cap_own, 'history': list(self.history[-10:]),
                'timings': {'poll': POLL_S, 'lctConnectWait': LCT_CONNECT_WAIT, 'rearm': REARM_RETRY}}


AUTO = None
_started = threading.Event()


def get():
    global AUTO
    if AUTO is None: AUTO = Coordinator()
    return AUTO


def run(stop=None):
    """The helper's thread (novalink serve): a look every POLL_S s, for as long as the helper runs. OPENNOVA_USB_AUTO=0 = off."""
    if os.environ.get('OPENNOVA_USB_AUTO') == '0' or _started.is_set(): return
    _started.set()
    c = get()
    if not c.env.win: c.tick(); return                     # macOS / Linux: Open Nova just uses the device
    while not (stop and stop.is_set()):
        c.tick()
        time.sleep(POLL_S)


def handle(p, body):
    """vendortap.handle passes /api/hw/vendor/usb-auto* here."""
    c = get()
    if p == 'usb-auto': return dict(c.status(), ok=True) if _started.is_set() or not c.env.win else dict(c.status(), ok=True, running=False)
    if p == 'usb-auto-allow': return c.allow()
    if p == 'usb-auto-install': return c.install()
    return {'ok': False, 'error': 'unknown: ' + p}
