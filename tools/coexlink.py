"""coexlink - Open Nova's link to COEX controllers (MX40 Pro, MX6000 Pro, MX2000 Pro, CX40 Pro): the controller's own REST
API (the one VMP's XCenter uses), docs\\COEX_DRIVER_API.md. Python standard library only; served by novalink.py under
/api/coex/*.

    python coexlink.py discover [--timeout 4] [--probe 127.0.0.1:18007,...]
    python coexlink.py info    --host 127.0.0.1 --port 18007
    python coexlink.py detect  --host 127.0.0.1 --port 18007 [--refresh 1]

- No login (authType 0), no keepalive; every reply is {code, message, data}, code 0 = OK. GETs may carry a JSON body.
- Identifiers: output card id = hwSlotId (8, 9 …); canvasID = card << 8; outputID = (card << 8) + port (0-based);
  cabinetID = (MAC & 0xFFFFFF) << 32 | outputID << 16 | index (0-based cable order) [R].
- Layout writes apply at once (no Send step on the controller); Save = PUT device/cabinet/solid, only on request.
- Layout format (from drv-coex.js): {"cabinets":[{"card":0,"port":0,"index":0,"x":0,"y":0,"width":192,"height":192},…],
  "portBackup":[[card, masterPort, backupPort],…]} — card = the controller's output cards in slot order, port / index 0-based.
"""
import json, socket, struct, sys, time, urllib.error, urllib.parse, urllib.request, uuid
import wirelog   # the flight recorder (every REST call and announcement)

APP_ID = 'OpenNova_' + str(uuid.uuid4())
PORT_MAX = 659722                      # 1G port at 8-bit / 60 Hz when the card doesn't say (MX40 Pro) [R]
GAMUTS = {'original': 'Original', 'rec709': 'Rec.709', 'dcip3': 'DCI-P3', 'dcip3d65': 'DCI-P3(D65)', 'rec2020': 'Rec.2020', 'input': 'From Input'}
BITDEPTH = {8: 0, 10: 1, 12: 2}
STATUS = {0: 'ok', 1: 'warning', 2: 'error'}


def _num(v):
    """A reading or None when the device gave none (a missing temperature must not look like 0 °C)."""
    try: return float(v) if v not in (None, '') else None
    except (TypeError, ValueError): return None


class CoexError(Exception):
    pass


