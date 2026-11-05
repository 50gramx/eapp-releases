#!/usr/bin/env node
// WHAT A BUILD IS MADE OF, AND WHETHER IT ALREADY EXISTS.
//
// A brand's build for one platform is a function of four things, and only
// these four:
//
//   eapp       eapp-live's tree, minus what no build reads (docs, tests,
//              editor settings) and minus every OTHER platform's folder: a
//              change under android/ is not a reason to rebuild Windows.
//   contracts  what the build takes from the contracts: the brand's resolved
//              delivery (resolve_contract_delivery.mjs, the same call the
//              build makes), and for web the gramx contract tree it bundles.
//              A brand's site: block, another brand, another community: none
//              of them is in a native build, so none of them rebuilds it.
//   recipe     the workflow file that turns those into an artifact.
//   epnd       the published in-app gram the build bundles.
//
// Their hash is the build's fingerprint. Before, a build was keyed on the
// WHOLE eapp-live and contracts commit, so a README edit or one brand's store
// copy rebuilt every brand on every platform, and the same inputs were built
// once per channel: on the 1st of a month nightly, bi-weekly and stable each
// rebuilt the identical binary.
//
// Decision for the channel asked for:
//   skip     its last build has this fingerprint (or, for a marker written
//            before fingerprints, the same three commits)
//   promote  another channel already built this fingerprint: copy that
//            release instead of building it again
//   build    nobody has built it
// and for each --also channel whose last build differs: promote it from the
// primary once that exists.
//
// Writes GitHub outputs: action, from_channel, fingerprint, parts (JSON),
// promotions (JSON list of {from, to}), build (true|false).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const args = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = 'true';
  else { args[a.slice(2)] = next; i += 1; }
}
const need = (k) => { if (!args[k]) { console.error(`build-plan: --${k} is required`); process.exit(2); } return args[k]; };

const brand = need('brand');
const platform = need('platform');
const channel = need('channel');
const eappDir = need('eapp');
const contractsDir = need('contracts');
const workflow = need('workflow');
const epnd = args['epnd-state'] || '';
const markersDir = args.markers || 'data/last-built';
const legacy = (args.legacy || '').trim();
const also = (args.also || '').split(/[\s,]+/).filter((c) => c && c !== channel);
const promotable = args.promotable !== 'false';
const markerName = (ch) => (args['marker-name'] || `${brand}-${platform}-{channel}`).replace('{channel}', ch);

const sha = (text) => createHash('sha256').update(text).digest('hex');
const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });

// ── eapp: the top-level tree entries a build of THIS platform reads ─────────
const PLATFORM_DIRS = ['android', 'ios', 'linux', 'macos', 'windows', 'web'];
const NEVER_BUILT = new Set(['docs', 'doc', 'test', 'integration_test', '.github', '.claude', '.vscode', '.idea', '.gitignore', '.gitattributes']);
const entries = git(eappDir, 'ls-tree', 'HEAD')
  .split('\n')
  .filter(Boolean)
  .filter((line) => {
    const name = line.split('\t')[1];
    if (NEVER_BUILT.has(name)) return false;
    if (/\.md$/i.test(name)) return false;
    if (PLATFORM_DIRS.includes(name) && name !== platform) return false;
    return true;
  });
const eapp = sha(entries.join('\n'));

// ── contracts: what the build takes from them ───────────────────────────────
const out = join(mkdtempSync(join(tmpdir(), 'plan-')), 'delivery.json');
execFileSync('node', [
  join(eappDir, 'tool/ci/resolve_contract_delivery.mjs'),
  '--contracts-root', contractsDir,
  '--brand-id', brand,
  '--platform', platform,
  '--channel', 'nightly',
  '--output', out,
], { stdio: ['ignore', 'ignore', 'inherit'] });
const delivery = JSON.parse(readFileSync(out, 'utf8'));
// Channel-named values, and where the contract file sits on this runner's
// disk: neither is something the build is made of. (The Windows runner reads
// that file only to fill a value the resolved environment left empty, and
// CI leaves none empty.)
for (const k of ['release_channel', 'release_tag', 'contracts_manifest', 'eapp_brand_contract']) delete delivery[k];
let contracts = sha(JSON.stringify(delivery, Object.keys(delivery).sort()));
if (platform === 'web') {
  contracts = sha(contracts + git(contractsDir, 'rev-parse', 'HEAD:src/main/contracts/community/apps/gramx').trim());
}

const recipe = sha(readFileSync(workflow));
const parts = { v: 1, eapp, contracts, recipe, epnd };
const fingerprint = sha(JSON.stringify(parts));

// ── what has already been built ─────────────────────────────────────────────
const CHANNELS = ['nightly', 'weekly', 'bi-weekly', 'stable'];
const marker = (ch) => {
  const p = join(markersDir, `${markerName(ch)}.json`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
};
const current = (m) => Boolean(m) && (m.fingerprint === fingerprint ||
  (!m.fingerprint && legacy && [m.eapp_sha, m.contracts_sha, m.epnd_state].map((x) => x || '').join(' ').trim() === legacy));

let action = 'build';
let from = '';
if (current(marker(channel))) {
  action = 'skip';
} else if (promotable) {
  const donor = CHANNELS.find((ch) => ch !== channel && marker(ch)?.fingerprint === fingerprint);
  if (donor) { action = 'promote'; from = donor; }
}

const promotions = [];
if (action === 'promote') promotions.push({ from, to: channel });
if (promotable) {
  for (const ch of also) {
    if (!current(marker(ch))) promotions.push({ from: channel, to: ch });
  }
}

const result = {
  action,
  from_channel: from,
  build: action === 'build' ? 'true' : 'false',
  fingerprint,
  parts: JSON.stringify(parts),
  promotions: JSON.stringify(promotions),
  any_promotions: promotions.length ? 'true' : 'false',
};
console.log(`${brand}/${platform}/${channel}: ${action}${from ? ` from ${from}` : ''}`, { parts, promotions });
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(result).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
