import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviders, providerId } from './providers.mjs';

const did = (tail) => `did:epn:0024080112${tail}`;

test('one row per gram that signed, busiest first, joined to fleet and sheet', () => {
  const evidence = [
    { name: 'hf.co/a/x:Q4_K_M', nodes: [{ node_did: did('aaa111'), measured_at: 1793200000000000, hardware: { os: 'linux', cpus: 4 } }] },
    { name: 'hf.co/a/y:Q4_K_M', nodes: [
      { node_did: did('aaa111'), measured_at: 1793100000000000 },
      { node_did: did('bbb222'), measured_at: 1793000000000000 },
    ] },
  ];
  const fleet = [{
    node_did: did('aaa111'), os: 'linux', arch: 'x86_64', version: '79a06a5e0', last_seen: '2026-10-28T15:50:00Z',
    snapshot_at: '2026-10-28T16:00:00Z', milestones: { claim_applied: { ok: true } },
    env: { gpu_model: 'Tesla T4', vram_gib: 15, cpus: 4, ram_gib: 31, awake_seconds: 90, slept_seconds: 10 },
    probes: { hardware_class: 'linux/amd64/nvidia/32g', measured: 2, failed: 0, queued: 9 },
  }];
  const machines = { grams: { [did('aaa111')]: { 'cpu:4': { model: 'Intel Xeon', clock_ghz: 2.2, measured_in: 'IN_400070', measured_at: '2026-10-28T10:00:00Z' } } } };
  const runs = [{ ref: 'hf.co/a/x:Q4_K_M', providers: ['aaa111'], tokens_per_sec: 30, cost_usd_per_million: 1.2, model: 'X', page: '/inferences/a/x' }];
  const out = buildProviders({ evidence, fleet, machines, runs, region: () => ({ city: 'Mumbai', state: 'Maharashtra' }), generatedAt: '2026-10-28T16:00:00Z' });
  assert.equal(out.length, 2);
  const [a, b] = out;
  assert.equal(a.id, 'aaa111');
  assert.equal(a.rank, 1);
  assert.equal(a.signed_runs, 2);
  assert.equal(a.builds_measured, 2);
  assert.equal(a.claimed, true);
  assert.equal(a.online, true);
  assert.equal(a.version, '79a06a5');
  assert.equal(a.hardware.gpu, 'Tesla T4');
  assert.equal(a.hardware.cpu_model, 'Intel Xeon');
  assert.equal(a.awake_pct, 90);
  assert.deepEqual(a.region, { code: 'IN_400070', city: 'Mumbai', state: 'Maharashtra' });
  assert.equal(a.fastest.model, 'X');
  assert.equal(a.cheapest.cost_usd_per_million, 1.2);
  assert.equal(a.first_signed_at, '2026-10-27T11:20:00.000Z');
  assert.equal(b.id, 'bbb222');
  assert.equal(b.claimed, false);
  assert.equal(b.online, false);
  assert.equal(b.region, null);
});

test('a Mac reporting its CPU as the gpu model shows no card', () => {
  const evidence = [{ name: 'r', nodes: [{ node_did: did('ccc333') }] }];
  const fleet = [{ node_did: did('ccc333'), env: { gpu_model: 'Intel(R) Core(TM) i5-5350U CPU @ 1.80GHz' } }];
  const [p] = buildProviders({ evidence, fleet });
  assert.equal(p.hardware.gpu, null);
});

test('providerId is the last six of the DID, lower case', () => {
  assert.equal(providerId('did:epn:00ABCDEF84BF54'), '84bf54');
});

