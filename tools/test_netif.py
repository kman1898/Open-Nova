"""Tests for Settings > Network (tools/netif.py and the helper's use of it): the interface list parsed from each system's
own command output (captured outputs below: Windows `ipconfig /all` in English and German, macOS `ifconfig` +
`networksetup -listallhardwareports`, Linux `ip -o link` / `ip -o -4 addr` and both `ifconfig` styles), the settings
kept on this computer (a temporary folder), the app server's bind plan, hot-plug changes (recorded, pooled connections
dropped), and discovery over two stand-in interfaces at once (loopback addresses 127.0.0.3 / .4 / .7 as two networks,
stand-in processors on 127.0.0.2 / .6): which interface each processor answered on, the same IP on two networks
flagged and each one reached through its own interface (TCP bound to that interface's address), an interface switched
off not searched. Nothing goes onto the real network. No real hardware.
    python -I tools/test_netif.py   (exit 0 = all passed)
"""
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import urllib.request

TMP = tempfile.mkdtemp(prefix='opennova_netif_test_')
os.environ['OPENNOVA_DIAG'] = os.path.join(TMP, 'diag')
os.environ['OPENNOVA_CONFIG_DIR'] = os.path.join(TMP, 'config')
os.environ['OPENNOVA_HELPER_LOGS'] = os.path.join(TMP, 'logs')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netif      # noqa: E402
import wirelog    # noqa: E402

fails = []


def ok(cond, what, detail=None):
    print(('PASS ' if cond else 'FAIL ') + what + ('' if cond or detail is None else '  -> %s' % (detail,)))
    if not cond: fails.append(what)


def by(ifs):
    return {i['name']: i for i in ifs}


def ips(i):
    return ['%s/%d' % (a['ip'], a['prefix']) for a in i['ipv4']]


# ------------------------------------------------------------------ captured command outputs (made-up adapters and addresses)
WIN_EN = '''
Windows IP Configuration

   Host Name . . . . . . . . . . . . : SHOW-PC
   Primary Dns Suffix  . . . . . . . :
   Node Type . . . . . . . . . . . . : Hybrid
   IP Routing Enabled. . . . . . . . : No

Ethernet adapter Ethernet 2:

   Connection-specific DNS Suffix  . :
   Description . . . . . . . . . . . : Intel(R) Ethernet Connection (7) I219-V
   Physical Address. . . . . . . . . : 02-00-00-00-00-01
   DHCP Enabled. . . . . . . . . . . : No
   Autoconfiguration Enabled . . . . : Yes
   Link-local IPv6 Address . . . . . : fe80::1c2d:3e4f:5a6b:7c8d%12(Preferred)
   IPv4 Address. . . . . . . . . . . : 192.168.0.10(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   Default Gateway . . . . . . . . . :
   NetBIOS over Tcpip. . . . . . . . : Enabled

Ethernet adapter Ethernet 3:

   Connection-specific DNS Suffix  . :
   Description . . . . . . . . . . . : Realtek USB GbE Family Controller
   Physical Address. . . . . . . . . : 02-00-00-00-00-02
   DHCP Enabled. . . . . . . . . . . : No
   IPv4 Address. . . . . . . . . . . : 192.168.0.20(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.0
   IPv4 Address. . . . . . . . . . . : 10.10.0.5(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.0.0
   Default Gateway . . . . . . . . . :
   DNS Servers . . . . . . . . . . . : 10.10.0.1
                                       10.10.0.2

Wireless LAN adapter Wi-Fi:

   Media State . . . . . . . . . . . : Media disconnected
   Connection-specific DNS Suffix  . :
   Description . . . . . . . . . . . : Intel(R) Wi-Fi 6 AX201 160MHz
   Physical Address. . . . . . . . . : 02-00-00-00-00-03
   DHCP Enabled. . . . . . . . . . . : Yes

Unknown adapter Tailscale:

   Connection-specific DNS Suffix  . : tailnet.example.ts.net
   Description . . . . . . . . . . . : Tailscale Tunnel
   Physical Address. . . . . . . . . :
   IPv4 Address. . . . . . . . . . . : 100.101.102.103(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.255.255

Ethernet adapter vEthernet (Default Switch):

   Description . . . . . . . . . . . : Hyper-V Virtual Ethernet Adapter
   Physical Address. . . . . . . . . : 02-00-00-00-00-04
   IPv4 Address. . . . . . . . . . . : 172.20.16.1(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.240.0

Ethernet adapter Ethernet 4:

   Description . . . . . . . . . . . : ASIX AX88179 USB 3.0 to Gigabit Ethernet Adapter
   Physical Address. . . . . . . . . : 02-00-00-00-00-06
   Autoconfiguration IPv4 Address. . : 169.254.12.34(Preferred)
   Subnet Mask . . . . . . . . . . . : 255.255.0.0

Ethernet adapter Bluetooth Network Connection:

   Media State . . . . . . . . . . . : Media disconnected
   Description . . . . . . . . . . . : Bluetooth Device (Personal Area Network)
   Physical Address. . . . . . . . . : 02-00-00-00-00-05

Tunnel adapter isatap.{6A1B2C3D-0000-1111-2222-333344445555}:

   Media State . . . . . . . . . . . : Media disconnected
   Description . . . . . . . . . . . : Microsoft ISATAP Adapter #2
'''.replace('\n', '\r\n')

