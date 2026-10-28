// value-models.mjs — THE VALUE TABLE IN WORDS A BUYER READS.
//
// table.json's `rows` are one line per BUILD per HARDWARE CLASS: refs like
// "hf.co/bartowski/google_gemma-4-E2B-it-GGUF:IQ3_XS", classes like
// "linux/amd64/none/32g", verdicts like "no hosted API listed". 660 lines of
// that answer nobody's question. A reader asks, per MODEL:
//
//   what is it, who made it, what can it do (the checks it passed),
//   which machines on this network have run it and how fast,
//   what a million tokens costs here and what OpenRouter charges,
//   who the licence lets me serve it to,
//   and so: should I run it here?
//
// `models` is that: one entry per catalog member, every season folded in, every
// field named and valued in plain words. The per-build rows stay in the file for
// a page that wants the detail; nothing here is new evidence, only a reading.

import { sheetFor } from './machines.mjs';
import { refRepo } from './model-filing.mjs';

/** Mirrors value-table weightsName (kept here so this file imports nothing circular). */
function weightsName(ref) {
  const repo = refRepo(ref);
  if (!repo) return null;
  return repo.split('/')[1]
    .replace(/^(google|microsoft|meta-llama|qwen|mistralai|deepseek-ai|ibm-granite|moonshotai|nvidia|liquidai)_/, '')
    .replace(/([-_.](gguf|mlx|awq|gptq|gguf-.*|i?q\d.*|\d+bit|fp8.*|bnb.*))+$/, '') || null;
}

const TEXT_SKILLS = /^(tools|code|output|instruct|reason|research|thinking|structured_output|faithful)/;

export const MIN_REAL_BUILD_MIB = 50; // under this a "model" is a test stub, not something to run

const OS = { windows: 'Windows PC', linux: 'Linux PC', darwin: 'Mac' };

/** "linux/amd64/nvidia/32g" -> "Linux PC with an NVIDIA GPU, 32 GB". */
export function machineName(klass) {
  if (!klass || klass === 'unknown') return 'machine not reported';
  const [os, arch, gpu, ram] = String(klass).split('/');
  const gb = ram ? `${ram.replace(/g$/i, '')} GB` : null;
  let base = OS[os] || os;
  if (os === 'darwin') base = arch === 'arm64' ? 'Mac with Apple silicon' : 'Intel Mac';
  let card = null;
  if (gpu === 'nvidia') card = 'an NVIDIA GPU';
  else if (gpu === 'amd') card = 'an AMD GPU';
  else if (gpu === 'intel') card = 'Intel graphics';
  else if (gpu === 'none' && os !== 'darwin') card = 'no GPU';
  const name = card ? `${base} with ${card}` : base;
  return gb ? `${name}, ${gb}` : name;
}

export function machineMemoryGB(klass) {
  const m = /\/(\d+)g$/i.exec(String(klass || ''));
  return m ? Number(m[1]) : null;
}

/** "Q4_K_M" -> "4-bit", "BF16" -> "16-bit (full precision)", "FP8" -> "8-bit". */
export function precisionName(quant) {
  const q = String(quant || '').toUpperCase();
  if (!q) return null;
  if (/^(BF16|F16|FP16)$/.test(q)) return '16-bit (full precision)';
  if (/^(F32|FP32)$/.test(q)) return '32-bit (full precision)';
  if (/^(TQ1|TQ2)/.test(q)) return 'ternary (1.58-bit)';
  const bits = /^I?Q(\d)/.exec(q) || /(\d+)[-_ ]?BIT/.exec(q) || /^(?:FP|INT|W|MXFP|NVFP)(\d+)/.exec(q);
  if (bits) return `${bits[1]}-bit`;
  if (/AWQ|GPTQ/.test(q)) return '4-bit';
  return q;
}

const KIND = {
  text: 'Text & chat', speech: 'Speech', speaker: 'Speaker recognition', translation: 'Translation',
  image: 'Images & video', vision: 'Vision (counting, locating)', audio: 'Music & sound', other: 'Other',
};

