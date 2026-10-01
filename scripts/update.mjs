// Downloads GOV.UK Fuel Finder data into a private Cloud Storage bucket, where
// server.mjs reads it to answer the FuelScout app's "stations near me" requests.
// Nothing is published publicly.
//
// Runs as a Cloud Run Job in London (Node 20+, no dependencies); the Fuel Finder
// API only answers UK addresses. Each run reads the previous snapshot back from
// the bucket, so it only asks the API for what changed. A full re-download
// happens weekly.
//
// Output (gs://$BUCKET):
//   snapshot.json – every forecourt with its prices, plus sync timestamps

import { readObject, writeObject } from "./storage.mjs";

const API_BASE = "https://www.fuel-finder.service.gov.uk";
const SNAPSHOT = "snapshot.json";
const FORMAT_VERSION = 1;

const HOUR = 60 * 60 * 1000;
const FULL_SYNC_INTERVAL = 7 * 24 * HOUR;
const STATION_SYNC_INTERVAL = HOUR;
const OVERLAP = 5 * 60 * 1000; // Overlap incremental windows so clock skew can't drop an update.
const BATCH_SIZE = 500;
const USER_AGENT = "FuelScout/1.0 (+https://github.com/Mguk77/fuelscout-data)";

const { FUEL_FINDER_CLIENT_ID, FUEL_FINDER_CLIENT_SECRET, BUCKET, FORCE_FULL } = process.env;
if (!FUEL_FINDER_CLIENT_ID || !FUEL_FINDER_CLIENT_SECRET) {
  throw new Error("Set the FUEL_FINDER_CLIENT_ID and FUEL_FINDER_CLIENT_SECRET secrets.");
}
if (!BUCKET) throw new Error("Set BUCKET to the private Cloud Storage bucket name.");

// MARK: - Main

const now = new Date();
const previous = await loadPreviousSnapshot();
const full =
  FORCE_FULL === "true" || !previous || now - new Date(previous.fullAt) > FULL_SYNC_INTERVAL;

const snapshot = full
  ? { version: FORMAT_VERSION, fullAt: iso(now), stationsAt: null, pricesAt: null, stations: {} }
  : previous;

let apiRequests = 0;
let accessToken;
let tokenExpiry = 0;

const stationsDue = full || !snapshot.stationsAt || now - new Date(snapshot.stationsAt) > STATION_SYNC_INTERVAL;
let stationsChanged = 0;
if (stationsDue) {
  const since = full || !snapshot.stationsAt ? undefined : new Date(new Date(snapshot.stationsAt) - OVERLAP);
  for (const record of await fetchAllBatches("/api/v1/pfs", since)) {
    const station = toStation(record);
    if (!station) continue;
    station.prices = snapshot.stations[station.id]?.prices ?? {};
    snapshot.stations[station.id] = station;
    stationsChanged++;
  }
  snapshot.stationsAt = iso(now);
}

const pricesSince = full || !snapshot.pricesAt ? undefined : new Date(new Date(snapshot.pricesAt) - OVERLAP);
let pricesChanged = 0;
for (const record of await fetchAllBatches("/api/v1/pfs/fuel-prices", pricesSince)) {
  const station = snapshot.stations[str(record.node_id)];
  if (!station || !Array.isArray(record.fuel_prices)) continue;
  for (const entry of record.fuel_prices) {
    const fuelType = str(entry?.fuel_type)?.toUpperCase();
    const pence = sanitisePence(num(entry?.price));
    if (!fuelType || pence === null) continue;
    station.prices[fuelType] = {
      pence,
      updated: parseDate(str(entry.price_last_updated) ?? str(entry.price_change_effective_timestamp)),
    };
    pricesChanged++;
  }
}
snapshot.pricesAt = iso(now);

await writeObject(BUCKET, SNAPSHOT, JSON.stringify(snapshot));
console.log(
  JSON.stringify({
    full,
    stations: Object.keys(snapshot.stations).length,
    stationsChanged,
    pricesChanged,
    apiRequests,
  }),
);

// MARK: - Snapshot

async function loadPreviousSnapshot() {
  const object = await readObject(BUCKET, SNAPSHOT);
  if (!object) return null; // First run.
  try {
    const snapshot = JSON.parse(object.text);
    return snapshot?.version === FORMAT_VERSION && snapshot.stations ? snapshot : null;
  } catch {
    return null; // Unreadable; start again with a full download.
  }
}

// MARK: - Fuel Finder API
// https://www.developer.fuel-finder.service.gov.uk/fuel-finder/public-api
// Batches of 500 across the whole UK; one request at a time, 100 per minute.

async function fetchAllBatches(path, since) {
  const results = [];
  for (let batch = 1; batch <= 200; batch++) {
    const url = new URL(path, API_BASE);
    url.searchParams.set("batch-number", String(batch));
    if (since) url.searchParams.set("effective-start-timestamp", since.toISOString().slice(0, 19).replace("T", " "));

    const page = await apiGet(url);
    if (page === null) break;
    results.push(...page);
    if (page.length < BATCH_SIZE) break;
  }
  return results;
}

