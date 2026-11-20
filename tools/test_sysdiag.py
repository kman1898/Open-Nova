"""Tests for tools/sysdiag.py (the problem report's "This computer" part): each parser fed captured command output
(Windows `netstat -ano -p UDP` in English and German, `tasklist /fo csv /nh`, `netsh advfirewall` rule blocks and the
current profile, macOS `lsof -nP -iUDP` and `ioreg -p IOUSB -l -w0`, Linux `ss -uanp`), the registry and /sys read
through stand-ins, the USB library list through a stand-in helper; then the real functions once on this computer (the
shapes, nothing raised, in time). Read-only: nothing is written, nothing sent. No real hardware.
    python -I -X utf8 tools/test_sysdiag.py   (exit 0 = all passed)
"""
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sysdiag    # noqa: E402

fails = []


def ok(cond, what, detail=None):
    print(('PASS ' if cond else 'FAIL ') + what + ('' if cond or detail is None else '  -> %s' % (detail,)))
    if not cond: fails.append(what)


# ------------------------------------------------------------------ captured command outputs (made-up programs and addresses)
NETSTAT_EN = '''
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  UDP    0.0.0.0:5353           *:*                                    2664
  UDP    0.0.0.0:54622          *:*                                    4412
  UDP    0.0.0.0:54622          *:*                                    4412
  UDP    192.168.0.10:3800      *:*                                    1234
  UDP    127.0.0.1:54624        *:*                                    4412
'''.replace('\n', '\r\n')
NETSTAT_EN6 = '''
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  UDP    [::]:3800              *:*                                    1234
  UDP    [fe80::1%12]:54623     *:*                                    999
  UDP    [::1]:5600             *:*                                    0
'''
NETSTAT_DE = '''
Aktive Verbindungen

  Proto  Lokale Adresse         Remoteadresse          Status           PID
  UDP    0.0.0.0:5600           *:*                                    777
  TCP    0.0.0.0:5600           0.0.0.0:0              ABHÖREN          778
'''
TASKLIST = ('"System Idle Process","0","Services","0","8 K"\r\n"python.exe","4412","Console","1","25.000 K"\r\n'
            '"VMP_XCenter.exe","1234","Console","1","40,100 K"\r\n"Unico.exe","777","Console","1","90,000 K"\r\n')

LSOF = '''COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
rapportd    512 tester    9u  IPv4 0x1234567890abcdef      0t0  UDP *:3722
python3.1  4321 tester    5u  IPv4 0x2234567890abcdef      0t0  UDP *:54622
python3.1  4321 tester    6u  IPv6 0x3234567890abcdef      0t0  UDP [::]:3800
Unico\\x20Lite  777 tester   12u  IPv4 0x4234567890abcdef      0t0  UDP 192.168.0.10:5600->192.168.0.11:5600
'''

SS = '''State    Recv-Q   Send-Q     Local Address:Port      Peer Address:Port  Process
UNCONN   0        0          127.0.0.53%lo:53             0.0.0.0:*
UNCONN   0        0                0.0.0.0:54622          0.0.0.0:*      users:(("python3",pid=1234,fd=5))
UNCONN   0        0                   [::]:3800              [::]:*      users:(("python3",pid=1234,fd=6))
UNCONN   0        0                0.0.0.0:5600           0.0.0.0:*
ESTAB    0        0           192.168.0.10:54623     192.168.0.11:5200  users:(("a",pid=9,fd=3),("b",pid=10,fd=3))
'''
SS_NETID = '''Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
udp   UNCONN 0      0            0.0.0.0:54624      0.0.0.0:*     users:(("x",pid=5,fd=7))
'''

IOREG = '''+-o Root  <class IORegistryEntry, id 0x100000100, retain 23>
  +-o AppleT8103USBXHCI@00000000  <class AppleT8103USBXHCI, id 0x100000318, registered, matched, active, busy 0 (0 ms), retain 63>
  | +-o USB2.0 Hub@00100000  <class IOUSBHostDevice, id 0x1000a1234, registered, matched, active, busy 0 (0 ms), retain 30>
  | | {
  | |   "idProduct" = 2337
  | |   "idVendor" = 1507
  | |   "USB Product Name" = "USB2.0 Hub"
  | | }
  | | +-o NovaStar Device@00110000  <class IOUSBHostDevice, id 0x1000a2345, registered, matched, active, busy 0 (0 ms), retain 20>
  | |   {
  | |     "sessionID" = 1234567
  | |     "idProduct" = 22304
  | |     "USB Product Name" = "NovaStar Device"
  | |     "idVendor" = 1155
  | |     "kUSBVendorString" = "STMicroelectronics"
  | |   }
  | +-o CP2102 USB to UART Bridge Controller@00200000  <class IOUSBHostDevice, id 0x1000a3456, registered, matched, active>
  |   {
  |     "idProduct" = 60000
  |     "idVendor" = 4292
  |     "USB Vendor Name" = "Silicon Labs"
  |   }
  +-o FT232R USB UART@00300000  <class IOUSBHostDevice, id 0x1000a4567, registered>
    {
      "idProduct" = 24577
      "idVendor" = 1027
    }
  +-o Other STM device@00400000  <class IOUSBHostDevice, id 0x1000a5678, registered>
    {
      "idProduct" = 22336
      "idVendor" = 1155
    }
'''

