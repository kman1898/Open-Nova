"""sysdiag.py - what a problem report needs to know about the tester's computer (Help ▸ Report a problem, tools/alpha.py).
Stdlib only; Windows, macOS, Linux. Read-only: nothing is written, nothing is sent on the network, no admin rights needed.
Every function returns its result and never raises: what couldn't be read is said in the result ('error' / 'errors').

    system_info()        -> {system, release, version, pretty, machine, arch, python, locale, errors}
        arch    Windows: PROCESSOR_ARCHITECTURE / PROCESSOR_ARCHITEW6432 and the machine's own (IsWow64Process2), so x86
                on x64 and x64 on ARM64 show; macOS: rosetta (an Intel Python on Apple silicon)
        python  {executable, version, implementation, bits, prefix, basePrefix, bundled (the Open Nova folder's python/)}
        locale  {locale, preferredEncoding, filesystemEncoding, stdoutEncoding, ansiCodePage, oemCodePage}
    libusb_tries()       -> [{lib, path, exists, result, inUse}]: every USB library path the helper itself tries
                            (novalink._libusb_paths / _libusb0_paths), loaded here once each (no function in it called),
                            and the ones the helper has loaded now (inUse True)
    usb_serial_drivers() -> {system, devices: [{kind, vid, pid, name, driver, ...}], ports, errors, ...}: NovaStar USB
                            (0483:5720), Silicon Labs CP210x (10C4) and FTDI (0403) devices and the driver each has;
                            Windows: + services (libusb0, WinUSB, silabser, FTDIBUS, FTSER2K, usbser), Linux: + groups
    udp_owners(ports)    -> {port: [{pid, name, local}], 'note': str, 'error': str}: which programs hold those UDP ports
    firewall(exe)        -> {system, ...}: the active profile / state and the rules that name this Python (Windows), the
                            application firewall's settings (macOS), what can be said without root (Linux)
    report() / report_md()   all of the above for the problem report (json / Markdown lines like netif.report_md)

The parsers take the commands' text (tests feed them captured output): parse_netstat, parse_tasklist, parse_lsof,
parse_ss, parse_ioreg, rule_blocks, profile_lines; win_usb(reg) and linux_usb(fs) take a stand-in for the registry /
the file system.
"""
import csv
import io
import json
import locale
import os
import platform
import re
import shutil
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
NOVA = os.path.dirname(HERE)
UDP_PORTS = (3800, 5600, 54622, 54623, 54624)   # LCT / H discovery, Unico search, COEX search
USB_KINDS = (('0483', '5720', 'NovaStar'), ('10C4', None, 'Silicon Labs CP210x'), ('0403', None, 'FTDI'))
WIN_SERVICES = ('libusb0', 'WinUSB', 'silabser', 'FTDIBUS', 'FTSER2K', 'usbser')
_NOWIN = {'creationflags': 0x08000000} if sys.platform == 'win32' else {}


def _err(e):
    return '%s: %s' % (type(e).__name__, e)


def _oem():
    try:
        import ctypes
        return 'cp%d' % ctypes.windll.kernel32.GetOEMCP()
    except Exception:  # noqa: BLE001 - not Windows
        return None


def _decode(b, oem=None):
    """Console-program output -> text: UTF-8 when it is, else the Windows OEM code page (netstat, netsh write in it),
    else UTF-8 with replacements."""
    try: return b.decode('utf-8')
    except UnicodeDecodeError: pass
    oem = oem or (_oem() if sys.platform == 'win32' else None)
    try: return b.decode(oem or 'utf-8', 'replace')
    except LookupError: return b.decode('utf-8', 'replace')


def _run(cmd, timeout=10):
    """-> (text, problem): problem '' when it ran and said something; never raises, never opens a window."""
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, timeout=timeout, **_NOWIN)
    except subprocess.TimeoutExpired:
        return '', '%s: no answer within %d s' % (cmd[0], timeout)
    except Exception as e:  # noqa: BLE001 - not installed, not allowed
        return '', '%s: %s' % (cmd[0], _err(e))
    out = _decode(p.stdout or b'')
    if not out.strip():
        return out, '%s: exit code %s%s' % (cmd[0], p.returncode, (', ' + _decode(p.stderr or b'').strip()[:300]) if p.stderr else '')
    return out, ''


