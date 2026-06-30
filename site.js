const state = {
  catalog: null,
  signing: null,
  matrix: null,
  releaseLookup: new Map(),
  releaseTrigger: null,
  filters: {
    brand: "all",
    platform: detectPlatform(),
    channel: "stable",
  },
};

const focusableSelectors = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

const platformNames = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
  android: "Android",
  web: "Web",
};

const channelNames = {
  stable: "Stable",
  weekly: "Weekly",
  "bi-weekly": "Bi-weekly",
  nightly: "Nightly",
};

const channelOrder = ["stable", "weekly", "bi-weekly", "nightly"];

async function loadJSON(path, optional = false) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    if (optional) return null;
    throw new Error(`${path} unavailable: ${response.status}`);
  }
  return response.json();
}

function detectPlatform() {
  const source = [
    navigator.userAgentData?.platform,
    navigator.platform,
    navigator.userAgent,
  ].join(" ").toLowerCase();

  if (source.includes("win")) return "windows";
  if (source.includes("mac")) return "macos";
  if (source.includes("linux")) return "linux";
  if (source.includes("android")) return "android";
  return "web";
}

function allReleases(product) {
  return [...(product.latestStable || []), ...(product.releases || [])];
}

function resolveSigning(brandId, platform) {
  const signing = state.signing || {};
  const override = (signing.overrides || {})[`${brandId}/${platform}`];
  const fallback = (signing.defaults || {})[platform];
  return override || fallback || { signed: false, unsigned: null };
}

function plannedPlatforms(product) {
  if (!state.matrix?.brands?.includes(product.brandId)) {
    return [];
  }
  return state.matrix.platforms || [];
}

function releaseScore(release, preferredPlatform, preferredChannel) {
  const preferredChannelRank = [
    preferredChannel,
    ...channelOrder.filter((channel) => channel !== preferredChannel),
  ].indexOf(release.channel);

  return (
    (release.platform === preferredPlatform ? 100 : 0) +
    (release.channel === preferredChannel ? 30 : 0) +
    (release.channel === "stable" ? 20 : 0) +
    (channelOrder.length - preferredChannelRank) * 5 +
    Number(release.buildId || 0) / 1000 +
    (release.generatedAt ? new Date(release.generatedAt).getTime() / 1e16 : 0)
  );
}

function featuredRelease(product) {
  const releases = allReleases(product);
  if (!releases.length) return null;
  return [...releases].sort((left, right) =>
    releaseScore(right, state.filters.platform, state.filters.channel) -
    releaseScore(left, state.filters.platform, state.filters.channel),
  )[0];
}

function fmtDate(value) {
  return value ? new Date(value).toLocaleString() : "Unknown";
}

function fmtCount(value) {
  return Number(value ?? 0).toLocaleString();
}

function daysSince(value) {
  if (!value) return null;
  const now = new Date(state.catalog?.generatedAt || Date.now());
  const then = new Date(value);
  return Math.max(0, Math.round((now - then) / 86400000));
}

function ageLabel(value) {
  const days = daysSince(value);
  if (days == null) return "Unknown age";
  if (days === 0) return "Built today";
  if (days === 1) return "Built 1 day ago";
  return `Built ${days} days ago`;
}

function maturityLabel(product) {
  const releases = allReleases(product);
  const stable = releases.some((release) => release.channel === "stable");
  const weekly = releases.some((release) => release.channel === "weekly");
  if (!releases.length) return { label: "Listed", tone: "cool-gray" };
  if (stable) return { label: "Shipping", tone: "green" };
  if (weekly) return { label: "Preview", tone: "blue" };
  return { label: "Nightly only", tone: "warm-gray" };
}

function ringLabel(product) {
  const releases = allReleases(product);
  const channels = [...new Set(releases.map((release) => release.channel))];
  if (!channels.length) return "No rings";
  if (channels.includes("stable")) return "Stable available";
  if (channels.includes("weekly") && channels.includes("nightly")) return "Weekly + nightly";
  if (channels.includes("weekly")) return "Weekly only";
  if (channels.includes("nightly")) return "Nightly only";
  return channels.map((channel) => channelNames[channel] || channel).join(", ");
}

function shortSha(value) {
  return value ? String(value).slice(0, 12) : "-";
}

