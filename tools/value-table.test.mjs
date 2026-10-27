// node tools/value-table.test.mjs
import assert from 'node:assert/strict';
import { buildValueTable, activeShare, perSecond, apiIndex, USABLE_TOKENS_PER_SEC } from './value-table.mjs';
import { licenceClass, serveScopes, licenceFromHub, hubRepoOf, perM, openRouterRow } from './market.mjs';

// ── market.mjs ──────────────────────────────────────────────────────────────
assert.equal(perM('0.00000015'), 0.15, 'OpenRouter prices are USD per token');
assert.equal(perM('-1'), null, 'a negative price is "varies", never zero');
assert.equal(perM(undefined), null);
assert.equal(licenceClass('apache-2.0'), 'open');
assert.equal(licenceClass('mit'), 'open');
assert.equal(licenceClass('cc-by-nc-4.0'), 'non-commercial');
assert.equal(licenceClass('llama3.2'), 'restricted', 'a community licence bounds use');
assert.equal(licenceClass('qwen-community-1.0'), 'restricted');
assert.equal(licenceClass(''), 'unknown');
assert.deepEqual(serveScopes('open'), ['own', 'gramx', 'open-mesh']);
assert.deepEqual(serveScopes('restricted'), ['own', 'gramx'], 'internal use, never the open mesh');
assert.deepEqual(serveScopes('non-commercial'), ['own']);
assert.deepEqual(serveScopes('unknown'), ['own', 'gramx'], 'unknown is treated as restricted');
assert.equal(licenceFromHub({ tags: ['gguf', 'license:apache-2.0'] }).class, 'open');
assert.equal(licenceFromHub({ cardData: { license: 'other', license_name: 'qwen-community-1.0' } }).class, 'restricted');
assert.equal(licenceFromHub({ gated: 'manual', tags: [] }).gated, true);
assert.equal(hubRepoOf({ ref: 'hf.co/unsloth/Qwen3.6-27B-GGUF:Q4_K_M' }), 'unsloth/Qwen3.6-27B-GGUF');
assert.equal(hubRepoOf({ ref: 'hf.co/unsloth/Qwen3.6-27B-GGUF:Q4_K_M', base: 'Qwen/Qwen3.6-27B' }), 'Qwen/Qwen3.6-27B', 'the licence is the base model\'s');
assert.equal(hubRepoOf({ ref: 'llama3.2:1b' }), null, 'an Ollama library tag is not a hub repo');
assert.equal(openRouterRow({ id: 'qwen/qwen3.8-flash', pricing: { prompt: '0.00000015', completion: '0.00000047' } }).usd_per_m_out, 0.47);

// ── the video's arithmetic, mirrored from the daemon ─────────────────────────
assert.equal(activeShare('48b', 'hf.co/bartowski/moonshotai_Kimi-Linear-48B-A3B-Instruct-GGUF:Q4_K_M'), 3 / 48);
assert.equal(activeShare('27b', 'hf.co/unsloth/Qwen3.6-27B-GGUF:Q4_K_M'), 1);
// 3 threads at the floor table, 2 GiB resident: ~32 µUSD a second, so a gram
// decoding 10 tok/s meters ~$3.2 per million output tokens.
const kaggle = { threads: 3, vcpu_second_uusd: 10, gib_hour_uusd: 3000, kwh_uusd: 100000, tariff_basis: 'bootstrap' };
const ps = perSecond(kaggle, 2048);
assert.ok(Math.abs(ps.total / 10 - 3.208) < 0.01, `$${(ps.total / 10).toFixed(3)}/M`);
assert.equal(perSecond(null, 2048), null);

