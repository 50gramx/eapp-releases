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
os_name="$(uname -s)"
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

# ── REPORTING A NODE THAT NEVER CAME BACK ─────────────────────────────────────
#
# The daemon reports the fleet's telemetry, so a node whose daemon does not start
# reports NOTHING — it simply stops appearing, indistinguishable from a laptop
# that was closed. That is the one failure this script can cause and the one it
# could not describe. epnd already drains $EPN_HOME/fleet-events.jsonl into a
# milestone on its next start (internal/telemetry/updater_events.go), which the
# Windows updater has used for a while; this is the same channel for unix. It is
# only read once the daemon runs again, which is exactly right: the event that
# matters is "this node had to be resurrected", and it is delivered by the
# resurrection itself.
fleet_event() { # $1 event, $2 started(true|false), $3 repaired-item, $4 needs_attention(true|false)
  _home="${EPN_HOME:-$HOME/.epn}"
  [ -d "$_home" ] || return 0
  printf '{"at":"%s","source":"epnd-autoupdate.sh","event":"%s","repaired":["%s"],"started":%s,"needs_attention":%s,"os":"%s"}
'     "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$3" "$2" "${4:-false}" "$os" >> "$_home/fleet-events.jsonl" 2>/dev/null || true
}

epnd_running() { pgrep -x epnd >/dev/null 2>&1; }

# -- THE HEARTBEAT: "IS THIS NODE'S UPDATER RUNNING AT ALL?" -------------------
#
# fleet_event reports what was REPAIRED, which is the right channel for a repair
# and the wrong one for the question the fleet keeps asking. An updater that
# runs every fifteen minutes and finds nothing to do writes NOTHING, so a node
# whose updater died six weeks ago and a node whose updater ran ninety seconds
# ago ship byte-identical telemetry: silence.
#
# Two grams in this fleet sat behind by six weeks and one working day and
# neither could be told apart from a healthy one without reading a scheduled
# task on the machine itself -- the manual step this system exists to remove.
#
# So stamp what was seen on EVERY run, satisfied or not. Unlike fleet-events
# this file is READ by the daemon, never drained: the current value is the fact.
epnd_home() { echo "${EPN_HOME:-$HOME/.epn}"; }

# bin_version asks the binary on disk what it is. "epnd version" prints
# "epnd <sha>"; anything else -- an older build, a binary that will not exec on
# this machine -- yields the empty string, reported as unknown rather than
# guessed at.
bin_version() {
  [ -x "$BIN" ] || return 0
  "$BIN" version 2>/dev/null | awk 'NR==1 && $1=="epnd" {print $2}' || true
}

# running_version asks the DAEMON what it is running, which no script can work
# out by itself -- a process does not carry the commit it was built from. The
# daemon stamps it at startup (telemetry.WriteRunningState).
#
# The PID is checked because the stamp OUTLIVES the process that wrote it: a
# daemon killed by an OOM leaves behind a stamp claiming a version nothing is
# serving, and restarting a node on the strength of a dead process's paperwork
# is exactly the confident wrong action this script must not take.
running_version() {
  _rs="$(epnd_home)/running.json"
  [ -f "$_rs" ] || return 0
  _pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$_rs" 2>/dev/null | head -1)"
  [ -n "$_pid" ] || return 0
  kill -0 "$_pid" 2>/dev/null || return 0
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_rs" 2>/dev/null | head -1 || true
}

# write_updater_state records this run. Best-effort and silent: a node that
# cannot write a heartbeat is still a node, and failing an update over
# diagnostics would turn an observability gap into an outage.
write_updater_state() { # $1 action, $2 behind_upstream(true|false)
  _home="$(epnd_home)"
  [ -d "$_home" ] || return 0
  _od="$(bin_version)"
  _rv="$(running_version)"
  printf '{"at":"%s","asset":"%s","on_disk":"%s","running":"%s","behind_upstream":%s,"action":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$asset" "${_od:-}" "${_rv:-}" "${2:-false}" "$1" \
    > "${_home}/updater-state.json.tmp" 2>/dev/null || return 0
  # Renamed into place so the daemon never reads a half-written stamp and
  # concludes this node is running a build it is not.
  mv -f "${_home}/updater-state.json.tmp" "${_home}/updater-state.json" 2>/dev/null || true
}

