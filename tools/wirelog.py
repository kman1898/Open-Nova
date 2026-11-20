"""wirelog.py - Open Nova's flight recorder: every byte the helper sends to a processor and gets back. Stdlib only.

User, 2026-10-11: "when i connect via my mac to the H's we will need to make sure we have a way to analyze anything sent
from it to and from the H. So we need real diagnostics."

What is recorded (one JSON object per line, files under Nova/diagnostics/YYYY-MM-DD/, a new file per helper start and
every 20 MB; full files are gzipped, nothing is deleted):
  tg    a NovaLCT-protocol frame (TCP), exact bytes as hex, decoded (serial, dst, dev, port, card, op, r2, addr, len,
        status) with the register's name; replies carry the round-trip time and whether they were stale
  conn  a TCP connection opened / closed / refused (with the error)
        (a reply after its request had timed out: late, with how late)
  echo  our own request coming back from the processor (H series: a broadcast write, or a request for a sending card
        that isn't there, which returns with the sending-card byte changed) — with the request it echoes ('of')
  err   a failed exchange: timeout, bad checksum, a non-zero status, connection closed — with the request it belonged to;
        link 'helper' = a bug in the helper itself (a short traceback in 'where')
  junk  bytes on a link that weren't a frame at all (all of them)
  usb   NovaStar's USB wrapper blocks around the frames: USBC write / read requests (tx), USBS status blocks (rx),
        the empty packet after a 64-byte multiple (docs/USB_NOVA_DEVICE.md)
  udp   discovery packets (NovaLCT 3800, Unico 5600, COEX 54622), whole
  http  a Unico / COEX / H web REST call: method, URL, headers, request and response bodies (whole: up to 4 MB in the
        record, bigger ones in a side file <day>/bodies/… the record names), status, time
  op    a helper route starting / ending (what the app asked for), with ok / error and time
  mark  a note from the app (an action like "Send layout") or typed by the user
Every record made while the helper serves an app request carries that request's action id ('act': the click / menu in
the app that caused it, docs/DIAGNOSTICS.md "Actions"). Only passwords, tokens and logins are ever left out (masked).
't' never goes backwards (a monotonic clock anchored to the wall clock at start, microseconds). Writing never stops
silently: a failed write keeps the records in memory (up to 64 MB) and retries; status() says so (writeError).
Recording happens where the helper writes to the socket, so nothing Open Nova sends can be missed; traffic that other
software or the processor itself sends is outside it (use Wireshark / tcpdump for that, then import the capture here).

    status() / frames(since, limit) / files() / load(name, limit) / mark(text) / set_enabled(on) / stray(link, bytes)
    set_action(id, what) / action() / bind(fn)   the app action the current thread works for
    body_bytes(b) -> the bytes of a recorded http body (inline text / base64 or its side file)
    to_pcap(records) -> bytes (Wireshark: TCP for frames and HTTP, UDP for discovery and marks)
    from_capture(bytes) -> records (a .pcap / .pcapng from Wireshark or tcpdump, decoded the same way)
"""
import base64
import collections
import gzip
import hashlib
import json
import os
import shutil
import socket
import struct
import threading
import time

NOVA = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIAG_DIR = os.environ.get('OPENNOVA_DIAG') or os.path.join(NOVA, 'diagnostics')
ROTATE = 20 * 1024 * 1024
BODY_MAX = 4 * 1024 * 1024         # an http body bigger than this goes to a side file (<day>/bodies/), never cut
PREVIEW = 64 * 1024                # what a side-filed body keeps in the record itself (for the app's detail view)
BACKLOG_MAX = 64 * 1024 * 1024     # records held in memory while the disk refuses them (then the oldest are counted lost)
RING = 5000
SENT_KEEP = 64                     # requests kept per link to recognise their echoes
COEX_UDP = (54622, 54623, 54624, 54700)   # VMP / COEX announcements + backup discovery (VENDOR_CAPTURE.md §3)
PROC_PORTS = range(5200, 5233)     # TG on TCP: 5200 MCTRL / VX, 5201+ per H output card (the Wireshark plug-in's ports)
DEV_NAMES = {0: 'sender', 1: 'rx', 2: 'dev2', 3: 'distributor', 4: 'function'}
# Names from captures that the doc tables don't carry ([R] in the docs); dev -> addr -> name
CURATED = {
    0: {0x05065000: 'REDU backup pairs', 0x05066000: 'SSPE', 0x0200009D: 'Device backup role (5A primary / A5 backup)',
        0x020000AF: 'Switch to backup ports', 0x02000074: 'Low latency (sending card)', 0x02020020: 'Function table',
        0x02020024: 'Function table (FreeRoute bit 6)', 0x02030000: 'Per-port card counts', 0x03200000: 'Per-card rectangles'},
    1: {0x0100000B: 'Restart FPGA (ScannerFPGARestart)', 0x01000080: 'Restart MCU (ScannerMCURestart)',
        0x01000011: 'Save receiving-card parameters', 0x01000096: 'Restore factory (receiving card)', 0x01000088: 'Mapping on/off',
        0x02000100: 'Blackout', 0x02000101: 'Test pattern / self test', 0x02000102: 'Freeze', 0x020001E3: 'Brightness apply',
        0x02000002: 'Red brightness', 0x02000003: 'Green brightness', 0x02000004: 'Blue brightness', 0x02000005: 'VR brightness',
        0x060003CA: 'Low-gray grade', 0x020001D5: 'Low latency (receiving card)', 0x0200014A: 'Bit errors', 0x020004FB: 'Disconnect count',
        0x14000420: 'Power supply status', 0x02000220: 'Function table', 0x06000200: 'NCP marker / identity',
        0x02000000: 'Receiving-card parameters'},
}
RANGES = [  # (dev, start, end, name): block writes / reads inside a known area
    (0, 0x05000000, 0x05040000, 'NSSD screen layout'), (0, 0x05065000, 0x05066000, 'REDU backup pairs'),
    (1, 0x05000000, 0x05000600, 'Gamma LUT'), (1, 0x08000000, 0x08400000, 'FPGA program / version'),
    (1, 0x09000000, 0x09100000, 'MCU program / version'), (1, 0x06000200, 0x06000400, 'NCP marker / identity'),
    (1, 0x02000000, 0x02000100, 'Receiving-card parameters'), (0, 0x02000000, 0x02000200, 'Sending-card parameters'),
]

