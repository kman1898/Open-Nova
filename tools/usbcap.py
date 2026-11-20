"""usbcap.py - Tools ▸ Vendor apps ▸ USB capture: record what NovaLCT sends to and gets from a USB-only controller (NovaPro HD:
NovaStar's own USB device 0483:5720, docs/USB_NOVA_DEVICE.md) without taking the device, the way Wireshark does on Windows.
Stdlib only. Docs: docs/USB_CAPTURE.md.

User, 2026-11-16: "same way wireshark works" — NovaLCT keeps the device and uses USB as normal, Open Nova only watches.

How: USBPcap (github.com/desowin/usbpcap, the capture driver Wireshark's Windows installer offers) sits under every USB root
hub as a filter driver; its USBPcapCMD.exe writes what it sees as a .pcap (link type 249, LINKTYPE_USBPCAP). Its capture
device only lets administrators start a capture, so USBPcapCMD (run by the helper as the user) starts an elevated copy of
itself through ShellExecute "runas" — the tester's one UAC prompt — which pipes the capture back; the helper writes it to
diagnostics/<day>/vendor/captures/<time>_usb.pcap as it comes, counts frames live, and on Stop decodes it into a .nwl next to
it (the recorder's format: Tools ▸ Diagnostics opens it). Nothing here ever runs elevated itself and nothing is sent to a
device: USBPcap only reads.

  USBPCAP                  the pinned installer (version, URL, SHA-256, signer) + its source and licences: the one place
                           tools/make_package.py and tools/smoke_package.py read it from
  detect(devices, refresh) read-only, cheap enough to poll: is USBPcap installed / active (or does it need a restart),
                           USBPcapCMD's path, the root hubs and which one has the NovaStar device (and its address; the
                           slower walk is cached: find_device), whether capture needs elevation
  nova_present()           is the NovaStar device plugged in now (cfgmgr32, no process)
  install() / install_status()   runs the bundled official installer through ShellExecute "runas" (UAC + USBPcap's own
                           installer pages, never silent), then detects again and says whether a restart is needed
  start(hub, addr, consent=, retry=) / status() / stop()   the live capture; for code too: idempotent, a state instead of
                           an exception, and no UAC prompt without consent (the tester's one "Allow USB recording")
  from_pcap(path or bytes, hint) -> records   a USBPcap .pcap / .pcapng -> the NovaStar device's TG frames (wrappers as
                           'usb' notes), like wirelog.from_capture does for TCP
  import_pcap(name, bytes) the same into vendor/captures/ (original kept) — Add capture… with a USB capture
  is_usbpcap(bytes)        is this a USBPcap capture (for the import dispatch)
  handle(path, body)       /api/hw/vendor/usb-* (vendortap.handle passes them on)
"""
import collections
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import threading
import time

import wirelog

IS_WIN = sys.platform == 'win32'
NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOVA_VID, NOVA_PID = 0x0483, 0x5720
LT_USBPCAP = 249

# ------------------------------------------------------------------ the pinned USBPcap: tools/usbpcap.json (one place)
# 1.5.4.0 = the latest release (2020-05-22) and the one Wireshark's own Windows build pins (same SHA-256). Authenticode-signed
# by "Tomasz Moń" (Certum Code Signing CA SHA2), timestamped (checked 2026-11-16). Driver GPL-2.0, USBPcapCMD BSD-2-Clause.
with open(os.path.join(NOVA, 'tools', 'usbpcap.json'), encoding='utf-8') as _f: USBPCAP = json.load(_f)
SNAPLEN = 131072                       # a whole TG reply (20 + 65535 B) fits; USBPcapCMD's default is 65535
USBD_CANCELED = 0xC0010000             # an IN read that timed out (NovaLCT reads with 1000 ms timeouts)
USB_CLASS_KEY = r'SYSTEM\CurrentControlSet\Control\Class\{36FC9E60-C465-11CF-8056-444553540000}'
NAMES = ('Nova ProHD', 'NovaStar MTP')  # the device's names (NovaLCT's driver INF / the device's own product string)
_lock = threading.Lock()


def _vt():
    import vendortap   # late: vendortap is the bigger module; usbcap only needs its folder / run helpers
    return vendortap


# ------------------------------------------------------------------ USBPcap .pcap / .pcapng (pure: unit-tested)
HDR = struct.Struct('<HQIHBHHBBI')     # USBPCAP_BUFFER_PACKET_HEADER (27 B, packed, LE): headerLen irpId status function info bus device endpoint transfer dataLength


def usb_header(p):
    """A USBPcap packet -> dict (len, irp, status, function, info, bus, dev, ep, transfer, n, stage, data, cut) or None."""
    if len(p) < HDR.size: return None
    hl, irp, st, fn, info, bus, dev, ep, tr, n = HDR.unpack_from(p, 0)
    if hl < HDR.size or hl > len(p): return None
    data = p[hl:hl + n]
    return {'len': hl, 'irp': irp, 'status': st, 'function': fn, 'info': info, 'bus': bus, 'dev': dev, 'ep': ep, 'transfer': tr, 'n': n,
            'stage': p[HDR.size] if tr == 2 and hl > HDR.size else None, 'data': data, 'cut': n - len(data)}


class PcapStream:
    """A classic .pcap as it arrives (USBPcapCMD writes one): feed(bytes) -> [(t, packet, original length)]. `rest` holds
    what is not a whole record yet; at the end of a file it is a record the capture was cut inside."""
    def __init__(self):
        self.buf, self.e, self.ns, self.lt, self.rest = b'', None, False, None, b''

    def feed(self, b):
        self.buf += b; out = []
        if self.e is None:
            if len(self.buf) < 24: return out
            m = self.buf[:4]
            if m not in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\xc3\xd4', b'\xa1\xb2\x3c\x4d'): raise ValueError('not a .pcap file')
            self.e = '<' if m[0] in (0xd4, 0x4d) else '>'; self.ns = m in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
            self.lt = struct.unpack_from(self.e + 'I', self.buf, 20)[0] & 0x0FFFFFFF; self.buf = self.buf[24:]
        o = 0
        while len(self.buf) - o >= 16:
            s, us, cap, orig = struct.unpack_from(self.e + 'IIII', self.buf, o)
            if len(self.buf) - o - 16 < cap: break
            out.append((s + us / (1e9 if self.ns else 1e6), self.buf[o + 16:o + 16 + cap], orig)); o += 16 + cap
        self.buf = self.buf[o:]; self.rest = self.buf
        return out


