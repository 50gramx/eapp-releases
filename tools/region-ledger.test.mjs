// Regions are pincodes; a gram is here in one at a time; its work stays where
// it was done. Run: node tools/region-ledger.test.mjs
import assert from 'node:assert/strict';
import { mergeCommunityLedger, buildCommunities, isRegionId } from './aggregate-founders.mjs';
import { labelFor, pincodeFit } from './region-labels.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

const node = (did, id, city, state, at, visible = true) => ({
  name: null, node_did: did, confidence: 'verified', score: 0.9, online: visible, reporter: false,
  visible, first_seen_at: at, last_seen_at: at,
});
const community = (id, city, state, nodes, extra = {}) => ({
  id, pincode: id.split('_')[1], city, state, country: id.split('_')[0],
  node_count: nodes.length, online_count: 0, verified_count: nodes.length, reporter_count: 0,
  nodes, bests: {}, rejected_results: [], ...extra,
});

test('a pincode knows its state', () => {
  assert.equal(pincodeFit('IN', '600001', 'Odisha'), 'contradicts');
  assert.equal(pincodeFit('IN', '600001', 'Tamil Nadu'), 'fits');
  assert.equal(pincodeFit('IN', '834001', 'Bihar'), 'contradicts');
  assert.equal(pincodeFit('IN', '834001', 'Jharkhand'), 'fits');
  assert.equal(pincodeFit('IN', '751030', 'Orissa'), 'fits');
  assert.equal(pincodeFit('US', '51503', 'Iowa'), 'unknown');
});

test('a region is a pincode and nothing else is one', () => {
  assert.ok(isRegionId('IN_600001'));
  assert.ok(isRegionId('US_51503'));
  assert.ok(!isRegionId('IN_'));
  assert.ok(!isRegionId('IN'));
  assert.ok(!isRegionId(''));
});

test('a stitched label is corrected from its own digits', () => {
  const l = labelFor(community('IN_600001', 'Chennai', 'Odisha', []), { entries: {} });
  assert.deepEqual(l, { city: 'Chennai', state: 'Tamil Nadu', label_source: 'reported-state-corrected' });
});

test('the directory names a pincode whose city was wrong, and keeps a familiar one that was right', () => {
  const dir = {
    entries: {
      IN_500057: { city: 'Hyderabad', state_district: 'Hyderabad', state: 'Telangana', names: ['Hyderabad', 'Asif Nagar mandal'] },
      IN_769002: { city: '', county: 'Rourkela', state_district: 'Sundargarh', state: 'Odisha', names: ['Rourkela', 'Sundargarh'] },
      IN_834001: { city: '', county: 'Kanke', state_district: 'Ranchi', state: 'Jharkhand', names: ['Kanke', 'Ranchi'] },
    },
  };
  assert.deepEqual(labelFor(community('IN_500057', 'Bengaluru', 'Karnataka', []), dir),
    { city: 'Hyderabad', state: 'Telangana', label_source: 'pincode-directory' });
  assert.equal(labelFor(community('IN_769002', 'Rourkela', 'Odisha', []), dir).city, 'Rourkela');
  assert.equal(labelFor(community('IN_834001', 'Hajipur', 'Bihar', []), dir).city, 'Ranchi');
});

test('a directory answer that contradicts the digits is not used', () => {
  const dir = { entries: { IN_600001: { city: 'Somewhere', state: 'Bihar', names: ['Somewhere'] } } };
  assert.equal(labelFor(community('IN_600001', 'Chennai', 'Tamil Nadu', []), dir).label_source, 'reported');
});

test('a gram is here in one region; the others keep it as having worked there', () => {
  const prev = {
    communities: [
      community('IN_769002', 'Rourkela', 'Odisha', [node('did:a', 'IN_769002', '', '', '2026-09-20T00:00:00Z', false)], {
        url_slug: 'odisha-rourkela',
        bests: { cpu: { resource_type: 'cpu', metric: 'cpu.throughput', value: 900, unit: 'hashes/s', node_did: 'did:a', ts: 1 } },
      }),
    ],
  };
  const cur = {
    generated_at: '2026-10-20T00:00:00Z',
    communities: [community('IN_751030', 'Bhubaneswar', 'Odisha', [node('did:a', 'IN_751030', '', '', undefined)])],
  };
  const out = mergeCommunityLedger(prev, cur);
  const rk = out.communities.find((c) => c.id === 'IN_769002');
  const bh = out.communities.find((c) => c.id === 'IN_751030');
  assert.equal(bh.node_count, 1);
  assert.equal(bh.nodes[0].here, true);
  assert.equal(rk.node_count, 0, 'not counted twice');
  assert.equal(rk.worked_here_count, 1, 'but remembered');
  assert.equal(rk.nodes[0].here, false);
  assert.equal(rk.nodes[0].now_in, 'IN_751030');
  assert.equal(rk.bests.cpu.value, 900, 'its work stays where it was done');
});

test('a corrected label moves the address and keeps the old one as an alias', () => {
  const prev = { communities: [community('IN_600001', 'Chennai', 'Odisha', [node('did:a', '', '', '', '2026-09-22T00:00:00Z', false)], { url_slug: 'odisha-chennai' })] };
  const out = mergeCommunityLedger(prev, { generated_at: '2026-10-20T00:00:00Z', communities: [] });
  const c = out.communities[0];
  assert.equal(c.state, 'Tamil Nadu');
  assert.equal(c.url_slug, 'tamil-nadu-chennai');
  assert.deepEqual(c.url_aliases, ['odisha-chennai']);
});

test('a re-estimated label that is not a correction never moves the address', () => {
  const prev = { communities: [community('IN_800001', 'Bodh Gaya', 'Bihar', [], { url_slug: 'bihar-patna' })] };
  const cur = { generated_at: '2026-10-20T00:00:00Z', communities: [community('IN_800001', 'Bodh Gaya', 'Bihar', [])] };
  const c = mergeCommunityLedger(prev, cur).communities[0];
  assert.equal(c.url_slug, 'bihar-patna');
  assert.equal(c.url_aliases, undefined);
});

test('work is filed where it was measured, not where its gram is now', () => {
  const nodes = [{ name: 'g', online: true, proof_snapshot: { node_did: 'did:a', region: { community_id: 'IN_751030', pincode: '751030', city: 'Bhubaneswar', region: 'Odisha', country_code: 'IN', confidence: 'verified' } } }];
  const verified = [{
    resource_type: 'cpu', verification: 'verified',
    signed_result: { result: { metric: 'cpu.throughput', value: 1200, unit: 'hashes/s', node_did: 'did:a', ts: 5, extra: { measured_in: 'IN_769002' } } },
  }];
  const out = buildCommunities(nodes, '2026-10-20T00:00:00Z', [], verified, []);
  const rk = out.communities.find((c) => c.id === 'IN_769002');
  assert.ok(rk, 'the region the work was done in exists');
  assert.equal(rk.node_count, 0);
  assert.ok(rk.bests.cpu, 'and holds that work');
  assert.ok(!out.communities.find((c) => c.id === 'IN_751030').bests.cpu);
});

test('a placement with no pincode is no region', () => {
  const nodes = [{ name: 'g', online: true, proof_snapshot: { node_did: 'did:a', region: { community_id: 'IN_', country_code: 'IN' } } }];
  assert.equal(buildCommunities(nodes, '2026-10-20T00:00:00Z').communities.length, 0);
});

console.log(`${passed} test(s) passed`);