class Coex:
    def __init__(self, host, port=8001, timeout=20):
        import netif   # host "ip%interface": through that interface only (the same IP on another network); recorded as given
        self.host, self.port, self.timeout = host, int(port), timeout
        self.ip, self.zone = netif.split_host(host)

    def _open(self, rq, timeout):
        import netif
        if self.zone: rq.full_url = rq.full_url.replace(self.host, self.ip, 1)   # the URL recorded keeps the interface
        return netif.urlopen(rq, timeout, self.zone)

    def _req(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        url = 'http://%s:%d/api/v1/%s' % (self.host, self.port, path)
        rq = urllib.request.Request(url, data=data, method=method, headers={'Content-Type': 'application/json', 'Application-Id': APP_ID})
        reqh = dict(rq.header_items()); t0 = time.time()
        try:
            with self._open(rq, self.timeout) as r:
                raw = r.read(); code = r.status; resph = dict(r.headers.items())
        except urllib.error.HTTPError as e:
            raw = e.read(); wirelog.http(method, url, data, e.code, raw, (time.time() - t0) * 1000, 'HTTP %d' % e.code, reqh, dict(e.headers.items()) if e.headers else None); raise
        except OSError as e:
            wirelog.http(method, url, data, None, None, (time.time() - t0) * 1000, str(e), reqh); raise
        wirelog.http(method, url, data, code, raw, (time.time() - t0) * 1000, None, reqh, resph)
        if not raw: return None
        j = json.loads(raw)
        if isinstance(j, dict) and 'code' in j:
            if j['code'] != 0: raise CoexError('%s %s: code %s %s' % (method, path, j['code'], j.get('message')))
            return j.get('data')
        return j

    def upload(self, method, path, fields, timeout=600):
        """multipart (device/cabinet/ncpfile): fields = [(name, filename|None, bytes)]"""
        import rcvfile
        body, ctype = rcvfile.multipart(fields)
        url = 'http://%s:%d/api/v1/%s' % (self.host, self.port, path)
        rq = urllib.request.Request(url, data=body, method=method, headers={'Content-Type': ctype, 'Application-Id': APP_ID})
        reqh = dict(rq.header_items()); t0 = time.time()   # the whole multipart body is recorded (a side file when big)
        try:
            with self._open(rq, timeout) as r: raw = r.read(); code = r.status; resph = dict(r.headers.items())
        except urllib.error.HTTPError as e:
            wirelog.http(method, url, body, e.code, e.read(), (time.time() - t0) * 1000, 'HTTP %d' % e.code, reqh, dict(e.headers.items()) if e.headers else None); raise
        except OSError as e:
            wirelog.http(method, url, body, None, None, (time.time() - t0) * 1000, str(e), reqh); raise
        wirelog.http(method, url, body, code, raw, (time.time() - t0) * 1000, None, reqh, resph)
        j = json.loads(raw) if raw else {}
        if isinstance(j, dict) and j.get('code', 0) != 0: raise CoexError('%s %s: code %s %s' % (method, path, j['code'], j.get('message')))
        return j.get('data') if isinstance(j, dict) else j

    def get(self, path, body=None): return self._req('GET', path, body)
    def put(self, path, body): return self._req('PUT', path, body)
    def post(self, path, body): return self._req('POST', path, body)
    def delete(self, path, body): return self._req('DELETE', path, body)

    def info(self):
        """Identity, output cards in slot order (each with its outputIDs), the first screen and what is placed on it."""
        hw = self.get('device/hw')
        cards = sorted(self.get('device/outputcard/info', {}) or [], key=lambda c: c.get('hwSlotId', c['id']))
        out = []
        for c in cards:
            cv = (c.get('canvasList') or [{}])[0]
            ports = sorted((p['id'] for p in ((cv.get('outputPortInfo') or {}).get('netPortInfoList') or [])))
            out.append({'id': c['id'], 'modelId': c.get('modelId'), 'name': c.get('name'), 'canvasId': cv.get('canvasId', c['id'] << 8),
                        'ports': ports})
        if not out and hw.get('modelID') == 5141:      # MX40 Pro is one board (card 8, 20 ports), just in case
            out = [{'id': 8, 'modelId': 5141, 'name': 'MX40 Pro', 'canvasId': 2048, 'ports': list(range(2048, 2068))}]
        scr = (self.get('screen') or {}).get('screens') or []   # no body: with {isNeedCabinetInfo} the emulator left cabinets out
        s = scr[0] if scr else None
        placed = []
        if s:
            for cv in s.get('canvases') or []:
                if cv.get('backupType') == 1: continue   # a backup card's canvas: the controller mirrors the master there
                for cb in cv.get('cabinets') or []:
                    placed.append({'canvasID': cv['canvasID'], 'cabinetID': int(cb['cabinetID']), 'outputID': cb.get('outputID'),
                                   'x': (cb.get('position') or {}).get('x'), 'y': (cb.get('position') or {}).get('y'),
                                   'w': (cb.get('size') or {}).get('width'), 'h': (cb.get('size') or {}).get('height')})
        inputs = []
        try:
            for ic in self.get('device/input/inputcard/info', {}) or []:
                for src in ic.get('sourceList') or []:
                    r = src.get('actualResolution') or {}
                    inputs.append({'card': ic.get('name'), 'name': src.get('name'), 'signal': src.get('sourceStatus') == 1,
                                   'width': r.get('width'), 'height': r.get('height'), 'rate': src.get('actualRefreshRate')})
        except Exception: pass
        try: lock = self.get('device/hw/lock') or {}
        except Exception: lock = {}
        return {'name': hw.get('name'), 'customName': hw.get('customName'), 'modelId': hw.get('modelID'), 'sn': hw.get('sn'),
                'inputs': inputs, 'locked': bool(lock.get('locked')), 'lockedBy': lock.get('ip') or '',
                'mac': hw.get('mac') or '', 'version': hw.get('hwVersion'), 'capability': hw.get('capability') or {},
                'cards': out, 'screen': s, 'placed': placed}


def mac24(mac): return int((mac or '0').replace(':', '').replace('-', ''), 16) & 0xFFFFFF
def cabinet_id(mac, output_id, index): return (mac24(mac) << 32) | (output_id << 16) | index


# ------------------------------------------------------------------ discovery
def discover(timeout=4.0, probe=()):
    """Controllers announce themselves every 3 s to UDP 54622-54624 (directed broadcast; emulators also multicast
    224.0.0.123): {"data":[{apiPort, mac, authType, workMode, https}]}. We listen on every interface, and also ask `probe`
    ("ip:port") directly (manual add = GET device/hw on port 8001). Each controller's interface ('iface') is the one whose
    subnet holds its address (an announcement on a network switched off in Settings > Network is left out); the same
    address on two interfaces' networks with two MACs announcing = two isolated networks with the same address: each
    interface is asked through itself and each controller found is reached through its own (netif.same_ip)."""
    import netif
    seen, macs = {}, {}   # macs[(ip, port)] = every MAC announcing from there: more than one = an IP conflict
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(('0.0.0.0', 54622))
        try: s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, struct.pack('4s4s', socket.inet_aton('224.0.0.123'), socket.inet_aton('127.0.0.1')))
        except OSError: pass
        s.settimeout(0.25); end = time.time() + timeout
        while time.time() < end:
            try: data, addr = s.recvfrom(65535)   # a whole datagram, however big
            except socket.timeout: continue
            except OSError: continue                   # one bad datagram must not end the search
            wirelog.udp('rx', addr, data, 'coex')
            import vendortap
            if vendortap.relayed(addr[0]): continue   # a Tools ▸ Vendor Apps relay's announcement for XCenter, not a controller of ours
            try:
                for a in json.loads(data.decode('utf-8', 'replace')).get('data') or []:
                    seen.setdefault((addr[0], int(a['apiPort'])), a)
                    if a.get('mac'): macs.setdefault((addr[0], int(a['apiPort'])), set()).add(a['mac'])
            except (ValueError, KeyError, TypeError): pass
    except OSError: pass
    finally: s.close()
    typed = set()
    for p in probe or ():
        h, _, pt = p.partition(':'); seen.setdefault((h, int(pt or 8001)), {'apiPort': pt or '8001'}); typed.add((h, int(pt or 8001)))
    out = []
    for (ip, port), a in seen.items():
        if a.get('authType') not in (None, 0): out.append({'ip': ip, 'port': port, 'error': 'needs a login (authType %s)' % a.get('authType')}); continue
        lo = ip.startswith('127.')
        cands = [netif.owner(ip)] if lo else netif.peer_ifaces(ip)
        if not lo and (ip, port) not in typed:
            if cands and not any(netif.search_on(c) for c in cands): continue   # that network is switched off (Settings > Network)
            cands = [c for c in cands if netif.search_on(c)]
        m = sorted(macs.get((ip, port)) or [])
        ask = [(netif.zoned(ip, c), c) for c in cands] if len(cands) > 1 and len(m) > 1 else [(ip, cands[0] if cands else netif.route_iface(ip))]
        got = []
        for host, iface in ask:
            try: hw = Coex(host, port, timeout=3).get('device/hw')
            except Exception: continue
            got.append({'ip': ip, 'port': port, 'mac': hw.get('mac'), 'SN': hw.get('sn'), 'modelId': hw.get('modelID'), 'iface': iface,
                        'deviceName': hw.get('customName') or hw.get('name'), 'model': hw.get('name'), 'emulator': a.get('workMode') == 1,
                        'conflict': ('%d controllers announce from %s (MAC %s) — an IP conflict' % (len(m), ip, ', '.join(m))) if len(m) > 1 else None})
        if len(got) > 1 and len({g['mac'] for g in got}) == 1: got = got[:1]   # one controller reached both ways (bridged networks)
        out += got
    return netif.same_ip(sorted(out, key=lambda x: (x['ip'], x['port'], x.get('iface') or '')), 'a controller')


