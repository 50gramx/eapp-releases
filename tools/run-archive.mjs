// EVERY SIGNED RUN, KEPT (data/catalog/runs-archive.jsonl).
//
// models.json carries each gram's LATEST signed result per build: a re-run
// replaces the one before it. That is right for "how fast is it", and wrong for
// "what has this gram done": a provider's activity, first result and weekly
// points need every run. This archive appends each signed run once, keyed by
// build, gram and the time it was measured, and is never rewritten -- the same
// shape as turns-archive.jsonl. Only what a public page already shows is kept:
// build, gram DID, family, time, tokens per second.

import { existsSync, readFileSync } from 'node:fs';

export const RUN_ARCHIVE_PATH = 'data/catalog/runs-archive.jsonl';

export function readRunArchive(path = RUN_ARCHIVE_PATH) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

/** The archive plus any signed run in models.json it does not hold yet. */
export function mergeRunArchive(archive, evidence) {
  const key = (x) => `${x.ref}|${x.node_did}|${x.measured_at}`;
  const seen = new Set(archive.map(key));
  const out = [...archive];
  for (const e of evidence || []) {
    for (const n of e.nodes || []) {
      if (!n?.node_did || !n.measured_at || !(n.throughput_signature || n.probe_signature)) continue;
      const row = {
        ref: e.name, node_did: n.node_did, family: e.family || null, measured_at: n.measured_at,
        tokens_per_sec: n.tokens_per_sec > 0 ? +Number(n.tokens_per_sec).toFixed(2) : null,
      };
      if (seen.has(key(row))) continue;
      seen.add(key(row));
      out.push(row);
    }
  }
  return out;
}
