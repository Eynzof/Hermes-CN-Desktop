param([string]$Root='C:\HermesE2E',[string[]]$IncludeRun=@())
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$reports=Join-Path $Root 'reports'
$coverage=Get-Content (Join-Path $reports 'coverage.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$runIds=@($coverage.workflows | Where-Object {$_.run} | Select-Object -ExpandProperty run -Unique)
$runIds=@(($runIds + $IncludeRun) | Select-Object -Unique)
$destination=Join-Path $reports ('exports\'+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
$runs=Join-Path $destination 'runs'
New-Item $runs -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $reports 'coverage.json'),(Join-Path $reports 'coverage.md') $destination
foreach($runId in $runIds){
  Copy-Item (Join-Path $reports "runs\$runId") $runs -Recurse
}
foreach($file in @('hindsight-fixture.json','openviking-fixture.json','ollama-fixture.json','local-model-fixture.json','local-model-resource-adjustment.json','local-model-context-baseline.json','context-baseline-restoration.json','python-dependencies.txt','wander-fixture.json','wander-source-manifest.json','wander-python-dependencies.txt','wander-model-calls.ndjson')){
  if(Test-Path (Join-Path $reports $file)){Copy-Item (Join-Path $reports $file) $destination}
}
$archive=$destination+'.zip'
& (Join-Path $Root '.venv\Scripts\python.exe') (Join-Path $PSScriptRoot 'zip-evidence.py') $destination $archive
if($LASTEXITCODE){throw 'Cannot create the portable evidence archive'}
@{archive=$archive;sourceRuns=$runIds.Count;supportingRuns=$IncludeRun;complete=$coverage.complete;counts=$coverage.counts;sha256=(Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant();bytes=(Get-Item $archive).Length} | ConvertTo-Json -Depth 4
