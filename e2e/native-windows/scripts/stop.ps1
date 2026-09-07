param([string]$Root='C:\HermesE2E',[switch]$Force)
$ErrorActionPreference='Stop'
$record=Join-Path $Root 'reports\desktop-process.json'
if(Test-Path $record) {
  $info=Get-Content $record -Raw | ConvertFrom-Json
  $app=Get-Process -Id $info.pid -ErrorAction SilentlyContinue
  if($app) {
    if($app.Path -ne $info.appExe){throw 'Recorded PID now belongs to another executable; refusing to stop it'}
    if($Force){& taskkill.exe /PID $info.pid /T /F | Out-Null}
    else {
      $app.CloseMainWindow() | Out-Null
      if(-not $app.WaitForExit(15000)){throw 'Application stayed alive after window close (possibly tray mode). Inspect it or explicitly use -Force for this isolated test process tree.'}
    }
  }
}
foreach($name in @('HermesNativeE2E','HermesNativeE2E-UIA')) {
  $task=Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if($task -and $task.State -eq 'Running'){Stop-ScheduledTask -TaskName $name}
}
Write-Output 'Isolated test processes stopped; runtime data and reports are preserved.'
