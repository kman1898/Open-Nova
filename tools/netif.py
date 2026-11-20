"""netif.py - this computer's network interfaces, and searching / connecting through each of them, on Windows, macOS and
Linux. Stdlib only.

Like Bitfocus Companion, Open Nova uses every network at once by default: discovery sends on every interface that is up
(one socket per interface address, bound to it) and listens on all, and each processor found says which interface it
answered on. A broadcast to 255.255.255.255 from an unbound socket leaves through ONE interface only (macOS: the primary
one, usually Wi-Fi), so the per-interface sockets are what reach a show network on a second Ethernet port.

    interfaces(fresh=False) -> [{name, label, type, up, mac, ipv4: [{ip, mask, prefix, broadcast}]}]
        name   what the system calls it: "Ethernet 2" (Windows), "en7" (macOS), "eth0" (Linux)
        label  Windows: the adapter's description; macOS: the hardware port ("USB 10/100/1000 LAN"); Linux: ''
        type   ethernet | wifi | vpn | loopback | virtual | bluetooth | other
        Read from GetAdaptersAddresses (Windows, any language; `ipconfig /all` only when that can't be called),
        `ifconfig` + `networksetup -listallhardwareports` (macOS), `ip -o link` + `ip -o -4 addr` (Linux; `ifconfig` when there is no `ip`); cached for REFRESH s.
    networks() / broadcasts() / addresses()    the older lists (every IPv4 network / broadcast / address but loopback)
    search_ifaces()     the interface addresses discovery searches on (up, not loopback, not switched off by the user)
    udp_search(...)     one discovery round over every interface (recorded whole, with the interface, in wirelog)
    connect((ip, port), timeout, zone) / urlopen(req, timeout, zone)   TCP / HTTP through one interface ("zone")
    split_host('192.168.0.11%Ethernet 3') -> ('192.168.0.11', 'Ethernet 3')
    owner(ip) / route_iface(ip) / peer_ifaces(ip)   which interface has address ip / reaches ip / has ip's subnet
    load_settings() / save_settings(d)   Settings ▸ Network (this computer only): {disabled: [names], bind}
    poll() / state()    hot-plug: interfaces that appeared, went, came up, went down or changed address

Two processors with the same IP on two isolated networks: discovery tells them apart by the interface each answered on
and gives each a host "ip%interface" (a zone, as IPv6 writes it); a connection to such a host is bound to that interface's
address (and to the interface itself where the system allows it: macOS IP_BOUND_IF, Linux SO_BINDTODEVICE (Linux 5.7+
without root); Windows sends from the interface that owns the source address). Limits in docs/RUNNING.md "Networks".
"""
import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time

NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REFRESH = 10                       # s an interface list is kept (hot-plug: the helper polls every POLL s)
POLL = 10
TYPES = ('ethernet', 'wifi', 'vpn', 'loopback', 'virtual', 'bluetooth', 'other')
BIND_CHOICES = ('all', 'localhost')    # or an interface name
_cache = {'at': 0.0, 'ifs': [], 'aat': 0.0, 'addrs': [], 'ports_at': 0.0, 'ports': {}}
_lock = threading.Lock()


def _run(cmd, raw=False):
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=5, **({'creationflags': 0x08000000} if sys.platform == 'win32' else {})).stdout
        return out if raw else out.decode('utf-8', 'replace')
    except (OSError, subprocess.SubprocessError):
        return b'' if raw else ''


def _decode(b, oem=None):
    """Console-program output -> text: UTF-8 when it is (ASCII, or a console set to UTF-8), else the console's OEM code
    page (Windows writes ipconfig in it: cp850, cp866, cp936 …), else UTF-8 with replacements."""
    try: return b.decode('utf-8')
    except UnicodeDecodeError: pass
    if oem is None and sys.platform == 'win32':
        try:
            import ctypes
            oem = 'cp%d' % ctypes.windll.kernel32.GetOEMCP()
        except (OSError, AttributeError, ImportError): oem = None
    try: return b.decode(oem or 'utf-8', 'replace')
    except LookupError: return b.decode('utf-8', 'replace')


def _addr(ip, mask, bcast=None):
    """One IPv4 address -> {ip, mask, prefix, broadcast} ('' broadcast for a /31 or /32: point-to-point, a VPN)."""
    try:
        n = ipaddress.IPv4Network('%s/%s' % (ip, mask), strict=False)
        ipaddress.IPv4Address(ip)
    except ValueError:
        return None
    return {'ip': ip, 'mask': str(n.netmask), 'prefix': n.prefixlen,
            'broadcast': '' if n.prefixlen >= 31 else (bcast or str(n.broadcast_address))}


def _mask(m):
    return str(ipaddress.IPv4Address(int(m, 16))) if m.lower().startswith('0x') else m


VPN_RX = re.compile(r'tailscale|wireguard|wintun|zerotier|openvpn|\btap\b|tap-windows|\btun\b|vpn|anyconnect|fortinet|forticlient|globalprotect|pangp|nordlynx|hamachi|netbird', re.I)
VIRT_RX = re.compile(r'hyper-v|vmware|virtualbox|vbox|virtual|vethernet|docker|wsl|parallels|loopback adapter|npcap|kernel debug', re.I)


def _kind(name, label='', hint=''):
    """The interface's type from its name, label (description / hardware port) and the system's own hint."""
    n, t = name.lower(), (label + ' ' + hint).lower()
    if hint == 'loopback' or n in ('lo', 'lo0') or n.startswith('loopback'): return 'loopback'
    if 'bluetooth' in t or n.startswith('bnep'): return 'bluetooth'
    if VPN_RX.search(label) or VPN_RX.search(name) or re.match(r'(utun|ipsec|ppp|tun|tap|wg|zt|tailscale)\d*', n) or hint == 'vpn': return 'vpn'
    if re.search(r'wi-?fi|wireless|wlan|802\.11|airport', t) or re.match(r'(wl|wlan|ath|ra)\w*\d', n) or hint == 'wifi': return 'wifi'
    if VIRT_RX.search(label) or re.match(r'(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|awdl|llw|anpi|ap\d|bridge|gif|stf|vnic)', n): return 'virtual'
    if hint == 'ethernet' or re.search(r'ethernet|\blan\b|thunderbolt|gigabit|realtek|intel|usb', t) or re.match(r'(en|eth|em|eno|ens|enp|enx)\w*', n): return 'ethernet'
    return 'other'


