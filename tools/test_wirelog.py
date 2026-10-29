"""Tests for wirelog.py (the flight recorder) through novalink's real TcpLink against a small stand-in processor:
frames, replies with round-trip times, a stale reply, a status error, a timeout, a refused connection, the file on disk,
.pcap export and re-import (classic and pcapng), H series echoes, late replies, old recordings sorted out on load, helper
bugs and USB / serial links in the export, the register names.   python -I tools/test_wirelog.py   (exit 0 = all passed)
"""
import json
import os
import re
import socket
import struct
import sys
import tempfile
import threading
import time

TMP = tempfile.mkdtemp(prefix='opennova_diag_test_')
os.environ['OPENNOVA_DIAG'] = TMP
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import novalink   # noqa: E402
import wirelog    # noqa: E402

fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond: fails.append(what)


def reply(req, status=0, data=b'', serial=None):
    h = bytearray(req[:18]); h[0], h[1], h[2] = 0xAA, 0x55, status
    if serial is not None: h[3] = serial
    struct.pack_into('<H', h, 16, len(data)); b = bytes(h) + data
    return b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF)


def fake(srv):
    """Answers by address: 0x00000002 -> 4A 7B; 0x02000001 -> ok; 0x01000002 -> status 3; 0x0BAD0000 -> nothing;
    0x05050000 -> a stale reply first, then the right one."""
    c, _ = srv.accept()
    buf = b''
    while True:
        try: d = c.recv(4096)
        except OSError: break
        if not d: break
        buf += d
        while len(buf) >= 20:
            n = struct.unpack_from('<H', buf, 16)[0] if buf[10] == 1 else 0
            req, buf = buf[:20 + n], buf[20 + n:]
            addr = struct.unpack_from('<I', req, 12)[0]
            if addr == 0x00000002: c.sendall(reply(req, data=b'\x4A\x7B'))
            elif addr == 0x01000002: c.sendall(reply(req, status=3))
            elif addr == 0x0BAD0000: pass
            elif addr == 0x05050000: c.sendall(reply(req, serial=(req[3] - 1) & 0xFF) + reply(req, data=b'\x01'))
            else: c.sendall(reply(req))
    c.close()


srv = socket.socket(); srv.bind(('127.0.0.1', 0)); srv.listen(1); port = srv.getsockname()[1]
threading.Thread(target=fake, args=(srv,), daemon=True).start()
link = novalink.TcpLink('127.0.0.1', port, timeout=0.5)
tag = '127.0.0.1:%d' % port
mid = link.read(0, 0, 0, 0, 0x00000002, 2)
link.write(1, 0, 2, 0xFFFF, 0x02000001, b'\xFF')
try: link.write(0, 0xFF, 0, 0, 0x01000002, b'\x00', r2=7); st = None
except novalink.LinkError as e: st = str(e)
try: link.read(0, 0, 0, 0, 0x0BAD0000, 1); to = None
except novalink.LinkError as e: to = str(e)
link.close()
link = novalink.TcpLink('127.0.0.1', port, timeout=0.5) if False else None
try: novalink.TcpLink('127.0.0.1', 1, timeout=0.5); refused = False
except OSError: refused = True

