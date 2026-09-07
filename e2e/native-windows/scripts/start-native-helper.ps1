param([string]$Root='C:\HermesE2E',[switch]$Restart)
$ErrorActionPreference='Stop'
$name='HermesNativeE2E-UIA'
$existing=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if($existing -and $existing.State -eq 'Running'){
  if($Restart){Stop-ScheduledTask -TaskName $name}
  else{Write-Output 'Native UI helper is already running';exit 0}
}
$script=Join-Path $PSScriptRoot 'native-helper.ps1'
$args="-STA -NoProfile -ExecutionPolicy Bypass -File `"$script`" -Root `"$Root`""
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $args
$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12)
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name
