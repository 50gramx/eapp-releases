// value-table.mjs — EVERY SEASON, ONE TABLE: WHAT IS WORTH RUNNING HERE.
//
// A season file says what the network proved in one week. Nobody could read
// across them, and none of them could say what a buyer asks first: is this
// build any good, what does a million tokens cost on this kind of machine,
// what does the hosted API charge for the same model, may I serve it to
// anyone, and so is it better run here or there?
//
// This joins, per build and per hardware class:
//
//   PROVED   (signed, every season)  tok/s, effective context, J/token, the
//                                     seasons it was proved in, how many grams
//   PRICED   (derived)               USD per million output / input / batched
//                                     tokens at the class's metered unit
//                                     prices, and the electricity part alone
//   ESTIMATED (labelled)             for a build nobody has measured on the
//                                     class: decode rate from the class's
//                                     calibrated bandwidth / bytes per token
//   CITED    (market.json)           OpenRouter's per-million prices and
//                                     context; the hub's licence and what it
//                                     lets this network serve
//
// and states a verdict per class: cheaper than the hosted API, the API is
// cheaper, only this network runs it, too slow here (estimate), or unproved.
//
// docs/CATALOG_VALUE_TABLE_PLAN_2026-10-27.md (epn-daemon), increment 5.

import { buildProviders } from './providers.mjs';
import { licenceClass, serveScopes, hubRepoOf } from './market.mjs';
import { catalogIndex, placementOf, refRepo } from './model-filing.mjs';
import { modelView, machineMemoryGB } from './value-models.mjs';

export const TABLE_PATH = 'data/catalog/seasons/table.json';

const TEXT_ENGINES = new Set(['ollama', 'llamacpp', 'vllm', 'mlx']);

const MODALITY = {
  ollama: 'text', llamacpp: 'text', vllm: 'text', mlx: 'text',
  'speech-hf': 'speech', 'speech-host': 'speech', 'speech-pod': 'speech', 'mlx-speech': 'speech', 'speech-duplex': 'speech',
  'speaker-id': 'speaker', 'translate-hf': 'translation',
  diffusers: 'image', 'mlx-image': 'image', 'vision-task': 'vision', audiogen: 'audio',
};

// Below this an estimate says the build cannot be USED here: slower than a
// person reads, which no chat, agent or voice turn survives.
export const USABLE_TOKENS_PER_SEC = 2;

/** Mirrors epn-daemon builtin.ActiveShare: the share of a build's bytes a token reads. */
export function activeShare(member, ref) {
  const re = /(\d+(?:\.\d+)?)b[-_]a(\d+(?:\.\d+)?)b/i;
  for (const s of [member, ref]) {
    const m = re.exec(String(s || ''));
    if (!m) continue;
    const total = Number(m[1]);
    const active = Number(m[2]);
    if (total > 0 && active > 0 && active < total) return active / total;
  }
  return 1;
}

/**
 * Mirrors epn-daemon internal/cmd/token_price.go: the µUSD one second of a
 * gram generating meters at, with diskMiB resident, and its energy part.
 * USD per million tokens = µUSD per second / tokens per second.
 */
export function perSecond(prices, diskMiB) {
  if (!prices || !(prices.threads > 0)) return null;
  const vcpu = prices.threads * (prices.vcpu_second_uusd || 0);
  const ram = (diskMiB || 0) / 1024 * (prices.gib_hour_uusd || 0) / 3600;
  const gpu = prices.gpu_backed ? (prices.gpu_second_uusd || 0) : 0;
  // 5 W per engine thread, +150 W for a driven card (hostinfo/energy.go), for one second.
  const watts = prices.threads * 5 + (prices.gpu_backed ? 150 : 0);
  const energy = watts / 3.6e6 * (prices.kwh_uusd || 0);
  return { total: vcpu + ram + gpu + energy, energy };
}

