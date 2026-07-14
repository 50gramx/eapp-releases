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

if [ "$os" = "linux" ]; then
  # systemd service file
  service_file="/etc/systemd/system/epnd.service"
  service_content="[Unit]
Description=EP&N Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$dest/epnd serve
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

  $SUDO systemctl daemon-reload
  $SUDO systemctl enable epnd
  $SUDO systemctl start epnd
  $SUDO systemctl enable epnd-autoupdate.timer
  $SUDO systemctl start epnd-autoupdate.timer
  echo "epnd service and auto-update timer registered" >&2

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
    </array>
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
  launchctl unload "$plist_file" 2>/dev/null || true
  launchctl load "$plist_file" 2>&1 || { echo "launchctl load failed — you may need to run: launchctl bootstrap gui/$(id -u) $plist_file" >&2; exit 1; }

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
    <key>StartInterval</key>
    <integer>900</integer>
    <key>StandardOutPath</key>
    <string>/tmp/epnd-autoupdate.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/epnd-autoupdate.err</string>
</dict>
</plist>
EOF
  launchctl unload "$autoupdate_plist" 2>/dev/null || true
  launchctl load "$autoupdate_plist" 2>/dev/null || echo "note: launchctl load autoupdate failed — you may need to manually load $autoupdate_plist" >&2

  echo "epnd service and auto-update timer registered via launchd" >&2
fi

echo "" >&2
echo "✓ epnd is installed and running as a system service" >&2
echo "  • auto-starts on boot" >&2
echo "  • auto-restarts on crash" >&2
echo "  • auto-updates every 15 minutes" >&2
echo "  • it is already running — do NOT run 'epnd serve' yourself" >&2
echo "  • run: epnd node list" >&2
