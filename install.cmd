@echo off
chcp 65001 >nul
title QQ Bot Stack - one-click install
echo.
echo This will install the ops scripts. A UAC prompt will appear - click Yes.
echo (Admin is only needed for the scheduled task and power settings.)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File','%~dp0install.ps1'"
exit /b 0