# ------------------------------------------------------------------ parsers (one per system's command output; tests feed them captured text)
WIN_HEAD = re.compile(r'^(.*?)[\s-]?(?:adapter|Adapter)\s+(.+?)\s*:$')
WIN_LINE = re.compile(r'^\s{1,8}(\S.*?)\s*(?:\.\s*)*:\s?(.*)$')    # "   Key . . . : value" (3 spaces; a value's 2nd line is far right)
WIN_IP = re.compile(r'^(\d{1,3}(?:\.\d{1,3}){3})(?:\s*\(.*\))?$')   # 192.168.0.10(Preferred) in any language
WIN_MAC = re.compile(r'^[0-9A-Fa-f]{2}(?:-[0-9A-Fa-f]{2}){5}$')      # a 6-byte physical address (a DUID is longer)
WIN_KEYS = (('desc', re.compile(r'^(Description|Beschreibung|Descripci.n|Descri..o|Beschrijving|Opis|Описание|描述|説明)$', re.I)),
            ('media', re.compile(r'Media State|Medienstatus|Statut du m|Estado de los medios|Estado d[ao] m|Mediastatus|Stan no|Состояние среды|媒体状态|メディアの状態', re.I)))


def _is_mask(v):
    try: return v.startswith('255.') and ipaddress.IPv4Network('0.0.0.0/' + v).prefixlen >= 8
    except ValueError: return False


def parse_ipconfig(text):
    """`ipconfig /all` (Windows) -> interfaces: the FALLBACK when GetAdaptersAddresses can't be called (_read). One section
    per adapter ("Ethernet adapter Ethernet 2:"); English and German headers give the name, other languages the whole
    header line. The addresses are found by their shape, not the (translated) words: an IPv4 value followed by a 255.x
    mask value; the physical address by its 6 bytes. A "Media State" line (some languages) = disconnected. No loopback
    (Windows doesn't list it: interfaces() adds it)."""
    out, cur = [], None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line: continue
        if not line[0].isspace():
            if not line.endswith(':'): cur = None; continue
            m = WIN_HEAD.match(line)
            head = m.group(1).strip() if m else ''
            name = m.group(2) if m else line[:-1].strip()
            cur = {'name': name, 'label': '', 'type': '', 'up': True, 'mac': '', 'ipv4': [], '_head': head if m else name, '_ip': None}
            out.append(cur); continue
        m = WIN_LINE.match(line) if cur is not None else None
        if not m: continue
        key, val = m.group(1).strip(), m.group(2).strip()
        ip, cur['_ip'] = cur['_ip'], None
        if ip and _is_mask(val.split()[0] if val else ''):
            a = _addr(ip, val.split()[0])
            if a: cur['ipv4'].append(a)
            continue
        v = WIN_IP.match(val)
        if v: cur['_ip'] = v.group(1); continue
        if WIN_MAC.match(val): cur['mac'] = val.replace('-', ':').lower(); continue
        for k, rx in WIN_KEYS:
            if not rx.search(key): continue
            if k == 'desc': cur['label'] = val
            elif k == 'media': cur['up'] = False
            break
    res = []
    for c in out:
        head = c.pop('_head').lower(); c.pop('_ip')
        if not c['label'] and not c['ipv4'] and not c['mac']: continue     # "Windows IP Configuration" (the host part)
        if re.search(r'tunnel|túnel|tunel|туннел|隧道|トンネル', head) and not c['ipv4']: continue   # isatap / Teredo pseudo-adapters: noise
        hint = ('wifi' if re.search(r'wireless|drahtlos|wlan|sans fil|inal.mbrica|sem fio|bezprzewod|беспровод|无线|ワイヤレス', head)
                else 'vpn' if re.search(r'ppp|unknown|unbekannt|desconocido|inconnu', head) else 'ethernet' if 'ethernet' in head else '')
        c['type'] = _kind(c['name'], c['label'], hint)
        if c['type'] == 'ethernet' and c['ipv4'] and all(a['prefix'] == 32 for a in c['ipv4']): c['type'] = 'vpn'
        res.append(c)
    return res


# ------------------------------------------------------------------ Windows: GetAdaptersAddresses (iphlpapi; no language, no parsing)
IF_ETHERNET, IF_PPP, IF_LOOPBACK, IF_WIFI, IF_TUNNEL = 6, 23, 24, 71, 131
_GAA = {}


def gaa_structs():
    """The ctypes layouts of IP_ADAPTER_ADDRESSES_LH / IP_ADAPTER_UNICAST_ADDRESS_LH (iptypes.h), up to the fields read
    here (the system fills the whole buffer; nothing past OperStatus / OnLinkPrefixLength is looked at)."""
    if _GAA: return _GAA
    import ctypes as C
    u32 = C.c_uint32

    class SOCKET_ADDRESS(C.Structure):
        _fields_ = [('lpSockaddr', C.c_void_p), ('iSockaddrLength', C.c_int)]

    class UNICAST(C.Structure): pass
    UNICAST._fields_ = [('Length', u32), ('Flags', u32), ('Next', C.POINTER(UNICAST)), ('Address', SOCKET_ADDRESS),
                        ('PrefixOrigin', C.c_int), ('SuffixOrigin', C.c_int), ('DadState', C.c_int), ('ValidLifetime', u32),
                        ('PreferredLifetime', u32), ('LeaseLifetime', u32), ('OnLinkPrefixLength', C.c_uint8)]

    class ADAPTER(C.Structure): pass
    ADAPTER._fields_ = [('Length', u32), ('IfIndex', u32), ('Next', C.POINTER(ADAPTER)), ('AdapterName', C.c_char_p),
                        ('FirstUnicastAddress', C.POINTER(UNICAST)), ('FirstAnycastAddress', C.c_void_p),
                        ('FirstMulticastAddress', C.c_void_p), ('FirstDnsServerAddress', C.c_void_p), ('DnsSuffix', C.c_wchar_p),
                        ('Description', C.c_wchar_p), ('FriendlyName', C.c_wchar_p), ('PhysicalAddress', C.c_uint8 * 8),
                        ('PhysicalAddressLength', u32), ('Flags', u32), ('Mtu', u32), ('IfType', u32), ('OperStatus', C.c_int)]
    _GAA.update(SOCKET_ADDRESS=SOCKET_ADDRESS, UNICAST=UNICAST, ADAPTER=ADAPTER)
    return _GAA


