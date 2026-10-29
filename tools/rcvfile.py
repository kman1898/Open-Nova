"""rcvfile.py - what a receiving-card configuration file is for (docs/RCV_FILE_GUARD.md §1, §5.1). Read-only, stdlib only.

    identity(path_or_bytes, name)   -> {kind: 'rcfgx'|'ncp'|'rccb', ok, error?, cabinets: [ident…], ...}
    rccb_records(b)                 -> [(addr, data, delay, timeout, after)]  (raises RcvFileError on a damaged script)
    block_identity(b)               -> the parameter block 0x02000000 decoded (same offsets on the card: compare byte for byte)
    ncp_block_identity(b)           -> the NCP info block 0x06000200 decoded (what an NCP-configured card reports back)

One cabinet identity (the neutral shape the guard compares, file and card alike):
    {w, h, modW, modH, chip, scan, decoder, groups, grey, refN, rotation, modelId, cardName, mfr, cabinet, ic, decoderName,
     ncp: bool, fw: {version, fpga, fpgaRemark, mcu, mcuRemark}, gen, version, savedBy, savedCard, notes: [...]}
Missing values are None (the guard shows them as "unknown", never as a match).

    python rcvfile.py <file> [...]      print each file's identity as JSON
"""
import io
import json
import re
import struct
import sys
import zipfile
import zlib

NCP_PW1 = b'N0@|,[)9.$eP'        # outer .ncp ZIP (CONFIG_FILE_FORMATS.md §3.2)
NCP_PW2 = b'*^Tm!{>6v8=&'        # the inner "package" ZIP
NCP_ONLY = {0x4801, 0x4802, 0x4803, 0x4754, 0x4757}   # VMP [LimitedNcpModel] (VMP_FILE_FORMATS.md:309)


class RcvFileError(Exception):
    pass


def _sum16(b):
    return (sum(b[64:]) + 0x5555) & 0xFFFF


def rccb_records(b):
    """The RCCB register-write script: header checks + every record. Raises RcvFileError when it's damaged."""
    if len(b) < 64 or b[:4] != b'RCCB':
        raise RcvFileError('not an RCCB script (magic)')
    total, crc, ver = struct.unpack_from('<IHH', b, 4)
    if total != len(b):
        raise RcvFileError('length field %d but the file is %d bytes (cut short or padded)' % (total, len(b)))
    if crc != _sum16(b):
        raise RcvFileError('checksum wrong (0x%04X stored, 0x%04X computed)' % (crc, _sum16(b)))
    out, o = [], 64
    while o < len(b):
        if o + 32 > len(b):
            raise RcvFileError('record header cut short at offset %d' % o)
        rl, _typ, addr, dl, delay, timeout, after = struct.unpack_from('<IHIIHHH', b, o)
        if rl != 32 + dl or o + rl > len(b):
            raise RcvFileError('record at offset %d runs past the end' % o)
        out.append((addr, bytes(b[o + 32:o + rl]), delay, timeout, after))
        o += rl
    return out


def tlv_blocks(b):
    """4th-generation .tlvBin: header EA 03 00 (version 1002), u16 block count, Sum16 at +12 (CONFIG_FILE_FORMATS.md §3.6)."""
    if len(b) < 16 or b[0] != 0xEA or b[1] != 0x03:
        raise RcvFileError('not a .tlvBin (magic)')
    want, got = struct.unpack_from('<H', b, 12)[0], (sum(b[16:]) + 0x5555) & 0xFFFF   # CONFIG_FILE_FORMATS.md §3.6
    if want != got:
        raise RcvFileError('.tlvBin checksum wrong (0x%04X stored, 0x%04X computed)' % (want, got))
    return {'version': struct.unpack_from('<H', b, 0)[0], 'blocks': struct.unpack_from('<H', b, 3)[0]}


