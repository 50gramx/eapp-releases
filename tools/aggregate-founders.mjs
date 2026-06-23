// Rebuilds data/founders.json purely as a function of data/nodes/*.json.
// Because the output is fully derived, the CI loop can safely re-run this after
// syncing to origin — no merge conflicts, ever (see aggregate-founders.yml).
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const dir = 'data/nodes';
const CLOUD_RATE_USD_PER_1M = 10; // transparent cloud-equivalent rate for displaced-cost estimate

const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
const nodes = [];
for (const f of files) {
  try {
    const n = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    nodes.push({
      name: n.name || f.replace(/\.json$/, ''),
      class: n.class || 'community',
      domain: n.domain || null,
      online: n.online === true,
      peer_count: n.peer_count ?? null,
      uptime_seconds: n.uptime_seconds ?? null,
      epnd_version: n.epnd_version || null,
      inferences_served: n.inferences_served ?? 0,
      tokens_served: n.tokens_served ?? 0,
      receipts_verified: n.receipts_verified ?? 0,
      proofs_issued: n.proofs_issued ?? 0,
      disputes_resolved: n.disputes_resolved ?? 0,
      checked_at: n.checked_at || null,
    });
  } catch (e) {
    console.error('skip', f, e.message);
  }
}

const founders = nodes.filter((n) => n.class === 'founder');
const sum = (k) => founders.reduce((a, n) => a + (n[k] || 0), 0);
const tokens = sum('tokens_served');

const out = {
  generated_at: new Date().toISOString(),
  founder_count: founders.length,
  full_founder_count: founders.filter((n) => n.domain).length,
  online_count: founders.filter((n) => n.online).length,
  cloud_rate_usd_per_1m: CLOUD_RATE_USD_PER_1M,
  totals: {
    inferences_served: sum('inferences_served'),
    tokens_served: tokens,
    displaced_cloud_usd: +((tokens / 1e6) * CLOUD_RATE_USD_PER_1M).toFixed(2),
    receipts_verified: sum('receipts_verified'),
    proofs_issued: sum('proofs_issued'),
    disputes_resolved: sum('disputes_resolved'),
    node_years_uptime: +(founders.reduce((a, n) => a + (n.uptime_seconds || 0), 0) / 31557600).toFixed(3),
  },
  nodes: founders.sort((a, b) => (b.domain ? 1 : 0) - (a.domain ? 1 : 0)),
};

writeFileSync('data/founders.json', JSON.stringify(out, null, 2) + '\n');
console.log('founders:', out.founder_count, 'full:', out.full_founder_count, 'displaced $:', out.totals.displaced_cloud_usd);
