"""rcvguard.py - does this receiving-card file fit these panels? (docs/RCV_FILE_GUARD.md §4). Pure logic, stdlib only.

    check(file_id, cabinet, cards, family) -> verdict
      file_id  = rcvfile.identity(...) (one file; cabinet = which of its cabinets[] is being sent, 0 for .rcfgx)
      cards    = [{where: {proc, card, port, index}, id: card identity (rcvfile's shape) or None = didn't answer,
                   planned: {w, h} or None (the project's cabinet there)}]
      family   = 'lct' | 'unico' | 'coex'
    verdict = {level: 'ok'|'info'|'warn'|'block', title, file: summary text, groups: [{level, count, where: [...],
               reasons: [{level, rule, text}], unknown: [text], id: card identity summary}], sendable, total}

Levels: BLOCK = no "Send anyway", only a typed override (user, 2026-10-11); WARN = "Send anyway" allowed; INFO = listed
only. Unknown never passes as a match. A BLOCK from a HARD rule (the file can't go through this path at all) has no override:
a group with one is marked hard, and the verdict counts the cabinets an override could reach (overridable).
Wording names the file value and the panel value (the app adds the count and where).
"""
import re

NCP_ONLY = {0x4801, 0x4802, 0x4803, 0x4754, 0x4757}   # VMP [LimitedNcpModel]
CARD_NAMES = {0x4186: 'A9s', 0x4187: 'A10s', 0x4506: 'A4s', 0x4508: 'A5s', 0x4509: 'A8s', 0x450A: 'A7s', 0x4512: 'X300',
              0x4516: 'A10s Plus', 0x4520: 'X500', 0x4524: 'XC160 Plus', 0x4528: 'A8s-N', 0x4560: 'B6s', 0x4584: 'A7',
              0x4585: 'A8', 0x4586: 'A4', 0x4587: 'A5', 0x4620: 'A6s', 0x4621: 'A3s / A5s Plus', 0x4622: 'A7s Plus',
              0x4623: 'A10s Plus-N', 0x4624: 'A5s Plus-N', 0x4625: 'A8s-T', 0x4651: 'DH3208', 0x4653: 'MRV416',
              0x4657: 'DH7516-S', 0x4681: 'XC190', 0x4682: 'X300_2', 0x4754: 'CA50', 0x4757: 'XA50 Pro',
              0x4801: 'A10s Pro', 0x4802: 'A10s Pro', 0x4803: 'A8s Pro', 0x4805: 'XA10', 0x4816: 'XA10-N',
              0x4103: 'MRV220', 0x4101: 'MRV300', 0x4105: 'MRV320', 0x4301: 'MRV336'}
# driver-chip code (block +0x0C) -> name, from the 95 real .rcfgx files (XML ChipCode / DriverChipType next to the byte)
CHIP_NAMES = {81: 'ICN2053', 107: 'ICND2055', 51: 'MBI5252', 32: 'MBI5151', 31: 'MBI5124', 88: 'ICN2038S', 33: 'MBI5153',
              151: 'MBI5850', 175: 'MBI5251'}
DECODER_NAMES = {1: 'Decode138', 66: 'Decode138ND'}
RANK = {'ok': 0, 'info': 1, 'warn': 2, 'block': 3}
# BLOCKs that no override passes: a 4th-generation package through NovaLCT (2), a non-NCP file to NCP-only cards on an MX
# processor (3; the processor refuses it), a damaged file (18). Every other BLOCK can be overridden after a typed confirm.
HARD_RULES = (2, 3, 18)


def norm(s):
    return re.sub(r'[\s\-_]', '', str(s)).lower() if s not in (None, '') else None


def vnorm(v):
    """'1.1.4.08' == '1.1.4.8'"""
    return '.'.join(x.lstrip('0') or '0' for x in str(v).strip().split('.'))


def card_name(i):
    if not i:
        return None
    if i.get('modelId') is not None:
        return CARD_NAMES.get(i['modelId']) or i.get('cardName') or 'ModelID 0x%04X' % i['modelId']
    return i.get('cardName')


def chip_name(i):
    ic = i.get('ic')
    if ic:
        ic = re.sub(r'^Chip_', '', ic)
        if norm(ic) not in ('commonbase',):
            return ic
    c = i.get('chip')
    return CHIP_NAMES.get(c) if c else None


def dec_name(i):
    return i.get('decoderName') or DECODER_NAMES.get(i.get('decoder'))


def size(w, h):
    return '%s×%s' % (w, h)