_lock = threading.Lock()
_ring = collections.deque(maxlen=RING)
_herr = collections.deque(maxlen=50)   # the helper's own bugs (err, link 'helper'), kept for the problem report
HEADER = {'text': ''}                  # first line of every recording file: the version (novalink sets it from tools/alpha.py)
_st = {'seq': 0, 'enabled': True, 'file': None, 'fh': None, 'bytes': 0, 'day': '', 'started': time.time(),
       'counts': collections.Counter(), 'links': {}, 'pending': {}, 'sent': {}, 'last_t': 0.0,
       'werr': None, 'backlog': collections.deque(), 'backlog_bytes': 0, 'lost': 0, 'retry': 0.0, 'side': 0}
_names = None
_PC0, _WALL0 = time.perf_counter(), time.time()
_ctx = threading.local()               # the app action the current thread is serving (set_action)


def now():
    """Seconds since 1970 that never go backwards (a clock change mid-session doesn't reorder the records): the wall clock
    at start plus a monotonic high-resolution counter."""
    return _WALL0 + (time.perf_counter() - _PC0)


# ------------------------------------------------------------------ the app action behind the records
def set_action(act, what=None):
    """The app action (its id from the browser: one click / menu / shortcut) this thread now works for; None = none.
    Every record made on this thread carries it as 'act' until set_action(None)."""
    _ctx.act = str(act)[:48] if act else None
    _ctx.what = str(what)[:120] if act and what else None


def action():
    return getattr(_ctx, 'act', None)


def action_what():
    return getattr(_ctx, 'what', None)


def bind(fn):
    """fn for another thread, keeping the action of the thread that made it (a probe fanned out over threads)."""
    a, w = action(), action_what()
    def run(*args, **kw):
        old = (action(), action_what()); set_action(a, w)
        try: return fn(*args, **kw)
        finally: set_action(*old)
    return run


# ------------------------------------------------------------------ names + decoding
def _load_names():
    global _names
    if _names is None:
        t = {0: {}, 1: {}, 'any': {}}
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tg_registers.json'), encoding='utf-8') as f:
                j = json.load(f)
            for k, d in (('0', 0), ('1', 1), ('any', 'any')):
                t[d] = {int(a, 16): v[0] for a, v in j.get(k, {}).items()}
        except (OSError, ValueError):
            pass
        for d, m in CURATED.items():
            t[d].update(m)                  # names seen live win over the doc tables' (Blackout, not KillMode)
        _names = t
    return _names


def reg_name(dev, addr):
    t = _load_names()
    n = t.get(dev, {}).get(addr) or t['any'].get(addr)
    if n: return n
    for d, s, e, name in RANGES:
        if d == dev and s <= addr < e: return '%s +0x%X' % (name, addr - s) if addr != s else name
    return ''


def frame_data_len(b):
    """Bytes of data inside a frame (header 18 + data + checksum 2): a read request has none."""
    return 0 if b[0] == 0x55 and b[10] == 0 else struct.unpack_from('<H', b, 16)[0]


def decode(b):
    """A NovaLCT-protocol frame -> fields (request 55 AA, reply AA 55; docs/HW_PROTOCOL.md), or None."""
    if len(b) < 20 or b[:2] not in (b'\x55\xAA', b'\xAA\x55'): return None
    card, op, r2, addr, ln = struct.unpack_from('<HBBIH', b, 8)
    # a reply swaps bytes 4 and 5 (HW_PROTOCOL.md §2.1): its sending card is byte 4, byte 5 is FE
    d = {'kind': 'req' if b[0] == 0x55 else 'reply', 'serial': b[3], 'dst': b[5] if b[0] == 0x55 else b[4], 'dev': b[6], 'port': b[7], 'card': card,
         'op': 'write' if op == 1 else 'read' if op == 0 else op, 'r2': r2, 'addr': '0x%08X' % addr, 'len': ln}
    if b[0] == 0xAA: d['status'] = b[2]
    n = frame_data_len(b)                           # a read request names the length it wants but carries no data
    data = b[18:18 + n] if len(b) >= 20 + n else b''
    if len(b) >= 20 + n:
        got = struct.unpack_from('<H', b, 18 + n)[0]; want = (0x5555 + sum(b[2:18 + n])) & 0xFFFF
        if got != want: d['badsum'] = True
    d['name'] = reg_name(b[6], addr)
    return d, data


def split_frames(b):
    """Bytes -> [(True, frame) / (False, stray bytes)] in order. A frame starts 55 AA / AA 55 and its checksum is right."""
    out, i, last = [], 0, 0
    while True:
        j = min([x for x in (b.find(b'\x55\xAA', i), b.find(b'\xAA\x55', i)) if x >= 0], default=-1)
        if j < 0 or len(b) - j < 20: break
        n = frame_data_len(b[j:j + 20])
        fr = b[j:j + 20 + n]
        if len(fr) == 20 + n and struct.unpack_from('<H', fr, 18 + n)[0] == (0x5555 + sum(fr[2:18 + n])) & 0xFFFF:
            if j > last: out.append((False, b[last:j]))
            out.append((True, fr)); i = last = j + 20 + n
        else:
            i = j + 1
    if last < len(b): out.append((False, b[last:]))
    return out


def _sc(x):
    return '*' if x == 255 else '%d' % (x + 1)


def echo_of(sent, fr):
    """(seq, change) of the request among sent [(seq, bytes)] that fr is: the same bytes, or the same with another
    sending-card byte (an H returns a request no sending card took that way: S2 -> S251). (None, '') if none."""
    for seq, s in reversed(list(sent)):
        if s == fr: return seq, ''
        if len(s) == len(fr) and s[:5] == fr[:5] and s[6:-2] == fr[6:-2]:
            return seq, 'sending card S%s -> S%s' % (_sc(s[5]), _sc(fr[5]))
    return None, ''


def _echo_rec(link, fr, sent, note=''):
    seq, ch = echo_of(sent, fr)
    p = decode(fr)
    f = {'link': link, 'dir': 'rx', 'hex': fr.hex(), 'd': p[0], 'sum': summary(*p)}
    if seq is not None: f['of'] = seq
    if ch: f['change'] = ch
    if note: f['note'] = note
    return f


