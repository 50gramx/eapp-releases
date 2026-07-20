#!/usr/bin/env bash
# Check for a newer epnd build; if found, atomically replace the binary and restart the service.
# Runs periodically (every 15 min, matching the CI's aggregate cycle) via launchd/systemd timer.
# Safe for in-flight work: atomic binary swap + graceful service restart.
set -eu

REPO="${EPND_REPO:-50gramx/eapp-releases}"
TAG="${EPND_TAG:-epnd-latest}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
BIN="${EPND_BIN:-/usr/local/bin/epnd}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
# Apple Silicon under a Rosetta shell reports x86_64 — trust the hardware flag,
# not uname, or a node that got the amd64 build will keep pulling amd64 forever
# (its amd64 checksum matches the amd64 target) and never cross back to arm64.
if [ "$os" = "darwin" ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ]; then
  arch="arm64"
fi
case "$arch" in
  x86_64|amd64) arch="amd64" ;;
  aarch64|arm64) arch="arm64" ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
asset="epnd-${os}-${arch}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Fetch the latest checksum and compare against installed binary
curl -fsSL "${BASE}/checksums.txt" -o "$tmp/checksums.txt" 2>/dev/null || { echo "could not fetch checksums.txt" >&2; exit 0; }

# Keep THIS updater script current too, same reasoning as the .ps1 sibling: the
# updater replaces epnd but never itself, so a bug or a missing capability here
# (this file used to have NO macOS restart at all, then had one that silently
# no-ops on modern macOS — see below) could never reach an already-installed
# node without a manual reinstall. Refresh from the published, checksum-verified
# copy; the new logic takes effect on the NEXT run (this run finishes on the old
# file, mv is atomic so nothing mid-execution breaks).
SELF="${EPND_AUTOUPDATE:-}"
if [ -z "$SELF" ]; then
  case "$os" in
    darwin) SELF="$HOME/Library/LaunchAgents/com.50gramx.epnd-autoupdate.sh" ;;
    linux)  SELF="$(dirname "$BIN")/epnd-autoupdate.sh" ;;
  esac
fi
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  selfWant="$(grep "[ *]epnd-autoupdate\.sh\$" "$tmp/checksums.txt" 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$selfWant" ]; then
    if command -v sha256sum >/dev/null 2>&1; then selfHave="$(sha256sum "$SELF" | awk '{print $1}')"
    else selfHave="$(shasum -a 256 "$SELF" | awk '{print $1}')"; fi
    if [ "$selfHave" != "$selfWant" ]; then
      if curl -fsSL "${BASE}/epnd-autoupdate.sh" -o "$tmp/self.sh" 2>/dev/null; then
        if command -v sha256sum >/dev/null 2>&1; then selfGot="$(sha256sum "$tmp/self.sh" | awk '{print $1}')"
        else selfGot="$(shasum -a 256 "$tmp/self.sh" | awk '{print $1}')"; fi
        if [ "$selfGot" = "$selfWant" ]; then
          chmod +x "$tmp/self.sh"
          cp "$tmp/self.sh" "$SELF"
          echo "updated the auto-update script itself (takes effect next run)" >&2
        fi
      fi
    fi
  fi
fi

want="$(grep "[ *]${asset}\$" "$tmp/checksums.txt" 2>/dev/null | awk '{print $1}' || true)"
if [ -z "$want" ]; then
  echo "no checksum entry for ${asset}" >&2
  exit 0
fi

if [ -x "$BIN" ]; then
  if command -v sha256sum >/dev/null 2>&1; then have="$(sha256sum "$BIN" | awk '{print $1}')"
  else have="$(shasum -a 256 "$BIN" | awk '{print $1}')"; fi
else
  have=""
fi

if [ "$have" = "$want" ]; then
  echo "epnd up to date" >&2
  exit 0
fi

echo "new epnd available (have=${have:-none} want=$want) — updating…" >&2
curl -fSL "${BASE}/${asset}" -o "$tmp/epnd" 2>/dev/null || { echo "download failed" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/epnd" | awk '{print $1}')"
else got="$(shasum -a 256 "$tmp/epnd" | awk '{print $1}')"; fi
[ "$got" = "$want" ] || { echo "checksum mismatch" >&2; exit 1; }

chmod +x "$tmp/epnd"
# Atomic swap: write to .new then rename over it
mv "$tmp/epnd" "${BIN}.new"
mv "${BIN}.new" "$BIN"
echo "updated epnd from ${TAG}" >&2

# Restart the service gracefully
os_name="$(uname -s)"
if [ "$os_name" = "Linux" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    # Kill any epnd NOT managed by systemd (a manual run, or a stale process from
    # before this node was serviceified) before restarting — same reasoning as
    # install.sh's Linux path: a lingering unmanaged process holds the
    # single-instance lock, the freshly restarted systemd unit exits immediately
    # on it, and the node silently stays on the OLD build despite "updating".
    pkill -x epnd 2>/dev/null || true
    sleep 1
    systemctl restart epnd || echo "note: systemctl restart failed — check systemctl status epnd" >&2
  fi
elif [ "$os_name" = "Darwin" ]; then
  # `launchctl unload`/`load` SILENTLY NO-OPS on modern macOS (Ventura+) when the
  # label is already registered — this branch used to be exactly that, so the
  # binary was swapped but the OLD process kept running on every auto-update
  # cycle on a current macOS, indefinitely, with no error surfaced anywhere.
  # install.sh already had to solve this same problem for the initial install
  # (see its comment there) via bootout+bootstrap, which actually re-reads state
  # rather than silently no-opping; mirrored here for the periodic restart path,
  # which needs the identical fix for the identical reason.
  gui="gui/$(id -u)"
  label="com.50gramx.epnd"
  launchctl bootout "$gui/$label" 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/${label}.plist" 2>/dev/null || true
  # Kill any epnd not managed by launchd — bootout only stops the launchd-managed
  # instance; a lingering unmanaged process still holds the single-instance lock.
  pkill -x epnd 2>/dev/null || true
  sleep 1
  plist="$HOME/Library/LaunchAgents/${label}.plist"
  if [ -f "$plist" ]; then
    if ! launchctl bootstrap "$gui" "$plist" 2>/dev/null; then
      launchctl load "$plist" 2>/dev/null || echo "note: launchctl bootstrap/load failed — check $plist" >&2
    fi
    launchctl enable "$gui/$label" 2>/dev/null || true
  else
    echo "note: no plist at $plist — restart epnd manually" >&2
  fi
fi
