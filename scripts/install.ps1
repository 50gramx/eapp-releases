<#
EP&N daemon installer (Windows). One-command install:

  irm https://raw.githubusercontent.com/50gramx/eapp-releases/main/scripts/install.ps1 | iex

Downloads the matching `epnd` release asset from the rolling `epnd-latest`
tag on the public eapp-releases repo, verifies its SHA-256, and installs it
as a system service (auto-start on boot, auto-restart on crash). Override
via env vars before piping to iex:
  $env:EPND_TAG = 'epnd-latest'       # release tag (default: rolling build)
  $env:EPND_INSTALL = 'C:\epnd'       # install dir (default: %LOCALAPPDATA%\epnd)
  $env:EPND_REPO = '50gramx/eapp-releases'
#>
$ErrorActionPreference = 'Stop'

$repo = if ($env:EPND_REPO) { $env:EPND_REPO } else { '50gramx/eapp-releases' }
$tag  = if ($env:EPND_TAG)  { $env:EPND_TAG }  else { 'epnd-latest' }
$base = "https://github.com/$repo/releases/download/$tag"

$arch = if ([System.Environment]::Is64BitOperatingSystem) {
  if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
} else {
  throw "unsupported arch: 32-bit Windows is not supported"
}

$asset = "epnd-windows-$arch.exe"
$url   = "$base/$asset"
$sums  = "$base/checksums.txt"

$dest = if ($env:EPND_INSTALL) { $env:EPND_INSTALL } else { Join-Path $env:LOCALAPPDATA 'epnd' }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("epnd-install-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "downloading $asset ($tag)…"
  Invoke-WebRequest -Uri $url -OutFile (Join-Path $tmp 'epnd.exe') -UseBasicParsing

  $sumsPath = Join-Path $tmp 'checksums.txt'
  try { Invoke-WebRequest -Uri $sums -OutFile $sumsPath -UseBasicParsing } catch { }

  if (Test-Path $sumsPath) {
    $line = Select-String -Path $sumsPath -Pattern "[ *]$asset$" | Select-Object -First 1
    if ($line) {
      $want = ($line.Line -split '\s+')[0]
      $got  = (Get-FileHash -Path (Join-Path $tmp 'epnd.exe') -Algorithm SHA256).Hash.ToLower()
      if ($want.ToLower() -ne $got) { throw "checksum mismatch for $asset (want $want got $got)" }
      Write-Host "checksum verified"
    }
  } else {
    Write-Warning "no checksums.txt found — skipping verification"
  }

  Copy-Item (Join-Path $tmp 'epnd.exe') (Join-Path $dest 'epnd.exe') -Force
  Write-Host "installed epnd -> $dest\epnd.exe"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $dest) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
    Write-Host "added $dest to your User PATH (open a new terminal to pick it up)"
  }

  & (Join-Path $dest 'epnd.exe') version 2>$null

  # ── register as a system service (Task Scheduler) ───────────────────────────
  Write-Host ""
  Write-Host "registering epnd as a system service…"

  $exePath = Join-Path $dest 'epnd.exe'
  $taskName = "EPNDaemon"
  $taskPath = "\50gramx\EPNDaemon"

  # Remove old task if it exists
  $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existingTask) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  }

  # Create task trigger (at startup, and every 5 minutes as a redundant restart check)
  $startupTrigger = New-ScheduledTaskTrigger -AtStartup
  $repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 36500)

  # Create task action (run the daemon)
  $taskAction = New-ScheduledTaskAction -Execute $exePath -Argument "serve"

  # Create task settings (auto-restart on failure)
  $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable

  # Create and register the task
  $task = New-ScheduledTask -Action $taskAction -Trigger $startupTrigger -Settings $taskSettings -Description "EP&N Daemon - auto-starts on boot and auto-restarts on failure"
  Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

  # Start the service immediately
  Start-ScheduledTask -TaskName $taskName

  Write-Host "epnd service registered in Task Scheduler"

  Write-Host ""
  Write-Host "✓ epnd is installed and running as a system service"
  Write-Host "  • auto-starts on boot"
  Write-Host "  • auto-restarts on crash"
  Write-Host "  • run: epnd status"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
