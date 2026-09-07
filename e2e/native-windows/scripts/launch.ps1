param(
  [string]$Root='C:\HermesE2E',
  [string]$AppExe='C:\HermesV090\Desktop App\hermes-agent-cn-desktop.exe',
  [int]$CdpPort=19229,
  [int]$ApiPort=9120,
  [switch]$UpdateFixture,
  [switch]$ShellUpdateFixture
)
$ErrorActionPreference='Stop'
trap { $_.Exception.Message | Set-Content (Join-Path $Root 'reports\launcher-error.txt') -Encoding UTF8; exit 1 }
$env:HERMES_DESKTOP_RUNTIME_ROOT=Join-Path $Root 'runtime'
$env:HERMES_DESKTOP_API_PORT="$ApiPort"
$env:HERMES_HOME=Join-Path $env:HERMES_DESKTOP_RUNTIME_ROOT 'hermes-home'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$CdpPort"
$env:PYTHONUTF8='1'
$env:HERMES_NO_ANALYTICS='1'
# This test uses the installed application's own resources and the real provider.
foreach($name in @('HERMES_DESKTOP_BUNDLED_RUNTIME_DIR','HERMES_DESKTOP_DASHBOARD_WEB_DIST_DIR','HERMES_DESKTOP_BUNDLED_SKILLS_DIR','HERMES_DESKTOP_BUNDLED_PLUGINS_DIR','HERMES_RUNTIME_UPDATE_PUBLIC_KEY_FILE','HERMES_UI_UPDATE_MANIFEST_URL','HERMES_SHELL_UPDATE_ENDPOINT','HERMES_SHELL_UPDATE_TOKEN','SSL_CERT_FILE','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','OPENAI_BASE_URL','OPENAI_API_KEY')) {
  Remove-Item "Env:$name" -ErrorAction SilentlyContinue
}
if($UpdateFixture) {
  $fixture=Join-Path $Root 'update-fixture'
  if(-not (Test-Path (Join-Path $fixture 'metadata.json'))){throw 'Prepare the local signed update fixture first'}
  $env:HERMES_RUNTIME_UPDATE_PUBLIC_KEY_FILE=Join-Path $fixture 'public.pem'
  $env:HERMES_UI_UPDATE_MANIFEST_URL='https://localhost:19445/ui.json'
  # The acceptance EXE reads Windows native trust roots. Do not set
  # SSL_CERT_FILE: Core's HTTP client would inherit a localhost-only CA set
  # and reject the real DeepSeek service's public certificate chain.
}
if($ShellUpdateFixture) {
  $fixture=Join-Path $Root 'shell-update-fixture'
  if(-not (Test-Path (Join-Path $fixture 'metadata.json'))){throw 'Prepare the signed shell update fixture first'}
  $env:HTTPS_PROXY='http://127.0.0.1:19446'
  $env:NO_PROXY='api.deepseek.com,127.0.0.1,localhost'
}
# The runner reads the private key and enters it through the UI. Do not
# inject a process-wide provider key: that would mask profile credential isolation.
Remove-Item Env:DEEPSEEK_API_KEY -ErrorAction SilentlyContinue
if(-not (Test-Path (Join-Path $Root 'secrets\deepseek.env'))){throw 'Private DeepSeek key file is required'}
$env:RUST_LOG='warn'
$env:PATH='C:\Users\admin\Desktop\Dev\Git\cmd;C:\Program Files\nodejs;' + $env:PATH
New-Item (Join-Path $Root 'reports'),$env:HERMES_HOME,(Join-Path $Root 'workspace') -ItemType Directory -Force | Out-Null
$configPath=Join-Path $env:HERMES_HOME 'config.yaml'
if(-not (Test-Path $configPath)) {
  $workspace=(Join-Path $Root 'workspace').Replace('\','/')
  $config=@"
model:
  provider: deepseek
  default: deepseek-v4-flash
  base_url: https://api.deepseek.com/v1
  context_length: 1048576
  max_tokens: 4096
  supports_vision: false
terminal:
  backend: local
  cwd: $workspace
"@
  [IO.File]::WriteAllText($configPath,$config,[Text.UTF8Encoding]::new($false))
}
# Match a normal GUI launch. Redirected parent handles leak into the product's
# external PowerShell and make prompt_toolkit fail with NoConsoleScreenBufferError.
# Core maintains its own log files under the isolated HERMES_HOME.
$p=Start-Process -FilePath $AppExe -WorkingDirectory $Root -PassThru
@{pid=$p.Id;appExe=$AppExe;runtimeRoot=$env:HERMES_DESKTOP_RUNTIME_ROOT;session=(Get-Process -Id $PID).SessionId;cdpPort=$CdpPort;apiPort=$ApiPort;updateFixture=[bool]$UpdateFixture;shellUpdateFixture=[bool]$ShellUpdateFixture} | ConvertTo-Json | Set-Content (Join-Path $Root 'reports\desktop-process.json') -Encoding UTF8
$p.WaitForExit()
@{pid=$p.Id;exitCode=$p.ExitCode;exitedAt=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json | Set-Content (Join-Path $Root 'reports\desktop-exit.json') -Encoding UTF8
