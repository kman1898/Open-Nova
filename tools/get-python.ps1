# get-python.ps1 - Windows, first start without Python: puts Python into <Open Nova folder>\python, so Open Nova runs
# with nothing to install by hand. Called by "Start Open Nova.bat" only when no Python 3.9+ is found.
# The Windows package (make_package.py --python) carries the archive in python-dist\: then nothing is downloaded (a show
# site without internet works); the any-system package fetches it from python.org.
#
# What it takes: python.org's "Windows embeddable package" for this computer (64-bit, ARM64 or 32-bit), about 12 MB,
# checked against the SHA-256 written below before anything is unpacked (the sums python.org lists for that release).
# Nothing is installed on Windows: no installer, no PATH change, no registry, no admin rights. Deleting the python
# folder removes it; the next start fetches it again. A newer release: change $Version and the three sums together
# (python.org/downloads/release/python-<version> lists them) and run the test suite on it (tools/run_tests.py).
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # PowerShell 5's progress bar makes the download many times slower

$Version = '3.14.10'
$Sums = @{
    amd64 = '90905e64a840557d8c1bc4f5b74db3d7ee85e3ffb217611cac1c7813acea4159'
    arm64 = 'bbe116bb1248820359cbf25127ac5c7794ea161869d83686cfbc9a45203ff836'
    win32 = '11a28e8c00a6d8f56b0a6164d52546133a9ed015a5b33e04536917e4fd6e306c'
}

# the computer, not this PowerShell (a 32-bit PowerShell on 64-bit Windows says x86 in PROCESSOR_ARCHITECTURE)
$arch = $env:PROCESSOR_ARCHITEW6432
if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
switch ($arch) { 'AMD64' { $kind = 'amd64' } 'ARM64' { $kind = 'arm64' } default { $kind = 'win32' } }

$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'python'
$work = Join-Path $root 'python-download'
$name = "python-$Version-embed-$kind.zip"
$url = "https://www.python.org/ftp/python/$Version/$name"

try {
    if (Test-Path $work) { Remove-Item -Recurse -Force $work }   # what an interrupted earlier try left
    New-Item -ItemType Directory -Path $work | Out-Null
    $zip = Join-Path $root "python-dist\$name"
    if (Test-Path $zip) {
        Write-Host "Setting up Python $Version ($kind) from this package ..."
    } else {
        $zip = Join-Path $work $name
        Write-Host "Downloading Python $Version ($kind) from python.org ..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip
    }
    $sum = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower()
    if ($sum -ne $Sums[$kind]) { throw "$name isn't the file python.org published (SHA-256 $sum)" }
    $unpacked = Join-Path $work 'python'
    Expand-Archive -Path $zip -DestinationPath $unpacked
    # The package's python3xx._pth keeps a script's own folder off the module path; Open Nova's helper and server import
    # their neighbours (tools\*.py), so it goes: then this Python finds modules exactly like an installed one.
    Get-ChildItem -Path $unpacked -Filter 'python*._pth' | Remove-Item -Force
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Move-Item -Path $unpacked -Destination $dest   # whole or not at all: a half-unpacked folder is never used
    Remove-Item -Recurse -Force $work
    Write-Host "Python $Version is in $dest"
    exit 0
}
catch {
    Write-Host ''
    Write-Host "Couldn't get Python: $($_.Exception.Message)"
    Write-Host 'Check the internet connection and start Open Nova again, or install Python yourself from'
    Write-Host 'https://www.python.org/downloads/ (tick "Add python.exe to PATH") and start again.'
    if (Test-Path $work) { Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue }
    exit 1
}
