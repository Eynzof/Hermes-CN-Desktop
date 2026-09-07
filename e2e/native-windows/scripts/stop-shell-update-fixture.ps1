param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$folder=Join-Path $Root 'shell-update-fixture'
$metadata=Get-Content (Join-Path $folder 'metadata.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$record=Get-Content (Join-Path $folder 'process.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$process=Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
if($process){
  if(-not $process.CommandLine.Contains($record.script)){throw 'Shell fixture PID was reused by another process'}
  & taskkill.exe /PID $record.pid /T /F | Out-Null
  if($LASTEXITCODE){throw 'Cannot stop the verified shell fixture tree'}
}
if(Get-NetTCPConnection -LocalPort 19446 -State Listen -ErrorAction SilentlyContinue){throw 'Shell fixture listener still exists; inspect before certificate cleanup'}
$certificate=Join-Path 'Cert:\LocalMachine\Root' $metadata.caThumbprint
if(Test-Path $certificate){Remove-Item $certificate}
Write-Output 'Removed only the test proxy process tree and its exact two-host certificate'