// ── the table ────────────────────────────────────────────────────────────────
const families = [
  { id: 'gemma-4', members: [{ id: 'e2b', artifacts: [{ ref: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', engine: 'ollama', quant: 'Q4_K_M', by: 'unsloth', base: 'google/gemma-4-E2B-it', disk_mib: 3000, rung: 0 }] }] },
  { id: 'qwen-3-6', members: [{ id: '27b', artifacts: [{ ref: 'hf.co/unsloth/Qwen3.6-27B-GGUF:Q4_K_M', engine: 'ollama', quant: 'Q4_K_M', by: 'unsloth', disk_mib: 16038, rung: 0 },
    { ref: 'hf.co/unsloth/Qwen3.6-27B-GGUF:IQ1_S', engine: 'ollama', quant: 'IQ1_S', by: 'unsloth', disk_mib: 6000, rung: 7 }] }] },
  { id: 'mms-tts', members: [{ id: 'hi', artifacts: [{ ref: 'facebook/mms-tts-hin', engine: 'speech-hf', quant: 'FP32', by: 'facebook', disk_mib: 139 }] }] },
];
const klass = 'linux/amd64/none/32g';
const seasons = new Map([
  ['2026-W43', { artifacts: [{ ref: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', family: 'gemma-4', member: 'e2b', engine: 'ollama', disk_mib: 3000,
    by_class: { [klass]: { grams: 1, tokens_per_sec_best: 8, effective_ctx_best: 8192, first_at: '2026-10-20T00:00:00Z', last_at: '2026-10-20T00:00:00Z' } } }] }],
  ['2026-W44', { artifacts: [
    { ref: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', family: 'gemma-4', member: 'e2b', engine: 'ollama', disk_mib: 3000,
      by_class: { [klass]: { grams: 2, tokens_per_sec_best: 12, effective_ctx_best: 4096, first_at: '2026-10-27T00:00:00Z', last_at: '2026-10-27T00:00:00Z' } } },
    { ref: 'facebook/mms-tts-hin', family: 'mms-tts', member: 'hi', engine: 'speech-hf', disk_mib: 139,
      by_class: { [klass]: { grams: 1, caps: { 'audio.out': 1 } } } },
  ] }],
]);
const current = { cost: { [klass]: { token_prices: kaggle, engines: { ollama: { eff_bytes_per_sec: 20 * 2 ** 30 } } } } };
const market = {
  openrouter: { source: 'https://openrouter.ai/api/v1/models', fetched_at: '2026-10-27T00:00:00Z', models: [
    { id: 'google/gemma-4-e2b-it', hugging_face_id: 'google/gemma-4-E2B-it', usd_per_m_in: 0.02, usd_per_m_out: 0.04, context_length: 131072 },
    { id: 'qwen/qwen3.6-27b', hugging_face_id: 'Qwen/Qwen3.6-27B', usd_per_m_in: 0.32, usd_per_m_out: 3.2, context_length: 262144 },
  ] },
  licences: { 'google/gemma-4-E2B-it': { id: 'gemma', class: 'restricted', source: 'hub', fetched_at: 'x' } },
};
const t = buildValueTable({ seasons, families, current, market, generatedAt: '2026-10-27T12:00:00Z' });
const row = (ref) => t.rows.find((r) => r.ref === ref);

const gemma = row('hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M');
assert.deepEqual(gemma.seasons, ['2026-W43', '2026-W44'], 'one row across every season it was proved in');
assert.equal(gemma.classes[klass].tokens_per_sec_best, 12, 'the best rate across seasons');
assert.equal(gemma.classes[klass].effective_ctx_best, 8192, 'the best context across seasons');
assert.deepEqual(gemma.classes[klass].seasons, ['2026-W43', '2026-W44']);
assert.ok(gemma.classes[klass].usd_per_m_out > 2.5, 'priced at the class\'s metered rate');
assert.equal(gemma.api.openrouter_id, 'google/gemma-4-e2b-it', 'joined to the hosted API by its base repo');
assert.equal(gemma.classes[klass].verdict, 'the API is cheaper', 'a CPU gram\'s metered million is dearer than $0.04');
assert.equal(gemma.licence.class, 'restricted');
assert.deepEqual(gemma.licence.serve_scopes, ['own', 'gramx']);
assert.ok(gemma.best.vs_api > 1);

const qwen = row('hf.co/unsloth/Qwen3.6-27B-GGUF:Q4_K_M');
assert.ok(qwen, 'an unproved build the API sells is in the table');
assert.equal(qwen.api.openrouter_id, 'qwen/qwen3.6-27b', 'a quantizer\'s repo joins the original by name');
assert.ok(qwen.classes[klass].est_tokens_per_sec < USABLE_TOKENS_PER_SEC, 'a dense 16 GB build is ~1.3 tok/s at 20 GiB/s');
assert.equal(qwen.classes[klass].verdict, 'too slow here (estimate)');
assert.equal(qwen.classes[klass].proved, false);
assert.equal(row('hf.co/unsloth/Qwen3.6-27B-GGUF:IQ1_S'), undefined, 'only the rung-0 build of an unproved model, not every quant');

const mms = row('facebook/mms-tts-hin');
assert.equal(mms.no_hosted_api, true);
assert.equal(mms.classes[klass].verdict, 'only the network runs it', 'speech nobody hosts: the network\'s own column');
assert.equal(t.counts.network_only, 1);
assert.deepEqual(t.seasons, ['2026-W43', '2026-W44']);

// The API index ignores paid variants other than :free and :batch.
const idx = apiIndex({ models: [{ id: 'a/b:nitro', variant: 'nitro', hugging_face_id: 'a/b', usd_per_m_out: 1 }] });
assert.equal(idx({ base: 'a/b' }), null);

console.log('ok - value table');
