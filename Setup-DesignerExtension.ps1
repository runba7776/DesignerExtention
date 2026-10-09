[CmdletBinding()]
param([switch]$SkipRegister, [switch]$SkipTaskPane, [switch]$NoStart)
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
  & npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  # Ensure the official Claude Code platform binary is placed even when npm lifecycle scripts are disabled.
  & node (Join-Path $PSScriptRoot 'node_modules/@anthropic-ai/claude-code/install.cjs')
  if ($LASTEXITCODE -ne 0) { throw 'Claude Code runtime setup failed.' }
  & npm.cmd run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'Type check failed.' }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
  if (-not $SkipTaskPane) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Setup-Office-TaskPane.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'PowerPoint task pane setup failed.' }
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'native/Build-Native.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'PowerPoint adapter build failed.' }
  # Registers the ribbon/auto-start COM add-in and sideloads the task pane
  # manifest for the current Windows user only (no administrator rights).
  if (-not $SkipRegister) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'native/Register.ps1') -Register
    if ($LASTEXITCODE -ne 0) { throw 'PowerPoint add-in registration failed.' }
  }
  if (-not $NoStart) {
    # Restart so an update takes effect; saved presentations are kept.
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Stop-DesignerExtension.ps1') | Out-Null
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'Start-DesignerExtension.ps1') -NoOpen
    if ($LASTEXITCODE -ne 0) { throw 'Designer Extention could not start. See runtime/server-error.log.' }
  }
  Write-Host 'Ready. Restart PowerPoint and choose Home > Slide creation (スライド作成). The local app starts automatically with PowerPoint.'
} finally { Pop-Location }
