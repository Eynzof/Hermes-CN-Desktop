param(
  [string]$Root='C:\HermesE2E',
  [string]$AppExe='C:\HermesV090\Desktop App\hermes-agent-cn-desktop.exe',
  [int]$CdpPort=19229,
  [int]$ApiPort=9120
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
$p=Start-Process -FilePath $AppExe -WorkingDirectory $Root -PassThru -RedirectStandardOutput (Join-Path $Root 'reports\desktop.log') -RedirectStandardError (Join-Path $Root 'reports\desktop-error.log')
@{pid=$p.Id;appExe=$AppExe;runtimeRoot=$env:HERMES_DESKTOP_RUNTIME_ROOT;session=(Get-Process -Id $PID).SessionId;cdpPort=$CdpPort;apiPort=$ApiPort} | ConvertTo-Json | Set-Content (Join-Path $Root 'reports\desktop-process.json') -Encoding UTF8
Wait-Process -Id $p.Id