# start_epnd brings the daemon up through its service manager and CONFIRMS it.
#
# The macOS path used to fire and forget: bootout + pkill kill the daemon
# unconditionally, and if the following bootstrap failed the script echoed a note
# to stderr — into launchd's void, where nothing reads it — and left the machine
# with no daemon at all until a human noticed. bootout is also asynchronous, so
# bootstrapping the same label immediately after it can fail with a busy/IO error
# purely as a race, which is precisely the case where the old process is already
# gone. So: retry, and verify by looking for the process rather than trusting the
# exit status of a command that is documented to succeed without starting
# anything.
start_epnd() {
  attempt=1
  while [ "$attempt" -le 5 ]; do
    case "$os_name" in
      Linux)
        command -v systemctl >/dev/null 2>&1 && systemctl restart epnd 2>/dev/null || true
        ;;
      Darwin)
        gui="gui/$(id -u)"
        label="com.50gramx.epnd"
        plist="$HOME/Library/LaunchAgents/${label}.plist"
        if [ -f "$plist" ]; then
          launchctl bootstrap "$gui" "$plist" 2>/dev/null             || launchctl kickstart -k "$gui/$label" 2>/dev/null             || launchctl load "$plist" 2>/dev/null || true
          launchctl enable "$gui/$label" 2>/dev/null || true
        else
          echo "note: no plist at $plist — cannot start epnd" >&2
          return 1
        fi
        ;;
    esac
    # Give the process a moment to claim the single-instance lock before judging.
    sleep 3
    if epnd_running; then
      return 0
    fi
    attempt=$((attempt + 1))
  done

  return 1
}

# Fetch the latest checksum and compare against installed binary
curl -fsSL "${BASE}/checksums.txt" -o "$tmp/checksums.txt" 2>/dev/null || { write_updater_state "checksums_unreachable" false; echo "could not fetch checksums.txt" >&2; exit 0; }

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
          # -- RENAMED, NEVER COPIED OVER. THE COMMENT ABOVE WAS RIGHT AND THIS
          # -- LINE WAS WRONG ------------------------------------------------
          #
          # The safety argument three paragraphs up is "mv is atomic so nothing
          # mid-execution breaks". The code did `cp`, which is the opposite: it
          # rewrites the bytes of the file bash is CURRENTLY EXECUTING, in
          # place, at line ~180 of ~250. Bash reads a script incrementally by
          # byte offset, so after an in-place overwrite its next read comes out
          # of the NEW content at the OLD offset -- and every offset shifts by
          # however much the update added. A release that inserts sixty lines
          # near the top leaves the running shell resuming in the middle of an
          # unrelated function.
          #
          # The .ps1 sibling already names this hazard and defers its own
          # self-update to the very end because of it. This side kept the `cp`.
          #
          # A rename does not touch the running inode: bash holds its descriptor
          # on the old file, which stays whole until the process exits, while
          # the new bytes take the path for the NEXT run. That is what the
          # comment always claimed happened.
          #
          # Staged NEXT TO the target, not in $tmp, because mv across
          # filesystems degrades to copy-and-unlink -- which is the very thing
          # being avoided, and mktemp -d is not guaranteed to share a volume
          # with $HOME.
          selfNew="${SELF}.new"
          if cp "$tmp/self.sh" "$selfNew" 2>/dev/null; then
            chmod +x "$selfNew"
            if mv -f "$selfNew" "$SELF" 2>/dev/null; then
              echo "updated the auto-update script itself (takes effect next run)" >&2
            else
              rm -f "$selfNew"
            fi
          fi
        fi
      fi
    fi
  fi
fi

