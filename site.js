// The releases page. Everything about a brand -- its name, summary, logo,
// category, rating, website, store links, which platforms it is planned for,
// and who may try it early -- comes from data/catalog.json, which
// tools/generate-catalog.mjs builds from the brand contracts and each build's
// release-metadata.json. Nothing about any brand is written here.
//
// Two views from one file: the home grid (index.html) and one app's page
// (apps/<brand>/index.html, where <body data-app="<brand>">).

// One tap lands in the same applications as the app's "Apply for a Private
// Space" form (bharatsphere mohallaApplications.submitInterest); the longer
// journey for an organisation or a brand is 50gramx.com/apply.
const INTEREST_URL = "https://us-central1-bharatsphere-183e7.cloudfunctions.net/submitInterest";
const JOURNEY_URL = "https://50gramx.com/apply";
const CONTACT_KEY = "epn-interest-contact";

const state = {
  catalog: null,
  signing: null,
  network: null,
  device: detectDevice(),
  channel: "stable",
  category: "",
  lookup: new Map(),
  app: document.body.dataset.app || "",
};

const platformNames = {
  android: "Android",
  ios: "iPhone & iPad",
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
  web: "Web",
};
const platformOrder = ["android", "ios", "macos", "windows", "linux", "web"];
const channelNames = { stable: "Stable", weekly: "Weekly", "bi-weekly": "Bi-weekly", nightly: "Nightly" };
const channelOrder = ["stable", "weekly", "bi-weekly", "nightly"];

// Plain glyphs for each platform (device shapes, not anyone's logo).
const icon = {
  android: '<path d="M7 9.5a5 5 0 0 1 10 0V17H7z"/><path d="M8.5 5.5 7 3.5M15.5 5.5 17 3.5"/><circle cx="10" cy="10" r=".6"/><circle cx="14" cy="10" r=".6"/>',
  ios: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  macos: '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2.5 19h19"/>',
  windows: '<path d="M4 5.5 11 4.5v7H4zM13 4.2l7-1v8.3h-7zM4 13.5h7v7l-7-1zM13 13.5h7v7.5l-7-1z"/>',
  linux: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="m7 10 3 2.5L7 15M12.5 15.5H17"/>',
  web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>',
};
const glyph = (platform, size = 18) =>
  `<svg class="glyph" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon[platform] || ""}</svg>`;

// Which store serves which platform, and its badge. Official badge artwork is
// kept in brand-assets/stores; a store without one gets a plain badge.
const storeInfo = {
  "play-store": { platform: "android", label: "Get it on Google Play", img: "brand-assets/stores/google-play.png", cls: "store--play" },
  "app-store": { platform: "ios", label: "Download on the App Store", img: "brand-assets/stores/app-store.svg" },
  testflight: { platform: "ios", label: "Test it on TestFlight" },
  "mac-app-store": { platform: "macos", label: "Download on the Mac App Store" },
  "microsoft-store": { platform: "windows", label: "Get it from Microsoft", img: "brand-assets/stores/microsoft-store.svg" },
};

