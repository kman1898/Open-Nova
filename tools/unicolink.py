"""unicolink: Open Nova's link to NovaStar Unico-family processors (VX Pro, …), which speak UServer's REST API instead of
the TG register protocol (tools\\novalink.py).

Every call here was seen live, against NovaStar's VX2000 Pro simulator and FakeUServer (docs\\UNICO_UI_TOUR.md §6–7,
docs\\FAKE_USERVER.md): discovery, login, the device reads, the topology write / delete, port backup and its verify modes.
Nothing has been sent to a real processor yet.

  python unicolink.py discover                                       UDP 5600 search, prints the devices that answer
  python unicolink.py info --host H --port P                         model, SN, MAC, screens, canvas, ports, backup state
  python unicolink.py detect --host H --port P [--refresh 0]         the cabinets the processor sees per port (rescans first)
  python unicolink.py send <layout.json> --host H --port P [--keep 1] [--dry 1]
        layout.json = {"cabinets":[{"port":0,"index":0,"x":0,"y":0,"width":192,"height":192},…], "portBackup":[[0,10],…]}
        port / index 0-based (index = cable order on the port). Replaces the screen's topology unless --keep 1.
        Ports run across the sending cards in slot order (an H2 with two 4xOPT cards: 0-31 = OUT-5, 32-63 = OUT-6).
  python unicolink.py serve [--port 8790]                            (normally novalink.py serve, which includes these routes)

Device-side protocol (REST, JSON; real units on 8088, the simulator on a free port):
  login     POST /unico/v1/system/auth/login {"username":"admin","password":base64("123456")} -> data.token (Authorization)
  topology  POST   screen/cabinets/topology [{cabinetID, guid, canvasId, cabinetPosition{x,y}, cabinetSize{width,height}, viewId:0}]
            DELETE screen/cabinets/topology {"cabinetIDs":[…],"screenIDs":null,"canvasIDs":null,"netPortIDs":null,"guidList":null}
  cabinetID = (MAC & 0xFFFFFF) << 32 | slot << 24 | port << 16 | index  (as a decimal string; port, index 0-based)
  canvas    PUT screen/canvas/window [{canvasID, canvasSize{canvasWidth, canvasHeight, isCustomResolution:1}, canvasPosition{0,0}, ...}]
            (Unico's Match Screen; layout.json "canvas": {"width","height"})
  port backup PUT screen/netport-backup [{screenId, screenGuid, slotId:0, backupObj:0, backupType, enableType:0,
            netportIds:[{masterNetportId, backupNetportId}]}]   backupType 0 none / 1 split / 2 sequential / 3 custom
"""
import base64, json, math, os, re, socket, struct, sys, time, urllib.error, urllib.request
import wirelog   # the flight recorder (every REST call and discovery packet)

PASSWORD = base64.b64encode(b'123456').decode()
LOAD_BASE = 655360          # pixels per port at 100 % (8-bit); Unico rounds the % up; 10-bit halves it (UNICO_UI_TOUR §6.6)


def _num(v):
    """A reading or None when the device gave none (a missing temperature must not look like 0 °C)."""
    try: return float(v) if v not in (None, '') else None
    except (TypeError, ValueError): return None


class UnicoError(Exception):
    pass


# ------------------------------------------------------------------ discovery (NOVA frame, UDP 5600)
def _crc16(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8): crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return (~crc) & 0xFFFF


def _nova(cmd, payload, seq=1):
    body = struct.pack('<I', seq) + struct.pack('<HHBB', 1, 0, 0, 0) + struct.pack('<IHH', cmd, 0, len(payload)) + payload
    head = b'NOVA' + bytes([0, 1]) + struct.pack('<IIHH', 0, 0, len(body) >> 16, len(body) & 0xFFFF)
    head += struct.pack('<H', _crc16(body))
    return head + struct.pack('<H', _crc16(head)) + body


DISC_PORT = 5600   # UCenter's search port (tests point it elsewhere)


def discover(timeout=2.0, targets=('255.255.255.255', '127.0.0.1')):
    """Broadcast UCenter's search (TLV 0x00010001) on every network interface at once (netif.udp_search; Settings > Network
    can leave one out) and collect the JSON replies: [{ip, modelId, SN, deviceName, port, iface}]. One serial number heard
    on two interfaces is one processor (bridged networks: the first answer is kept); two serial numbers from one address on
    one interface = an IP conflict (Unico warns the same way); on two interfaces = two isolated networks with the same
    address (netif.same_ip: each reached through its own)."""
    import netif, vendortap
    probe = _nova(0x00010001, b'{"searchInfo":[],"advSearchInfo":{"brand":{},"serial":{},"modelId":{}}}')
    found = {}
    for d, addr, iface in netif.udp_search(DISC_PORT, probe, 'unico', timeout, targets):
        if d[:4] != b'NOVA' or len(d) < 40: continue
        try: j = json.loads(d[40:40 + struct.unpack_from('<H', d, 38)[0]])
        except ValueError: continue
        if not isinstance(j, dict) or 'SN' not in j: continue
        if vendortap.relayed(addr[0]): continue   # a Tools > Vendor Apps relay answering with the real one's reply
        http = [p['port'] for p in j.get('protocols', []) if p.get('linkType') == 'http']
        found.setdefault(j['SN'], {'ip': addr[0], 'modelId': j.get('modelId'), 'SN': j['SN'], 'deviceName': j.get('deviceName'),
                                   'port': http[0] if http else 8088, 'iface': iface})
    by_ip = {}   # two serial numbers answering from one address on one network = an IP conflict
    for x in found.values(): by_ip.setdefault((x['ip'], x['iface']), []).append(x['SN'])
    for x in found.values():
        sns = by_ip[(x['ip'], x['iface'])]
        x['conflict'] = ('%d processors answer from %s (SN %s) — an IP conflict' % (len(sns), x['ip'], ', '.join(sorted(sns)))) if len(sns) > 1 and x['ip'] not in ('127.0.0.1',) else None
    return netif.same_ip(sorted(found.values(), key=lambda x: (x['ip'], x['port'])))


# ------------------------------------------------------------------ REST client
def _open(req, timeout, zone):
    import netif
    return netif.urlopen(req, timeout, zone)


