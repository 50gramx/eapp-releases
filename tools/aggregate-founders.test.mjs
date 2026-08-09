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
  mergeModels,
  buildCommunities,
  buildModels,
  backfillCommunities,
  buildGramxRooms,
  buildAgentTurns,
  collectVerifiedTurnStatements,
  rollAgentTurns,
  mergeTurnArchive,
  buildPrivateWork,
  verifyPrivateAggregate,
  verifyTurnStatement,
  verifyEpochStatement,
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

// ---------------------------------------------------------------------------
// The model matrix. Every number on /inference comes from here, and the whole
// argument of that page is "a model card claims 131072 and this machine proved
// 4096". An unverified probe would make that claim worthless.
// ---------------------------------------------------------------------------

test('buildModels publishes only what a signature covers', () => {
  const id = testIdentity();
  const probe = signedResult(id, 'model.probe', 1.0, 'pass', {
    model: 'gemma4:e2b',
    effective_ctx: 4096,
    probe_version: 2,
    tools: true,
    vision: true,
    audio: false,
  });
  const tps = signedResult(id, 'inference.tokens_per_sec', 8.53, 'tokens/s', { model: 'gemma4:e2b' });

  const node = {
    name: 'n1',
    proof_snapshot: {
      node_did: id.did,
      model_probes: { 'gemma4:e2b': probe.envelope },
      model_probe_signing_payloads: { 'gemma4:e2b': probe.payloadB64 },
      resources: {
        inference: {
          models: { 'gemma4:e2b': tps.envelope },
          model_signing_payloads: { 'gemma4:e2b': tps.payloadB64 },
        },
      },
    },
  };

  const out = buildModels([node], 'now');
  assert.equal(out.model_count, 1);
  const m = out.models[0];
  assert.equal(m.name, 'gemma4:e2b');
  assert.equal(m.effective_ctx.value, 4096, 'the context a node PROVED');
  assert.equal(m.effective_ctx.node_did, id.did, 'traceable to the machine that proved it');
  assert.equal(m.capabilities.tools, true);
  assert.equal(m.capabilities.audio, false, 'a failed probe is a measurement, not an absence');
  assert.equal(m.best_throughput.tokens_per_sec, 8.53);
  assert.equal(out.rejected_results.length, 0);
});

test('buildModels rejects a tampered probe instead of publishing it', () => {
  const id = testIdentity();
  const probe = signedResult(id, 'model.probe', 1.0, 'pass', { model: 'liar:1b', effective_ctx: 4096 });
  // The signature is over effective_ctx=4096. Claim 131072 instead.
  probe.envelope.result.extra.effective_ctx = 131072;

  const node = {
    name: 'n1',
    proof_snapshot: {
      node_did: id.did,
      model_probes: { 'liar:1b': probe.envelope },
      model_probe_signing_payloads: { 'liar:1b': probe.payloadB64 },
    },
  };

  const out = buildModels([node], 'now');
  assert.equal(out.model_count, 0, 'a model whose probe does not verify must not appear');
  assert.equal(out.rejected_results.length, 1);
  assert.equal(out.rejected_results[0].model, 'liar:1b');
});

test('buildModels keeps the highest PROVED context across nodes', () => {
  const a = testIdentity();
  const b = testIdentity();
  const mk = (id, ctx) => {
    const p = signedResult(id, 'model.probe', 1.0, 'pass', { model: 'm', effective_ctx: ctx });
    return {
      name: null,
      proof_snapshot: {
        node_did: id.did,
        model_probes: { m: p.envelope },
        model_probe_signing_payloads: { m: p.payloadB64 },
      },
    };
  };
  const out = buildModels([mk(a, 4096), mk(b, 32768)], 'now');
  assert.equal(out.models[0].effective_ctx.value, 32768);
  assert.equal(out.models[0].effective_ctx.node_did, b.did, 'attributed to the node that proved the larger one');
  assert.equal(out.models[0].provider_count, 2);
});

test('buildModels keeps a per-node row, and is pessimistic about a hanging tool loop', () => {
  const good = testIdentity();
  const bad = testIdentity();
  const probe = (id, terminated, ctx) => {
    const p = signedResult(id, 'model.probe', 1.0, 'pass', {
      model: 'm',
      effective_ctx: ctx,
      tools: true,
      tools_loop_terminated: terminated,
      declared_ctx: 40960,
      declared_quantization: 'Q4_K_M',
      runtime_version: '0.31.2',
    });
    return {
      name: null,
      proof_snapshot: { node_did: id.did, model_probes: { m: p.envelope }, model_probe_signing_payloads: { m: p.payloadB64 } },
    };
  };

  const out = buildModels([probe(good, true, 8192), probe(bad, false, 4096)], 'now');
  const m = out.models[0];

  // Optimistic for a capability: some node proved tools work.
  assert.equal(m.capabilities.tools, true);
  // Pessimistic for termination: one node watched the loop hang, so the matrix says so.
  assert.equal(m.capabilities.tools_loop_terminated, false, 'a hang seen anywhere must not be averaged away');

  assert.equal(m.effective_ctx.value, 8192, 'the largest context any node proved');
  assert.equal(m.nodes.length, 2, 'one row per node');
  assert.equal(m.declared.ctx, 40960);
  assert.equal(m.declared.quantization, 'Q4_K_M');
  assert.equal(m.declared.attested_by, good.did, 'a declaration is attested by the node that read it');
  assert.equal(m.slug, 'm');

  const hung = m.nodes.find((n) => n.node_did === bad.did);
  assert.equal(hung.effective_ctx, 4096, 'each node keeps its own measurement');
  assert.equal(hung.capabilities.tools_loop_terminated, false);
  assert.equal(hung.runtime_version, '0.31.2');
});

