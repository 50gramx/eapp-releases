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
  mergeCommunityLedger,
  mergeBests,
  buildCommunities,
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
      { did: 'did:epn:A', vram_gib: 8, ram_pool_gib: 16, gpu_class: 'nvidia',
        proof_snapshot: { metrics: { inferences_served: 10, tokens_served: 2_000_000, receipts_verified: 4 } },
        models: [{ name: 'gemma4:e2b', effective_ctx: 4096, vram_needed_gib: 3.1, tokens_per_sec: 6 }] },
      { did: 'did:epn:B', vram_gib: 24, gpu_class: 'amd', models: [] },
    ] },
    { nodes: [
      // A seen again by a second reporter — the richer entry (more models) wins.
      { did: 'did:epn:A', vram_gib: 8, gpu_class: 'nvidia',
        proof_snapshot: { metrics: { inferences_served: 10, tokens_served: 2_000_000, receipts_verified: 4 } },
        models: [{ name: 'gemma4:e2b', effective_ctx: 8192, vram_needed_gib: 3.1, tokens_per_sec: 6 }, { name: 'llama3.2', effective_ctx: 2048 }] },
      { did: 'did:epn:C', vcpu_seconds: 100,
        proof_snapshot: { metrics: { inferences_served: 5, tokens_served: 1_000_000, receipts_verified: 1 } },
        models: [{ name: 'gemma4:e2b', effective_ctx: 2048, vram_needed_gib: 2.4, tokens_per_sec: 9 }] },
    ] },
  ];
  const mesh = buildMeshView(views, '2026-07-01T00:00:00Z');
  assert.equal(mesh.reporter_count, 2);
  assert.equal(mesh.node_count, 3); // A, B, C distinct — A not double-counted
  assert.equal(mesh.totals.vram_gib, 32); // 8(A once) + 24(B) + 0(C)
  assert.equal(mesh.totals.vcpu_seconds, 100);
  // Network-wide activity summed from signed proof snapshots (A once + C), NOT
  // double-counting A even though two reporters saw it.
  assert.equal(mesh.activity.inferences_served, 15); // 10(A) + 5(C)
  assert.equal(mesh.activity.tokens_served, 3_000_000);
  assert.equal(mesh.activity.receipts_verified, 5);
  assert.equal(mesh.activity.displaced_cloud_usd, 30); // 3M/1e6 * $10
  const g = mesh.models.find((m) => m.name === 'gemma4:e2b');
  assert.equal(g.providers, 2); // A + C
  assert.equal(g.best_effective_ctx, 8192); // A's richer entry
  assert.equal(g.max_vram_gib, 3.1); // max(A 3.1, C 2.4)
  assert.equal(g.best_tokens_per_sec, 9); // max(A 6, C 9)
  // capacity + TOP500 comparison: 80(nvidia A) + 45(amd B) + ~0(C) TFLOP/s
  assert.equal(Math.round(mesh.capacity.est_tflops), 125);
  assert.equal(mesh.top500.would_enter_top500, false); // 0.125 PFLOP/s << #500 (2.31)
  assert.ok(mesh.top500.pct_of_rank_1 > 0);
});

test('buildProofOutputs folds in peer benchmarks from mesh views without double-counting self-reports', () => {
  const a = testIdentity(); // reports itself AND is re-seen via a mesh view
  const c = testIdentity(); // only ever seen via a mesh view (no bootstrap reporter)

  const aNetwork = signedResult(a, 'tunnel.throughput', 100, 'MB/s', {}, 1000);
  const cNetwork = signedResult(c, 'tunnel.throughput', 50, 'MB/s', {}, 1000);

  const nodes = [
    {
      name: 'a',
      proof_snapshot: {
        resources: { network: { result: aNetwork.envelope, signing_payload_b64: aNetwork.payloadB64 } },
      },
    },
  ];

  // Two reporters' mesh views both saw node A (DHT republication of the SAME
  // signed result — same ts) and node C (never self-reports).
  const meshViews = [
    { nodes: [
      { did: a.did, proof_snapshot: { resources: { network: { result: aNetwork.envelope, signing_payload_b64: aNetwork.payloadB64 } } } },
      { did: c.did, proof_snapshot: { resources: { network: { result: cNetwork.envelope, signing_payload_b64: cNetwork.payloadB64 } } } },
    ] },
    { nodes: [
      { did: a.did, proof_snapshot: { resources: { network: { result: aNetwork.envelope, signing_payload_b64: aNetwork.payloadB64 } } } },
    ] },
  ];

  const { network, bests } = buildProofOutputs(nodes, '2026-07-01T00:00:00Z', meshViews);
  // A's result appears 3 times across sources (self + 2 mesh views) but must
  // count once; C only ever appears via mesh views and must still be counted.
  assert.equal(network.resources.network.aggregate.sample_count, 2);
  assert.equal(network.resources.network.aggregate.value, 150);
  assert.equal(bests.resources.network.value, 100);
  assert.equal(bests.resources.network.node_did, a.did);
});