# ------------------------------------------------------------------ detection
def cabinet_ident(x):
    """One card's identity for the .rcfgx / NCP guard (rcvfile's neutral shape) from GET device/cabinet. The card's ModelID
    isn't in that reply (it's in device/cabinet/baseinfo, not used yet): it comes from the card name (rcvguard.CARD_NAMES)."""
    import rcvfile, rcvguard
    ri, f, sz = x.get('rvCardInfo') or {}, x.get('cabinetFileParam') or {}, x.get('size') or {}
    mr = ri.get('moduleResolution') or {}
    name = f.get('cardModel') or x.get('rvCardName') or None
    mid = next((k for k, v in rcvguard.CARD_NAMES.items() if name and rcvguard.norm(v) == rcvguard.norm(name)), None)
    i = rcvfile._blank(); i['gen'] = None
    i.update({'modelId': mid, 'cardName': name, 'w': sz.get('width'), 'h': sz.get('height'),
              'modW': mr.get('width'), 'modH': mr.get('height'), 'ic': ri.get('driverChip') or None,
              'decoderName': ri.get('decodeIc') or None, 'scan': ri.get('scanNumber'), 'grey': ri.get('grayScale'),
              'ncp': bool(f.get('cabinetName')) if f else None, 'mfr': f.get('manufactureName') or x.get('manufacture') or None,
              'cabinet': f.get('cabinetName') or x.get('cabType') or None, 'version': f.get('version') or x.get('ncpVersion') or None,
              'fw': {k: v for k, v in (('fpga', ri.get('firmware')), ('fpgaRemark', ri.get('firmwareRemark')), ('mcu', ri.get('mcuFirmWare'))) if v}})
    return i


def ncp_send(dev, data, name, cabinet, ids, log):
    """Send an NCP to receiving cards the way VMP's Layout ▸ Change Model does it (RCV_FILE_GUARD.md §3b.3, captured against
    VMP's controller emulator): cfg/exist → (not there) PUT device/cabinet/ncpfile (multipart text = file name, file) →
    PUT device/cabinet/ncp/update/cfgfile {idList, isModifyDefaultNcp false, updateTime 0, ncpParam, cfgParam}. No save
    afterwards (VMP's Save Rv-card Config is separate). The app runs the file guard first."""
    import os, rcvfile
    fid = rcvfile.identity(data, name)
    if not fid.get('ok') or fid.get('kind') != 'ncp': raise CoexError('not a readable NCP: %s' % fid.get('error', fid.get('kind')))
    cab = fid['cabinets'][int(cabinet or 0)]
    pack = fid.get('packName') or os.path.splitext(os.path.basename(name))[0]
    ncpParam = {'creatTime': fid.get('creatTime') or '', 'packName': pack}
    cfgParam = {k: cab['cfgParam'].get(k) for k in ('status', 'manufactureName', 'issue', 'cardModel', 'cabinetName', 'version')}
    have = dev.get('device/cabinet/cfg/exist', {'ncpParam': ncpParam, 'cfgParam': cfgParam})
    if not have:
        fn = os.path.basename(name) or pack + '.ncp'
        log('NCP %s (%.1f MB) -> ncpfile' % (fn, len(data) / 1048576.0))
        dev.upload('PUT', 'device/cabinet/ncpfile', [('text', None, fn.encode('utf-8')), ('file', fn, data)])
    else:
        log('NCP %s is already on the controller' % pack)
    idl = [int(i) for i in ids]
    log('update/cfgfile %d cabinet(s) -> %s' % (len(idl), cfgParam.get('cabinetName')))
    dev.put('device/cabinet/ncp/update/cfgfile', {'idList': idl, 'isModifyDefaultNcp': False, 'updateTime': 0, 'ncpParam': ncpParam, 'cfgParam': cfgParam})
    return {'ok': True, 'cabinets': len(idl), 'pack': pack, 'uploaded': not have}


def inputs(dev):
    """The inputs with what they receive and their EDID — read-only, GET device/input/sources {} [R tap_mx40]:
    [{id, name, signal, width, height, rate, edid: {text, custom}, supports, color}]."""
    out = []
    for e in dev.get('device/input/sources', {}) or []:
        ar, de = e.get('actualResolution') or {}, e.get('defaultEDID') or {}
        res = de.get('resolution') or {}
        out.append({'id': e.get('id'), 'name': e.get('name'), 'signal': e.get('sourceStatus') == 1,
                    'width': ar.get('width'), 'height': ar.get('height'), 'rate': e.get('actualRefreshRate'),
                    'edid': {'width': res.get('width'), 'height': res.get('height'), 'rate': de.get('refreshRate'),
                             'custom': bool(e.get('isEdidCustom') or de.get('isCustom')), 'supported': e.get('isSupportEDID')} if (de or 'isSupportEDID' in e) else None,
                    'supports': e.get('supportResolution'), 'color': (e.get('colorSpace'), e.get('gamut'), e.get('dynamicRange'))})
    return out


def identify(dev):
    """Read-only: every card's identity, flat [{dst (output card in slot order), port, index, cabinetId, id}]."""
    info = dev.info()
    d = detect(dev, False, info)
    try:
        pl = [{'outputCardID': c['id'], 'canvasID': c['canvasId'], 'outputIDs': c['ports']} for c in info['cards']]
        mid = {str(x['id']): x.get('modelID') for x in dev.get('device/cabinet/baseinfo', {'type': 1, 'portList': pl}) or []}
    except (CoexError, OSError, ValueError): mid = {}
    for card in d['cards']:
        for lst in card['ports'].values():
            for c in lst:
                if mid.get(str(c['id'])): c['ident']['modelId'] = mid[str(c['id'])]
    return [{'dst': ci, 'port': int(p), 'index': c['index'], 'cabinetId': str(c['id']), 'id': c['ident']}
            for ci, card in enumerate(d['cards']) for p, lst in card['ports'].items() for c in lst]


