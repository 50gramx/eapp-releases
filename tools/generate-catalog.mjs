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

function hasSection(block, section) {
  return new RegExp(`^\\s{4}${escapeRegExp(section)}:\\s*$`, 'm').test(block);
}

// THE PLATFORMS A BRAND IS PLANNED FOR come from what it already declares, so a
// new brand or platform appears on the page (as "coming") the day its contract
// says so: a platform section in the brand (ios:, web:, windows:, ...) plans
// that platform, and the build cadence's matrix plans its own pairs.
const PLATFORM_SECTIONS = ['windows', 'macos', 'linux', 'android', 'ios', 'web'];

function plannedFromContract(block) {
  return PLATFORM_SECTIONS.filter((platform) => hasSection(block, platform));
}

// THE BRAND'S PUBLIC FACE, from its contract's site: block. Store links are
// listed only when the contract names them (once they are public); nothing
// about a brand is written in this file.
const STORE_KEYS = ['play-store', 'app-store', 'testflight', 'mac-app-store', 'microsoft-store'];

function presenceFrom(block) {
  const stores = STORE_KEYS
    .map((store) => ({ store, url: nestedValue(block, 'site', store) }))
    .filter((entry) => /^https:\/\//.test(entry.url));
  const access = nestedValue(block, 'site', 'access')
    .split(/[\s,]+/)
    .map((tier) => tier.toLowerCase())
    .filter((tier) => ['alpha', 'beta', 'gamma'].includes(tier));
  const distribution = nestedValue(block, 'site', 'distribution').toLowerCase() === 'private' ? 'private' : 'public';
  const website = nestedValue(block, 'site', 'website') || nestedValue(block, 'web', 'url');

  // The web app is the brand's web: url, the address its web build serves;
  // a website alone (a company home page) is not the app running on the web.
  const webApp = nestedValue(block, 'web', 'url');

  return {
    website: /^https:\/\//.test(website) ? website : '',
    webApp: /^https:\/\//.test(webApp) ? webApp : '',
    stores,
    access,
    distribution,
  };
}

// THE REST OF A BRAND'S STORE FACE, as the brand declares it in its contract's
// site: block. A field it has not declared stays empty and the page says so;
// nothing here is guessed. An age rating names who gave it (rating-authority),
// because a rating nobody issued is not a rating.
function detailsFrom(block) {
  const value = (key) => nestedValue(block, 'site', key);
  const https = (url) => (/^https:\/\//.test(url) ? url : '');
  return {
    category: value('category'),
    description: value('description'),
    developer: value('developer'),
    ageRating: value('age-rating'),
    ratingAuthority: value('rating-authority'),
    interactive: value('interactive-elements'),
    privacyPolicy: https(value('privacy-policy')),
    terms: https(value('terms')),
    support: https(value('support')),
    dataSafety: https(value('data-safety')),
    screenshots: value('screenshots').split(',').map((item) => item.trim()).filter(Boolean),
    video: https(value('video')),
    publisherDefaults: !/^(off|false|no)$/i.test(value('publisher-defaults')),
  };
}

// THE PUBLISHER (src/main/contracts/publisher.yaml): who stands behind the
// brands, and the store facts a brand inherits until it names its own.
function readPublisher(contractsRoot) {
  const file = join(contractsRoot, 'src/main/contracts/publisher.yaml');
  if (!existsSync(file)) return null;
  const out = {};
  for (const match of readFileSync(file, 'utf8').matchAll(/^\s{2}([a-z-]+):\s*(.+?)\s*$/gm)) {
    out[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = clean(match[2]);
  }
  return out.name ? out : null;
}

// What a brand takes from the publisher, field by field; `inherited` names
// them so the page can say whose policy it is.
function applyPublisher(product, publisher) {
  product.inherited = [];
  if (!publisher || !product.publisherDefaults) return;
  const take = { developer: 'name', privacyPolicy: 'privacyPolicy', terms: 'terms', support: 'support' };
  for (const [field, from] of Object.entries(take)) {
    if (!product[field] && publisher[from]) {
      product[field] = publisher[from];
      product.inherited.push(field);
    }
  }
}

// SCREENS AND FILM. The contract's own (screenshots:, video:) first, then
// what CI captured from the brand's live web app (capture-media.yml writes
// brand-assets/media/<brand>/auto-*.png and a captured.json saying when and
// from where). A path that is not on the site is left out, not shown broken.
function mediaFor(product, siteRoot) {
  const media = [];
  for (const item of product.screenshots || []) {
    if (/^https:\/\//.test(item)) media.push({ type: 'image', src: item, source: 'contract' });
    else if (existsSync(join(siteRoot, item.replace(/^\/+/, '')))) media.push({ type: 'image', src: item.replace(/^\/+/, ''), source: 'contract' });
  }
  const dir = join(siteRoot, 'brand-assets/media', slug(product.brandId));
  let captured = {};
  try { captured = JSON.parse(readFileSync(join(dir, 'captured.json'), 'utf8')); } catch { /* none yet */ }
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => /^auto-.*\.(png|jpe?g|webp)$/.test(f)).sort()) {
      media.push({
        type: 'image',
        src: `brand-assets/media/${slug(product.brandId)}/${file}`,
        source: 'captured',
        capturedAt: captured.capturedAt || '',
        from: captured.url || '',
        frame: /phone/.test(file) ? 'phone' : 'desktop',
      });
    }
  }
  return media;
}

// A BRAND WITHOUT A LOGO OF ITS OWN gets a mark drawn from its id: a golden-
// angle spiral (the gram mark's geometry) whose hue and dot count come from a
// hash of the id. Same id, same mark, on every build; it is replaced the day
// the contract names a real logo.
function hashOf(text) {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  // Finish with an avalanche so short ids that differ by a letter or two land
  // far apart in hue (plain FNV keeps their low bits close).
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function generatedMark(brandId) {
  const h = hashOf(brandId);
  const hue = h % 360;
  const count = 13 + ((h >>> 9) % 13);
  const turn = ((h >>> 3) % 628) / 100;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const dots = [];
  for (let i = 0; i < count; i += 1) {
    const r = 5 + 36 * Math.sqrt((i + 0.5) / count);
    const a = turn + i * golden;
    const size = 2.6 + 5.4 * (1 - i / count);
    dots.push(`  <circle cx="${(64 + r * Math.cos(a)).toFixed(2)}" cy="${(64 + r * Math.sin(a)).toFixed(2)}" r="${size.toFixed(2)}" fill="hsl(${(hue + i * 6) % 360} 80% ${60 + (i % 3) * 9}%)"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 20%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 55% 9%)"/></linearGradient></defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
${dots.join('\n')}
</svg>
`;
}

// The brand's logo as the site serves it: the contract names the app asset
// (lib/assets/...), and the site keeps a copy at brand-assets/<that path>.
function logoFor(block, siteRoot) {
  const logo = directValue(block, 'logo');
  if (!logo) return '';
  const served = `brand-assets/${logo.replace(/^\/+/, '')}`;

  return existsSync(join(siteRoot, served)) ? served : '';
}

function readBrands(contractsRoot, siteRoot) {
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
        ...presenceFrom(brand),
        ...detailsFrom(brand),
        logo: logoFor(brand, siteRoot),
        logoGenerated: false,
        planned: plannedFromContract(brand),
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
  // A logo file two brands both name identifies neither of them (a contract
  // pointing at another brand's logo as a placeholder): the brand that
  // declared it first keeps it, the others get their own mark.
  const owner = new Map();
  for (const product of products) {
    if (!product.logo) continue;
    if (owner.has(product.logo)) product.logo = '';
    else owner.set(product.logo, product.brandId);
  }
  for (const product of products) {
    if (product.logo) continue;
    const served = `brand-assets/generated/${slug(product.brandId)}.svg`;
    mkdirSync(join(siteRoot, 'brand-assets/generated'), { recursive: true });
    writeFileSync(join(siteRoot, served), generatedMark(product.brandId));
    product.logo = served;
    product.logoGenerated = true;
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

// Size and download count of every asset, by "<tag>|<asset name>", straight
// from GitHub: the page shows what a download weighs and how often the
// current builds were fetched, and never a number it did not read.
const assetFacts = new Map();

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
      for (const item of release.assets || []) {
        assetFacts.set(`${release.tag_name}|${item.name}`, {
          size: item.size,
          downloads: item.download_count,
        });
      }
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

const siteRoot = optional(opts, 'site-root', '.');
const matrixPath = optional(opts, 'matrix', 'data/brand-platform-matrix.json');
const products = readBrands(contractsRoot, siteRoot);
const publisher = readPublisher(contractsRoot);
for (const product of products) {
  applyPublisher(product, publisher);
  product.media = mediaFor(product, siteRoot);
}
let matrix = { brands: [], platforms: [] };
try {
  matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
} catch {
  // No cadence matrix: the contracts alone plan the platforms.
}
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
      website: '',
      stores: [],
      access: [],
      distribution: 'public',
      logo: '',
      planned: [],
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
  for (const release of product.releases) {
    const facts = assetFacts.get(`${release.releaseTag}|${release.assetName}`);
    if (facts) {
      release.assetSize = facts.size;
      release.downloads = facts.downloads;
    }
  }
  const counted = new Map();
  for (const release of product.releases) {
    if (typeof release.downloads === 'number') counted.set(`${release.releaseTag}|${release.assetName}`, release.downloads);
  }
  product.downloads = counted.size ? [...counted.values()].reduce((a, b) => a + b, 0) : null;
  product.latestStable = stableRecent(product.releases);
  // Planned = what the contract declares + the cadence matrix + whatever has
  // shipped; the page shows each planned platform without a build as coming.
  const fromMatrix = (matrix.brands || []).includes(product.brandId) ? matrix.platforms || [] : [];
  const shipped = product.releases.map((release) => release.platform).filter(Boolean);
  product.planned = [...new Set([...(product.planned || []), ...fromMatrix, ...shipped])];
}

const platforms = [...new Set(products.flatMap((product) => product.planned))].sort();
const channels = [...new Set(releases.map((release) => release.channel).filter(Boolean))].sort();

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  publisher,
  products,
  platforms,
  channels,
};

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Wrote catalog for ${products.length} products: ${output}`);

// EVERY APP HAS ITS OWN PAGE at apps/<brand>/, so it can be linked, shared and
// found by search with its own title, summary and image. Each is index.html
// with the app's meta filled in and the home content left out; site.js sees
// data-app on <body> and draws that app.
const htmlEscape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shell = readFileSync(join(siteRoot, 'index.html'), 'utf8');
for (const product of products) {
  const id = slug(product.brandId);
  const title = `${product.displayName} — 50GRAMx Apps`;
  const summary = product.summary || '';
  const page = shell
    .replace(/<title>[^<]*<\/title>/, () => `<title>${htmlEscape(title)}</title>\n    <base href="../../">`)
    .replace(/(<meta name="description" content=")[^"]*"/, (_, a) => `${a}${htmlEscape(summary)}"`)
    .replace(/(<meta property="og:title" content=")[^"]*"/, (_, a) => `${a}${htmlEscape(title)}"`)
    .replace(/(<meta property="og:description" content=")[^"]*"/, (_, a) => `${a}${htmlEscape(summary)}"`)
    .replace(/<link rel="icon" href="[^"]*">/, () => `<link rel="icon" href="${htmlEscape(product.logo)}">\n    <meta property="og:image" content="${htmlEscape(product.logo)}">`)
    .replace(/<body>/, () => `<body data-app="${htmlEscape(product.brandId)}">`)
    .replace(/<!--home-->[\s\S]*?<!--\/home-->/, '<p class="loading">Loading…</p>');
  mkdirSync(join(siteRoot, 'apps', id), { recursive: true });
  writeFileSync(join(siteRoot, 'apps', id, 'index.html'), page);
}
console.log(`Wrote ${products.length} app pages under apps/`);
