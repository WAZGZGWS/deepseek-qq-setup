@echo off
setlocal
chcp 65001 >nul
rem stack-doctor: full-stack health check (NapCat / bridge / DSH / workers)
rem Run it from a scheduled task every 2 minutes; it exits immediately.
cd /d "%~dp0"
node "%~dp0stack-doctor.mjs"
exit /b 0