def summary(f):
    """'Absen JP8.9 PRO_1_1_1_1 · A10s Pro · 112×112 · MBI5251 · 1/4 scan · firmware 1.5.5.98'"""
    bits = []
    if f.get('mfr') or f.get('cabinet'):
        bits.append(' '.join(x for x in (f.get('mfr'), f.get('cabinet')) if x))
    if card_name(f):
        bits.append(card_name(f))
    elif f.get('savedCard'):
        bits.append('saved from ' + f['savedCard'])
    if f.get('w'):
        bits.append(size(f['w'], f['h']))
    if chip_name(f):
        bits.append(chip_name(f))
    if f.get('scan'):
        bits.append('1/%d scan' % f['scan'])
    fw = (f.get('fw') or {})
    if fw.get('fpga') or fw.get('version'):
        bits.append('firmware ' + (fw.get('fpga') or fw.get('version')))
    if f.get('gen') == 4:
        bits.append('4th-generation package')
    return ' · '.join(bits) or 'no identity in the file'


def _ident_key(i):
    if not i:
        return ('none',)
    fw = i.get('fw') or {}
    return (i.get('modelId'), i.get('w'), i.get('h'), i.get('modW'), i.get('modH'), norm(chip_name(i)), i.get('chip'), i.get('scan'),
            norm(dec_name(i)), i.get('decoder'), bool(i.get('ncp')), norm(i.get('cabinet')) if i.get('ncp') else None,
            fw.get('fpga'), fw.get('mcu'), fw.get('fpgaRemark'), fw.get('mcuRemark'), i.get('grey'))   # every value a rule reads


