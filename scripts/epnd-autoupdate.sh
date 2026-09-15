#!/usr/bin/env bash
# Check for a newer epnd build; if found, atomically replace the binary and restart the service.
# Runs periodically (every 15 min, matching the CI's aggregate cycle) via launchd/systemd timer.
# Safe for in-flight work: atomic binary swap + graceful service restart.
set -eu
# systemd runs a oneshot with no HOME. Under set -u every "$HOME" below is
# then a fatal "unbound variable" -- bootstrap's updater died on the line
# that stamps its own heartbeat, mid-update, on the first run of a script
# that had finally reached it. Root's home is the only honest default for a
# unit that runs as root; a user-run script keeps its own.
: "${HOME:=/root}"
export HOME

REPO="${EPND_REPO:-50gramx/eapp-releases}"
TAG="${EPND_TAG:-epnd-latest}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"
# -- A RUN THAT NEVER ENDS IS A TIMER THAT NEVER FIRES AGAIN ------------------
#
# Every network call below used to be unbounded. curl with no --max-time will
# sit on a half-open socket forever, and neither scheduler will start a second
# copy of a job whose first copy is still running: launchd skips a StartInterval
# window while the previous run is alive, and Task Scheduler defaults to
# IgnoreNew. So ONE stalled fetch does not delay one update -- it silently ends
# the cadence, permanently, until somebody reboots.
#
# That failure is invisible from the fleet, which is what makes it expensive.
# A hung run writes no heartbeat, so updater-state.json keeps whatever the last
# SUCCESSFUL run left behind. This fleet's M4 shows exactly that shape: heartbeat
# frozen at 05:07 reading "current", on_disk == running, nothing diverging, and
# a build published at 05:41 that it has never once looked at. A gram that is
# wedged and a gram that is idle are byte-identical in the telemetry.
#
# Two bounds, because they fail differently. Per-call caps stop a single stalled
# socket. The run deadline is the backstop for everything else -- a wedged
# pkill, a launchctl that blocks, a filesystem that stops answering -- because
# the invariant that matters is not "this call finishes", it is "this process
# exits before the next window opens". 600s against a 900s interval leaves the
# next run a clean slate.
#
# Retries are deliberate and small: a laptop waking onto WiFi loses the first
# connection routinely, and failing that run means waiting a full window.
CURL_OPTS="--connect-timeout 15 --max-time 120 --retry 2 --retry-delay 3"

# The binary is ~70 MiB and some grams are on domestic uplinks, so it gets its
# own budget -- still bounded, still shorter than the window.
# RETRIES HERE TOO, AND THIS IS THE ONE THAT NEEDED THEM. The note above says a
# laptop waking onto WiFi loses its first connection routinely and that failing
# that run costs a whole window -- and then the retries went on the kilobyte
# fetches and not on the seventy-megabyte one.
#
# This fleet's M4 is reporting download_failed right now: awake 133 seconds, on
# battery, behind_upstream true, its updater running and its binary fetch giving
# up on the first refused connection. The small fetches before it succeeded,
# because they retry.
#
# --retry-connrefused as well, because a machine seconds out of sleep is
# refusing connections rather than timing them out, and plain --retry does not
# cover that case.
# -- AND RESUME, BECAUSE THIS MACHINE GETS A FEW MINUTES AT A TIME -----------
#
# Retries restart the transfer. On a laptop that is the wrong remedy, and the
# fleet says so plainly: the M4's awake_seconds reads 133, 102, 529, 250 at
# every observation. It wakes, runs the updater, and sleeps again inside a few
# minutes. Seventy megabytes does not finish in that window, so every attempt
# began at zero and every attempt was cut off at the same place -- for a day.
#
# -C - continues where the last one stopped. A machine that gets four minutes at
# a time then makes four minutes of progress per wake instead of none, and the
# download completes across however many wakes it takes.
#
# The partial lands in $tmp, which is per-run, so this only helps within a run
# today; see the note where the download target is chosen for why that is worth
# fixing next and why it is not fixed here.
CURL_BIG_OPTS="--connect-timeout 15 --max-time 600 --retry 3 --retry-delay 5 --retry-connrefused -C -"

RUN_DEADLINE="${EPND_UPDATE_DEADLINE:-600}"
( sleep "$RUN_DEADLINE"; kill -9 "$$" 2>/dev/null ) &
_watchdog=$!
# Killed on every exit path so a fast run does not leave a sleep behind, and so
# the watchdog can never outlive the run it was guarding.
trap 'kill "$_watchdog" 2>/dev/null || true' EXIT INT TERM

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
os_name="$(uname -s)"