want="$(grep "[ *]${asset}\$" "$tmp/checksums.txt" 2>/dev/null | awk '{print $1}' || true)"
if [ -z "$want" ]; then
  write_updater_state "no_checksum_entry" false
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
  # UP TO DATE IS NOT THE SAME AS RUNNING, AND THIS IS WHERE A DEAD NODE STAYED
  # DEAD. The script only ever restarted the daemon as a SIDE EFFECT of an
  # update, so a node whose daemon failed to come back after one went on
  # reporting "epnd up to date" every fifteen minutes, forever, while running
  # nothing. Observed on macOS, where the restart path could kill the daemon and
  # then fail to start it. The timer is already a heartbeat; make it a watchdog.
  if epnd_running; then
    # UP TO DATE ON DISK IS NOT THE SAME AS RUNNING THE UP-TO-DATE BUILD, and
    # this is the failure with a live victim. Once a swap lands but the restart
    # does not take -- a bootout/bootstrap race on macOS, a lingering process
    # holding the single-instance lock -- every LATER run arrives here, finds
    # the checksum current and the process alive, prints "up to date", and
    # exits. The node then serves the old build forever while looking perfectly
    # healthy, and nothing downstream of it looks wrong.
    #
    # The liveness watchdog below cannot catch it: the daemon IS running. Only
    # the version can tell, and only the daemon knows it.
    _od="$(bin_version)"
    _rv="$(running_version)"
    if [ -n "$_od" ] && [ -n "$_rv" ] && [ "$_od" != "$_rv" ]; then
      echo "epnd on disk is $_od but the running daemon is $_rv -- restarting onto the installed build" >&2
      case "$os_name" in
        Linux) pkill -x epnd 2>/dev/null || true; sleep 1 ;;
        Darwin)
          launchctl bootout "gui/$(id -u)/com.50gramx.epnd" 2>/dev/null \
            || launchctl unload "$HOME/Library/LaunchAgents/com.50gramx.epnd.plist" 2>/dev/null || true
          pkill -x epnd 2>/dev/null || true
          sleep 1 ;;
      esac
      if start_epnd; then
        write_updater_state "restarted_onto_installed_build" false
        fleet_event "updater_restarted_stale_running_build" true "daemon was running an older build than the installed binary" false
        echo "epnd restarted on the installed build" >&2
      else
        write_updater_state "restart_failed" false
        fleet_event "updater_restart_failed" false "killed to adopt the installed build and did not restart" true
        echo "ERROR: epnd was stopped to adopt the installed build and did NOT come back" >&2
      fi
      exit 0
    fi
    write_updater_state "current" false
    echo "epnd up to date" >&2
    exit 0
  fi
  echo "epnd up to date but NOT RUNNING — starting it" >&2
  if start_epnd; then
    write_updater_state "started_stopped_daemon" false
    echo "epnd started" >&2
    fleet_event "updater_started_stopped_daemon" true "epnd was installed and current but not running" false
  else
    write_updater_state "start_failed" false
    echo "note: epnd is not running and could not be started — check the service" >&2
    fleet_event "updater_start_failed" false "epnd is installed and current but will not start" true
  fi
  exit 0
fi

echo "new epnd available (have=${have:-none} want=$want) — updating…" >&2
write_updater_state "downloading" true
curl -fSL "${BASE}/${asset}" -o "$tmp/epnd" 2>/dev/null || { write_updater_state "download_failed" true; echo "download failed" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/epnd" | awk '{print $1}')"
else got="$(shasum -a 256 "$tmp/epnd" | awk '{print $1}')"; fi
[ "$got" = "$want" ] || { write_updater_state "checksum_mismatch" true; echo "checksum mismatch" >&2; exit 1; }

chmod +x "$tmp/epnd"
# Atomic swap: write to .new then rename over it
mv "$tmp/epnd" "${BIN}.new"
mv "${BIN}.new" "$BIN"
echo "updated epnd from ${TAG}" >&2

# Restart the service gracefully.
#
# Both branches kill first — a lingering unmanaged epnd holds the single-instance
# lock, so a freshly restarted service exits immediately on it and the node
# silently stays on the OLD build despite "updating". On macOS `launchctl
# unload`/`load` also SILENTLY NO-OPS when the label is already registered, which
# is why start_epnd prefers bootstrap/kickstart and then checks for the process.
if [ "$os_name" = "Linux" ]; then
  pkill -x epnd 2>/dev/null || true
  sleep 1
elif [ "$os_name" = "Darwin" ]; then
  gui="gui/$(id -u)"
  label="com.50gramx.epnd"
  launchctl bootout "$gui/$label" 2>/dev/null || launchctl unload "$HOME/Library/LaunchAgents/${label}.plist" 2>/dev/null || true
  pkill -x epnd 2>/dev/null || true
  sleep 1
fi

if start_epnd; then
  write_updater_state "updated" false
  echo "epnd restarted on the new build" >&2
else
  write_updater_state "update_restart_failed" false
  # THE WORST OUTCOME THIS SCRIPT CAN PRODUCE, SAID OUT LOUD. The old daemon has
  # been killed and the new one did not start, so this node is now down and will
  # stay down. Recorded so the resurrection reports it, and the next run of this
  # timer will retry through the liveness check above.
  echo "ERROR: epnd was stopped for the update and did NOT come back — this node is down" >&2
  fleet_event "updater_restart_failed" false "killed for update and did not restart" true
fi