// The network's metered unit prices (epn-daemon config.DefaultPriceFloors), for a
// class no gram of which has reported its own pricing basis yet. The thread count
// is the one assumption, and the row says it is one.
export const ASSUMED_THREADS = 4;
export function assumedBasis(klass) {
  const gpu = String(klass || '').split('/')[2];
  return {
    threads: ASSUMED_THREADS, vcpu_second_uusd: 10, gib_hour_uusd: 3000, gpu_second_uusd: 100, kwh_uusd: 100000,
    gpu_backed: ['nvidia', 'amd', 'apple'].includes(gpu), tariff_basis: 'bootstrap', assumed: true,
  };
}

/** The weights a repo packages: "hf.co/bartowski/google_gemma-4-E2B-it-GGUF:Q4_0" -> "gemma-4-e2b-it". */
export function weightsName(ref) {
  const repo = refRepo(ref);
  if (!repo) return null;
  return repo.split('/')[1]
    .replace(/^(google|microsoft|meta-llama|qwen|mistralai|deepseek-ai|ibm-granite|moonshotai|nvidia|liquidai)_/, '')
    .replace(/([-_.](gguf|mlx|awq|gptq|gguf-.*|i?q\d.*|\d+bit|fp8.*|bnb.*))+$/, '') || null;
}

const r4 = (v) => (v > 0 ? +v.toFixed(4) : null);
const r2 = (v) => (v > 0 ? +v.toFixed(2) : null);

function minPos(a, b) {
  if (!(a > 0)) return b > 0 ? b : null;
  if (!(b > 0)) return a;
  return Math.min(a, b);
}

/** The hosted API row for a build: by its hub repo, its base, or the repo name without its quantizer. */
export function apiIndex(openrouter) {
  const byHF = new Map();
  const byName = new Map();
  for (const m of openrouter?.models || []) {
    if (!m.hugging_face_id) continue;
    if (m.variant && m.variant !== 'free' && m.variant !== 'batch') continue;
    const k = m.hugging_face_id.toLowerCase();
    const row = byHF.get(k) || { ids: [], best: null, free: false, batch: null };
    row.ids.push(m.id);
    if (m.variant === 'free') row.free = true;
    else if (m.variant === 'batch') row.batch = m;
    else if (!row.best || (m.usd_per_m_out ?? Infinity) < (row.best.usd_per_m_out ?? Infinity)) row.best = m;
    byHF.set(k, row);
    byName.set(k.split('/')[1], row);
  }
  return (a) => {
    const cands = [a.base, hubRepoOf(a)].filter(Boolean).map((s) => s.toLowerCase());
    for (const c of cands) if (byHF.has(c)) return byHF.get(c);
    // unsloth/Qwen3.6-27B-GGUF -> qwen3.6-27b: a quantizer's repo of the same weights.
    for (const c of cands) {
      const name = c.split('/')[1]?.replace(/-(gguf|mlx|awq|gptq|fp8|bnb.*|\d+bit)$/i, '');
      if (name && byName.has(name)) return byName.get(name);
    }
    return null;
  };
}

function verdict(cls, api, modality) {
  const out = cls.usd_per_m_out;
  if (cls.tokens_per_sec_best > 0 || cls.proved) {
    if (!api) return modality === 'text' ? 'no hosted API listed' : 'only the network runs it';
    if (out > 0 && api.usd_per_m_out > 0) return out <= api.usd_per_m_out ? 'cheaper than the API' : 'the API is cheaper';
    if (api.usd_per_m_out === 0) return 'the API is free';
    return 'proved';
  }
  if (cls.est_tokens_per_sec > 0) return cls.est_tokens_per_sec < USABLE_TOKENS_PER_SEC ? 'too slow here (estimate)' : 'estimated';
  return 'unproved';
}

/**
 * buildValueTable — one row per build the network has proved in any season,
 * plus every catalog build a hosted API also sells (the market's leaders,
 * proved or not), with per-class proved, priced, estimated and cited columns.
 */
