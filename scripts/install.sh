#!/usr/bin/env bash
# EP&N daemon installer. One-command install on Linux/macOS:
#
#   curl -fsSL https://raw.githubusercontent.com/50gramx/eapp-releases/main/scripts/install.sh | sh
#
# Detects OS/arch, downloads the matching `epnd` release asset from the
# rolling `epnd-latest` tag, verifies its SHA-256, and installs it as a
# system service (auto-start on boot, auto-restart on crash). Override:
#   EPND_TAG       release tag (default: epnd-latest, the rolling build)
#   EPND_INSTALL   install dir (default: /usr/local/bin, or ~/.local/bin)
set -eu

REPO="${EPND_REPO:-50gramx/eapp-releases}"
TAG="${EPND_TAG:-epnd-latest}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

# ── detect platform ───────────────────────────────────────────────────────────
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$os" in
  linux|darwin) ;;
  *) echo "unsupported OS: $os (use the Windows binary instead)" >&2; exit 1 ;;
esac
# On an Apple Silicon Mac, `uname -m` reports x86_64 whenever the SHELL itself is
# running under Rosetta 2 (an Intel Terminal, an Intel-installed curl, an Intel
# CI runner). That would fetch the amd64 binary, which then runs under Rosetta —
# it comes up with a DIFFERENT node identity and cannot manage the arm64 k3s VM,
# so the gram is cluster-blind and never probes. Trust the HARDWARE, not the
# emulated uname: hw.optional.arm64=1 means this is Apple Silicon, period.
if [ "$os" = "darwin" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  arch="arm64"
fi
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac

asset="epnd-${os}-${arch}"
url="${BASE}/${asset}"
sums="${BASE}/checksums.txt"

# ── choose an install dir on PATH ─────────────────────────────────────────────
dest="${EPND_INSTALL:-/usr/local/bin}"
if [ ! -w "$dest" ] 2>/dev/null; then
  if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && [ "${EPND_INSTALL:-}" = "" ]; then
    SUDO="sudo"
  else
    dest="${HOME}/.local/bin"; mkdir -p "$dest"; SUDO=""
    case ":$PATH:" in *":$dest:"*) ;; *) echo "note: add $dest to your PATH" >&2 ;; esac
  fi
else
  SUDO=""
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading ${asset} (${TAG})…" >&2
curl -fSL "$url"  -o "$tmp/epnd"
curl -fSL "$sums" -o "$tmp/checksums.txt" 2>/dev/null || true

# ── verify checksum when checksums.txt is available ───────────────────────────
if [ -s "$tmp/checksums.txt" ]; then
  want="$(grep "[ *]${asset}\$" "$tmp/checksums.txt" 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$want" ]; then
    if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/epnd" | awk '{print $1}')"
    else got="$(shasum -a 256 "$tmp/epnd" | awk '{print $1}')"; fi
    [ "$want" = "$got" ] || { echo "checksum mismatch for ${asset}" >&2; exit 1; }
    echo "checksum verified" >&2
  fi
else
  echo "warning: no checksums.txt found — skipping verification" >&2
fi

chmod +x "$tmp/epnd"
$SUDO mkdir -p "$dest"
$SUDO mv "$tmp/epnd" "$dest/epnd"
echo "installed epnd → $dest/epnd" >&2
"$dest/epnd" version || true

# ── register as a system service ──────────────────────────────────────────────
echo "" >&2
echo "registering epnd as a system service…" >&2

# -- VERIFY, DO NOT ASSERT ---------------------------------------------------
#
# This script used to end with five confident lines -- "running as a system
# service", "auto-updates every 15 minutes" -- none of which it had checked.
# That is how a Mac in this fleet sat on a stale build: `launchctl bootstrap`
# failed, the fallback `launchctl load` printed "Load failed: 5: Input/output
# error" AND STILL EXITED 0 (legacy launchctl reports failure on stderr and
# returns success), so the `||` guard never fired, and the installer told the
# owner the service was running and updating itself while nothing had loaded.
# The owner only found out days later, by hand, when the node was four builds
# behind.
#
# An installer that claims a state it never measured is the same defect as a
# daemon reporting a GPU it never probed. So: every claim below is a check,
# and a claim that cannot be checked is not printed.
svc_ok=0
upd_ok=0