def rules(f, kind, c, family, planned=None):
    """Reasons for one card identity c (not None). Returns (reasons, unknown)."""
    R, U = [], []
    add = lambda lvl, rule, text: R.append({'level': lvl, 'rule': rule, 'text': text})
    fname, cname = card_name(f), card_name(c)
    # 1 receiving-card model (only an NCP / firmware names it)
    if f.get('modelId') is not None:
        if c.get('modelId') is None:
            U.append('Card model: file %s, panels unknown (the card doesn’t report it)' % fname)
        elif c['modelId'] != f['modelId']:
            add('block', 1, 'This file is for %s receiving cards (0x%04X); these panels have %s cards (0x%04X).'
                % (fname, f['modelId'], cname, c['modelId']))
    elif f.get('cardName') and c.get('cardName') and norm(f['cardName']) != norm(c['cardName']):
        add('warn', 13, 'This file is for %s cards; these panels say %s.' % (f['cardName'], c['cardName']))
    # 2 generation
    if f.get('gen') == 4 and family == 'lct':
        add('block', 2, 'This is a 4th-generation (%s) package; it can’t be sent through this processor.' % (fname or 'CX'))
    # 3 / 3a NCP-only cards
    if kind != 'ncp' and c.get('modelId') in NCP_ONLY:
        if family == 'coex':
            add('block', 3, '%s cards on an MX processor only accept NCP files — send the cabinet’s NCP instead.' % cname)
        else:
            add('warn', '3a', 'NovaStar treats %s as NCP-only; this .rcfgx will replace its NCP configuration.' % cname)
    # 4-8 what the panel is: compared with what it reports now (the previous file wrote these values). When the project's
    # cabinet matches the file while the panel disagrees, the panel probably holds a wrong config: WARN, not BLOCK.
    stale = planned and planned.get('w') and f.get('w') and (planned['w'], planned['h']) == (f['w'], f['h'])
    hard = 'warn' if stale else 'block'
    if f.get('w') and c.get('w'):
        if (f['w'], f['h']) == (c['w'], c['h']):
            pass
        elif (f['w'], f['h']) == (c['h'], c['w']):
            add('warn', '4a', 'The file is for this cabinet turned 90° (%s; the panels report %s) — the screen layout must be rotated to match.'
                % (size(f['w'], f['h']), size(c['w'], c['h'])))
        else:
            add(hard, 4, 'The file is for %s cabinets; these panels are %s.' % (size(f['w'], f['h']), size(c['w'], c['h'])) +
                (' The project says %s, which matches the file — the panels may hold a wrong config now.' % size(planned['w'], planned['h']) if stale else ''))
    elif f.get('w'):
        U.append('Cabinet size: file %s, panels unknown' % size(f['w'], f['h']))
    if f.get('modW') and c.get('modW') and (f['modW'], f['modH']) != (c['modW'], c['modH']):
        add(hard, 5, 'The file drives %s modules; these panels have %s modules.' % (size(f['modW'], f['modH']), size(c['modW'], c['modH'])))
    fc, cc = chip_name(f), chip_name(c)
    if fc and cc:
        if norm(fc) != norm(cc):
            add(hard, 6, 'The file is for %s driver chips; these panels use %s.' % (fc, cc))
    elif f.get('chip') and c.get('chip') and f['chip'] != c['chip']:
        add(hard, 6, 'The file is for driver chip code %d; these panels report %d.' % (f['chip'], c['chip']))
    elif fc:
        U.append('Driver chip: file %s, panels unknown (the card doesn’t report it)' % fc)
    if f.get('scan') and c.get('scan'):
        if f['scan'] != c['scan']:
            add(hard, 7, 'The file is for 1/%d scan; these panels are 1/%d scan.' % (f['scan'], c['scan']))
    elif f.get('scan'):
        U.append('Scan: file 1/%d, panels unknown' % f['scan'])
    fd, cd = dec_name(f), dec_name(c)
    if fd and cd and norm(fd) != norm(cd):
        add('warn', 8, 'The file uses a %s row decoder; these panels use %s.' % (fd, cd))
    elif f.get('decoder') and c.get('decoder') and f['decoder'] != c['decoder'] and not (fd and cd):   # 0 = not set / unknown
        add('warn', 8, 'The file uses row-decoder code %d; these panels report %d.' % (f['decoder'], c['decoder']))
    # 9 firmware inside an NCP
    ff, cf = f.get('fw') or {}, c.get('fw') or {}
    if kind == 'ncp' and ff.get('fpga'):
        if cf.get('fpga'):
            same = ff.get('fpga') == cf.get('fpga') and ff.get('mcu') == cf.get('mcu') and \
                (not ff.get('fpgaRemark') or not cf.get('fpgaRemark') or ff['fpgaRemark'] == cf['fpgaRemark'])
            if same:
                add('info', 9, 'Same firmware as the panels (%s): only the parameters are sent.' % ff['fpga'])
            elif family == 'lct':   # Open Nova sends NCP parameters only on NovaLCT processors: firmware updates are out of scope
                add('block', 9, 'The NCP is for firmware %s; these cards run %s. Open Nova only sends the parameters and doesn’t update '
                    'receiving-card firmware — update it in NovaLCT first.' % (ff['fpga'], cf['fpga']))
            else:
                add('warn', 9, 'The NCP contains firmware %s; these cards run %s. Sending also updates the receiving-card firmware '
                    '(about 90 s — don’t power off).' % (ff['fpga'], cf['fpga']))
        elif family == 'lct':
            add('block', 9, 'Couldn’t read these cards’ firmware, so the NCP parameters can’t be checked against it (file: %s).' % ff['fpga'])
        else:
            U.append('Firmware: file %s, panels unknown — the firmware may be updated too' % ff['fpga'])
    # 9b an .rcfgx and the firmware it was saved with (ScanBoardVersionInfo/ProgramVersion): no family updates receiving-card
    # firmware with an .rcfgx, so other firmware on the panels (or firmware that can't be read) blocks it (user, 2026-10-10)
    if kind in ('rcfgx', 'rccb'):   # a bare register script (.bin) records no firmware: WARN
        sv = ff.get('savedWith')
        if sv:
            if cf.get('fpga'):
                if vnorm(sv) != vnorm(cf['fpga']):
                    add('block', '9b', 'This .rcfgx was saved from cards running firmware %s%s; these cards run %s. Update the cards’ '
                        'firmware first, or use an .rcfgx saved from this firmware.' % (sv, ' (' + f['savedCard'] + ')' if f.get('savedCard') else '', cf['fpga']))
            else:
                add('block', '9b', 'Couldn’t read these cards’ firmware, so this .rcfgx (saved with firmware %s) can’t be checked against it.' % sv)
        else:
            add('warn', '9b', 'This file doesn’t record which firmware it was made for (an .rcfgx saved by an older NovaLCT, or a bare .bin), so that can’t be checked.')
    # 11 / 11a how the panels are configured now
    if c.get('ncp') is not None:
        if kind == 'ncp' and c.get('ncp') is False:   # None = the card's NCP marker wasn't read
            add('warn', 11, 'These panels are set up from an .rcfgx now, not an NCP; sending the NCP replaces that.')
        if kind != 'ncp' and c.get('ncp'):
            add('warn', '11a', 'These panels are NCP-configured (%s); this .rcfgx replaces the NCP setup.'
                % (' '.join(x for x in (c.get('mfr'), c.get('cabinet')) if x) or 'an NCP'))
    # 12 cabinet name (NCP to NCP)
    if kind == 'ncp' and c.get('ncp') and c.get('cabinet') and f.get('cabinet') and norm(c['cabinet']) != norm(f['cabinet']):
        add('warn', 12, 'The file is cabinet %s (%s); the panels say they are %s (%s).'
            % (f['cabinet'], f.get('mfr') or '?', c['cabinet'], c.get('mfr') or '?'))
    # 15 / 16 information only
    if kind == 'rcfgx' and f.get('savedCard') and cname and norm(f['savedCard']) != norm(cname):
        add('info', 15, 'This .rcfgx was saved from an %s card; these are %s (not a problem by itself).' % (f['savedCard'], cname))
    if f.get('grey') and c.get('grey') and f['grey'] != c['grey']:
        add('info', 16, 'Grey depth changes %d → %d bit.' % (c['grey'], f['grey']))
    return R, U