EXE = r'C:\Program Files\Open Nova\python\python.exe'
NETSH_RULES = r'''
Rule Name:                            python.exe
----------------------------------------------------------------------
Description:                          python.exe
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
Grouping:
LocalIP:                              Any
RemoteIP:                             Any
Protocol:                             UDP
LocalPort:                            Any
RemotePort:                           Any
Edge traversal:                       Defer to user
Program:                              C:\program files\open nova\python\python.exe
InterfaceTypes:                       Any
Security:                             NotRequired
Rule source:                          Local Setting
Action:                               Block

Rule Name:                            python.exe
----------------------------------------------------------------------
Description:                          python.exe
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Protocol:                             TCP
Program:                              C:\Program Files\Open Nova\python\python.exe
Action:                               Allow

Rule Name:                            Unico
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Domain,Private,Public
Program:                              C:\Program Files\NovaStar\Unico\Unico.exe
Action:                               Block

Rule Name:                            Old Python
----------------------------------------------------------------------
Enabled:                              No
Direction:                            In
Profiles:                             Public
Program:                              C:\Program Files\Open Nova\python\python.exe
Action:                               Block

Ok.

'''.replace('\n', '\r\n')
NETSH_DE = r'''Regelname:                            python.exe
----------------------------------------------------------------------
Aktiviert:                            Ja
Richtung:                             Eingehend
Profile:                              Öffentlich
Programm:                             C:\Program Files\Open Nova\python\python.exe
Aktion:                               Blockieren
'''
PROFILE_EN = '''
Public Profile Settings:
----------------------------------------------------------------------
State                                 ON
Firewall Policy                       BlockInbound,AllowOutbound

Logging:
LogAllowedConnections                 Disable

Ok.
'''
PROFILE_DE = '''
Öffentliches Profil Einstellungen:
----------------------------------------------------------------------
Status                                EIN
Firewallrichtlinie                    BlockInbound,AllowOutbound
'''

# ------------------------------------------------------------------ Windows: netstat + tasklist
ok(sysdiag.parse_netstat(NETSTAT_DE) == [('0.0.0.0:5600', 777)], 'netstat (German headers): the UDP row by its shape, TCP left out', sysdiag.parse_netstat(NETSTAT_DE))
names = sysdiag.parse_tasklist(TASKLIST)
ok(names == {0: 'System Idle Process', 4412: 'python.exe', 1234: 'VMP_XCenter.exe', 777: 'Unico.exe'}, 'tasklist CSV: pid -> image name', names)
rows = [(l, p, names.get(p, '')) for l, p in sysdiag.parse_netstat(NETSTAT_EN + NETSTAT_EN6 + NETSTAT_DE)]
o = sysdiag.owners_from(rows, sysdiag.UDP_PORTS)
ok(sorted(o) == [3800, 5600, 54622, 54623, 54624], 'owners: one entry per port asked, nothing else (5353 left out)', sorted(o))
ok(o[54622] == [{'pid': 4412, 'name': 'python.exe', 'local': '0.0.0.0:54622'}], 'owners: 54622 = python.exe, the repeated row once', o[54622])
ok(o[3800] == [{'pid': 1234, 'name': 'VMP_XCenter.exe', 'local': '192.168.0.10:3800'}, {'pid': 1234, 'name': 'VMP_XCenter.exe', 'local': '[::]:3800'}],
   'owners: 3800 on IPv4 and IPv6 ([::]) both listed', o[3800])
ok(o[54623] == [{'pid': 999, 'name': '', 'local': '[fe80::1%12]:54623'}] and o[54624][0]['local'] == '127.0.0.1:54624',
   'owners: a scoped IPv6 address, a process tasklist doesn\'t name (name empty), loopback', (o[54623], o[54624]))