def summary(d, data):
    """'W rx d0 p3 c* 0x02000001 GlobalBrightness = FF' / 'R sender d0 0x00000002 ModelID (2 B)'"""
    who = DEV_NAMES.get(d['dev'], 'dev%d' % d['dev'])   # S = sending card, P = port, C = card, 1-based as in the app; * = all
    where = 'S%s' % ('*' if d['dst'] == 255 else d['dst'] + 1)
    if d['dev'] != 0 or d['port']: where += ' P%s' % ('*' if d['port'] == 255 else d['port'] + 1)
    if d['dev'] != 0: where += ' C%s' % ('*' if d['card'] == 0xFFFF else d['card'] + 1)
    rw = 'W' if d['op'] == 'write' else 'R' if d['op'] == 'read' else '?'
    val = ''
    if data:
        h = data[:12].hex(' ').upper()
        val = (' = ' if d['kind'] == 'req' else ' -> ') + h + (' … (%d B)' % len(data) if len(data) > 12 else '')
    elif d['op'] == 'read' and d['kind'] == 'req':
        val = ' (%d B)' % d['len']
    st = '' if d.get('status', 0) == 0 else ' STATUS %d' % d['status']
    return '%s %s %s %s%s%s%s%s' % (rw, who, where, d['addr'], ' ' + d['name'] if d['name'] else '', val,
                                   ' r2=%d' % d['r2'] if d['r2'] else '', st + (' BAD CHECKSUM' if d.get('badsum') else ''))


# ------------------------------------------------------------------ recording
def _open_file(now):
    day = time.strftime('%Y-%m-%d', time.localtime(now))
    d = os.path.join(DIAG_DIR, day); os.makedirs(d, exist_ok=True)
    base = os.path.join(d, time.strftime('%Y%m%d-%H%M%S', time.localtime(now)))
    path, k = base + '_%d.nwl' % os.getpid(), 1
    while os.path.exists(path) or os.path.exists(path + '.gz'):   # a rotation within the same second: never the file being gzipped
        k += 1; path = base + '~%02d_%d.nwl' % (k, os.getpid())                  # (sorts after the first: names stay in time order)
    _st.update(fh=open(path, 'a', encoding='utf-8', newline='\n'), file=path, bytes=0, day=day)


def _gzip_later(path):
    def go():
        try:
            with open(path, 'rb') as a, gzip.open(path + '.gz', 'wb') as b: shutil.copyfileobj(a, b)
            with gzip.open(path + '.gz', 'rb') as c: ok = c.read() == open(path, 'rb').read()
            if ok: os.remove(path)          # the .gz holds the same bytes (checked)
        except OSError:
            pass
    threading.Thread(target=go, daemon=True).start()


def _write(line, t, seq):
    """One line to the recording (under _lock). A failure never loses it: the line waits in memory (BACKLOG_MAX) and goes
    out, in order, with the next write that works; the failure is kept for status() (writeError) until then."""
    st = _st
    if st['werr'] and st['fh'] is None and time.time() < st['retry']:
        _hold(line); return
    try:
        day = time.strftime('%Y-%m-%d', time.localtime(t))
        if st['fh'] is None or st['bytes'] > ROTATE or st['day'] != day:
            if st['fh'] is not None:
                st['fh'].close(); st['fh'] = None
                if st['bytes'] > ROTATE: _gzip_later(st['file'])
            _open_file(t)
            if HEADER['text']:   # which Open Nova made this file (seq just before the first record's)
                h = json.dumps({'seq': seq - 0.5, 't': round(t, 6), 'kind': 'mark', 'source': 'header', 'text': HEADER['text']}, ensure_ascii=False, separators=(',', ':')) + '\n'
                st['fh'].write(h); st['bytes'] += len(h)
        n = len(st['backlog'])
        if n:
            back = ''.join(st['backlog'])
            st['fh'].write(back); st['bytes'] += len(back); st['backlog'].clear(); st['backlog_bytes'] = 0
        st['fh'].write(line); st['fh'].flush(); st['bytes'] += len(line)
        if st['werr']:                                      # writing works again: say what happened, in the file itself
            w, lost = st['werr'], st['lost']; st['werr'] = None
            m = json.dumps({'seq': seq + 0.5, 't': round(t, 6), 'kind': 'mark', 'source': 'recorder', 'text': 'Writing the recording failed from %s (%s); %d record(s) held in memory are written above%s' % (
                time.strftime('%H:%M:%S', time.localtime(w['since'])), w['error'], n, ', %d lost (over %d MB)' % (lost, BACKLOG_MAX >> 20) if lost else '')},
                ensure_ascii=False, separators=(',', ':')) + '\n'
            st['fh'].write(m); st['fh'].flush(); st['bytes'] += len(m)
    except (OSError, ValueError) as e:
        st['counts']['write_error'] += 1
        if st['werr'] is None: st['werr'] = {'since': time.time(), 'error': str(e)[:200]}
        st['werr'].update(last=time.time(), error=str(e)[:200])
        try:
            if st['fh'] is not None: st['fh'].close()
        except (OSError, ValueError): pass
        st['fh'] = None; st['retry'] = time.time() + 1.0      # try the disk again at most once a second
        _hold(line)


def _hold(line):
    _st['backlog'].append(line); _st['backlog_bytes'] += len(line)
    while _st['backlog_bytes'] > BACKLOG_MAX and _st['backlog']:
        _st['backlog_bytes'] -= len(_st['backlog'].popleft()); _st['lost'] += 1


def write_error():
    """None, or {since, last, error, held, lost} while the recording can't be written (disk full, folder gone …)."""
    with _lock:
        w = _st['werr']
        return dict(w, held=len(_st['backlog']), lost=_st['lost']) if w else None


def record(kind, **f):
    a = action()
    with _lock:
        _st['seq'] += 1
        t = _st['last_t'] = max(now(), _st['last_t'])
        r = {'seq': _st['seq'], 't': round(t, 6), 'kind': kind}
        if a and 'act' not in f: r['act'] = a
        r.update(f)
        _ring.append(r)
        _st['counts'][kind] += 1
        if kind == 'err' and f.get('link') == 'helper': _herr.append(r)
        if not _st['enabled']: return r
        _write(json.dumps(r, ensure_ascii=False, separators=(',', ':'), default=str) + '\n', t, r['seq'])
    return r


def _link(link):
    return _st['links'].setdefault(link, {'tx': 0, 'rx': 0, 'err': 0, 'nocard': 0, 'rtt_sum': 0.0, 'rtt_n': 0, 'rtt_max': 0.0, 'last_err': '', 'last': 0})