def packets(buf):
    """(t, link type, packet, original length) of a .pcap / .pcapng, and how many bytes the file was cut short inside a
    record (classic .pcap; a cut .pcapng block is dropped by wirelog's reader)."""
    if buf[:4] == b'\x0a\x0d\x0d\x0a':
        return [(t, lt, p, None) for t, lt, p in wirelog._packets(buf)], 0
    ps = PcapStream()
    out = [(t, ps.lt, p, orig) for t, p, orig in ps.feed(buf)]
    return out, len(ps.rest)


def is_usbpcap(buf):
    """Is this a capture whose (first) link type is USBPcap's 249?"""
    try:
        if buf[:4] == b'\x0a\x0d\x0d\x0a':
            for _, lt, _ in wirelog._packets(buf): return lt == LT_USBPCAP
            o, e = 0, '<'
            while o + 12 <= len(buf):            # no packet yet: the interface block says
                if buf[o:o + 4] == b'\x0a\x0d\x0d\x0a': e = '<' if buf[o + 8:o + 12] == b'\x4d\x3c\x2b\x1a' else '>'
                bt, bl = struct.unpack_from(e + 'II', buf, o)
                if bt == 1: return struct.unpack_from(e + 'H', buf, o + 8)[0] == LT_USBPCAP
                if bl < 12: return False
                o += bl
            return False
        ps = PcapStream(); ps.feed(buf[:24])
        return ps.lt == LT_USBPCAP
    except (ValueError, struct.error):
        return False


# ------------------------------------------------------------------ the NovaStar device's bulk traffic -> records
def _blocks(b):
    """Bytes of one direction -> ([(kind, bytes)], rest): kind 'USBC' (31 B) / 'USBS' (13 B) / 'frame' (a TG frame whose
    checksum is right) / 'junk'; rest = a block that isn't whole yet (it may go on in the next transfer)."""
    out, i, j0 = [], 0, 0
    def cand(k): return min([x for x in (b.find(b'\x55\xAA', k), b.find(b'\xAA\x55', k), b.find(b'USBC', k), b.find(b'USBS', k)) if x >= 0], default=-1)
    while i < len(b):
        h, n = b[i:i + 4], len(b) - i
        size = 31 if h == b'USBC' else 13 if h == b'USBS' else None
        if size is None and b[i:i + 2] in (b'\x55\xAA', b'\xAA\x55'):
            size = 20 + wirelog.frame_data_len(b[i:i + 20]) if n >= 20 else 20
        if size is None and n < 4 and any(x.startswith(b[i:]) for x in (b'USBC', b'USBS')): size = 4
        if size is not None:
            if n < size:                                   # not whole yet
                if i > j0: out.append(('junk', b[j0:i]))
                return out, b[i:]
            blk = b[i:i + size]
            good = h in (b'USBC', b'USBS') or struct.unpack_from('<H', blk, size - 2)[0] == (0x5555 + sum(blk[2:size - 2])) & 0xFFFF
            if good:
                if i > j0: out.append(('junk', b[j0:i]))
                out.append((h.decode() if h in (b'USBC', b'USBS') else 'frame', blk)); i = j0 = i + size; continue
        k = cand(i + 1); i = len(b) if k < 0 else k
    if j0 < len(b): out.append(('junk', b[j0:]))
    return out, b''


def _starts_block(d):
    return d[:4] in (b'USBC', b'USBS') or d[:2] in (b'\x55\xAA', b'\xAA\x55')


