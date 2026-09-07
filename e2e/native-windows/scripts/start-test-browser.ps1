param([string]$Root='C:\HermesE2E',[int]$Port=19230)
$ErrorActionPreference='Stop'
$chrome='C:\Program Files\Google\Chrome\Application\chrome.exe'
if(-not (Test-Path $chrome)){throw 'Installed Google Chrome is required for the real Dashboard browser workflow'}
if(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue){throw 'Browser test port is occupied; inspect before starting'}
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
