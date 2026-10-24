// FILING A MEASURED MODEL UNDER TODAY'S CATALOG, AND NAMING ITS BUILD.
//
// Founder's decisions, 2026-10-24 (epn-daemon docs/CATALOG_COVERAGE_BACKLOG.md §E):
//
//   * Old signed results are filed by the CURRENT catalog, by ref. The signed fact
//     is about the ARTIFACT (ref + quant + engine), never about a member; the
//     family/member a gram signed is what its catalog believed that day, and the
//     catalog has since re-filed builds (e2b~bartowski folds into e2b, Qwen3-VL-4B
//     leaves qwen-3/4b). The signature is untouched; the signed filing is kept
//     beside the current one as a note.
//   * Every build has its own address under its member:
//     /inferences/<family>/<member>/<build>, build = publisher-quant-engine -- the
//     same three facts the daemon uses for artifact identity -- with the precision
//     the catalog read from the repo's files when the name carries none.
//
// This file is the join and the naming. It never infers a family from the shape
// of a name: a ref the catalog does not name, by ref or by repo, keeps whatever
// its signature said.

/** A path-safe lower-case word: "Q4_K_M" -> "q4_k_m", "Jackrong" -> "jackrong". */
export function slugPart(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9._]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .replace(/-{2,}/g, '-');
}

/**
 * The repo a ref names, lower-cased, or null for an engine tag.
 * "hf.co/unsloth/gemma-4-E2B-it-GGUF:Q4_K_M" -> "unsloth/gemma-4-e2b-it-gguf";
 * "google/gemma-4-E2B-it-qat-w4a16-ct" -> itself; "gemma4:e2b" -> null.
 */
export function refRepo(ref) {
  let r = String(ref || '').trim();
  if (r.toLowerCase().startsWith('hf.co/')) r = r.slice(6);
  const slash = r.indexOf('/');
  if (slash <= 0) return null;
  const colon = r.indexOf(':', slash);
  if (colon >= 0) r = r.slice(0, colon);
  return r.toLowerCase();
}

/** The quant written into a pull ref ("hf.co/x/y:Q4_K_M" -> "Q4_K_M"), or null. */
function refQuant(ref) {
  const r = String(ref || '');
  const slash = r.indexOf('/');
  const colon = r.lastIndexOf(':');
  if (slash < 0 || colon < slash) return null;
  return r.slice(colon + 1).toUpperCase() || null;
}

/** The engine a node ran, as the catalog spells engines. */
function normalizeEngine(runtime) {
  const r = String(runtime || '').toLowerCase();
  if (!r) return null;
  return r.replace(/-host$/, '');
}

// Words in a derivative's name that say safety training was removed. The same
// markers the daemon's lineage reads (derivativeMarkers), restricted to the ones
// that are about safety rather than about merging.
const SAFETY_REMOVED = /(^|[^a-z])(abliterat\w*|uncensor\w*|heretic|unfiltered|unaligned|nsfw)([^a-z]|$)/i;

