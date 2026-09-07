param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$fixture=Join-Path $Root 'update-fixture'
$script=Join-Path $PSScriptRoot 'update-fixture.py'
$p=Start-Process -FilePath (Join-Path $Root '.venv\Scripts\python.exe') -ArgumentList "`"$script`" --root `"$Root`"" -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $fixture 'stdout.log') -RedirectStandardError (Join-Path $fixture 'stderr.log') -PassThru
@{pid=$p.Id;root=$Root;script=$script} | ConvertTo-Json | Set-Content (Join-Path $fixture 'process.json') -Encoding UTF8
$p.WaitForExit()
exit $p.ExitCode
