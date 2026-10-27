@echo off
setlocal
chcp 65001 >nul
rem like-card: like the owner's QQ profile card once a day (pure API, zero tokens)
cd /d "%~dp0"
node "%~dp0like-card.mjs"
exit /b 0