function kindOf(modality, caps) {
  if (modality === 'speech') {
    if (caps.has('audio.out')) return 'Text to speech';
    if (caps.has('audio.in')) return 'Speech to text';
    return 'Speech';
  }
  if (modality === 'image' && caps.has('video.generate')) return 'Video generation';
  if (modality === 'image') return 'Image generation';
  if (caps.has('embed.vector')) return 'Embeddings (search)';
  return KIND[modality] || 'Other';
}

const SKILLS = [
  ['tools.call', 'calls tools'],
  ['tools.multi_hop', 'multi-step tool use'],
  ['code.write', 'writes code'],
  ['code.reason', 'reasons about code'],
  ['thinking', 'shows its reasoning'],
  ['output.schema', 'returns valid JSON'],
  ['output.long', 'long answers'],
  ['research.synthesize', 'summarises sources'],
  ['vision.read', 'reads images'],
  ['vision.count', 'counts objects'],
  ['image.generate', 'makes images'],
  ['video.generate', 'makes video'],
  ['audio.out', 'speaks'],
  ['audio.in', 'transcribes'],
  ['audio.music', 'makes music'],
  ['voice.identify', 'identifies speakers'],
  ['embed.vector', 'search embeddings'],
];

const LANG = {
  en: 'English', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', gu: 'Gujarati', kn: 'Kannada',
  ml: 'Malayalam', pa: 'Punjabi', or: 'Odia', as: 'Assamese', ur: 'Urdu', ne: 'Nepali', si: 'Sinhala', sw: 'Swahili',
  am: 'Amharic', nl: 'Dutch', ru: 'Russian', es: 'Spanish',
};

function skillsOf(caps) {
  const skills = SKILLS.filter(([c]) => caps.has(c)).map(([, w]) => w);
  const langs = [];
  for (const c of caps) {
    const m = /^(?:lang|translate)\.([a-z]{2})$/.exec(c);
    if (m && LANG[m[1]] && !langs.includes(LANG[m[1]])) langs.push(LANG[m[1]]);
  }
  return { skills, languages: langs };
}

const LICENCE_NAME = {
  'apache-2.0': 'Apache 2.0', mit: 'MIT', gemma: 'Gemma terms of use', 'cc-by-4.0': 'CC BY 4.0',
  'cc-by-nc-4.0': 'CC BY-NC 4.0 (non-commercial)', 'creativeml-openrail-m': 'CreativeML OpenRAIL-M', mrl: 'Mistral research licence',
};

export function licenceName(lic) {
  if (!lic?.id) return null;
  const id = String(lic.id).toLowerCase();
  if (id === 'other' && lic.name && lic.name !== 'other') {
    return lic.name.replace(/[-_]/g, ' ').replace(/\b(\w)/g, (c) => c.toUpperCase()).replace(/\bMit\b/, 'MIT').replace(/\bGlm\b/, 'GLM').replace(/\bLfm/, 'LFM') + ' licence';
  }
  if (id === 'other') return 'custom licence';
  if (/^llama/.test(id)) return `Llama ${id.replace(/^llama/, '')} community licence`.replace('  ', ' ');
  return LICENCE_NAME[id] || lic.id;
}

const MAY_SERVE = {
  open: 'Anyone, including strangers on the open network',
  'open-weights': 'Anyone, under the maker\'s terms',
  restricted: 'Only your own machines and your company\'s',
  'non-commercial': 'Only your own machines, not for paid work',
  unknown: 'Licence not checked yet',
};

/** "Phi 4 MINI-REASONING" -> "Phi 4 Mini-Reasoning": a catalog member id upper-cased is not a name. */
function tidyName(s) {
  return String(s || '').replace(/\b([A-Z][A-Z0-9]*[A-Z]{3,})\b/g, (w) => (/^(GGUF|MLX|FP8|BF16|AWQ|GPTQ|TTS|MMS|GLM|LFM|NVFP4|MXFP4|API|VL)$/.test(w) ? w : w[0] + w.slice(1).toLowerCase()));
}

// ── HOW BIG IS IT: PARAMETERS, IN BILLIONS ───────────────────────────────────
//
// The first thing a buyer filters by, and only 84 of 1,258 catalog members
// state it. Most say it in their name ("27b", "0.8b", "26b-a4b", "600M"), and
// a mixture of experts says how much of itself each token uses ("-a4b"). Where
// the name is silent the download says it: bytes × 8 ÷ bits per weight, and
// the answer is labelled an estimate.

