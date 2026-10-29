// NovaLCT .scfg ("System configuration file") codec: global SCFG. Pure (no DOM, no app state);
// the export / import UI is js/app-scfg.js.
// Format (docs/CONFIG_FILE_FORMATS.md §4): the XML NovaLCT V5.9.2 writes for its system configuration,
// one line, UTF-8, no BOM:
//   <?xml version="1.0" encoding="utf-8"?><SystemParameterConfig xmlns:xsi=… xmlns:xsd=…>
//     <ReduInfoList> SenderRedundancyInfo{MasterSenderIndex,MasterPortIndex,SlaveSenderIndex,SlavePortIndex}* </ReduInfoList>
//     <SacnBdProp> receiving-card parameters = the children of <ScanBoardProperty> in an .rcfgx </SacnBdProp>
//     <ScreenCfgInfo> base64 of the .scr (DSCI) byte image </ScreenCfgInfo>
//     <CaptureScreenFrame>30</CaptureScreenFrame>     [<SyncVideoData>base64</SyncVideoData>]
// NovaLCT's loader needs ReduInfoList (may be empty) and SacnBdProp,
// and on Send pushes SacnBdProp to EVERY receiving card before the layout — so SacnBdProp is only
// ever copied verbatim from a real receiving-card file (.rcfgx / .scfg), never made up here.
// Depends on: nothing (scr.js is not needed; ScreenCfgInfo is passed in / out as bytes).
(function (root) {
  'use strict';

  var XSI = 'http://www.w3.org/2001/XMLSchema-instance', XSD = 'http://www.w3.org/2001/XMLSchema';
  var HEAD = '<?xml version="1.0" encoding="utf-8"?><SystemParameterConfig xmlns:xsi="' + XSI + '" xmlns:xsd="' + XSD + '">';
  var REDU_FIELDS = ['MasterSenderIndex', 'MasterPortIndex', 'SlaveSenderIndex', 'SlavePortIndex'];
  var REDU_KEYS = ['masterSender', 'masterPort', 'slaveSender', 'slavePort'];
  var DEFAULT_CAPTURE_FRAME = 30;   // UC_LEDScreenConfig_Multiply.FrameRate default (virtual-sender capture fps)

  // ---------------------------------------------------------------- bytes / text / base64
  function toU8(buf) { return buf instanceof Uint8Array ? buf : new Uint8Array(buf); }
  function decodeText(buf) {
    var b = toU8(buf);
    if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
    if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) b = b.subarray(3);
    return new TextDecoder('utf-8').decode(b);
  }
  function encodeText(s) { return new TextEncoder().encode(s); }   // UTF-8, no BOM (like .NET StreamWriter)
  function b64encode(u8) {
    if (typeof btoa !== 'function') return Buffer.from(u8).toString('base64');
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64decode(s) {
    s = String(s).replace(/\s+/g, '');
    if (typeof atob !== 'function') return new Uint8Array(Buffer.from(s, 'base64'));
    var bin = atob(s), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---------------------------------------------------------------- receiving-card parameters ("rx")
  // rx = { attrs: extra attributes for <SacnBdProp> (normally ''), inner: its content, verbatim }.
  function checkRx(rx) {
    if (!rx || typeof rx.inner !== 'string' || rx.inner.indexOf('<StandardLedModuleProp') < 0)
      throw new Error('No receiving-card parameters (the file has no <StandardLedModuleProp>)');
    return rx;
  }
  // The attributes of an element's start tag that must travel with its content: namespace
  // declarations other than the xsi / xsd pair the .scfg root already declares.
  function carriedAttrs(attrText) {
    var out = '', re = /\s(xmlns(?::[\w.-]+)?)\s*=\s*("[^"]*"|'[^']*')/g, m;
    while ((m = re.exec(attrText))) {
      var v = m[2].slice(1, -1);
      if ((m[1] === 'xmlns:xsi' && v === XSI) || (m[1] === 'xmlns:xsd' && v === XSD)) continue;
      out += ' ' + m[1] + '="' + v + '"';
    }
    return out;
  }
  // Content of the element <tag …>…</tag> (first one, not nested in itself): { attrs, inner, start, end } or null.
  function element(text, tag, from) {
    var re = new RegExp('<' + tag + '(?=[\\s/>])', 'g');
    re.lastIndex = from || 0;
    var m = re.exec(text);
    if (!m) return null;
    var gt = text.indexOf('>', m.index);
    if (gt < 0) return null;
    var attrs = text.slice(m.index + 1 + tag.length, gt);
    if (/\/\s*$/.test(attrs)) return { attrs: attrs.replace(/\/\s*$/, ''), inner: '', start: m.index, end: gt + 1, empty: true };
    var close = text.indexOf('</' + tag + '>', gt);
    if (close < 0) return null;
    return { attrs: attrs, inner: text.slice(gt + 1, close), start: m.index, end: close + tag.length + 3 };
  }
  // From a ScanBoardProperty XML document (the .xml inside an .rcfgx, or a legacy .rcfg).
  function rxFromXml(text) {
    if (typeof text !== 'string') text = decodeText(text);
    var e = element(text, 'ScanBoardProperty');
    if (!e) throw new Error('Not a receiving-card XML (no <ScanBoardProperty>)');
    return checkRx({ attrs: carriedAttrs(e.attrs), inner: e.inner });
  }
  // NovaLCT reads an old text-form <DriverChipType>Chip_X</DriverChipType> back from the raw file,
  // line by line, and only when it is alone on its line; a
  // one-line .scfg would lose the chip. Put any such element on its own line.
  function chipLines(inner) {
    return inner.replace(/[ \t]*(<DriverChipType>[^<]+<\/DriverChipType>)[ \t]*/g, function (all, el, off, s) {
      // (the ends of `inner` touch <SacnBdProp> / </SacnBdProp> in the output, so they count as "same line")
      var nx = s[off + all.length], before = off > 0 && s[off - 1] === '\n' ? '' : '\r\n', after = nx === '\r' || nx === '\n' ? '' : '\r\n';
      return before || after ? before + el + after : all;
    });
  }
  // A few facts about rx for the UI / log (best effort; element order differs between LCT versions).
  function rxSummary(rx) {
    var inner = rx && rx.inner || '', top = inner, out = {};
    // top-level only: cut out the nested blocks that repeat names (module, cabinet info, irregular cabinet)
    ['StandardLedModuleProp', 'CabinetInfo', 'IrCabinetProp', 'ConfigFileVersion', 'FlashPTopology'].forEach(function (t) {
      var e = element(top, t);
      if (e) { out['_' + t] = e.inner; top = top.slice(0, e.start) + top.slice(e.end); }
    });
    function v(src, tag) { var m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(src || ''); return m ? m[1] : null; }
    var mod = out._StandardLedModuleProp, chip = element(mod || '', 'DriverChipType');
    return {
      card: v(out._ConfigFileVersion, 'ScanBoardName'), firmware: v(out._ConfigFileVersion, 'ProgramVersion'),
      chip: chip ? (v(chip.inner, 'ChipCode') != null ? 'ChipCode ' + v(chip.inner, 'ChipCode') : chip.inner.trim()) : null,
      width: +v(top, 'Width') || null, height: +v(top, 'Height') || null,
      moduleW: +v(mod, 'ModulePixelCols') || null, moduleH: +v(mod, 'ModulePixelRows') || null, scan: v(mod, 'ScanType'),
      grayDepth: v(top, 'GrayDepth'), refNumPerVs: v(top, 'RefNumPerVs'), brightness: v(top, 'Brightness'),
      rotation: v(top, 'CabinetRotateAngle'), savedBy: v(top, 'RCFGXVersion')
    };
  }

  // ---------------------------------------------------------------- .scfg build / parse
  // opts: { scr: Uint8Array (.scr bytes), rx (required), redundancy: [{masterSender, masterPort,
  // slaveSender, slavePort}] (zero-based; [] = none), captureFrame (default 30), syncVideo: Uint8Array|null }
  function build(opts) {
    if (!opts || !opts.scr || !opts.scr.length) throw new Error('No screen configuration (.scr bytes)');
    var scr = toU8(opts.scr);
    if (String.fromCharCode(scr[0], scr[1], scr[2], scr[3]) !== 'DSCI') throw new Error('ScreenCfgInfo is not a .scr (DSCI) image');
    var rx = checkRx(opts.rx), redu = opts.redundancy || [];
    var x = HEAD;
    // Always written (an empty list is <ReduInfoList />): LCT's loader walks it without a null check.
    if (!redu.length) x += '<ReduInfoList />';
    else {
      x += '<ReduInfoList>';
      redu.forEach(function (r) {
        x += '<SenderRedundancyInfo>';
        REDU_FIELDS.forEach(function (f, i) {
          var n = r[REDU_KEYS[i]];
          if (!(n >= 0 && n <= 255 && n === Math.floor(n))) throw new Error('Redundancy ' + REDU_KEYS[i] + ' must be 0-255 (zero-based)');
          x += '<' + f + '>' + n + '</' + f + '>';
        });
        x += '</SenderRedundancyInfo>';
      });
      x += '</ReduInfoList>';
    }
    x += '<SacnBdProp' + (rx.attrs || '') + '>' + chipLines(rx.inner) + '</SacnBdProp>';
    x += '<ScreenCfgInfo>' + b64encode(scr) + '</ScreenCfgInfo>';
    var cf = opts.captureFrame != null ? opts.captureFrame : DEFAULT_CAPTURE_FRAME;
    if (!(cf === Math.floor(cf) && cf >= -2147483648 && cf <= 2147483647)) throw new Error('CaptureScreenFrame must be an integer');
    x += '<CaptureScreenFrame>' + cf + '</CaptureScreenFrame>';
    if (opts.syncVideo && opts.syncVideo.length) x += '<SyncVideoData>' + b64encode(toU8(opts.syncVideo)) + '</SyncVideoData>';
    return x + '</SystemParameterConfig>';
  }

  // text / bytes -> { redundancy ([] or null when the element is missing), rx (or null), scr
  // (Uint8Array or null), captureFrame (number or null), syncVideo (Uint8Array or null), warnings }
  function parse(input) {
    var text = typeof input === 'string' ? input : decodeText(input), warnings = [];
    var root = element(text, 'SystemParameterConfig');
    if (!root) throw new Error('Not a NovaLCT .scfg file (no <SystemParameterConfig>)');
    var body = root.inner, rx = null;
    var sb = element(body, 'SacnBdProp');
    if (sb) {   // cut it out first so nothing below can match inside the receiving-card XML
      rx = { attrs: carriedAttrs(sb.attrs), inner: sb.inner };
      body = body.slice(0, sb.start) + body.slice(sb.end);
      if (rx.inner.indexOf('<StandardLedModuleProp') < 0) warnings.push('SacnBdProp has no StandardLedModuleProp');
    } else warnings.push('no SacnBdProp: NovaLCT cannot load this file');
    var redundancy = null, rl = element(body, 'ReduInfoList');
    if (rl) {
      redundancy = [];
      var re = /<SenderRedundancyInfo>([\s\S]*?)<\/SenderRedundancyInfo>/g, m;
      while ((m = re.exec(rl.inner))) {
        var r = {};
        REDU_FIELDS.forEach(function (f, i) { var mm = new RegExp('<' + f + '>\\s*(\\d+)\\s*</' + f + '>').exec(m[1]); r[REDU_KEYS[i]] = mm ? +mm[1] : 0; });
        redundancy.push(r);
      }
    } else warnings.push('no ReduInfoList: NovaLCT rejects the file on load');
    var sc = element(body, 'ScreenCfgInfo'), scr = sc && sc.inner.trim() ? b64decode(sc.inner) : null;
    if (!scr) warnings.push('no ScreenCfgInfo');
    var cf = element(body, 'CaptureScreenFrame'), sv = element(body, 'SyncVideoData');
    return { redundancy: redundancy, rx: rx, scr: scr, captureFrame: cf ? parseInt(cf.inner, 10) : null,
      syncVideo: sv && sv.inner.trim() ? b64decode(sv.inner) : null, warnings: warnings };
  }

  // ---------------------------------------------------------------- .rcfgx (ZIP) reading
  function r16(b, o) { return b[o] | (b[o + 1] << 8); }
  function r32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  // NovaLCT writes .rcfgx with deflate level 0 = stored blocks only; inflate those without a
  // decompressor. Returns null when a block is really compressed.
  function inflateStored(d) {
    var parts = [], n = 0, p = 0;
    for (;;) {
      if (p >= d.length) return null;
      var hdr = d[p], final = hdr & 1;
      if (((hdr >> 1) & 3) !== 0) return null;
      var len = r16(d, p + 1), nlen = r16(d, p + 3);
      if ((len ^ 0xFFFF) !== nlen || p + 5 + len > d.length) return null;
      parts.push(d.subarray(p + 5, p + 5 + len)); n += len; p += 5 + len;
      if (final) break;
    }
    var out = new Uint8Array(n), o = 0;
    parts.forEach(function (x) { out.set(x, o); o += x.length; });
    return out;
  }
  function inflate(d) {
    var st = inflateStored(d);
    if (st) return Promise.resolve(st);
    if (typeof DecompressionStream !== 'function') return Promise.reject(new Error('This browser cannot unzip compressed entries'));
    var ds = new DecompressionStream('deflate-raw');
    var w = ds.writable.getWriter(); w.write(d); w.close();
    return new Response(ds.readable).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  // Entries from the central directory (SharpZipLib leaves the local-header sizes as 0xFFFFFFFF).
  function unzip(buf) {
    var b = toU8(buf), e = -1;
    for (var i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (r32(b, i) === 0x06054b50) { e = i; break; }
    if (e < 0) return Promise.reject(new Error('Not a ZIP file'));
    var count = r16(b, e + 10), p = r32(b, e + 16), jobs = [];
    for (var k = 0; k < count; k++) {
      if (r32(b, p) !== 0x02014b50) return Promise.reject(new Error('Bad ZIP directory'));
      var method = r16(b, p + 10), csize = r32(b, p + 20), nlen = r16(b, p + 28), xlen = r16(b, p + 30), clen = r16(b, p + 32), lho = r32(b, p + 42);
      var name = new TextDecoder('utf-8').decode(b.subarray(p + 46, p + 46 + nlen));
      var data = b.subarray(lho + 30 + r16(b, lho + 26) + r16(b, lho + 28), lho + 30 + r16(b, lho + 26) + r16(b, lho + 28) + csize);
      jobs.push((method === 0 ? Promise.resolve(data) : method === 8 ? inflate(data) : Promise.reject(new Error('ZIP method ' + method)))
        .then(function (nm) { return function (d) { return { name: nm, data: d }; }; }(name)));
      p += 46 + nlen + xlen + clen;
    }
    return Promise.all(jobs);
  }
  // .rcfgx bytes -> rx (the XML entry's ScanBoardProperty content).
  function rxFromRcfgx(buf) {
    return unzip(buf).then(function (entries) {
      var xml = entries.find(function (en) { return /\.xml$/i.test(en.name); });
      if (!xml) throw new Error('No .xml inside the .rcfgx');
      return rxFromXml(decodeText(xml.data));
    });
  }

  var api = { build: build, parse: parse, rxFromXml: rxFromXml, rxFromRcfgx: rxFromRcfgx, rxSummary: rxSummary, unzip: unzip,
    toBytes: encodeText, decodeText: decodeText, b64encode: b64encode, b64decode: b64decode, DEFAULT_CAPTURE_FRAME: DEFAULT_CAPTURE_FRAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SCFG = api;
})(this);
