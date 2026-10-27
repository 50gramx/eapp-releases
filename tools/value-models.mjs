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
  const speed = cap(`${rate(f.tokens_per_sec)} tokens a second on a ${f.machine}`);
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

/**
 * modelView — one plain-language entry per catalog member (or per unfiled ref),
 * from the per-build rows buildValueTable made.
 */
export function modelView(rows, { families = [], largestMachineGB = null } = {}) {
  const fam = new Map((families || []).map((f) => [f.id, f]));
  const groups = new Map();
  for (const r of rows) {
    if (/^claude-/.test(r.ref)) continue; // a hosted seat, not a network build
    // A build today's catalog does not file: grouped with its other quants by
    // the weights its repo packages, under the packager's name.
    const key = r.family && r.member ? `${r.family}/${r.member}` : `${refRepo(r.ref)?.split('/')[0] || ''}/${weightsName(r.ref) || r.ref}`;
    const g = groups.get(key) || { key, rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }

  const out = [];
  for (const g of groups.values()) {
    const r0 = g.rows[0];
    const f = fam.get(r0.family);
    const mem = f?.members?.find((m) => m.id === r0.member);
    const caps = new Set();
    const measured = [];
    const seasons = new Set();
    for (const r of g.rows) {
      for (const s of r.seasons) seasons.add(s);
      const real = !(r.disk_mib > 0 && r.disk_mib < MIN_REAL_BUILD_MIB);
      for (const [klass, c] of Object.entries(r.classes)) {
        for (const k of c.caps || []) caps.add(k);
        if (!c.proved || !real) continue;
        measured.push({
          machine: machineName(klass),
          machine_class: klass,
          machines: c.grams,
          tokens_per_sec: c.tokens_per_sec_best || null,
          context_tokens: c.effective_ctx_best || null,
          build: [precisionName(r.quant), r.publisher ? `by ${r.publisher}` : null].filter(Boolean).join(' ') || null,
          ref: r.ref,
          cost_usd_per_million: c.usd_per_m_out ?? c.est_usd_per_m_out ?? null,
          cost_is_estimate: c.usd_per_m_out == null && c.est_usd_per_m_out != null,
          weeks: c.seasons,
        });
      }
    }
    const known = measured.filter((x) => x.machine_class !== 'unknown');
    const pool = known.length ? known : measured;
    const fastest = pool.filter((x) => x.tokens_per_sec > 0).sort((a, b) => b.tokens_per_sec - a.tokens_per_sec)[0] || pool[0] || null;
    const cheapest = pool.filter((x) => x.cost_usd_per_million > 0).sort((a, b) => a.cost_usd_per_million - b.cost_usd_per_million)[0] || null;

    // The build a buyer would download: the standard rung, else the smallest real one.
    const sized = g.rows.filter((r) => r.disk_mib >= MIN_REAL_BUILD_MIB);
    const smallest = (list) => [...list].sort((a, b) => a.disk_mib - b.disk_mib)[0];
    const lead = smallest(sized.filter((r) => r.rung === 0)) || smallest(sized) || r0;
    const apiRow = g.rows.find((r) => r.api)?.api || null;
    const licRow = g.rows.find((r) => r.licence?.id)?.licence || r0.licence;
    let modality = g.rows.find((r) => r.modality !== 'other')?.modality || r0.modality;
    if (modality === 'other' && ([...caps].some((c) => TEXT_SKILLS.test(c)) || /gguf/i.test(r0.ref))) modality = 'text';
    const downloadGB = lead.disk_mib ? +(lead.disk_mib / 1024).toFixed(1) : null;
    const { skills, languages } = skillsOf(caps);
    const repoName = refRepo(r0.ref) ? String(r0.ref).replace(/^hf\.co\//i, '').split(':')[0].split('/')[1].replace(/[-_.]gguf$/i, '') : r0.ref;
    const name = tidyName(mem?.display_name || (r0.member && f ? `${f.display_name || f.id} ${r0.member}` : repoName));

    const m = {
      model: name,
      // A community build is its packager's, of the vendor's weights.
      made_by: (r0.derivative ? r0.publisher : f?.vendor) || r0.publisher || refRepo(r0.ref)?.split('/')[0] || null,
      based_on: r0.derivative ? (f?.display_name || null) : null,
      in_catalog: Boolean(r0.family),
      kind: kindOf(modality, caps),
      community_build: Boolean(r0.derivative),
      page: r0.family && r0.member ? `/inferences/${r0.family}/${r0.member}` : null,
      download_gb: downloadGB,
      ...paramsOf({ declared: mem?.params, member: r0.member, name, ref: lead.ref, diskMib: lead.disk_mib, quant: lead.quant }),
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
        input_usd_per_million: apiRow.usd_per_m_in,
        output_usd_per_million: apiRow.usd_per_m_out,
        free_tier: apiRow.free_variant,
        context_tokens: apiRow.context_length,
        checked_at: apiRow.fetched_at,
      } : null,
      licence: {
        name: licenceName(licRow),
        you_may_serve: MAY_SERVE[licRow?.class || 'unknown'],
        class: licRow?.class || 'unknown',
        source: licRow?.source || null,
      },
      builds: g.rows.length,
    };
    m.bottom_line = bottomLine(m);
    out.push(m);
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
