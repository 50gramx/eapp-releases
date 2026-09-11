// node tools/seasons.test.mjs
import assert from 'node:assert/strict';
import { buildSeasons, seasonIdOf, seasonWindow, hardwareClassOf } from './seasons.mjs';

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

const r = buildSeasons(models, families, new Date(W37).toISOString(), new Map());
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
const later = buildSeasons({ models: [] }, families, new Date(W37).toISOString(), prev);
const w36 = later.files.get('data/catalog/seasons/2026-W36.json');
assert.equal(w36.open, false);
assert.equal(w36.artifacts[0].by_class['darwin/arm64/apple/16g'].grams, 1, 'merged, not regenerated');
assert.equal(later.current.coverage['hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M']['darwin/arm64/apple/16g'], 1, 'prior seasons still count as coverage');

console.log('ok - seasons');