def gaa_rows(api=None):
    """Every adapter from GetAdaptersAddresses (AF_UNSPEC; IPv4 unicast addresses only) -> [{name, label, iftype, up, mac,
    ipv4: [(ip, prefix)]}] in the system's (= ipconfig's) order; None when it can't be called. api: a stand-in with
    GetAdaptersAddresses(family, flags, reserved, buffer, POINTER(c_uint32) size) (tests); default Windows' IP helper library (iphlpapi)."""
    import ctypes as C
    import struct
    try:
        if api is None:
            api = C.WinDLL('iphlpapi')
            api.GetAdaptersAddresses.argtypes = [C.c_uint32, C.c_uint32, C.c_void_p, C.c_void_p, C.POINTER(C.c_uint32)]
            api.GetAdaptersAddresses.restype = C.c_uint32
        T = gaa_structs()
        size = C.c_uint32(16384)
        for _ in range(4):                          # ERROR_BUFFER_OVERFLOW (111): the size it needs is in size
            buf = C.create_string_buffer(size.value)
            r = api.GetAdaptersAddresses(0, 0x2 | 0x4 | 0x8, None, buf, C.pointer(size))   # skip anycast, multicast, DNS servers
            if r == 0: break
            if r == 232: return []                  # ERROR_NO_DATA: no adapters
            if r != 111: return None
        else:
            return None
        rows, p = [], C.cast(buf, C.POINTER(T['ADAPTER']))
        while p:
            a = p.contents
            ips, u = [], a.FirstUnicastAddress
            while u:
                sa = u.contents.Address
                if sa.lpSockaddr and sa.iSockaddrLength >= 8:
                    raw = C.string_at(sa.lpSockaddr, 8)
                    if struct.unpack('=H', raw[:2])[0] == 2 and u.contents.OnLinkPrefixLength <= 32:   # AF_INET
                        ips.append(('%d.%d.%d.%d' % tuple(bytearray(raw[4:8])), int(u.contents.OnLinkPrefixLength)))
                u = u.contents.Next
            n = min(int(a.PhysicalAddressLength), 8)
            rows.append({'name': a.FriendlyName or '', 'label': a.Description or '', 'iftype': int(a.IfType), 'up': a.OperStatus == 1,
                         'mac': ':'.join('%02x' % b for b in list(a.PhysicalAddress)[:n]) if n else '', 'ipv4': ips})
            p = a.Next
        return rows
    except (OSError, AttributeError, ValueError, TypeError):
        return None


def from_gaa(rows):
    """gaa_rows() -> interfaces, as parse_ipconfig would give them: the loopback left out (interfaces() adds it), a tunnel
    pseudo-adapter (isatap / Teredo) without IPv4 left out; the type from the adapter's own IfType (ipconfig's header:
    Ethernet / Wireless LAN / PPP / Tunnel / Unknown) plus its name and description."""
    res = []
    for r in rows or ():
        if r['iftype'] == IF_LOOPBACK: continue
        addrs = [a for a in (_addr(ip, str(pre)) for ip, pre in r['ipv4']) if a]
        if r['iftype'] == IF_TUNNEL and not addrs: continue
        hint = {IF_ETHERNET: 'ethernet', IF_WIFI: 'wifi', IF_PPP: 'vpn', IF_TUNNEL: ''}.get(r['iftype'], 'vpn')
        c = {'name': r['name'], 'label': r['label'], 'type': _kind(r['name'], r['label'], hint), 'up': bool(r['up']), 'mac': r['mac'], 'ipv4': addrs}
        if c['type'] == 'ethernet' and c['ipv4'] and all(a['prefix'] == 32 for a in c['ipv4']): c['type'] = 'vpn'
        res.append(c)
    return res


def parse_ifconfig(text, ports=None):
    """`ifconfig` (macOS / BSD, Linux net-tools new and old style) -> interfaces. ports = {device: hardware port name}
    (macOS networksetup) for the labels."""
    out, cur = [], None
    for raw in text.splitlines():
        if not raw.strip(): continue
        if not raw[0].isspace():
            old = 'Link encap' in raw
            name = raw.split()[0] if old else raw.split(':')[0]
            name = name.rstrip(':')
            fl = re.search(r'<([^>]*)>', raw)
            cur = {'name': name, 'label': (ports or {}).get(name, ''), 'type': '', 'up': False, 'mac': '', 'ipv4': [],
                   '_flags': set(fl.group(1).split(',')) if fl else set(), '_status': '', '_hint': 'loopback' if 'Loopback' in raw else ''}
            m = re.search(r'HWaddr\s+([0-9A-Fa-f:]{17})', raw)
            if m: cur['mac'] = m.group(1).lower()
            out.append(cur); continue
        if cur is None: continue
        line = raw.strip()
        if re.match(r'inet\s', line):
            ip = re.match(r'inet (?:addr:)?([\d.]+)', line)
            mk = re.search(r'(?:netmask|Mask:)\s*(0x[0-9a-fA-F]+|[\d.]+)', line)
            bc = re.search(r'(?:broadcast|Bcast:)\s*([\d.]+)', line)
            if ip and mk:
                a = _addr(ip.group(1), _mask(mk.group(1)), bc.group(1) if bc else None)
                if a: cur['ipv4'].append(a)
            continue
        m = re.match(r'(?:ether)\s+([0-9a-fA-F:]{17})', line)
        if m: cur['mac'] = m.group(1).lower()
        if '(Local Loopback)' in line or 'Link encap:Local Loopback' in line: cur['_hint'] = 'loopback'
        m = re.match(r'status:\s*(\w+)', line)
        if m: cur['_status'] = m.group(1)
        if re.match(r'(UP|BROADCAST|LOOPBACK|POINTOPOINT)\b', line) and 'MTU' in line:   # old net-tools: the flags on their own line
            cur['_flags'] |= set(line.split('MTU')[0].split())
    for c in out:
        f, st = c.pop('_flags'), c.pop('_status')
        c['up'] = 'UP' in f and ('RUNNING' in f or st == 'active' or 'LOOPBACK' in f) and st != 'inactive'
        hint = c.pop('_hint') or ('loopback' if 'LOOPBACK' in f else 'vpn' if 'POINTOPOINT' in f else '')
        c['type'] = _kind(c['name'], c['label'], hint)
    return out


