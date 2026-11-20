param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$HostName = 'com.bytebridge.host'
$ExtId = 'cfjmpidkokhhloiognboaiembblpjaid'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Local = Join-Path $env:LOCALAPPDATA 'byteBridge'
$HostDir = Join-Path $Local 'host'
$RegPaths = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts\' + $HostName,
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $HostName,
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\' + $HostName,
  'HKCU:\Software\Chromium\NativeMessagingHosts\' + $HostName
)
if ($Uninstall) {
  foreach ($r in $RegPaths) { Remove-Item -Path $r -Force -ErrorAction SilentlyContinue }
  Remove-Item $Local -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host 'byteBridge native host registrations removed.'
  exit 0
}
$Venv = Join-Path $Root '.build-venv'
if (!(Test-Path $Venv)) { py -3 -m venv $Venv }
$Py = Join-Path $Venv 'Scripts\python.exe'
& $Py -m pip install --upgrade pip pyinstaller
New-Item -ItemType Directory -Force (Join-Path $Root 'dist') | Out-Null
& $Py -m PyInstaller --noconfirm --clean --onefile --name byteBridgeHost (Join-Path $Root 'host\host.py')
New-Item -ItemType Directory -Force $HostDir | Out-Null
Copy-Item (Join-Path $Root 'dist\byteBridgeHost.exe') (Join-Path $HostDir 'byteBridgeHost.exe') -Force
& (Join-Path $HostDir 'byteBridgeHost.exe') --selftest
if ($LASTEXITCODE -ne 0) { throw 'byteBridge native host self-test failed.' }
$ManifestPath = Join-Path $HostDir 'com.bytebridge.host.json'
$Manifest = [ordered]@{ name=$HostName; description='byteBridge native messaging host'; path=(Join-Path $HostDir 'byteBridgeHost.exe'); type='stdio'; allowed_origins=@("chrome-extension://$ExtId/") }
$Json = $Manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($ManifestPath, $Json, [System.Text.UTF8Encoding]::new($false))
foreach ($r in $RegPaths) {
  New-Item -Path $r -Force | Out-Null
  Set-ItemProperty -Path $r -Name '(default)' -Value $ManifestPath
}
Copy-Item (Join-Path $Root 'extension') (Join-Path $Root 'dist\extension') -Recurse -Force
Write-Host 'byteBridge Windows native host built and registered.'
Write-Host "Load unpacked extension from: $(Join-Path $Root 'dist\extension')"
Write-Host 'Install tools if needed: winget install --id yt-dlp.yt-dlp --exact; winget install --id Gyan.FFmpeg --exact; winget install --id DenoLand.Deno --exact'
