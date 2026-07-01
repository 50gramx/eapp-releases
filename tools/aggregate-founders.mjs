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

function collectSignedResults(nodes) {
  const out = [];
  for (const node of nodes) {
    const resources = proofSnapshotOf(node)?.resources || {};
    const network = resources.network;
    if (network?.result) {
      out.push({
        node_name: node.name || null,
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
        node_name: node.name || null,
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
          node_name: node.name || null,
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

export function buildProofOutputs(nodes, generatedAt = new Date().toISOString()) {
  const verified = [];
  const rejected = [];
  for (const candidate of collectSignedResults(nodes)) {
    const verification = verifySignedResult(candidate.signed_result, candidate.payload_b64);
    if (verification.ok) {
      verified.push({ ...candidate, verification });
    } else {
      rejected.push({
        node_name: candidate.node_name,
        resource_type: candidate.resource_type,
        model: candidate.model,
        reason: verification.reason,
      });
    }
  }

  const networkResources = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, emptyAggregate(type)]));
  const bestResources = Object.fromEntries(RESOURCE_TYPES.map((type) => [type, marker(type)]));
  const byResource = new Map();
  for (const item of verified) {
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
  };
}

// ---------------------------------------------------------------------------
// I/O (skipped entirely under test — see aggregate-founders.test.mjs).
// ---------------------------------------------------------------------------

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
  const files = existsSync(NODES_DIR) ? readdirSync(NODES_DIR).filter((f) => f.endsWith('.json')) : [];
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

function main() {
  const { nodes, nodeHistories } = loadNodes();
  const out = buildAggregate(nodes, nodeHistories);
  const proof = buildProofOutputs(nodes, out.generated_at);
  writeFileSync('data/founders.json', JSON.stringify(out, null, 2) + '\n');
  writeFileSync('data/network.json', JSON.stringify(proof.network, null, 2) + '\n');
  writeFileSync('data/bests.json', JSON.stringify(proof.bests, null, 2) + '\n');
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