test('buildModels publishes a verified batch variant, and lets it carry a model alone', () => {
  const id = testIdentity();
  const variant = signedResult(id, 'inference.batch_tokens_per_sec', 111.2, 'tokens/s', {
    model: 'gemma4:e2b',
    slots: 4,
    context_tokens: 4096,
    per_request_tokens_per_sec: 27.5,
    kv_quant: 'q4_0',
    per_user_kv_mib: 350,
    resident_mib: 9000,
    category: 'high-throughput',
  });

  const node = {
    name: 'n1',
    proof_snapshot: {
      node_did: id.did,
      resources: {
        inference: {
          variants: { 'gemma4:e2b': [variant.envelope] },
          variant_signing_payloads: { 'gemma4:e2b': [variant.payloadB64] },
        },
      },
    },
  };

  const out = buildModels([node], 'now');
  // No effective_ctx and no best_throughput at all — a batch variant alone
  // must still be enough for the model to appear (matches the daemon side:
  // resources.inference.variants is independent of the rolling figure).
  assert.equal(out.model_count, 1, 'a batch variant alone must publish the model');
  const m = out.models[0];
  assert.equal(m.effective_ctx, null);
  assert.equal(m.best_throughput, null);
  assert.equal(m.variants.length, 1);
  const v = m.variants[0];
  assert.equal(v.slots, 4);
  assert.equal(v.context_tokens, 4096);
  assert.equal(v.aggregate_tokens_per_sec, 111.2, 'the AGGREGATE figure, not per-request');
  assert.equal(v.per_request_tokens_per_sec, 27.5);
  assert.equal(v.category, 'high-throughput');
  assert.equal(v.node_did, id.did);
  assert.ok(v.payload_sha256, 'a verified variant must carry its proof hash');

  const row = m.nodes.find((n) => n.node_did === id.did);
  assert.equal(row.variants.length, 1, 'the per-node table gets its own copy too');
  assert.equal(out.rejected_results.length, 0);
});

test('buildModels rejects a tampered batch variant instead of publishing it', () => {
  const id = testIdentity();
  const variant = signedResult(id, 'inference.batch_tokens_per_sec', 111.2, 'tokens/s', {
    model: 'liar:1b',
    slots: 4,
    context_tokens: 4096,
  });
  // Signed at 111.2 — claim 999 instead.
  variant.envelope.result.value = 999;

  const node = {
    name: 'n1',
    proof_snapshot: {
      node_did: id.did,
      resources: {
        inference: {
          variants: { 'liar:1b': [variant.envelope] },
          variant_signing_payloads: { 'liar:1b': [variant.payloadB64] },
        },
      },
    },
  };

  const out = buildModels([node], 'now');
  assert.equal(out.model_count, 0, 'a model whose only evidence is a tampered variant must not appear');
  assert.equal(out.rejected_results.length, 1);
  assert.equal(out.rejected_results[0].model, 'liar:1b');
  assert.equal(out.rejected_results[0].kind, 'batch_variant');
});

// --- backfilling the signed bytes of already-published records --------------
//
// The published corpus predates signing_payload_b64, so most bests hold a value,
// a signature, and a digest of bytes nobody has. Worse, their `ts` is a unix
// NANOSECOND int64 that already went through JSON.parse on the way into the
// previous file, so its exact digits are gone before the backfill ever sees it.
// These tests pin the two properties that make recovering those bytes safe:
// a genuine record is recovered exactly, and a record that does not verify gets
// nothing attached rather than a plausible guess.

function publishedBest(identity, { value = 41.5, ts, tamperValue = null } = {}) {
  // `ts` arrives as a STRING. A numeric literal this large is already rounded by
  // the time JavaScript finishes parsing this file, so the only way to sign over
  // the true nanosecond value is to build the payload bytes by hand — exactly the
  // asymmetry that makes this backfill necessary in the first place.
  const payload = Buffer.from(
    `{"metric":"cpu.throughput","value":${value},"unit":"hashes/s","ts":${ts},"node_did":"${identity.did}"}`
  );
  const signature = sign(null, payload, identity.privateKey).toString('base64');

  // Then round-trip through JSON exactly as a previously-published file did,
  // which is what silently destroys the low digits of ts.
  const roundTripped = JSON.parse(payload.toString('utf8'));
  if (tamperValue !== null) roundTripped.value = tamperValue;

  return {
    status: 'signed',
    resource_type: 'cpu',
    metric: 'cpu.throughput',
    value: roundTripped.value,
    unit: 'hashes/s',
    node_did: identity.did,
    ts: roundTripped.ts,
    verification: 'verified',
    payload_sha256: createHash('sha256').update(payload).digest('base64'),
    signature,
    signed_result: { result: roundTripped },
  };
}

const NANO_TS = '1784871999571592109';

test('backfillCommunities recovers signed bytes whose nanosecond ts was rounded away', () => {
  const id = testIdentity();
  // Ends in 109: not representable as a double, so JSON.parse rounds it.
  assert.notEqual(String(Number(NANO_TS)), NANO_TS, 'fixture must actually lose precision');

  const doc = { communities: [{ id: 'IN_500001', bests: { cpu: publishedBest(id, { ts: NANO_TS }) } }] };
  const out = backfillCommunities(doc, doc);
  const best = out.communities[0].bests.cpu;

  assert.ok(best.signing_payload_b64, 'the signed bytes must be recovered');

  // Recovered means recovered: the bytes carry the TRUE ts, not the rounded one,
  // and they satisfy both the signature and the published digest.
  const payload = Buffer.from(best.signing_payload_b64, 'base64');
  assert.equal(JSON.parse(payload.toString('utf8')).metric, 'cpu.throughput');
  assert.ok(payload.toString('utf8').includes(NANO_TS), 'the exact ts must be recovered');
  assert.equal(createHash('sha256').update(payload).digest('base64'), best.payload_sha256);
  assert.equal(verifySignedResult({ result: best.signed_result.result, signature: best.signature }, best.signing_payload_b64).ok, true);
});

