param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$containerName='hermes-native-e2e-ollama'
$image='ollama/ollama@sha256:32931b46719f673c05fdbaa81ccb26da18ea4a1c57590a754874ab28ba269eb2'
$base='qwen3.5:0.8b'
$baseDigest='f3817196d142eaf72ce79dfebe53dcb20bd21da87ce13e138a8f8e10a866b3a4'
$model='hermes-e2e-qwen35:0.8b-64k'
$origin='http://127.0.0.1:11435'
if(-not @(docker ps -a --filter "name=^/$containerName`$" --format '{{.Names}}').Count){
  & (Join-Path $PSScriptRoot 'start-ollama.ps1') -Root $Root
}
$container=(docker inspect $containerName | ConvertFrom-Json)[0]
if($container.Config.Image -ne $image -or $container.Config.Labels.'hermes.native-e2e' -ne 'true'){throw 'Ollama is not the isolated pinned fixture'}
if($container.HostConfig.NanoCpus -ne 8000000000){
  docker update --cpus=8 $containerName | Out-Null
  if($LASTEXITCODE){throw 'Cannot allocate eight CPU cores to the dedicated local inference fixture'}
}
if(-not $container.State.Running){docker start $containerName | Out-Null;if($LASTEXITCODE){throw 'Cannot start isolated Ollama'}}
$version=Invoke-RestMethod "$origin/api/version" -TimeoutSec 15
$tags=Invoke-RestMethod "$origin/api/tags" -TimeoutSec 10
if(-not ($tags.models | Where-Object {$_.name -eq $base})){
  $pull=Invoke-RestMethod "$origin/api/pull" -Method Post -ContentType application/json -Body (@{model=$base;stream=$false}|ConvertTo-Json) -TimeoutSec 900
  if($pull.status -ne 'success'){throw 'Local generation model pull failed'}
  $tags=Invoke-RestMethod "$origin/api/tags" -TimeoutSec 10
}
$baseModel=$tags.models | Where-Object {$_.name -eq $base}
if($baseModel.digest -ne $baseDigest){throw 'Generation model tag differs from the pinned digest'}
$parameters=@{num_ctx=65536;num_predict=256;temperature=0;presence_penalty=0}
$created=Invoke-RestMethod "$origin/api/create" -Method Post -ContentType application/json -Body (@{model=$model;from=$base;parameters=$parameters;stream=$false}|ConvertTo-Json -Depth 4) -TimeoutSec 120
if($created.status -ne 'success'){throw 'Cannot configure the real 64K local model'}
$show=Invoke-RestMethod "$origin/api/show" -Method Post -ContentType application/json -Body (@{model=$model}|ConvertTo-Json) -TimeoutSec 10
if($show.model_info.'qwen35.context_length' -lt 65536){throw 'The model does not support the required context'}
$warm=Invoke-RestMethod "$origin/api/chat" -Method Post -ContentType application/json -Body (@{model=$model;think=$false;stream=$false;keep_alive='10m';messages=@(@{role='user';content='Reply only READY.'});options=@{num_predict=8}}|ConvertTo-Json -Depth 5) -TimeoutSec 180
if($warm.eval_count -le 0 -or -not $warm.message.content){throw 'Real local model calibration produced no tokens'}
$loaded=Invoke-RestMethod "$origin/api/ps" -TimeoutSec 10
$active=$loaded.models | Where-Object {$_.name -eq $model}
if($active.context_length -lt 65536){throw 'Ollama did not actually load the configured 64K context'}
$report=@{checkedAt=(Get-Date).ToUniversalTime().ToString('o');origin=$origin;container=$containerName;cpuQuota=8;image=$image;ollamaVersion=$version.version;baseModel=$base;baseDigest=$baseDigest;model=$model;parameters=$parameters;capabilities=$show.capabilities;loaded=$active;calibration=@{content=$warm.message.content;inputTokens=$warm.prompt_eval_count;outputTokens=$warm.eval_count};calibrationIsDesktopAcceptance=$false;source='https://ollama.com/library/qwen3.5:0.8b'}
$report | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Root 'reports\local-model-fixture.json') -Encoding UTF8
Write-Output 'Pinned local generation model is loaded with a real 64K context.'