# ------------------------------------------------------------------ the system and Python
def system_info():
    r = {'system': platform.system(), 'release': platform.release(), 'version': platform.version(), 'pretty': '',
         'machine': platform.machine(), 'arch': {}, 'python': {}, 'locale': {}, 'errors': []}
    try:
        if sys.platform == 'win32':
            rel, ver, sp, kind = platform.win32_ver()
            ed = platform.win32_edition() if hasattr(platform, 'win32_edition') else ''
            r['pretty'] = 'Windows %s %s %s' % (rel, ed or '', ver)
            r['arch'] = {'PROCESSOR_ARCHITECTURE': os.environ.get('PROCESSOR_ARCHITECTURE', ''),
                         'PROCESSOR_ARCHITEW6432': os.environ.get('PROCESSOR_ARCHITEW6432', '')}
            try:                                    # the machine's own architecture (x64 Python on ARM64 Windows: emulated)
                import ctypes
                from ctypes import wintypes
                k32 = ctypes.windll.kernel32
                pm, nm = wintypes.USHORT(), wintypes.USHORT()
                k32.GetCurrentProcess.restype = wintypes.HANDLE
                if k32.IsWow64Process2(wintypes.HANDLE(k32.GetCurrentProcess()), ctypes.byref(pm), ctypes.byref(nm)):
                    names = {0x14c: 'x86', 0x8664: 'x64', 0xaa64: 'ARM64', 0x1c4: 'ARM'}
                    r['arch']['native'] = names.get(nm.value, hex(nm.value))
                    r['arch']['wow64'] = names.get(pm.value, hex(pm.value)) if pm.value else ''
            except Exception as e:  # noqa: BLE001 - Windows before 10 1709
                r['arch']['native'] = '? (%s)' % _err(e)
        elif sys.platform == 'darwin':
            ver, _, mach = platform.mac_ver()
            r['pretty'] = 'macOS %s (%s)' % (ver, mach or platform.machine())
            out, _ = _run(['sysctl', '-n', 'sysctl.proc_translated'], 5)
            r['arch'] = {'rosetta': out.strip() == '1'}
        else:
            try:
                with open('/etc/os-release', encoding='utf-8', errors='replace') as f:
                    m = re.search(r'^PRETTY_NAME="?(.*?)"?$', f.read(), re.M)
                r['pretty'] = m.group(1) if m else ''
            except OSError as e:
                r['errors'].append('/etc/os-release: %s' % _err(e))
            r['pretty'] = r['pretty'] or 'Linux %s' % platform.release()
    except Exception as e:  # noqa: BLE001
        r['errors'].append('os: %s' % _err(e))
    try:
        exe = sys.executable or ''
        bundle = os.path.normcase(os.path.join(NOVA, 'python') + os.sep)
        bundled = bool(exe) and any(os.path.normcase(x).startswith(bundle) for x in (exe, os.path.realpath(exe)))
        r['python'] = {'executable': exe, 'version': sys.version.split()[0], 'implementation': platform.python_implementation(),
                       'bits': struct.calcsize('P') * 8, 'prefix': sys.prefix, 'basePrefix': getattr(sys, 'base_prefix', sys.prefix),
                       'bundled': bundled, 'build': sys.version}
    except Exception as e:  # noqa: BLE001
        r['errors'].append('python: %s' % _err(e))
    try:
        L = {'locale': '', 'preferredEncoding': '', 'filesystemEncoding': sys.getfilesystemencoding(),
             'stdoutEncoding': getattr(sys.stdout, 'encoding', None) or ''}
        try: L['locale'] = '.'.join(x for x in locale.getlocale() if x) or '(C / not set)'
        except Exception as e: L['locale'] = '? (%s)' % _err(e)  # noqa: BLE001
        try: L['preferredEncoding'] = locale.getpreferredencoding(False)
        except Exception as e: L['preferredEncoding'] = '? (%s)' % _err(e)  # noqa: BLE001
        if sys.platform == 'win32':
            import ctypes
            L['ansiCodePage'], L['oemCodePage'] = ctypes.windll.kernel32.GetACP(), ctypes.windll.kernel32.GetOEMCP()
        r['locale'] = L
    except Exception as e:  # noqa: BLE001
        r['errors'].append('locale: %s' % _err(e))
    return r


# ------------------------------------------------------------------ USB libraries (the helper's own list of paths)
def _helper():
    """The helper module (novalink): '__main__' when the helper runs as `python novalink.py serve`, else the imported one,
    else imported here (no .pyc written)."""
    m = sys.modules.get('__main__')
    if m is not None and hasattr(m, '_libusb_paths'): return m
    if sys.modules.get('novalink') is not None: return sys.modules['novalink']
    keep = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        if HERE not in sys.path: sys.path.insert(0, HERE)
        import novalink
        return novalink
    finally:
        sys.dont_write_bytecode = keep