if [ "$os" = "linux" ]; then
  # systemd service file
  service_file="/etc/systemd/system/epnd.service"
  service_content="[Unit]
Description=EP&N Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# --bootstrap so the daemon PROVISIONS the cluster (VM + k3s + inference pods) on
# first start, not just checks for one. EnsureCluster is idempotent (no-op once
# k3s is up) and non-fatal (a machine that can't run k3s degrades to
# remote-inference and reports which step failed via telemetry). Without this a
# fresh node never gets a cluster and can never host its own inference.
ExecStart=$dest/epnd serve --bootstrap
Restart=always
RestartSec=10
User=$(whoami)
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
"
  echo "$service_content" | $SUDO tee "$service_file" > /dev/null

  # Install the auto-update script
  echo "installing auto-update script…" >&2
  curl -fsSL "${BASE}/epnd-autoupdate.sh" -o "$tmp/epnd-autoupdate.sh" 2>/dev/null || true
  if [ -s "$tmp/epnd-autoupdate.sh" ]; then
    chmod +x "$tmp/epnd-autoupdate.sh"
    $SUDO mv "$tmp/epnd-autoupdate.sh" "$dest/epnd-autoupdate.sh"
  fi

  # systemd timer files for 15-minute auto-update cycle
  # The daemon's home, by the rule the daemon itself applies (config.epnHome):
  # EPN_HOME, else ~/.epn of the user the service above runs as.
  kick_home() { echo "${EPN_HOME:-$HOME/.epn}"; }

  autoupdate_service="/etc/systemd/system/epnd-autoupdate.service"
  autoupdate_timer="/etc/systemd/system/epnd-autoupdate.timer"

  service_update="[Unit]
Description=EP&N Auto-Update
After=network-online.target

[Service]
Type=oneshot
ExecStart=$dest/epnd-autoupdate.sh
"
  echo "$service_update" | $SUDO tee "$autoupdate_service" > /dev/null

  timer_content="[Unit]
Description=EP&N Auto-Update Timer
Requires=epnd-autoupdate.service

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
"
  echo "$timer_content" | $SUDO tee "$autoupdate_timer" > /dev/null

  # THE KICK. A running gram that learns a newer build exists -- from a peer's
  # ad, or by polling the release when it is always on -- asks the updater to
  # run now rather than waiting for the timer. It cannot `systemctl start` a
  # system unit as its own user (that needs root or polkit), so it touches one
  # file instead, and this path unit runs the same updater service when the
  # file changes. No authority at runtime; a touch with no watcher is harmless.
  kick_path="/etc/systemd/system/epnd-autoupdate.path"
  # Two files are watched: the daemon's home, which is the one directory a
  # sandboxed unit (ProtectSystem=strict, ReadWritePaths=<home>) can write,
  # and /tmp for a daemon whose unit is looser. The service and this unit
  # agree on the home through the same rule: EPN_HOME, else ~/.epn of the
  # installing user.
  kick_content="[Unit]
Description=EP&N Auto-Update Kick (a running gram asks for a check now)

[Path]
PathModified=$(kick_home)/kick-update
PathModified=/tmp/epnd-kick-update
Unit=epnd-autoupdate.service