const SIZE = /(?:^|[^a-z0-9.])(e)?(\d+(?:\.\d+)?)\s*([bm])(?:-a(\d+(?:\.\d+)?)([bm]))?(?![a-z0-9])/i;

function namedSize(s) {
  const m = SIZE.exec(String(s || ''));
  if (!m) return null;
  const scale = (n, u) => (u.toLowerCase() === 'm' ? n / 1000 : n);
  const n = scale(Number(m[2]), m[3]);
  if (!(n > 0) || n > 5000) return null;
  // "E2B" (Gemma) is the EFFECTIVE size: 2B used per token of a larger model.
  if (m[1]) return { total: null, active: n };
  return { total: n, active: m[4] ? scale(Number(m[4]), m[5]) : null };
}

/** Bits per stored weight for a build's precision, for reading size off a download. */
function bitsPerWeight(quant) {
  const p = precisionName(quant) || '';
  if (/^32/.test(p)) return 32;
  if (/^16/.test(p)) return 16;
  if (/ternary/.test(p)) return 1.7;
  const n = /^(\d+)-bit/.exec(p);
  if (!n) return null;
  return Number(n[1]) === 8 ? 8.5 : Number(n[1]) + 0.85; // K-quants carry scales: Q4_K_M is ~4.85
}

const roundB = (b) => (b >= 10 ? Math.round(b) : b >= 1 ? +b.toFixed(1) : +b.toFixed(2));

export function paramsOf({ declared, member, name, ref, diskMib, quant }) {
  let total = null;
  let active = null;
  for (const s of [declared, member, name, refRepo(ref)?.split('/')[1]]) {
    const n = namedSize(s);
    if (n?.total && total == null) total = n.total;
    if (n?.active && active == null) active = n.active;
  }
  let basis = total != null ? 'named' : null;
  if (total == null) {
    const bpw = bitsPerWeight(quant);
    if (diskMib >= MIN_REAL_BUILD_MIB && bpw) {
      total = (diskMib * 1048576 * 8) / bpw / 1e9;
      basis = 'estimated from download size';
    } else if (active != null) {
      total = active;
      basis = 'named';
    }
  }
  if (total == null) return { params_b: null, active_params_b: null, params_basis: null };
  const moe = active != null && active < total * 0.9;
  return { params_b: roundB(total), active_params_b: moe ? roundB(active) : null, params_basis: basis };
}

const usd = (v) => (v >= 10 ? `$${Math.round(v)}` : v >= 0.01 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);
const rate = (v) => (v >= 10 ? String(Math.round(v)) : v.toFixed(1));
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function bottomLine(m) {
  const f = m.fastest;
  const api = m.hosted_api;
  const sells = api ? ` OpenRouter sells it at ${usd(api.output_usd_per_million)} per million output tokens.` : '';
  if (!f) {
    if (m.too_big_for_the_network) return `Not run here yet: it needs about ${m.download_gb} GB of memory and the largest machine on the network has ${m.largest_machine_gb} GB.${sells}`;
    return `Not measured here yet.${sells}`;
  }
  if (f.tokens_per_sec == null) {
    const where = `${m.machine_kinds} kind${m.machine_kinds === 1 ? '' : 's'} of machine`;
    if (m.kind === 'Text & chat') return `Ran on ${where} here, but its speed was not recorded.${sells}`;
    return api ? `Runs on ${where} here. OpenRouter also sells it.` : `Runs on ${where} here, and no hosted API sells it — this network is where to get it.`;
  }
  const speed = cap(`${rate(f.tokens_per_sec)} tokens a second on ${f.machine_detail ? f.machine : `a ${f.machine}`}`);
  const c = m.cheapest;
  if (!api) return `${speed}. No hosted API sells it, so this network is the place to run it.`;
  if (api.output_usd_per_million === 0) return `${speed}. OpenRouter has it free, so run it here only for privacy.`;
  if (c?.cost_usd_per_million > 0 && api.output_usd_per_million > 0) {
    const ratio = c.cost_usd_per_million / api.output_usd_per_million;
    const here = `About ${usd(c.cost_usd_per_million)} per million tokens here${c.cost_is_estimate ? ' (estimated)' : ''}`;
    if (ratio <= 1) return `${speed}. ${here}, against OpenRouter's ${usd(api.output_usd_per_million)} — cheaper here.`;
    return `${speed}. ${here}, against OpenRouter's ${usd(api.output_usd_per_million)}: the API is ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}× cheaper. Run it here for privacy or to keep work on your own machines, not to save money.`;
  }
  return `${speed}.${sells}`;
}

