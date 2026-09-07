param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$folder=Join-Path $Root 'shell-update-fixture'
$script=Join-Path $PSScriptRoot 'shell-update-fixture.py'
$p=Start-Process (Join-Path $Root '.venv\Scripts\python.exe') -ArgumentList "`"$script`" --root `"$Root`"" -WindowStyle Hidden -RedirectStandardOutput (Join-Path $folder 'stdout.log') -RedirectStandardError (Join-Path $folder 'stderr.log') -PassThru
@{pid=$p.Id;script=$script} | ConvertTo-Json | Set-Content (Join-Path $folder 'process.json') -Encoding UTF8
$p.WaitForExit()
exit $p.ExitCode