BIN="${EPND_BIN:-}"

# -- UPDATE THE BINARY THE SERVICE MANAGER ACTUALLY RUNS ----------------------
#
# BIN used to be hardcoded to /usr/local/bin/epnd. install.sh does NOT always
# put it there:
#
#	dest="${EPND_INSTALL:-/usr/local/bin}"
#	dest="${HOME}/.local/bin"        # when /usr/local/bin needs sudo and
#	                                 # the install was run without it
#
# and the launchd plist it writes runs "$dest/epnd". So on every gram installed
# without sudo, launchd starts ~/.local/bin/epnd while this script updates
# /usr/local/bin/epnd. TWO DIFFERENT FILES. The updater then reports "updated"
# and "current" forever, truthfully, about a binary nothing runs.
#
# This fleet's M4 is the proof. Its heartbeat said:
#
#	INSTALLED f7546f48 BUT RUNNING 202ce921 — swapped without a restart
#
# 202ce92 is months old. The gram had been dutifully updating a file no process
# ever opened, and every "why is this Mac behind" investigation looked at the
# timer, the scheduler and the network -- none of which was ever wrong.
#
# So ask the service manager where its binary is, instead of assuming. An
# explicit EPND_BIN still wins, because an operator who names a path means it.
service_bin() {
  case "$os_name" in
    Darwin)
      _plist="$HOME/Library/LaunchAgents/com.50gramx.epnd.plist"
      [ -f "$_plist" ] || return 0
      # PlistBuddy ships with macOS and reads the parsed plist, which may be
      # binary -- grepping the file works until somebody's is not XML.
      if [ -x /usr/libexec/PlistBuddy ]; then
        /usr/libexec/PlistBuddy -c "Print :ProgramArguments:0" "$_plist" 2>/dev/null && return 0
      fi
      sed -n 's|.*<string>\(.*/epnd\)</string>.*|\1|p' "$_plist" 2>/dev/null | head -1 || true
      ;;
    Linux)
      # systemd's ExecStart is the same question in the other dialect.
      systemctl show epnd.service --property=ExecStart --value 2>/dev/null |
        sed -n 's|.*path=\([^ ;]*\).*|\1|p' | head -1 || true
      ;;
  esac
}

if [ -z "$BIN" ]; then
  BIN="$(service_bin 2>/dev/null || true)"
fi
if [ -z "$BIN" ]; then
  BIN="/usr/local/bin/epnd"