class Decoder:
    """USBPcap packets -> the recorder's records for NovaStar's USB device: OUT = tx, IN = rx; TG frames named like the rest of
    Diagnostics (wirelog.decode / summary), USBC / USBS wrapper blocks and empty packets as 'usb' notes, stray bytes 'junk',
    failed transfers 'err'. Other devices, control transfers and NovaLCT's timed-out reads stay out (counted in stats).
    The device: its device descriptor in the capture (0483:5720; USBPcapCMD --inject-descriptors puts the connected ones at
    the start), else hint = (USBPcap root hub number, address) from the capture's start, else its traffic (NovaLCT's 31-byte
    USBC blocks going out: CB length 16, CB[0] A2 / A3, CB[7] 1 — a bare TG frame isn't enough, any device could send 55 AA)."""
    def __init__(self, hint=None):
        self.out, self.devs, self.streams, self.sent, self.pend = [], {}, {}, {}, {}
        self.hint = tuple(hint) if hint else None
        self.held = collections.defaultdict(list)          # packets of a device nothing has identified yet
        self.stats = collections.Counter()
        self.others = set()

    def _rec(self, t, kind, **f):
        r = {'seq': len(self.out) + 1, 't': round(t, 6), 'kind': kind}; r.update(f); self.out.append(r); return r

    def _nova(self, key, t, why):
        self.devs[key] = (NOVA_VID, NOVA_PID, why)
        self._rec(t, 'mark', source='usbcap', text='NovaStar USB device 0483:5720 on USBPcap%d, address %d (%s)' % (key[0], key[1], why))

    def packet(self, t, p, orig=None):
        h = usb_header(p)
        if h is None: self.stats['notUsb'] += 1; return
        self.stats['packets'] += 1
        key = (h['bus'], h['dev'])
        if h['transfer'] == 2:                             # control: only to learn who is who (device descriptors)
            self.stats['control'] += 1
            d = h['data']
            if h['info'] & 1 and len(d) >= 12 and d[0] == 18 and d[1] == 1:
                vid, pid = struct.unpack_from('<HH', d, 8)
                if (vid, pid) == (NOVA_VID, NOVA_PID):
                    if self.devs.get(key, (0, 0))[:2] != (NOVA_VID, NOVA_PID): self._nova(key, t, 'its device descriptor')
                    for q in self.held.pop(key, []): self._bulk(*q)
                else:
                    self.devs[key] = (vid, pid, 'descriptor'); self.held.pop(key, None)
            return
        if h['transfer'] != 3: self.stats['otherTransfers'] += 1; return
        v = self.devs.get(key)
        if v is None and self.hint == key: self._nova(key, t, 'the address the capture started with'); v = self.devs[key]
        if v is None:                                      # not known yet: hold, and look at what it sends
            d = h['data']
            if not (h['ep'] & 0x80) and not h['info'] & 1 and len(d) == 31 and d[:4] == b'USBC' and d[14] == 16 and d[15] in (0xA2, 0xA3) and d[22] == 1:
                self._nova(key, self.held[key][0][0] if self.held.get(key) else t, 'its traffic: NovaLCT’s USBC blocks'); v = self.devs[key]
                for q in self.held.pop(key, []): self._bulk(*q)
            else:
                if len(self.held[key]) < 4000: self.held[key].append((t, h, orig, key))
                return
        if v[:2] != (NOVA_VID, NOVA_PID): self.others.add(key); self.stats['otherDevice'] += 1; return
        self._bulk(t, h, orig, key)

    def _bulk(self, t, h, orig, key):
        link = 'usb:0483:5720@USBPcap%d.%d' % key
        ep, done, d = h['ep'], h['info'] & 1, h['data']
        self.stats['bulk'] += 1
        if h['cut'] or (orig is not None and orig > HDR.size and orig - h['len'] > len(d)):
            self.stats['cut'] += 1
            self._rec(t, 'err', link=link, error='a USB transfer was cut short in the capture (%d of %d bytes kept)' % (len(d), h['n']))
        if not ep & 0x80:                                  # OUT: data on the way down, the result on the way back
            if done:
                if h['status']: self._rec(t, 'err', link=link, error='USB write failed: status 0x%08X' % h['status'], ep='0x%02X' % ep)
                return
            if not h['n']: self._rec(t, 'usb', link=link, dir='tx', hex='', n=0, what='empty packet', ep='0x%02X' % ep); return
            self._feed(t, key, ep, d, 'tx', link)
            return
        if not done: return                                # an IN read asked for: its data comes with the completion
        if h['status']:
            if h['status'] == USBD_CANCELED and not d: self.stats['inTimeouts'] += 1; return
            self._rec(t, 'err', link=link, error='USB read failed: status 0x%08X' % h['status'], ep='0x%02X' % ep)
            if not d: return
        if d: self._feed(t, key, ep, d, 'rx', link)

    def _feed(self, t, key, ep, d, direction, link):
        s = self.streams.setdefault(key + (ep,), {'buf': b'', 'link': link, 'dir': direction, 't': t})
        if s['buf'] and _starts_block(d):                  # a piece waiting, and this transfer starts a block of its own
            items, rest = _blocks(s['buf'] + d)
            if not (items and items[0][0] != 'junk' and len(items[0][1]) > len(s['buf'])):
                self._rec(s['t'], 'junk', link=link, hex=s['buf'].hex(), n=len(s['buf']), note='cut off: the next transfer started a new block')
                s['buf'] = b''
        if not s['buf']: s['t'] = t
        items, s['buf'] = _blocks(s['buf'] + d)
        for kind, b in items: self._item(t, kind, b, direction, link, '0x%02X' % ep)

    def _item(self, t, kind, b, direction, link, ep):
        if kind == 'junk':
            self._rec(t, 'junk', link=link, hex=b.hex(), n=len(b), dir=direction, ep=ep); return
        if kind in ('USBC', 'USBS'):
            f = {'link': link, 'dir': direction, 'hex': b.hex(), 'n': len(b), 'what': kind, 'ep': ep}
            if kind == 'USBC':
                tag, n = struct.unpack_from('<II', b, 4); f.update(tag=tag, len=n, read=bool(b[12] & 0x80), cb='%02X' % b[15])
                f['note'] = {0xA2: 'write block: a TG frame follows', 0xA3: 'read block: send the reply'}.get(b[15], 'block')
            else:
                tag, residue, status = struct.unpack_from('<IIB', b, 4); f.update(tag=tag, residue=residue, status=status)
            self._rec(t, 'usb', **f); return
        self.stats['frames'] += 1
        if b[0] == 0x55 and direction == 'rx':             # our request coming back
            r = self._rec(t, 'echo', **wirelog._echo_rec(link, b, self.sent.get(link, ()))); r['ep'] = ep; return
        p = wirelog.decode(b)
        r = self._rec(t, 'tg', link=link, dir=direction, hex=b.hex(), ep=ep)
        if p:
            r['d'] = p[0]; r['sum'] = wirelog.summary(*p)
            k = (link, p[0]['serial'])
            if direction == 'tx': self.pend[k] = t
            elif k in self.pend: r['rtt'] = round((t - self.pend.pop(k)) * 1000, 2)
        if direction == 'tx': self.sent.setdefault(link, collections.deque(maxlen=wirelog.SENT_KEEP)).append((r['seq'], b))

    def finish(self, t=None, cut=0):
        """The end of the capture: pieces still waiting are junk; a file cut inside a record is said."""
        for s in self.streams.values():
            if s['buf']:
                self._rec(s['t'], 'err', link=s['link'], error='the capture ends inside a block (%d bytes of it kept as junk)' % len(s['buf']))
                self._rec(s['t'], 'junk', link=s['link'], hex=s['buf'].hex(), n=len(s['buf']), dir=s['dir'], note='the capture ends here'); s['buf'] = b''
        if cut:
            self._rec(t if t is not None else (self.out[-1]['t'] if self.out else time.time()), 'err', link='usbcap',
                      error='the capture file ends inside a packet (%d bytes): it was cut short' % cut)
        self.stats['otherDevices'] = len(self.others) + len([k for k in self.held if k not in self.devs])
        self.held.clear()
        return self.out


def from_pcap(src, hint=None):
    """A USBPcap capture (path or bytes; .pcap or .pcapng, link type 249) -> records like the recorder's, for NovaStar's USB
    device only (Decoder). ValueError: not a capture / no USBPcap packets in it."""
    buf = src if isinstance(src, (bytes, bytearray)) else open(src, 'rb').read()
    pk, cut = packets(bytes(buf))
    dec, last, n = Decoder(hint), None, 0
    for t, lt, p, orig in pk:
        if lt != LT_USBPCAP: continue
        n += 1; last = t
        dec.packet(t, p, orig)
    if not n and not cut: raise ValueError('no USBPcap (link type 249) packets in it')
    return dec.finish(last, cut)


def _summary(recs):
    k = collections.Counter(r['kind'] for r in recs)
    return dict(k)


