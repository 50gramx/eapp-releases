// tools/stable-write.mjs — write a published JSON file only when what it SAYS changed.
//
// Every aggregate (every 15 minutes) used to rewrite every data file, because each
// carries the run's own clock: generated_at, published_at, a cost row's `at`, a
// region's last_seen_at. A file whose numbers had not moved still changed, so the
// site rebuilt every page that showed it, and closed seasons looked edited
// (15 Nov 2026: 290 of 295 runs touched all ~30 files).
//
// The rule: compare the new object with the file on disk, ignoring the run's clock.
// Equal means the file is left exactly as it was, stamps included, so its
// generated_at says when its content last changed. Anything else is written whole.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Keys that only say when a run happened.
const CLOCK_KEYS = new Set(['generated_at', 'generatedAt', 'published_at', 'updated_at']);

/** obj without the run's clock: CLOCK_KEYS anywhere, and any string equal to `now`. */
export function withoutClock(v, now) {
  if (Array.isArray(v)) return v.map((x) => withoutClock(x, now));
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (CLOCK_KEYS.has(k)) continue;
      if (now && x === now) continue;
      out[k] = withoutClock(x, now);
    }
    return out;
  }
  return v;
}

/** The clock a published object was stamped with by the run that wrote it. */
function clockOf(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return o.generated_at ?? o.generatedAt ?? o.published_at ?? o.updated_at ?? null;
}

/**
 * True when `obj` says the same as the JSON already at `path`. Each side drops ITS
 * OWN run's clock: the old file's stamps equal its generated_at, the new object's
 * equal `now`, so a value that is only "when this run happened" on both sides
 * compares equal.
 */
export function sameAsPublished(path, obj, now) {
  if (!existsSync(path)) return false;
  try {
    const old = JSON.parse(readFileSync(path, 'utf8'));
    return JSON.stringify(withoutClock(old, clockOf(old))) === JSON.stringify(withoutClock(obj, now ?? clockOf(obj)));
  } catch {
    return false;
  }
}

/** Write `obj` to `path` unless it says what the file already says. Returns whether it wrote. */
export function writeJsonStable(path, obj, now) {
  if (sameAsPublished(path, obj, now)) return false;
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  return true;
}