fi

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
# daemon_home is where the DAEMON keeps its state, read from its unit: the
# EPN_HOME in the service environment, else the service user's ~/.epn. On the
# bootstrap the unit says /var/lib/epnd while this script runs as root, so
# $HOME/.epn was /root/.epn -- running.json and updater-state.json were read
# and written in a home no daemon uses. running_version() answered "" on every
# run, the state file the fleet reads was never there, and the first restart
# through the verified path reported "did NOT come back" about a daemon that
# had been up for forty seconds.
daemon_home() {
  _env=$(systemctl show epnd -p Environment --value 2>/dev/null || true)
  _h=$(printf '%s
' "$_env" | tr ' ' '
' | sed -n 's/^EPN_HOME=//p' | head -1)
  if [ -n "$_h" ]; then echo "$_h"; return 0; fi
  _u=$(systemctl show epnd -p User --value 2>/dev/null || true)
  [ -n "$_u" ] || _u=root
  _d=$(getent passwd "$_u" 2>/dev/null | cut -d: -f6)
  [ -n "$_d" ] || _d=/root
  echo "$_d/.epn"
}

epnd_home() {
  if [ -n "${EPN_HOME:-}" ]; then echo "$EPN_HOME"; return 0; fi
  if command -v systemctl >/dev/null 2>&1 && systemctl show epnd -p Id --value 2>/dev/null | grep -q '^epnd.service$'; then
    daemon_home
    return 0
  fi
  echo "$HOME/.epn"
}

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
# RESTART_ERR is the service manager's last words. They used to go to
# /dev/null; now they ride in the state file so the fleet can read WHY a
# restart failed instead of only that it did. Quotes and newlines stripped so
# the hand-rolled JSON stays JSON.
RESTART_ERR=""
write_updater_state() { # $1 action, $2 behind_upstream(true|false)
  _home="$(epnd_home)"
  [ -d "$_home" ] || return 0
  _od="$(bin_version)"
  _rv="$(running_version)"
  _err="$(printf '%s' "$RESTART_ERR" | tr -d '"\\' | tr '\n' ' ' | cut -c1-400)"
  printf '{"at":"%s","asset":"%s","on_disk":"%s","running":"%s","running_pid":"%s","behind_upstream":%s,"action":"%s","last_error":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$asset" "${_od:-}" "${_rv:-}" "$(pgrep -x epnd 2>/dev/null | tr '\n' ' ' | sed 's/ $//')" "${2:-false}" "$1" "$_err" \
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
# -- THE RACE THAT TOOK THE INTEL MAC DOWN FOR A TIMER WINDOW ----------------
#
# bootout is asynchronous. One second after it the label is still registered
# and draining, so bootstrap fails "already registered", kickstart -k and load
# no-op, and every error went to /dev/null. Then `pgrep -x epnd` found the OLD
# daemon still inside its five-second shutdown grace and start_epnd said 0.
# updater-state.json recorded action:"updated"; launchctl list had no label;
# the node was down until the next run. A dying process is not a started one.
#
# So stopping is now a function that WAITS: for the label to leave launchd and
# for every pid that existed before the stop to be gone. And starting verifies
# by a pid that is NOT one of those, plus the daemon's own running.json
# naming that pid and the on-disk version -- the only two facts that mean
# "the new build is up".
OLD_PIDS=""
stop_epnd() {
  OLD_PIDS="$(pgrep -x epnd 2>/dev/null | tr '\n' ' ')"
  case "$os_name" in
    Linux)
      command -v systemctl >/dev/null 2>&1 && systemctl stop epnd 2>/dev/null || true
      pkill -x epnd 2>/dev/null || true
      ;;
    Darwin)
      gui="gui/$(id -u)"
      label="com.50gramx.epnd"
      _e="$(launchctl bootout "$gui/$label" 2>&1)" \
        || _e="$_e; $(launchctl unload "$HOME/Library/LaunchAgents/${label}.plist" 2>&1)" || true
      [ -n "$_e" ] && RESTART_ERR="bootout: $_e"
      ;;
  esac
  # Wait for the graceful shutdown to FINISH (the daemon's stage 3), not begin.
  # 45 s covers stage-2 grace plus lock release; past that, the old build is
  # holding the node hostage and SIGKILL is the lesser harm.
  _w=0
  while [ "$_w" -lt 45 ]; do
    _left=""
    for _p in $OLD_PIDS; do kill -0 "$_p" 2>/dev/null && _left="$_left $_p"; done
    if [ "$os_name" = "Darwin" ] && launchctl print "$gui/$label" >/dev/null 2>&1; then
      _left="$_left label"
    fi
    [ -z "$_left" ] && return 0
    sleep 1
    _w=$((_w + 1))
    [ "$_w" -eq 15 ] && { for _p in $OLD_PIDS; do kill -TERM "$_p" 2>/dev/null || true; done; }
  done
  for _p in $OLD_PIDS; do kill -KILL "$_p" 2>/dev/null || true; done
  RESTART_ERR="${RESTART_ERR:+$RESTART_ERR; }old epnd did not exit in 45s, killed:$_left"
  sleep 1

  return 0
}

# new_epnd_up: a pid that is not one of OLD_PIDS, and running.json written by
# THAT pid naming the on-disk version. pgrep alone was the bug.
new_epnd_up() {
  _od="$(bin_version)"
  for _p in $(pgrep -x epnd 2>/dev/null); do
    case " $OLD_PIDS " in *" $_p "*) continue ;; esac
    _rs="$(epnd_home)/running.json"
    [ -f "$_rs" ] || continue
    _rp="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$_rs" 2>/dev/null | head -1)"
    _rv="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_rs" 2>/dev/null | head -1)"
    [ "$_rp" = "$_p" ] || continue
    [ -z "$_od" ] || [ "$_rv" = "$_od" ] || continue

    return 0
  done

  return 1
}

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
          _e="$(launchctl bootstrap "$gui" "$plist" 2>&1)" \
            || _e="$_e; kickstart: $(launchctl kickstart -k "$gui/$label" 2>&1)" \
            || _e="$_e; load: $(launchctl load "$plist" 2>&1)" || true
          [ -n "$_e" ] && RESTART_ERR="attempt $attempt: $_e"
          launchctl enable "$gui/$label" 2>/dev/null || true
        else
          RESTART_ERR="no plist at $plist"
          echo "note: no plist at $plist — cannot start epnd" >&2
          return 1
        fi
        ;;
    esac
    # The daemon writes running.json once it holds the single-instance lock
    # and knows its build; give it up to 20 s per attempt before judging.
    _t=0
    while [ "$_t" -lt 20 ]; do
      if new_epnd_up; then
        RESTART_ERR=""
        return 0
      fi
      sleep 1
      _t=$((_t + 1))
    done
    attempt=$((attempt + 1))
  done
  [ -n "$RESTART_ERR" ] || RESTART_ERR="no new epnd pid with running.json at the installed version after 5 attempts"

  return 1
}