[Install]
WantedBy=paths.target
"
  echo "$kick_content" | $SUDO tee "$kick_path" > /dev/null

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable epnd
  # Kill any epnd NOT managed by systemd (a manual `epnd serve` or a stale
  # process) so it releases the single-instance lock; otherwise `restart` starts
  # a new daemon that exits immediately on the held lock, leaving the node on the
  # OLD build. Then restart (not start — start is a no-op if already running, so a
  # re-run would never pick up the new binary).
  $SUDO pkill -x epnd 2>/dev/null || true
  sleep 1
  $SUDO systemctl restart epnd
  $SUDO systemctl enable epnd-autoupdate.timer
  $SUDO systemctl restart epnd-autoupdate.timer
  $SUDO systemctl enable epnd-autoupdate.path
  $SUDO systemctl restart epnd-autoupdate.path

  # `systemctl restart` can exit 0 on a unit that then dies in its first
  # seconds. Ask the unit what it IS, rather than trusting the command that
  # was supposed to have made it so.
  systemctl is-active --quiet epnd 2>/dev/null && svc_ok=1
  systemctl is-active --quiet epnd-autoupdate.timer 2>/dev/null && upd_ok=1
  [ "$svc_ok" = 1 ] || echo "epnd.service is not active - systemctl status epnd" >&2
  [ "$upd_ok" = 1 ] || echo "epnd-autoupdate.timer is not active - systemctl status epnd-autoupdate.timer" >&2

elif [ "$os" = "darwin" ]; then
  # launchd plist for macOS — substitute the path BEFORE writing
  plist_file="$HOME/Library/LaunchAgents/com.50gramx.epnd.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.50gramx.epnd</string>
    <key>ProgramArguments</key>
    <array>
        <string>$dest/epnd</string>
        <string>serve</string>
        <!-- provision the cluster on first start; idempotent + non-fatal -->
        <string>--bootstrap</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <!-- The daemon infers how it was started from whether stdin is a
             character device. launchd gets that right, but saying it outright
             costs nothing and keeps every platform reporting the same way. -->
        <key>EPN_LAUNCH</key>
        <string>service</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>/tmp/epnd.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/epnd.err</string>
</dict>
</plist>
EOF
  # Reload the agent. On modern macOS (Ventura+), `launchctl unload`/`load`
  # SILENTLY NO-OPS for an already-registered label — so a re-run swaps the binary
  # but the OLD argument list (e.g. `serve` without `--bootstrap`) stays active and
  # the node never provisions a cluster. Use bootout+bootstrap (the current API),
  # which actually re-reads the plist; fall back to unload/load on older systems.
  gui="gui/$(id -u)"
  launchctl bootout "$gui/com.50gramx.epnd" 2>/dev/null || launchctl unload "$plist_file" 2>/dev/null || true
  # Kill any epnd NOT managed by launchd (a manual `epnd serve` or a stale
  # process). bootout only stops the launchd-managed daemon; a lingering process
  # keeps the single-instance lock, so the freshly-loaded daemon exits at once and
  # the node stays on the OLD build — exactly the "re-ran the installer but still
  # old" symptom.
  pkill -x epnd 2>/dev/null || true
  sleep 1
  if ! launchctl bootstrap "$gui" "$plist_file" 2>&1; then
    # THE FALLBACK'S EXIT CODE IS NOT EVIDENCE. `launchctl load` prints
    # "Load failed: <errno>: ..." on stderr and exits 0 anyway. Run it, let
    # the owner see what it says, and decide from the domain afterwards --
    # never from `||`, which is what silently passed a failed load for months.
    launchctl load "$plist_file" 2>&1 || true
  fi
  launchctl enable "$gui/com.50gramx.epnd" 2>/dev/null || true

  # Install auto-update script for macOS
  echo "installing auto-update script…" >&2
  curl -fsSL "${BASE}/epnd-autoupdate.sh" -o "$tmp/epnd-autoupdate.sh" 2>/dev/null || true
  if [ -s "$tmp/epnd-autoupdate.sh" ]; then
    chmod +x "$tmp/epnd-autoupdate.sh"
    cp "$tmp/epnd-autoupdate.sh" "$HOME/Library/LaunchAgents/com.50gramx.epnd-autoupdate.sh"
  fi

  # launchd timer plist (runs every 15 minutes — 900 seconds)
  autoupdate_plist="$HOME/Library/LaunchAgents/com.50gramx.epnd-autoupdate.plist"
  cat > "$autoupdate_plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.50gramx.epnd-autoupdate</string>
    <key>ProgramArguments</key>
    <array>
        <string>$HOME/Library/LaunchAgents/com.50gramx.epnd-autoupdate.sh</string>
    </array>
    <!-- StartCalendarInterval, NOT StartInterval, and the difference is the
         whole reason this fleet's Mac stopped updating.

         launchd.plist(5) says of StartInterval: a firing that lands while the
         machine is asleep is MISSED, "due to shortcomings in kqueue(3)". Not
         deferred, not coalesced, not fired on wake -- lost, silently, with
         nothing recorded. A laptop that sleeps through four windows simply
         does not update, and its scheduler reports no error because nothing
         failed. That is exactly what was observed: a 75-minute gap against a
         900-second interval, and launchd saying "registered, has not run, no
         reason given".

         StartCalendarInterval is the key the Leopard-era wake handling was
         applied to: a missed calendar firing runs once on wake. Four entries
         express the same fifteen minutes and survive sleep. -->
    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Minute</key><integer>0</integer></dict>
        <dict><key>Minute</key><integer>15</integer></dict>
        <dict><key>Minute</key><integer>30</integer></dict>
        <dict><key>Minute</key><integer>45</integer></dict>
    </array>
    <key>StandardOutPath</key>
    <string>/tmp/epnd-autoupdate.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/epnd-autoupdate.err</string>
