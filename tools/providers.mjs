// WHO DOES THE WORK (table.json `providers`).
//
// Every signed run names the gram that measured it (node_did), and the table
// showed the machine but never the gram -- so a person whose laptop signed 40
// results was nowhere on the site, while OpenRouter lists every company that
// hosts a model. This is the same list for a network of people: one row per
// gram that has signed anything, joined from three places that were never
// joined before:
//
//   - the signed results (models.json): how many runs, which builds, when;
//   - the fleet telemetry (data/nodes/*.fleet.json): its OS, card, version,
//     whether it is online, whether its owner claimed it, how awake it is;
//   - the machine sheets (data/machines.json): its CPU, memory, card and disk
//     as the gram signed them.
//
// A gram is shown by the last six characters of its DID. A claimed gram is
// marked claimed but still not named: the claim binds it to an account, and
// no gram publishes that account's name today. A name appears here only when
// a gram signs one.

import { cpuName } from './machines.mjs';

/** The short id a gram is shown and linked by: the last six of its DID. */
export const providerId = (did) => String(did || '').slice(-6).toLowerCase();

const ONLINE_WINDOW_MS = 30 * 60 * 1000;
const RECENT_DAYS = 30;

// models.json measured_at is unix nano- or microseconds; telemetry is ISO.
const toMs = (v) => {
  if (v == null || v === '') return null;
  // Signed results carry nanoseconds, microseconds or seconds depending on the field and the build.
  if (typeof v === 'number') return v > 1e17 ? Math.round(v / 1e6) : v > 1e14 ? Math.round(v / 1e3) : v > 1e11 ? v : v * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function bestSheet(grams, did) {
  const g = grams?.[did];
  if (!g) return null;
  const pick = (prefix) => Object.entries(g)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, s]) => s)
    .sort((a, b) => String(b.measured_at || '').localeCompare(String(a.measured_at || '')))[0] || null;
  const out = { cpu: pick('cpu:'), memory: pick('mem:'), gpu: pick('gpu:'), storage: g.storage || null };
  return out.cpu || out.memory || out.gpu || out.storage ? out : null;
}

function hardwareLine(fleet, hw, sheet) {
  const env = fleet?.env || {};
  // A Mac without a discrete card reports its CPU string as the "gpu model".
  const named = env.gpu_model && !/CPU @|Core\(TM\)/i.test(env.gpu_model) ? env.gpu_model : null;
  const gpu = sheet?.gpu?.name || named || null;
  const vram = sheet?.gpu?.memory_gb || env.vram_gib || hw?.vram_gib || null;
  const cpu = sheet?.cpu?.model || cpuName(null).name;
  return {
    os: fleet?.os || hw?.os || null,
    arch: fleet?.arch || hw?.arch || null,
    class: fleet?.probes?.hardware_class || null,
    cpu_model: cpu || null,
    cpu_clock_ghz: sheet?.cpu?.clock_ghz || null,
    cpus: env.cpus || hw?.cpus || sheet?.cpu?.cores_logical || null,
    ram_gb: env.ram_gib || hw?.ram_gib || sheet?.memory?.total_gb || null,
    memory_bandwidth_gb_s: sheet?.memory?.bandwidth_gb_s || null,
    gpu: gpu || (env.gpu_class && env.gpu_class !== 'none' ? env.gpu_class : null),
    vram_gb: vram,
    gpu_tflops_fp16: sheet?.gpu?.fp16_tflops || sheet?.gpu?.tflops_fp16 || null,
    disk_read_mb_s: sheet?.storage?.read_mb_s || null,
  };
}

/**
 * buildProviders joins signed results, fleet telemetry and machine sheets
 * into one row per gram, busiest first.
 *
 * evidence  models.json `models` (each with nodes[] of signed results)
 * runs      the table's per-model runs, each with `providers` ids, for the
 *           builds a gram holds the fastest or cheapest result of
 * fleet     fleet telemetry nodes (readFleetNodes), newest per DID
 * machines  data/machines.json
 * region    (code) => {city, state} | null, from the pincode directory
 */
const AWARD_RUNS = [1000, 100, 10, 1];
const DAYS_KEPT = 120;