const tierInfo = {
  alpha: { label: "Alpha", hint: "Early trials, first to see new things" },
  beta: { label: "Beta", hint: "Test builds through the stores (TestFlight, Play testing)" },
  gamma: { label: "For my organisation", hint: "Private to your people, through your own gramx store" },
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (value) => (/^https:\/\//.test(String(value || "")) ? String(value) : "");
const slug = (value) => String(value).trim().toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "product";
const appHref = (product) => `apps/${slug(product.brandId)}/`;

function detectDevice() {
  const ua = navigator.userAgent.toLowerCase();
  const touchMac = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  if (/android/.test(ua)) return "android";
  if (/iphone|ipad|ipod/.test(ua) || touchMac) return "ios";
  if (/mac/.test(ua)) return "macos";
  if (/win/.test(ua)) return "windows";
  if (/linux|x11|cros/.test(ua)) return "linux";
  return "web";
}

function rememberedContact() {
  try { return localStorage.getItem(CONTACT_KEY) || ""; } catch { return ""; }
}
function rememberContact(value) {
  try { localStorage.setItem(CONTACT_KEY, value); } catch { /* private mode: ask again next time */ }
}

async function loadJSON(path, optional = false) {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return await response.json();
  } catch (error) {
    if (optional) return null;
    throw error;
  }
}

// ── facts ──────────────────────────────────────────────────────────────────

function releasesOf(product) {
  const seen = new Set();
  return [...(product.latestStable || []), ...(product.releases || [])].filter((r) => {
    const k = [r.platform, r.channel, r.buildId, r.assetName].join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// The build to offer for a platform: the chosen channel if there is one,
// else the steadiest channel that exists.
function bestFor(product, platform) {
  const builds = releasesOf(product).filter((r) => r.platform === platform);
  if (!builds.length) return null;
  const order = [state.channel, ...channelOrder.filter((c) => c !== state.channel)];
  const rank = (r) => {
    const i = order.indexOf(r.channel);
    return (i < 0 ? 99 : i) * 1e7 - Number(r.buildId || 0);
  };
  return [...builds].sort((a, b) => rank(a) - rank(b))[0];
}

function guidanceFor(brandId, platform) {
  const s = state.signing || {};
  return (s.overrides || {})[`${brandId}/${platform}`] || (s.defaults || {})[platform] || { signed: false, unsigned: null };
}

// Signed or not, as the build that made it recorded; builds from before that
// was recorded fall back to the guidance table.
function signingOf(release) {
  if (release.signing) {
    return {
      release: { label: "Signed", tone: "good", note: "Signed with the brand's own key." },
      debug: { label: "Test-signed", tone: "warn", note: "Signed with a throwaway test key; it installs, but cannot update a store copy." },
      "ad-hoc": { label: "Not notarized", tone: "warn", note: "Signed on the build machine only; macOS will ask you to confirm." },
      none: { label: "Unsigned", tone: "warn", note: "Not signed; follow the install steps." },
    }[release.signing] || { label: "Unsigned", tone: "warn", note: "" };
  }
  return guidanceFor(release.brandId, release.platform).signed
    ? { label: "Signed", tone: "good", note: "" }
    : { label: "Unsigned", tone: "warn", note: "Follow the install steps." };
}

function storeFor(product, platform) {
  return (product.stores || []).find((s) => storeInfo[s.store]?.platform === platform && safeUrl(s.url)) || null;
}

// What one platform looks like for one app, the same way everywhere on the
// page: in a store, live on the web, a build (with its signature), coming
// (planned in the contract), or not planned.
function platformState(product, platform) {
  const store = storeFor(product, platform);
  const release = bestFor(product, platform);
  if (platform === "web" && product.webApp) return { kind: "web", label: "Live", tone: "good", release };
  if (store) return { kind: "store", label: "In store", tone: "good", store, release };
  if (release) {
    const sig = signingOf(release);
    return { kind: "build", label: sig.label, tone: sig.tone, sig, release };
  }
  if ((product.planned || []).includes(platform)) return { kind: "planned", label: "Coming", tone: "quiet" };
  return { kind: "none", label: "Not planned", tone: "off" };
}

function keyFor(product, release) {
  const key = `${product.brandId}|${release.platform}|${release.channel}|${release.buildId}`;
  state.lookup.set(key, { product, release, sig: signingOf(release) });
  return key;
}

function ago(value) {
  if (!value) return "";
  const days = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 86400000));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
const isOld = (value) => value && Date.now() - new Date(value).getTime() > 60 * 86400000;

function bytes(n) {
  if (typeof n !== "number" || !n) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

const short = (sha) => (sha ? String(sha).slice(0, 10) : "–");
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

// ── shared pieces ──────────────────────────────────────────────────────────

function logoOf(product, size = 56) {
  const title = product.logoGenerated ? ` title="A mark drawn from the app's id; the brand has not added its own logo yet"` : "";
  return `<img class="logo" src="${esc(product.logo)}" alt="" width="${size}" height="${size}" loading="lazy"${title}>`;
}

function ratingChip(product) {
  if (product.ageRating) {
    const by = product.ratingAuthority ? ` by ${product.ratingAuthority}` : "";
    return `<span class="rating" title="Rated ${esc(product.ageRating)}${esc(by)}">${esc(product.ageRating)}</span>`;
  }
  return `<span class="rating rating--none" title="No age rating has been issued for this app yet">Not yet rated</span>`;
}

function storeBadges(product, onlyPlatform = null) {
  return (product.stores || [])
    .filter((s) => storeInfo[s.store] && safeUrl(s.url) && (!onlyPlatform || storeInfo[s.store].platform === onlyPlatform))
    .map((s) => {
      const info = storeInfo[s.store];
      const inner = info.img
        ? `<img src="${esc(info.img)}" alt="${esc(info.label)}" height="44">`
        : `<span class="store__text"><small>${esc(platformNames[info.platform])}</small>${esc(info.label)}</span>`;
      return `<a class="store ${info.cls || ""}" href="${esc(safeUrl(s.url))}" rel="noopener" target="_blank">${inner}</a>`;
    })
    .join("");
}

function platformStrip(product) {
  return `<ul class="pstrip" aria-label="Platforms">${platformOrder.map((p) => {
    const s = platformState(product, p);
    return `<li class="pchip pchip--${s.tone}" title="${esc(platformNames[p])}: ${esc(s.label)}">${glyph(p, 16)}<span class="pchip__label">${esc(s.label)}</span><span class="sr">${esc(platformNames[p])}</span></li>`;
  }).join("")}</ul>`;
}

function primaryAction(product) {
  const platform = state.device;
  const s = platformState(product, platform);
  const name = platformNames[platform];
  if (s.kind === "store") return "";
  if (s.kind === "web") return `<a class="btn btn--primary btn--big" href="${esc(product.webApp)}" rel="noopener" target="_blank">Open ${esc(product.displayName)}</a>`;
  if (s.kind === "build") return `<button type="button" class="btn btn--primary btn--big" data-get="${esc(keyFor(product, s.release))}">Get it for ${esc(name)}</button>`;
  if (s.kind === "planned") return `<button type="button" class="btn btn--big" data-tier="beta" data-platform="${esc(platform)}" data-brand="${esc(product.brandId)}">Tell me when it's on ${esc(name)}</button>`;
  return `<button type="button" class="btn btn--big" data-tier="feature" data-platform="${esc(platform)}" data-brand="${esc(product.brandId)}">Ask for ${esc(name)}</button>`;
}

function networkStrip() {
  const n = state.network;
  if (!n) return "";
  const parts = [];
  if (n.communities) parts.push(`<b>${n.communities}</b> communities`);
  if (n.peers) parts.push(`<b>${n.peers}</b> peers online`);
  if (n.grams) parts.push(`<b>${n.grams}</b> grams reporting signed results`);
  if (!parts.length) return "";
  return `<a class="net__link" href="status.html"><span class="net__dot" aria-hidden="true"></span><span>EP&amp;N network now: ${parts.join(" · ")} <span aria-hidden="true">→</span></span></a>`;
}

// ── home ───────────────────────────────────────────────────────────────────

function card(product) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.root = product.brandId;
  const meta = [product.category, product.developer].filter(Boolean).map(esc).join(" · ");
  const get = `${storeBadges(product)}${primaryAction(product)}`;
  el.innerHTML = `
    <a class="card__head" href="${appHref(product)}">
      ${logoOf(product)}
      <span class="card__id">
        <span class="card__name">${esc(product.displayName)}</span>
        <span class="card__meta">${meta || "&nbsp;"}</span>
        <span class="card__chips">${ratingChip(product)}${product.distribution === "private" ? `<span class="badge">Private</span>` : ""}</span>
      </span>
    </a>
    <p class="card__summary">${esc(product.summary || "")}</p>
    ${platformStrip(product)}
    ${get ? `<div class="card__get">${get}</div>` : ""}
    <a class="card__more" href="${appHref(product)}">Every platform, details and builds →</a>
    <div class="ask__panel" hidden></div>`;
  return el;
}

function renderHome() {
  state.lookup = new Map();
  const products = [...(state.catalog.products || [])]
    .filter((p) => !state.category || p.category === state.category)
    .sort((a, b) => releasesOf(b).length - releasesOf(a).length || a.displayName.localeCompare(b.displayName));
  const grid = document.querySelector("#grid");
  grid.replaceChildren(...products.map(card));
  if (!products.length) grid.innerHTML = `<p class="loading">No apps listed yet.</p>`;

  const categories = [...new Set((state.catalog.products || []).map((p) => p.category).filter(Boolean))].sort();
  const filters = document.querySelector("#filters");
  filters.innerHTML = categories.length > 1
    ? ["", ...categories].map((c) => `<button type="button" class="pill" data-category="${esc(c)}" aria-pressed="${c === state.category}">${esc(c || "All apps")}</button>`).join("")
    : "";
  const net = document.querySelector("#netStrip");
  net.innerHTML = networkStrip();
  net.hidden = !net.innerHTML;
}

function renderChannels() {
  const present = new Set((state.catalog.products || []).flatMap((p) => releasesOf(p).map((r) => r.channel)));
  const root = document.querySelector("#channelPick");
  if (!root) return;
  root.innerHTML = channelOrder.filter((c) => present.has(c)).map((c) =>
    `<button type="button" class="seg__btn" aria-pressed="${c === state.channel}" data-channel="${c}">${esc(channelNames[c])}</button>`).join("");
  const chip = document.querySelector("#deviceChip");
  if (chip) chip.textContent = `For your ${platformNames[state.device] || "device"}`;
}

// ── one app ────────────────────────────────────────────────────────────────

function platformRow(product, platform) {
  const s = platformState(product, platform);
  const r = s.release;
  const here = platform === state.device ? " prow--here" : "";
  const detail = r
    ? `${esc(channelNames[r.channel] || r.channel)} · v${esc(r.version || "?")} (${esc(r.buildId)}) · <span class="${isOld(r.generatedAt) ? "old" : ""}">${esc(ago(r.generatedAt))}</span>${r.assetSize ? ` · ${esc(bytes(r.assetSize))}` : ""}`
    : s.kind === "planned" ? "Planned in the app's contract; no build yet"
      : s.kind === "none" ? "Not in the app's plans yet" : "";
  let act = "";
  if (s.kind === "store") act = `<a class="btn btn--small btn--primary" href="${esc(safeUrl(s.store.url))}" rel="noopener" target="_blank">Store</a>${r ? `<button type="button" class="btn btn--small" data-get="${esc(keyFor(product, r))}">Build</button>` : ""}`;
  else if (s.kind === "web") act = `<a class="btn btn--small btn--primary" href="${esc(product.webApp)}" rel="noopener" target="_blank">Open</a>`;
  else if (s.kind === "build") act = `<button type="button" class="btn btn--small btn--primary" data-get="${esc(keyFor(product, r))}">Get</button>`;
  else if (s.kind === "planned") act = `<button type="button" class="btn btn--small" data-tier="beta" data-platform="${esc(platform)}" data-brand="${esc(product.brandId)}">Notify me</button>`;
  else act = `<button type="button" class="btn btn--small" data-tier="feature" data-platform="${esc(platform)}" data-brand="${esc(product.brandId)}">Ask for it</button>`;
  const buildSig = (s.kind === "store" || s.kind === "web") && r ? signingOf(r) : null;
  const signNote = buildSig ? ` <span class="badge badge--${buildSig.tone}" title="The direct download build">${esc(buildSig.label)} build</span>` : "";
  return `<li class="prow prow--${s.kind}${here}">
    <span class="prow__plat">${glyph(platform, 22)}<b>${esc(platformNames[platform])}</b>${platform === state.device ? `<i>this device</i>` : ""}</span>
    <span class="prow__state"><span class="badge badge--${s.tone}">${esc(s.label)}</span>${signNote}</span>
    <span class="prow__detail">${detail}</span>
    <span class="prow__act">${act}</span>
  </li>`;
}

function infoRows(product) {
  const builds = releasesOf(product);
  const times = builds.map((r) => r.generatedAt).filter(Boolean).sort();
  const versions = [...new Set(builds.map((r) => r.version).filter(Boolean))];
  const muted = (text) => `<span class="muted">${esc(text)}</span>`;
  const missing = muted("Not declared yet");
  const link = (url) => `<a href="${esc(url)}" rel="noopener" target="_blank">${esc(hostOf(url))} ↗</a>`;
  const rows = [
    ["Category", product.category ? esc(product.category) : missing],
    ["Age rating", product.ageRating
      ? `${esc(product.ageRating)}${product.ratingAuthority ? ` ${muted(`· ${product.ratingAuthority}`)}` : ""}`
      : muted("Not yet rated")],
    ["Interactive elements", product.interactive ? esc(product.interactive) : missing],
    ["Price", "Free"],
    ["Developer", product.developer ? esc(product.developer) : missing],
    ["Version", versions.length ? esc(versions.join(", ")) : muted("No build yet")],
    ["Latest build", times.length ? `${esc(new Date(times.at(-1)).toLocaleDateString())} ${muted(`· ${ago(times.at(-1))}`)}` : muted("–")],
    ["First build here", times.length ? esc(new Date(times[0]).toLocaleDateString()) : muted("–")],
    ["Downloads here", typeof product.downloads === "number" ? `${esc(product.downloads.toLocaleString())} ${muted("· current builds, counted by GitHub")}` : muted("–")],
    ["Distribution", product.distribution === "private" ? "Private, through each organisation's gramx store" : "Public"],
    ["Website", product.website ? link(product.website) : missing],
    ["Privacy policy", product.privacyPolicy ? link(product.privacyPolicy) : missing],
    ["Support", product.support ? link(product.support) : missing],
    ["Logo", product.logoGenerated ? muted("Drawn from the app's id until the brand adds its own") : "From the brand's contract"],
  ];
  return `<dl class="info">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
}

function tryEarly(product) {
  const tiers = (product.access || []).filter((t) => tierInfo[t]);
  return `<div class="ask">
    ${tiers.length ? `<p class="ask__title">Try it early</p>
    <div class="ask__chips">
      ${tiers.map((t) => `<button type="button" class="pill" data-tier="${t}" data-brand="${esc(product.brandId)}" title="${esc(tierInfo[t].hint)}">${esc(tierInfo[t].label)}</button>`).join("")}
    </div>` : ""}
    <p class="ask__title">What do you think?</p>
    <div class="ask__chips">
      <button type="button" class="pill" data-say="like" data-brand="${esc(product.brandId)}" aria-label="I like it">👍 Like it</button>
      <button type="button" class="pill" data-say="dislike" data-brand="${esc(product.brandId)}" aria-label="Not for me">👎 Not for me</button>
      <button type="button" class="pill" data-tier="feature" data-brand="${esc(product.brandId)}">💡 I want a feature</button>
    </div>
    <div class="ask__panel" hidden></div>
  </div>`;
}

function provenance(product) {
  const rows = releasesOf(product)
    .sort((a, b) => platformOrder.indexOf(a.platform) - platformOrder.indexOf(b.platform) || channelOrder.indexOf(a.channel) - channelOrder.indexOf(b.channel))
    .map((r) => {
      const sig = signingOf(r);
      return `<li class="prov__row">
        <div>
          <b>${esc(platformNames[r.platform] || r.platform)} · ${esc(channelNames[r.channel] || r.channel)}</b>
          <span>v${esc(r.version || "?")} build ${esc(r.buildId)} · ${esc(ago(r.generatedAt))}${r.assetSize ? ` · ${esc(bytes(r.assetSize))}` : ""} · <span class="badge badge--${sig.tone}">${esc(sig.label)}</span></span>
          <span class="mono">sha256 ${esc(short(r.sha256))} · source <a href="https://github.com/${esc(r.sourceRepo || "50gramx/eapp-live")}/commit/${esc(r.sourceCommit || "")}">${esc(short(r.sourceCommit))}</a> · contracts <a href="https://github.com/${esc(r.contractsRepo || "50gramx/eapp-interaction-contracts")}/commit/${esc(r.contractsCommit || "")}">${esc(short(r.contractsCommit))}</a>${r.epndVersion ? ` · gram ${esc(short(r.epndVersion))}` : ""}</span>
        </div>
        <div class="prov__acts">
          <a class="link" href="https://github.com/50gramx/eapp-releases/releases/tag/${esc(r.releaseTag || "")}">Release</a>
          <button type="button" class="link" data-get="${esc(keyFor(product, r))}">Get</button>
        </div>
      </li>`;
    });
  if (!rows.length) return "";
  return `<details class="prov"><summary>Every build, with its provenance (${rows.length})</summary><ul>${rows.join("")}</ul></details>`;
}

function renderApp() {
  state.lookup = new Map();
  const product = (state.catalog.products || []).find((p) => p.brandId === state.app);
  const view = document.querySelector("#view");
  if (!product) {
    view.innerHTML = `<p class="loading">This app isn't listed. <a href="./">See every app</a>.</p>`;
    return;
  }
  document.title = `${product.displayName} — 50GRAMx Apps`;
  const builds = releasesOf(product);
  const live = platformOrder.filter((p) => ["build", "store", "web"].includes(platformState(product, p).kind)).length;
  const facts = [
    `<div class="fact">${ratingChip(product)}<span>Age rating</span></div>`,
    `<div class="fact"><b>${esc(product.category || "–")}</b><span>Category</span></div>`,
    `<div class="fact"><b>${live} of ${platformOrder.length}</b><span>Platforms</span></div>`,
    `<div class="fact"><b>Free</b><span>Price</span></div>`,
    typeof product.downloads === "number" ? `<div class="fact"><b>${esc(product.downloads.toLocaleString())}</b><span>Downloads here</span></div>` : "",
  ].join("");
  const channels = channelOrder.filter((c) => builds.some((r) => r.channel === c));
  view.innerHTML = `
    <nav class="crumbs"><a href="./">← All apps</a></nav>
    <section class="app" data-root="${esc(product.brandId)}">
      <header class="app__head">
        ${logoOf(product, 96)}
        <div class="app__id">
          <h1>${esc(product.displayName)}</h1>
          ${product.productName && product.productName !== product.displayName ? `<p class="app__product">${esc(product.productName)}</p>` : ""}
          <p class="app__dev">${esc(product.developer || "")}${product.website ? `${product.developer ? " · " : ""}<a href="${esc(product.website)}" rel="noopener" target="_blank">${esc(hostOf(product.website))} ↗</a>` : ""}</p>
        </div>
      </header>
      <div class="facts">${facts}</div>
      <div class="app__get">
        ${storeBadges(product)}
        ${primaryAction(product)}
      </div>

      <div class="h2row">
        <h2 class="h2">On every platform</h2>
        ${channels.length > 1 ? `<div class="seg" role="group" aria-label="Build channel">${channels.map((c) => `<button type="button" class="seg__btn" aria-pressed="${c === state.channel}" data-channel="${c}">${esc(channelNames[c])}</button>`).join("")}</div>` : ""}
      </div>
      <ul class="prows">${platformOrder.map((p) => platformRow(product, p)).join("")}</ul>

      <h2 class="h2">About this app</h2>
      <p class="app__summary">${esc(product.summary || "")}</p>
      ${product.description ? `<p class="app__desc">${esc(product.description)}</p>` : ""}

      ${tryEarly(product)}

      <h2 class="h2">App information</h2>
      ${infoRows(product)}

      ${networkStrip() ? `<div class="net">${networkStrip()}</div>` : ""}

      ${provenance(product)}
    </section>`;
}

function render() {
  if (state.app) renderApp();
  else { renderChannels(); renderHome(); }
}

// ── getting a build ────────────────────────────────────────────────────────

function openGuide(key) {
  const entry = state.lookup.get(key);
  if (!entry) return;
  const { product, release, sig } = entry;
  const url = safeUrl(release.assetUrl);
  if (sig.tone === "good" && url) {
    window.location.href = url;
    return;
  }
  const guide = guidanceFor(product.brandId, release.platform);
  const u = guide.unsigned || {};
  const command = u.command ? u.command.replace("{APP}", guide.appName || "the app") : "";
  document.querySelector("#guideKicker").textContent = `${product.displayName} · ${platformNames[release.platform] || release.platform} · ${channelNames[release.channel] || release.channel}`;
  document.querySelector("#guideTitle").textContent = u.headline || sig.note || "Before you install";
  document.querySelector("#guideBody").innerHTML = `
    ${sig.note ? `<p class="guide__sig"><span class="badge badge--${sig.tone}">${esc(sig.label)}</span> ${esc(sig.note)}</p>` : ""}
    ${u.reassurance ? `<p>${esc(u.reassurance)}</p>` : ""}
    ${(u.steps || []).length ? `<ol>${u.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}
    ${command ? `<pre class="mono">${esc(command)}</pre>` : ""}
    ${release.assetSize ? `<p class="small">${esc(release.assetName || "")} · ${esc(bytes(release.assetSize))}</p>` : ""}
    ${release.sha256 ? `<p class="mono small">SHA-256 ${esc(release.sha256)}</p>` : ""}`;
  const go = document.querySelector("#guideGo");
  go.href = url || "#";
  const copy = document.querySelector("#guideCopy");
  copy.hidden = !command;
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(command); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
  };
  copy.textContent = "Copy command";
  document.querySelector("#guide").showModal();
}

// ── interest: one tap, one line ────────────────────────────────────────────

async function send(payload) {
  const response = await fetch(INTEREST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, source: "releases-page" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Couldn't send that — try again.");
}

function panelFor(button) {
  const root = button.closest("[data-root]") || document.querySelector(`[data-root="${CSS.escape(button.dataset.brand || "")}"]`);
  return root?.querySelector(".ask__panel") || null;
}

function openAsk(button) {
  const brand = button.dataset.brand;
  const tier = button.dataset.tier;
  const platform = button.dataset.platform || state.device;
  const panel = panelFor(button);
  if (!panel) return;
  const saved = rememberedContact();
  const isFeature = tier === "feature";
  const wantsPlatform = isFeature && Boolean(button.dataset.platform);
  const lead = wantsPlatform
    ? `Tell us you want it on ${platformNames[platform] || platform}; it helps decide what comes next.`
    : isFeature
      ? "What should it do?"
      : tier === "gamma"
        ? "Your organisation gets it privately, through its own gramx store. Leave a way to reach you, or take the full journey."
        : tier === "alpha"
          ? "You'll get early builds before anyone else."
          : `You'll get the test build${platform ? ` for ${platformNames[platform] || platform}` : ""}.`;
  panel.hidden = false;
  panel.innerHTML = `
    <p class="ask__lead">${esc(lead)}</p>
    <div class="ask__line">
      ${isFeature ? `<input class="ask__note" maxlength="600" placeholder="e.g. offline maps" aria-label="The feature you want" value="${wantsPlatform ? esc(`On ${platformNames[platform] || platform}`) : ""}">` : ""}
      ${tier === "gamma" ? `<input class="ask__org" maxlength="80" placeholder="Organisation" aria-label="Organisation">` : ""}
      <input class="ask__contact" maxlength="120" inputmode="email" autocomplete="email" placeholder="Email or mobile" aria-label="Email or mobile number" value="${esc(saved)}">
      <button type="button" class="btn btn--primary ask__send">Send</button>
    </div>
    ${tier === "gamma" ? `<a class="link" href="${JOURNEY_URL}" rel="noopener" target="_blank">Set up your organisation's space on 50gramx.com/apply ↗</a>` : ""}
    <p class="ask__status" role="status"></p>`;
  const contact = panel.querySelector(".ask__contact");
  (isFeature && !wantsPlatform ? panel.querySelector(".ask__note") : saved ? panel.querySelector(".ask__send") : contact)?.focus();
  panel.querySelector(".ask__send").onclick = async () => {
    const status = panel.querySelector(".ask__status");
    const value = contact.value.trim();
    if (!value) { status.textContent = "Just an email or a mobile number."; contact.focus(); return; }
    status.textContent = "Sending…";
    try {
      await send({
        kind: tier,
        brand,
        platform,
        contact: value,
        note: panel.querySelector(".ask__note")?.value || "",
        org: panel.querySelector(".ask__org")?.value || "",
      });
      rememberContact(value);
      panel.innerHTML = `<p class="ask__done">Thanks — we'll be in touch at ${esc(value)}.</p>`;
    } catch (error) {
      status.textContent = error.message;
    }
  };
  panel.querySelectorAll("input").forEach((input) => input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") panel.querySelector(".ask__send")?.click();
  }));
  panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function say(button) {
  const brand = button.dataset.brand;
  const kind = button.dataset.say;
  const row = button.parentElement;
  row.querySelectorAll("[data-say]").forEach((b) => { b.disabled = true; });
  try {
    await send({ kind, brand, platform: state.device, contact: rememberedContact() || undefined });
    button.classList.add("pill--on");
    button.textContent = kind === "like" ? "👍 Thanks!" : "👎 Noted, thank you";
  } catch (error) {
    row.querySelectorAll("[data-say]").forEach((b) => { b.disabled = false; });
    button.title = error.message;
  }
}