function coverage(product) {
  const planned = plannedPlatforms(product);
  const published = [...new Set(allReleases(product).map((release) => release.platform))];
  return {
    planned,
    published,
    missing: planned.filter((platform) => !published.includes(platform)),
  };
}

function currentProducts() {
  return state.catalog.products.filter((product) =>
    state.filters.brand === "all" || product.brandId === state.filters.brand,
  );
}

function publishedPlatforms(products) {
  return [...new Set(products.flatMap((product) => allReleases(product).map((release) => release.platform)))];
}

function availablePlatformItems() {
  const products = currentProducts();
  const planned = state.filters.brand === "all"
    ? [...new Set((state.matrix?.platforms || []))]
    : plannedPlatforms(products[0] || {});
  const published = publishedPlatforms(products);
  const combined = [...new Set([state.filters.platform, ...published, ...planned])];
  return combined.map((platform) => ({
    id: platform,
    label: platform === detectPlatform() ? `${platformNames[platform] || platform} detected` : (platformNames[platform] || platform),
    disabled: !published.includes(platform),
  }));
}

function availableChannelItems() {
  const products = currentProducts();
  const channels = [...new Set(products.flatMap((product) => allReleases(product).map((release) => release.channel)))];
  const combined = [...new Set(["stable", ...channels])];
  return combined
    .filter((channel) => channelOrder.includes(channel))
    .map((channel) => ({
      id: channel,
      label: channelNames[channel] || channel,
      disabled: !channels.includes(channel),
    }));
}

function firstEnabled(items, preferredId) {
  const preferred = items.find((item) => item.id === preferredId && !item.disabled);
  if (preferred) return preferred.id;
  const first = items.find((item) => !item.disabled);
  return first ? first.id : preferredId;
}

function syncFilterAvailability() {
  const platformItems = availablePlatformItems();
  const channelItems = availableChannelItems();
  state.filters.platform = firstEnabled(platformItems, state.filters.platform);
  state.filters.channel = firstEnabled(channelItems, state.filters.channel);
}

function releaseKey(product, release) {
  return [product.brandId, release.platform, release.channel, release.buildId || 0].join("|");
}

function primeReleaseLookup() {
  state.releaseLookup = new Map();
  for (const product of state.catalog.products) {
    for (const release of allReleases(product)) {
      state.releaseLookup.set(releaseKey(product, release), { product, release });
    }
  }
}

function heroStats() {
  const products = state.catalog.products || [];
  const releases = products.flatMap(allReleases);
  const shippingBrands = products.filter((product) => allReleases(product).length > 0).length;
  const signedBuilds = releases.filter((release) => resolveSigning(release.brandId, release.platform).signed).length;
  const latestPublished = releases.reduce((latest, release) => {
    if (!release.generatedAt) return latest;
    return !latest || new Date(release.generatedAt) > new Date(latest.generatedAt) ? release : latest;
  }, null);
  const plannedPairs = (state.matrix?.brands || []).length * (state.matrix?.platforms || []).length;
  const publishedPairs = new Set(releases.map((release) => `${release.brandId}/${release.platform}`)).size;
  const stableBuilds = releases.filter((release) => release.channel === "stable").length;
  const catalogLag = latestPublished ? daysSince(latestPublished.generatedAt) : null;

  document.querySelector("#heroStats").innerHTML = [
    stat("Brands shipping", `${shippingBrands}/${products.length}`),
    stat("Published builds", fmtCount(releases.length)),
    stat("Coverage", plannedPairs ? `${publishedPairs}/${plannedPairs}` : fmtCount(publishedPairs)),
    stat("Latest artifact", latestPublished ? ageLabel(latestPublished.generatedAt) : "No builds"),
  ].join("");

  const summary = document.querySelector("#catalogSummary");
  if (summary) {
    summary.textContent = `Catalog generated ${fmtDate(state.catalog.generatedAt)}. Latest published artifact is ${catalogLag == null ? "unknown" : `${catalogLag} day${catalogLag === 1 ? "" : "s"} old`}. ${stableBuilds === 0 ? "No stable builds are currently published, so recommendations fall back to preview rings." : `${stableBuilds} stable build${stableBuilds === 1 ? "" : "s"} available.`}`;
  }
}

