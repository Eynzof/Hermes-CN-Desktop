[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$CertificatePath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$AppExe,
  [string]$SentinelValue = "hermes-hot-update-preservation-v1",
  [switch]$ClearPending
)

$ErrorActionPreference = "Stop"
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$certificate = (Resolve-Path -LiteralPath $CertificatePath).Path
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$application = [IO.Path]::GetFullPath($AppExe)

Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\CurrentUser\TrustedPeople | Out-Null
Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
$installerSignature = Get-AuthenticodeSignature -FilePath $installer
if ($installerSignature.Status -ne "Valid") {
  throw "baseline Authenticode 无效：$($installerSignature.Status)"
}

Get-Process | ForEach-Object {
  try {
    if ($_.Path -eq $application -or ($_.Path -and $_.Path.StartsWith($runtime, [StringComparison]::OrdinalIgnoreCase))) {
      Stop-Process -Id $_.Id -Force
    }
  } catch {
    Write-Verbose "跳过无法读取 Path 的无关系统进程：$($_.Exception.Message)"
  }
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
if ($ClearPending) {
  $pending = Join-Path $runtime "desktop-updater-cache"
  if (Test-Path -LiteralPath $pending) {
    Remove-Item -LiteralPath $pending -Recurse -Force
  }
}

$install = Start-Process -FilePath $installer -ArgumentList "/S" -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "baseline NSIS 安装失败：$($install.ExitCode)" }
if (-not (Test-Path -LiteralPath $application)) { throw "baseline EXE 不存在：$application" }

$installedVersion = (Get-Item -LiteralPath $application).VersionInfo.ProductVersion
if ($installedVersion -ne $ExpectedVersion) {
  throw "baseline ProductVersion 不匹配：expected=$ExpectedVersion actual=$installedVersion"
}

$sentinelDirectory = Join-Path $runtime "test-evidence"
$sentinel = Join-Path $sentinelDirectory "preservation-sentinel.txt"
New-Item -ItemType Directory -Force -Path $sentinelDirectory | Out-Null
if (Test-Path -LiteralPath $sentinel) {
  $existing = [IO.File]::ReadAllText($sentinel)
  if ($existing -ne $SentinelValue) { throw "测试 sentinel 已存在但内容不一致" }
} else {
  [IO.File]::WriteAllText($sentinel, $SentinelValue)
}

[ordered]@{
  ok = $true
  installer = $installer
  installerSignature = $installerSignature.Status.ToString()
  installedExe = $application
  installedVersion = $installedVersion
  runtimeRoot = $runtime
  sentinel = $sentinel
  sentinelValue = $SentinelValue
  pendingCleared = [bool]$ClearPending
} | ConvertTo-Json -Depth 4