ok({'pid': 777, 'name': 'Unico.exe', 'local': '0.0.0.0:5600'} in o[5600] and all(x['pid'] != 778 for x in o[5600]), 'owners: German netstat too; its TCP row is no UDP owner', o[5600])

# ------------------------------------------------------------------ macOS lsof / Linux ss
lo = sysdiag.owners_from(sysdiag.parse_lsof(LSOF), sysdiag.UDP_PORTS)
ok(lo[54622] == [{'pid': 4321, 'name': 'python3.1', 'local': '*:54622'}] and lo[3800][0]['local'] == '[::]:3800', 'lsof: 54622 and IPv6 3800 by python', lo)
ok(lo[5600] == [{'pid': 777, 'name': 'Unico Lite', 'local': '192.168.0.10:5600'}] and lo[54623] == [], 'lsof: a connected socket = its local end; "\\x20" in a name = a space', lo[5600])
so = sysdiag.owners_from(sysdiag.parse_ss(SS) + sysdiag.parse_ss(SS_NETID), sysdiag.UDP_PORTS)
ok(so[54622] == [{'pid': 1234, 'name': 'python3', 'local': '0.0.0.0:54622'}] and so[3800][0]['local'] == '[::]:3800', 'ss: 54622 and IPv6 3800 with their process', so)
ok(so[5600] == [{'pid': None, 'name': '', 'local': '0.0.0.0:5600'}], 'ss: a socket without process info (another user\'s, no root) is still listed', so[5600])
ok([x['pid'] for x in so[54623]] == [9, 10] and so[54624] == [{'pid': 5, 'name': 'x', 'local': '0.0.0.0:54624'}], 'ss: two processes on one socket; the older "Netid" column', (so[54623], so[54624]))

# ------------------------------------------------------------------ USB devices: macOS ioreg, the Windows registry, Linux /sys (stand-ins)
io_ = sysdiag.parse_ioreg(IOREG)
ok([(d['kind'], d['vid'], d['pid']) for d in io_] == [('NovaStar', '0483', '5720'), ('Silicon Labs CP210x', '10C4', 'EA60'), ('FTDI', '0403', '6001')],
   'ioreg: NovaStar 0483:5720, CP210x, FTDI found; the hub and another STM device (0483, not 5720) left out', io_)
ok(io_[0]['name'] == 'NovaStar Device' and io_[0]['vendor'] == 'STMicroelectronics' and io_[1]['vendor'] == 'Silicon Labs', 'ioreg: names and vendor strings', io_[:2])


class Reg:
    """A stand-in HKLM: {path: (subkeys, values)}; a path that isn't there raises OSError as winreg does."""
    def __init__(self, tree): self.t = tree

    def subkeys(self, p):
        if p not in self.t: raise OSError(2, 'not found')
        return list(self.t[p][0])

    def values(self, p):
        if p not in self.t: raise OSError(2, 'not found')
        return dict(self.t[p][1])


E = r'SYSTEM\CurrentControlSet\Enum\USB'
S = r'SYSTEM\CurrentControlSet\Services'
reg = Reg({
    E: (['VID_0483&PID_5720', 'VID_0483&PID_5740', 'VID_10C4&PID_EA60', 'VID_0403&PID_6010&MI_00', 'VID_046D&PID_C52B', 'ROOT_HUB30'], {}),
    E + r'\VID_0483&PID_5720': (['6&1a2b3c4d&0&2', '6&1a2b3c4d&0&4'], {}),
    E + r'\VID_0483&PID_5720\6&1a2b3c4d&0&2': ([], {'Service': 'libusb0', 'DeviceDesc': '@oem12.inf,%nova.devicedesc%;NovaStar USB Device',
                                                    'Mfg': '@oem12.inf,%novastar%;NovaStar', 'Driver': '{88bae032-5a81-49f0-bc3d-a4ff138216d6}\\0003'}),
    E + r'\VID_0483&PID_5720\6&1a2b3c4d&0&4': ([], {'Service': 'WinUSB', 'DeviceDesc': 'NovaStar (WinUSB)'}),
    E + r'\VID_10C4&PID_EA60': (['0001'], {}),
    E + r'\VID_10C4&PID_EA60\0001': ([], {'Service': 'silabser', 'FriendlyName': '@oem40.inf,%desc%;Silicon Labs CP210x USB to UART Bridge (COM3)'}),
    E + r'\VID_0403&PID_6010&MI_00': (['7&2&0&0000'], {}),
    E + r'\VID_0403&PID_6010&MI_00\7&2&0&0000': ([], {'Service': 'FTDIBUS', 'DeviceDesc': 'USB Serial Converter A'}),
    S + r'\libusb0': ([], {'ImagePath': r'System32\drivers\libusb0.sys'}),
    S + r'\WinUSB': ([], {'ImagePath': r'\SystemRoot\System32\drivers\WinUSB.SYS'}),
    S + r'\silabser': ([], {'ImagePath': r'\SystemRoot\System32\drivers\silabser.sys'}),
    r'HARDWARE\DEVICEMAP\SERIALCOMM': ([], {r'\Device\Silabser0': 'COM3', r'\Device\Serial0': 'COM1'}),
})
w = sysdiag.win_usb(reg)
ok([(d['kind'], d['instance'], d['driver']) for d in w['devices']] == [('NovaStar', '6&1a2b3c4d&0&2', 'libusb0'), ('NovaStar', '6&1a2b3c4d&0&4', 'WinUSB'),
   ('Silicon Labs CP210x', '0001', 'silabser'), ('FTDI', '7&2&0&0000', 'FTDIBUS')],
   'registry: NovaStar 0483:5720 (each instance and its driver), CP210x, FTDI (an interface key); 0483:5740 and the mouse left out', w['devices'])
