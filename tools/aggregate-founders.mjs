// Rebuilds data/founders.json purely as a function of data/nodes/*.json (and
// each node's data/nodes/<name>.history.jsonl). Because the output is fully
// derived, the CI loop can safely re-run this after syncing to origin — no
// merge conflicts, ever (see aggregate-founders.yml).
//
// Honesty fixes (see repo task notes): this file used to (a) filter to
// class === 'founder' only, dropping every community/keeper node; (b) surface
// each node's raw process `uptime_seconds`, which resets to ~0 on every
// auto-update restart, as "cumulative uptime"; and (c) label one box's local
// counters as network totals. All three are fixed below. Every number this
// script emits is still a SELF-REPORT from the node's own daemon — there is
// no independent verification — and every card on the page must say so.
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const NODES_DIR = 'data/nodes';
// What the published data/ directory may weigh before this run says so out loud.
// See the check at the end of main() for why a warning and not a failure.
const PUBLISH_BUDGET_BYTES = 5_000_000;
const CLOUD_RATE_USD_PER_1M = 10; // transparent cloud-equivalent rate for displaced-cost estimate
// The reporter timer runs every 15 minutes (report-bootstrap-status.timer).
// Used only as a cap on how long a single online->online gap between two
// heartbeats may count toward lifetime uptime (see lifetimeUptimeSeconds).
const EXPECTED_HEARTBEAT_INTERVAL_SEC = 15 * 60;
// The metered resource nets, and nothing else. Mirrors proofsnapshot.resourceTypes
// in epn-daemon and epn-protocol's ResourceVector — three places that must agree,
// because this list decides what the site presents as capacity a region contributes.
//
// speech_asr/speech_tts were briefly added here and must not come back. A speech
// engine is a model being served: its evidence is task-typed model evidence, its
// metering is inference metering, and a realtime-factor RATIO cannot be summed into
// the "aggregate = sum of verified signed node results" this file publishes per
// resource type. See proofsnapshot.resourceTypes for the full reasoning.
const RESOURCE_TYPES = ['network', 'inference', 'cpu', 'mem', 'storage', 'gpu', 'energy'];

/**
 * True when a resource type is one of the metered nets.
 *
 * Used to scrub records that a previous run published under a type this list no
 * longer recognises. The merges below are high-water marks by design — they hold a
 * signed best until something beats it — which means a type published in error
 * would otherwise be carried forward forever, long after the daemon stopped
 * producing it. A resource that is no longer a resource is not a regression to
 * protect; it is a retraction to honour.
 */
function isResourceType(type) {
    return RESOURCE_TYPES.includes(type);
}
const COMMISSIONING_STATUS = 'configured_not_yet_benchmarked';

// ---------------------------------------------------------------------------
// Pure functions (unit-tested by aggregate-founders.test.mjs) — no fs access.
// ---------------------------------------------------------------------------

/**
 * Lifetime/availability uptime derived from a node's append-only heartbeat
 * history, robust to auto-update restarts (which reset the process's own
 * uptime_seconds to ~0) and to missed heartbeats (gaps).
 *
 * Formula: walk consecutive heartbeat pairs in time order. For each pair,
 * count the wall-clock delta between them toward lifetime uptime ONLY if
 * both heartbeats reported online AND the gap is no more than 2x the
 * expected reporting interval. The 2x cap means a missed heartbeat or two
 * (reporter hiccup) still counts, but a multi-hour/day gap (box was down,
 * network was cut, reporter itself died) does NOT get silently credited as
 * uptime just because the node came back online afterward — that gap is
 * simply excluded rather than guessed at.
 *
 * This intentionally ignores each heartbeat's self-reported uptime_seconds
 * entirely: that field resets on every restart and would undercount lifetime
 * uptime across a fleet that auto-updates every 15 minutes' worth of drift.
 */
export function lifetimeUptimeSeconds(history, expectedIntervalSec = EXPECTED_HEARTBEAT_INTERVAL_SEC) {
  if (!Array.isArray(history) || history.length < 2) return 0;
  const sorted = [...history].sort((a, b) => new Date(a.t) - new Date(b.t));
  let total = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const dt = (new Date(cur.t) - new Date(prev.t)) / 1000;
    if (!(dt > 0)) continue;
    if (prev.online && cur.online && dt <= expectedIntervalSec * 2) {
      total += dt;
    }
  }
  return Math.round(total);
}

/** Fraction (0-100) of recorded heartbeats that were online. Gap-robust by
 * construction: it counts heartbeats, not time, so a long gap with no
 * heartbeats at all simply contributes no samples either way. */
export function availabilityPct(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const online = history.filter((h) => h.online).length;
  return +((online / history.length) * 100).toFixed(1);
}

/** Earliest heartbeat timestamp, i.e. first-seen time for this node. */
export function firstSeenAt(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  return history.reduce((min, h) => (!min || new Date(h.t) < new Date(min) ? h.t : min), null);
}

/** Sums one counter field across every node's LATEST snapshot. Missing/zero
 * fields count as 0 — a node that has never reported a counter must not
 * silently break the network total. */
export function sumField(nodes, field) {
  return nodes.reduce((a, n) => a + (Number(n[field]) || 0), 0);
}

/**
 * Merges every node's history into a single network-wide "peers online over
 * time" trend. At each event (any node's heartbeat), the network total is
 * the sum of the most-recently-known peer count for every node (a node's
 * count only updates when ITS heartbeat arrives; nodes that haven't reported
 * yet contribute 0, not undefined). Downsampled evenly to at most `maxPoints`
 * so the page's sparkline stays cheap to render over months of history.
 */
export function mergePeerTrend(nodeHistories, maxPoints = 60) {
  const events = [];
  for (const [name, history] of Object.entries(nodeHistories)) {
    for (const h of history) {
      events.push({ node: name, t: h.t, peers: Number(h.peers) || 0 });
    }
  }
  events.sort((a, b) => new Date(a.t) - new Date(b.t));

  const last = {};
  const trend = [];
  for (const e of events) {
    last[e.node] = e.peers;
    const total = Object.values(last).reduce((a, v) => a + v, 0);
    trend.push({ t: e.t, peers_online_total: total });
  }

  if (trend.length <= maxPoints) return trend;
  const step = trend.length / maxPoints;
  const sampled = [];
  for (let i = 0; i < maxPoints; i++) {
    sampled.push(trend[Math.floor(i * step)]);
  }
  sampled.push(trend[trend.length - 1]);
  return sampled;
}

function marker(resourceType) {
  return {
    resource_type: resourceType,
    status: COMMISSIONING_STATUS,
    label: 'configured, not-yet-benchmarked',
    note: 'No verified signed benchmark has been reported for this resource type yet.',
  };
}

function signatureBuffer(signature) {
  if (typeof signature === 'string') return Buffer.from(signature, 'base64');
  if (Array.isArray(signature)) return Buffer.from(signature);
  return Buffer.alloc(0);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function payloadBuffer(sr, payloadB64) {
  if (payloadB64) return Buffer.from(payloadB64, 'base64');
  const r = sr?.result;
  if (!r) return Buffer.alloc(0);
  const out = {
    metric: r.metric,
    value: r.value,
    unit: r.unit,
    ts: r.ts,
    node_did: r.node_did,
  };
  if (r.extra && Object.keys(r.extra).length > 0) {
    out.extra = sortObject(r.extra);
  }
  return Buffer.from(JSON.stringify(out));
}

function publicKeyFromDID(did) {
  const prefix = 'did:epn:';
  if (!did || !did.startsWith(prefix)) {
    throw new Error('missing did:epn public key');
  }
  const raw = Buffer.from(did.slice(prefix.length), 'hex');
  const libp2pEd25519Prefix = Buffer.from([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]);
  if (raw.length !== libp2pEd25519Prefix.length + 32 || !raw.subarray(0, libp2pEd25519Prefix.length).equals(libp2pEd25519Prefix)) {
    throw new Error('unsupported DID public-key encoding');
  }
  const ed25519Raw = raw.subarray(libp2pEd25519Prefix.length);
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([spkiPrefix, ed25519Raw]), format: 'der', type: 'spki' });
}

// The outer `result` object (r) is untrusted until we confirm it is exactly
// what the signature covers: a valid signature over SOME payload proves
// nothing about r.value if r itself can diverge from that payload. This
// guards against a tampered/re-labeled envelope that keeps an old, validly
// signed payload_b64 but reports a different value/metric/unit/node_did in
// the outer result — which would otherwise sum or "win best" on a forged
// number despite carrying a real signature.
function payloadMatchesResult(payload, r) {
  let decoded;
  try {
    decoded = JSON.parse(payload.toString('utf8'));
  } catch {
    return false;
  }
  if (decoded.metric !== r.metric) return false;
  if (Number(decoded.value) !== Number(r.value)) return false;
  if (decoded.unit !== r.unit) return false;
  if (decoded.node_did !== r.node_did) return false;
  if (decoded.ts !== undefined && r.ts !== undefined && decoded.ts !== r.ts) return false;
  const decodedExtra = decoded.extra ? JSON.stringify(sortObject(decoded.extra)) : '';
  const rExtra = r.extra ? JSON.stringify(sortObject(r.extra)) : '';
  if (decodedExtra !== rExtra) return false;
  return true;
}