// ── THE MACHINE, AS ITS SIGNED RESULT DESCRIBES IT ───────────────────────────
//
// A hardware class pooled a 12 GB desktop card with a 4 GB laptop one and put
// the SYSTEM memory in the name, so "Windows PC with an NVIDIA GPU, 16 GB"
// read as a 16 GB card. Every signed result carries the machine itself: its
// CPUs, its memory, its card and that card's memory -- and, from e9f1c13,
// the card's and processor's names and who hosts the machine.

const GPU_VENDOR = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', apple: 'Apple', tpu: 'Google TPU' };
const HW_ORG = { nvidia: 'nvidia', amd: 'amd', intel: 'Intel', apple: 'apple', tpu: 'google' };
const HOST_ORG = { Kaggle: 'kaggle', 'Google Colab': 'google', 'Google Cloud': 'google', 'AWS EC2': 'aws', 'Microsoft Azure': 'microsoft' };

/** The machine a signed result names, in words and as parts a page can show. */
export function machineOf(hw) {
  if (!hw || !hw.os) return null;
  const os = hw.os === 'darwin' ? 'Mac' : hw.os === 'windows' ? 'Windows' : hw.os === 'linux' ? 'Linux' : hw.os;
  const gpu = hw.gpu && hw.gpu !== 'none' && hw.gpu !== 'other' ? hw.gpu : null;
  const count = hw.gpu_count > 1 ? `${hw.gpu_count}× ` : '';
  const card = gpu
    ? gpu === 'apple'
      ? (hw.gpu_model || 'Apple silicon')
      : `${count}${hw.gpu_model || GPU_VENDOR[gpu] || gpu}${hw.vram_gib > 0 ? ` ${Math.round(hw.vram_gib)} GB` : ''}`
    : 'no GPU';
  const parts = [os, card, hw.cpus ? `${hw.cpus} CPUs` : null, hw.ram_gib ? `${Math.round(hw.ram_gib)} GB RAM` : null].filter(Boolean);
  return {
    name: parts.join(' · '),
    os, os_version: hw.os_version || null, cpus: hw.cpus || null, cpu_model: hw.cpu_model || null,
    ram_gb: hw.ram_gib ? Math.round(hw.ram_gib) : null,
    gpu_vendor: gpu ? GPU_VENDOR[gpu] || gpu : null, gpu_model: hw.gpu_model || null, gpu_count: hw.gpu_count || (gpu ? 1 : 0),
    vram_gb: hw.vram_gib > 0 ? Math.round(hw.vram_gib) : null,
    host: hw.host || null,
    vendor_org: gpu ? HW_ORG[gpu] || null : (hw.os === 'darwin' ? 'apple' : null),
    host_org: HOST_ORG[hw.host] || null,
    key: [hw.os, hw.arch, hw.cpus, Math.round(hw.ram_gib || 0), gpu || 'none', Math.round(hw.vram_gib || 0), hw.gpu_model || '', hw.gpu_count || '', hw.host || ''].join('|'),
  };
}

// The network's price list (epn-daemon config.DefaultPriceFloors): what metering
// charges every gram, in µUSD. One list, posted, the same everywhere.
export const PRICE_LIST = { vcpu_second_uusd: 10, gib_hour_uusd: 3000, gpu_second_uusd: 100, kwh_uusd: 100000 };

/**
 * What a million output tokens cost on THIS machine at the metered rates:
 * epn-daemon internal/cmd/token_price.go, with the machine's own signed CPUs
 * (the engine drives every thread but one), the build resident in memory and
 * the card when it has one. µUSD per second ÷ tokens per second.
 */
export function meteredUsdPerM(hw, diskMiB, tokensPerSec) {
  return meteredBreakdown(hw, diskMiB, tokensPerSec)?.usd_per_million ?? null;
}

