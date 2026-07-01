// Fixture-based checks for the pure functions in aggregate-founders.mjs.
// Run with: node tools/aggregate-founders.test.mjs
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  lifetimeUptimeSeconds,
  availabilityPct,
  firstSeenAt,
  sumField,
  mergePeerTrend,
  buildAggregate,
  buildProofOutputs,
  verifySignedResult,
  buildMeshView,
} from './aggregate-founders.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('ok -', name);
}

function testIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const rawPub = spki.subarray(-32);
  const peerID = Buffer.concat([Buffer.from([0x00, 0x24, 0x08, 0x01, 0x12, 0x20]), rawPub]);
  return { privateKey, did: `did:epn:${peerID.toString('hex')}` };
}

function signedResult(identity, metric, value, unit, extra = {}, ts = 1781286290) {
  const result = { metric, value, unit, ts, node_did: identity.did };
  if (Object.keys(extra).length > 0) result.extra = Object.fromEntries(Object.keys(extra).sort().map((key) => [key, extra[key]]));
  const payload = Buffer.from(JSON.stringify(result));
  return {
    envelope: {
      result,
      signature: sign(null, payload, identity.privateKey).toString('base64'),
      hash: createHash('sha256').update(payload).digest('base64'),
    },
    payloadB64: payload.toString('base64'),
  };
}

// --- lifetimeUptimeSeconds --------------------------------------------------

test('lifetime uptime sums online->online gaps within the interval cap', () => {
  const history = [
    { t: '2026-01-01T00:00:00Z', online: true },
    { t: '2026-01-01T00:15:00Z', online: true }, // +900s
    { t: '2026-01-01T00:30:00Z', online: true }, // +900s
  ];
  assert.equal(lifetimeUptimeSeconds(history), 1800);
});

test('lifetime uptime survives a restart (uptime_s resets, history does not)', () => {
  // Mirrors the real bootstrap-01 history: uptime_s drops mid-stream but the
  // node stayed online across both heartbeats either side of the restart.
  const history = [
    { t: '2026-01-01T00:00:00Z', online: true, uptime_s: 40000 },
    { t: '2026-01-01T00:15:00Z', online: true, uptime_s: 201 }, // process restarted
    { t: '2026-01-01T00:30:00Z', online: true, uptime_s: 1100 },
  ];
  assert.equal(lifetimeUptimeSeconds(history), 1800, 'restart must not zero the lifetime figure');
});

test('lifetime uptime excludes a large unobserved gap (missed heartbeats / outage)', () => {
  const history = [
    { t: '2026-01-01T00:00:00Z', online: true },
    { t: '2026-01-02T00:00:00Z', online: true }, // 24h gap — way past the 30 min cap
  ];
  assert.equal(lifetimeUptimeSeconds(history), 0, 'a day-long gap must not be credited as uptime');
});

test('lifetime uptime excludes any gap touching an offline heartbeat', () => {
  const history = [
    { t: '2026-01-01T00:00:00Z', online: true },
    { t: '2026-01-01T00:15:00Z', online: false },
    { t: '2026-01-01T00:30:00Z', online: true },
  ];
  assert.equal(lifetimeUptimeSeconds(history), 0);
});

test('lifetime uptime is order-independent (sorts by t internally)', () => {
  const history = [
    { t: '2026-01-01T00:15:00Z', online: true },
    { t: '2026-01-01T00:00:00Z', online: true },
    { t: '2026-01-01T00:30:00Z', online: true },
  ];
  assert.equal(lifetimeUptimeSeconds(history), 1800);
});

test('lifetime uptime is 0 for empty/short history', () => {
  assert.equal(lifetimeUptimeSeconds([]), 0);
  assert.equal(lifetimeUptimeSeconds([{ t: '2026-01-01T00:00:00Z', online: true }]), 0);
});

// --- availabilityPct / firstSeenAt -----------------------------------------

test('availabilityPct is heartbeat-count based, robust to time gaps', () => {
  const history = [
    { t: '2026-01-01T00:00:00Z', online: true },
    { t: '2026-01-02T00:00:00Z', online: true }, // big time gap, still just 1 more sample
    { t: '2026-01-03T00:00:00Z', online: false },
    { t: '2026-01-04T00:00:00Z', online: true },
  ];
  assert.equal(availabilityPct(history), 75);
});

test('firstSeenAt picks the earliest timestamp regardless of array order', () => {
  const history = [
    { t: '2026-01-03T00:00:00Z', online: true },
    { t: '2026-01-01T00:00:00Z', online: true },
  ];
  assert.equal(firstSeenAt(history), '2026-01-01T00:00:00Z');
});

