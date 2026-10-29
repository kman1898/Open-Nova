"""Tests for rcvlib.py on a throwaway library folder (never the real one).
    python -I tools\\test_rcvlib.py      (exit code 0 = all passed)
"""
import glob
import json
import os
import sys
import tempfile

TMP = tempfile.mkdtemp(prefix='opennova_lib_test_')
os.environ['OPENNOVA_LIBRARY'] = TMP
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rcvfile   # noqa: E402
import rcvlib    # noqa: E402

SAMPLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'Samples', 'RCFGX NCP')
fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond:
        fails.append(what)


assert rcvlib.LIB_DIR == TMP
files = [f for f in glob.glob(os.path.join(SAMPLES, '**', '*'), recursive=True) if f.lower().endswith(('.rcfgx', '.ncp'))]
if files:
    samples = [(os.path.basename(f), open(f, 'rb').read()) for f in files]
else:   # Samples/RCFGX NCP is private (vendor files, not in the repository): stand-in files, read by a stand-in reader
    print('SKIP the library with the real sample .rcfgx / .ncp files (Samples/RCFGX NCP not here: private); stand-in files used')
    real_identity = rcvfile.identity
    MAGIC = b'OPENNOVA-TEST-FILE '

    def stand_in_identity(src, name=''):
        if isinstance(src, bytes) and src.startswith(MAGIC): return json.loads(src[len(MAGIC):].decode('utf-8'))
        return real_identity(src, name)
    rcvfile.identity = stand_in_identity

    def made(kind, **kw):
        c = rcvfile._blank(); c.update(kw)
        return MAGIC + json.dumps({'kind': kind, 'ok': True, 'cabinets': [c]}).encode('utf-8')
    jp = dict(w=112, h=112, modW=56, modH=14, scan=4, decoder=66, modelId=0x4802, cardName='A10s Pro', mfr='Absen', cabinet='JP8.9 PRO_1_1_1_1',
              ic='MBI5251', decoderName='Decode138ND', ncp=True, fw={'fpga': '1.5.5.98', 'mcu': '1.5.5.98'})
    samples = [('JP8.9 PRO_1_1_1_1_112x112.ncp', made('ncp', **jp)), ('JP8.9 copy.ncp', made('ncp', **jp)),
               ('JP8.9 older firmware.ncp', made('ncp', **dict(jp, fw={'fpga': '1.5.4.0', 'mcu': '1.5.4.0'})))]
    samples += [('rx %d.rcfgx' % i, made('rcfgx', w=w, h=h, modW=w // 2, modH=h // 16, chip=81, scan=13, decoder=1, ic='ICN2053'))
                for i, (w, h) in enumerate([(104, 208), (128, 256), (160, 160), (192, 192), (256, 128), (96, 96)])]
    samples.append(('ca50.ncp', made('ncp', w=640, h=360, modelId=0x4754, cardName='CA50', ncp=True, gen=4, fw={'version': '1.2.0.52'})))
res = [rcvlib.add(data, name) for name, data in samples]
files = samples
dups = sum(1 for r in res if r.get('duplicate'))
ok(all(r['ok'] for r in res), 'all %d sample files added' % len(files))
es = rcvlib.entries()
ok(len(es) == len(files) - dups, '%d entries, %d byte-identical copies recognised as duplicates' % (len(es), dups))
ok(all('ident' not in e for e in es) and all('ident' in e for e in rcvlib.entries(full=True)), 'the listing leaves the identities out; the index keeps them')
bad = rcvlib.add(b'not a file', 'x.rcfgx')
ok(not bad['ok'] and 'not added' in bad['error'], 'a damaged file is refused')

cs = rcvlib.conflicts()
print('       %d cabinet(s) with files of different firmware' % len(cs))
for c in cs[:4]:
    print('       ', c['label'], '|', ', '.join(c['firmware']), '|', len(c['files']), 'files')
ok(all(len({rcvlib.rcvguard.vnorm(f['firmware']) for f in c['files'] if f['firmware']}) > 1 for c in cs), 'every conflict really has more than one firmware')

# a made-up conflict: the same cabinet twice with other firmware
e0 = next(e for e in rcvlib.entries() if e['kind'] == 'ncp')
twin = dict(e0, id='x' * 40, name='twin.ncp', cabinets=[dict(e0['cabinets'][0], firmware='9.9.9.9')])
ok(any(any(f['id'] == 'x' * 40 for f in c['files']) for c in rcvlib.conflicts(rcvlib.entries() + [twin])), 'same cabinet with other firmware is flagged')

# matching: A10s Pro 112x112 MBI5251 1/4 panels running 1.5.5.98 fit the JP8.9 NCP and little else
card = rcvfile._blank(); card.update({'modelId': 0x4802, 'w': 112, 'h': 112, 'modW': 56, 'modH': 14, 'ic': 'MBI5251', 'scan': 4,
                                      'ncp': True, 'mfr': 'Absen', 'cabinet': 'JP8.9 PRO_1_1_1_1', 'fw': {'fpga': '1.5.5.98', 'mcu': '1.5.5.98'}})
m = rcvlib.match([{'where': {'proc': 'P', 'card': 0, 'port': 0, 'index': 0}, 'id': card}], 'lct')
fit = [e['name'] for e in rcvlib.entries() if any(x['level'] in ('ok', 'info', 'warn') for x in m[e['id']])]
print('       fits:', fit)
ok(any('JP8.9 PRO_1_1_1_1' in n for n in fit) and len(fit) < len(es) / 4, 'matching keeps the JP8.9 NCP and drops most others')

rid = es[0]['id']
ok(rcvlib.remove(rid) and not any(e['id'] == rid for e in rcvlib.entries()), 'remove takes it out of the library')
ok(os.path.exists(os.path.join(TMP, '_removed', es[0]['file'])), 'and keeps the file in _removed (never deleted)')
data, name = rcvlib.get(es[1]['id'])
ok(rcvfile.identity(data, name)['ok'], 'get returns the stored file')

print('\n%d failed' % len(fails) if fails else '\nAll passed')
print('(test library left in %s)' % TMP)
sys.exit(1 if fails else 0)
