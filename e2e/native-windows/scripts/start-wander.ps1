param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$baseline=Get-Content (Join-Path $PSScriptRoot '..\wander-baseline.json') -Raw | ConvertFrom-Json
$script=Join-Path $PSScriptRoot 'wander-observer.py'
$python=Join-Path $Root 'services\wander-venv\Scripts\python.exe'
$metadataPath=Join-Path $Root 'reports\wander-fixture.json'
$listeners=@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in $baseline.ports})
if($listeners.Count){
  if(-not (Test-Path $metadataPath)){throw 'MemOS ports have an unrecorded owner'}
  $metadata=Get-Content $metadataPath -Raw | ConvertFrom-Json
  foreach($listener in $listeners){
    $owner=Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
    if(($owner.ProcessId -ne $metadata.pid -and $owner.ParentProcessId -ne $metadata.pid) -or -not $owner.CommandLine.Contains($script)){throw 'MemOS port owner differs from the recorded test service'}
  }
  if($listeners.Count -ne 3){throw 'Recorded MemOS service has only partially bound the default ports; inspect its logs'}
} else {
  if(Test-Path $metadataPath){
    $previous=Get-Content $metadataPath -Raw | ConvertFrom-Json
    if(Get-Process -Id $previous.pid -ErrorAction SilentlyContinue){throw 'Recorded MemOS process is alive without its ports; inspect before starting another process'}
  }
  $keyLine=Get-Content (Join-Path $Root 'secrets\deepseek.env') | Where-Object {$_ -like 'DEEPSEEK_API_KEY=*'} | Select-Object -First 1
  if(-not $keyLine){throw 'Private DeepSeek key file is missing'}
  $config=@{model=$baseline.model;url=$baseline.baseUrl;max_context_size=1048576;max_tokens=4096;policy='openai_legacy';api_key=$keyLine.Substring('DEEPSEEK_API_KEY='.Length).Trim()}
  $privateConfig=Join-Path $Root 'secrets\wander-remote.json'
  [IO.File]::WriteAllText($privateConfig,($config | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  & icacls.exe $privateConfig /inheritance:r /grant:r "${env:USERNAME}:F" 'SYSTEM:F' | Out-Null
  if($LASTEXITCODE){throw 'Cannot restrict MemOS model configuration permissions'}
  # A process launched directly by OpenSSH/execFileSync inherits that job's
  # lifetime or keeps its pipes open. The scheduled launcher owns the service.
  $taskName='HermesNativeE2E-Wander'
  $launcher=Join-Path $PSScriptRoot 'launch-wander.ps1'
  $arguments="-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`" -Root `"$Root`""
  $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
  $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
}
$deadline=(Get-Date).AddSeconds(90)
do {
  try {
    $health=Invoke-RestMethod http://127.0.0.1:18400/v1/health -TimeoutSec 3
    $fs=Invoke-RestMethod http://127.0.0.1:18402/v1/health -TimeoutSec 3
    if($health.status -ne 'ok' -or $health.model -ne $baseline.model -or $fs.status -ne 'ok'){throw 'MemOS health/model does not match the baseline'}
    break
  } catch {
    $task=Get-ScheduledTask -TaskName 'HermesNativeE2E-Wander' -ErrorAction SilentlyContinue
    if($task -and $task.State -ne 'Running' -and (Get-Date) -gt $deadline.AddSeconds(-85)){throw 'MemOS scheduled launcher exited before becoming healthy; inspect wander.stderr.log'}
    if((Get-Date) -gt $deadline){throw};Start-Sleep -Milliseconds 500
  }
} while($true)
@{healthy=$true;sourceCommit=$baseline.sourceCommit;model=$health.model;ports=$baseline.ports} | ConvertTo-Json