ok(w['devices'][0]['DeviceDesc'] == 'NovaStar USB Device' and w['devices'][0]['Mfg'] == 'NovaStar' and w['devices'][0]['name'] == 'NovaStar USB Device'
   and w['devices'][2]['FriendlyName'] == 'Silicon Labs CP210x USB to UART Bridge (COM3)', 'registry: "@oem12.inf,%x%;text" -> text', w['devices'][0])
ok(w['services']['libusb0'] == {'exists': True, 'ImagePath': r'System32\drivers\libusb0.sys'} and w['services']['FTSER2K'] == {'exists': False, 'ImagePath': ''}
   and sorted(w['services']) == sorted(sysdiag.WIN_SERVICES), 'registry: driver services there / not there, with ImagePath', w['services'])
ok(w['ports'] == [{'device': r'\Device\Serial0', 'port': 'COM1'}, {'device': r'\Device\Silabser0', 'port': 'COM3'}] and not w['errors'], 'registry: COM ports from SERIALCOMM', w['ports'])
w0 = sysdiag.win_usb(Reg({}))
ok(w0['devices'] == [] and w0['ports'] == [] and len(w0['errors']) == 1 and not any(v['exists'] for v in w0['services'].values()),
   'registry: nothing there = an empty answer with the reason, no exception', w0)


class FS:
    """A stand-in file system for /sys and /dev."""
    def __init__(self, dirs, files, links): self.d, self.f, self.l = dirs, files, links

    def listdir(self, p):
        if p not in self.d: raise OSError(2, 'no such directory')
        return list(self.d[p])

    def read(self, p):
        if p not in self.f: raise OSError(2, 'no such file')
        return self.f[p].strip()

    def readlink(self, p):
        if p not in self.l: raise OSError(22, 'not a link')
        return self.l[p]


R = '/sys/bus/usb/devices'
fs = FS({R: ['usb1', '1-1', '1-1:1.0', '1-2', '1-2:1.0', '1-3', '1-3:1.0', '1-3:1.1'], '/dev': ['tty0', 'ttyUSB0', 'ttyACM0', 'ttyS0']},
        {R + '/1-1/idVendor': '0483\n', R + '/1-1/idProduct': '5720\n', R + '/1-1/product': 'NovaStar Device\n',
         R + '/1-2/idVendor': '10c4\n', R + '/1-2/idProduct': 'ea60\n', R + '/1-2/manufacturer': 'Silicon Labs\n',
         R + '/1-3/idVendor': '046d\n', R + '/1-3/idProduct': 'c52b\n'},
        {R + '/1-2:1.0/driver': '../../../../../../bus/usb/drivers/cp210x'})
lx = sysdiag.linux_usb(fs, groups=['tester', 'dialout'])
ok([(d['kind'], d['vid'], d['pid'], d['driver']) for d in lx['devices']] == [('NovaStar', '0483', '5720', '(none)'), ('Silicon Labs CP210x', '10C4', 'EA60', 'cp210x')],
   'Linux /sys: NovaStar with no driver bound (libusb opens it), CP210x on cp210x; the mouse and the root hub left out', lx['devices'])
