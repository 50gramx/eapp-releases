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
    systemctl restart epnd || echo "note: systemctl restart failed — check systemctl status epnd" >&2
  fi
elif [ "$os_name" = "Darwin" ]; then
  # macOS: launchctl unload/load to restart
  launchctl unload ~/Library/LaunchAgents/com.50gramx.epnd.plist 2>/dev/null || true
  launchctl load ~/Library/LaunchAgents/com.50gramx.epnd.plist 2>/dev/null || echo "note: launchctl load failed — check ~/Library/LaunchAgents/com.50gramx.epnd.plist" >&2
fi