# Fetch the latest checksum and compare against installed binary
curl $CURL_OPTS -fsSL "${BASE}/checksums.txt" -o "$tmp/checksums.txt" 2>/dev/null || { write_updater_state "checksums_unreachable" false; echo "could not fetch checksums.txt" >&2; exit 0; }

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
      if curl $CURL_OPTS -fsSL "${BASE}/epnd-autoupdate.sh" -o "$tmp/self.sh" 2>/dev/null; then
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

# -- THE UPDATER UPDATED EVERYTHING EXCEPT ITS OWN SCHEDULE -------------------
#
# This script replaces epnd, and since the block above it replaces itself. It
# has never been able to replace the TIMER THAT RUNS IT. install.sh writes the
# launchd plist (and the systemd timer) once, at install, and nothing revises
# them for the life of the machine.
#
# So a gram installed by an older install.sh keeps whatever cadence that build
# happened to give it, forever, and no release can correct it. That is the same
# shape as the BIN bug that stranded this fleet's M4 on a months-old binary: a
# fact decided once at install time, never re-checked, and invisible from the
# outside because everything downstream of it reports success.
#
# It is also the only remaining way a gram can go quiet that a new build cannot
# reach. Every other failure this script has -- a wrong path, a hung fetch, a
# divergent binary -- is now fixed by shipping. A wrong interval is fixed by
# nothing.
#
# So the schedule is reconciled the same way the binary is: read what is
# installed, compare against what this build expects, rewrite only on a
# mismatch. Idempotent, silent when correct, and it costs one file read.
EXPECT_INTERVAL="${EPND_UPDATE_INTERVAL:-900}"

reconcile_schedule() {
  case "$os_name" in
    Darwin) reconcile_launchd ;;
    Linux)  reconcile_systemd ;;
  esac
}

# -- RECONCILE TOWARD StartCalendarInterval, NOT StartInterval ---------------
#
# The previous version of this function asserted StartInterval 900 on every run.
# It was written to close a real gap -- a plist fixed once at install time that
# no release could reach -- and it did close it, onto the WRONG KEY.
#
# launchd.plist(5) on StartInterval: a firing that lands while the machine is
# asleep is MISSED, "due to shortcomings in kqueue(3)". Not deferred, not
# coalesced, not run on wake. Lost, with nothing recorded, so the scheduler
# reports no error because nothing failed. A laptop that sleeps through four
# windows does not update and cannot say why -- which is exactly what this
# fleet's M4 did all day: a 75-minute gap against a 900-second interval, and
# launchctl answering "registered, has not run, no reason given".
#
# StartCalendarInterval is the key the wake handling was actually applied to: a
# missed calendar firing runs once on wake. Four entries express the same
# quarter-hour and survive sleep.
#
# THE TWO HALVES CANNOT SHIP SEPARATELY. install.sh now writes the calendar
# form, and this function ran every fifteen minutes asserting the interval form
# back -- so fixing only the installer would have been undone on the next tick,
# on every gram already installed, by a repair that reported success. A
# reconciler is only ever as right as the shape it reconciles toward.
reconcile_launchd() {
  _plist="$HOME/Library/LaunchAgents/com.50gramx.epnd-autoupdate.plist"
  [ -f "$_plist" ] || return 0
  [ -x /usr/libexec/PlistBuddy ] || return 0

  # Already on the calendar form: nothing to do. Checked by asking for the
  # array's first entry, because Print on a missing key is the only portable
  # "does this exist" PlistBuddy offers.
  if /usr/libexec/PlistBuddy -c "Print :StartCalendarInterval:0" "$_plist" >/dev/null 2>&1; then
    return 0
  fi

  # Set in place rather than rewriting the file. A rewrite would have to
  # reproduce ProgramArguments and the log paths from here, and reproducing them
  # in a second place is how they drift from what install.sh writes -- the exact
  # class of bug this block exists to close.
  /usr/libexec/PlistBuddy -c "Delete :StartInterval" "$_plist" >/dev/null 2>&1 || true
  /usr/libexec/PlistBuddy -c "Add :StartCalendarInterval array" "$_plist" >/dev/null 2>&1 || return 0
  _i=0
  for _min in 0 15 30 45; do
    /usr/libexec/PlistBuddy -c "Add :StartCalendarInterval:$_i dict" "$_plist" >/dev/null 2>&1 || return 0
    /usr/libexec/PlistBuddy -c "Add :StartCalendarInterval:$_i:Minute integer $_min" "$_plist" >/dev/null 2>&1 || return 0
    _i=$((_i + 1))
  done

  # launchd holds the OLD definition until the job is reloaded; without this the
  # file is right and the behaviour is unchanged, which is worse than not
  # trying, because the next run would see a correct file and stop looking.
  _gui="gui/$(id -u)"
  launchctl bootout "$_gui/com.50gramx.epnd-autoupdate" >/dev/null 2>&1 || true
  launchctl bootstrap "$_gui" "$_plist" >/dev/null 2>&1 ||
    launchctl load "$_plist" >/dev/null 2>&1 || true
  echo "repaired auto-update schedule: StartInterval -> StartCalendarInterval (survives sleep)" >&2
}