ok(lx['devices'][0]['product'] == 'NovaStar Device' and lx['ports'] == ['/dev/ttyACM0', '/dev/ttyUSB0'] and lx['serialGroup'] is True,
   'Linux: product name, /dev/ttyUSB* and ttyACM*, in dialout', lx)
ok(sysdiag.linux_usb(FS({}, {}, {}), groups=['tester'])['serialGroup'] is False, 'Linux: not in dialout / uucp = said so')

# ------------------------------------------------------------------ USB libraries through a stand-in helper
missing = os.path.join(tempfile.gettempdir(), 'opennova-sysdiag-none', 'libusb-1.0.dll')


class Lib:
    path, version = '/opt/x/libusb-1.0.so.0', '1.2.6.0'


H = type('H', (), {'_libusb_paths': staticmethod(lambda: [missing, 'libusb-1.0.so.0', 'libusb-1.0.so.0', '', sys.executable]),
                   '_libusb0_paths': staticmethod(lambda: ['libusb0.dll']), '_LIBUSB': [Lib()], '_LIBUSB0': [None]})
tried = []
lt = sysdiag.libusb_tries(H, lambda p: tried.append(p) or ('loaded' if p == 'libusb-1.0.so.0' else 'OSError: [WinError 193] %1 is not a valid Win32 application'))
t1 = [x for x in lt if x['lib'] == 'libusb-1.0' and not x['inUse']]
ok([(x['path'], x['exists'], x['result'][:7]) for x in t1] == [(missing, False, 'not the'), ('libusb-1.0.so.0', None, 'loaded'), (sys.executable, True, 'OSError')],
   'USB libraries: each path the helper tries, once; a missing absolute path not loaded ("not there"); a bare name exists None', t1)
ok(missing not in tried and tried.count('libusb-1.0.so.0') == 1, 'USB libraries: a path that isn\'t there is never loaded; a repeated one once', tried)
ok((['libusb0.dll'] if sys.platform == 'win32' else []) == [x['path'] for x in lt if x['lib'] == 'libusb0' and not x['inUse']], 'USB libraries: libusb0.dll on Windows only (as the helper)')
use = [x for x in lt if x['inUse']]
ok(len(use) == 2 and use[0]['path'] == '/opt/x/libusb-1.0.so.0' and 'Lib' in use[0]['result'] and '1.2.6.0' in use[0]['result'] and 'none loaded' in use[1]['result'],
   'USB libraries: what the helper has loaded now (its class, path, version) and "tried, none" for libusb0', use)
bad = sysdiag.libusb_tries(type('B', (), {'_libusb_paths': staticmethod(lambda: 1 / 0)}), lambda p: 'loaded')
ok(bad and 'ZeroDivisionError' in bad[0]['result'], 'USB libraries: a helper that fails = said in the result, no exception', bad)

# ------------------------------------------------------------------ the firewall (netsh text)
blocks = sysdiag.rule_blocks(NETSH_RULES, EXE)
ok(len(blocks) == 3 and all('Open Nova' in b or 'open nova' in b for b in blocks) and not any('Unico.exe' in b for b in blocks),
   'netsh: the rule blocks that name this Python (any case), not the other program\'s', [b.splitlines()[0] for b in blocks])
ok([sysdiag.is_block(b) for b in blocks] == [True, False, True], 'netsh: Block / Allow from each rule\'s Action')
br = sysdiag.rule_brief(blocks[0])
ok(br == ['Rule Name: python.exe', 'Enabled: Yes', 'Direction: In', 'Profiles: Public', 'Protocol: UDP', 'Action: Block'], 'netsh: a rule in brief (English keys)', br)
de = sysdiag.rule_blocks(NETSH_DE, EXE)
ok(len(de) == 1 and sysdiag.is_block(de[0]) and sysdiag.rule_brief(de[0])[0] == 'Regelname: python.exe' and len(sysdiag.rule_brief(de[0])) == 6,
   'netsh (German): found, "Blockieren" = block, brief = the first 6 lines (no dashes)', sysdiag.rule_brief(de[0]) if de else de)
ok(sysdiag.profile_lines(PROFILE_EN) == ['Public Profile Settings: State ON'] and sysdiag.profile_lines(PROFILE_DE) == ['Öffentliches Profil Einstellungen: Status EIN'],
   'netsh current profile: the profile and its state, any language', (sysdiag.profile_lines(PROFILE_EN), sysdiag.profile_lines(PROFILE_DE)))