export function buildProviders({ evidence = [], runs = [], fleet = [], machines = null, region = () => null, rooms = [], generatedAt = new Date().toISOString() } = {}) {
  const now = Date.parse(generatedAt) || Date.now();
  const byDID = new Map();
  const row = (did) => {
    let r = byDID.get(did);
    if (!r) {
      r = { did, runs: 0, refs: new Set(), recent: 0, first: null, last: null, hw: null, days: {}, families: {}, opened: [] };
      byDID.set(did, r);
    }
    return r;
  };
  for (const e of evidence || []) {
    // The gram whose signed result is the network's earliest for this build
    // opened it: the first machine anywhere to prove it runs.
    let opener = null;
    for (const n of e.nodes || []) {
      if (!n?.node_did) continue;
      const r = row(n.node_did);
      r.runs++;
      r.refs.add(e.name);
      const fam = e.family || 'other';
      r.families[fam] = (r.families[fam] || 0) + 1;
      const t = toMs(n.measured_at);
      if (t) {
        if (!r.first || t < r.first) r.first = t;
        if (!r.last || t > r.last) r.last = t;
        if (now - t <= RECENT_DAYS * 864e5) r.recent++;
        if (now - t <= DAYS_KEPT * 864e5) {
          const day = new Date(t).toISOString().slice(0, 10);
          r.days[day] = (r.days[day] || 0) + 1;
        }
        if (!opener || t < opener.t) opener = { t, did: n.node_did };
      }
      if (n.hardware && !r.hw) r.hw = n.hardware;
    }
    if (opener) row(opener.did).opened.push({ ref: e.name, family: e.family || null, member: e.member || null, at: iso(opener.t) });
  }
  const roomsOf = new Map();
  for (const rm of rooms || []) {
    for (const d of rm.contributors || []) {
      const list = roomsOf.get(d) || [];
      list.push(rm.gramx_id);
      roomsOf.set(d, list);
    }
  }
  const fleetBy = new Map((fleet || []).filter((n) => n?.node_did).map((n) => [n.node_did, n]));
  for (const did of fleetBy.keys()) if (!byDID.has(did) && (fleetBy.get(did).probes?.measured || 0) > 0) row(did);

  // The builds each gram holds the network's best result for.
  const held = new Map();
  for (const x of runs || []) {
    for (const id of x.providers || []) {
      const list = held.get(id) || [];
      list.push(x);
      held.set(id, list);
    }
  }

  const out = [];
  for (const r of byDID.values()) {
    const id = providerId(r.did);
    const f = fleetBy.get(r.did) || null;
    const sheet = bestSheet(machines?.grams, r.did);
    const seen = toMs(f?.last_seen);
    const asOf = toMs(f?.snapshot_at) || now;
    const env = f?.env || {};
    const awake = Number(env.awake_seconds) || 0;
    const slept = Number(env.slept_seconds) || 0;
    const code = sheet?.cpu?.measured_in || sheet?.memory?.measured_in || sheet?.storage?.measured_in || null;
    const place = code ? region(code) : null;
    const mine = (held.get(id) || []).filter((x) => x.tokens_per_sec > 0);
    const builds = mine
      .sort((a, b) => b.tokens_per_sec - a.tokens_per_sec)
      .slice(0, 50)
      .map((x) => ({
        model: x.model, page: x.page || null, build: x.build || null, build_page: x.build_page || null,
        ref: x.ref, engine: x.engine || null, tokens_per_sec: x.tokens_per_sec,
        cost_usd_per_million: x.cost_usd_per_million ?? null, measured_at: x.measured_at || null,
        context_tokens: x.context_tokens || null,
        // Vast's DLPerf-per-dollar, for tokens: what an hour of this machine buys.
        tokens_per_usd_hour: x.cost_breakdown?.usd_per_hour > 0 ? Math.round(x.tokens_per_sec / x.cost_breakdown.usd_per_hour) : null,
      }));
    const cheapest = builds.filter((b) => b.cost_usd_per_million > 0).sort((a, b) => a.cost_usd_per_million - b.cost_usd_per_million)[0] || null;
    const awards = [];
    const runAward = AWARD_RUNS.find((n) => r.runs >= n);
    if (runAward) awards.push({ id: `runs-${runAward}`, label: runAward === 1 ? 'First signed result' : `${runAward}+ signed runs` });
    if (r.opened.length) awards.push({ id: 'opener', label: `First to measure ${r.opened.length} build${r.opened.length === 1 ? '' : 's'}` });
    if (builds.length >= 10) awards.push({ id: 'best-10', label: `Best result on ${builds.length} builds` });
    if (sheet?.cpu && sheet?.memory) awards.push({ id: 'sheet', label: 'Machine benchmarked and signed' });
    out.push({
      id,
      did: r.did,
      name: `Gram ·${id}`,
      claimed: Boolean(f?.milestones?.claim_applied?.ok),
      online: Boolean(seen && asOf - seen <= ONLINE_WINDOW_MS),
      last_seen: iso(seen),
      version: f?.version ? String(f.version).slice(0, 7) : null,
      region: place ? { code, city: place.city || null, state: place.state || null } : code ? { code, city: null, state: null } : null,
      hardware: hardwareLine(f, r.hw, sheet),
      sheet,
      signed_runs: r.runs,
      signed_runs_30d: r.recent,
      builds_measured: r.refs.size,
      best_results: builds.length,
      first_signed_at: iso(r.first),
      last_signed_at: iso(r.last),
      awake_pct: awake + slept > 0 ? Math.round((awake / (awake + slept)) * 1000) / 10 : null,
      queue: f?.probes ? { measured: f.probes.measured ?? null, failed: f.probes.failed ?? null, queued: f.probes.queued ?? null } : null,
      download_mib_per_sec: Number(f?.probes?.download_mib_per_sec) || null,
      best_value: builds.filter((b) => b.tokens_per_usd_hour > 0).sort((a, b) => b.tokens_per_usd_hour - a.tokens_per_usd_hour)[0] || null,
      opened: r.opened.sort((a, b) => String(a.at).localeCompare(String(b.at))),
      runs_by_day: Object.entries(r.days).sort(([a], [b]) => a.localeCompare(b)).map(([date, runs]) => ({ date, runs })),
      runs_by_family: Object.entries(r.families).sort((a, b) => b[1] - a[1]).map(([family, runs]) => ({ family, runs })),
      rooms: roomsOf.get(r.did) || [],
      awards,
      fastest: builds[0] || null,
      cheapest,
      builds,
    });
  }
  out.sort((a, b) => b.signed_runs - a.signed_runs || String(b.last_signed_at || '').localeCompare(String(a.last_signed_at || '')));
  out.forEach((p, i) => { p.rank = i + 1; p.of = out.length; });
  return out;
}