function stat(label, value) {
  return `<div class="catalog-stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function buildSwitchers() {
  syncFilterAvailability();

  buildSwitcher("#brandFilter", [
    { id: "all", label: "All" },
    ...state.catalog.products.map((product) => ({ id: product.brandId, label: product.displayName })),
  ], state.filters.brand, (id) => {
    state.filters.brand = id;
    buildSwitchers();
    renderCatalog();
  });

  buildSwitcher("#platformFilter", availablePlatformItems(), state.filters.platform, (id) => {
    state.filters.platform = id;
    buildSwitchers();
    renderCatalog();
  });

  buildSwitcher("#channelFilter", availableChannelItems(), state.filters.channel, (id) => {
    state.filters.channel = id;
    buildSwitchers();
    renderCatalog();
  });
}

function buildSwitcher(selector, items, selectedId, onSelect) {
  const root = document.querySelector(selector);
  root.replaceChildren();

  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cds--content-switcher-btn${item.id === selectedId ? " cds--content-switcher--selected" : ""}`;
    button.setAttribute("aria-pressed", item.id === selectedId ? "true" : "false");
    button.setAttribute("aria-disabled", item.disabled ? "true" : "false");
    button.disabled = Boolean(item.disabled);
    button.innerHTML = `<span class="cds--content-switcher__label">${item.label}</span>`;
    if (item.disabled) {
      button.title = "Not available for the current brand selection";
    }
    if (!item.disabled) {
      button.addEventListener("click", () => onSelect(item.id));
    }
    root.append(button);
  });
}

function renderCatalog() {
  const grid = document.querySelector("#brandGrid");
  const summary = document.querySelector("#catalogSummary");
  grid.replaceChildren();

  const products = state.catalog.products.filter((product) =>
    state.filters.brand === "all" || product.brandId === state.filters.brand,
  );

  let visibleBuilds = 0;
  let missingPairs = 0;
  let brandsOutsideCadence = 0;

  for (const product of products) {
    const releases = allReleases(product);
    visibleBuilds += releases.length;
    missingPairs += coverage(product).missing.length;
    if (!plannedPlatforms(product).length) brandsOutsideCadence += 1;
    if (!releases.length) {
      grid.append(emptyBrand(product));
      continue;
    }
    grid.append(brandCard(product));
  }

  const stableFallback = state.filters.channel === "stable"
    ? " Stable-first will fall back automatically when a brand has no stable build."
    : "";
  summary.textContent = `${fmtCount(products.length)} brands in view, ${fmtCount(visibleBuilds)} published builds, ${fmtCount(missingPairs)} planned desktop gaps still unfilled, ${fmtCount(brandsOutsideCadence)} listed brand${brandsOutsideCadence === 1 ? "" : "s"} outside the declared desktop cadence.${stableFallback}`;
}

function buildDownloadAction(product, release, buttonClass = "cds--btn cds--btn--primary") {
  const signing = resolveSigning(product.brandId, release.platform);
  if (signing.signed) {
    return `<a class="${buttonClass}" href="${release.assetUrl || "#"}">Download</a>`;
  }

  return `<button type="button" class="${buttonClass} catalog-download-trigger" data-release-key="${releaseKey(product, release)}">Download</button>`;
}

function emptyBrand(product) {
  const maturity = maturityLabel(product);
  const inCadence = plannedPlatforms(product).length > 0;
  const section = document.createElement("section");
  section.className = "cds--tile cds--tile--light catalog-brand-empty";
  section.innerHTML = `
    <p class="catalog-panel-label">Brand not yet shipping</p>
    <h3>${product.displayName}</h3>
    <div class="catalog-tag-row">
      <span class="cds--tag cds--tag--${maturity.tone}">${maturity.label}</span>
      <span class="cds--tag cds--tag--cool-gray">0 published builds</span>
      <span class="cds--tag ${inCadence ? "cds--tag--blue" : "cds--tag--warm-gray"}">${inCadence ? "Desktop cadence declared" : "Not in desktop cadence matrix"}</span>
    </div>
    <p class="catalog-brand-summary">${product.summary || "No public releases have been published for this brand yet."}</p>
  `;
  return section;
}

