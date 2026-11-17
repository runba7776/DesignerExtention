@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\..\native\Register.ps1" -Register
pause