def block_identity(b):
    """Parameter block 0x02000000 (file record or card read): offsets from RCV_FILE_GUARD.md §1.1 A."""
    if not b or len(b) < 0x1B:
        return {}
    g = lambda o: b[o] if len(b) > o else None
    u16 = lambda o: struct.unpack_from('<H', b, o)[0] if len(b) >= o + 2 else None
    return {'modW': g(0x0A), 'modH': g(0x0B), 'chip': g(0x0C), 'scan': g(0x0D), 'decoder': g(0x0F), 'groups': g(0x10),
            'cols': g(0x15), 'rows': g(0x16), 'w': u16(0x17), 'h': u16(0x19), 'grey': g(0x25), 'refN': g(0x27)}


def _cstr(b):
    b = b.split(b'\x00', 1)[0]
    try:
        return b.decode('utf-8').strip() or None
    except UnicodeDecodeError:
        return b.decode('latin-1').strip() or None


def ncp_block_identity(b):
    """NCP info block 0x06000200: [0] 0x5A = NCP-configured; strings at 160 / 192 / 234 / 288 / 304; File ID at 0x110."""
    if not b:
        return {}
    s = lambda a, z: _cstr(b[a:z]) if len(b) >= z else None
    return {'ncp': b[0] == 0x5A, 'marker': b[0], 'mfr': s(160, 192), 'cabinet': s(192, 224), 'cardName': s(234, 250),
            'ic': s(288, 304), 'decoderName': s(304, 320), 'fileId': b[0x110:0x120].hex() if len(b) >= 0x120 else None}


def _blank():
    return {'w': None, 'h': None, 'modW': None, 'modH': None, 'chip': None, 'scan': None, 'decoder': None, 'groups': None,
            'grey': None, 'refN': None, 'rotation': None, 'modelId': None, 'cardName': None, 'mfr': None, 'cabinet': None,
            'ic': None, 'decoderName': None, 'ncp': False, 'fw': {}, 'gen': 3, 'version': None, 'savedBy': None,
            'savedCard': None, 'notes': []}


def _from_records(recs, ident):
    """Fill ident from an RCCB script's identity records."""
    by = {}
    for addr, data, *_ in recs:
        by.setdefault(addr, data)
    if 0x02000000 in by:
        for k, v in block_identity(by[0x02000000]).items():
            if k in ident and v is not None:
                ident[k] = v
    if 0x0200009B in by and by[0x0200009B]:
        ident['rotation'] = by[0x0200009B][0]
    if 0x06000200 in by:
        nb = ncp_block_identity(by[0x06000200])
        if nb.get('marker') == 0x5A:
            ident['ncp'] = True
        for k in ('mfr', 'cabinet', 'cardName', 'ic', 'decoderName'):
            if nb.get(k) and not ident.get(k):
                ident[k] = nb[k]
    if ident.get('chip') == 0xFF:      # cabinet-tool chip: the IC is named in the NCP block / config, not here
        ident['chip'] = None
    return by


def _zip_pair(z):
    """The .rcfgx's two entries, whatever their names (the base name is the first save's, not the file's)."""
    names = [n for n in z.namelist() if not n.endswith('/')]
    xml = [n for n in names if n.lower().endswith('.xml')]
    bins = [n for n in names if n.lower().endswith('.bin')]
    if len(names) != 2 or len(xml) != 1 or len(bins) != 1:
        raise RcvFileError('an .rcfgx holds exactly one .xml and one .bin; this one has: %s' % ', '.join(names[:6]))
    return z.read(xml[0]), z.read(bins[0])


def _xml(x, tag):
    m = re.search(r'<%s>([^<]*)</%s>' % (tag, tag), x)
    return m.group(1).strip() if m else None


