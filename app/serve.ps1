# Minimal static file server: powershell -File serve.ps1 [port] [-LocalOnly] [-Bind all|localhost|<interface>] [-DataDir dir] [-LogMaxMB 20]
# Plain TCP socket (like Python's http.server), so it can listen on the network without admin
# rights: http://localhost:port/ here, http://<this-pc-ip>:port/ from other machines.
# Windows Firewall may ask once whether to allow PowerShell on the network.
#
# Shared projects (as Unico's project list / VMP's projects): the server keeps a list of projects,
# one of them "current"; every browser that opens the app from this server works on the current one,
# and switching switches every browser. Same files and behaviour as serve.py:
#   <DataDir>\projects\index.json   {"current":"<id>","projects":[{"id","name","created","opened","mode"}]}
#   <DataDir>\projects\<id>.json    one project; <id>.rev its revision number
#   <DataDir>\projects\removed\     Remove moves a project's files here (<name>_<id>.json / .rev)
# At start an old single <DataDir>\project.json (+ project.rev) becomes a project of the list (moved
# in, nothing lost), and project files the index doesn't know are added back to it.
# Workspaces, as VMP's Online Project / Offline Project: every project is "online" or "offline" (its
# "mode", kept in the index; the app lists only the current project's workspace). A project without
# one gets it from its file: its "mode" when set, else online when a processor is linked to hardware,
# offline when it has processors but none linked, online when empty.
#
# Endpoints
#   GET  /<file>              static files under this folder
#   GET  /api/project         the current project (404 if none yet); headers X-Rev = its revision,
#                             X-Project = its id
#   PUT  /api/project         save a project (body = JSON; headers X-Client = sender id, X-Project = the
#                             project's id - the current one when missing, 410 when it was removed -,
#                             X-Project-Name = its name, URL-encoded, kept in the index, X-Project-Mode =
#                             online / offline, its workspace) -> 200, X-Rev,
#                             X-Project; every live-update listener then gets
#                             data: {"rev":n,"from":"<X-Client>","project":"<id>"}
#   GET  /api/projects        {"current":"<id>","projects":[{"id","name","rev","bytes","modified","opened","mode"}]}
#   POST /api/projects/new?name=N&mode=M  body = the new project (JSON; M = its workspace, else from the
#                             body) -> it becomes current
#                             -> {"ok","id","current","rev"}
#   POST /api/projects/open?id=X     make X current (404 unknown)
#   POST /api/projects/remove?id=X   move X to removed\ (409 for the only project); the most recently
#                             opened one (of X's workspace when it has another) becomes current if X was.
#   GET  /api/projects/removed       {"removed":[{"file","id","name","bytes","modified","mode"}]} (newest first)
#   POST /api/projects/restore?file=F  move removed\F.json (+ .rev) back into the list (its old id when
#                             free) and make it current (404 unknown). These four: only from the app's own
#                             page (Origin); every live-update listener gets
#                             data: {"switch":"<current id>","rev":n,"from":"<X-Client>"}
#   GET  /api/errors?project=X  the monitor errors kept until the user's Clear (app-health.js), per project,
#                             beside it in <id>.errors.json (not in the project: no unsaved mark, no undo)
#                             -> {"project","rev","held":{key:record},"gone":{key:t},"base":{key:{...}}}
#                             (X = the current one when missing; 404 unknown)
#   POST /api/errors?project=X  body {"held":{key: record | null},"gone":{key:t},"base":{key: {...} | null}} =
#                             only what changed (null = cleared; gone keeps the newest time)
#                             -> {"ok","project","rev","held":n}; keeps every open error and the newest 500
#                             ended ones (1000 gone times); only from the app's own page (Origin); every
#                             live-update listener gets data: {"errors":rev,"from":"<X-Client>","project":"<id>"}.
#                             410 unknown project. Remove / restore move the file with its project
#                             (removed\<name>_<id>.errors).
#   GET  /api/preview?project=X&screen=L  the Layout canvas's content-preview picture of screen L (app-preview.js),
#                             a JPEG beside the project (<id>.preview.<L>.jpg) -> image/jpeg, 404 none
#   PUT  /api/preview?project=X&screen=L  body = the JPEG (<= 8 MB) -> {"ok","project","screen","bytes"}; only from
#                             the app's own page (Origin); listeners get data: {"preview":"<L>","project":"<id>",
#                             "from":"<X-Client>"}. Remove / restore move the pictures with their project.
#   GET  /api/events         Server-Sent Events stream of those saves and switches (": ping" every 15 s)
#   PUT  /out/<path>          test hook: write a file into app\out (this machine only, else 403)
#   POST /api/log             client log batch: NDJSON, one JSON object per line (max 500 lines,
#                             64 KB each; lines not starting with { and ending with } are skipped)
#                             -> 204. Accepted from any address.
#   GET  /api/logs?lines=N&since=MS&until=MS&q=TEXT
#                             read the log: the most recent N (default 500, max 20000) matching lines,
#                             oldest first. since/until = epoch ms, inclusive, compared with each line's
#                             "timestamp" (server local time); q = case-insensitive substring of the raw
#                             line. No filter: only the last 4 MB of the file is read; any filter: the
#                             whole current file (not archives) is scanned. Returns JSON
#                             {"lines":[...],"file_size_bytes":n,"file_path":"...","dir_path":"...",
#                              "archive_count":n,"matched_count":n,"returned_count":n,"filtered":bool}
#   DELETE /api/logs          empty the current log file (archives kept), then log logs_cleared -> 204
#                             (this machine only, else 403)
#   POST /api/logs/reveal     open the log folder in Explorer -> 204 (this machine only, else 403)
#
# Log file: <DataDir>\logs\open_nova.log, UTF-8 without BOM, one JSON object per line (\n):
#   {"timestamp":"yyyy-MM-dd HH:mm:ss.fff","source":"server","action":"...","details":{...}}
#   {"timestamp":"yyyy-MM-dd HH:mm:ss.fff","source":"client","ip":"<sender>", <the client's own fields>}
# Client lines are the posted line with the server's fields spliced in front (not re-serialized).
# Server actions: server_start, project_saved, project_save_failed, project_save_refused,
# project_created, project_opened, project_removed, project_restored, projects_migrated, project_found, project_missing,
# projects_index_unreadable, projects_refused, errors_saved, errors_refused, events_connect, events_disconnect, http_error,
# api_not_found, logs_cleared. Static files, /api/log(s), SSE pings and GET /api/project(s) are not logged. Rotation: before appending, a file over LogMaxMB (20 MB) is renamed to
# open_nova_yyyyMMdd_HHmmss.log and only the newest 2 such archives are kept. Logging is
# best-effort: a failure to write the log never fails a request.
param([int]$Port = 8765, [switch]$LocalOnly, [string]$Bind = '', [string]$DataDir = '', [double]$LogMaxMB = 20, [int]$HelperPort = 8790)
$root = $PSScriptRoot.TrimEnd('\') + '\'
if (-not $DataDir) { $DataDir = Join-Path $root 'data' }
New-Item -ItemType Directory -Force $DataDir | Out-Null
$DataDir = (Resolve-Path -LiteralPath $DataDir).ProviderPath
$MaxBody = 64MB
$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css'; '.json' = 'application/json'; '.md' = 'text/plain; charset=utf-8'; '.scr' = 'application/octet-stream'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.woff2' = 'font/woff2'; '.jpg' = 'image/jpeg'; '.txt' = 'text/plain; charset=utf-8' }
$ascii = [Text.Encoding]::ASCII

