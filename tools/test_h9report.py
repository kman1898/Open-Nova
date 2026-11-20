"""test_h9report.py - what an H9 tester's report showed (2026-11-19), helper side: "no receiving card here" replies (ack 1)
aren't link errors; identify stays on the backup once a port's cards answer only there; the H 16-port card's function
table (status 4) falls back to the FreeRoute byte or says "not available"; the H's MVR card (0x7B47) is never asked for a
sending card's table; one processor heard on two adapters of the same network is listed once (same MAC in the ARP table),
two isolated networks stay two. The second report (2026-11-20): the H9 answers a read past the end of a cabled chain only
after ~500 ms, in order, so detect waits for that late answer before its next read (no more "port 2: 0 cards" one run, 14
the next); a processor that stays silent there keeps its fast detect. Stdlib only, stand-ins only (no hardware)."""
import os
import socket
import struct
import sys
import tempfile
import threading
import time

DIAG = tempfile.mkdtemp(prefix='opennova_diag_test_')
os.environ['OPENNOVA_DIAG'] = DIAG
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import alpha       # noqa: E402
import netif       # noqa: E402
import novalink    # noqa: E402
import wirelog     # noqa: E402

fails = 0


def ok(cond, text, *more):
    global fails
    print(('PASS ' if cond else 'FAIL ') + text + ('' if cond or not more else '  %r' % (more,)))
    if not cond: fails += 1


def tg_server(answer):
    """A stand-in TG processor: answer(dst, dev, port, card, addr, n) -> (status, data)."""
    s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen(4)
    def run():
        while True:
            try: c, _ = s.accept()
            except OSError: return
            buf = b''
            while True:
                try: d = c.recv(65536)
                except OSError: break
                if not d: break
                buf += d
                while len(buf) >= 20:
                    n = struct.unpack_from('<H', buf, 16)[0]; op = buf[10]; ln = 20 + (n if op == 1 else 0)
                    if len(buf) < ln: break
                    req, buf = buf[:ln], buf[ln:]
                    dst, dev, port = req[5], req[6], req[7]
                    card, addr = struct.unpack_from('<H', req, 8)[0], struct.unpack_from('<I', req, 12)[0]
                    got = answer(dst, dev, port, card, addr, n)
                    if got is None: continue                                   # a processor that stays silent
                    st, data = got
                    h = bytearray(req[:18]); h[0], h[1], h[2] = 0xAA, 0x55, st
                    struct.pack_into('<H', h, 16, len(data)); b = bytes(h) + data
                    c.sendall(b + struct.pack('<H', (0x5555 + sum(b[2:])) & 0xFFFF))
            c.close()
    threading.Thread(target=run, daemon=True).start()
    return s


# ------------------------------------------------------------------ ack 1 to a receiving-card read = no card there, not an error
def answer(dst, dev, port, card, addr, n):
    if dev == 0 and addr == 2: return 0, struct.pack('<H', 0x7B46)
    if dev == 0 and addr == 0x02020020: return 4, b''               # the H 16-port card: unknown command
    if dev == 0 and addr == 0x02020024: return 0, bytes([0x40])      # … but the FreeRoute byte alone answers
    if dev == 1: return (0, bytes(n)) if card < 2 else (1, b'')       # two cards on the port, then nobody
    return 2, b''


srv = tg_server(answer)
host, port = srv.getsockname()
link = novalink.TcpLink(host, port, 2.0)
tag = '%s:%d' % (host, port)
link.read(1, 0, 0, 1, 0x02000000, 16)
try: link.read(1, 0, 0, 2, 0x02000000, 16); got = None
except novalink.LinkError as e: got = e
ok(isinstance(got, novalink.NoCard) and 'status 1' in str(got), 'ack 1 to a receiving-card read raises NoCard (a LinkError: callers unchanged)', got)
L = wirelog.status()['links'][tag]
ok(L['err'] == 0 and L['nocard'] == 1, 'the recorder counts it as "no card", not as a link error', L)
recs = [r for r in wirelog.frames(0, 500) if r.get('link') == tag]
ok(any(r.get('kind') == 'tg' and r.get('dir') == 'rx' and r.get('nocard') for r in recs) and not any(r.get('kind') == 'err' for r in recs),
   'the reply is recorded with nocard, no "err" record')
try: link.read(0, 0, 0, 0, 0x02000099, 4); got = None
except novalink.LinkError as e: got = e
L = wirelog.status()['links'][tag]
ok(got is not None and not isinstance(got, novalink.NoCard) and L['err'] == 1, 'any other refused read still counts as an error', L)

