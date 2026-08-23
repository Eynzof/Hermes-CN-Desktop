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
} | ConvertTo-Json -Depth 3