def parse_hwports(text):
    """`networksetup -listallhardwareports` (macOS) -> {device: hardware port name}, e.g. {'en7': 'USB 10/100/1000 LAN'}."""
    out, port = {}, None
    for line in text.splitlines():
        m = re.match(r'Hardware Port:\s*(.+)', line.strip())
        if m: port = m.group(1).strip(); continue
        m = re.match(r'Device:\s*(\S+)', line.strip())
        if m and port: out[m.group(1)] = port; port = None
    return out


def parse_ip(link_text, addr_text, wireless=None):
    """`ip -o link` + `ip -o -4 addr` (Linux) -> interfaces. wireless(name) -> True for a Wi-Fi device (/sys/class/net)."""
    out, by = [], {}
    for line in link_text.splitlines():
        m = re.match(r'\d+:\s+([^:@\s]+)(?:@\S*)?:\s+<([^>]*)>(.*)', line)
        if not m: continue
        name, fl, rest = m.group(1), set(m.group(2).split(',')), m.group(3)
        lk = re.search(r'link/(\w+)(?:\s+([0-9a-f:]{17}))?', rest)
        kind = lk.group(1) if lk else ''
        st = re.search(r'\bstate (\w+)', rest)
        up = 'UP' in fl and 'NO-CARRIER' not in fl and ('LOWER_UP' in fl or (st and st.group(1) == 'UP'))
        hint = 'loopback' if kind == 'loopback' else 'vpn' if kind == 'none' or 'POINTOPOINT' in fl else 'wifi' if wireless and wireless(name) else ''
        c = {'name': name, 'label': '', 'type': _kind(name, '', hint), 'up': bool(up), 'mac': (lk.group(2) or '') if lk and kind == 'ether' else '', 'ipv4': []}
        out.append(c); by[name] = c
    for line in addr_text.splitlines():
        m = re.match(r'\d+:\s+(\S+)\s+inet\s+([\d.]+)/(\d+)(?:\s+brd\s+([\d.]+))?', line)
        if not m: continue
        c = by.get(m.group(1))
        if c is None:                                          # an address without its link line: still an interface
            c = by[m.group(1)] = {'name': m.group(1), 'label': '', 'type': _kind(m.group(1)), 'up': True, 'mac': '', 'ipv4': []}; out.append(c)
        a = _addr(m.group(2), m.group(3), m.group(4))
        if a: c['ipv4'].append(a)
    return out


def _wireless(name):
    return os.path.isdir('/sys/class/net/%s/wireless' % name) or os.path.isdir('/sys/class/net/%s/phy80211' % name)


def _read():
    if sys.platform == 'win32':
        ifs = from_gaa(gaa_rows())                # the system's own list, the same in every language
        _cache['src'] = 'GetAdaptersAddresses'
        if not ifs:                               # not callable here: ipconfig's text (decoded with the console code page)
            ifs, _cache['src'] = parse_ipconfig(_decode(_run(['ipconfig', '/all'], raw=True))), 'ipconfig'
        if ifs: ifs.append({'name': 'Loopback Pseudo-Interface 1', 'label': 'this computer', 'type': 'loopback', 'up': True, 'mac': '', 'ipv4': [_addr('127.0.0.1', '255.0.0.0')]})
        return ifs
    if sys.platform.startswith('linux'):
        ifs = parse_ip(_run(['ip', '-o', 'link']), _run(['ip', '-o', '-4', 'addr']), _wireless)
        if ifs: return ifs
    ports = {}
    if sys.platform == 'darwin':
        if time.time() - _cache['ports_at'] > 60:
            _cache.update(ports=parse_hwports(_run(['networksetup', '-listallhardwareports'])), ports_at=time.time())
        ports = _cache['ports']
    return parse_ifconfig(_run(['ifconfig']) or _run(['/sbin/ifconfig']), ports)


def interfaces(fresh=False):
    """Every interface of this computer (see the module doc), in the system's order; cached for REFRESH s."""
    with _lock:
        if not fresh and time.time() - _cache['at'] < REFRESH: return _cache['ifs']
    ifs = _read()
    seen = set()
    for i in ifs:                                              # two entries with one name (an ifconfig alias): keep both addresses
        if i['name'] in seen: i['name'] += ' (2)'
        seen.add(i['name'])
    with _lock: _cache.update(at=time.time(), ifs=ifs)
    return ifs


# ------------------------------------------------------------------ the older lists (serve.py's startup message, the helper's origins)
def networks():
    """[{'ip', 'mask', 'broadcast'}] every IPv4 network with a broadcast (no loopback, link-local, /31, /32)."""
    out, seen = [], set()
    for i in interfaces():
        if i['type'] == 'loopback': continue
        for a in i['ipv4']:
            ip = ipaddress.IPv4Address(a['ip'])
            if ip.is_loopback or ip.is_link_local or not a['broadcast'] or a['ip'] in seen: continue
            seen.add(a['ip']); out.append({'ip': a['ip'], 'mask': a['mask'], 'broadcast': a['broadcast']})
    return out


def broadcasts():
    return sorted({n['broadcast'] for n in networks()})


def addresses():
    """Every IPv4 address of this computer but loopback: the networks plus point-to-point ones (a VPN such as Tailscale
    has a /32 address and no broadcast) and what the host name resolves to. Cached for 30 s."""
    if time.time() - _cache['aat'] < 30:
        return _cache['addrs']
    found = [a['ip'] for i in interfaces() for a in i['ipv4']]
    try:
        found += socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    out = []
    for ip in found:
        try: a = ipaddress.IPv4Address(ip)
        except ValueError: continue
        if not a.is_loopback and not a.is_unspecified and ip not in out: out.append(ip)
    _cache.update(aat=time.time(), addrs=out)
    return out


# ------------------------------------------------------------------ which interface
def owner(ip):
    """The name of the interface that has local address ip ('loopback' for 127.x), or ''."""
    if not ip: return ''
    n = next((i['name'] for i in interfaces() for a in i['ipv4'] if a['ip'] == ip), '')
    if n or not ip.startswith('127.'): return n
    return next((i['name'] for i in interfaces() if i['type'] == 'loopback'), 'loopback')