export function verifySignedResult(sr, payloadB64 = '') {
  try {
    const r = sr?.result;
    if (!r?.node_did || !r.metric || typeof r.value !== 'number' || !r.unit) {
      return { ok: false, reason: 'missing result fields' };
    }
    const sig = signatureBuffer(sr.signature);
    if (sig.length === 0) {
      return { ok: false, reason: 'missing signature' };
    }
    const payload = payloadBuffer(sr, payloadB64);
    if (payload.length === 0) {
      return { ok: false, reason: 'missing signing payload' };
    }
    if (!payloadMatchesResult(payload, r)) {
      return { ok: false, reason: 'result does not match signed payload' };
    }
    const pub = publicKeyFromDID(r.node_did);
    const ok = verifySignature(null, payload, pub, sig);
    return {
      ok,
      reason: ok ? 'verified' : 'signature invalid',
      payload_sha256: createHash('sha256').update(payload).digest('base64'),
      // The EXACT bytes the node signed, and only when the node actually
      // published them. Never the reconstruction from payloadBuffer's fallback:
      // a consumer that re-serializes `result` in JavaScript cannot reproduce
      // Go's int64 nanosecond `ts` (it exceeds 2^53, so JSON.parse rounds it),
      // and would report a valid signature as invalid on roughly a fifth of
      // real records. Publishing these bytes is what lets a browser verify at
      // all; publishing a guess at them would manufacture false tampering
      // alarms on honest measurements, which is worse than publishing nothing.
      payload_b64: payloadB64 || '',
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function proofSnapshotOf(node) {
  return node?.proof_snapshot || node?.proofSnapshot || null;
}

// collectSignedResultsFrom pulls every signed benchmark candidate out of a
// list of { name, proof_snapshot } entries. Shared by self-reported nodes
// (data/nodes/<name>.json) and DHT-fetched peer snapshots (mesh views) —
// both carry the identical proofsnapshot.Snapshot shape from the daemon.
function collectSignedResultsFrom(entries) {
  const out = [];
  for (const { name, proof_snapshot } of entries) {
    const resources = proof_snapshot?.resources || {};
    const network = resources.network;
    if (network?.result) {
      out.push({
        node_name: name || null,
        resource_type: 'network',
        model: null,
        signed_result: network.result,
        payload_b64: network.signing_payload_b64 || '',
      });
    }
    const inference = resources.inference;
    const modelPayloads = inference?.model_signing_payloads || {};
    for (const [model, signedResult] of Object.entries(inference?.models || {})) {
      out.push({
        node_name: name || null,
        resource_type: 'inference',
        model,
        signed_result: signedResult,
        payload_b64: modelPayloads[model] || '',
      });
    }
    for (const resourceType of RESOURCE_TYPES) {
      if (resourceType === 'network' || resourceType === 'inference') continue;
      const proof = resources[resourceType];
      if (proof?.result) {
        out.push({
          node_name: name || null,
          resource_type: resourceType,
          model: null,
          signed_result: proof.result,
          payload_b64: proof.signing_payload_b64 || '',
        });
      }
    }
  }
  return out;
}

function collectSignedResults(nodes) {
  return collectSignedResultsFrom(nodes.map((node) => ({ name: node.name, proof_snapshot: proofSnapshotOf(node) })));
}

// collectMeshSignedResults pulls signed benchmarks out of every peer's
// DHT-fetched proof snapshot across all reporters' mesh views (data/nodes/
// *.mesh.json). This is how a peer's benchmarks reach network.json/bests.json
// even when that peer isn't itself running the bootstrap reporter — any
// founder that saw it on the DHT carries its signed proof forward. The same
// physical node's result can appear in multiple reporters' mesh views (and in
// its own self-report); buildProofOutputs dedupes by (node_did, resource_type,
// model) after verification so it is never double-counted.
function collectMeshSignedResults(meshViews) {
  const entries = [];
  for (const view of meshViews) {
    if (!view || !Array.isArray(view.nodes)) continue;
    for (const n of view.nodes) {
      if (!n || !n.proof_snapshot) continue;
      entries.push({ name: null, proof_snapshot: n.proof_snapshot });
    }
  }
  return collectSignedResultsFrom(entries);
}

// dedupeVerified keeps one verified result per (node_did, resource_type,
// model) — the one with the newest result.ts — so a benchmark seen via the
// node's own self-report AND via one or more reporters' mesh views (DHT
// republication) is only ever counted once in aggregate/best.
function dedupeVerified(verified) {
  const byKey = new Map();
  for (const item of verified) {
    const r = item.signed_result.result;
    const key = `${r.node_did}|${item.resource_type}|${item.model || ''}`;
    const existing = byKey.get(key);
    if (!existing || (Number(r.ts) || 0) > (Number(existing.signed_result.result.ts) || 0)) {
      byKey.set(key, item);
    }
  }
  return [...byKey.values()];
}

function bestRecord(candidate, verification) {
  const r = candidate.signed_result.result;
  return {
    status: 'signed',
    resource_type: candidate.resource_type,
    model: candidate.model || undefined,
    metric: r.metric,
    value: r.value,
    unit: r.unit,
    node_did: r.node_did,
    node_name: candidate.node_name,
    ts: r.ts,
    verification: verification.reason,
    payload_sha256: verification.payload_sha256,
    signature: candidate.signed_result.signature,
    hash: candidate.signed_result.hash,
    // The signed bytes, carried through so a READER can verify this record
    // instead of taking our word that we did. Everything needed is now in the
    // published file: these bytes, the signature over them, and the ed25519
    // public key embedded in node_did. Absent when the producing node did not
    // publish its signing payload — in which case a consumer must show the
    // record as unverifiable rather than reconstructing the bytes (see
    // verifySignedResult).
    signing_payload_b64: verification.payload_b64 || undefined,
    signed_result: candidate.signed_result,
  };
}

function emptyAggregate(resourceType) {
  return {
    resource_type: resourceType,
    status: COMMISSIONING_STATUS,
    label: 'configured, not-yet-benchmarked',
    aggregate: null,
    sample_count: 0,
  };
}

export function buildProofOutputs(nodes, generatedAt = new Date().toISOString(), meshViews = []) {
  const verified = [];
  const rejected = [];
  const candidates = [...collectSignedResults(nodes), ...collectMeshSignedResults(meshViews)];
  for (const candidate of candidates) {
    const verification = verifySignedResult(candidate.signed_result, candidate.payload_b64);
    if (verification.ok) {
      verified.push({ ...candidate, verification });
    } else {
      rejected.push({
        node_name: candidate.node_name,
        // Without the DID a rejected result cannot be attributed to the region
        // that produced it — and a region that hides its rejects proves nothing.
        node_did: candidate.signed_result?.result?.node_did || null,
        resource_type: candidate.resource_type,
        model: candidate.model,
        reason: verification.reason,
      });
    }
  }

  const networkResources = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, emptyAggregate(type)]));
  const bestResources = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, marker(type)]));
  const byResource = new Map();
  for (const item of dedupeVerified(verified)) {
    if (!byResource.has(item.resource_type)) byResource.set(item.resource_type, []);
    byResource.get(item.resource_type).push(item);
  }

  for (const resourceType of RESOURCE_TYPES) {
    if (resourceType === 'inference') continue;
    const items = byResource.get(resourceType) || [];
    if (items.length === 0) continue;
    const metric = items[0].signed_result.result.metric;
    const unit = items[0].signed_result.result.unit;
    const value = items.reduce((sum, item) => sum + (Number(item.signed_result.result.value) || 0), 0);
    const best = items.reduce((top, item) => (item.signed_result.result.value > top.signed_result.result.value ? item : top), items[0]);
    networkResources[resourceType] = {
      resource_type: resourceType,
      status: 'signed',
      aggregate: {
        strategy: 'sum_of_verified_signed_results',
        metric,
        value: +value.toFixed(6),
        unit,
        sample_count: items.length,
        label: 'sum of verified signed node results',
      },
      sample_count: items.length,
    };
    bestResources[resourceType] = bestRecord(best, best.verification);
  }

  const inferenceItems = byResource.get('inference') || [];
  if (inferenceItems.length > 0) {
    const aggregatesByModel = {};
    const bestsByModel = {};
    for (const item of inferenceItems) {
      const model = item.model || item.signed_result.result.extra?.model || 'unknown';
      const currentAgg = aggregatesByModel[model] || {
        strategy: 'sum_of_verified_signed_results',
        metric: item.signed_result.result.metric,
        value: 0,
        unit: item.signed_result.result.unit,
        sample_count: 0,
        label: 'sum of verified signed node results for this model',
      };
      currentAgg.value += Number(item.signed_result.result.value) || 0;
      currentAgg.sample_count += 1;
      aggregatesByModel[model] = currentAgg;
      const curBest = bestsByModel[model];
      if (!curBest || item.signed_result.result.value > curBest.signed_result.result.value) {
        bestsByModel[model] = item;
      }
    }
    for (const agg of Object.values(aggregatesByModel)) {
      agg.value = +agg.value.toFixed(6);
    }
    networkResources.inference = {
      resource_type: 'inference',
      status: 'signed',
      aggregate_by_model: aggregatesByModel,
      sample_count: inferenceItems.length,
    };
    bestResources.inference = {
      resource_type: 'inference',
      status: 'signed',
      metric: 'inference.tokens_per_sec',
      models: Object.fromEntries(
        Object.entries(bestsByModel)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([model, item]) => [model, bestRecord(item, item.verification)])
      ),
    };
  }

  return {
    network: {
      generated_at: generatedAt,
      trust_model: 'aggregate = sum of verified signed node results; unsigned or invalid results are excluded',
      node_count: nodes.length,
      activity: {
        label: 'sum of self-reported signed node results and counters',
        inferences_served: sumField(nodes, 'inferences_served'),
        tokens_served: sumField(nodes, 'tokens_served'),
        receipts_verified: sumField(nodes, 'receipts_verified'),
        proofs_issued: sumField(nodes, 'proofs_issued'),
        disputes_resolved: sumField(nodes, 'disputes_resolved'),
        peers_online: sumField(nodes, 'peers_online'),
        uptime_seconds: sumField(nodes, 'uptime_seconds'),
      },
      resources: networkResources,
      rejected_results: rejected,
    },
    bests: {
      generated_at: generatedAt,
      trust_model: 'best = highest verified single signed result, traceable to the producing node DID',
      resources: bestResources,
      rejected_results: rejected,
    },
    // Exposed so buildCommunities can attribute each verified result to the
    // region that produced it, without verifying any signature twice.
    verified: dedupeVerified(verified),
    rejected,
  };
}

// ---------------------------------------------------------------------------
// I/O (skipped entirely under test — see aggregate-founders.test.mjs).
// ---------------------------------------------------------------------------

/**
 * The last published version of a derived-but-persisted file. Absent on the very
 * first run; after that it is the prior state of the ledger. A parse failure
 * returns null rather than throwing: a corrupt ledger must not stop the network
 * from publishing today's truth, and the merge treats null as "no history".
 */