class Unico:
    def __init__(self, host, port=8088, timeout=30):
        import netif   # host "ip%interface": through that interface only (the same IP on another network); recorded as given
        ip, self.zone = netif.split_host(host)
        self.base = 'http://%s:%d/unico/v1/' % (ip, int(port)); self.timeout = timeout; self.token = None
        self.shown = 'http://%s:%d/unico/v1/' % (host, int(port))
        self.calls = []                     # (method, path, body, code) for the log

    def _req(self, method, path, body=None):
        data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
        r = urllib.request.Request(self.base + path, data=data, method=method, headers={'Content-Type': 'application/json'})
        if self.token: r.add_header('Authorization', self.token)
        login = 'auth/login' in path                   # its password and the token it answers are the only things masked
        shown = data if not login else json.dumps(dict(body, password='<hidden>'), separators=(',', ':')).encode()
        reqh = dict(r.header_items()); t0 = time.time()
        try:
            with _open(r, self.timeout, self.zone) as x: raw = x.read(); code = x.status; resph = dict(x.headers.items())
        except urllib.error.HTTPError as e:
            wirelog.http(method, self.shown + path, shown, e.code, e.read(), (time.time() - t0) * 1000, 'HTTP %d' % e.code, reqh, dict(e.headers.items()) if e.headers else None)
            raise UnicoError('%s %s: HTTP %d' % (method, path, e.code))
        except OSError as e:
            wirelog.http(method, self.shown + path, shown, None, None, (time.time() - t0) * 1000, str(e), reqh)
            raise UnicoError('%s %s: %s' % (method, path, e))
        wirelog.http(method, self.shown + path, shown, code, raw if not login else re.sub(rb'("token"\s*:\s*")[^"]*(")', rb'\1<hidden>\2', raw), (time.time() - t0) * 1000, None, reqh, resph)
        try: j = json.loads(raw)
        except ValueError: raise UnicoError('%s %s: not JSON' % (method, path))
        self.calls.append((method, path, body, j.get('code')))
        if j.get('code') != 0: raise UnicoError('%s %s: code %s %s' % (method, path, j.get('code'), j.get('message', '')))
        return j.get('data')

    def login(self):
        self.token = None
        self.token = self._req('POST', 'system/auth/login', {'username': 'admin', 'password': PASSWORD})['token']
        return self

    def upload(self, path, fields, timeout=300):
        """multipart POST (cabinet/ncp/import): fields = [(name, filename|None, bytes)]"""
        import rcvfile
        body, ctype = rcvfile.multipart(fields)
        r = urllib.request.Request(self.base + path, data=body, method='POST', headers={'Content-Type': ctype, 'timeout': '300000'})
        if self.token: r.add_header('Authorization', self.token)
        reqh = dict(r.header_items()); t0 = time.time()   # the whole multipart body is recorded (a side file when big)
        try:
            with _open(r, timeout, self.zone) as x: raw = x.read(); code = x.status; resph = dict(x.headers.items())
            wirelog.http('POST', self.shown + path, body, code, raw, (time.time() - t0) * 1000, None, reqh, resph); j = json.loads(raw)
        except urllib.error.HTTPError as e:
            wirelog.http('POST', self.shown + path, body, e.code, e.read(), (time.time() - t0) * 1000, 'HTTP %d' % e.code, reqh, dict(e.headers.items()) if e.headers else None)
            raise UnicoError('POST %s: HTTP %d' % (path, e.code))
        except (OSError, ValueError) as e:
            if not isinstance(e, ValueError): wirelog.http('POST', self.shown + path, body, None, None, (time.time() - t0) * 1000, str(e), reqh)
            raise UnicoError('POST %s: %s' % (path, e))
        self.calls.append(('POST', path, '<multipart %d B>' % len(body), j.get('code')))
        if j.get('code') != 0: raise UnicoError('POST %s: code %s %s' % (path, j.get('code'), j.get('message', '')))
        return j.get('data')

    def get(self, path): return self._req('GET', path)
    def put(self, path, body): return self._req('PUT', path, body)
    def post(self, path, body): return self._req('POST', path, body)
    def delete(self, path, body): return self._req('DELETE', path, body)

    # -------------------------------------------------------------- reads
    def info(self):
        det = self.get('node/detail?nodeId=1')
        eth = self.get('node/ethernet?nodeId=1')['ethernet']['infos']
        screens = self.get('screen/list-detail')['list']
        leds = [{'screenId': s['screenId'], 'guid': s['guid'], 'name': s['general']['name'], 'type': s['screenIdObj']['type']}
                for s in screens if s['screenIdObj']['type'] != 8]          # type 8 = the MVR (multiviewer) screen
        def opt(path, key):   # a device of the family without LED outputs doesn't have these commands (model 0x722A: code 8212)
            try: return self.get(path)[key]
            except UnicoError as e:
                if ' code 8212 ' not in str(e): raise
                return []
        canvases = [{'canvasId': c['canvasID'], 'slotId': c['slotID'], 'width': c['canvasSize']['canvasWidth'],
                     'height': c['canvasSize']['canvasHeight'], 'online': c['isOnline']}
                    for c in opt('screen/canvas-all', 'canvasList')]
        # Ports are numbered across the sending cards, card by card (slot order): a VX Pro has one card (ports 0-19); an H2
        # with two 4xFiber cards has ports 0-31 on slot 4 and 32-63 on slot 5. 'cardPort' = the index on its own card,
        # which is what goes into the cabinetID.
        ports = {}
        for n in opt('node/sender-netport', 'list'):
            o = n['netPortIdObj']
            if n['canvasID'] and o.get('slotId') is not None:
                ports.setdefault((o['slotId'], n['netportIndex']), {'cardPort': n['netportIndex'], 'netportId': n['netportID'],
                                                                     'slotId': o['slotId'], 'canvasId': n['canvasID']})
        plist = [ports[k] for k in sorted(ports)]
        for i, p in enumerate(plist): p['index'] = i
        topo = self.get('screen/topology?' + '&'.join('screenIds%%5B%%5D=%d' % s['screenId'] for s in leds)) if leds else {'list': []}
        placed = [t['cabinetID'] for s in topo['list'] for c in s['canvasInfoList'] for t in (c['topologyList'] or [])]
        by_screen = {}   # per LED screen: a Send replaces only its own screen's cabinets
        for s in topo['list']:
            by_screen.setdefault(s.get('screenId'), []).extend(t['cabinetID'] for c in s['canvasInfoList'] for t in (c['topologyList'] or []))
        return {'modelId': det['modelId'], 'sn': det['sn'], 'name': det['general']['name'], 'version': det.get('version'),
                'status': det['status'], 'deviceBackup': det.get('deviceBackup'), 'workMode': det['mode']['workMode'],
                'mac': eth[0]['mac'] if eth else '', 'ip': eth[0]['ip'] if eth else '',
                'screens': leds, 'canvases': canvases, 'ports': plist, 'placedCabinets': placed, 'placedByScreen': by_screen}


# ------------------------------------------------------------------ panel detection
def _int(v):
    try: return int(v) if v not in (None, '') else None
    except (TypeError, ValueError): return None


def cabinet_ident(b, ph, f, modules):
    """One card's identity for the .rcfgx / NCP guard (rcvfile's neutral shape) from cabinet/info-v2."""
    import rcvfile
    i = rcvfile._blank(); i['gen'] = None
    mods = [m.get('rect') or {} for m in modules or []]
    i.update({'modelId': _int(b.get('modelId')), 'cardName': f.get('cardModel') or b.get('modelName') or None,
              'w': _int(ph.get('width')), 'h': _int(ph.get('height')),
              'modW': _int(mods[0].get('width')) if mods else None, 'modH': _int(mods[0].get('height')) if mods else None,
              'ic': b.get('driverChip') or None, 'decoderName': b.get('decodeType') or None, 'scan': _int(b.get('scanNumber')),
              'grey': _int(b.get('grayScale')), 'rotation': _int(ph.get('angle')),
              'ncp': bool(f.get('cabinetName')) if f else None, 'mfr': f.get('manufactureName') or ph.get('manuFacture') or None,
              'cabinet': f.get('cabinetName') or b.get('cabType') or None, 'version': f.get('version') or None,
              'fw': {k: v for k, v in (('fpga', b.get('firmware') or b.get('prgVer')), ('mcu', b.get('mcuVer'))) if v}})
    return i