def route_iface(ip):
    """The interface the system would use to reach ip (a UDP 'connect' only asks the routing table, sends nothing)."""
    if ip.startswith('127.'): return owner(ip)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try: s.connect((ip, 9)); return owner(s.getsockname()[0])
    except OSError: return ''
    finally: s.close()


def peer_ifaces(ip):
    """The names of the interfaces (up) whose own subnet holds ip — more than one = the same network number on two ports."""
    try: p = ipaddress.IPv4Address(ip)
    except ValueError: return []
    out = []
    for i in interfaces():
        if not i['up'] or i['type'] == 'loopback': continue
        if any(a['broadcast'] and p in ipaddress.IPv4Network('%s/%d' % (a['ip'], a['prefix']), strict=False) for a in i['ipv4']) and i['name'] not in out:
            out.append(i['name'])
    return out


def iface_ips(name, near=None):
    """The IPv4 addresses of interface `name` (the one in the same subnet as `near` first)."""
    i = next((x for x in interfaces() if x['name'] == name), None)
    if not i: return []
    ips = [a for a in i['ipv4']]
    if near:
        try:
            p = ipaddress.IPv4Address(near)
            ips.sort(key=lambda a: 0 if p in ipaddress.IPv4Network('%s/%d' % (a['ip'], a['prefix']), strict=False) else 1)
        except ValueError: pass
    return [a['ip'] for a in ips]


def split_host(host):
    """'192.168.0.11%Ethernet 3' -> ('192.168.0.11', 'Ethernet 3'); a host without a zone -> (host, None)."""
    h = str(host or '')
    if '%' in h and not h.startswith('['):
        ip, z = h.split('%', 1)
        return ip, (z or None)
    return h, None


def zoned(ip, name):
    return '%s%%%s' % (ip, name)


IP_BOUND_IF = 25                    # macOS <netinet/in.h>
SO_BINDTODEVICE = 25                # Linux <asm-generic/socket.h>


def bind_device(sock, name):
    """Tie sock to interface `name` beyond its source address, where the system allows it without admin rights:
    macOS IP_BOUND_IF, Linux SO_BINDTODEVICE (5.7+ or with CAP_NET_RAW). Windows: binding the interface's address is
    enough (it sends from the interface that owns the source address). -> True when sock is tied to that interface."""
    if sys.platform == 'win32': return True
    try:
        if sys.platform == 'darwin':
            sock.setsockopt(socket.IPPROTO_IP, IP_BOUND_IF, socket.if_nametoindex(name)); return True
        if sys.platform.startswith('linux'):
            sock.setsockopt(socket.SOL_SOCKET, getattr(socket, 'SO_BINDTODEVICE', SO_BINDTODEVICE), name.encode() + b'\0'); return True
    except (OSError, AttributeError, ValueError):
        pass
    return False


class ZoneError(OSError):
    pass


def connect(addr, timeout=3.0, zone=None):
    """A TCP connection to addr = (ip, port); zone = the interface to go through (its address bound as the source, the
    socket tied to it where possible). An interface that isn't there now is an error, never "any route": the same address
    on another network may be a different processor."""
    if not zone: return socket.create_connection(addr, timeout=timeout)
    src = iface_ips(zone, addr[0])
    if not src: raise ZoneError('network "%s" isn’t connected to this computer now (%s is on it)' % (zone, addr[0]))
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        bind_device(s, zone)
        s.bind((src[0], 0)); s.settimeout(timeout); s.connect(addr)
    except OSError:
        s.close(); raise
    return s


def urlopen(req, timeout, zone=None):
    """urllib.request.urlopen, through interface `zone` when given (Unico / COEX REST to a processor that shares its IP
    with one on another network). Never through a proxy: a corporate laptop's system proxy (or HTTP_PROXY) can't reach a
    processor on a show network, nor this computer's 127.0.0.1."""
    import urllib.request
    if not zone: return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout)
    import http.client

    class Conn(http.client.HTTPConnection):
        def connect(self):
            self.sock = connect((self.host, self.port), self.timeout, zone)

    class Handler(urllib.request.HTTPHandler):
        def http_open(self, r): return self.do_open(Conn, r)
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), Handler).open(req, timeout=timeout)


# ------------------------------------------------------------------ Settings ▸ Network (this computer only)
def config_dir():
    """Where this computer's own settings live (never in a project, never in the Open Nova folder, which may be synced):
    %APPDATA%\\OpenNova, ~/Library/Application Support/OpenNova, $XDG_CONFIG_HOME/opennova or ~/.config/opennova;
    OPENNOVA_CONFIG_DIR overrides it (tests). None = it would be inside the Open Nova folder (then nothing is kept)."""
    d = os.environ.get('OPENNOVA_CONFIG_DIR')
    if not d:
        if sys.platform == 'win32': d = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'OpenNova')
        elif sys.platform == 'darwin': d = os.path.expanduser('~/Library/Application Support/OpenNova')
        else: d = os.path.join(os.environ.get('XDG_CONFIG_HOME') or os.path.expanduser('~/.config'), 'opennova')
    d = os.path.abspath(d)
    if os.path.normcase(d + os.sep).startswith(os.path.normcase(NOVA + os.sep)): return None
    return d


def _settings_path():
    d = config_dir()
    return os.path.join(d, 'network.json') if d else None


def load_settings():
    """{'disabled': [interface names not searched], 'bind': 'all' | 'localhost' | an interface name}. Defaults: every
    interface searched (one that turns up later too), the app reachable from every network."""
    s = {'disabled': [], 'bind': 'all'}
    p = _settings_path()
    try:
        with open(p, encoding='utf-8') as f: j = json.load(f)
        if isinstance(j, dict):
            if isinstance(j.get('disabled'), list): s['disabled'] = [str(x)[:120] for x in j['disabled'] if isinstance(x, str)][:64]
            if isinstance(j.get('bind'), str) and j['bind'].strip(): s['bind'] = j['bind'].strip()[:120]
    except (OSError, ValueError, TypeError): pass
    return s