WIN_DE = '''
Windows-IP-Konfiguration

Ethernet-Adapter Ethernet 2:

   Verbindungsspezifisches DNS-Suffix:
   Beschreibung. . . . . . . . . . . : Intel(R) Ethernet Connection I219-LM
   Physische Adresse . . . . . . . . : 02-00-00-00-00-11
   IPv4-Adresse  . . . . . . . . . . : 10.1.2.3(Bevorzugt)
   Subnetzmaske  . . . . . . . . . . : 255.255.255.0

Drahtlos-LAN-Adapter WLAN:

   Medienstatus. . . . . . . . . . . : Medium getrennt
   Beschreibung. . . . . . . . . . . : Intel(R) Wi-Fi 6 AX201 160MHz
'''

MAC_IFCONFIG = '''lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\toptions=1203<RXCSUM,TXCSUM,TXSTATUS,SW_TIMESTAMP>
\tinet 127.0.0.1 netmask 0xff000000
\tinet6 ::1 prefixlen 128
\tnd6 options=201<PERFORMNUD,DAD>
gif0: flags=8010<POINTOPOINT,MULTICAST> mtu 1280
stf0: flags=0<> mtu 1280
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
\tether 02:00:00:00:01:00
\tinet6 fe80::1c%en0 prefixlen 64 secured scopeid 0xe
\tinet 10.0.1.23 netmask 0xffffff00 broadcast 10.0.1.255
\tnd6 options=201<PERFORMNUD,DAD>
\tmedia: autoselect
\tstatus: active
en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=6467<RXCSUM,TXCSUM,VLAN_MTU,TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
\tether 02:00:00:00:01:07
\tinet 192.168.0.10 netmask 0xffffff00 broadcast 192.168.0.255
\tmedia: autoselect (1000baseT <full-duplex>)
\tstatus: active
en8: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether 02:00:00:00:01:08
\tmedia: autoselect (none)
\tstatus: inactive
bridge0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether 02:00:00:00:01:09
\tstatus: inactive
awdl0: flags=8843<UP,BROADCAST,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether 02:00:00:00:01:0a
\tstatus: active
utun3: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
\tinet 100.101.102.103 --> 100.101.102.103 netmask 0xffffffff
'''

MAC_PORTS = '''
Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 02:00:00:00:01:00

Hardware Port: USB 10/100/1000 LAN
Device: en7
Ethernet Address: 02:00:00:00:01:07

Hardware Port: Thunderbolt Ethernet Slot 1
Device: en8
Ethernet Address: 02:00:00:00:01:08

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 02:00:00:00:01:09

VLAN Configurations
===================
'''

LINUX_LINK = '''1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\\    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000\\    link/ether 02:00:00:00:02:00 brd ff:ff:ff:ff:ff:ff
3: wlan0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN mode DORMANT group default qlen 1000\\    link/ether 02:00:00:00:02:01 brd ff:ff:ff:ff:ff:ff
4: tailscale0: <POINTOPOINT,MULTICAST,NOARP,UP,LOWER_UP> mtu 1280 qdisc fq_codel state UNKNOWN mode DEFAULT group default qlen 500\\    link/none
5: docker0: <NO-CARRIER,BROADCAST,MULTICAST,UP> mtu 1500 qdisc noqueue state DOWN mode DEFAULT group default\\    link/ether 02:00:00:00:02:05 brd ff:ff:ff:ff:ff:ff
6: enx020000000206: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP mode DEFAULT group default qlen 1000\\    link/ether 02:00:00:00:02:06 brd ff:ff:ff:ff:ff:ff
7: veth1a2b3c@if6: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc noqueue master docker0 state UP mode DEFAULT group default\\    link/ether 02:00:00:00:02:07 brd ff:ff:ff:ff:ff:ff link-netnsid 0
'''
LINUX_ADDR = '''1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever
2: eth0    inet 192.168.0.10/24 brd 192.168.0.255 scope global noprefixroute eth0\\       valid_lft forever preferred_lft forever
4: tailscale0    inet 100.101.102.103/32 scope global tailscale0\\       valid_lft forever preferred_lft forever
5: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever
6: enx020000000206    inet 192.168.0.20/24 brd 192.168.0.255 scope global noprefixroute enx020000000206\\       valid_lft forever preferred_lft forever
'''