def check(file_id, cabinet, cards, family):
    if not file_id or not file_id.get('ok'):
        why = (file_id or {}).get('error') or 'unreadable'
        return {'level': 'block', 'title': 'This file can’t be sent', 'file': why, 'total': len(cards), 'sendable': 0,
                'groups': [{'level': 'block', 'count': len(cards), 'where': [c['where'] for c in cards],
                            'reasons': [{'level': 'block', 'rule': 18, 'hard': True, 'text': 'The file is damaged or not a receiving-card file: %s. Don’t send it.' % why}],
                            'unknown': [], 'id': None, 'hard': True}], 'overridable': 0}
    kind = file_id['kind']
    f = file_id['cabinets'][cabinet or 0]
    if not cards:
        return {'level': 'block', 'title': 'Not connected: nothing was checked', 'file': summary(f), 'total': 0, 'sendable': 0,
                'groups': [], 'overridable': 0}
    groups = {}
    for c in cards:
        k = _ident_key(c.get('id')) + (tuple(sorted((c.get('planned') or {}).items())),)
        groups.setdefault(k, []).append(c)
    out = []
    for k, members in groups.items():
        cid = members[0].get('id')
        if cid is None:
            g = {'level': 'warn', 'reasons': [{'level': 'warn', 'rule': 'no-answer',
                 'text': 'These cabinets didn’t answer, so they weren’t checked — a broadcast still reaches them.'}], 'unknown': []}
        else:
            R, U = rules(f, kind, cid, family, members[0].get('planned'))
            for r in R:
                if r['level'] == 'block' and r['rule'] in HARD_RULES: r['hard'] = True
            lvl = max([r['level'] for r in R] + ['ok'], key=lambda x: RANK[x])
            # every hard check unknown: never "OK"
            hard_known = any(r['rule'] in (1, 4, '4a', 5, 6, 7) for r in R) or (f.get('w') and cid.get('w')) or \
                (f.get('modelId') is not None and cid.get('modelId') is not None)
            if not hard_known:
                lvl = lvl if RANK[lvl] >= RANK['warn'] else 'warn'
                U.insert(0, 'Couldn’t confirm this file fits these panels.')
            g = {'level': lvl, 'reasons': sorted(R, key=lambda r: -RANK[r['level']]), 'unknown': U, 'hard': any(r.get('hard') for r in R)}
        g.update({'count': len(members), 'where': [m['where'] for m in members],
                  'id': None if cid is None else {'card': card_name(cid), 'size': size(cid['w'], cid['h']) if cid.get('w') else None,
                                                  'chip': chip_name(cid), 'scan': cid.get('scan'), 'cabinet': cid.get('cabinet')}})
        out.append(g)
    out.sort(key=lambda g: (-RANK[g['level']], -g['count']))
    level = max((g['level'] for g in out), key=lambda x: RANK[x])
    sendable = sum(g['count'] for g in out if g['level'] != 'block')
    title = {'block': 'This file doesn’t match the panels', 'warn': 'Check before sending',
             'info': 'The file matches the panels', 'ok': 'The file matches the panels'}[level]
    overridable = sum(g['count'] for g in out if g['level'] == 'block' and not g.get('hard'))
    return {'level': level, 'title': title, 'file': summary(f), 'kind': kind, 'total': len(cards), 'sendable': sendable,
            'groups': out, 'overridable': overridable}
