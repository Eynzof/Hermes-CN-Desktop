param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$name='hermes-native-e2e-openviking'
$image='ghcr.io/volcengine/openviking@sha256:14553ec16f2bda9bd08a188cffb659fcfff4fde5891cbb881ed1bd8488b23294'
if(@(docker ps -a --filter "name=^/$name`$" --format '{{.Names}}').Count){throw 'The isolated OpenViking container already exists; inspect it instead of recreating it'}
if(Get-NetTCPConnection -LocalPort 19333 -State Listen -ErrorAction SilentlyContinue){throw 'OpenViking test port 19333 is occupied'}
$keyLine=Get-Content (Join-Path $Root 'secrets\deepseek.env') | Where-Object {$_.StartsWith('DEEPSEEK_API_KEY=')} | Select-Object -First 1
if(-not $keyLine){throw 'Private DeepSeek key missing'}
$config=@{
  storage=@{workspace='/app/.openviking/data-768'}
  embedding=@{dense=@{provider='ollama';model='nomic-embed-text:v1.5';api_base='http://hermes-native-e2e-ollama:11434/v1';dimension=768}}
  vlm=@{provider='openai';model='deepseek-v4-flash';api_base='https://api.deepseek.com/v1';api_key=$keyLine.Substring('DEEPSEEK_API_KEY='.Length);max_retries=1}
  server=@{host='0.0.0.0';port=1933;auth_mode='api_key';root_api_key=([guid]::NewGuid().ToString('N'))}
}
$file=Join-Path $Root 'secrets\openviking.conf'
[IO.File]::WriteAllText($file,($config | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
& icacls.exe $file /inheritance:r /grant:r "${env:USERNAME}:F" 'SYSTEM:F' | Out-Null
if($LASTEXITCODE){throw 'Cannot restrict OpenViking credential configuration'}
docker run -d --name $name --label hermes.native-e2e=true --network hermes-native-e2e-memory --memory=4g --cpus=2 -p 127.0.0.1:19333:1933 -e OPENVIKING_WITH_BOT=0 -v hermes-native-e2e-openviking-data:/app/.openviking --mount "type=bind,source=$file,target=/app/.openviking/ov.conf,readonly" $image
if($LASTEXITCODE){throw 'Real OpenViking fixture failed to start'}
@{container=$name;image=$image;version='0.4.17.1';llmProvider='deepseek';llmModel='deepseek-v4-flash';embeddingModel='nomic-embed-text:v1.5';embeddingDimension=768;api='http://127.0.0.1:19333';createdAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $Root 'reports\openviking-fixture.json') -Encoding UTF8
Write-Output 'OpenViking fixture started; inspect /health and wait for the actual local embedding model to load.'