// --- sumField ----------------------------------------------------------------

test('sumField totals across a multi-node fixture, missing fields as 0', () => {
  const nodes = [
    { inferences_served: 10 },
    { inferences_served: 5 },
    {}, // no field at all
  ];
  assert.equal(sumField(nodes, 'inferences_served'), 15);
});

// --- mergePeerTrend ----------------------------------------------------------

test('mergePeerTrend sums per-node last-known peer counts across a merged, sorted stream', () => {
  const nodeHistories = {
    a: [
      { t: '2026-01-01T00:00:00Z', peers: 2 },
      { t: '2026-01-01T00:20:00Z', peers: 3 },
    ],
    b: [
      { t: '2026-01-01T00:10:00Z', peers: 1 },
    ],
  };
  const trend = mergePeerTrend(nodeHistories, 100);
  assert.deepEqual(
    trend.map((p) => p.peers_online_total),
    [2, 3, 4] // a:2 -> b joins at 1 (a still 2 => 3) -> a updates to 3 (b still 1 => 4)
  );
});

// --- buildAggregate: Task 3 (no founder-only filter) + Task 5 (network totals) --

test('buildAggregate includes community nodes, not just founder-class (Task 3)', () => {
  const nodes = [
    { name: 'f1', class: 'founder', domain: 'f1.example.com', online: true, uptime_seconds: 100, inferences_served: 1, tokens_served: 0, receipts_verified: 0, proofs_issued: 0, disputes_resolved: 0, peers_online: 1, peers_distinct_total: 2 },
    { name: 'c1', class: 'community', domain: null, online: true, uptime_seconds: 50, inferences_served: 2, tokens_served: 0, receipts_verified: 0, proofs_issued: 0, disputes_resolved: 0, peers_online: 1, peers_distinct_total: 1 },
  ];
  const out = buildAggregate(nodes, {});
  assert.equal(out.node_count, 2);
  assert.equal(out.founder_count, 1);
  assert.equal(out.community_count, 1);
  assert.ok(out.nodes.some((n) => n.name === 'c1'), 'community node must appear in the rendered set');
  assert.equal(out.nodes[0].class, 'founder', 'founders sort first');
});

test('buildAggregate network totals sum ALL nodes, not one box (Task 5)', () => {
  const nodes = [
    { name: 'f1', class: 'founder', domain: 'f1.example.com', online: true, uptime_seconds: 100, inferences_served: 10, tokens_served: 1000, receipts_verified: 3, proofs_issued: 1, disputes_resolved: 0, peers_online: 2, peers_distinct_total: 5 },
    { name: 'c1', class: 'community', domain: null, online: true, uptime_seconds: 50, inferences_served: 4, tokens_served: 500, receipts_verified: 1, proofs_issued: 0, disputes_resolved: 0, peers_online: 1, peers_distinct_total: 2 },
  ];
  const out = buildAggregate(nodes, {});
  assert.equal(out.totals.inferences_served, 14);
  assert.equal(out.totals.tokens_served, 1500);
  assert.equal(out.totals.receipts_verified, 4);
  assert.equal(out.peers.online_now, 3);
  assert.equal(out.peers.connected_ever, 7);
  assert.match(out.totals.label, /self-reported/);
});

test('verifySignedResult validates a daemon-shaped Ed25519 signed result', () => {
  const id = testIdentity();
  const signed = signedResult(id, 'tunnel.throughput', 125, 'MB/s');
  const verification = verifySignedResult(signed.envelope, signed.payloadB64);
  assert.equal(verification.ok, true);
  assert.equal(verification.reason, 'verified');
});