def nocard(d):
    """A decoded reply that says "no receiving card answered here" (ack 1 to a receiving-card request): the expected end of a
    chain walk, or a dead primary the backup serves (novalink.NoCard). Noted on the reply, never counted as an error."""
    return bool(d) and d.get('kind') == 'reply' and d.get('status') == 1 and d.get('dev') == 1


def tg(link, direction, frame, **extra):
    """A frame on a link. direction 'tx' (to the processor) / 'rx'. Replies get the round-trip time of their request
    (late=True: it came after the request had timed out; its time is kept out of the link's reply-time figures)."""
    frame = bytes(frame)
    p = decode(frame)
    rec = {'link': link, 'dir': direction, 'hex': frame.hex()}
    t = now()
    with _lock:
        L = _link(link); L[direction] += 1; L['last'] = time.time()
        if p:
            key = (link, p[0]['serial'])
            if direction == 'tx': _st['pending'][key] = t
            elif key in _st['pending']:
                rtt = (t - _st['pending'].pop(key)) * 1000; rec['rtt'] = round(rtt, 2)
                if not extra.get('late'): L['rtt_sum'] += rtt; L['rtt_n'] += 1; L['rtt_max'] = max(L['rtt_max'], rtt)
    if p:
        rec['d'] = p[0]; rec['sum'] = summary(*p)
        if direction == 'rx' and nocard(p[0]):
            rec['nocard'] = True
            with _lock: _link(link)['nocard'] += 1
    rec.update(extra)
    r = record('tg', **rec)
    if direction == 'tx':
        with _lock: _st['sent'].setdefault(link, collections.deque(maxlen=SENT_KEEP)).append((r['seq'], frame))
    return r


def stray(link, data, note=''):
    """Bytes a link got that weren't the reply being waited for, sorted out: our own request coming back ('echo': an H
    returns broadcast writes, and requests no sending card took with the sending-card byte changed), a reply that came
    after its request had timed out ('tg' rx, late=True), anything else 'junk'. Returns the records."""
    out = []
    for is_frame, b in split_frames(bytes(data)):
        if is_frame and b[0] == 0x55:
            with _lock: sent = list(_st['sent'].get(link, ()))
            out.append(record('echo', **_echo_rec(link, b, sent, note)))
        elif is_frame:
            out.append(tg(link, 'rx', b, late=True, **({'note': note} if note else {})))
        else:
            f = {'link': link, 'hex': b.hex(), 'n': len(b)}
            if note: f['note'] = note
            out.append(record('junk', **f))
    return out


USB_KIND = {b'USBC': 'USBC', b'USBS': 'USBS'}


def usb(link, direction, block, **extra):
    """One block of NovaStar's USB wrapper (not stream bytes): a USBC write / read request (tx, with the length and tag it
    announces), a USBS status (rx: tag, residue, status) or the empty packet after a 64-byte multiple (tx, n 0)."""
    block = bytes(block)
    f = {'link': link, 'dir': direction, 'hex': block.hex(), 'n': len(block), 'what': USB_KIND.get(block[:4], 'empty packet' if not block else 'block')}
    try:
        if block[:4] == b'USBC' and len(block) >= 13:
            tag, n = struct.unpack_from('<II', block, 4); f.update(tag=tag, len=n, read=bool(block[12] & 0x80))
        elif block[:4] == b'USBS' and len(block) >= 13:
            tag, residue, status = struct.unpack_from('<IIB', block, 4); f.update(tag=tag, residue=residue, status=status)
    except struct.error: pass
    f.update(extra)
    if f.get('status'):
        with _lock: L = _link(link); L['err'] += 1; L['last_err'] = 'USB status %d' % f['status']
    return record('usb', **f)


def err(link, text, frame=None):
    with _lock:
        L = _link(link); L['err'] += 1; L['last_err'] = text
    rec = {'link': link, 'error': text}
    if frame is not None:
        p = decode(bytes(frame)); rec['req'] = summary(*p) if p else bytes(frame).hex()
    return record('err', **rec)


def conn(link, event, error=None, ms=None, **extra):
    """A connection opened / closed / refused; extra: via = the interface (and its address) it went through."""
    if error:
        with _lock: L = _link(link); L['err'] += 1; L['last_err'] = '%s: %s' % (event, error)
    f = {'link': link, 'event': event}
    if error: f['error'] = error
    if ms is not None: f['ms'] = round(ms, 1)
    f.update((k, v) for k, v in extra.items() if v not in (None, ''))
    return record('conn', **f)


def udp(direction, peer, data, proto='', **extra):
    """A discovery datagram, whole (bytes as hex; also as text when it is one); extra: iface = the interface it went out
    of / came in on (netif.udp_search), via = the address it was sent from."""
    data = bytes(data)
    txt = data.decode('utf-8', 'replace') if data[:1] in (b'r', b'{') else ''
    f = {'dir': direction, 'peer': '%s:%s' % tuple(peer[:2]), 'hex': data.hex(), 'n': len(data), 'proto': proto}
    if txt: f['text'] = txt
    f.update((k, v) for k, v in extra.items() if v not in (None, ''))
    return record('udp', **f)


def _side(b, part):
    """A body too big for a record -> diagnostics/<day>/bodies/<recording>_<n>_<part>.bin; the name (relative) or None."""
    with _lock:
        if not _st['enabled']: return None
        _st['side'] += 1; k = _st['side']
        base = os.path.basename(_st['file'] or '')[:-4] or time.strftime('%Y%m%d-%H%M%S') + '_%d' % os.getpid()
    day = time.strftime('%Y-%m-%d')
    rel = '%s/bodies/%s_%d_%s.bin' % (day, base, k, part)
    try:
        d = os.path.join(DIAG_DIR, day, 'bodies'); os.makedirs(d, exist_ok=True)
        with open(os.path.join(DIAG_DIR, *rel.split('/')), 'wb') as fh: fh.write(b)
        return rel
    except OSError as e:
        with _lock:
            _st['counts']['write_error'] += 1
            if _st['werr'] is None: _st['werr'] = {'since': time.time(), 'last': time.time(), 'error': 'side file: %s' % e}
        return None


def _body(b, part='body'):
    """An http body for the record, whole: UTF-8 text as 'text', anything else as 'b64'; over BODY_MAX the bytes go to a
    side file ('file', with 'sha256' and the first PREVIEW bytes as 'text'); kept inline if that file can't be written."""
    if b is None: return None
    if isinstance(b, str): b = b.encode('utf-8')
    b = bytes(b)
    try: out = {'n': len(b), 'text': b.decode('utf-8')}
    except UnicodeDecodeError: out = {'n': len(b), 'b64': base64.b64encode(b).decode('ascii')}
    if len(b) <= BODY_MAX: return out
    rel = _side(b, part)
    if not rel: return out                                   # the disk refused the side file: whole, in the record
    return {'n': len(b), 'file': rel, 'sha256': hashlib.sha256(b).hexdigest(), 'text': b[:PREVIEW].decode('utf-8', 'replace'), 'preview': True}


