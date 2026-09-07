param(
  [string]$Root='C:\HermesE2E',
  [string]$AppExe='C:\HermesV090\Desktop App\hermes-agent-cn-desktop.exe',
  [int]$CdpPort=19229,
  [int]$ApiPort=9120
)
$ErrorActionPreference='Stop'
$taskName='HermesNativeE2E'
if(-not (Test-Path $AppExe)){throw "Application not found: $AppExe"}
if(-not (Test-Path (Join-Path $Root 'secrets\deepseek.env'))){throw 'Private DeepSeek credentials file is missing'}
& icacls.exe (Join-Path $Root 'secrets') /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if($LASTEXITCODE){throw 'Cannot set test credential directory permissions'}
& icacls.exe (Join-Path $Root 'secrets\deepseek.env') /inheritance:r /grant:r "${env:USERNAME}:F" 'SYSTEM:F' | Out-Null
if($LASTEXITCODE){throw 'Cannot set test credential file permissions'}
$baseline=Get-Content (Join-Path $PSScriptRoot '..\baseline.json') -Raw | ConvertFrom-Json
$actual=(Get-FileHash $AppExe -Algorithm SHA256).Hash.ToLowerInvariant()
if($actual -ne $baseline.installedDesktopSha256){throw "Desktop artifact differs from baseline: $actual"}
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $ApiPort,$CdpPort })
if($listeners.Count){throw "Test ports are occupied; inspect the owning processes before starting: $($listeners | ConvertTo-Json -Compress)"}
$launch=Join-Path $PSScriptRoot 'launch.ps1'
$arguments="-NoProfile -ExecutionPolicy Bypass -File `"$launch`" -Root `"$Root`" -AppExe `"$AppExe`" -CdpPort $CdpPort -ApiPort $ApiPort"
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$env:HERMES_E2E_CDP="http://127.0.0.1:$CdpPort"
& 'C:\Program Files\nodejs\node.exe' (Join-Path $PSScriptRoot 'wait-ready.mjs')
if($LASTEXITCODE){throw 'Desktop did not become ready; inspect launcher and Core logs'}
& (Join-Path $PSScriptRoot 'start-native-helper.ps1') -Root $Root
@{task=$taskName;appSha256=$actual;cdp="http://127.0.0.1:$CdpPort";runtimeRoot=(Join-Path $Root 'runtime')} | ConvertTo-Json
