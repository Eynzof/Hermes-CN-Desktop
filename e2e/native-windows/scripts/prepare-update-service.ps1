param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$listener=Get-NetTCPConnection -LocalPort 19445 -State Listen -ErrorAction SilentlyContinue
if($listener){
  $record=Get-Content (Join-Path $Root 'update-fixture\process.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach($socket in $listener){
    $owner=Get-CimInstance Win32_Process -Filter "ProcessId = $($socket.OwningProcess)"
    # A Windows venv launches the base interpreter as its direct child.
    if(($owner.ProcessId -ne $record.pid -and $owner.ParentProcessId -ne $record.pid) -or -not $owner.CommandLine.Contains($record.script)){throw 'The local update port belongs to another process'}
  }
  $check=Invoke-WebRequest https://localhost:19445/metadata.json -UseBasicParsing -TimeoutSec 5
  if($check.StatusCode -ne 200){throw 'The signed update fixture is not healthy'}
} else {& (Join-Path $PSScriptRoot 'start-update-fixture.ps1') -Root $Root}
Write-Output 'Owned signed Runtime/UI update service is ready'