test('backfill attaches nothing to a record whose signature does not hold', () => {
  const id = testIdentity();
  const doc = {
    communities: [
      { id: 'IN_500001', bests: { cpu: publishedBest(id, { ts: NANO_TS, tamperValue: 99999 }) } },
    ],
  };
  const out = backfillCommunities(doc, doc);

  assert.equal(
    out.communities[0].bests.cpu.signing_payload_b64,
    undefined,
    'a record that cannot be proven must stay unverifiable rather than gain invented bytes'
  );
});

test('backfill leaves a record that already carries its bytes untouched', () => {
  const id = testIdentity();
  const best = { ...publishedBest(id, { ts: NANO_TS }), signing_payload_b64: 'already-here' };
  const doc = { communities: [{ id: 'IN_500001', bests: { cpu: best } }] };

  assert.equal(backfillCommunities(doc, doc).communities[0].bests.cpu.signing_payload_b64, 'already-here');
});

console.log(`\n${passed} test(s) passed`);

// --- a type that stops being a resource net must leave the published data -----
//
// The merges are high-water marks: they hold a signed best until something beats
// it. That is right for capacity and wrong for a misclassification, because a type
// published in error is never "beaten" — no daemon produces it any more, so it
// would ride forward forever. speech_asr/speech_tts were published as resources
// once; these tests pin that they are scrubbed rather than grandfathered.

test('mergeBests drops a best whose type is no longer a resource net', () => {
  const speechBest = { status: 'signed', resource_type: 'speech_asr', value: 0.42, unit: 'ratio' };
  const merged = mergeBests(
    { resources: { cpu: { status: 'signed', value: 100, unit: 'hashes/s' }, speech_asr: speechBest } },
    { resources: { cpu: { status: 'signed', value: 90, unit: 'hashes/s' } } }
  );

  assert.equal(merged.resources.speech_asr, undefined, 'speech is not a resource net and must not be carried forward');
  assert.equal(merged.resources.cpu.value, 100, 'a real net still keeps its high-water mark');
});

test('mergeCommunityLedger drops community bests that are no longer resource nets', () => {
  const prev = {
    communities: [
      {
        id: 'IN_500001',
        bests: {
          cpu: { status: 'signed', value: 100, unit: 'hashes/s', payload_sha256: 'a' },
          speech_tts: { status: 'signed', value: 0.31, unit: 'ratio', payload_sha256: 'b' },
        },
        nodes: [],
      },
    ],
  };
  const cur = {
    community_count: 1,
    communities: [{ id: 'IN_500001', bests: {}, nodes: [], online_count: 0, reporter_count: 0 }],
  };

  const out = mergeCommunityLedger(prev, cur);
  const bests = out.communities[0].bests;
  assert.equal(bests.speech_tts, undefined, 'a retracted resource type must not survive the ledger merge');
  assert.ok(bests.cpu, 'a real net survives');
});


// --- a probe proves capability even when it proves no context ----------------
//
// The "is this a real model or just a name?" filter used to enumerate only
// text-shaped evidence: effective_ctx, throughput, batch variants. Two real cases
// fell through it — a speech model, which has no token context to recall a needle
// from and emits no tokens/sec but does prove `audio`, and any LLM whose
// capability probe passed while its context ladder failed. Both carried a VERIFIED
// signature and were discarded as names.

test('buildModels publishes a model whose only signed evidence is a capability', () => {
  const id = testIdentity();
  // A speech-probe-shaped payload: audio proved, everything else deliberately
  // absent — no effective_ctx, no tools, no vision.
  const probe = signedResult(id, 'model.probe', 1.0, 'pass', {
    model: 'moonshine',
    audio: true,
    runtime: 'speech-host',
    probe_version: 1,
    speech_role: 'asr',
    speech_realtime_factor: 0.31,
  });

  const out = buildModels([
    {
      name: 'n1',
      proof_snapshot: {
        node_did: id.did,
        model_probes: { moonshine: probe.envelope },
        model_probe_signing_payloads: { moonshine: probe.payloadB64 },
        resources: {},
      },
    },
  ], 'now');

  assert.equal(out.model_count, 1, 'a signed capability IS evidence — the model must appear');
  const m = out.models[0];
  assert.equal(m.name, 'moonshine');
  assert.equal(m.capabilities.audio, true, 'audio must be published as proved');
  assert.equal(m.effective_ctx, null, 'a speech model has no probed context and must not claim one');
  assert.equal(m.best_throughput, null, 'a speech model emits no tokens and must not claim a rate');
  // The silences survive the round trip: absent stays absent, never false.
  for (const cap of ['tools', 'vision', 'thinking', 'structured_output']) {
    assert.equal(m.capabilities[cap], undefined, `${cap} was never probed and must stay absent`);
  }
  // And it is verifiable: the signature and the exact signed bytes travel with it.
  assert.ok(m.nodes[0].probe_signature, 'the probe signature must be published');
  assert.ok(m.nodes[0].probe_signing_payload_b64, 'the signed bytes must be published');
});

test('buildModels still refuses a model with no signed evidence at all', () => {
  const out = buildModels([{ name: 'n1', proof_snapshot: { node_did: 'did:epn:x', resources: {} } }], 'now');
  assert.equal(out.model_count, 0, 'a name with nothing signed behind it is still not a model');
});

console.log(`\n${passed} test(s) passed`);

// -- GRAMX ROOM TOTALS --------------------------------------------------------

