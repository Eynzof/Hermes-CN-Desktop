param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$fixture=Join-Path $Root 'update-fixture'
$metadata=Get-Content (Join-Path $fixture 'metadata.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$record=Get-Content (Join-Path $fixture 'process.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$process=Get-CimInstance Win32_Process -Filter "ProcessId = $($record.pid)"
if($process) {
  $expected=Join-Path $Root 'native-windows\scripts\update-fixture.py'
  if(-not $process.CommandLine.Contains($expected)){throw 'Recorded PID now belongs to another process'}
  # Include the owned base-interpreter child of the Windows venv launcher.
  & taskkill.exe /PID $record.pid /T /F | Out-Null
  if($LASTEXITCODE){throw 'Cannot stop the owned update fixture process tree'}
}
$remaining=Get-NetTCPConnection -LocalPort 19445 -State Listen -ErrorAction SilentlyContinue
if($remaining){throw 'The update listener is still alive; retain its certificate until ownership is resolved'}
$certificate=Join-Path 'Cert:\LocalMachine\Root' $metadata.caThumbprint
if(Test-Path $certificate){Remove-Item $certificate}
Write-Output 'Stopped the owned fixture and removed only its exact temporary certificate; archives and evidence remain.'