def try_load(path):
    """Load a library with ctypes and let it go again; no function in it is called. -> 'loaded' or the error."""
    try:
        import ctypes
        import _ctypes
        lib = (ctypes.WinDLL if sys.platform == 'win32' else ctypes.CDLL)(path)
        try:
            if sys.platform == 'win32': _ctypes.FreeLibrary(lib._handle)
            else: _ctypes.dlclose(lib._handle)
        except Exception:  # noqa: BLE001 - it stays loaded: harmless
            pass
        return 'loaded'
    except Exception as e:  # noqa: BLE001
        return _err(e)


def libusb_tries(helper=None, load=None):
    """helper / load: stand-ins (tests); default the helper module and try_load."""
    out = []
    try:
        h = helper or _helper()
    except Exception as e:  # noqa: BLE001
        return [{'lib': '?', 'path': '', 'exists': None, 'result': 'the helper (novalink.py) could not be loaded: %s' % _err(e), 'inUse': False}]
    load = load or try_load
    for lib, fn, win_only in (('libusb-1.0', '_libusb_paths', False), ('libusb0', '_libusb0_paths', True)):
        if win_only and sys.platform != 'win32': continue            # libusb0.dll: Windows only (as the helper)
        try:
            paths = list(getattr(h, fn)())
        except Exception as e:  # noqa: BLE001
            out.append({'lib': lib, 'path': '', 'exists': None, 'result': 'its path list could not be made: %s' % _err(e), 'inUse': False}); continue
        seen = set()
        for p in paths:
            if not p or p in seen: continue
            seen.add(p)
            ex = os.path.exists(p) if os.path.isabs(p) else None
            res = 'not there' if ex is False else load(p).replace(' Try using the full path with constructor syntax.', '')
            out.append({'lib': lib, 'path': p, 'exists': ex, 'result': res, 'inUse': False})
    for lib, name in (('libusb-1.0', '_LIBUSB'), ('libusb0', '_LIBUSB0')):
        try:
            got = list(getattr(h, name, None) or [])
        except Exception:  # noqa: BLE001
            got = []
        for x in got:
            if x is None:
                out.append({'lib': lib, 'path': '', 'exists': None, 'result': 'the helper tried it: none loaded', 'inUse': True}); continue
            v = getattr(x, 'version', '')
            out.append({'lib': lib, 'path': str(getattr(x, 'path', '') or ''), 'exists': None, 'inUse': True,
                        'result': 'in use by the helper (%s%s)' % (type(x).__name__, ', ' + str(v) if v else '')})
    return out


# ------------------------------------------------------------------ USB / serial devices and their drivers
def _kind(vid, pid):
    vid, pid = (vid or '').upper(), (pid or '').upper()
    for v, p, name in USB_KINDS:
        if vid == v and (p is None or pid == p): return name
    return ''


def _text(v):
    """A registry text like "@oem12.inf,%desc%;Real text" -> "Real text"."""
    if isinstance(v, (list, tuple)): v = ', '.join(str(x) for x in v)
    s = str(v if v is not None else '')
    return s.rsplit(';', 1)[1] if s.startswith('@') and ';' in s else s


class WinReg:
    """Read-only HKEY_LOCAL_MACHINE: subkeys(path) -> [names], values(path) -> {name: value}; OSError when it isn't there."""
    def __init__(self):
        import winreg
        self.w = winreg

    def subkeys(self, path):
        with self.w.OpenKey(self.w.HKEY_LOCAL_MACHINE, path, 0, self.w.KEY_READ) as k:
            return [self.w.EnumKey(k, i) for i in range(self.w.QueryInfoKey(k)[0])]

    def values(self, path):
        with self.w.OpenKey(self.w.HKEY_LOCAL_MACHINE, path, 0, self.w.KEY_READ) as k:
            out = {}
            for i in range(self.w.QueryInfoKey(k)[1]):
                n, v, _ = self.w.EnumValue(k, i)
                out[n] = v
            return out


