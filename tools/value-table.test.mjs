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
assert.equal(licenceClass('llama3.2'), 'open-weights', "Llama's terms permit serving others");
assert.equal(licenceClass('gemma'), 'open-weights');
assert.equal(licenceClass('qwen-community-1.0'), 'restricted', 'Flash Next: no API serving without a licence');
assert.equal(licenceClass('other'), 'restricted', 'unread terms never assumed to allow strangers');
assert.equal(licenceClass('mrl'), 'non-commercial');
assert.equal(licenceClass(''), 'unknown');
assert.deepEqual(serveScopes('open'), ['own', 'gramx', 'open-mesh']);
assert.deepEqual(serveScopes('restricted'), ['own', 'gramx'], 'internal use, never the open mesh');
assert.deepEqual(serveScopes('non-commercial'), ['own']);
assert.deepEqual(serveScopes('unknown'), ['own', 'gramx', 'open-mesh'], 'nothing declared is shown as such, not yet a stop');
assert.deepEqual(serveScopes('open-weights'), ['own', 'gramx', 'open-mesh']);
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
  licences: { 'google/gemma-4-E2B-it': { id: 'qwen-community-1.0', class: 'restricted', source: 'hub', fetched_at: 'x' } },
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

{
  // A quantizer's repo with no licence takes the original's, via the hosted API's repo.
  const fam = [{ id: 'qwen-3-8', members: [{ id: 'flash-next', artifacts: [{ ref: 'hf.co/someone/Qwen3.8-Flash-Next-GGUF:Q4_K_M', engine: 'llamacpp', quant: 'Q4_K_M', disk_mib: 70000, rung: 0 }] }] }];
  const mk = {
    openrouter: { models: [{ id: 'qwen/qwen3.8-flash', hugging_face_id: 'Qwen/Qwen3.8-Flash-Next', usd_per_m_in: 0.15, usd_per_m_out: 0.47 }] },
    licences: { 'Qwen/Qwen3.8-Flash-Next': { id: 'other', name: 'qwen-community-1.0', class: 'restricted' } },
  };
  const tt = buildValueTable({ seasons: new Map(), families: fam, current: {}, market: mk });
  const r = tt.rows[0];
  assert.equal(r.api.openrouter_id, 'qwen/qwen3.8-flash');
  assert.equal(r.licence.class, 'restricted', 'Flash Next: the original\'s community licence');
  assert.deepEqual(r.licence.serve_scopes, ['own', 'gramx']);
  console.log('ok - a quantizer inherits the original\'s licence');
}