ok(sysdiag._decode('Öffentlich'.encode('cp850'), 'cp850') == 'Öffentlich' and sysdiag._decode('Öffentlich'.encode('utf-8'), 'cp850') == 'Öffentlich',
   'console output: UTF-8 when it is, else the OEM code page')

# ------------------------------------------------------------------ one part failing doesn't stop the others; the Markdown
real_sys = sysdiag.system_info
sysdiag.system_info = lambda: 1 / 0
real_run = sysdiag._run
sysdiag._run = lambda cmd, timeout=10: ('', '%s: not found' % cmd[0])
try:
    r = sysdiag.report()
    md = sysdiag.report_md(r)
finally:
    sysdiag.system_info, sysdiag._run = real_sys, real_run
ok('ZeroDivisionError' in r['system'].get('error', '') and isinstance(r['usbLibraries'], list) and all(r['udpPorts'][p] == [] for p in sysdiag.UDP_PORTS)
   and r['udpPorts']['error'] and r['firewall']['system'], 'report: a failing part is an error in its place; commands that don\'t run = empty, said why', r['udpPorts'])
ok(md[:2] == ['', '## This computer'] and any(x.startswith('- UDP 54622: free') for x in md), 'report_md: still made', md)

# ------------------------------------------------------------------ this computer, for real (read-only)
t0 = time.time()
r = sysdiag.report()
took = time.time() - t0
ok(set(r) >= {'system', 'usbLibraries', 'usbSerial', 'udpPorts', 'firewall', 'seconds'}, 'this computer: every part there', sorted(r))
s = r['system']
ok(set(s) >= {'system', 'release', 'version', 'pretty', 'machine', 'arch', 'python', 'locale', 'errors'} and s['python'].get('bits') in (32, 64)
   and s['python']['executable'] == sys.executable and isinstance(s['python']['bundled'], bool),
   'this computer: %s · %s · Python %s %s-bit' % (s.get('pretty'), s.get('machine'), s['python'].get('version'), s['python'].get('bits')), s)
ok(isinstance(r['usbLibraries'], list) and all(set(x) >= {'lib', 'path', 'exists', 'result', 'inUse'} for x in r['usbLibraries']),
   'this computer: %d USB library tries (%d loaded)' % (len(r['usbLibraries']), sum(1 for x in r['usbLibraries'] if x['result'] == 'loaded')), r['usbLibraries'])
u = r['usbSerial']
ok(isinstance(u.get('devices'), list) and isinstance(u.get('ports'), list) and isinstance(u.get('errors'), list),
   'this computer: %d USB serial device(s), ports %s' % (len(u.get('devices') or []), ', '.join(x['port'] if isinstance(x, dict) else x for x in u.get('ports') or []) or 'none'), u)
up = r['udpPorts']
ok(all(isinstance(up.get(p), list) for p in sysdiag.UDP_PORTS) and 'note' in up and 'error' in up,
   'this computer: UDP owners (%s)' % '; '.join('%d %s' % (p, ', '.join(x['name'] or '?' for x in up[p]) or 'free') for p in sysdiag.UDP_PORTS), up)
f = r['firewall']
ok(f.get('system') == {'win32': 'windows', 'darwin': 'macos'}.get(sys.platform, 'linux') and isinstance(f.get('errors'), list)
   and (sys.platform != 'win32' or (isinstance(f.get('rules'), list) and isinstance(f.get('categories'), list) and f.get('rulesTotal', 0) > 0)),
   'this computer: firewall read (%s)' % ('%d rule(s) of %d name this Python, %d block' % (len(f.get('rules') or []), f.get('rulesTotal', 0), f.get('blocking', 0))
                                         if sys.platform == 'win32' else f.get('system')), {k: v for k, v in f.items() if k not in ('rules', 'profile')})
ok(took < 40, 'this computer: report() in %.1f s (under 40 s; per part %s)' % (took, r['seconds']))
md = sysdiag.report_md(r)
ok(md[:3] == ['', '## This computer', ''] and all(isinstance(x, str) for x in md) and len(md) < 80, 'this computer: report_md %d lines' % len(md), md)
try:
    json.dumps(r, default=str)
    ok(True, 'this computer: the report is JSON')
except (TypeError, ValueError) as e:
    ok(False, 'this computer: the report is JSON', e)
print('\n'.join(md))

print('\n' + ('All passed' if not fails else '%d FAILED:\n  ' % len(fails) + '\n  '.join(fails)))
sys.exit(1 if fails else 0)