reconcile_systemd() {
  _timer="$(systemctl show epnd-autoupdate.timer --property=LoadState --value 2>/dev/null || true)"
  [ "$_timer" = "loaded" ] || return 0
  _have="$(systemctl show epnd-autoupdate.timer --property=TimersMonotonic --value 2>/dev/null || true)"
  case "$_have" in
    *"$EXPECT_INTERVAL"*) return 0 ;;
  esac
  # Deliberately REPORT ONLY on Linux. A systemd unit may be managed by a
  # package, a config-management tool or the distribution, and silently
  # rewriting a unit this script did not certainly author is a bigger risk than
  # a wrong interval. macOS LaunchAgents in the user's own directory have no
  # such ambiguity -- install.sh is the only thing that writes them.
  echo "note: epnd-autoupdate.timer interval does not match $EXPECT_INTERVAL (left alone; systemd units may be externally managed)" >&2
}

# daemon_home is where the RUNNING daemon keeps its home -- read from its
# unit, not from this script's environment: this runs as root on a timer with
# HOME=/root, and the daemon on bootstrap runs as user epnd with
# EPN_HOME=/var/lib/epnd. The same rule the daemon applies (config.epnHome):
# EPN_HOME from the unit, else ~/.epn of the unit's user.

# ensure_kick_path gives an existing gram the path unit install.sh writes,
# and keeps it current. It runs here because this service runs as root on
# the timer, so every gram converges within one cycle with no owner action.
#
# The unit is ours by name, so unlike reconcile_schedule it IS rewritten when
# its content is not what we would write now. The first version watched only
# /tmp -- which a daemon under ProtectSystem=strict cannot write, so on
# bootstrap the kick never landed and every update rode the timer. The unit
# now watches the daemon's home first (the one directory such a unit can
# write) and /tmp second.
ensure_kick_path() {
  command -v systemctl >/dev/null 2>&1 || return 0
  [ "$(id -u)" = "0" ] || return 0
  _p="/etc/systemd/system/epnd-autoupdate.path"
  _want="[Unit]
Description=EP&N Auto-Update Kick (a running gram asks for a check now)

[Path]
PathModified=$(daemon_home)/kick-update
PathModified=/tmp/epnd-kick-update
Unit=epnd-autoupdate.service

[Install]
WantedBy=paths.target
"
  if [ -e "$_p" ] && [ "$(cat "$_p")" = "$(printf '%s' "$_want")" ]; then
    return 0
  fi
  printf '%s' "$_want" > "$_p"
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl enable --now epnd-autoupdate.path >/dev/null 2>&1 || true
  systemctl restart epnd-autoupdate.path >/dev/null 2>&1 || true
  echo "installed epnd-autoupdate.path watching $(daemon_home)/kick-update: a running gram can now ask for a check without waiting for the timer" >&2
}

