<#
.SYNOPSIS
安装 Windows 热更新测试基线并保留用户数据。
.EXAMPLE
./scripts/windows-hot-update-prepare.ps1 -InstallerPath ./desktop-setup.exe -WindowsSigning none -ExpectedVersion 0.9.0 -RuntimeRoot C:\hermes-test\runtime -AppExe C:\hermes-test\desktop.exe
.EXAMPLE
./scripts/windows-hot-update-prepare.ps1 -InstallerPath ./prototype-setup.exe -WindowsSigning authenticode -TrustTestCertificate -CertificatePath ./staging-publisher.cer -ExpectedVersion 0.9.1-prototype.1 -RuntimeRoot C:\hermes-test\runtime -AppExe C:\hermes-test\desktop.exe
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [string]$CertificatePath,
  [ValidateSet("none", "authenticode")][string]$WindowsSigning = "none",
  [switch]$TrustTestCertificate,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$AppExe,
  [string]$ExistingRuntimeRoot,
  [string]$SentinelValue = "hermes-hot-update-preservation-v1",
  [switch]$ClearPending
)

$ErrorActionPreference = "Stop"
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)
$application = [IO.Path]::GetFullPath($AppExe)
$runtimeRoots = @($runtime)
if ($ExistingRuntimeRoot) {
  $runtimeRoots += [IO.Path]::GetFullPath($ExistingRuntimeRoot)
}
$stoppedProcesses = @()

if ($CertificatePath -or $TrustTestCertificate) {
  if (-not $TrustTestCertificate -or -not $CertificatePath -or $WindowsSigning -ne "authenticode") {
    throw "测试证书仅允许在 authenticode 模式下显式指定 -TrustTestCertificate 与 -CertificatePath"
  }
  $certificate = (Resolve-Path -LiteralPath $CertificatePath).Path
  Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\LocalMachine\Root -Confirm:$false | Out-Null
  Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\CurrentUser\TrustedPeople | Out-Null
  Import-Certificate -FilePath $certificate -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
}
$installerSignature = Get-AuthenticodeSignature -FilePath $installer
$expectedSignature = if ($WindowsSigning -eq "authenticode") { "Valid" } else { "NotSigned" }
if ($installerSignature.Status.ToString() -ne $expectedSignature) {
  throw "baseline Authenticode: $($installerSignature.Status), expected $expectedSignature"
}

Get-Process | ForEach-Object {
  try {
    $underRuntime = $false
    foreach ($root in $runtimeRoots) {
      $prefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
      if ($_.Path -and $_.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        $underRuntime = $true
        break
      }
    }
    if ($_.Path -eq $application -or $underRuntime) {
      $stoppedProcesses += [ordered]@{ pid = $_.Id; path = $_.Path }
      Stop-Process -Id $_.Id -Force
    }
  } catch {
    Write-Verbose "Skipping unrelated process with inaccessible Path: $($_.Exception.Message)"
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
if ($install.ExitCode -ne 0) { throw "baseline NSIS install failed: $($install.ExitCode)" }
if (-not (Test-Path -LiteralPath $application)) { throw "baseline EXE missing: $application" }

$installedVersion = (Get-Item -LiteralPath $application).VersionInfo.ProductVersion
if ($installedVersion -ne $ExpectedVersion) {
  throw "baseline ProductVersion mismatch: expected=$ExpectedVersion actual=$installedVersion"
}

$sentinelDirectory = Join-Path $runtime "test-evidence"
$sentinel = Join-Path $sentinelDirectory "preservation-sentinel.txt"
New-Item -ItemType Directory -Force -Path $sentinelDirectory | Out-Null
if (Test-Path -LiteralPath $sentinel) {
  $existing = [IO.File]::ReadAllText($sentinel)
  if ($existing -ne $SentinelValue) { throw "test sentinel exists with unexpected content" }
} else {
  [IO.File]::WriteAllText($sentinel, $SentinelValue)
}

[ordered]@{
  ok = $true
  installer = $installer
  windowsSigning = $WindowsSigning
  testCertificateTrusted = [bool]$TrustTestCertificate
  installerSignature = $installerSignature.Status.ToString()
  installedExe = $application
  installedVersion = $installedVersion
  runtimeRoot = $runtime
  existingRuntimeRoot = $ExistingRuntimeRoot
  stoppedProcesses = $stoppedProcesses
  sentinel = $sentinel
  sentinelValue = $SentinelValue
  pendingCleared = [bool]$ClearPending
} | ConvertTo-Json -Depth 4
