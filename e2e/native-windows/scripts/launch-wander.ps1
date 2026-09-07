param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$baseline=Get-Content (Join-Path $PSScriptRoot '..\wander-baseline.json') -Raw | ConvertFrom-Json
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONUNBUFFERED='1'
$python=Join-Path $Root 'services\wander-venv\Scripts\python.exe'
$script=Join-Path $PSScriptRoot 'wander-observer.py'
$arguments=@('"'+$script+'"','"'+$Root+'"')
$process=Start-Process $python -ArgumentList $arguments -WorkingDirectory (Join-Path $Root $baseline.sourceDirectory) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Root 'reports\wander.stdout.log') -RedirectStandardError (Join-Path $Root 'reports\wander.stderr.log')
$metadata=@{pid=$process.Id;sourceCommit=$baseline.sourceCommit;archiveSha256=$baseline.archiveSha256;model=$baseline.model;baseUrl=$baseline.baseUrl;ports=$baseline.ports;source=(Join-Path $Root $baseline.sourceDirectory);data=(Join-Path $Root 'services\wander-data');launcher='HermesNativeE2E-Wander'}
$metadata | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $Root 'reports\wander-fixture.json') -Encoding UTF8
$process.WaitForExit()
@{pid=$process.Id;exitCode=$process.ExitCode;exitedAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $Root 'reports\wander-exit.json') -Encoding UTF8
