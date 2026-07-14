<#
Gram (EP&N) node installer for Windows. One-command install:

  irm https://raw.githubusercontent.com/50gramx/eapp-releases/main/scripts/install.ps1 | iex

Downloads the matching `epnd` release asset from the rolling `epnd-latest`
tag on the public eapp-releases repo, verifies its SHA-256, and installs it
as a background service (auto-start on boot, auto-restart on crash, no
visible window). Override via env vars before piping to iex:
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

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("gram-install-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  Write-Host "downloading Gram node ($tag)…"
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
  Write-Host "installed Gram node -> $dest\epnd.exe"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $dest) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dest", 'User')
    Write-Host "added $dest to your User PATH (open a new terminal to pick it up)"
  }

  & (Join-Path $dest 'epnd.exe') version 2>$null

  # ── register as a background service (Task Scheduler) ────────────────────────
  # Two separate concerns, both best-effort so a failure in either never aborts
  # an otherwise-successful install:
  #
  # 1. Access Denied — Register-ScheduledTask can throw this in a plain
  #    (non-elevated) PowerShell. Elevation is NOT required to run the node at
  #    all, only to make it auto-start via Task Scheduler.
  #
  # 2. Visible console window — a scheduled task launching a console .exe runs
  #    it under an INTERACTIVE logon token by default, which pops a real
  #    console window in the user's session. Closing that window sends
  #    CTRL_CLOSE and kills the process — not what "background service" means.
  #    -LogonType S4U runs the task in a non-interactive session: no window,
  #    and nothing to accidentally close.
  Write-Host ""
  Write-Host "registering Gram node as a background service…"

  $exePath = Join-Path $dest 'epnd.exe'
  $taskName = "GramNode"
  $serviceRegistered = $false

  # A hidden (S4U) task has no console to show output in — without redirecting
  # somewhere, `serve`'s logs (engine spin-up, k3s provisioning failures, probe
  # results) are simply gone, and there is no way to tell a running-but-silent
  # node from one whose engine never came up.
  $logDir = Join-Path $dest 'logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $logPath = Join-Path $logDir 'epnd.log'
  $wrappedArg = "/c `"`"$exePath`" serve >> `"$logPath`" 2>&1`""

  # Clean up the old pre-rebrand task name if present, so upgrading doesn't
  # leave two overlapping schedules.
  Get-ScheduledTask -TaskName 'EPNDaemon' -ErrorAction SilentlyContinue |
    Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue

  try {
    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    }

    $startupTrigger = New-ScheduledTaskTrigger -AtStartup
    $taskAction = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $wrappedArg
    $taskSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
    $task = New-ScheduledTask -Action $taskAction -Trigger $startupTrigger -Settings $taskSettings -Principal $taskPrincipal -Description "Gram node — auto-starts on boot and auto-restarts on failure, runs hidden"
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop

    Write-Host "Gram node registered in Task Scheduler (runs hidden, no console window)"
    Write-Host "logs: $logPath"
    $serviceRegistered = $true
  } catch {
    Write-Warning "Task Scheduler registration failed (Access Denied is common without elevation): $($_.Exception.Message)"
    Write-Host "falling back to a per-user startup entry (starts at login, no elevation needed)…"

    try {
      $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
      Set-ItemProperty -Path $runKey -Name 'GramNode' -Value "cmd.exe $wrappedArg" -Force -ErrorAction Stop
      Write-Host "added login-startup entry (HKCU Run key)"
      $serviceRegistered = $true
    } catch {
      Write-Warning "could not add login-startup entry either: $($_.Exception.Message)"
      Write-Host "you can still run the node manually: $exePath serve"
    }

    # Start it now regardless, so this session has a running node — hidden,
    # same as the Task Scheduler path, logs to the same file.
    try {
      Start-Process -FilePath $exePath -ArgumentList 'serve' -WindowStyle Hidden -RedirectStandardOutput $logPath -RedirectStandardError "$logPath.err"
      Write-Host "started Gram node for this session — logs: $logPath"
    } catch {
      Write-Warning "could not start Gram node: $($_.Exception.Message)"
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
`$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("gram-update-" + [System.Guid]::NewGuid())
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
  Stop-ScheduledTask -TaskName 'GramNode' -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Copy-Item (Join-Path `$tmp 'epnd.exe') `$bin -Force -ErrorAction Stop
  Start-ScheduledTask -TaskName 'GramNode' -ErrorAction SilentlyContinue
} finally {
  Remove-Item -Recurse -Force `$tmp -ErrorAction SilentlyContinue
}
"@
    Set-Content -Path $scriptPath -Value $updateScript -Encoding utf8 -Force
  } catch {
    Write-Warning "could not install auto-update script: $_"
  }

  # Register auto-update task (runs every 15 minutes) — same elevation and
  # hidden-window handling as the main service task, independently best-effort.
  #
  # No -RepetitionDuration: Task Scheduler's XML serializer rejects the
  # ~100-year duration `New-TimeSpan -Days 36500` produces ("value ...
  # incorrectly formatted or out of range", P36500D). Omitting it entirely
  # means "repeat forever" — exactly what's wanted, and it's valid XML.
  $updateTaskName = "GramNodeAutoUpdate"
  $autoUpdateRegistered = $false

  Get-ScheduledTask -TaskName 'EPNDaemonAutoUpdate' -ErrorAction SilentlyContinue |
    Unregister-ScheduledTask -Confirm:$false -ErrorAction SilentlyContinue

  try {
    $existingUpdateTask = Get-ScheduledTask -TaskName $updateTaskName -ErrorAction SilentlyContinue
    if ($existingUpdateTask) {
      Unregister-ScheduledTask -TaskName $updateTaskName -Confirm:$false -ErrorAction Stop
    }

    $updateTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30) -RepetitionInterval (New-TimeSpan -Minutes 15)
    $updateAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
    $updateSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
    $updatePrincipal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
    $updateTask = New-ScheduledTask -Action $updateAction -Trigger $updateTrigger -Settings $updateSettings -Principal $updatePrincipal -Description "Gram node auto-update — checks for updates every 15 minutes"
    Register-ScheduledTask -TaskName $updateTaskName -InputObject $updateTask -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName $updateTaskName -ErrorAction SilentlyContinue

    Write-Host "auto-update task registered in Task Scheduler"
    $autoUpdateRegistered = $true
  } catch {
    Write-Warning "auto-update task registration failed (needs the same elevation as the service task): $($_.Exception.Message)"
  }

  Write-Host ""
  if ($serviceRegistered -and $autoUpdateRegistered) {
    Write-Host "✓ Gram node is installed and running in the background"
    Write-Host "  • auto-starts on boot"
    Write-Host "  • auto-restarts on crash"
    Write-Host "  • auto-updates every 15 minutes"
    Write-Host "  • no visible window — it runs hidden, closing a terminal does not stop it"
    Write-Host "  • logs: $logPath"
  } else {
    Write-Host "✓ Gram node is installed and running for this session"
    Write-Host "  • re-run from an Administrator PowerShell for full auto-start/auto-update"
  }
  Write-Host "  • run: epnd node list"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