def body_bytes(b):
    """The bytes of a recorded body: inline text / base64, or read back from its side file (b'' if that is gone)."""
    if not b: return b''
    if b.get('file'):
        try:
            with open(path_of(b['file']), 'rb') as fh: return fh.read()
        except (KeyError, OSError): return (b.get('text') or '').encode('utf-8')
    if 'b64' in b: return base64.b64decode(b['b64'])
    return (b.get('text') or '').encode('utf-8')


SECRET_HEADERS = ('authorization', 'token', 'cookie', 'set-cookie', 'x-auth-token', 'password', 'proxy-authorization')


def headers_of(h):
    """Request / response headers for the record ({name: value}); token / authorization / cookie values masked."""
    if not h: return None
    items = h.items() if hasattr(h, 'items') else h
    return {str(k): '<hidden>' if str(k).lower() in SECRET_HEADERS and v else str(v) for k, v in items}


def http(method, url, req, status, resp, ms, error=None, reqh=None, resph=None, **extra):
    """A REST call: whole bodies (see _body), the headers (secrets masked) when given; extra: via = the interface it was
    bound to (a processor sharing its IP with one on another network)."""
    host = url.split('/')[2] if '://' in url else ''
    with _lock:
        L = _link(host); L['tx'] += 1; L['last'] = time.time()
        if status is not None: L['rx'] += 1; L['rtt_sum'] += ms; L['rtt_n'] += 1; L['rtt_max'] = max(L['rtt_max'], ms)
        if error: L['err'] += 1; L['last_err'] = error
    f = {'link': host, 'method': method, 'url': url, 'req': _body(req, 'req'), 'status': status, 'resp': _body(resp, 'resp'), 'ms': round(ms, 1)}
    if reqh: f['reqh'] = headers_of(reqh)
    if resph: f['resph'] = headers_of(resph)
    if error: f['error'] = error
    f.update((k, v) for k, v in extra.items() if v not in (None, ''))
    return record('http', **f)


def op(route, phase, **f):
    return record('op', route=route, phase=phase, **f)


def mark(text, source='user'):
    return record('mark', text=str(text)[:500], source=source)


def set_enabled(on):
    with _lock:
        _st['enabled'] = bool(on)
        if not on and _st['fh'] is not None:
            _st['fh'].close(); _st['fh'] = None
    return status()


# ------------------------------------------------------------------ reading back
def status():
    with _lock:
        links = {k: {'tx': v['tx'], 'rx': v['rx'], 'err': v['err'], 'nocard': v.get('nocard', 0), 'last_err': v['last_err'],
                     'rtt_avg': round(v['rtt_sum'] / v['rtt_n'], 2) if v['rtt_n'] else None, 'rtt_max': round(v['rtt_max'], 2),
                     'ago': round(time.time() - v['last'], 1) if v['last'] else None} for k, v in _st['links'].items()}
        w = _st['werr']
        return {'ok': True, 'enabled': _st['enabled'], 'file': _st['file'], 'dir': DIAG_DIR, 'seq': _st['seq'],
                'counts': dict(_st['counts']), 'links': links, 'since': _st['started'], 'lost': _st['lost'],
                'writeError': dict(w, held=len(_st['backlog']), lost=_st['lost']) if w else None}


def helper_errors():
    with _lock: return list(_herr)


def frames(since=0, limit=500):
    with _lock:
        out = [r for r in _ring if r['seq'] > since]
    return out[-limit:]


def files():
    out = []
    if os.path.isdir(DIAG_DIR):
        for day in sorted(os.listdir(DIAG_DIR), reverse=True):
            d = os.path.join(DIAG_DIR, day)
            if not os.path.isdir(d): continue
            for f in sorted(os.listdir(d), reverse=True):
                if f.endswith(('.nwl', '.nwl.gz')):
                    p = os.path.join(d, f)
                    out.append({'name': day + '/' + f, 'size': os.path.getsize(p), 'mtime': os.path.getmtime(p), 'current': p == _st['file']})
    return out


def session(max_each=8 * 1024 * 1024, max_total=24 * 1024 * 1024):
    """This helper run's recordings (the files named _<pid>.nwl[.gz]), newest first, as text for the support bundle:
    [{name, text, n, cut}] - the end of each file when it is over max_each, older files left out over max_total."""
    tag, out, total = '_%d.nwl' % os.getpid(), [], 0
    for f in files():
        if tag not in f['name'] or total >= max_total: continue
        p = path_of(f['name'])
        try:
            with (gzip.open(p, 'rb') if p.endswith('.gz') else open(p, 'rb')) as fh: b = fh.read()
        except OSError:
            continue
        keep = min(max_each, max_total - total); cut = len(b) > keep
        if cut: b = b[-keep:]; b = b[b.find(b'\n') + 1:]          # whole lines only
        total += len(b)
        out.append({'name': f['name'], 'text': b.decode('utf-8', 'replace'), 'n': f['size'], 'cut': cut})
    return out


def path_of(name):
    p = os.path.realpath(os.path.join(DIAG_DIR, *str(name).replace('\\', '/').split('/')))
    if not p.startswith(os.path.realpath(DIAG_DIR) + os.sep) or not os.path.isfile(p): raise KeyError('no such capture')
    return p


def load(name, limit=200000):
    p = path_of(name)
    op_ = gzip.open if p.endswith('.gz') else open
    out = []
    with op_(p, 'rt', encoding='utf-8', errors='replace') as f:
        for line in f:
            try: out.append(json.loads(line))
            except ValueError: continue
            if len(out) >= limit: break
    return upgrade(out)


