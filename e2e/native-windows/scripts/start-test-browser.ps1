param([string]$Root='C:\HermesE2E',[int]$Port=19230)
$ErrorActionPreference='Stop'
$chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'
if(-not (Test-Path $chrome)){throw 'Installed Google Chrome is required for the real Dashboard browser workflow'}
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
if($listeners.Count){
  $owners=@($listeners.OwningProcess | Select-Object -Unique)
  if($owners.Count -ne 1){throw 'Browser test port has multiple process owners'}
  $owner=Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
  if($owner.ExecutablePath -ne $chrome -or -not $owner.CommandLine.Contains((Join-Path $Root 'browser-profile')) -or -not $owner.CommandLine.Contains("--remote-debugging-port=$Port")){throw 'Browser test port belongs to another process; inspect before starting'}
  $version=Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 5
  $version | Select-Object Browser,'Protocol-Version' | ConvertTo-Json
  exit 0
}
$arguments="--user-data-dir=`"$(Join-Path $Root 'browser-profile')`" --remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port --no-first-run --no-default-browser-check about:blank"
$action=New-ScheduledTaskAction -Execute $chrome -Argument $arguments
$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName HermesNativeE2E-Browser -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName HermesNativeE2E-Browser
$deadline=(Get-Date).AddSeconds(30)
do {
  try { $version=Invoke-RestMethod "http://127.0.0.1:$Port/json/version"; break } catch { Start-Sleep -Milliseconds 250 }
} while((Get-Date) -lt $deadline)
if(-not $version){throw 'Interactive test browser did not start'}
$version | Select-Object Browser,'Protocol-Version' | ConvertTo-Json
