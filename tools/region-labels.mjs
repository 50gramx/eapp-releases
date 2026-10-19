// region-labels.mjs — A REGION IS A PINCODE, AND A PINCODE KNOWS WHERE IT IS.
//
// A region's id is its pincode (IN_<pincode>). Its NAME used to be whatever the
// first gram to sign into it estimated from IP geolocation, and the daemon's
// estimator stitched two providers' answers field by field (fixed in
// epn-daemon internal/bench/placement.go). That is how the ledger came to hold
// "Chennai, Odisha", "Delhi, Bihar", a Hyderabad pincode filed under Bengaluru,
// and two Ranchi pincodes filed under Bihar.
//
// A label now comes from the pincode, not from the estimate:
//
//   1. The STATE is checked against the pincode's own leading digits. India
//      Post assigns them by postal circle, so this is a fact, not a guess.
//   2. A directory (data/pincode-directory.json, resolved from OpenStreetMap by
//      `node tools/region-labels.mjs resolve` in CI) names the pincode's state
//      and district. Where the reported city is one of the names the directory
//      gives that pincode, the reported (familiar) name stays. Where it is not,
//      the directory's name replaces it.
//   3. With no directory entry, a reported label whose state contradicts the
//      pincode is corrected to the pincode's state and marked as such.
//
// A directory answer is itself checked against the leading digits and dropped
// when it contradicts them: OpenStreetMap's postcode tags are crowd-sourced.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const DIRECTORY_PATH = 'data/pincode-directory.json';

// ── THE LEADING DIGITS ─────────────────────────────────────────────────────
// Mirrors epn-daemon internal/bench/placement.go. Generous: a prefix lists every
// state its circle serves, so "contradicts" is always a real contradiction.
const J = ['jharkhand'];
const IN_PREFIX3 = {
  814: J, 815: J, 816: J, 822: J, 825: J, 826: J, 827: J, 828: J, 829: J,
  831: J, 832: J, 833: J, 834: J, 835: J,
  160: ['chandigarh', 'punjab', 'haryana'],
  194: ['ladakh', 'jammuandkashmir'],
  403: ['goa'],
  605: ['puducherry', 'tamilnadu'], 609: ['puducherry', 'tamilnadu'],
  682: ['kerala', 'lakshadweep'],
  737: ['sikkim'],
  744: ['andamanandnicobarislands'],
  396: ['gujarat', 'dadraandnagarhavelianddamananddiu', 'dadraandnagarhaveli', 'damananddiu'],
  362: ['gujarat', 'dadraandnagarhavelianddamananddiu', 'damananddiu'],
};
const range = (a, b, states) => Object.fromEntries(Array.from({ length: b - a + 1 }, (_, i) => [a + i, states]));
const IN_PREFIX2 = {
  11: ['delhi'],
  12: ['haryana'], 13: ['haryana', 'punjab'],
  14: ['punjab'], 15: ['punjab'], 16: ['punjab', 'chandigarh', 'haryana'],
  17: ['himachalpradesh'],
  18: ['jammuandkashmir'], 19: ['jammuandkashmir', 'ladakh'],
  ...range(20, 28, ['uttarpradesh']),
  24: ['uttarpradesh', 'uttarakhand'], 26: ['uttarakhand', 'uttarpradesh'],
  ...range(30, 34, ['rajasthan']),
  ...range(36, 39, ['gujarat']),
  ...range(40, 44, ['maharashtra']),
  ...range(45, 48, ['madhyapradesh']),
  49: ['chhattisgarh'],
  50: ['telangana', 'andhrapradesh'],
  51: ['andhrapradesh', 'telangana'], 52: ['andhrapradesh'], 53: ['andhrapradesh'],
  ...range(56, 59, ['karnataka']),
  ...range(60, 64, ['tamilnadu']),
  ...range(67, 69, ['kerala']),
  ...range(70, 74, ['westbengal']),
  ...range(75, 77, ['odisha']),
  78: ['assam'],
  79: ['arunachalpradesh', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'tripura', 'assam'],
  ...range(80, 85, ['bihar']),
};
const KNOWN_STATES = new Set([...Object.values(IN_PREFIX2), ...Object.values(IN_PREFIX3)].flat());