function wireJoin() {
  const form = document.querySelector("#joinForm");
  if (!form) return;
  const status = form.querySelector(".join__status");
  const contact = form.elements.contact;
  contact.value = rememberedContact();
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const org = form.elements.org.value.trim();
    const value = contact.value.trim();
    if (!org || !value) { status.textContent = "Your brand's name and an email or mobile, please."; return; }
    status.textContent = "Sending…";
    try {
      await send({ kind: "join", org, contact: value, note: form.elements.note.value, website: form.elements.website.value });
      rememberContact(value);
      form.innerHTML = `<p class="ask__done">Thanks — we'll reach out to ${esc(value)} about ${esc(org)}.</p>`;
    } catch (error) {
      status.textContent = error.message;
    }
  });
}

function wire() {
  document.addEventListener("click", (event) => {
    const get = event.target.closest("[data-get]");
    if (get) { openGuide(get.dataset.get); return; }
    const tier = event.target.closest("[data-tier]");
    if (tier) { openAsk(tier); return; }
    const sayBtn = event.target.closest("[data-say]");
    if (sayBtn) { say(sayBtn); return; }
    const category = event.target.closest("[data-category]");
    if (category) { state.category = category.dataset.category; renderHome(); return; }
    const channel = event.target.closest("[data-channel]");
    if (channel) { state.channel = channel.dataset.channel; render(); }
  });
  wireJoin();
}

// The network strip: the same signed aggregates status.html shows, read from
// what CI publishes; files that are missing just leave it out.
function networkFrom(network, communities) {
  if (!network && !communities) return null;
  return {
    communities: communities?.community_count || 0,
    peers: network?.activity?.peers_online || 0,
    grams: network?.node_count || 0,
  };
}

try {
  const [catalog, signing, network, communities] = await Promise.all([
    loadJSON("data/catalog.json"),
    loadJSON("data/signing.json", true),
    loadJSON("data/network.json", true),
    loadJSON("data/communities.json", true),
  ]);
  state.catalog = catalog;
  state.signing = signing;
  state.network = networkFrom(network, communities);
  const channels = new Set((catalog.products || []).flatMap((p) => releasesOf(p).map((r) => r.channel)));
  state.channel = channelOrder.find((c) => channels.has(c)) || "stable";
  render();
  wire();
} catch (error) {
  const target = document.querySelector(state.app ? "#view" : "#grid");
  if (target) target.innerHTML = `<p class="loading">The app list couldn't load. Refresh in a moment.</p>`;
  console.error(error);
}