def detect(dev, refresh=False, info=None):
    """Detected receiving cards per output card and port, in cable order: {cards:[{id, ports:{port:[{index,width,height,
    cabinet,card,firmware,id}]}}]} (port / index 0-based)."""
    info = info or dev.info()
    if refresh:
        dev.post('device/cabinet/refresh', {'type': 0, 'canvasIdList': []})
        end = time.time() + 8
        while time.time() < end:
            time.sleep(0.4)
            if not ((dev.get('device/cabinet/refreshing-port') or {}).get('portIDs')): break
    pl = [{'outputCardID': c['id'], 'canvasID': c['canvasId'], 'outputIDs': c['ports']} for c in info['cards']]
    found = dev.get('device/cabinet', {'type': 1, 'portList': pl}) or []
    by = {}
    for x in found:
        by.setdefault(x['outputID'], []).append(x)
    cards = []
    for c in info['cards']:
        ports = {}
        for o in c['ports']:
            lst = sorted(by.get(o, []), key=lambda x: x['index'])
            if lst:
                ports[o - (c['id'] << 8)] = [{'index': x['index'], 'width': (x.get('size') or {}).get('width'), 'height': (x.get('size') or {}).get('height'),
                                              'cabinet': x.get('cabType') or '', 'card': x.get('rvCardName') or '',
                                              'firmware': (x.get('rvCardInfo') or {}).get('firmware') or '', 'id': str(x['id']),
                                              'ident': cabinet_ident(x)} for x in lst]
        cards.append({'id': c['id'], 'ports': ports})
    return {'model': info['modelId'], 'name': info['name'], 'cards': cards}


# ------------------------------------------------------------------ layout
def build_send(info, layout, det=None):
    """(canvas moves, cabinet POST body, backup calls, warnings). Each card's canvas sits at the top-left of its cabinets;
    cabinet positions are relative to their canvas [R]. Detected IDs / sizes are preferred where they exist."""
    s = info['screen']
    if not s: raise CoexError('the controller has no screen')
    cards = info['cards']; warn = []
    dmap = {}
    for ci, c in enumerate((det or {}).get('cards') or []):
        for p, lst in c['ports'].items():
            for x in lst: dmap[(ci, int(p), x['index'])] = x
    by_card = {}
    for cb in layout.get('cabinets') or []:
        ci = int(cb.get('card', 0))
        if ci >= len(cards): raise CoexError('the layout uses output card %d, the controller has %d' % (ci + 1, len(cards)))
        if int(cb['port']) >= len(cards[ci]['ports']): raise CoexError('card %d has no port %d (it has %d)' % (ci + 1, cb['port'] + 1, len(cards[ci]['ports'])))
        by_card.setdefault(ci, []).append(cb)
    canvases, moves = [], []
    cur_pos = {cv['canvasID']: cv.get('position') or {'x': 0, 'y': 0} for cv in s.get('canvases') or []}
    for ci, lst in sorted(by_card.items()):
        c = cards[ci]; x0 = min(int(b['x']) for b in lst); y0 = min(int(b['y']) for b in lst)
        if cur_pos.get(c['canvasId']) != {'x': x0, 'y': y0}: moves.append({'canvasID': c['canvasId'], 'position': {'x': x0, 'y': y0}})
        cabs = []
        for b in sorted(lst, key=lambda b: (b['port'], b['index'])):
            oid = c['ports'][int(b['port'])]; d = dmap.get((ci, int(b['port']), int(b['index'])))
            w, h = int(b['width']), int(b['height'])
            if d and (d['width'], d['height']) != (w, h):
                warn.append('Card %d port %d cable position %d: the project has %dx%d, the controller detects %s %dx%d'
                            % (ci + 1, b['port'] + 1, b['index'] + 1, w, h, d['cabinet'], d['width'], d['height']))
            cabs.append({'cabinetID': int(d['id']) if d else cabinet_id(info['mac'], oid, int(b['index'])), 'connectID': int(b['index']),
                         'position': {'x': int(b['x']) - x0, 'y': int(b['y']) - y0}, 'lockStatus': False, 'outputID': oid,
                         'angle': 0, 'pageID': 0, 'size': {'height': h, 'width': w}})
        canvases.append({'canvasID': c['canvasId'], 'cabinets': cabs})
    # port backup: custom pairs per card (mode 3), or off; written only when it differs from the controller's
    want = {}
    for ci, mp, bp in layout.get('portBackup') or []:
        c = cards[int(ci)]; want.setdefault(c['id'], []).append({'masterPort': c['ports'][int(mp)], 'backupPort': c['ports'][int(bp)]})
    for cv in canvases:
        oids = {b['outputID'] for b in cv['cabinets']}
        for ps in want.values():
            for q in ps:
                if q['backupPort'] in oids: raise CoexError('port %d carries cabinets, so it can\'t be a backup port' % ((q['backupPort'] & 0xFF) + 1))
    return {'screenID': s['screenID'], 'moves': moves, 'post': {'screenID': s['screenID'], 'canvases': canvases}, 'backup': want, 'warnings': warn}


def current_backup(dev):
    out = {}
    for x in dev.get('device/netport/backup') or []:
        lst = x.get('netPortBackupList') or x.get('netPortBackuplist') or []
        out[x['subCardId']] = sorted((q['masterPort'], q['backupPort']) for q in lst) if x.get('netPortBackupMode') else []
    return out


def clear_calls(info):
    by = {}
    for p in info['placed']: by.setdefault(p['canvasID'], []).append({'cabinetID': p['cabinetID'], 'outputID': p['outputID'], 'pageID': 0})
    return {'screenID': info['screen']['screenID'], 'canvases': [{'canvasID': k, 'cabinets': v} for k, v in sorted(by.items())]} if by else None