test('buildMeshView preserves class field and defaults community nodes (WP-5)', () => {
  const views = [
    { nodes: [
      { did: 'did:epn:founder1', class: 'founder', vram_gib: 8, models: [] },
      { did: 'did:epn:community1', vram_gib: 4, models: [] }, // no class field, should default
      { did: 'did:epn:community2', class: 'community', vram_gib: 6, models: [] },
    ] },
  ];
  const mesh = buildMeshView(views, '2026-07-01T00:00:00Z');
  assert.equal(mesh.node_count, 3);
  const founder = mesh.nodes.find((n) => n.did === 'did:epn:founder1');
  assert.equal(founder.class, 'founder');
  const comm1 = mesh.nodes.find((n) => n.did === 'did:epn:community1');
  assert.equal(comm1.class, 'community', 'nodes without explicit class must default to "community"');
  const comm2 = mesh.nodes.find((n) => n.did === 'did:epn:community2');
  assert.equal(comm2.class, 'community');
  // Verify community nodes are NOT filtered out — all three appear
  assert.equal(mesh.nodes.length, 3, 'all nodes, including community, must appear');
});

console.log(`\n${passed} test(s) passed`);

// buildCommunities: derives communities purely from node proof_snapshot.region,
// grouping by community_id with node/online/verified counts. No hardcoded list.
test('buildCommunities groups nodes by community and counts evidence', () => {
  const nodes = [
    { name: 'a', online: true, proof_snapshot: { node_did: 'did:epn:a', region: { community_id: 'IN_560045', pincode: '560045', city: 'Bengaluru', region: 'Karnataka', country_code: 'IN', confidence: 'verified' } } },
    { name: 'b', online: false, proof_snapshot: { node_did: 'did:epn:b', region: { community_id: 'IN_560045', pincode: '560045', city: 'Bengaluru', region: 'Karnataka', country_code: 'IN', confidence: 'claimed' } } },
    { name: 'c', online: true, proof_snapshot: { node_did: 'did:epn:c', region: { community_id: 'IN_110001', pincode: '110001', city: 'New Delhi', region: 'Delhi', country_code: 'IN', confidence: 'verified' } } },
    { name: 'd', online: true, proof_snapshot: {} }, // no region → excluded
  ];
  const out = buildCommunities(nodes, '2026-07-09T00:00:00Z');
  assert.equal(out.community_count, 2);
  const blr = out.communities.find((c) => c.id === 'IN_560045');
  assert.equal(blr.node_count, 2);
  assert.equal(blr.online_count, 1);
  assert.equal(blr.verified_count, 1);
  assert.equal(blr.city, 'Bengaluru');
  assert.equal(blr.pincode, '560045');
  // Most-populated community sorts first.
  assert.equal(out.communities[0].id, 'IN_560045');
  // A node with no region contributes to no community.
  assert.ok(!out.communities.some((c) => c.nodes.some((n) => n.name === 'd')));
});

// ---------------------------------------------------------------------------
// The ledger. These two tests exist because both behaviours were once wrong and
// silently so — a region blinked out when one reporter lost sight of a peer, and
// the network's best CPU fell by 5x when the machine that set it went to sleep.
// ---------------------------------------------------------------------------

