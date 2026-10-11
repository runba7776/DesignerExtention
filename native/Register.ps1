[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
    [Parameter(ParameterSetName = 'Register')][switch]$Register,
    [Parameter(Mandatory = $true, ParameterSetName = 'Unregister')][switch]$Unregister
)
$ErrorActionPreference = 'Stop'
$addinGuid = '{EA8E8197-C2D4-4530-985C-F62677DAF6AC}'
$addinProgId = 'DesignerExtension.Connect'
$dllPath = Join-Path $PSScriptRoot 'bin/DesignerExtension.AddIn.dll'
$registryViews = @([Microsoft.Win32.RegistryView]::Registry32)
if ([Environment]::Is64BitOperatingSystem) { $registryViews += [Microsoft.Win32.RegistryView]::Registry64 }
if (-not $Unregister) {
    if (-not (Test-Path -LiteralPath $dllPath)) { throw '先に native/Build-Native.ps1 を実行してください。' }
    $assemblyName = [Reflection.AssemblyName]::GetAssemblyName($dllPath)
    $codeBase = ([Uri]([IO.Path]::GetFullPath($dllPath))).AbsoluteUri
}

foreach ($registryView in $registryViews) {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $registryView)
    try {
        $classPath = "Software\Classes\CLSID\$addinGuid"
        $progIdPath = "Software\Classes\$addinProgId"
        $officePath = "Software\Microsoft\Office\PowerPoint\Addins\$addinProgId"
        if ($Unregister) {
            # These three literal identities belong exclusively to this add-in.
            $baseKey.DeleteSubKeyTree($officePath, $false)
            $baseKey.DeleteSubKeyTree($progIdPath, $false)
            $baseKey.DeleteSubKeyTree($classPath, $false)
            continue
        }
        $classKey = $baseKey.CreateSubKey($classPath)
        try { $classKey.SetValue('', 'DesignerExtension.Native.Connect') } finally { $classKey.Dispose() }
        foreach ($suffix in @('InprocServer32', "InprocServer32\$($assemblyName.Version)")) {
            $serverKey = $baseKey.CreateSubKey("$classPath\$suffix")
            try {
                if ($suffix -eq 'InprocServer32') {
                    $serverKey.SetValue('', 'mscoree.dll')
                    $serverKey.SetValue('ThreadingModel', 'Both')
                }
                $serverKey.SetValue('Class', 'DesignerExtension.Native.Connect')
                $serverKey.SetValue('Assembly', $assemblyName.FullName)
                $serverKey.SetValue('RuntimeVersion', 'v4.0.30319')
                $serverKey.SetValue('CodeBase', $codeBase)
            } finally { $serverKey.Dispose() }
        }
        $progKey = $baseKey.CreateSubKey("$classPath\ProgId")
        try { $progKey.SetValue('', $addinProgId) } finally { $progKey.Dispose() }
        $category = $baseKey.CreateSubKey("$classPath\Implemented Categories\{62C8FE65-4EBB-45e7-B440-6E39B2CDBF29}")
        $category.Dispose()
        $progKey = $baseKey.CreateSubKey($progIdPath)
        try { $progKey.SetValue('', 'Designer Extention') } finally { $progKey.Dispose() }
        $idKey = $baseKey.CreateSubKey("$progIdPath\CLSID")
        try { $idKey.SetValue('', $addinGuid) } finally { $idKey.Dispose() }
        $officeKey = $baseKey.CreateSubKey($officePath)
        try {
            $officeKey.SetValue('FriendlyName', 'Designer Extention')
            $officeKey.SetValue('Description', '資料と指示から編集可能なスライドを作成します。')
            $officeKey.SetValue('LoadBehavior', 3, [Microsoft.Win32.RegistryValueKind]::DWord)
            # OnConnection performs no UI or network work, including when PowerPoint
            # is started by the renderer through Automation.
            $officeKey.SetValue('CommandLineSafe', 1, [Microsoft.Win32.RegistryValueKind]::DWord)
        } finally { $officeKey.Dispose() }
    } finally { $baseKey.Dispose() }
}

# Task pane (Office web add-in). The WEF\Developer value is the documented
# per-user sideload used by Office's own dev tools: PowerPoint loads the manifest
# at startup and shows its ribbon button without "Upload My Add-in".
$manifestPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\Designer-Extention-TaskPane.xml'))
$developerKeyPath = 'Software\Microsoft\Office\16.0\WEF\Developer'
$manifestId = ([xml](Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8)).OfficeApp.Id
$developerKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($developerKeyPath)
try {
    if ($Unregister) { $developerKey.DeleteValue($manifestId, $false) }
    else { $developerKey.SetValue($manifestId, $manifestPath, [Microsoft.Win32.RegistryValueKind]::String) }
} finally { $developerKey.Dispose() }

# PowerPoint caches per identity whether any registry add-in exists
# (PowerPoint_<identity>_HasRegistryAddin). Mark it so a value cached as 0 before
# this registration does not hide the WEF\Developer catalog.
if (-not $Unregister) {
    $wefKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Office\16.0\WEF', $true)
    if ($wefKey) {
        try {
            foreach ($name in $wefKey.GetValueNames() | Where-Object { $_ -like 'PowerPoint_*_HasRegistryAddin' }) {
                $wefKey.SetValue($name, 1, [Microsoft.Win32.RegistryValueKind]::DWord)
            }
        } finally { $wefKey.Dispose() }
    }
}

# A registry-sideloaded add-in shows its ribbon button only after it has been
# opened once. This starter deck references the sideloaded add-in, so opening it
# shows the right-side pane immediately (same mechanism as Office's dev tools).
$starterPath = Join-Path (Split-Path $manifestPath) 'Designer-Extention-Start.pptx'
if ($Unregister) { Remove-Item -LiteralPath $starterPath -Force -ErrorAction SilentlyContinue }
else {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $manifestVersion = ([xml](Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8)).OfficeApp.Version
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'templates\TaskPaneStarter.pptx') -Destination $starterPath -Force
    $archive = [IO.Compression.ZipFile]::Open($starterPath, [IO.Compression.ZipArchiveMode]::Update)
    try {
        $entry = $archive.GetEntry('ppt/webextensions/webextension.xml')
        $reader = [IO.StreamReader]::new($entry.Open()); $xml = $reader.ReadToEnd(); $reader.Dispose()
        $xml = $xml.Replace('00000000-0000-0000-0000-000000000000', $manifestId).Replace('version="1.0.0.0"', "version=`"$manifestVersion`"")
        $entry.Delete()
        $writer = [IO.StreamWriter]::new($archive.CreateEntry('ppt/webextensions/webextension.xml').Open(), [Text.UTF8Encoding]::new($false))
        $writer.Write($xml); $writer.Dispose()
    } finally { $archive.Dispose() }
}

if ($Unregister) { Write-Output 'Designer Extention の現在のユーザー向け登録（リボンと右側ペイン）を解除しました。' }
else { Write-Output 'Designer Extention を現在のユーザーに登録しました。PowerPointを閉じてから Designer-Extention-Start.pptx を開くと、右側に作成ペインが表示されます。' }
