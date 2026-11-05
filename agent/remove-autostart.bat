@echo off
title Skill Workbench - Remove Auto Start
echo Removing the startup shortcut...
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\SkillWorkbench-Agent.lnk"
if exist "%LNK%" (
  del "%LNK%"
  echo [OK] Removed: %LNK%
) else (
  echo [OK] Nothing to remove - auto start was not enabled.
)
echo.
echo Note: a running agent is not affected. Close its window to stop it.
echo.
pause
