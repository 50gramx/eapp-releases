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
export function buildSeasons(models, families, generatedAt = new Date().toISOString(), previous = readSeasons()) {
  const idx = artifactIndex(families);
  const obs = observations(models);
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
  const current = { ...files.get(`${SEASONS_DIR}/${now}.json`), coverage };
  const index = { generated_at: generatedAt, cadence_days: SEASON_CADENCE_DAYS, current: now, seasons: indexEntries };
  return { files, current, index };
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

/** Write what buildSeasons returned. */
export function writeSeasons({ files, current, index }, dir = SEASONS_DIR) {
  mkdirSync(dir, { recursive: true });
  for (const [path, obj] of files) writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
  writeFileSync(`${dir}/current.json`, JSON.stringify(current, null, 2) + '\n');
  writeFileSync(`${dir}/index.json`, JSON.stringify(index, null, 2) + '\n');
}