/**
 * The same sum, line by line: what each metered resource costs per second of
 * decoding on this machine, and its share of a million tokens. Every quantity
 * is the machine's own signed size or the build's own size; every rate is the
 * price list; nothing is guessed except the energy model, which says so.
 */
export function meteredBreakdown(hw, diskMiB, tokensPerSec) {
  if (!hw?.cpus || !(tokensPerSec > 0)) return null;
  const threads = Math.max(1, hw.cpus - 1);
  const card = ['nvidia', 'amd', 'apple', 'tpu'].includes(hw.gpu);
  const gib = (diskMiB || 0) / 1024;
  const watts = threads * 5 + (card ? 150 : 0); // hostinfo/energy.go, for one second
  const perM = (uusdPerSec) => +(uusdPerSec / tokensPerSec).toFixed(4); // µUSD/s ÷ tok/s = USD per 1M tokens
  const lines = [
    {
      resource: 'CPU', quantity: `${threads} of ${hw.cpus} threads (the engine drives every thread but one)`,
      rate: `$${(PRICE_LIST.vcpu_second_uusd * 3600 / 1e6).toFixed(3)} per thread-hour`,
      uusd_per_second: threads * PRICE_LIST.vcpu_second_uusd,
    },
    {
      resource: 'Memory', quantity: `${gib.toFixed(1)} GB of weights held resident`,
      rate: `$${(PRICE_LIST.gib_hour_uusd / 1e6).toFixed(3)} per GB-hour`,
      uusd_per_second: gib * PRICE_LIST.gib_hour_uusd / 3600,
    },
  ];
  if (card) {
    lines.push({
      resource: 'GPU', quantity: `${hw.gpu_count > 1 ? `${hw.gpu_count} cards, billed as one` : 'one card'}`,
      rate: `$${(PRICE_LIST.gpu_second_uusd * 3600 / 1e6).toFixed(2)} per GPU-hour`,
      uusd_per_second: PRICE_LIST.gpu_second_uusd,
    });
  }
  lines.push({
    resource: 'Energy', quantity: `${watts} W modelled (${threads} threads × 5 W${card ? ' + 150 W card' : ''})`,
    rate: `$${(PRICE_LIST.kwh_uusd / 1e6).toFixed(2)} per kWh`,
    uusd_per_second: watts / 3.6e6 * PRICE_LIST.kwh_uusd,
  });
  let total = 0;
  for (const l of lines) {
    l.uusd_per_second = +l.uusd_per_second.toFixed(3);
    l.usd_per_million = perM(l.uusd_per_second);
    total += l.uusd_per_second;
  }
  return {
    tokens_per_sec: +tokensPerSec.toFixed(2),
    usd_per_hour: +(total * 3600 / 1e6).toFixed(4),
    usd_per_million: perM(total),
    lines,
    formula: 'USD per million tokens = metered µUSD per second ÷ tokens per second',
    source: 'epn-daemon config.DefaultPriceFloors and internal/cmd/token_price.go',
  };
}

// ── ONE MODEL, ONE ROW ───────────────────────────────────────────────────────
//
// The catalog files every packager's repo as a "community" member, so
// hugging-quants' Llama-3.2-1B-Instruct-Q4_K_M-GGUF -- the same weights in
// another file -- was a model of its own beside Llama 3.2 1B. A repackaging
// is a BUILD of its base; only changed weights (abliterated, uncensored, a
// fine-tune) are a VARIANT, and a variant sits under its base.

const FORMAT = /(^|-)(gguf|ggml|mlx|onnx|exl2|bf16|f16|fp16|f32|fp32|fp8|fp4|int4|int8|\d+-?bits?|q\d(-k)?(-[msl])?|q\d-\d|iq\d[\w]*|i1|k-m|awq|gptq|bnb[\w-]*|nvfp4|mxfp4|mtp|mtplx|optiq[\w]*|oq\d\w*|dq\d?|w\d+a\d+|instruct|it|hf|quantized|imatrix|static|fast|speed|optimized|dense-modules|with)(?=-|$)/g;

