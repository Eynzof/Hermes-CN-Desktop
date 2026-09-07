param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$name='hermes-native-e2e-hindsight'
$image='ghcr.io/vectorize-io/hindsight@sha256:598173a33b44c95e73058935eb4a767663e5f8c650d52349d3992e0ec4107d74'
$existing=@(docker ps -a --filter "name=^/$name`$" --format '{{.Names}}')
if($existing.Count){throw 'The isolated Hindsight container already exists; inspect its readiness instead of recreating it'}
$keyLine=Get-Content (Join-Path $Root 'secrets\deepseek.env') | Where-Object { $_.StartsWith('DEEPSEEK_API_KEY=') } | Select-Object -First 1
if(-not $keyLine){throw 'Private DeepSeek key missing'}
$envFile=Join-Path $Root 'secrets\hindsight.env'
$configuration=@(
  # Hindsight 0.4.9 exposes DeepSeek through its OpenAI-compatible adapter.
  'HINDSIGHT_API_LLM_PROVIDER=openai',
  ('HINDSIGHT_API_LLM_API_KEY='+$keyLine.Substring('DEEPSEEK_API_KEY='.Length)),
  'HINDSIGHT_API_LLM_MODEL=deepseek-v4-flash',
  'HINDSIGHT_API_LLM_BASE_URL=https://api.deepseek.com/v1',
  'HINDSIGHT_API_LLM_MAX_CONCURRENT=2',
  'HINDSIGHT_API_EMBEDDINGS_PROVIDER=local',
  'HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL=BAAI/bge-small-en-v1.5',
  'HINDSIGHT_API_RERANKER_PROVIDER=flashrank'
)
[IO.File]::WriteAllLines($envFile,$configuration,(New-Object Text.UTF8Encoding($false)))
& icacls.exe $envFile /inheritance:r /grant:r "${env:USERNAME}:F" 'SYSTEM:F' | Out-Null
if($LASTEXITCODE){throw 'Cannot restrict fixture credential file'}
# Docker initializes this otherwise-empty volume as root. The pinned image
# runs as UID/GID 1000 and pg0 requires write access to its own data directory.
docker run --rm --user 0 --entrypoint chown -v hermes-native-e2e-hindsight-data:/home/hindsight/.pg0 $image 1000:1000 /home/hindsight/.pg0
if($LASTEXITCODE){throw 'Cannot initialize the isolated pg0 data volume'}
docker run -d --name $name --label hermes.native-e2e=true --env-file $envFile --shm-size=1g --memory=8g --cpus=4 -p 127.0.0.1:18888:8888 -p 127.0.0.1:19999:9999 -v hermes-native-e2e-hindsight-data:/home/hindsight/.pg0 -v hermes-native-e2e-hindsight-models:/home/hindsight/.cache $image
if($LASTEXITCODE){throw 'Real Hindsight fixture failed to start'}
$metadata=@{container=$name;image=$image;llmProvider='deepseek';llmModel='deepseek-v4-flash';embeddingModel='BAAI/bge-small-en-v1.5';api='http://127.0.0.1:18888';controlPlane='http://127.0.0.1:19999';createdAt=(Get-Date).ToUniversalTime().ToString('o')}
$metadata | ConvertTo-Json | Set-Content (Join-Path $Root 'reports\hindsight-fixture.json') -Encoding UTF8
$metadata | ConvertTo-Json