// The display name for a prefix that belongs to exactly one state.
const STATE_DISPLAY = {
  delhi: 'Delhi', haryana: 'Haryana', punjab: 'Punjab', himachalpradesh: 'Himachal Pradesh',
  jammuandkashmir: 'Jammu and Kashmir', uttarpradesh: 'Uttar Pradesh', uttarakhand: 'Uttarakhand',
  rajasthan: 'Rajasthan', gujarat: 'Gujarat', maharashtra: 'Maharashtra', goa: 'Goa',
  madhyapradesh: 'Madhya Pradesh', chhattisgarh: 'Chhattisgarh', telangana: 'Telangana',
  andhrapradesh: 'Andhra Pradesh', karnataka: 'Karnataka', tamilnadu: 'Tamil Nadu', kerala: 'Kerala',
  westbengal: 'West Bengal', odisha: 'Odisha', assam: 'Assam', bihar: 'Bihar', jharkhand: 'Jharkhand',
  sikkim: 'Sikkim', ladakh: 'Ladakh', chandigarh: 'Chandigarh', puducherry: 'Puducherry',
};

const STATE_ALIASES = {
  orissa: 'odisha', nctofdelhi: 'delhi', nationalcapitalterritoryofdelhi: 'delhi', newdelhi: 'delhi',
  pondicherry: 'puducherry', uttaranchal: 'uttarakhand', jammukashmir: 'jammuandkashmir',
  andamanandnicobar: 'andamanandnicobarislands',
};

export function stateKey(s) {
  const k = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  return STATE_ALIASES[k] || k;
}

function prefixStates(country, pincode) {
  if (String(country || '').toUpperCase() !== 'IN' || !/^\d{6}$/.test(pincode || '')) return null;
  return IN_PREFIX3[pincode.slice(0, 3)] || IN_PREFIX2[pincode.slice(0, 2)] || null;
}

/** 'fits' | 'contradicts' | 'unknown' — can this pincode lie in this state? */
export function pincodeFit(country, pincode, state) {
  const states = prefixStates(country, pincode);
  if (!states || !state) return 'unknown';
  const k = stateKey(state);
  if (!KNOWN_STATES.has(k)) return 'unknown';
  return states.includes(k) ? 'fits' : 'contradicts';
}

// ── NAMES ──────────────────────────────────────────────────────────────────
const CITY_ALIASES = {
  bangalore: 'bengaluru', calcutta: 'kolkata', bombay: 'mumbai', madras: 'chennai',
  gurgaon: 'gurugram', orissa: 'odisha', cuttak: 'cuttack', secunderabad: 'hyderabad',
};
function nameKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b(municipal corporation|m\.?corp\.?|district|urban|rural|mandal|taluk|tehsil)\b/g, ' ')
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map((w) => CITY_ALIASES[w] || w)
    .join(' ');
}

/** Whether a reported city is one of the names a directory gives its pincode. */
function cityMatches(reported, entry) {
  const r = nameKey(reported);
  if (!r) return false;
  return (entry.names || []).some((n) => {
    const k = nameKey(n);
    return k && (k === r || k.includes(r) || r.includes(k));
  });
}

/** The directory's own name for a place: its city, else its district. */
function directoryCity(entry) {
  const clean = (s) => String(s || '').replace(/\s*(Municipal Corporation|District)$/i, '').trim();
  return clean(entry.city) || clean(entry.state_district) || clean(entry.county) || '';
}

// ── THE LABEL ──────────────────────────────────────────────────────────────

/**
 * labelFor returns {city, state, label_source} for a community, from its pincode.
 * label_source: 'pincode-directory' | 'reported' | 'reported-state-corrected'.
 */
