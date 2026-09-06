#!/usr/bin/env bash
# Check for a newer epnd build; if found, atomically replace the binary and restart the service.
# Runs periodically (every 15 min, matching the CI's aggregate cycle) via launchd/systemd timer.
# Safe for in-flight work: atomic binary swap + graceful service restart.
set -eu

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

reconcile_schedule 2>/dev/null || true

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