test('activity by day and family, the builds it opened first, awards and rooms', () => {
  const d1 = did('aaa111');
  const d2 = did('bbb222');
  const evidence = [
    { name: 'x', family: 'qwen-3', nodes: [{ node_did: d1, measured_at: '2026-10-20T10:00:00Z' }, { node_did: d2, measured_at: '2026-10-21T10:00:00Z' }] },
    { name: 'y', family: 'gemma-4', nodes: [{ node_did: d2, measured_at: '2026-10-19T10:00:00Z' }, { node_did: d1, measured_at: '2026-10-20T11:00:00Z' }] },
  ];
  const rooms = [{ gramx_id: 'IN_400070', contributors: [d1] }];
  const runs = [{ ref: 'x', providers: ['aaa111'], tokens_per_sec: 36, cost_breakdown: { usd_per_hour: 0.36 }, model: 'X' }];
  const all = buildProviders({ evidence, rooms, runs, generatedAt: '2026-10-28T00:00:00Z' });
  const a = all.find((p) => p.id === 'aaa111');
  const b = all.find((p) => p.id === 'bbb222');
  assert.equal(a.id, 'aaa111');
  assert.deepEqual(a.runs_by_day, [{ date: '2026-10-20', runs: 2 }]);
  assert.deepEqual(a.runs_by_family, [{ family: 'qwen-3', runs: 1 }, { family: 'gemma-4', runs: 1 }].sort((p, q) => q.runs - p.runs));
  assert.deepEqual(a.opened.map((o) => o.ref), ['x']);
  assert.deepEqual(b.opened.map((o) => o.ref), ['y']);
  assert.deepEqual(a.rooms, ['IN_400070']);
  assert.equal(a.best_value.tokens_per_usd_hour, 100);
  assert.ok(a.awards.some((w) => w.id === 'opener'));
  assert.ok(a.awards.some((w) => w.id === 'runs-1'));
  assert.equal(a.of, 2);
});

test('nanosecond, microsecond and second stamps all land on the right day', () => {
  const evidence = [{ name: 'r', nodes: [
    { node_did: did('ddd444'), measured_at: 1793200000000000000 },
    { node_did: did('ddd444'), measured_at: 1793200000000000 },
    { node_did: did('ddd444'), measured_at: 1793200000 },
  ] }];
  const [p] = buildProviders({ evidence, generatedAt: '2026-10-28T12:00:00Z' });
  assert.equal(p.first_signed_at.slice(0, 10), '2026-10-28');
  assert.equal(p.last_signed_at.slice(0, 10), '2026-10-28');
  assert.deepEqual(p.runs_by_day, [{ date: '2026-10-28', runs: 3 }]);
});

test('part logos, standing among machines, and history from the archive', async () => {
  const { partOrg } = await import('./providers.mjs');
  assert.equal(partOrg('NVIDIA GeForce RTX 3080 Ti'), 'nvidia');
  assert.equal(partOrg('AMD64 Family 25 Model 33 Stepping 0, AuthenticAMD'), 'amd');
  assert.equal(partOrg('Intel Xeon'), 'intel');
  assert.equal(partOrg('Apple M4'), 'apple');
  const a = did('aaa111');
  const b = did('bbb222');
  const evidence = [{ name: 'x', nodes: [{ node_did: a, measured_at: '2026-10-27T10:00:00Z' }, { node_did: b, measured_at: '2026-10-27T10:00:00Z' }] }];
  const machines = { grams: { [a]: { 'gpu:0': { fp16_tflops: 60 } }, [b]: { 'gpu:0': { fp16_tflops: 20 } } } };
  const history = [{ ref: 'x', node_did: a, measured_at: '2026-10-01T10:00:00Z' }, { ref: 'x', node_did: a, measured_at: '2026-10-27T10:00:00Z' }];
  const out = buildProviders({ evidence, machines, history, generatedAt: '2026-10-28T00:00:00Z' });
  const pa = out.find((p) => p.id === 'aaa111');
  assert.equal(pa.percentiles.gpu_tflops, 100);
  assert.equal(out.find((p) => p.id === 'bbb222').percentiles.gpu_tflops, 0);
  assert.equal(pa.first_signed_at.slice(0, 10), '2026-10-01');
  assert.deepEqual(pa.runs_by_day, [{ date: '2026-10-01', runs: 1 }, { date: '2026-10-27', runs: 1 }]);
});

test('uptime by day from the hours the collector heard the gram', () => {
  const d = did('eee555');
  const fleet = [{ node_did: d, hours_seen: { '2026-10-27': (1 << 24) - 1, '2026-10-28': 0b111 } }];
  const [p] = buildProviders({ evidence: [{ name: 'r', nodes: [{ node_did: d }] }], fleet });
  assert.deepEqual(p.uptime_days, [{ date: '2026-10-27', hours: 24 }, { date: '2026-10-28', hours: 3 }]);
  assert.equal(p.uptime_pct, 56.3);
});