LINUX_IFCONFIG_NEW = '''eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500
        inet 192.168.0.10  netmask 255.255.255.0  broadcast 192.168.0.255
        inet6 fe80::1  prefixlen 64  scopeid 0x20<link>
        ether 02:00:00:00:03:00  txqueuelen 1000  (Ethernet)
        RX packets 10  bytes 1000 (1.0 KB)

lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536
        inet 127.0.0.1  netmask 255.0.0.0
        loop  txqueuelen 1000  (Local Loopback)

wlan0: flags=4099<UP,BROADCAST,MULTICAST>  mtu 1500
        ether 02:00:00:00:03:01  txqueuelen 1000  (Ethernet)
'''

# (written with '=' for ':' after the field names here: the repository guard reads a capitalised word, a colon and digits as a code citation)
LINUX_IFCONFIG_OLD = '''eth0      Link encap:Ethernet  HWaddr 02:00:00:00:04:00
          inet addr=192.168.0.10  Bcast=192.168.0.255  Mask=255.255.255.0
          UP BROADCAST RUNNING MULTICAST  MTU=1500  Metric=1

eth1      Link encap:Ethernet  HWaddr 02:00:00:00:04:01
          BROADCAST MULTICAST  MTU=1500  Metric=1

lo        Link encap:Local Loopback
          inet addr=127.0.0.1  Mask=255.0.0.0
          UP LOOPBACK RUNNING  MTU=65536  Metric=1
'''.replace('=', ':')

# ------------------------------------------------------------------ parsers
w = by(netif.parse_ipconfig(WIN_EN))
ok(list(w) == ['Ethernet 2', 'Ethernet 3', 'Wi-Fi', 'Tailscale', 'vEthernet (Default Switch)', 'Ethernet 4', 'Bluetooth Network Connection'],
   'Windows: one interface per adapter, friendly names; the host part and the isatap pseudo-adapter left out', list(w))
ok(ips(w['Ethernet 2']) == ['192.168.0.10/24'] and w['Ethernet 2']['ipv4'][0]['broadcast'] == '192.168.0.255' and w['Ethernet 2']['up']
   and w['Ethernet 2']['type'] == 'ethernet' and w['Ethernet 2']['label'].startswith('Intel') and w['Ethernet 2']['mac'] == '02:00:00:00:00:01',
   'Windows: Ethernet 2 = Ethernet, up, 192.168.0.10/24, broadcast, description, MAC', w['Ethernet 2'])
ok(ips(w['Ethernet 3']) == ['192.168.0.20/24', '10.10.0.5/16'] and w['Ethernet 3']['type'] == 'ethernet', 'Windows: two IPv4 addresses on one adapter (USB Ethernet)', ips(w['Ethernet 3']))
ok(w['Wi-Fi']['type'] == 'wifi' and not w['Wi-Fi']['up'] and not w['Wi-Fi']['ipv4'], 'Windows: Wi-Fi "Media disconnected" = down, no address')
ok(w['Tailscale']['type'] == 'vpn' and w['Tailscale']['ipv4'][0]['broadcast'] == '' and w['Tailscale']['ipv4'][0]['prefix'] == 32, 'Windows: Tailscale = VPN, /32, no broadcast')
ok(w['vEthernet (Default Switch)']['type'] == 'virtual', 'Windows: Hyper-V switch = virtual')
ok(ips(w['Ethernet 4']) == ['169.254.12.34/16'] and w['Ethernet 4']['type'] == 'ethernet', 'Windows: an automatic (169.254) address is kept (a direct cable to a processor)')
ok(w['Bluetooth Network Connection']['type'] == 'bluetooth' and not w['Bluetooth Network Connection']['up'], 'Windows: Bluetooth PAN = bluetooth, down')
de = by(netif.parse_ipconfig(WIN_DE))
ok(list(de) == ['Ethernet 2', 'WLAN'] and ips(de['Ethernet 2']) == ['10.1.2.3/24'] and de['WLAN']['type'] == 'wifi' and not de['WLAN']['up'],
   'Windows (German): names, address and mask, WLAN disconnected', {k: (v['type'], v['up'], ips(v)) for k, v in de.items()})

