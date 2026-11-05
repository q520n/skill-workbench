@echo off
chcp 65001 >nul
title Skill Workbench - CLI Sign-in
setlocal

rem === Self-contained: absolute paths, works from ANY folder (Desktop included) ===
set "WB_NODE=C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
set "WB_AGENT=G:\workbuddy\2026-11-04-17-47-27\skill-workbench\agent"
set "WB_CLI=G:\workbuddy\2026-11-04-17-47-27\skill-workbench\local\cli\node_modules\@tencent-ai\codebuddy-code\bin\codebuddy"
set "WB_WORKDIR=G:\workbuddy\2026-11-04-17-47-27"
rem Full CLI has a real TUI; do NOT force the desktop's lite bundle.
set "CODEBUDDY_FORCE_LITE_WB_BUNDLE="
set "CODEBUDDY_SKIP_GIT_BASH_CHECK=1"

if not exist "%WB_NODE%" goto :nonode
if not exist "%WB_CLI%" goto :nocli
if not exist "%WB_AGENT%\login-cli.js" goto :noagent

cd /d "%WB_AGENT%"
echo [preflight] node : %WB_NODE%
echo [preflight] cli  : %WB_CLI%
echo [preflight] dir  : %CD%
echo.

rem Auto-type /login into this real console after the TUI has started.
rem Manual fallback: just type /login and press Enter yourself.
if "%WB_SKIP_AUTOTYPE%"=="1" goto :noauto
if exist "%WB_AGENT%\autotype-login.vbs" start "" /min wscript.exe "%WB_AGENT%\autotype-login.vbs"
:noauto

"%WB_NODE%" "%WB_AGENT%\login-cli.js" --intro
rem Use the workspace root so the CLI does not show a first-run trust prompt.
cd /d "%WB_WORKDIR%"
"%WB_NODE%" "%WB_CLI%" --port 0 --permission-mode dontAsk
cd /d "%WB_AGENT%"
echo.
echo [CLI exited] code=%ERRORLEVEL% - Verifying sign-in state ...
"%WB_NODE%" "%WB_AGENT%\login-cli.js" --check
echo.
echo Done. You can close this window now.
pause
exit /b 0

:nonode
echo [X] Node runtime not found: %WB_NODE%
echo     Edit WB_NODE at the top of this file.
echo.
pause
exit /b 1

:nocli
echo [X] CLI not found: %WB_CLI%
echo     Edit WB_CLI at the top of this file.
echo.
pause
exit /b 1

:noagent
echo [X] Agent folder not found: %WB_AGENT%
echo     Edit WB_AGENT at the top of this file.
echo.
pause
exit /b 1