test('buildProofOutputs sums verified results and picks highest verified bests per resource/model', () => {
  const a = testIdentity();
  const b = testIdentity();
  const aNetwork = signedResult(a, 'tunnel.throughput', 100, 'MB/s');
  const bNetwork = signedResult(b, 'tunnel.throughput', 200, 'MB/s');
  const badHighNetwork = signedResult(a, 'tunnel.throughput', 999, 'MB/s');
  badHighNetwork.envelope.result.value = 999.5; // tamper after signing; must not win

  const aGemma = signedResult(a, 'inference.tokens_per_sec', 6, 'tokens/s', { model: 'gemma4:e2b' });
  const bGemma = signedResult(b, 'inference.tokens_per_sec', 8, 'tokens/s', { model: 'gemma4:e2b' });
  const aLlama = signedResult(a, 'inference.tokens_per_sec', 11, 'tokens/s', { model: 'llama3.2:latest' });
  const bLlama = signedResult(b, 'inference.tokens_per_sec', 7, 'tokens/s', { model: 'llama3.2:latest' });

  const nodes = [
    {
      name: 'a',
      inferences_served: 2,
      tokens_served: 100,
      receipts_verified: 1,
      peers_online: 1,
      proof_snapshot: {
        resources: {
          network: { result: aNetwork.envelope, signing_payload_b64: aNetwork.payloadB64 },
          inference: {
            models: {
              'gemma4:e2b': aGemma.envelope,
              'llama3.2:latest': aLlama.envelope,
            },
            model_signing_payloads: {
              'gemma4:e2b': aGemma.payloadB64,
              'llama3.2:latest': aLlama.payloadB64,
            },
          },
        },
      },
    },
    {
      name: 'b',
      inferences_served: 3,
      tokens_served: 250,
      receipts_verified: 2,
      peers_online: 4,
      proof_snapshot: {
        resources: {
          network: { result: bNetwork.envelope, signing_payload_b64: bNetwork.payloadB64 },
          inference: {
            models: {
              'gemma4:e2b': bGemma.envelope,
              'llama3.2:latest': bLlama.envelope,
            },
            model_signing_payloads: {
              'gemma4:e2b': bGemma.payloadB64,
              'llama3.2:latest': bLlama.payloadB64,
            },
          },
        },
      },
    },
    {
      name: 'tampered',
      proof_snapshot: {
        resources: {
          network: { result: badHighNetwork.envelope, signing_payload_b64: badHighNetwork.payloadB64 },
        },
      },
    },
  ];

  const { network, bests } = buildProofOutputs(nodes, '2026-07-01T00:00:00Z');
  assert.equal(network.activity.inferences_served, 5);
  assert.equal(network.activity.tokens_served, 350);
  assert.equal(network.activity.receipts_verified, 3);
  assert.equal(network.activity.peers_online, 5);
  assert.equal(network.resources.network.aggregate.value, 300);
  assert.equal(network.resources.network.aggregate.sample_count, 2);
  assert.equal(bests.resources.network.value, 200);
  assert.equal(bests.resources.network.node_did, b.did);
  assert.equal(network.resources.inference.aggregate_by_model['gemma4:e2b'].value, 14);
  assert.equal(network.resources.inference.aggregate_by_model['llama3.2:latest'].value, 18);
  assert.equal(bests.resources.inference.models['gemma4:e2b'].value, 8);
  assert.equal(bests.resources.inference.models['gemma4:e2b'].node_did, b.did);
  assert.equal(bests.resources.inference.models['llama3.2:latest'].value, 11);
  assert.equal(bests.resources.inference.models['llama3.2:latest'].node_did, a.did);
  assert.equal(bests.resources.cpu.status, 'configured_not_yet_benchmarked');
  assert.equal(bests.rejected_results.length, 1);
});

test('buildMeshView unions DHT nodes by DID and summarizes resources + models', () => {
  const views = [
    { nodes: [
      { did: 'did:epn:A', vram_gib: 8, ram_pool_gib: 16, models: [{ name: 'gemma4:e2b', effective_ctx: 4096 }] },
      { did: 'did:epn:B', vram_gib: 24, models: [] },
    ] },
    { nodes: [
      // A seen again by a second reporter — the richer entry (more models) wins.
      { did: 'did:epn:A', vram_gib: 8, models: [{ name: 'gemma4:e2b', effective_ctx: 8192 }, { name: 'llama3.2', effective_ctx: 2048 }] },
      { did: 'did:epn:C', vcpu_seconds: 100, models: [{ name: 'gemma4:e2b', effective_ctx: 2048 }] },
    ] },
  ];
  const mesh = buildMeshView(views, '2026-07-01T00:00:00Z');
  assert.equal(mesh.reporter_count, 2);
  assert.equal(mesh.node_count, 3); // A, B, C distinct — A not double-counted
  assert.equal(mesh.totals.vram_gib, 32); // 8(A once) + 24(B) + 0(C)
  assert.equal(mesh.totals.vcpu_seconds, 100);
  const g = mesh.models.find((m) => m.name === 'gemma4:e2b');
  assert.equal(g.providers, 2); // A + C
  assert.equal(g.best_effective_ctx, 8192); // A's richer entry
});

console.log(`\n${passed} test(s) passed`);
