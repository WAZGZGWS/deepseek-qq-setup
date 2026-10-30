@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0set-mail-auth.ps1"