function readPublished(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Where every signed turn statement is kept. See mergeTurnArchive. */
const TURN_ARCHIVE_PATH = 'data/turns-archive.jsonl';

/**
 * The turn archive, one signed statement per line.
 *
 * Best-effort per line, like readHistory and like the daemon's own ledger reader: a
 * single unparseable line is skipped rather than fatal. An archive that refused to
 * load because one byte was corrupt would take every agent off the site with it, and
 * the line is still in the file for anyone auditing.
 */
function readTurnArchive(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Network-wide high-water marks. Same rule as a community's: replaced only by a
 * strictly greater verified value, and carrying the ts + DID of the machine that
 * proved it. Bounded by the number of resource types — seven — forever.
 *
 * rejected_results is NOT merged. It describes what happened in this run; an old
 * rejection is not a standing accusation against a node.
 */
export function mergeBests(previous, current) {
  if (!previous?.resources) return current;
  const merged = { ...current.resources };
  for (const [resourceType, held] of Object.entries(previous.resources)) {
    // Drop a type that is no longer a metered resource net, however well signed
    // its record is. The signature was always real; the CLASSIFICATION was wrong,
    // and a valid signature over a misfiled measurement does not entitle it to
    // stay on the page as capacity.
    if (!isResourceType(resourceType)) continue;
    if (held?.status !== 'signed' || typeof held.value !== 'number') continue;
    const now = merged[resourceType];
    const nowIsSigned = now?.status === 'signed' && typeof now.value === 'number';
    if (!nowIsSigned || held.value > now.value) merged[resourceType] = held;
  }
  return { ...current, resources: merged };
}

/**
 * mergeModels — the model matrix, persisted the same way communities and bests are.
 *
 * buildModels() is a snapshot: a model only appears while a node that probed it is
 * VISIBLE this run (its proof snapshot in data/nodes/ or a reporter's mesh view). But
 * a signed probe HAPPENED — the node measured a real context length, on real hardware,
 * and signed it. When that node sleeps its probe should not un-happen, exactly as a best
 * or a region does not un-happen (see mergeCommunityLedger). Without this merge, a model
 * page 404s the moment its prober goes quiet, and /inference/models/[slug] can build
 * nothing — the intermittent empty matrix.
 *
 * The merge keeps signed evidence and carries its ts/DID, so a reader judges its age.
 * Keyed by model, and by node within a model, it grows with the NETWORK, not with time.
 * rejected_results is NOT merged: it describes THIS run, not a standing accusation.
 */
function pickGreaterProof(prev, cur, field) {
  const pv = prev && typeof prev[field] === 'number' ? prev[field] : null;
  const cv = cur && typeof cur[field] === 'number' ? cur[field] : null;
  if (pv === null) return cur || null;
  if (cv === null) return prev || null;
  return cv >= pv ? cur : prev; // tie → the fresher (current) proof
}

function mergeModelCaps(prev = {}, cur = {}) {
  const out = { ...prev };
  for (const [cap, val] of Object.entries(cur)) {
    if (typeof val !== 'boolean') continue;
    if (cap === 'tools_loop_terminated') {
      // Pessimistic: if ANY run saw the loop hang, the matrix says so.
      out[cap] = out[cap] === undefined ? val : out[cap] && val;
    } else {
      // Optimistic: some node proved it. `false` from both stays false.
      out[cap] = out[cap] === true || val === true;
    }
  }
  return out;
}

function mergeOneModel(prev, cur) {
  if (!prev) return cur;

  // A node's proof snapshot is atomic, so a node that reported THIS run replaces its
  // prior entry; a node absent this run keeps its last one, whose probed_at/measured_at
  // shows its age.
  const byNode = new Map((prev.nodes || []).map((n) => [n.node_did, n]));
  for (const n of cur.nodes || []) byNode.set(n.node_did, n);
  const nodes = [...byNode.values()].sort((a, b) => (b.tokens_per_sec || 0) - (a.tokens_per_sec || 0));

  return {
    ...cur,
    provider_count: nodes.length,
    // Strictly greater PROVED value wins, carrying the DID + ts that proved it.
    effective_ctx: pickGreaterProof(prev.effective_ctx, cur.effective_ctx, 'value'),
    best_throughput: pickGreaterProof(prev.best_throughput, cur.best_throughput, 'tokens_per_sec'),
    declared: cur.declared || prev.declared || null,
    capabilities: mergeModelCaps(prev.capabilities, cur.capabilities),
    sample_count: nodes.filter((n) => typeof n.tokens_per_sec === 'number').length,
    // BATCH VARIANTS SURVIVE THEIR PROVER SLEEPING, like every other signed proof
    // in this file.
    //
    // Everything above is merged; variants were not, and `...cur` meant they came
    // from the CURRENT run alone. So a model's proved batch-serving shapes appeared
    // whenever the gram that swept them happened to be visible and silently vanished
    // when it was not — the page showing batch capacity on one refresh and none on
    // the next. That is the exact failure the surrounding merge exists to prevent:
    // a signed sweep does not un-happen because its prober went to sleep.
    variants: mergeVariants(prev.variants, cur.variants),
    nodes,
  };
}

// mergeVariants unions two variant lists, keyed by the shape that was PROVED.
//
// A variant is one (node, slots, context) operating point, so that triple is its
// identity: the same gram re-sweeping the same shape replaces its earlier figure, and
// a different shape is a different proof that stands on its own. Ties go to the newer
// timestamp, because a re-sweep is a fresh measurement of the same thing rather than a
// competing claim — this is not a high-water mark, and quietly keeping the best number
// a machine ever produced would misreport what it can do now.
function mergeVariants(prevList, curList) {
  const byShape = new Map();
  const key = (v) => `${v.node_did}|${v.slots}|${v.context_tokens}`;

  for (const v of prevList || []) {
    if (v && v.node_did) byShape.set(key(v), v);
  }
  for (const v of curList || []) {
    if (!v || !v.node_did) continue;
    const existing = byShape.get(key(v));
    if (!existing || Number(v.ts || 0) >= Number(existing.ts || 0)) {
      byShape.set(key(v), v);
    }
  }

  return [...byShape.values()].sort(
    (a, b) => (b.aggregate_tokens_per_sec || 0) - (a.aggregate_tokens_per_sec || 0),
  );
}

export function mergeModels(previous, current) {
  if (!previous?.models?.length) return current;
  const prevBySlug = new Map(previous.models.map((m) => [m.slug, m]));

  const out = [];
  const seen = new Set();
  for (const cur of current.models) {
    seen.add(cur.slug);
    out.push(mergeOneModel(prevBySlug.get(cur.slug), cur));
  }
  // Models nobody probed this run keep their signed evidence and their page.
  for (const prev of previous.models) {
    if (seen.has(prev.slug)) continue;
    out.push(prev);
  }

  out.sort((a, b) => b.provider_count - a.provider_count || a.name.localeCompare(b.name));
  return { ...current, model_count: out.length, models: out };
}

function readHistory(name) {
  const path = `${NODES_DIR}/${name}.history.jsonl`;
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function loadNodes() {
  const files = existsSync(NODES_DIR)
    ? readdirSync(NODES_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.mesh.json'))
    : [];
  const nodes = [];
  const nodeHistories = {};
  for (const f of files) {
    try {
      const n = JSON.parse(readFileSync(`${NODES_DIR}/${f}`, 'utf8'));
      const name = n.name || f.replace(/\.json$/, '');
      const history = readHistory(name);
      nodeHistories[name] = history;
      nodes.push({
        name,
        // class is self-reported by the node's own reporter script; only
        // 'founder' and 'community' are meaningful today (Task 3 widens
        // aggregation to both — previously only 'founder' was kept at all).
        class: n.class || 'community',
        domain: n.domain || null,
        online: n.online === true,
        peer_count: n.peer_count ?? null,
        peers_online: n.peers_online ?? n.peer_count ?? null,
        peers_distinct_total: n.peers_distinct_total ?? null,
        process_uptime_seconds: n.uptime_seconds ?? null, // raw, resets on restart — NOT the headline figure
        uptime_seconds: lifetimeUptimeSeconds(history), // headline figure: survives restarts
        availability_pct: availabilityPct(history),
        first_seen_at: firstSeenAt(history),
        heartbeats_recorded: history.length,
        epnd_version: n.epnd_version || null,
        inferences_served: n.inferences_served ?? 0,
        tokens_served: n.tokens_served ?? 0,
        receipts_verified: n.receipts_verified ?? 0,
        proofs_issued: n.proofs_issued ?? 0,
        disputes_resolved: n.disputes_resolved ?? 0,
        proof_snapshot: n.proof_snapshot || null,
        checked_at: n.checked_at || null,
      });
    } catch (e) {
      console.error('skip', f, e.message);
    }
  }
  return { nodes, nodeHistories };
}

// -- GRAMX ROOM TOTALS -------------------------------------------------------
//
// What a whole room did, summed from the epoch statements its grams each signed.
//
// Every rule the daemon's payment.Rollup enforces is enforced again HERE, because
// this side must not trust the reporter that collected the bytes any more than a
// browser trusts this aggregator:
//
//   verify        a statement whose signature does not check against the DID that
//                 published it is DISCARDED. A number containing unverifiable input
//                 is not a weaker proof, it is not a proof.
//   own work only a statement signed by one gram but claiming to be another's is
//                 refused, or one peer could inflate a room with grams that never ran.
//   provider only one piece of work between two grams in a room produces TWO signed
//                 statements (provider and consumer). Summing both inflates a room by
//                 exactly the volume of its own internal traffic, so the more a gramx
//                 talks to itself the busier it would look. Only the provider side --
//                 the gram that actually burned the seconds -- is counted; self is
//                 counted once.
//   coverage      omission is undetectable, so the total always ships with how many
//                 grams contributed. A bare number would imply a completeness it
//                 cannot have.
//
// The statements are carried and verified as PUBLISHED BYTES wherever possible. See
// the int64-nanosecond lesson in verifySignedResult: a payload rebuilt in JS is not
// automatically the payload that was signed.

const GRAMX_SIDE_PROVIDER = 'provider';
const GRAMX_SIDE_SELF = 'self';

/** Verifies one signed epoch statement against the DID that published it. */
export function verifyEpochStatement(statement, fromDID) {
  try {
    if (!statement || typeof statement !== 'object') {
      return { ok: false, reason: 'not an object' };
    }
    if (!statement.node_did || statement.node_did !== fromDID) {
      return { ok: false, reason: 'statement is about a different gram than the one that published it' };
    }
    const sig = signatureBuffer(statement.sig);
    if (sig.length === 0) return { ok: false, reason: 'missing signature' };

    // VERIFY THE BYTES THAT WERE SIGNED. NEVER REBUILD THEM.
    //
    // This used to reconstruct the payload by re-marshalling the fields in Go's
    // struct order, and it was wrong in a way that looked right: Go and JavaScript
    // do not render every float64 to the same string, so genuine statements were
    // refused by an ed25519 check working perfectly. Measured on live published
    // data, 17 of 19 statements failed — silently, leaving room totals that looked
    // complete and were a small arbitrary subset.
    //
    // It is the int64-nanosecond bug again, on a new record type, and the remedy is
    // the one already proven here: the daemon publishes what it signed and this
    // reads it. A statement without carried bytes is UNVERIFIABLE, which is our gap
    // to close by shipping the daemon fix everywhere — never a reason to guess.
    if (!statement.signing_payload_b64) {
      return { ok: false, reason: 'no signed bytes published with this statement' };
    }
    const payload = Buffer.from(statement.signing_payload_b64, 'base64');
    const key = publicKeyFromDID(fromDID);
    if (!verifySignature(null, payload, key, sig)) {
      return { ok: false, reason: 'signature does not verify' };
    }

    // The carried bytes are what the signature covers, so the readable fields must
    // agree with them — otherwise a valid payload could be published beside a
    // re-labelled envelope and the numbers read from the wrong one. Same guard
    // payloadMatchesResult applies to signed results.
    let decoded;
    try {
      decoded = JSON.parse(payload.toString('utf8'));
    } catch {
      return { ok: false, reason: 'carried payload is not readable JSON' };
    }
    for (const k of ['node_did', 'gramx_id', 'resource_type', 'epoch_start', 'side']) {
      if (decoded[k] !== undefined && decoded[k] !== statement[k]) {
        return { ok: false, reason: `envelope disagrees with the signed payload on ${k}` };
      }
    }
    for (const k of ['total_units', 'total_cost_uusd', 'credit_uusd']) {
      if (decoded[k] !== undefined && Number(decoded[k]) !== Number(statement[k])) {
        return { ok: false, reason: `envelope disagrees with the signed payload on ${k}` };
      }
    }

    return { ok: true, payload_b64: statement.signing_payload_b64 };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'verify failed' };
  }
}

/** Rolls verified statements into per-room, per-resource totals with coverage. */
export function buildGramxRooms(nodes, generatedAt, meshViews = []) {
  const collected = [];
  const addFrom = (source) => {
    const epochs = source && source.gramx_epochs;
    if (!epochs || typeof epochs !== 'object') return;
    for (const [room, raw] of Object.entries(epochs)) {
      const list = Array.isArray(raw) ? raw : [];
      for (const st of list) {
        collected.push({ room, fromDID: st && st.node_did, statement: st });
      }
    }
  };
  for (const n of nodes || []) addFrom(n);
  for (const view of meshViews || []) {
    for (const n of (view && view.nodes) || []) addFrom(n);
  }

  const rooms = new Map();
  const seen = new Set();
  let rejected = 0;

  let withheld = 0;

  for (const { room, fromDID, statement } of collected) {
    if (!room || !fromDID) { rejected++; continue; }

    // A PRIVATE ROOM IS NEVER NAMED IN A PUBLIC ARTIFACT.
    //
    // The daemon already strips these at the door (see api.publicStatementsOnly),
    // and this is the second lock on the same door. The rule is not "trust the
    // reporter": this file re-verifies every signature rather than trusting the
    // collector, and it must re-enforce every privacy rule for exactly the same
    // reason. A reporter running an older build, or a hand-edited node file, would
    // otherwise put a private circle's id, its members' DIDs and its hour-by-hour
    // activity into a public repository.
    //
    // Withheld, not rejected. A private statement is not a bad statement — it is a
    // good one that is none of the public's business — and counting it as a
    // verification failure would make an honest network look like it was publishing
    // forgeries.
    if (statement && statement.private === true) { withheld++; continue; }

    const v = verifyEpochStatement(statement, fromDID);
    if (!v.ok) { rejected++; continue; }

    const dedupe = fromDID + '|' + room + '|' + statement.resource_type + '|' + statement.epoch_start;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    let entry = rooms.get(room);
    if (!entry) {
      entry = { gramx_id: room, resources: new Map(), contributors: new Set(), rejected: 0 };
      rooms.set(room, entry);
    }
    entry.contributors.add(fromDID);

    const side = statement.side;
    if (side !== GRAMX_SIDE_PROVIDER && side !== GRAMX_SIDE_SELF) {
      if (side !== 'consumer') entry.rejected++;
      continue;
    }

    const rt = statement.resource_type || 'unknown';
    let acc = entry.resources.get(rt);
    if (!acc) {
      acc = {
        resource_type: rt, total_units: 0, total_cost_uusd: 0, credit_uusd: 0,
        receipt_count: 0, statements: 0, epochs: new Set(),
        first_epoch: null, last_epoch: null, signed: [],
      };
      entry.resources.set(rt, acc);
    }
    acc.total_units += Number(statement.total_units) || 0;
    acc.total_cost_uusd += Number(statement.total_cost_uusd) || 0;
    acc.credit_uusd += Number(statement.credit_uusd) || 0;
    acc.receipt_count += Number(statement.receipt_count) || 0;
    acc.statements++;
    acc.epochs.add(statement.epoch_start);
    if (acc.first_epoch === null || statement.epoch_start < acc.first_epoch) acc.first_epoch = statement.epoch_start;
    if (acc.last_epoch === null || statement.epoch_end > acc.last_epoch) acc.last_epoch = statement.epoch_end;

    // Carry the verified bytes so a BROWSER can check the same statement itself.
    // Capped: the page needs enough to show the number is real, not the archive.
    if (acc.signed.length < 24) {
      acc.signed.push({
        node_did: fromDID,
        epoch_start: statement.epoch_start,
        total_units: statement.total_units,
        total_cost_uusd: statement.total_cost_uusd,
        credit_uusd: statement.credit_uusd,
        side: statement.side,
        signature: statement.sig,
        signing_payload_b64: v.payload_b64,
      });
    }
  }

  const out = [];
  for (const entry of rooms.values()) {
    const resources = [];
    for (const acc of entry.resources.values()) {
      resources.push({
        resource_type: acc.resource_type,
        total_units: Math.round(acc.total_units * 1e6) / 1e6,
        total_cost_uusd: acc.total_cost_uusd,
        credit_uusd: acc.credit_uusd,
        receipt_count: acc.receipt_count,
        statements: acc.statements,
        epochs: acc.epochs.size,
        first_epoch: acc.first_epoch,
        last_epoch: acc.last_epoch,
        signed: acc.signed,
      });
    }
    resources.sort((a, b) => a.resource_type.localeCompare(b.resource_type));
    if (resources.length === 0) continue;
    out.push({
      gramx_id: entry.gramx_id,
      contributors: [...entry.contributors].sort(),
      contributor_count: entry.contributors.size,
      rejected: entry.rejected,
      resources,
    });
  }
  out.sort((a, b) => a.gramx_id.localeCompare(b.gramx_id));

  return {
    generated_at: generatedAt,
    room_count: out.length,
    rejected,
    // How many signed statements were withheld for being about a private room.
    // Reported as a COUNT and nothing else: a reader can see that this page is not
    // the whole network without learning anything about the rooms it is not.
    withheld_private: withheld,
    // Said in the data, not in a footnote a reader can drop: these totals are what
    // the listed grams REPORTED. A gram that never published leaves no signature to
    // notice the absence of, so this can never be read as a room's complete
    // activity -- only as its verified, attributed floor.
    coverage_note: 'totals are summed from verified provider-side statements by the listed contributors; grams that did not publish are invisible, so these are a verified floor, not a complete account',
    rooms: out,
  };
}

// WHAT THE AGENTS DID, from the digest each gram signed about its own.
//
// The same three rules the room rollup enforces, for the same reasons:
//
//   verify        a digest whose signature does not check against the DID that
//                 published it is DISCARDED, not down-weighted.
//   own work only a digest signed by one gram but claiming to be another's is refused.
//   coverage      the totals ship with how many grams contributed, because omission
//                 is undetectable and a bare number would imply completeness.
//
// There is no provider/consumer split here and there must not be one. A turn is
// taken ONCE, by one agent, on one gram — it is not a two-sided exchange the way a
// metered resource is, so there is nothing to double-count and nothing to pick a side
// of. Deduping is by (gram, agent, room, epoch), which is exactly the key the daemon
// grouped by.
//
// The resource figures here are an ATTRIBUTION of cost that data/gramx.json already
// accounts for, seen from the agent's side rather than the room's. They must never be
// added to it — that would bill the network twice for one second of compute.

/** Verifies one signed agent-turn digest against the DID that published it. */
export function verifyTurnStatement(statement, fromDID) {
  try {
    if (!statement || typeof statement !== 'object') {
      return { ok: false, reason: 'not an object' };
    }
    if (!statement.node_did || statement.node_did !== fromDID) {
      return { ok: false, reason: 'digest is about a different gram than the one that published it' };
    }
    const sig = signatureBuffer(statement.sig);
    if (sig.length === 0) return { ok: false, reason: 'missing signature' };

    // Carried bytes only. This record type has float64 fields (vcpu_seconds,
    // energy_kwh), which is precisely the shape that made re-marshalling in JS refuse
    // 17 of 19 genuine epoch statements. Rebuilding the payload here would repeat that
    // bug knowingly.
    if (!statement.signing_payload_b64) {
      return { ok: false, reason: 'no signed bytes published with this digest' };
    }
    const payload = Buffer.from(statement.signing_payload_b64, 'base64');
    const key = publicKeyFromDID(fromDID);
    if (!verifySignature(null, payload, key, sig)) {
      return { ok: false, reason: 'signature does not verify' };
    }

    let decoded;
    try {
      decoded = JSON.parse(payload.toString('utf8'));
    } catch {
      return { ok: false, reason: 'carried payload is not readable JSON' };
    }
    // The envelope must agree with the bytes the signature covers, or a valid payload
    // could be published beside a re-labelled envelope and the numbers read from the
    // wrong one.
    for (const k of ['node_did', 'persona_id', 'gramx_id', 'epoch_start']) {
      if (decoded[k] !== undefined && decoded[k] !== statement[k]) {
        return { ok: false, reason: 'envelope disagrees with the signed payload on ' + k };
      }
    }
    for (const k of ['turns', 'tool_calls', 'held', 'failed', 'gated']) {
      if (decoded[k] !== undefined && Number(decoded[k]) !== Number(statement[k])) {
        return { ok: false, reason: 'envelope disagrees with the signed payload on ' + k };
      }
    }

    return { ok: true, payload_b64: statement.signing_payload_b64 };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'verify failed' };
  }
}

/**
 * Every turn statement the daemons published this run, verified once and kept whole.
 *
 * Exposed for the same reason buildProofOutputs exposes `verified`: the turn archive
 * is extended from exactly these, and no signature is verified twice to do it.
 */
export function collectVerifiedTurnStatements(nodes, meshViews = []) {
  const collected = [];
  const addFrom = (source) => {
    const raw = source && source.agent_turns;
    if (!Array.isArray(raw)) return;
    for (const st of raw) {
      collected.push({ fromDID: st && st.node_did, statement: st });
    }
  };
  for (const n of nodes || []) addFrom(n);
  for (const view of meshViews || []) {
    for (const n of (view && view.nodes) || []) addFrom(n);
  }

  const statements = [];
  let rejected = 0;

  for (const { fromDID, statement } of collected) {
    if (!fromDID) { rejected++; continue; }

    // The daemon strips a private room's id BEFORE signing the digest, so a private
    // statement arrives here already anonymous and its work can be published safely
    // — that is the whole design. This guard is for a statement that is marked
    // private and STILL carries a room id, which can only mean an older or altered
    // signer. The work is dropped rather than the id trusted to be harmless.
    if (statement && statement.private === true && statement.gramx_id) { rejected++; continue; }

    const v = verifyTurnStatement(statement, fromDID);
    if (!v.ok) { rejected++; continue; }

    // Whole, and carrying the bytes that were signed — what the archive keeps and what
    // a browser re-checks. Carried through untouched, never rebuilt.
    statements.push({ ...statement, signing_payload_b64: v.payload_b64 });
  }

  return { statements, rejected };
}

/** Rolls verified turn digests into per-agent totals, with the rooms they worked in. */
export function buildAgentTurns(nodes, generatedAt, meshViews = []) {
  const { statements, rejected } = collectVerifiedTurnStatements(nodes, meshViews);
  return rollAgentTurns(statements, generatedAt, rejected);
}

/**
 * The roll itself, over statements that are already verified.
 *
 * Split out from collection so the SAME roll runs over one run's statements and over
 * the whole archive. That is what keeps the published totals a function of the record
 * they claim to summarise — the discipline turn_digest.go's Digest already keeps on
 * the daemon side, held one level further along the road.
 */
export function rollAgentTurns(statements, generatedAt, rejected = 0) {
  const agents = new Map();
  const seen = new Set();
  const grams = new Set();

  for (const statement of statements || []) {
    const fromDID = statement.node_did;
    const persona = statement.persona_id || 'unnamed';
    const room = statement.gramx_id || '';
    const dedupe = [fromDID, persona, room, statement.epoch_start].join('|');
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    grams.add(fromDID);

    // Keyed by (gram, agent). NOT by agent name alone: two grams may each run a
    // concierge called "evo", and merging them would invent one agent out of two and
    // attribute each gram's work to the other. An agent belongs to the gram that
    // vouches for it — that is what its DID is for.
    const key = fromDID + '|' + persona;
    let a = agents.get(key);
    if (!a) {
      a = {
        node_did: fromDID, persona_id: persona, kind: statement.kind || '',
        turns: 0, tool_calls: 0, held: 0, failed: 0, gated: 0,
        prompt_tokens: 0, output_tokens: 0,
        vcpu_seconds: 0, gpu_seconds: 0, energy_kwh: 0, carbon_grams: 0,
        rooms: new Set(), models: new Set(), tools: new Set(),
        first_epoch: null, last_epoch: null, epochs: new Set(), signed: [],
      };
      agents.set(key, a);
    }
    for (const k of ['turns', 'tool_calls', 'held', 'failed', 'gated',
      'prompt_tokens', 'output_tokens',
      'vcpu_seconds', 'gpu_seconds', 'energy_kwh', 'carbon_grams']) {
      a[k] += Number(statement[k]) || 0;
    }
    if (room) a.rooms.add(room);
    for (const m of statement.models || []) a.models.add(m);
    for (const t of statement.tools || []) a.tools.add(t);
    a.epochs.add(statement.epoch_start);
    if (a.first_epoch === null || statement.epoch_start < a.first_epoch) a.first_epoch = statement.epoch_start;
    if (a.last_epoch === null || statement.epoch_end > a.last_epoch) a.last_epoch = statement.epoch_end;

    // Carry the verified bytes so a BROWSER can check the same digest itself.
    // Capped: the page needs enough to show the number is real, not the archive —
    // and since the roll runs newest-first over data/turns-archive.jsonl, these are
    // the freshest statements. Nothing is lost by the cap: the archive keeps every
    // statement, and the totals above are summed from all of them, not from these.
    if (a.signed.length < 24) {
      a.signed.push({
        node_did: fromDID,
        epoch_start: statement.epoch_start,
        turns: statement.turns,
        held: statement.held,
        signature: statement.sig,
        signing_payload_b64: statement.signing_payload_b64,
      });
    }
  }

  const out = [];
  for (const a of agents.values()) {
    // Held rate is over the turns that HAVE an outcome, never over all turns. A
    // receipt written before the outcome field existed has none, and dividing by every
    // turn would report a settled agent as failing.
    const decided = a.held + a.failed + a.gated;
    out.push({
      node_did: a.node_did,
      persona_id: a.persona_id,
      kind: a.kind,
      turns: a.turns,
      tool_calls: a.tool_calls,
      held: a.held, failed: a.failed, gated: a.gated,
      decided,
      held_pct: decided > 0 ? +((a.held / decided) * 100).toFixed(1) : null,
      prompt_tokens: a.prompt_tokens,
      output_tokens: a.output_tokens,
      vcpu_seconds: Math.round(a.vcpu_seconds * 1e6) / 1e6,
      gpu_seconds: Math.round(a.gpu_seconds * 1e6) / 1e6,
      energy_kwh: a.energy_kwh,
      carbon_grams: Math.round(a.carbon_grams * 1e3) / 1e3,
      rooms: [...a.rooms].sort(),
      models: [...a.models].sort(),
      tools: [...a.tools].sort(),
      epochs: a.epochs.size,
      first_epoch: a.first_epoch,
      last_epoch: a.last_epoch,
      signed: a.signed,
    });
  }
  out.sort((x, y) => y.turns - x.turns || x.persona_id.localeCompare(y.persona_id));

  const totals = out.reduce((t, a) => {
    t.turns += a.turns; t.tool_calls += a.tool_calls;
    t.held += a.held; t.failed += a.failed; t.gated += a.gated;
    return t;
  }, { turns: 0, tool_calls: 0, held: 0, failed: 0, gated: 0 });
  const decided = totals.held + totals.failed + totals.gated;

  return {
    generated_at: generatedAt,
    agent_count: out.length,
    gram_count: grams.size,
    rejected,
    totals: {
      ...totals,
      decided,
      held_pct: decided > 0 ? +((totals.held / decided) * 100).toFixed(1) : null,
    },
    // Said in the data, not in a footnote a reader can drop.
    coverage_note: 'turn counts are summed from every digest the listed grams have signed about their own agents, including epochs their daemons have since aged out of the seven-day window they publish; a gram that has never published is invisible, so these are a verified floor, not a complete account. The resource figures attribute cost already accounted in data/gramx.json and must not be added to it.',
    agents: out,
  };
}

/**
 * THE TURN ARCHIVE — every statement a daemon ever signed about its agents, kept
 * because the daemon itself cannot keep them.
 *
 * turn_digest.go folds a TRAILING SEVEN DAYS and says why: "a DHT value is size-capped
 * and a ledger is not, and an unbounded digest would grow until the put silently
 * failed". That bound is right for a DHT put and wrong for a ledger. A turn that fell
 * out of the window still happened. Without this archive the site published whatever
 * the window happened to hold, so an agent's total SHRANK as its work aged, and when
 * every gram was briefly quiet the whole file went to zero agents — which is not a
 * quiet network, it is a network that forgot. data/turns.json blinked between two
 * agents and none of them roughly every quarter hour, and each site build that landed
 * on an empty one died: `output: export` refuses a dynamic route with no params and
 * reports it as a missing generateStaticParams(), which is not where the fault is.
 *
 * Merge, never regenerate — the rule bests, communities and the model matrix already
 * follow (see mergeModels, mergeCommunityLedger).
 *
 * ON ADDING, WHICH IS THE PART THAT MUST NOT BE GOT WRONG. The unit here is the signed
 * per-epoch statement, and the key is (gram, agent, room, epoch) — the same key the
 * roll dedupes on. That key is what makes adding safe: a daemon republishes the same
 * epoch on every run for a week, and each one lands exactly once, so totals can be
 * summed from the archive without billing the network many times over for one turn. A
 * gram that was offline and later backfills an old epoch has it counted, because the
 * epoch is keyed by when the work happened and not by when it was heard.
 *
 * Ordering is by epoch, oldest first: the archive is appended to far more often than
 * it is rewritten, and a stable order keeps each run's diff to the lines it actually
 * added.
 */
export function mergeTurnArchive(previous, incoming) {
  const byKey = new Map();
  const keyOf = (s) => [s.node_did, s.persona_id || 'unnamed', s.gramx_id || '', s.epoch_start].join('|');

  for (const s of previous || []) {
    if (s && s.node_did) byKey.set(keyOf(s), s);
  }
  for (const s of incoming || []) {
    if (!s || !s.node_did) continue;
    const held = byKey.get(keyOf(s));
    // The same gram's statement about the same agent in the same hour is the same
    // statement; it does not improve by being heard again. The one exception is a copy
    // that carries its signed bytes where the held one does not — the number is
    // identical, but only one of them can be checked in a reader's browser, and more
    // checkable at the same value is always the record to keep. Same rule as a best.
    if (!held || (!held.signing_payload_b64 && s.signing_payload_b64)) byKey.set(keyOf(s), s);
  }

  return [...byKey.values()].sort(
    (a, b) =>
      (Number(a.epoch_start) || 0) - (Number(b.epoch_start) || 0) ||
      String(a.node_did).localeCompare(String(b.node_did)) ||
      String(a.persona_id || '').localeCompare(String(b.persona_id || '')) ||
      String(a.gramx_id || '').localeCompare(String(b.gramx_id || ''))
  );
}

// PRIVATE WORK COUNTS, WITHOUT SAYING WHERE.
//
// Withholding private rooms entirely was an over-correction. It made a gram that
// works mostly inside private circles look idle, and a gram's weight is supposed to
// be what it earned. The distinction that was missing is between the WORK and its
// CONTEXT:
//
//   the work     how many GPU-seconds, at what cost, credited back by how much.
//                Aggregate, resource-typed, unremarkable on its own.
//   the context  which room, which members, which hour was busy. This is what a
//                competitor mines. Never published.
//
// Each gram signs ONE statement per (resource, hour) summed across EVERY private room
// it served — see payment.PrivateAggregateStatement, which explains why summing
// BEFORE signing is the part that matters: four id-less statements for one hour say
// this gram serves four private rooms, and published hourly their individual rhythms
// come back by size.
//
// Verified here like everything else, and NOT cross-checkable the way a public room's
// total is: there are no per-room statements to check it against, by design. It is a
// signed assertion by a known identity. Members of a room check their own room.

/** Verifies one signed private-work aggregate against the DID that published it. */
export function verifyPrivateAggregate(statement, fromDID) {
  try {
    if (!statement || typeof statement !== 'object') {
      return { ok: false, reason: 'not an object' };
    }
    if (!statement.node_did || statement.node_did !== fromDID) {
      return { ok: false, reason: 'aggregate is about a different gram than the one that published it' };
    }
    // A room id here means the aggregate was built by something that did not
    // understand what it is for. Refused rather than stripped: we do not know what
    // else that signer got wrong.
    if (statement.gramx_id) {
      return { ok: false, reason: 'a private aggregate must not name a room' };
    }
    const sig = signatureBuffer(statement.sig);
    if (sig.length === 0) return { ok: false, reason: 'missing signature' };
    if (!statement.signing_payload_b64) {
      return { ok: false, reason: 'no signed bytes published with this aggregate' };
    }
    const payload = Buffer.from(statement.signing_payload_b64, 'base64');
    const key = publicKeyFromDID(fromDID);
    if (!verifySignature(null, payload, key, sig)) {
      return { ok: false, reason: 'signature does not verify' };
    }
    let decoded;
    try {
      decoded = JSON.parse(payload.toString('utf8'));
    } catch {
      return { ok: false, reason: 'carried payload is not readable JSON' };
    }
    if (decoded.gramx_id) {
      return { ok: false, reason: 'the signed payload names a room' };
    }
    for (const k of ['node_did', 'resource_type', 'epoch_start', 'side']) {
      if (decoded[k] !== undefined && decoded[k] !== statement[k]) {
        return { ok: false, reason: 'envelope disagrees with the signed payload on ' + k };
      }
    }
    for (const k of ['total_units', 'total_cost_uusd', 'credit_uusd']) {
      if (decoded[k] !== undefined && Number(decoded[k]) !== Number(statement[k])) {
        return { ok: false, reason: 'envelope disagrees with the signed payload on ' + k };
      }
    }

    return { ok: true, payload_b64: statement.signing_payload_b64 };
  } catch (err) {
    return { ok: false, reason: (err && err.message) || 'verify failed' };
  }
}

/** Network-wide private work, by resource. No rooms, no members, no per-gram split. */
export function buildPrivateWork(nodes, generatedAt, meshViews = []) {
  const collected = [];
  const addFrom = (source) => {
    const raw = source && source.private_work;
    if (!Array.isArray(raw)) return;
    for (const st of raw) collected.push({ fromDID: st && st.node_did, statement: st });
  };
  for (const n of nodes || []) addFrom(n);
  for (const view of meshViews || []) {
    for (const n of (view && view.nodes) || []) addFrom(n);
  }

  const byResource = new Map();
  const grams = new Set();
  const seen = new Set();
  let rejected = 0;

  for (const { fromDID, statement } of collected) {
    if (!fromDID) { rejected++; continue; }
    const v = verifyPrivateAggregate(statement, fromDID);
    if (!v.ok) { rejected++; continue; }

    // Provider side only, exactly as the room rollup does: one piece of work between
    // two grams produces two statements, and summing both would inflate the network
    // by the volume of its own internal traffic.
    const side = statement.side;
    if (side !== 'provider' && side !== 'self') continue;

    const dedupe = [fromDID, statement.resource_type, statement.epoch_start, side].join('|');
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    grams.add(fromDID);

    const rt = statement.resource_type || 'unknown';
    let acc = byResource.get(rt);
    if (!acc) {
      acc = { resource_type: rt, total_units: 0, total_cost_uusd: 0, credit_uusd: 0, receipt_count: 0, epochs: new Set() };
      byResource.set(rt, acc);
    }
    acc.total_units += Number(statement.total_units) || 0;
    acc.total_cost_uusd += Number(statement.total_cost_uusd) || 0;
    acc.credit_uusd += Number(statement.credit_uusd) || 0;
    acc.receipt_count += Number(statement.receipt_count) || 0;
    acc.epochs.add(statement.epoch_start);
  }

  // NOT per gram. A per-gram breakdown of private work, published alongside a public
  // list of which grams belong to which region, narrows a private room to a handful
  // of machines. The count of contributing grams is published; the split between them
  // is not.
  const resources = [...byResource.values()]
    .map((a) => ({
      resource_type: a.resource_type,
      total_units: Math.round(a.total_units * 1e6) / 1e6,
      total_cost_uusd: a.total_cost_uusd,
      credit_uusd: a.credit_uusd,
      receipt_count: a.receipt_count,
      epochs: a.epochs.size,
    }))
    .sort((a, b) => a.resource_type.localeCompare(b.resource_type));

  return {
    generated_at: generatedAt,
    gram_count: grams.size,
    rejected,
    note: 'work done inside private rooms, summed across every room and every gram. No room is named, no membership is implied, and there is no per-gram split — the work is public, its context is not. Signed by each gram that did it; not cross-checkable by strangers, because the per-room statements it sums are deliberately unpublished.',
    resources,
  };
}

export function buildAggregate(nodes, nodeHistories) {
  const founders = nodes.filter((n) => n.class === 'founder');
  const community = nodes.filter((n) => n.class !== 'founder');
  // Founders first, then everyone else — grouping, not filtering (Task 3).
  const ordered = [...founders, ...community].sort((a, b) => {
    const classRank = (n) => (n.class === 'founder' ? 0 : 1);
    if (classRank(a) !== classRank(b)) return classRank(a) - classRank(b);
    return (b.domain ? 1 : 0) - (a.domain ? 1 : 0);
  });

  const tokens = sumField(nodes, 'tokens_served');

  return {
    generated_at: new Date().toISOString(),
    // Every totals/peers/network figure below is a SUM OF SELF-REPORTED
    // per-node counters. No independent/settlement-verified total exists yet
    // (see docs/NETWORK_METERING_TRUST_MODEL.md for the trusted-total design
    // gap this leaves open).
    node_count: nodes.length,
    founder_count: founders.length,
    community_count: community.length,
    full_founder_count: founders.filter((n) => n.domain).length,
    online_count: nodes.filter((n) => n.online).length,
    cloud_rate_usd_per_1m: CLOUD_RATE_USD_PER_1M,
    totals: {
      label: 'sum of self-reported node counters (all reporting nodes, not one box)',
      inferences_served: sumField(nodes, 'inferences_served'),
      tokens_served: tokens,
      displaced_cloud_usd: +((tokens / 1e6) * CLOUD_RATE_USD_PER_1M).toFixed(2),
      receipts_verified: sumField(nodes, 'receipts_verified'),
      proofs_issued: sumField(nodes, 'proofs_issued'),
      disputes_resolved: sumField(nodes, 'disputes_resolved'),
      // Lifetime uptime summed across the fleet, in node-years. Derived from
      // heartbeat history (see lifetimeUptimeSeconds), not raw process uptime.
      node_years_uptime: +(sumField(nodes, 'uptime_seconds') / 31557600).toFixed(3),
    },
    peers: {
      label: 'local self-reported peer-store counts, summed per node (not a deduplicated network total — two nodes connected to each other each count that edge once)',
      online_now: sumField(nodes, 'peers_online'),
      connected_ever: sumField(nodes, 'peers_distinct_total'),
      trend: mergePeerTrend(nodeHistories),
    },
    nodes: ordered,
  };
}

/**
 * Derives the regional/community view purely from each node's signed
 * proof_snapshot.region (community_id = IN_<pincode>, from the daemon's location
 * bench). No hardcoded region list: a community appears here the moment a node
 * reports it, and disappears when no node does.
 *
 * It reads reporters AND every peer seen on the DHT (mesh views). Reporters are
 * the handful of machines running the status reporter; peers are everyone else.
 * Reading only reporters made the map a map of our own boxes: a verified node in
 * Hyderabad was signing its placement into bootstrap-01's mesh view and never
 * appeared in a region, because it does not run our reporter. A community is a
 * fact about the network, not about who we happen to poll.
 *
 * Each community also carries the best VERIFIED signed result per resource
 * produced by a node in it — traceable to the producing DID, with the signature
 * and payload hash — plus the results that failed verification there. Evidence
 * belongs where it was produced. `verified` is the deduped set from
 * buildProofOutputs; pass it so a result is verified exactly once.
 */
/**
 * buildModels — the model matrix, from signatures rather than model cards.
 *
 * Two independent signed sources per model, answering different questions:
 *
 *   proof_snapshot.model_probes[model]   what the model CAN do on that hardware.
 *     Its payload carries effective_ctx — the context length the node PROVED by
 *     needle-in-haystack recall, not the one the card advertises — and one flag
 *     per capability, each measured by actually running it.
 *
 *   resources.inference.models[model]    how FAST it ran there, in tokens/s.
 *
 * Every signature is verified here, against the DID that produced it, before any
 * number leaves this function. A probe that fails verification is reported in
 * rejected_results and contributes nothing: it does not get to be a model card
 * with a signature-shaped hole in it.
 *
 * declared_ctx is deliberately NOT published. The DHT model ad carries a
 * bench_digest with no signature beside it, so a declared context taken from it
 * would be an unverifiable number sitting next to verified ones — exactly the
 * confusion this file exists to prevent. What a model claims about itself is its
 * author's assertion. We publish what a machine proved.
 */
/** A URL-safe slug for one model. `qwen3:0.6b` -> `qwen3-0.6b`. */
export function modelSlug(name) {
  return name.replace(/[:/]/g, '-').replace(/[^a-zA-Z0-9._-]/g, '').toLowerCase();
}

function nodeEntry(m, nodeDid) {
  if (!m.nodes.has(nodeDid)) {
    m.nodes.set(nodeDid, { node_did: nodeDid, capabilities: {} });
  }
  return m.nodes.get(nodeDid);
}

export function buildModels(nodes, generatedAt = new Date().toISOString(), meshViews = []) {
  const entries = [
    ...nodes.map((n) => ({ name: n.name, proof_snapshot: proofSnapshotOf(n) })),
    ...meshViews
      .flatMap((v) => (Array.isArray(v?.nodes) ? v.nodes : []))
      .map((n) => ({ name: n.name || null, proof_snapshot: n.proof_snapshot })),
  ];

  const byModel = new Map();
  const rejected = [];

  const upsert = (model, nodeDid) => {
    if (!byModel.has(model)) {
      byModel.set(model, {
        name: model,
        providers: new Set(),
        capabilities: {},
        effective_ctx: null,
        throughput: [],
        // Every VERIFIED batch-variant measurement across every node — one
        // per (node, slots, context) operating point. A model can carry
        // several; unlike effective_ctx/best_throughput this is never
        // reduced to a single "best" number, because the machine AND the
        // shape (slots x context) are both what a reader is choosing between.
        variants: [],
        // One entry per node that measured this model. A model matrix that averages
        // across machines hides the only thing a reader is choosing between.
        nodes: new Map(),
        declared: null,
      });
    }
    const m = byModel.get(model);
    if (nodeDid) m.providers.add(nodeDid);
    return m;
  };

  for (const { name, proof_snapshot: snap } of entries) {
    if (!snap) continue;

    const payloads = snap.model_probe_signing_payloads || {};
    for (const [model, signed] of Object.entries(snap.model_probes || {})) {
      const v = verifySignedResult(signed, payloads[model] || '');
      if (!v.ok) {
        rejected.push({
          node_name: name || null,
          node_did: signed?.result?.node_did || null,
          model,
          kind: 'probe',
          reason: v.reason,
        });
        continue;
      }
      const extra = signed.result.extra || {};
      const m = upsert(model, signed.result.node_did);

      // What the runtime DECLARED, as attested by a node's signature. Not the same
      // kind of fact as a measurement, and kept in its own field so it can never be
      // mistaken for one.
      if (!m.declared && (extra.declared_ctx || extra.declared_quantization)) {
        m.declared = {
          ctx: Number(extra.declared_ctx) || null,
          quantization: extra.declared_quantization ?? null,
          parameter_size: extra.declared_parameter_size ?? null,
          parameter_count: Number(extra.declared_parameter_count) || null,
          family: extra.declared_family ?? null,
          format: extra.declared_format ?? null,
          capabilities: extra.declared_capabilities ?? null,
          source: extra.declared_source ?? null,
          attested_by: signed.result.node_did,
        };
      }

      const node = nodeEntry(m, signed.result.node_did);
      node.effective_ctx = Number(extra.effective_ctx) || 0;
      node.runtime = extra.runtime ?? null;
      node.runtime_version = extra.runtime_version ?? null;
      node.probe_version = extra.probe_version ?? null;
      node.probe_ctx_ladder = extra.probe_ctx_ladder ?? null;
      node.probed_at = signed.result.ts;
      node.probe_payload_sha256 = v.payload_sha256;
      // A digest alone is not checkable — it is a claim about bytes the reader
      // does not have. The signature and the signed bytes travel with it so the
      // per-machine table on a model page can be verified machine by machine,
      // which is the whole point of listing machines separately.
      node.probe_signature = signed.signature;
      node.probe_signing_payload_b64 = v.payload_b64 || undefined;
      for (const cap of ['tools', 'tools_loop_terminated', 'structured_out', 'thinking', 'vision', 'audio']) {
        if (typeof extra[cap] === 'boolean') node.capabilities[cap === 'structured_out' ? 'structured_output' : cap] = extra[cap];
      }

      const ctx = Number(extra.effective_ctx) || 0;
      if (ctx > 0 && (!m.effective_ctx || ctx > m.effective_ctx.value)) {
        m.effective_ctx = {
          value: ctx,
          node_did: signed.result.node_did,
          ts: signed.result.ts,
          payload_sha256: v.payload_sha256,
          signature: signed.signature,
          signing_payload_b64: v.payload_b64 || undefined,
          probe_version: extra.probe_version ?? null,
        };
      }

      for (const cap of ['tools', 'tools_loop_terminated', 'vision', 'audio', 'thinking', 'structured_out']) {
        // `false` is a measurement too: the node ran the probe and the model
        // could not do it. Only a capability nobody probed is absent.
        //
        // The network-level flag is the OPTIMISTIC one — some node proved it — and
        // the per-node table below is where a reader sees which. That is safe for a
        // capability and dangerous for tools_loop_terminated, so that one is
        // pessimistic: if any node saw the loop hang, the matrix says so.
        if (typeof extra[cap] === 'boolean') {
          const key = cap === 'structured_out' ? 'structured_output' : cap;
          if (key === 'tools_loop_terminated') {
            m.capabilities[key] = m.capabilities[key] === undefined ? extra[cap] : m.capabilities[key] && extra[cap];
          } else if (extra[cap] || m.capabilities[key] === undefined) {
            m.capabilities[key] = extra[cap];
          }
        }
      }
    }

    const inference = snap.resources?.inference;
    const infPayloads = inference?.model_signing_payloads || {};
    for (const [model, signed] of Object.entries(inference?.models || {})) {
      const v = verifySignedResult(signed, infPayloads[model] || '');
      if (!v.ok) {
        rejected.push({
          node_name: name || null,
          node_did: signed?.result?.node_did || null,
          model,
          kind: 'throughput',
          reason: v.reason,
        });
        continue;
      }
      const m = upsert(model, signed.result.node_did);
      const extra = signed.result.extra || {};
      m.throughput.push({
        tokens_per_sec: signed.result.value,
        node_did: signed.result.node_did,
        ts: signed.result.ts,
        payload_sha256: v.payload_sha256,
        signature: signed.signature,
        signing_payload_b64: v.payload_b64 || undefined,
      });
      const node = nodeEntry(m, signed.result.node_did);
      node.tokens_per_sec = signed.result.value;
      node.sample_count = Number(extra.sample_count) || null;
      node.total_tokens = Number(extra.total_tokens) || null;
      node.total_seconds = Number(extra.total_seconds) || null;
      node.measured_at = signed.result.ts;
      node.throughput_payload_sha256 = v.payload_sha256;
      node.throughput_signature = signed.signature;
      node.throughput_signing_payload_b64 = v.payload_b64 || undefined;
    }

    // Batch variants — proved serving capacity at a specific (slots, context)
    // operating point (internal/agent.SignBatchVariant / BatchVariantCache on
    // the daemon). Verified with the SAME verifySignedResult every other
    // signed figure on this page goes through — a batch variant is not a
    // second, weaker class of "signed". One model can carry many (one per
    // node x operating point), so — unlike effective_ctx/best_throughput —
    // nothing here is reduced to a single winner.
    const variantPayloads = inference?.variant_signing_payloads || {};
    for (const [model, signedList] of Object.entries(inference?.variants || {})) {
      const payloadsForModel = variantPayloads[model] || [];
      (Array.isArray(signedList) ? signedList : []).forEach((signed, i) => {
        const v = verifySignedResult(signed, payloadsForModel[i] || '');
        if (!v.ok) {
          rejected.push({
            node_name: name || null,
            node_did: signed?.result?.node_did || null,
            model,
            kind: 'batch_variant',
            reason: v.reason,
          });
          return;
        }
        const extra = signed.result.extra || {};
        const m = upsert(model, signed.result.node_did);
        const variant = {
          slots: Number(extra.slots) || 0,
          context_tokens: Number(extra.context_tokens) || 0,
          aggregate_tokens_per_sec: signed.result.value,
          per_request_tokens_per_sec: Number(extra.per_request_tokens_per_sec) || 0,
          kv_quant: extra.kv_quant ?? null,
          per_user_kv_mib: Number(extra.per_user_kv_mib) || null,
          resident_mib: Number(extra.resident_mib) || null,
          category: extra.category ?? null,
          node_did: signed.result.node_did,
          ts: signed.result.ts,
          payload_sha256: v.payload_sha256,
          signature: signed.signature,
          signing_payload_b64: v.payload_b64 || undefined,
        };
        m.variants.push(variant);
        const node = nodeEntry(m, signed.result.node_did);
        node.variants = node.variants || [];
        node.variants.push(variant);
      });
    }
  }

  const models = [...byModel.values()]
    .map((m) => ({
      name: m.name,
      slug: modelSlug(m.name),
      provider_count: m.providers.size,
      effective_ctx: m.effective_ctx,
      declared: m.declared,
      capabilities: m.capabilities,
      best_throughput: m.throughput.reduce((top, t) => (!top || t.tokens_per_sec > top.tokens_per_sec ? t : top), null),
      sample_count: m.throughput.length,
      // Sorted by capacity (highest aggregate tok/s first), same rule as
      // best_throughput above — but never reduced to one row, since a reader
      // is choosing between machines AND between shapes (slots x context).
      variants: [...m.variants].sort((a, b) => b.aggregate_tokens_per_sec - a.aggregate_tokens_per_sec),
      nodes: [...m.nodes.values()].sort((a, b) => (b.tokens_per_sec || 0) - (a.tokens_per_sec || 0)),
    }))
    // A model nobody probed, timed, or ran a batch variant on is a name. It does
    // not appear.
    //
    // "Probed" means a signature proved SOMETHING, which is not the same as
    // "has a context length". This used to enumerate only text-shaped evidence —
    // effective_ctx, throughput, batch variants — so a model whose signed probe
    // proved a CAPABILITY and nothing else was discarded as a name. Two real
    // things fell through that hole: a speech model, which has no token context to
    // recall a needle from and no tokens/sec to report but does prove `audio`, and
    // any LLM whose capability probe passed while its context ladder failed.
    //
    // capabilities is only ever populated from a probe that VERIFIED, so a
    // non-empty map is itself signed evidence — that is why it belongs in this
    // filter and why adding it cannot let an unproven name through.
    .filter(
      (m) =>
        m.effective_ctx ||
        m.best_throughput ||
        m.variants.length > 0 ||
        Object.keys(m.capabilities).length > 0
    )
    .sort((a, b) => b.provider_count - a.provider_count || a.name.localeCompare(b.name));

  return {
    generated_at: generatedAt,
    // Says what a reader can check, not what we promise. Until this file carried
    // `signature` and `signing_payload_b64` the sentence below was true of the
    // PIPELINE and unverifiable from the ARTIFACT — a digest with nothing beside
    // it is a claim about bytes the reader does not have. Both are published now,
    // and the ed25519 public key is inside node_did, so "verify it yourself" is a
    // statement about this file rather than about our process.
    trust_model:
      'every field verified against the signature of the node that produced it, and re-verifiable by you: each signed figure carries the exact bytes the node signed (signing_payload_b64) and the signature over them, and the ed25519 public key is embedded in node_did. effective_ctx is the context length a node PROVED by recall, never the length a model card advertises',
    model_count: models.length,
    models,
    rejected_results: rejected,
  };
}

/**
 * mergeCommunityLedger — the one file in this system that is NOT derivable from
 * scratch, and the reason that is worth it.
 *
 * Everything else here is a snapshot: run the aggregator, get the current truth.
 * That is wrong for two things.
 *
 * A region. `data/nodes/<name>.mesh.json` is regenerated wholesale from the
 * reporter's live DHT view every cycle, and most nodes appear ONLY there. So the
 * moment bootstrap-01 stops seeing a peer — a reboot, a network blip — that
 * peer's community vanished from communities.json, its page 404'd, and the
 * region blinked out of existence on the strength of one machine's connectivity.
 * A region that a node once signed itself into HAPPENED. It can go quiet. It
 * cannot un-happen.
 *
 * A best. `bestRecord` picked the highest value among results VISIBLE THIS RUN.
 * When the Hyderabad node slept, the network's best CPU silently fell from 1659
 * hashes/s to 330 and we published that as the best the network had ever proved.
 * It was measured. It was signed. We threw it away because a machine went to
 * sleep. That is the opposite of what this company sells.
 *
 * So: merge, never regenerate. A community and its high-water marks persist,
 * carrying first_seen_at / last_seen_at so a reader can judge the age of the
 * evidence for themselves.
 *
 * On size, which is the reason this is a merge and not an append: the ledger is
 * keyed by community, by node within a community, and by resource within a
 * community. It grows with the NETWORK, not with TIME. Ten thousand nodes is a
 * big file; ten years of ten nodes is the same file it is today. Nothing here
 * accumulates per-run. history.jsonl remains the append-only record; this is not
 * that.
 *
 * A high-water mark is replaced only by a strictly greater VERIFIED value. It
 * always carries the ts it was measured at and the DID that signed it, so an
 * old record from a departed machine reads as exactly what it is.
 */
export function mergeCommunityLedger(previous, current) {
  const prevById = new Map((previous?.communities || []).map((c) => [c.id, c]));
  const now = current.generated_at;
  const out = [];
  const seenIds = new Set();

  for (const cur of current.communities) {
    seenIds.add(cur.id);
    const prev = prevById.get(cur.id);
    out.push(mergeOne(prev, cur, now));
  }

  // Communities nobody could see this run. They keep their evidence and their
  // page; they simply stop claiming anyone is online.
  for (const prev of prevById.values()) {
    if (seenIds.has(prev.id)) continue;
    out.push({
      ...prev,
      node_count: prev.nodes?.length || 0,
      online_count: 0,
      reporter_count: 0,
      nodes: (prev.nodes || []).map((n) => ({ ...n, online: false, visible: false })),
      rejected_results: prev.rejected_results || [],
    });
  }

  out.sort((a, b) => b.node_count - a.node_count || a.id.localeCompare(b.id));
  return { ...current, community_count: out.length, communities: out };
}

function mergeOne(prev, cur, now) {
  if (!prev) {
    return {
      ...cur,
      first_seen_at: now,
      last_seen_at: now,
      nodes: cur.nodes.map((n) => ({ ...n, first_seen_at: now, last_seen_at: now, visible: true })),
      bests: Object.fromEntries(Object.entries(cur.bests).map(([k, b]) => [k, { ...b, first_proved_at: now }])),
    };
  }

  const prevNodes = new Map((prev.nodes || []).map((n) => [n.node_did, n]));
  const nodes = [];
  const seenDids = new Set();
  for (const n of cur.nodes) {
    seenDids.add(n.node_did);
    const p = prevNodes.get(n.node_did);
    nodes.push({ ...n, first_seen_at: p?.first_seen_at || now, last_seen_at: now, visible: true });
  }
  for (const p of prevNodes.values()) {
    if (seenDids.has(p.node_did)) continue;
    // Known here, not visible now. Its last_seen_at is how a reader dates it.
    nodes.push({ ...p, online: false, visible: false });
  }

  // High-water marks. Strictly greater, and only ever from a verified result.
  //
  // With one exception, which is not a regression: the SAME measurement —
  // identical payload_sha256, so byte-for-byte the same signed record — arriving
  // with provenance the held copy lacks. Before signing_payload_b64 was carried
  // through, every held best was a value plus a digest of bytes the reader did
  // not have; a strictly-greater rule would have kept those unverifiable copies
  // forever, because re-publishing the same measurement is by definition not an
  // improvement in value. The number does not change here. What changes is
  // whether a reader can check it, and more checkable at the same value is
  // always the record to keep.
  // Carried forward only for types that are still resource nets — see mergeBests.
  const bests = Object.fromEntries(Object.entries(prev.bests || {}).filter(([type]) => isResourceType(type)));
  for (const [resourceType, candidate] of Object.entries(cur.bests)) {
    const held = bests[resourceType];
    const sameMeasurement =
      held && candidate.payload_sha256 && candidate.payload_sha256 === held.payload_sha256;
    const gainsProvenance = sameMeasurement && !!candidate.signing_payload_b64 && !held.signing_payload_b64;
    if (!held || Number(candidate.value) > Number(held.value) || gainsProvenance) {
      bests[resourceType] = { ...candidate, first_proved_at: held?.first_proved_at || now };
    }
  }

  return {
    ...cur,
    first_seen_at: prev.first_seen_at || now,
    last_seen_at: now,
    node_count: nodes.length,
    // online/verified/reporter counts describe RIGHT NOW, over visible nodes only.
    online_count: cur.online_count,
    reporter_count: cur.reporter_count,
    verified_count: nodes.filter((n) => n.confidence === 'verified').length,
    nodes,
    bests,
  };
}

export function buildCommunities(nodes, generatedAt = new Date().toISOString(), meshViews = [], verified = [], rejected = []) {
  // Union reporters with DHT-seen peers, keyed on the node DID so the same
  // machine seen twice (its own report + a reporter's mesh view) is one node.
  const byDid = new Map();
  const addNode = (entry, isReporter) => {
    const ps = entry?.proof_snapshot;
    const did = ps?.node_did;
    const region = ps?.region;
    if (!did || !region?.community_id) return;
    const existing = byDid.get(did);
    // A reporter's self-report wins over a second-hand DHT sighting: it is the
    // node speaking for itself, and it knows whether it is online.
    if (existing && !isReporter) return;
    // PRESENCE, WHEN IT IS ACTUALLY KNOWN.
    //
    // A reporter speaks for itself. A peer seen on the DHT used to be `null` —
    // "we cannot tell" — which was honest at the time, because a peer only appeared
    // in a mesh view while connected and vanished the moment it dropped. The daemon
    // now keeps away peers and reports online/last_seen for them, so a mesh sighting
    // carries real presence and `null` is reserved for a reporter on an older build
    // that genuinely says nothing.
    const meshKnows = !isReporter && entry.online !== undefined;
    byDid.set(did, {
      did,
      name: entry.name || null,
      online: isReporter ? entry.online === true : meshKnows ? entry.online !== false : null,
      last_seen: entry.last_seen || null,
      reporter: isReporter,
      region,
    });
  };
  for (const n of nodes) addNode(n, true);
  for (const view of meshViews) {
    if (!view || !Array.isArray(view.nodes)) continue;
    for (const n of view.nodes) addNode(n, false);
  }

  // Which community produced each verified result, and each rejected one.
  const communityOfDid = new Map([...byDid.values()].map((n) => [n.did, n.region.community_id]));
  const bestsByCommunity = new Map();
  for (const item of verified) {
    const r = item.signed_result.result;
    const id = communityOfDid.get(r.node_did);
    if (!id || item.resource_type === 'inference') continue;
    if (!bestsByCommunity.has(id)) bestsByCommunity.set(id, new Map());
    const top = bestsByCommunity.get(id).get(item.resource_type);
    if (!top || Number(r.value) > Number(top.signed_result.result.value)) {
      bestsByCommunity.get(id).set(item.resource_type, item);
    }
  }
  const rejectedByCommunity = new Map();
  for (const item of rejected) {
    const id = item.node_did ? communityOfDid.get(item.node_did) : null;
    if (!id) continue;
    if (!rejectedByCommunity.has(id)) rejectedByCommunity.set(id, []);
    rejectedByCommunity.get(id).push(item);
  }

  const byId = new Map();
  for (const n of byDid.values()) {
    const region = n.region;
    const id = region.community_id;
    const cur = byId.get(id) || {
      id,
      pincode: region.pincode || '',
      city: region.city || '',
      state: region.region || '',
      country: region.country_code || '',
      node_count: 0,
      online_count: 0,
      verified_count: 0,
      reporter_count: 0,
      nodes: [],
      bests: {},
      rejected_results: [],
    };
    cur.pincode = cur.pincode || region.pincode || '';
    cur.city = cur.city || region.city || '';
    cur.state = cur.state || region.region || '';
    cur.country = cur.country || region.country_code || '';
    cur.node_count += 1;
    // online is only known for reporters. A peer we saw on the DHT is not
    // counted online, because nobody asked it.
    if (n.online === true) cur.online_count += 1;
    if (n.reporter) cur.reporter_count += 1;
    if (region.confidence === 'verified') cur.verified_count += 1;
    cur.nodes.push({
      name: n.name,
      node_did: n.did,
      confidence: region.confidence || 'unknown',
      score: typeof region.score === 'number' ? region.score : null,
      online: n.online,
      reporter: n.reporter,
    });
    byId.set(id, cur);
  }

  for (const [id, community] of byId) {
    const bests = bestsByCommunity.get(id);
    if (bests) {
      for (const [resourceType, item] of bests) {
        community.bests[resourceType] = bestRecord(item, item.verification);
      }
    }
    community.rejected_results = rejectedByCommunity.get(id) || [];
  }

  const communities = [...byId.values()].sort(
    (a, b) => b.node_count - a.node_count || a.id.localeCompare(b.id)
  );
  return {
    generated_at: generatedAt,
    label:
      'communities derived from signed node proof_snapshot.region (community_id = IN_<pincode>); reporters and DHT-seen peers alike; bests are the highest verified signed result produced in that community',
    community_count: communities.length,
    communities,
  };
}

function meshNum(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// loadMeshViews reads the per-reporter *.mesh.json files (each a node's DHT-known
// view of the network: peers + resource capacity + model benchmarks).
function loadMeshViews() {
  const files = existsSync(NODES_DIR)
    ? readdirSync(NODES_DIR).filter((f) => f.endsWith('.mesh.json'))
    : [];
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(readFileSync(`${NODES_DIR}/${f}`, 'utf8')));
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

// Rough FP16 TFLOP/s per node by GPU class (order-of-magnitude estimate only) —
// enough to place the network on a TOP500 scale, clearly labelled as an estimate.
const GPU_TFLOPS = { nvidia: 80, amd: 45, apple: 15, intel: 4, none: 0 };
// Published TOP500 reference figures (HPL/LINPACK Rmax) from the official list.
// There is no free JSON API, so these are transcribed from top500.org and must
// be bumped when a new list ships. Attributed + disclaimed below; our own number
// is an independent estimate, not a TOP500 result.
// Source: https://top500.org/lists/top500/2024/11/ (November 2024, 64th list):
//   #1 El Capitan 1.742 EFlop/s · #500 entry 2.31 PFlop/s · total 11.72 EFlop/s.
const TOP500_REF = {
  as_of: 'TOP500 November 2024 (HPL/LINPACK Rmax)',
  source: 'https://top500.org/lists/top500/2024/11/',
  rank_1: { name: 'El Capitan', pflops: 1742 },
  rank_500_pflops: 2.31,
  list_sum_pflops: 11720,
  disclaimer:
    'TOP500 figures are from the published November 2024 list (© top500.org). This project is not affiliated with, sponsored by, or endorsed by TOP500. The network figure is an independent order-of-magnitude estimate from advertised capacity — not a LINPACK measurement.',
};
function estNodeTflops(n) {
  const gpu = GPU_TFLOPS[n.gpu_class || 'none'] ?? 0;
  const cpu = (meshNum(n.vcpu_seconds) / 3600) * 0.05; // ~0.05 TFLOP/s per vCPU
  return gpu + cpu;
}

// buildMeshView unions the DHT-known nodes across every reporter's mesh view
// (by DID, keeping the richest entry) and summarizes network-wide resource
// capacity and model availability. Purely additive — never touches
// founders/network/bests.
export function buildMeshView(views, generatedAt = new Date().toISOString()) {
  const byDid = new Map();
  let reporterCount = 0;
  for (const view of views) {
    if (!view || !Array.isArray(view.nodes)) continue;
    reporterCount++;
    for (const n of view.nodes) {
      const did = n.did || n.DID;
      if (!did) continue;
      const prev = byDid.get(did);
      const nModels = Array.isArray(n.models) ? n.models.length : 0;
      const pModels = prev && Array.isArray(prev.models) ? prev.models.length : 0;
      if (!prev || nModels > pModels) byDid.set(did, n);
    }
  }
  let nodes = [...byDid.values()];
  // Ensure each node has a class field, defaulting to "community" (WP-5), and
  // normalise presence.
  //
  // ONLINE AND AWAY ARE DIFFERENT FACTS. The daemon now reports both (a peer whose
  // connection dropped is kept, marked away, with a last_seen) because deleting it
  // made the fleet look like it was constantly shedding members while every machine
  // was still running. A reporter on an older build sends neither field; those nodes
  // are treated as ONLINE, which is exactly what the old data meant — it only ever
  // contained connected peers.
  nodes = nodes.map((n) => ({
    ...n,
    class: n.class || "community",
    online: n.online === undefined ? true : !!n.online,
    last_seen: n.last_seen || null,
  }));
  const totals = {
    vram_gib: 0, ram_pool_gib: 0, vcpu_seconds: 0,
    storage_block_gib: 0, storage_object_gib: 0, egress_gbps: 0,
  };
  const onlineCount = nodes.filter((n) => n.online !== false).length;
  const models = new Map();
  // Network-wide settlement activity, summed from each node's SIGNED proof
  // snapshot (the mesh path), NOT from self-reported node files. This is how
  // inference/token/receipt counts from serving peers (who never run the
  // status reporter themselves) reach the public page — the bootstrap that
  // does report serves nothing, so without this the totals read all-zero.
  // Nodes are already deduped by DID above, so no double counting.
  const activity = {
    inferences_served: 0, tokens_served: 0, receipts_verified: 0,
    proofs_issued: 0, disputes_resolved: 0,
  };
  let estTflops = 0;
  for (const n of nodes) {
    // AN AWAY GRAM'S CAPACITY IS NOT AVAILABLE CAPACITY.
    //
    // Its VRAM, RAM, cores and egress are real, and they are on a machine nothing can
    // currently reach — summing them would advertise a network that can serve more
    // than it can. The node still APPEARS in the list, correctly marked away, because
    // "this gram exists and is asleep" is true and worth showing; what it must not do
    // is inflate what the network can do right now.
    //
    // Its historical ACTIVITY still counts: inferences served and receipts verified
    // are things that already happened, and they do not stop having happened because
    // a laptop closed.
    const present = n.online !== false;

    const pm = (n.proof_snapshot && n.proof_snapshot.metrics) || {};
    activity.inferences_served += meshNum(pm.inferences_served);
    activity.tokens_served += meshNum(pm.tokens_served);
    activity.receipts_verified += meshNum(pm.receipts_verified);
    activity.proofs_issued += meshNum(pm.proofs_issued);
    activity.disputes_resolved += meshNum(pm.disputes_resolved);

    if (!present) continue;

    estTflops += estNodeTflops(n);
    totals.vram_gib += meshNum(n.vram_gib);
    totals.ram_pool_gib += meshNum(n.ram_pool_gib);
    totals.vcpu_seconds += meshNum(n.vcpu_seconds);
    totals.storage_block_gib += meshNum(n.storage_block_gib);
    totals.storage_object_gib += meshNum(n.storage_object_gib);
    totals.egress_gbps += meshNum(n.egress_gbps);
    const nodeDid = n.did || n.DID || '';
    for (const m of n.models || []) {
      if (!m || !m.name) continue;
      const cur = models.get(m.name) || {
        name: m.name, providers: 0, total_free_slots: 0,
        best_effective_ctx: 0, best_declared_ctx: 0, max_vram_gib: 0,
        quants: new Set(), caps: {}, verified: false, provider_dids: new Set(),
        tokens_per_sec_samples: [],
      };
      cur.providers++;
      cur.total_free_slots += meshNum(m.free_slots);
      cur.best_effective_ctx = Math.max(cur.best_effective_ctx, meshNum(m.effective_ctx));
      cur.best_declared_ctx = Math.max(cur.best_declared_ctx, meshNum(m.ctx));
      cur.max_vram_gib = Math.max(cur.max_vram_gib, meshNum(m.vram_needed_gib));
      if (m.quant) cur.quants.add(m.quant);
      if (meshNum(m.tokens_per_sec) > 0) cur.tokens_per_sec_samples.push(meshNum(m.tokens_per_sec));
      // Capability provenance (EP&N foundation: declared vs measured). A measured
      // (node-signed) capability outranks a merely declared one.
      const measured = m.measured_caps || {};
      const declared = m.declared_caps || {};
      for (const k of ['tools', 'vision', 'audio', 'embedding', 'thinking', 'structured_output']) {
        if (measured[k]) cur.caps[k] = 'measured';
        else if (declared[k] && cur.caps[k] !== 'measured') cur.caps[k] = 'declared';
      }
      if (m.bench_digest) cur.verified = true; // a signed benchmark backs this model somewhere
      if (nodeDid) cur.provider_dids.add(nodeDid);
      models.set(m.name, cur);
    }
  }
  for (const k of Object.keys(totals)) totals[k] = +totals[k].toFixed(3);
  activity.displaced_cloud_usd = +((activity.tokens_served / 1e6) * CLOUD_RATE_USD_PER_1M).toFixed(2);
  activity.label = 'sum of signed per-node proof-snapshot counters across the DHT-known network';
  const estPflops = +(estTflops / 1000).toFixed(4);
  const top500 = {
    as_of: TOP500_REF.as_of,
    source: TOP500_REF.source,
    est_network_tflops: +estTflops.toFixed(2),
    est_network_pflops: estPflops,
    pct_of_rank_1: +((estPflops / TOP500_REF.rank_1.pflops) * 100).toFixed(4),
    pct_of_list_sum: +((estPflops / TOP500_REF.list_sum_pflops) * 100).toFixed(4),
    would_enter_top500: estPflops >= TOP500_REF.rank_500_pflops,
    rank_1: TOP500_REF.rank_1,
    rank_500_pflops: TOP500_REF.rank_500_pflops,
    list_sum_pflops: TOP500_REF.list_sum_pflops,
    disclaimer: TOP500_REF.disclaimer,
  };
  return {
    generated_at: generatedAt,
    label: 'DHT-known network, unioned across founder mesh reports',
    reporter_count: reporterCount,
    node_count: nodes.length,
    // Presence, published rather than inferred. node_count is every gram this
    // network knows; online_count is how many can be reached right now. A reader
    // showing only the first would repeat the mistake this whole change fixes.
    online_count: onlineCount,
    away_count: nodes.length - onlineCount,
    totals,
    activity,
    capacity: {
      vram_gib: totals.vram_gib,
      vcpu_seconds: totals.vcpu_seconds,
      est_tflops: +estTflops.toFixed(2),
      est_pflops: estPflops,
    },
    top500,
    models: [...models.values()]
      .map((m) => ({
        name: m.name,
        providers: m.providers,
        provider_count: m.provider_dids.size,
        total_free_slots: m.total_free_slots,
        best_effective_ctx: m.best_effective_ctx,
        best_declared_ctx: m.best_declared_ctx,
        max_vram_gib: +m.max_vram_gib.toFixed(2),
        quants: [...m.quants],
        caps: m.caps, // { tools: 'measured'|'declared', vision: ..., ... }
        verified: m.verified,
        best_tokens_per_sec: m.tokens_per_sec_samples.length
          ? +Math.max(...m.tokens_per_sec_samples).toFixed(2)
          : undefined,
        median_tokens_per_sec: m.tokens_per_sec_samples.length
          ? +median(m.tokens_per_sec_samples).toFixed(2)
          : undefined,
      }))
      .sort((a, b) => b.providers - a.providers || b.best_effective_ctx - a.best_effective_ctx),
    nodes,
  };
}

// ---------------------------------------------------------------------------
// Backfilling the signed bytes of already-published records
// ---------------------------------------------------------------------------
//
// Every best in data/bests.json and data/communities.json is a high-water mark:
// once a machine proves a number, that record is held until something beats it.
// Those records were published before signing_payload_b64 was carried through,
// so they hold a value, a signature, and a digest of bytes the reader does not
// have — and because re-publishing the same measurement is not an improvement in
// value, they would stay unverifiable forever. Most of the published corpus is in
// that state right now.
//
// The bytes are recoverable, because a signature match IS proof of
// byte-exactness. We rebuild the canonical payload from the `signed_result` we
// already publish, then verify the node's signature against the bytes we built.
// If it verifies, those bytes are necessarily the exact bytes the node signed —
// no other string could satisfy an ed25519 signature. If it does not, we attach
// nothing and the record stays honestly marked unverifiable. There is no path
// here that publishes bytes we have not proven correct.
//
// The one hard part is `ts`: Go writes a unix NANOSECOND int64, which exceeds
// 2^53, so JSON.parse rounds it and any naive re-serialization produces a
// different string (this is exactly the bug that would make a browser verifier
// report ~19% of honest records as tampered). readPublishedExact preserves those
// digits verbatim so the rebuilt bytes can match.

const BIG_INT_SENTINEL = "\u0000bigint:";

/**
 * Reads a published JSON file, preserving integers too large for a JS double as
 * their exact digits. Without this, `ts` is silently rounded on the way in and
 * the canonical bytes can never be rebuilt.
 */
function readPublishedExact(path) {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text.replace(/:\s*(-?\d{16,})(?=\s*[,}\]])/g, `: "${BIG_INT_SENTINEL}$1"`));
  } catch {
    return null;
  }
}