def save_settings(changes):
    """Merge {'disabled': [...]} / {'bind': ...} into the file. -> the settings now; raises ValueError on a bad value."""
    s = load_settings()
    if 'disabled' in changes:
        d = changes['disabled']
        if not isinstance(d, list) or not all(isinstance(x, str) for x in d): raise ValueError('disabled: a list of interface names')
        s['disabled'] = sorted({x.strip()[:120] for x in d if x.strip()})[:64]
    if 'bind' in changes:
        b = str(changes['bind'] or 'all').strip()[:120]
        if not b or re.search(r'[\x00-\x1f]', b): raise ValueError('bind: all, localhost or an interface name')
        s['bind'] = b
    p = _settings_path()
    if not p: raise ValueError('no place for this computer’s settings outside the Open Nova folder (set OPENNOVA_CONFIG_DIR)')
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f: json.dump(s, f, indent=1)
    os.replace(tmp, p)
    return s


def bind_plan(choice=None):
    """What the app server listens on for Settings ▸ Network's "App reachable from" (choice: None = the saved one):
    -> {'choice', 'hosts': None (every interface, IPv4 + IPv6) | ['127.0.0.1', <the interface's addresses>…], 'note'}.
    One interface = that interface and this computer (the browser here opens http://localhost:…). An interface that isn't
    connected at start = this computer only, said in 'note' (never every network: the user narrowed it on purpose)."""
    c = (choice or load_settings()['bind'] or 'all').strip()
    if c == 'all': return {'choice': c, 'hosts': None, 'note': ''}
    if c in ('localhost', 'local', '127.0.0.1'): return {'choice': 'localhost', 'hosts': ['127.0.0.1'], 'note': ''}
    try: ipaddress.IPv4Address(c); ips = [c]
    except ValueError: ips = [ip for ip in iface_ips(c) if ip != '127.0.0.1']
    if not ips: return {'choice': c, 'hosts': ['127.0.0.1'], 'note': '"%s" is not connected now: this computer only until the next start with it connected' % c}
    return {'choice': c, 'hosts': ['127.0.0.1'] + ips, 'note': ''}


def save_applied(port, info):
    """What an app server listens on now (serve.py / serve.ps1 at start), for the dialog's "now" line: network-applied-<port>.json."""
    d = config_dir()
    if not d: return
    try:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'network-applied-%d.json' % int(port)), 'w', encoding='utf-8') as f: json.dump(info, f)
    except (OSError, ValueError): pass


def load_applied(port):
    d = config_dir()
    try:
        with open(os.path.join(d, 'network-applied-%d.json' % int(port)), encoding='utf-8-sig') as f: j = json.load(f)
        return j if isinstance(j, dict) else None
    except (OSError, ValueError, TypeError): return None


# ------------------------------------------------------------------ discovery over every interface
def search_ifaces():
    """The interface addresses discovery searches on: up, not loopback, not switched off in Settings ▸ Network ->
    [{name, ip, broadcast ('' for a /32 VPN address: only typed addresses reach across it), prefix}]. None = the
    interface list couldn't be read (discovery then broadcasts as before: the system picks the interface)."""
    ifs = interfaces()
    if not ifs: return None
    off = set(load_settings()['disabled'])
    return [{'name': i['name'], 'ip': a['ip'], 'broadcast': a['broadcast'], 'prefix': a['prefix']}
            for i in ifs if i['up'] and i['type'] != 'loopback' and i['name'] not in off for a in i['ipv4']]


def search_on(name):
    """Is interface `name` searched (not switched off)?"""
    return name not in set(load_settings()['disabled'])


def udp_search(port, payload, proto, timeout=2.0, targets=('255.255.255.255', '127.0.0.1'), probe=()):
    """One discovery round: `payload` to UDP `port` from one socket per searched interface address (bound to it, tied to
    the interface where the system allows; to 255.255.255.255 and the network's broadcast), and from one unbound socket
    to loopback (`targets`' 127.x) and to `probe` (addresses typed in the app: across routers and VPNs). Every datagram
    either way is recorded whole (wirelog.udp) with the interface it used. -> [(data, (ip, port), interface name)]:
    an answer on an interface socket belongs to that interface; one on the unbound socket to the interface the system
    routes it through ('' unknown)."""
    import select
    import wirelog
    plan, socks, probs, searched = search_ifaces(), [], [], []
    if plan is None: probs.append(problem('noifaces', 'this computer’s network adapters couldn’t be read'))
    elif not [a for a in plan if a['broadcast']]: probs.append(problem('noifaces', 'no network adapter is connected (or all are switched off in Settings ▸ Network)'))
    lo = [t for t in targets if t.startswith('127.')]
    common = [t for t in targets if not t.startswith('127.')]
    try:
        d = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); d.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1); d.bind(('0.0.0.0', 0))
        socks.append((d, None))
        tied, sent = [], set()
        for a in plan or ():
            # a second address on the same network: one search is enough; a /32 (VPN) address has no broadcast: typed
            # addresses (probe) reach across it from the unbound socket
            if not a['broadcast'] or (a['name'], a['broadcast']) in sent: continue
            sent.add((a['name'], a['broadcast']))
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            try:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                pinned = bind_device(s, a['name'])
                s.bind((a['ip'], 0))
            except OSError as e:
                s.close(); wirelog.record('err', link='%s:%d' % (a['ip'], port), error='discovery on %s (%s) not possible: %s' % (a['name'], a['ip'], e), iface=a['name'])
                probs.append(problem('bind', 'can’t search on %s (%s): %s' % (a['name'], a['ip'], e), e, a['name'])); continue
            socks.append((s, a)); tied.append(pinned); searched.append({'name': a['name'], 'ip': a['ip']})
            # 255.255.255.255 only where the socket is tied to its interface (else it may leave through another one and
            # its answer be put down to the wrong network); the network's own broadcast is routed by its subnet anyway
            for t in ([] if not pinned else [x for x in common if x == '255.255.255.255']) + ([a['broadcast']] if a['broadcast'] else []):
                try: s.sendto(payload, (t, port)); wirelog.udp('tx', (t, port), payload, proto, iface=a['name'], via=a['ip'])
                except OSError as e:
                    wirelog.record('err', link='%s:%d' % (t, port), error='discovery send on %s failed: %s' % (a['name'], e), iface=a['name'])
                    probs.append(problem('send', 'the search couldn’t be sent on %s: %s' % (a['name'], e), e, a['name']))
        # the unbound socket: loopback, typed addresses; everything (the old way) when the interfaces can't be read, and
        # 255.255.255.255 when some searched interface couldn't be tied (the system's choice of interface, as before)
        legacy = plan is None
        out = lo + [str(p).split(':')[0] for p in probe or () if p]
        if legacy: out = list(targets) + broadcasts() + out[len(lo):]
        elif plan and not all(tied): out = [x for x in common if x == '255.255.255.255'] + out
        for t in out:
            try: d.sendto(payload, (t, port)); wirelog.udp('tx', (t, port), payload, proto, iface=owner(t) if t.startswith('127.') else '')
            except OSError as e:
                wirelog.record('err', link='%s:%d' % (t, port), error='discovery send failed: %s' % e)
                if not t.startswith('127.'): probs.append(problem('send', 'the search couldn’t be sent to %s: %s' % (t, e), e))
        got, end = [], time.time() + timeout
        while time.time() < end:
            try: r, _, _ = select.select([s for s, _ in socks], [], [], min(0.25, max(0.0, end - time.time())))
            except (OSError, ValueError): break
            for s in r:
                a = next(x for y, x in socks if y is s)
                try: data, addr = s.recvfrom(65535)          # a whole datagram, however big
                except OSError: continue
                name = a['name'] if a else route_iface(addr[0])
                wirelog.udp('rx', addr, data, proto, iface=name)
                got.append((data, addr, name))
        note_search(proto, probs, searched, len(got))
        return got
    finally:
        for s, _ in socks:
            try: s.close()
            except OSError: pass


