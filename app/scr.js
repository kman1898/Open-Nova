// NovaLCT .scr ("DSCI") screen-configuration codec.
// Format worked out from the files NovaLCT V5.9.2 writes and reads (its normal and its 1600-mode layouts).
// All integers little-endian. "CRC" fields are 16-bit byte sums.
(function (root) {
  'use strict';

  var FILE_HDR_LEN = 54;
  var DVI_LEN = 128;
  var DVI_VER = 1001;
  var SCREEN_VER = 1006;        // ScreenDataNewVer(1005) + 1
  var ADJ_VER = 1002;
  var SCR_HDR_COUNT = 132;      // ScreenInfoRelativeAddress.SCREEN_HEADERINFO_SCREENCOUNT
  var SCR_HDR_LENS = 133;       // SCREEN_HEADERINFO_SCREENLENINFOADDR
  var SCR_HDR_CRC_FROM = 4;     // SCREEN_HEADERINFO_RESERVED
  var EXT_PTR = 28;             // StartAddressIndex: u32 offset of the DVI-extension JSON
  var VIRT_LEN = 15;            // VirtualParamsLen trailer on Standard screens
  var CELL_LEN = 17;
  var ADJ_HDR = 133, ADJ_ENTRY = 40;
  var EMPTY_SENDER = 255;       // cells with no receiving card

  var TYPE = { Simple: 0, Standard: 1, Complex: 2, CommonIrregular: 3 };

  function sum16(b, off, n) { var s = 0; for (var i = 0; i < n; i++) s += b[off + i]; return s & 0xFFFF; }
  function r16(b, o) { return b[o] | (b[o + 1] << 8); }
  function r32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function w16(b, o, v) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; }
  function w32(b, o, v) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; b[o + 2] = (v >> 16) & 255; b[o + 3] = (v >>> 24) & 255; }

  function utf8Encode(s) { return new TextEncoder().encode(s); }
  function utf8Decode(b) { return new TextDecoder('utf-8').decode(b); }
  function utf16Encode(s) { var o = new Uint8Array(s.length * 2); for (var i = 0; i < s.length; i++) w16(o, i * 2, s.charCodeAt(i)); return o; }
  function utf16Decode(b, off, n) { var s = ''; for (var i = 0; i + 1 < n; i += 2) { var c = r16(b, off + i); if (!c) break; s += String.fromCharCode(c); } return s; }

  // ---------------------------------------------------------------- parse
  function parse(buf) {
    var f = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (f.length < FILE_HDR_LEN || String.fromCharCode(f[0], f[1], f[2], f[3]) !== 'DSCI') throw new Error('Not a NovaLCT .scr file (missing DSCI header)');
    var dviLen = r32(f, 6), scrLen = r32(f, 10), adjLen = r16(f, 14);
    if (f.length < FILE_HDR_LEN + dviLen + scrLen + adjLen) throw new Error('Truncated .scr file');
    var warnings = [];
    if (sum16(f, 6, FILE_HDR_LEN + dviLen + scrLen - 6) !== r16(f, 4)) warnings.push('file checksum mismatch');

    var d = FILE_HDR_LEN;
    var dvi = {
      version: r16(f, d), portCols: f[d + 4], portRows: f[d + 5],
      graphicsWidth: r16(f, d + 6), graphicsHeight: r16(f, d + 8)
    };

    var s0 = FILE_HDR_LEN + dviLen;
    var sc = f.subarray(s0, s0 + scrLen);
    if (sum16(sc, SCR_HDR_CRC_FROM, scrLen - SCR_HDR_CRC_FROM) !== r16(sc, 2)) warnings.push('screen checksum mismatch');
    var screenVersion = r16(sc, 0);
    var count = sc[SCR_HDR_COUNT];
    var dviOffsetsHdr = Array.prototype.slice.call(sc, 10, 26);
    var ext = null, extPtr = screenVersion === SCREEN_VER ? r32(sc, EXT_PTR) : 0;
    if (extPtr && extPtr + 2 <= scrLen) {
      var jl = r16(sc, extPtr);
      try { ext = JSON.parse(utf8Decode(sc.subarray(extPtr + 2, extPtr + 2 + jl))); } catch (e) { warnings.push('bad DVI extension JSON'); }
    }

    var screens = [], p = SCR_HDR_LENS + 4 * count, stdIdx = 0;
    for (var k = 0; k < count; k++) {
      var len = r32(sc, SCR_HDR_LENS + 4 * k);
      var type = sc[p];
      var s = { type: type, virtualMode: sc[p + 1] };
      if (type === TYPE.Standard) {
        s.x = r16(sc, p + 2); s.y = r16(sc, p + 4);
        s.cols = r16(sc, p + 6); s.rows = r16(sc, p + 8);
        s.cells = [];
        var q = p + 10;
        for (var c = 0; c < s.cols; c++) for (var r = 0; r < s.rows; r++) {
          s.cells.push({
            col: c, row: r, sender: sc[q], port: sc[q + 1], connect: r16(sc, q + 2),
            x: r16(sc, q + 4), y: r16(sc, q + 6), xInPort: r16(sc, q + 8), yInPort: r16(sc, q + 10),
            width: r16(sc, q + 12), height: r16(sc, q + 14), dvi: sc[q + 16]
          });
          q += CELL_LEN;
        }
        if (len >= 10 + CELL_LEN * s.cols * s.rows + VIRT_LEN) {
          s.virtual = {
            isVirtual: sc[q] === 1, map: r32(sc, q + 1), subpixelMode: r32(sc, q + 5), rgbMode: r32(sc, q + 9),
            lightPointMode: sc[q + 13], lightPointLayout: sc[q + 14]
          };
        } else s.virtual = null;   // no trailer (e.g. the .scr inside an LCT .scfg): build leaves it out too
        var e = ext && ext[stdIdx];
        s.dviOffsets = e ? { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, x3: e.x3, y3: e.y3, x4: e.x4, y4: e.y4 } : null;
        stdIdx++;
      } else if (type === TYPE.Simple) {
        s.x = r16(sc, p + 2); s.y = r16(sc, p + 4); s.sender = sc[p + 6];
        s.portCols = sc[p + 7]; s.portRows = sc[p + 8];
        s.scanBdCols = r16(sc, p + 9); s.scanBdRows = r16(sc, p + 11);
        s.pixelColsInScanBd = r16(sc, p + 13); s.pixelRowsInScanBd = r16(sc, p + 15);
        s.ports = [];
        for (var i = 0, o = p + 17; i < s.portCols * s.portRows; i++, o += 10)
          s.ports.push({ connectType: sc[o], port: sc[o + 1], begCol: r16(sc, o + 2), begRow: r16(sc, o + 4), endCol: r16(sc, o + 6), endRow: r16(sc, o + 8) });
      } else {
        var n = r32(sc, p + 2);
        s.regions = [];
        for (var j = 0, o2 = p + 6; j < n; j++, o2 += 16)
          s.regions.push({ sender: sc[o2], port: sc[o2 + 1], connect: r16(sc, o2 + 2), x: r16(sc, o2 + 4), y: r16(sc, o2 + 6),
            xInPort: r16(sc, o2 + 8), yInPort: r16(sc, o2 + 10), width: r16(sc, o2 + 12), height: r16(sc, o2 + 14) });
      }
      screens.push(s);
      p += len;
    }

    var a = s0 + scrLen;
    if (adjLen >= ADJ_HDR) {
      var na = f[a + SCR_HDR_COUNT];
      for (var m = 0; m < na && m < screens.length; m++) {
        var ao = a + ADJ_HDR + ADJ_ENTRY * m;
        screens[m].adjust = { xZoomType: f[ao], xScale: f[ao + 1], yZoomType: f[ao + 2], yScale: f[ao + 3],
          virtualMap: f[ao + 4], name: utf16Decode(f, ao + 5, 20), threeD: f[ao + 25] };
      }
    }
    var tail = f.length > a + adjLen ? f.slice(a + adjLen) : null;   // optional sender-modulation block
    return { dvi: dvi, screenVersion: screenVersion, dviOffsetsHdr: dviOffsetsHdr, screens: screens, tail: tail, warnings: warnings };
  }

  // ---------------------------------------------------------------- build
  function defaultAdjust() { return { xZoomType: 0, xScale: 1, yZoomType: 0, yScale: 1, virtualMap: 228, name: '', threeD: 0 }; }
  // What NovaLCT V5.9.2 writes for a newly created screen (virtual mode off).
  function defaultVirtual() { return { isVirtual: false, map: 255, subpixelMode: 28, rgbMode: 255, lightPointMode: 0, lightPointLayout: 2 }; }

  function buildScreenBlock(s) {
    if (s.type === TYPE.Standard || s.type === undefined) {
      var n = s.cols * s.rows, b = new Uint8Array(10 + CELL_LEN * n + (s.virtual === null ? 0 : VIRT_LEN));
      b[0] = TYPE.Standard; b[1] = s.virtualMode || 0;
      w16(b, 2, s.x); w16(b, 4, s.y); w16(b, 6, s.cols); w16(b, 8, s.rows);
      // cells are column-major: for col { for row }
      var grid = {};
      s.cells.forEach(function (c) { grid[c.col + ',' + c.row] = c; });
      var q = 10;
      for (var c = 0; c < s.cols; c++) for (var r = 0; r < s.rows; r++) {
        var cell = grid[c + ',' + r];
        if (!cell) throw new Error('Screen missing cell ' + c + ',' + r);
        b[q] = cell.sender; b[q + 1] = cell.port; w16(b, q + 2, cell.connect);
        w16(b, q + 4, cell.x); w16(b, q + 6, cell.y);
        w16(b, q + 8, cell.xInPort != null ? cell.xInPort : c); w16(b, q + 10, cell.yInPort != null ? cell.yInPort : r);
        w16(b, q + 12, cell.width); w16(b, q + 14, cell.height); b[q + 16] = cell.dvi != null ? cell.dvi : 1;
        q += CELL_LEN;
      }
      if (s.virtual === null) return b;   // the source file had no virtual-params trailer
      var v = s.virtual || defaultVirtual();
      b[q] = v.isVirtual ? 1 : 0; w32(b, q + 1, v.map); w32(b, q + 5, v.subpixelMode); w32(b, q + 9, v.rgbMode);
      b[q + 13] = v.lightPointMode; b[q + 14] = v.lightPointLayout;
      return b;
    }
    if (s.type === TYPE.Simple) {
      var bs = new Uint8Array(17 + 10 * s.ports.length);
      bs[0] = 0; bs[1] = s.virtualMode || 0; w16(bs, 2, s.x); w16(bs, 4, s.y); bs[6] = s.sender;
      bs[7] = s.portCols; bs[8] = s.portRows; w16(bs, 9, s.scanBdCols); w16(bs, 11, s.scanBdRows);
      w16(bs, 13, s.pixelColsInScanBd); w16(bs, 15, s.pixelRowsInScanBd);
      s.ports.forEach(function (pp, i) { var o = 17 + 10 * i; bs[o] = pp.connectType; bs[o + 1] = pp.port;
        w16(bs, o + 2, pp.begCol); w16(bs, o + 4, pp.begRow); w16(bs, o + 6, pp.endCol); w16(bs, o + 8, pp.endRow); });
      return bs;
    }
    var bc = new Uint8Array(6 + 16 * s.regions.length);
    bc[0] = s.type; bc[1] = s.virtualMode || 0; w32(bc, 2, s.regions.length);
    s.regions.forEach(function (g, i) { var o = 6 + 16 * i; bc[o] = g.sender; bc[o + 1] = g.port; w16(bc, o + 2, g.connect);
      w16(bc, o + 4, g.x); w16(bc, o + 6, g.y); w16(bc, o + 8, g.xInPort); w16(bc, o + 10, g.yInPort); w16(bc, o + 12, g.width); w16(bc, o + 14, g.height); });
    return bc;
  }

  function build(model) {
    var screens = model.screens;
    if (!screens || !screens.length) throw new Error('No screens');
    if (screens.length > 255) throw new Error('Too many screens');

    // DVI block
    var dv = model.dvi || {}, dvi = new Uint8Array(DVI_LEN);
    w16(dvi, 0, DVI_VER); dvi[4] = dv.portCols != null ? dv.portCols : 1; dvi[5] = dv.portRows != null ? dv.portRows : 1;
    w16(dvi, 6, dv.graphicsWidth || 0); w16(dvi, 8, dv.graphicsHeight || 0);
    w16(dvi, 2, sum16(dvi, 4, DVI_LEN - 4));

    // Screen block
    var blocks = screens.map(buildScreenBlock);
    var hdrLen = SCR_HDR_LENS + 4 * screens.length, bodyLen = 0;
    blocks.forEach(function (b) { bodyLen += b.length; });
    var extList = [];
    screens.forEach(function (s) {
      if (s.type === TYPE.Standard || s.type === undefined) {
        var o = s.dviOffsets || {};
        extList.push({ si: extList.length, x1: o.x1 || 0, y1: o.y1 || 0, x2: o.x2 || 0, y2: o.y2 || 0, x3: o.x3 || 0, y3: o.y3 || 0, x4: o.x4 || 0, y4: o.y4 || 0 });
      }
    });
    var json = utf8Encode(JSON.stringify(extList));
    var sc = new Uint8Array(hdrLen + bodyLen + 2 + json.length);
    w16(sc, 0, SCREEN_VER);
    if (model.dviOffsetsHdr) for (var i = 0; i < 16; i++) sc[10 + i] = model.dviOffsetsHdr[i];
    w32(sc, EXT_PTR, hdrLen + bodyLen);
    sc[SCR_HDR_COUNT] = screens.length;
    var p = hdrLen;
    blocks.forEach(function (b, k) { w32(sc, SCR_HDR_LENS + 4 * k, b.length); sc.set(b, p); p += b.length; });
    w16(sc, p, json.length); sc.set(json, p + 2);
    w16(sc, 2, sum16(sc, SCR_HDR_CRC_FROM, sc.length - SCR_HDR_CRC_FROM));

    // Adjust-params block
    var adj = new Uint8Array(ADJ_HDR + ADJ_ENTRY * screens.length);
    w16(adj, 0, ADJ_VER); adj[SCR_HDR_COUNT] = screens.length;
    screens.forEach(function (s, k) {
      var a = s.adjust || defaultAdjust(), o = ADJ_HDR + ADJ_ENTRY * k;
      adj[o] = a.xZoomType; adj[o + 1] = a.xScale; adj[o + 2] = a.yZoomType; adj[o + 3] = a.yScale; adj[o + 4] = a.virtualMap;
      var nm = utf16Encode(a.name || '').subarray(0, 20); adj.set(nm, o + 5);
      adj[o + 25] = a.threeD;
    });
    w16(adj, 2, sum16(adj, 4, adj.length - 4));

    // File
    var tail = model.tail || new Uint8Array(0);
    var out = new Uint8Array(FILE_HDR_LEN + dvi.length + sc.length + adj.length + tail.length);
    out.set([68, 83, 67, 73], 0);                       // "DSCI"
    w32(out, 6, dvi.length); w32(out, 10, sc.length); w16(out, 14, adj.length);
    var o = FILE_HDR_LEN;
    out.set(dvi, o); o += dvi.length; out.set(sc, o); o += sc.length; out.set(adj, o); o += adj.length; out.set(tail, o);
    w16(out, 4, sum16(out, 6, FILE_HDR_LEN + dvi.length + sc.length - 6));
    return out;
  }

  // ---------------------------------------------------------------- capacity
  // Gigabit port capacity in pixels. Table rows are floor(1e9 × 0.95 / (M × fps)),
  // M = 24 for 8-bit and 48 for 10/12-bit.
  // Between rows: straight-line interpolation, rounded down. Below 24 Hz: the 24 row.
  // Above 120 Hz: 0 (not supported).
  // Rows are the formula rounded down:
  //   8-bit:     1,649,305  1,583,333  1,319,444  791,666  659,722  329,861
  //   10/12-bit:   824,652    791,666    659,722  395,833  329,861  164,930
  var CAP_FPS = [24, 25, 30, 50, 60, 120];
  var CAP_BUDGET = 950000000;   // 1e9 × 0.95, written out so no float rounding creeps in
  function capRow(M) { return CAP_FPS.map(function (f) { return Math.floor(CAP_BUDGET / (M * f)); }); }
  var CAP_TABLE = { 8: capRow(24), 16: capRow(48) };           // 16 = 10- and 12-bit
  function portCapacity(bitDepth, fps) {
    var row = CAP_TABLE[bitDepth <= 8 ? 8 : 16];
    if (!(fps > 0)) return 0;
    if (fps > CAP_FPS[CAP_FPS.length - 1]) return 0;
    if (fps <= CAP_FPS[0]) return row[0];
    for (var i = 1; i < CAP_FPS.length; i++) {
      if (fps <= CAP_FPS[i]) {
        var f0 = CAP_FPS[i - 1], f1 = CAP_FPS[i];
        if (fps === f1) return row[i];
        return Math.floor(row[i - 1] + (row[i] - row[i - 1]) * (fps - f0) / (f1 - f0));
      }
    }
    return 0;
  }

  var api = { parse: parse, build: build, portCapacity: portCapacity, CAP_FPS: CAP_FPS, CAP_TABLE: CAP_TABLE, TYPE: TYPE, EMPTY_SENDER: EMPTY_SENDER,
    defaultAdjust: defaultAdjust, defaultVirtual: defaultVirtual };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SCR = api;
})(this);
