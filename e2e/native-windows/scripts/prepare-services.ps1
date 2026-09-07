param([string]$Root='C:\HermesE2E',[switch]$Updates)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
& docker info --format '{{.ServerVersion}}'
if($LASTEXITCODE){throw 'Docker Desktop must be running before preparing the real memory services'}
$services=@(
  @{name='hermes-native-e2e-ollama';image='ollama/ollama@sha256:32931b46719f673c05fdbaa81ccb26da18ea4a1c57590a754874ab28ba269eb2';script='start-ollama.ps1';health='http://127.0.0.1:11435/api/version'},
  @{name='hermes-native-e2e-openviking';image='ghcr.io/volcengine/openviking@sha256:14553ec16f2bda9bd08a188cffb659fcfff4fde5891cbb881ed1bd8488b23294';script='start-openviking.ps1';health='http://127.0.0.1:19333/health'},
  @{name='hermes-native-e2e-hindsight';image='ghcr.io/vectorize-io/hindsight@sha256:598173a33b44c95e73058935eb4a767663e5f8c650d52349d3992e0ec4107d74';script='start-hindsight.ps1';health='http://127.0.0.1:18888/health'}
)
foreach($service in $services){
  $name=$service.name
  $existing=@(docker ps -a --filter "name=^/$name`$" --format '{{.Names}}')
  if($existing.Count){
    $container=(docker inspect $name | ConvertFrom-Json)[0]
    if($container.Config.Image -ne $service.image -or $container.Config.Labels.'hermes.native-e2e' -ne 'true'){throw "Existing $name differs from the pinned test fixture"}
    if(-not $container.State.Running){docker start $name | Out-Null;if($LASTEXITCODE){throw "Cannot start $name"}}
  } else {
    & (Join-Path $PSScriptRoot $service.script) -Root $Root
  }
  $deadline=(Get-Date).AddMinutes(10)
  do {
    try {
      $health=Invoke-RestMethod $service.health -TimeoutSec 3
      if($name -eq 'hermes-native-e2e-openviking' -and -not $health.healthy){throw 'OpenViking is responding but not healthy'}
      if($name -eq 'hermes-native-e2e-hindsight' -and $health.status -ne 'healthy'){throw 'Hindsight is responding but not healthy'}
      break
    } catch {if((Get-Date) -gt $deadline){throw};Start-Sleep -Seconds 1}
  } while($true)
  Write-Output "Ready: $name"
}
if(-not (Test-Path (Join-Path $Root 'secrets\openviking-client.json'))){& (Join-Path $PSScriptRoot 'initialize-openviking.ps1') -Root $Root}
if($Updates){
  & (Join-Path $PSScriptRoot 'prepare-update-service.ps1') -Root $Root
}
Write-Output 'Real external services are ready; their existing isolated data was preserved.'