def import_pcap(name, data, keep_original=True, original_path=None, hint=None):
    """A USBPcap capture -> vendor/captures/<time>_<name>.nwl (+ the original next to it, unchanged), like
    vendortap.import_capture does for TCP. -> {ok, nwl, parts, original, total, kinds, links}"""
    vt = _vt()
    if len(data) > vt.IMPORT_MAX: return {'ok': False, 'error': 'that capture is over %d MB' % (vt.IMPORT_MAX >> 20)}
    recs = from_pcap(data, hint)                           # ValueError: not one
    d = os.path.dirname(original_path) if original_path and not keep_original else vt.vendor_dir('captures')
    base = os.path.splitext(os.path.basename(original_path))[0] if original_path and not keep_original else \
        time.strftime('%H%M%S_') + vt._safe(os.path.splitext(os.path.basename(str(name or 'usb')))[0], 50)   # a live capture: next to its .pcap, same name
    orig = original_path
    if keep_original:
        orig = os.path.join(d, base + ('.pcapng' if data[:4] == b'\x0a\x0d\x0d\x0a' else '.pcap'))
        with open(orig, 'wb') as f: f.write(data)
    nova = [r for r in recs if r['kind'] in ('tg', 'echo', 'usb')]
    head = {'seq': 0, 't': recs[0]['t'] if recs else time.time(), 'kind': 'mark', 'source': 'vendor',
            'text': 'Imported USB capture %s (%d bytes, %d records%s)' % (os.path.basename(str(name)), len(data), len(recs),
                                                                         '' if nova else ': no NovaStar USB traffic in it')}
    parts, f, n, links = [], None, 0, collections.Counter()
    try:
        for r in [head] + recs:                            # parts of 12 MB, so each fits in a problem report
            if f is None or n > vt.TAPE_ROTATE:
                if f: f.close()
                parts.append(os.path.join(d, base + ('' if not parts else '_%d' % (len(parts) + 1)) + '.nwl'))
                f, n = open(parts[-1], 'w', encoding='utf-8', newline='\n'), 0
            line = json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n'
            f.write(line); n += len(line)
            if r.get('link'): links[r['link']] += 1
    finally:
        if f: f.close()
    wirelog.mark('USB capture imported: %s -> %s (%d records)' % (name, vt._rel(parts[0]), len(recs)), source='vendor')
    return {'ok': True, 'nwl': vt._rel(parts[0]), 'parts': [vt._rel(p) for p in parts], 'original': vt._rel(orig) if orig else '',
            'total': len(recs), 'kinds': _summary(recs), 'links': dict(links.most_common(12)), 'usb': True}


# ------------------------------------------------------------------ is USBPcap here? (read-only)
def parse_interfaces(text):
    """USBPcapCMD --extcap-interfaces -> ['\\\\.\\USBPcap1', …]"""
    return re.findall(r'^interface \{value=([^}]+)\}', text or '', re.M)


def parse_config(text):
    """USBPcapCMD --extcap-config --extcap-interface H -> the devices on that root hub: [{addr, name, parent, node}]
    ('node' = a function of a composite device, under its device's address)."""
    out = []
    for m in re.finditer(r'^value \{arg=\d+\}\{value=([0-9_]+)\}\{display=([^}]*)\}\{enabled=(\w+)\}(?:\{parent=([0-9_]+)\})?', text or '', re.M):
        v, disp, _, par = m.groups()
        a = v.split('_')
        out.append({'addr': int(a[0]), 'node': len(a) > 1, 'name': re.sub(r'^\[\d+\] ', '', disp), 'parent': par or ''})
    return out


def find_nova(hubs, names=NAMES):
    """[{hub, devices}] -> {hub, bus, addr, name} of the first device whose name is one of the NovaStar device's, or None."""
    low = [n.lower() for n in names if n]
    for h in hubs:
        for d in h['devices']:
            if not d['node'] and d['name'].lower() in low:
                return {'hub': h['hub'], 'bus': hub_number(h['hub']), 'addr': d['addr'], 'name': d['name']}
    return None


def hub_number(hub):
    m = re.search(r'(\d+)\s*$', str(hub or ''))
    return int(m.group(1)) if m else None


def hub_path(hub):
    """'1' / 'USBPcap1' / '\\\\.\\USBPcap1' -> '\\\\.\\USBPcap1'"""
    n = hub_number(hub)
    return '\\\\.\\USBPcap%d' % n if n is not None else ''


def state_of(inst, cmd, hubs, admin=False):
    """(state, what to say). inst: {service, filter, uninstall, pendingRemoval}."""
    if inst.get('pendingRemoval'):
        return 'reboot', 'USBPcap is being removed: restart the computer, then install it again.'
    if not (inst.get('service') or inst.get('filter') or inst.get('uninstall')):
        return 'not-installed', 'USB capture needs USBPcap (free and open source; the USB capture driver Wireshark uses). Install it once: Windows asks for permission, then restart the computer.'
    if not cmd:
        return 'no-cmd', 'USBPcap’s driver is here but USBPcapCMD.exe isn’t: install USBPcap again (or Wireshark with “Install USBPcap” ticked).'
    if not (inst.get('service') and inst.get('filter')) or not hubs:
        return 'reboot', 'USBPcap is installed but not active yet: restart the computer once, then USB capture works.'
    return 'ready', 'Ready. ' + ('' if admin else 'Start asks Windows for permission once (USBPcap only lets administrators capture).')


def _reg(path, value=None):
    """HKLM value (or True when only the key is asked for and it exists); None when missing."""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | getattr(winreg, 'KEY_WOW64_64KEY', 0)) as k:
            return winreg.QueryValueEx(k, value)[0] if value else True
    except OSError:
        return None


def installed():
    """What Windows says about USBPcap (registry only)."""
    if not IS_WIN: return {}
    svc = 'SYSTEM\\CurrentControlSet\\Services\\USBPcap'
    up = _reg(USB_CLASS_KEY, 'UpperFilters') or []
    un = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\USBPcap'
    return {'service': bool(_reg(svc)), 'filter': any(str(x).lower() == 'usbpcap' for x in (up if isinstance(up, list) else [up])),
            'uninstall': bool(_reg(un)), 'version': _reg(un, 'DisplayVersion') or '', 'uninstallString': _reg(un, 'UninstallString') or '',
            'pendingRemoval': _reg(svc, 'DeleteFlag') is not None}