// A statement signed by the Go daemon must verify here, byte for byte. This
// fixture was produced by payment.GramxEpochStatement.Sign and pasted verbatim: if
// the JS field order or shape ever drifts from the Go struct, this fails, which is
// the only early warning that the site has started rejecting honest numbers.
const GO_SIGNED_STATEMENT = {
  node_did: "did:epn:0024080112206491c45b17f86551d4a3eba94930cc2f5123411de08b1b8a077cf2e0131e6af0",
  gramx_id: "IN_400001",
  resource_type: "gpu_second",
  epoch_start: 1785000000,
  epoch_end: 1785003600,
  total_units: 308.01785907100003,
  total_cost_uusd: 3080,
  receipt_count: 7,
  private: false,
  trust_factor: 0,
  credit_uusd: 0,
  side: "provider",
  first_at: 1785000001000000000,
  last_at: 1785003599000000000,
  generated_at: 1785003700,
  sig: "hCNrzIsXpTMU7ZHgt9BD/VL23t8Gzcp9n/OdjvavgkzMtpslXrDPB2sd75W+786Ds+ep47liIqBDp9TLZitIBg==",
  signing_payload_b64: "eyJub2RlX2RpZCI6ImRpZDplcG46MDAyNDA4MDExMjIwNjQ5MWM0NWIxN2Y4NjU1MWQ0YTNlYmE5NDkzMGNjMmY1MTIzNDExZGUwOGIxYjhhMDc3Y2YyZTAxMzFlNmFmMCIsImdyYW14X2lkIjoiSU5fNDAwMDAxIiwicmVzb3VyY2VfdHlwZSI6ImdwdV9zZWNvbmQiLCJlcG9jaF9zdGFydCI6MTc4NTAwMDAwMCwiZXBvY2hfZW5kIjoxNzg1MDAzNjAwLCJ0b3RhbF91bml0cyI6MzA4LjAxNzg1OTA3MTAwMDAzLCJ0b3RhbF9jb3N0X3V1c2QiOjMwODAsInJlY2VpcHRfY291bnQiOjcsInByaXZhdGUiOmZhbHNlLCJ0cnVzdF9mYWN0b3IiOjAsImNyZWRpdF91dXNkIjowLCJzaWRlIjoicHJvdmlkZXIiLCJmaXJzdF9hdCI6MTc4NTAwMDAwMTAwMDAwMDAwMCwibGFzdF9hdCI6MTc4NTAwMzU5OTAwMDAwMDAwMCwiZ2VuZXJhdGVkX2F0IjoxNzg1MDAzNzAwfQ=="
};

test('a statement signed by the Go daemon verifies here', () => {
  const v = verifyEpochStatement(GO_SIGNED_STATEMENT, GO_SIGNED_STATEMENT.node_did);
  assert.equal(v.ok, true, v.reason);
  assert.ok(v.payload_b64.length > 0);
});

test('a tampered total does not verify', () => {
  const tampered = { ...GO_SIGNED_STATEMENT, total_cost_uusd: 999999 };
  assert.equal(verifyEpochStatement(tampered, tampered.node_did).ok, false);
});

