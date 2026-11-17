@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\Start-DesignerExtension.ps1"
if errorlevel 1 pause
