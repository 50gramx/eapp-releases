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