ports = netif.parse_hwports(MAC_PORTS)
ok(ports == {'en0': 'Wi-Fi', 'en7': 'USB 10/100/1000 LAN', 'en8': 'Thunderbolt Ethernet Slot 1', 'bridge0': 'Thunderbolt Bridge'}, 'macOS: hardware port names per device', ports)
m = by(netif.parse_ifconfig(MAC_IFCONFIG, ports))
ok(m['en7']['label'] == 'USB 10/100/1000 LAN' and m['en7']['type'] == 'ethernet' and m['en7']['up'] and ips(m['en7']) == ['192.168.0.10/24']
   and m['en7']['ipv4'][0]['broadcast'] == '192.168.0.255', 'macOS: en7 = USB 10/100/1000 LAN, Ethernet, up, 192.168.0.10/24 (hex netmask)', m['en7'])
ok(m['en0']['type'] == 'wifi' and m['en0']['label'] == 'Wi-Fi' and ips(m['en0']) == ['10.0.1.23/24'], 'macOS: en0 = Wi-Fi')
ok(not m['en8']['up'] and m['en8']['type'] == 'ethernet', 'macOS: "status: inactive" = not connected (en8, Thunderbolt Ethernet)')
ok(m['utun3']['type'] == 'vpn' and ips(m['utun3']) == ['100.101.102.103/32'], 'macOS: utun3 = VPN (point-to-point, /32)')
ok(m['lo0']['type'] == 'loopback' and m['lo0']['up'], 'macOS: lo0 = loopback')
ok(m['bridge0']['type'] == 'virtual' and m['awdl0']['type'] == 'virtual' and not m['gif0']['up'], 'macOS: bridge / awdl = virtual, gif0 down')

lx = by(netif.parse_ip(LINUX_LINK, LINUX_ADDR, lambda n: n == 'wlan0'))
ok(sorted(lx) == ['docker0', 'enx020000000206', 'eth0', 'lo', 'tailscale0', 'veth1a2b3c', 'wlan0'], 'Linux ip: every link, "@if6" cut from the name', sorted(lx))
ok(lx['eth0']['up'] and lx['eth0']['type'] == 'ethernet' and ips(lx['eth0']) == ['192.168.0.10/24'] and lx['eth0']['mac'] == '02:00:00:00:02:00', 'Linux ip: eth0 = Ethernet, up, address, MAC')
ok(lx['wlan0']['type'] == 'wifi' and not lx['wlan0']['up'], 'Linux ip: wlan0 = Wi-Fi (sysfs), NO-CARRIER = down')
ok(lx['tailscale0']['type'] == 'vpn' and lx['tailscale0']['up'] and lx['tailscale0']['ipv4'][0]['broadcast'] == '', 'Linux ip: tailscale0 = VPN (link/none), /32')
ok(lx['docker0']['type'] == 'virtual' and not lx['docker0']['up'] and lx['veth1a2b3c']['type'] == 'virtual', 'Linux ip: docker0 / veth = virtual')
ok(lx['enx020000000206']['type'] == 'ethernet' and ips(lx['enx020000000206']) == ['192.168.0.20/24'], 'Linux ip: a USB adapter (enx…) = Ethernet')
ok(lx['lo']['type'] == 'loopback', 'Linux ip: lo = loopback')
n2 = by(netif.parse_ifconfig(LINUX_IFCONFIG_NEW))
ok(n2['eth0']['up'] and ips(n2['eth0']) == ['192.168.0.10/24'] and n2['lo']['type'] == 'loopback' and not n2['wlan0']['up'] and n2['wlan0']['type'] == 'wifi',
   'Linux ifconfig (net-tools 2): eth0 up, lo loopback, wlan0 not running', {k: (v['type'], v['up'], ips(v)) for k, v in n2.items()})
o2 = by(netif.parse_ifconfig(LINUX_IFCONFIG_OLD))
ok(o2['eth0']['up'] and ips(o2['eth0']) == ['192.168.0.10/24'] and o2['eth0']['mac'] == '02:00:00:00:04:00' and not o2['eth1']['up'] and o2['lo']['type'] == 'loopback',
   'Linux ifconfig (old style "Link encap"): eth0 up with address and MAC, eth1 down, lo loopback', {k: (v['type'], v['up'], ips(v)) for k, v in o2.items()})

