param([string]$Root='C:\HermesE2E',[string]$Profile='restored-default',[int]$Port=19120)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
if($Profile -notmatch '^[a-z0-9][a-z0-9_-]+$' -or $Profile -eq 'default'){throw 'Choose an inactive test profile'}
$homePath=Join-Path $Root "runtime\hermes-home\profiles\$Profile"
if(-not (Test-Path (Join-Path $homePath 'config.yaml'))){throw 'Test profile config is missing'}
if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue){throw 'Diagnostic port is already occupied'}
$runtime=Get-Content (Join-Path $Root 'runtime\current.json') -Raw | ConvertFrom-Json
$diagnostic=Join-Path $Root ('reports\profile-diagnostic-'+(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
New-Item $diagnostic -ItemType Directory | Out-Null
$env:HERMES_HOME=$homePath
$env:HERMES_DESKTOP='1'
$env:HERMES_DISABLE_LAZY_INSTALLS='1'
$env:HERMES_DASHBOARD_PREWARM_AGENT='0'
$env:HERMES_NO_ANALYTICS='1'
$env:HERMES_DASHBOARD_SESSION_TOKEN=[guid]::NewGuid().ToString('N')
$env:PYTHONUTF8='1'
$p=Start-Process -FilePath $runtime.executablePath -WorkingDirectory (Split-Path $runtime.executablePath -Parent) -ArgumentList @('dashboard','--host','127.0.0.1','--port',"$Port",'--no-open') -RedirectStandardOutput (Join-Path $diagnostic 'stdout.log') -RedirectStandardError (Join-Path $diagnostic 'stderr.log') -PassThru
try {
  $deadline=(Get-Date).AddSeconds(45)
  while(-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    if($p.HasExited -or (Get-Date) -gt $deadline){throw 'Diagnostic Core did not start'}
    Start-Sleep -Milliseconds 300
  }
  $results=@()
  foreach($path in @('/api/config','/api/model/info')) {
    try {
      $r=Invoke-WebRequest "http://127.0.0.1:$Port$path" -UseBasicParsing -Headers @{Authorization="Bearer $env:HERMES_DASHBOARD_SESSION_TOKEN";'X-Hermes-Session-Token'=$env:HERMES_DASHBOARD_SESSION_TOKEN}
      $results+=@{path=$path;status=[int]$r.StatusCode;bytes=$r.RawContentLength}
    } catch {$results+=@{path=$path;status=[int]$_.Exception.Response.StatusCode;error=$_.Exception.Message}}
  }
  $results | ConvertTo-Json | Set-Content (Join-Path $diagnostic 'results.json') -Encoding UTF8
  $results | ConvertTo-Json -Compress
} finally {
  if(-not $p.HasExited){& taskkill.exe /PID $p.Id /T /F | Out-Null}
  Write-Output "Diagnostic evidence: $diagnostic"
}
