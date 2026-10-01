// FuelScout API: answers "which forecourts are near here?" from the private
// snapshot that update.mjs keeps in Cloud Storage. Only the stations within the
// requested radius (at most 30 miles) are returned, so the full dataset is never
// downloadable in one go.
//
//   GET /v1/stations?lat=51.5&lon=-0.12&radiusMiles=8
//   → { "version": 1, "updatedAt": "…", "stations": [Station, …] }
//
// Runs as a Cloud Run service in London (Node 20+, no dependencies).

import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { objectGeneration, readObject } from "./storage.mjs";

const { BUCKET, PORT = "8080" } = process.env;
if (!BUCKET) throw new Error("Set BUCKET to the private Cloud Storage bucket name.");

const SNAPSHOT = "snapshot.json";
const FORMAT_VERSION = 1;
const MAX_RADIUS_MILES = 30; // The app never asks for more than this.
const RECHECK_INTERVAL = 5 * 60 * 1000; // How often to look for a newer snapshot (published hourly).
// Per client IP, per instance. Generous because mobile networks put many phones behind one IP;
// the app itself only asks when the user moves a few miles, data is 15 minutes old, or they pull to refresh.
const RATE_LIMIT = 60;
const RATE_WINDOW = 10 * 60 * 1000;
const UK = { minLat: 49, maxLat: 61.5, minLon: -8.9, maxLon: 2.1 };

// MARK: - Snapshot cache

let cache = null; // { generation, updatedAt, stations, checkedAt }
let loading = null;

async function currentData() {
  if (cache && Date.now() - cache.checkedAt < RECHECK_INTERVAL) return cache;
  loading ??= refresh().finally(() => (loading = null));
  try {
    return await loading;
  } catch (error) {
    if (cache) {
      console.error(`Keeping cached snapshot: ${error.message}`);
      cache.checkedAt = Date.now();
      return cache;
    }
    throw error;
  }
}

async function refresh() {
  if (cache && (await objectGeneration(BUCKET, SNAPSHOT)) === cache.generation) {
    cache.checkedAt = Date.now();
    return cache;
  }
  const object = await readObject(BUCKET, SNAPSHOT);
  if (!object) throw new Error("No snapshot yet; run the fuelscout-updater job.");
  const snapshot = JSON.parse(object.text);
  if (snapshot.version !== FORMAT_VERSION) throw new Error(`Unsupported snapshot version ${snapshot.version}`);

  const stations = Object.values(snapshot.stations).filter(
    (station) => !station.isClosed && Object.keys(station.prices).length > 0,
  );
  cache = { generation: object.generation, updatedAt: snapshot.pricesAt, stations, checkedAt: Date.now() };
  console.log(JSON.stringify({ loaded: stations.length, updatedAt: cache.updatedAt }));
  return cache;
}

// MARK: - Rate limiting

const requestTimes = new Map(); // ip → timestamps within the window

function allow(ip) {
  const now = Date.now();
  const recent = (requestTimes.get(ip) ?? []).filter((time) => now - time < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) {
    requestTimes.set(ip, recent);
    return false;
  }
  recent.push(now);
  requestTimes.set(ip, recent);
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of requestTimes) {
    if (times.every((time) => now - time >= RATE_WINDOW)) requestTimes.delete(ip);
  }
}, RATE_WINDOW).unref();

/** Cloud Run appends the real client address as the last X-Forwarded-For entry. */
function clientIP(request) {
  const forwarded = request.headers["x-forwarded-for"];
  return forwarded ? forwarded.split(",").at(-1).trim() : request.socket.remoteAddress;
}

// MARK: - HTTP

function send(request, response, status, body, extraHeaders = {}) {
  let payload = Buffer.from(JSON.stringify(body));
  const headers = { "Content-Type": "application/json", ...extraHeaders };
  if (payload.length > 1024 && /\bgzip\b/.test(request.headers["accept-encoding"] ?? "")) {
    payload = gzipSync(payload);
    headers["Content-Encoding"] = "gzip";
  }
  response.writeHead(status, headers);
  response.end(payload);
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

async function handle(request, response) {
  const url = new URL(request.url, "http://localhost");
  if (request.method !== "GET" || url.pathname !== "/v1/stations") {
    return send(request, response, 404, { error: "Not found" });
  }
  if (!allow(clientIP(request))) {
    return send(request, response, 429, { error: "Too many requests" }, { "Retry-After": "60" });
  }

  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const radiusMiles = Number(url.searchParams.get("radiusMiles"));
  const valid =
    Number.isFinite(lat) && lat >= UK.minLat && lat <= UK.maxLat &&
    Number.isFinite(lon) && lon >= UK.minLon && lon <= UK.maxLon &&
    Number.isFinite(radiusMiles) && radiusMiles > 0 && radiusMiles <= MAX_RADIUS_MILES;
  if (!valid) {
    return send(request, response, 400, {
      error: `Give lat and lon within the UK and radiusMiles between 0 and ${MAX_RADIUS_MILES}.`,
    });
  }

  let data;
  try {
    data = await currentData();
  } catch (error) {
    console.error(error);
    return send(request, response, 503, { error: "Prices are temporarily unavailable." });
  }

  const stations = data.stations.filter(
    (station) => distanceMiles(lat, lon, station.latitude, station.longitude) <= radiusMiles,
  );
  send(request, response, 200, { version: FORMAT_VERSION, updatedAt: data.updatedAt, stations }, {
    "Cache-Control": "private, max-age=60",
  });
}

createServer((request, response) => {
  handle(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) send(request, response, 500, { error: "Internal error" });
  });
}).listen(Number(PORT), () => console.log(`Listening on ${PORT}`));