# -- DOORS: LET THE SERVICE BIND 443/8443 ---------------------------------------
#
# The daemon offers extra listen ports that port-filtered campus networks
# still admit (p2p/doors.go). On Linux a service user cannot bind a port
# below 1024 without CAP_NET_BIND_SERVICE, so every Linux gram -- the
# bootstrap first -- gets a drop-in granting exactly that capability and
# nothing else. NoNewPrivileges stays: ambient capabilities are compatible
# with it. Installed once; the daemon picks the capability up on its next
# restart, which the update that ships this already performs.
ensure_bind_doors() {
  command -v systemctl >/dev/null 2>&1 || return 0
  [ "$(id -u)" = "0" ] || return 0
  [ -f /etc/systemd/system/epnd.service ] || return 0
  _d="/etc/systemd/system/epnd.service.d"
  _p="$_d/doors.conf"
  _want="# Installed by epnd-autoupdate.sh: the daemon listens on 443/8443 beside its
# own ports so grams behind port-filtered networks can reach it. A service
# user needs this one capability to bind them; nothing else is granted.
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
"
  if [ -e "$_p" ] && [ "$(cat "$_p")" = "$(printf '%s' "$_want")" ]; then
    return 0
  fi
  mkdir -p "$_d"
  printf '%s' "$_want" > "$_p"
  systemctl daemon-reload >/dev/null 2>&1 || true
  echo "installed $_p: epnd may bind 443/8443 from its next restart" >&2
  fleet_event "updater_installed_bind_doors" true "systemd drop-in granting CAP_NET_BIND_SERVICE" false
  # A restart is what makes the capability real. Stop synchronously, start,
  # verify the new pid -- the same path an update takes.
  stop_epnd
  if start_epnd; then
    write_updater_state "restarted_for_doors" false
  else
    write_updater_state "restart_failed" false
    fleet_event "updater_restart_failed" false "restarted to grant bind capability and did not come back" true
  fi
}

reconcile_schedule 2>/dev/null || true
case "$(uname -s)" in
  Linux) ensure_kick_path 2>/dev/null || true; ensure_bind_doors 2>/dev/null || true ;;
esac

# -- REFRESH THE OTHER SHIPPED SCRIPTS, NOT JUST THIS ONE --------------------
#
# This script updates epnd and, since d1a566d, itself. It has never updated
# report-bootstrap-status.sh, which is the founder-node reporter that pushes a
# snapshot and an append-only history to eapp-releases every fifteen minutes.
#
# The reason was not a decision. The release workflow built checksums.txt with
# `sha256sum epnd-*`, a filename pattern standing in for "the things we ship" --
# and report-bootstrap-status.sh does not begin with epnd-, so it was published
# as a release asset with no checksum row. Nothing here will write a file it
# cannot verify, so it could never be refreshed, and bootstrap-01 has been
# running a copy older than the repo's for weeks.
#
# Same defect as the hardcoded BIN path and the never-revised launchd interval:
# a fact fixed once at install time that no build could reach. The point of
# this file is that shipping is the remedy for everything, and one unchecksummed
# filename quietly exempted a script from that.
#
# ONLY REFRESHES WHAT IS ALREADY THERE. A missing file means this node is not a
# founder node and was never meant to run the reporter; installing it here would
# turn an update into a provisioning decision, and hand a machine a root-only
# token path it has no business holding.
refresh_shipped_script() {
  _name="$1"
  _dest="$2"
  [ -f "$_dest" ] || return 0

  # -- COMPARED AS A STRING, NOT MATCHED AS A PATTERN -----------------------
  #
  # The sibling lookups above grep with the filename embedded in the pattern,
  # so every "." in a name is a wildcard. "report-bootstrap-status.sh" happily
  # matches "report-bootstrap-statusXsh", and escaping it turned out to be
  # fiddly enough that the first attempt here silently did not escape at all --
  # verified by od, matching both lines.
  #
  # sha256sum prints "HASH  name" or "HASH *name", so the name is field two and
  # an exact comparison answers the question with no regex in it. Nothing to
  # escape, nothing to get subtly wrong, and it cannot match a file that merely
  # resembles the one asked for.
  _want="$(awk -v n="$_name" '$2 == n || $2 == "*" n { print $1; exit }' "$tmp/checksums.txt" 2>/dev/null || true)"
  [ -n "$_want" ] || return 0
  if command -v sha256sum >/dev/null 2>&1; then _have="$(sha256sum "$_dest" | awk '{print $1}')"
  else _have="$(shasum -a 256 "$_dest" | awk '{print $1}')"; fi
  [ "$_have" != "$_want" ] || return 0

  curl $CURL_OPTS -fsSL "${BASE}/${_name}" -o "$tmp/$_name" 2>/dev/null || return 0
  if command -v sha256sum >/dev/null 2>&1; then _got="$(sha256sum "$tmp/$_name" | awk '{print $1}')"
  else _got="$(shasum -a 256 "$tmp/$_name" | awk '{print $1}')"; fi
  [ "$_got" = "$_want" ] || return 0

  # Staged beside the target and renamed, never copied over: a timer can fire
  # mid-write, and a half-written reporter that runs is worse than an old one
  # that works. mv within a directory is atomic.
  if cp "$tmp/$_name" "${_dest}.new" 2>/dev/null; then
    chmod +x "${_dest}.new" 2>/dev/null || true
    if mv -f "${_dest}.new" "$_dest" 2>/dev/null; then
      echo "updated ${_name}" >&2
    else
      rm -f "${_dest}.new"
    fi
  fi
}