def run_send(dev, layout, log, dry=False):
    t0 = time.time()
    def say(s): log('%8.3f  %s' % (time.time() - t0, s))
    info = dev.info()
    say('# %s (%s, model %s) MAC %s: %d cards, %d placed' % (info['customName'] or info['name'], info['name'], info['modelId'], info['mac'], len(info['cards']), len(info['placed'])))
    det = detect(dev, False, info)
    plan = build_send(info, layout, det)
    for w in plan['warnings']: say('! ' + w)
    cur = current_backup(dev)
    bcalls = []
    for c in info['cards']:
        w = sorted((q['masterPort'], q['backupPort']) for q in plan['backup'].get(c['id'], []))
        if w == cur.get(c['id'], []): continue
        if w: bcalls.append(('PUT', 'device/netport/backup', [{'subCardId': c['id'], 'netPortBackupMode': 3, 'netPortBackupList': [{'masterPort': m, 'backupPort': b} for m, b in w]}]))
        else: bcalls.append(('DELETE', 'device/netport/backup', {'subCardIdList': [c['id']]}))
    # sending-card backup (layout 'cardBackup' = [[masterCard, backupCard]] in slot order): every port of the backup card
    # backs up the same port of the master [R]; written only when it differs from the controller's (hwinfo.outputCardBackup)
    ccalls = []
    if 'cardBackup' in layout:
        ids = [c['id'] for c in info['cards']]
        want = {(ids[int(m)], ids[int(b)]) for m, b in layout['cardBackup'] or [] if int(m) < len(ids) and int(b) < len(ids)}
        used = {cv['canvasID'] >> 8 for cv in plan['post']['canvases'] if cv['cabinets']}
        for m, b in want:
            if b in used: raise CoexError('output card %d carries cabinets, so it cannot be the backup card' % (ids.index(b) + 1))
        cur = {(x['masterOutputCardId'], x['backupOutputCardId']) for x in (dev.get('device/hwinfo', {'keyValueList': []}) or {}).get('outputCardBackup') or []}
        for m, b in sorted(cur - want): ccalls.append({'masterOutputCardId': m, 'backupOutputCardId': b, 'enable': False})
        for m, b in sorted(want - cur): ccalls.append({'masterOutputCardId': m, 'backupOutputCardId': b, 'enable': True})
    n = sum(len(cv['cabinets']) for cv in plan['post']['canvases'])
    clr = clear_calls(info)
    say('DELETE screen/cabinets (%d placed)%s' % (len(info['placed']), ' [dry run]' if dry else ''))
    if plan['moves']: say('PUT screen/canvas/position %s%s' % ([m['canvasID'] for m in plan['moves']], ' [dry run]' if dry else ''))
    say('POST screen/cabinets (%d cabinets)%s' % (n, ' [dry run]' if dry else ''))
    for m, p, b in bcalls: say('%s %s%s' % (m, p, ' [dry run]' if dry else ''))
    for c in ccalls: say('PUT device/outputcard/backup %s%s' % (json.dumps(c), ' [dry run]' if dry else ''))
    if dry: return {'ok': True, 'dry': True, 'cabinets': n, 'warnings': plan['warnings']}
    if clr: dev.delete('screen/cabinets', clr)
    if plan['moves']: dev.put('screen/canvas/position', {'screenID': plan['screenID'], 'canvases': plan['moves'], 'layers': []})
    if n: dev.post('screen/cabinets', plan['post'])
    for m, p, b in bcalls: dev._req(m, p, b)
    for c in ccalls: dev.put('device/outputcard/backup', c)
    after = dev.info()
    want = sorted(c['cabinetID'] for cv in plan['post']['canvases'] for c in cv['cabinets'])
    got = sorted(p['cabinetID'] for p in after['placed'])
    ok = want == got
    say('read back: %d cabinets placed, %s' % (len(got), 'all match' if ok else 'MISMATCH'))
    if bcalls:
        nb = current_backup(dev); bok = all(nb.get(cid, []) == sorted((q['masterPort'], q['backupPort']) for q in plan['backup'].get(cid, [])) for cid in nb)
        say('read back: port backup %s' % ('match' if bok else 'MISMATCH')); ok = ok and bok
    return {'ok': ok, 'cabinets': len(got), 'warnings': plan['warnings']}


def read_layout(dev, info=None):
    info = info or dev.info()
    slot = {c['id']: i for i, c in enumerate(info['cards'])}
    pos = {cv['canvasID']: cv.get('position') or {'x': 0, 'y': 0} for cv in (info['screen'] or {}).get('canvases') or []}
    out = []
    for p in info['placed']:
        oid = p['outputID']; cp = pos.get(p['canvasID'], {'x': 0, 'y': 0})
        out.append({'card': slot.get(oid >> 8, 0), 'port': oid & 0xFF, 'index': p['cabinetID'] & 0xFFFF, 'x': p['x'] + cp['x'], 'y': p['y'] + cp['y'],
                    'w': p['w'], 'h': p['h'], 'cabinetID': str(p['cabinetID'])})
    return out


