"""Tests for rcvfile.py + rcvguard.py: the real sample files read cleanly, and the guard's verdicts for each rule.
Without Samples/RCFGX NCP (private, not in the repository) the rules run on made-up identities and the file reading is SKIPPED.
    python -I tools\\test_rcvguard.py        (exit code 0 = all passed)
"""
import copy
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rcvfile    # noqa: E402
import rcvguard   # noqa: E402

SAMPLES = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'Samples', 'RCFGX NCP')
fails = []


def ok(cond, what):
    print(('PASS ' if cond else 'FAIL ') + what)
    if not cond:
        fails.append(what)


def card(**kw):
    c = rcvfile._blank()
    c['ncp'] = None
    c.update(kw)
    return c


def where(i, port=0):
    return {'proc': 'Proc 1', 'card': 0, 'port': port, 'index': i}


# ---- the real files (Samples/RCFGX NCP: vendor files, private, never in the repository). Without them the rules below run on
# identities made here with the same values (what rcvfile.identity returns for those files); reading the files is SKIPPED.
# The two files the checks need are found by what they hold (their names and folders are the user's, not for the repository):
# an A10s Pro 112×112 NCP with firmware 1.5.5.98, and a 4th-generation (CA50) 640×360 NCP.
files = sorted(f for f in glob.glob(os.path.join(SAMPLES, '**', '*'), recursive=True) if f.lower().endswith(('.rcfgx', '.ncp')))
ids = [rcvfile.identity(f) for f in files]
c0 = lambda r: (r.get('cabinets') or [{}])[0]
NCP_FILE = next((f for f, r in zip(files, ids) if r.get('kind') == 'ncp' and c0(r).get('modelId') == 0x4802 and (c0(r).get('w'), c0(r).get('h')) == (112, 112)
                 and (c0(r).get('fw') or {}).get('fpga') == '1.5.5.98'), None)
CX_FILE = next((f for f, r in zip(files, ids) if r.get('kind') == 'ncp' and c0(r).get('gen') == 4 and (c0(r).get('w'), c0(r).get('h')) == (640, 360)), None)
REAL = bool(files) and NCP_FILE is not None and CX_FILE is not None


def made(kind, **kw):
    c = rcvfile._blank(); c.update(kw)
    return {'kind': kind, 'ok': True, 'cabinets': [c]}


if REAL:
    ok(len(files) >= 100 and all(r['ok'] for r in ids), 'all %d sample .rcfgx / .ncp files read (%d failed)' % (len(files), sum(not r['ok'] for r in ids)))
    ncp = rcvfile.identity(NCP_FILE)
    rc = next(r for r, f in zip(ids, files) if f.lower().endswith('.rcfgx') and r['cabinets'][0]['chip'] == 81 and not r['cabinets'][0]['fw'].get('savedWith'))
    rcv = next(r for r, f in zip(ids, files) if f.lower().endswith('.rcfgx') and r['cabinets'][0]['fw'].get('savedWith'))   # records its firmware
    cx = rcvfile.identity(CX_FILE)
else:
    print('SKIP reading the sample .rcfgx / .ncp files, damaged-file and NCP script checks (Samples/RCFGX NCP not here: private); rules run on made-up identities')
    cp0 = {'manufactureName': 'Absen', 'cabinetName': 'JP8.9 PRO_1_1_1_1', 'cardModel': 'A10s Pro', 'status': 'Released', 'version': '1.5.5.98', 'issue': 4}
    ncp = made('ncp', w=112, h=112, modW=56, modH=14, scan=4, decoder=66, groups=1, grey=16, refN=64, modelId=0x4802, cardName='A10s Pro',
               mfr='Absen', cabinet='JP8.9 PRO_1_1_1_1', ic='MBI5251', decoderName='Decode138ND', ncp=True, type='MX', status='Released',
               fw={'version': '1.5.5.98', 'fpga': '1.5.5.98', 'fpgaRemark': 'test FPGA', 'mcu': '1.5.5.98', 'mcuRemark': 'test MCU'},
               sendSeconds=34, cfgParam=cp0)
    ncp.update(formatVersion=3, packName='test pack', creatTime='20260101120000')
    rc = made('rcfgx', w=104, h=208, modW=52, modH=13, chip=81, scan=13, decoder=1, groups=1, grey=14, refN=64, rotation=0, ic='ICN2053')
    rcv = made('rcfgx', w=128, h=256, modW=64, modH=64, chip=0, scan=16, decoder=1, groups=2, grey=12, refN=2, rotation=0, ic='CommonBase',
               fw={'savedWith': '4.2.0.0'}, savedBy='NovaLCT (test)', savedCard='MRV210')
    cx = made('ncp', w=640, h=360, modelId=0x4750, cardName='CA50', mfr='Absen', cabinet='test CX', ic='Chip_XM10480G', decoderName='StaticNoCode',
              ncp=True, fw={'version': '1.2.0.52'}, gen=4, type='CX', status='NovaRelease')