def ncp_send(dev, data, name, cabinet, cabinet_ids, log):
    """Send an NCP to receiving cards the way Unico's Maintain ▸ Cabinet ▸ Update does it (RCV_FILE_GUARD.md §3b.1, captured
    from the real Unico UI): free space → cabinet/ncp/import (a <time>.zip holding ncp.zip holding <packName>.ncp) → the
    device's cabinet/packet/list entry for that pack → PUT cabinet/ncp/upgrade {ncp: {packInfo, cabinetFileParam}, type 0,
    source 0, cabinetIds}. No save afterwards (Unico doesn't either). The app runs the file guard first."""
    import io, zipfile, rcvfile
    fid = rcvfile.identity(data, name)
    if not fid.get('ok') or fid.get('kind') != 'ncp': raise UnicoError('not a readable NCP: %s' % fid.get('error', fid.get('kind')))
    cab = fid['cabinets'][int(cabinet or 0)]
    pack = fid.get('packName') or os.path.splitext(os.path.basename(name))[0]
    free = (dev.get('cabinet/ncp/residual-space') or {}).get('residualSpace')
    if free is not None and len(data) > float(free) * 1024 * 1024:
        raise UnicoError('the processor has %s MB free for cabinet files; this NCP is %.1f MB' % (free, len(data) / 1048576.0))
    inner = io.BytesIO(); zi = zipfile.ZipFile(inner, 'w', zipfile.ZIP_DEFLATED); zi.writestr(pack + '.ncp', data); zi.close()
    outer = io.BytesIO(); zo = zipfile.ZipFile(outer, 'w', zipfile.ZIP_DEFLATED); zo.writestr('ncp.zip', inner.getvalue()); zo.close()
    log('NCP %s (%.1f MB) -> import' % (pack, len(data) / 1048576.0))
    dev.upload('cabinet/ncp/import', [('files', '%d.zip' % int(time.time() * 1000), outer.getvalue())])
    lib = (dev.get('cabinet/packet/list') or {}).get('ncpList') or []
    e = next((x for x in lib if x.get('packName') == pack), None)
    if not e: raise UnicoError('the processor didn’t list pack %s after the import' % pack)
    fp = cab.get('cfgParam') or {}
    cc = next((c for c in e.get('cabinetConfigInfo') or [] if (c.get('cabinetFileParam') or {}).get('cabinetName') == fp.get('cabinetName')), None)
    if cc: fp = cc['cabinetFileParam']                      # the device's own naming wins
    body = {'ncp': {'packInfo': {'packName': e['packName'], 'creatTime': e.get('creatTime') or fid.get('creatTime')}, 'cabinetFileParam': fp},
            'type': 0, 'source': 0, 'cabinetIds': [str(i) for i in cabinet_ids]}
    log('upgrade %d cabinet(s) with %s / %s' % (len(cabinet_ids), e['packName'], fp.get('cabinetName')))
    dev.put('cabinet/ncp/upgrade', body)
    return {'ok': True, 'cabinets': len(cabinet_ids), 'pack': e['packName']}


def inputs(dev):
    """The inputs with what they receive and their EDID (preset) timing — read-only, GET interface/list-detail [R]:
    [{id, name, signal, width, height, rate, edid: {width, height, rate}, color}]."""
    d = dev.get('interface/list-detail') or {}
    lst = d.get('list') if isinstance(d, dict) else d
    out = []
    for e in lst or []:
        a, pr = e.get('actualThumbTiming') or {}, e.get('presetThumbTiming') or {}
        w, h = a.get('width') or 0, a.get('height') or 0
        out.append({'id': e.get('interfaceId'), 'name': (e.get('general') or {}).get('name') or 'input %s' % e.get('interfaceId'),
                    'signal': bool(w and h), 'width': w, 'height': h, 'rate': a.get('frame') or (e.get('actualTiming') or {}).get('refresh'),
                    'edid': {'width': pr.get('width'), 'height': pr.get('height'), 'rate': pr.get('frame')} if pr else None,
                    'color': ((e.get('colorDepth') or {}).get('actual'), (e.get('colorSpace') or {}).get('actual'))})
    return out


def identify(dev):
    """Read-only: every card's identity, flat [{dst, port, index, cabinetId, id}] (no rescan)."""
    d = detect(dev, False)
    return [{'dst': 0, 'port': p['port'], 'index': c['index'], 'cabinetId': c['cabinetId'], 'id': c['ident']}
            for p in d['ports'] for c in p['cabinets']]


def detect(dev, refresh=True):
    """The receiving cards (cabinets) the processor sees on each output port, in cable order (UNICO_UI_TOUR §8):
    PUT cabinet/refresh {"slotIds":[…]} rescans (Unico's Layout "Refresh"), GET cabinet/info-v2 lists one entry per card.
    Returns the app's neutral shape: {ports:[{port, netportId, cabinets:[{index, width, height, pitch, angle, cabinet, card,
    chip, firmware, modules}]}]}; port / index 0-based."""
    info = dev.info()
    if refresh:
        slots = sorted({p['slotId'] for p in info['ports']})
        if slots: dev.put('cabinet/refresh', {'slotIds': slots})
    idx = {p['netportId']: p['index'] for p in info['ports']}
    ports = {}
    for c in dev.get('cabinet/info-v2') or []:
        p = idx.get(c['netPortID'])
        if p is None: continue
        b, ph = c.get('cabinetBaseInfo') or {}, c.get('cabinetPhysicalInfo') or {}
        f = b.get('cabinetFileParam') or {}
        ports.setdefault(p, []).append({
            'index': c['cabinetIndex'], 'width': ph.get('width'), 'height': ph.get('height'),
            'pitch': float(ph['pointSpace']) if ph.get('pointSpace') else None, 'angle': ph.get('angle'),
            'cabinet': f.get('cabinetName') or b.get('cabType') or '', 'card': f.get('cardModel') or '',
            'chip': b.get('driverChip') or '', 'firmware': b.get('firmware') or b.get('workVer') or '',
            'modules': [m['rect'] for m in c.get('cabinetModules') or []], 'cabinetId': str(c.get('cabinetID')),
            'ident': cabinet_ident(b, ph, f, c.get('cabinetModules'))})
    out = []
    for p in sorted(ports):
        out.append({'port': p, 'netportId': next(k for k, v in idx.items() if v == p),
                    'cabinets': sorted(ports[p], key=lambda x: x['index'])})
    return {'model': info['modelId'], 'name': info['name'], 'portsTotal': len(info['ports']), 'ports': out}


