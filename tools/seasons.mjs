// tools/seasons.mjs — the catalog's SEASONS, built from what the network signed.
//
// Founder's decision 2026-09-11 (epn-daemon/docs/CATALOG_SEASONS_AND_ENGINE_BRIDGES.md):
// the catalog proves itself in time-based cohorts and publishes on a cadence. A
// season file says, per artifact and per hardware class, what the fleet proved
// this window and everything before it — with how many grams contributed, so a
// number on a page is a verified floor and never a complete account.
//
// Inputs are the two things the aggregator already verifies and merges:
//   models.json   every signed model probe, per node, with its carried payload
//                 (hardware is inside the signed payload — os/arch/ram and, from
//                 epnd 4f0889d on, the card class and VRAM)
//   families      the catalog as the grams publish it: lineage (publisher /
//                 attribution / base / derivative), cohort and rung per artifact
//
// Nothing here scores. Downloads, likes and popularity do not appear. A publisher's
// row is a count of signed outcomes and the number of grams behind it.
//
// Files (data/catalog/seasons/):
//   <id>.json      one season, MERGED with the previously published copy of the same
//                  id (a closed season never loses a measurement because a node slept)
//   current.json   the open season plus `coverage` — ref → class → grams, cumulative
//                  over every season — which is what a gram reads to pick the least-
//                  covered artifact for its own hardware class
//   index.json     every season id with its counts, newest first

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';

// One cadence, mirrored from builtin.SeasonCadence (epn-daemon). Weekly = ISO week.
export const SEASON_CADENCE_DAYS = 7;
export const SEASONS_DIR = 'data/catalog/seasons';

