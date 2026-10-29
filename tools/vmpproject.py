"""vmpproject.py - read a VMP project (.nprj) into Open Nova's neutral shape (docs/VMP_FILE_FORMATS.md; checked on the
tour-1 sample, tools/vmp/captures/tour1/vmp_tour1.nprj). Read-only, stdlib only.

.nprj = ZIP: check.xml (the controllers: name, IP, SN, MAC, ModelID, sub-cards), XCenterFile.zip, and per controller
"<ip>_project_" = a ZIP of its own data (no userdata/ prefix): controller3.1/usrconfig/screenConfig.json (screens ->
canvases (one per output card; backupType 1 = a backup card's mirror) -> cabinets {cabinetID, connectID, outputID,
position, size, angle}) and controller3.1/usrconfig/backup.json (port backup pairs). outputID = outputCardId << 8 | port.

    parse(data) -> {project, vmpVersion, controllers: [{name, ip, sn, mac, modelId, model, outputCards: [{id, slot, modelId,
                    name}], screens: [{name, cabinets: [{x, y, w, h, card, port, connect, angle}]}],
                    portBackup: [{card, port, backupCard, backupPort}], backupMode}]}
"""
import io
import json
import re
import zipfile


def _xml(block, tag):
    m = re.search(r'<%s>([^<]*)</%s>' % (tag, tag), block)
    return m.group(1).strip() if m else None


def parse(data):
    z = zipfile.ZipFile(io.BytesIO(data))
    if 'check.xml' not in z.namelist():
        raise ValueError('not a VMP project: no check.xml inside')
    x = z.read('check.xml').decode('utf-8', 'replace')
    head = re.search(r'<ProjectConfig([^>]*)>', x)
    attrs = dict(re.findall(r'(\w+)="([^"]*)"', head.group(1))) if head else {}
    out = {'project': attrs.get('ProjectName'), 'vmpVersion': attrs.get('VMPVersion'), 'controllers': []}
    for dev in re.findall(r'<Device\b[^>]*>(.*?)</Device>', x, re.S):
        c = {'name': _xml(dev, 'DeviceName'), 'ip': _xml(dev, 'DeviceIp'), 'sn': _xml(dev, 'DeviceSN'), 'mac': _xml(dev, 'DeviceMAC'),
             'modelId': int(_xml(dev, 'DeviceModelID') or 0), 'model': _xml(dev, 'DeviceTypeName'), 'outputCards': [], 'screens': [],
             'portBackup': [], 'backupMode': None}
        for oc in re.findall(r'<OutputCard>(.*?)</OutputCard>', dev, re.S):
            c['outputCards'].append({'id': int(_xml(oc, 'Id') or 0), 'slot': int(_xml(oc, 'SlotId') or 0),
                                     'modelId': int(_xml(oc, 'ModelId') or 0), 'name': _xml(oc, 'CardName')})
        c['outputCards'].sort(key=lambda o: o['slot'])
        path = _xml(dev, 'DeviceDataFilePath')
        if path and path in z.namelist():
            dz = zipfile.ZipFile(io.BytesIO(z.read(path)))
            names = dz.namelist()
            sc = next((n for n in names if n.endswith('usrconfig/screenConfig.json')), None)
            if sc:
                j = json.loads(dz.read(sc).decode('utf-8-sig'))
                for s in j.get('screens') or []:
                    sp = s.get('position') or {}
                    cabs = []
                    for cv in s.get('canvases') or []:
                        if cv.get('backupType') == 1:      # a backup card's mirror of the master: not placed twice
                            continue
                        cp = cv.get('position') or {}
                        for cb in cv.get('cabinets') or []:
                            pos, size, oid = cb.get('position') or {}, cb.get('size') or {}, int(cb.get('outputID') or 0)
                            cabs.append({'x': (sp.get('x') or 0) + (cp.get('x') or 0) + (pos.get('x') or 0),
                                         'y': (sp.get('y') or 0) + (cp.get('y') or 0) + (pos.get('y') or 0),
                                         'w': size.get('width'), 'h': size.get('height'), 'card': oid >> 8, 'port': oid & 0xFF,
                                         'connect': cb.get('connectID', 0), 'angle': cb.get('angle') or 0, 'id': str(cb.get('cabinetID'))})
                    c['screens'].append({'name': s.get('screenName') or 'Screen', 'cabinets': cabs})
            bk = next((n for n in names if n.endswith('usrconfig/backup.json')), None)
            if bk:
                b = json.loads(dz.read(bk).decode('utf-8-sig'))
                c['backupMode'] = b.get('Mode')
                for nb in b.get('NetPortBackupInfo') or []:
                    for q in nb.get('netPortBackupList') or []:
                        m, k = int(q['masterPort']), int(q['backupPort'])
                        c['portBackup'].append({'card': m >> 8, 'port': m & 0xFF, 'backupCard': k >> 8, 'backupPort': k & 0xFF})
        out['controllers'].append(c)
    return out


if __name__ == '__main__':
    import sys
    r = parse(open(sys.argv[1], 'rb').read())
    for c in r['controllers']:
        print(c['name'], c['model'], c['ip'], 'cards', [(o['id'], o['modelId']) for o in c['outputCards']],
              'screens', [(s['name'], len(s['cabinets'])) for s in c['screens']], 'backup pairs', len(c['portBackup']))
