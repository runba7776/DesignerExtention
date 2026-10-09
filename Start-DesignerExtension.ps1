param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'runtime'
$statePath = Join-Path $runtimeDir 'server.json'
function Get-AvailableDesignerPort {
  $preferredPort = 4317
  if ($env:DESIGNER_PORT -match '^\d+$') {
    $configuredPort = [int]$env:DESIGNER_PORT
    if ($configuredPort -ge 1024 -and $configuredPort -le 65535 -and $configuredPort -ne 4318) { $preferredPort = $configuredPort }
  }
  $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $preferredPort)
  $preferredAvailable = $false
  try { $probe.Start(); $preferredAvailable = $true } catch { $preferredAvailable = $false } finally { try { $probe.Stop() } catch { } }
  if ($preferredAvailable) { return $preferredPort }

  for ($attempt = 0; $attempt -lt 5; $attempt++) {
    $probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    try { $probe.Start(); $candidate = [int]$probe.LocalEndpoint.Port } finally { $probe.Stop() }
    if ($candidate -ne 4318) { Write-Host "Port $preferredPort is unavailable; using local port $candidate."; return $candidate }
  }
  throw 'Could not find an available local port for Designer Extention.'
}
function Get-NodeExecutable {
  $command = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  # PowerPoint and Explorer may keep a PATH from before Node.js was installed.
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  foreach ($directory in (($machinePath + ';' + $userPath) -split ';') + @((Join-Path $env:ProgramFiles 'nodejs'))) {
    if (-not $directory) { continue }
    $candidate = Join-Path $directory 'node.exe'
    if (Test-Path -LiteralPath $candidate) { return $candidate }
  }
  throw 'Node.js was not found. Install Node.js 22 or later (https://nodejs.org/) and run Setup-DesignerExtension.cmd again.'
}
# PowerPoint (COM add-in), the ribbon button and a double-click can all start
# the app at the same time. Serialize them so only one server is launched.
$startMutex = [Threading.Mutex]::new($false, 'Local\DesignerExtensionStart')
$ownsStartMutex = $false
try { $ownsStartMutex = $startMutex.WaitOne(90000) } catch [Threading.AbandonedMutexException] { $ownsStartMutex = $true }
try {
$serverReady = $false
if (Test-Path -LiteralPath $statePath) {
  try {
    $serverState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $existingProcess = Get-Process -Id $serverState.pid -ErrorAction Stop
    $response = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $serverState.port + '/api/health') -UseBasicParsing -TimeoutSec 2
    $serverReady = $response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).app -eq 'Designer Extention'
  } catch { $serverReady = $false }
}
if (-not $serverReady) {
  $nodeExecutable = Get-NodeExecutable
  $tsxEntry = Join-Path $projectRoot 'node_modules/tsx/dist/cli.mjs'
  if (-not (Test-Path -LiteralPath $tsxEntry)) { throw 'Dependencies are missing. Run Setup-DesignerExtension.ps1 first.' }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist/web/index.html'))) { throw 'The app has not been built. Run Setup-DesignerExtension.ps1 first.' }
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $selectedPort = Get-AvailableDesignerPort
  $nodeArguments = @('"' + $tsxEntry + '"', '"' + (Join-Path $projectRoot 'server/index.ts') + '"')
  $previousDesignerPort = [Environment]::GetEnvironmentVariable('DESIGNER_PORT', 'Process')
  try {
    $env:DESIGNER_PORT = [string]$selectedPort
    $process = Start-Process -FilePath $nodeExecutable -ArgumentList $nodeArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'server.log') -RedirectStandardError (Join-Path $runtimeDir 'server-error.log') -PassThru
  } finally {
    if ($null -eq $previousDesignerPort) { Remove-Item Env:\DESIGNER_PORT -ErrorAction SilentlyContinue } else { $env:DESIGNER_PORT = $previousDesignerPort }
  }
  # The first start after an update compiles TypeScript and can take a while.
  for ($attempt = 0; $attempt -lt 240; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (Test-Path -LiteralPath $statePath) {
      try {
        $serverState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $response = Invoke-WebRequest -Uri ('http://127.0.0.1:' + $serverState.port + '/api/health') -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200 -and ($response.Content | ConvertFrom-Json).app -eq 'Designer Extention') { $serverReady = $true; break }
      } catch { }
    }
    if ($process.HasExited) { break }
  }
}
} finally { if ($ownsStartMutex) { $startMutex.ReleaseMutex() }; $startMutex.Dispose() }
if (-not $serverReady) { throw 'Could not start Designer Extention. See runtime/server-error.log.' }
if (-not $NoOpen) { Start-Process -FilePath $serverState.url -WindowStyle Hidden }
Write-Host "Designer Extention is running on local port $($serverState.port)."
Write-Host 'PowerPoint task pane endpoint: https://localhost:4318/taskpane.html?taskpane=1'