def win_usb(reg=None):
    """Windows: every NovaStar / CP210x / FTDI device Windows has seen (Enum\\USB; plugged in now or before) with its
    driver, the driver services there are, the COM ports now."""
    r = {'system': 'windows', 'devices': [], 'services': {}, 'ports': [], 'errors': [],
         'note': 'devices Windows has seen (plugged in now or before)'}
    try: reg = reg or WinReg()
    except Exception as e:  # noqa: BLE001
        r['errors'].append('registry: %s' % _err(e)); return r
    base = r'SYSTEM\CurrentControlSet\Enum\USB'
    try: keys = reg.subkeys(base)
    except Exception as e:  # noqa: BLE001
        keys = []; r['errors'].append('%s: %s' % (base, _err(e)))
    for key in keys:
        m = re.match(r'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(.*)$', key, re.I)
        if not m or not _kind(m.group(1), m.group(2)): continue
        try: inst = reg.subkeys(base + '\\' + key)
        except Exception as e:  # noqa: BLE001
            r['errors'].append('%s: %s' % (key, _err(e))); continue
        for i in inst:
            try: v = reg.values(base + '\\' + key + '\\' + i)
            except Exception as e:  # noqa: BLE001
                v = {'error': _err(e)}
            d = {'kind': _kind(m.group(1), m.group(2)), 'vid': m.group(1).upper(), 'pid': m.group(2).upper(), 'key': key, 'instance': i,
                 'name': _text(v.get('FriendlyName') or v.get('DeviceDesc')), 'driver': _text(v.get('Service'))}
            for n in ('Service', 'DeviceDesc', 'Mfg', 'Driver', 'FriendlyName'):
                d[n] = _text(v.get(n))
            if 'error' in v: d['error'] = v['error']
            r['devices'].append(d)
    for s in WIN_SERVICES:
        try:
            v = reg.values(r'SYSTEM\CurrentControlSet\Services' + '\\' + s)
            r['services'][s] = {'exists': True, 'ImagePath': _text(v.get('ImagePath'))}
        except OSError:
            r['services'][s] = {'exists': False, 'ImagePath': ''}
        except Exception as e:  # noqa: BLE001
            r['services'][s] = {'exists': None, 'ImagePath': '', 'error': _err(e)}
    try:
        r['ports'] = sorted(({'device': k, 'port': str(v)} for k, v in reg.values(r'HARDWARE\DEVICEMAP\SERIALCOMM').items()), key=lambda x: x['port'])
    except OSError:
        pass                                          # no serial port at all: the key isn't there
    except Exception as e:  # noqa: BLE001
        r['errors'].append('SERIALCOMM: %s' % _err(e))
    return r


def parse_ioreg(text):
    """`ioreg -p IOUSB -l -w0` (macOS) -> [{kind, vid, pid, name, product, vendor, driver}] for NovaStar / CP210x / FTDI."""
    out, cur = [], None
    for line in text.splitlines():
        m = re.search(r'\+-o (.+?)(?:@[0-9a-fA-F]+)?\s+<class (\w+)', line)
        if m:
            cur = {'name': m.group(1).strip(), 'class': m.group(2), 'p': {}}; out.append(cur); continue
        m = re.search(r'"([^"]+)" = (.*)$', line)
        if m and cur is not None:
            v = m.group(2).strip()
            cur['p'][m.group(1)] = v[1:-1] if v.startswith('"') and v.endswith('"') else v
    res = []
    for d in out:
        p = d['p']
        try: vid, pid = '%04X' % int(p.get('idVendor', '')), '%04X' % int(p.get('idProduct', ''))
        except ValueError: continue
        k = _kind(vid, pid)
        if not k: continue
        res.append({'kind': k, 'vid': vid, 'pid': pid, 'name': d['name'], 'product': p.get('USB Product Name', ''),
                    'vendor': p.get('USB Vendor Name', p.get('kUSBVendorString', '')), 'driver': ''})
    return res


def mac_usb():
    r = {'system': 'macos', 'devices': [], 'ports': [], 'errors': []}
    out, err = _run(['ioreg', '-p', 'IOUSB', '-l', '-w0'], 15)
    if err: r['errors'].append(err)
    r['devices'] = parse_ioreg(out)
    try: r['ports'] = sorted('/dev/' + n for n in os.listdir('/dev') if n.startswith('cu.'))
    except OSError as e: r['errors'].append('/dev: %s' % _err(e))
    return r


class LinuxFS:
    """The real file system for linux_usb (tests pass a stand-in with the same three calls)."""
    def listdir(self, p): return os.listdir(p)

    def read(self, p):
        with open(p, encoding='utf-8', errors='replace') as f: return f.read().strip()

    def readlink(self, p): return os.readlink(p)