def cmd_path(inst=None):
    """USBPcapCMD.exe: USBPcap's own folder, else Wireshark's extcap folder ('' = not here). OPENNOVA_USBPCAPCMD = a stand-in (tests)."""
    env = os.environ.get('OPENNOVA_USBPCAPCMD')
    if env: return env
    if not IS_WIN: return ''
    c = []
    u = (inst or {}).get('uninstallString', '').strip('"')
    if u: c.append(os.path.join(os.path.dirname(u), 'USBPcapCMD.exe'))
    for pf in (os.environ.get('ProgramW6432'), os.environ.get('ProgramFiles'), os.environ.get('ProgramFiles(x86)')):
        if pf: c += [os.path.join(pf, 'USBPcap', 'USBPcapCMD.exe'), os.path.join(pf, 'Wireshark', 'extcap', 'USBPcapCMD.exe'),
                     os.path.join(pf, 'Wireshark', 'extcap', 'wireshark', 'USBPcapCMD.exe')]
    return next((p for p in c if os.path.isfile(p)), '')


def _cmd(path):
    return [sys.executable, path] if path.endswith('.py') else [path]


def nova_names():
    """The names Windows has for the NovaStar device (its Enum entries' DeviceDesc / FriendlyName) + the known ones."""
    out = list(NAMES)
    if not IS_WIN: return out
    import winreg
    base = 'SYSTEM\\CurrentControlSet\\Enum\\USB\\VID_0483&PID_5720'
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as k:
            for i in range(64):
                try: inst = winreg.EnumKey(k, i)
                except OSError: break
                for v in ('FriendlyName', 'DeviceDesc'):
                    s = _reg(base + '\\' + inst, v)
                    if s: out.append(str(s).split(';')[-1])
    except OSError:
        pass
    return list(dict.fromkeys(out))


def is_admin():
    if not IS_WIN: return hasattr(os, 'geteuid') and os.geteuid() == 0
    try:
        import ctypes
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (OSError, AttributeError):
        return False


def bundled():
    """The official installer that came with Open Nova (the Windows package's usb-capture/), or ''.
    OPENNOVA_USBPCAP_SETUP = another copy (tests)."""
    p = os.environ.get('OPENNOVA_USBPCAP_SETUP') or os.path.join(NOVA, *USBPCAP['path'].split('/'))
    return p if os.path.isfile(p) else ''


def nova_present():
    """Is a NovaStar USB device (0483:5720) plugged in right now? Windows: its Enum entries asked through cfgmgr32
    (CM_Locate_DevNode without the phantom flag finds present devices only): a few registry reads, no process. None = can't tell."""
    if not IS_WIN or os.environ.get('OPENNOVA_USBPCAPCMD'): return None
    try:
        import ctypes
        import winreg
        cm =ctypes.WinDLL('cfgmgr32')
        base = 'SYSTEM\\CurrentControlSet\\Enum\\USB\\VID_0483&PID_5720'
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, base) as k:
            for i in range(64):
                try: inst = winreg.EnumKey(k, i)
                except OSError: break
                dn = ctypes.c_uint32()
                if cm.CM_Locate_DevNodeW(ctypes.byref(dn), ctypes.c_wchar_p('USB\\VID_0483&PID_5720\\' + inst), 0) == 0: return True
        return False
    except FileNotFoundError:
        return False                                       # never plugged in here
    except (OSError, AttributeError):
        return None


_cache = {'hubs': None, 'hubsT': 0.0, 'ver': '', 'nova': None, 'novaT': 0.0, 'present': None, 'cmd': ''}
HUBS_TTL, NOVA_TTL = 60.0, 30.0


def _hubs(cmd, refresh=False):
    """The root hubs USBPcap is on (USBPcapCMD --extcap-interfaces: one quick process; they only change with a restart)."""
    vt, now = _vt(), time.time()
    if refresh or _cache['hubs'] is None or _cache['cmd'] != cmd or now - _cache['hubsT'] > HUBS_TTL:
        _cache.update(hubs=parse_interfaces(vt._run(_cmd(cmd) + ['--extcap-interfaces'], 15)), hubsT=now, cmd=cmd,
                      ver=(re.search(r'version=([\d.]+)', vt._run(_cmd(cmd) + ['--extcap-version'], 10)) or [None, ''])[1])
    return _cache['hubs']


def find_device(cmd=None, refresh=False):
    """The slower part: which root hub (and address) has the NovaStar device -> ({hub, bus, addr, name} or None, [{hub, devices}]).
    One USBPcapCMD --extcap-config per hub (it walks that hub; no admin needed). Cached until the device comes / goes or
    NOVA_TTL passes, so detect() stays cheap."""
    cmd = cmd if cmd is not None else cmd_path(installed())
    if not cmd: return None, []
    pres, now = nova_present(), time.time()
    if not refresh and _cache['novaT'] and pres == _cache['present'] and now - _cache['novaT'] < NOVA_TTL and pres is not False:
        return _cache['nova'], _cache.get('devs', [])
    if pres is False:                                      # not plugged in: nothing to walk
        _cache.update(nova=None, novaT=now, present=pres, devs=[]); return None, []
    vt = _vt()
    devs = [{'hub': h, 'devices': parse_config(vt._run(_cmd(cmd) + ['--extcap-interface', h, '--extcap-config'], 15))} for h in _hubs(cmd, refresh)]
    nova = find_nova(devs, nova_names())
    _cache.update(nova=nova, novaT=now, present=pres, devs=devs)
    return nova, devs


def detect(devices=True, refresh=False):
    """Read-only and cheap enough to call every few seconds (registry reads, a cached hub list, cfgmgr32 for "is the device
    plugged in"; the per-hub device walk only when the device comes / goes or after NOVA_TTL; refresh=True redoes all).
    -> {ok, supported, state, say, installed, cmd, version, hubs, nova, present, admin, needsElevation, bundled, pin, capture}
    state: unsupported / not-installed / reboot / no-cmd / ready."""
    base = {'ok': True, 'platform': sys.platform, 'pin': {k: USBPCAP[k] for k in ('version', 'url', 'sha256', 'home')}, 'capture': status()}
    if not IS_WIN and not os.environ.get('OPENNOVA_USBPCAPCMD'):
        return dict(base, supported=False, state='unsupported', say='USB capture uses USBPcap, which is for Windows only (NovaLCT is Windows-only too).',
                    hubs=[], nova=None, present=None)
    inst = installed()
    cmd = cmd_path(inst)
    hubs = _hubs(cmd, refresh) if cmd else []
    adm = is_admin()
    st, say = state_of(inst, cmd, hubs, adm) if not os.environ.get('OPENNOVA_USBPCAPCMD') else ('ready', 'Ready (stand-in USBPcapCMD).')
    nova, devs = find_device(cmd, refresh) if st == 'ready' and devices else (None, [])
    pres = nova_present()
    if st == 'ready' and devices:
        say += (' NovaStar USB device: %s on USBPcap%s, address %d.' % (nova['name'], nova['bus'], nova['addr']) if nova else
                ' The NovaStar USB device isn’t on any USB port now: plug the controller in (and let NovaLCT find it), then look again.')
    return dict(base, supported=True, state=st, say=say, installed=inst, cmd=cmd, version=_cache['ver'] or inst.get('version', ''), hubs=devs or [{'hub': h, 'devices': None} for h in hubs],
                nova=nova, present=pres, admin=adm, needsElevation=not adm, bundled=bundled())


