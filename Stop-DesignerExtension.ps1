param()
$ErrorActionPreference = 'Stop'
$statePath = Join-Path $PSScriptRoot 'runtime/server.json'
if (-not (Test-Path -LiteralPath $statePath)) { Write-Output 'Designer Extention is not running.'; exit 0 }
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
$serverPid = [int]$state.pid
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid"
if (-not $serverProcess) { Write-Output 'Designer Extention is already stopped.'; exit 0 }
$entryPath = Join-Path $PSScriptRoot 'server/index.ts'
$normalizedCommand = ([string]$serverProcess.CommandLine).Replace('\','/')
$isOurEntry = $normalizedCommand.IndexOf($entryPath.Replace('\','/'), [StringComparison]::OrdinalIgnoreCase) -ge 0
# A server started with a relative path is still ours when it owns the recorded port.
$ownsPort = $false
try { $ownsPort = [bool](Get-NetTCPConnection -LocalPort ([int]$state.port) -State Listen -ErrorAction Stop | Where-Object OwningProcess -eq $serverPid) } catch { }
if ($serverProcess.Name -ne 'node.exe' -or -not ($isOurEntry -or ($ownsPort -and $normalizedCommand -match 'server/index\.ts'))) {
    # The PID was reused by another program, so this app is not running. Never stop it.
    Write-Output 'Designer Extention is not running (the recorded process belongs to another program). No process was stopped.'
    exit 0
}
Stop-Process -Id $serverPid
Write-Output 'Designer Extention stopped. In-memory documents, conversation and API keys are cleared. Saved PowerPoint files are retained.'
