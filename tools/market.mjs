// market.mjs — WHAT THE WORLD SAYS ABOUT A MODEL, CITED, NEVER SIGNED.
//
// The seasons say what this network PROVED: speed, fit, context, energy, per
// hardware class, signed by the gram that measured it. Three facts a buyer
// weighs beside those are not ours to prove, and the catalog carried none of
// them:
//
//   1. PRICE. What a hosted API charges per million tokens, input and output
//      apart, and what context it serves -- OpenRouter's public model list
//      (no key). The number a gram's metered price has to beat.
//   2. RIGHTS. The licence the publisher ships the weights under, from the
//      Hugging Face hub's own `license:` tag. "Free" means three things: open
//      (apache, mit), open weights with use limits (community licences --
//      Qwen 3.8 Flash Next's forbids serving others through an API without a
//      licence), and non-commercial.
//   3. QUALITY. What benchmarks say the model can do (increment 7).
//
// Each is held here with its source and when it was fetched, and published
// in data/catalog/market.json. The value table cites it; nothing here is ever
// presented as something the network measured.
//
//   node tools/market.mjs refresh     # CI, before the aggregator; never fatal
//
// docs/CATALOG_VALUE_TABLE_PLAN_2026-10-27.md (epn-daemon), increments 3-4.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const MARKET_PATH = 'data/catalog/market.json';
const MODELS_PATH = 'data/models.json';
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const HF_API = 'https://huggingface.co/api/models/';

// OpenRouter's list changes daily at most; a licence almost never. Each is
// refreshed on its own clock so the 15-minute aggregator costs nothing.
const OPENROUTER_TTL_MS = 20 * 3600 * 1000;
const LICENCE_TTL_MS = 7 * 24 * 3600 * 1000;
// The hub is shared with every gram's discovery; a few dozen lookups a run,
// one at a time, clears a catalog of a few hundred repos within a day.
const LICENCES_PER_RUN = 60;
const LICENCE_GAP_MS = 300;

export function readMarket(path = MARKET_PATH) {
  if (!existsSync(path)) return { openrouter: null, licences: {} };
  try {
    const m = JSON.parse(readFileSync(path, 'utf8'));
    return { openrouter: m.openrouter || null, licences: m.licences || {}, generated_at: m.generated_at };
  } catch {
    return { openrouter: null, licences: {} };
  }
}

// perM turns OpenRouter's USD-per-token strings into USD per million tokens.
// Absent and negative (OpenRouter's "varies") read as unknown, never zero.
export function perM(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return +(n * 1e6).toFixed(6);
}

/** One OpenRouter model row, reduced to what the value table reads. */
export function openRouterRow(m) {
  const p = m.pricing || {};
  return {
    id: m.id,
    hugging_face_id: m.hugging_face_id || null,
    name: m.name || m.id,
    context_length: Number(m.context_length) || null,
    max_completion_tokens: Number(m.top_provider?.max_completion_tokens) || null,
    usd_per_m_in: perM(p.prompt),
    usd_per_m_out: perM(p.completion),
    usd_per_m_cached_in: perM(p.input_cache_read),
    modality: m.architecture?.modality || null,
    variant: (m.id.split(':')[1] || null),
    created: Number(m.created) || null,
  };
}

// ── RIGHTS ──────────────────────────────────────────────────────────────────

const OPEN = new Set(['apache-2.0', 'mit', 'bsd', 'bsd-2-clause', 'bsd-3-clause', 'cc-by-4.0', 'cc-by-sa-4.0',
  'cc0-1.0', 'unlicense', 'openrail', 'openrail++', 'creativeml-openrail-m', 'bigscience-openrail-m', 'mpl-2.0',
  'artistic-2.0', 'isc', 'zlib', 'odc-by', 'pddl', 'cdla-permissive-2.0', 'ecl-2.0', 'afl-3.0', 'lgpl-3.0', 'gpl-3.0', 'agpl-3.0']);

/**
 * licenceClass sorts a licence id into what it lets this network do:
 *   open            serve anyone, including the open mesh
 *   restricted      open weights with use limits (community / custom
 *                   licences): own grams and a company's gramx, not the
 *                   open mesh, until the terms are read
 *   non-commercial  research / personal only
 *   unknown         nothing declared: treated as restricted
 */
export function licenceClass(id) {
  const l = String(id || '').toLowerCase().trim();
  if (!l) return 'unknown';
  if (/(^|-)nc(-|$)|non-?commercial|research|cc-by-nc/.test(l)) return 'non-commercial';
  if (OPEN.has(l)) return 'open';
  // llama2/llama3.x, gemma, qwen, deepseek, "other", "custom": weights are
  // published, use is bounded by terms only a person can accept.
  return 'restricted';
}

