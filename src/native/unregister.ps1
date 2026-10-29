# Remove only registry values pointing to this installation's own manifests.
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'AutoPresence\NativeMessaging'
$items = @(
  @{ Key = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.autopresence.browser'; File = 'chrome.json' },
  @{ Key = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.autopresence.browser'; File = 'edge.json' },
  @{ Key = 'HKCU:\Software\Mozilla\NativeMessagingHosts\com.autopresence.browser'; File = 'firefox.json' }
)
foreach ($item in $items) {
  $path = Join-Path $dir $item.File
  if (Test-Path $item.Key) {
    $existing = (Get-Item $item.Key).GetValue('')
    if ($existing -eq $path) { Remove-Item -LiteralPath $item.Key; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path } }
  }
}
# Keep host.bat if any host remains registered to avoid breaking another browser.
$remaining = $items | Where-Object { (Test-Path $_.Key) -and ((Get-Item $_.Key).GetValue('') -eq (Join-Path $dir $_.File)) }
if (-not $remaining) {
  $launcher = Join-Path $dir 'host.bat'
  if (Test-Path -LiteralPath $launcher) { Remove-Item -LiteralPath $launcher }
}
Write-Host 'AutoPresence native host registrations removed where present.'