# The reporter runs as root from a systemd timer, so writing it needs root. A
# non-root updater simply skips -- reported, not fatal, because every other
# thing this script does still works.
if [ -f /usr/local/bin/report-bootstrap-status.sh ]; then
  if [ -w /usr/local/bin/report-bootstrap-status.sh ]; then
    refresh_shipped_script report-bootstrap-status.sh /usr/local/bin/report-bootstrap-status.sh
  else
    echo "note: report-bootstrap-status.sh is out of this updater's reach (not writable)" >&2
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
      stop_epnd
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
  OLD_PIDS=""
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
# -- THE PARTIAL HAS TO OUTLIVE THE RUN, OR RESUME BUYS NOTHING --------------
#
# $tmp is mktemp -d, fresh every run, so -C - could only ever resume across the
# three retries INSIDE one run. That is not the shape of the problem. This
# fleet's M4 is awake 133, 102, 529, 250 seconds at a time -- it gets a few
# minutes per wake, and seventy megabytes does not finish in one. Every run
# started at zero, was cut off at the same place, and threw the bytes away.
#
# So the partial lives under the epn home, and each wake adds however much it
# manages before sleeping.
#
# KEYED BY THE CHECKSUM IT IS BEING BUILT TOWARDS. A partial left from an
# earlier build is not a head start, it is a different file: resuming onto it
# produces bytes that fail the checksum, and since the next run would resume
# onto the same wrong prefix it would fail identically, forever. The sidecar is
# what stops a stale partial becoming a permanent one -- when the wanted hash
# changes, the partial goes.
partialDir="$(epnd_home)/update"
mkdir -p "$partialDir" 2>/dev/null || true
partial="$partialDir/${asset}.partial"
partialFor="$partialDir/${asset}.want"
if [ -f "$partial" ] && [ "$(cat "$partialFor" 2>/dev/null || true)" != "$want" ]; then
  rm -f "$partial"
fi
printf '%s' "$want" > "$partialFor" 2>/dev/null || true

