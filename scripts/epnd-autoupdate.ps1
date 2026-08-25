<#
Check for a newer epnd build; if found, stop the service, replace the binary,
and restart it. Runs periodically (every 15 min) via Task Scheduler.
Safe for in-flight work: atomic binary swap + graceful service restart.
#>
$ErrorActionPreference = 'Continue'

# Keep THIS updater script current too. The updater replaces epnd.exe but never
# itself, so a bug in the updater -- like the em dash on line 79 that Windows
# PowerShell decoded as a smart quote, ending the string early and derailing the
# parse of everything after it -- could never be fixed remotely. Every node would
# need a manual reinstall.
#
# ALWAYS CALLED LAST. Replacing the file the engine is currently reading can
# derail the rest of the run; deferring costs one cycle and removes the hazard.
# The new logic takes effect on the next run.
function Update-Self {
  param([string]$Base, [string]$SumsPath, [string]$Tmp)

  if (-not $PSCommandPath) { return }
  $selfLine = Select-String -Path $SumsPath -Pattern "[ *]epnd-autoupdate.ps1$" | Select-Object -First 1
  if (-not $selfLine) { return }

  $selfWant = (($selfLine.Line -split '\s+')[0]).ToLower()
  $selfHave = (Get-FileHash -Path $PSCommandPath -Algorithm SHA256 -ErrorAction SilentlyContinue).Hash.ToLower()
  if ($selfHave -eq $selfWant) { return }

  try {
    Invoke-WebRequest -Uri "$Base/epnd-autoupdate.ps1" -OutFile (Join-Path $Tmp 'self.ps1') -UseBasicParsing -ErrorAction Stop
    $selfGot = (Get-FileHash -Path (Join-Path $Tmp 'self.ps1') -Algorithm SHA256).Hash.ToLower()
    if ($selfGot -ne $selfWant) { return }

    # A published script must be pure ASCII (the build enforces it). Refusing a
    # non-ASCII one here too means a bad publish cannot brick the updater on the
    # machines that already have a working copy.
    $bytes = [System.IO.File]::ReadAllBytes((Join-Path $Tmp 'self.ps1'))
    if ($bytes | Where-Object { $_ -gt 127 }) {
      Write-Host "refusing a non-ASCII updater script -- keeping the working copy" -ForegroundColor Yellow
      return
    }

    Copy-Item (Join-Path $Tmp 'self.ps1') $PSCommandPath -Force -ErrorAction Stop
    Write-Host "updated the auto-update script itself; it takes effect next run" -ForegroundColor Green
  } catch {
    Write-Host "note: could not self-update the updater script" -ForegroundColor Gray
  }
}