# ------------------------------------------------------------------ ShellExecute "runas" (Windows)
def _runas(exe, params, show=1):
    """Start exe elevated (Windows' UAC prompt). -> (process handle or None, Win32 error). Blocks until the prompt is answered.
    1223 (ERROR_CANCELLED) = the tester said No."""
    import ctypes
    from ctypes import wintypes as W
    class SEI(ctypes.Structure):
        _fields_ = [('cbSize', W.DWORD), ('fMask', ctypes.c_ulong), ('hwnd', W.HWND), ('lpVerb', W.LPCWSTR), ('lpFile', W.LPCWSTR),
                    ('lpParameters', W.LPCWSTR), ('lpDirectory', W.LPCWSTR), ('nShow', ctypes.c_int), ('hInstApp', W.HINSTANCE),
                    ('lpIDList', ctypes.c_void_p), ('lpClass', W.LPCWSTR), ('hkeyClass', W.HKEY), ('dwHotKey', W.DWORD),
                    ('hIconOrMonitor', W.HANDLE), ('hProcess', W.HANDLE)]
    sh = ctypes.WinDLL('shell32', use_last_error=True)
    sh.ShellExecuteExW.argtypes = [ctypes.POINTER(SEI)]; sh.ShellExecuteExW.restype = W.BOOL
    e = SEI(); e.cbSize = ctypes.sizeof(SEI); e.fMask = 0x00000040   # SEE_MASK_NOCLOSEPROCESS
    e.lpVerb, e.lpFile, e.lpParameters, e.lpDirectory, e.nShow = 'runas', exe, params, os.path.dirname(exe), show
    if not sh.ShellExecuteExW(ctypes.byref(e)): return None, ctypes.get_last_error()
    return e.hProcess, 0


def _wait_exit(h):
    """Wait for an elevated process we started (its handle) to end -> exit code (None = unknown)."""
    import ctypes
    from ctypes import wintypes as W
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]; k.GetExitCodeProcess.argtypes = [W.HANDLE, ctypes.POINTER(W.DWORD)]
    k.CloseHandle.argtypes = [W.HANDLE]
    k.WaitForSingleObject(h, 0xFFFFFFFF)
    c = W.DWORD()
    code = c.value if k.GetExitCodeProcess(h, ctypes.byref(c)) else None
    k.CloseHandle(h)
    return code


def sha256_of(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''): h.update(b)
    return h.hexdigest()


def signature(p):
    """Windows' Authenticode verdict on a file: {status, signer} ('' when PowerShell can't say)."""
    if not IS_WIN: return {'status': '', 'signer': ''}
    try:
        r = subprocess.run(['powershell', '-NoProfile', '-NonInteractive', '-Command',
                            '$s = Get-AuthenticodeSignature -LiteralPath $env:ON_SIGFILE; "$($s.Status)|$($s.SignerCertificate.Subject)"'],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, env=dict(os.environ, ON_SIGFILE=p), creationflags=0x08000000)
        st, _, subj = r.stdout.decode('utf-8', 'replace').strip().partition('|')
        m = re.search(r'CN=([^,]+)', subj)
        return {'status': st, 'signer': m.group(1).strip() if m else subj}
    except (OSError, subprocess.SubprocessError):
        return {'status': '', 'signer': ''}


_inst = {'running': False, 'result': None}


def install():
    """Install USB capture: the official USBPcap installer that came with Open Nova, checked (SHA-256 pinned above), started
    through ShellExecute "runas" — the tester sees Windows' permission prompt and USBPcap's own installer (licences, Next,
    Install). Never silent. Runs in the background; install_status() says how it went."""
    if not IS_WIN: return {'ok': False, 'error': 'USBPcap is for Windows only.'}
    with _lock:
        if _inst['running']: return {'ok': False, 'error': 'the USBPcap installer is already open'}
    d = detect()
    if d['state'] in ('ready', 'reboot', 'no-cmd') and d['installed'].get('uninstall'):
        return {'ok': False, 'error': 'USBPcap %s is already installed' % (d['installed'].get('version') or '') + (': ' + d['say'] if d['state'] != 'ready' else '.'), 'detect': d}
    p = bundled()
    if not p:
        return {'ok': False, 'error': 'The USBPcap installer isn’t in this copy of Open Nova (it comes with the Windows package). Get USBPcap %s from %s '
                                      '(or install Wireshark and tick “Install USBPcap”), then restart the computer.' % (USBPCAP['version'], USBPCAP['home'])}
    h = sha256_of(p)
    if h != USBPCAP['sha256']: return {'ok': False, 'error': '%s isn’t the official USBPcap %s (its SHA-256 differs): not started.' % (os.path.basename(p), USBPCAP['version'])}
    with _lock: _inst.update(running=True, result=None, started=time.time())
    wirelog.mark('USB capture: starting the USBPcap %s installer (%s, SHA-256 checked)' % (USBPCAP['version'], p), source='vendor')
    threading.Thread(target=_install_run, args=(p,), daemon=True).start()
    return {'ok': True, 'started': True, 'say': 'Windows asks for permission, then USBPcap’s installer opens: accept its two licences and click Install. Restart the computer afterwards.'}


