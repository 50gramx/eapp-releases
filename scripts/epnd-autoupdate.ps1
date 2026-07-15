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

  # Keep THIS updater script current too. The updater replaces epnd.exe but never
  # itself, so a bug in the updater (like the one that left the binary file-locked
  # and every node stuck on an old build) could never be fixed remotely — every
  # node would need a manual reinstall. Refresh our own file from the published,
  # checksum-verified copy; the new logic takes effect on the next run.
  if ($PSCommandPath) {
    $selfLine = Select-String -Path (Join-Path $tmp 'checksums.txt') -Pattern "[ *]epnd-autoupdate.ps1$" | Select-Object -First 1
    if ($selfLine) {
      $selfWant = (($selfLine.Line -split '\s+')[0]).ToLower()
      $selfHave = (Get-FileHash -Path $PSCommandPath -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash.ToLower()
      if ($selfHave -ne $selfWant) {
        try {
          Invoke-WebRequest -Uri "$base/epnd-autoupdate.ps1" -OutFile (Join-Path $tmp 'self.ps1') -UseBasicParsing -ErrorAction Stop
          $selfGot = (Get-FileHash -Path (Join-Path $tmp 'self.ps1') -Algorithm SHA256).Hash.ToLower()
          if ($selfGot -eq $selfWant) {
            Copy-Item (Join-Path $tmp 'self.ps1') $PSCommandPath -Force -ErrorAction Stop
            Write-Host "updated the auto-update script itself" -ForegroundColor Green
          }
        } catch { Write-Host "note: could not self-update the updater script" -ForegroundColor Gray }
      }
    }
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

  # Stop the service, replace binary, restart. The task name must match what
  # install.ps1 registers ('GramNode'); it used to be 'EPNDaemon' here, so this
  # standalone script stopped the WRONG task entirely on a real install.
  $taskName = "GramNode"
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue

  # Stop-ScheduledTask does NOT reliably kill epnd.exe: the task launches it via a
  # cmd.exe wrapper, so epnd.exe is a GRANDCHILD that gets orphaned and keeps the
  # binary file-locked — which made the in-place swap fail and the node silently
  # stay on the old build. Kill the actual running binary at $bin (path-matched;
  # fall back to any epnd.exe if the path can't be read).
  $procs = Get-CimInstance Win32_Process -Filter "Name='epnd.exe'" -ErrorAction SilentlyContinue
  $targets = $procs | Where-Object { $_.ExecutablePath -eq $bin }
  if (-not $targets) { $targets = $procs }
  $targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 700

  # Rename-then-replace: Windows can MOVE a running/locked exe aside even when it
  # cannot be overwritten in place, so the swap succeeds even if a handle lingers.
  $old = "$bin.old"
  Remove-Item $old -Force -ErrorAction SilentlyContinue
  if (Test-Path $bin) { Move-Item -Path $bin -Destination $old -Force -ErrorAction SilentlyContinue }
  Copy-Item (Join-Path $tmp 'epnd.exe') $bin -Force -ErrorAction Stop
  Remove-Item $old -Force -ErrorAction SilentlyContinue
  Write-Host "updated epnd from $tag" -ForegroundColor Green

  Start-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