R = wirelog.frames(0, 1000)
tg = [r for r in R if r['kind'] == 'tg']
ok(mid == b'\x4A\x7B', 'the link still works with the recorder in it (ModelID read 4A 7B)')
ok(any(r['dir'] == 'tx' and r['d']['addr'] == '0x00000002' and r['d']['name'] == 'ModelID' for r in tg), 'request recorded, decoded, register named (ModelID)')
rx = [r for r in tg if r['dir'] == 'rx' and r['d']['addr'] == '0x00000002']
ok(rx and rx[0].get('rtt') is not None and rx[0]['sum'].endswith('-> 4A 7B'), 'reply recorded with its round-trip time and value (%s)' % (rx[0]['sum'] if rx else '-'))
w = [r for r in tg if r['dir'] == 'tx' and r['d']['addr'] == '0x02000001']
ok(w and w[0]['sum'] == 'W rx S1 P3 C* 0x02000001 GlobalBrightness = FF', 'receiving-card write summary: %s' % (w[0]['sum'] if w else '-'))
fr = [r for r in tg if r['dir'] == 'tx' and r['d']['addr'] == '0x01000002']
ok(fr and 'r2=7' in fr[0]['sum'] and 'FactoryReset' in fr[0]['sum'], 'factory reset frame named, r2 shown: %s' % (fr[0]['sum'] if fr else '-'))
errs = [r for r in R if r['kind'] == 'err']
ok(st and any('status 3' in e['error'] and 'FactoryReset' in e.get('req', '') for e in errs), 'a non-zero status is an error record with its request')
ok(to and any('timeout' in e['error'] and '0x0BAD0000' in e.get('req', '') for e in errs), 'a timeout is an error record with its request')
conns = [r for r in R if r['kind'] == 'conn']
ok(refused and any(c['event'] == 'connect failed' for c in conns) and any(c['event'] == 'open' for c in conns) and any(c['event'] == 'close' for c in conns),
   'connection open / close / refused recorded')
ok(wirelog.status()['links'][tag]['err'] >= 2 and wirelog.status()['links'][tag]['rtt_avg'] is not None, 'per-link stats: errors and round-trip times')

# stale reply (a fresh link and a fresh fake)
srv2 = socket.socket(); srv2.bind(('127.0.0.1', 0)); srv2.listen(1); p2 = srv2.getsockname()[1]
threading.Thread(target=fake, args=(srv2,), daemon=True).start()
l2 = novalink.TcpLink('127.0.0.1', p2, timeout=0.5); v = l2.read(0, 0, 0, 0, 0x05050000, 1); l2.close()
ok(v == b'\x01' and any(r['kind'] == 'tg' and r.get('stale') for r in wirelog.frames(0, 1000)), 'a stale reply is recorded and skipped')

wirelog.mark('pressing Detect', 'user')
fl = wirelog.files()
ok(fl and fl[0]['name'].endswith('.nwl') and wirelog.load(fl[0]['name'])[-1]['kind'] == 'mark', 'everything is on disk in diagnostics/<day>/*.nwl, the note last')

# pcap round trip
recs = wirelog.load(fl[0]['name'])
pc = wirelog.to_pcap(recs)
back = wirelog.from_capture(pc)
a = [(r['dir'], r['hex']) for r in recs if r['kind'] == 'tg']
b = [(r['dir'], r['hex']) for r in back if r['kind'] == 'tg']
ok(len(a) >= 10 and a == b, '.pcap export and re-import give the same %d frames, same directions' % len(a))
ok(any(r.get('rtt') is not None for r in back if r['kind'] == 'tg' and r['dir'] == 'rx'), 'imported replies get round-trip times')
# the same packets as pcapng (Wireshark's default format)
pk = list(wirelog._packets(pc))
shb = struct.pack('<IIIHHq', 0x0A0D0D0A, 28, 0x1A2B3C4D, 1, 0, -1) + struct.pack('<I', 28)
idb = struct.pack('<IIHHI', 1, 20, 1, 0, 65535) + struct.pack('<I', 20)
epbs = b''
for t, _lt, p in pk:
    ts = int(t * 1e6); pad = (-len(p)) % 4; L = 32 + len(p) + pad
    epbs += struct.pack('<IIIIIII', 6, L, 0, ts >> 32, ts & 0xFFFFFFFF, len(p), len(p)) + p + b'\0' * pad + struct.pack('<I', L)
ng = wirelog.from_capture(shb + idb + epbs)
ok([(r['dir'], r['hex']) for r in ng if r['kind'] == 'tg'] == a, 'a .pcapng (Wireshark default) decodes the same')
# a capture split across packets and with a retransmission
f1 = bytes.fromhex(a[0][1])
def eth(t, seq, payload):
    l4 = struct.pack('!HHIIBBHHH', 50000, 5200, seq, 0, 5 << 4, 0x18, 65535, 0, 0) + payload
    return wirelog._pkt(t, b'\x0a\x00\x00\x01', b'\x0a\x00\x00\x02', 6, l4)
