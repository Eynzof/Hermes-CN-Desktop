param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$name='hermes-native-e2e-ollama'
$image='ollama/ollama@sha256:32931b46719f673c05fdbaa81ccb26da18ea4a1c57590a754874ab28ba269eb2'
$network='hermes-native-e2e-memory'
if(@(docker ps -a --filter "name=^/$name`$" --format '{{.Names}}').Count){throw 'The isolated Ollama container already exists; inspect it instead of recreating it'}
if(Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue){throw 'Ollama test port 11435 is occupied'}
if(-not @(docker network ls --filter "name=^$network`$" --format '{{.Name}}').Count){docker network create --label hermes.native-e2e=true $network | Out-Null}
docker run -d --name $name --label hermes.native-e2e=true --network $network --memory=4g --cpus=2 -p 127.0.0.1:11435:11434 -v hermes-native-e2e-ollama-models:/root/.ollama $image
if($LASTEXITCODE){throw 'Real Ollama fixture failed to start'}
$deadline=(Get-Date).AddSeconds(60)
do {
  try {$version=Invoke-RestMethod http://127.0.0.1:11435/api/version -TimeoutSec 2;break}
  catch {if((Get-Date) -gt $deadline){throw};Start-Sleep -Milliseconds 500}
} while($true)
$model='nomic-embed-text:v1.5'
$pull=Invoke-RestMethod http://127.0.0.1:11435/api/pull -Method Post -ContentType 'application/json' -Body (@{model=$model;stream=$false} | ConvertTo-Json) -TimeoutSec 900
if($pull.status -ne 'success'){throw 'Real embedding model download did not succeed'}
$models=Invoke-RestMethod http://127.0.0.1:11435/api/tags -TimeoutSec 5
@{container=$name;image=$image;version=$version.version;models=$models.models;api='http://127.0.0.1:11435';createdAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Root 'reports\ollama-fixture.json') -Encoding UTF8
Write-Output 'Ollama and the real local embedding model are ready.'
