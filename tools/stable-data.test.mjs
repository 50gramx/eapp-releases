// The published data changes only when what it says changes (15 Nov 2026).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJsonStable } from './stable-write.mjs';
import { settleClosed } from './seasons.mjs';
import { mergePeerTrend } from './aggregate-founders.mjs';

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

console.log('ok - stable data');