# Repair the Task Scheduler entries THIS node already has.
#
# WHY THIS RUNS ON EVERY PASS, BEFORE ANYTHING ELSE
#
# New-ScheduledTaskSettingsSet defaults DisallowStartIfOnBatteries and
# StopIfGoingOnBatteries to true, and install.ps1 never overrode them. On a
# laptop that means: install on AC and it runs; unplug and Windows STOPS the
# daemon; and it will not start again while on battery. The only trigger was
# -AtStartup, so even a reboot on battery did not bring it back. That is the
# "connected for exactly one day, never seen again" pattern across most of the
# fleet -- not users uninstalling, which they have no way to do.
#
# Fixing install.ps1 only helps machines that install AGAIN. This function is
# how the fix reaches the machines already out there: the updater self-updates,
# so a node that gets one updater pass repairs its own tasks permanently and
# revives its daemon. It needs no network and no new binary, so it runs before
# the checksum fetch and before the up-to-date exit.
function Repair-GramTasks {
  $script:NeedsElevation = $false
  $repaired = @()
  foreach ($name in @('GramNode', 'GramNodeAutoUpdate')) {
    try {
      $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
      if (-not $t) { continue }

      $why = @()
      if ($t.Settings.DisallowStartIfOnBatteries) { $why += 'battery-start' }
      if ($t.Settings.StopIfGoingOnBatteries)     { $why += 'battery-stop' }
      # PT0S is "no limit". Anything else (PT72H by default) force-kills a
      # long-running daemon; for the updater it is merely wrong.
      if ($t.Settings.ExecutionTimeLimit -and $t.Settings.ExecutionTimeLimit -ne 'PT0S') { $why += 'exec-limit' }

      $triggers = @($t.Triggers)
      $needLogon = $false
      if ($name -eq 'GramNode') {
        $hasLogon = $false
        foreach ($tr in $triggers) {
          if ($tr.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') { $hasLogon = $true }
        }
        if (-not $hasLogon) { $needLogon = $true; $why += 'no-logon-trigger' }
      }

      if ($why.Count -eq 0) { continue }

      $t.Settings.DisallowStartIfOnBatteries = $false
      $t.Settings.StopIfGoingOnBatteries = $false
      $t.Settings.ExecutionTimeLimit = 'PT0S'
      if ($needLogon) { $triggers += (New-ScheduledTaskTrigger -AtLogOn) }

      Set-ScheduledTask -TaskName $name -Settings $t.Settings -Trigger $triggers -ErrorAction Stop | Out-Null
      $repaired += "$name[$($why -join '+')]"
      Write-Host "repaired scheduled task $name ($($why -join ', '))" -ForegroundColor Green
    } catch {
      # ACCESS DENIED IS THE EXPECTED FAILURE, NOT AN ANOMALY.
      #
      # Tasks in the root folder can only be modified with elevation, and this
      # updater runs S4U / RunLevel Limited -- deliberately, because a
      # background updater must never raise a UAC prompt. So on an existing
      # node the settings CANNOT be repaired from here. Say so precisely and
      # record it, because "this node repaired itself" and "this node needs a
      # re-install to survive being unplugged" are different facts and the
      # fleet has to be able to count them separately.
      if ($_.Exception.Message -match 'Access is denied') {
        $script:NeedsElevation = $true
        Write-Host "task ${name} needs elevation to repair -- using the logon-startup entry instead" -ForegroundColor Yellow
      } else {
        Write-Host "note: could not repair task ${name}: $($_.Exception.Message)" -ForegroundColor Gray
      }
    }
  }
  return $repaired
}

# Persistence that needs NO elevation and no Task Scheduler at all.
#
# THIS IS THE PART THAT ACTUALLY REACHES EXISTING NODES.
#
# Repairing the registered task requires elevation, and this updater runs
# Limited on purpose (a background updater must never raise a UAC prompt). So on
# a node that is already installed the task settings CANNOT be fixed from here,
# and telling the user to re-install is not a fix -- it is the same dead end
# they are already in.
#
# HKCU\...\CurrentVersion\Run is writable by any user, unelevated, on every
# supported Windows version. An entry here starts the node at every logon
# regardless of what Task Scheduler thinks about battery policy, which is the
# single condition that kept these machines down: DisallowStartIfOnBatteries
# does not merely stop a running node, it REFUSES TO START ONE, so a laptop that
# reboots on battery never comes back.
#
# install.ps1 has always had this as its non-elevated fallback; it was simply
# never applied to nodes that took the Task Scheduler path. Belt and braces: the
# task starts it on AC, the Run key starts it everywhere else. Both point at the
# same command, and epnd's own serve.lock keeps a second copy from running.
function Set-LogonEntry {
  param([string]$Bin, [string]$Dest)
  try {
    $log = Join-Path $Dest 'logs\epnd.log'
    $val = 'cmd.exe /c "' + '"' + $Bin + '" serve --bootstrap >> "' + $log + '" 2>&1' + '"'
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $existing = (Get-ItemProperty -Path $runKey -Name 'GramNode' -ErrorAction SilentlyContinue).GramNode
    if ($existing -eq $val) { return $false }
    Set-ItemProperty -Path $runKey -Name 'GramNode' -Value $val -Force -ErrorAction Stop
    Write-Host "installed logon-startup entry (HKCU Run) -- node now starts on battery too" -ForegroundColor Green
    return $true
  } catch {
    Write-Host "note: could not set the logon-startup entry: $($_.Exception.Message)" -ForegroundColor Gray
    return $false
  }
}

# Start the node now if it is not running.
#
# Started DIRECTLY, not via Start-ScheduledTask: an on-demand task run is
# refused under DisallowStartIfOnBatteries just as a triggered one is, so on the
# machines that need this most the task route does nothing. Start-Process is
# subject to no such policy.
function Resume-GramNode {
  param([string]$Bin, [string]$Dest)
  try {
    $procs = @(Get-CimInstance Win32_Process -Filter "Name='epnd.exe'" -ErrorAction SilentlyContinue)
    $mine = @($procs | Where-Object { $_.ExecutablePath -eq $Bin })
    if ($mine.Count -gt 0) { return $false }
    # AN UNREADABLE PATH IS NOT AN ABSENT NODE.
    #
    # Win32_Process.ExecutablePath comes back EMPTY for a process this token
    # cannot open -- which is the normal case here, because the node was started
    # by the scheduled task and this updater runs Limited. Path-matching alone
    # therefore concluded "not running" on every single pass and launched
    # another copy every 15 minutes. Only serve.lock stopped that from becoming
    # a pile of half-started nodes. If an epnd.exe exists at all and we cannot
    # prove it is not ours, leave it alone: a missed restart costs one cycle, a
    # spurious one costs a process every quarter hour, forever.
    if ($procs.Count -gt 0) { return $false }
    if (-not (Test-Path $Bin)) { return $false }
    $logDir = Join-Path $Dest 'logs'
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    # --bootstrap, matching every other launch path. A bare `serve` would give a
    # node that never provisions a cluster, and two launch paths for one install
    # must not disagree about what the node is.
    Start-Process -FilePath $Bin -ArgumentList 'serve','--bootstrap' -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $logDir 'epnd.log') `
      -RedirectStandardError  (Join-Path $logDir 'epnd.err') -ErrorAction Stop
    Write-Host "node was not running -- started it" -ForegroundColor Green
    return $true
  } catch {
    Write-Host "note: could not start the node: $($_.Exception.Message)" -ForegroundColor Gray
    return $false
  }
}

# Leave a durable, machine-readable trace so a revival is visible as a FACT and
# not as an inference from a node reappearing. Written next to the binary and,
# when it exists, into EPN_HOME where the daemon's own state lives.
function Write-FleetEvent {
  param([string]$Dest, [string[]]$Repaired, [bool]$Started, [bool]$NeedsElevation, [bool]$LogonEntry)
  if ($Repaired.Count -eq 0 -and -not $Started -and -not $NeedsElevation -and -not $LogonEntry) { return }
  try {
    $evt = [ordered]@{
      at       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      source   = 'epnd-autoupdate.ps1'
      event    = 'windows_task_repair'
      repaired = $Repaired
      started  = $Started
      # True means: this node is still carrying the power settings that stop it
      # on battery, and only a re-install can clear them.
      needs_elevation = $NeedsElevation
      # The elevation-free repair: node now starts at logon regardless of the
      # task's battery policy.
      logon_entry = $LogonEntry
      os       = 'windows'
    }
    $line = ($evt | ConvertTo-Json -Compress -Depth 4)
    foreach ($dir in @($Dest, $env:EPN_HOME)) {
      if ($dir -and (Test-Path $dir)) {
        Add-Content -Path (Join-Path $dir 'fleet-events.jsonl') -Value $line -Encoding utf8 -ErrorAction SilentlyContinue
      }
    }
    Write-Host "fleet event recorded: windows_task_repair" -ForegroundColor Green
  } catch {
    Write-Host "note: could not record the fleet event" -ForegroundColor Gray
  }
}

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

# BEFORE the network, and before any early exit: a node whose tasks are broken
# needs repairing whether or not a new binary exists, and whether or not GitHub
# is reachable at this moment.
$repaired = Repair-GramTasks
$logonEntry = Set-LogonEntry -Bin $bin -Dest $dest
$started = Resume-GramNode -Bin $bin -Dest $dest
Write-FleetEvent -Dest $dest -Repaired $repaired -Started $started -NeedsElevation $script:NeedsElevation -LogonEntry $logonEntry

try {
  # Fetch the latest checksum
  try {
    Invoke-WebRequest -Uri $sums -OutFile (Join-Path $tmp 'checksums.txt') -UseBasicParsing -ErrorAction Stop
  } catch {
    Write-Host "could not fetch checksums.txt" -ForegroundColor Gray
    exit 0
  }

  # THE SELF-UPDATE RUNS LAST, NOT HERE. See Update-Self at the end of this file.
  #
  # It used to run at this point, and rewriting the file PowerShell is CURRENTLY
  # EXECUTING is a real hazard: the engine reads a script incrementally, so
  # replacing the bytes underneath it can derail the rest of the run. Deferring it
  # to the very end costs one update cycle and removes the hazard entirely.

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

  # UP TO DATE IS NOT DONE. This used to `exit 0` here, which meant Update-Self
  # -- the only thing that can ever fix the updater itself -- ran ONLY when a
  # binary update happened. A fleet that is current on the binary could never
  # receive a fix to this script, which is precisely the fleet we have. Fall
  # through to the self-update at the end instead of leaving.
  $binaryCurrent = ($have -eq $want.ToLower())
  if ($binaryCurrent) {
    Write-Host "epnd up to date" -ForegroundColor Gray
  } else {

  Write-Host "new epnd available (have=$($have.Substring(0,8))... want=$($want.Substring(0,8))...) -- updating..." -ForegroundColor Yellow

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
  # binary file-locked -- which made the in-place swap fail and the node silently
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
  }

  # ALWAYS LAST, and now always REACHED. See the note on the up-to-date branch.
  Update-Self -Base $base -SumsPath (Join-Path $tmp 'checksums.txt') -Tmp $tmp
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
