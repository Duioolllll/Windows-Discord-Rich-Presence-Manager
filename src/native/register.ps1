# Register per-user Native Messaging hosts. Supply real extension IDs after installation.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ElectronExe,
  [Parameter(Mandatory=$true)][string]$HostScript,
  [string]$ChromeExtensionId,
  [string]$EdgeExtensionId,
  [string]$FirefoxExtensionId
)
$ErrorActionPreference = 'Stop'
foreach ($path in @($ElectronExe, $HostScript)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or -not [IO.Path]::IsPathRooted($path) -or $path -match '[%"\r\n]') { throw 'ElectronExe and HostScript must be existing absolute paths without percent signs or quotes.' }
}
foreach ($id in @($ChromeExtensionId, $EdgeExtensionId)) {
  if ($id -and $id -cnotmatch '^[a-p]{32}$') { throw 'Chrome and Edge extension IDs must have 32 lowercase letters a through p.' }
}
if ($FirefoxExtensionId -and $FirefoxExtensionId -notmatch '^[a-zA-Z0-9._+@{}-]{1,128}$') { throw 'Invalid Firefox extension ID.' }
if (-not ($ChromeExtensionId -or $EdgeExtensionId -or $FirefoxExtensionId)) { throw 'Supply at least one installed extension ID.' }
$dir = Join-Path $env:LOCALAPPDATA 'AutoPresence\NativeMessaging'
$items = @()
if ($ChromeExtensionId) { $items += @{ Key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.autopresence.browser'; File = 'chrome.json'; Mode = 'chrome'; Id = $ChromeExtensionId } }
if ($EdgeExtensionId) { $items += @{ Key = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.autopresence.browser'; File = 'edge.json'; Mode = 'chrome'; Id = $EdgeExtensionId } }
if ($FirefoxExtensionId) { $items += @{ Key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\com.autopresence.browser'; File = 'firefox.json'; Mode = 'firefox'; Id = $FirefoxExtensionId } }
# Do not overwrite an existing host owned by another installation.
foreach ($item in $items) {
  if (Test-Path $item.Key) {
    $existing = (Get-Item $item.Key).GetValue('')
    $expected = Join-Path $dir $item.File
    if ($existing -and $existing -ne $expected) { throw "Native host registration already points elsewhere: $($item.Key)" }
  }
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
$launcher = Join-Path $dir 'host.bat'
# Electron must have its RunAsNode fuse enabled. Values are quoted and checked above.
$batch = "@echo off`r`nset `"ELECTRON_RUN_AS_NODE=1`"`r`n`"$ElectronExe`" `"$HostScript`"`r`n"
[IO.File]::WriteAllText($launcher, $batch, $utf8)
foreach ($item in $items) {
  $manifest = @{ name = 'com.autopresence.browser'; description = 'AutoPresence native messaging host'; path = $launcher; type = 'stdio' }
  if ($item.Mode -eq 'chrome') { $manifest.allowed_origins = @("chrome-extension://$($item.Id)/") }
  else { $manifest.allowed_extensions = @($item.Id) }
  $path = Join-Path $dir $item.File
  [IO.File]::WriteAllText($path, ($manifest | ConvertTo-Json -Depth 4), $utf8)
  New-Item -Force -Path $item.Key | Out-Null
  (Get-Item $item.Key).SetValue('', $path)
}
Write-Host 'Native host registered for the supplied extension IDs. Restart the browser if necessary.'
