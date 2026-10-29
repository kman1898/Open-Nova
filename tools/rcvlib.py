"""rcvlib.py - the receiving-card file library (.rcfgx / NCP / RCCB .bin), kept by the helper so every device that opens
the app sees the same files. Stdlib only. Files live in LIB_DIR as <sha1>.<ext> with index.json next to them; a removed
file is moved to LIB_DIR\\_removed (never deleted).

    add(data, name)        -> {ok, entry, duplicate?}   (a damaged file is refused: rcvfile.identity must read it)
    entries()              -> [entry]                   entry = {id, name, kind, size, added, cabinets: [cabinet summary]}
    get(id)                -> (bytes, name)
    remove(id)             -> True
    conflicts(entries)     -> [{key, label, files: [{id, name, cabinet, firmware}]}]   same cabinet, different firmware
    match(cards, family)   -> {id: [{cabinet, level, title, sendable, total, reasons}]} every file checked against the cards

Same cabinet = same card model, cabinet size, module size, driver chip and scan (docs/RCV_FILE_GUARD.md §4 values); its
firmware = an NCP's FPGA version, an .rcfgx's saved-with firmware. Two files for the same cabinet with different
firmware are flagged: sending the wrong one is the mistake the library is there to prevent.
"""
import datetime
import hashlib
import json
import os
import shutil
import threading

import rcvfile
import rcvguard

LIB_DIR = os.environ.get('OPENNOVA_LIBRARY') or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'library')
_lock = threading.Lock()


def _index_path():
    return os.path.join(LIB_DIR, 'index.json')


def _load():
    try:
        with open(_index_path(), encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {'files': []}


def _save(idx):
    os.makedirs(LIB_DIR, exist_ok=True)
    tmp = _index_path() + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _index_path())


def _summary(c):
    """What the library shows per cabinet (and what conflicts / matching need)."""
    fw = c.get('fw') or {}
    return {'mfr': c.get('mfr'), 'cabinet': c.get('cabinet'), 'card': rcvguard.card_name(c) or c.get('savedCard'),
            'modelId': c.get('modelId'), 'w': c.get('w'), 'h': c.get('h'), 'modW': c.get('modW'), 'modH': c.get('modH'),
            'chip': rcvguard.chip_name(c), 'scan': c.get('scan'), 'gen': c.get('gen'),
            'firmware': fw.get('fpga') or fw.get('version') or fw.get('savedWith'), 'text': rcvguard.summary(c)}


def add(data, name):
    fid = rcvfile.identity(data, name)
    if not fid.get('ok'):
        return {'ok': False, 'error': 'not added — ' + (fid.get('error') or 'unreadable file')}
    sha = hashlib.sha1(data).hexdigest()
    ext = {'ncp': '.ncp', 'rcfgx': '.rcfgx', 'rccb': '.bin'}.get(fid['kind'], '.bin')
    with _lock:
        idx = _load()
        old = next((e for e in idx['files'] if e['id'] == sha), None)
        if old:
            return {'ok': True, 'entry': old, 'duplicate': True}
        os.makedirs(LIB_DIR, exist_ok=True)
        with open(os.path.join(LIB_DIR, sha + ext), 'wb') as f:
            f.write(data)
        e = {'id': sha, 'name': os.path.basename(name) or sha + ext, 'file': sha + ext, 'kind': fid['kind'], 'size': len(data),
             'added': datetime.datetime.now().isoformat(timespec='seconds'), 'packName': fid.get('packName'),
             'cabinets': [_summary(c) for c in fid['cabinets']], 'ident': fid}   # ident: matching needs no re-read
        idx['files'].append(e)
        _save(idx)
    return {'ok': True, 'entry': e}


def entries(full=False):
    with _lock:
        es = _load()['files']
    return es if full else [{k: v for k, v in e.items() if k != 'ident'} for e in es]


def get(fid):
    e = next((x for x in entries() if x['id'] == fid), None)
    if not e:
        raise KeyError('not in the library')
    with open(os.path.join(LIB_DIR, e['file']), 'rb') as f:
        return f.read(), e['name']


def remove(fid):
    with _lock:
        idx = _load()
        e = next((x for x in idx['files'] if x['id'] == fid), None)
        if not e:
            return False
        gone = os.path.join(LIB_DIR, '_removed')
        os.makedirs(gone, exist_ok=True)
        src = os.path.join(LIB_DIR, e['file'])
        if os.path.exists(src):
            shutil.move(src, os.path.join(gone, e['file']))       # kept, never deleted
        with open(os.path.join(gone, e['file'] + '.json'), 'w', encoding='utf-8') as f:
            json.dump(dict(e, removed=datetime.datetime.now().isoformat(timespec='seconds')), f, ensure_ascii=False, indent=1)
        idx['files'] = [x for x in idx['files'] if x['id'] != fid]
        _save(idx)
    return True


def cabinet_key(s):
    """Same cabinet: card model, cabinet and module size, chip, scan (None where unknown)."""
    n = rcvguard.norm
    return (n(s.get('card')), s.get('w'), s.get('h'), s.get('modW'), s.get('modH'), n(s.get('chip')), s.get('scan'))


def conflicts(es=None):
    es = entries() if es is None else es
    groups = {}
    for e in es:
        for ci, s in enumerate(e['cabinets']):
            if not s.get('w'):
                continue
            groups.setdefault(cabinet_key(s), []).append({'id': e['id'], 'name': e['name'], 'kind': e['kind'], 'cabinet': ci,
                                                          'firmware': s.get('firmware'), 'text': s.get('text'), 's': s})
    out = []
    for k, files in groups.items():
        fws = {rcvguard.vnorm(f['firmware']) for f in files if f['firmware']}
        if len(fws) > 1:
            s0 = next((f['s'] for f in files if f['s'].get('card')), files[0]['s'])   # the files' own spelling
            label = ' · '.join(str(x) for x in (s0.get('card'), '%s×%s' % (s0['w'], s0['h']), '%s×%s modules' % (s0['modW'], s0['modH']) if s0.get('modW') else None,
                                                 s0.get('chip'), '1/%s scan' % s0['scan'] if s0.get('scan') else None) if x)
            for f in files: f.pop('s', None)
            out.append({'key': list(k), 'label': label, 'firmware': sorted({f['firmware'] for f in files if f['firmware']}), 'files': files})
    return out


def match(cards, family):
    """Every library file (each cabinet of an NCP) checked against these cards with the file guard's rules."""
    out = {}
    for e in entries(full=True):
        fid = e.get('ident')
        if not fid:
            try:
                data, name = get(e['id'])
            except (KeyError, OSError) as x:
                out[e['id']] = [{'cabinet': 0, 'level': 'block', 'title': 'file missing from the library folder: %s' % x}]
                continue
            fid = rcvfile.identity(data, name)
        res = []
        for ci in range(len(fid.get('cabinets') or [None])):
            v = rcvguard.check(fid, ci, cards, family)
            reasons = [r['text'] for g in v.get('groups', []) for r in g.get('reasons', []) if r['level'] in ('block', 'warn')]
            res.append({'cabinet': ci, 'level': v['level'], 'title': v['title'], 'sendable': v.get('sendable'),
                        'total': v.get('total'), 'reasons': list(dict.fromkeys(reasons))[:6]})
        out[e['id']] = res
    return out
