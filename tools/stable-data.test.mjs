// The published data changes only when what it says changes (15 Nov 2026).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonStable } from './stable-write.mjs';
import { settleClosed } from './seasons.mjs';
import { mergePeerTrend, buildGramxRooms, meshViewOrLast, MESH_CARRY_MS } from './aggregate-founders.mjs';

// A run that only moves its own clock leaves the file exactly as it was.
{
  const dir = mkdtempSync(join(tmpdir(), 'stable-'));
  const p = join(dir, 'x.json');
  const t1 = '2026-11-15T05:32:35.900Z';
  const t2 = '2026-11-15T05:47:38.450Z';
  assert.equal(writeJsonStable(p, { generated_at: t1, n: 1, cost: { at: t1 }, rows: [{ last_seen_at: t1 }] }, t1), true);
  const before = readFileSync(p, 'utf8');
  assert.equal(writeJsonStable(p, { generated_at: t2, n: 1, cost: { at: t2 }, rows: [{ last_seen_at: t2 }] }, t2), false, 'only the clock moved');
  assert.equal(readFileSync(p, 'utf8'), before, 'stamps included, nothing is rewritten');
  assert.equal(writeJsonStable(p, { generated_at: t2, n: 2, cost: { at: t2 }, rows: [{ last_seen_at: t2 }] }, t2), true, 'a number moved');
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).generated_at, t2, 'and the stamp says when');
  // A real time that is not the run's clock is content.
  writeFileSync(p, JSON.stringify({ generated_at: t1, seen: '2026-11-15T05:30:00Z' }));
  assert.equal(writeJsonStable(p, { generated_at: t2, seen: '2026-11-15T05:45:00Z' }, t2), true, 'a gram seen again is news');
}

// A closed season is kept as published; only late evidence enters it.
{
  const prev = {
    id: '2026-W44', open: false, published_at: 'old',
    contributors: { grams: 2, classes: ['c'] }, counts: { artifacts: 1, publishers: 1, by_cohort: { 2: 1 } },
    artifacts: [{ ref: 'r1', member: 'kept-member', engine: 'speech-host', cohort: 2, by_class: { c: { grams: 2, held_probes: 3, last_at: '2026-11-01T00:00:00.000Z', caps: {} } } }],
    publishers: [],
  };
  const idx = new Map([['r1', { ref: 'r1', member: 'refiled-today', engine: 'speech-pod', cohort: 3 }]]);
  const row = (ts) => ({ dids: new Set(['d']), backends: new Set(), held_probes: 1, tokens_per_sec_best: null, effective_ctx_best: null, caps: {}, first_at: ts, last_at: ts, joules_per_token_best: null, energy_tier: null });
  const same = settleClosed(prev, new Map([['r1', new Map([['c', row('2026-10-30T00:00:00.000Z')]])]]), idx, new Set(['d']));
  assert.equal(same, prev, 'nothing late: the season is untouched, not re-filed by today\'s catalog');
  const late = settleClosed(prev, new Map([['r2', new Map([['c', row('2026-11-01T01:00:00.000Z')]])]]), idx, new Set(['d']));
  assert.equal(late.artifacts.length, 2, 'a late probe is added');
  assert.equal(late.artifacts[0].member, 'kept-member', 'rows already there keep their lineage');
  assert.equal(late.published_at, 'old');
}

// A past point of the peers trend never moves when history grows.
{
  const h = (n) => Array.from({ length: n }, (_, i) => ({ t: new Date(Date.UTC(2026, 9, 1) + i * 15 * 60e3).toISOString(), peers: i % 7 }));
  const a = mergePeerTrend({ n: h(3000) }, 60);
  const b = mergePeerTrend({ n: h(3001) }, 60);
  assert.ok(a.length <= 61 && b.length <= 61, 'bounded');
  assert.deepEqual(a.slice(0, -1), b.slice(0, a.length - 1), 'every past point is the same point');
}

// The room rollup does not depend on the order reports arrived in.
{
  const rows = readFileSync(new URL('../data/gramx-archive.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).slice(0, 400);
  const a = buildGramxRooms([], 'now', [], rows);
  const b = buildGramxRooms([], 'now', [], [...rows].reverse());
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'same rooms, same samples');
  assert.deepEqual(a.archive, b.archive, 'same archive, line for line');
}

// An empty mesh report does not empty the network; an old one is not assumed.
{
  const last = { generated_at: '2026-11-15T08:00:00Z', nodes: [{ did: 'a' }] };
  const now = Date.parse('2026-11-15T08:30:00Z');
  assert.equal(meshViewOrLast({}, last, now).view.carried_from, last.generated_at, 'empty: the last good view stands in');
  assert.equal(meshViewOrLast({ nodes: [{ did: 'b' }] }, last, now).keep, true, 'a real view replaces it');
  assert.equal(meshViewOrLast({}, last, now + MESH_CARRY_MS).view.carried_from, undefined, 'too old: nothing assumed');

  // A partial report: the same grams, their DHT parts missing.
  const full = { generated_at: '2026-11-15T08:00:00Z', nodes: [{ did: 'a', online: true, proof_snapshot: { x: 1 }, models: ['m'] }] };
  const partial = { generated_at: '2026-11-15T08:15:00Z', nodes: [{ did: 'a', online: false }, { did: 'b' }] };
  const m = meshViewOrLast(partial, full, now).view;
  assert.deepEqual(m.nodes[0].proof_snapshot, { x: 1 }, 'the missing part is filled in');
  assert.equal(m.nodes[0].online, false, 'what the report does say stands');
  assert.equal(m.nodes[0].carried_from.models, full.generated_at, 'and says when it was seen');
  assert.equal(m.nodes.length, 2, 'no gram is added or dropped');
  // Carried again from the merged view, it keeps its first time and expires.
  const later = meshViewOrLast({ generated_at: 'x', nodes: [{ did: 'a' }] }, m, Date.parse(full.generated_at) + MESH_CARRY_MS + 1).view;
  assert.equal(later.nodes[0].proof_snapshot, undefined, 'a carried part expires on its own clock');
}

console.log('ok - stable data');