function weightsKey(s) {
  let k = String(s || '').toLowerCase().replace(/^.*\//, '').replace(/[_ .]+/g, '-');
  for (let i = 0; i < 4; i++) k = k.replace(FORMAT, '$1').replace(/--+/g, '-').replace(/^-|-$/g, '');
  return k;
}

/** True when a community member is its base's weights in another file. */
export function isRepackage(derivName, baseNames) {
  const d = weightsKey(derivName);
  if (!d) return true;
  return baseNames.map(weightsKey).some((b) => b && (d === b || d.replace(/-/g, '') === b.replace(/-/g, '')));
}

const NS = 1e6;
const toISO = (ns) => (ns > 0 ? new Date(ns / NS).toISOString() : null);
const hubURL = (repo) => (repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://huggingface.co/${repo}` : null);

/**
 * modelView — one plain-language entry per model, from the per-build rows
 * buildValueTable made and the signed evidence (data/models.json) behind them.
 */
export function modelView(rows, { families = [], largestMachineGB = null, evidence = null, market = null, machines = null } = {}) {
  const fam = new Map((families || []).map((f) => [f.id, f]));
  const avatars = market?.avatars || {};
  const logo = (org) => (org && avatars[org]?.url) || null;
  const endpoints = market?.endpoints || {};
  // The signed results behind each ref: every gram that measured it, with the machine.
  const byRef = new Map();
  for (const e of evidence || []) {
    const list = byRef.get(e.name) || [];
    list.push(e);
    byRef.set(e.name, list);
  }

  // Which member a row belongs to: a repackaging folds into its base.
  const baseOf = (r) => {
    const f = fam.get(r.family);
    const mem = f?.members?.find((m) => m.id === r.member);
    if (!mem?.derivative || !mem.base) return { key: `${r.family}/${r.member}`, variantOf: null };
    const base = f.members.find((m) => m.id === mem.base);
    const names = [base?.display_name, base?.id, ...(base?.artifacts || []).flatMap((a) => [a.base, refRepo(a.ref)])].filter(Boolean);
    if (base && isRepackage(mem.display_name || mem.id, names)) return { key: `${r.family}/${mem.base}`, variantOf: null };
    return { key: `${r.family}/${r.member}`, variantOf: base ? `${r.family}/${mem.base}` : null };
  };

  const groups = new Map();
  for (const r of rows) {
    if (/^claude-/.test(r.ref)) continue; // a hosted seat, not a network build
    const filed = r.family && r.member ? baseOf(r) : null;
    const key = filed?.key || `${refRepo(r.ref)?.split('/')[0] || ''}/${weightsName(r.ref) || r.ref}`;
    const g = groups.get(key) || { key, rows: [], variantOf: filed?.variantOf || null };
    g.rows.push(r);
    groups.set(key, g);
  }

  const out = [];
  for (const g of groups.values()) {
    const [famID, memID] = g.key.split('/');
    const f = fam.get(famID);
    const mem = f?.members?.find((m) => m.id === memID);
    const r0 = g.rows.find((r) => r.member === memID) || g.rows[0];
    const caps = new Set();
    const seasons = new Set();
    const runs = new Map(); // ref + machine -> the best signed run on it
    for (const r of g.rows) {
      for (const s of r.seasons) seasons.add(s);
      const real = !(r.disk_mib > 0 && r.disk_mib < MIN_REAL_BUILD_MIB);
      for (const c of Object.values(r.classes)) for (const k of c.caps || []) caps.add(k);
      if (!real) continue;
      const build = [precisionName(r.quant), r.publisher ? `by ${r.publisher}` : null].filter(Boolean).join(' ') || null;
      const signed = byRef.get(r.ref) || [];
      for (const e of signed) {
        const page = e.family && e.member && e.build ? `/inferences/${e.family}/${e.member}/${e.build}` : null;
        for (const n of e.nodes || []) {
          const mc = machineOf(n.hardware);
          const tps = n.tokens_per_sec > 0 ? n.tokens_per_sec : null;
          const key = `${r.ref}|${mc?.key || 'unreported'}`;
          const prev = runs.get(key);
          const dids = new Set([...(prev?._dids || []), n.node_did]);
          if (prev && (prev.tokens_per_sec || 0) >= (tps || 0)) { prev._dids = dids; prev.machines = dids.size; continue; }
          runs.set(key, {
            machine: mc?.name || 'machine not reported',
            machine_detail: mc,
            machine_class: mc?.key || 'unknown',
            machines: dids.size,
            _dids: dids,
            tokens_per_sec: tps ? +tps.toFixed(2) : null,
            context_tokens: (typeof n.effective_ctx === 'number' ? n.effective_ctx : n.effective_ctx?.value) || e.effective_ctx?.value || null,
            build,
            ref: r.ref,
            engine: n.runtime || e.engine || r.engine || null,
            cost_usd_per_million: meteredUsdPerM(n.hardware, r.disk_mib, tps),
            cost_breakdown: meteredBreakdown(n.hardware, r.disk_mib, tps),
            machine_sheet: sheetFor(machines, n.node_did, n.hardware),
            cost_is_estimate: false,
            cost_basis: 'the network\'s metered rates on this machine',
            measured_at: toISO(n.measured_at || n.probed_at),
            signed: Boolean(n.throughput_signature || n.probe_signature),
            build_page: page,
            hub_url: hubURL(refRepo(r.ref)),
            weeks: r.seasons,
          });
        }
      }
      // A season proved it, the matrix no longer carries the gram: the class
      // figure stays, marked as the class it is.
      if (!signed.length) {
        for (const [klass, c] of Object.entries(r.classes)) {
          if (!c.proved) continue;
          runs.set(`${r.ref}|${klass}`, {
            machine: machineName(klass), machine_detail: null, machine_class: klass, machines: c.grams,
            tokens_per_sec: c.tokens_per_sec_best || null, context_tokens: c.effective_ctx_best || null,
            build, ref: r.ref, engine: r.engine,
            cost_usd_per_million: c.usd_per_m_out ?? c.est_usd_per_m_out ?? null,
            cost_is_estimate: c.usd_per_m_out == null && c.est_usd_per_m_out != null,
            cost_basis: c.usd_per_m_out != null ? 'the network\'s metered rates' : 'the network\'s metered rates, machine size assumed',
            measured_at: c.last_at || null, signed: true, build_page: null, hub_url: hubURL(refRepo(r.ref)), weeks: c.seasons,
          });
        }
      }
    }
    const measured = [...runs.values()].map(({ _dids, ...x }) => (_dids ? { ...x, providers: [..._dids].filter(Boolean).map((d) => String(d).slice(-6).toLowerCase()) } : x));
    const known = measured.filter((x) => x.machine_detail || x.machine_class !== 'unknown');
    const pool = known.length ? known : measured;
    const fastest = pool.filter((x) => x.tokens_per_sec > 0).sort((a, b) => b.tokens_per_sec - a.tokens_per_sec)[0] || pool[0] || null;
    const cheapest = pool.filter((x) => x.cost_usd_per_million > 0).sort((a, b) => a.cost_usd_per_million - b.cost_usd_per_million)[0] || null;

    // The build a buyer would download: the standard rung, else the smallest real one.
    const sized = g.rows.filter((r) => r.disk_mib >= MIN_REAL_BUILD_MIB);
    const smallest = (list) => [...list].sort((a, b) => a.disk_mib - b.disk_mib)[0];
    const lead = smallest(sized.filter((r) => r.rung === 0 && r.member === memID)) || smallest(sized.filter((r) => r.rung === 0)) || smallest(sized) || r0;
    const apiRow = g.rows.find((r) => r.api && r.member === memID)?.api || g.rows.find((r) => r.api)?.api || null;
    const licRow = g.rows.find((r) => r.licence?.id)?.licence || r0.licence;
    let modality = g.rows.find((r) => r.modality !== 'other')?.modality || r0.modality;
    if (modality === 'other' && ([...caps].some((c) => TEXT_SKILLS.test(c)) || /gguf/i.test(r0.ref))) modality = 'text';
    const downloadGB = lead.disk_mib ? +(lead.disk_mib / 1024).toFixed(1) : null;
    const { skills, languages } = skillsOf(caps);
    const repoName = refRepo(r0.ref) ? String(r0.ref).replace(/^hf\.co\//i, '').split(':')[0].split('/')[1].replace(/[-_.]gguf$/i, '') : r0.ref;
    const name = tidyName(mem?.display_name || (memID && f ? `${f.display_name || f.id} ${memID}` : repoName));
    const baseRepo = lead.base || r0.base || lead.hub_repo || null;
    const makerOrg = (mem?.derivative ? (mem.author || refRepo(r0.ref)?.split('/')[0]) : baseRepo?.split('/')[0]) || refRepo(r0.ref)?.split('/')[0] || null;
    const providers = apiRow ? endpoints[apiRow.openrouter_id]?.providers || null : null;
    const licRepo = String(licRow?.source || '').replace(/^https:\/\/huggingface\.co\/api\/models\//, '');

    const m = {
      model: name,
      // A community build is its packager's, of the vendor's weights.
      made_by: (mem?.derivative ? mem.author || r0.publisher : f?.vendor) || r0.publisher || refRepo(r0.ref)?.split('/')[0] || null,
      maker_logo: logo(makerOrg) || logo(baseRepo?.split('/')[0]),
      based_on: mem?.derivative ? (f?.members?.find((x) => x.id === mem.base)?.display_name || f?.display_name || null) : null,
      variant_of: g.variantOf ? `/inferences/${g.variantOf}` : null,
      in_catalog: Boolean(f),
      kind: kindOf(modality, caps),
      community_build: Boolean(mem?.derivative),
      page: f && memID ? `/inferences/${famID}/${memID}` : null,
      hub_url: hubURL(baseRepo) || hubURL(refRepo(lead.ref)),
      download_gb: downloadGB,
      ...paramsOf({ declared: mem?.params, member: memID, name, ref: lead.ref, diskMib: lead.disk_mib, quant: lead.quant }),
      longest_prompt_tokens: pool.reduce((n, x) => Math.max(n, x.context_tokens || 0), 0) || null,
      too_big_for_the_network: Boolean(!fastest && largestMachineGB && downloadGB && downloadGB > largestMachineGB),
      largest_machine_gb: largestMachineGB,
      skills_passed: skills,
      languages_passed: languages,
      status: fastest ? 'measured' : 'not measured yet',
      fastest,
      cheapest,
      machine_kinds: new Set(pool.map((x) => x.machine_class)).size,
      machines_total: pool.reduce((n, x) => n + (x.machines || 0), 0),
      weeks_measured: [...seasons].sort(),
      measured_on: [...pool].sort((a, b) => (b.tokens_per_sec || 0) - (a.tokens_per_sec || 0)),
      hosted_api: apiRow ? {
        seller: 'OpenRouter',
        model_id: apiRow.openrouter_id,
        url: `https://openrouter.ai/${apiRow.openrouter_id}`,
        input_usd_per_million: apiRow.usd_per_m_in,
        output_usd_per_million: apiRow.usd_per_m_out,
        free_tier: apiRow.free_variant,
        context_tokens: apiRow.context_length,
        checked_at: apiRow.fetched_at,
        providers,
        provider_count: providers?.length || null,
      } : null,
      licence: {
        name: licenceName(licRow),
        you_may_serve: MAY_SERVE[licRow?.class || 'unknown'],
        class: licRow?.class || 'unknown',
        source: licRow?.link || hubURL(licRepo) || null,
      },
      builds: new Set(g.rows.map((r) => r.ref)).size,
      variants: [],
    };
    m.bottom_line = bottomLine(m);
    out.push(m);
  }

  // Variants under their base: the base lists them, and each names its base.
  const byPage = new Map(out.map((m) => [m.page, m]));
  for (const m of out) {
    const base = m.variant_of && byPage.get(m.variant_of);
    if (!base) continue;
    m.based_on = base.model;
    base.variants.push({ model: m.model, made_by: m.made_by, page: m.page, status: m.status, tokens_per_sec: m.fastest?.tokens_per_sec ?? null });
  }

  // Measured first: the most it proved it can do, then how fast. Then what an
  // API sells, smallest first (what a gram could take on next), then the rest.
  const rank = (m) => (m.status === 'measured' ? 0 : m.hosted_api && !m.community_build ? 1 : m.hosted_api ? 2 : 3);
  out.sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 0
      ? b.skills_passed.length - a.skills_passed.length || (b.fastest?.tokens_per_sec || 0) - (a.fastest?.tokens_per_sec || 0)
      : (a.download_gb ?? Infinity) - (b.download_gb ?? Infinity))
    || a.model.localeCompare(b.model));
  return out;
}