# ---- Log file (modelled on LED Raster Designer's) ----
$logDir = Join-Path $DataDir 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$logFile = Join-Path $logDir 'open_nova.log'
$LogMaxBytes = [int64]($LogMaxMB * 1MB)
$LogTailBytes = 4MB                           # unfiltered reads only look at the end of the file
$utf8 = New-Object Text.UTF8Encoding $false    # no BOM
$inv = [Globalization.CultureInfo]::InvariantCulture
$tsRx = New-Object Text.RegularExpressions.Regex '^\{\s*"timestamp"\s*:\s*"(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})"', 'Compiled'
Add-Type -AssemblyName System.Web.Extensions
Add-Type -AssemblyName System.Net.Http
$helper = New-Object Net.Http.HttpClient            # hardware helper pass-through (/api/hw|unico|coex|rcv/*)
$helper.Timeout = [TimeSpan]::FromMinutes(15)       # a Save waits for the receiving cards (up to 10 min)
$jss = New-Object Web.Script.Serialization.JavaScriptSerializer
$jss.MaxJsonLength = [int]::MaxValue

function Get-LogTime { [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff', $inv) }

function Get-LogArchives {
    @([IO.Directory]::GetFiles($logDir, 'open_nova_*.log') | Where-Object { [IO.Path]::GetFileName($_) -match '^open_nova_\d{8}_\d{6}(_\d+)?\.log$' })
}

function Add-LogLines([string[]]$lines) {
    # Appends finished lines (no newlines inside), rotating the file first when it is too big.
    try {
        $fi = New-Object IO.FileInfo $logFile
        if ($fi.Exists -and $fi.Length -gt $LogMaxBytes) {
            $stamp = [DateTime]::Now.ToString('yyyyMMdd_HHmmss', $inv)
            $dest = Join-Path $logDir "open_nova_$stamp.log"; $k = 1
            while (Test-Path -LiteralPath $dest) { $dest = Join-Path $logDir "open_nova_${stamp}_$k.log"; $k++ }
            [IO.File]::Move($logFile, $dest)
            [string[]]$old = Get-LogArchives
            [Array]::Sort($old, [StringComparer]::OrdinalIgnoreCase); [Array]::Reverse($old)   # newest first
            for ($i = 2; $i -lt $old.Length; $i++) { try { [IO.File]::Delete($old[$i]) } catch { } }
        }
    } catch { }
    try { [IO.File]::AppendAllText($logFile, ($lines -join "`n") + "`n", $utf8) } catch { }
}

function Write-Log([string]$action, $details = $null, [string]$source = 'server') {
    try {
        $d = if ($null -ne $details) { ConvertTo-Json -InputObject $details -Compress -Depth 6 } else { '{}' }
        $line = '{"timestamp":"' + (Get-LogTime) + '","source":' + (ConvertTo-Json -InputObject $source -Compress) +
            ',"action":' + (ConvertTo-Json -InputObject $action -Compress) + ',"details":' + $d + '}'
        Add-LogLines @($line -replace "[\r\n]", '')
    } catch { }
}

function Read-Log([int]$max, [string]$needle, [string]$since, [string]$until, [bool]$filtered) {
    # The last $max matching lines, in file order. Line by line with a bounded queue, so a 20 MB
    # file never sits in memory; time filters compare the fixed-format timestamp text.
    $queue = New-Object 'Collections.Generic.Queue[string]'
    $matched = 0
    if (Test-Path -LiteralPath $logFile) {
        $fs = New-Object IO.FileStream $logFile, 'Open', 'Read', 'ReadWrite'
        try {
            $skip = $false
            if (-not $filtered -and $fs.Length -gt $LogTailBytes) { [void]$fs.Seek(-$LogTailBytes, 'End'); $skip = $true }
            $sr = New-Object IO.StreamReader $fs, $utf8, $false, 65536
            if ($skip) { [void]$sr.ReadLine() }                  # partial first line
            $timed = [bool]($since -or $until)
            $ic = [StringComparison]::OrdinalIgnoreCase
            $ord = [StringComparison]::Ordinal
            while ($null -ne ($l = $sr.ReadLine())) {
                if ($l.Length -eq 0) { continue }
                if ($needle -and $l.IndexOf($needle, $ic) -lt 0) { continue }
                if ($timed) {
                    if ($l.StartsWith('{"timestamp":"', $ord) -and $l.Length -ge 38) { $ts = $l.Substring(14, 23) }
                    else {
                        $m = $tsRx.Match($l.Substring(0, [Math]::Min(60, $l.Length)))
                        if (-not $m.Success) { continue }
                        $ts = $m.Groups[1].Value
                    }
                    if ($since -and [string]::CompareOrdinal($ts, $since) -lt 0) { continue }
                    if ($until -and [string]::CompareOrdinal($ts, $until) -gt 0) { continue }
                }
                $matched++
                $queue.Enqueue($l)
                if ($queue.Count -gt $max) { [void]$queue.Dequeue() }
            }
        } finally { $fs.Dispose() }
    }
    return @{ lines = $queue.ToArray(); matched = $matched }
}

function Get-Query([string]$target) {
    $q = @{}
    $i = $target.IndexOf('?')
    if ($i -ge 0) {
        foreach ($p in $target.Substring($i + 1).Split('&')) {
            if (-not $p) { continue }
            $kv = $p.Split([char[]]'=', 2)
            $v = if ($kv.Length -gt 1) { [Uri]::UnescapeDataString($kv[1].Replace('+', ' ')) } else { '' }
            $q[[Uri]::UnescapeDataString($kv[0].Replace('+', ' ')).ToLower()] = $v
        }
    }
    $q
}

function Get-LogStamp([string]$ms) {
    # epoch milliseconds -> the log's local "yyyy-MM-dd HH:mm:ss.fff" text ('' when missing/invalid)
    $n = [int64]0
    if (-not $ms -or -not [int64]::TryParse($ms, [ref]$n)) { return '' }
    try { [DateTimeOffset]::FromUnixTimeMilliseconds($n).LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss.fff', $inv) } catch { '' }
}

function Get-Ip($tcpClient) {
    try {
        $a = $tcpClient.Client.RemoteEndPoint.Address
        if ($a.IsIPv4MappedToIPv6) { $a = $a.MapToIPv4() }
        return [string]$a
    } catch { return '' }
}

# ---- Project list (the same files and rules as serve.py) ----
$projDir = Join-Path $DataDir 'projects'
$idxFile = Join-Path $projDir 'index.json'
$idRx = '^[a-z0-9]{1,32}$'
$script:idx = @{ current = ''; projects = (New-Object Collections.ArrayList) }
$script:revs = @{}

function Get-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
function Get-CleanName([string]$s) {
    $s = ($s -creplace '[\x00-\x1f\x7f]', '').Trim()
    if ($s.Length -gt 120) { $s = $s.Substring(0, 120) }
    $s
}
function Get-FileName([string]$s) {                 # a project name as part of a file name (removed\)
    $s = ($s -creplace '[^A-Za-z0-9 _.-]', '_').Trim(' .'.ToCharArray())
    if ($s.Length -gt 60) { $s = $s.Substring(0, 60).Trim(' .'.ToCharArray()) }
    if ($s) { $s } else { 'project' }
}
function Read-Int([string]$f) { $n = 0; try { [void][int]::TryParse([IO.File]::ReadAllText($f).Trim(), [ref]$n) } catch { }; $n }
function Get-ModeOf($o) {                           # a project's workspace (see the top): its "mode", else from its processors' links
    if ($o -isnot [Collections.IDictionary]) { return 'online' }
    if ($o['mode'] -is [string] -and ($o['mode'] -ceq 'online' -or $o['mode'] -ceq 'offline')) { return $o['mode'] }
    $n = 0
    if ($o['devices'] -is [Array]) {
        foreach ($d in $o['devices']) {
            if ($d -isnot [Collections.IDictionary]) { continue }
            $n++
            if ($d['hw'] -is [Collections.IDictionary] -and [string]$d['hw']['kind'] -cne 'offline') { return 'online' }
        }
    }
    if ($n) { 'offline' } else { 'online' }
}
function Get-MetaIn([string]$f) {                   # @(name, workspace) of a project file (@('', 'online') if unreadable)
    try { $o = $jss.DeserializeObject([IO.File]::ReadAllText($f)) } catch { return @('', 'online') }
    $nm = $(if ($o -is [Collections.IDictionary] -and $o['name'] -is [string]) { Get-CleanName $o['name'] } else { '' })
    @($nm, (Get-ModeOf $o))
}
function Get-NameIn([string]$f) { (Get-MetaIn $f)[0] }   # the "name" a project file carries ('' if none / unreadable)
function Get-ModeIn([byte[]]$b) {                   # the workspace of a project sent as bytes
    try { Get-ModeOf ($jss.DeserializeObject($utf8.GetString($b).TrimStart([char]0xFEFF))) } catch { 'online' }
}
function Get-PFile([string]$id, [string]$ext = '.json') { Join-Path $projDir ($id + $ext) }
function Get-Entry([string]$id) { foreach ($p in $script:idx.projects) { if ($p.id -ceq $id) { return $p } }; $null }
function New-ProjId {
    while ($true) { $id = [Guid]::NewGuid().ToString('N').Substring(0, 8); if (-not (Get-Entry $id) -and -not (Test-Path -LiteralPath (Get-PFile $id))) { return $id } }
}
function Add-Entry([string]$id, [string]$name, [string]$mode = 'online') {
    $n = Get-Ms
    if (-not $name) { $name = 'Project ' + ($script:idx.projects.Count + 1) }
    $e = [ordered]@{ id = $id; name = $name; created = $n; opened = $n; mode = $mode }
    [void]$script:idx.projects.Add($e)
    $e
}
function Get-Latest([string]$mode = '') {          # the most recently opened project's id (of that workspace when it has one; '' if none)
    $best = $null; $any = $false
    foreach ($p in $script:idx.projects) { if ($p.mode -ceq $mode) { $any = $true } }
    foreach ($p in $script:idx.projects) { if ((-not $any -or $p.mode -ceq $mode) -and ($null -eq $best -or $p.opened -gt $best.opened)) { $best = $p } }
    if ($null -ne $best) { $best.id } else { '' }
}
function Move-Over([string]$tmp, [string]$dest) {
    # ([NullString]::Value: PowerShell would pass $null as "" = an illegal backup path)
    if ([IO.File]::Exists($dest)) { [IO.File]::Replace($tmp, $dest, [NullString]::Value) } else { [IO.File]::Move($tmp, $dest) }
}
function Write-PFile([string]$path, [byte[]]$data) { $tmp = $path + '.tmp'; [IO.File]::WriteAllBytes($tmp, $data); Move-Over $tmp $path }
function Save-Index {
    $tmp = $idxFile + '.tmp'
    [IO.File]::WriteAllText($tmp, $jss.Serialize([ordered]@{ current = $script:idx.current; projects = $script:idx.projects.ToArray() }), $utf8)
    Move-Over $tmp $idxFile
}
function Import-Projects {
    # The index; project files it doesn't know (index lost, or copied in) are added back; an old single project.json
    # is moved in as one more project. Entries whose file is gone are dropped. Nothing is ever deleted here.
    New-Item -ItemType Directory -Force $projDir | Out-Null
    if (Test-Path -LiteralPath $idxFile) {
        try {
            $x = $jss.DeserializeObject([IO.File]::ReadAllText($idxFile))
            foreach ($p in @($x['projects'])) {
                if ($p -is [Collections.IDictionary] -and ([string]$p['id']) -cmatch $idRx -and -not (Get-Entry ([string]$p['id']))) {
                    $nm = Get-CleanName ([string]$p['name']); if (-not $nm) { $nm = [string]$p['id'] }
                    $md = $(if ([string]$p['mode'] -ceq 'online' -or [string]$p['mode'] -ceq 'offline') { [string]$p['mode'] } else { '' })
                    [void]$script:idx.projects.Add([ordered]@{ id = [string]$p['id']; name = $nm; created = [int64]$p['created']; opened = [int64]$p['opened']; mode = $md })
                }
            }
            $script:idx.current = [string]$x['current']
        } catch { Write-Log 'projects_index_unreadable' ([ordered]@{ file = $idxFile; error = $_.Exception.Message }) }
    }
    foreach ($p in @($script:idx.projects)) {
        if (-not (Test-Path -LiteralPath (Get-PFile $p.id))) { $script:idx.projects.Remove($p); Write-Log 'project_missing' ([ordered]@{ id = $p.id; name = $p.name }) }
    }
    [string[]]$fs = @([IO.Directory]::GetFiles($projDir, '*.json') | ForEach-Object { [IO.Path]::GetFileName($_) })
    [Array]::Sort($fs, [StringComparer]::Ordinal)
    foreach ($f in $fs) {
        $id = $f.Substring(0, $f.Length - 5)
        if ($f.EndsWith('.json') -and $f -cne 'index.json' -and $id -cmatch $idRx -and -not (Get-Entry $id)) {
            $m = Get-MetaIn (Get-PFile $id)
            $e = Add-Entry $id $m[0] $m[1]; Write-Log 'project_found' ([ordered]@{ id = $id; name = $e.name; mode = $m[1] })
        }
    }
    $legacy = Join-Path $DataDir 'project.json'; $lrev = Join-Path $DataDir 'project.rev'
    if (Test-Path -LiteralPath $legacy) {                # the single shared project of earlier versions
        $id = New-ProjId; $m = Get-MetaIn $legacy; $name = $m[0]; $rev = Read-Int $lrev
        [IO.File]::Move($legacy, (Get-PFile $id))
        if (Test-Path -LiteralPath $lrev) { [IO.File]::Move($lrev, (Get-PFile $id '.rev')) } else { [IO.File]::WriteAllText((Get-PFile $id '.rev'), [string]$rev) }
        $e = Add-Entry $id $name $m[1]
        if (-not (Get-Entry $script:idx.current)) { $script:idx.current = $id }
        Write-Log 'projects_migrated' ([ordered]@{ from = $legacy; id = $id; name = $e.name; rev = $rev })
    }
    foreach ($p in $script:idx.projects) {           # projects of before the workspaces: online or offline from their content
        if (-not $p.mode) { $p.mode = (Get-MetaIn (Get-PFile $p.id))[1]; Write-Log 'project_workspace' ([ordered]@{ id = $p.id; name = $p.name; mode = $p.mode; why = 'from its content' }) }
    }
    if (-not (Get-Entry $script:idx.current)) { $script:idx.current = Get-Latest }
    foreach ($p in $script:idx.projects) { $script:revs[$p.id] = Read-Int (Get-PFile $p.id '.rev') }
    Save-Index
}
function Get-Listing {
    $out = New-Object Collections.ArrayList
    foreach ($p in $script:idx.projects) {
        $fi = New-Object IO.FileInfo (Get-PFile $p.id)
        $size = [int64]0; $mod = [int64]0
        if ($fi.Exists) { $size = $fi.Length; $mod = ([DateTimeOffset]$fi.LastWriteTimeUtc).ToUnixTimeMilliseconds() }
        [void]$out.Add([ordered]@{ id = $p.id; name = $p.name; rev = [int]$script:revs[$p.id]; bytes = $size; modified = $mod; opened = [int64]$p.opened; mode = $p.mode })
    }
    [ordered]@{ current = $script:idx.current; projects = $out.ToArray() }
}
$removedRx = '_([a-z0-9]{1,32})(?:_\d{8}_\d{6})?$'     # <name>_<id>[_<stamp>] in projects\removed\
function Get-Removed {                              # projects\removed\: [{file (no .json), id, name, bytes, modified, mode}], newest first
    $rdir = Join-Path $projDir 'removed'; $out = New-Object Collections.ArrayList
    if ([IO.Directory]::Exists($rdir)) {
        foreach ($p in [IO.Directory]::GetFiles($rdir, '*.json')) {
            $fi = New-Object IO.FileInfo $p
            if (-not $fi.Name.EndsWith('.json')) { continue }
            $f = $fi.Name.Substring(0, $fi.Name.Length - 5)
            $rid = $(if ($f -cmatch $removedRx) { $Matches[1] } else { '' })
            $m = Get-MetaIn $p; $nm = $m[0]; if (-not $nm) { $nm = $f }
            [void]$out.Add([ordered]@{ file = $f; id = $rid; name = $nm; bytes = $fi.Length; modified = ([DateTimeOffset]$fi.LastWriteTimeUtc).ToUnixTimeMilliseconds(); mode = $m[1] })
        }
    }
    $items = $out.ToArray(); [int64[]]$keys = @($items | ForEach-Object { - $_.modified })
    [Array]::Sort([Array]$keys, [Array]$items)      # ([Array]: the generic overload would sort a copy; Sort-Object wraps the items)
    [ordered]@{ removed = $items }
}
# ---- Monitor errors kept until the user's Clear (per project, beside it: <id>.errors.json; the same rules as serve.py) ----
$ErrEndedMax = 500; $ErrGoneMax = 1000      # every open error + the newest 500 ended ones; cleared alarm-log times
$dictT = [Collections.Generic.Dictionary[string, object]]   # (a PowerShell @{} ignores case; ::new() = not wrapped for the serializer)
function Read-Errors([string]$id) {                 # <id>.errors.json (empty when none / unreadable)
    $doc = [ordered]@{ rev = 0; held = $dictT::new(); gone = $dictT::new(); base = $dictT::new() }
    $f = Get-PFile $id '.errors.json'
    if ([IO.File]::Exists($f)) {
        try {
            $x = $jss.DeserializeObject([IO.File]::ReadAllText($f))
            if ($x -is [Collections.IDictionary]) {
                if ($x['rev'] -is [ValueType]) { $doc.rev = [int]$x['rev'] }
                foreach ($k in 'held', 'gone', 'base') { if ($x[$k] -is [Collections.Generic.Dictionary[string, object]]) { $doc[$k] = $x[$k] } }
            }
        } catch { }
    }
    $doc
}
function Get-Num($v) { if ($v -is [ValueType] -and $v -isnot [bool]) { [double]$v } else { [double]0 } }
function Merge-Errors($doc, $ch) {
    # One browser's changes into the kept errors: records set / cleared (null) by key, cleared alarm-log times (newest
    # wins), counter baselines; then the cap (every open error, the newest ended ones). Returns @(set, cleared).
    $n = @(0, 0)
    foreach ($part in 'held', 'base') {
        $h = $ch[$part]
        if ($h -isnot [Collections.IDictionary]) { continue }
        foreach ($k in @($h.Keys)) {
            if ($k.Length -gt 400) { continue }
            $v = $h[$k]
            if ($v -is [Collections.IDictionary]) { $doc[$part][$k] = $v; if ($part -eq 'held') { $n[0]++ } }
            elseif ($null -eq $v -and $doc[$part].ContainsKey($k)) { [void]$doc[$part].Remove($k); if ($part -eq 'held') { $n[1]++ } }
        }
    }
    $g = $ch['gone']
    if ($g -is [Collections.IDictionary]) {
        foreach ($k in @($g.Keys)) {
            $t = Get-Num $g[$k]
            if ($t -and $k.Length -le 400 -and (-not $doc.gone.ContainsKey($k) -or (Get-Num $doc.gone[$k]) -lt $t)) { $doc.gone[$k] = $g[$k] }
        }
    }
    $ended = @(foreach ($k in @($doc.held.Keys)) { $r = $doc.held[$k]; if ($r -is [Collections.IDictionary] -and (Get-Num $r['ended'])) { [pscustomobject]@{ k = $k; t = (Get-Num $r['ended']) } } })
    if ($ended.Count -gt $ErrEndedMax) { foreach ($e in @($ended | Sort-Object t -Descending | Select-Object -Skip $ErrEndedMax)) { [void]$doc.held.Remove($e.k) } }
    if ($doc.gone.Count -gt $ErrGoneMax) {
        $gs = @(foreach ($k in @($doc.gone.Keys)) { [pscustomobject]@{ k = $k; t = (Get-Num $doc.gone[$k]) } })
        foreach ($e in @($gs | Sort-Object t -Descending | Select-Object -Skip $ErrGoneMax)) { [void]$doc.gone.Remove($e.k) }
    }
    $doc.rev = [int]$doc.rev + 1
    $n
}
function Send-Json($client, [int]$code, [string]$reason, $obj) {
    Send-Response $client $code $reason 'application/json; charset=utf-8' ($utf8.GetBytes($jss.Serialize($obj)))
}
Import-Projects

# Which networks (Settings > Network "App reachable from", as serve.py / tools/netif.py bind_plan): -Bind all | localhost |
# an interface name ("Ethernet 2") or one of its IPv4 addresses = that network and this computer; empty = this computer's
# saved choice (%APPDATA%\OpenNova\network.json; OPENNOVA_CONFIG_DIR overrides the folder). -LocalOnly = localhost.
$cfgDir = $env:OPENNOVA_CONFIG_DIR
if (-not $cfgDir) { $cfgDir = Join-Path $(if ($env:APPDATA) { $env:APPDATA } else { $HOME }) 'OpenNova' }
$cfgDir = [IO.Path]::GetFullPath($cfgDir)
if ($cfgDir.StartsWith((Split-Path $root -Parent).TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $cfgDir = '' }   # never in the (synced) Open Nova folder
if (-not $Bind -and $cfgDir) { try { $Bind = [string](Get-Content -LiteralPath (Join-Path $cfgDir 'network.json') -Raw -Encoding UTF8 | ConvertFrom-Json).bind } catch { } }
if ($LocalOnly -or $Bind -eq 'local' -or $Bind -eq '127.0.0.1') { $Bind = 'localhost' }
if (-not $Bind) { $Bind = 'all' }
$bindNote = ''; $bindIps = @()
if ($Bind -ne 'all' -and $Bind -ne 'localhost') {
    $ip = $null
    if ([Net.IPAddress]::TryParse($Bind, [ref]$ip) -and $ip.AddressFamily -eq 'InterNetwork') { $bindIps = @($Bind) }
    else { $bindIps = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias $Bind -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike '127.*' } | ForEach-Object { $_.IPAddress }) }
    if (-not $bindIps.Count) { $bindNote = "`"$Bind`" is not connected now: this computer only until the next start with it connected" }
}
$listeners = New-Object Collections.ArrayList
if ($Bind -eq 'all') {
    $tcp = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::IPv6Any), $Port
    $tcp.Server.DualMode = $true          # IPv4 and IPv6, every interface
    $tcp.Start(); [void]$listeners.Add($tcp)
} else {
    $tcp = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback), $Port   # this computer always (http://localhost:...)
    $tcp.Start(); [void]$listeners.Add($tcp)
    foreach ($a in $bindIps) {
        try { $l = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Parse($a)), $Port; $l.Start(); [void]$listeners.Add($l) }
        catch { $bindNote = ($bindNote + ' ' + "cannot listen on $a ($($_.Exception.Message))").Trim(); $bindIps = @($bindIps | Where-Object { $_ -ne $a }) }
    }
}
$localOnlyNow = $Bind -ne 'all' -and -not $bindIps.Count
Write-Host "Serving $root on http://localhost:$Port/"
$addresses = New-Object Collections.Generic.List[string]
if ($Bind -eq 'all') {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' } |
        ForEach-Object { $addresses.Add("http://$($_.IPAddress):$Port/") }
} else { foreach ($a in $bindIps) { $addresses.Add("http://${a}:$Port/") } }
foreach ($a in $addresses) { Write-Host "                 and $a" }
if ($Bind -ne 'all') { Write-Host "Reachable from: $(if ($localOnlyNow) { 'this computer only' } else { "$Bind and this computer" }) (Settings > Network)" }
if ($bindNote) { Write-Host "Note: $bindNote" }
if ($cfgDir) {   # what this server listens on, for the dialog's "now" line (as serve.py)
    try {
        New-Item -ItemType Directory -Force $cfgDir | Out-Null
        $hosts = $null; if ($Bind -ne 'all') { $hosts = @('127.0.0.1') + $bindIps }
        $applied = [ordered]@{ choice = $Bind; hosts = $hosts; note = $bindNote; server = 'serve.ps1'; pid = $PID; at = [long]([DateTime]::UtcNow - [DateTime]'1970-01-01').TotalMilliseconds }
        [IO.File]::WriteAllText((Join-Path $cfgDir "network-applied-$Port.json"), $jss.Serialize($applied), (New-Object Text.UTF8Encoding $false))
    } catch { }
}
Write-Host "Log file: $logFile"
$ver = 'unknown'   # which Open Nova this is (version.json, the one version source; as serve.py)
try { $vj = Get-Content -LiteralPath (Join-Path $root 'version.json') -Raw -Encoding UTF8 | ConvertFrom-Json; $ver = "$($vj.version) (build $($vj.build), $($vj.channel))" } catch { }
Write-Host "Open Nova $ver"
Write-Log 'server_start' ([ordered]@{
    port = $Port; data_dir = $DataDir; log_file = $logFile; addresses = [string[]]$addresses.ToArray()
    local_only = [bool]$localOnlyNow; bind = $Bind; bind_note = $(if ($bindNote) { $bindNote } else { $null }); ps_version = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.VersionString; version = $ver
})

function Send-Response($client, [int]$code, [string]$reason, [string]$type, [byte[]]$body, [string]$extra = '') {
    if (-not $body) { $body = [byte[]]@() }
    $h = "HTTP/1.1 $code $reason`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n" + $extra
    if ($type) { $h += "Content-Type: $type`r`n" }
    $hb = $ascii.GetBytes($h + "`r`n")
    $s = $client.GetStream()
    $s.Write($hb, 0, $hb.Length)
    if ($body.Length) { $s.Write($body, 0, $body.Length) }
    $s.Flush()
}

$sse = New-Object Collections.ArrayList       # open live-update connections
function Send-Event([string]$data) {
    $b = [Text.Encoding]::UTF8.GetBytes($(if ($data) { "data: $data`n`n" } else { ": ping`n`n" }))
    foreach ($s in @($sse)) {
        $ok = $true
        try {
            # a listener never sends anything, so "readable with nothing to read" = it hung up
            if ($s.Client.Poll(0, [Net.Sockets.SelectMode]::SelectRead) -and $s.Client.Available -eq 0) { $ok = $false }
            else { $s.GetStream().Write($b, 0, $b.Length) }
        } catch { $ok = $false }
        if (-not $ok) {
            $ip = Get-Ip $s
            try { $s.Close() } catch { }
            $sse.Remove($s)
            Write-Log 'events_disconnect' ([ordered]@{ ip = $ip; open = $sse.Count })
        }
    }
}

function Handle($c) {
    if (-not $c.head) {                                     # parse the request head once
        $text = $ascii.GetString($c.buf.GetBuffer(), 0, [int][Math]::Min($c.buf.Length, 65536))
        $end = $text.IndexOf("`r`n`r`n")
        if ($end -lt 0) { return ($c.buf.Length -gt 65536) } # headers not complete yet (or absurd)
        $lines = $text.Substring(0, $end) -split "`r`n"
        $req = $lines[0] -split ' '
        $hdr = @{}
        foreach ($ln in $lines[1..($lines.Length - 1)]) { $i = $ln.IndexOf(':'); if ($i -gt 0) { $hdr[$ln.Substring(0, $i).Trim().ToLower()] = $ln.Substring($i + 1).Trim() } }
        $len = 0
        if ($hdr['content-length']) { $len = [int64]$hdr['content-length'] }
        if ($len -gt $MaxBody) { Send-Response $c.client 413 'Too Large' $null $null; return $true }
        $c.head = @{ method = $req[0]; target = $(if ($req.Length -gt 1) { $req[1] } else { '/' }); hdr = $hdr; len = [int]$len; bodyStart = $end + 4 }
    }
    $method = $c.head.method; $target = $c.head.target; $hdr = $c.head.hdr; $len = $c.head.len; $bodyStart = $c.head.bodyStart
    if ($c.buf.Length - $bodyStart -lt $len) { return $false } # body not complete yet

    $rel = [Uri]::UnescapeDataString(($target -split '\?')[0].TrimStart('/'))
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    $remote = $c.client.Client.RemoteEndPoint.Address
    if ($remote.IsIPv4MappedToIPv6) { $remote = $remote.MapToIPv4() }
    $isLocal = [Net.IPAddress]::IsLoopback($remote)
    $ip = [string]$remote

    # Hardware helper calls (tools\novalink.py on 127.0.0.1:8790) pass through this server, so the app reaches the
    # processors from any device that can open the app, with nothing else to open. Sent in the background: the
    # reply goes back when it arrives (the loop below keeps serving everyone else; long Saves are fine).
    if ($rel -match '^api/(hw|unico|coex|rcv)/') {
        if (-not $c.proxy) {
            # Only the app's own page may drive the hardware: a browser always sends Origin on a POST, and another
            # site's page would carry its own origin; a JSON body can't be sent cross-site without a preflight, which
            # this server never grants. (Without these checks any page the operator opened could POST here.)
            $origin = $hdr['origin']
            if ($origin -and $origin -ne ('http://' + $hdr['host'])) {
                Write-Log 'helper_refused' ([ordered]@{ ip = $ip; path = $rel; origin = $origin })
                Send-Response $c.client 403 'Forbidden' 'application/json' ([Text.Encoding]::UTF8.GetBytes('{"ok":false,"error":"refused: not the app''s own page"}'))
                return $true
            }
            if ($method -eq 'POST' -and ([string]$hdr['content-type']) -notmatch '^application/json') {
                Send-Response $c.client 415 'Unsupported Media Type' 'application/json' ([Text.Encoding]::UTF8.GetBytes('{"ok":false,"error":"JSON only"}'))
                return $true
            }
            $qi = $target.IndexOf('?'); $qs = if ($qi -ge 0) { $target.Substring($qi) } else { '' }   # downloads carry their name in the query
            $msg = New-Object Net.Http.HttpRequestMessage ([Net.Http.HttpMethod]::new($method)), ('http://127.0.0.1:' + $HelperPort + '/' + $rel + $qs)
            if ($len -gt 0) {
                $body = New-Object byte[] $len                   # one copy of the body (a 40 MB NCP must not be copied per pass)
                [Array]::Copy($c.buf.GetBuffer(), $bodyStart, $body, 0, $len)
                $msg.Content = New-Object Net.Http.ByteArrayContent (, $body)
                $msg.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/json')
            }
            $c.proxy = $helper.SendAsync($msg)
            return $false
        }
        if (-not $c.proxy.IsCompleted) { return $false }
        if ($c.proxy.IsFaulted -or $c.proxy.IsCanceled) {
            $err = $(if ($c.proxy.Exception) { $c.proxy.Exception.GetBaseException().Message } else { 'cancelled' })
            $why = $(if ($c.proxy.IsCanceled -or $err -match 'cancel') { 'the hardware helper didn''t answer within ' + [int]$helper.Timeout.TotalMinutes + ' minutes (it may still be working)' } else { 'the hardware helper is not running (' + ($err -replace '"', "'") + ')' })
            Send-Response $c.client 502 'Bad Gateway' 'application/json' ([Text.Encoding]::UTF8.GetBytes('{"ok":false,"error":"' + $why + '"}'))
            return $true
        }
        $res = $c.proxy.Result
        $b = $res.Content.ReadAsByteArrayAsync().Result
        Send-Response $c.client ([int]$res.StatusCode) ([string]$res.ReasonPhrase) 'application/json' $b
        return $true
    }

    $data = $c.buf.ToArray()

    if ($rel -eq 'api/log' -and $method -eq 'POST') {
        # Client log batch (NDJSON). Each line gets the server's fields spliced in front of its own
        # - cheap, and the client's text is kept exactly as sent (minus any raw line breaks).
        $prefix = '{"timestamp":"' + (Get-LogTime) + '","source":"client","ip":"' + $ip + '",'
        $text = [Text.Encoding]::UTF8.GetString($data, $bodyStart, $len).TrimStart([char]0xFEFF)
        $out = New-Object Collections.Generic.List[string]
        $n = 0
        foreach ($ln in $text.Split([char]10)) {
            $ln = $ln.Replace("`r", '').Trim()
            if ($ln.Length -eq 0) { continue }
            $n++
            if ($n -gt 500) { break }
            if ($ln.Length -gt 65536 -or -not $ln.StartsWith('{') -or -not $ln.EndsWith('}')) { continue }
            $rest = $ln.Substring(1)
            if ($rest.Trim() -eq '}') { $out.Add($prefix.TrimEnd(',') + '}') } else { $out.Add($prefix + $rest) }
        }
        if ($out.Count) { Add-LogLines $out.ToArray() }
        Send-Response $c.client 204 'No Content' $null $null
        return $true
    }
    if ($rel -eq 'api/logs' -and $method -eq 'GET') {
        $q = Get-Query $target
        $max = 500; $v = 0
        if ($q['lines'] -and [int]::TryParse($q['lines'], [ref]$v)) { $max = [Math]::Max(1, [Math]::Min(20000, $v)) }
        $since = Get-LogStamp $q['since']; $until = Get-LogStamp $q['until']; $needle = [string]$q['q']
        $filtered = [bool]($since -or $until -or $needle)
        $r = Read-Log $max $needle $since $until $filtered
        $fi = New-Object IO.FileInfo $logFile
        $res = [ordered]@{
            lines = [string[]]$r.lines; file_size_bytes = [int64]$(if ($fi.Exists) { $fi.Length } else { 0 })
            file_path = [string]$logFile; dir_path = [string]$logDir; archive_count = [int](Get-LogArchives).Count
            matched_count = [int]$r.matched; returned_count = [int]$r.lines.Length; filtered = $filtered
        }
        Send-Response $c.client 200 'OK' 'application/json; charset=utf-8' ($utf8.GetBytes($jss.Serialize($res)))
        return $true
    }
    if ($rel -eq 'api/logs' -and $method -eq 'DELETE') {
        if (-not $isLocal) { Send-Response $c.client 403 'Forbidden' $null $null; return $true }
        [IO.File]::WriteAllBytes($logFile, [byte[]]@())
        Write-Log 'logs_cleared' ([ordered]@{ ip = $ip })
        Send-Response $c.client 204 'No Content' $null $null
        return $true
    }
    if ($rel -eq 'api/logs/reveal' -and $method -eq 'POST') {
        if (-not $isLocal) { Send-Response $c.client 403 'Forbidden' $null $null; return $true }
        Start-Process explorer.exe -ArgumentList ('"' + $logDir + '"')
        Send-Response $c.client 204 'No Content' $null $null
        return $true
    }
    if ($rel -eq 'api/events' -and $method -eq 'GET') {
        # Live updates (Server-Sent Events): the connection stays open and gets one
        # "data: {rev, from}" line per saved change.
        $h = $ascii.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: text/event-stream`r`nCache-Control: no-store`r`nConnection: keep-alive`r`n`r`nretry: 2000`n`n")
        $c.client.GetStream().Write($h, 0, $h.Length)
        $c.sse = $true
        Write-Log 'events_connect' ([ordered]@{ ip = $ip; open = $sse.Count + 1 })   # joins $sse when Handle returns
        return $true
    }
    if ($rel -eq 'api/project') {
        if ($method -eq 'GET') {
            $id = $script:idx.current; $xh = "X-Rev: $([int]$script:revs[$id])`r`nX-Project: $id`r`n"
            if (-not $id -or -not (Test-Path -LiteralPath (Get-PFile $id))) { Send-Response $c.client 404 'Not Found' 'text/plain' $null $xh; return $true }
            Send-Response $c.client 200 'OK' 'application/json' ([IO.File]::ReadAllBytes((Get-PFile $id))) $xh; return $true
        }
        if ($method -eq 'PUT') {
            # The server's copy is the project; the latest save wins and every other browser is told. A save names its
            # project (X-Project), so one that arrives after another browser switched projects still lands where it belongs.
            $body = New-Object byte[] $len
            [Array]::Copy($data, $bodyStart, $body, 0, $len)
            $from = ($hdr['x-client'] -replace '[^A-Za-z0-9_-]', '')
            $want = ([string]$hdr['x-project']).Trim()
            $name = Get-CleanName ([Uri]::UnescapeDataString([string]$hdr['x-project-name']))
            $mode = $(if ([string]$hdr['x-project-mode'] -ceq 'online' -or [string]$hdr['x-project-mode'] -ceq 'offline') { [string]$hdr['x-project-mode'] } else { '' })
            if ($want -and -not (Get-Entry $want)) {
                Write-Log 'project_save_refused' ([ordered]@{ project = $(if ($want.Length -gt 40) { $want.Substring(0, 40) } else { $want }); why = 'no such project (removed?)'; from = $from; ip = $ip })
                Send-Response $c.client 410 'Gone' 'text/plain' ($ascii.GetBytes('that project was removed')) "X-Project: $($script:idx.current)`r`n"
                return $true
            }
            $id = $(if ($want) { $want } else { $script:idx.current })
            try {
                if (-not $id) { $id = New-ProjId; [void](Add-Entry $id $name $(if ($mode) { $mode } else { Get-ModeIn $body })); $script:idx.current = $id; Save-Index }   # the first project
                Write-PFile (Get-PFile $id) $body
                $script:revs[$id] = [int]$script:revs[$id] + 1
                [IO.File]::WriteAllText((Get-PFile $id '.rev'), [string]$script:revs[$id])
                $e = Get-Entry $id
                if ($mode -and $e.mode -cne $mode) {        # the app moved it to the other workspace
                    Write-Log 'project_workspace' ([ordered]@{ id = $id; name = $(if ($name) { $name } else { $e.name }); mode = $mode; was = $e.mode; from = $from }); $e.mode = $mode; Save-Index
                }
                if ($name -and $e.name -cne $name) { $e.name = $name; Save-Index }
            } catch {
                $err = $_
                Write-Log 'project_save_failed' ([ordered]@{ error = $err.Exception.Message; project = $id; ip = $ip })
                throw $err                                      # -> the 500 path below
            }
            $rev = [int]$script:revs[$id]
            Send-Response $c.client 200 'OK' 'text/plain' $null "X-Rev: $rev`r`nX-Project: $id`r`n"
            Write-Log 'project_saved' ([ordered]@{ rev = $rev; bytes = $len; project = $id; from = $from; ip = $ip })
            Send-Event ('{"rev":' + $rev + ',"from":"' + $from + '","project":"' + $id + '"}')
            return $true
        }
    }
    if ($rel -eq 'api/projects' -and $method -eq 'GET') { Send-Json $c.client 200 'OK' (Get-Listing); return $true }
    if ($rel -eq 'api/projects/removed' -and $method -eq 'GET') { Send-Json $c.client 200 'OK' (Get-Removed); return $true }
    if ($rel.StartsWith('api/projects/') -and $method -eq 'POST') {
        # New / Open / Remove: the project every browser is on changes, so every browser is told to switch.
        $act = $rel.Substring(13)
        $origin = $hdr['origin']
        if ($origin -and $origin -ne ('http://' + $hdr['host'])) {
            Write-Log 'projects_refused' ([ordered]@{ ip = $ip; action = $act; origin = $origin })
            Send-Json $c.client 403 'Forbidden' ([ordered]@{ ok = $false; error = 'refused: not the app''s own page' }); return $true
        }
        $q = Get-Query $target
        $from = ($hdr['x-client'] -replace '[^A-Za-z0-9_-]', '')
        $id = ([string]$q['id']).Trim(); $info = [ordered]@{}
        $e = $(if ($id) { Get-Entry $id } else { $null })
        if ($act -ceq 'new') {
            $body = New-Object byte[] $len
            [Array]::Copy($data, $bodyStart, $body, 0, $len)
            $k = 0; while ($k -lt $len -and (9, 10, 11, 12, 13, 32) -contains $body[$k]) { $k++ }
            if ($k -ge $len -or $body[$k] -ne 123) { Send-Json $c.client 400 'Bad Request' ([ordered]@{ ok = $false; error = 'the project must be JSON' }); return $true }
            $id = New-ProjId; Write-PFile (Get-PFile $id) $body; $script:revs[$id] = 1
            [IO.File]::WriteAllText((Get-PFile $id '.rev'), '1')
            $md = $(if ([string]$q['mode'] -ceq 'online' -or [string]$q['mode'] -ceq 'offline') { [string]$q['mode'] } else { Get-ModeIn $body })
            $e = Add-Entry $id (Get-CleanName ([string]$q['name'])) $md; $script:idx.current = $id
            $info['bytes'] = $len
        } elseif ($act -ceq 'open' -or $act -ceq 'remove') {
            if ($null -eq $e) { Send-Json $c.client 404 'Not Found' ([ordered]@{ ok = $false; error = 'no such project' }); return $true }
            if ($act -ceq 'open') { $e.opened = Get-Ms; $script:idx.current = $id }
            else {
                if ($script:idx.projects.Count -lt 2) { Send-Json $c.client 409 'Conflict' ([ordered]@{ ok = $false; error = 'the only project can''t be removed' }); return $true }
                $rdir = Join-Path $projDir 'removed'
                New-Item -ItemType Directory -Force $rdir | Out-Null
                $base = Join-Path $rdir ((Get-FileName $e.name) + '_' + $id)
                if (Test-Path -LiteralPath ($base + '.json')) { $base += '_' + [DateTime]::Now.ToString('yyyyMMdd_HHmmss', $inv) }
                [IO.File]::Move((Get-PFile $id), $base + '.json')
                if (Test-Path -LiteralPath (Get-PFile $id '.rev')) { [IO.File]::Move((Get-PFile $id '.rev'), $base + '.rev') }
                if (Test-Path -LiteralPath (Get-PFile $id '.errors.json')) { [IO.File]::Move((Get-PFile $id '.errors.json'), $base + '.errors') }
                foreach ($pv in [IO.Directory]::GetFiles($projDir, $id + '.preview.*.jpg')) { [IO.File]::Move($pv, $base + [IO.Path]::GetFileName($pv).Substring($id.Length)) }   # the content-preview pictures go with it
                $script:idx.projects.Remove($e); $script:revs.Remove($id); $info['moved_to'] = $base + '.json'
                if ($script:idx.current -ceq $id) { $script:idx.current = Get-Latest $e.mode }
            }
        } elseif ($act -ceq 'restore') {                 # a removed project back into the list (its old id when free), made current
            $f = [string]$q['file']; $rdir = Join-Path $projDir 'removed'; $src = Join-Path $rdir ($f + '.json')
            if ($f -cnotmatch '^[A-Za-z0-9 _.-]{1,120}$' -or $f -eq '.' -or $f -eq '..' -or -not [IO.File]::Exists($src)) {
                Send-Json $c.client 404 'Not Found' ([ordered]@{ ok = $false; error = 'no such removed project' }); return $true
            }
            $id = ''; $m = Get-MetaIn $src; $nm = $m[0]
            if ($f -cmatch $removedRx) { $id = $Matches[1]; if (-not $nm) { $nm = $f.Substring(0, $f.Length - $Matches[0].Length) } }
            if (-not $nm) { $nm = $f }
            if (-not $id -or (Get-Entry $id) -or (Test-Path -LiteralPath (Get-PFile $id))) { $id = New-ProjId }
            [IO.File]::Move($src, (Get-PFile $id))
            $srev = Join-Path $rdir ($f + '.rev')
            if ([IO.File]::Exists($srev)) { [IO.File]::Move($srev, (Get-PFile $id '.rev')) } else { [IO.File]::WriteAllText((Get-PFile $id '.rev'), '1') }
            $script:revs[$id] = Read-Int (Get-PFile $id '.rev')
            $serr = Join-Path $rdir ($f + '.errors')
            if ([IO.File]::Exists($serr) -and -not [IO.File]::Exists((Get-PFile $id '.errors.json'))) { [IO.File]::Move($serr, (Get-PFile $id '.errors.json')) }
            foreach ($pv in [IO.Directory]::GetFiles($rdir, $f + '.preview.*.jpg')) {
                $to = Get-PFile $id ([IO.Path]::GetFileName($pv).Substring($f.Length)); if (-not [IO.File]::Exists($to)) { [IO.File]::Move($pv, $to) }
            }
            $e = Add-Entry $id $nm $m[1]; $script:idx.current = $id; $info['from_file'] = $f + '.json'
        } else { Send-Json $c.client 404 'Not Found' ([ordered]@{ ok = $false; error = 'unknown action' }); return $true }
        Save-Index
        $cur = $script:idx.current; $rev = [int]$script:revs[$cur]
        $info['id'] = $id; $info['name'] = $e.name; $info['mode'] = $e.mode; $info['current'] = $cur; $info['from'] = $from; $info['ip'] = $ip
        Write-Log $(if ($act -ceq 'new') { 'project_created' } elseif ($act -ceq 'open') { 'project_opened' } elseif ($act -ceq 'restore') { 'project_restored' } else { 'project_removed' }) $info
        Send-Json $c.client 200 'OK' ([ordered]@{ ok = $true; id = $id; current = $cur; rev = $rev })
        Send-Event ('{"switch":"' + $cur + '","rev":' + $rev + ',"from":"' + $from + '"}')
        return $true
    }
    if ($rel -eq 'api/errors' -and ($method -eq 'GET' -or $method -eq 'POST')) {
        # The monitor errors kept until the user's Clear, per project, beside it (not in it: no unsaved mark, no undo).
        # Every browser sends only what it changed; the server merges, so a Clear in one browser clears it in all.
        $from = ($hdr['x-client'] -replace '[^A-Za-z0-9_-]', '')
        if ($method -eq 'POST') {
            $origin = $hdr['origin']
            if ($origin -and $origin -ne ('http://' + $hdr['host'])) {
                Write-Log 'errors_refused' ([ordered]@{ ip = $ip; origin = $origin })
                Send-Json $c.client 403 'Forbidden' ([ordered]@{ ok = $false; error = 'refused: not the app''s own page' }); return $true
            }
        }
        $q = Get-Query $target
        $id = ([string]$q['project']).Trim(); if (-not $id) { $id = $script:idx.current }
        if (-not $id -or -not (Get-Entry $id)) {
            if ($method -eq 'GET') { Send-Json $c.client 404 'Not Found' ([ordered]@{ ok = $false; error = 'no such project' }) }
            else { Send-Json $c.client 410 'Gone' ([ordered]@{ ok = $false; error = 'no such project' }) }
            return $true
        }
        $doc = Read-Errors $id
        if ($method -eq 'GET') { $doc['project'] = $id; Send-Json $c.client 200 'OK' $doc; return $true }
        $ch = $null
        try { $ch = $jss.DeserializeObject([Text.Encoding]::UTF8.GetString($data, $bodyStart, $len).TrimStart([char]0xFEFF)) } catch { }
        if ($ch -isnot [Collections.IDictionary]) { Send-Json $c.client 400 'Bad Request' ([ordered]@{ ok = $false; error = 'the change must be a JSON object' }); return $true }
        $n = Merge-Errors $doc $ch
        Write-PFile (Get-PFile $id '.errors.json') ($utf8.GetBytes($jss.Serialize($doc)))
        $rev = [int]$doc.rev; $held = $doc.held.Count
        Send-Json $c.client 200 'OK' ([ordered]@{ ok = $true; project = $id; rev = $rev; held = $held })
        Write-Log 'errors_saved' ([ordered]@{ project = $id; rev = $rev; set = $n[0]; cleared = $n[1]; held = $held; from = $from; ip = $ip })
        Send-Event ('{"errors":' + $rev + ',"from":"' + $from + '","project":"' + $id + '"}')
        return $true
    }
    if ($rel -eq 'api/preview' -and ($method -eq 'GET' -or $method -eq 'PUT')) {
        # The Layout canvas's content-preview picture per project and screen (PRO_LOOK_PLAN §5.2), beside the project
        # (<id>.preview.<screen>.jpg): never in the project, never sent to a processor. The same rules as serve.py.
        $from = ($hdr['x-client'] -replace '[^A-Za-z0-9_-]', '')
        if ($method -eq 'PUT') {
            $origin = $hdr['origin']
            if ($origin -and $origin -ne ('http://' + $hdr['host'])) {
                Write-Log 'preview_refused' ([ordered]@{ ip = $ip; origin = $origin })
                Send-Json $c.client 403 'Forbidden' ([ordered]@{ ok = $false; error = 'refused: not the app''s own page' }); return $true
            }
        }
        $q = Get-Query $target
        $id = ([string]$q['project']).Trim(); if (-not $id) { $id = $script:idx.current }
        $sid = ([string]$q['screen']) -replace '[^A-Za-z0-9_-]', ''; if ($sid.Length -gt 40) { $sid = $sid.Substring(0, 40) }
        if (-not $id -or -not (Get-Entry $id) -or -not $sid) { Send-Json $c.client 404 'Not Found' ([ordered]@{ ok = $false; error = 'no such project / screen' }); return $true }
        $pf = Get-PFile $id ('.preview.' + $sid + '.jpg')
        if ($method -eq 'GET') {
            if (-not [IO.File]::Exists($pf)) { Send-Response $c.client 404 'Not Found' 'text/plain' ([Text.Encoding]::UTF8.GetBytes('no picture')); return $true }
            Send-Response $c.client 200 'OK' 'image/jpeg' ([IO.File]::ReadAllBytes($pf)); return $true
        }
        if ($len -lt 4 -or $data[$bodyStart] -ne 0xFF -or $data[$bodyStart + 1] -ne 0xD8 -or $len -gt 8MB) {
            Send-Json $c.client 400 'Bad Request' ([ordered]@{ ok = $false; error = 'a JPEG of at most 8 MB' }); return $true
        }
        $body = New-Object byte[] $len
        [Array]::Copy($data, $bodyStart, $body, 0, $len)
        Write-PFile $pf $body
        Write-Log 'preview_saved' ([ordered]@{ project = $id; screen = $sid; bytes = $len; from = $from; ip = $ip })
        Send-Json $c.client 200 'OK' ([ordered]@{ ok = $true; project = $id; screen = $sid; bytes = $len })
        Send-Event ('{"preview":"' + $sid + '","project":"' + $id + '","from":"' + $from + '"}')
        return $true
    }
    if ($method -eq 'PUT' -and $rel.StartsWith('out/')) {
        # test hook: save a file into app\out - only from this machine, never over the network
        if (-not $isLocal -or -not $path.StartsWith($root + 'out\')) { Send-Response $c.client 403 'Forbidden' $null $null; return $true }
        New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
        $body = New-Object byte[] $len
        [Array]::Copy($data, $bodyStart, $body, 0, $len)
        [IO.File]::WriteAllBytes($path, $body)
        Send-Response $c.client 204 'No Content' $null $null
        return $true
    }
    if (($method -eq 'GET' -or $method -eq 'HEAD') -and $path.StartsWith($root) -and (Test-Path -LiteralPath $path -PathType Leaf)) {
        $ext = [IO.Path]::GetExtension($path).ToLower()
        $type = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
        $bytes = if ($method -eq 'GET') { [IO.File]::ReadAllBytes($path) } else { $null }
        Send-Response $c.client 200 'OK' $type $bytes
        return $true
    }
    if ($rel.StartsWith('api/')) { Write-Log 'api_not_found' ([ordered]@{ method = $method; path = '/' + $rel; ip = $ip }) }
    Send-Response $c.client 404 'Not Found' 'text/plain' ($ascii.GetBytes('Not found'))
    return $true
}

# Single-threaded event loop: browsers open spare connections they may never use,
# so nothing here blocks on one client.
$clients = New-Object Collections.ArrayList
$chunk = New-Object byte[] 65536
$lastPing = [DateTime]::UtcNow
while ($true) {
    $busy = $false
    foreach ($L in $listeners) {   # every interface, or loopback + the chosen interface's addresses (Settings > Network)
        while ($L.Pending()) {
            [void]$clients.Add(@{ client = $L.AcceptTcpClient(); buf = (New-Object IO.MemoryStream); t = [DateTime]::UtcNow })
            $busy = $true
        }
    }
    foreach ($c in @($clients)) {
        $done = $false
        try {
            while ($c.client.Available -gt 0) {
                $n = $c.client.GetStream().Read($chunk, 0, $chunk.Length)
                if ($n -le 0) { break }
                $c.buf.Write($chunk, 0, $n); $c.t = [DateTime]::UtcNow; $busy = $true
            }
            if ($c.buf.Length -gt 0) { $done = Handle $c }
            if (-not $done -and -not $c.proxy -and ([DateTime]::UtcNow - $c.t).TotalSeconds -gt 15) { $done = $true }   # idle spare connection (not a helper call in flight)
        } catch {
            $msg = $_.Exception.Message
            try { Send-Response $c.client 500 'Server Error' 'text/plain' ($ascii.GetBytes($msg)) } catch { }
            $hd = $c.head
            Write-Log 'http_error' ([ordered]@{
                status = 500; method = $(if ($hd) { [string]$hd.method } else { '' })
                path = $(if ($hd) { ([string]$hd.target -split '\?')[0] } else { '' }); error = $msg; ip = (Get-Ip $c.client)
            })
            $done = $true
        }
        if ($done) {
            if ($c.sse) { [void]$sse.Add($c.client) } else { try { $c.client.Close() } catch { } }
            $clients.Remove($c)
        }
    }
    if (([DateTime]::UtcNow - $lastPing).TotalSeconds -gt 15) { Send-Event ''; $lastPing = [DateTime]::UtcNow }   # keep-alive, drops dead ones
    if (-not $busy) { Start-Sleep -Milliseconds 5 }
}
