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
  # Register-ScheduledTask can throw Access Denied in a plain (non-elevated)
  # PowerShell — common on managed/locked-down machines, and sometimes even on
  # a personal one depending on local policy. Elevation is NOT required to run
  # `epnd` at all, only to make it auto-start via Task Scheduler, so a failure
  # here must not abort an otherwise-successful install: fall back to a
  # per-user Run-key entry (starts epnd at login, no elevation needed) and
  # start it immediately for this session.
  Write-Host ""
  Write-Host "registering epnd as a system service…"

  $exePath = Join-Path $dest 'epnd.exe'
  $taskName = "EPNDaemon"
  $serviceRegistered = $false

  try {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    }

    $startupTrigger = New-ScheduledTaskTrigger -AtStartup
    $taskAction = New-ScheduledTaskAction -Execute $exePath -Argument "serve"
    $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    $task = New-ScheduledTask -Action $taskAction -Trigger $startupTrigger -Settings $taskSettings -Description "EP&N Daemon - auto-starts on boot and auto-restarts on failure"
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

    Write-Host "epnd service registered in Task Scheduler"
    $serviceRegistered = $true
  } catch {
    Write-Warning "Task Scheduler registration failed (Access Denied is common without elevation): $($_.Exception.Message)"
    Write-Host "falling back to a per-user startup entry (starts at login, no elevation needed)…"

    try {
      $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
      Set-ItemProperty -Path $runKey -Name 'EPNDaemon' -Value "`"$exePath`" serve" -Force -ErrorAction Stop
      Write-Host "added login-startup entry (HKCU Run key)"
      $serviceRegistered = $true
    } catch {
      Write-Warning "could not add login-startup entry either: $($_.Exception.Message)"
      Write-Host "you can still run epnd manually: $exePath serve"
    }

    # Start it now regardless, so this session has a running node.
    try {
      Start-Process -FilePath $exePath -ArgumentList 'serve' -WindowStyle Hidden
      Write-Host "started epnd for this session"
    } catch {
      Write-Warning "could not start epnd: $($_.Exception.Message)"
    }

    Write-Host ""
    Write-Host "note: for full auto-start on boot (not just login) and auto-restart on"
    Write-Host "crash, re-run this installer from an Administrator PowerShell:"
    Write-Host "  irm https://raw.githubusercontent.com/50gramx/eapp-releases/main/scripts/install.ps1 | iex"
  }

  # ── install and register auto-update script ────────────────────────────────
  Write-Host "installing auto-update script…"

  $scriptPath = Join-Path $dest 'epnd-autoupdate.ps1'
  try {
    $updateScript = @"
`$ErrorActionPreference = 'Continue'
`$repo = '50gramx/eapp-releases'
`$tag = 'epnd-latest'
`$base = "https://github.com/`$repo/releases/download/`$tag"
`$arch = if ([System.Environment]::Is64BitOperatingSystem) {
  if (`$env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
} else { throw 'unsupported arch' }
`$asset = "epnd-windows-`$arch.exe"
`$dest = Join-Path `$env:LOCALAPPDATA 'epnd'
`$bin = Join-Path `$dest 'epnd.exe'
`$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("epnd-update-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path `$tmp | Out-Null
try {
  try {
    Invoke-WebRequest -Uri "`$base/checksums.txt" -OutFile (Join-Path `$tmp 'checksums.txt') -UseBasicParsing -ErrorAction Stop
  } catch {
    exit 0
  }
  `$line = Select-String -Path (Join-Path `$tmp 'checksums.txt') -Pattern "[ *]`$asset`$" | Select-Object -First 1
  if (-not `$line) { exit 0 }
  `$want = (`$line.Line -split '\s+')[0]
  if (Test-Path `$bin) {
    `$have = (Get-FileHash -Path `$bin -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash.ToLower()
  } else {
    `$have = ""
  }
  if (`$have -eq `$want.ToLower()) { exit 0 }
  Invoke-WebRequest -Uri "`$base/`$asset" -OutFile (Join-Path `$tmp 'epnd.exe') -UseBasicParsing -ErrorAction Stop
  `$got = (Get-FileHash -Path (Join-Path `$tmp 'epnd.exe') -Algorithm SHA256 -ErrorAction Stop).Hash.ToLower()
  if (`$got -ne `$want.ToLower()) { exit 1 }
  Stop-ScheduledTask -TaskName 'EPNDaemon' -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Copy-Item (Join-Path `$tmp 'epnd.exe') `$bin -Force -ErrorAction Stop
  Start-ScheduledTask -TaskName 'EPNDaemon' -ErrorAction SilentlyContinue
} finally {
  Remove-Item -Recurse -Force `$tmp -ErrorAction SilentlyContinue
}
"@
    Set-Content -Path $scriptPath -Value $updateScript -Encoding utf8 -Force
  } catch {
    Write-Warning "could not install auto-update script: $_"
  }

  # Register auto-update task (runs every 15 minutes) — same elevation caveat
  # as the main service task, so this is independently best-effort too.
  $updateTaskName = "EPNDaemonAutoUpdate"
  $autoUpdateRegistered = $false
  try {
    $existingUpdateTask = Get-ScheduledTask -TaskName $updateTaskName -ErrorAction SilentlyContinue
    if ($existingUpdateTask) {
      Unregister-ScheduledTask -TaskName $updateTaskName -Confirm:$false -ErrorAction Stop
    }

    $updateTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30) -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Days 36500)
    $updateAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
    $updateSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
    $updateTask = New-ScheduledTask -Action $updateAction -Trigger $updateTrigger -Settings $updateSettings -Description "EP&N Auto-Update - checks for updates every 15 minutes"
    Register-ScheduledTask -TaskName $updateTaskName -InputObject $updateTask -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $updateTaskName -ErrorAction SilentlyContinue

    Write-Host "auto-update task registered in Task Scheduler"
    $autoUpdateRegistered = $true
  } catch {
    Write-Warning "auto-update task registration failed (needs the same elevation as the service task): $($_.Exception.Message)"
  }

  Write-Host ""
  if ($serviceRegistered -and $autoUpdateRegistered) {
    Write-Host "✓ epnd is installed and running as a system service"
    Write-Host "  • auto-starts on boot"
    Write-Host "  • auto-restarts on crash"
    Write-Host "  • auto-updates every 15 minutes"
  } else {
    Write-Host "✓ epnd is installed and running for this session"
    Write-Host "  • re-run from an Administrator PowerShell for full auto-start/auto-update"
  }
  Write-Host "  • it is already running — do NOT run 'epnd serve' yourself"
  Write-Host "  • run: epnd node list"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