# ------------------------------------------------------------------ health (docs\HEALTH_UNICO.md)
LINK_STATES = {0: 'no link', 1: 'ok', 2: 'over capacity', 3: 'unstable', 4: 'non-standard', 5: 'non-standard, no link',
               6: 'over capacity, no link', 7: 'on backup', 8: 'no signal (backup)'}
SIDES = {0: 'primary', 1: 'backup', 2: 'none'}
STATUS = {0: 'ok', 1: 'warning', 2: 'error', 3: 'unknown'}
CABINET_EVENTS = {101: 'data link broken', 102: 'data link restored', 103: 'voltage high', 104: 'voltage normal', 105: 'voltage low',
                  106: 'temperature high', 107: 'temperature normal', 108: 'temperature low', 109: 'bit errors', 110: 'bit errors cleared',
                  111: 'bit errors on primary', 112: 'primary clean', 113: 'bit errors on backup', 114: 'backup clean',
                  115: 'fed from primary', 116: 'fed from backup'}
PORT_EVENTS = {20: 'port disconnected', 21: 'port connected', 22: 'fibre disconnected', 23: 'fibre connected', 30: 'running on backup'}


def health(dev):
    """One health snapshot in Open Nova's neutral shape (shared with the NovaLCT / COEX readers):
    {ports: [{port, link, onBackup, cabinets}], cabinets: [{port, index, side, dark, temp, tempStatus, voltage, voltStatus,
    bitErrors}], device: {temp, voltage, fans}, events: [{t, level, port, index, code, text, value}]}  (port / index 0-based)."""
    info = dev.info()
    idx = {p['netportId']: p['index'] for p in info['ports']}
    glob = {(p['slotId'], p['cardPort']): p['index'] for p in info['ports']}
    ports = []
    for n in dev.get('node/sender-netport')['list']:
        if not n.get('canvasID') or n['netportID'] not in idx or any(x['port'] == idx[n['netportID']] for x in ports): continue
        ports.append({'port': idx[n['netportID']], 'link': LINK_STATES.get(n.get('linkState'), str(n.get('linkState'))),
                      'onBackup': n.get('redundState') == 1, 'cabinets': n.get('useCabinetNum', 0)})
    q = '&'.join('screenGuids%%5B%%5D=%s' % s['guid'] for s in info['screens']) or 'screenGuids%5B%5D='
    cabs = []
    for d in dev.get('monitor/cabinet-runtime-info?' + q) or []:
        for m in d.get('monitorInfos') or []:
            cid = int(m['cabinetId']); b = m.get('backupStatus') or {}
            cabs.append({'port': glob.get(((cid >> 24) & 0xFF, (cid >> 16) & 0xFF), (cid >> 16) & 0xFF), 'index': cid & 0xFFFF, 'side': SIDES.get(b.get('mode'), '?'),
                         'dark': (b.get('status') == 3), 'temp': _num(m['temperature']['value']),
                         'tempStatus': STATUS.get(m['temperature'].get('status')), 'voltage': _num(m['voltage']['value']),
                         'voltStatus': STATUS.get(m['voltage'].get('status')),
                         'bitErrors': sum(e.get('value', 0) for e in m.get('errorBit') or [])})
    dr = (dev.get('monitor/device-runtime-info') or [{}])[0].get('monitorInfo') or {}
    device = {'temp': _num((dr.get('mainBoardTemperature') or {}).get('value')),
              'voltage': _num((dr.get('mainBoardVoltage') or {}).get('value')), 'fans': dr.get('fanInfos') or []}
    events = []
    for d in dev.get('monitor/alarm-info?pageNum=0&pageSize=2000') or []:
        a = d.get('monitorAlarmInfo') or {}
        for e in a.get('cabinetAlarmInfos') or []:
            o = e.get('idObj') or {}
            events.append({'t': e.get('timestamp'), 'level': STATUS.get(e.get('alarmStatus')),
                           'port': glob.get((o.get('slotId'), o.get('netPortIndex')), o.get('netPortIndex')), 'index': o.get('cabinetIndex'), 'code': e['errorCode'], 'text': CABINET_EVENTS.get(e['errorCode'], 'code %s' % e['errorCode']),
                           'value': e.get('value')})
        for e in (a.get('netPortAlarmInfos') or []) + (a.get('deviceAlarmInfos') or []) + (a.get('fanAlarmInfos') or []):
            o = e.get('idObj') or {}
            events.append({'t': e.get('timestamp'), 'level': STATUS.get(e.get('alarmStatus')),
                           'port': idx.get(o.get('netportId'), o.get('netPortIndex')), 'index': None,
                           'code': e.get('errorCode'), 'text': PORT_EVENTS.get(e.get('errorCode'), 'code %s' % e.get('errorCode')), 'value': e.get('value')})
    return {'ports': sorted(ports, key=lambda x: x['port']), 'cabinets': sorted(cabs, key=lambda x: (x['port'], x['index'])),
            'device': device, 'events': events}


def compare_detected(layout, det):
    """Warnings where the show file differs from what the processor detects: more cabinets on a port than it sees, or a
    different cabinet size at the same cable position. (The simulator accepts any topology; a real unit has real cards.)"""
    seen = {p['port']: p['cabinets'] for p in det['ports']}
    warn, by_port = [], {}
    for c in layout.get('cabinets') or []: by_port.setdefault(c['port'], []).append(c)
    for p, cabs in sorted(by_port.items()):
        d = seen.get(p, [])
        if len(cabs) > len(d):
            warn.append('Port %d: the show file has %d cabinets, the processor detects %d' % (p + 1, len(cabs), len(d)))
        dd = {x['index']: x for x in d}
        bad = [c['index'] for c in cabs if c['index'] in dd and (dd[c['index']]['width'], dd[c['index']]['height']) != (c['width'], c['height'])]
        if bad:
            x = dd[bad[0]]; c = next(c for c in cabs if c['index'] == bad[0])
            warn.append('Port %d: %d cabinet(s) differ in size from the detected ones (cable position %d: show %dx%d, detected %s %dx%d)'
                        % (p + 1, len(bad), bad[0] + 1, c['width'], c['height'], x['cabinet'], x['width'], x['height']))
    return warn


# ------------------------------------------------------------------ layout Send
def cabinet_id(mac, slot, port, index):
    m = int(mac.replace(':', '').replace('-', '') or '0', 16) & 0xFFFFFF
    return str((m << 32) | (slot << 24) | (port << 16) | index)


def port_load(cabinets):
    """Percent per port the way Unico shows it: ceil(sum of cabinet areas / 655,360 * 100)."""
    area = {}
    for c in cabinets: area[c['port']] = area.get(c['port'], 0) + c['width'] * c['height']
    return {p: math.ceil(a * 100 / LOAD_BASE) for p, a in sorted(area.items())}