/** Go's encoding/json shape for one value: object keys sorted, big ints raw. */
function goJSON(value) {
  if (typeof value === 'string' && value.startsWith(BIG_INT_SENTINEL)) {
    return value.slice(BIG_INT_SENTINEL.length);
  }
  if (Array.isArray(value)) return `[${value.map(goJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${goJSON(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Rebuilds the exact bytes bench.Result.signingPayload() produced: struct field
 * order (metric, value, unit, ts, node_did), `extra` omitted when empty, map
 * keys sorted, no whitespace.
 */
function rebuildSigningPayload(result) {
  const fields = ['metric', 'value', 'unit', 'ts', 'node_did']
    .map((k) => `${JSON.stringify(k)}:${goJSON(result[k])}`)
    .join(',');
  const extra = result.extra && Object.keys(result.extra).length > 0 ? `,"extra":${goJSON(result.extra)}` : '';
  return Buffer.from(`{${fields}${extra}}`, 'utf8');
}

/**
 * The signed bytes of one already-published best, or '' if they cannot be proven.
 *
 * `exact` is the same record read through readPublishedExact (nanosecond `ts`
 * intact); `best` is the ordinary parse that will actually be written back out.
 * The sentinel-bearing copy is used only to rebuild and verify bytes — it must
 * never reach the output document, or a rounded `ts` would be replaced by a
 * sentinel string in published JSON.
 */
/**
 * Every nanosecond `ts` that could have been rounded to the one we hold.
 *
 * A previously-published file went through JSON.stringify on a JS double, so its
 * exact digits are already gone before we ever read it — readPublishedExact
 * cannot recover what the writer discarded. But the loss is bounded and small: at
 * ~1.78e18 the gap between representable doubles is 256, so the int64 the node
 * actually signed is within ±128 of the value we hold. That is a couple of
 * hundred candidates, and a signature tells us which one is right.
 *
 * This is a search, not a guess. ed25519 over a 32-byte digest makes a false
 * positive computationally impossible, so a candidate whose signature verifies is
 * the signed value — recovered, not assumed.
 */
function candidateTimestamps(ts) {
  const base = BigInt(String(ts).replace(BIG_INT_SENTINEL, ''));
  const out = [base];
  for (let d = 1n; d <= 256n; d++) out.push(base - d, base + d);
  return out;
}

function provenBytesFor(best, exact) {
  const result = exact?.signed_result?.result || best?.signed_result?.result;
  if (!best || best.signing_payload_b64 || !result || !best.signature) return '';
  try {
    const pub = publicKeyFromDID(result.node_did);
    const sig = signatureBuffer(best.signature);
    for (const ts of candidateTimestamps(result.ts)) {
      const payload = rebuildSigningPayload({ ...result, ts: `${BIG_INT_SENTINEL}${ts}` });
      if (!verifySignature(null, payload, pub, sig)) continue;
      // The signature already proves these bytes. This additionally catches a
      // record whose published digest disagrees with its own signed payload.
      const digest = createHash('sha256').update(payload).digest('base64');
      if (best.payload_sha256 && best.payload_sha256 !== digest) return '';
      return payload.toString('base64');
    }
    return '';
  } catch {
    return '';
  }
}

function backfillOneBest(best, exact) {
  const bytes = provenBytesFor(best, exact);
  return bytes ? { ...best, signing_payload_b64: bytes } : best;
}

/** Backfills every best in a published bests.json-shaped document. */
export function backfillBests(doc, exactDoc) {
  if (!doc?.resources) return doc;
  const resources = {};
  for (const [type, best] of Object.entries(doc.resources)) {
    resources[type] = backfillOneBest(best, exactDoc?.resources?.[type]);
  }
  return { ...doc, resources };
}

/** Backfills every best in every community of a published communities.json. */
export function backfillCommunities(doc, exactDoc) {
  if (!Array.isArray(doc?.communities)) return doc;
  const exactById = new Map((exactDoc?.communities || []).map((c) => [c.id, c]));
  return {
    ...doc,
    communities: doc.communities.map((c) => {
      const exact = exactById.get(c.id);
      return {
        ...c,
        bests: Object.fromEntries(
          Object.entries(c.bests || {}).map(([t, b]) => [t, backfillOneBest(b, exact?.bests?.[t])])
        ),
      };
    }),
  };
}

function main() {
  const { nodes, nodeHistories } = loadNodes();
  const meshViews = loadMeshViews();
  const out = buildAggregate(nodes, nodeHistories);
  const proof = buildProofOutputs(nodes, out.generated_at, meshViews);
  writeFileSync('data/founders.json', JSON.stringify(out, null, 2) + '\n');
  writeFileSync('data/network.json', JSON.stringify(proof.network, null, 2) + '\n');
  // Network-wide bests are MERGED with what was last published, not
  // regenerated: a signed measurement that verified is not un-measured when the
  // machine that made it goes to sleep.
  proof.bests = mergeBests(
    backfillBests(readPublished('data/bests.json'), readPublishedExact('data/bests.json')),
    proof.bests
  );
  writeFileSync('data/bests.json', JSON.stringify(proof.bests, null, 2) + '\n');
  const mesh = buildMeshView(meshViews, out.generated_at);
  writeFileSync('data/mesh.json', JSON.stringify(mesh, null, 2) + '\n');
  // Same for the community ledger. See mergeCommunityLedger: a region that a
  // node signed itself into happened, and it cannot un-happen because one
  // reporter stopped seeing it on the DHT.
  const previousCommunities = backfillCommunities(
    readPublished('data/communities.json'),
    readPublishedExact('data/communities.json')
  );
  const communities = mergeCommunityLedger(
    previousCommunities,
    buildCommunities(out.nodes, out.generated_at, meshViews, proof.verified, proof.rejected)
  );
  writeFileSync('data/communities.json', JSON.stringify(communities, null, 2) + '\n');

  // The model matrix: what a model PROVED on real hardware, signature by signature.
  // Merge, never regenerate — a signed probe does not un-happen when its prober sleeps
  // (see mergeModels / mergeCommunityLedger). This is what stops the model matrix from
  // blinking empty and 404-ing /inference/models/[slug].
  const models = mergeModels(readPublished('data/models.json'), buildModels(out.nodes, out.generated_at, meshViews));
  writeFileSync('data/models.json', JSON.stringify(models, null, 2) + '\n');

  // What each ROOM did, from the hours its grams each signed. Verified here and
  // re-verifiable in the browser from the same carried bytes.
  const gramx = buildGramxRooms(out.nodes, out.generated_at, meshViews);

  // What each AGENT did, from the digest each gram signed about its own. A separate
  // file from gramx.json because it answers a different question - what an agent did,
  // not what a room owes - and because a reader must never be tempted to add the two
  // resource totals together.
  //
  // The archive is the record; turns.json is DERIVED from it every run, never
  // accumulated into — so the published totals stay a function of statements that were
  // verified, and an agent whose gram is asleep keeps every turn it proved. See
  // mergeTurnArchive for why the per-epoch key is what makes that safe to add up.
  const { statements: turnStatements, rejected: turnsRejected } = collectVerifiedTurnStatements(
    out.nodes,
    meshViews
  );
  const turnArchive = mergeTurnArchive(readTurnArchive(TURN_ARCHIVE_PATH), turnStatements);
  writeFileSync(
    TURN_ARCHIVE_PATH,
    turnArchive.length ? turnArchive.map((s) => JSON.stringify(s)).join('\n') + '\n' : ''
  );
  // Newest first, so the bounded `signed` sample each agent carries on the page is its
  // freshest evidence. The archive above keeps the rest, and the totals are summed
  // from all of it regardless of what the sample holds.
  //
  // `rejected` is this run's, not the archive's: it describes what arrived today, and
  // an old rejection is not a standing accusation against a gram.
  const turns = rollAgentTurns([...turnArchive].reverse(), out.generated_at, turnsRejected);
  writeFileSync('data/turns.json', JSON.stringify(turns, null, 2) + '\n');

  // Private work, counted and context-free. Folded INTO gramx.json rather than a file
  // of its own: a reader asking "what did this network do" must see both halves at
  // once, or the public rooms read as the whole of it.
  gramx.private_work = buildPrivateWork(out.nodes, out.generated_at, meshViews);
  writeFileSync('data/gramx.json', JSON.stringify(gramx, null, 2) + '\n');
  console.log('private work: grams', gramx.private_work.gram_count,
    'resources', gramx.private_work.resources.length,
    'rejected', gramx.private_work.rejected);

  // A SIZE BUDGET, CHECKED EVERY RUN.
  //
  // This directory is committed on every aggregate - today roughly every 15 minutes.
  // Measured at 3 nodes it is already 1.1 MB, of which one file (mesh.json) is 66 KB
  // and scales linearly with the network: ~22 KB per node, so ~22 MB per commit at a
  // thousand grams, and gigabytes of git objects a day. That is a repository that
  // stops being clonable, and it would arrive gradually enough that nobody notices
  // the run it became a problem.
  //
  // A warning, not a failure: the honest response to "the network grew" is to change
  // what is published, not to stop publishing. But it must be SAID, in the log of the
  // run that crossed the line, rather than discovered later from a slow clone.
  // .jsonl counts too. The turn archive is the one published file that grows with
  // TIME rather than with the network — a line per agent per hour worked, kept because
  // the daemon's digest only reaches back seven days — so it is the last file that
  // should be able to cross this line unseen.
  const publishedBytes = readdirSync('data').filter((f) => /\.jsonl?$/.test(f))
    .reduce((n, f) => n + statSync('data/' + f).size, 0);
  const perNode = mesh.node_count > 0 ? Math.round(publishedBytes / mesh.node_count) : 0;
  console.log('published bytes:', publishedBytes, '(' + perNode + '/node)');
  if (publishedBytes > PUBLISH_BUDGET_BYTES) {
    console.warn(
      '\n!! data/ is ' + (publishedBytes / 1e6).toFixed(1) + ' MB, over the '
      + (PUBLISH_BUDGET_BYTES / 1e6).toFixed(1) + ' MB budget.\n'
      + '   Most of the weight is signed payloads carried so a browser can verify\n'
      + '   offline. The network already holds every one of them. Publish a REFERENCE\n'
      + '   (node DID + record key + payload hash) and let the proof page fetch the\n'
      + '   payload from the gram that signed it - the repo becomes an index, not an\n'
      + '   archive.\n'
    );
  }
  console.log(
    'agents:', turns.agent_count, 'turns:', turns.totals.turns, 'rejected digests:', turns.rejected,
    'archived statements:', turnArchive.length, `(+${turnStatements.length} seen this run)`
  );
  console.log('mesh nodes:', mesh.node_count, 'models:', mesh.models.length, 'communities:', communities.community_count);
  console.log('gramx rooms:', gramx.room_count, 'rejected statements:', gramx.rejected);
  console.log(
    'nodes:', out.node_count,
    'founders:', out.founder_count,
    'community:', out.community_count,
    'full:', out.full_founder_count,
    'displaced $:', out.totals.displaced_cloud_usd
  );
}

// Only run the file-system side when executed directly
// (`node tools/aggregate-founders.mjs`), not when imported by the test file.
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  main();
}
