"""Tests for usbcap.py (Tools ▸ Vendor apps ▸ USB capture, docs/USB_CAPTURE.md): USBPcap captures built here (.pcap and
.pcapng, link type 249) decoded into the recorder's records — a descriptor exchange, USBC + TG write + IN reply, the USBS
status flow (A3 read block), a second device on the same root hub, a frame split over two IN transfers, timed-out reads,
an empty packet, an echo, a packet cut by the snap length, a truncated file, identification by hint / by traffic — then the
import into vendor/captures/, the detection parsers and states, the installer's checks (nothing is ever installed or
elevated), and start / stop with a stand-in USBPcapCMD (consent, already running, refused prompt). No driver, no device,
no admin.   python -I -X utf8 tools/test_usbcap.py   (exit 0 = all passed)
"""
import json
import os
import struct
import sys
import tempfile
import time

TMP = tempfile.mkdtemp(prefix='opennova_usbcap_test_')
os.environ['OPENNOVA_DIAG'] = os.path.join(TMP, 'diag')
os.environ.pop('OPENNOVA_USBPCAPCMD', None); os.environ.pop('OPENNOVA_USBPCAP_SETUP', None)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wirelog       # noqa: E402
import usbcap as U   # noqa: E402

fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what); sys.stdout.flush()
    if not cond: fails.append(what)


# ------------------------------------------------------------------ building captures
def frame(head, serial, dev=0, addr=0x00000002, op=0, ln=2, data=b'', status=0, card=0, port=0, dst=0):
    """A TG frame: head 55AA = request (read: no data), AA55 = reply."""
    if head == b'\x55\xAA': b = bytearray(head + bytes([0, serial, 0xFE, dst, dev, port]))
    else: b = bytearray(head + bytes([status, serial, dst, 0xFE, dev, port]))
    b += struct.pack('<HBBIH', card, op, 0, addr, ln) + data
    return bytes(b) + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF)


def cbw(n, read=False, tag=0x1234):
    return b'USBC' + struct.pack('<IIBBB', tag, n, 0x80 if read else 0, 0, 16) + bytes([0xA3 if read else 0xA2, 0, 0, 0, 0, 0, 0, 1]) + bytes(8)


def csw(tag=0x1234, residue=0, status=0):
    return b'USBS' + struct.pack('<IIB', tag, residue, status)


def pkt(bus, dev, ep, info, data=b'', transfer=3, status=0, irp=1, fn=9, stage=None, n=None):
    hl = 27 + (1 if stage is not None else 0)
    h = struct.pack('<HQIHBHHBBI', hl, irp, status, fn, info, bus, dev, ep, transfer, len(data) if n is None else n)
    return h + (bytes([stage]) if stage is not None else b'') + data


def descriptor(bus, dev, vid, pid, irp=7):
    d = bytes([18, 1, 0, 2, 0, 0, 0, 64]) + struct.pack('<HHH', vid, pid, 0x0404) + bytes([1, 2, 3, 1])
    setup = bytes([0x80, 6, 0, 1, 0, 0, 18, 0])
    return [pkt(bus, dev, 0x80, 0, setup, transfer=2, fn=0x0B, stage=0, irp=irp), pkt(bus, dev, 0x80, 1, d, transfer=2, fn=0x0B, stage=3, irp=irp)]


