param(
  [string]$Root='C:\HermesE2E',
  [string]$RuntimeArchive='C:\HermesV090Fixes\artifacts\hermes-agent-cn-runtime-win32-x64-0.21.0-cn.10.zip',
  [string]$RuntimeManifest='C:\HermesV090\Desktop App\bundled-runtime\stable-win32-x64.json',
  [string]$UiDist='C:\HermesV090Fixes\artifacts\desktop-0.9.0-cn10\web-dist',
  [string]$SigningKey='C:\HermesV090\keys\runtime-test.pem'
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$fixture=Join-Path $Root 'update-fixture'
$python=Join-Path $Root '.venv\Scripts\python.exe'
$script=Join-Path $PSScriptRoot 'update-fixture.py'
if(-not (Test-Path (Join-Path $fixture 'metadata.json'))) {
  & $python $script --root $Root --prepare --runtime-archive $RuntimeArchive --runtime-manifest $RuntimeManifest --ui-dist $UiDist --signing-key $SigningKey
  if($LASTEXITCODE){throw 'Local update fixture preparation failed'}
}
$metadata=Get-Content (Join-Path $fixture 'metadata.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$certPath=Join-Path $fixture 'ca.cer'
$certificate=[Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
if($certificate.Thumbprint.ToLowerInvariant() -ne $metadata.caThumbprint){throw 'Fixture certificate metadata differs'}
if($certificate.NotAfter -le (Get-Date)){throw 'Fixture TLS certificate has expired; prepare a new isolated fixture'}
& icacls.exe (Join-Path $Root 'secrets\update-fixture') /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if($LASTEXITCODE){throw 'Cannot restrict fixture private key directory'}
# Short-lived localhost-only trust root. Its exact thumbprint is retained for
# removal with stop-update-fixture.ps1; unrelated certificates are untouched.
& certutil.exe -f -addstore Root $certPath | Out-Null
if($LASTEXITCODE){throw 'Cannot trust the localhost fixture certificate'}
$listeners=@(Get-NetTCPConnection -State Listen -LocalPort 19445 -ErrorAction SilentlyContinue)
if($listeners.Count){throw 'Port 19445 is already in use; inspect the existing fixture before launching another'}
# OpenSSH's job terminates detached children when its session ends. Use an
# independent scheduled task, as for the real desktop and native UI helper.
$launch=Join-Path $PSScriptRoot 'launch-update-fixture.ps1'
$action=New-ScheduledTaskAction -Execute powershell.exe -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launch`" -Root `"$Root`""
$principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 12)
Register-ScheduledTask -TaskName 'HermesNativeE2E-Updates' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'HermesNativeE2E-Updates'
$ready=$false
for($attempt=0;$attempt -lt 20;$attempt++) {
  try {
    $response=Invoke-WebRequest -Uri ($metadata.baseUrl+'/metadata.json') -UseBasicParsing -TimeoutSec 2
    if($response.StatusCode -eq 200){$ready=$true;break}
  } catch {Start-Sleep -Milliseconds 250}
}
if(-not $ready){throw 'Local HTTPS fixture did not become healthy; inspect its stdout/stderr logs'}
@{task='HermesNativeE2E-Updates';url=$metadata.baseUrl;caThumbprint=$metadata.caThumbprint} | ConvertTo-Json