def linux_usb(fs=None, groups=None):
    """Linux: /sys/bus/usb/devices (vendor, product, the driver of each interface), /dev/ttyUSB* / ttyACM*, and whether
    this user is in dialout / uucp (serial ports). groups: a stand-in [names] (tests)."""
    fs = fs or LinuxFS()
    r = {'system': 'linux', 'devices': [], 'ports': [], 'groups': [], 'serialGroup': None, 'errors': []}
    root = '/sys/bus/usb/devices'
    try: names = sorted(fs.listdir(root))
    except Exception as e:  # noqa: BLE001
        names = []; r['errors'].append('%s: %s' % (root, _err(e)))
    for n in names:
        if ':' in n: continue                         # an interface, read with its device
        try: vid, pid = fs.read(root + '/' + n + '/idVendor').upper(), fs.read(root + '/' + n + '/idProduct').upper()
        except Exception:  # noqa: BLE001 - a hub's root, no ids
            continue
        k = _kind(vid, pid)
        if not k: continue
        d = {'kind': k, 'vid': vid, 'pid': pid, 'name': n, 'product': '', 'manufacturer': '', 'drivers': {}}
        for f, key in (('product', 'product'), ('manufacturer', 'manufacturer')):
            try: d[key] = fs.read(root + '/' + n + '/' + f)
            except Exception: pass  # noqa: BLE001
        for i in names:
            if not i.startswith(n + ':'): continue
            try: d['drivers'][i] = os.path.basename(fs.readlink(root + '/' + i + '/driver'))
            except Exception: d['drivers'][i] = ''   # noqa: BLE001 - no driver bound
        d['driver'] = ', '.join(sorted({x for x in d['drivers'].values() if x})) or '(none)'
        r['devices'].append(d)
    try: r['ports'] = sorted('/dev/' + n for n in fs.listdir('/dev') if re.match(r'tty(USB|ACM)\d+$', n))
    except Exception as e: r['errors'].append('/dev: %s' % _err(e))  # noqa: BLE001
    try:
        if groups is None:
            import grp
            groups = sorted({grp.getgrgid(g).gr_name for g in os.getgroups()})
        r['groups'] = list(groups)
        r['serialGroup'] = any(g in ('dialout', 'uucp') for g in groups)
    except Exception as e:  # noqa: BLE001
        r['errors'].append('groups: %s' % _err(e))
    return r


def usb_serial_drivers():
    try:
        if sys.platform == 'win32': return win_usb()
        if sys.platform == 'darwin': return mac_usb()
        return linux_usb()
    except Exception as e:  # noqa: BLE001
        return {'system': sys.platform, 'devices': [], 'ports': [], 'errors': [_err(e)]}


# ------------------------------------------------------------------ who holds the discovery ports (UDP)
def _port(addr):
    try: return int(addr.rsplit(':', 1)[1])
    except (IndexError, ValueError): return None


def parse_netstat(text):
    """`netstat -ano -p UDP` / `-p UDPv6` (Windows, any language: the rows by their shape) -> [(local, pid)]."""
    out = []
    for line in text.splitlines():
        t = line.split()
        if len(t) >= 3 and t[0].upper().startswith('UDP') and ':' in t[1] and t[-1].isdigit():
            out.append((t[1], int(t[-1])))
    return out


def parse_tasklist(text):
    """`tasklist /fo csv /nh` -> {pid: image name}."""
    out = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) >= 2 and row[1].strip().isdigit(): out[int(row[1])] = row[0]
    return out


def parse_lsof(text):
    """`lsof -nP -iUDP` (macOS) -> [(local, pid, name)]."""
    out = []
    for line in text.splitlines():
        t = line.split()
        if len(t) < 3 or not t[1].isdigit() or 'UDP' not in t: continue
        i = t.index('UDP')
        if i + 1 < len(t): out.append((t[i + 1].split('->')[0], int(t[1]), t[0].replace('\\x20', ' ')))
    return out


def parse_ss(text):
    """`ss -uanp` (Linux) -> [(local, pid or None, name)]; the process part is empty for others' sockets without root."""
    out = []
    for line in text.splitlines():
        t = line.split()
        if t and t[0].lower() in ('udp', 'udp6'): t = t[1:]
        if len(t) < 5 or not t[1].isdigit() or not t[2].isdigit(): continue
        procs = re.findall(r'\("([^"]*)",pid=(\d+)', line)
        if not procs: out.append((t[3], None, ''))
        for name, pid in procs: out.append((t[3], int(pid), name))
    return out


