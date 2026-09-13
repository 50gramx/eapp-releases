// node tools/seasons.test.mjs
import assert from 'node:assert/strict';
import { buildSeasons, seasonIdOf, seasonWindow, hardwareClassOf, classVariance, classVarianceWithHistory, refinedClassOf, CLASS_VARIANCE_WINDOW } from './seasons.mjs';

function payload(extra, ts, did) {
  return Buffer.from(JSON.stringify({ metric: 'model.probe', value: 1, unit: 'pass', ts, node_did: did, extra })).toString('base64');
}

const W37 = Date.UTC(2026, 8, 11, 17); // 2026-09-11 → ISO week 37
const W36 = Date.UTC(2026, 8, 3, 17);

assert.equal(seasonIdOf(W37), '2026-W37', 'ISO week id');
assert.equal(seasonIdOf(W37 * 1e6), '2026-W37', 'nanosecond timestamps are read too');
assert.deepEqual(seasonWindow('2026-W37'), { starts_at: '2026-09-07T00:00:00.000Z', ends_at: '2026-09-14T00:00:00.000Z' });
assert.equal(hardwareClassOf({ os: 'windows', arch: 'amd64', gpu: 'nvidia', ram_gib: 15.9 }), 'windows/amd64/nvidia/16g');
assert.equal(hardwareClassOf({ os: 'darwin', arch: 'arm64', ram_gib: 24 }), 'darwin/arm64/none/32g');
assert.equal(hardwareClassOf(null), 'unknown');

