-- novastar.lua - NovaStar NovaLCT-protocol ("TG") dissector for Wireshark, written by Open Nova (tools/build_wireshark.py).
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
NAMES[0][0x00000000] = "VendorID"
NAMES[0][0x00000002] = "ModelID"
NAMES[0][0x00000004] = "ProtocolVersion"
NAMES[0][0x00000006] = "JumboFrameSupport"
NAMES[0][0x00000007] = "MaxPacketData"
NAMES[0][0x00000009] = "HWLanguagePack"
NAMES[0][0x00000016] = "ControllerSN"
NAMES[0][0x0000001E] = "BootMode"
NAMES[0][0x0000001F] = "NewUpdateScheme"
NAMES[0][0x00000020] = "MCU_UID"
NAMES[0][0x00000044] = "DeviceExtendType"
NAMES[0][0x00000045] = "SupportDeviceTable"
NAMES[0][0x00010000] = "DeviceTable"
NAMES[0][0x01000000] = "SortCommand"
NAMES[0][0x01000001] = "SaveSender"
NAMES[0][0x01000002] = "FactoryReset"
NAMES[0][0x01000003] = "TestPoint"
NAMES[0][0x01000004] = "ReloadProgram"
NAMES[0][0x01000005] = "ChipErase"
NAMES[0][0x0100000D] = "ADV7612Debug"
NAMES[0][0x0100000E] = "ADV7612Debug +1"
NAMES[0][0x0100000F] = "ADV7612Debug +2"
NAMES[0][0x01000020] = "BrightnessGamma"
NAMES[0][0x01F00000] = "FwTotalSize"
NAMES[0][0x01F00004] = "FwSentSize"
NAMES[0][0x01F00008] = "FwFileCount"
NAMES[0][0x01F0000A] = "FwFileIndex"
NAMES[0][0x01F0000C] = "FwFileSize"
NAMES[0][0x01F00010] = "SoftLoad"
NAMES[0][0x02000000] = "PhysicalAddress"
NAMES[0][0x02000002] = "Temperature"
NAMES[0][0x02000004] = "Humidity"
NAMES[0][0x02000006] = "FanState"
NAMES[0][0x02000008] = "FieldRateSource"
NAMES[0][0x0200000A] = "MultiSourceSync"
NAMES[0][0x0200000B] = "AudioControl"
NAMES[0][0x0200000D] = "IOControl"
NAMES[0][0x0200000F] = "AmbientLux"
NAMES[0][0x02000010] = "AmbientLux"
NAMES[0][0x02000011] = "RTC"
NAMES[0][0x02000017] = "DVISignalPresent"
NAMES[0][0x02000018] = "MasterSlavePort0"
NAMES[0][0x02000019] = "MasterSlavePort1"
NAMES[0][0x0200001A] = "MasterSlavePort2"
NAMES[0][0x0200001B] = "MasterSlavePort3"
NAMES[0][0x0200001C] = "DVI0FieldRateL"
NAMES[0][0x0200001D] = "DVI0FieldRateH"
NAMES[0][0x0200001E] = "RedundantStatus"
NAMES[0][0x0200001F] = "PsdTxOnly"
NAMES[0][0x02000020] = "GenlockState"
NAMES[0][0x02000021] = "BootLogoHold"
NAMES[0][0x02000022] = "SourceAutoSelect"
NAMES[0][0x02000023] = "VideoSource"
NAMES[0][0x02000024] = "DVI0Width"
NAMES[0][0x02000026] = "DVI0Height"
NAMES[0][0x02000028] = "DVI0OffsetX"
NAMES[0][0x0200002A] = "DVI0OffsetY"
NAMES[0][0x0200002C] = "RealDVI0Width"
NAMES[0][0x0200002E] = "DVI1Height"
NAMES[0][0x02000030] = "DVI1OffsetX"
NAMES[0][0x02000032] = "DVI1OffsetY"
NAMES[0][0x02000034] = "DVI1RelX"
NAMES[0][0x02000036] = "DVI1RelY"
NAMES[0][0x02000038] = "VirtualMap"
NAMES[0][0x02000039] = "FrameChange"
NAMES[0][0x0200003A] = "MirrorDisplay"
NAMES[0][0x0200003B] = "Gamma18BitEn"
NAMES[0][0x0200003C] = "EnableDistributor"
NAMES[0][0x0200003D] = "DistributorMode"
NAMES[0][0x0200003E] = "Weekday"
NAMES[0][0x0200003F] = "SerialTimeout"
NAMES[0][0x02000040] = "SmartSetMode"
NAMES[0][0x02000041] = "3DLeftFirst"
NAMES[0][0x02000042] = "3DMode"
NAMES[0][0x02000043] = "SyncTime"
NAMES[0][0x02000046] = "SourceDetCol"
NAMES[0][0x02000048] = "SourceDetRow"
NAMES[0][0x0200004A] = "ComplexCfgScreenFlag"
NAMES[0][0x0200004B] = "InterlacedInput"
NAMES[0][0x0200004C] = "SerdesNetPortEnable"
NAMES[0][0x0200004D] = "SourceSignalState"
NAMES[0][0x0200004E] = "BrightnessSync"
NAMES[0][0x0200004F] = "3DEmitter"
NAMES[0][0x02000050] = "Port0Enable"
NAMES[0][0x02000051] = "Port0Width"
NAMES[0][0x02000053] = "Port0Height"
NAMES[0][0x02000055] = "Port0OffsetX"
NAMES[0][0x02000057] = "Port0OffsetY"
NAMES[0][0x02000059] = "Port1 Enable/W/H/X/Y"
NAMES[0][0x02000062] = "Port2 Enable/W/H/X/Y"
NAMES[0][0x0200006B] = "Port3 Enable/W/H/X/Y"
NAMES[0][0x02000074] = "Low latency (sending card)"
NAMES[0][0x02000075] = "ScaleEn"
NAMES[0][0x02000076] = "ColScalePara"
NAMES[0][0x02000078] = "EndColScalePos"
NAMES[0][0x0200007A] = "RowScalePara"
NAMES[0][0x0200007C] = "EndRowScalePos"
NAMES[0][0x0200007E] = "RowDoubleSizeEn"
NAMES[0][0x0200007F] = "ColDoubleSizeEn"
NAMES[0][0x02000080] = "DVIDecryptStartX"
NAMES[0][0x02000082] = "DVIDecryptStartY"
NAMES[0][0x02000084] = "DVIDecryptWidth"
NAMES[0][0x02000085] = "DVIDecryptHeight"
NAMES[0][0x02000086] = "SDIMode"
NAMES[0][0x02000087] = "SDIFamily"
NAMES[0][0x02000088] = "SDIRate"
NAMES[0][0x02000089] = "Set3DDVIOffset"
NAMES[0][0x02000098] = "MasterSlavePort4"
NAMES[0][0x02000099] = "MasterSlavePort5"
NAMES[0][0x0200009A] = "MasterSlavePort6"
NAMES[0][0x0200009B] = "MasterSlavePort7"
NAMES[0][0x0200009D] = "Device backup role (5A primary / A5 backup)"
NAMES[0][0x0200009E] = "RedundantStatus"
NAMES[0][0x0200009F] = "PortLinkStatus"
NAMES[0][0x020000A0] = "DDRWrDoneFlag"
NAMES[0][0x020000A1] = "ScaleIpEn"
NAMES[0][0x020000AF] = "Switch to backup ports"
NAMES[0][0x020000B0] = "PortEnableNextAddr"
NAMES[0][0x020000D4] = "SendVideoSyncData"
NAMES[0][0x020000F0] = "VirtualMapNew"
NAMES[0][0x02000100] = "MasterOrSlaveNew16Addr"
NAMES[0][0x02000130] = "PortEnableNext16Addr"
NAMES[0][0x02000178] = "DVIOf4KInfoAddr"
NAMES[0][0x02000180] = "DVIOf1600InfoAddr"
NAMES[0][0x020001A5] = "SetSourceTypeAddr"
NAMES[0][0x020001A6] = "DVIModeSettingAddr"
NAMES[0][0x020001B7] = "DVIOfPortInfoAddr"
NAMES[0][0x020001DA] = "SenderMasterMode"
NAMES[0][0x020001EC] = "SetScreenALLWidth"
NAMES[0][0x02010000] = "Sender_All32DataAddr"
NAMES[0][0x02010040] = "MasterOrSlaveNew32Addr"
NAMES[0][0x02010240] = "PortEnableNext32Addr"
NAMES[0][0x02020020] = "Function table"
NAMES[0][0x02020024] = "Function table (FreeRoute bit 6)"
NAMES[0][0x02030000] = "Per-port card counts"
NAMES[0][0x02100000] = "660ScreenInfo / ScreenConfigSpace"
NAMES[0][0x021F0000] = "Sender_NewFrameAddr"
NAMES[0][0x02200000] = "HMIControl"
NAMES[0][0x02200116] = "LoadModeAddr"
NAMES[0][0x0220012A] = "Sender_GrayDepthAndBitAddr"
NAMES[0][0x02300000] = "ScreenRedundancy"
NAMES[0][0x02400000] = "SmartBrightScreen"
NAMES[0][0x02500000] = "RxFactoryTest"
NAMES[0][0x02600000] = "ScreenOnOffLog"
NAMES[0][0x02700000] = "CabinetRotation"
NAMES[0][0x02800000] = "ScanCardCountOfSender"
NAMES[0][0x02800010] = "ReadScanCardCountOfSender"
NAMES[0][0x02820000] = "SubpixelModeNew"
NAMES[0][0x03000000] = "ScannerCoordinates"
NAMES[0][0x03100000] = "CardsPerPort"
NAMES[0][0x03100100] = "VirtualEnable"
NAMES[0][0x03100101] = "DisplayMode"
NAMES[0][0x03100109] = "HDEnableAddr"
NAMES[0][0x03100200] = "NumberOfCardOrBoardInPort16Addr"
NAMES[0][0x03200000] = "Per-card rectangles"
NAMES[0][0x04000000] = "SenderProgram"
NAMES[0][0x05000000] = "SoftwareSpace"
NAMES[0][0x05065000] = "REDU backup pairs"
NAMES[0][0x05066000] = "SSPE"
NAMES[0][0x06000000] = "PictureWebSpace"
NAMES[0][0x07000000] = "FontSpace"
NAMES[0][0x08000000] = "EDIDSpace"
NAMES[0][0x09000000] = "AuthorizationSpace"
NAMES[0][0x0A000000] = "HWBrightnessSpace"
NAMES[0][0x0C000000] = "DVIEncryptSpace"
NAMES[0][0x0D000000] = "PlutoMCU"
NAMES[0][0x0E000000] = "Gamma12Bit"
NAMES[0][0x0E100000] = "Sender_GreenGammaTableAddr"
NAMES[0][0x0E200000] = "Sender_BlueGammaTableAddr"
NAMES[0][0x0F000000] = "RxConfigFileStore"
NAMES[0][0x0F800000] = "Sender660Config"
NAMES[0][0x0FF00000] = "Sender660Config"
NAMES[0][0x10000000] = "BootLogo"
NAMES[0][0x11000000] = "WebCascade"
NAMES[0][0x12000000] = "OnlineCorrection"
NAMES[0][0x12010000] = "HWTestPattern"
NAMES[0][0x13000000] = "GlobalState"
NAMES[0][0x13001000] = "DataChangeFlags"
NAMES[0][0x13010000] = "InputResolution"
NAMES[0][0x13014000] = "InputResolutionSet"
NAMES[0][0x13015000] = "EDIDTemplate"
NAMES[0][0x13020000] = "WindowParams"
NAMES[0][0x13024000] = "CropInfo"
NAMES[0][0x13030000] = "ScreenParams"
NAMES[0][0x13040000] = "OutputResolution"
NAMES[0][0x13050000] = "PQ input"
NAMES[0][0x13050200] = "PQ output"
NAMES[0][0x13050400] = "PQ window"
NAMES[0][0x13070000] = "Pictures"
NAMES[0][0x13080000] = "Logo"
NAMES[0][0x13090000] = "SwitcherSync"
NAMES[0][0x13100000] = "Presets"
NAMES[0][0x13110000] = "PresetSchedule"
NAMES[0][0x13120000] = "InputBackup"
NAMES[0][0x13140000] = "CascadeScreenParams"
NAMES[0][0x13200000] = "PresetRename"
NAMES[0][0x13300000] = "InputRename"
NAMES[0][0x14000000] = "DeviceName"
NAMES[0][0x18000000] = "SenderProgramStore"
NAMES[0][0x1A000000] = "SetBackUpOrRestore"
NAMES[0][0x1A000001] = "BackUpFinish"
NAMES[0][0x1A000002] = "RestoreFinish"
NAMES[0][0x1A000003] = "HWRestoreFinish"
NAMES[0][0x1A000100] = "BackUpFileHeader"
NAMES[0][0x1A000101] = "BackUpFile"
NAMES[0][0xFFFF0000] = "VirtualSender"
NAMES[1][0x00000000] = "ScannerModel"
NAMES[1][0x00000002] = "FPGAGoldenVersion"
NAMES[1][0x00000006] = "MonitorCardPresent"
NAMES[1][0x00000007] = "MonitorCardModel"
NAMES[1][0x00000009] = "MonitorCardVersion"
NAMES[1][0x01000000] = "ScannerCommand"
NAMES[1][0x01000002] = "HWLock"
NAMES[1][0x0100000B] = "Restart FPGA (ScannerFPGARestart)"
NAMES[1][0x01000010] = "ParameterReloadFromSpiFlash"
NAMES[1][0x01000011] = "Save receiving-card parameters"
NAMES[1][0x01000012] = "recalculate"
NAMES[1][0x01000019] = "WriteConfigRegisterAddr"
NAMES[1][0x01000080] = "Restart MCU (ScannerMCURestart)"
NAMES[1][0x01000088] = "Mapping on/off"
NAMES[1][0x01000095] = "ScannerSdramToSlaveFlash"
NAMES[1][0x01000096] = "Restore factory (receiving card)"
NAMES[1][0x0100009D] = "FlashCabinetAddr"
NAMES[1][0x010000A4] = "SaveCommonCoefficienceAddr"
NAMES[1][0x010000AC] = "SendToFlash"
NAMES[1][0x010000AD] = "ReadFromFlash"
NAMES[1][0x02000000] = "Receiving-card parameters"
NAMES[1][0x02000001] = "GlobalBrightness"
NAMES[1][0x02000002] = "Red brightness"
NAMES[1][0x02000003] = "Green brightness"
NAMES[1][0x02000004] = "Blue brightness"
NAMES[1][0x02000005] = "VR brightness"
NAMES[1][0x02000006] = "MonitorRGBCode"
NAMES[1][0x02000007] = "DriveMode"
NAMES[1][0x02000008] = "DclkDuty"
NAMES[1][0x02000009] = "ModuleDataDir"
NAMES[1][0x0200000A] = "ModuleWidth"
NAMES[1][0x0200000B] = "ModuleHeight"
NAMES[1][0x0200000C] = "DriverChip"
NAMES[1][0x0200000D] = "ScanCount"
NAMES[1][0x0200000E] = "OEPolarity"
NAMES[1][0x0200000F] = "DecodeType"
NAMES[1][0x02000010] = "GroupNumInModule"
NAMES[1][0x02000011] = "GroupOrder"
NAMES[1][0x02000015] = "ModuleCols"
NAMES[1][0x02000016] = "ModuleRows"
NAMES[1][0x02000017] = "CabinetWidth"
NAMES[1][0x02000019] = "CabinetHeight"
NAMES[1][0x0200001B] = "PhysicalDataGroups"
NAMES[1][0x0200001C] = "ModuleCascadeDir"
NAMES[1][0x0200001D] = "ModuleTracePoints"
NAMES[1][0x0200001F] = "PointsPerGroupScan"
NAMES[1][0x02000021] = "IrregularLoad"
NAMES[1][0x02000022] = "LogicalDataGroups"
NAMES[1][0x02000023] = "DriverFunction"
NAMES[1][0x02000024] = "DExtendMode"
NAMES[1][0x02000025] = "GrayDepth"
NAMES[1][0x02000026] = "GrayMode"
NAMES[1][0x02000027] = "RefNumPerVs"
NAMES[1][0x02000029] = "LineBias"
NAMES[1][0x0200002A] = "BlankUnitNumPerScan"
NAMES[1][0x0200002C] = "RowChangePoint"
NAMES[1][0x0200002E] = "ABCDRollOver"
NAMES[1][0x0200002F] = "GclkNumPerScan"
NAMES[1][0x02000031] = "LightTimeRatio"
NAMES[1][0x02000032] = "ShiftUnitNumPerSubField"
NAMES[1][0x02000034] = "TotalUnitNumPerSubField"
NAMES[1][0x02000036] = "LightTimePerSubField"
NAMES[1][0x02000038] = "Dclk/Gclk cycle, phase, high"
NAMES[1][0x02000039] = "Dclk/Gclk cycle, phase, high +1"
NAMES[1][0x0200003A] = "Dclk/Gclk cycle, phase, high +2"
NAMES[1][0x0200003B] = "Dclk/Gclk cycle, phase, high +3"
NAMES[1][0x0200003C] = "Dclk/Gclk cycle, phase, high +4"
NAMES[1][0x0200003D] = "Dclk/Gclk cycle, phase, high +5"
NAMES[1][0x0200003E] = "PartNumPerRef"
NAMES[1][0x0200003F] = "SubField0"
NAMES[1][0x02000040] = "SubField1"
NAMES[1][0x02000041] = "SubField2"
NAMES[1][0x02000042] = "SubField3"
NAMES[1][0x02000043] = "SubField4"
NAMES[1][0x02000044] = "SubField5"
NAMES[1][0x02000045] = "SubField6"
NAMES[1][0x02000046] = "SubField7"
NAMES[1][0x02000047] = "RowsCtrlByDataGroup0"
NAMES[1][0x02000048] = "RowsCtrlByDataGroup1"
NAMES[1][0x02000049] = "RowsCtrlByDataGroup2"
NAMES[1][0x0200004A] = "RowsCtrlByDataGroup3"
NAMES[1][0x0200004B] = "RowsCtrlByDataGroup4"
NAMES[1][0x0200004C] = "RowsCtrlByDataGroup5"
NAMES[1][0x0200004D] = "RowsCtrlByDataGroup6"
NAMES[1][0x0200004E] = "RowsCtrlByDataGroup7"
NAMES[1][0x0200004F] = "TotalGclkUnitNumPerScan"
NAMES[1][0x02000051] = "CorrectionOn"
NAMES[1][0x02000052] = "CoefficientSource"
NAMES[1][0x02000053] = "NoSignalMode"
NAMES[1][0x02000054] = "ABCDCode"
NAMES[1][0x0200005C] = "RGBCode"
NAMES[1][0x0200005D] = "R gain (legacy name)"
NAMES[1][0x0200005E] = "G gain (legacy name)"
NAMES[1][0x0200005F] = "B gain (legacy name)"
NAMES[1][0x02000060] = "VR gain (legacy name)"
NAMES[1][0x02000061] = "Threshold"
NAMES[1][0x02000062] = "SymmetricOutput"
NAMES[1][0x02000063] = "50/60/75/120 Hz timing sets & chip config-register initial values"
NAMES[1][0x0200007F] = "GclkExtendEnable"
NAMES[1][0x02000080] = "FirstLine"
NAMES[1][0x02000081] = "OtherLine"
NAMES[1][0x02000082] = "VsFreqValidInfo"
NAMES[1][0x02000083] = "StartPositionOfDataGroup0"
NAMES[1][0x02000084] = "StartPositionOfDataGroup1"
NAMES[1][0x02000085] = "StartPositionOfDataGroup2"
NAMES[1][0x02000086] = "StartPositionOfDataGroup3"
NAMES[1][0x02000087] = "StartPositionOfDataGroup4"
NAMES[1][0x02000088] = "StartPositionOfDataGroup5"
NAMES[1][0x02000089] = "StartPositionOfDataGroup6"
NAMES[1][0x0200008A] = "StartPositionOfDataGroup7"
NAMES[1][0x0200008B] = "CabinetSerialNum"
NAMES[1][0x0200008D] = "ConfigRegister R"
NAMES[1][0x0200008F] = "ConfigRegister G"
NAMES[1][0x02000091] = "ConfigRegister B"
NAMES[1][0x02000093] = "ConfigRegister VR"
NAMES[1][0x02000095] = "HctrlClose"
NAMES[1][0x02000096] = "SerialDecodeRepeat"
NAMES[1][0x02000097] = "MBI5041BNewTiming"
NAMES[1][0x02000098] = "DriverDeghost"
NAMES[1][0x02000099] = "MultiFunc"
NAMES[1][0x0200009A] = "ScalerInfo"
NAMES[1][0x0200009B] = "RotationDegree"
NAMES[1][0x0200009C] = "Mbi5042GrayEnhanced"
NAMES[1][0x0200009D] = "No-correction thresholds / attenuations R/G/B/VR"
NAMES[1][0x0200009F] = "No-correction thresholds / attenuations R/G/B/VR +2"
NAMES[1][0x020000A1] = "No-correction thresholds / attenuations R/G/B/VR +4"
NAMES[1][0x020000A3] = "No-correction thresholds / attenuations R/G/B/VR +6"
NAMES[1][0x020000A5] = "No-correction thresholds / attenuations R/G/B/VR +8"
NAMES[1][0x020000A7] = "No-correction thresholds / attenuations R/G/B/VR +10"
NAMES[1][0x020000A9] = "No-correction thresholds / attenuations R/G/B/VR +12"
NAMES[1][0x020000AB] = "No-correction thresholds / attenuations R/G/B/VR +14"
NAMES[1][0x020000AD] = "CtrlEndPoint"
NAMES[1][0x020000AF] = "LocalStartX"
NAMES[1][0x020000B1] = "LocalStartY"
NAMES[1][0x020000B3] = "NewOERamEnable"
NAMES[1][0x020000B4] = "LowGrayCompensation"
NAMES[1][0x020000B5] = "AddrExtend"
NAMES[1][0x020000B6] = "TwentyDataGroup"
NAMES[1][0x020000B7] = "GroupSwapEn"
NAMES[1][0x020000B8] = "GroupSwapInfo0"
NAMES[1][0x020000B9] = "GroupSwapInfo1"
NAMES[1][0x020000BA] = "GroupSwapInfo2"
NAMES[1][0x020000BB] = "GroupSwapInfo3"
NAMES[1][0x020000BC] = "GroupSwapInfo4"
NAMES[1][0x020000BD] = "GroupSwapInfo5"
NAMES[1][0x020000BE] = "GroupSwapInfo6"
NAMES[1][0x020000BF] = "GroupSwapInfo7"
NAMES[1][0x020000C0] = "GroupSwapInfo8"
NAMES[1][0x020000C1] = "GroupSwapInfo9"
NAMES[1][0x020000C2] = "GroupSwapInfo10"
NAMES[1][0x020000C3] = "GroupSwapInfo11"
NAMES[1][0x020000C4] = "GroupSwapInfo12"
NAMES[1][0x020000C5] = "GroupSwapInfo13"
NAMES[1][0x020000C6] = "GroupSwapInfo14"
NAMES[1][0x020000C7] = "GroupSwapInfo15"
NAMES[1][0x020000C8] = "GroupSwapInfo16"
NAMES[1][0x020000C9] = "GroupSwapInfo17"
NAMES[1][0x020000CA] = "GroupSwapInfo18"
NAMES[1][0x020000CB] = "GroupSwapInfo19"
NAMES[1][0x020000CC] = "GroupSwapInfo20"
NAMES[1][0x020000CD] = "GroupSwapInfo21"
NAMES[1][0x020000CE] = "GroupSwapInfo22"
NAMES[1][0x020000CF] = "GroupSwapInfo23"
NAMES[1][0x020000D0] = "GroupSwapInfo24"
NAMES[1][0x020000D1] = "GroupSwapInfo25"
NAMES[1][0x020000D2] = "GroupSwapInfo26"
NAMES[1][0x020000D3] = "GroupSwapInfo27"
NAMES[1][0x020000D4] = "GroupSwapInfo28"
NAMES[1][0x020000D5] = "GroupSwapInfo29"
NAMES[1][0x020000D6] = "GroupSwapInfo30"
NAMES[1][0x020000D7] = "GroupSwapInfo31"
NAMES[1][0x020000D8] = "LowGrayRamEnable"
NAMES[1][0x020000DA] = "OutputMode"
NAMES[1][0x020000DB] = "MBI515x ΔT/DhT, serial colour params"
NAMES[1][0x020000DC] = "MBI515x ΔT/DhT, serial colour params +1"
NAMES[1][0x020000DD] = "MBI515x ΔT/DhT, serial colour params +2"
NAMES[1][0x020000DE] = "MBI515x ΔT/DhT, serial colour params +3"
NAMES[1][0x020000DF] = "MBI515x ΔT/DhT, serial colour params +4"
NAMES[1][0x020000E0] = "TV-card DVI0 W"
NAMES[1][0x020000E2] = "TV-card DVI0 H"
NAMES[1][0x020000E4] = "TV-card DVI0 X"
NAMES[1][0x020000E6] = "TV-card DVI0 Y"
NAMES[1][0x020000E8] = "LogicShiftUnitNumPerSubField"
NAMES[1][0x020000EA] = "ConfigRegister2 R"
NAMES[1][0x020000EC] = "ConfigRegister2 G"
NAMES[1][0x020000EE] = "ConfigRegister2 B"
NAMES[1][0x020000F0] = "ConfigRegister2 VR"
NAMES[1][0x020000F2] = "misc chip-specific (MBI5353, MBI5124, temperature warning …)"
NAMES[1][0x02000100] = "Blackout"
NAMES[1][0x02000101] = "Test pattern / self test"
NAMES[1][0x02000102] = "Freeze"
NAMES[1][0x02000103] = "ScreenEncrypted"
NAMES[1][0x02000104] = "SmartSetMode"
NAMES[1][0x02000110] = "AverMatrix"
NAMES[1][0x02000130] = "ColorAdjustEnable"
NAMES[1][0x02000131] = "ChromaCoefficient"
NAMES[1][0x02000149] = "ParaForCurrentVsFreq"
NAMES[1][0x0200014A] = "Bit errors"
NAMES[1][0x02000150] = "chip-specific (MY9868, RT5958, SUM2033/2117, ICN2038S, MBI5153 …)"
NAMES[1][0x02000170] = "ICN2055 registers 9–16"
NAMES[1][0x02000193] = "DVI encryption enable + PC MAC"
NAMES[1][0x0200019A] = "SetMoudleNumber (NAND-erase alias)"
NAMES[1][0x0200019B] = "SdramToSlave"
NAMES[1][0x0200019C] = "Gray18BitEn"
NAMES[1][0x0200019D] = "Clearview enable"
NAMES[1][0x0200019E] = "Clearview master"
NAMES[1][0x0200019F] = "Clearview slave"
NAMES[1][0x020001D5] = "Low latency (receiving card)"
NAMES[1][0x020001E3] = "Brightness apply"
NAMES[1][0x02000220] = "Function table"
NAMES[1][0x020004CE] = "NCPOpStateFlag"
NAMES[1][0x020004FB] = "Disconnect count"
NAMES[1][0x03000000] = "ModuleTraceTable"
NAMES[1][0x03000680] = "ScannerCabinetID"
NAMES[1][0x030006E0] = "CabinetCorrectLocationSize"
NAMES[1][0x03000800] = "AutoRefreshRateAddr"
NAMES[1][0x03002000] = "ModuleFlashTopology"
NAMES[1][0x03003000] = "ModuleFlashCheck"
NAMES[1][0x04000000] = "CardTraceTable"
NAMES[1][0x05000000] = "GammaTables"
NAMES[1][0x06000000] = "OETable"
NAMES[1][0x06000200] = "NCP marker / identity"
NAMES[1][0x060003CA] = "Low-gray grade"
NAMES[1][0x07000000] = "CorrectionData"
NAMES[1][0x08000000] = "FPGAProgram"
NAMES[1][0x09000000] = "MCUProgram"
NAMES[1][0x0A000000] = "MonitorStatus"
NAMES[1][0x0B000000] = "PointCheckData"
NAMES[1][0x0C000000] = "ModuleFlashInfo (label only)"
NAMES[1][0x0D000000] = "BootImage"
NAMES[1][0x0E000000] = "MultiChipRamA"
NAMES[1][0x0F000000] = "MultiChipRamB"
NAMES[1][0x10000000] = "MultiChipRamC"
NAMES[1][0x11000000] = "NewOETable"
NAMES[1][0x12000000] = "GeneralBuffer / ColorManageInfo"
NAMES[1][0x13000000] = "LowGrayCodeTable"
NAMES[1][0x14000000] = "CardMCU"
NAMES[1][0x14000420] = "Power supply status"
NAMES[1][0x15000000] = "SenderAuthTime"
NAMES[1][0x16000000] = "ModuleSpace"
NAMES[1][0x17000000] = "SUM6060Monitor"
NAMES[1][0x18000000] = "MAPInfo"
NAMES[1][0x19000000] = "MAPFontLib"
NAMES[1][0x1B000000] = "WriteConfigRegisterAddrFor2200 / Config2055"
NAMES[1][0x2D010000] = "FlashResult"
NAMES[1][0x2D010010] = "FlashVersion"
RANGES[#RANGES + 1] = { 0, 0x05000000, 0x05040000, "NSSD screen layout" }
RANGES[#RANGES + 1] = { 0, 0x05065000, 0x05066000, "REDU backup pairs" }
RANGES[#RANGES + 1] = { 1, 0x05000000, 0x05000600, "Gamma LUT" }
RANGES[#RANGES + 1] = { 1, 0x08000000, 0x08400000, "FPGA program / version" }
RANGES[#RANGES + 1] = { 1, 0x09000000, 0x09100000, "MCU program / version" }
RANGES[#RANGES + 1] = { 1, 0x06000200, 0x06000400, "NCP marker / identity" }
RANGES[#RANGES + 1] = { 1, 0x02000000, 0x02000100, "Receiving-card parameters" }
RANGES[#RANGES + 1] = { 0, 0x02000000, 0x02000200, "Sending-card parameters" }

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