f0 = ncp['cabinets'][0]
ok(ncp['kind'] == 'ncp' and f0['modelId'] == 0x4802 and (f0['w'], f0['h']) == (112, 112) and f0['ic'] == 'MBI5251' and f0['scan'] == 4,
   'NCP identity: A10s Pro 0x4802, 112×112, MBI5251, 1/4 scan')
fr = rc['cabinets'][0]
fv = rcv['cabinets'][0]

# ---- damaged files
bad = rcvfile.identity(b'hello', 'x.rcfgx')
ok(not bad['ok'], 'a non-file is refused')
v = rcvguard.check(bad, 0, [{'where': where(0), 'id': card(w=112, h=112)}], 'lct')
ok(v['level'] == 'block' and v['sendable'] == 0, 'damaged file → BLOCK, nothing sendable')
if REAL:
    data = open(next(f for f in files if f.lower().endswith('.rcfgx')), 'rb').read()
    ok(not rcvfile.identity(data[:len(data) // 2], 'x.rcfgx')['ok'], 'a cut-short .rcfgx is refused')
    # flip a byte inside the .bin of a real rcfgx: the zip CRC or the RCCB Sum16 catches it
    rb = rcvfile.rccb_records
    try:
        import io, zipfile
        z = zipfile.ZipFile(io.BytesIO(data)); binn = [n for n in z.namelist() if n.lower().endswith('.bin')][0]
        b = bytearray(z.read(binn)); b[100] ^= 0xFF
        rb(bytes(b)); ok(False, 'RCCB checksum catches one flipped byte')
    except rcvfile.RcvFileError as e:
        ok('checksum' in str(e), 'RCCB checksum catches one flipped byte (%s)' % e)

# ---- rules
same = card(modelId=0x4802, w=112, h=112, modW=56, modH=14, ic='MBI5251', scan=4, decoderName='Decode138ND', ncp=True,
            mfr='Absen', cabinet='JP8.9 PRO_1_1_1_1', fw={'fpga': '1.5.5.98', 'mcu': '1.5.5.98', 'fpgaRemark': f0['fw'].get('fpgaRemark')})
v = rcvguard.check(ncp, 0, [{'where': where(i), 'id': copy.deepcopy(same)} for i in range(8)], 'lct')
ok(v['level'] in ('ok', 'info') and v['sendable'] == 8 and len(v['groups']) == 1, 'NCP on matching A10s Pro panels → OK (%s)' % v['level'])

xa = dict(same, modelId=0x4816, cardName='XA10-N')
v = rcvguard.check(ncp, 0, [{'where': where(i), 'id': copy.deepcopy(xa)} for i in range(4)], 'lct')
ok(v['level'] == 'block' and any(r['rule'] == 1 for r in v['groups'][0]['reasons']), 'NCP for A10s Pro on XA10-N cards → BLOCK (rule 1)')
print('      ', v['groups'][0]['reasons'][0]['text'])

big = card(w=256, h=256, chip=fr['chip'], scan=fr['scan'], modW=fr['modW'], modH=fr['modH'])
v = rcvguard.check(rc, 0, [{'where': where(i), 'id': big} for i in range(3)], 'lct')
ok(v['level'] == 'block' and any(r['rule'] == 4 for r in v['groups'][0]['reasons']) or (fr['w'], fr['h']) == (256, 256),
   '.rcfgx for %s×%s on 256×256 panels → BLOCK (rule 4)' % (fr['w'], fr['h']))
print('      ', v['groups'][0]['reasons'][0]['text'])

sw = card(w=fr['h'], h=fr['w'], chip=fr['chip'], scan=fr['scan'], modW=fr['modW'], modH=fr['modH'])
if fr['w'] != fr['h']:
    v = rcvguard.check(rc, 0, [{'where': where(0), 'id': sw}], 'lct')
    ok(v['level'] == 'warn' and v['groups'][0]['reasons'][0]['rule'] == '4a', 'swapped W×H → WARN (rotated, rule 4a)')

match = card(w=fr['w'], h=fr['h'], chip=fr['chip'], scan=fr['scan'], modW=fr['modW'], modH=fr['modH'], decoder=fr['decoder'], ncp=False)
other = card(w=fr['w'] + 64, h=fr['h'], chip=fr['chip'], scan=fr['scan'], modW=fr['modW'], modH=fr['modH'], ncp=False)
cards = [{'where': where(i, 0), 'id': match} for i in range(96)] + [{'where': where(i, 4), 'id': other} for i in range(24)]
v = rcvguard.check(rc, 0, cards, 'lct')
ok(v['level'] == 'block' and v['sendable'] == 96 and len(v['groups']) == 2, 'mixed wall 96 + 24 → BLOCK, 96 sendable, 2 groups')

chip = card(w=fr['w'], h=fr['h'], chip=107, scan=fr['scan'], modW=fr['modW'], modH=fr['modH'])
v = rcvguard.check(rc, 0, [{'where': where(0), 'id': chip}], 'lct')
ok(v['level'] == 'block' and any(r['rule'] == 6 for r in v['groups'][0]['reasons']), 'other driver chip → BLOCK (rule 6)')
print('      ', [r['text'] for r in v['groups'][0]['reasons'] if r['rule'] == 6][0])

fu = dict(rc, cabinets=[dict(fr, chip=50, ic=None)])          # a chip code with no known name
a50, b60 = [card(w=fr['w'], h=fr['h'], chip=c, scan=fr['scan'], modW=fr['modW'], modH=fr['modH']) for c in (50, 60)]
v = rcvguard.check(fu, 0, [{'where': where(0), 'id': a50}, {'where': where(1), 'id': b60}], 'lct')
ok(len(v['groups']) == 2 and v['level'] == 'block' and v['sendable'] == 1, 'unnamed chip codes 50 / 60 are separate groups; 60 → BLOCK (audit #4)')

scan = card(w=fr['w'], h=fr['h'], chip=fr['chip'], scan=(fr['scan'] or 4) * 2, modW=fr['modW'], modH=fr['modH'])
v = rcvguard.check(rc, 0, [{'where': where(0), 'id': scan}], 'lct')
ok(v['level'] == 'block' and any(r['rule'] == 7 for r in v['groups'][0]['reasons']), 'other scan → BLOCK (rule 7)')

v = rcvguard.check(rc, 0, [{'where': where(0), 'id': match}, {'where': where(1), 'id': None}], 'lct')
ok(v['level'] == 'warn' and v['sendable'] == 2, 'a cabinet that didn’t answer → WARN, never silently OK')

v = rcvguard.check(rc, 0, [{'where': where(0), 'id': card()}], 'lct')
ok(v['level'] == 'warn' and any('Couldn’t confirm' in u for u in v['groups'][0]['unknown']), 'card reports nothing → WARN "Couldn’t confirm"')

pro = card(modelId=0x4802, w=fr['w'], h=fr['h'], chip=fr['chip'], scan=fr['scan'], modW=fr['modW'], modH=fr['modH'])
ok(rcvguard.check(rc, 0, [{'where': where(0), 'id': pro}], 'coex')['level'] == 'block', '.rcfgx to A10s Pro on MX → BLOCK (rule 3)')
ok(rcvguard.check(rc, 0, [{'where': where(0), 'id': pro}], 'lct')['level'] == 'warn', '.rcfgx to A10s Pro on NovaLCT → WARN (rule 3a)')

ncpc = dict(match, ncp=True, mfr='Absen', cabinet='JP8.9 PRO')
v = rcvguard.check(rc, 0, [{'where': where(0), 'id': ncpc}], 'lct')
ok(v['level'] == 'warn' and any(r['rule'] == '11a' for r in v['groups'][0]['reasons']), '.rcfgx onto NCP-configured panels → WARN (rule 11a)')

stale = {'where': where(0), 'id': other, 'planned': {'w': fr['w'], 'h': fr['h']}}
v = rcvguard.check(rc, 0, [stale], 'lct')
ok(v['level'] == 'warn', 'panels report another size but the project matches the file → WARN, not BLOCK')

v = rcvguard.check(cx, 0, [{'where': where(0), 'id': card(modelId=0x4754, w=640, h=360)}], 'lct')
ok(v['level'] == 'block' and any(r['rule'] == 2 for r in v['groups'][0]['reasons']), '4th-generation CA50 package on a NovaLCT processor → BLOCK (rule 2)')

v = rcvguard.check(ncp, 0, [], 'lct')
ok(v['level'] == 'block' and v['title'].startswith('Not connected'), 'no targets → "Not connected: nothing was checked"')

oldfw = dict(same, fw={'fpga': '1.1.4.8', 'mcu': '1.1.4.8'})
v = rcvguard.check(ncp, 0, [{'where': where(0), 'id': oldfw}], 'lct')
ok(v['level'] == 'block' and any(r['rule'] == 9 for r in v['groups'][0]['reasons']), 'NCP with other firmware on NovaLCT → BLOCK (parameters only, rule 9)')
ok(rcvguard.check(ncp, 0, [{'where': where(0), 'id': oldfw}], 'unico')['level'] == 'warn', 'NCP with other firmware on Unico → WARN (the device updates it)')
nofw = dict(same, fw={})
ok(rcvguard.check(ncp, 0, [{'where': where(0), 'id': nofw}], 'lct')['level'] == 'block', 'NCP on NovaLCT with unreadable firmware → BLOCK')
if REAL:
    cp = ncp['cabinets'][0]['cfgParam']
    ok(ncp.get('packName') and ncp.get('creatTime') and cp['cardModel'] == 'A10s Pro' and cp['version'] == '1.5.5.98', 'NCP pack name / time / cfgParam for Unico and COEX')
fit =lambda **kw: card(w=fv['w'], h=fv['h'], chip=fv['chip'], scan=fv['scan'], modW=fv['modW'], modH=fv['modH'], decoder=fv['decoder'], ncp=False, **kw)
v = rcvguard.check(rcv, 0, [{'where': where(0), 'id': fit(fw={'fpga': fv['fw']['savedWith']})}], 'lct')
ok(v['level'] in ('ok', 'info'), '.rcfgx saved with firmware %s on cards running it → OK (%s)' % (fv['fw']['savedWith'], v['level']))
v = rcvguard.check(rcv, 0, [{'where': where(0), 'id': fit(fw={'fpga': '9.9.9.9'})}], 'coex')
ok(v['level'] == 'block' and any(r['rule'] == '9b' for r in v['groups'][0]['reasons']), '.rcfgx on cards with other firmware → BLOCK (rule 9b, every family)')
print('      ', [r['text'] for r in v['groups'][0]['reasons'] if r['rule'] == '9b'][0])
ok(rcvguard.check(rcv, 0, [{'where': where(0), 'id': fit()}], 'lct')['level'] == 'block', '.rcfgx on cards whose firmware can’t be read → BLOCK')
v = rcvguard.check(rc, 0, [{'where': where(0), 'id': match}], 'lct')
ok(v['level'] == 'warn' and any(r['rule'] == '9b' for r in v['groups'][0]['reasons']), '.rcfgx that doesn’t record its firmware → WARN')
if REAL:
    s1 = rcvfile.ncp_script(open(NCP_FILE, 'rb').read())
    ok(len(s1) == 114 and s1[0][0] == 0x010000C6 and any(t for _a, _d, _dl, t, _af in s1), 'NCP parameter script: 114 records, starts 0x010000C6, has busy polls (CAPTURE_NCP_SEND §3)')
    ok(30 <= f0.get('sendSeconds', 0) <= 36, 'NCP send time per target ≈ LCT’s 33 s (%s s)' % f0.get('sendSeconds'))

# ---- NovaLCT NCP send (novalink.rcv_send on a stand-in link; the dall version = LCT's captures, compare_send.py --ncp)
# compare_send.py (tools/, a research tool next to LCT's captures) is not in the repository either
try:
    import compare_send   # noqa: E402
except ImportError:
    compare_send = None
if REAL and compare_send:
    ncpdata = open(NCP_FILE, 'rb').read()
    ops = compare_send.ours_ncp(ncpdata, 'x.ncp', 0, [{'dst': 1, 'port': 3, 'card': None}])
    ws = [o for o in ops if o['op'] == 1]; rs = [o for o in ops if o['op'] == 0]
    ok(len(ws) == 669 and all((o['dev'], o['dst'], o['port'], o['card'], o['r2']) == (1, 1, 3, 0xFFFF, 0) for o in ws),
       'NCP to one port: 669 writes, all rx d1 p3 call r2 0 (%d)' % len(ws))
    ok(len(rs) == 14 and all((o['dst'], o['port'], o['card'], o['addr'], o['len']) == (1, 3, 0, 0x02000001, 16) for o in rs), 'its 14 busy polls read that port’s first card (as LCT)')
    ok(ws[-1]['addr'] == 0x010000C6 and ws[-1]['data'] == b'\x01', 'ends with 0x010000C6 ← 01: no Save-to-HW appended')
    ok(not any(o['addr'] == 0x08000000 or o['addr'] == 0x09000000 or o['addr'] in (0x01000080, 0x0100000B) for o in ws), 'no firmware upload, no MCU / FPGA restart (parameters only)')
    ops = compare_send.ours_ncp(ncpdata, 'x.ncp', 0, [{'dst': 0, 'port': 2, 'card': 5}, {'dst': 0, 'port': 2, 'card': 6}])
    ws = [o for o in ops if o['op'] == 1]; rs = [o for o in ops if o['op'] == 0]
    ok(len(ws) == 2 * 669 and {o['card'] for o in ws[:669]} == {5} and {o['card'] for o in ws[669:]} == {6} and {o['card'] for o in rs} == {5, 6},
       'mixed wall: card by card (c5 then c6), each polled on itself')
else:
    print('SKIP NCP send plan from a real .ncp (%s not here: private)' % ('Samples/RCFGX NCP' if not REAL else 'tools/compare_send.py'))

# ---- override (user, 2026-10-11): every BLOCK can be overridden except the hard ones (rules 2, 3, 18)
v = rcvguard.check(ncp, 0, [{'where': where(0), 'id': oldfw}, {'where': where(1), 'id': same}], 'lct')
ok(v['level'] == 'block' and v['overridable'] == 1 and not v['groups'][0].get('hard'), 'firmware BLOCK (rule 9) can be overridden: overridable 1')
v = rcvguard.check(cx, 0, [{'where': where(0), 'id': card(modelId=0x4754, w=640, h=360)}], 'lct')
ok(v['overridable'] == 0 and v['groups'][0]['hard'], '4th-generation package through NovaLCT (rule 2) is hard: no override')
ok(rcvguard.check(bad, 0, [{'where': where(0), 'id': card(w=112, h=112)}], 'lct')['overridable'] == 0, 'damaged file (rule 18) is hard: no override')
v = rcvguard.check(rcv, 0, [{'where': where(0), 'id': fit(fw={'fpga': fv['fw']['savedWith']}, modelId=0x4801)}], 'coex')
ok(v['level'] == 'block' and v['overridable'] == 0 and any(r.get('hard') and r['rule'] == 3 for r in v['groups'][0]['reasons']), '.rcfgx to NCP-only cards on an MX (rule 3) is hard: no override')

print('\n%d failed' % len(fails) if fails else '\nAll passed')
sys.exit(1 if fails else 0)
