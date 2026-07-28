#!/usr/bin/env bash
# Write a marker file on this repo's main and push it, tolerating the race.
#
# eapp-releases main is pushed by several scheduled workflows on overlapping
# crons, so a bare push is rejected ("fetch first") often enough to matter.
# Re-sync to origin, re-write the marker, retry. Give up gracefully: whatever
# the marker records has ALREADY happened, and the next run catches up — failing
# the job here would report a successful deploy as a failure.
#
# Usage: push-marker.sh <file> <value> <commit-message>
set -euo pipefail

file="$1"
value="$2"
message="$3"

git config user.name "eutopia-ci"
git config user.email "ci@50gramx.com"

for i in $(seq 1 6); do
  git fetch -q origin main
  git reset -q --hard origin/main
  echo "$value" > "$file"
  if git diff --quiet -- "$file"; then
    echo "marker $file already current"
    exit 0
  fi
  git add "$file"
  git commit -q -m "$message"
  if git push -q origin HEAD:main; then
    echo "pushed $file=$value"
    exit 0
  fi
  echo "push raced (attempt $i) — re-syncing"
  sleep $((RANDOM % 4 + 2))
done

echo "gave up after retries — next run will catch up (not a failure)"
exit 0