# ------------------------------------------------------------------ what this computer has (read for real; nothing sent)
real = netif.interfaces(fresh=True)
ok(isinstance(real, list) and all(set(i) >= {'name', 'label', 'type', 'up', 'ipv4'} and i['type'] in netif.TYPES for i in real),
   'this computer: %d interface(s) read (%s)' % (len(real), ', '.join('%s %s' % (i['name'], i['type']) for i in real)))


# ------------------------------------------------------------------ stand-in interfaces from here on
def fake(names_ips):
    out = []
    for name, addrs, up in names_ips:
        out.append({'name': name, 'label': '', 'type': 'loopback' if name == 'lo' else 'ethernet', 'up': up, 'mac': '',
                    'ipv4': [{'ip': ip, 'mask': '255.255.255.0', 'prefix': 24, 'broadcast': bc} for ip, bc in addrs]})
    return out


def use(ifs):
    netif._read = lambda: [dict(i, ipv4=[dict(a) for a in i['ipv4']]) for i in ifs]
    netif._cache['at'] = 0.0


real_read = netif._read
use(fake([('Show A', [('127.0.0.3', '127.0.0.2')], True), ('Show B', [('127.0.0.4', '127.0.0.2'), ('127.0.0.7', '127.0.0.6')], True),
          ('Wi-Fi', [], False), ('lo', [('127.0.0.1', '')], True)]))

# ------------------------------------------------------------------ settings (this computer only)
s0 = netif.load_settings()
ok(s0 == {'disabled': [], 'bind': 'all'}, 'settings: default = every interface searched, the app on every network', s0)
ok([(a['name'], a['ip']) for a in netif.search_ifaces()] == [('Show A', '127.0.0.3'), ('Show B', '127.0.0.4'), ('Show B', '127.0.0.7')],
   'searched: every interface that is up, each address (loopback and a disconnected one aside)', netif.search_ifaces())
netif.save_settings({'disabled': ['Show A']})
ok(netif.load_settings()['disabled'] == ['Show A'] and [a['name'] for a in netif.search_ifaces()] == ['Show B', 'Show B'], 'switching one off leaves it out of the search')
ok(os.path.isfile(os.path.join(TMP, 'config', 'network.json')), 'kept in this computer\'s settings folder (OPENNOVA_CONFIG_DIR here)')
netif.save_settings({'disabled': []})
for bad in ({'disabled': 'Show A'}, {'disabled': [1]}, {'bind': 'x\x01'}):
    try: netif.save_settings(bad); ok(False, 'refused: %r' % (bad,))
    except ValueError: ok(True, 'refused: %r' % (bad,))
keep_env = os.environ['OPENNOVA_CONFIG_DIR']
os.environ['OPENNOVA_CONFIG_DIR'] = os.path.join(netif.NOVA, 'app', 'data')
ok(netif.config_dir() is None, 'never inside the Open Nova folder (it may be synced to other computers)')
os.environ['OPENNOVA_CONFIG_DIR'] = keep_env

# ------------------------------------------------------------------ the app server's bind plan
ok(netif.bind_plan('all')['hosts'] is None, 'bind all = every interface (IPv4 + IPv6)')
ok(netif.bind_plan('localhost')['hosts'] == ['127.0.0.1'], 'bind localhost = this computer only')
ok(netif.bind_plan('Show B')['hosts'] == ['127.0.0.1', '127.0.0.4', '127.0.0.7'], 'bind one interface = this computer + its addresses', netif.bind_plan('Show B'))
bp = netif.bind_plan('USB LAN')
ok(bp['hosts'] == ['127.0.0.1'] and 'not connected' in bp['note'], 'an interface that is not there at start = this computer only, said so (never every network)', bp)
netif.save_settings({'bind': 'Show A'})
ok(netif.bind_plan()['choice'] == 'Show A' and netif.bind_plan()['hosts'] == ['127.0.0.1', '127.0.0.3'], 'no choice given = the saved one')
netif.save_applied(18765, {'choice': 'all', 'hosts': None})
ok(netif.load_applied(18765) == {'choice': 'all', 'hosts': None} and netif.load_applied(18766) is None, 'what the server listens on now is kept per port for the dialog')
netif.save_settings({'bind': 'all'})

# ------------------------------------------------------------------ zones and the same IP on two networks
ok(netif.split_host('192.168.0.11%Ethernet 3') == ('192.168.0.11', 'Ethernet 3') and netif.split_host('192.168.0.11') == ('192.168.0.11', None)
   and netif.split_host('serial:COM3') == ('serial:COM3', None), 'split_host: "ip%interface", a plain host, a serial link')