# ------------------------------------------------------------------ health
def health(dev):
    """Neutral health snapshot (as unicolink.health), card = output card in slot order."""
    info = dev.info()
    slot = {c['id']: i for i, c in enumerate(info['cards'])}
    m = dev.get('device/monitor/info', {'isNeedCabinetInfo': 0}) or {}
    placed = {}
    for p in info['placed']: placed[p['outputID']] = placed.get(p['outputID'], 0) + 1
    ports = []
    for o in m.get('outputStatus') or []:
        oid = o['outputID']
        if oid not in placed: continue
        ports.append({'card': slot.get(oid >> 8, 0), 'port': oid & 0xFF, 'link': 'ok' if o.get('linkStatus') else 'no link', 'onBackup': False, 'cabinets': placed[oid]})
    cabs = []
    for c in m.get('cabinets') or []:
        for r in c.get('rvCards') or []:
            oid = c.get('outPutID') or r.get('netPortIndex'); b = r.get('backupStatus') or {}
            cabs.append({'card': slot.get(oid >> 8, 0), 'port': oid & 0xFF, 'index': c.get('index', r.get('cabinetIndex', 0)),
                         'side': 'backup' if b.get('mode') == 1 else 'primary', 'dark': False,
                         'temp': _num((r.get('temperature') or {}).get('value')), 'tempStatus': STATUS.get((r.get('temperature') or {}).get('status'), 'ok'),
                         'voltage': _num((r.get('voltage') or {}).get('value')), 'voltStatus': STATUS.get((r.get('voltage') or {}).get('status'), 'ok'),
                         'bitErrors': sum(e.get('value', 0) for e in r.get('errorBit') or []),
                         'nextLink': (r.get('nextCabinetLinkStatus') or {}).get('linkStatus', True)})
    for p in ports: p['onBackup'] = any(c['side'] == 'backup' for c in cabs if c['card'] == p['card'] and c['port'] == p['port'])
    # events in the wording the other readers use (unicolink / novalink), so one alarm catalogue explains all three
    events, last = [], {}
    for c in cabs: last[(c['card'], c['port'])] = max(last.get((c['card'], c['port']), -1), c['index'])
    for p in ports:
        if p['link'] != 'ok': events.append({'level': 'error', 'card': p['card'], 'port': p['port'], 'index': None, 'text': 'port disconnected'})
        elif p['onBackup']: events.append({'level': 'warning', 'card': p['card'], 'port': p['port'], 'index': None, 'text': 'running on backup'})
    for c in cabs:
        w = dict(card=c['card'], port=c['port'], index=c['index'])
        if c['tempStatus'] in ('warning', 'error'): events.append(dict(w, level=c['tempStatus'], text='temperature %.1f °C' % c['temp'] if c['temp'] is not None else 'temperature ' + c['tempStatus']))
        if c['voltStatus'] in ('warning', 'error'): events.append(dict(w, level=c['voltStatus'], text='supply voltage %.1f V' % c['voltage'] if c['voltage'] is not None else 'supply voltage ' + c['voltStatus']))
        if c['bitErrors']: events.append(dict(w, level='warning', text='bit errors'))
        if not c['nextLink'] and c['index'] < last[(c['card'], c['port'])]: events.append(dict(w, level='error', text='data link broken'))
    device = {'temp': _num((m.get('mainBoardTemperature') or {}).get('value')), 'voltage': _num((m.get('mainBoardVoltage') or {}).get('value')),
              'fans': m.get('fanInfos') or []}
    return {'ports': sorted(ports, key=lambda x: (x['card'], x['port'])), 'cabinets': sorted(cabs, key=lambda x: (x['card'], x['port'], x['index'])),
            'device': device, 'events': events}