function brandCard(product) {
  const featured = featuredRelease(product);
  const releases = allReleases(product);
  const alternates = releases
    .filter((release) => release !== featured)
    .sort((left, right) =>
      releaseScore(right, state.filters.platform, state.filters.channel) -
      releaseScore(left, state.filters.platform, state.filters.channel),
    );

  const section = document.createElement("section");
  section.className = "cds--tile catalog-brand-card";

  const stableCount = releases.filter((release) => release.channel === "stable").length;
  const signedCount = releases.filter((release) => resolveSigning(product.brandId, release.platform).signed).length;
  const productCoverage = coverage(product);
  const maturity = maturityLabel(product);
  const sourceCommitCount = new Set(releases.map((release) => release.sourceCommit).filter(Boolean)).size;
  const contractsCommitCount = new Set(releases.map((release) => release.contractsCommit).filter(Boolean)).size;
  const stableFallback = state.filters.channel === "stable" && stableCount === 0;
  const hasBundledDaemon = releases.some((release) => release.epndVersion);
  const catalogLag = daysSince(featured.generatedAt);
  const inCadence = plannedPlatforms(product).length > 0;
  const featuredSigning = resolveSigning(product.brandId, featured.platform);

  section.innerHTML = `
    <div>
      <div class="catalog-brand-head">
        <p class="catalog-panel-label">${product.organisation || "Brand"}</p>
        <h3>${product.displayName}</h3>
        <div class="catalog-brand-meta">${product.productName || product.displayName} | ${product.launchEnvironment || "No launch environment listed"}</div>
        <p class="catalog-brand-summary">${product.summary || "Contract-driven product release channel."}</p>
      </div>

      <div class="catalog-tag-row">
        <span class="cds--tag cds--tag--${maturity.tone}">${maturity.label}</span>
        <span class="cds--tag cds--tag--blue">Coverage ${productCoverage.published.length}/${productCoverage.planned.length || productCoverage.published.length}</span>
        <span class="cds--tag cds--tag--green">${signedCount} signed</span>
        <span class="cds--tag cds--tag--cool-gray">${ringLabel(product)}</span>
        <span class="cds--tag ${inCadence ? "cds--tag--blue" : "cds--tag--warm-gray"}">${inCadence ? "Cadence declared" : "Outside cadence matrix"}</span>
        ${hasBundledDaemon ? '<span class="cds--tag cds--tag--purple">Bundled daemon</span>' : ""}
        ${stableFallback ? '<span class="cds--tag cds--tag--warm-gray">Stable unavailable, fallback active</span>' : ""}
      </div>

      <div class="catalog-brand-metrics">
        <div class="catalog-metric">
          <span>Home app</span>
          <strong>${product.homeApp || "-"}</strong>
        </div>
        <div class="catalog-metric">
          <span>Builds</span>
          <strong>${fmtCount(releases.length)}</strong>
        </div>
        <div class="catalog-metric">
          <span>Artifact age</span>
          <strong>${ageLabel(featured.generatedAt).replace("Built ", "")}</strong>
        </div>
        <div class="catalog-metric">
          <span>Source revisions</span>
          <strong>${sourceCommitCount}</strong>
        </div>
        <div class="catalog-metric">
          <span>Contract revisions</span>
          <strong>${contractsCommitCount}</strong>
        </div>
      </div>

      ${productCoverage.missing.length ? `
        <div class="catalog-note">
          Planned desktop coverage is incomplete: ${productCoverage.missing.map((platform) => platformNames[platform] || platform).join(", ")} not yet published.
        </div>
      ` : ""}
      ${catalogLag != null && catalogLag >= 3 ? `
        <div class="catalog-note">
          Artifact freshness is aging: the newest public build for this brand is ${catalogLag} days old even though the catalog itself is newer.
        </div>
      ` : ""}
    </div>

    <div class="catalog-featured">
      <div>
        <p class="catalog-panel-label">Recommended build</p>
        <h4>${platformNames[featured.platform] || featured.platform} | ${channelNames[featured.channel] || featured.channel}</h4>
        <div class="catalog-featured-meta">
          <span>Version ${featured.version || "?"} | build ${featured.buildId || 0}</span>
          <span>${ageLabel(featured.generatedAt)} | published ${fmtDate(featured.generatedAt)}</span>
          <span>Source ${shortSha(featured.sourceCommit)} | contracts ${shortSha(featured.contractsCommit)}</span>
          ${featured.epndVersion ? `<span>Bundled epnd ${shortSha(featured.epndVersion)}</span>` : ""}
        </div>
      </div>

      <div class="catalog-tag-row">
        <span class="cds--tag ${featuredSigning.signed ? "cds--tag--green" : "cds--tag--warm-gray"}">${featuredSigning.signed ? "Signed" : "Unsigned"}</span>
        <span class="cds--tag cds--tag--blue">${platformNames[featured.platform] || featured.platform}</span>
        <span class="cds--tag cds--tag--cool-gray">${channelNames[featured.channel] || featured.channel}</span>
        ${featured.sha256 ? '<span class="cds--tag cds--tag--cool-gray">SHA-256 published</span>' : ""}
      </div>

      <div class="catalog-featured-actions">
        ${buildDownloadAction(product, featured)}
        <a class="cds--btn cds--btn--ghost" href="https://github.com/50gramx/eapp-releases/releases/tag/${featured.releaseTag || ""}">Release details</a>
      </div>

      ${alternates.length ? `
        <div>
          <p class="catalog-panel-label">Other builds</p>
          <div class="catalog-build-pills">
            ${alternates.slice(0, 4).map((release) => buildPill(product, release)).join("")}
          </div>
        </div>
      ` : ""}
    </div>
  `;

  const details = document.createElement("div");
  details.className = "catalog-accordion";
  details.innerHTML = `
    <ul class="cds--accordion">
      <li class="cds--accordion__item">
        <button class="cds--accordion__heading" aria-expanded="false" type="button">
          <svg class="cds--accordion__arrow" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 12L10 8 6 4 4.6 5.4 7.2 8 4.6 10.6z"></path>
          </svg>
          <span class="cds--accordion__title">Browse all published builds and provenance</span>
        </button>
        <div class="cds--accordion__wrapper">
          <div class="cds--accordion__content">
            <div class="catalog-release-list">
              ${releases
                .sort((left, right) =>
                  releaseScore(right, state.filters.platform, state.filters.channel) -
                  releaseScore(left, state.filters.platform, state.filters.channel),
                )
                .map((release) => releaseRow(product, release))
                .join("")}
            </div>
          </div>
        </div>
      </li>
    </ul>
  `;
  wireAccordion(details);
  section.append(details);

  return section;
}

