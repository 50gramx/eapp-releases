#!/usr/bin/env bash
# Give a channel the build another channel already made from the same inputs.
#
#   promote-release.sh <brand> <platform> <from-channel> <to-channel> <fingerprint> <parts-json>
#
# build-plan.mjs decides when: the two channels' inputs hash the same, so a
# rebuild would only produce the same artifact again. This copies the
# from-channel release's files to the to-channel release, rewrites the
# channel-named fields of its metadata (the build id, commits, SHA-256 and
# signing stay those of the build that made it, plus promotedFrom), and
# writes the to-channel marker so the next run knows it is current.
#
# Runs in a checkout of eapp-releases with GH_TOKEN able to write releases.
set -euo pipefail

brand="$1" platform="$2" from="$3" to="$4" fingerprint="$5" parts="$6"
repo="${GITHUB_REPOSITORY:-50gramx/eapp-releases}"
from_tag="$brand-$platform-$from"
to_tag="$brand-$platform-$to"
work="$(mktemp -d)"

echo "promote $from_tag -> $to_tag"
gh release download "$from_tag" -R "$repo" -D "$work"

FROM="$from" TO="$to" FROM_TAG="$from_tag" TO_TAG="$to_tag" WORK="$work" node -e '
  const fs = require("fs");
  const { FROM, TO, FROM_TAG, TO_TAG, WORK } = process.env;
  const at = new Date().toISOString();
  const swapTag = (v) => typeof v === "string" ? v.split(`/${FROM_TAG}/`).join(`/${TO_TAG}/`) : v;
  const meta = `${WORK}/release-metadata.json`;
  if (fs.existsSync(meta)) {
    const m = JSON.parse(fs.readFileSync(meta, "utf8"));
    m.promotedFrom = { channel: FROM, releaseTag: FROM_TAG, buildId: m.buildId, at };
    m.channel = TO;
    m.releaseTag = TO_TAG;
    m.assetUrl = swapTag(m.assetUrl);
    if (m.catalogPath) m.catalogPath = m.catalogPath.replace(new RegExp(`/${FROM}\\.json$`), `/${TO}.json`);
    fs.writeFileSync(meta, JSON.stringify(m, null, 2) + "\n");
  }
  const delivery = `${WORK}/brand-delivery.json`;
  if (fs.existsSync(delivery)) {
    const d = JSON.parse(fs.readFileSync(delivery, "utf8"));
    d.release_channel = TO;
    d.release_tag = TO_TAG;
    fs.writeFileSync(delivery, JSON.stringify(d, null, 2) + "\n");
  }
'

title="$(gh release view "$from_tag" -R "$repo" --json name -q .name | sed "s/ $from\$/ $to/")"
notes="Same build as **$from_tag** (inputs fingerprint \`${fingerprint:0:16}\`): promoted, not rebuilt."
if gh release view "$to_tag" -R "$repo" >/dev/null 2>&1; then
  gh release upload "$to_tag" "$work"/* -R "$repo" --clobber
  gh release edit "$to_tag" -R "$repo" --title "$title" --notes "$notes"
else
  gh release create "$to_tag" "$work"/* -R "$repo" --title "$title" --notes "$notes"
fi

# The to-channel marker: the donor's commits plus this fingerprint.
marker="data/last-built/$brand-$platform-$to.json"
donor="data/last-built/$brand-$platform-$from.json"
git config user.name "eutopia-ci"
git config user.email "ci@50gramx.com"
for i in $(seq 1 6); do
  git fetch -q origin main
  git reset -q --hard origin/main
  DONOR="$donor" MARKER="$marker" FROM="$from" FP="$fingerprint" PARTS="$parts" node -e '
    const fs = require("fs");
    let d = {};
    try { d = JSON.parse(fs.readFileSync(process.env.DONOR, "utf8")); } catch {}
    fs.mkdirSync(require("path").dirname(process.env.MARKER), { recursive: true });
    fs.writeFileSync(process.env.MARKER, JSON.stringify({
      eapp_sha: d.eapp_sha || "", contracts_sha: d.contracts_sha || "", epnd_state: d.epnd_state || "",
      fingerprint: process.env.FP, parts: JSON.parse(process.env.PARTS || "{}"),
      promoted_from: process.env.FROM, built_at: d.built_at || "", promoted_at: new Date().toISOString(),
    }, null, 2) + "\n");
  '
  git add "$marker"
  git diff --cached --quiet && { echo "marker already current"; exit 0; }
  git commit -q -m "ci: promote $brand/$platform $from -> $to"
  if git push -q origin HEAD:main; then echo "pushed $marker"; exit 0; fi
  echo "push raced (attempt $i); re-syncing"; sleep $((RANDOM % 4 + 2))
done
echo "gave up pushing the marker; the next run re-checks and promotes again (not a failure)"
