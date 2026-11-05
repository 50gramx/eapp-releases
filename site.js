// The releases page. Everything about a brand -- its name, summary, logo,
// website, store links, which platforms it is planned for, and who may try it
// early -- comes from data/catalog.json, which tools/generate-catalog.mjs builds
// from the brand contracts and each build's release-metadata.json. Nothing
// about any brand is written here.

// One tap lands in the same applications as the app's "Apply for a Private
// Space" form (bharatsphere mohallaApplications.submitInterest); the longer
// journey for an organisation or a brand is 50gramx.com/apply.
const INTEREST_URL = "https://us-central1-bharatsphere-183e7.cloudfunctions.net/submitInterest";
const JOURNEY_URL = "https://50gramx.com/apply";
const CONTACT_KEY = "epn-interest-contact";

const state = {
  catalog: null,
  signing: null,
  device: detectDevice(),
  channel: "stable",
  lookup: new Map(),
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

// Which store serves which platform, and how its badge reads.
const storeInfo = {
  "play-store": { platform: "android", label: "Get it on Google Play" },
  "app-store": { platform: "ios", label: "Download on the App Store" },
  testflight: { platform: "ios", label: "Test it on TestFlight" },
  "mac-app-store": { platform: "macos", label: "Download on the Mac App Store" },
  "microsoft-store": { platform: "windows", label: "Get it from Microsoft" },
};

const tierInfo = {
  alpha: { label: "Alpha", hint: "Early trials, first to see new things" },
  beta: { label: "Beta", hint: "Test builds through the stores (TestFlight, Play testing)" },
  gamma: { label: "For my organisation", hint: "Private to your people, through your own gramx store" },
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (value) => (/^https:\/\//.test(String(value || "")) ? String(value) : "");

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
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    if (optional) return null;
    throw new Error(`${path}: ${response.status}`);
  }
  return response.json();
}

// ── builds ─────────────────────────────────────────────────────────────────

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
  const rank = (r) => {
    const order = [state.channel, ...channelOrder.filter((c) => c !== state.channel)];
    const i = order.indexOf(r.channel);
    return (i < 0 ? 99 : i) * 1e7 - Number(r.buildId || 0);
  };
  return [...builds].sort((a, b) => rank(a) - rank(b))[0];
}

function guidanceFor(brandId, platform) {
  const s = state.signing || {};
  return (s.overrides || {})[`${brandId}/${platform}`] || (s.defaults || {})[platform] || { signed: false, unsigned: null };
}

// Signed or not, as the build that made it said; older builds fall back to
// the guidance table.
function signingOf(release) {
  if (release.signing) {
    return {
      release: { label: "Signed", tone: "good", note: "Signed with the brand's own key." },
      debug: { label: "Test-signed", tone: "warn", note: "Signed with a throwaway key; it cannot update a store copy." },
      "ad-hoc": { label: "Not notarized", tone: "warn", note: "Signed on the build machine only; macOS will ask you to confirm." },
      none: { label: "Unsigned", tone: "warn", note: "Not signed; follow the install steps." },
    }[release.signing] || { label: "Unsigned", tone: "warn", note: "" };
  }
  return guidanceFor(release.brandId, release.platform).signed
    ? { label: "Signed", tone: "good", note: "" }
    : { label: "Unsigned", tone: "warn", note: "Follow the install steps." };
}

function ago(value) {
  if (!value) return "";
  const days = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 86400000));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

const short = (sha) => (sha ? String(sha).slice(0, 10) : "–");

// ── rendering ──────────────────────────────────────────────────────────────

function logoOf(product) {
  if (product.logo) return `<img class="brand__logo" src="${esc(product.logo)}" alt="" width="56" height="56" loading="lazy">`;
  const letters = (product.displayName || product.brandId).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
  return `<span class="brand__logo brand__logo--mono" aria-hidden="true">${esc(letters)}</span>`;
}

function storeBadges(product, onlyPlatform = null) {
  return (product.stores || [])
    .filter((s) => storeInfo[s.store] && safeUrl(s.url) && (!onlyPlatform || storeInfo[s.store].platform === onlyPlatform))
    .map((s) => `<a class="store" href="${esc(safeUrl(s.url))}" rel="noopener" target="_blank"><span class="store__plat">${esc(platformNames[storeInfo[s.store].platform])}</span>${esc(storeInfo[s.store].label)}</a>`)
    .join("");
}

