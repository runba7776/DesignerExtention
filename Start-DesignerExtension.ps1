param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
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
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/tsx/dist/cli.mjs'))) { throw 'Dependencies are missing. Run Setup-DesignerExtension.ps1 first.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'dist/web/index.html'))) { throw 'The app has not been built. Run Setup-DesignerExtension.ps1 first.' }
# The same launcher PowerPoint's add-in uses: it starts the server once and prints its address.
$url = & (Get-NodeExecutable) (Join-Path $PSScriptRoot 'scripts/launch.mjs')
if ($LASTEXITCODE -ne 0 -or -not $url) { throw 'Could not start Designer Extention. See runtime/server-error.log.' }
if (-not $NoOpen) { Start-Process -FilePath $url -WindowStyle Hidden }
Write-Host "Designer Extention is running on $(([Uri]$url).GetLeftPart('Authority'))."
Write-Host 'PowerPoint task pane endpoint: https://localhost:4318/taskpane.html?taskpane=1'
