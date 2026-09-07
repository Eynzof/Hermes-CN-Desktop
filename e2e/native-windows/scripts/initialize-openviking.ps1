param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
$file=Join-Path $Root 'secrets\openviking-client.json'
if(Test-Path $file){throw 'The isolated OpenViking tenant credential already exists; preserve it'}
$deadline=(Get-Date).AddSeconds(90)
do {
  try {$health=Invoke-RestMethod http://127.0.0.1:19333/health -TimeoutSec 3;if($health.healthy){break}}
  catch {if((Get-Date) -gt $deadline){throw}}
  if((Get-Date) -gt $deadline){throw 'OpenViking has not become healthy'}
  Start-Sleep -Milliseconds 500
} while($true)
$config=Get-Content (Join-Path $Root 'secrets\openviking.conf') -Raw -Encoding UTF8 | ConvertFrom-Json
# A ROOT key is only for administration; real memory access uses a tenant key.
$result=Invoke-RestMethod http://127.0.0.1:19333/api/v1/admin/accounts -Method Post -Headers @{'X-API-Key'=$config.server.root_api_key} -ContentType 'application/json' -Body '{"account_id":"hermes-e2e","admin_user_id":"default"}' -TimeoutSec 60
if(-not $result.result.user_key){throw 'OpenViking did not issue a tenant credential'}
[IO.File]::WriteAllText($file,($result | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
& icacls.exe $file /inheritance:r /grant:r "${env:USERNAME}:F" 'SYSTEM:F' | Out-Null
if($LASTEXITCODE){throw 'Cannot restrict OpenViking tenant credential'}
Write-Output 'Isolated OpenViking tenant hermes-e2e/default is ready.'