def owners_from(rows, ports):
    """[(local, pid, name)] -> {port: [{pid, name, local}]} for the ports asked (duplicate rows once)."""
    res = {int(p): [] for p in ports}
    for local, pid, name in rows:
        p = _port(local)
        if p in res:
            e = {'pid': pid, 'name': name, 'local': local}
            if e not in res[p]: res[p].append(e)
    return res


def udp_owners(ports=UDP_PORTS):
    note, err = '', ''
    try:
        if sys.platform == 'win32':
            t4, e4 = _run(['netstat', '-ano', '-p', 'UDP'], 15)
            t6, e6 = _run(['netstat', '-ano', '-p', 'UDPv6'], 15)
            tl, et = _run(['tasklist', '/fo', 'csv', '/nh'], 15)
            names = parse_tasklist(tl)
            rows = [(l, p, names.get(p, '')) for l, p in parse_netstat(t4 + '\n' + t6)]
            err = '; '.join(x for x in (e4, e6, et) if x)
        elif sys.platform == 'darwin':
            t, err = _run(['lsof', '-nP', '-iUDP'], 15)
            rows, note = parse_lsof(t), 'lsof without sudo: only this user\'s programs are listed; "free" may be another user\'s'
            if err and not t: err = ''               # lsof says nothing (exit 1) when no UDP socket is open
        else:
            t, err = _run(['ss', '-uanp'], 15)
            rows, note = parse_ss(t), 'ss without root: other users\' programs show no name / pid'
        res = owners_from(rows, ports)
    except Exception as e:  # noqa: BLE001
        res, err = {int(p): [] for p in ports}, _err(e)
    res['note'], res['error'] = note, err
    return res


# ------------------------------------------------------------------ the firewall (read-only)
def rule_blocks(text, exe):
    """`netsh advfirewall firewall show rule name=all verbose` -> the rule blocks (blank-line separated) that name exe
    (case-insensitive, %variables% expanded)."""
    want = {os.path.normcase(exe)}
    try: want.add(os.path.normcase(os.path.realpath(exe)))
    except (OSError, ValueError): pass
    want = {w.lower() for w in want if w}
    out = []
    for b in re.split(r'\r?\n\s*\r?\n', text.replace('\r\n', '\n')):
        b = b.strip('\n')
        hay = os.path.expandvars(b).lower().replace('/', '\\') if os.sep == '\\' else os.path.expandvars(b).lower()
        if b.strip() and any(w in hay for w in want): out.append(b)
    return out


BLOCK_RX = re.compile(r':\s*(block|blockieren|bloquer|bloquear|blocca(re)?|blokkeren|blokuj|zablokuj|блок\w*|阻止|封鎖|ブロック|차단)\s*$', re.I)


def is_block(b):
    """A rule block's action is Block (its last line in netsh; the English key or the value in a few languages)."""
    lines = [x for x in b.splitlines() if x.strip()]
    return bool(lines) and (bool(BLOCK_RX.search(lines[-1])) or any(re.match(r'\s*Action:\s*Block\s*$', x) for x in lines))


def rule_brief(b):
    """A rule block -> its Name / Direction / Profiles / Protocol / Enabled / Action lines (English keys), else its first 6 lines."""
    keys = ('Rule Name:', 'Enabled:', 'Direction:', 'Profiles:', 'Protocol:', 'Action:')
    got = [re.sub(r'\s{2,}', ' ', x.strip()) for x in b.splitlines() if x.strip().startswith(keys)]
    return got if len(got) >= 3 else [re.sub(r'\s{2,}', ' ', x.strip()) for x in b.splitlines() if x.strip() and not set(x.strip()) <= set('-')][:6]


def profile_lines(text):
    """`netsh advfirewall show currentprofile` (any language) -> ["Public Profile Settings: State ON", ...]: each header
    (the line above the dashes) with the first setting under it (the state)."""
    L = [x.rstrip() for x in text.splitlines()]
    out = []
    for i, x in enumerate(L):
        if x.strip() and set(x.strip()) <= set('-') and i > 0 and L[i - 1].strip():
            nxt = next((y for y in L[i + 1:] if y.strip()), '')
            out.append('%s %s' % (L[i - 1].strip(), re.sub(r'\s{2,}', ' ', nxt.strip())))
    return out


