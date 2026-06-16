#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

function argsMap(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function required(opts, key) {
  const value = opts[key];
  if (!value) throw new Error(`Missing required option --${key}`);
  return value;
}

function optional(opts, key, fallback = '') {
  return opts[key] || fallback;
}

function clean(value) {
  return (value || '').trim().replace(/^['"]|['"]$/g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findEthosapps(root) {
  const found = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const st = statSync(path);
      if (st.isDirectory()) {
        if (entry === '.git' || entry === 'build' || entry === 'node_modules') continue;
        walk(path);
      } else if (entry === 'ethosapps.yaml') {
        found.push(path);
      }
    }
  }
  walk(root);
  return found;
}

function orgBlocks(text) {
  const matches = [...text.matchAll(/^-\s+organisation:\s*(.+)\s*$/gm)];
  return matches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    return {
      organisation: clean(match[1]),
      text: text.slice(start, end),
    };
  });
}

function brandBlock(orgBlock) {
  const brandMatch = orgBlock.text.match(/^\s{2}brand:\s*$/m);
  if (!brandMatch) return '';
  const rest = orgBlock.text.slice(brandMatch.index + brandMatch[0].length);
  const nextTopLevelField = rest.search(/^\s{2}[A-Za-z0-9_-]+:\s*(?:\S.*)?$/m);
  return nextTopLevelField >= 0 ? rest.slice(0, nextTopLevelField) : rest;
}

function directValue(block, key) {
  const match = block.match(new RegExp(`^\\s{4}${escapeRegExp(key)}:\\s*(.+?)\\s*$`, 'm'));
  return clean(match?.[1] || '');
}

function nestedValue(block, section, key) {
  const sectionMatch = block.match(new RegExp(`^\\s{4}${escapeRegExp(section)}:\\s*$`, 'm'));
  if (!sectionMatch) return '';
  const rest = block.slice(sectionMatch.index + sectionMatch[0].length);
  const nextSection = rest.search(/^\s{4}[A-Za-z0-9_-]+:\s*(?:\S.*)?$/m);
  const sectionText = nextSection >= 0 ? rest.slice(0, nextSection) : rest;
  const match = sectionText.match(new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*(.+?)\\s*$`, 'm'));
  return clean(match?.[1] || '');
}

function slug(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'product';
}

function readBrands(contractsRoot) {
  const products = [];
  for (const file of findEthosapps(contractsRoot)) {
    const text = readFileSync(file, 'utf8');
    for (const org of orgBlocks(text)) {
      const brand = brandBlock(org);
      if (!brand) continue;
      const brandId = directValue(brand, 'id') || org.organisation;
      const displayName = directValue(brand, 'display-name') || brandId;
      const productName = directValue(brand, 'product-name') || displayName;
      products.push({
        brandId,
        productId: brandId,
        organisation: org.organisation,
        displayName,
        productName,
        launchEnvironment: directValue(brand, 'launch-environment'),
        summary: directValue(brand, 'about') ||
          nestedValue(brand, 'site', 'summary') ||
          `${productName} release channel.`,
        homeApp: directValue(brand, 'home-app'),
        releases: [],
      });
    }
  }
  products.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return products;
}

function walkJsonFiles(root) {
  if (!existsSync(root)) return [];
  const found = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const st = statSync(path);
      if (st.isDirectory()) {
        walk(path);
      } else if (entry.endsWith('.json')) {
        found.push(path);
      }
    }
  }
  walk(root);
  return found;
}

function readReleaseMetadata(metadataRoot) {
  const releases = [];
  for (const file of walkJsonFiles(metadataRoot)) {
    const name = file.replaceAll('\\', '/');
    if (name.endsWith('/stable-history.json')) continue;
    if (name.endsWith('/catalog.json')) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) {
      releases.push(...parsed);
    } else if (parsed && typeof parsed === 'object') {
      releases.push(parsed);
    }
  }
  return releases;
}

async function readGitHubReleaseMetadata(repo, token) {
  if (!repo) return [];
  const releases = [];
  let url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  while (url) {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed: ${response.status} ${response.statusText}`);
    }
    const page = await response.json();
    for (const release of page) {
      const asset = (release.assets || []).find((item) => item.name === 'release-metadata.json');
      if (!asset) continue;
      const assetResponse = await fetch(asset.browser_download_url, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!assetResponse.ok) continue;
      releases.push(await assetResponse.json());
    }
    url = nextLink(response.headers.get('link'));
  }

  return releases;
}

function nextLink(linkHeader) {
  if (!linkHeader) return '';
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return '';
}

function dedupeReleases(releases) {
  const seen = new Set();
  const out = [];
  for (const release of releases) {
    const key = [
      release.brandId || release.product || '',
      release.platform || '',
      release.channel || '',
      release.version || '',
      release.buildId || '',
      release.assetName || '',
      release.releaseTag || '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(release);
  }
  return out;
}

function stableRecent(releases) {
  return releases
    .filter((release) => release.channel === 'stable')
    .sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')))
    .slice(0, 3);
}

const opts = argsMap(process.argv);
const contractsRoot = required(opts, 'contracts-root');
const metadataRoot = optional(opts, 'metadata-root', 'data/releases');
const output = optional(opts, 'output', 'data/catalog.json');
const githubReleasesRepo = optional(opts, 'github-releases-repo');
const githubToken = optional(opts, 'github-token', process.env.GITHUB_TOKEN || '');

const products = readBrands(contractsRoot);
const byBrand = new Map(products.map((product) => [product.brandId, product]));
const releases = dedupeReleases([
  ...readReleaseMetadata(metadataRoot),
  ...(await readGitHubReleaseMetadata(githubReleasesRepo, githubToken)),
]);

for (const release of releases) {
  const brandId = release.brandId || release.product;
  if (!brandId) continue;
  if (!byBrand.has(brandId)) {
    byBrand.set(brandId, {
      brandId,
      productId: release.product || brandId,
      organisation: '',
      displayName: brandId,
      productName: brandId,
      launchEnvironment: '',
      summary: `${brandId} release channel.`,
      homeApp: '',
      releases: [],
    });
    products.push(byBrand.get(brandId));
  }
  byBrand.get(brandId).releases.push(release);
}

for (const product of products) {
  product.releases.sort((a, b) => {
    const aTime = String(a.generatedAt || '');
    const bTime = String(b.generatedAt || '');
    return bTime.localeCompare(aTime);
  });
  product.latestStable = stableRecent(product.releases);
}

const platforms = [...new Set(releases.map((release) => release.platform).filter(Boolean))].sort();
const channels = [...new Set(releases.map((release) => release.channel).filter(Boolean))].sort();

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  products,
  platforms,
  channels,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Wrote catalog for ${products.length} products: ${output}`);