def build_send(info, layout, screen_guid=None, keep=False):
    """The REST calls for a layout, from the device's info() and the app's cabinets. Returns (calls, warnings)."""
    cabs = layout.get('cabinets') or []
    if not cabs: raise UnicoError('No cabinets to send')
    if info['status'] == 9: raise UnicoError('The processor is busy (status 9: a processor-backup sync is running)')
    if not info['screens']: raise UnicoError('The processor has no LED screen')
    scr = next((s for s in info['screens'] if s['guid'] == screen_guid), None) if screen_guid else info['screens'][0]
    if not scr: raise UnicoError('Screen %s not found on the processor' % screen_guid)
    ports = {p['index']: p for p in info['ports']}
    warn, seen = [], set()
    body = []
    for c in cabs:
        p = ports.get(c['port'])
        if p is None: raise UnicoError('Port %d does not exist on this processor (it has %d)' % (c['port'] + 1, len(ports)))
        key = (c['port'], c['index'])
        if key in seen: raise UnicoError('Port %d has two cabinets at cable position %d' % (c['port'] + 1, c['index'] + 1))
        seen.add(key)
        body.append({'cabinetID': cabinet_id(info['mac'], p['slotId'], p['cardPort'], c['index']), 'guid': scr['guid'],
                     'canvasId': p['canvasId'], 'cabinetPosition': {'x': int(c['x']), 'y': int(c['y'])},
                     'cabinetSize': {'width': int(c['width']), 'height': int(c['height'])}, 'viewId': 0})
    for p, pct in port_load(cabs).items():
        if pct > 100: warn.append('Port %d is at %d %% of its capacity (8-bit)' % (p + 1, pct))
    canv = {c['canvasId']: c for c in info['canvases']}
    for cid in {b['canvasId'] for b in body}:
        cv = canv.get(cid)
        x1 = max(b['cabinetPosition']['x'] + b['cabinetSize']['width'] for b in body if b['canvasId'] == cid)
        y1 = max(b['cabinetPosition']['y'] + b['cabinetSize']['height'] for b in body if b['canvasId'] == cid)
        if cv and (x1 > cv['width'] or y1 > cv['height']):
            warn.append('The layout (%d x %d) is larger than the canvas %d x %d' % (x1, y1, cv['width'], cv['height']))
    calls = []
    mine = (info.get('placedByScreen') or {}).get(scr['screenId'], [] if info.get('placedByScreen') is not None else info['placedCabinets'])
    if mine and not keep:   # only this screen's cabinets: another LED screen on the processor keeps its own
        calls.append(('DELETE', 'screen/cabinets/topology', {'screenIDs': None, 'canvasIDs': None, 'netPortIDs': None,
                                                             'cabinetIDs': mine, 'guidList': None}))
    calls.append(('POST', 'screen/cabinets/topology', body))
    # Port backup is always set, like LCT's Send clears every port's backup flag: the given pairs, or none. A stale pair
    # from an earlier send would otherwise turn ports of the new layout into backup ports.
    # canvas size (Unico's Match Screen = PUT screen/canvas/window, custom W x H): only when asked and different
    cv = layout.get('canvas')
    if cv:
        cur = next((c for c in info['canvases'] if c['canvasId'] == body[0]['canvasId']), None)
        if cur and (cur['width'], cur['height']) != (int(cv['width']), int(cv['height'])):
            calls.append(('PUT', 'screen/canvas/window', [{'canvasID': cur['canvasId'], 'canvasIDObj': {'slotID': 0, 'canvasIndex': 0},
                'canvasSize': {'canvasWidth': int(cv['width']), 'canvasHeight': int(cv['height']), 'maxFrameRate': 0, 'isCustomResolution': 1},
                'isOnline': 0, 'canvasPosition': {'x': 0, 'y': 0}, 'canvasId': 0, 'realCabinetRect': {'x': 0, 'y': 0, 'width': 0, 'height': 0},
                'correctCabinetRect': {'x': 0, 'y': 0, 'width': 0, 'height': 0}, 'topologyList': None, 'zOrder': 0}]))
    pb = layout.get('portBackup') or []
    used = {c['port'] for c in cabs}
    for m, b in pb:
        if m not in ports or b not in ports: raise UnicoError('Backup pair %d→%d uses a port the processor does not have' % (m + 1, b + 1))
        if b in used: raise UnicoError('Port %d carries cabinets, so it cannot be the backup of port %d' % (b + 1, m + 1))
        if m not in used: warn.append('Port %d is backed up on port %d but has no cabinets' % (m + 1, b + 1))
    pairs = [{'masterNetportId': ports[m]['netportId'], 'backupNetportId': ports[b]['netportId']} for m, b in pb]
    calls.append(('PUT', 'screen/netport-backup', [{'screenId': scr['screenId'], 'screenGuid': scr['guid'], 'slotId': 0,
                  'backupObj': 0, 'backupType': 3 if pairs else 0, 'enableType': 0, 'netportIds': pairs}]))
    return calls, warn


def run_send(dev, layout, log, screen_guid=None, keep=False, dry=False):
    t0 = time.time()
    def say(s): log('%8.3f  %s' % (time.time() - t0, s))
    info = dev.info()
    say('# %s %s (model %d, %s) MAC %s: %d placed cabinets, %d ports' % (info['name'], info['sn'], info['modelId'], info['version'],
        info['mac'] or '-', len(info['placedCabinets']), len(info['ports'])))
    calls, warn = build_send(info, layout, screen_guid, keep)
    warn += compare_detected(layout, detect(dev, refresh=False))
    for w in warn: say('! ' + w)
    for m, path, body in calls:
        n = len(body) if isinstance(body, list) else len(body.get('cabinetIDs') or [])
        say('%s %s (%d items)%s' % (m, path, n, ' [dry run]' if dry else ''))
        if not dry: dev._req(m, path, body)
    if dry: return {'ok': True, 'dry': True, 'calls': len(calls), 'warnings': warn}
    after = dev.info()
    sent = next(b for m, p, b in calls if m == 'POST')
    want = sorted(c['cabinetID'] for c in sent)
    got = sorted(after['placedCabinets'])
    ok = got == want
    say('read back: %d cabinets on the processor, %s' % (len(got), 'all match' if ok else 'MISMATCH'))
    cvc = next((b[0] for m, p, b in calls if p == 'screen/canvas/window'), None)
    if cvc is not None:
        c2 = next((c for c in after['canvases'] if c['canvasId'] == cvc['canvasID']), {})
        cok = (c2.get('width'), c2.get('height')) == (cvc['canvasSize']['canvasWidth'], cvc['canvasSize']['canvasHeight'])
        say('read back: canvas %sx%s, %s' % (c2.get('width'), c2.get('height'), 'match' if cok else 'MISMATCH')); ok = ok and cok
    pb = next((b[0] for m, p, b in calls if p == 'screen/netport-backup'), None)
    if pb is not None:                          # the screen reports its port backup in screen/list-detail .netportBackup
        cur = next((s.get('netportBackup') or {} for s in dev.get('screen/list-detail')['list'] if s['guid'] == pb['screenGuid']), {})
        pairs = sorted((x['masterNetportId'], x['backupNetportId']) for x in cur.get('netportIds') or [])
        bok = cur.get('backupType') == pb['backupType'] and pairs == sorted((x['masterNetportId'], x['backupNetportId']) for x in pb['netportIds'])
        say('read back: port backup type %s, %d pairs, %s' % (cur.get('backupType'), len(pairs), 'match' if bok else 'MISMATCH'))
        ok = ok and bok
    return {'ok': ok, 'calls': len(calls), 'cabinets': len(got), 'warnings': warn}