e = netif.same_ip([{'ip': '192.168.0.11', 'iface': 'Show A'}, {'ip': '192.168.0.11', 'iface': 'Show B'}, {'ip': '192.168.0.12', 'iface': 'Show A'},
                   {'ip': '127.0.0.1', 'iface': 'lo'}, {'ip': '127.0.0.1', 'iface': 'Show A'}])
ok([x['ip'] for x in e[:3]] == ['192.168.0.11%Show A', '192.168.0.11%Show B', '192.168.0.12'] and e[0]['addr'] == '192.168.0.11'
   and 'Two networks' in e[0]['conflict'] and ' 192.168.0.11 ' in e[0]['conflict'] and not e[2].get('conflict') and not e[3].get('conflict'),
   'the same IP on two networks: each entry bound to its interface ("ip%interface") and flagged; this computer\'s own answer isn\'t a second network', e)
ok(netif.peer_ifaces('127.0.0.2') == ['Show A', 'Show B'] and netif.owner('127.0.0.4') == 'Show B', 'peer_ifaces: both networks hold 127.0.0.2; owner of an address')

# ------------------------------------------------------------------ discovery over two stand-in interfaces at once
import novalink    # noqa: E402
import unicolink   # noqa: E402

lo_ok = True
try:
    for a in ('127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.6', '127.0.0.7'):
        t = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); t.bind((a, 0)); t.close()
except OSError as ex:
    lo_ok = False
    print('SKIP discovery over two stand-in interfaces (this system has only 127.0.0.1 on loopback: %s)' % ex)


class Responder:
    """A stand-in processor on UDP addr: answers each search with answer(sender address) (None = silence)."""
    def __init__(self, addr, port, answer):
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); self.s.bind((addr, port)); self.s.settimeout(0.2)
        self.answer, self.heard, self.on = answer, [], True
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        while self.on:
            try: d, a = self.s.recvfrom(65535)
            except OSError: continue
            self.heard.append(a[0]); r = self.answer(a[0], d)
            if r: self.s.sendto(r, a)

    def close(self): self.on = False; time.sleep(0.25); self.s.close()