</dict>
</plist>
EOF
  launchctl bootout "$gui/com.50gramx.epnd-autoupdate" 2>/dev/null || launchctl unload "$autoupdate_plist" 2>/dev/null || true
  if ! launchctl bootstrap "$gui" "$autoupdate_plist" 2>&1; then
    launchctl load "$autoupdate_plist" 2>&1 || true
  fi

  # Now ASK THE DOMAIN what is actually loaded. This is the only statement in
  # this script about launchd that is worth anything: `launchctl print` fails
  # when the label is not there, whatever the loader claimed about itself.
  launchd_has() {
    launchctl print "$gui/$1" >/dev/null 2>&1 || launchctl list "$1" >/dev/null 2>&1
  }
  launchd_has com.50gramx.epnd && svc_ok=1
  launchd_has com.50gramx.epnd-autoupdate && upd_ok=1

  if [ "$svc_ok" != 1 ]; then
    echo "" >&2
    echo "epnd did NOT load as a service. The binary is installed at $dest/epnd," >&2
    echo "but nothing is running it and nothing will update it." >&2
    echo "  fix: launchctl bootout $gui/com.50gramx.epnd; launchctl bootstrap $gui $plist_file" >&2
  fi
  if [ "$upd_ok" != 1 ]; then
    echo "" >&2
    echo "the 15-minute auto-update timer did NOT load. This machine will stay on" >&2
    echo "the build it has until somebody re-runs this installer by hand." >&2
    echo "  fix: launchctl bootstrap $gui $autoupdate_plist" >&2
  fi
fi

echo "" >&2
if [ "$svc_ok" = 1 ] && [ "$upd_ok" = 1 ]; then
  echo "✓ epnd is installed and running as a system service" >&2
  echo "  • auto-starts on boot" >&2
  echo "  • auto-restarts on crash" >&2
  echo "  • auto-updates every 15 minutes" >&2
  echo "  • it is already running — do NOT run 'epnd serve' yourself" >&2
  echo "  • run: epnd node list" >&2
elif [ "$svc_ok" = 1 ]; then
  # A running daemon that cannot update itself is the failure this fleet
  # actually had, and it is worth its own exit code: the machine works today
  # and silently falls behind forever.
  echo "⚠ epnd is running, but it will NOT auto-update." >&2
  echo "  Apply the fix above, or re-run this installer whenever you want a" >&2
  echo "  newer build." >&2
  echo "  • run: epnd node list" >&2
  exit 1
else
  echo "⚠ epnd is installed at $dest/epnd but is NOT running as a service." >&2
  echo "  Nothing above succeeded in starting it. Apply the fix printed above." >&2
  exit 1
fi