split = struct.pack('<IHHiIII', 0xA1B2C3D4, 2, 4, 0, 0, 65535, 1) + eth(1.0, 100, f1[:7]) + eth(1.1, 100, f1[:7]) + eth(1.2, 107, f1[7:])
sp = [r for r in wirelog.from_capture(split) if r['kind'] == 'tg']
ok(len(sp) == 1 and sp[0]['hex'] == f1.hex(), 'a frame split over two packets, one retransmitted, is put back together once')


# ---- H series echoes (live, 2026-10-11: a broadcast write comes back as sent; a request for a sending card that isn't
# there comes back with the sending-card byte changed, 01 -> FA, checksum redone) - recorded as 'echo', not 'junk'
def resum(b):
    b = bytes(b[:-2]); return b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF)


def h_fake(srv):
    c, _ = srv.accept(); buf = b''
    while True:
        try: d = c.recv(4096)
        except OSError: break
        if not d: break
        buf += d
        while len(buf) >= 20:
            n = struct.unpack_from('<H', buf, 16)[0] if buf[10] == 1 else 0
            req, buf = buf[:20 + n], buf[20 + n:]
            if req[5] == 0xFF: c.sendall(req)                                   # broadcast: back as it was, no reply
            elif req[5] != 0: c.sendall(resum(req[:5] + bytes([0xFA]) + req[6:]))  # no such sending card
            else: c.sendall(reply(req, data=b'\x00' * struct.unpack_from('<H', req, 16)[0]))
    c.close()


srv3 = socket.socket(); srv3.bind(('127.0.0.1', 0)); srv3.listen(1); p3 = srv3.getsockname()[1]
threading.Thread(target=h_fake, args=(srv3,), daemon=True).start()
l3 = novalink.TcpLink('127.0.0.1', p3, timeout=0.3); tag3 = '127.0.0.1:%d' % p3
l3.write(0, 0xFF, 0, 0, 0x01000000, b'\x00', no_reply=True)
try: l3.read(0, 1, 0, 0, 0x00000002, 2); gone = False
except novalink.LinkError: gone = True
l3.read(0, 0, 0, 0, 0x02000000, 4); l3.close()
R3 = [r for r in wirelog.frames(0, 5000) if r.get('link') == tag3]
tx3 = [r for r in R3 if r['kind'] == 'tg' and r['dir'] == 'tx']
ec = [r for r in R3 if r['kind'] == 'echo']
ok(gone and len(ec) == 2 and not [r for r in R3 if r['kind'] == 'junk'], 'H echoes are recorded as echo, nothing as junk (%d echo)' % len(ec))
ok(ec and ec[0].get('of') == tx3[0]['seq'] and not ec[0].get('change') and 'SortCommand' in ec[0]['sum'], 'the broadcast write echo points at its request')
ok(len(ec) > 1 and ec[1].get('of') == tx3[1]['seq'] and ec[1].get('change') == 'sending card S2 -> S251', 'the echo of a request for a missing sending card says so: %s' % (ec[1].get('change') if len(ec) > 1 else '-'))

# a late reply (USB drain after a timeout): a 'tg' rx, late, with how late, kept out of the link's reply times
rq = tx3[1]; late_reply = reply(bytes.fromhex(rq['hex']), status=1)
before = wirelog.status()['links'][tag3]['rtt_max']
lr = wirelog.stray(tag3, late_reply + b'\x01\x02\x03', 'drained')
ok([r['kind'] for r in lr] == ['tg', 'junk'] and lr[0].get('late') and lr[0].get('rtt') is not None and lr[0]['note'] == 'drained' and lr[1]['n'] == 3,
   'a late reply is a late tg rx with its time; bytes after it are junk')
ok(wirelog.status()['links'][tag3]['rtt_max'] == before, 'a late reply does not count in the link reply times')

