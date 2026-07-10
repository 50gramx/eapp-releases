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
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const NODES_DIR = 'data/nodes';
const CLOUD_RATE_USD_PER_1M = 10; // transparent cloud-equivalent rate for displaced-cost estimate
// The reporter timer runs every 15 minutes (report-bootstrap-status.timer).
// Used only as a cap on how long a single online->online gap between two
// heartbeats may count toward lifetime uptime (see lifetimeUptimeSeconds).
const EXPECTED_HEARTBEAT_INTERVAL_SEC = 15 * 60;
const RESOURCE_TYPES = ['network', 'inference', 'cpu', 'mem', 'storage', 'gpu', 'energy'];
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
    if (held?.status !== 'signed' || typeof held.value !== 'number') continue;
    const now = merged[resourceType];
    const nowIsSigned = now?.status === 'signed' && typeof now.value === 'number';
    if (!nowIsSigned || held.value > now.value) merged[resourceType] = held;
  }
  return { ...current, resources: merged };
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
      byModel.set(model, { name: model, providers: new Set(), capabilities: {}, effective_ctx: null, throughput: [] });
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

      const ctx = Number(extra.effective_ctx) || 0;
      if (ctx > 0 && (!m.effective_ctx || ctx > m.effective_ctx.value)) {
        m.effective_ctx = {
          value: ctx,
          node_did: signed.result.node_did,
          ts: signed.result.ts,
          payload_sha256: v.payload_sha256,
          probe_version: extra.probe_version ?? null,
        };
      }

      for (const cap of ['tools', 'vision', 'audio', 'thinking', 'structured_out']) {
        // `false` is a measurement too: the node ran the probe and the model
        // could not do it. Only a capability nobody probed is absent.
        if (typeof extra[cap] === 'boolean') {
          const key = cap === 'structured_out' ? 'structured_output' : cap;
          if (extra[cap] || m.capabilities[key] === undefined) m.capabilities[key] = extra[cap];
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
      m.throughput.push({
        tokens_per_sec: signed.result.value,
        node_did: signed.result.node_did,
        ts: signed.result.ts,
        payload_sha256: v.payload_sha256,
      });
    }
  }

  const models = [...byModel.values()]
    .map((m) => ({
      name: m.name,
      provider_count: m.providers.size,
      effective_ctx: m.effective_ctx,
      capabilities: m.capabilities,
      best_throughput: m.throughput.reduce((top, t) => (!top || t.tokens_per_sec > top.tokens_per_sec ? t : top), null),
      sample_count: m.throughput.length,
    }))
    // A model nobody probed and nobody timed is a name. It does not appear.
    .filter((m) => m.effective_ctx || m.best_throughput)
    .sort((a, b) => b.provider_count - a.provider_count || a.name.localeCompare(b.name));

  return {
    generated_at: generatedAt,
    trust_model:
      'every field verified against the signature of the node that produced it; effective_ctx is the context length a node PROVED by recall, never the length a model card advertises',
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
  const bests = { ...(prev.bests || {}) };
  for (const [resourceType, candidate] of Object.entries(cur.bests)) {
    const held = bests[resourceType];
    if (!held || Number(candidate.value) > Number(held.value)) {
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
    byDid.set(did, {
      did,
      name: entry.name || null,
      online: isReporter ? entry.online === true : null,
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
  // Ensure each node has a class field, defaulting to "community" (WP-5)
  nodes = nodes.map((n) => ({
    ...n,
    class: n.class || "community",
  }));
  const totals = {
    vram_gib: 0, ram_pool_gib: 0, vcpu_seconds: 0,
    storage_block_gib: 0, storage_object_gib: 0, egress_gbps: 0,
  };
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
    estTflops += estNodeTflops(n);
    const pm = (n.proof_snapshot && n.proof_snapshot.metrics) || {};
    activity.inferences_served += meshNum(pm.inferences_served);
    activity.tokens_served += meshNum(pm.tokens_served);
    activity.receipts_verified += meshNum(pm.receipts_verified);
    activity.proofs_issued += meshNum(pm.proofs_issued);
    activity.disputes_resolved += meshNum(pm.disputes_resolved);
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
  proof.bests = mergeBests(readPublished('data/bests.json'), proof.bests);
  writeFileSync('data/bests.json', JSON.stringify(proof.bests, null, 2) + '\n');
  const mesh = buildMeshView(meshViews, out.generated_at);
  writeFileSync('data/mesh.json', JSON.stringify(mesh, null, 2) + '\n');
  // Same for the community ledger. See mergeCommunityLedger: a region that a
  // node signed itself into happened, and it cannot un-happen because one
  // reporter stopped seeing it on the DHT.
  const previousCommunities = readPublished('data/communities.json');
  const communities = mergeCommunityLedger(
    previousCommunities,
    buildCommunities(out.nodes, out.generated_at, meshViews, proof.verified, proof.rejected)
  );
  writeFileSync('data/communities.json', JSON.stringify(communities, null, 2) + '\n');

  // The model matrix: what a model PROVED on real hardware, signature by signature.
  const models = buildModels(out.nodes, out.generated_at, meshViews);
  writeFileSync('data/models.json', JSON.stringify(models, null, 2) + '\n');
  console.log('mesh nodes:', mesh.node_count, 'models:', mesh.models.length, 'communities:', communities.community_count);
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