# action summary (REPORT.md "Actions"): nocard replies don't count as errors
acts = alpha.actions([{'act': 'a1', 'kind': 'tg', 'dir': 'rx', 't': 1, 'd': {'status': 1}, 'nocard': True},
                      {'act': 'a1', 'kind': 'tg', 'dir': 'rx', 't': 2, 'd': {'status': 4}}])
ok(acts and acts[0]['errors'] == 1, 'action summary: a nocard reply isn\'t an error, a status 4 is', acts)

# ------------------------------------------------------------------ the function table on the H 16-port card
f = novalink.sender_functions(link, 0)
ok(f.get('freeRoute') is True and f.get('byte4') == '40' and not f.get('error'), 'status 4 to the 64-byte table: the FreeRoute byte alone is read', f)
link.close(); srv.close()

srv = tg_server(lambda dst, dev, port, card, addr, n: (0, struct.pack('<H', 0x7B46)) if addr == 2 else (4, b''))
link = novalink.TcpLink(*srv.getsockname(), 2.0)
f = novalink.sender_functions(link, 0)
ok(f.get('unsupported') is True and 'not available on this card' in f.get('error', ''), 'both refused: "not available on this card"', f)
link.close(); srv.close()
ok(0x7B47 in novalink.NON_LED_CARDS, 'the H MVR card (0x7B47) is known not to be a sending card (no function table asked)')

# ------------------------------------------------------------------ identify: once a port answers only via the backup, stay there
class Stand:
    """A link whose port 0 primary is dead (every read: no card); the backup (port 8) has 9 cards."""
    def __init__(self): self.calls = []
    def read(self, dev, dst, port, card, addr, n, r2=0, timeout=None):
        self.calls.append((dst, port, card, addr))
        if port == 0: raise novalink.NoCard(novalink.NoCard.TEXT)
        if card >= 9: raise novalink.NoCard(novalink.NoCard.TEXT)
        return bytes(n)


st = Stand()
out = novalink.identify(st, [{'dst': 0, 'ports': {'0': 9}}], lambda *a: None, full=True, pairs=[{'ps': 0, 'pp': 0, 'bs': 0, 'bp': 8}])
prim = [c for c in st.calls if c[1] == 0]
ok(len(out) == 9 and all(o['id'] is not None for o in out), 'every card read through the backup', [o['id'] is None for o in out])
ok(len(prim) == 1, 'the dead primary is asked once, then the rest of the port is read on the backup (%d primary reads)' % len(prim))

# ------------------------------------------------------------------ the same processor on two adapters of one network
e = [{'ip': '192.0.2.10', 'iface': 'Show A', 'text': 'App'}, {'ip': '192.0.2.10', 'iface': 'Show B', 'text': 'App'}, {'ip': '192.0.2.12', 'iface': 'Show A'}]
r = netif.same_ip([dict(x) for x in e], macs=lambda ip: {'Show A': '00:1a:2b:3c:4d:5e', 'Show B': '00:1a:2b:3c:4d:5e'})
ok(len(r) == 2 and r[0]['ip'] == '192.0.2.10' and not r[0].get('conflict') and r[0]['also'] in (['Show A'], ['Show B']),
   'same MAC behind both adapters: one entry, plain address, the other adapter kept as "also"', r)
r = netif.same_ip([dict(x) for x in e], macs=lambda ip: {'Show A': '00:1a:2b:3c:4d:5e', 'Show B': '00:1a:2b:3c:4d:5f'})
ok(len(r) == 3 and r[0]['ip'] == '192.0.2.10%Show A' and 'Two networks' in r[0]['conflict'], 'different MACs: two isolated networks, as before', r)
r = netif.same_ip([dict(x) for x in e], macs=lambda ip: {'Show A': '00:1a:2b:3c:4d:5e'})
ok(len(r) == 3 and r[1]['ip'] == '192.0.2.10%Show B', 'a MAC not known on one side: kept apart (never merge two processors by guess)', r)

ok(netif.parse_arp('? (192.0.2.10) at 0:1a:2b:3c:4d:5e on en0 ifscope [ethernet]\n? (192.0.2.10) at 0:1a:2b:3c:4d:5e on en17 ifscope [ethernet]\n'
                   '? (192.0.2.1) at 1:2:3:4:5:6 on en0\n? (192.0.2.10) at (incomplete) on en5', '192.0.2.10')
   == {'en0': '00:1a:2b:3c:4d:5e', 'en17': '00:1a:2b:3c:4d:5e'}, 'ARP table, macOS: per interface, incomplete left out')