# recordings from before: their 'junk' is sorted out on load (upgrade)
bc = bytes.fromhex(tx3[0]['hex'])
old = [{'seq': 1, 't': 10.0, 'kind': 'tg', 'link': 'usb:0483:5720@0-1', 'dir': 'tx', 'hex': bc.hex(), 'd': wirelog.decode(bc)[0]},
       {'seq': 2, 't': 10.1, 'kind': 'tg', 'link': 'usb:0483:5720@0-1', 'dir': 'tx', 'hex': rq['hex'], 'd': rq['d']},
       {'seq': 3, 't': 10.2, 'kind': 'junk', 'link': 'usb:0483:5720@0-1', 'hex': bc.hex(), 'n': len(bc)},
       {'seq': 4, 't': 10.6, 'kind': 'junk', 'link': 'usb:0483:5720@0-1', 'hex': (late_reply + b'\xEE').hex(), 'n': 21, 'note': 'drained'}]
up = wirelog.upgrade(old)
ok([(r['kind'], r['seq']) for r in up] == [('tg', 1), ('tg', 2), ('echo', 3), ('tg', 4), ('junk', 4.1)] and up[2].get('of') == 1 and up[3].get('late')
   and abs(up[3].get('rtt', 0) - 500) < 1, 'old junk records are sorted into echo / late reply / junk on load')
REAL = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'OpenNova-20261011', 'diagnostics', '2026-10-11')
if os.path.isdir(REAL):   # the user's real H recordings (read only)
    ne = nj = nf = 0
    for fn in sorted(os.listdir(REAL)):
        if not fn.endswith('.nwl'): continue
        with open(os.path.join(REAL, fn), encoding='utf-8', errors='replace') as fh:
            recs = []
            for line in fh:
                try: recs.append(json.loads(line))
                except ValueError: pass
        for r in wirelog.upgrade(recs):
            ne += r['kind'] == 'echo'
            if r['kind'] == 'junk':
                nj += 1; nf += any(f for f, _ in wirelog.split_frames(bytes.fromhex(r['hex'])))
    ok(ne > 0 and nf == 0, 'real H recordings: %d echoes, %d junk left, none of it a frame' % (ne, nj))
else:
    print('SKIP real H recordings (%s not here)' % REAL)

# ---- helper bugs and USB / serial links in the .pcap export
bug = wirelog.record('err', link='helper', error='/api/hw/info KeyError: x', where=['  File "novalink.py", line 1', '    x = y["x"]', "KeyError: 'x'"])
def mk(serial, dst, addr, n):
    h = bytes([0x55, 0xAA, 0, serial, 0xFE, dst, 0, 0]) + struct.pack('<HBBIH', 0, 0, 0, addr, n)
    return h + struct.pack('<H', (0x5555 + sum(h[2:])) & 0xFFFF)
q1, q2, q3 = mk(1, 0, 0x00000002, 2), mk(2, 0xFF, 0x01000000, 0), mk(3, 0, 0x00000002, 2)
usb = [{'seq': 1, 't': 20.0, 'kind': 'tg', 'link': 'usb:0483:5720@0-1', 'dir': 'tx', 'hex': q1.hex()},
       {'seq': 2, 't': 20.1, 'kind': 'tg', 'link': 'usb:0483:5720@0-1', 'dir': 'rx', 'hex': reply(q1, data=b'\x4A\x7B').hex()},
       {'seq': 3, 't': 20.2, 'kind': 'tg', 'link': 'usb:0483:5720@0-1', 'dir': 'tx', 'hex': q2.hex()},
       {'seq': 4, 't': 20.3, 'kind': 'echo', 'link': 'usb:0483:5720@0-1', 'dir': 'rx', 'hex': q2.hex(), 'of': 3},
       {'seq': 5, 't': 20.4, 'kind': 'tg', 'link': 'serial:COM3', 'dir': 'tx', 'hex': q3.hex()},
       {'seq': 6, 't': 20.5, 'kind': 'tg', 'link': 'serial:COM3', 'dir': 'rx', 'hex': reply(q3, data=b'\x46\x7B').hex()},
       {'seq': 7, 't': 20.6, 'kind': 'junk', 'link': 'usb:0483:5720@0-1', 'hex': '55534253' + '00' * 9, 'n': 13, 'note': 'USB status 1'},
       dict(bug)]
pc2 = wirelog.to_pcap(usb)
pk2 = list(wirelog._packets(pc2))
tcp_ports = set(); notes = []
for _t, _lt, p in pk2:
    ip = p[14:]
    if ip[9] == 6: tcp_ports.update(struct.unpack_from('!HH', ip, 20))
    elif ip[9] == 17: notes.append(ip[28:].decode('utf-8', 'replace'))
