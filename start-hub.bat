@echo off
chcp 65001 >nul
title Skill Workbench - Hub (local preview)
setlocal
set "WB_NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "WB_HUB=G:\workbuddy\2026-11-04-17-47-27\skill-workbench\hub"
set PORT=7788
set HOST=127.0.0.1
if not exist "%WB_NODE%" goto :nonode
if not exist "%WB_HUB%\server.js" goto :nohub
cd /d "%WB_HUB%"
echo Local preview: http://127.0.0.1:7788
echo.
"%WB_NODE%" "%WB_HUB%\server.js"
echo.
pause
exit /b 0

:nonode
echo [X] Node runtime not found: %WB_NODE%
pause
exit /b 1

:nohub
echo [X] Hub folder not found: %WB_HUB%
pause
exit /b 1