def _install_run(p):
    res = {}
    try:
        hp, err = _runas(p, '')
        if hp is None:
            res = {'ok': False, 'refused': err == 1223, 'error': 'Windows’ permission prompt was answered No: nothing was installed.' if err == 1223 else
                   'The installer didn’t start (Windows error %d).' % err}
        else:
            code = _wait_exit(hp)
            d = detect()
            res = {'ok': code == 0 and d['state'] in ('ready', 'reboot'), 'exitCode': code, 'state': d['state'], 'rebootNeeded': d['state'] == 'reboot',
                   'say': {0: '', 1: 'The USBPcap installer was cancelled.', 2: 'The USBPcap installer stopped (already installed, or a restart pending?).'}.get(code, '') or d['say'],
                   'detect': d}
    except Exception as e:  # noqa: BLE001 - the app must hear about it
        res = {'ok': False, 'error': 'installing USBPcap failed: %s' % e}
    wirelog.mark('USB capture: USBPcap installer finished: %s' % json.dumps({k: v for k, v in res.items() if k != 'detect'}, ensure_ascii=False), source='vendor')
    with _lock: _inst.update(running=False, result=res)


def install_status():
    with _lock: return {'ok': True, 'running': _inst['running'], 'result': _inst['result']}


# ------------------------------------------------------------------ the live capture
_C = {'st': None}      # the capture this helper started (one dict, shared by start / the reader / status / stop)


def _stderr_tail(st):
    try:
        with open(st['errfile'], encoding='utf-8', errors='replace') as f: return f.read()[-800:].strip()
    except (OSError, KeyError):
        return ''


_session = {'refused': 0, 'consent': False}   # this helper session: UAC answered No (times), the tester's "Allow USB recording"


def _no(state, say, **f):
    return dict({'ok': False, 'state': state, 'error': say, 'say': say, 'running': False}, **f)


def start(hub=None, addr=None, all_devices=False, minutes=60, max_mb=200, consent=False, retry=False):
    """Capture the root hub with the NovaStar device (detect(); or hub / addr given) into vendor/captures/<time>_usb.pcap.
    USBPcapCMD runs as the tester; it asks Windows for an elevated copy of itself (one UAC prompt) that does the capture and
    pipes it back through it to the helper. NovaLCT keeps the device the whole time; Open Nova sends nothing.
    For code too (the USB coordinator): never raises for the expected cases and never causes a UAC prompt unless
    consent=True (the tester's one "Allow USB recording" this session). After the prompt was answered No it doesn't ask
    again this session unless retry=True. Already running -> ok with the running capture (idempotent).
    -> {ok, state, say, running, capture?}; state: capturing / waiting (the prompt is up) / needs-consent / unsupported /
    not-installed / reboot / no-cmd / no-device / refused / failed."""
    with _lock: run = _C['st'] is not None and _C['st']['proc'].poll() is None
    if run:
        s = status(); return {'ok': True, 'state': s['state'], 'say': s['say'], 'running': True, 'already': True, 'capture': s}
    if consent: _session['consent'] = True
    if not _session['consent']: return _no('needs-consent', 'USB recording needs the tester’s OK first (Windows will ask for permission once).')
    if _session['refused'] and not retry:
        return _no('refused', 'Windows’ permission prompt was answered No this session: USB recording stays off until it is started again by hand.')
    d = detect()
    if d['state'] != 'ready': return _no(d['state'], d['say'])
    nova = d.get('nova')
    hp = hub_path(hub) if hub else (nova or {}).get('hub', '')
    if hub and nova and hub_path(hub) == nova['hub'] and addr is None: addr = nova['addr']
    elif not hub and nova: addr = nova['addr'] if addr is None else addr
    if not hp:
        return _no('no-device', 'The NovaStar USB device isn’t plugged in (or Windows hasn’t got it yet): plug the controller in, then start again.',
                   hubs=[h['hub'] for h in d['hubs']])
    args = ['-d', hp, '-o', '-', '-s', str(SNAPLEN), '--inject-descriptors']
    args += ['-A'] if all_devices or addr is None else ['--devices', str(int(addr)), '--capture-from-new-devices']
    path = os.path.join(_vt().vendor_dir('captures'), time.strftime('%H%M%S') + '_usb.pcap')
    errfile = path + '.usbpcapcmd.txt'
    try:
        fh, ef = open(path, 'wb'), open(errfile, 'w', encoding='utf-8')
        proc = subprocess.Popen(_cmd(d['cmd']) + args, stdout=subprocess.PIPE, stderr=ef, stdin=subprocess.DEVNULL,
                                **({'creationflags': 0x08000000} if IS_WIN else {}))
    except OSError as e:
        return _no('failed', 'USBPcapCMD didn’t start: %s' % e)
    st = {'proc': proc, 'header': None, 'fh': fh, 'ef': ef, 'file': path, 'errfile': errfile, 'started': time.time(), 'bytes': 0, 'hub': hp,
          'hint': (hub_number(hp), int(addr)) if addr is not None else None, 'addr': addr, 'dec': Decoder((hub_number(hp), int(addr)) if addr is not None else None),
          'ps': PcapStream(), 'error': '', 'why': '', 'limit': (float(minutes or 60) * 60, int(max_mb or 200) << 20), 'args': args}
    st['reader'] = threading.Thread(target=_reader, args=(st,), daemon=True)
    with _lock: _C['st'] = st
    st['reader'].start()
    wirelog.mark('USB capture started: USBPcapCMD %s -> %s' % (' '.join(args), _vt()._rel(path)), source='vendor')
    for _ in range(15):                                    # an at-once failure (bad hub, no worker) shows here
        if proc.poll() is not None or st['bytes']: break
        time.sleep(0.1)
    s = status()
    if s['state'] in ('refused', 'failed'):
        _settle(st)
        return _no(s['state'], s['say'], capture=s)
    return {'ok': True, 'state': s['state'], 'say': s['say'], 'running': True, 'capture': s}


def _settle(st):
    """USBPcapCMD ended without a capture (prompt refused / failed): close the files (kept: USBPcapCMD's message is in the .txt)."""
    st['reader'].join(5); _finish_files(st)