# ------------------------------------------------------------------ helper routes (novalink.py serve)
def handle(path, body, log):
    if path == '/api/coex/discover':
        return {'ok': True, 'devices': discover(float(body.get('timeout', 4)), body.get('probe') or ())}
    dev = Coex(body['host'], int(body.get('port', 8001)))
    if path == '/api/coex/info':
        return {'ok': True, 'info': dev.info()}
    if path == '/api/coex/rcv-send':                     # NCP to receiving cards (after the app's file guard)
        import base64
        log('# NCP %s -> %s, %d cabinet(s); guard %s' % (body.get('name'), body['host'], len(body.get('cabinetIds') or []), body.get('verdict')))
        return ncp_send(dev, base64.b64decode(body['data']), body.get('name', ''), body.get('cabinet') or 0, body.get('cabinetIds') or [], log)
    if path == '/api/coex/cabinet-restart':              # PUT device/cabinet/reboot {idList} [R VMP_TOUR]; no ids = every card found
        ids = body.get('ids') or [c['cabinetId'] for c in identify(dev)]
        log('# restart %d receiving card(s) on %s' % (len(ids), body['host']))
        if ids: dev.put('device/cabinet/reboot', {'idList': [int(x) for x in ids]})
        return {'ok': True, 'cards': len(ids)}
    if path == '/api/coex/ber-clear':                    # the user's Clear: DELETE device/cabinet/errorbit {idList} [R VMP_TOUR, tap_mx40d:L571]
        info = dev.info(); tg = body.get('targets')       # [{card, port, index}] or None = every placed cabinet (VMP's bin icon)
        ids = [p['cabinetID'] for p in info['placed']] if not tg else \
            [cabinet_id(info['mac'], info['cards'][int(t['card'])]['ports'][int(t['port'])], int(t['index'])) for t in tg if int(t['card']) < len(info['cards'])]
        log('# clear errors: DELETE device/cabinet/errorbit, %d cabinet(s) on %s' % (len(ids), body['host']))
        if ids: dev.delete('device/cabinet/errorbit', {'idList': ids})
        return {'ok': True, 'cabinets': len(ids)}
    if path == '/api/coex/inputs':                       # inputs + EDID, read-only
        return {'ok': True, 'inputs': inputs(dev)}
    if path == '/api/coex/identify':                     # read-only card identity for the .rcfgx / NCP guard
        return {'ok': True, 'cards': identify(dev)}
    if path == '/api/coex/detect':
        d = detect(dev, bool(body.get('refresh')))
        for c in d['cards']:
            for lst in c['ports'].values():
                for x in lst: x['id'] = str(x['id'])
        return {'ok': True, 'detected': d}
    if path == '/api/coex/send':
        log('# target %s:%s' % (body['host'], body.get('port', 8001)))
        return run_send(dev, body['layout'], log, bool(body.get('dry')))
    if path == '/api/coex/clear':
        info = dev.info(); clr = clear_calls(info)
        if clr and not body.get('dry'): dev.delete('screen/cabinets', clr)
        log('# clear: %d cabinets%s' % (len(info['placed']), ' [dry run]' if body.get('dry') else ''))
        return {'ok': True, 'cleared': len(info['placed'])}
    if path == '/api/coex/read-layout':
        return {'ok': True, 'cabinets': read_layout(dev)}
    if path == '/api/coex/health':
        return {'ok': True, 'health': health(dev)}
    if path == '/api/coex/save':                         # VMP Save Rv-card Config (rv parameters) [R]; never part of a send
        info = dev.info(); ids = [p['cabinetID'] for p in info['placed']]
        if not ids: return {'ok': False, 'error': 'no cabinets placed'}
        dev.put('device/cabinet/solid', {'idList': ids, 'type': 1})
        log('# save: PUT device/cabinet/solid %d cabinets' % len(ids))
        return {'ok': True, 'cabinets': len(ids)}
    if path == '/api/coex/cabinets':                     # display / identify / mapping / pattern
        info = dev.info(); act = body.get('action'); canv = [c['canvasId'] for c in info['cards']]
        tg = body.get('targets')                          # [{card, port, index}] or None = everything
        ids = [p['cabinetID'] for p in info['placed']] if tg is None else \
            [cabinet_id(info['mac'], info['cards'][int(t['card'])]['ports'][int(t['port'])], int(t['index'])) for t in tg if int(t['card']) < len(info['cards'])]
        if act == 'display':                              # 0 normal 1 blackout 2 freeze [R]
            if tg is None: dev.put('device/displaymode', {'value': int(body['mode']), 'canvasIDs': canv})
            else: dev.put('device/cabinet/displaymode', {'mode': int(body['mode']), 'cids': ids})
        elif act == 'identify':                           # the receiving card's indicator LED [R]
            dev.put('device/cabinet/indicatorlightstate', {'idList': ids, 'enable': bool(body.get('on'))})
        elif act == 'mapping':                            # port / number overlay per canvas [R]
            dev.put('screen/output/canvas/mapping', {'enable': bool(body.get('on')), 'canvasIds': canv})
        elif act == 'pattern':                            # receiving-card self-test (codes checked on the emulator, see docs)
            if not ids: return {'ok': False, 'error': 'the controller has no cabinets placed yet'}
            dev.put('device/cabinet/testpattern', {'idList': ids, 'testmode': int(body['mode'])})
        else: raise KeyError(act)
        log('# %s %s on %s' % (act, body.get('mode', body.get('on')), 'everything' if tg is None else '%d cabinets' % len(ids)))
        return {'ok': True, 'cabinets': len(ids)}
    if path == '/api/coex/screen':                       # colour / output settings on the screen [R, docs §9]
        info = dev.info(); s = info['screen']
        if not s: return {'ok': False, 'error': 'the controller has no screen'}
        sid = s['screenID']; a = body.get('action'); v = body.get('value')
        ids = [p['cabinetID'] for p in info['placed']]
        if a == 'brightness':
            if not ids: return {'ok': False, 'error': 'no cabinets placed'}
            dev.put('device/cabinet/brightness', {'idList': ids, 'brightnessBaseValue': 0, 'nit': 0, 'ratio': float(v) / 100.0, 'ratioCol': False})
        elif a == 'gamma':
            if not ids: return {'ok': False, 'error': 'no cabinets placed'}
            dev.put('device/cabinet/gamma', {'type': 3, 'idList': ids, 'value': float(v)})
        elif a == 'colortemp': dev.put('screen/colortemperature', {'screenIdList': [sid], 'colorTemperature': int(v)})
        elif a == 'gamut': dev.put('screen/output/gamut', {'name': GAMUTS[v], 'screenIdList': [sid]})
        elif a == 'bitdepth': dev.put('screen/output/bitdepth', {'screenIdList': [sid], 'bitDepth': BITDEPTH[int(v)]})
        elif a == 'lowlatency':
            dev.put('screen/mode', {'screenID': sid, 'layoutMode': s.get('layoutMode', 0), 'workingMode': s.get('workingMode', 1),
                                    'lowLatency': bool(v), 'outputMode': s.get('outputMode', 0)})
        else: raise KeyError(a)
        log('# screen %s = %s' % (a, v))
        return {'ok': True}
    if path == '/api/coex/screen-read':                  # read-only: the screen's colour / output settings as VMP reads them
        # GET screen/displayparams {list:[{screenId, brightness 0-1, colorTemperature, gamma}]} and GET screen/output
        # [{screenId, lowDelay, outputBitDepth {bitDepth}, gamutList {currentGamutName}}], both VMP's own calls on the
        # controller emulator (tap_mx40d L1232, offline_10001 L1152 / L1147: 50 % -> 0.4998779, Rec.709 -> 6504 K).
        info = dev.info(); s = info['screen']
        if not s: return {'ok': False, 'error': 'the controller has no screen'}
        sid = s['screenID']
        dp = (dev.get('screen/displayparams') or {}).get('list') or []
        p = next((x for x in dp if x.get('screenId') == sid), dp[0] if dp else {})
        so = dev.get('screen/output') or []
        o = next((x for x in so if x.get('screenId') == sid), so[0] if so else {})
        names = {v: k for k, v in GAMUTS.items()}; names['From input'] = 'input'
        gn = (o.get('gamutList') or {}).get('currentGamutName')
        bd = {v: k for k, v in BITDEPTH.items()}.get((o.get('outputBitDepth') or {}).get('bitDepth'))
        return {'ok': True, 'brightness': round(float(p['brightness']) * 100.0, 1) if p.get('brightness') is not None else None,
                'gamma': p.get('gamma'), 'colorTemp': p.get('colorTemperature'),
                'gamut': names.get(gn), 'gamutName': gn, 'bitDepth': bd,
                'lowLatency': o.get('lowDelay') if 'lowDelay' in o else None}
    if path == '/api/coex/read-backup':                  # port backup pairs per output card [[card, masterPort, backupPort]]
        info = dev.info(); slot = {c['id']: i for i, c in enumerate(info['cards'])}; out = []
        for cid, pairs in current_backup(dev).items():
            for m, b in pairs: out.append([slot.get(cid, 0), m & 0xFF, b & 0xFF])
        return {'ok': True, 'pairs': out}
    # ---- presets stored on the controller (docs\PRESET_SCHEDULE_API.md §2.1 [R]); 128 slots per screen. 'layout' (VMP's
    # screenData) is off unless asked: recalling it may rewrite the cabinet layout.
    if path == '/api/coex/presets':
        info = dev.info(); sid = (info['screen'] or {}).get('screenID'); out = []
        for sp in (dev.get('preset') or {}).get('screenPresets') or []:
            if sid and sp.get('screenID') != sid: continue
            for p in sp.get('presets') or []:
                out.append({'id': p.get('presetUUID') or str(p.get('sequenceNumber')), 'slot': p.get('sequenceNumber'), 'name': p.get('name', ''),
                            'flags': {k: p.get(k) for k in ('sourceData', 'screenData', 'processingData', 'outputData')}, 'active': bool(p.get('state'))})
        return {'ok': True, 'presets': sorted(out, key=lambda x: x['slot'] or 0), 'raw': (dev.get('preset') or {})}
    if path == '/api/coex/preset-save':
        info = dev.info(); sid = info['screen']['screenID']; f = body.get('flags') or {}
        used = {p.get('sequenceNumber') for sp in (dev.get('preset') or {}).get('screenPresets') or [] for p in sp.get('presets') or []}
        slot = int(body.get('slot') or next(i for i in range(1, 129) if i not in used))
        r = dev.post('preset/update', {'preset': {'screenData': bool(f.get('layout')), 'sequenceNumber': slot, 'processingData': bool(f.get('processing', True)),
                                                  'name': str(body['name'])[:64], 'sourceData': bool(f.get('source', True)), 'outputData': bool(f.get('output', True)), 'effectSwitch': 0},
                                       'screenID': sid})
        log('# preset saved in slot %d: %s' % (slot, body['name']))
        return {'ok': True, 'id': r, 'slot': slot}
    if path == '/api/coex/preset-apply':                  # VMP / XCenter's sequence: open effect, recall, close effect [R]
        info = dev.info(); sid = info['screen']['screenID']
        b = {'deviceList': ['%s:%d' % (dev.host, dev.port)], 'sequenceNumber': int(body['slot']), 'screenIdList': [sid]}
        fx = dev.post('preset/opendisplayeffect', b)
        try: dev.post('preset/current/screens/update', b)
        finally:
            if fx is not None: dev.post('preset/closedisplayeffect', fx)
        log('# preset %s recalled' % body['slot'])
        return {'ok': True}
    if path == '/api/coex/preset-delete':
        info = dev.info()
        dev.post('preset/delete', {'screenID': info['screen']['screenID'], 'sequenceNumberList': [int(body['slot'])]})
        return {'ok': True}
    # ---- schedules (docs\PRESET_SCHEDULE_API.md §2.2 [R]): brightness strategies per screen; strategies only run while the
    # screen's Schedule switch is on (default off). Times "YYYY-MM-DD HH:MM" local; weekdays 0 = Sunday.
    if path == '/api/coex/schedules':
        info = dev.info(); sid = info['screen']['screenID']
        x = dev.get('screen/schedule/detail?screenId=' + urllib.parse.quote(sid)) or {}
        br = [{'id': q.get('strategyId'), 'start': q.get('startTime'), 'end': q.get('endTime'), 'brightness': round(float(q.get('brightnessRatio') or 0) * 100),
               'repeat': q.get('repeatList') or [] if q.get('repeatEnable') else [], 'until': q.get('repeatEndTime') or ''} for q in x.get('brightnessStrategyList') or []]
        return {'ok': True, 'enable': bool(x.get('enable')), 'brightness': br, 'presetCount': len(x.get('presetStrategyList') or []),
                'diagnosticsCount': len(x.get('diagnosticsStrategyList') or []), 'raw': x}
    if path == '/api/coex/schedule-add':
        info = dev.info(); sid = info['screen']['screenID']; rep = [int(v) for v in body.get('repeat') or []]
        g = '{%s}' % uuid.uuid4()
        until = '2069-12-31 23:59' if rep else ''
        dev.post('screen/schedule/brightness-strategy/update', {'brightnessStrategyList': [{
            'strategyId': g, 'relatedId': g, 'strategyType': 1, 'adjustType': 0, 'startTimeType': 0, 'startTime': body['start'], 'endTimeType': 0,
            'endTime': body['end'], 'brightnessRatio': round(float(body['brightness']) / 100.0, 4), 'repeatEnable': bool(rep), 'brightnessNit': 0,
            'repeatList': rep, 'repeatEndTime': until, 'originRepeatEndTime': until}], 'screenId': sid})
        log('# brightness schedule %s – %s at %s %%%s' % (body['start'], body['end'], body['brightness'], ' repeat %s' % rep if rep else ''))
        return {'ok': True, 'id': g}
    if path == '/api/coex/schedule-delete':
        info = dev.info()
        dev.post('screen/schedule/brightness-strategy/delete', {'screenId': info['screen']['screenID'], 'strategyIdList': [body['id']]})
        return {'ok': True}
    if path == '/api/coex/schedule-enable':               # the screen's Schedule switch (checked on the emulator)
        info = dev.info()
        dev.post('screen/schedule/enable/update', {'screenId': info['screen']['screenID'], 'enable': bool(body.get('enable'))})
        return {'ok': True}
    if path == '/api/coex/verify':                       # backup verify: 2 backup only, 0 normal [R]
        info = dev.info()
        dev.post('device/backup/verify', {'screenID': info['screen']['screenID'], 'verifyType': int(body['type'])})
        return {'ok': True}
    raise KeyError(path)


def main(argv):
    if not argv or argv[0] in ('-h', '--help'): print(__doc__); return 0
    cmd = argv[0]; a = dict(zip(argv[1::2], argv[2::2]))
    if cmd == 'discover':
        for d in discover(float(a.get('--timeout', 4)), [p for p in a.get('--probe', '').split(',') if p]): print(json.dumps(d))
        return 0
    dev = Coex(a['--host'], int(a.get('--port', 8001)))
    if cmd == 'info': print(json.dumps(dev.info(), indent=1)); return 0
    if cmd == 'detect': print(json.dumps(detect(dev, a.get('--refresh') == '1'), indent=1)); return 0
    print('unknown command ' + cmd); return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