function buildPill(product, release) {
  const signing = resolveSigning(product.brandId, release.platform);
  const action = signing.signed
    ? `<a class="catalog-build-pill" href="${release.assetUrl || "#"}">`
    : `<button type="button" class="catalog-build-pill catalog-download-trigger" data-release-key="${releaseKey(product, release)}">`;
  const close = signing.signed ? "</a>" : "</button>";

  return `
    ${action}
      <div>
        <strong>${platformNames[release.platform] || release.platform} | ${channelNames[release.channel] || release.channel}</strong>
        <span>${ageLabel(release.generatedAt)} | build ${release.buildId || 0}</span>
      </div>
    ${close}
  `;
}

function releaseRow(product, release) {
  const signing = resolveSigning(product.brandId, release.platform);
  const signed = signing.signed;
  return `
    <article class="catalog-release-row">
      <div>
        <h5>${platformNames[release.platform] || release.platform} | ${channelNames[release.channel] || release.channel}</h5>
        <p>Version ${release.version || "?"} | build ${release.buildId || 0}</p>
        <p>${ageLabel(release.generatedAt)} | published ${fmtDate(release.generatedAt)}</p>
        <p>Source ${shortSha(release.sourceCommit)} | contracts ${shortSha(release.contractsCommit)}</p>
        ${release.epndVersion ? `<p>Bundled epnd ${shortSha(release.epndVersion)} | sha ${shortSha(release.epndSha256)}</p>` : ""}
        <div class="catalog-tag-row">
          <span class="cds--tag ${signed ? "cds--tag--green" : "cds--tag--warm-gray"}">${signed ? "Signed" : "Unsigned"}</span>
          ${release.sha256 ? `<span class="cds--tag cds--tag--cool-gray">Artifact sha ${shortSha(release.sha256)}</span>` : ""}
          ${release.stableHistoryPath ? `<span class="cds--tag cds--tag--cool-gray">Stable history path declared</span>` : ""}
        </div>
      </div>
      <div>
        ${buildDownloadAction(product, release, "cds--btn cds--btn--secondary")}
      </div>
    </article>
  `;
}

function wireAccordion(root) {
  const button = root.querySelector(".cds--accordion__heading");
  const item = root.querySelector(".cds--accordion__item");
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", expanded ? "false" : "true");
    item.classList.toggle("cds--accordion__item--active", !expanded);
  });
}