test('mergeCommunityLedger keeps a community whose nodes are no longer visible', () => {
  const previous = {
    communities: [
      {
        id: 'IN_500050',
        pincode: '500050',
        city: 'Hyderabad',
        node_count: 1,
        online_count: 1,
        verified_count: 1,
        first_seen_at: '2026-07-01T00:00:00Z',
        last_seen_at: '2026-07-09T00:00:00Z',
        nodes: [{ node_did: 'did:a', confidence: 'verified', online: true, visible: true }],
        bests: { cpu: { resource_type: 'cpu', value: 1659, status: 'signed' } },
        rejected_results: [],
      },
    ],
  };
  // Today the reporter cannot see Hyderabad at all.
  const current = { generated_at: '2026-07-10T00:00:00Z', community_count: 0, communities: [] };

  const out = mergeCommunityLedger(previous, current);
  assert.equal(out.community_count, 1, 'the region must not vanish');
  const c = out.communities[0];
  assert.equal(c.id, 'IN_500050');
  assert.equal(c.online_count, 0, 'nobody is online');
  assert.equal(c.nodes[0].visible, false, 'and the node says so');
  assert.equal(c.bests.cpu.value, 1659, 'what was proved there stays proved');
});

test('mergeCommunityLedger keeps the high-water mark when today is slower', () => {
  const previous = {
    communities: [
      {
        id: 'IN_400001',
        nodes: [{ node_did: 'did:a', confidence: 'claimed' }],
        bests: { cpu: { resource_type: 'cpu', value: 1659, status: 'signed' } },
        first_seen_at: '2026-07-01T00:00:00Z',
      },
    ],
  };
  const current = {
    generated_at: '2026-07-10T00:00:00Z',
    community_count: 1,
    communities: [
      {
        id: 'IN_400001',
        node_count: 1,
        online_count: 1,
        reporter_count: 1,
        verified_count: 0,
        nodes: [{ node_did: 'did:a', confidence: 'claimed', online: true }],
        bests: { cpu: { resource_type: 'cpu', value: 330, status: 'signed' } },
        rejected_results: [],
      },
    ],
  };

  const out = mergeCommunityLedger(previous, current);
  assert.equal(out.communities[0].bests.cpu.value, 1659, 'a best is a high-water mark, not the latest');
  assert.equal(out.communities[0].first_seen_at, '2026-07-01T00:00:00Z', 'first_seen_at is preserved');
});

test('mergeCommunityLedger takes a strictly greater verified result', () => {
  const previous = { communities: [{ id: 'IN_1', nodes: [], bests: { cpu: { value: 100, status: 'signed' } } }] };
  const current = {
    generated_at: 'now',
    communities: [
      { id: 'IN_1', node_count: 0, online_count: 0, reporter_count: 0, verified_count: 0, nodes: [], bests: { cpu: { value: 900, status: 'signed' } }, rejected_results: [] },
    ],
  };
  assert.equal(mergeCommunityLedger(previous, current).communities[0].bests.cpu.value, 900);
});

test('mergeBests never regresses a signed network best, and accepts a better one', () => {
  const previous = { resources: { cpu: { status: 'signed', value: 1659 }, gpu: { status: 'signed', value: 5 } } };
  const current = {
    resources: {
      cpu: { status: 'signed', value: 330 },
      gpu: { status: 'not-benchmarked' },
      mem: { status: 'signed', value: 2000 },
    },
  };
  const out = mergeBests(previous, current);
  assert.equal(out.resources.cpu.value, 1659, 'slower today does not overwrite the record');
  assert.equal(out.resources.gpu.value, 5, 'a signed result outranks a marker even when absent today');
  assert.equal(out.resources.mem.value, 2000, 'a resource proved for the first time appears');

  const better = mergeBests(previous, { resources: { cpu: { status: 'signed', value: 9999 } } });
  assert.equal(better.resources.cpu.value, 9999, 'a strictly greater result wins');
});

test('mergeBests on a first run passes the current bests through untouched', () => {
  const current = { resources: { cpu: { status: 'signed', value: 1 } } };
  assert.deepEqual(mergeBests(null, current), current);
});