const families = [{
  id: 'gemma-4', members: [
    { id: 'e2b', artifacts: [{ ref: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', engine: 'ollama', quant: 'Q4_K_M', by: 'unsloth', attribution: 'quantizer', base: 'google/gemma-4-E2B-it', cohort: 0, rung: 0 }] },
    { id: 'e2b~someone', derivative: true, base: 'e2b', artifacts: [{ ref: 'hf.co/someone/gemma-4-E2B-lawyer-GGUF:Q4_K_M', engine: 'ollama', quant: 'Q4_K_M', by: 'someone', attribution: 'derivative', cohort: 3, rung: 0 }] },
  ],
}];
const hwWin = { os: 'windows', arch: 'amd64', gpu: 'nvidia', ram_gib: 15.9 };
const hwMac = { os: 'darwin', arch: 'arm64', gpu: 'apple', ram_gib: 16 };
const models = { models: [
  { name: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', nodes: [
    { node_did: 'did:epn:a', capabilities: { tools: true, vision: false }, tokens_per_sec: 40, probe_signing_payload_b64: payload({ hardware: hwWin, effective_ctx: 8192, runtime: 'ollama' }, W37 * 1e6, 'did:epn:a') },
    { node_did: 'did:epn:b', capabilities: { tools: true }, tokens_per_sec: 55, probe_signing_payload_b64: payload({ hardware: hwWin, effective_ctx: 4096, runtime: 'ollama' }, W37 * 1e6, 'did:epn:b') },
    { node_did: 'did:epn:c', capabilities: { tools: true }, tokens_per_sec: 12, probe_signing_payload_b64: payload({ hardware: hwMac, effective_ctx: 8192, runtime: 'ollama' }, W36 * 1e6, 'did:epn:c') },
  ] },
  { name: 'hf.co/someone/gemma-4-E2B-lawyer-GGUF:Q4_K_M', nodes: [
    { node_did: 'did:epn:a', capabilities: { tools: false }, probe_signing_payload_b64: payload({ hardware: hwWin }, W37 * 1e6, 'did:epn:a') },
  ] },
] };

const r = buildSeasons(models, families, new Date(W37).toISOString(), new Map(), [], null);
assert.deepEqual(r.index.seasons.map((s) => s.id), ['2026-W37', '2026-W36']);
const w37 = r.files.get('data/catalog/seasons/2026-W37.json');
assert.equal(w37.open, true);
assert.equal(w37.contributors.grams, 2, 'two distinct grams this season');
const e2b = w37.artifacts.find((a) => a.ref === 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M');
assert.equal(e2b.publisher, 'unsloth');
assert.equal(e2b.cohort, 0);
const win = e2b.by_class['windows/amd64/nvidia/16g'];
assert.equal(win.grams, 2);
assert.equal(win.tokens_per_sec_best, 55, 'best of the class, not the mean');
assert.equal(win.effective_ctx_best, 8192);
assert.deepEqual(win.caps, { tools: 2 }, 'a capability that failed is not counted as held');
assert.equal(e2b.by_class['darwin/arm64/apple/16g'], undefined, 'the mac probe was last season');
const deriv = w37.artifacts.find((a) => a.ref.includes('lawyer'));
assert.equal(deriv.derivative, true);
assert.equal(deriv.cohort, 3);
assert.deepEqual(w37.publishers.map((p) => p.publisher), ['unsloth', 'someone'], 'publishers listed by held, most first');
assert.equal(w37.publishers[0].publisher, 'unsloth');
assert.equal(w37.publishers[0].grams, 2);
// coverage is cumulative across seasons
assert.equal(r.current.coverage['hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M']['darwin/arm64/apple/16g'], 1);
assert.equal(r.current.coverage['hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M']['windows/amd64/nvidia/16g'], 2);

// A closed season merged with its published copy never loses a gram.
const prev = new Map([['2026-W36', { ...r.files.get('data/catalog/seasons/2026-W36.json') }]]);
const later = buildSeasons({ models: [] }, families, new Date(W37).toISOString(), prev, [], null);
const w36 = later.files.get('data/catalog/seasons/2026-W36.json');
assert.equal(w36.open, false);
assert.equal(w36.artifacts[0].by_class['darwin/arm64/apple/16g'].grams, 1, 'merged, not regenerated');
assert.equal(later.current.coverage['hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M']['darwin/arm64/apple/16g'], 1, 'prior seasons still count as coverage');


// ── LEARNED CLASSES: split, merge, and the oscillation window ──────────────
const K = 'windows/amd64/nvidia/16g';
const ob = (did, tps, vram) => ({ ref: 'r', node_did: did, klass: K, tokens_per_sec: tps, hw: { os: 'windows', arch: 'amd64', gpu: 'nvidia', ram_gib: 16, vram_gib: vram } });
// Two machines hiding in one bucket: 8 GiB cards at ~10 tok/s, 16 GiB cards at ~100.
const bimodal = [ob('a', 10, 8), ob('b', 11, 8), ob('c', 100, 16), ob('d', 105, 16)];
// The same cut explaining nothing: both halves spread as much as the whole.
const flat = [ob('a', 10, 8), ob('b', 100, 8), ob('c', 11, 16), ob('d', 105, 16)];

const v = classVariance(bimodal);
assert.deepEqual({ dimension: v[K].split.dimension, at: v[K].split.at }, { dimension: 'vram_gib', at: 16 }, 'a clean cut on VRAM is proposed');
assert.equal(classVariance(bimodal.slice(0, 3))[K].split, null, 'a class with fewer than 4 grams never splits');
assert.equal(classVariance(bimodal.slice(0, 3))[K].tps_spread, 10, 'but its spread is still reported');
const m = classVariance(flat, { [K]: { dimension: 'vram_gib', at: 16 } });
assert.equal(m[K].split, null, 'an already-split class is not re-split');
assert.equal(m[K].merge.converged, true, 'halves that each spread >= 0.75 of the whole propose a merge');
assert.equal(classVariance(bimodal, { [K]: { dimension: 'vram_gib', at: 16 } })[K].merge.converged, false, 'halves that explain the spread do not');

// Hysteresis: the split is applied only after K consecutive proposals.
let prior;
for (let i = 1; i < CLASS_VARIANCE_WINDOW; i++) {
  prior = classVarianceWithHistory(bimodal, prior, `t${i}`);
  assert.equal(prior[K].split, null, `aggregate ${i}: proposed, not yet applied`);
  assert.equal(prior[K].proposed, 'split');
  assert.equal(prior[K].streak, i);
  assert.equal(refinedClassOf(K, { vram_gib: 16 }, prior), K, 'grams still key coarse');
}
prior = classVarianceWithHistory(bimodal, prior, 'tK');
assert.equal(prior[K].split.dimension, 'vram_gib', 'applied on the Kth consecutive aggregate');
assert.equal(prior[K].history.length, CLASS_VARIANCE_WINDOW, 'history is bounded to the window');
assert.equal(refinedClassOf(K, { vram_gib: 16 }, prior), `${K}/vram>=16`);
assert.equal(refinedClassOf(K, { vram_gib: 8 }, prior), `${K}/vram<16`);

// A single flat aggregate does not flip it back; the split holds and the streak resets.
prior = classVarianceWithHistory(flat, prior, 'm1');
assert.equal(prior[K].proposed, 'merge');
assert.equal(prior[K].streak, 1);
assert.equal(prior[K].split.dimension, 'vram_gib', 'still split after one converged aggregate');
prior = classVarianceWithHistory(bimodal, prior, 'h1');
assert.equal(prior[K].proposed, 'hold');
assert.equal(prior[K].split.dimension, 'vram_gib', 'a hold in between keeps the split');
// The streak was broken: three more converged aggregates are needed.
for (let i = 1; i < CLASS_VARIANCE_WINDOW; i++) {
  prior = classVarianceWithHistory(flat, prior, `m${i + 1}`);
  assert.equal(prior[K].split.dimension, 'vram_gib', `merge ${i}: proposed, not yet applied`);
}
prior = classVarianceWithHistory(flat, prior, 'mK');
assert.equal(prior[K].split, null, 'merged back after K consecutive converged aggregates');
assert.equal(refinedClassOf(K, { vram_gib: 16 }, prior), K, 'grams key coarse again');
// And it cannot re-split on the very next aggregate.
prior = classVarianceWithHistory(bimodal, prior, 's1');
assert.equal(prior[K].split, null, 'a fresh split proposal starts its own window');
assert.equal(prior[K].streak, 1);
// A class that lost its grams keeps the split in force rather than flapping.
const kept = classVarianceWithHistory([], { [K]: { split: { dimension: 'vram_gib', at: 16 }, history: [] } }, 'e1');
assert.equal(kept[K].split.dimension, 'vram_gib', 'no observations: the split in force is carried');
assert.equal(kept[K].proposed, 'hold');

// The history is carried through current.json: buildSeasons reads the prior publication.
const probeAt = (did, tps, vram) => ({ node_did: did, tokens_per_sec: tps, capabilities: {}, probe_signing_payload_b64: payload({ hardware: { ...hwWin, vram_gib: vram } }, W37 * 1e6, did) });
const bimodalModels = { models: [{ name: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', nodes: [probeAt('did:epn:a', 10, 8), probeAt('did:epn:b', 11, 8), probeAt('did:epn:c', 100, 16), probeAt('did:epn:d', 105, 16)] }] };
let cur = null;
for (let i = 1; i <= CLASS_VARIANCE_WINDOW; i++) {
  cur = buildSeasons(bimodalModels, families, new Date(W37 + i * 1000).toISOString(), new Map(), [], cur).current;
  assert.equal(cur.class_variance[K].history.length, i, `aggregate ${i} carried ${i - 1} prior proposals`);
}
assert.equal(cur.class_variance[K].split.at, 16, 'buildSeasons applies the split once the window is full');
assert.ok(cur.coverage['hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M'][`${K}/vram>=16`], 'coverage is keyed by the refined class once applied');

console.log('ok - seasons');