export function labelFor(c, directory) {
  const pincode = c.pincode || String(c.id || '').split('_')[1] || '';
  const country = c.country || String(c.id || '').split('_')[0] || '';
  const entry = directory?.entries?.[c.id];
  if (entry && !entry.missing && entry.state && pincodeFit(country, pincode, entry.state) !== 'contradicts') {
    const city = cityMatches(c.city, entry) ? c.city : directoryCity(entry) || c.city;
    return { city, state: entry.state, label_source: 'pincode-directory' };
  }
  if (pincodeFit(country, pincode, c.state) === 'contradicts') {
    const states = prefixStates(country, pincode);
    if (states?.length === 1 && STATE_DISPLAY[states[0]]) {
      return { city: c.city, state: STATE_DISPLAY[states[0]], label_source: 'reported-state-corrected' };
    }
  }
  return { city: c.city, state: c.state, label_source: 'reported' };
}

export function loadDirectory(path = DIRECTORY_PATH) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { entries: {} };
  } catch {
    return { entries: {} };
  }
}

// ── RESOLVING (CI only) ────────────────────────────────────────────────────
//
// One request a second (OpenStreetMap's Nominatim usage policy), an identifying
// User-Agent, a cap per run, and a cache: a pincode is looked up once, and a miss
// is retried after 30 days. Never fails the run -- a pincode it cannot resolve
// keeps its reported label, corrected only where its own digits disagree.

const MAX_PER_RUN = 40;
const RETRY_MISS_MS = 30 * 24 * 3600 * 1000;
const UA = '50gramx-region-labels/1.0 (+https://github.com/50gramx/eapp-releases; ci@50gramx.com)';

async function resolveOne(country, pincode) {
  const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(pincode)}&country=${encodeURIComponent(country.toLowerCase())}&format=json&addressdetails=1&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const [hit] = await res.json();
  const a = hit?.address;
  if (!a?.state) return null;
  const names = [a.city, a.town, a.village, a.suburb, a.county, a.state_district, a.municipality].filter(Boolean);
  return { city: a.city || a.town || '', county: a.county || '', state_district: a.state_district || '', state: a.state, names };
}

export async function resolveDirectory(ids, path = DIRECTORY_PATH, now = Date.now()) {
  const dir = loadDirectory(path);
  dir.entries ||= {};
  let looked = 0;
  for (const id of [...new Set(ids)].sort()) {
    const [country, pincode] = String(id).split('_');
    if (!country || !pincode) continue;
    const held = dir.entries[id];
    if (held && !(held.missing && now - Date.parse(held.resolved_at) > RETRY_MISS_MS)) continue;
    if (looked >= MAX_PER_RUN) break;
    if (looked > 0) await new Promise((r) => setTimeout(r, 1100));
    looked++;
    try {
      const e = await resolveOne(country, pincode);
      const at = new Date(now).toISOString();
      dir.entries[id] = e && pincodeFit(country, pincode, e.state) !== 'contradicts'
        ? { ...e, resolved_at: at }
        : { missing: true, resolved_at: at };
      console.log(`region-labels: ${id} -> ${dir.entries[id].missing ? 'no answer' : `${directoryCity(dir.entries[id])}, ${dir.entries[id].state}`}`);
    } catch (err) {
      console.log(`region-labels: ${id} not resolved this run (${err.message})`);
    }
  }
  dir.source = 'OpenStreetMap Nominatim postcode search (data © OpenStreetMap contributors, ODbL 1.0)';
  dir.updated_at = new Date(now).toISOString();
  dir.entries = Object.fromEntries(Object.entries(dir.entries).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(path, JSON.stringify(dir, null, 2) + '\n');
  return dir;
}

/** Every region id the network has named: the ledger plus every node's snapshot. */
function knownIds() {
  const ids = [];
  try {
    for (const c of JSON.parse(readFileSync('data/communities.json', 'utf8')).communities || []) ids.push(c.id);
  } catch {
    /* first run */
  }
  try {
    for (const n of JSON.parse(readFileSync('data/founders.json', 'utf8')).nodes || []) {
      const id = n?.proof_snapshot?.region?.community_id;
      if (id) ids.push(id);
    }
  } catch {
    /* first run */
  }
  return ids;
}

if (process.argv[1] && process.argv[1].endsWith('region-labels.mjs') && process.argv[2] === 'resolve') {
  resolveDirectory(knownIds()).catch((err) => {
    console.log(`region-labels: skipped (${err.message})`);
  });
}