{
  // ── the same table in words a buyer reads (tools/value-models.mjs) ─────────
  const { machineName, precisionName, licenceName } = await import('./value-models.mjs');
  assert.equal(machineName('linux/amd64/nvidia/32g'), 'Linux PC with an NVIDIA GPU, 32 GB');
  assert.equal(machineName('darwin/arm64/apple/16g'), 'Mac with Apple silicon, 16 GB');
  assert.equal(machineName('windows/amd64/none/8g'), 'Windows PC with no GPU, 8 GB');
  assert.equal(machineName('unknown'), 'machine not reported');
  assert.equal(precisionName('Q4_K_M'), '4-bit');
  assert.equal(precisionName('IQ1_S'), '1-bit');
  assert.equal(precisionName('BF16'), '16-bit (full precision)');
  assert.equal(precisionName('FP8'), '8-bit');
  assert.equal(precisionName('4bit'), '4-bit');
  assert.equal(licenceName({ id: 'other', name: 'qwen-community-1.0' }), 'Qwen Community 1.0 licence');
  assert.equal(licenceName({ id: 'apache-2.0' }), 'Apache 2.0');

  const { machineOf, meteredUsdPerM, isRepackage } = await import('./value-models.mjs');
  const kaggle = { os: 'linux', arch: 'amd64', cpus: 4, ram_gib: 31.3, gpu: 'nvidia', vram_gib: 15, gpu_model: 'Tesla T4', gpu_count: 2, host: 'Kaggle' };
  assert.equal(machineOf(kaggle).name, 'Linux · 2× Tesla T4 15 GB · 4 CPUs · 31 GB RAM', 'the card and its memory, not the system memory, name a GPU machine');
  assert.equal(machineOf(kaggle).host_org, 'kaggle');
  assert.equal(machineOf({ os: 'windows', cpus: 16, ram_gib: 15.9, gpu: 'nvidia', vram_gib: 12 }).name, 'Windows · NVIDIA 12 GB · 16 CPUs · 16 GB RAM');
  assert.notEqual(machineOf({ os: 'windows', cpus: 12, ram_gib: 15.7, gpu: 'nvidia', vram_gib: 4 }).key,
    machineOf({ os: 'windows', cpus: 16, ram_gib: 15.9, gpu: 'nvidia', vram_gib: 12 }).key, 'a 4 GB card and a 12 GB card are two machines');
  // 3 threads × 10 + 1 GiB × 3000/3600 + 100 (card) + (3×5+150) W × $0.10/kWh, ÷ 100 tok/s
  assert.equal(meteredUsdPerM({ cpus: 4, gpu: 'nvidia' }, 1024, 100), +((30 + 3000 / 3600 + 100 + 165 / 3.6e6 * 100000) / 100).toFixed(4));
  assert.equal(meteredUsdPerM({ gpu: 'nvidia' }, 1024, 100), null, 'no signed CPU count, no price');
  assert.ok(isRepackage('Llama-3.2-1B-Instruct-Q4_K_M-GGUF', ['meta-llama/Llama-3.2-1B-Instruct']), 'another file of the same weights is a build');
  assert.ok(isRepackage('Llama-3.2-3B-Instruct', ['meta-llama/Llama-3.2-3B-Instruct']));
  assert.ok(!isRepackage('Llama-3.2-3B-Instruct-abliterated-GGUF', ['meta-llama/Llama-3.2-3B-Instruct']), 'changed weights are a variant');
  assert.ok(!isRepackage('Llama-3.2-1B-Instruct-LinkLlama-Cap50', ['meta-llama/Llama-3.2-1B-Instruct']));

  const { paramsOf } = await import('./value-models.mjs');
  assert.deepEqual(paramsOf({ member: '26b-a4b' }), { params_b: 26, active_params_b: 4, params_basis: 'named' }, 'a mixture of experts names both sizes');
  assert.deepEqual(paramsOf({ declared: '5.1B', member: 'e2b' }), { params_b: 5.1, active_params_b: 2, params_basis: 'named' }, '"E2B" is the effective size of a larger model');
  assert.equal(paramsOf({ name: 'NLLB-200 distilled 600M' }).params_b, 0.6);
  assert.equal(paramsOf({ name: 'Llama 3.2 1B' }).params_b, 1, 'the version number is not a size');
  assert.equal(paramsOf({ name: 'Granite 4bit' }).params_b, null, '"4bit" is a precision, not 4 billion');
  const est = paramsOf({ name: 'GLM-4.7 Flash', diskMib: 16 * 1024, quant: 'Q4_K_M' });
  assert.equal(est.params_basis, 'estimated from download size');
  assert.ok(est.params_b > 26 && est.params_b < 30, `16 GiB at ~4.85 bits is ~28B, got ${est.params_b}`);

  const m = t.models.find((x) => x.page === '/inferences/gemma-4/e2b');
  assert.ok(m, 'one entry per model, not per build per class');
  assert.equal(m.fastest.machine, 'Linux PC with no GPU, 32 GB');
  assert.equal(m.fastest.tokens_per_sec, 12);
  assert.equal(m.fastest.build, '4-bit by unsloth');
  assert.deepEqual(m.weeks_measured, ['2026-W43', '2026-W44']);
  assert.equal(m.hosted_api.output_usd_per_million, 0.04);
  assert.equal(m.licence.you_may_serve, "Only your own machines and your company's");
  assert.match(m.bottom_line, /^12 tokens a second on a Linux PC with no GPU, 32 GB\. About \$\d+\.\d\d per million tokens here, against OpenRouter's \$0\.04: the API is \d+× cheaper/);
  const speech = t.models.find((x) => x.page === '/inferences/mms-tts/hi');
  assert.equal(speech.kind, 'Text to speech');
  assert.match(speech.bottom_line, /no hosted API sells it/);
  const unmeasured = t.models.find((x) => x.page === '/inferences/qwen-3-6/27b');
  assert.equal(unmeasured.status, 'not measured yet');
  assert.equal(unmeasured.download_gb, 15.7, 'the smallest standard build, not the largest');
  assert.ok(t.models.indexOf(m) < t.models.indexOf(unmeasured), 'measured models first');
  console.log('ok - the table in plain words');
}

{
  // A class no gram has priced yet: measured speed, the network's rates, an
  // assumed machine size -- an estimate, said so.
  const fam = [{ id: 'llama-3-2', members: [{ id: '1b', artifacts: [{ ref: 'llama3.2:1b', engine: 'ollama', quant: 'Q4_K_M', disk_mib: 1300, rung: 0 }] }] }];
  const ss = new Map([['2026-W44', { artifacts: [{ ref: 'llama3.2:1b', engine: 'ollama', disk_mib: 1300, by_class: { 'darwin/arm64/apple/8g': { grams: 1, tokens_per_sec_best: 26 } } }] }]]);
  const tt = buildValueTable({ seasons: ss, families: fam, current: {}, market: {} });
  const c = tt.rows[0].classes['darwin/arm64/apple/8g'];
  assert.equal(c.usd_per_m_out, undefined, 'never a measured price');
  assert.ok(c.est_usd_per_m_out > 0 && /4-thread/.test(c.est_price_basis));
  assert.equal(tt.models[0].cheapest.cost_is_estimate, true);

  // A quantizer's repo the catalog never filed joins the member with the same weights.
  const fam2 = [{ id: 'gemma-4', display_name: 'Gemma 4', vendor: 'Google', members: [{ id: 'e2b', display_name: 'Gemma 4 E2B', artifacts: [{ ref: 'hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M', engine: 'ollama', disk_mib: 3000, rung: 0 }] }] }];
  const ss2 = new Map([['2026-W40', { artifacts: [{ ref: 'hf.co/bartowski/google_gemma-4-E2B-it-GGUF:Q4_0', by_class: { 'linux/amd64/nvidia/32g': { grams: 1, tokens_per_sec_best: 82 } } }] }]]);
  const t2 = buildValueTable({ seasons: ss2, families: fam2, current: {}, market: {} });
  const bart = t2.rows.find((r) => r.ref.includes('bartowski'));
  assert.equal(bart.member, 'e2b');
  assert.equal(t2.models.length, 1);
  assert.equal(t2.models[0].model, 'Gemma 4 E2B');
  assert.equal(t2.models[0].fastest.tokens_per_sec, 82);
  console.log('ok - estimated prices are labelled; quantizers file by their weights');
}

// ── machines.mjs + the metered breakdown ────────────────────────────────────
{
  const { cpuName, buildMachines, sheetFor } = await import('./machines.mjs');
  const { meteredBreakdown, meteredUsdPerM } = await import('./value-models.mjs');
  assert.deepEqual(cpuName('Intel(R) Xeon(R) CPU @ 2.20GHz'), { name: 'Intel Xeon', clock_ghz: 2.2 });
  assert.deepEqual(cpuName('AMD Ryzen 7 5800H with Radeon Graphics'), { name: 'AMD Ryzen 7 5800H with Radeon Graphics', clock_ghz: null });
  const did = 'did:epn:x';
  const res = (rt, value, extra, ts) => ({ resource_type: rt, signed_result: { result: { node_did: did, metric: rt, value, unit: '', ts, extra } } });
  const m = buildMachines([
    res('cpu', 300, { cores_logical: 4, cores_physical: 2, cpu_model: 'Intel(R) Xeon(R) CPU @ 2.00GHz' }, 2e18),
    res('mem', 2650, { total_mb: 32098 }, 2e18),
    res('gpu', 23, { name: 'Tesla T4', mem_total_mb: 14912 }, 2e18),
  ]);
  const cpuOnly = sheetFor(m, did, { cpus: 4, ram_gib: 31.3, gpu: 'none' });
  assert.equal(cpuOnly.cpu.clock_ghz, 2);
  assert.equal(cpuOnly.memory.total_gb, 31.3);
  assert.equal(cpuOnly.gpu, undefined, 'a CPU run is never given the card');
  const onCard = sheetFor(m, did, { cpus: 4, ram_gib: 31.3, gpu: 'nvidia', vram_gib: 15, gpu_model: 'Tesla T4' });
  assert.equal(onCard.gpu.name, 'Tesla T4');
  assert.equal(sheetFor(m, did, { cpus: 8, ram_gib: 16, gpu: 'none' }), null, 'another machine of the same gram gets nothing');
  const b = meteredBreakdown({ cpus: 4, gpu: 'nvidia' }, 1024, 100);
  assert.equal(b.usd_per_million, meteredUsdPerM({ cpus: 4, gpu: 'nvidia' }, 1024, 100));
  assert.deepEqual(b.lines.map((l) => l.resource), ['CPU', 'Memory', 'GPU', 'Energy']);
  assert.ok(Math.abs(b.lines.reduce((s, l) => s + l.usd_per_million, 0) - b.usd_per_million) < 1e-3, 'the lines add up to the total');
  console.log('machines + breakdown ok');
}