def upgrade(records):
    """Recordings made before stray() existed called echoes and late replies 'junk': sort those out the same way now
    (a record that splits gets seq + .1, .2 …)."""
    sent, pend, out = {}, {}, []
    for r in records:
        k, link = r.get('kind'), r.get('link')
        if k == 'tg' and r.get('hex') and r.get('d'):
            if r.get('dir') == 'tx':
                sent.setdefault(link, collections.deque(maxlen=SENT_KEEP)).append((r['seq'], bytes.fromhex(r['hex'])))
                pend[(link, r['d']['serial'])] = r['t']
            else: pend.pop((link, r['d']['serial']), None)
        if k != 'junk' or not r.get('hex'):
            out.append(r); continue
        try: parts = split_frames(bytes.fromhex(r['hex']))
        except ValueError: parts = []
        if not any(f for f, _ in parts):
            out.append(r); continue
        for i, (is_frame, b) in enumerate(parts):
            base = {'seq': r['seq'] + i / 10.0 if i else r['seq'], 't': r['t']}
            if is_frame and b[0] == 0x55:
                x = dict(base, kind='echo', **_echo_rec(link, b, sent.get(link, ()), r.get('note', '')))
            elif is_frame:
                p = decode(b); x = dict(base, kind='tg', link=link, dir='rx', hex=b.hex(), d=p[0], sum=summary(*p), late=True)
                t0 = pend.pop((link, p[0]['serial']), None)
                if t0 is not None: x['rtt'] = round((r['t'] - t0) * 1000, 2)
                if r.get('note'): x['note'] = r['note']
            else:
                x = dict(base, kind='junk', link=link, hex=b.hex(), n=len(b))
                if r.get('note'): x['note'] = r['note']
            out.append(x)
    return out


# ------------------------------------------------------------------ Wireshark (.pcap) export
def _ip4(host, table):
    try: return socket.inet_aton(host.split('%')[0])   # "192.168.0.11%Ethernet 3": a processor reached through one interface
    except OSError:
        if host not in table: table[host] = bytes([10, 99, 1, len(table) % 250 + 1])
        return table[host]


