@echo off
chcp 65001 >nul
title Skill Workbench - Check CLI Sign-in
setlocal
set "WB_NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "WB_AGENT=G:\workbuddy\2026-11-04-17-47-27\skill-workbench\agent"
set "CODEBUDDY_FORCE_LITE_WB_BUNDLE="
if not exist "%WB_NODE%" goto :nonode
if not exist "%WB_AGENT%\login-cli.js" goto :noagent
cd /d "%WB_AGENT%"
"%WB_NODE%" "%WB_AGENT%\login-cli.js" --check
echo.
pause
exit /b 0

:nonode
echo [X] Node runtime not found: %WB_NODE%
pause
exit /b 1

:noagent
echo [X] Agent folder not found: %WB_AGENT%
pause
exit /b 1