def _reader(st):
    """USBPcapCMD's stdout -> the .pcap (as it comes) + the live counters. Ends when USBPcapCMD ends (Stop, a refused prompt,
    or the limits below)."""
    p, out = st['proc'], st['proc'].stdout
    rd = getattr(out, 'read1', None) or (lambda n: os.read(out.fileno(), n))
    try:
        while True:
            b = rd(65536)
            if not b: break
            st['fh'].write(b); st['fh'].flush()
            with _lock:
                st['bytes'] += len(b)
                if st['header'] is None and st['bytes'] >= 24:   # the elevated copy is capturing: how long the start took
                    st['header'] = time.time()
                    wirelog.mark('USB capture running %.1f s after start (Windows’ prompt included)' % (st['header'] - st['started']), source='vendor')
                try:
                    for t, pk, orig in st['ps'].feed(b): st['dec'].packet(t, pk, orig)
                except ValueError as e: st['error'] = 'not a capture: %s' % e
            if time.time() - st['started'] > st['limit'][0] or st['bytes'] > st['limit'][1]:
                st['why'] = 'stopped by itself after %d min / %d MB' % (st['limit'][0] // 60, st['limit'][1] >> 20)
                p.terminate()
    except (OSError, ValueError) as e:
        st['error'] = str(e)
    try: p.wait(10)
    except subprocess.TimeoutExpired: pass
    if st['bytes'] < 24 and not st.get('stopping'):
        try: st['ef'].flush()
        except (OSError, ValueError): pass
        if 'Failed to create worker process' in _stderr_tail(st): _session['refused'] += 1   # no new prompt this session without retry
        wirelog.mark('USB capture ended without capturing: %s' % (_stderr_tail(st) or 'exit code %s' % p.returncode), source='vendor')
    _finish_files(st)                                      # USBPcapCMD has ended: the .pcap is whole


def status():
    with _lock: st = _C['st']
    if not st: return {'running': False, 'state': 'idle', 'say': 'No USB capture running.'}
    p = st['proc']
    run, err = p.poll() is None, _stderr_tail(st) if p.poll() is not None else ''
    if run: state = 'capturing' if st['bytes'] >= 24 else 'waiting'
    elif st.get('stopping'): state = 'stopped'
    elif re.search(r'Failed to create worker process', err) and st['bytes'] < 24: state = 'refused'
    elif st['bytes'] < 24: state = 'failed'
    else: state = 'stopped'
    say = {'waiting': 'Windows is asking for permission: click Yes in its prompt. Then use NovaLCT as usual.',
           'capturing': 'Capturing: use NovaLCT as usual, then Stop.',
           'refused': 'Windows’ permission prompt was answered No (or closed): nothing was captured. Start again and choose Yes — USBPcap only lets administrators capture.',
           'failed': 'USBPcapCMD stopped at once: %s' % (err or 'exit code %s' % p.returncode),
           'stopped': st.get('why') or 'Stopped.'}[state]
    with _lock:
        dec = st['dec']; frames = dec.stats['frames']; last = [r.get('sum') or r.get('what') or r.get('error', '') for r in dec.out[-5:] if r['kind'] in ('tg', 'usb', 'err', 'echo')]
        nova = any(v[:2] == (NOVA_VID, NOVA_PID) for v in dec.devs.values())
    return {'running': run, 'state': state, 'say': say, 'file': _vt()._rel(st['file']), 'bytes': st['bytes'], 'seconds': round(time.time() - st['started']),
            'hub': st['hub'], 'addr': st['addr'], 'packets': dec.stats['packets'], 'frames': frames, 'novaSeen': nova, 'last': last, 'error': st.get('error', ''),
            'startSeconds': round(st['header'] - st['started'], 2) if st['header'] else None, 'refusedThisSession': _session['refused']}


def _finish_files(st):
    for k in ('fh', 'ef'):
        try: st[k].close()
        except (OSError, KeyError, AttributeError): pass


def stop():
    """End USBPcapCMD (the copy the helper started: its elevated copy ends with it — the pipe it writes to breaks and
    USBPcapCMD's job closes), write the rest of the file and decode it next to the .pcap."""
    with _lock: st = _C['st']
    if not st: return {'ok': True, 'state': 'idle', 'running': False, 'say': 'No USB capture running.'}
    p = st['proc']
    st['stopping'] = True
    if p.poll() is None:
        time.sleep(0.3)                                    # what the elevated copy has just sent still comes through
        p.terminate()
        try: p.wait(5)
        except subprocess.TimeoutExpired: p.kill(); p.wait(5)
    st['reader'].join(10)
    _finish_files(st)
    s = status()
    with _lock: _C['st'] = None
    path = st['file']
    if st['bytes'] < 24:
        return _no(s['state'] if s['state'] in ('refused', 'failed') else 'empty', s['say'] if s['state'] in ('refused', 'failed') else 'Nothing was captured (Windows’ prompt not answered?).', capture=s)
    with open(path, 'rb') as f: data = f.read()
    try:
        r = import_pcap(os.path.basename(path), data, keep_original=False, original_path=path, hint=st['hint'])
    except ValueError as e:
        return _no('failed', 'the capture couldn’t be read: %s' % e, file=_vt()._rel(path))
    wirelog.mark('USB capture stopped: %s (%d bytes)' % (_vt()._rel(path), len(data)), source='vendor')
    return dict(r, state='stopped', running=False, capture=s)


def _atexit():
    p = _C['st'] and _C['st']['proc']
    if p and p.poll() is None:
        try: p.terminate()
        except OSError: pass


import atexit   # noqa: E402 - the helper never leaves a USBPcapCMD behind
atexit.register(_atexit)


# ------------------------------------------------------------------ the problem report + the helper's routes
def report_md():
    try: d = detect()
    except Exception as e:  # noqa: BLE001 - the report must still be made
        return ['USB capture (USBPcap): not checked: %s' % e, '']
    if not d.get('supported'): return []
    n = d.get('nova')
    return ['USB capture (USBPcap): %s%s%s; NovaStar USB device %s.' % (d['state'], ' %s' % d['version'] if d.get('version') else '', ', bundled installer' if d.get('bundled') else '',
                                                                      'on USBPcap%s address %s' % (n['bus'], n['addr']) if n else 'not on a USB port now'), '']


def handle(p, body):
    """vendortap.handle passes /api/hw/vendor/usb-* here."""
    if p == 'usb-detect': return detect(body.get('devices', True) is not False, bool(body.get('refresh')))
    if p == 'usb-install': return install()
    if p == 'usb-install-status': return install_status()
    if p == 'usb-start': return start(body.get('hub'), body.get('addr'), bool(body.get('all')), body.get('minutes') or 60,
                                     consent=bool(body.get('consent')), retry=bool(body.get('retry')))
    if p == 'usb-status': return {'ok': True, 'capture': status()}
    if p == 'usb-stop': return stop()
    return {'ok': False, 'error': 'unknown: ' + p}


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'decode':     # python tools/usbcap.py decode FILE.pcap: the records, one per line
        for r in from_pcap(sys.argv[2]): print(json.dumps(r, ensure_ascii=False))
    else:
        print(json.dumps(detect(), indent=1, default=str))