def _csum(b):
    if len(b) % 2: b += b'\0'
    s = sum(struct.unpack('!%dH' % (len(b) // 2), b)); s = (s >> 16) + (s & 0xFFFF); s += s >> 16
    return ~s & 0xFFFF


def _pkt(t, src, dst, proto, l4):
    ip = struct.pack('!BBHHHBBH4s4s', 0x45, 0, 20 + len(l4), 0, 0x4000, 64, proto, 0, src, dst)
    ip = ip[:10] + struct.pack('!H', _csum(ip)) + ip[12:]
    eth = b'\x02\x00\x00\x00\x00\x02' + b'\x02\x00\x00\x00\x00\x01' + b'\x08\x00'
    frame = eth + ip + l4
    sec = int(t); us = int(round((t - sec) * 1e6))
    if us >= 1000000: sec += 1; us -= 1000000
    return struct.pack('<IIII', sec, us, len(frame), len(frame)) + frame


def to_pcap(records):
    """Records -> a classic .pcap (Ethernet). The computer is 10.99.0.1; frames ride on one TCP stream per link (no
    handshake, sequence numbers continuous), each HTTP call on its own stream, discovery as UDP, marks as UDP to port 9.
    Echoes, late replies and stray bytes go on the link's stream from the processor's side, as they arrived. A USB /
    serial link ("usb:0483:5720@0-1", "serial:COM3") gets a made-up host 10.99.1.n on port 5200 (the plug-in decodes it
    there) and a note saying which link it stands for. Nothing is cut: big payloads go out as several TCP segments (Wireshark
    reassembles them), HTTP with its recorded headers and whole bodies (side files read back), notes longer than a packet
    as numbered parts. USB wrapper blocks (kind usb) are notes, not stream bytes."""
    me, hosts, out = b'\x0a\x63\x00\x01', {}, [struct.pack('<IHHiIII', 0xA1B2C3D4, 2, 4, 0, 0, 262144, 1)]
    streams, nextport, SEG = {}, [50000], 16000

    def tcp(t, sp, dp, src, dst, key, payload):
        for i in range(0, max(len(payload), 1), SEG):
            part = payload[i:i + SEG]
            seq = streams.get(key, 1000); streams[key] = seq + len(part)
            ack = streams.get(key[::-1] if isinstance(key, tuple) else key, 1000)
            hdr = struct.pack('!HHIIBBHHH', sp, dp, seq, ack, 5 << 4, 0x18, 65535, 0, 0)
            out.append(_pkt(t, src, dst, 6, hdr + part))

    def note(t, k, r):
        txt = ('OpenNova %s: ' % k + json.dumps({x: y for x, y in r.items() if x not in ('seq', 't', 'kind')}, ensure_ascii=False, default=str)).encode('utf-8')
        parts = [txt[i:i + 1400] for i in range(0, len(txt), 1400)] or [b'']
        for i, p in enumerate(parts):
            if len(parts) > 1: p = ('OpenNova part %d/%d: ' % (i + 1, len(parts))).encode() + p if i else p + (' [part 1/%d]' % len(parts)).encode()
            out.append(_pkt(t, me, b'\x0a\x63\x00\xfe', 17, struct.pack('!HHHH', 9, 9, 8 + len(p), 0) + p))

    def hdrs(h, extra):
        h = dict(h or {}); h.update({k: v for k, v in extra.items() if not any(x.lower() == k.lower() for x in h)})
        return ''.join('%s: %s\r\n' % (k, v) for k, v in h.items() if k.lower() != 'content-length')

    for r in records:
        k, t = r.get('kind'), r.get('t', 0)
        usbst = k == 'usb' or k == 'junk' and str(r.get('note', '')).startswith('USB status')   # the USB wrapper's blocks, not stream bytes
        if k in ('tg', 'echo', 'junk') and r.get('hex') and r.get('link') and not usbst:
            host, _, port = r['link'].rpartition(':')
            if not port.isdigit():                                  # a USB / serial link: a made-up host on 5200
                if r['link'] not in hosts: note(t, 'link', {'link': r['link'], 'shown as': '%s:5200' % socket.inet_ntoa(_ip4(r['link'], hosts))})
                host, port = r['link'], '5200'
            ip, port = _ip4(host, hosts), int(port or 0)
            if r['link'] not in streams: streams[r['link']] = nextport[0]; nextport[0] += 1
            lp = streams[r['link']]
            data = bytes.fromhex(r['hex'])
            if k == 'tg' and r.get('dir') == 'tx': tcp(t, lp, port, me, ip, (lp, port), data)
            else: tcp(t, port, lp, ip, me, (port, lp), data)
        elif k == 'http':
            host = r.get('link') or '0.0.0.0:80'
            h, _, port = host.rpartition(':') if ':' in host else (host, '', '80')
            ip, port, lp = _ip4(h, hosts), int(port or 80), nextport[0]; nextport[0] += 1
            path = '/' + r['url'].split('/', 3)[3] if r['url'].count('/') >= 3 else r['url']
            rb = body_bytes(r.get('req'))
            req = ('%s %s HTTP/1.1\r\n%sContent-Length: %d\r\n\r\n' % (r['method'], path, hdrs(r.get('reqh'), {'Host': host, 'Content-Type': 'application/json'}), len(rb))).encode('utf-8', 'replace') + rb
            tcp(t, lp, port, me, ip, (lp, port), req)
            if r.get('status') is not None:
                sb = body_bytes(r.get('resp'))
                res = ('HTTP/1.1 %d X\r\n%sContent-Length: %d\r\n\r\n' % (r['status'], hdrs(r.get('resph'), {'Content-Type': 'application/json'}), len(sb))).encode('utf-8', 'replace') + sb
                tcp(t + r.get('ms', 0) / 1000.0, port, lp, ip, me, (port, lp), res)
            elif r.get('error'): note(t + r.get('ms', 0) / 1000.0, 'http error', {'url': r['url'], 'error': r['error'], 'act': r.get('act')})
        elif k == 'udp':
            h, _, port = r['peer'].rpartition(':'); ip, port = _ip4(h, hosts), int(port or 0)
            data = bytes.fromhex(r.get('hex', ''))
            src, dst, sp, dp = (me, ip, 50999, port) if r['dir'] == 'tx' else (ip, me, port, 50999)
            out.append(_pkt(t, src, dst, 17, struct.pack('!HHHH', sp, dp, 8 + len(data), 0) + data))
        elif k in ('mark', 'op', 'err', 'conn') or usbst:
            note(t, k, r)               # an 'err' from the helper itself (link 'helper') carries its traceback ('where')
    return b''.join(out)


# ------------------------------------------------------------------ Wireshark / tcpdump capture import
def _packets(buf):
    """(t, linktype, bytes) for every packet of a .pcap or .pcapng."""
    if len(buf) < 24: raise ValueError('not a capture file')
    magic = buf[:4]
    if magic in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\xc3\xd4', b'\xa1\xb2\x3c\x4d'):
        e = '<' if magic[0] in (0xd4, 0x4d) else '>'
        ns = magic in (b'\x4d\x3c\xb2\xa1', b'\xa1\xb2\x3c\x4d')
        lt = struct.unpack_from(e + 'I', buf, 20)[0] & 0x0FFFFFFF; o = 24
        while o + 16 <= len(buf):
            s, us, cap, _ = struct.unpack_from(e + 'IIII', buf, o); o += 16
            yield s + us / (1e9 if ns else 1e6), lt, buf[o:o + cap]; o += cap
        return
    if magic != b'\x0a\x0d\x0d\x0a': raise ValueError('not a .pcap / .pcapng file')
    o, e, ifs = 0, '<', []
    while o + 12 <= len(buf):
        if buf[o:o + 4] == b'\x0a\x0d\x0d\x0a':
            e = '<' if buf[o + 8:o + 12] == b'\x4d\x3c\x2b\x1a' else '>'; ifs = []
        btype, blen = struct.unpack_from(e + 'II', buf, o)
        if blen < 12: break
        body = buf[o + 8:o + blen - 4]
        if btype == 1:   # interface: link type, then options; if_tsresol (9) = timestamp units (Windows Wireshark: 10^-9)
            res, oo = 1e6, 8
            while oo + 4 <= len(body):
                code, ln = struct.unpack_from(e + 'HH', body, oo)
                if code == 0: break
                if code == 9 and ln >= 1:
                    v = body[oo + 4]; res = float(2 ** (v & 0x7F)) if v & 0x80 else float(10 ** v)
                oo += 4 + ln + (-ln) % 4
            ifs.append([struct.unpack_from(e + 'H', body, 0)[0], res])
        elif btype == 6 and len(body) >= 20:
            iid, hi, lo, cap, _ = struct.unpack_from(e + 'IIIII', body, 0)
            lt, res = ifs[iid] if iid < len(ifs) else (1, 1e6)
            yield ((hi << 32) | lo) / res, lt, body[20:20 + cap]
        elif btype == 3 and ifs:
            yield 0.0, ifs[0][0], body[4:]
        o += blen


def _ip_of(lt, p):
    if lt == 1:   # Ethernet (+ VLAN tags)
        o, et = 14, struct.unpack_from('!H', p, 12)[0] if len(p) >= 14 else 0
        while et in (0x8100, 0x88A8) and len(p) >= o + 4: et = struct.unpack_from('!H', p, o + 2)[0]; o += 4
        return p[o:] if et == 0x0800 else None
    if lt in (0, 108): return p[4:] if len(p) > 4 and p[4] >> 4 == 4 else None      # BSD loopback (macOS lo0)
    if lt == 113: return p[16:] if struct.unpack_from('!H', p, 14)[0] == 0x0800 else None   # Linux cooked
    if lt == 276: return p[20:] if struct.unpack_from('!H', p, 0)[0] == 0x0800 else None    # Linux cooked v2
    if lt in (101, 228, 12): return p if p[:1] and p[0] >> 4 == 4 else None                 # raw IPv4
    return None


def from_capture(buf):
    """A Wireshark / tcpdump capture -> records like the recorder's: NovaLCT frames on any TCP port (found by their
    55 AA / AA 55 header; streams reassembled in order, retransmissions dropped), discovery on UDP 3800 / 5600 / 54622,
    HTTP request / status lines on other TCP streams. The processor is the side on TCP 5200-5232, else the side the first
    55 AA frame went to; 55 AA frames from the processor are echoes of our requests."""
    out, flows, http_seen, proc, sent, alias = [], {}, set(), {}, {}, {}
    seen = collections.OrderedDict()   # the same IP packet logged twice (Windows pktmon: once per edge / adapter) counts once
    for t, lt, p in _packets(buf):
        ip = _ip_of(lt, p)
        if not ip or len(ip) < 20: continue
        ihl = (ip[0] & 15) * 4; proto = ip[9]; src, dst = socket.inet_ntoa(ip[12:16]), socket.inet_ntoa(ip[16:20])
        tot = struct.unpack_from('!H', ip, 2)[0] or len(ip)
        l4 = ip[ihl:tot]
        dk = (ip[4:6], ip[12:20], proto, tot, bytes(l4[:16]))
        if ip[4:6] != bytes(2):
            if dk in seen and t - seen[dk] < 1.0: continue
            seen[dk] = t
            if len(seen) > 4096: seen.popitem(last=False)
        if proto == 17 and len(l4) >= 8:
            sp, dp = struct.unpack_from('!HH', l4, 0); data = l4[8:]
            if dp == 9 and data.startswith(b'OpenNova link: '):      # our own .pcap: which USB / serial link a made-up host is
                try: j = json.loads(data[15:].decode('utf-8')); alias[j['shown as']] = j['link']
                except (ValueError, KeyError, TypeError): pass
            coex = sp in COEX_UDP or dp in COEX_UDP     # VMP / COEX: announcements 54622-54624, backup discovery 54700
            if 3800 in (sp, dp) or 5600 in (sp, dp) or coex:
                tx = dp in (3800, 5600) and not data.startswith(b'rpProMI')   # COEX: the controller announces itself (rx)
                peer = (dst, dp) if tx else (src, sp)
                txt = data.decode('utf-8', 'replace') if data[:1] in (b'r', b'{') else ''
                r = {'seq': len(out) + 1, 't': t, 'kind': 'udp', 'dir': 'tx' if tx else 'rx', 'peer': '%s:%s' % peer, 'hex': data.hex(), 'n': len(data),
                     'proto': 'coex' if coex else {3800: 'nova', 5600: 'unico'}.get(dp if tx else sp, ''), 'cli': '%s:%s' % ((src, sp) if tx else (dst, dp))}
                if txt: r['text'] = txt
                out.append(r)
            continue
        if proto != 6 or len(l4) < 20: continue
        sp, dp, seq = struct.unpack_from('!HHI', l4, 0); off = (l4[12] >> 4) * 4; data = l4[off:]
        if not data: continue
        key = (src, sp, dst, dp); f = flows.setdefault(key, {'next': None, 'buf': b'', 't': t})
        if f['next'] is not None:
            d = (seq - f['next']) & 0xFFFFFFFF
            if d >= 0x80000000:                      # old / overlapping (retransmission): keep only the new part
                skip = (f['next'] - seq) & 0xFFFFFFFF
                if skip >= len(data): continue
                data = data[skip:]; seq = f['next']
            elif d:
                out.append({'seq': len(out) + 1, 't': t, 'kind': 'err', 'link': '%s:%d' % (dst, dp), 'error': 'capture gap: %d bytes missing' % d})
                f['buf'] = b''
        f['next'] = (seq + len(data)) & 0xFFFFFFFF; f['buf'] += data
        b = f['buf']
        while True:
            i = min([x for x in (b.find(b'\x55\xAA'), b.find(b'\xAA\x55')) if x >= 0], default=-1)
            if i < 0 or len(b) - i < 20: break
            n = frame_data_len(b[i:i + 20])
            if n > 65000 or b[i + 4:i + 5] not in (b'\xFE', b'\x00') and b[i] == 0x55: b = b[i + 1:]; continue
            if len(b) - i < 20 + n: break
            fr, skipped = b[i:i + 20 + n], b[:i]; b = b[i + 20 + n:]
            ck = frozenset(((src, sp), (dst, dp)))
            if skipped and ck in proc:                     # bytes between frames on a NovaStar stream
                out.append({'seq': len(out) + 1, 't': t, 'kind': 'junk', 'link': '%s:%d' % proc[ck], 'hex': skipped.hex(), 'n': len(skipped)})
            if ck not in proc:
                proc[ck] = (src, sp) if sp in PROC_PORTS and dp not in PROC_PORTS else (dst, dp) if dp in PROC_PORTS and sp not in PROC_PORTS \
                    else (dst, dp) if fr[0] == 0x55 else (src, sp)
            from_proc = proc[ck] == (src, sp)
            link = '%s:%d' % proc[ck]; cli = '%s:%d' % ((dst, dp) if from_proc else (src, sp))   # cli: the program's side (netcap names it)
            if fr[0] == 0x55 and from_proc:                # our request coming back
                r = dict(_echo_rec(link, fr, sent.get(link, ())), seq=len(out) + 1, t=t, kind='echo', cli=cli)
                out.append(r); continue
            p = decode(fr); r = {'seq': len(out) + 1, 't': t, 'kind': 'tg', 'link': link, 'dir': 'rx' if from_proc else 'tx', 'hex': fr.hex(), 'cli': cli}
            if p: r['d'] = p[0]; r['sum'] = summary(*p)
            if not from_proc: sent.setdefault(link, collections.deque(maxlen=SENT_KEEP)).append((r['seq'], fr))
            out.append(r)
        f['buf'] = b[-65536:] if len(b) > 65536 else b
        head = data[:200]
        if (head[:4] in (b'GET ', b'PUT ', b'POST', b'DELE', b'HTTP')) and (key, len(out)) not in http_seen:
            line = head.split(b'\r\n', 1)[0].decode('latin1')
            out.append({'seq': len(out) + 1, 't': t, 'kind': 'http', 'link': '%s:%d' % ((dst, dp) if not head.startswith(b'HTTP') else (src, sp)),
                        'cli': '%s:%d' % ((src, sp) if not head.startswith(b'HTTP') else (dst, dp)),
                        'method': line.split(' ')[0], 'url': line, 'req': None, 'status': None, 'resp': None, 'ms': 0, 'imported': True})
    # round-trip times: a reply after the request with its serial on the same link
    pend = {}
    for r in out:
        if r['kind'] != 'tg' or 'd' not in r: continue
        k = (r['link'], r['d']['serial'])
        if r['dir'] == 'tx': pend[k] = r['t']
        elif k in pend: r['rtt'] = round((r['t'] - pend.pop(k)) * 1000, 2)
    for r in out:
        if r.get('link') in alias: r['link'] = alias[r['link']]
    return out


def save_import(name, records):
    """Keep an imported capture next to the recordings (diagnostics/imported/<name>.nwl) so it can be opened again."""
    d = os.path.join(DIAG_DIR, 'imported'); os.makedirs(d, exist_ok=True)
    base = ''.join(c if c.isalnum() or c in '-_.' else '_' for c in os.path.splitext(os.path.basename(name))[0])[:60] or 'capture'
    p = os.path.join(d, time.strftime('%Y%m%d-%H%M%S_') + base + '.nwl')
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        for r in records: f.write(json.dumps(r, ensure_ascii=False, separators=(',', ':')) + '\n')
    return 'imported/' + os.path.basename(p)