function platformTile(product, platform) {
  const release = bestFor(product, platform);
  const store = (product.stores || []).find((s) => storeInfo[s.store]?.platform === platform && safeUrl(s.url));
  const here = platform === state.device ? " tile--here" : "";
  const name = esc(platformNames[platform] || platform);

  if (platform === "web" && product.website) {
    return `<a class="tile${here}" href="${esc(product.website)}" rel="noopener" target="_blank">
      <span class="tile__name">${name}</span>
      <span class="tile__what">Open in your browser</span>
      <span class="badge badge--good">Live</span>
    </a>`;
  }
  if (release) {
    const sig = signingOf(release);
    const key = `${product.brandId}|${release.platform}|${release.channel}|${release.buildId}`;
    state.lookup.set(key, { product, release, sig });
    return `<button type="button" class="tile${here}" data-get="${esc(key)}">
      <span class="tile__name">${name}</span>
      <span class="tile__what">${esc(channelNames[release.channel] || release.channel)} · ${esc(ago(release.generatedAt))}</span>
      <span class="badge badge--${sig.tone}">${esc(sig.label)}</span>
      ${store ? `<span class="tile__also">Also in the store</span>` : ""}
    </button>`;
  }
  if (store) {
    return `<a class="tile${here}" href="${esc(safeUrl(store.url))}" rel="noopener" target="_blank">
      <span class="tile__name">${name}</span>
      <span class="tile__what">${esc(storeInfo[store.store].label)}</span>
      <span class="badge badge--good">Store</span>
    </a>`;
  }
  return `<button type="button" class="tile tile--soon${here}" data-tier="beta" data-platform="${esc(platform)}" data-brand="${esc(product.brandId)}">
    <span class="tile__name">${name}</span>
    <span class="tile__what">Coming — tell me when</span>
    <span class="badge">Planned</span>
  </button>`;
}

function primaryAction(product) {
  const platform = state.device;
  const store = (product.stores || []).find((s) => storeInfo[s.store]?.platform === platform && safeUrl(s.url));
  const release = bestFor(product, platform);
  if (store) {
    return `<a class="btn btn--primary btn--big" href="${esc(safeUrl(store.url))}" rel="noopener" target="_blank">${esc(storeInfo[store.store].label)}</a>`;
  }
  if (platform === "web" && product.website) {
    return `<a class="btn btn--primary btn--big" href="${esc(product.website)}" rel="noopener" target="_blank">Open ${esc(product.displayName)}</a>`;
  }
  if (release) {
    const key = `${product.brandId}|${release.platform}|${release.channel}|${release.buildId}`;
    return `<button type="button" class="btn btn--primary btn--big" data-get="${esc(key)}">Get it for ${esc(platformNames[platform])}</button>`;
  }
  if ((product.planned || []).includes(platform) && (product.access || []).length) {
    return `<button type="button" class="btn btn--primary btn--big" data-tier="beta" data-platform="${esc(platform)}" data-brand="${esc(product.brandId)}">Tell me when it's on ${esc(platformNames[platform])}</button>`;
  }
  return "";
}

