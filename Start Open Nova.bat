@echo off
rem Windows: double-click to start Open Nova. Keep this window open while you work.
rem No Python on this computer? The first start puts one into this folder (tools\get-python.ps1): nothing to install.
setlocal
title Open Nova
rem Windows 7 / 8.x: the package's Python (3.14) can't run there, and python.org's can't either; say so before anything
rem else. "ver" prints "Microsoft Windows [Version 6.1.7601]" (6.x = Vista to 8.1, 10.0 = Windows 10 and 11)
for /f "delims=" %%v in ('ver') do set "WINVER=%%v"
if defined OPENNOVA_TEST_WINVER set "WINVER=%OPENNOVA_TEST_WINVER%"
echo %WINVER% | findstr /r /c:" [56]\.[0-9]" >nul
if not errorlevel 1 (
  echo Open Nova needs Windows 10 or 11. This computer has an older Windows: %WINVER%
  echo The Python that Open Nova runs on doesn't work there, so it can't start on this computer.
  pause
  exit /b 1
)
rem pushd, not cd: a folder on a network share (\\server\share\...) gets a temporary drive letter, which cd can't do
pushd "%~dp0"
rem a Python set up for something else must not steer ours
set PYTHONHOME=
set PYTHONPATH=

rem opened from inside the zip: Windows runs it from a temporary "...zip\" folder, often without the rest of Open Nova
set "HERE=%~dp0"
set ZIPPED=
if not exist "%~dp0opennova.py" set ZIPPED=1
if /i not "%HERE:.zip\=%"=="%HERE%" set ZIPPED=1
if defined ZIPPED (
  echo Unzip Open Nova first: right-click the zip, Extract All, then double-click "Start Open Nova.bat" in the new folder.
  pause
  popd
  exit /b 1
)

rem which Python: the one in this folder; else the package's own (python-dist, the version tested); else Python 3.9+
rem already on the computer; else fetch one
set PY=
if exist "%~dp0python\python.exe" call :try "%~dp0python\python.exe"
if defined PY goto run
if exist "%~dp0python-dist\*.zip" goto ownpy
call :try py -3
if not defined PY call :try python
if defined PY goto run
echo Open Nova needs Python. Getting it from python.org into this folder (about 12 MB, only this once).
echo Nothing is installed on Windows; it stays in the "python" folder here.
goto getpy
:ownpy
echo Setting up Open Nova's own Python in this folder (only this once, a few seconds).
echo Nothing is installed on Windows; it stays in the "python" folder here.
:getpy
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\get-python.ps1"
if errorlevel 1 (
  pause
  popd
  exit /b 1
)
call :try "%~dp0python\python.exe"
if not defined PY (
  echo The Python in "%~dp0python" doesn't start. Delete that folder and start Open Nova again.
  pause
  popd
  exit /b 1
)
echo.
echo When Windows asks whether Python may use the network: tick BOTH Private and Public networks, then click Allow.
echo Show networks without internet count as Public. Without that Open Nova can't find your processors.
echo.

:run
rem opennova.py keeps a copy of this window's text in the data folder (app\data\logs\console.txt) for Report a problem
%PY% opennova.py %*
set RC=%errorlevel%
if not "%RC%"=="0" pause
popd
exit /b %RC%

rem :try <python command> - PY = that command when it starts and is 3.9+ with lzma (the Microsoft Store's "python"
rem placeholder answers with an error, so it is never picked)
:try
%* -c "import sys, lzma; sys.exit(sys.version_info < (3, 9))" >nul 2>nul
if %errorlevel%==0 set PY=%*
exit /b 0