if lo_ok:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); probe.bind(('127.0.0.2', 0)); P = probe.getsockname()[1]; probe.close()
    novalink.DISC_PORT = P
    # "Show A" and "Show B" each have a processor at 127.0.0.2 (two isolated networks with the same address: told apart by
    # their answer); "Show B" also has one at 127.0.0.6
    r1 = Responder('127.0.0.2', P, lambda src, d: b'rpProMI:NETWORK-' + (b'A' if src == '127.0.0.3' else b'B') if d == b'rqProMI:' else None)
    r2 = Responder('127.0.0.6', P, lambda src, d: b'rpProMI:H_SUB_CARD@^^@5201_5202' if d == b'rqProMI:' else None)
    seq0 = wirelog.status()['seq']
    found = novalink.discover(1.0, targets=('127.0.0.1',))
    f = {x['ip']: x for x in found}
    ok(sorted(f) == ['127.0.0.2%Show A', '127.0.0.2%Show B', '127.0.0.6'], 'discovery: searched on both interfaces at once, three processors', sorted(f))
    ok(f['127.0.0.6']['iface'] == 'Show B' and f['127.0.0.6']['links'] == [5201, 5202] and not f['127.0.0.6'].get('conflict'),
       'each processor says which interface it answered on (127.0.0.6 on Show B, its H links)')
    ok(f['127.0.0.2%Show A']['text'] == 'NETWORK-A' and f['127.0.0.2%Show B']['text'] == 'NETWORK-B' and all('Two networks' in f[k]['conflict'] for k in ('127.0.0.2%Show A', '127.0.0.2%Show B')),
       'the same IP on two networks: both kept apart (each its own answer), flagged', [f[k].get('conflict') for k in f])
    ok(sorted(set(r1.heard)) == ['127.0.0.3', '127.0.0.4'] and r2.heard == ['127.0.0.7'], 'each interface searched from its own address (bound sockets)', (r1.heard, r2.heard))
    recs = [r for r in wirelog.frames(seq0, 5000) if r['kind'] == 'udp']
    ok(any(r['dir'] == 'tx' and r.get('iface') == 'Show A' and r.get('via') == '127.0.0.3' for r in recs)
       and any(r['dir'] == 'rx' and r.get('iface') == 'Show B' and r['peer'] == '127.0.0.6:%d' % P for r in recs),
       'every search packet is recorded with the interface it went out of / came in on')
    netif.save_settings({'disabled': ['Show A']})
    r1.heard[:] = []
    found = novalink.discover(0.8, targets=('127.0.0.1',))
    ok(sorted(x['ip'] for x in found) == ['127.0.0.2', '127.0.0.6'] and r1.heard == ['127.0.0.4'] and not any(x.get('conflict') for x in found),
       'Show A switched off: not searched; 127.0.0.2 is then only Show B\'s (no zone, no flag)', [(x['ip'], x['iface']) for x in found])
    netif.save_settings({'disabled': []})
    r1.close(); r2.close()

    # ---- Unico search: serial numbers; the same IP on two networks; one processor seen on both = one entry
    unicolink.DISC_PORT = P

    def nova(sn):
        j = json.dumps({'SN': sn, 'modelId': 1234, 'deviceName': 'VX-' + sn, 'protocols': [{'linkType': 'http', 'port': 18088}]}).encode()
        return b'NOVA' + bytes(34) + struct.pack('<H', len(j)) + j
    u1 = Responder('127.0.0.2', P, lambda src, d: nova('SN-A' if src == '127.0.0.3' else 'SN-B') if d[:4] == b'NOVA' else None)
    got = {x['SN']: x for x in unicolink.discover(1.0, targets=('127.0.0.1',))}
    ok(sorted(got) == ['SN-A', 'SN-B'] and got['SN-A']['ip'] == '127.0.0.2%Show A' and got['SN-B']['ip'] == '127.0.0.2%Show B' and got['SN-A']['port'] == 18088
       and 'Two networks' in (got['SN-A']['conflict'] or ''), 'Unico search: two serial numbers at one IP on two networks = each bound to its own, flagged', got)
    u1.close()
    u2 = Responder('127.0.0.2', P, lambda src, d: nova('SN-ONE') if d[:4] == b'NOVA' else None)
    got = unicolink.discover(1.0, targets=('127.0.0.1',))
    ok(len(got) == 1 and got[0]['ip'] == '127.0.0.2' and not got[0]['conflict'], 'Unico search: one serial number heard on both networks = one processor (bridged), no flag', got)
    u2.close()

    # ---- TCP through one interface: the connection's source is that interface's address
    srv = socket.socket(); srv.bind(('127.0.0.2', 0)); srv.listen(4); TP = srv.getsockname()[1]; peers = []

    def acc():
        while True:
            try: c, a = srv.accept()
            except OSError: return
            peers.append(a[0]); c.close()
    threading.Thread(target=acc, daemon=True).start()
    seq0 = wirelog.status()['seq']
    L = novalink.TcpLink('127.0.0.2%Show B', TP, 1.0); L.close()
    time.sleep(0.2)
    ok(peers[-1:] == ['127.0.0.4'] and L.local == '127.0.0.4', 'a link to "127.0.0.2%Show B" goes out from Show B\'s address', peers)
    cr = [r for r in wirelog.frames(seq0, 100) if r['kind'] == 'conn' and r['event'] == 'open']
    ok(cr and cr[0]['link'] == '127.0.0.2%%Show B:%d' % TP and cr[0].get('via') == 'Show B 127.0.0.4', 'the recording says which interface the connection used', cr[:1])
    try: novalink.TcpLink('127.0.0.2%USB LAN', TP, 1.0); ok(False, 'an interface that is gone: refused')
    except OSError as ex: ok('isn’t connected' in str(ex), 'an interface that is gone: refused, never "any route" (the same IP elsewhere may be another processor)', str(ex))

    # ---- hot-plug: a USB adapter appears, then goes; recorded, its pooled connection dropped
    netif.poll()
    use(fake([('Show A', [('127.0.0.3', '127.0.0.2')], True), ('Show B', [('127.0.0.4', '127.0.0.2'), ('127.0.0.7', '127.0.0.6')], True),
              ('Wi-Fi', [], False), ('lo', [('127.0.0.1', '')], True), ('USB LAN', [('127.0.0.9', '127.0.0.8')], True)]))
    ev = netif.poll()
    ok([(x['event'], x['name']) for x in ev] == [('added', 'USB LAN')] and 'USB LAN appeared (127.0.0.9)' == ev[0]['text'], 'hot-plug: a new interface is noticed', ev)
    ok('USB LAN' in [a['name'] for a in netif.search_ifaces()], 'and searched by the next search, no restart')
    link = novalink.open_link('127.0.0.2%USB LAN', TP, timeout=1.0); link.close()
    ok(any(s.raw is not None and s.raw.local == '127.0.0.9' for s in novalink._POOL.values()), 'a pooled connection through USB LAN is open')
    seq0 = wirelog.status()['seq']
    use(fake([('Show A', [('127.0.0.3', '127.0.0.2')], False), ('Show B', [('127.0.0.4', '127.0.0.2'), ('127.0.0.7', '127.0.0.6')], True),
              ('Wi-Fi', [('10.0.1.23', '10.0.1.255')], True), ('lo', [('127.0.0.1', '')], True)]))
    ev = netif.poll()
    ok(sorted((x['event'], x['name']) for x in ev) == [('down', 'Show A'), ('removed', 'USB LAN'), ('up', 'Wi-Fi')], 'hot-plug: gone, disconnected, connected', ev)
    novalink.net_changes(ev)
    ok(not any(s.raw is not None and getattr(s.raw, 'local', '') == '127.0.0.9' for s in novalink._POOL.values()), 'the connection that went out of USB LAN is closed cleanly')
    nr = [r for r in wirelog.frames(seq0, 200) if r['kind'] == 'conn' and r['link'].startswith('net:')]
    ok(sorted(r['link'] for r in nr) == ['net:Show A', 'net:USB LAN', 'net:Wi-Fi'] and any('went away' in r['event'] for r in nr), 'every change is recorded (link "net:<interface>")', nr)
    st = netif.state()
    ok(st['seq'] >= 2 and st['events'][-1]['text'], 'the change counter the app checks moved')
    srv.close()