# ------------------------------------------------------------------ why a search found nothing (the app's empty list says it)
NOROUTE = {65, 113, 51, 101}        # EHOSTUNREACH / ENETUNREACH (macOS 65 / 51, Linux 113 / 101): macOS refusing Local Network
_searches = {}                      # proto -> {at, problems, searched, answers}: the last round of each search
_owners = {'at': 0.0, 'v': None}


def problem(code, text, err=None, iface=''):
    """One thing that went wrong in a search: {code, text, iface, errno}. code: noifaces | bind | send | noroute (macOS
    without Local Network permission, or no route) | listen (a UDP port that can't be listened on) | port (another
    program here holds a search port)."""
    n = getattr(err, 'errno', None)
    if code == 'send' and n in NOROUTE: code = 'noroute'
    return {'code': code, 'text': text, 'iface': iface, 'errno': n}


def note_search(proto, problems, searched=None, answers=0):
    """Keep what a search round met (udp_search does; coexlink for its listening sockets)."""
    with _lock: _searches[proto] = {'at': time.time(), 'problems': list(problems), 'searched': list(searched or []), 'answers': answers}


def port_owners(max_age=30.0):
    """The other programs on this computer that hold a search port (NovaLCT UDP 3800, Unico 5600, VMP's XCenter
    54622-54624): [{port, pid, name}], cached for max_age s (tools/sysdiag.py; [] when it can't be read)."""
    if _owners['v'] is not None and time.time() - _owners['at'] < max_age: return _owners['v']
    out = []
    try:
        import sysdiag
        for p, rows in sysdiag.udp_owners().items():
            if not isinstance(p, int): continue
            for r in rows:
                if r.get('pid') and int(r['pid']) != os.getpid() and not any(o['port'] == p and o['pid'] == r['pid'] for o in out):
                    out.append({'port': p, 'pid': r['pid'], 'name': r.get('name') or 'pid %s' % r['pid']})
    except Exception:  # noqa: BLE001 - only a hint for an empty search
        out = []
    _owners.update(at=time.time(), v=out)
    return out


def search_report(owners=False, max_age=60.0):
    """What the searches of the last max_age s met, for the app's "No processors found" line: {platform, problems (each
    once), searched [{name, ip}], answers}; owners=True adds the other programs holding a search port (a problem 'port'
    each)."""
    now, probs, seen, searched = time.time(), [], set(), []
    with _lock: rounds = [r for r in _searches.values() if now - r['at'] < max_age]
    for r in rounds:
        for x in r['problems']:
            if x['text'] not in seen: seen.add(x['text']); probs.append(x)
        for a in r['searched']:
            if a not in searched: searched.append(a)
    if owners:
        for o in port_owners():
            probs.append(problem('port', '%s on this computer holds UDP %d' % (o['name'], o['port'])))
    return {'platform': sys.platform, 'problems': probs, 'searched': searched, 'answers': sum(r['answers'] for r in rounds)}


def same_ip_text(ip, names, what='a processor'):
    return 'Two networks each have %s at %s (%s) — Open Nova reaches each through its own network' % (what, ip, ', '.join(names))


MAC_RE = re.compile(r'([0-9a-f]{1,2}(?:[:-][0-9a-f]{1,2}){5})', re.I)


def _mac(m):
    return ':'.join('%02x' % int(x, 16) for x in re.split('[:-]', m))


def parse_arp(text, ip, by_addr=None):
    """The ARP / neighbour table text -> {interface name: MAC} for ip. macOS / BSD `arp -an` ("? (ip) at mac on en0 …"),
    Linux /proc/net/arp ("ip 0x1 0x2 mac * eth0"), Windows `arp -a` (an "Interface: <local ip> --- 0x7" heading per
    interface; by_addr maps that local address to the interface's name). Incomplete entries are left out."""
    out, cur = {}, None
    for line in text.splitlines():
        m = re.match(r'\s*Interface:\s*([\d.]+)', line)
        if m: cur = (by_addr or {}).get(m.group(1), m.group(1)); continue
        if not re.search(r'(^|[\s(])%s([\s)]|$)' % re.escape(ip), line): continue
        mac = MAC_RE.search(line)
        if not mac or _mac(mac.group(1)) in ('00:00:00:00:00:00', 'ff:ff:ff:ff:ff:ff'): continue
        on = re.search(r' on (\S+)', line)
        name = on.group(1) if on else cur if cur else line.split()[-1]   # macOS "on en0"; Windows: its heading; Linux: last column
        if name: out[name] = _mac(mac.group(1))
    return out


def arp_macs(ip):
    """{interface name: MAC} for ip from this computer's ARP table (read-only, nothing sent): which device answers at ip on
    each interface."""
    if sys.platform.startswith('linux'):
        try:
            with open('/proc/net/arp') as f: return parse_arp(f.read(), ip)
        except OSError: return {}
    if sys.platform == 'win32':
        by = {a['ip']: i['name'] for i in interfaces() for a in i['ipv4']}
        return parse_arp(_decode(_run(['arp', '-a', ip], raw=True)), ip, by)
    return parse_arp(_run(['arp', '-an']), ip)


