[CmdletBinding()]
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$runtimeDirectory = Join-Path $projectRoot 'runtime/office-taskpane'
$thumbprintPath = Join-Path $runtimeDirectory 'certificate-thumbprint.txt'
$certificatePath = Join-Path $runtimeDirectory 'localhost.cer'
$pfxPath = Join-Path $runtimeDirectory 'localhost.pfx'
$passphrasePath = Join-Path $runtimeDirectory 'passphrase.txt'
$runtimeRoot = Join-Path $projectRoot 'runtime'
$expectedRuntimeDirectory = [IO.Path]::GetFullPath((Join-Path $runtimeRoot 'office-taskpane'))
if (-not [string]::Equals([IO.Path]::GetFullPath($runtimeDirectory), $expectedRuntimeDirectory, [StringComparison]::OrdinalIgnoreCase)) { throw 'タスクペインの保存先がプロジェクト内ではありません。' }
foreach ($directoryPath in @($runtimeRoot,$runtimeDirectory)) {
  if (Test-Path -LiteralPath $directoryPath) {
    $item = Get-Item -LiteralPath $directoryPath -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'タスクペインの保存先にリンクまたは通常ファイルがあります。処理を停止しました。' }
  }
}
function Assert-TaskPaneFiles {
  foreach ($filePath in @($thumbprintPath,$certificatePath,$pfxPath,$passphrasePath)) {
    if (Test-Path -LiteralPath $filePath) {
      $item = Get-Item -LiteralPath $filePath -Force
      if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'タスクペイン証明書ファイルがリンクまたはフォルダーです。処理を停止しました。' }
    }
  }
}
Assert-TaskPaneFiles

if ($Remove) {
  if (Test-Path -LiteralPath $thumbprintPath) {
    $thumbprint = (Get-Content -LiteralPath $thumbprintPath -Raw).Trim()
    if ($thumbprint -match '^[A-Fa-f0-9]{40}$') {
      Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $thumbprint | Remove-Item -ErrorAction SilentlyContinue
      Get-ChildItem Cert:\CurrentUser\My | Where-Object Thumbprint -eq $thumbprint | Remove-Item -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath @($pfxPath,$certificatePath,$passphrasePath,$thumbprintPath) -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $runtimeDirectory -Force -ErrorAction SilentlyContinue
  Write-Host 'Designer ExtentionのPowerPointタスクペイン用証明書と秘密鍵を削除しました。'
  exit 0
}

New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
& icacls.exe $runtimeDirectory '/reset' '/Q' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'タスクペイン用フォルダーの権限を初期化できませんでした。' }
& icacls.exe $runtimeDirectory '/inheritance:r' '/Q' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'タスクペイン用フォルダーの継承権限を外せませんでした。' }
& icacls.exe $runtimeDirectory '/grant:r' "*$($userSid.Value):(OI)(CI)F" "*$($systemSid.Value):(OI)(CI)F" '/Q' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'タスクペイン用フォルダーを現在のユーザーとSYSTEMだけに制限できませんでした。' }
$certificate = $null
if ((Test-Path -LiteralPath $thumbprintPath) -and (Test-Path -LiteralPath $pfxPath) -and (Test-Path -LiteralPath $certificatePath) -and (Test-Path -LiteralPath $passphrasePath)) {
  $thumbprint = (Get-Content -LiteralPath $thumbprintPath -Raw).Trim()
  $certificate = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $thumbprint -and $_.NotAfter -gt (Get-Date).AddDays(14) } | Select-Object -First 1
}
if (-not $certificate) {
  if (Test-Path -LiteralPath $thumbprintPath) {
    $oldThumbprint = (Get-Content -LiteralPath $thumbprintPath -Raw).Trim()
    if ($oldThumbprint -match '^[A-Fa-f0-9]{40}$') {
      Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $oldThumbprint | Remove-Item -ErrorAction SilentlyContinue
      Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $oldThumbprint -and $_.FriendlyName -eq 'Designer Extention PowerPoint Task Pane' } | Remove-Item -ErrorAction SilentlyContinue
    }
  }
  Remove-Item -LiteralPath @($pfxPath,$certificatePath,$passphrasePath,$thumbprintPath) -Force -ErrorAction SilentlyContinue
  $certificate = New-SelfSignedCertificate -DnsName 'localhost' -CertStoreLocation Cert:\CurrentUser\My -FriendlyName 'Designer Extention PowerPoint Task Pane' -NotAfter (Get-Date).AddYears(2) -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -Type SSLServerAuthentication -HashAlgorithm SHA256
  $thumbprint = $certificate.Thumbprint
  $randomBytes = New-Object byte[] 32
  $randomGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $randomGenerator.GetBytes($randomBytes)
  $randomGenerator.Dispose()
  $passphrase = [Convert]::ToBase64String($randomBytes)
  $securePassphrase = ConvertTo-SecureString $passphrase -AsPlainText -Force
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassphrase | Out-Null
  Export-Certificate -Cert $certificate -FilePath $certificatePath | Out-Null
  [IO.File]::WriteAllText($passphrasePath, $passphrase, [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText($thumbprintPath, $thumbprint, [Text.Encoding]::ASCII)

}

$trusted = Get-ChildItem Cert:\CurrentUser\Root | Where-Object Thumbprint -eq $certificate.Thumbprint | Select-Object -First 1
if (-not $trusted) {
  $answer = Read-Host 'PowerPointの右側ペインを有効にするため、このPCの現在のWindowsユーザーでlocalhost証明書を信頼しますか？ [Y/N]'
  if ($answer -match '^(Y|YES)$') {
    Import-Certificate -FilePath $certificatePath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
    Write-Host '現在のWindowsユーザーの信頼済みルートに、localhost用証明書を登録しました。'
  } else {
    Write-Warning '証明書は作成しましたが信頼されていません。ブラウザー版は利用できます。右側ペインを使うには、このスクリプトを再実行して証明書を信頼してください。'
  }
}

# Ribbon icons are static files in web/public and are copied by the Vite build.
Write-Host 'PowerPoint task pane certificate is ready.'