def rcfgx_identity(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    try:
        xmlb, binb = _zip_pair(z)
    except zipfile.BadZipFile as e:
        raise RcvFileError('damaged ZIP: %s' % e)
    except (RuntimeError, ValueError, zlib.error) as e:
        raise RcvFileError('damaged ZIP: %s' % e)
    ident = _blank()
    recs = rccb_records(binb)
    _from_records(recs, ident)
    x = xmlb.decode('utf-8', 'replace')
    xw, xh = _xml(x, 'Width'), _xml(x, 'Height')
    chip_txt = _xml(x, 'DriverChipType')
    chip_code = _xml(x, 'ChipCode')
    ident['savedCard'] = _xml(x, 'ScanBoardName')
    ident['savedBy'] = _xml(x, 'RCFGXVersion')
    pv = _xml(x, 'ProgramVersion')
    if pv:
        ident['fw'] = {'savedWith': pv}
    if chip_txt and chip_txt.startswith('Chip_'):
        ident['ic'] = chip_txt[5:]
    scan = _xml(x, 'ScanType')
    # the XML and the .bin say the same thing in every real file; a difference means a hand-edited file
    try:
        if xw and xh and ident['w'] is not None and (int(xw), int(xh)) != (ident['w'], ident['h']):
            ident['notes'].append('the XML says %s×%s but the register script writes %s×%s' % (xw, xh, ident['w'], ident['h']))
        if ident['w'] is None and xw:
            ident['w'], ident['h'] = int(xw), int(xh)
        if chip_code and ident['chip'] is not None and int(chip_code) != ident['chip']:
            ident['notes'].append('the XML chip code %s differs from the script (%d)' % (chip_code, ident['chip']))
        if scan and scan.startswith('Scan_') and ident['scan'] is None:
            ident['scan'] = int(scan[5:])
    except ValueError:
        pass
    return {'kind': 'rcfgx', 'ok': True, 'records': len(recs), 'cabinets': [ident]}


def _open_ncp(data):
    outer = zipfile.ZipFile(io.BytesIO(data))
    outer.setpassword(NCP_PW1)
    if 'package' not in outer.namelist():
        raise RcvFileError('not an NCP: no "package" inside')
    try:
        pkg = outer.read('package')
    except RuntimeError as e:
        raise RcvFileError('can’t open the NCP (password / encryption): %s' % e)
    inner = zipfile.ZipFile(io.BytesIO(pkg))
    inner.setpassword(NCP_PW2)
    return inner


def _modelid(v):
    if v is None or v == '':
        return None
    if isinstance(v, int):
        return v
    s = str(v).strip()
    try:
        return int(s, 16) if re.fullmatch(r'[0-9A-Fa-f]{4}', s) else int(s, 0)
    except ValueError:
        return None


def ncp_identity(data):
    z = _open_ncp(data)
    try:
        man = json.loads(z.read('manifest.json').decode('utf-8-sig'))
    except KeyError:
        raise RcvFileError('not an NCP: no manifest.json in the package')
    names = z.namelist()
    cp = man.get('cabinetPackage') or {}
    desc = cp.get('description') or {}
    out = {'kind': 'ncp', 'ok': True, 'formatVersion': man.get('formatVersion'), 'tool': man.get('CabineToolVersion'),
           'version': desc.get('version'), 'status': desc.get('status'), 'packName': desc.get('packName'),
           'creatTime': desc.get('date'), 'cabinets': []}   # packName + creatTime = how Unico / COEX name the pack
    for c in cp.get('cabinets') or []:
        ident = _blank()
        ident['mfr'] = c.get('manufacturername')
        ident['cabinet'] = c.get('name')
        ident['version'] = desc.get('version')
        ident['ncp'] = True   # an NCP sets the card's NCP marker (0x06000200[0] = 0x5A)
        cfg = c.get('cfgName')
        if cfg not in names:
            ident['notes'].append('cabinet file %s missing from the package' % cfg)
            out['cabinets'].append(ident)
            continue
        cz = zipfile.ZipFile(io.BytesIO(z.read(cfg)))
        conf = json.loads(cz.read('config.json').decode('utf-8-sig'))
        bi = conf.get('baseInfo') or {}
        dims = ((bi.get('physicalProperies') or {}).get('dimensions')) or {}
        ident.update({'w': dims.get('horizontalPixels'), 'h': dims.get('verticalPixels'), 'cardName': bi.get('cardModel'),
                      'modelId': _modelid(bi.get('moduleID')), 'ic': bi.get('icType'), 'decoderName': bi.get('decodeType'),
                      'type': bi.get('type'), 'status': bi.get('Status')})
        if bi.get('manufacture'):
            ident['mfr'] = bi.get('manufacture')
        if bi.get('name'):
            ident['cabinet'] = bi.get('name')
        if bi.get('firmwareVersion'):
            ident['fw'] = {'version': bi.get('firmwareVersion')}
        try:
            ident['scan'] = int(bi.get('scanType')) if bi.get('scanType') not in (None, '') else None
        except (TypeError, ValueError):
            pass
        # the cabinet's register script: the first files[] entry ending in "in" (.bin / .tlvBin), as LCT picks it
        pf = next((f.get('fileName') for f in conf.get('files') or [] if str(f.get('fileName', '')).endswith('in')), None)
        if pf and pf in cz.namelist():
            pb = cz.read(pf)
            if pf.endswith('.tlvBin'):
                ident['gen'] = 4
                tlv_blocks(pb)
            else:
                recs = rccb_records(pb)     # raises on a damaged script -> the whole file is refused
                cfgv = {k: ident[k] for k in ('w', 'h', 'scan', 'cardName', 'ic', 'mfr', 'cabinet', 'decoderName')}
                _from_records(recs, ident)  # module size, chip byte, decoder byte, grey, rotation from the script
                ident['sendSeconds'] = script_seconds(recs)
                for k, v in cfgv.items():   # config.json's names and size win; a size difference is noted
                    if v is None:
                        continue
                    if k in ('w', 'h') and ident[k] not in (None, v):
                        ident['notes'].append('config.json says %s=%s, the register script %s' % (k, v, ident[k]))
                    ident[k] = v
        elif pf:
            ident['notes'].append('parameter file %s missing' % pf)
        # how Unico / COEX name this cabinet file (cabinetFileParam / cfgParam), as their apps send it [R captures]
        ident['cfgParam'] = {'manufactureName': bi.get('manufacture') or c.get('manufacturername'), 'cabinetName': bi.get('name') or c.get('name'),
                             'cardModel': bi.get('cardModel'), 'status': bi.get('Status'), 'version': bi.get('firmwareVersion'),
                             'issue': bi.get('AmendmentNum') if bi.get('AmendmentNum') is not None else c.get('revision')}
        if bi.get('type') == 'CX':
            ident['gen'] = 4
        # firmware: Config.xml ModuleID + FPGA / MCU versions (what LCT compares before "parameters only")
        fwf = c.get('firmwareFile')
        if fwf and fwf in names:
            fb = z.read(fwf)
            if fb[:2] == b'PK':
                fz = zipfile.ZipFile(io.BytesIO(fb))
                cx = next((n for n in fz.namelist() if n.lower().endswith('config.xml')), None)
                if cx:
                    x = fz.read(cx).decode('utf-8-sig', 'replace')
                    mid = _xml(x, 'ModuleID')
                    if mid and ident['modelId'] is None:
                        ident['modelId'] = _modelid(mid)
                    for lab, key in (('FPGA', 'fpga'), ('MCU', 'mcu')):
                        m = re.search(r'<FileLabel>%s</FileLabel>.*?<Version>([^<]*)</Version>(?:.*?<Remark>([^<]*)</Remark>)?' % lab, x, re.S)
                        if m:
                            ident['fw'][key] = m.group(1).strip()
                            if m.group(2):
                                ident['fw'][key + 'Remark'] = m.group(2).strip()
            else:
                ident['gen'] = 4
        out['cabinets'].append(ident)
    if not out['cabinets']:
        raise RcvFileError('the NCP lists no cabinets')
    return out


def script(data, name=''):
    """The register writes an .rcfgx (or a bare RCCB .bin) makes, in file order: [(addr, data, delay_ms)]. Raises
    RcvFileError for an NCP (its send is a different flow) or a damaged file."""
    if data[:4] == b'RCCB':
        return [(a, d, dl) for a, d, dl, _t, _a in rccb_records(data)]
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise RcvFileError('damaged ZIP: %s' % e)
    if 'package' in z.namelist() or name.lower().endswith('.ncp'):
        raise RcvFileError('this is an NCP: its send isn’t the .rcfgx replay')
    _x, binb = _zip_pair(z)
    return [(a, d, dl) for a, d, dl, _t, _a in rccb_records(binb)]


def ncp_script(data, cabinet=0):
    """An NCP cabinet's register script for a NovaLCT "parameters only" send: [(addr, data, delay, timeout, after)]
    (CAPTURE_NCP_SEND.md §3, §5.1). Refuses a 4th-generation .tlvBin."""
    z = _open_ncp(data)
    man = json.loads(z.read('manifest.json').decode('utf-8-sig'))
    cabs = (man.get('cabinetPackage') or {}).get('cabinets') or []
    if cabinet >= len(cabs):
        raise RcvFileError('the NCP has no cabinet %d' % (cabinet + 1))
    cz = zipfile.ZipFile(io.BytesIO(z.read(cabs[cabinet]['cfgName'])))
    conf = json.loads(cz.read('config.json').decode('utf-8-sig'))
    pf = next((f.get('fileName') for f in conf.get('files') or [] if str(f.get('fileName', '')).endswith('in')), None)
    if not pf or pf not in cz.namelist():
        raise RcvFileError('the NCP has no parameter script')
    if pf.endswith('.tlvBin'):
        raise RcvFileError('a 4th-generation package (.tlvBin) can’t be sent through a NovaLCT-protocol processor')
    return rccb_records(cz.read(pf))


def script_seconds(recs):
    """How long a NovaLCT-style NCP parameter send of these records takes per target: delays + 1 s after each busy poll +
    AfterTimeout (bit 15) + ~3 ms per 256-B frame (the JP8.9 script: 33 s, LCT took 33.2-33.6 s in the captures)."""
    ms = sum(dl + (1000 if t else 0) + ((af & 0x7FFF) if af & 0x8000 else 0) for _a, _d, dl, t, af in recs)
    frames = sum((len(d) + 255) // 256 for _a, d, _dl, _t, _af in recs)
    return int(round(ms / 1000.0 + frames * 0.003))


def multipart(fields):
    """[(name, filename or None, bytes)] -> (body, content type) for a multipart/form-data upload."""
    import uuid
    bd = '----OpenNova' + uuid.uuid4().hex
    out = bytearray()
    for name, fn, val in fields:
        out += ('--%s\r\n' % bd).encode()
        if fn is None:
            out += ('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode()
        else:
            out += ('Content-Disposition: form-data; name="%s"; filename="%s"\r\nContent-Type: application/octet-stream\r\n\r\n' % (name, fn)).encode('utf-8')
        out += val + b'\r\n'
    out += ('--%s--\r\n' % bd).encode()
    return bytes(out), 'multipart/form-data; boundary=' + bd


def identity(src, name=''):
    """File (path or bytes) -> identity. Never raises: a damaged / unknown file comes back {ok: False, error, damaged}."""
    try:
        data = src if isinstance(src, (bytes, bytearray)) else open(src, 'rb').read()
        name = name or ('' if isinstance(src, (bytes, bytearray)) else str(src))
        low = name.lower()
        if data[:4] == b'RCCB':
            ident = _blank()
            _from_records(rccb_records(data), ident)
            return {'kind': 'rccb', 'ok': True, 'cabinets': [ident]}
        if data[:2] != b'PK':
            return {'kind': None, 'ok': False, 'error': 'not an .rcfgx, NCP or RCCB file'}
        if low.endswith('.ncp'):
            return ncp_identity(data)
        z = zipfile.ZipFile(io.BytesIO(data))
        if 'package' in z.namelist():
            return ncp_identity(data)
        return rcfgx_identity(data)
    except RcvFileError as e:
        return {'kind': None, 'ok': False, 'damaged': True, 'error': str(e)}
    except (zipfile.BadZipFile, RuntimeError, KeyError, ValueError, struct.error, OSError, zlib.error) as e:
        return {'kind': None, 'ok': False, 'damaged': True, 'error': 'damaged or unreadable file: %s' % e}


if __name__ == '__main__':
    for p in sys.argv[1:]:
        print(p)
        print(json.dumps(identity(p), ensure_ascii=False, indent=1))