curl $CURL_BIG_OPTS -fSL "${BASE}/${asset}" -o "$partial" 2>/dev/null || {
  # NOT an error worth erasing progress over. Whatever arrived is kept and the
  # next wake continues from it; the only thing that discards a partial is a
  # change in what we are aiming at.
  write_updater_state "download_failed" true
  echo "download failed (partial kept for the next run)" >&2
  exit 1
}
cp "$partial" "$tmp/epnd" 2>/dev/null || { write_updater_state "download_failed" true; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$tmp/epnd" | awk '{print $1}')"
else got="$(shasum -a 256 "$tmp/epnd" | awk '{print $1}')"; fi
[ "$got" = "$want" ] || {
  # The completed file does not match. Whatever is in the partial is wrong and
  # resuming onto it would reproduce the same wrong answer, so it goes -- this
  # is the one case where progress is worth less than a clean start.
  rm -f "$partial" "$partialFor"
  write_updater_state "checksum_mismatch" true; echo "checksum mismatch" >&2; exit 1
}
# Verified. The partial has done its job and holding seventy megabytes for a
# build already installed is just cost.
rm -f "$partial" "$partialFor"

chmod +x "$tmp/epnd"

# -- HAND OVER IF THE DAEMON IS ALIVE; SWAP ONLY IF IT IS NOT ---------------
#
# Backlog item 15. Killing epnd mid-probe threw away whatever it was doing --
# a multi-gigabyte pull, a forty-minute probe, a call being served for a peer
# -- and bounced the pods on the way back up. A live daemon is asked instead:
# the verified binary is staged beside it with a JSON sidecar, and the daemon
# drains its own work and swaps itself (internal/selfupdate/handover.go).
#
# THE FALLBACK IS WHAT MAKES THIS SAFE: a daemon too old to know about the
# sidecar would ignore it forever, so a stage not taken up within the grace
# window is abandoned and this run does the old hard swap.
#
# -- AND THE FALLBACK WAS RESET BY THE LOOP IT EXISTS TO ESCAPE -------------
#
# The grace was measured from the SIDECAR'S mtime, and write_staged_update
# rewrites the sidecar on every run. This script runs every ten minutes, well
# inside a twenty-minute window, so the sidecar could never grow old enough to
# be called stale and the hard swap was unreachable.
#
# bootstrap-01 sat on a four-day-old build because of it: staging a fresh
# binary every ten minutes, the daemon unable to complete the rename (it runs
# as `epnd`; /usr/local/bin is root-owned, so the swap fails with EACCES), and
# the escape hatch reset by the same loop each time. Worse, that gram is the
# fleet's collector -- it re-serialises every digest through its own structs,
# so every telemetry field newer than its build was silently dropped for the
# whole fleet.
#
# So the grace is measured from when a handover was FIRST asked for and not
# yet taken up, in a marker this script does not touch while one is pending.
# The window is about the DAEMON'S RESPONSIVENESS, not about any particular
# build -- which matters on a day with six releases, where keying it to the
# build would restart the clock on every push.
HANDOVER_GRACE_MIN=20

# handover_since_file records when the current, unanswered handover began.
handover_since_file() {
  _home=$(epnd_home)
  [ -n "$_home" ] || return 1
  printf '%s/update-handover-since' "$_home"
}

daemon_answering() {
  curl -fsS --max-time 3 http://127.0.0.1:53581/v1/identity >/dev/null 2>&1
}

write_staged_update() {
  _home=$(epnd_home)
  [ -n "$_home" ] && [ -d "$_home" ] || return 1
  # START THE CLOCK ONLY WHEN ONE IS NOT ALREADY RUNNING. A pending sidecar
  # means the daemon has not answered the previous ask, and replacing the
  # binary it is offered does not make it any more responsive -- so the
  # original request keeps its age and can time out.
  #
  # AND START IT ON A MACHINE ALREADY STUCK IN THE OLD LOOP. Without the second
  # test this fix could never reach the machines that need it: bootstrap-01 has
  # a sidecar that is rewritten every ten minutes, so "only when the sidecar is
  # absent" would never fire there and the deadlock would survive its own
  # remedy. A missing marker beside a pending sidecar means this script has just
  # been upgraded underneath an unanswered handover; the clock starts now.
  _since=$(handover_since_file) || _since=""
  if [ -n "$_since" ] && { [ ! -f "$_home/update-staged.json" ] || [ ! -f "$_since" ]; }; then
    : > "$_since" 2>/dev/null || true
  fi
  cp -f "$1" "$BIN.staged" 2>/dev/null || return 1
  _at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"version":"%s","path":"%s","sha256":"%s","at":"%s"}
'     "$2" "$BIN.staged" "$3" "$_at" > "$_home/update-staged.json.tmp" 2>/dev/null || return 1
  mv -f "$_home/update-staged.json.tmp" "$_home/update-staged.json" 2>/dev/null || return 1

  return 0
}

staged_is_stale() {
  _home=$(epnd_home)
  # A sidecar must still be pending for a timeout to mean anything: once the
  # daemon takes one up it deletes it, and that is the healthy path.
  [ -f "$_home/update-staged.json" ] || return 1
  # AGED FROM THE FIRST UNANSWERED ASK, not from the last staged binary. See
  # the comment on HANDOVER_GRACE_MIN. Missing marker: an update staged by an
  # older copy of this script, so fall back to the sidecar's own age rather
  # than treating it as brand new.
  _f=$(handover_since_file) || _f=""
  if [ -z "$_f" ] || [ ! -f "$_f" ]; then
    _f="$_home/update-staged.json"
  fi
  _age=$(( $(date +%s) - $(date -r "$_f" +%s 2>/dev/null || echo 0) ))
  [ "$_age" -ge $(( HANDOVER_GRACE_MIN * 60 )) ]
}

if daemon_answering && ! staged_is_stale; then
  if write_staged_update "$tmp/epnd" "$TAG" "$got"; then
    write_updater_state "handover_pending" false
    echo "staged for handover - the daemon will finish its work and swap itself" >&2
    exit 0
  fi
  echo "could not stage for handover - falling back to the hard swap" >&2
elif staged_is_stale; then
  echo "a staged update was not taken up within ${HANDOVER_GRACE_MIN}m - the daemon cannot swap itself, so this run does it" >&2
  write_updater_state "handover_timeout" true
  rm -f "$(epnd_home)/update-staged.json" 2>/dev/null || true
  _since=$(handover_since_file) 2>/dev/null || _since=""
  [ -n "$_since" ] && rm -f "$_since" 2>/dev/null
fi

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
stop_epnd

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
