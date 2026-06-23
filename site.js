const state = {
  catalog: null,
  signing: null,
  filters: {
    brand: 'all',
    platform: 'all',
    channel: 'all',
  },
};

const platformNames = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  android: 'Android',
  web: 'Web',
};

const platformGlyph = {
  windows: '⊞',
  macos: '⌘',
  linux: '🐧',
  android: '🤖',
  web: '🌐',
};

const channelNames = {
  nightly: 'Nightly',
  weekly: 'Weekly',
  'bi-weekly': 'Bi-weekly',
  stable: 'Stable',
};

const channelBlurb = {
  nightly: 'freshest build, fast feedback',
  weekly: 'regular integration checkpoint',
  'bi-weekly': 'slower review rhythm',
  stable: 'release-grade, kept with history',
};

async function loadJSON(path, optional = false) {
  const response = await fetch(path, { cache: 'no-store' });
  if (!response.ok) {
    if (optional) return null;
    throw new Error(`${path} unavailable: ${response.status}`);
  }
  return response.json();
}

function option(label, value) {
  const element = document.createElement('option');
  element.value = value;
  element.textContent = label;
  return element;
}

function setupFilters(catalog) {
  const brandFilter = document.querySelector('#brandFilter');
  const platformFilter = document.querySelector('#platformFilter');
  const channelFilter = document.querySelector('#channelFilter');

  for (const product of catalog.products) {
    brandFilter.append(option(product.displayName, product.brandId));
  }
  for (const platform of catalog.platforms) {
    platformFilter.append(option(platformNames[platform] || platform, platform));
  }
  for (const channel of catalog.channels) {
    channelFilter.append(option(channelNames[channel] || channel, channel));
  }

  brandFilter.addEventListener('change', () => {
    state.filters.brand = brandFilter.value;
    renderProducts();
  });
  platformFilter.addEventListener('change', () => {
    state.filters.platform = platformFilter.value;
    renderProducts();
  });
  channelFilter.addEventListener('change', () => {
    state.filters.channel = channelFilter.value;
    renderProducts();
  });
}

function releaseMatches(release) {
  const { platform, channel } = state.filters;
  return (platform === 'all' || release.platform === platform) &&
    (channel === 'all' || release.channel === channel);
}

