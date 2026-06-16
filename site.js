const state = {
  catalog: null,
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

const channelNames = {
  nightly: 'Nightly',
  weekly: 'Weekly',
  'bi-weekly': 'Bi-weekly',
  stable: 'Stable',
};

async function loadCatalog() {
  const response = await fetch('data/catalog.json', { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Catalog unavailable: ${response.status}`);
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

function renderProducts() {
  const grid = document.querySelector('#productGrid');
  const productTemplate = document.querySelector('#productTemplate');
  const releaseTemplate = document.querySelector('#releaseTemplate');
  grid.replaceChildren();

  const products = state.catalog.products.filter((product) =>
    state.filters.brand === 'all' || product.brandId === state.filters.brand,
  );

  let rendered = 0;
  for (const product of products) {
    const releases = product.releases.filter(releaseMatches);
    const clone = productTemplate.content.cloneNode(true);
    const card = clone.querySelector('.product-card');
    const icon = clone.querySelector('.product-icon');
    const title = clone.querySelector('h3');
    const meta = clone.querySelector('.product-meta');
    const summary = clone.querySelector('.product-summary');
    const releaseList = clone.querySelector('.release-list');

    icon.dataset.initial = product.displayName.slice(0, 1).toUpperCase();
    title.textContent = product.displayName;
    meta.textContent = [
      product.organisation,
      product.launchEnvironment,
    ].filter(Boolean).join(' · ');
    summary.textContent = product.summary || 'Contract-driven Eutopia product.';

    if (releases.length === 0) {
      const row = releaseTemplate.content.cloneNode(true);
      row.querySelector('strong').textContent = 'No matching builds yet';
      row.querySelector('span').textContent = 'Publish release metadata to list downloads here.';
      const link = row.querySelector('a');
      link.textContent = 'Pending';
      link.setAttribute('aria-disabled', 'true');
      releaseList.append(row);
    } else {
      releaseList.append(sectionLabel('Latest builds'));
      for (const release of releases.slice(0, 8)) {
        releaseList.append(releaseRow(releaseTemplate, release));
      }
    }

    const stable = (product.latestStable || []).filter(releaseMatches);
    if (stable.length > 0) {
      releaseList.append(sectionLabel('Last stable versions'));
      for (const release of stable.slice(0, 3)) {
        releaseList.append(releaseRow(releaseTemplate, release));
      }
    }

    card.id = product.brandId;
    grid.append(clone);
    rendered += 1;
  }

  if (rendered === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No products match the selected filters.';
    grid.append(empty);
  }
}

function sectionLabel(text) {
  const element = document.createElement('h4');
  element.className = 'release-section-title';
  element.textContent = text;
  return element;
}

function releaseRow(template, release) {
  const row = template.content.cloneNode(true);
  row.querySelector('strong').textContent = [
    platformNames[release.platform] || release.platform,
    channelNames[release.channel] || release.channel,
  ].join(' · ');
  row.querySelector('span').textContent = release.version
    ? `v${release.version} · build ${release.buildId || 0}`
    : 'Release metadata available';
  const link = row.querySelector('a');
  link.href = release.assetUrl || '#';
  link.textContent = release.assetName ? 'Download' : 'Details';
  if (!release.assetUrl) link.setAttribute('aria-disabled', 'true');
  return row;
}

try {
  state.catalog = await loadCatalog();
  setupFilters(state.catalog);
  renderProducts();
} catch (error) {
  const grid = document.querySelector('#productGrid');
  const empty = document.createElement('p');
  empty.className = 'empty-state';
  empty.textContent = 'Catalog data is not generated yet. Run tools/generate-catalog.mjs.';
  grid.append(empty);
  console.error(error);
}
