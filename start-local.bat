@echo off
chcp 65001 >nul
title Skill Workbench - Local Mode
setlocal

rem === Self-contained local launcher: page + executor on THIS machine ===
set "WB_NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "WB_ROOT=G:\workbuddy\2026-11-04-17-47-27\skill-workbench"

if not exist "%WB_NODE%" goto :nonode
if not exist "%WB_ROOT%\local\start.js" goto :noroot

cd /d "%WB_ROOT%"
echo Starting local workbench ... browser will open automatically.
echo.
"%WB_NODE%" "%WB_ROOT%\local\start.js"
echo.
echo [stopped] Local workbench is no longer running.
pause
exit /b 0

:nonode
echo [X] Node runtime not found: %WB_NODE%
echo     Edit WB_NODE at the top of this file.
pause
exit /b 1

:noroot
echo [X] Workbench folder not found: %WB_ROOT%
echo     Edit WB_ROOT at the top of this file.
pause
exit /b 1