function tryEarly(product) {
  const tiers = (product.access || []).filter((t) => tierInfo[t]);
  if (!tiers.length) return "";
  return `<div class="ask" data-brand="${esc(product.brandId)}">
    <p class="ask__title">Try it early</p>
    <div class="ask__chips">
      ${tiers.map((t) => `<button type="button" class="pill" data-tier="${t}" data-brand="${esc(product.brandId)}" title="${esc(tierInfo[t].hint)}">${esc(tierInfo[t].label)}</button>`).join("")}
    </div>
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
      const key = `${product.brandId}|${r.platform}|${r.channel}|${r.buildId}`;
      state.lookup.set(key, { product, release: r, sig });
      return `<li class="prov__row">
        <div>
          <b>${esc(platformNames[r.platform] || r.platform)} · ${esc(channelNames[r.channel] || r.channel)}</b>
          <span>build ${esc(r.buildId)} · ${esc(ago(r.generatedAt))} · <span class="badge badge--${sig.tone}">${esc(sig.label)}</span></span>
          <span class="mono">sha256 ${esc(short(r.sha256))} · source <a href="https://github.com/${esc(r.sourceRepo || "50gramx/eapp-live")}">${esc(short(r.sourceCommit))}</a> · contracts <a href="https://github.com/${esc(r.contractsRepo || "50gramx/eapp-interaction-contracts")}/commit/${esc(r.contractsCommit || "")}">${esc(short(r.contractsCommit))}</a>${r.epndVersion ? ` · gram ${esc(short(r.epndVersion))}` : ""}</span>
        </div>
        <div class="prov__acts">
          <a class="link" href="https://github.com/50gramx/eapp-releases/releases/tag/${esc(r.releaseTag || "")}">Release</a>
          <button type="button" class="link" data-get="${esc(key)}">Get</button>
        </div>
      </li>`;
    });
  if (!rows.length) return "";
  return `<details class="prov"><summary>Every build, with its provenance (${rows.length})</summary><ul>${rows.join("")}</ul></details>`;
}

function brandCard(product) {
  const shipped = releasesOf(product).length;
  const planned = platformOrder.filter((p) => (product.planned || []).includes(p) || (p === "web" && product.website));
  const status = shipped ? (releasesOf(product).some((r) => r.channel === "stable") ? ["Shipping", "good"] : ["Preview", "info"]) : ["Coming", "quiet"];
  const card = document.createElement("article");
  card.className = "brand";
  card.id = `brand-${product.brandId}`;
  card.innerHTML = `
    <header class="brand__head">
      ${logoOf(product)}
      <div class="brand__id">
        <h2>${esc(product.displayName)}</h2>
        <p class="brand__product">${esc(product.productName && product.productName !== product.displayName ? product.productName : "")}</p>
        <div class="brand__chips">
          <span class="badge badge--${status[1]}">${status[0]}</span>
          ${product.distribution === "private" ? `<span class="badge">Private · gramx store</span>` : ""}
          ${product.website ? `<a class="badge badge--link" href="${esc(product.website)}" rel="noopener" target="_blank">${esc(new URL(product.website).host)} ↗</a>` : ""}
        </div>
      </div>
    </header>
    <p class="brand__summary">${esc(product.summary || "")}</p>
    <div class="brand__get">${primaryAction(product)}</div>
    ${storeBadges(product) ? `<div class="stores">${storeBadges(product)}</div>` : ""}
    ${planned.length ? `<div class="tiles">${planned.map((p) => platformTile(product, p)).join("")}</div>` : ""}
    ${tryEarly(product)}
    ${provenance(product)}
  `;
  return card;
}

function render() {
  state.lookup = new Map();
  const root = document.querySelector("#apps");
  const products = [...(state.catalog.products || [])].sort((a, b) =>
    releasesOf(b).length - releasesOf(a).length || a.displayName.localeCompare(b.displayName));
  root.replaceChildren(...products.map(brandCard));
  if (!products.length) root.innerHTML = `<p class="loading">No apps listed yet.</p>`;
}

function renderChannels() {
  const present = new Set((state.catalog.products || []).flatMap((p) => releasesOf(p).map((r) => r.channel)));
  const root = document.querySelector("#channelPick");
  root.innerHTML = channelOrder.filter((c) => present.has(c)).map((c) =>
    `<button type="button" class="seg__btn" aria-pressed="${c === state.channel}" data-channel="${c}">${esc(channelNames[c])}</button>`).join("");
  document.querySelector("#deviceChip").textContent = `For your ${platformNames[state.device] || "device"}`;
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
  return button.closest(".ask")?.querySelector(".ask__panel") || null;
}

function openAsk(button) {
  const brand = button.dataset.brand;
  const tier = button.dataset.tier;
  const platform = button.dataset.platform || state.device;
  let panel = panelFor(button);
  if (!panel) {
    // A "coming" tile or the main button: use the brand's own panel.
    const card = document.querySelector(`#brand-${CSS.escape(brand)}`);
    panel = card?.querySelector(".ask__panel");
    if (!panel) return;
  }
  const saved = rememberedContact();
  const isFeature = tier === "feature";
  const lead = isFeature
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
      ${isFeature ? `<input class="ask__note" maxlength="600" placeholder="e.g. offline maps" aria-label="The feature you want">` : ""}
      ${tier === "gamma" ? `<input class="ask__org" maxlength="80" placeholder="Organisation" aria-label="Organisation">` : ""}
      <input class="ask__contact" maxlength="120" inputmode="email" autocomplete="email" placeholder="Email or mobile" aria-label="Email or mobile number" value="${esc(saved)}">
      <button type="button" class="btn btn--primary ask__send">Send</button>
    </div>
    ${tier === "gamma" ? `<a class="link" href="${JOURNEY_URL}" rel="noopener" target="_blank">Set up your organisation's space on 50gramx.com/apply ↗</a>` : ""}
    <p class="ask__status" role="status"></p>`;
  const contact = panel.querySelector(".ask__contact");
  (isFeature ? panel.querySelector(".ask__note") : saved ? panel.querySelector(".ask__send") : contact)?.focus();
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
    const channel = event.target.closest("[data-channel]");
    if (channel) {
      state.channel = channel.dataset.channel;
      renderChannels();
      render();
    }
  });
  wireJoin();
}

try {
  const [catalog, signing] = await Promise.all([loadJSON("data/catalog.json"), loadJSON("data/signing.json", true)]);
  state.catalog = catalog;
  state.signing = signing;
  const channels = new Set((catalog.products || []).flatMap((p) => releasesOf(p).map((r) => r.channel)));
  state.channel = channelOrder.find((c) => channels.has(c)) || "stable";
  renderChannels();
  render();
  wire();
} catch (error) {
  document.querySelector("#apps").innerHTML = `<p class="loading">The app list couldn't load. Refresh in a moment.</p>`;
  console.error(error);
}