def read_layout(dev):
    """The placed cabinets of every LED screen: [{card, slot, port, index, x, y, w, h, cabinetID}] (from the cabinetID:
    (MAC & 0xFFFFFF) << 32 | slot << 24 | port << 16 | index)."""
    leds = [s for s in dev.get('screen/list-detail')['list'] if s['screenIdObj']['type'] != 8]   # not the MVR screen
    if not leds: return []
    topo = dev.get('screen/topology?' + '&'.join('screenIds%%5B%%5D=%d' % s['screenId'] for s in leds))
    out = []
    for s in topo['list']:
        for c in s['canvasInfoList']:
            for t in (c['topologyList'] or []):
                cid = int(t['cabinetID']); pos = t.get('cabinetPosition') or t.get('position') or {}; size = t.get('cabinetSize') or t.get('size') or {}
                out.append({'slot': (cid >> 24) & 0xFF, 'port': (cid >> 16) & 0xFF, 'index': cid & 0xFFFF, 'x': pos.get('x'), 'y': pos.get('y'),
                            'w': size.get('width'), 'h': size.get('height'), 'cabinetID': str(cid)})
    # several sending slots (two-card units): card = the slot's place in order, so port 1 of each slot stays apart
    slots = sorted({o['slot'] for o in out})
    for o in out: o['card'] = slots.index(o['slot'])
    return out


# ------------------------------------------------------------------ helper routes (used by novalink.py serve)
# Factory Reset levels (UNICO_OPERATIONS §6.3): 0 reboot, 1 IP, 2 EDID, 3 pictures, 4 language, 5 project files, 8 user files.
# Unico adds 9 (device mode) in ByPass mode; Open Nova doesn't offer resets of a ByPass unit differently (not captured).
FACTORY_KEEP = {'keepUser': [0, 1, 2, 3, 4, 5, 8], 'keepIp': [0, 1], 'all': [0]}


def _goodbye(call):
    """A request after which the processor reboots: a reply, or the link dropping right away, both mean it was taken
    (NovaStar's simulator exits on it). Returns True when the connection dropped instead of answering."""
    try: call(); return False
    except UnicoError as e:
        if 'code' in str(e) or 'HTTP' in str(e): raise   # the processor answered and refused
        return True


