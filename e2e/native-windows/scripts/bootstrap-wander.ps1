param([string]$Root='C:\HermesE2E',[string]$SourceArchive='')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$baseline=Get-Content (Join-Path $PSScriptRoot '..\wander-baseline.json') -Raw | ConvertFrom-Json
if(-not $SourceArchive){$SourceArchive=Join-Path $Root $baseline.archive}
if(-not (Test-Path $SourceArchive)){throw 'Provide the private repository git archive described in README before preparing MemOS'}
if((Get-FileHash $SourceArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $baseline.archiveSha256){throw 'MemOS source archive does not match the pinned integration commit'}
$source=Join-Path $Root $baseline.sourceDirectory
if(-not (Test-Path $source)){
  New-Item $source -ItemType Directory -Force | Out-Null
  # Python decodes archive member names as UTF-8; Windows tar.exe can mangle
  # Chinese names under the current console code page.
  & (Join-Path $Root '.venv\Scripts\python.exe') -m tarfile -e $SourceArchive $source
  if($LASTEXITCODE){throw 'Cannot extract MemOS source'}
}
$venv=Join-Path $Root 'services\wander-venv'
$python=Join-Path $venv 'Scripts\python.exe'
if(-not (Test-Path $python)){
  & (Join-Path $Root '.venv\Scripts\python.exe') -m venv $venv
  if($LASTEXITCODE){throw 'Cannot create the separate MemOS Python environment'}
}
$ErrorActionPreference='Continue'
& $python -m pip install $source -c (Join-Path $PSScriptRoot '..\wander-constraints.txt') --log (Join-Path $Root 'reports\wander-install-pinned.log')
$installExit=$LASTEXITCODE
$ErrorActionPreference='Stop'
if($installExit){throw 'Cannot install pinned MemOS dependencies'}
& $python -m pip check
if($LASTEXITCODE){throw 'MemOS dependency consistency check failed'}
& $python -m pip freeze | Set-Content (Join-Path $Root 'reports\wander-python-dependencies.txt') -Encoding UTF8
Write-Output 'Pinned MemOS source and its separate Python environment are ready.'