// Resolve signing config for a brand+platform: per-brand override wins, else
// the platform default, else a safe unsigned fallback.
function resolveSigning(brandId, platform) {
  const signing = state.signing || {};
  const override = (signing.overrides || {})[`${brandId}/${platform}`];
  const fallback = (signing.defaults || {})[platform];
  return override || fallback || { signed: false, appName: 'the app', unsigned: null };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderProducts() {
  const grid = document.querySelector('#productGrid');
  grid.replaceChildren();

  const products = state.catalog.products.filter((product) =>
    state.filters.brand === 'all' || product.brandId === state.filters.brand,
  );

  let rendered = 0;
  for (const product of products) {
    const releases = product.releases.filter(releaseMatches);

    const card = el('article', 'product-card');
    card.id = product.brandId;

    const head = el('div', 'product-head');
    const icon = el('div', 'product-icon');
    icon.dataset.initial = product.displayName.slice(0, 1).toUpperCase();
    const headText = el('div');
    headText.append(el('h3', null, product.displayName));
    headText.append(el('p', 'product-meta',
      [product.organisation, product.launchEnvironment].filter(Boolean).join(' · ')));
    head.append(icon, headText);
    card.append(head);
    card.append(el('p', 'product-summary', product.summary || 'Contract-driven Eutopia product.'));

    const list = el('div', 'release-list');
    if (releases.length === 0) {
      const empty = el('div', 'release-row');
      const left = el('div');
      left.append(el('strong', null, 'No matching builds yet'));
      left.append(el('span', null, 'Publish release metadata to list downloads here.'));
      empty.append(left);
      list.append(empty);
    } else {
      list.append(el('h4', 'release-section-title', 'Latest builds'));
      for (const release of releases.slice(0, 8)) {
        list.append(deliveryCard(product, release));
      }
    }

    const stable = (product.latestStable || []).filter(releaseMatches);
    if (stable.length > 0) {
      list.append(el('h4', 'release-section-title', 'Last stable versions'));
      for (const release of stable.slice(0, 3)) {
        list.append(deliveryCard(product, release));
      }
    }

    card.append(list);
    grid.append(card);
    rendered += 1;
  }

  if (rendered === 0) {
    grid.append(el('p', 'empty-state', 'No products match the selected filters.'));
  }
}

// One delivery = a specific brand · platform · channel build. Enhanced beyond
// a bare download: shows the platform/channel/version, the bundled daemon, and
// either a store badge (signed) or an expandable install guide (unsigned).
function deliveryCard(product, release) {
  const sign = resolveSigning(product.brandId, release.platform);
  const card = el('div', 'delivery');

  const header = el('div', 'delivery-head');
  const id = el('div', 'delivery-id');
  const glyph = el('span', 'delivery-glyph', platformGlyph[release.platform] || '◆');
  const titles = el('div');
  titles.append(el('strong', null,
    `${platformNames[release.platform] || release.platform} · ${channelNames[release.channel] || release.channel}`));
  const sub = release.version
    ? `v${release.version} · build ${release.buildId || 0} · ${channelBlurb[release.channel] || ''}`
    : (channelBlurb[release.channel] || 'Release metadata available');
  titles.append(el('span', null, sub));
  if (release.epndVersion) {
    titles.append(el('span', 'delivery-daemon', `bundled epnd ${String(release.epndVersion).slice(0, 12)}`));
  }
  id.append(glyph, titles);
  header.append(id);

  const badge = el('span', `delivery-badge ${sign.signed ? 'is-signed' : 'is-unsigned'}`,
    sign.signed ? 'Store-signed' : 'Unsigned build');
  header.append(badge);
  card.append(header);

  // ── Action area ────────────────────────────────────────────────────────────
  const actions = el('div', 'delivery-actions');

  if (sign.signed && sign.store) {
    // Signed: show the official store badge linking to the store listing.
    const storeLink = el('a', 'store-badge');
    storeLink.href = sign.store.url || '#';
    storeLink.rel = 'noopener';
    storeLink.target = '_blank';
    storeLink.append(el('span', 'store-badge-eyebrow', sign.store.eyebrow || 'Get it on'));
    storeLink.append(el('span', 'store-badge-name', sign.store.name || 'Store'));
    actions.append(storeLink);
    // Direct download still offered as a secondary option.
    if (release.assetUrl) {
      const dl = el('a', 'download-link secondary', 'Direct download');
      dl.href = release.assetUrl;
      actions.append(dl);
    }
  } else {
    // Unsigned: primary download + an expandable install guide.
    const dl = el('a', 'download-link', release.assetUrl ? 'Download' : 'Details');
    dl.href = release.assetUrl || '#';
    if (!release.assetUrl) dl.setAttribute('aria-disabled', 'true');
    actions.append(dl);

    if (sign.unsigned) {
      const toggle = el('button', 'install-toggle', 'How to install ▾');
      toggle.type = 'button';
      actions.append(toggle);
      const guide = installGuide(sign, release);
      guide.hidden = true;
      toggle.addEventListener('click', () => {
        guide.hidden = !guide.hidden;
        toggle.textContent = guide.hidden ? 'How to install ▾' : 'Hide instructions ▴';
      });
      card.append(actions);
      card.append(guide);
      return card;
    }
  }

  card.append(actions);
  return card;
}

function installGuide(sign, release) {
  const appName = sign.appName || 'the app';
  const u = sign.unsigned;
  const guide = el('div', 'install-guide');

  guide.append(el('p', 'install-headline', u.headline || 'Install steps'));
  if (u.reassurance) guide.append(el('p', 'install-reassure', u.reassurance));

  const ol = el('ol', 'install-steps');
  for (const step of (u.steps || [])) ol.append(el('li', null, step));
  guide.append(ol);

  const cmd = (u.command || '').replace('{APP}', appName);
  if (cmd) {
    const box = el('div', 'install-cmd');
    const code = el('code', null, cmd);
    const copy = el('button', 'copy-cmd', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cmd);
        copy.textContent = 'Copied ✓';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1600);
      } catch {
        copy.textContent = 'Copy failed';
      }
    });
    box.append(code, copy);
    guide.append(box);
  }

  if (release.sha256) {
    guide.append(el('p', 'install-sha', `SHA-256: ${release.sha256}`));
  }
  return guide;
}

try {
  const [catalog, signing] = await Promise.all([
    loadJSON('data/catalog.json'),
    loadJSON('data/signing.json', true),
  ]);
  state.catalog = catalog;
  state.signing = signing;
  setupFilters(state.catalog);
  renderProducts();
} catch (error) {
  const grid = document.querySelector('#productGrid');
  grid.append(el('p', 'empty-state', 'Catalog data is not generated yet. Run tools/generate-catalog.mjs.'));
  console.error(error);
}