def same_ip(out, what='a processor', macs=arp_macs):
    """Discovery entries [{ip, iface, ...}]: one IP heard on more than one interface.
    - The same device on one network reached twice (a Mac's Wi-Fi and Ethernet, or two adapters, on the same show network;
      an H9 tester's en0 + en17, 2026-11-19): the ARP table names the same MAC for that IP on every interface -> one entry
      (the wired one first), 'also' = the other interfaces. Listing it twice made every processor show up twice.
    - Two isolated show networks with the same addresses (different MACs, or not known): each entry's ip becomes
      "ip%interface" (novalink / unicolink / coexlink then connect through that interface only), addr = the plain IP, and
      'conflict' says so (the app shows it). -> out"""
    ifs = interfaces()
    lo = {i['name'] for i in ifs if i['type'] == 'loopback'} | {'loopback'}
    rank = {i['name']: (0 if i['type'] == 'ethernet' else 2 if i['type'] == 'wifi' else 1) for i in ifs}
    by, drop = {}, set()
    for x in out: by.setdefault(x['ip'], []).append(x)
    for ip, g in by.items():
        names = sorted({x['iface'] for x in g if x.get('iface') and x['iface'] not in lo})   # this computer's own answers aside
        if len(names) < 2: continue
        seen = macs(ip) if macs else {}
        known = {seen.get(n) for n in names}
        if None not in known and len(known) == 1:   # one MAC behind every interface: one device, one network
            keep = sorted((x for x in g if x.get('iface') in names), key=lambda x: (rank.get(x['iface'], 1), names.index(x['iface'])))[0]
            keep['also'] = [n for n in names if n != keep['iface']]
            drop.update(id(x) for x in g if x is not keep and x.get('iface') in names)
            continue
        for x in g:
            x['addr'] = ip
            if x.get('iface'): x['ip'] = zoned(ip, x['iface'])
            x['conflict'] = same_ip_text(ip, names, what)
    if drop: out[:] = [x for x in out if id(x) not in drop]
    return out


# ------------------------------------------------------------------ hot-plug
_watch = {'snap': None, 'seq': 0, 'events': [], 'at': 0.0}


def _sig(i):
    return (i['up'], tuple(sorted(a['ip'] + '/' + str(a['prefix']) for a in i['ipv4'])))


def poll():
    """Read the interfaces now and compare with the last poll. -> [{'event': added | removed | up | down | address,
    'name', 'type', 'ips', 'gone' (addresses no longer there), 'text'}] (nothing on the first call)."""
    cur = {i['name']: i for i in interfaces(fresh=True)}
    with _lock:
        old, _watch['snap'], _watch['at'] = _watch['snap'], cur, time.time()
    if old is None: return []
    ev = []
    ips = lambda i: [a['ip'] for a in i['ipv4']]
    for n, i in cur.items():
        o = old.get(n)
        if o is None: ev.append({'event': 'added', 'name': n, 'type': i['type'], 'ips': ips(i), 'gone': [], 'up': i['up']})
        elif _sig(o) != _sig(i):
            e = 'up' if i['up'] and not o['up'] else 'down' if o['up'] and not i['up'] else 'address'
            ev.append({'event': e, 'name': n, 'type': i['type'], 'ips': ips(i), 'gone': [x for x in ips(o) if x not in ips(i)], 'up': i['up']})
    for n, o in old.items():
        if n not in cur: ev.append({'event': 'removed', 'name': n, 'type': o['type'], 'ips': [], 'gone': ips(o), 'up': False})
    words = {'added': 'appeared', 'removed': 'went away', 'up': 'connected', 'down': 'disconnected', 'address': 'changed address'}
    for e in ev:
        e['text'] = '%s %s%s' % (e['name'], words[e['event']], (' (%s)' % ', '.join(e['ips'])) if e['ips'] and e['up'] else '')
    if ev:
        with _lock:
            _watch['seq'] += 1
            for e in ev: e['seq'] = _watch['seq']; e['t'] = time.time()
            _watch['events'] = (_watch['events'] + ev)[-50:]
    return ev


def state():
    """{'seq' (changes so far), 'events' (the last 20), 'at' (last poll)} for the app's cheap check."""
    with _lock: return {'seq': _watch['seq'], 'events': _watch['events'][-20:], 'at': _watch['at']}


def report():
    """For the problem report: the interfaces, the settings, the last changes (addresses only, no MACs)."""
    try:
        ifs = [{k: v for k, v in i.items() if k != 'mac'} for i in interfaces()]
    except Exception as e:  # noqa: BLE001 - a report is made anyway
        ifs = [{'error': '%s: %s' % (type(e).__name__, e)}]
    return {'platform': sys.platform, 'source': _cache.get('src', ''), 'interfaces': ifs, 'settings': load_settings(), 'changes': state()['events']}


def report_md():
    r = report()
    L = ['', '## Networks', '', 'Searched: %s. App reachable from: %s.%s' % (
        'all but ' + ', '.join(r['settings']['disabled']) if r['settings']['disabled'] else 'every interface', r['settings']['bind'],
        ' Read with %s.' % r['source'] if r['source'] else ''), '']
    for i in r['interfaces']:
        if 'error' in i: L.append('- (interfaces not read: %s)' % i['error']); continue
        L.append('- %s%s · %s · %s · %s' % (i['name'], ' (%s)' % i['label'] if i['label'] else '', i['type'], 'up' if i['up'] else 'down',
                                         ', '.join('%s/%d' % (a['ip'], a['prefix']) for a in i['ipv4']) or 'no IPv4'))
    for e in r['changes'][-10:]:
        L.append('- change: %s' % e['text'])
    return L


if __name__ == '__main__':
    for i in interfaces():
        print('%-28s %-9s %-4s %-34s %s' % (i['name'], i['type'], 'up' if i['up'] else 'down', ', '.join('%s/%d' % (a['ip'], a['prefix']) for a in i['ipv4']) or '-', i['label']))
    print('searched: %s' % ', '.join('%s %s' % (a['name'], a['ip']) for a in search_ifaces() or []))
    print('addresses: ' + ', '.join(addresses()))
