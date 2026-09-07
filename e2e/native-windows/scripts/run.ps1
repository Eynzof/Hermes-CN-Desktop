param(
  [string]$Root='C:\HermesE2E',
  [string]$Case='',
  [switch]$Remaining,
  [int]$MaxFailures=1,
  [switch]$RequireComplete
)
$ErrorActionPreference='Stop'
$env:PATH='C:\Program Files\nodejs;C:\Users\admin\AppData\Roaming\npm;' + $env:PATH
$env:HERMES_E2E_ROOT=$Root
$framework=Split-Path $PSScriptRoot -Parent
if($Remaining){
  & node.exe (Join-Path $PSScriptRoot 'coverage.mjs')
  if($LASTEXITCODE){throw 'Cannot read current baseline coverage'}
  $coverage=Get-Content (Join-Path $Root 'reports\coverage.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $pending=@($coverage.workflows | Where-Object {-not $_.scope -and $_.status -ne 'passed' -and (-not $Case -or $_.id -match $Case)})
  if($pending.Count -eq 0){Write-Output 'Selected required workflows already passed on this exact baseline';exit 0}
  $Case='(?:'+(($pending | ForEach-Object {[regex]::Escape($_.id)}) -join '|')+')\b'
}
$runId=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$env:HERMES_E2E_REPORT=Join-Path $Root "reports\runs\$runId"
New-Item $env:HERMES_E2E_REPORT -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $framework 'baseline.json') $env:HERMES_E2E_REPORT
$baseline=Get-Content (Join-Path $framework 'baseline.json') -Raw | ConvertFrom-Json
$processInfo=Get-Content (Join-Path $Root 'reports\desktop-process.json') -Raw | ConvertFrom-Json
$actual=(Get-FileHash $processInfo.appExe -Algorithm SHA256).Hash.ToLowerInvariant()
if($actual -ne $baseline.installedDesktopSha256){throw 'Running test installation differs from baseline'}
$env:HERMES_E2E_APP_SHA256=$actual
@{windowsUtc=(Get-Date).ToUniversalTime().ToString('o');appSha256=$actual;appExe=$processInfo.appExe;appPid=$processInfo.pid;caseFilter=$Case} | ConvertTo-Json | Set-Content (Join-Path $env:HERMES_E2E_REPORT 'run-provenance.json') -Encoding UTF8
& node.exe (Join-Path $PSScriptRoot 'source-manifest.mjs') (Join-Path $env:HERMES_E2E_REPORT 'framework-manifest.json')
if($LASTEXITCODE){throw 'Cannot record framework source manifest'}
Push-Location $framework
try {
  # Invoke Node directly: pnpm.cmd adds cmd.exe parsing and can interpret a
  # regex alternation in --grep as a shell pipe on Windows PowerShell 5.1.
  $arguments=@((Join-Path $framework 'node_modules\@playwright\test\cli.js'),'test','--config','playwright.config.ts','--max-failures',"$MaxFailures")
  if($Case){$arguments+=@('--grep',$Case)}
  $ErrorActionPreference='Continue'
  & node.exe @arguments 2>&1 | Tee-Object (Join-Path $env:HERMES_E2E_REPORT 'run.log')
  $testExit=$LASTEXITCODE
  $ErrorActionPreference='Stop'
  & node.exe scripts/coverage.mjs
  if($LASTEXITCODE){throw 'Cannot generate coverage report'}
  if($RequireComplete){
    & node.exe scripts/coverage.mjs --require-complete
    if($LASTEXITCODE){$testExit=1}
  }
  Write-Output "Evidence: $env:HERMES_E2E_REPORT"
  exit $testExit
} finally {Pop-Location}