def handle(path, body, log):
    if path == '/api/unico/discover':
        ds = discover(float(body.get('timeout', 2)))
        import netif   # nothing found: what the searches met (bind / send errors, the adapters searched, who holds a search port)
        return dict({'ok': True, 'devices': ds}, **({} if ds else {'search': netif.search_report(owners=True)}))
    dev = Unico(body['host'], int(body.get('port', 8088))).login()
    if path == '/api/unico/info':
        return {'ok': True, 'info': dev.info()}
    if path == '/api/unico/send':
        log('# target %s:%s' % (body['host'], body.get('port', 8088)))
        return run_send(dev, body['layout'], log, body.get('screenGuid'), bool(body.get('keep')), bool(body.get('dry')))
    if path == '/api/unico/detect':
        return {'ok': True, 'detected': detect(dev, body.get('refresh', True))}
    if path == '/api/unico/rcv-send':                    # NCP to receiving cards (after the app's file guard)
        import base64
        log('# NCP %s -> %s, %d cabinet(s); guard %s' % (body.get('name'), body['host'], len(body.get('cabinetIds') or []), body.get('verdict')))
        return ncp_send(dev, base64.b64decode(body['data']), body.get('name', ''), body.get('cabinet') or 0, body.get('cabinetIds') or [], log)
    if path == '/api/unico/restart':                     # Device Restart: PUT node/power {option 0, nodeId 1} [R sim, UTOUR §6.14]
        log('# restart %s' % body['host'])
        return {'ok': True, 'dropped': _goodbye(lambda: dev.put('node/power', {'option': 0, 'nodeId': 1}))}
    if path == '/api/unico/factory-reset':               # Factory Reset: the list says what is KEPT (type 0 = reboot) [R sim, UTOUR §6.14]
        keep = FACTORY_KEEP[body['level']]
        log('# factory reset %s: %s, keep %s' % (body['host'], body['level'], keep))
        return {'ok': True, 'dropped': _goodbye(lambda: dev.put('system/restore-factory', {'restoreFactory': [{'type': t, 'para': 0} for t in keep]}))}
    if path == '/api/unico/inputs':                      # inputs + EDID timing, read-only
        return {'ok': True, 'inputs': inputs(dev)}
    if path == '/api/unico/identify':                    # read-only card identity for the .rcfgx / NCP guard
        return {'ok': True, 'cards': identify(dev)}
    if path == '/api/unico/health':
        return {'ok': True, 'health': health(dev)}
    if path == '/api/unico/save':                        # Unico's "Save": PUT cabinet/solid {type 1, screenIds} [R UTOUR]
        info = dev.info(); ids = [s['screenId'] for s in info['screens']]
        log('# save: PUT cabinet/solid screens %s' % ids)
        dev.put('cabinet/solid', {'type': 1, 'screenIds': ids})
        return {'ok': True, 'screens': len(ids)}
    if path == '/api/unico/clear':                       # every cabinet off the screens (Unico "Clear Topology"), as the
        info = dev.info(); ids = info['placedCabinets']   # live editor does when the last panel is removed
        if ids and not body.get('dry'):
            dev.delete('screen/cabinets/topology', {'screenIDs': None, 'canvasIDs': None, 'netPortIDs': None, 'cabinetIDs': ids, 'guidList': None})
        log('# clear: %d cabinets%s' % (len(ids), ' [dry run]' if body.get('dry') else ''))
        return {'ok': True, 'cleared': len(ids)}
    if path == '/api/unico/cabinets':                    # display mode / test pattern / mapping on cabinets [R UTOUR]
        info = dev.info(); act = body.get('action')
        if act == 'mapping':                              # the cards draw their identity (port / chain number)
            ids = sorted({p['canvasId'] for p in info['ports'] if p.get('canvasId')})
            dev.put('cabinet/device-mapping', {'enable': 1 if body.get('on') else 0, 'canvasIDs': ids})
            log('# mapping %s canvases %s' % ('on' if body.get('on') else 'off', ids))
            return {'ok': True}
        tg = body.get('targets')                          # [{port (global), index}] or None = every placed cabinet
        if tg is None: ids = info['placedCabinets']
        else:
            ids = []
            for t in tg:
                p = info['ports'][int(t['port'])] if int(t['port']) < len(info['ports']) else None
                if p: ids.append(cabinet_id(info['mac'], p['slotId'], p['cardPort'], int(t['index'])))
        if not ids: return {'ok': False, 'error': 'the processor has no cabinets placed yet — Send the layout first'}
        sel = {'screenIDs': None, 'canvasIDs': None, 'netPortIDs': None, 'cabinetIDs': ids, 'guidList': None}
        if act == 'display': dev.put('cabinet/display-mode', dict(sel, mode=int(body['mode'])))          # 0 normal 1 black 2 frozen
        elif act == 'pattern': dev.put('cabinet/test-pattern', dict(sel, mode=int(body['mode'])))        # 1 normal, 4 red … 13 ageing
        else: raise KeyError(act)
        log('# %s mode %s on %d cabinets' % (act, body.get('mode'), len(ids)))
        return {'ok': True, 'cabinets': len(ids)}
    if path == '/api/unico/screen':                      # colour / output settings on every LED screen [R UTOUR §6-8]
        info = dev.info(); scr = info['screens']
        if not scr: return {'ok': False, 'error': 'the processor has no LED screen'}
        sids = [s['screenId'] for s in scr]; guids = [s['guid'] for s in scr]; v = body.get('value'); a = body.get('action')
        if a == 'brightness':                             # value = 0-100 %
            dev.put('cabinet/brightness', {'screenIDs': sids, 'canvasIDs': None, 'netPortIDs': None, 'cabinetIDs': None, 'guidList': guids,
                                           'brightness': {'nit': 0, 'ratio': int(round(float(v) * 100)), 'ratioScale': 10000, 'brightnessNitType': 0}})
        elif a == 'gamma':                                # value = e.g. 2.2
            dev.put('screen/gamma', {'screenIDs': sids, 'canvasIDs': None, 'netPortIDs': None, 'cabinetIDs': None, 'guidList': guids,
                                     'gammaValue': int(round(float(v) * 100)), 'gammaValueScale': 100})
        elif a == 'colortemp':                            # value = kelvin
            dev.put('screen/color-temperature', [{'guid': s['guid'], 'screenId': s['screenId'], 'colorTemperature': int(v)} for s in scr])
        elif a == 'gamut':                                # value = PresetColorGamut (1 709, 2 P3, 15 P3-D65, 3 2020, 11 original, 255 input)
            dev.put('screen/gamut', [{'guid': s['guid'], 'screenId': s['screenId'], 'presetGamutType': int(v), 'actualGamutType': 0} for s in scr])
        elif a == 'bitdepth':                             # value = 8 / 10 / 12
            dev.put('screen/color-depth', [{'guid': s['guid'], 'screenId': s['screenId'], 'colorDepth': {'actual': 0, 'preset': int(v)}, 'connectorType': None} for s in scr])
        else: raise KeyError(a)
        log('# screen %s = %s on %d screen(s)' % (a, v, len(scr)))
        return {'ok': True, 'screens': len(scr)}
    if path == '/api/unico/screen-read':                 # read-only: the LED screen's colour settings as Unico shows them
        # GET screen/list-detail (Unico's own call, seen live): adjustment {brightness {ratio, ratioScale}, gamma {value,
        # scale}, colorTemperature}, selectGamut {presetGamut, actualGamut}, colorDepth {preset} — the simulator held the
        # values the Unico tour set (80 %, 2.20, Rec.709 = 6504 K). The first LED screen: /api/unico/screen writes them all.
        leds = [s for s in dev.get('screen/list-detail')['list'] if s['screenIdObj']['type'] != 8]
        if not leds: return {'ok': False, 'error': 'the processor has no LED screen'}
        s = leds[0]; a = s.get('adjustment') or {}; b = a.get('brightness') or {}; g = a.get('gamma') or {}; sg = s.get('selectGamut') or {}
        out = {'ok': True, 'screens': len(leds),
               'brightness': round(b['ratio'] * 100.0 / b['ratioScale'], 1) if b.get('ratioScale') else None,
               'gamma': round(float(g['value']) / g['scale'], 2) if g.get('scale') else None,
               'colorTemp': a.get('colorTemperature') or sg.get('colorTemperature') or None,
               'gamut': sg.get('presetGamut') if 'presetGamut' in sg else None,
               'bitDepth': (s.get('colorDepth') or {}).get('preset')}
        if len(leds) > 1:   # say so when the other LED screens hold other values (the writes go to all of them)
            def key(x): xa = x.get('adjustment') or {}; return json.dumps([xa, (x.get('selectGamut') or {}).get('presetGamut')], sort_keys=True)
            out['mixed'] = any(key(x) != key(s) for x in leds[1:])
        return out
    if path == '/api/unico/read-layout':                 # what the processor has placed, for the project-vs-hardware diff
        return {'ok': True, 'cabinets': read_layout(dev)}
    if path == '/api/unico/read-backup':                 # the port backup pairs the processor has (screen/list-detail .netportBackup)
        info = dev.info(); idx = {p['netportId']: p['index'] for p in info['ports']}; out = []
        for s in dev.get('screen/list-detail')['list']:
            nb = s.get('netportBackup') or {}
            if not nb.get('backupType'): continue
            for x in nb.get('netportIds') or []:
                m, b = idx.get(x['masterNetportId']), idx.get(x['backupNetportId'])
                if m is not None and b is not None: out.append([0, m, b])
        # processor backup (node/detail .deviceBackup {master{sn, name, ip}, slave[…]}, UNICO_UI_TOUR §processor backup [R])
        db = info.get('deviceBackup') or {}
        roles = []
        if db and ((db.get('master') or {}).get('sn') or any((x or {}).get('sn') for x in db.get('slave') or [])):   # an empty pairing isn't one
            me = info.get('sn'); mst = db.get('master') or {}; sl = db.get('slave') or []
            role = 'master' if mst.get('sn') == me else 'backup' if any((x or {}).get('sn') == me for x in sl) else 'paired'
            roles.append({'sender': 0, 'role': role, 'master': mst.get('name') or mst.get('sn'),
                          'backups': [(x or {}).get('name') or (x or {}).get('sn') for x in sl]})
        return {'ok': True, 'pairs': out, 'deviceBackup': roles}
    # ---- presets stored on the processor (docs\PRESET_SCHEDULE_API.md §1.1, bodies [R] from the VX simulator). A Unico
    # preset holds layers (source / position / size) and audio — no brightness, no cabinet layout. Delete isn't offered:
    # its device-side call was never seen.
    if path == '/api/unico/presets':
        lst = (dev.get('preset') or {}).get('list') or []
        return {'ok': True, 'presets': [{'id': p['guid'], 'slot': p.get('serial'), 'name': p.get('name', ''), 'active': p.get('currentRegion') == 2} for p in lst]}
    if path == '/api/unico/preset-save':
        info = dev.info()
        if not info['screens']: return {'ok': False, 'error': 'the processor has no LED screen'}
        used = {p.get('serial') for p in ((dev.get('preset') or {}).get('list') or [])}
        slot = int(body.get('slot') or next(i for i in range(1, 257) if i not in used))
        screens = []
        lays = (dev.get('layers/list-detail') or {}).get('list') or []
        for s in info['screens']:
            mine = [l['layerIdObj'] for l in lays if (l.get('layerIdObj') or {}).get('screenGuid') == s['guid'] and l['layerIdObj'].get('type') == 2]
            on = [o for o, l in zip(mine, [l for l in lays if (l.get('layerIdObj') or {}).get('screenGuid') == s['guid'] and l['layerIdObj'].get('type') == 2]) if l.get('enable')]
            screens.append({'guid': s['guid'], 'layers': [{'serial': o['id'], 'type': 2} for o in (on or mine)] or [{'serial': 1, 'type': 2}]})
        r = dev.post('preset/create', {'interfaces': list(range(1, 23)), 'loadType': 1, 'name': str(body['name'])[:64], 'params': ['3-2', '3-3', '3-4', '2-4'],
                                       'screens': screens, 'serial': slot, 'sourceRegion': 2, 'type': 2})
        log('# preset saved in slot %d: %s' % (slot, body['name']))
        return {'ok': True, 'id': (r or {}).get('guid'), 'slot': slot}
    if path == '/api/unico/preset-apply':
        r = dev.post('preset/apply', {'auxiliary': {'effect': {'enable': 1}, 'keyFrame': {'enable': 1}, 'swapEnable': 1, 'switchEffect': {'time': 2000, 'type': 0}},
                                      'presetId': body['id'], 'serial': int(body['slot']), 'targetRegion': 2}) or {}
        bad = r.get('screenObjFailed') or r.get('screenObjResourceNotEnough')
        log('# preset %s recalled%s' % (body['slot'], ' — refused for some screens' if bad else ''))
        return {'ok': not bad, 'error': 'the processor refused it for some screens (resources)' if bad else None}
    if path == '/api/unico/preset-rename':
        dev.post('preset/update-name', [{'guid': body['id'], 'name': str(body['name'])[:64]}])
        return {'ok': True}
    if path == '/api/unico/schedules':                   # read-only: brightness strategies per LED screen [R list-detail]
        info = dev.info(); br = []; en = None
        try: en = all((x.get('globalEnable', 1) == 1) for x in (dev.get('strategy/public-attribute') or {}).get('list') or [])
        except Exception: pass
        for sc in info['screens']:
            for q in (dev.get('strategy/list-detail?screenId=%d' % sc['screenId']) or {}).get('list') or []:
                if q.get('type') != 0: continue
                t = q.get('taskDate') or {}; b = q.get('brightnessStrategy') or {}; rp = (t.get('repeatInfo') or {})
                br.append({'id': q.get('id'), 'screenId': sc['screenId'], 'start': '%s %s' % (t.get('startDate', ''), (b.get('startTime') or '')[:5]), 'end': '%s %s' % (t.get('startDate', ''), (b.get('endTime') or '')[:5]),
                           'brightness': round((b.get('fixedBrightness') or 0) / 100) if b.get('adjustMode') == 1 else None, 'sensor': b.get('adjustMode') == 0,
                           'repeat': rp.get('customValue') or [] if rp.get('repeatType') else [], 'enabled': q.get('enable') == 1})
        return {'ok': True, 'enable': en, 'brightness': br}
    # Live-confirmed on NovaStar's VX2000 Pro simulator 2026-10-10: preset delete, strategy
    # create (fixed brightness, weekly repeat), strategy delete (POST - DELETE answers 405), the per-screen Schedule switch.
    if path == '/api/unico/preset-delete':
        dev.post('preset/delete', [body['id']])
        log('# preset %s deleted' % body['id'])
        return {'ok': True}
    if path == '/api/unico/schedule-add':                # brightness % at fixed times, once or weekly (0 = Sunday)
        info = dev.info(); rep = [int(v) for v in body.get('repeat') or []]
        d0, t0 = body['start'].split(' '); d1, t1 = body['end'].split(' ')
        for sc in info['screens']:
            dev.post('strategy/create', [{"id": 0, "screenId": sc['screenId'], "viewId": [], "screenType": 0, "name": "",
                "taskDate": {"startDate": d0, "endDate": '2069-12-31' if rep else d0,
                             "repeatInfo": {"repeatType": 1 if rep else 0, "customType": 0, "customValue": rep},
                             "skipDateConfig": {"skipDate": [], "skipScope": {"startDate": "", "endDate": ""}}},
                "type": 0, "status": 1, "enable": 1,
                "brightnessStrategy": {"adjustMode": 1, "startTime": t0 + ':00', "endTime": t1 + ':00', "fixedBrightness": int(round(float(body['brightness']) * 100))},
                "relayStrategy": {"multiCardId": "0", "channelIndex": 0, "controlMode": 1, "temperatureConfigs": [], "timeConfigs": []},
                "operateType": 2}])
        log('# brightness schedule %s - %s at %s %%%s' % (body['start'], t1, body['brightness'], ' repeat %s' % rep if rep else ''))
        return {'ok': True}
    if path == '/api/unico/schedule-delete':
        dev.post('strategy/delete', [{'id': int(body['id'])}])
        return {'ok': True}
    if path == '/api/unico/schedule-enable':             # every LED screen's Schedule switch (public-attribute globalEnable)
        for sc in dev.info()['screens']:
            dev.post('strategy/public-attribute/enable', [{'screenId': sc['screenId'], 'enable': 1 if body.get('enable') else 0}])
        return {'ok': True}
    if path == '/api/unico/backup-mode':                 # 0 normal, 1 backup only, 2 primary only, 3 both off
        info = dev.info(); scr = info['screens'][0]
        dev.put('screen/netport-backup-enable', [{'screenId': scr['screenId'], 'guid': scr['guid'], 'enableType': int(body['mode'])}])
        return {'ok': True}
    raise KeyError(path)