function closeDownloadModal() {
  const modal = document.querySelector("#downloadModal");
  modal.hidden = true;
  document.body.classList.remove("catalog-modal-open");
  if (state.releaseTrigger instanceof HTMLElement) {
    state.releaseTrigger.focus();
  }
  state.releaseTrigger = null;
}

function openDownloadModal(key, trigger = null) {
  const entry = state.releaseLookup.get(key);
  if (!entry) return;
  const { product, release } = entry;
  const signing = resolveSigning(product.brandId, release.platform);
  if (signing.signed) {
    window.location.href = release.assetUrl || "#";
    return;
  }

  const modal = document.querySelector("#downloadModal");
  const panel = modal.querySelector(".catalog-modal__panel");
  const title = document.querySelector("#downloadModalTitle");
  const body = document.querySelector("#downloadModalBody");
  const continueLink = document.querySelector("#modalContinueDownload");
  const copyButton = document.querySelector("#modalCopyCommand");
  const unsigned = signing.unsigned || {};
  const command = unsigned.command ? unsigned.command.replace("{APP}", signing.appName || "the app") : "";
  state.releaseTrigger = trigger instanceof HTMLElement ? trigger : document.activeElement;

  title.textContent = `${product.displayName} | ${platformNames[release.platform] || release.platform} | ${channelNames[release.channel] || release.channel}`;
  body.innerHTML = `
    <div class="catalog-modal-copy">
      <p class="catalog-install-title">${unsigned.headline || "Unsigned build guidance"}</p>
      ${unsigned.reassurance ? `<p class="catalog-install-copy">${unsigned.reassurance}</p>` : ""}
      <ol class="catalog-install-steps">${(unsigned.steps || []).map((step) => `<li>${step}</li>`).join("")}</ol>
      ${command ? `<div class="catalog-inline-code"><code>${command}</code></div>` : ""}
      ${release.sha256 ? `<div class="catalog-guide-sha">SHA-256 available in the build metadata for verification.</div>` : ""}
    </div>
  `;
  continueLink.href = release.assetUrl || "#";
  copyButton.hidden = !command;
  copyButton.onclick = async () => {
    try {
      await navigator.clipboard.writeText(command);
      copyButton.textContent = "Copied";
      setTimeout(() => {
        copyButton.textContent = "Copy command";
      }, 1500);
    } catch {
      copyButton.textContent = "Copy failed";
    }
  };
  copyButton.textContent = "Copy command";
  document.body.classList.add("catalog-modal-open");
  modal.hidden = false;
  panel.focus();
}

function wireDownloadModal() {
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest(".catalog-download-trigger");
    if (trigger) {
      openDownloadModal(trigger.dataset.releaseKey, trigger);
      return;
    }
    if (event.target.closest("[data-close-modal='true']")) {
      closeDownloadModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    const modal = document.querySelector("#downloadModal");
    if (event.key === "Escape" && !modal.hidden) {
      closeDownloadModal();
      return;
    }
    if (event.key === "Tab" && !modal.hidden) {
      const focusable = [...modal.querySelectorAll(focusableSelectors)].filter((element) => !element.hasAttribute("hidden"));
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
}

function updateThemeMeta(themeName) {
  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute("content", themeName === "dark" ? "#161616" : "#0f62fe");
  }
}

function wireSystemTheme() {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const syncThemeColor = () => updateThemeMeta(media.matches ? "dark" : "light");
  syncThemeColor();
  media.addEventListener("change", syncThemeColor);
}

try {
  wireSystemTheme();
  const [catalog, signing, matrix] = await Promise.all([
    loadJSON("data/catalog.json"),
    loadJSON("data/signing.json", true),
    loadJSON("data/brand-platform-matrix.json", true),
  ]);
  state.catalog = catalog;
  state.signing = signing;
  state.matrix = matrix;
  primeReleaseLookup();
  heroStats();
  buildSwitchers();
  renderCatalog();
  wireDownloadModal();
} catch (error) {
  document.querySelector("#brandGrid").innerHTML = `
    <section class="cds--tile cds--tile--light catalog-brand-empty">
      <p class="catalog-panel-label">Catalog unavailable</p>
      <h3>Generated data is missing</h3>
      <p class="catalog-brand-summary">Run the catalog generation step and refresh this page.</p>
    </section>
  `;
  console.error(error);
}