def firewall(exe=None):
    exe = exe or sys.executable or ''
    try:
        if sys.platform == 'win32':
            r = {'system': 'windows', 'exe': exe, 'profile': '', 'profiles': [], 'rules': [], 'rulesTotal': 0, 'blocking': 0,
                 'categories': [], 'errors': []}
            t, e = _run(['netsh', 'advfirewall', 'show', 'currentprofile'], 15)
            r['profile'], r['profiles'] = t.strip(), profile_lines(t)
            if e: r['errors'].append(e)
            t, e = _run(['netsh', 'advfirewall', 'firewall', 'show', 'rule', 'name=all', 'verbose'], 30)
            if e: r['errors'].append(e)
            r['rulesTotal'] = len([b for b in re.split(r'\n\s*\n', t.replace('\r\n', '\n')) if b.strip() and '---' in b])
            r['rules'] = rule_blocks(t, exe)
            r['blocking'] = sum(1 for b in r['rules'] if is_block(b) and not re.search(r'^\s*Enabled:\s*No\s*$', b, re.M))
            t, e = _run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
                         "Get-NetConnectionProfile | Select-Object InterfaceAlias,@{n='NetworkCategory';e={[string]$_.NetworkCategory}} | ConvertTo-Json"], 15)
            if e: r['errors'].append(e)
            try:
                j = json.loads(t) if t.strip() else []
                r['categories'] = [{'InterfaceAlias': x.get('InterfaceAlias'), 'NetworkCategory': x.get('NetworkCategory')}
                                   for x in (j if isinstance(j, list) else [j]) if isinstance(x, dict)]
            except ValueError as e2:
                r['errors'].append('network categories: %s' % _err(e2))
            return r
        if sys.platform == 'darwin':
            fw = '/usr/libexec/ApplicationFirewall/socketfilterfw'
            r = {'system': 'macos', 'exe': exe, 'errors': []}
            for k, a in (('global', '--getglobalstate'), ('stealth', '--getstealthmode'), ('blockAll', '--getblockall')):
                t, e = _run([fw, a], 10); r[k] = t.strip()
                if e: r['errors'].append(e)
            apps, seen = {}, []
            for p in (exe, os.path.realpath(exe), os.path.join(getattr(sys, 'base_prefix', sys.prefix), 'Resources', 'Python.app')):
                if p and p not in seen and os.path.exists(p): seen.append(p)
            for p in seen:
                t, e = _run([fw, '--getappblocked', p], 10); apps[p] = t.strip() or e
            r['apps'] = apps
            return r
        return {'system': 'linux', 'exe': exe, 'note': 'ufw / firewalld status needs root: not read',
                'ufw': shutil.which('ufw') or '', 'firewall-cmd': shutil.which('firewall-cmd') or '', 'errors': []}
    except Exception as e:  # noqa: BLE001
        return {'system': sys.platform, 'exe': exe, 'errors': [_err(e)]}


# ------------------------------------------------------------------ the problem report
def report():
    """Each part on its own: one failing doesn't stop the others. 'seconds' = how long each took."""
    out, took = {}, {}
    for key, fn in (('system', system_info), ('usbLibraries', libusb_tries), ('usbSerial', usb_serial_drivers),
                    ('udpPorts', udp_owners), ('firewall', firewall)):
        t0 = time.time()
        try: out[key] = fn()
        except Exception as e:  # noqa: BLE001
            out[key] = {'error': _err(e)}
        took[key] = round(time.time() - t0, 2)
    out['seconds'] = took
    return out


