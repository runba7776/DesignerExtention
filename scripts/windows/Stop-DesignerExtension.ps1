param()
$ErrorActionPreference = 'Stop'
# This script lives in scripts/windows; the app is two folders up.
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$statePath = Join-Path $root 'runtime/server.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'Designer Extension is not running.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$serverPid = [int]$state.pid
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
if (-not $serverProcess) { Write-Output 'Designer Extension is already stopped.'; exit 0 }
$entryPath = Join-Path $root 'server/index.ts'
$normalizedCommand = ([string]$serverProcess.CommandLine).Replace('\','/')
$isOurEntry = $normalizedCommand.IndexOf($entryPath.Replace('\','/'), [StringComparison]::OrdinalIgnoreCase) -ge 0
# A server started with a relative path is still ours when it owns the recorded port.
$ownsPort = $false
try { $ownsPort = [bool](Get-NetTCPConnection -LocalPort ([int]$state.port) -State Listen -ErrorAction Stop | Where-Object OwningProcess -eq $serverPid) } catch { }
if ($serverProcess.Name -ne 'node.exe' -or -not ($isOurEntry -or ($ownsPort -and $normalizedCommand -match 'server/index\.ts'))) {
    # The PID was reused by another program, so this app is not running. Never stop it.
    Write-Output 'Designer Extension is not running (the recorded process belongs to another program). No process was stopped.'
    exit 0
}
Stop-Process -Id $serverPid
Write-Output 'Designer Extension stopped. In-memory documents, conversation and API keys are cleared. Saved PowerPoint files are retained.'
