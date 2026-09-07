param([string]$Root='C:\HermesE2E',[string]$AppExe='C:\HermesV090\Desktop App\hermes-agent-cn-desktop.exe')
$ErrorActionPreference='Stop'
$metadata=Get-Content (Join-Path $Root 'shell-update-fixture\metadata.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq $AppExe}){throw 'Quit the actual test Desktop before restoring its baseline installer'}
if((Get-FileHash $metadata.baselineInstaller).Hash.ToLowerInvariant() -ne $metadata.baselineInstallerSha256){throw 'Baseline installer bytes changed'}
$directory=Split-Path $AppExe -Parent
$installer=Start-Process $metadata.baselineInstaller -ArgumentList "/S /P /D=$directory" -PassThru -Wait
if($installer.ExitCode -ne 0){throw "Baseline installer returned $($installer.ExitCode)"}
if((Get-FileHash $AppExe).Hash.ToLowerInvariant() -ne $metadata.baselineInstalledSha256){throw 'Installed baseline hash differs after restoration'}
Write-Output 'Restored the exact baseline NSIS installation; isolated user data retained'
