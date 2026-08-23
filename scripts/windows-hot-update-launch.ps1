[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppExe,
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [Parameter(Mandatory = $true)][string]$Endpoint,
  [Parameter(Mandatory = $true)][string]$DeviceId,
  [string]$Channel = "prototype",
  [int]$CdpPort = 9222
)

$ErrorActionPreference = "Stop"
if (-not $env:HERMES_SHELL_UPDATE_TOKEN) { throw "HERMES_SHELL_UPDATE_TOKEN is required" }
$sessionId = (Get-Process -Id $PID).SessionId
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$isElevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($sessionId -eq 0) {
  throw "Windows hot-update smoke requires an interactive Session 1+; Session 0 cannot create WebView2 reliably"
}
if ($isElevated) {
  throw "Windows hot-update smoke must run non-elevated; elevated WebView2 hosts ignore local remote-debugging flags"
}
$application = (Resolve-Path -LiteralPath $AppExe).Path
$runtime = [IO.Path]::GetFullPath($RuntimeRoot)

Get-Process | ForEach-Object {
  try {
    if ($_.Path -eq $application -or ($_.Path -and $_.Path.StartsWith($runtime, [StringComparison]::OrdinalIgnoreCase))) {
      Stop-Process -Id $_.Id -Force
    }
  } catch {
    Write-Verbose "Skipping unrelated process with inaccessible Path: $($_.Exception.Message)"
  }
}

$env:HERMES_DESKTOP_RUNTIME_ROOT = $runtime
$env:HERMES_UPDATE_CHANNEL = $Channel
$env:HERMES_UPDATE_DEVICE_ID = $DeviceId
$env:HERMES_SHELL_UPDATE_ENDPOINT = $Endpoint
$env:HERMES_DESKTOP_API_PORT = "9120"
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
$process = Start-Process -FilePath $application -PassThru

[ordered]@{
  ok = $true
  pid = $process.Id
  appExe = $application
  runtimeRoot = $runtime
  channel = $Channel
  deviceId = $DeviceId
  endpoint = $Endpoint
  cdp = "http://127.0.0.1:$CdpPort"
  sessionId = $sessionId
  elevated = $isElevated
} | ConvertTo-Json -Depth 3