ok(netif.parse_arp('IP address       HW type     Flags       HW address            Mask     Device\n'
                   '192.0.2.10       0x1         0x2         00:1a:2b:3c:4d:5e     *        eth1\n', '192.0.2.10') == {'eth1': '00:1a:2b:3c:4d:5e'},
   'ARP table, Linux /proc/net/arp')
ok(netif.parse_arp('\nInterface: 192.0.2.5 --- 0x7\n  Internet Address      Physical Address      Type\n  192.0.2.10            00-1a-2b-3c-4d-5e     dynamic\n'
                   '  192.0.2.100           00-1a-2b-3c-4d-60     dynamic\n', '192.0.2.10', {'192.0.2.5': 'Ethernet'}) == {'Ethernet': '00:1a:2b:3c:4d:5e'},
   'ARP table, Windows arp -a (the interface by its address; 192.0.2.100 isn\'t 192.0.2.10)')

# REPORT.md: Monitor's errors kept until Clear, as the tester saw them (the one fibre event, the layout-vs-cable gap)
hh = {'info': {'version': '0.0.0-test', 'build': 'test', 'alpha': True, 'channel': 'alpha', 'reportContact': ''}, 'readOnly': True, 'when': 'now',
      'tester': {}, 'firstContacts': [], 'line': 'Open Nova test', 'platform': 'test', 'python': '3', 'recorder': 'off', 'writes': [],
      'status': {'counts': {}, 'links': {}}, 'helperErrors': [], 'timeline': [], 'files': []}
mon = [{'t': '2026-11-19T19:09:43.000Z', 'ended': '', 'level': 'error', 'dev': 'H9', 'where': 'S2', 'text': 'OPT1 fiber: no link — ports 1–8 running on backup (OPT2)', 'n': 1},
       {'t': '2026-11-19T19:09:43.000Z', 'ended': '2026-11-19T19:10:00.000Z', 'level': 'warning', 'dev': 'H9', 'where': 'S2 P1', 'text': '10 cabinets mapped, 5 answer', 'n': 2}]
md = alpha.report_md({'summary': {'app': {}, 'monitor': mon}}, hh)
ok('## Monitor (errors kept until Clear)' in md and '| 19:09:43 | going on | error | H9 | S2 | OPT1 fiber: no link — ports 1–8 running on backup (OPT2) | 1 |' in md
   and '| 19:09:43 | 19:10:00 | warning | H9 | S2 P1 | 10 cabinets mapped, 5 answer | 2 |' in md, 'REPORT.md lists Monitor kept errors (going on / ended)')
ok('## Monitor' not in alpha.report_md({'summary': {'app': {}}}, hh), 'REPORT.md: no Monitor section when nothing is kept')

# ------------------------------------------------------------------ the end probe the H9 answers late (second report, 2026-11-20)
SLOW = 0.8      # the H9: ~500 ms (957 ms when two queued); longer here so a request sent behind it surely misses its time
def chains(silent):
    def answer(dst, dev, port, card, addr, n):
        if dev == 0 and addr == 0x02000000: b = bytearray(n); b[31] = 0b0011; return 0, bytes(b)   # ports 1 and 2 linked
        if dev == 0: return 0, bytes(n)
        if dev == 1 and addr == 0x02000000 and port in (0, 1):
            if card < 14: b = bytearray(32); b[0x17] = b[0x19] = 216; return 0, bytes(b)
            if silent: return None
            time.sleep(SLOW); return 1, b''                       # "no card here", late; the next request waits behind it
        if dev == 1: return 1, b''
        return 2, b''
    return answer


def run_detect(silent):
    srv = tg_server(chains(silent)); h, pt = srv.getsockname()
    lk = novalink.TcpLink(h, pt, 2.0); t0 = time.time(); logs = []
    out = novalink.detect(lk, [{'dst': 0, 'ports': 4}], logs.append)
    took = time.time() - t0; late = getattr(lk, 'late', None); lk.close(); srv.close()
    return {p: len(c) for p, c in out[0]['ports'].items()}, took, late


for k in range(3):
    got, took, late = run_detect(False)
    ok(got == {0: 14, 1: 14} and late is True, 'H9 end probe answered late: both ports 14 cards, every run (run %d, %.1f s)' % (k + 1, took), got)
got, took, late = run_detect(True)
ok(got == {0: 14, 1: 14} and late is False, 'a processor silent past the end: both ports 14 cards, and it isn\'t waited for again', got, late)
ok(took < novalink.OWED_WAIT + 1.0, 'silent past the end: one wait for the late answer at most (%.1f s)' % took)

print('All passed' if not fails else '%d FAILED' % fails)
sys.exit(1 if fails else 0)
