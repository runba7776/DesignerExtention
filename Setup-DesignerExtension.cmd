@echo off
setlocal
pushd "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Setup-DesignerExtension.ps1"
set "setupExitCode=%ERRORLEVEL%"
popd
if not "%setupExitCode%"=="0" (
  echo.
  echo Setup failed. Read the error above before closing this window.
  pause
  exit /b %setupExitCode%
)
echo.
echo Setup complete. Start Designer Extention with Start-DesignerExtension.cmd.
pause
exit /b 0