def main(argv):
    if not argv or argv[0] in ('-h', '--help'): print(__doc__); return 0
    cmd = argv[0]; rest = argv[1:]
    pos = [a for i, a in enumerate(rest) if not a.startswith('--') and (i == 0 or not rest[i - 1].startswith('--'))]
    args = dict(zip(rest[len(pos)::2], rest[len(pos) + 1::2])) if pos else dict(zip(rest[::2], rest[1::2]))
    if cmd == 'discover':
        for d in discover(float(args.get('--timeout', 2))): print('%(ip)s:%(port)s  %(SN)s  model %(modelId)s  %(deviceName)s' % d)
        return 0
    if cmd == 'serve':
        import novalink
        return novalink.main(['serve'] + rest)
    dev = Unico(args['--host'], int(args.get('--port', 8088))).login()
    if cmd == 'info': print(json.dumps(dev.info(), indent=1)); return 0
    if cmd == 'detect':
        d = detect(dev, args.get('--refresh', '1') == '1')
        for p in d['ports']:
            c = p['cabinets']; kinds = sorted({'%s %dx%d' % (x['cabinet'], x['width'], x['height']) for x in c})
            print('port %2d: %3d cabinets  %s' % (p['port'] + 1, len(c), ', '.join(kinds)))
        return 0
    if cmd == 'send':
        layout = json.load(open(pos[0], encoding='utf-8'))
        r = run_send(dev, layout, print, args.get('--screen'), args.get('--keep') == '1', args.get('--dry') == '1')
        print(json.dumps(r)); return 0 if r['ok'] else 1
    print(__doc__); return 2


if __name__ == '__main__':
    try: sys.exit(main(sys.argv[1:]))
    except UnicoError as e: print('error:', e); sys.exit(1)