/** Returns null when the API signals the end of paging. */
async function apiGet(url) {
  for (let attempt = 1; ; attempt++) {
    const token = await validToken();
    apiRequests++;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT } });
    const text = await response.text();

    if (response.ok) return unwrapList(text);
    if (response.status === 404 || /no more data/i.test(text)) return null;
    if (attempt >= 4) throw new Error(`Fuel Finder ${response.status} for ${url.pathname}: ${text.slice(0, 200)}`);
    if (response.status === 401 || response.status === 403) {
      accessToken = undefined; // Tokens can be revoked mid-pagination.
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfter = Number(response.headers.get("Retry-After")) || 0;
      await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfter, 2 ** attempt) * 1000));
      continue;
    }
    throw new Error(`Fuel Finder ${response.status} for ${url.pathname}: ${text.slice(0, 200)}`);
  }
}

async function validToken() {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;
  apiRequests++;
  const response = await fetch(new URL("/api/v1/oauth/generate_access_token", API_BASE), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: FUEL_FINDER_CLIENT_ID,
      client_secret: FUEL_FINDER_CLIENT_SECRET,
      scope: "fuelfinder.read",
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    // An empty 403 from CloudFront means the request was blocked before reaching the API (e.g. a cloud IP),
    // whereas wrong credentials come back as a JSON 401.
    const via = `server=${response.headers.get("server")}, x-cache=${response.headers.get("x-cache")}`;
    throw new Error(`Fuel Finder sign-in failed (${response.status}, ${via}): ${text.slice(0, 200) || "<empty body>"}`);
  }

  // The token may be returned bare or wrapped in { success, data: { ... } }.
  const body = JSON.parse(text);
  const payload = body?.access_token ? body : body?.data;
  if (!payload?.access_token) throw new Error(`Unexpected token response: ${text.slice(0, 200)}`);
  accessToken = String(payload.access_token);
  tokenExpiry = Date.now() + (Number(payload.expires_in) || 3600) * 1000;
  return accessToken;
}

function unwrapList(text) {
  const body = JSON.parse(text);
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.data)) return body.data.data;
  if (/no more data/i.test(text)) return [];
  throw new Error(`Unexpected Fuel Finder response: ${text.slice(0, 200)}`);
}

// MARK: - Mapping (output matches the iOS app's Station model)

function toStation(record) {
  const id = str(record.node_id);
  const location = record.location ?? {};
  const latitude = num(location.latitude);
  const longitude = num(location.longitude);
  // Skip forecourts without a plausible UK location.
  if (!id || latitude === null || longitude === null) return null;
  if (latitude < 49 || latitude > 61.5 || longitude < -8.9 || longitude > 2.1) return null;

  const brand = str(record.brand_name);
  const openingHours = {};
  for (const [day, hours] of Object.entries(record.opening_times?.usual_days ?? {})) {
    if (!hours || typeof hours !== "object") continue;
    openingHours[day.toLowerCase()] = { open: str(hours.open), close: str(hours.close), is24Hours: bool(hours.is_24_hours) };
  }

  return {
    id,
    name: tidy(str(record.trading_name) ?? brand ?? "Filling station"),
    brand: brand ? tidy(brand) : null,
    addressLines: [location.address_line_1, location.address_line_2, location.city].map(str).filter(Boolean).map(tidy),
    postcode: str(location.postcode)?.toUpperCase() ?? null,
    latitude,
    longitude,
    isMotorway: bool(record.is_motorway_service_station),
    isSupermarket: bool(record.is_supermarket_service_station),
    isClosed: bool(record.temporary_closure) || bool(record.permanent_closure),
    amenities: Array.isArray(record.amenities) ? record.amenities.map(String) : [],
    openingHours,
    phone: str(record.public_phone_number),
    prices: {},
  };
}

/** Pence per litre; some retailers submit pounds (1.379) or tenths of a penny (1379). */
function sanitisePence(raw) {
  if (raw === null || raw <= 0) return null;
  let pence = raw;
  if (pence < 10) pence *= 100;
  else if (pence > 1000) pence /= 10;
  if (pence < 50 || pence > 400) return null;
  return Math.round(pence * 10) / 10;
}

function str(value) {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  return null;
}

function num(value) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function bool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["true", "yes", "y", "1"].includes(value.toLowerCase());
  return false;
}

/** ISO 8601 without milliseconds, which is what the iOS decoder expects. */
function iso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseDate(value) {
  if (!value) return null;
  const normalised = value.includes("T") ? value : value.replace(" ", "T");
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(normalised);
  const time = Date.parse(hasZone ? normalised : `${normalised}Z`);
  return Number.isNaN(time) ? null : iso(new Date(time));
}

/** Many forecourts are registered in capitals ("TESCO EXTRA"); present them in title case. */
function tidy(text) {
  if (!/[A-Za-z]/.test(text) || text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/(^|[\s\-'(/&])([a-z])/g, (_, before, letter) => before + letter.toUpperCase());
}
