<#
Check for a newer epnd build; if found, stop the service, replace the binary,
and restart it. Runs periodically (every 15 min) via Task Scheduler.
Safe for in-flight work: atomic binary swap + graceful service restart.
#>
$ErrorActionPreference = 'Continue'

$repo = if ($env:EPND_REPO) { $env:EPND_REPO } else { '50gramx/eapp-releases' }
$tag  = if ($env:EPND_TAG)  { $env:EPND_TAG }  else { 'epnd-latest' }
$base = "https://github.com/$repo/releases/download/$tag"

$arch = if ([System.Environment]::Is64BitOperatingSystem) {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
} else {
  Write-Error "unsupported arch: 32-bit Windows is not supported"
  exit 1
}

$asset = "epnd-windows-$arch.exe"
$dest = if ($env:EPND_INSTALL) { $env:EPND_INSTALL } else { Join-Path $env:LOCALAPPDATA 'epnd' }
$bin = Join-Path $dest 'epnd.exe'

$sums = "$base/checksums.txt"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("epnd-update-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  # Fetch the latest checksum
  try {
    Invoke-WebRequest -Uri $sums -OutFile (Join-Path $tmp 'checksums.txt') -UseBasicParsing -ErrorAction Stop
  } catch {
    Write-Host "could not fetch checksums.txt" -ForegroundColor Gray
    exit 0
  }

  $line = Select-String -Path (Join-Path $tmp 'checksums.txt') -Pattern "[ *]$asset$" | Select-Object -First 1
  if (-not $line) {
    Write-Host "no checksum entry for $asset" -ForegroundColor Gray
    exit 0
  }

  $want = ($line.Line -split '\s+')[0]

  # Compare against installed binary
  if (Test-Path $bin) {
    $have = (Get-FileHash -Path $bin -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash.ToLower()
  } else {
    $have = ""
  }

  if ($have -eq $want.ToLower()) {
    Write-Host "epnd up to date" -ForegroundColor Gray
    exit 0
  }

  Write-Host "new epnd available (have=$($have.Substring(0,8))... want=$($want.Substring(0,8))...) — updating…" -ForegroundColor Yellow

  # Download and verify
  try {
    Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $tmp 'epnd.exe') -UseBasicParsing -ErrorAction Stop
  } catch {
    Write-Error "download failed: $_"
    exit 1
  }

  $got = (Get-FileHash -Path (Join-Path $tmp 'epnd.exe') -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower()
  if ($got -ne $want.ToLower()) {
    Write-Error "checksum mismatch (want $want got $got)"
    exit 1
  }

  # Gracefully stop the service, replace binary, restart
  $taskName = "EPNDaemon"
  try {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  } catch { }

  # Atomic swap (overwrite the binary)
  Copy-Item (Join-Path $tmp 'epnd.exe') $bin -Force -ErrorAction Stop
  Write-Host "updated epnd from $tag" -ForegroundColor Green

  # Restart the service
  try {
    Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  } catch {
    Write-Host "note: could not restart task — check Task Scheduler manually" -ForegroundColor Gray
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