/** ISO week id for a timestamp (ms or ns): "2026-W37". Same rule as builtin.SeasonID. */
export function seasonIdOf(ts) {
  const ms = ts > 1e14 ? Math.floor(ts / 1e6) : ts;
  const d = new Date(ms);
  // ISO week: Thursday of the same week decides the year.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  if (SEASON_CADENCE_DAYS >= 14) return `${t.getUTCFullYear()}-F${String(Math.floor((week + 1) / 2)).padStart(2, '0')}`;
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The window a season id covers, as ISO strings. */
export function seasonWindow(id) {
  const m = /^(\d{4})-W(\d{2})$/.exec(id);
  if (!m) return { starts_at: null, ends_at: null };
  const year = Number(m[1]);
  const week = Number(m[2]);
  // Monday of ISO week 1 is the Monday on or before Jan 4.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday1 = new Date(jan4);
  monday1.setUTCDate(jan4.getUTCDate() - day + 1);
  const start = new Date(monday1);
  start.setUTCDate(monday1.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { starts_at: start.toISOString(), ends_at: end.toISOString() };
}

/** RAM band as builtin's ramBand: powers of two, "16g". */
function ramBand(gib) {
  let band = 4;
  while (band < (gib || 0) && band < 4096) band *= 2;
  return `${band}g`;
}

/** Hardware class key, same rule as agent.ProbeHardware.HardwareClass. */
export function hardwareClassOf(hw) {
  if (!hw || !hw.os || !hw.arch) return 'unknown';
  return `${hw.os}/${hw.arch}/${hw.gpu || 'none'}/${ramBand(hw.ram_gib)}`;
}

function decodePayload(b64) {
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** The catalog's artifacts by ref, with lineage and season order. */
function artifactIndex(families) {
  const idx = new Map();
  for (const f of families || []) {
    for (const m of f.members || []) {
      for (const a of m.artifacts || []) {
        if (!a?.ref) continue;
        idx.set(a.ref, {
          ref: a.ref, family: f.id, member: m.id, engine: a.engine || null, quant: a.quant || null,
          publisher: a.by || null, attribution: a.attribution || null, base: a.base || null,
          derivative: Boolean(m.derivative), cohort: Number.isInteger(a.cohort) ? a.cohort : null,
          rung: Number.isInteger(a.rung) ? a.rung : null, disk_mib: a.disk_mib || null,
        });
      }
      for (const alias of m.aliases || []) {
        if (!idx.has(alias)) idx.set(alias, { ref: alias, family: f.id, member: m.id, alias_of: m.id });
      }
    }
  }
  return idx;
}

/**
 * One signed probe becomes one observation: which artifact, which gram, which
 * hardware class, when, what it held. Only what the payload carries.
 */
function observations(models) {
  const out = [];
  for (const m of models?.models || []) {
    for (const n of m.nodes || []) {
      const p = decodePayload(n.probe_signing_payload_b64);
      if (!p || !n.node_did) continue;
      const extra = p.extra || {};
      const hw = extra.hardware && typeof extra.hardware === 'object' ? extra.hardware : null;
      const ts = Number(p.ts || n.probed_at || 0);
      const held = [];
      for (const [k, v] of Object.entries(n.capabilities || {})) if (v === true) held.push(k);
      out.push({
        ref: m.name, node_did: n.node_did, klass: hardwareClassOf(hw), ts,
        engine: extra.runtime || n.runtime || null,
        effective_ctx: Number(extra.effective_ctx || n.effective_ctx || 0) || 0,
        tokens_per_sec: Number(n.tokens_per_sec || 0) || 0,
        held: held.sort(),
        hw,
        // Signed demand proxy: the rolling throughput observation carries how
        // many tokens this node actually produced with the model.
        total_tokens: Number(n.total_tokens || 0) || 0,
      });
    }
  }
  return out;
}

function emptyClassRow() {
  return { grams: 0, held_probes: 0, tokens_per_sec_best: null, effective_ctx_best: null, caps: {}, first_at: null, last_at: null, dids: new Set() };
}

function fold(row, o) {
  row.dids.add(o.node_did);
  row.held_probes += 1;
  if (o.tokens_per_sec > 0 && (row.tokens_per_sec_best === null || o.tokens_per_sec > row.tokens_per_sec_best)) row.tokens_per_sec_best = Number(o.tokens_per_sec.toFixed(2));
  if (o.effective_ctx > 0 && (row.effective_ctx_best === null || o.effective_ctx > row.effective_ctx_best)) row.effective_ctx_best = o.effective_ctx;
  for (const c of o.held) row.caps[c] = (row.caps[c] || 0) + 1;
  const iso = o.ts ? new Date(o.ts > 1e14 ? Math.floor(o.ts / 1e6) : o.ts).toISOString() : null;
  if (iso && (!row.first_at || iso < row.first_at)) row.first_at = iso;
  if (iso && (!row.last_at || iso > row.last_at)) row.last_at = iso;
}

function finishRow(row) {
  return {
    grams: row.dids.size, held_probes: row.held_probes,
    tokens_per_sec_best: row.tokens_per_sec_best, effective_ctx_best: row.effective_ctx_best,
    caps: Object.fromEntries(Object.entries(row.caps).sort()),
    first_at: row.first_at, last_at: row.last_at,
  };
}

/** Merge a previously published season's rows into fresh ones: counts never fall. */
function mergeRows(prev, cur) {
  if (!prev) return cur;
  const out = { ...cur };
  out.grams = Math.max(prev.grams || 0, cur.grams || 0);
  out.held_probes = Math.max(prev.held_probes || 0, cur.held_probes || 0);
  if (prev.tokens_per_sec_best !== null && prev.tokens_per_sec_best !== undefined && (out.tokens_per_sec_best === null || prev.tokens_per_sec_best > out.tokens_per_sec_best)) out.tokens_per_sec_best = prev.tokens_per_sec_best;
  if (prev.effective_ctx_best && (!out.effective_ctx_best || prev.effective_ctx_best > out.effective_ctx_best)) out.effective_ctx_best = prev.effective_ctx_best;
  out.caps = { ...cur.caps };
  for (const [k, v] of Object.entries(prev.caps || {})) out.caps[k] = Math.max(out.caps[k] || 0, v);
  if (prev.first_at && (!out.first_at || prev.first_at < out.first_at)) out.first_at = prev.first_at;
  if (prev.last_at && (!out.last_at || prev.last_at > out.last_at)) out.last_at = prev.last_at;
  return out;
}

/**
 * buildSeasons — every season the signed record spans, merged with what was
 * published before, plus current.json and index.json.
 *
 * Returns { files: Map<path, object>, current, index } so a caller (and a test) can
 * see what would be written without writing it.
 */
/**
 * WHAT PROVING COSTS, per hardware class and engine, from the fleet's own
 * clocks. Every measured row a gram reports carries pull_ms and probe_ms (its
 * residency ledger), and the report carries the gram's median download speed.
 * Medians per (class, engine), with sample counts. Operational data, not a
 * claim about any model: a gram with no samples of its own reads this to
 * expect what an artifact will cost it, which is what turns "remaining" into
 * an estimate instead of a trailing count (see the daemon's forecast).
 */
export function costTable(nodes, prior = null) {
  const probe = new Map(); // class -> engine -> ms[]
  const speed = new Map(); // class -> MiB/s[]
  for (const n of nodes || []) {
    const p = n?.probes;
    const klass = p?.hardware_class || 'unknown';
    if (Number(p?.download_mib_per_sec) > 0) {
      if (!speed.has(klass)) speed.set(klass, []);
      speed.get(klass).push(Number(p.download_mib_per_sec));
    }
    for (const m of p?.models || []) {
      if (m.state !== 'measured' || !(Number(m.probe_ms) > 0)) continue;
      const eng = m.engine || 'unknown';
      if (!probe.has(klass)) probe.set(klass, new Map());
      const byEng = probe.get(klass);
      if (!byEng.has(eng)) byEng.set(eng, []);
      byEng.get(eng).push(Number(m.probe_ms));
    }
  }
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
  };
  const out = {};
  for (const [klass, byEng] of probe) {
    out[klass] = out[klass] || { engines: {} };
    for (const [eng, xs] of byEng) out[klass].engines[eng] = { probe_ms_median: Math.round(median(xs)), samples: xs.length };
  }
  for (const [klass, xs] of speed) {
    out[klass] = out[klass] || { engines: {} };
    out[klass].download_mib_per_sec_median = +median(xs).toFixed(1);
    out[klass].download_samples = xs.length;
  }
  return out;
}

/**
 * LEARNED CLASSES: where one hardware class hides two machines.
 *
 * A class is a bucket (os/arch/gpu/RAM band). Whether it is ONE kind of machine
 * is an empirical question the signed outcomes can answer: if the same
 * artifact runs at 3 tok/s on some members and 105 on others, the bucket is
 * hiding a dimension. This reports, per class, the spread of tok/s per ref
 * across its grams and the candidate dimension that separates the fast from
 * the slow (VRAM band or RAM band, whichever separates them cleanly). A split
 * is proposed when the two halves each spread less than half of the whole:
 * the halves explain the outcome better than the bucket did. Nothing is
 * split here -- the proposal is published for the daemon to read as data.
 *
 * A class with fewer than CLASS_SPLIT_MIN_GRAMS distinct grams never has a
 * split proposed: two halves of three machines is one machine on a side, and
 * one machine has no spread to compare.
 *
 * `applied` is the split currently in force per coarse class (from the
 * previous publication). For a class that is already split this reports the
 * INVERSE question against the same cut: have the halves converged -- each
 * half now spreads at least CLASS_MERGE_RATIO of the whole -- so the split
 * explains nothing and a merge is proposed. Proposals only; applying either
 * is classVarianceWithHistory's job, behind the oscillation window.
 */
export const CLASS_SPLIT_MIN_GRAMS = 4;
export const CLASS_MERGE_RATIO = 0.75;
/** Consecutive aggregates a split or merge proposal must hold before it is applied. */
export const CLASS_VARIANCE_WINDOW = 3;

export function classVariance(obs, applied = {}) {
  const byClassRef = new Map(); // class -> ref -> [{tps, hw, did}]
  for (const o of obs) {
    if (!(o.tokens_per_sec > 0) || !o.hw) continue;
    if (!byClassRef.has(o.klass)) byClassRef.set(o.klass, new Map());
    const refs = byClassRef.get(o.klass);
    if (!refs.has(o.ref)) refs.set(o.ref, []);
    refs.get(o.ref).push({ tps: o.tokens_per_sec, hw: o.hw, did: o.node_did });
  }
  const spread = (xs) => (xs.length < 2 ? 0 : Math.max(...xs) / Math.min(...xs));
  const halves = (list, dim, cut) => {
    const lo = list.filter((r) => Number(r.hw[dim] || 0) < cut).map((r) => r.tps);
    const hi = list.filter((r) => Number(r.hw[dim] || 0) >= cut).map((r) => r.tps);
    return { lo, hi };
  };
  const out = {};
  for (const [klass, refs] of byClassRef) {
    let worst = null;
    for (const [ref, rows] of refs) {
      const uniq = new Map(rows.map((r) => [r.did, r]));
      if (uniq.size < 3) continue;
      const list = [...uniq.values()];
      const whole = spread(list.map((r) => r.tps));
      if (!worst || whole > worst.spread) worst = { ref, spread: whole, list };
    }
    if (!worst) continue;
    const row = { ref: worst.ref, grams: worst.list.length, tps_spread: +worst.spread.toFixed(1), split: null, merge: null };
    const inForce = applied?.[klass] || null;
    if (inForce?.dimension && Number(inForce.at) > 0) {
      // Already split on this cut: does the cut still explain the spread?
      const { lo, hi } = halves(worst.list, inForce.dimension, Number(inForce.at));
      if (lo.length >= 2 && hi.length >= 2) {
        const sl = spread(lo), sh = spread(hi);
        const converged = sl >= worst.spread * CLASS_MERGE_RATIO && sh >= worst.spread * CLASS_MERGE_RATIO;
        row.merge = { dimension: inForce.dimension, at: Number(inForce.at), converged, below: { grams: lo.length, tps_spread: +sl.toFixed(1) }, above: { grams: hi.length, tps_spread: +sh.toFixed(1) } };
      }
      out[klass] = row;
      continue;
    }
    if (worst.list.length < CLASS_SPLIT_MIN_GRAMS) {
      out[klass] = row;
      continue;
    }
    for (const dim of ['vram_gib', 'ram_gib']) {
      const vals = [...new Set(worst.list.map((r) => Number(r.hw[dim] || 0)))].sort((a, b) => a - b);
      if (vals.length < 2) continue;
      for (let i = 1; i < vals.length; i++) {
        const cut = vals[i];
        const { lo, hi } = halves(worst.list, dim, cut);
        if (lo.length < 2 || hi.length < 2) continue;
        const sl = spread(lo), sh = spread(hi);
        if (sl < worst.spread / 2 && sh < worst.spread / 2) {
          row.split = { dimension: dim, at: cut, below: { grams: lo.length, tps_spread: +sl.toFixed(1) }, above: { grams: hi.length, tps_spread: +sh.toFixed(1) } };
          break;
        }
      }
      if (row.split) break;
    }
    out[klass] = row;
  }
  return out;
}

/**
 * THE OSCILLATION WINDOW. A split or merge changes how every gram of a class
 * keys itself, and a class with few grams can look split one week and not the
 * next. So a proposal is applied only after it has held for
 * CLASS_VARIANCE_WINDOW consecutive aggregates, and the proposals are carried
 * in the published row as `history` (newest last) so the next aggregate reads
 * them back from the previous current.json.
 *
 * Per coarse class the published row is:
 *   split     the split IN FORCE (what refinedClassOf and the daemon apply),
 *             or null
 *   proposed  what this aggregate saw: 'split' | 'merge' | 'hold'
 *   history   the last CLASS_VARIANCE_WINDOW proposals, each
 *             { at, proposal, dimension?, cut? }
 *   streak    how many consecutive entries of history agree with the newest
 *   halves    (when split) the two halves' spreads under the cut in force
 *
 * `prior` is the previous publication's class_variance (or undefined).
 */
export function classVarianceWithHistory(obs, prior, at = new Date().toISOString()) {
  const applied = {};
  for (const [klass, row] of Object.entries(prior || {})) if (row?.split?.dimension) applied[klass] = { dimension: row.split.dimension, at: Number(row.split.at) };
  const fresh = classVariance(obs, applied);
  const out = {};
  const classes = new Set([...Object.keys(fresh), ...Object.keys(applied)]);
  for (const klass of classes) {
    const seen = fresh[klass] || null;
    const inForce = applied[klass] || null;
    const prev = prior?.[klass] || {};
    let proposal;
    if (inForce) {
      proposal = seen?.merge?.converged ? { at, proposal: 'merge', dimension: inForce.dimension, cut: inForce.at } : { at, proposal: 'hold' };
    } else if (seen?.split) {
      proposal = { at, proposal: 'split', dimension: seen.split.dimension, cut: seen.split.at };
    } else {
      proposal = { at, proposal: 'hold' };
    }
    const history = [...(Array.isArray(prev.history) ? prev.history : []), proposal].slice(-CLASS_VARIANCE_WINDOW);
    const same = (a, b) => a.proposal === b.proposal && (a.dimension || null) === (b.dimension || null) && (a.cut ?? null) === (b.cut ?? null);
    let streak = 0;
    for (let i = history.length - 1; i >= 0 && same(history[i], proposal); i--) streak++;
    const held = streak >= CLASS_VARIANCE_WINDOW;
    let split = inForce ? (prev.split || inForce) : null;
    if (!inForce && proposal.proposal === 'split' && held) split = seen.split;
    if (inForce && proposal.proposal === 'merge' && held) split = null;
    const row = seen ? { ...seen } : { ref: prev.ref || null, grams: 0, tps_spread: null };
    delete row.merge;
    if (seen?.merge) row.halves = { below: seen.merge.below, above: seen.merge.above, converged: seen.merge.converged };
    out[klass] = { ...row, split, proposed: proposal.proposal, history, streak };
  }
  return out;
}

/**
 * DEMAND PER CELL, from signed throughput observations: how many tokens the
 * grams of a class actually produced with an artifact. Depth (the rest of
 * the ladder, the language tail, batch shapes) follows this, never an
 * authored list. Tokens, not requests: a request that produced nothing is not
 * demand anyone paid for.
 */
export function demandTable(obs, prior = null) {
  const out = {};
  for (const o of obs) {
    if (!(o.total_tokens > 0)) continue;
    out[o.ref] = out[o.ref] || {};
    out[o.ref][o.klass] = (out[o.ref][o.klass] || 0) + o.total_tokens;
  }
  // A GRAM THAT WENT TO SLEEP DID NOT UN-SERVE ITS TOKENS.
  //
  // Demand is built from the observations the fleet is reporting NOW, so the
  // moment a gram sleeps every token it ever served vanished from the table
  // and the refs it served dropped below their class median -- which is what
  // orders depth and places replicas. Cumulative is what the number always
  // meant: the highest total the network has ever recorded for this cell
  // stands until a larger one replaces it.
  for (const [ref, classes] of Object.entries(prior || {})) {
    for (const [klass, tokens] of Object.entries(classes || {})) {
      if (!(Number(tokens) > 0)) continue;
      out[ref] = out[ref] || {};
      out[ref][klass] = Math.max(Number(out[ref][klass] || 0), Number(tokens));
    }
  }

  return out;
}

/**
 * mergeCost carries a hardware class's operational medians across an aggregate
 * in which no gram of that class reported.
 *
 * THE SAME REASON DEMAND IS CUMULATIVE. costTable reads the live fleet
 * snapshot; a class whose only grams are asleep disappeared from the table
 * entirely, taking its probe medians and download speed with it -- and every
 * gram of that class then planned its queue with no basis at all, on a fact
 * the network had already measured. What is carried is marked with the
 * aggregate that last saw it, so a reader can tell a measurement from a
 * memory.
 */
export function mergeCost(fresh, prior, at) {
  const out = {};
  for (const [klass, row] of Object.entries(prior || {})) {
    out[klass] = { ...row, carried_from: row.carried_from || row.at || null };
  }
  for (const [klass, row] of Object.entries(fresh || {})) {
    const kept = out[klass] || {};
    const engines = { ...(kept.engines || {}) };
    for (const [eng, r] of Object.entries(row.engines || {})) engines[eng] = { ...r, at };
    out[klass] = {
      ...kept, ...row, engines, at,
      carried_from: null,
    };
  }

  return out;
}

/** The refined class key under a proposed split: "<coarse>/vram>=12" or "<coarse>/vram<12". */
export function refinedClassOf(coarse, hw, variance) {
  const split = variance?.[coarse]?.split;
  if (!split || !hw) return coarse;
  const v = Number(hw[split.dimension] || 0);
  const dim = split.dimension.replace('_gib', '');
  return `${coarse}/${dim}${v >= split.at ? '>=' : '<'}${split.at}`;
}

export function buildSeasons(models, families, generatedAt = new Date().toISOString(), previous = readSeasons(), nodes = [], priorCurrent = readCurrent()) {
  const idx = artifactIndex(families);
  const obs = observations(models);
  // LEARNED CLASSES, applied. The split is proposed from the coarse buckets,
  // held for CLASS_VARIANCE_WINDOW aggregates (history read back from the
  // previous current.json), and then used to key coverage, so a gram reading
  // class_variance derives the same refined key the season used
  // (agent.CurrentHardwareClass).
  const variance = classVarianceWithHistory(obs, priorCurrent?.class_variance, generatedAt);
  for (const o of obs) o.klass = refinedClassOf(o.klass, o.hw, variance);
  const now = seasonIdOf(Date.parse(generatedAt));

  // season -> ref -> class -> row
  const bySeason = new Map();
  const cumulative = new Map(); // ref -> class -> row (all seasons)
  const publishersBySeason = new Map(); // season -> publisher -> {held, dids}
  const gramsBySeason = new Map();
  for (const o of obs) {
    const sid = o.ts ? seasonIdOf(o.ts) : now;
    if (!bySeason.has(sid)) bySeason.set(sid, new Map());
    const refs = bySeason.get(sid);
    if (!refs.has(o.ref)) refs.set(o.ref, new Map());
    const classes = refs.get(o.ref);
    if (!classes.has(o.klass)) classes.set(o.klass, emptyClassRow());
    fold(classes.get(o.klass), o);
    if (!cumulative.has(o.ref)) cumulative.set(o.ref, new Map());
    const cc = cumulative.get(o.ref);
    if (!cc.has(o.klass)) cc.set(o.klass, emptyClassRow());
    fold(cc.get(o.klass), o);
    if (!gramsBySeason.has(sid)) gramsBySeason.set(sid, new Set());
    gramsBySeason.get(sid).add(o.node_did);
    const art = idx.get(o.ref);
    if (art?.publisher) {
      if (!publishersBySeason.has(sid)) publishersBySeason.set(sid, new Map());
      const pubs = publishersBySeason.get(sid);
      if (!pubs.has(art.publisher)) pubs.set(art.publisher, { held: 0, dids: new Set(), engines: {} });
      const row = pubs.get(art.publisher);
      row.held += 1;
      row.dids.add(o.node_did);
      if (art.engine) row.engines[art.engine] = (row.engines[art.engine] || 0) + 1;
    }
  }
  // The open season exists even before anything is measured in it.
  if (!bySeason.has(now)) bySeason.set(now, new Map());

  const files = new Map();
  const ids = [...bySeason.keys()].sort().reverse();
  const indexEntries = [];
  for (const sid of ids) {
    const prev = previous.get(sid) || null;
    const prevRows = new Map();
    for (const a of prev?.artifacts || []) prevRows.set(a.ref, a.by_class || {});
    const refs = bySeason.get(sid);
    const artifacts = [];
    const seenRefs = new Set([...refs.keys(), ...prevRows.keys()]);
    for (const ref of [...seenRefs].sort()) {
      const art = idx.get(ref) || { ref, family: null, member: null };
      const classes = refs.get(ref) || new Map();
      const byClass = {};
      const classNames = new Set([...classes.keys(), ...Object.keys(prevRows.get(ref) || {})]);
      for (const k of [...classNames].sort()) {
        const cur = classes.has(k) ? finishRow(classes.get(k)) : { grams: 0, held_probes: 0, tokens_per_sec_best: null, effective_ctx_best: null, caps: {}, first_at: null, last_at: null };
        byClass[k] = mergeRows((prevRows.get(ref) || {})[k], cur);
      }
      artifacts.push({ ...art, by_class: byClass });
    }
    const pubs = publishersBySeason.get(sid) || new Map();
    const prevPubs = new Map((prev?.publishers || []).map((p) => [p.publisher, p]));
    const publisherNames = new Set([...pubs.keys(), ...prevPubs.keys()]);
    const publishers = [...publisherNames].sort().map((name) => {
      const cur = pubs.get(name);
      const before = prevPubs.get(name);
      const held = Math.max(cur?.held || 0, before?.held || 0);
      const grams = Math.max(cur?.dids?.size || 0, before?.grams || 0);
      const engines = { ...(before?.engines || {}) };
      for (const [e, n] of Object.entries(cur?.engines || {})) engines[e] = Math.max(engines[e] || 0, n);
      return { publisher: name, held, grams, engines };
    }).sort((a, b) => b.held - a.held || a.publisher.localeCompare(b.publisher));
    const grams = Math.max(gramsBySeason.get(sid)?.size || 0, prev?.contributors?.grams || 0);
    const classes = new Set(prev?.contributors?.classes || []);
    for (const refRows of refs.values()) for (const k of refRows.keys()) classes.add(k);
    const cohorts = {};
    for (const a of artifacts) if (Number.isInteger(a.cohort)) cohorts[a.cohort] = (cohorts[a.cohort] || 0) + 1;
    const season = {
      id: sid, cadence_days: SEASON_CADENCE_DAYS, ...seasonWindow(sid),
      open: sid === now, published_at: generatedAt,
      contributors: { grams, classes: [...classes].sort() },
      counts: { artifacts: artifacts.length, publishers: publishers.length, by_cohort: cohorts },
      artifacts, publishers,
      note: 'Every number is a signed measurement or a count of them. grams is how many distinct nodes contributed: a verified floor, not a complete account. Lineage (publisher, attribution, base, cohort, rung) is from the catalog and is not a measurement.',
    };
    files.set(`${SEASONS_DIR}/${sid}.json`, season);
    indexEntries.push({ id: sid, open: season.open, starts_at: season.starts_at, ends_at: season.ends_at, grams, artifacts: artifacts.length, publishers: publishers.length });
  }
  // Seasons that were published before but have no observation this run stay as they were.
  for (const [sid, prev] of previous) {
    if (!files.has(`${SEASONS_DIR}/${sid}.json`)) {
      files.set(`${SEASONS_DIR}/${sid}.json`, { ...prev, open: false });
      indexEntries.push({ id: sid, open: false, starts_at: prev.starts_at, ends_at: prev.ends_at, grams: prev.contributors?.grams || 0, artifacts: prev.artifacts?.length || 0, publishers: prev.publishers?.length || 0 });
    }
  }
  indexEntries.sort((a, b) => b.id.localeCompare(a.id));

  // current.json: the open season plus cumulative coverage for the grams.
  const coverage = {};
  for (const [ref, classes] of cumulative) {
    coverage[ref] = {};
    for (const [k, row] of classes) coverage[ref][k] = row.dids.size;
  }
  // Prior seasons' coverage counts too (a node that slept still measured).
  for (const [sid, prev] of previous) {
    if (sid === now) continue;
    for (const a of prev.artifacts || []) {
      coverage[a.ref] = coverage[a.ref] || {};
      for (const [k, row] of Object.entries(a.by_class || {})) coverage[a.ref][k] = Math.max(coverage[a.ref][k] || 0, row.grams || 0);
    }
  }
  // coverage_caps: one level finer -- ref -> class -> capability -> how many
  // probes proved it. A CELL of the probe-work plan is one entry here.
  const coverageCaps = {};
  for (const [ref, classes] of cumulative) {
    coverageCaps[ref] = {};
    for (const [k, row] of classes) coverageCaps[ref][k] = Object.fromEntries(Object.entries(row.caps).sort());
  }
  for (const [sid, prev] of previous) {
    if (sid === now) continue;
    for (const a of prev.artifacts || []) {
      coverageCaps[a.ref] = coverageCaps[a.ref] || {};
      for (const [k, row] of Object.entries(a.by_class || {})) {
        coverageCaps[a.ref][k] = coverageCaps[a.ref][k] || {};
        for (const [c, n] of Object.entries(row.caps || {})) coverageCaps[a.ref][k][c] = Math.max(coverageCaps[a.ref][k][c] || 0, n);
      }
    }
  }
  const current = {
    ...files.get(`${SEASONS_DIR}/${now}.json`),
    coverage,
    coverage_caps: coverageCaps,
    proving: provingNow(nodes),
    grams: gramProgress(nodes),
    grams_note: 'one row per gram: what it is, what its hardware can never reach, how far it has got, and its OWN priced estimate for the rest. There is no single fleet ETA, because a gram only proves what it can obtain.',
    modalities: modalities(nodes, files.get(`${SEASONS_DIR}/${now}.json`)),
    modalities_note: 'per engine: how many artifacts this season proved, on how many hardware classes, which capabilities came back, and how many artifact-slots the fleet currently cannot reach at all (no Apple Silicon for MLX, no schedulable card for vLLM, no cluster for the speech pods). An engine with zero proved and a large unreachable count has never been shown to work on this network -- a statement about the network, not about the models.',
    proving_note: 'proving is a LEASE, not a fact: what each gram said it was working on when it last reported. It expires on its own, confers nothing and is never coverage. It is here so the network can be watched working.',
    refusals: refusalTable(nodes, previous, now),
    refusals_note: 'refusals are signed facts about (artifact, class): gated, unloadable, or absent upstream. They are coverage of a kind -- the fleet learned it once -- and they sink the cell to the back of every gram of that class. A refusal lifts when its season closes and the engine that refused has moved on.',
    cost: mergeCost(costTable(nodes), priorCurrent?.cost, generatedAt),
    class_variance: variance,
    class_variance_note: `class_variance.<class>.split is the split in force; a split or merge is applied only after the same proposal held for ${CLASS_VARIANCE_WINDOW} consecutive aggregates (history), and a class with fewer than ${CLASS_SPLIT_MIN_GRAMS} grams never splits.`,
    demand: demandTable(obs, priorCurrent?.demand),
    demand_note: 'demand is tokens produced per artifact per class, from signed throughput observations; it orders depth, never existence.',
    contributors_note: 'grams and classes are what THIS window heard from; coverage, refusals, cost and demand carry across windows, because a gram going to sleep does not unmake what it measured.',
    cost_note: 'cost is operational: medians of node-reported pull/probe clocks per hardware class and engine, with sample counts. It is not a measurement of any model and is never ranked.',
  };
  const index = { generated_at: generatedAt, cadence_days: SEASON_CADENCE_DAYS, current: now, seasons: indexEntries };
  return { files, current, index };
}

/**
 * refusalTable: ref -> class -> {cause, grams, version, first_at, last_at}.
 *
 * ── WHY A REFUSAL IS PUBLISHED AT ALL ─────────────────────────────────────
 *
 * Coverage-first sends every gram of a class at the cells nobody has proved.
 * When a cell CANNOT be proved -- the repo is gated, the engine has no loader
 * for that architecture, the quant was never published -- every gram of the
 * class discovers that separately, once per season. Four grams lost four
 * hours each on the same sixteen Indic artifacts the night this was written.
 *
 * A refusal is as useful as a measurement and is signed the same way, so it
 * belongs in the season beside coverage. Only permanent causes appear: a
 * budget refusal is one machine's today, an engine outage is one minute's.
 */
export function refusalTable(nodes, previous = new Map(), now = '') {
  const PERMANENT = new Set(['gated', 'unloadable', 'unavailable']);
  const out = {};
  const note = (ref, klass, cause, at, version) => {
    if (!ref || !klass || !PERMANENT.has(cause)) return;
    out[ref] = out[ref] || {};
    const row = out[ref][klass] || { cause, grams: 0, version: version || '', first_at: at, last_at: at, dids: new Set() };
    row.cause = cause;
    if (at && (!row.first_at || at < row.first_at)) row.first_at = at;
    if (at && (!row.last_at || at > row.last_at)) row.last_at = at;
    if (version) row.version = version;
    out[ref][klass] = row;
  };
  for (const n of nodes || []) {
    const p = n?.probes;
    const klass = p?.hardware_class || '';
    for (const r of p?.refusals || []) {
      note(r.ref, r.class || klass, String(r.cause || ''), r.at || '', n.version || '');
      const row = out[r.ref]?.[r.class || klass];
      if (row && n.node_did) row.dids.add(n.node_did);
    }
  }
  // A refusal another gram published in an earlier season still stands until
  // that season closes AND the engine moves; carrying it forward is what
  // makes a gram that has never met the artifact step over it.
  for (const [sid, prev] of previous || []) {
    if (sid === now) continue;
    for (const [ref, classes] of Object.entries(prev.refusals || {})) {
      for (const [klass, row] of Object.entries(classes)) {
        if (!PERMANENT.has(row.cause)) continue;
        out[ref] = out[ref] || {};
        const cur = out[ref][klass];
        if (!cur) {
          out[ref][klass] = { ...row, dids: new Set() };
          out[ref][klass].grams = row.grams || 1;
        }
      }
    }
  }
  for (const classes of Object.values(out)) {
    for (const row of Object.values(classes)) {
      if (row.dids) {
        row.grams = Math.max(row.grams || 0, row.dids.size);
        delete row.dids;
      }
    }
  }

  return out;
}

/**
 * provingNow: what the network has a live claim on, gram by gram.
 *
 * ── A LEASE, PUBLISHED AS A LEASE ───────────────────────────────────────────
 *
 * Every other table here is a FACT: coverage, refusals, cost, demand, all of
 * them signed and cumulative. This one is the opposite and must read as such --
 * it is what each gram said it was working on when it last reported, it expires
 * on its own, it confers nothing and ranks nothing. It is published because a
 * network nobody can watch working looks like a network that is not working:
 * a reader gets "who is proving what, and where", from data the grams already
 * gossip, without opening a shell on anybody's laptop.
 *
 * Stale rows are dropped rather than shown as current -- a claim whose lease
 * has expired is not news about the present.
 */
export function provingNow(nodes, now = Date.now()) {
  const out = [];
  for (const n of nodes || []) {
    const c = n?.probes?.proving;
    if (!c?.ref) continue;
    const until = c.until ? Date.parse(c.until) : NaN;
    if (Number.isFinite(until) && until < now) continue;
    out.push({
      gram: String(n.node_did || '').slice(-6),
      ref: c.ref,
      family: c.family || null,
      member: c.member || null,
      class: c.class || n?.probes?.hardware_class || null,
      region: c.region || null,
      until: c.until || null,
    });
  }

  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * gramProgress: one row per gram -- what it is, what it can reach, how far it
 * has got, and when it expects to finish.
 *
 * ── THE QUESTION A FOUNDER ACTUALLY ASKS ────────────────────────────────────
 *
 * "How long until the catalog is proved" has no single answer, and publishing
 * one number would be a lie of convenience. A gram proves the artifacts its
 * hardware can obtain: a Windows box with no Apple Silicon will never measure
 * an MLX build, and a machine with no schedulable card will never measure a
 * vLLM one. So progress is per gram, and the unreachable count is published
 * beside it rather than hidden inside a percentage.
 *
 * expected_hours is the gram's OWN priced estimate -- the sum over its queue
 * of what each artifact should cost it, from its own clocks or from machines
 * of its class. eta_hours is the trailing count, kept beside it because they
 * disagree in a way that is informative: a machine that measured twice
 * yesterday reports 1668 trailing hours and 24 priced ones, and the priced one
 * is the one a person can plan with.
 */
export function gramProgress(nodes) {
  const out = [];
  for (const n of nodes || []) {
    const p = n?.probes;
    if (!p || p.queued == null) continue;
    const unreachable = Object.values(p.unobtainable || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    out.push({
      gram: String(n.node_did || '').slice(-6),
      os: n.os || null,
      class: p.hardware_class || null,
      engines: Object.keys(p.engines || {}).sort(),
      artifacts: p.artifacts ?? null,
      measured: p.measured ?? 0,
      failed: p.failed ?? 0,
      queued: p.queued ?? 0,
      unreachable,
      unreachable_by_engine: p.unobtainable || {},
      expected_hours: p.outlook?.expected_hours ?? null,
      expected_basis: p.outlook?.expected_basis ?? null,
      eta_hours: p.outlook?.eta_hours ?? null,
      blocked: p.outlook?.blocked || null,
      last_seen: n.last_seen || null,
    });
  }

  return out.sort((a, b) => b.measured - a.measured || a.gram.localeCompare(b.gram));
}

/**
 * modalities: what the catalog asks of each kind of engine, and how much of it
 * has been proved.
 *
 * A reader cannot tell from a coverage table whether VIDEO models run at all,
 * which is the first thing anyone asks about them. This groups the season's
 * own artifacts by engine -- diffusers, vision-task, audiogen, ollama, vllm,
 * mlx, speech -- with the capabilities actually proved on each, so "do video
 * models work here" has an answer that is a measurement rather than a guess.
 */
export function modalities(nodes, current) {
  const byEngine = new Map();
  const touch = (e) => {
    if (!byEngine.has(e)) {
      byEngine.set(e, { engine: e, proved_artifacts: 0, measured: 0, unreachable: 0, capabilities: {}, grams: new Set() });
    }

    return byEngine.get(e);
  };
  for (const a of current?.artifacts || []) {
    if (!a.engine) continue;
    const row = touch(a.engine);
    row.proved_artifacts++;
    for (const [klass, by] of Object.entries(a.by_class || {})) {
      row.measured += by.grams || 0;
      row.grams.add(klass);
      for (const [c, n] of Object.entries(by.caps || {})) row.capabilities[c] = (row.capabilities[c] || 0) + n;
    }
  }
  for (const n of nodes || []) {
    for (const [engine, count] of Object.entries(n?.probes?.unobtainable || {})) {
      touch(engine).unreachable += Number(count) || 0;
    }
  }

  return [...byEngine.values()]
    .map((r) => ({ ...r, classes: r.grams.size, grams: undefined }))
    .sort((a, b) => b.proved_artifacts - a.proved_artifacts || a.engine.localeCompare(b.engine));
}

/** Previously published seasons, by id. */
export function readSeasons(dir = SEASONS_DIR) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const m = /^(\d{4}-[WF]\d{2})\.json$/.exec(name);
    if (!m) continue;
    try {
      out.set(m[1], JSON.parse(readFileSync(`${dir}/${name}`, 'utf8')));
    } catch {
      // an unreadable prior season is rebuilt from the record; nothing is lost
    }
  }
  return out;
}

/** The previously published current.json, or null: the class-variance history lives there. */
export function readCurrent(dir = SEASONS_DIR) {
  const path = `${dir}/current.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null; // an unreadable history starts the window over; nothing else is lost
  }
}

/** Write what buildSeasons returned. */
export function writeSeasons({ files, current, index }, dir = SEASONS_DIR) {
  mkdirSync(dir, { recursive: true });
  for (const [path, obj] of files) writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  writeFileSync(`${dir}/current.json`, JSON.stringify(current, null, 2) + '\n');
  writeFileSync(`${dir}/index.json`, JSON.stringify(index, null, 2) + '\n');
}