export function buildValueTable({ seasons, families, current, market, evidence = null, machines = null, fleet = null, region = () => null, rooms = [], history = [], generatedAt = new Date().toISOString() }) {
  const catalog = new Map();
  for (const f of families || []) {
    for (const m of f.members || []) {
      for (const a of m.artifacts || []) {
        if (a?.ref) catalog.set(a.ref, { ...a, family: f.id, member: m.id, family_name: f.display_name || f.id, derivative: Boolean(m.derivative) });
      }
    }
  }
  const index = catalogIndex(families);
  // A ref the catalog spells differently (case, quant suffix, a repo it files
  // by name) is filed the way the model pages file it: tools/model-filing.mjs.
  // A quantizer the catalog never filed (bartowski/google_gemma-4-E2B-it-GGUF)
  // packages weights a member already names (unsloth/gemma-4-E2B-it-GGUF): the
  // same repo name less its packager's prefix and format suffix. Only a name
  // exactly one member answers to is used.
  const byWeights = new Map();
  for (const f of families || []) for (const m of f.members || []) for (const art of m.artifacts || []) {
    for (const k of [weightsName(art.ref), weightsName(art.base)]) {
      if (!k) continue;
      const list = byWeights.get(k) || new Set();
      list.add(`${f.id}|${m.id}`);
      byWeights.set(k, list);
    }
  }
  const filed = (ref) => {
    if (catalog.has(ref)) return catalog.get(ref);
    let p = placementOf({ name: ref }, index);
    let w = [...(byWeights.get(weightsName(ref)) || [])];
    // Two members on the same weights: the original, not a derivative of it.
    if (w.length > 1) {
      w = w.filter((k) => {
        const [fid, mid] = k.split('|');
        return !(families || []).find((x) => x.id === fid)?.members?.find((x) => x.id === mid)?.derivative;
      });
    }
    if (!p && w.length === 1) {
      const [family, member] = w[0].split('|');
      p = { family, member, artifact: { ref, quant: String(ref).includes(':') ? String(ref).split(':').pop().toUpperCase() : null, by: refRepo(ref)?.split('/')[0] }, by: 'weights_name' };
    }
    if (!p) return null;
    const f = (families || []).find((x) => x.id === p.family);
    const m = f?.members?.find((x) => x.id === p.member);
    return { ...(p.artifact || {}), ref, family: p.family, member: p.member, family_name: f?.display_name || p.family, derivative: Boolean(m?.derivative) };
  };
  const api = apiIndex(market?.openrouter);
  const cost = current?.cost || {};

  // Proved, folded across every season, oldest first so later seasons refine.
  const proved = new Map(); // ref -> { seasons:Set, art, classes: Map }
  const ids = [...(seasons?.keys?.() || [])].sort();
  for (const id of ids) {
    const s = seasons.get(id);
    for (const a of s?.artifacts || []) {
      if (!a?.ref) continue;
      const row = proved.get(a.ref) || { seasons: new Set(), art: a, classes: new Map() };
      row.seasons.add(id);
      row.art = { ...row.art, ...a };
      for (const [klass, c] of Object.entries(a.by_class || {})) {
        const prev = row.classes.get(klass) || { grams: 0, seasons: new Set() };
        prev.seasons.add(id);
        prev.grams = Math.max(prev.grams, c.grams || 0);
        prev.tokens_per_sec_best = Math.max(prev.tokens_per_sec_best || 0, c.tokens_per_sec_best || 0) || null;
        prev.effective_ctx_best = Math.max(prev.effective_ctx_best || 0, c.effective_ctx_best || 0) || null;
        prev.joules_per_token_best = minPos(prev.joules_per_token_best, c.joules_per_token_best);
        prev.first_at = [prev.first_at, c.first_at].filter(Boolean).sort()[0] || null;
        prev.last_at = [prev.last_at, c.last_at].filter(Boolean).sort().pop() || null;
        prev.caps = new Set([...(prev.caps || []), ...Object.keys(c.caps || {})]);
        row.classes.set(klass, prev);
      }
      proved.set(a.ref, row);
    }
  }

  const refs = new Set(proved.keys());
  // Unproved builds a hosted API also sells: the rung-0 build of each (the
  // quant a season proves first), not every quant of it.
  for (const [ref, a] of catalog) if ((a.rung === 0 || a.rung == null) && api(a)) refs.add(ref);

  const rows = [];
  for (const ref of [...refs].sort()) {
    const cat = filed(ref) || {};
    const signed = proved.get(ref)?.art || {};
    // Today's catalog files the build; the season keeps what was measured.
    const a = { ...signed, ...cat, ...Object.fromEntries(Object.entries(signed).filter(([k, v]) => v != null && !['family', 'member'].includes(k))) };
    if (cat.family) { a.family = cat.family; a.member = cat.member; }
    const engine = a.engine || cat.engine || null;
    const modality = MODALITY[engine] || 'other';
    const share = activeShare(a.member, ref);
    const disk = Number(a.disk_mib) || null;
    const repo = hubRepoOf(a);
    const apiRow = api(a);
    // A quantizer's repo often declares nothing; the weights are the
    // original's, and the hosted API names the original.
    let lic = repo ? market?.licences?.[repo] : null;
    const original = apiRow?.best?.hugging_face_id;
    if ((!lic || !lic.id) && original && market?.licences?.[original]?.id) lic = market.licences[original];
    const licClass = lic?.class || licenceClass(lic?.id);
    const apiCols = apiRow?.best ? {
      openrouter_id: apiRow.best.id, ids: apiRow.ids,
      usd_per_m_in: apiRow.best.usd_per_m_in, usd_per_m_out: apiRow.best.usd_per_m_out,
      usd_per_m_cached_in: apiRow.best.usd_per_m_cached_in, context_length: apiRow.best.context_length,
      free_variant: apiRow.free, batch_usd_per_m_out: apiRow.batch?.usd_per_m_out ?? null,
      source: market?.openrouter?.source || null, fetched_at: market?.openrouter?.fetched_at || null,
    } : null;

    const classes = {};
    const p = proved.get(ref);
    const klasses = new Set([...(p?.classes?.keys() || [])]);
    if (TEXT_ENGINES.has(engine)) for (const [k, c] of Object.entries(cost)) if (c?.engines?.[engine]?.eff_bytes_per_sec > 0) klasses.add(k);
    for (const klass of [...klasses].sort()) {
      const c = p?.classes?.get(klass) || null;
      const basis = cost[klass]?.token_prices || (klass !== 'unknown' && TEXT_ENGINES.has(engine) ? assumedBasis(klass) : null);
      const ps = perSecond(basis, disk);
      const row = {
        proved: Boolean(c),
        grams: c?.grams || 0,
        seasons: c ? [...c.seasons].sort() : [],
        tokens_per_sec_best: c?.tokens_per_sec_best || null,
        effective_ctx_best: c?.effective_ctx_best || null,
        joules_per_token_best: c?.joules_per_token_best || null,
        first_at: c?.first_at || null, last_at: c?.last_at || null,
        caps: c?.caps ? [...c.caps].sort() : [],
      };
      if (ps && row.tokens_per_sec_best > 0 && TEXT_ENGINES.has(engine) && basis.assumed) {
        // Measured speed, assumed machine size: an estimate, and said so.
        row.est_usd_per_m_out = r4(ps.total / row.tokens_per_sec_best);
        row.est_price_basis = `the network's metered rates for a ${ASSUMED_THREADS}-thread machine of this class`;
      } else if (ps && row.tokens_per_sec_best > 0 && TEXT_ENGINES.has(engine)) {
        row.usd_per_m_out = r4(ps.total / row.tokens_per_sec_best);
        row.usd_per_m_energy = r4(ps.energy / row.tokens_per_sec_best);
        // Measured energy, where the gram read it, replaces the model's.
        if (row.joules_per_token_best > 0) row.usd_per_m_energy = r4(row.joules_per_token_best * 1e6 / 3.6e6 * (basis.kwh_uusd || 0) / 1e6);
      }
      if (!row.tokens_per_sec_best && TEXT_ENGINES.has(engine)) {
        const bw = cost[klass]?.engines?.[engine]?.eff_bytes_per_sec;
        if (bw > 0 && disk > 0) {
          row.est_tokens_per_sec = r2(bw / (disk * 1048576 * share));
          row.est_basis = 'machines of this class';
          if (ps && row.est_tokens_per_sec > 0) row.est_usd_per_m_out = r4(ps.total / row.est_tokens_per_sec);
        }
      }
      if (basis) row.tariff_basis = basis.tariff_basis || null;
      row.verdict = verdict({ ...row, usd_per_m_out: row.usd_per_m_out ?? row.est_usd_per_m_out }, apiCols, modality);
      classes[klass] = row;
    }

    // The cheapest proved class against the API: the one line a reader wants.
    let best = null;
    for (const [klass, c] of Object.entries(classes)) {
      if (c.usd_per_m_out > 0 && (!best || c.usd_per_m_out < best.usd_per_m_out)) best = { class: klass, usd_per_m_out: c.usd_per_m_out };
    }
    if (best && apiCols?.usd_per_m_out > 0) best.vs_api = +(best.usd_per_m_out / apiCols.usd_per_m_out).toFixed(2);

    rows.push({
      ref, family: a.family || null, member: a.member || null, quant: a.quant || null, engine, modality,
      base: a.base || null, hub_repo: repo || null,
      publisher: a.by || a.publisher || null, derivative: Boolean(a.derivative), cohort: a.cohort ?? null, rung: a.rung ?? null,
      disk_mib: disk, active_share: share < 1 ? +share.toFixed(4) : 1,
      licence: { id: lic?.id || null, name: lic?.name || null, class: licClass, serve_scopes: serveScopes(licClass), gated: Boolean(lic?.gated), source: lic?.source || null, fetched_at: lic?.fetched_at || null },
      seasons: p ? [...p.seasons].sort() : [],
      api: apiCols,
      no_hosted_api: !apiCols,
      best,
      classes,
    });
  }

  const count = (pred) => rows.filter(pred).length;
  const memories = rows.flatMap((r) => Object.keys(r.classes).map(machineMemoryGB)).filter((v) => v > 0);
  const models = modelView(rows, { families, largestMachineGB: memories.length ? Math.max(...memories) : null, evidence, market, machines });
  return {
    generated_at: generatedAt,
    seasons: ids,
    note: 'Proved columns are signed by the grams that measured them, across every season. Prices here are each machine\'s signed size (CPUs, memory, card) at the network\'s metered price list (USD per million tokens = µUSD per second / tokens per second). Estimates are labelled and never signed. API prices and licences are cited from OpenRouter and the Hugging Face hub with the time they were read.',
    usable_tokens_per_sec: USABLE_TOKENS_PER_SEC,
    counts: {
      rows: rows.length,
      proved: count((r) => r.seasons.length > 0),
      with_api: count((r) => r.api),
      network_only: count((r) => r.no_hosted_api && r.seasons.length > 0 && r.modality !== 'text'),
      cheaper_than_api_somewhere: count((r) => Object.values(r.classes).some((c) => c.verdict === 'cheaper than the API')),
      licence_known: count((r) => r.licence.id),
    },
    model_counts: {
      models: models.length,
      measured: models.filter((m) => m.status === 'measured').length,
      sold_by_an_api: models.filter((m) => m.hosted_api).length,
      measured_and_no_api_sells_it: models.filter((m) => m.status === 'measured' && !m.hosted_api).length,
      cheaper_here_than_the_api: models.filter((m) => m.cheapest && m.hosted_api?.output_usd_per_million > 0 && m.cheapest.cost_usd_per_million <= m.hosted_api.output_usd_per_million).length,
      too_big_for_every_machine: models.filter((m) => m.too_big_for_the_network).length,
    },
    // The grams behind every signed number (tools/providers.mjs).
    providers: buildProviders({
      evidence, machines, fleet: fleet || [], region, rooms, history, generatedAt,
      runs: models.flatMap((m) => (m.measured_on || []).map((r) => ({ ...r, model: m.model, page: m.page }))),
    }),
    // Logos for every model maker, publisher, card maker and host: each one's own
    // Hugging Face avatar (market.json).
    logos: Object.fromEntries(Object.entries(market?.avatars || {})
      .filter(([, v]) => v?.url).map(([org, v]) => [org, v.url])),
    price_list: {
      usd_per_cpu_hour: 0.036, usd_per_gb_ram_hour: 0.003, usd_per_gpu_hour: 0.36, usd_per_kwh: 0.1,
      source: 'epn-daemon config.DefaultPriceFloors: what metering charges every gram',
    },
    models,
    rows,
  };
}
