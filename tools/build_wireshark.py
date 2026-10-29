"""build_wireshark.py - writes tools/wireshark/novastar.lua, a Wireshark plug-in that decodes the NovaLCT protocol (TG
frames on TCP, any port: 5200 for MCTRL / VX, 5201+ per H output card) and the discovery packets (UDP 3800, Unico 5600,
COEX 54622), with the register names Open Nova knows (tools/tg_registers.json + wirelog.CURATED).
    python tools/build_wireshark.py
Install: copy novastar.lua into Wireshark's personal plugins folder (Help ▸ About Wireshark ▸ Folders ▸ Personal Lua
Plugins; macOS ~/.local/lib/wireshark/plugins, Windows %APPDATA%\\Wireshark\\plugins), then restart Wireshark.
Display filter examples: novastar, novastar.addr == 0x02000001, novastar.status != 0, novastar.dev == 1, novastar.echo
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wirelog  # noqa: E402

LUA = r'''-- novastar.lua - NovaStar NovaLCT-protocol ("TG") dissector for Wireshark, written by Open Nova (tools/build_wireshark.py).
-- Frames: request 55 AA 00 serial FE dst dev port card(u16) op r2 addr(u32) len(u16) [data] sum(u16);
-- reply AA 55 status serial ... len [data] sum; sum = 0x5555 + bytes from offset 2 (docs/HW_PROTOCOL.md).
-- A read request carries no data (len = the bytes asked for). Heuristic on every TCP port, plus 5200-5232 directly.
-- A request frame (55 AA) coming FROM port 5200-5232 is an echo: an H returns broadcast writes, and requests no sending
-- card took (with the sending-card byte changed). Open Nova's .pcap export puts USB / serial links on 10.99.1.n:5200.
local p = Proto("novastar", "NovaStar TG (NovaLCT protocol)")
local DEV = { [0] = "sender", [1] = "rx", [2] = "dev2", [3] = "distributor", [4] = "function" }
local f = p.fields
f.kind = ProtoField.string("novastar.kind", "Kind")
f.status = ProtoField.uint8("novastar.status", "Status", base.DEC)
f.serial = ProtoField.uint8("novastar.serial", "Serial", base.DEC)
f.dst = ProtoField.uint8("novastar.dst", "Sending card (dst, 255 = all)", base.DEC)
f.dev = ProtoField.uint8("novastar.dev", "Device", base.DEC, DEV)
f.port = ProtoField.uint8("novastar.port", "Port (0-based, 255 = all)", base.DEC)
f.card = ProtoField.uint16("novastar.card", "Card (0-based, 65535 = all)", base.DEC)
f.op = ProtoField.uint8("novastar.op", "Operation", base.DEC, { [0] = "read", [1] = "write" })
f.r2 = ProtoField.uint8("novastar.r2", "Reserved2", base.DEC)
f.addr = ProtoField.uint32("novastar.addr", "Address", base.HEX)
f.name = ProtoField.string("novastar.name", "Register")
f.len = ProtoField.uint16("novastar.len", "Length", base.DEC)
f.data = ProtoField.bytes("novastar.data", "Data")
f.sum = ProtoField.uint16("novastar.sum", "Checksum", base.HEX)
f.badsum = ProtoField.bool("novastar.badsum", "Checksum wrong")
f.echo = ProtoField.bool("novastar.echo", "Echo of a request (sent back by the processor)")

local NAMES = { [0] = {}, [1] = {}, any = {} }
local RANGES = {}
--NAMES--

local function regname(dev, addr)
  local t = NAMES[dev]
  local n = (t and t[addr]) or NAMES.any[addr]
  if n then return n end
  for _, r in ipairs(RANGES) do
    if r[1] == dev and addr >= r[2] and addr < r[3] then
      if addr == r[2] then return r[4] end
      return string.format("%s +0x%X", r[4], addr - r[2])
    end
  end
  return ""
end

local function one(buf, off, pinfo, tree)
  local req = buf(off, 1):uint() == 0x55
  local op = buf(off + 10, 1):uint()
  local ln = buf(off + 16, 2):le_uint()
  local dl = (req and op == 0) and 0 or ln
  local total = 20 + dl
  local dpos = req and 5 or 4   -- a reply swaps bytes 4 and 5: its sending card is byte 4
  local dst, dev, port, card = buf(off + dpos, 1):uint(), buf(off + 6, 1):uint(), buf(off + 7, 1):uint(), buf(off + 8, 2):le_uint()
  local addr = buf(off + 12, 4):le_uint()
  local name = regname(dev, addr)
  local sum = 0x5555
  for i = off + 2, off + 17 + dl do sum = sum + buf(i, 1):uint() end
  sum = sum % 65536
  local got = buf(off + 18 + dl, 2):le_uint()
  local where = "S" .. (dst == 255 and "*" or tostring(dst + 1))
  if dev ~= 0 or port ~= 0 then where = where .. " P" .. (port == 255 and "*" or tostring(port + 1)) end
  if dev ~= 0 then where = where .. " C" .. (card == 65535 and "*" or tostring(card + 1)) end
  local echo = req and pinfo.src_port >= 5200 and pinfo.src_port <= 5232
  local info = string.format("%s %s %s %s 0x%08X %s", echo and "<- ECHO" or req and "->" or "<-", op == 1 and "W" or "R", DEV[dev] or ("dev" .. dev), where, addr, name)
  if not req and buf(off + 2, 1):uint() ~= 0 then info = info .. " STATUS " .. buf(off + 2, 1):uint() end
  if got ~= sum then info = info .. " BAD CHECKSUM" end
  local t = tree:add(p, buf(off, total), "NovaStar " .. info)
  t:add(f.kind, echo and "echo" or req and "request" or "reply")
  if echo then t:add(f.echo, true) end
  if req then t:add(f.serial, buf(off + 3, 1)) else t:add(f.status, buf(off + 2, 1)); t:add(f.serial, buf(off + 3, 1)) end
  t:add(f.dst, buf(off + dpos, 1)); t:add(f.dev, buf(off + 6, 1)); t:add(f.port, buf(off + 7, 1))
  t:add_le(f.card, buf(off + 8, 2)); t:add(f.op, buf(off + 10, 1)); t:add(f.r2, buf(off + 11, 1))
  t:add_le(f.addr, buf(off + 12, 4)); if name ~= "" then t:add(f.name, name) end
  t:add_le(f.len, buf(off + 16, 2))
  if dl > 0 then t:add(f.data, buf(off + 18, dl)) end
  t:add_le(f.sum, buf(off + 18 + dl, 2)); if got ~= sum then t:add(f.badsum, true) end
  return total, info
end

function p.dissector(buf, pinfo, tree)
  local n, off, infos = buf:len(), 0, {}
  while off < n do
    if n - off < 20 then pinfo.desegment_offset = off; pinfo.desegment_len = DESEGMENT_ONE_MORE_SEGMENT; break end
    local m0, m1 = buf(off, 1):uint(), buf(off + 1, 1):uint()
    if not ((m0 == 0x55 and m1 == 0xAA) or (m0 == 0xAA and m1 == 0x55)) then
      if off == 0 then return 0 end
      break
    end
    local op, ln = buf(off + 10, 1):uint(), buf(off + 16, 2):le_uint()
    local total = 20 + ((m0 == 0x55 and op == 0) and 0 or ln)
    if n - off < total then pinfo.desegment_offset = off; pinfo.desegment_len = total - (n - off); break end
    local used, info = one(buf, off, pinfo, tree)
    infos[#infos + 1] = info
    off = off + used
  end
  if #infos > 0 then
    pinfo.cols.protocol = "NovaStar"
    pinfo.cols.info = table.concat(infos, " | ")
  end
  return n
end

local function heur(buf, pinfo, tree)
  if buf:len() < 20 then return false end
  local m0, m1 = buf(0, 1):uint(), buf(1, 1):uint()
  if m0 == 0x55 and m1 == 0xAA and buf(4, 1):uint() == 0xFE then p.dissector(buf, pinfo, tree); pinfo.conversation = p; return true end
  if m0 == 0xAA and m1 == 0x55 and buf(6, 1):uint() <= 4 then p.dissector(buf, pinfo, tree); pinfo.conversation = p; return true end
  return false
end
p:register_heuristic("tcp", heur)
local tcp = DissectorTable.get("tcp.port")
for port = 5200, 5232 do tcp:add(port, p) end

-- discovery: NovaLCT "rqProMI:" / "rpProMI:..." on UDP 3800; Unico NOVA TLV + JSON on 5600; COEX announcements on 54622
local d = Proto("novastar_disc", "NovaStar discovery")
local df = d.fields
df.text = ProtoField.string("novastar_disc.text", "Text")
function d.dissector(buf, pinfo, tree)
  pinfo.cols.protocol = "NovaStar disc"
  local s = buf:raw()
  local j = s:find("{", 1, true)
  local shown = (s:sub(1, 2) == "rq" or s:sub(1, 2) == "rp") and s or (j and s:sub(j) or "")
  local t = tree:add(d, buf(), "NovaStar discovery")
  if shown ~= "" then t:add(df.text, buf(#s - #shown), shown); pinfo.cols.info = shown:sub(1, 120) end
  return buf:len()
end
local udp = DissectorTable.get("udp.port")
udp:add(3800, d); udp:add(5600, d); udp:add(54622, d)
'''


def main():
    with open(os.path.join(HERE, 'tg_registers.json'), encoding='utf-8') as fh:
        j = json.load(fh)
    lines = []
    esc = lambda s: s.replace('\\', '\\\\').replace('"', '\\"')
    for key, dev in (('0', '0'), ('1', '1'), ('any', 'any')):
        names = {int(a, 16): v[0] for a, v in j.get(key, {}).items()}
        if dev != 'any':
            names.update(wirelog.CURATED.get(int(dev), {}))      # names seen live win, as in wirelog
        tbl = 'NAMES.any' if dev == 'any' else 'NAMES[%s]' % dev
        for a in sorted(names): lines.append('%s[0x%08X] = "%s"' % (tbl, a, esc(names[a])))
    for dev, s, e, n in wirelog.RANGES:
        lines.append('RANGES[#RANGES + 1] = { %d, 0x%08X, 0x%08X, "%s" }' % (dev, s, e, esc(n)))
    out = os.path.join(HERE, 'wireshark'); os.makedirs(out, exist_ok=True)
    path = os.path.join(out, 'novastar.lua')
    with open(path, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(LUA.replace('--NAMES--', '\n'.join(lines)))
    print('%s (%d register names)' % (path, len(lines)))


if __name__ == '__main__':
    main()
