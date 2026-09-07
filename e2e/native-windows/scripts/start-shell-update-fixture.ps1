param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$folder=Join-Path $Root 'shell-update-fixture'
$python=Join-Path $Root '.venv\Scripts\python.exe'
$script=Join-Path $PSScriptRoot 'shell-update-fixture.py'
if(-not (Test-Path (Join-Path $folder 'metadata.json'))){
  & $python $script --root $Root --prepare
  if($LASTEXITCODE){throw 'Shell fixture preparation failed'}
}
$metadata=Get-Content (Join-Path $folder 'metadata.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$certPath=Join-Path $folder 'ca.cer'
$certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
if($certificate.Thumbprint.ToLowerInvariant() -ne $metadata.caThumbprint -or $certificate.NotAfter -le (Get-Date)){throw 'Shell fixture certificate is invalid or expired'}
$listeners=@(Get-NetTCPConnection -LocalPort 19446 -State Listen -ErrorAction SilentlyContinue)
if($listeners.Count){
  $record=Get-Content (Join-Path $folder 'process.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach($socket in $listeners){
    $owner=Get-CimInstance Win32_Process -Filter "ProcessId = $($socket.OwningProcess)"
    if(($owner.ProcessId -ne $record.pid -and $owner.ParentProcessId -ne $record.pid) -or -not $owner.CommandLine.Contains($record.script)){throw 'Shell update fixture port belongs to another process'}
  }
  if(-not (Invoke-RestMethod http://127.0.0.1:19446/health -TimeoutSec 5).ready){throw 'The owned shell update fixture is not healthy'}
  Write-Output 'Owned two-host signed shell fixture is already ready'
  exit 0
}
& icacls.exe (Join-Path $Root 'secrets\shell-update-fixture') /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if($LASTEXITCODE){throw 'Cannot restrict fixture private keys'}
& certutil.exe -f -addstore Root $certPath | Out-Null
if($LASTEXITCODE){throw 'Cannot trust the two-host test certificate'}
$launch=Join-Path $PSScriptRoot 'launch-shell-update-fixture.ps1'
$action=New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launch`" -Root `"$Root`""
$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'HermesNativeE2E-ShellUpdates' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'HermesNativeE2E-ShellUpdates'
$deadline=(Get-Date).AddSeconds(20)
do {
  try {if((Invoke-RestMethod http://127.0.0.1:19446/health -TimeoutSec 2).ready){break}} catch {if((Get-Date) -gt $deadline){throw};Start-Sleep -Milliseconds 250}
} while($true)
Write-Output 'Two-host signed shell fixture ready on loopback 19446'