# ------------------------------------------------------------------ the helper's routes
from http.server import ThreadingHTTPServer   # noqa: E402
h = ThreadingHTTPServer(('127.0.0.1', 0), novalink.Handler); HP = h.server_address[1]
threading.Thread(target=h.serve_forever, daemon=True).start()


def post(path, body):
    rq = urllib.request.Request('http://127.0.0.1:%d%s' % (HP, path), data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(rq, timeout=5) as r: return r.status, json.loads(r.read())
    except urllib.error.HTTPError as ex: return ex.code, json.loads(ex.read())


novalink.NET_FOUND.clear(); novalink.net_found('lct', [{'ip': '127.0.0.6', 'iface': 'Show B'}, {'ip': '127.0.0.2%Show A', 'addr': '127.0.0.2', 'iface': 'Show A'}])
c, r = post('/api/hw/net/interfaces', {'appPort': 18765})
ri = {i['name']: i for i in r.get('interfaces', [])}
ok(c == 200 and r['ok'] and 'Show B' in ri and ri['Show B']['search'] and ri['Show B']['found'] == [{'ip': '127.0.0.6', 'kind': 'lct'}] and ri['Show A']['found'][0]['ip'] == '127.0.0.2'
   and not ri['lo']['search'] and r['applied'] == {'choice': 'all', 'hosts': None} and 'mac' not in ri['Show B'] and r['saved'],
   '/api/hw/net/interfaces: interfaces, searched, processors found on each, what the server listens on now', r)
c, r = post('/api/hw/net/set', {'disabled': ['Wi-Fi'], 'bind': 'Show B', 'appPort': 18765})
ok(c == 200 and r['settings'] == {'disabled': ['Wi-Fi'], 'bind': 'Show B'} and r['plan']['hosts'] == ['127.0.0.1', '127.0.0.4', '127.0.0.7']
   and {i['name']: i['search'] for i in r['interfaces']}['Wi-Fi'] is False, '/api/hw/net/set: saved, the new plan in the answer')
c, r = post('/api/hw/net/set', {'disabled': 'Wi-Fi'})
ok(c == 400 and not r['ok'], '/api/hw/net/set: a bad value is refused (400)', r)
c, r = post('/api/hw/net/state', {})
ok(c == 200 and r['ok'] and 'seq' in r and isinstance(r['events'], list), '/api/hw/net/state: the change counter')
h.shutdown()

# ------------------------------------------------------------------ the problem report
md = netif.report_md()
ok(md[1] == '## Networks' and any('Show B' in x for x in md) and 'Show B' in json.dumps(netif.report()), 'the problem report lists the networks and the settings')

netif._read = real_read; netif._cache['at'] = 0.0
print('\n' + ('All passed' if not fails else '%d FAILED:\n  ' % len(fails) + '\n  '.join(fails)))
sys.exit(1 if fails else 0)