test('a gram may not publish a statement about another gram', () => {
  const v = verifyEpochStatement(GO_SIGNED_STATEMENT, 'did:epn:00240801122000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(v.ok, false);
});

test('one piece of work between two grams is not counted twice', () => {
  // The same work, provider side and consumer side. Only the provider is summed.
  const provider = GO_SIGNED_STATEMENT;
  const consumer = { ...GO_SIGNED_STATEMENT, side: 'consumer' };
  const out = buildGramxRooms([{ gramx_epochs: { IN_400001: [provider, consumer] } }], 'now', []);
  const room = out.rooms[0];
  assert.equal(room.resources[0].total_units, 308.017859);
  assert.equal(room.resources[0].total_cost_uusd, 3080);
});

test('unverifiable statements are rejected, not down-weighted', () => {
  const forged = { ...GO_SIGNED_STATEMENT, total_units: 99999 };
  const out = buildGramxRooms([{ gramx_epochs: { IN_400001: [GO_SIGNED_STATEMENT, forged] } }], 'now', []);
  assert.equal(out.rooms[0].resources[0].total_units, 308.017859);
  assert.equal(out.rejected, 1);
});

test('the same statement seen by two reporters counts once', () => {
  const out = buildGramxRooms(
    [{ gramx_epochs: { IN_400001: [GO_SIGNED_STATEMENT] } }],
    'now',
    [{ nodes: [{ gramx_epochs: { IN_400001: [GO_SIGNED_STATEMENT] } }] }],
  );
  assert.equal(out.rooms[0].resources[0].statements, 1);
  assert.equal(out.rooms[0].resources[0].total_units, 308.017859);
});

test('a room total ships with its coverage and the bytes to re-check it', () => {
  const out = buildGramxRooms([{ gramx_epochs: { IN_400001: [GO_SIGNED_STATEMENT] } }], 'now', []);
  const room = out.rooms[0];
  assert.equal(room.contributor_count, 1);
  assert.ok(out.coverage_note.includes('floor'));
  const signed = room.resources[0].signed[0];
  assert.ok(signed.signing_payload_b64.length > 0);
  assert.ok(signed.signature.length > 0);
});


// -- AGENT TURNS ---------------------------------------------------------------

// Produced by agent.AgentTurnStatement.Sign and pasted verbatim, exactly like
// GO_SIGNED_STATEMENT above and for the same reason: this is the only early warning
// that the site has started rejecting honest numbers.
//
// energy_kwh is deliberately the awkward float that broke the epoch statements. If
// this file ever goes back to reconstructing the payload, this fixture is what fails.
const GO_SIGNED_TURN_DIGEST = {
  node_did: "did:epn:002408011220a1a8cc5afeff04364363dab32362bd32851746d3e91003e9f2317ba776e615b7",
  persona_id: "evo",
  gramx_id: "room-a",
  kind: "concierge_turn",
  epoch_start: 1785153600,
  epoch_end: 1785157200,
  turns: 2,
  tool_calls: 2,
  held: 1,
  failed: 1,
  gated: 0,
  prompt_tokens: 0,
  output_tokens: 0,
  vcpu_seconds: 1.4,
  energy_kwh: 0.0000030337805555555625,
  models: ["gemma4:e2b"],
  tools: ["ask_specialist", "cite_fact"],
  generated_at: 1785155903,
  sig: "FkycMAvvAaTJjlHN451Y6+6gGK2Cp2ZN6E/X7o5zpQ00yHLubrYOIOkHQ9/20LpwhCz435Mv0T+qVB4TYHduBQ==",
  signing_payload_b64: "eyJub2RlX2RpZCI6ImRpZDplcG46MDAyNDA4MDExMjIwYTFhOGNjNWFmZWZmMDQzNjQzNjNkYWIzMjM2MmJkMzI4NTE3NDZkM2U5MTAwM2U5ZjIzMTdiYTc3NmU2MTViNyIsInBlcnNvbmFfaWQiOiJldm8iLCJncmFteF9pZCI6InJvb20tYSIsImtpbmQiOiJjb25jaWVyZ2VfdHVybiIsImVwb2NoX3N0YXJ0IjoxNzg1MTUzNjAwLCJlcG9jaF9lbmQiOjE3ODUxNTcyMDAsInR1cm5zIjoyLCJ0b29sX2NhbGxzIjoyLCJoZWxkIjoxLCJmYWlsZWQiOjEsImdhdGVkIjowLCJwcm9tcHRfdG9rZW5zIjowLCJvdXRwdXRfdG9rZW5zIjowLCJ2Y3B1X3NlY29uZHMiOjEuNCwiZW5lcmd5X2t3aCI6MC4wMDAwMDMwMzM3ODA1NTU1NTU1NjI1LCJtb2RlbHMiOlsiZ2VtbWE0OmUyYiJdLCJ0b29scyI6WyJhc2tfc3BlY2lhbGlzdCIsImNpdGVfZmFjdCJdLCJnZW5lcmF0ZWRfYXQiOjE3ODUxNTU5MDN9"
};

test('a turn digest signed by the Go daemon verifies here', () => {
  const v = verifyTurnStatement(GO_SIGNED_TURN_DIGEST, GO_SIGNED_TURN_DIGEST.node_did);
  assert.equal(v.ok, true, v.reason);
});

test('a tampered turn count does not verify', () => {
  const tampered = { ...GO_SIGNED_TURN_DIGEST, turns: 9999 };
  assert.equal(verifyTurnStatement(tampered, tampered.node_did).ok, false);
});

test('a gram may not publish a digest about another gram', () => {
  const v = verifyTurnStatement(GO_SIGNED_TURN_DIGEST,
    'did:epn:00240801122000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(v.ok, false);
});

test('the same digest seen by two reporters counts once', () => {
  const out = buildAgentTurns(
    [{ agent_turns: [GO_SIGNED_TURN_DIGEST] }],
    'now',
    [{ nodes: [{ agent_turns: [GO_SIGNED_TURN_DIGEST] }] }],
  );
  assert.equal(out.agent_count, 1);
  assert.equal(out.agents[0].turns, 2);
});

// A turn is taken once by one agent. There is no provider/consumer side to pick, so
// the only defence against double counting is the dedupe key — and it must be the
// same key the daemon grouped by.
test('two agents on one gram are not merged into one', () => {
  const other = { ...GO_SIGNED_TURN_DIGEST, persona_id: 'reference' };
  const out = buildAgentTurns([{ agent_turns: [GO_SIGNED_TURN_DIGEST, other] }], 'now', []);
  // The second is a re-labelled envelope, so it must be REFUSED rather than counted
  // as a second agent: the signature covers persona_id.
  assert.equal(out.agent_count, 1);
  assert.equal(out.rejected, 1);
});

test('an unverifiable digest is rejected, not down-weighted', () => {
  const forged = { ...GO_SIGNED_TURN_DIGEST, held: 999 };
  const out = buildAgentTurns([{ agent_turns: [GO_SIGNED_TURN_DIGEST, forged] }], 'now', []);
  assert.equal(out.agents[0].held, 1);
  assert.equal(out.rejected, 1);
});

// The held rate is over decided turns, never over all of them: a receipt written
// before the outcome field existed has no outcome, and dividing by every turn would
// report a working agent as failing.
test('the held rate divides by decided turns, not by every turn', () => {
  const out = buildAgentTurns([{ agent_turns: [GO_SIGNED_TURN_DIGEST] }], 'now', []);
  const a = out.agents[0];
  assert.equal(a.decided, 2);
  assert.equal(a.held_pct, 50);
});

test('agent totals ship with coverage and the bytes to re-check them', () => {
  const out = buildAgentTurns([{ agent_turns: [GO_SIGNED_TURN_DIGEST] }], 'now', []);
  assert.equal(out.gram_count, 1);
  assert.ok(out.coverage_note.includes('floor'));
  assert.ok(out.coverage_note.includes('must not be added'));
  const signed = out.agents[0].signed[0];
  assert.ok(signed.signing_payload_b64.length > 0);
  assert.ok(signed.signature.length > 0);
});

test('a gram with no agents produces an empty, honest turn ledger', () => {
  const out = buildAgentTurns([{}], 'now', []);
  assert.equal(out.agent_count, 0);
  assert.equal(out.totals.turns, 0);
  assert.equal(out.totals.held_pct, null);
});


// -- PRIVATE WORK, COUNTED WITHOUT CONTEXT --------------------------------------

// Signed by AggregatePrivate and pasted verbatim. It sums TWO private rooms
// (105.09268272099999 + 308.01785907100003) into one figure, and the awkward floats
// are the point: they are the exact shape that made a JS reconstruction refuse 17 of
// 19 genuine epoch statements.
const GO_SIGNED_PRIVATE_AGGREGATE = {
  "node_did": "did:epn:0024080112202917f0d78980c4e96f28090dca450942483bddc164fd01611c4966d4873b09f0",
  "resource_type": "gpu_second",
  "epoch_start": 1785160800,
  "epoch_end": 1785164400,
  "total_units": 413.110542,
  "total_cost_uusd": 4130,
  "credit_uusd": 413,
  "receipt_count": 2,
  "side": "provider",
  "generated_at": 1785164158,
  "sig": "9l/A6eOOJoyTOSQtc2EtjK+TKtnMLlVV3PlCwS6fwJ9KAUEXWoz/X4Y4fUtyw+e7HPkpj3SZH5iUVymQmbn5BA==",
  "signing_payload_b64": "eyJub2RlX2RpZCI6ImRpZDplcG46MDAyNDA4MDExMjIwMjkxN2YwZDc4OTgwYzRlOTZmMjgwOTBkY2E0NTA5NDI0ODNiZGRjMTY0ZmQwMTYxMWM0OTY2ZDQ4NzNiMDlmMCIsInJlc291cmNlX3R5cGUiOiJncHVfc2Vjb25kIiwiZXBvY2hfc3RhcnQiOjE3ODUxNjA4MDAsImVwb2NoX2VuZCI6MTc4NTE2NDQwMCwidG90YWxfdW5pdHMiOjQxMy4xMTA1NDIsInRvdGFsX2Nvc3RfdXVzZCI6NDEzMCwiY3JlZGl0X3V1c2QiOjQxMywicmVjZWlwdF9jb3VudCI6Miwic2lkZSI6InByb3ZpZGVyIiwiZ2VuZXJhdGVkX2F0IjoxNzg1MTY0MTU4fQ=="
};

test('a private aggregate signed by the Go daemon verifies here', () => {
  const v = verifyPrivateAggregate(GO_SIGNED_PRIVATE_AGGREGATE, GO_SIGNED_PRIVATE_AGGREGATE.node_did);
  assert.equal(v.ok, true, v.reason);
});

test('two private rooms arrive as one figure that cannot be decomposed', () => {
  const out = buildPrivateWork([{ private_work: [GO_SIGNED_PRIVATE_AGGREGATE] }], 'now', []);
  assert.equal(out.rejected, 0);
  assert.equal(out.resources.length, 1);
  assert.equal(out.resources[0].total_units, 413.110542);
  // The work is counted; the rooms are gone.
  const published = JSON.stringify(out);
  assert.ok(!published.includes('room-a') && !published.includes('room-b'));
  assert.ok(!published.includes('gramx_id'));
});

// There is no per-gram split, on purpose: published alongside a public list of which
// grams are in which region, a per-gram figure narrows a private room to a handful of
// machines.
test('private work is not broken down per gram', () => {
  const out = buildPrivateWork([{ private_work: [GO_SIGNED_PRIVATE_AGGREGATE] }], 'now', []);
  assert.ok(!JSON.stringify(out.resources).includes(GO_SIGNED_PRIVATE_AGGREGATE.node_did));
  assert.equal(out.gram_count, 1); // the coverage figure survives; the split does not
});

// An aggregate that names a room was built by something that did not understand what
// it is for. Refused rather than stripped — we do not know what else that signer got
// wrong.
test('a private aggregate that names a room is refused outright', () => {
  const named = { ...GO_SIGNED_PRIVATE_AGGREGATE, gramx_id: 'room-a' };
  assert.equal(verifyPrivateAggregate(named, named.node_did).ok, false);
  const out = buildPrivateWork([{ private_work: [named] }], 'now', []);
  assert.equal(out.rejected, 1);
  assert.equal(out.resources.length, 0);
});

test('a tampered private total does not verify', () => {
  const t = { ...GO_SIGNED_PRIVATE_AGGREGATE, total_units: 99999 };
  assert.equal(verifyPrivateAggregate(t, t.node_did).ok, false);
});

test('the same aggregate seen by two reporters counts once', () => {
  const out = buildPrivateWork(
    [{ private_work: [GO_SIGNED_PRIVATE_AGGREGATE] }],
    'now',
    [{ nodes: [{ private_work: [GO_SIGNED_PRIVATE_AGGREGATE] }] }],
  );
  assert.equal(out.resources[0].total_units, 413.110542);
});

test('the private note says what a reader cannot check', () => {
  const out = buildPrivateWork([{ private_work: [GO_SIGNED_PRIVATE_AGGREGATE] }], 'now', []);
  assert.ok(out.note.includes('No room is named'));
  assert.ok(out.note.includes('not cross-checkable'));
});

// -- PRESENCE ------------------------------------------------------------------

// An away gram's capacity is not available capacity: summing it would advertise a
// network that can serve more than it can.
test('an away node appears but does not add capacity', () => {
  const mesh = buildMeshView([{
    nodes: [
      { did: 'did:epn:a', online: true, vram_gib: 8, ram_pool_gib: 4, vcpu_seconds: 100 },
      { did: 'did:epn:b', online: false, last_seen: '2026-07-27T06:00:00Z', vram_gib: 64, ram_pool_gib: 32, vcpu_seconds: 900 },
    ],
  }], 'now');

  assert.equal(mesh.node_count, 2, 'both grams must still be listed');
  assert.equal(mesh.online_count, 1);
  assert.equal(mesh.away_count, 1);
  assert.equal(mesh.totals.vram_gib, 8, 'an unreachable machine advertised its VRAM as available');
  assert.equal(mesh.totals.ram_pool_gib, 4);
  assert.equal(mesh.totals.vcpu_seconds, 100);

  const away = mesh.nodes.find((n) => n.did === 'did:epn:b');
  assert.equal(away.online, false);
  assert.equal(away.last_seen, '2026-07-27T06:00:00Z', 'a reader cannot tell asleep from gone without this');
});

// Work that already happened does not stop having happened because a laptop closed.
test('an away node still counts toward historical activity', () => {
  const mesh = buildMeshView([{
    nodes: [
      { did: 'did:epn:b', online: false, proof_snapshot: { metrics: { tokens_served: 500, inferences_served: 7 } } },
    ],
  }], 'now');
  assert.equal(mesh.activity.tokens_served, 500);
  assert.equal(mesh.activity.inferences_served, 7);
  assert.equal(mesh.totals.vram_gib, 0);
});

// A reporter on an older build sends neither field. Its nodes were, by definition,
// connected — treating them as away would erase the network on the first deploy.
test('nodes from an older reporter default to online', () => {
  const mesh = buildMeshView([{ nodes: [{ did: 'did:epn:old', vram_gib: 2 }] }], 'now');
  assert.equal(mesh.online_count, 1);
  assert.equal(mesh.away_count, 0);
  assert.equal(mesh.totals.vram_gib, 2);
});

// -- BATCH VARIANTS ------------------------------------------------------------

// A signed batch sweep does not un-happen because its prober went to sleep. This was
// the model page showing batch capacity on one refresh and none on the next.
test('batch variants survive a run where their prover is absent', () => {
  const prev = { models: [{
    slug: 'llama', name: 'llama', provider_count: 1, nodes: [],
    variants: [{ node_did: 'did:epn:a', slots: 4, context_tokens: 8192, aggregate_tokens_per_sec: 120, ts: 100 }],
  }] };
  // This run the prover is not visible, so it contributes no variants.
  const cur = { model_count: 1, models: [{ slug: 'llama', name: 'llama', provider_count: 0, nodes: [], variants: [] }] };

  const merged = mergeModels(prev, cur);
  assert.equal(merged.models[0].variants.length, 1, 'a proved batch shape vanished with its prober');
  assert.equal(merged.models[0].variants[0].aggregate_tokens_per_sec, 120);
});

// A re-sweep of the same shape replaces the old figure — it is a fresh measurement of
// the same thing, not a competing claim, and keeping the best-ever would misreport
// what the machine can do now.
test('a re-swept shape replaces its earlier figure', () => {
  const prev = { models: [{
    slug: 'llama', name: 'llama', nodes: [],
    variants: [{ node_did: 'did:epn:a', slots: 4, context_tokens: 8192, aggregate_tokens_per_sec: 900, ts: 100 }],
  }] };
  const cur = { model_count: 1, models: [{
    slug: 'llama', name: 'llama', nodes: [],
    variants: [{ node_did: 'did:epn:a', slots: 4, context_tokens: 8192, aggregate_tokens_per_sec: 120, ts: 200 }],
  }] };

  const merged = mergeModels(prev, cur);
  assert.equal(merged.models[0].variants.length, 1);
  assert.equal(merged.models[0].variants[0].aggregate_tokens_per_sec, 120, 'a stale high-water figure won');
});

// Different shapes and different grams are different proofs and all stand.
test('distinct shapes accumulate rather than overwrite', () => {
  const prev = { models: [{
    slug: 'llama', name: 'llama', nodes: [],
    variants: [{ node_did: 'did:epn:a', slots: 4, context_tokens: 8192, aggregate_tokens_per_sec: 120, ts: 100 }],
  }] };
  const cur = { model_count: 1, models: [{
    slug: 'llama', name: 'llama', nodes: [],
    variants: [
      { node_did: 'did:epn:a', slots: 8, context_tokens: 8192, aggregate_tokens_per_sec: 200, ts: 200 },
      { node_did: 'did:epn:b', slots: 4, context_tokens: 8192, aggregate_tokens_per_sec: 90, ts: 200 },
    ],
  }] };

  const merged = mergeModels(prev, cur);
  assert.equal(merged.models[0].variants.length, 3);
  assert.equal(merged.models[0].variants[0].aggregate_tokens_per_sec, 200, 'variants must be sorted by throughput');
});

// -- PRIVACY -------------------------------------------------------------------

// THE LEAK. Both rooms on the live network were private, and their ids, their
// members' DIDs and their hour-by-hour activity were published to a public
// repository. The daemon strips these at the door now; this is the second lock,
// because this file already refuses to trust the reporter on signatures and must
// refuse to trust it on privacy for the same reason.
test('a private room is never named in the published rollup', () => {
  const priv = { ...GO_SIGNED_STATEMENT, gramx_id: 'DG1h70GzVONqlxjluvnM', private: true };
  const out = buildGramxRooms(
    [{ gramx_epochs: { DG1h70GzVONqlxjluvnM: [priv], IN_400001: [GO_SIGNED_STATEMENT] } }],
    'now', [],
  );
  const published = JSON.stringify(out);
  assert.ok(!published.includes('DG1h70GzVONqlxjluvnM'), 'a private room id reached the published file');
  assert.equal(out.room_count, 1);
  assert.equal(out.rooms[0].gramx_id, 'IN_400001');
  // Withheld, not rejected: a private statement is a good statement that is none of
  // the public's business, and counting it as a failure would make an honest
  // network look like it was publishing forgeries.
  assert.equal(out.withheld_private, 1);
  assert.equal(out.rejected, 0);
});

// A private room's members must not be published either — the contributor list is
// the membership of the room.
test('a private room contributes no DIDs to the public file', () => {
  const priv = { ...GO_SIGNED_STATEMENT, gramx_id: 'secret', private: true };
  const out = buildGramxRooms([{ gramx_epochs: { secret: [priv] } }], 'now', []);
  assert.equal(out.rooms.length, 0);
  assert.ok(!JSON.stringify(out).includes(priv.node_did));
});

// The daemon strips the room id BEFORE signing, so a private digest arrives already
// anonymous and its WORK is publishable. One that still carries an id can only come
// from an older or altered signer, and its id is not to be trusted as harmless.
test('a private turn digest that still names its room is dropped', () => {
  const leaky = { ...GO_SIGNED_TURN_DIGEST, private: true };
  const out = buildAgentTurns([{ agent_turns: [leaky] }], 'now', []);
  assert.equal(out.agent_count, 0);
  assert.equal(out.rejected, 1);
});

// THE TURN ARCHIVE.
//
// rollAgentTurns takes statements that are already verified, so these fixtures carry
// no real signature: what is under test is the adding up, not the checking. The
// checking is covered by the buildAgentTurns cases above, which run the whole path.
const ARCHIVED_TURN = {
  node_did: 'did:epn:aaa',
  persona_id: 'evo',
  gramx_id: 'room-a',
  kind: 'concierge_turn',
  epoch_start: 1785153600,
  epoch_end: 1785157200,
  turns: 2, tool_calls: 2, held: 1, failed: 1, gated: 0,
  prompt_tokens: 0, output_tokens: 0,
  vcpu_seconds: 1.4, gpu_seconds: 0, energy_kwh: 0, carbon_grams: 0,
  models: ['gemma4:e2b'], tools: ['cite_fact'],
  sig: 'sig-1', signing_payload_b64: 'payload-1',
};
const atEpoch = (epoch, over = {}) => ({
  ...ARCHIVED_TURN, epoch_start: epoch, epoch_end: epoch + 3600, ...over,
});

// A daemon republishes the same hour on every run for a week. If that added up, the
// network would be billed many times over for one turn.
test('a statement republished every run lands in the archive exactly once', () => {
  const first = mergeTurnArchive([], [atEpoch(1785153600)]);
  const again = mergeTurnArchive(first, [atEpoch(1785153600)]);
  assert.equal(again.length, 1);
  assert.equal(rollAgentTurns(again, 'now').totals.turns, 2);
});

// The whole reason the archive exists: turn_digest.go folds seven days and no more,
// so without this the total SHRANK as an agent's work aged out of the window.
test('a turn the daemon has aged out of its window is still counted', () => {
  const archive = mergeTurnArchive(
    [atEpoch(1785153600, { turns: 2, held: 1, failed: 1 })],
    [atEpoch(1786000000, { turns: 3, held: 3, failed: 0 })]
  );
  const out = rollAgentTurns(archive, 'now');
  assert.equal(out.agent_count, 1);
  assert.equal(out.totals.turns, 5);
  assert.equal(out.agents[0].epochs, 2);
  // decided = 4 held + 1 failed, and the rate is over those, never over every turn.
  assert.equal(out.totals.decided, 5);
  assert.equal(out.totals.held_pct, 80);
});

test('an agent keeps every turn it proved when its gram publishes nothing', () => {
  const archive = mergeTurnArchive([atEpoch(1785153600)], []);
  const out = rollAgentTurns(archive, 'now');
  assert.equal(out.agent_count, 1);
  assert.equal(out.gram_count, 1);
  assert.equal(out.totals.turns, 2);
});

// Same number either way; only one of them can be checked in a reader's browser.
test('a statement that arrives with its signed bytes replaces one without them', () => {
  const bare = atEpoch(1785153600, { signing_payload_b64: '' });
  const full = atEpoch(1785153600);
  assert.equal(mergeTurnArchive([bare], [full])[0].signing_payload_b64, 'payload-1');
  assert.equal(mergeTurnArchive([full], [bare])[0].signing_payload_b64, 'payload-1');
});

// An agent belongs to the gram that vouches for it — that is what its DID is for.
test('two grams running an agent of the same name stay two agents in the archive', () => {
  const archive = mergeTurnArchive([], [
    atEpoch(1785153600),
    atEpoch(1785153600, { node_did: 'did:epn:bbb' }),
  ]);
  assert.equal(archive.length, 2);
  assert.equal(rollAgentTurns(archive, 'now').agent_count, 2);
});

test('the archive is ordered oldest epoch first, so a run diffs to the lines it added', () => {
  const archive = mergeTurnArchive([], [atEpoch(1786000000), atEpoch(1785153600)]);
  assert.deepEqual(archive.map((s) => s.epoch_start), [1785153600, 1786000000]);
});

test('the rooms, models and tools an agent worked in accumulate across epochs', () => {
  const archive = mergeTurnArchive([], [
    atEpoch(1785153600, { gramx_id: 'room-a', models: ['m1'], tools: ['t1'] }),
    atEpoch(1786000000, { gramx_id: 'room-b', models: ['m2'], tools: ['t2'] }),
  ]);
  const a = rollAgentTurns(archive, 'now').agents[0];
  assert.deepEqual(a.rooms, ['room-a', 'room-b']);
  assert.deepEqual(a.models, ['m1', 'm2']);
  assert.deepEqual(a.tools, ['t1', 't2']);
  assert.equal(a.first_epoch, 1785153600);
  assert.equal(a.last_epoch, 1786000000 + 3600);
});

// Verified once, on the way in — the archive is extended from exactly these.
test('collecting verifies once and carries the signed bytes through', () => {
  const { statements, rejected } = collectVerifiedTurnStatements(
    [{ agent_turns: [GO_SIGNED_TURN_DIGEST] }],
    []
  );
  assert.equal(rejected, 0);
  assert.equal(statements.length, 1);
  assert.equal(statements[0].signing_payload_b64, GO_SIGNED_TURN_DIGEST.signing_payload_b64);
  // And a forgery never reaches the archive at all.
  assert.equal(
    collectVerifiedTurnStatements([{ agent_turns: [{ ...GO_SIGNED_TURN_DIGEST, turns: 9999 }] }], []).statements.length,
    0
  );
});

// The published page and the archive must never disagree about what happened.
test('turns.json derived from the archive matches building it from the daemons direct', () => {
  const nodes = [{ agent_turns: [GO_SIGNED_TURN_DIGEST] }];
  const { statements, rejected } = collectVerifiedTurnStatements(nodes, []);
  const viaArchive = rollAgentTurns(mergeTurnArchive([], statements), 'now', rejected);
  assert.deepEqual(viaArchive, buildAgentTurns(nodes, 'now', []));
});