ok(5200 in tcp_ports and len([n for n in notes if n.startswith('OpenNova link: ')]) == 2, 'USB / serial links go out on made-up hosts at TCP 5200 (where the plug-in decodes), each with a note')
ok(any(n.startswith('OpenNova err: ') and '"where"' in n and '"helper"' in n for n in notes), 'a helper bug goes into the .pcap as a note with its traceback')
ok(any('USB status 1' in n for n in notes), 'a USB status block goes in as a note, not as stream bytes')
back2 = wirelog.from_capture(pc2)
ok([(r['kind'], r['link'], r.get('dir'), r['hex']) for r in back2 if r['kind'] in ('tg', 'echo')] ==
   [(r['kind'], r['link'], r['dir'], r['hex']) for r in usb if r['kind'] in ('tg', 'echo')], 'USB / serial frames and the echo come back from the .pcap with their link names')
ok([r for r in back2 if r['kind'] == 'echo'][0].get('of') == 3, 'the imported echo points at its request')

# ---- register names (tools/build_registers.py from docs/HW_OPERATIONS.md; both research files stay out of the repository,
# so a checkout checks the packaged table tools/tg_registers.json itself)
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tg_registers.json'), encoding='utf-8') as fh: disk = json.load(fh)
try:
    import build_registers   # noqa: E402
    have_doc = os.path.isfile(build_registers.DOC)
except ImportError:
    have_doc = False
if have_doc:
    reg = build_registers.build(open(build_registers.DOC, encoding='utf-8').read().splitlines())
    ok(disk == reg, 'tools/tg_registers.json is up to date with the doc (python tools/build_registers.py)')
else:
    reg = disk
    print('SKIP tg_registers.json against docs/HW_OPERATIONS.md (build_registers.py / the doc are research files, not in the repository)')
bad = [(d, a, v[0]) for d in reg for a, v in reg[d].items()
       if v[0].count('(') != v[0].count(')') or re.search(r'^\W|\*|\)\w|`', v[0]) or not v[0].strip()]
ok(not bad, 'no malformed register names (%s)' % (bad[:3] or 'none'))
want = {('0', 0x02000100): 'MasterOrSlaveNew16Addr', ('0', 0x02000018): 'MasterSlavePort0', ('0', 0x02010040): 'MasterOrSlaveNew32Addr',
        ('0', 0x020000B0): 'PortEnableNextAddr', ('0', 0x03100200): 'NumberOfCardOrBoardInPort16Addr', ('0', 0x0E100000): 'Sender_GreenGammaTableAddr',
        ('0', 0x02800010): 'ReadScanCardCountOfSender', ('0', 0x01000000): 'SortCommand', ('0', 0x1A000003): 'HWRestoreFinish',
        ('0', 0x14000000): 'DeviceName', ('0', 0x13050200): 'PQ output', ('1', 0x02000003): 'G brightness', ('1', 0x0200019E): 'Clearview master',
        ('1', 0x02000045): 'SubField6', ('1', 0x01000011): 'ParameterStore2SpiFlash', ('1', 0x020000E2): 'TV-card DVI0 H'}
miss = ['%s %08X %r' % (d, a, (reg[d].get('0x%08X' % a) or ['-'])[0]) for (d, a), n in want.items() if (reg[d].get('0x%08X' % a) or [''])[0] != n]
ok(not miss, 'packed table rows expand to the right names (%s)' % (miss or 'all %d' % len(want)))
wirelog._names = None
ok(wirelog.reg_name(0, 0x02000100) == 'MasterOrSlaveNew16Addr' and wirelog.reg_name(1, 0x02000100) == 'Blackout', 'names in frames: sender 0x02000100 / receiving-card blackout')
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wireshark', 'novastar.lua'), encoding='utf-8') as fh: lua = fh.read()
ok('NAMES[0][0x02000100] = "MasterOrSlaveNew16Addr"' in lua and 'New32)Addr' not in lua and 'novastar.echo' in lua, 'the Wireshark plug-in carries the same names and marks echoes (python tools/build_wireshark.py)')

print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
