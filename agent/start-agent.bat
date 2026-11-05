@echo off
chcp 65001 >nul
title Skill Workbench - Local Agent
setlocal
set "WB_NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "WB_AGENT=G:\workbuddy\2026-11-04-17-47-27\skill-workbench\agent"
rem Full CLI is used; never force the desktop's lite bundle.
set "CODEBUDDY_FORCE_LITE_WB_BUNDLE="
if not exist "%WB_NODE%" goto :nonode
if not exist "%WB_AGENT%\agent.js" goto :noagent
cd /d "%WB_AGENT%"
echo ============================================
echo   Skill Workbench / Local Agent
echo   Keep this window open while colleagues use the hub
echo   Close this window to stop the agent.
echo ============================================
echo.
:loop
"%WB_NODE%" "%WB_AGENT%\agent.js"
echo.
echo [agent exited] restarting in 3s ... close this window to stop.
timeout /t 3 /nobreak >nul
goto loop

:nonode
echo [X] Node runtime not found: %WB_NODE%
pause
exit /b 1

:noagent
echo [X] Agent folder not found: %WB_AGENT%
pause
exit /b 1