def pcap(pk, cut=0):
    """[(t, bytes) or (t, bytes, orig)] -> a classic .pcap like USBPcapCMD's (LE, microseconds, link type 249)."""
    out = struct.pack('<IHHiIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, 249)
    for x in pk:
        t, b = x[0], x[1]; orig = x[2] if len(x) > 2 else len(b)
        out += struct.pack('<IIII', int(t), int(round((t - int(t)) * 1e6)), len(b), orig) + b
    return out[:len(out) - cut] if cut else out


def pcapng(pk):
    def blk(t, body): body += bytes((-len(body)) % 4); n = 12 + len(body); return struct.pack('<II', t, n) + body + struct.pack('<I', n)
    out = blk(0x0A0D0D0A, struct.pack('<IHHq', 0x1A2B3C4D, 1, 0, -1))
    out += blk(1, struct.pack('<HHI', 249, 0, 0))                     # no if_tsresol: microseconds
    for x in pk:
        t, b = x[0], x[1]; us = int(round(t * 1e6))
        out += blk(6, struct.pack('<IIIII', 0, us >> 32, us & 0xFFFFFFFF, len(b), len(b)) + b)
    return out


T0 = 1763300000.0
NOVA = (1, 5)
OTHER = (1, 6)
LINK = 'usb:0483:5720@USBPcap1.5'


def main_capture():
    """The story most tests read: descriptors, a main-path read, the USBS flow, a split reply, noise from another device."""
    p, t = [], T0
    def at(dt, b):
        nonlocal t; t += dt; p.append((t, b))
    for b in descriptor(*NOVA, 0x0483, 0x5720): at(0.001, b)
    for b in descriptor(*OTHER, 0x046D, 0xC077, irp=8): at(0.001, b)
    # 1) main path: USBC(A2) + read ModelID, the reply on IN
    r1 = frame(b'\x55\xAA', 1, addr=0x00000002, ln=2)
    a1 = frame(b'\xAA\x55', 1, addr=0x00000002, ln=2, data=b'\x51\x01')
    at(0.010, pkt(*NOVA, 0x01, 0, cbw(len(r1)), irp=10)); at(0.0001, pkt(*NOVA, 0x01, 1, irp=10, n=0))
    at(0.0001, pkt(*NOVA, 0x01, 0, r1, irp=11)); at(0.0001, pkt(*NOVA, 0x01, 1, irp=11, n=0))
    at(0.0001, pkt(*NOVA, 0x81, 0, irp=12))
    at(0.0042, pkt(*NOVA, 0x81, 1, a1, irp=12))
    # another device on the same hub: bulk that even looks like a frame -> stays out
    at(0.001, pkt(*OTHER, 0x02, 0, frame(b'\x55\xAA', 9), irp=20)); at(0.001, pkt(*OTHER, 0x81, 1, b'\x01\x02\x03', transfer=1, irp=21))
    # 2) USBS flow: write, a CSW first, then an A3 read block and the reply, then a trailing CSW
    w2 = frame(b'\x55\xAA', 2, addr=0x02000001, op=1, ln=1, data=b'\xFF', dev=1, port=0xFF, card=0xFFFF)
    a2 = frame(b'\xAA\x55', 2, addr=0x02000001, op=1, ln=1, data=b'\xFF', dev=1, port=0xFF, card=0xFFFF)
    at(0.010, pkt(*NOVA, 0x01, 0, cbw(len(w2), tag=0x55), irp=30)); at(0.0001, pkt(*NOVA, 0x01, 0, w2, irp=31))
    at(0.0010, pkt(*NOVA, 0x81, 1, csw(0x55), irp=32))
    at(0.0001, pkt(*NOVA, 0x01, 0, cbw(20 + 1, read=True, tag=0x56), irp=33))
    at(0.0030, pkt(*NOVA, 0x81, 1, a2 + csw(0x56), irp=34))
    # 3) a timed-out read (NovaLCT's 1000 ms reads): counted, not recorded
    at(1.0, pkt(*NOVA, 0x81, 1, status=0xC0010000, irp=40, n=0))
    # 4) a reply split over two IN transfers (64 B of data)
    r4 = frame(b'\x55\xAA', 3, addr=0x00000100, ln=64)
    a4 = frame(b'\xAA\x55', 3, addr=0x00000100, ln=64, data=bytes(range(64)))
    at(0.010, pkt(*NOVA, 0x01, 0, cbw(len(r4)), irp=50)); at(0.0001, pkt(*NOVA, 0x01, 0, r4, irp=51))
    at(0.0020, pkt(*NOVA, 0x81, 1, a4[:30], irp=52)); at(0.0030, pkt(*NOVA, 0x81, 1, a4[30:], irp=53))
    # 5) an empty packet after a 64-byte multiple, an echo of a request, a failed write
    at(0.010, pkt(*NOVA, 0x01, 0, b'', irp=60))
    at(0.001, pkt(*NOVA, 0x81, 1, r1, irp=61))
    at(0.001, pkt(*NOVA, 0x01, 1, status=0xC0000004, irp=62, n=0))
    return p, (r1, a1, w2, a2, r4, a4)


def kinds(recs, k): return [r for r in recs if r['kind'] == k]


# ------------------------------------------------------------------ tests
def t_decode():
    p, (r1, a1, w2, a2, r4, a4) = main_capture()
    recs = U.from_pcap(pcap(p))
    tg = kinds(recs, 'tg')
    ok([(r['dir'], r['hex']) for r in tg] == [('tx', r1.hex()), ('rx', a1.hex()), ('tx', w2.hex()), ('rx', a2.hex()), ('tx', r4.hex()), ('rx', a4.hex())],
       'TG frames rebuilt in order: OUT = tx, IN = rx, wrappers stripped (%d)' % len(tg))
    ok(all(r['link'] == LINK for r in recs if r.get('link') and r['link'] != 'usbcap'), 'every record is the NovaStar device’s link (%s); the other device stays out' % LINK)
    ok(tg[0]['sum'] == wirelog.summary(*wirelog.decode(r1)) and 'ModelID' in tg[0]['sum'] and tg[1]['d']['kind'] == 'reply', 'named by the recorder’s own decoder: %s' % tg[0]['sum'])
    ok(abs(tg[1].get('rtt', 0) - (0.0001 + 0.0001 + 0.0042) * 1000) < 0.05, 'RTT from the URB times (request OUT -> reply IN): %s ms' % tg[1].get('rtt'))
    ok(abs(tg[5]['t'] - tg[4]['t'] - 0.005) < 1e-4 and tg[5]['hex'] == a4.hex(), 'a reply split over two IN transfers is one frame at the second transfer’s time')
    u = kinds(recs, 'usb')
    w = [(x['what'], x.get('read'), x.get('cb'), x['dir']) for x in u]
    ok(w == [('USBC', False, 'A2', 'tx'), ('USBC', False, 'A2', 'tx'), ('USBS', None, None, 'rx'), ('USBC', True, 'A3', 'tx'), ('USBS', None, None, 'rx'),
             ('USBC', False, 'A2', 'tx'), ('empty packet', None, None, 'tx')], 'wrapper blocks recorded as usb notes: %s' % w)
    ok(u[0]['len'] == len(r1) and u[0]['tag'] == 0x1234 and u[2]['tag'] == 0x55 and u[2]['status'] == 0 and u[3]['len'] == 21, 'USBC length / tag and USBS tag / status decoded')
    e = kinds(recs, 'echo')
    ok(len(e) == 1 and e[0].get('of') == tg[0]['seq'], 'a request coming back on IN is an echo of it')
    er = kinds(recs, 'err')
    ok(len(er) == 1 and 'USB write failed: status 0xC0000004' in er[0]['error'], 'a failed OUT transfer is an err: %s' % [x['error'] for x in er])
    ok(not kinds(recs, 'junk'), 'no junk in a clean capture')
    ok(any(r['kind'] == 'mark' and 'its device descriptor' in r['text'] for r in recs), 'the device was identified by its descriptor')
    ok(not any('046D' in json.dumps(r) or r.get('hex') == frame(b'\x55\xAA', 9).hex() for r in recs), 'control transfers and the other device’s traffic are left out')
    ng = U.from_pcap(pcapng(p))
    strip = lambda rs: [(r['kind'], r.get('hex'), r.get('dir')) for r in rs]
    ok(strip(ng) == strip(recs) and abs(ng[-1]['t'] - recs[-1]['t']) < 1e-5, 'the same from a .pcapng (%d records)' % len(ng))
    ok(U.is_usbpcap(pcap(p)) and U.is_usbpcap(pcapng(p)) and U.is_usbpcap(pcap([])) and not U.is_usbpcap(struct.pack('<IHHiIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1)),
       'is_usbpcap: .pcap / .pcapng / empty capture yes, Ethernet no')
    seqs = [r['seq'] for r in recs]
    ok(seqs == list(range(1, len(recs) + 1)) and all(recs[i]['t'] <= recs[i + 1]['t'] + 1e-9 for i in range(len(recs) - 1) if recs[i]['kind'] != 'mark'), 'seq 1..n, times in order')


def t_identify():
    p, (r1, a1, *_) = main_capture()
    nodesc = [x for x in p if U.usb_header(x[1])['transfer'] != 2]
    a = U.from_pcap(pcap(nodesc), hint=NOVA)
    ok(len(kinds(a, 'tg')) == 6 and any('the address the capture started with' in r.get('text', '') for r in a), 'no descriptors: the hint (hub, address) from the start names the device')
    b = U.from_pcap(pcap(nodesc))
    ok(len(kinds(b, 'tg')) == 6 and any('its traffic' in r.get('text', '') for r in b) and all(r.get('link') in (LINK, None, 'usbcap') for r in b),
       'no descriptors, no hint: found by its traffic (USBC A2), the other device (a bare 55 AA frame) still left out')
    c = U.from_pcap(pcap([(T0, x) for x in descriptor(1, 5, 0x1234, 0x0001)] + nodesc), hint=NOVA)
    ok(not kinds(c, 'tg'), 'a descriptor naming another device wins over the hint (the address was reused)')
    # the device comes back on another address after a replug: its new descriptor names it
    q = [(T0 + 5 + i * 0.001, x) for i, x in enumerate(descriptor(1, 9, 0x0483, 0x5720) + [pkt(1, 9, 0x01, 0, cbw(20)), pkt(1, 9, 0x01, 0, r1), pkt(1, 9, 0x81, 1, a1)])]
    d = U.from_pcap(pcap(p + q))
    ok(len([r for r in kinds(d, 'tg') if r['link'] == 'usb:0483:5720@USBPcap1.9']) == 2, 'after a replug (new address, new descriptor) it is followed on')


def t_damaged():
    p, (r1, a1, *_) = main_capture()
    data = pcap(p)
    last = U.from_pcap(data[:-5])
    ok(any(r['kind'] == 'err' and 'ends inside a packet' in r['error'] for r in last), 'a file cut inside a packet says so')
    # the capture stops between the two halves of the split reply (packet 20 = its first half)
    r = U.from_pcap(pcap(p[:21]))
    tgs = kinds(r, 'tg')
    ok(tgs and tgs[-1]['dir'] == 'tx' and any(x['kind'] == 'err' and 'ends inside a block' in x['error'] for x in r) and kinds(r, 'junk'),
       'a capture ending between the two halves of a reply: the half is junk + an err (%d tg)' % len(tgs))
    # snap length: the packet says 64 B of data, the file holds 30
    s = pcap(p[:4] + [(T0 + 1, pkt(*NOVA, 0x01, 0, cbw(20))), (T0 + 1.001, pkt(*NOVA, 0x01, 0, r1)), (T0 + 1.002, pkt(*NOVA, 0x81, 1, a1[:10], n=len(a1)))])
    sr = U.from_pcap(s)
    ok(any(x['kind'] == 'err' and 'cut short in the capture (10 of 22 bytes' in x['error'] for x in sr), 'a transfer cut by the snap length is an err')
    # a piece cut off by a new block: junk, then the new frame
    j = pcap(p[:4] + [(T0 + 1, pkt(*NOVA, 0x81, 1, a1[:7])), (T0 + 1.1, pkt(*NOVA, 0x81, 1, a1))])
    jr = U.from_pcap(j)
    ok([x['kind'] for x in jr if x['kind'] in ('junk', 'tg')] == ['junk', 'tg'] and 'cut off' in kinds(jr, 'junk')[0].get('note', ''), 'a half frame followed by a new one: junk (cut off), then the frame')
    try: U.from_pcap(b'not a capture at all, sorry'); bad = False
    except ValueError: bad = True
    ok(bad, 'not a capture -> ValueError')


def t_import():
    p, _ = main_capture()
    data = pcap(p)
    r = U.import_pcap('novalct usb.pcap', data)
    ok(r['ok'] and r['kinds'].get('tg') == 6 and r['nwl'].endswith('.nwl') and '/vendor/captures/' in '/' + r['nwl'], 'import_pcap -> vendor/captures/ .nwl: %s' % r['nwl'])
    orig = os.path.join(os.environ['OPENNOVA_DIAG'], *r['original'].split('/'))
    ok(open(orig, 'rb').read() == data, 'the original capture is kept next to it, unchanged')
    lines = [json.loads(x) for x in open(os.path.join(os.environ['OPENNOVA_DIAG'], *r['nwl'].split('/')), encoding='utf-8')]
    ok(lines[0]['kind'] == 'mark' and 'Imported USB capture' in lines[0]['text'] and len(lines) == r['total'] + 1, 'the .nwl opens like the recorder’s (a header mark + %d records)' % r['total'])
    ok(wirelog.upgrade(lines[1:]) is not None, 'the records pass the recorder’s loader')


def t_detect_parsers():
    ifs = 'interface {value=\\\\.\\USBPcap1}{display=USBPcap1}\ninterface {value=\\\\.\\USBPcap2}{display=USBPcap2}\n'
    ok(U.parse_interfaces(ifs) == ['\\\\.\\USBPcap1', '\\\\.\\USBPcap2'], 'extcap interfaces parsed')
    cfg = ('arg {number=0}{call=--snaplen}{display=Snapshot length}{tooltip=Snapshot length}{type=unsigned}{default=65535}\n'
           'value {arg=99}{value=1}{display=[1] Generic USB Hub}{enabled=true}\n'
           'value {arg=99}{value=5}{display=[5] Nova ProHD}{enabled=true}{parent=1}\n'
           'value {arg=99}{value=6}{display=[6] USB Composite Device}{enabled=true}{parent=1}\n'
           'value {arg=99}{value=6_1}{display=USB Input Device}{enabled=false}{parent=6}\n')
    dv = U.parse_config(cfg)
    ok([(d['addr'], d['name'], d['node']) for d in dv] == [(1, 'Generic USB Hub', False), (5, 'Nova ProHD', False), (6, 'USB Composite Device', False), (6, 'USB Input Device', True)],
       'extcap config (the devices on a hub) parsed')
    n = U.find_nova([{'hub': '\\\\.\\USBPcap1', 'devices': []}, {'hub': '\\\\.\\USBPcap2', 'devices': dv}])
    ok(n == {'hub': '\\\\.\\USBPcap2', 'bus': 2, 'addr': 5, 'name': 'Nova ProHD'}, 'the NovaStar device found by its name: %s' % n)
    ok(U.find_nova([{'hub': 'x', 'devices': dv[2:]}]) is None, 'no NovaStar device -> None')
    ok(U.hub_path('2') == U.hub_path('USBPcap2') == U.hub_path('\\\\.\\USBPcap2') == '\\\\.\\USBPcap2', 'hub names normalised')
    S = U.state_of
    ok(S({}, '', [])[0] == 'not-installed', 'state: not installed')
    ok(S({'service': True, 'filter': True, 'uninstall': True}, 'c', [])[0] == 'reboot', 'state: installed, no capture device yet -> restart')
    ok(S({'service': True, 'filter': True, 'pendingRemoval': True}, 'c', ['h'])[0] == 'reboot', 'state: being removed -> restart')
    ok(S({'service': True, 'filter': True}, '', ['h'])[0] == 'no-cmd', 'state: driver without USBPcapCMD')
    ok(S({'service': True, 'filter': True, 'uninstall': True}, 'c', ['h'])[0] == 'ready', 'state: ready')
    t0 = time.time(); d = U.detect(); dt = time.time() - t0
    ok(d['ok'] and d['state'] in ('unsupported', 'not-installed', 'reboot', 'no-cmd', 'ready') and dt < 3, 'detect() here: %s in %.2f s — %s' % (d['state'], dt, d['say']))
    t0 = time.time(); [U.detect() for _ in range(5)]; dt5 = (time.time() - t0) / 5
    ok(dt5 < 1.0, 'detect() again (cached): %.3f s each' % dt5)


def t_install_checks():
    r = U.install()
    if not U.IS_WIN:
        ok(not r['ok'] and 'Windows' in r['error'], 'install off Windows: says Windows only'); return
    if U.detect()['state'] != 'not-installed':
        print('SKIP install checks (USBPcap is installed on this computer)'); return
    ok(not r['ok'] and U.USBPCAP['home'] in r['error'] and not U.install_status()['running'], 'no bundled installer: says where to get it, starts nothing')
    fake = os.path.join(TMP, U.USBPCAP['file']); open(fake, 'wb').write(b'MZ not the real one')
    os.environ['OPENNOVA_USBPCAP_SETUP'] = fake
    try: r = U.install()
    finally: os.environ.pop('OPENNOVA_USBPCAP_SETUP', None)
    ok(not r['ok'] and 'SHA-256 differs' in r['error'] and not U.install_status()['running'], 'a file that isn’t the pinned installer is never started')


def t_pin():
    P, root = U.USBPCAP, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    import re
    ok(all(re.match(r'^[0-9a-f]{64}$', P[k]) for k in ('sha256', 'sourceSha256')) and P['url'].endswith('/' + P['file']) and P['path'] == 'usb-capture/' + P['file']
       and P['version'] in P['url'] and P['sourcePath'].startswith('usb-capture/') and P['sourceUrl'].endswith(P['sourcePath'].split('/')[-1]),
       'tools/usbpcap.json: one version, URL, path and SHA-256s that fit together (%s)' % P['version'])
    lic = [x for x in P['licenses'] if not os.path.isfile(os.path.join(root, *x.split('/')))]
    ok(not lic and b'GNU GENERAL PUBLIC LICENSE' in open(os.path.join(root, 'licenses', 'USBPcap-GPL-2.0.txt'), 'rb').read()
       and b'Tomasz Mon' in open(os.path.join(root, 'licenses', 'USBPcap-BSD-2-Clause.txt'), 'rb').read(), 'USBPcap’s licence texts are in licenses/')


STANDIN = r'''
import os, struct, sys, time
a = sys.argv[1:]
cnt = os.environ['STANDIN_COUNT']
if '--extcap-version' in a: print('extcap {version=1.5.4.0}{help=http://desowin.org/usbpcap/}'); sys.exit(0)
if '--extcap-interfaces' in a: print('interface {value=\\\\.\\USBPcap1}{display=USBPcap1}'); sys.exit(0)
if '--extcap-config' in a: print('value {arg=99}{value=5}{display=[5] Nova ProHD}{enabled=true}'); sys.exit(0)
with open(cnt, 'a') as f: f.write(' '.join(a) + '\n')
if os.environ.get('STANDIN_REFUSE'): sys.stderr.write('Failed to create worker process!\n'); sys.exit(0)
data = open(os.environ['STANDIN_PCAP'], 'rb').read()
o = sys.stdout.buffer
o.write(data[:24]); o.flush()
i = 24
while i < len(data):
    s, us, cap, orig = struct.unpack_from('<IIII', data, i)
    o.write(data[i:i + 16 + cap]); o.flush(); i += 16 + cap
    time.sleep(0.01)
end = time.time() + 30                       # then wait to be stopped (never longer than 30 s)
while time.time() < end: time.sleep(0.1)
'''


def t_live():
    p, _ = main_capture()
    sp = os.path.join(TMP, 'standin_usbpcapcmd.py'); open(sp, 'w', encoding='utf-8').write(STANDIN)
    src = os.path.join(TMP, 'src.pcap'); open(src, 'wb').write(pcap(p))
    cnt = os.path.join(TMP, 'launches.txt'); open(cnt, 'w').close()
    os.environ.update(OPENNOVA_USBPCAPCMD=sp, STANDIN_PCAP=src, STANDIN_COUNT=cnt)
    launches = lambda: len([x for x in open(cnt).read().split('\n') if x])
    try:
        U._cache.update(hubs=None, novaT=0)
        d = U.detect(refresh=True)
        ok(d['state'] == 'ready' and d['nova'] and d['nova']['addr'] == 5 and d['nova']['bus'] == 1 and d['version'] == '1.5.4.0', 'detect with the stand-in: the device on USBPcap1, address 5')
        r = U.start()
        ok(not r['ok'] and r['state'] == 'needs-consent' and launches() == 0, 'start without the tester’s OK: needs-consent, no USBPcapCMD (no UAC prompt)')
        r = U.start(consent=True)
        ok(r['ok'] and r['state'] in ('waiting', 'capturing') and launches() == 1, 'start with consent: %s' % r['state'])
        args = open(cnt).read().split()
        ok(args[:4] == ['-d', '\\\\.\\USBPcap1', '-o', '-'] and '--devices' in args and args[args.index('--devices') + 1] == '5' and '--inject-descriptors' in args
           and '--capture-from-new-devices' in args, 'USBPcapCMD asked for the device’s hub + address, piping to the helper: %s' % ' '.join(args))
        r2 = U.start(consent=True)
        ok(r2['ok'] and r2.get('already') and launches() == 1, 'start again while running: ok, the same capture (idempotent)')
        end = time.time() + 10
        while time.time() < end and U.status()['frames'] < 7: time.sleep(0.1)
        s = U.status()
        ok(s['state'] == 'capturing' and s['frames'] >= 7 and s['novaSeen'] and s['startSeconds'] is not None, 'live: %d frames counted while it runs, started after %s s' % (s['frames'], s['startSeconds']))
        x = U.stop()
        ok(x['ok'] and x['state'] == 'stopped' and x['kinds'].get('tg') == 6 and x['original'].endswith('_usb.pcap'), 'stop: the .pcap decoded next to it (%s)' % x.get('nwl'))
        pf = os.path.join(os.environ['OPENNOVA_DIAG'], *x['original'].split('/'))
        ok(open(pf, 'rb').read() == pcap(p), 'the .pcap the helper wrote is byte for byte what USBPcapCMD sent')
        y = U.stop()
        ok(y['ok'] and y['state'] == 'idle', 'stop again: idle, no error')
        os.environ['STANDIN_REFUSE'] = '1'
        r = U.start(consent=True)
        if r['state'] in ('waiting',):              # a slow machine: the stand-in hasn't answered within start's wait
            end = time.time() + 5
            while time.time() < end and U.status()['running']: time.sleep(0.1)
            r = dict(r, state=U.status()['state'])
        ok(not r['ok'] if r['state'] == 'refused' else False, 'the UAC prompt answered No: refused (%s)' % r.get('say'))
        n = launches()
        r = U.start(consent=True)
        ok(r['state'] == 'refused' and launches() == n, 'after a refusal: no new prompt this session')
        r = U.start(consent=True, retry=True)
        time.sleep(0.5)
        ok(launches() == n + 1, 'retry=True (the tester asks again): one new try')
        U.stop()
    finally:
        for k in ('OPENNOVA_USBPCAPCMD', 'STANDIN_PCAP', 'STANDIN_COUNT', 'STANDIN_REFUSE'): os.environ.pop(k, None)
        U._atexit()


if __name__ == '__main__':
    for t in (t_decode, t_identify, t_damaged, t_import, t_detect_parsers, t_pin, t_install_checks, t_live):
        try: t()
        except Exception as e:  # noqa: BLE001
            import traceback; traceback.print_exc(); ok(False, '%s raised %s' % (t.__name__, e))
    print('\n%d failed' % len(fails) if fails else '\nAll passed')
    sys.exit(1 if fails else 0)
