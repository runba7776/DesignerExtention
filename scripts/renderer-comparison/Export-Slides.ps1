# Exports each slide of an existing PPTX as a PNG with PowerPoint itself, at the size the native renderer uses
# (1600x900), so the TS (PptxGenJS) file is pictured exactly like the C# one. Opens the file read-only and without a
# window, and never quits PowerPoint or touches the user's own presentations.
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Prefix = 'hosted'
)
$ErrorActionPreference = 'Stop'
$file = (Resolve-Path -LiteralPath $Path).Path
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$app = New-Object -ComObject PowerPoint.Application
# ReadOnly = msoTrue, Untitled = msoFalse, WithWindow = msoFalse
$presentation = $app.Presentations.Open($file, -1, 0, 0)
try {
  for ($i = 1; $i -le $presentation.Slides.Count; $i++) {
    $presentation.Slides.Item($i).Export((Join-Path $Out "$Prefix-$i.png"), 'PNG', 1600, 900)
  }
} finally {
  $presentation.Close()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($app)
}
