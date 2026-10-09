[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$nativeRoot = $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe'
}
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework 4.x のコンパイラが必要です。' }
$bin = Join-Path $nativeRoot 'bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
# Rebuild a binary only when its sources changed. PowerPoint keeps the add-in
# DLL loaded while it runs, so an unconditional rebuild failed during updates.
function Test-NeedsBuild([string]$binary, [string[]]$sources) {
    if (-not (Test-Path -LiteralPath $binary)) { return $true }
    $built = (Get-Item -LiteralPath $binary).LastWriteTimeUtc
    return [bool]($sources | Where-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc -gt $built })
}
function Assert-Writable([string]$binary, [string]$message) {
    if (-not (Test-Path -LiteralPath $binary)) { return }
    try { $stream = [IO.File]::Open($binary, 'Open', 'ReadWrite', 'None'); $stream.Dispose() } catch { throw $message }
}
$rendererSource = Join-Path $nativeRoot 'Renderer.cs'
$rendererBinary = Join-Path $bin 'DesignerExtension.Renderer.exe'
$rendererSources = @($rendererSource, (Join-Path $nativeRoot 'ChartIntegrity.cs'))
if (Test-NeedsBuild $rendererBinary $rendererSources) {
    Assert-Writable $rendererBinary 'The PowerPoint renderer is in use. Wait for slide creation to finish, then run setup again.'
    & $compiler /nologo /optimize+ /target:exe /platform:anycpu /reference:Microsoft.CSharp.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll /reference:System.IO.Compression.dll /reference:System.IO.Compression.FileSystem.dll "/out:$rendererBinary" $rendererSources
    if ($LASTEXITCODE -ne 0) { throw 'PowerPoint renderer build failed.' }
}
$addinSource = Join-Path $nativeRoot 'AddIn.cs'
$addinBinary = Join-Path $bin 'DesignerExtension.AddIn.dll'
if (Test-NeedsBuild $addinBinary @($addinSource)) {
    Assert-Writable $addinBinary 'PowerPoint is using the Designer Extention add-in. Close PowerPoint, then run setup again.'
    & $compiler /nologo /optimize+ /target:library /platform:anycpu /reference:System.Windows.Forms.dll "/out:$addinBinary" $addinSource
    if ($LASTEXITCODE -ne 0) { throw 'PowerPoint add-in build failed.' }
}
Write-Output "Native renderer and add-in built: $bin"