def report_md(r=None):
    r = r or report()
    L = ['', '## This computer', '']
    s = r.get('system') or {}
    try:
        a = s.get('arch') or {}
        arch = s.get('machine', '')
        if a.get('native') and a.get('wow64'): arch += ', %s Python on %s' % (a['wow64'], a['native'])
        elif a.get('native'): arch += ' (machine %s)' % a['native']
        if a.get('PROCESSOR_ARCHITEW6432'): arch += ', PROCESSOR_ARCHITEW6432 %s' % a['PROCESSOR_ARCHITEW6432']
        if a.get('rosetta'): arch += ', under Rosetta'
        L.append('- OS: %s · %s' % (re.sub(r'\s+', ' ', s.get('pretty') or '%s %s' % (s.get('system'), s.get('release'))).strip(), arch))
        p, lo = s.get('python') or {}, s.get('locale') or {}
        L.append('- Python: %s · %s %s %s-bit · %s' % (p.get('executable'), p.get('implementation'), p.get('version'), p.get('bits'),
                                                     'bundled with Open Nova' if p.get('bundled') else 'not the bundled one'))
        L.append('- Locale: %s · encoding %s · stdout %s%s' % (lo.get('locale'), lo.get('preferredEncoding'), lo.get('stdoutEncoding'),
                                                              ' · code pages ANSI %s / OEM %s' % (lo.get('ansiCodePage'), lo.get('oemCodePage')) if lo.get('oemCodePage') else ''))
        for e in s.get('errors') or []: L.append('- (system: %s)' % e)
    except Exception as e:  # noqa: BLE001
        L.append('- (system not read: %s)' % _err(e))
    try:
        libs = r.get('usbLibraries')
        if isinstance(libs, list):
            for x in libs:
                L.append('- USB %s: %s → %s' % (x['lib'], x['path'] or '—', x['result']))
        else: L.append('- (USB libraries not read: %s)' % (libs or {}).get('error'))
    except Exception as e:  # noqa: BLE001
        L.append('- (USB libraries: %s)' % _err(e))
    try:
        u = r.get('usbSerial') or {}
        for d in u.get('devices') or []:
            L.append('- USB device: %s %s:%s %s · driver %s%s' % (d.get('kind'), d.get('vid'), d.get('pid'), d.get('name') or d.get('product') or '',
                                                                d.get('driver') or '(none)', ' · ' + d['instance'] if d.get('instance') else ''))
        if not u.get('devices'): L.append('- USB devices (NovaStar / CP210x / FTDI): none%s' % (' seen' if u.get('system') == 'windows' else ''))
        ports = u.get('ports') or []
        L.append('- Serial ports: %s' % (', '.join('%s (%s)' % (x['port'], x['device']) if isinstance(x, dict) else x for x in ports) or 'none'))
        if u.get('services'):
            L.append('- Driver services: ' + ', '.join('%s %s' % (k, 'yes' if v.get('exists') else 'no') for k, v in u['services'].items()))
        if u.get('system') == 'linux': L.append('- In dialout / uucp: %s' % ('yes' if u.get('serialGroup') else 'no'))
        for e in u.get('errors') or []: L.append('- (USB: %s)' % e)
    except Exception as e:  # noqa: BLE001
        L.append('- (USB devices: %s)' % _err(e))
    try:
        o = r.get('udpPorts') or {}
        for p in sorted(k for k in o if isinstance(k, int)):
            w = o[p]
            L.append('- UDP %d: %s' % (p, '; '.join('%s (pid %s) %s' % (x['name'] or '?', x['pid'] if x['pid'] is not None else '?', x['local']) for x in w) or 'free'))
        if o.get('error'): L.append('- (UDP ports: %s)' % o['error'])
        if o.get('note'): L.append('- (%s)' % o['note'])
    except Exception as e:  # noqa: BLE001
        L.append('- (UDP ports: %s)' % _err(e))
    try:
        f = r.get('firewall') or {}
        if f.get('system') == 'windows':
            L.append('- Firewall: %s' % ('; '.join(f.get('profiles') or []) or '(profile not read)'))
            if f.get('categories'): L.append('- Network categories: ' + ', '.join('%s %s' % (c['InterfaceAlias'], c['NetworkCategory']) for c in f['categories']))
            L.append('- Firewall rules for this Python: %d (%d block)' % (len(f.get('rules') or []), f.get('blocking', 0)))
            for b in f.get('rules') or []:
                L.append('  - ' + ' · '.join(rule_brief(b)))
        elif f.get('system') == 'macos':
            L.append('- Firewall: %s · %s · %s' % (f.get('global'), f.get('stealth'), f.get('blockAll')))
            for p, t in (f.get('apps') or {}).items(): L.append('  - %s' % t)
        elif f.get('system') == 'linux':
            L.append('- Firewall: %s (ufw %s, firewall-cmd %s)' % (f.get('note'), 'there' if f.get('ufw') else 'not there', 'there' if f.get('firewall-cmd') else 'not there'))
        for e in f.get('errors') or []: L.append('- (firewall: %s)' % e)
    except Exception as e:  # noqa: BLE001
        L.append('- (firewall: %s)' % _err(e))
    return L


if __name__ == '__main__':
    try: sys.stdout.reconfigure(errors='replace')
    except AttributeError: pass
    print('\n'.join(report_md()))