/** The scopes a licence class may be served to (D79-style: own, company, open mesh). */
export function serveScopes(cls) {
  switch (cls) {
    case 'open': return ['own', 'gramx', 'open-mesh'];
    case 'restricted': return ['own', 'gramx'];
    case 'non-commercial': return ['own'];
    default: return ['own', 'gramx'];
  }
}

/** The hub repo a catalog artifact's licence is read from: its base, else its own repo. */
export function hubRepoOf(a) {
  if (a?.base && /^[\w.-]+\/[\w.-]+$/.test(a.base)) return a.base;
  const m = String(a?.ref || '').match(/^(?:hf\.co\/)?([\w.-]+\/[\w.-]+?)(?::[\w.-]+)?$/);
  return m ? m[1] : null;
}

export function licenceFromHub(info) {
  const tags = Array.isArray(info?.tags) ? info.tags : [];
  const tag = tags.find((t) => typeof t === 'string' && t.startsWith('license:'));
  const id = (info?.cardData?.license || (tag ? tag.slice('license:'.length) : '') || '').toString();
  const name = info?.cardData?.license_name || null;
  const effective = id === 'other' && name ? name : id;
  return {
    id: id || null,
    name,
    link: info?.cardData?.license_link || null,
    class: licenceClass(effective),
    gated: Boolean(info?.gated),
  };
}

function catalogRepos(models) {
  const repos = new Set();
  for (const f of models?.families || []) {
    for (const m of f.members || []) {
      for (const a of m.artifacts || []) {
        const r = hubRepoOf(a);
        if (r) repos.add(r);
      }
    }
  }
  return [...repos];
}

async function fetchJSON(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'epn-aggregator (+https://github.com/50gramx/eapp-releases)' }, signal: ctl.signal });
    if (!res.ok) return { status: res.status };
    return { status: res.status, body: await res.json() };
  } finally {
    clearTimeout(t);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function refresh(now = Date.now()) {
  const market = readMarket();
  const models = existsSync(MODELS_PATH) ? JSON.parse(readFileSync(MODELS_PATH, 'utf8')) : null;

  const orAt = Date.parse(market.openrouter?.fetched_at || '') || 0;
  if (now - orAt > OPENROUTER_TTL_MS) {
    try {
      const r = await fetchJSON(OPENROUTER_URL);
      if (r.body?.data?.length) {
        market.openrouter = {
          source: OPENROUTER_URL,
          fetched_at: new Date(now).toISOString(),
          models: r.body.data.map(openRouterRow),
        };
        console.log(`[market] openrouter: ${market.openrouter.models.length} models`);
      } else {
        console.log(`[market] openrouter: HTTP ${r.status}, keeping the previous list`);
      }
    } catch (e) {
      console.log(`[market] openrouter unreachable (${e.message}), keeping the previous list`);
    }
  }

  // Oldest first: a repo never looked up, then the stalest.
  const due = catalogRepos(models)
    .map((repo) => ({ repo, at: Date.parse(market.licences[repo]?.fetched_at || '') || 0 }))
    .filter((x) => now - x.at > LICENCE_TTL_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, LICENCES_PER_RUN);
  let got = 0;
  for (const { repo } of due) {
    try {
      const r = await fetchJSON(HF_API + repo, 10000);
      if (r.status === 429) { console.log('[market] hub throttled; the rest wait for the next run'); break; }
      if (r.body) {
        market.licences[repo] = { ...licenceFromHub(r.body), source: HF_API + repo, fetched_at: new Date(now).toISOString() };
        got++;
      } else if (r.status === 404 || r.status === 401) {
        market.licences[repo] = { id: null, class: 'unknown', gated: r.status === 401, source: HF_API + repo, fetched_at: new Date(now).toISOString() };
      }
    } catch { /* the next run asks again */ }
    await sleep(LICENCE_GAP_MS);
  }
  console.log(`[market] licences: ${got} resolved this run, ${Object.keys(market.licences).length} held`);

  writeFileSync(MARKET_PATH, JSON.stringify({
    generated_at: new Date(now).toISOString(),
    note: 'Cited facts about models from their own sources -- prices (OpenRouter) and licences (the Hugging Face hub). Not measured by this network; every row names its source and when it was read.',
    openrouter: market.openrouter,
    licences: Object.fromEntries(Object.entries(market.licences).sort()),
  }, null, 2) + '\n');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain && process.argv[2] === 'refresh') {
  refresh().catch((e) => { console.log('[market] refresh failed:', e.message); });
}