/** True when a ref's own name says the safety training was taken out. */
export function safetyRemoved(ref) {
  return SAFETY_REMOVED.test(String(ref || '').replace(/^hf\.co\//i, ''));
}

/** Indexes a catalog by exact ref, by alias, and by repo; each key lists every member that names it. */
export function catalogIndex(families) {
  const byRef = new Map();
  const byAlias = new Map();
  const byRepo = new Map();
  const add = (map, key, place) => {
    if (!key) return;
    const list = map.get(key) || [];
    if (!list.some((p) => p.family === place.family && p.member === place.member)) list.push(place);
    map.set(key, list);
  };
  for (const fam of families || []) {
    for (const mem of fam.members || []) {
      const at = (art) => ({ family: fam.id, member: mem.id, artifact: art, derivative: !!mem.derivative, base_member: mem.base || null });
      for (const art of mem.artifacts || []) {
        add(byRef, String(art.ref || '').trim().toLowerCase(), at(art));
        add(byRepo, refRepo(art.ref), at(art));
      }
      for (const alias of mem.aliases || []) add(byAlias, String(alias || '').trim().toLowerCase(), at(null));
    }
  }
  return { byRef, byAlias, byRepo };
}

// ONE KEY, TWO MEMBERS. Catalogs published by grams on older builds still file
// some refs twice -- the seed's wan-2/t2v-1-3b and discovery's wan-2/1.3b for one
// repo -- until those grams update. Where the gram that measured the model
// signed one of the candidates, that one is the answer; an exact ref otherwise
// takes the first; a repo named by two members is no answer at all.
function choose(list, signed, exactKey) {
  if (!list || list.length === 0) return null;
  const mine = list.find((p) => p.family === signed.family && p.member === signed.member);
  if (mine) return mine;
  if (list.length === 1 || exactKey) return list[0];
  return null;
}

/** Where today's catalog files a model, and how that was decided. */
export function placementOf(model, index, signed = { family: null, member: null }) {
  const name = String(model.name || '').trim().toLowerCase();
  const exact = choose(index.byRef.get(name), signed, true);
  if (exact) return { ...exact, by: 'catalog_ref' };
  const alias = choose(index.byAlias.get(name), signed, true);
  if (alias) return { ...alias, by: 'catalog_alias' };
  const repo = refRepo(model.name);
  const sameRepo = repo ? choose(index.byRepo.get(repo), signed, false) : null;
  if (sameRepo) {
    return {
      ...sameRepo,
      artifact: { ...sameRepo.artifact, ref: model.name, quant: refQuant(model.name) || sameRepo.artifact?.quant },
      by: 'catalog_repo',
    };
  }
  return null;
}

/** The build's three facts: whose packaging, which precision, which engine. */
export function buildFacts(model, artifact) {
  const ref = String(model.name || '');
  const repo = refRepo(ref);
  const publisher = artifact?.by || (repo ? repo.split('/')[0] : ref.includes(':') ? 'ollama' : null);
  // PRECISION: what the ref spells, else what the catalog read from the repo's
  // own files, else what the node's runtime declared.
  const quant =
    refQuant(ref) ||
    artifact?.quant ||
    model.declared?.quantization ||
    null;
  const runtimes = (model.nodes || []).map((n) => normalizeEngine(n.runtime)).filter(Boolean);
  const counts = new Map();
  for (const r of runtimes) counts.set(r, (counts.get(r) || 0) + 1);
  const ran = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || null;
  // The catalog's engine names the loader ("diffusers", "vision-task"); a node
  // reports the engine process ("generation"), which is the less specific word.
  const engine = artifact?.engine || ran || null;
  return { publisher: publisher ? String(publisher) : null, quant: quant ? String(quant) : null, engine };
}

/** The path segment for one build. Precision missing falls back to the repo's own name. */
export function buildIdOf(model, facts) {
  const repo = refRepo(model.name);
  // No precision known: the repo's own name, or an engine tag's own word
  // (gemma4:e2b-it-qat -> e2b-it-qat), stands in for it.
  const tag = !repo && String(model.name || '').includes(':') ? String(model.name).split(':').pop() : null;
  const precision = facts.quant || (repo ? repo.split('/')[1] : null) || tag || 'unknown';
  return [facts.publisher || 'unknown', precision, facts.engine || 'unknown'].map(slugPart).filter(Boolean).join('-');
}

/**
 * Re-files every model under the current catalog and gives each filed model a
 * build id unique within its member. Returns the models (mutated in place) and
 * counts for the log.
 */
export function fileModelsByCatalog(models, families, previousBuilds = new Map()) {
  const index = catalogIndex(families);
  let refiled = 0;
  let filed = 0;
  for (const m of models || []) {
    const signed = { family: m.signed_family ?? m.family ?? null, member: m.signed_member ?? m.member ?? null };
    // Keep the SIGNED filing once, from the first run that had it, so a
    // re-filing never forgets what the gram itself said.
    if (m.signed_family === undefined) m.signed_family = signed.family;
    if (m.signed_member === undefined) m.signed_member = signed.member;
    const place = placementOf(m, index, signed);
    if (place) {
      m.family = place.family;
      m.member = place.member;
      m.filed_by = place.by;
      filed += 1;
      if (signed.family && (signed.family !== place.family || signed.member !== place.member)) refiled += 1;
    } else {
      m.family = signed.family;
      m.member = signed.member;
      m.filed_by = signed.family ? 'signed' : null;
    }
    const facts = buildFacts(m, place?.artifact || null);
    m.publisher = facts.publisher;
    m.quant = facts.quant;
    m.engine = facts.engine;
    m.attribution = place?.artifact?.attribution || (place?.derivative ? 'derivative' : null);
    m.base_ref = place?.artifact?.base || null;
    m.derivative = !!place?.derivative;
    m.base_member = place?.base_member || null;
    m.safety_removed = safetyRemoved(m.name) || safetyRemoved(m.base_ref);
    m.build = m.family && m.member ? buildIdOf(m, facts) : null;
  }

  // ONE ADDRESS PER BUILD, AND IT DOES NOT MOVE. Two builds of one member can
  // share publisher, quant and engine (unsloth's gemma-4-12B-it-GGUF and
  // gemma-4-12B-it-qat-GGUF are both unsloth Q4_K_M on Ollama); the words that
  // tell their repos apart are added, and a ref that differs only in case gets a
  // short digest of itself. A build keeps the address it was published under
  // while that address is still its own, so a shared link survives a newcomer.
  const groups = new Map();
  for (const m of models || []) {
    if (!m.build) continue;
    const key = `${m.family}/${m.member}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.name.localeCompare(b.name));
    const byBase = new Map();
    for (const m of group) {
      if (!byBase.has(m.build)) byBase.set(m.build, []);
      byBase.get(m.build).push(m);
    }
    const taken = new Set();
    const wanted = new Map();
    // Previously published addresses first: they are what is already linked.
    for (const m of group) {
      const prev = previousBuilds.get(m.name);
      if (prev && prev.family === m.family && prev.member === m.member && prev.build && !taken.has(prev.build)) {
        wanted.set(m, prev.build);
        taken.add(prev.build);
      }
    }
    for (const [base, same] of byBase) {
      const words = same.map((m) => new Set(String(refRepo(m.name) || m.name).split(/[^a-z0-9]+/i).map((w) => w.toLowerCase()).filter(Boolean)));
      same.forEach((m, i) => {
        if (wanted.has(m)) return;
        const candidates = [];
        if (same.length === 1) candidates.push(base);
        const own = [...words[i]].filter((w) => !words.every((set) => set.has(w)));
        if (own.length) candidates.push(`${base}-${own.map(slugPart).join('-')}`);
        candidates.push(`${base}-${shortDigest(m.name)}`);
        const id = candidates.find((c) => !taken.has(c)) || `${base}-${shortDigest(m.name + '|' + taken.size)}`;
        wanted.set(m, id);
        taken.add(id);
      });
    }
    for (const [m, id] of wanted) m.build = id;
  }
  return { models, filed, refiled };
}

/** Eight hex characters of a stable, dependency-free hash (FNV-1a). */
function shortDigest(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
