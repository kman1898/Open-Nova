@echo off
rem Windows: double-click to start Open Nova. Keep this window open while you work.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (py -3 opennova.py %*) else (python opennova.py %*)
if errorlevel 1 pause
