param([string]$Root='C:\HermesE2E',[string]$Python='python.exe')
$ErrorActionPreference='Stop'
$framework=Split-Path $PSScriptRoot -Parent
$env:PATH='C:\Program Files\nodejs;C:\Users\admin\AppData\Roaming\npm;' + $env:PATH
Get-Command node.exe,pnpm.cmd,$Python -ErrorAction Stop | Select-Object Name,Source
New-Item (Join-Path $Root 'reports'),(Join-Path $Root 'workspace') -ItemType Directory -Force | Out-Null
$venvPython=Join-Path $Root '.venv\Scripts\python.exe'
if(-not (Test-Path $venvPython)) {
  & $Python -m venv (Join-Path $Root '.venv')
  if($LASTEXITCODE){throw 'Cannot create isolated test Python environment'}
}
& $venvPython -m pip install --disable-pip-version-check -r (Join-Path $framework 'requirements.txt') -c (Join-Path $framework 'requirements-lock.txt')
if($LASTEXITCODE){throw 'Cannot install native test service dependencies'}
Push-Location $framework
try {
  & pnpm.cmd install --frozen-lockfile --ignore-workspace
  if($LASTEXITCODE){throw 'Cannot install pinned Playwright dependencies'}
} finally {Pop-Location}
& $venvPython -m pip freeze | Set-Content (Join-Path $Root 'reports\python-dependencies.txt') -Encoding UTF8
Write-Output 'The test framework is ready. Supply the private key file and run scripts/start.ps1.'
