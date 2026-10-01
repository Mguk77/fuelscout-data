// Minimal Google Cloud Storage client for a private bucket, with no dependencies.
// Authenticates as the Cloud Run service account via the metadata server, so no
// keys are needed. Used by update.mjs (writes the snapshot) and server.mjs (reads it).

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

let token;
let tokenExpiry = 0;

async function accessToken() {
  if (token && Date.now() < tokenExpiry - 60_000) return token;
  const response = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!response.ok) throw new Error(`Metadata server token failed (${response.status})`);
  const body = await response.json();
  token = body.access_token;
  tokenExpiry = Date.now() + body.expires_in * 1000;
  return token;
}

function objectURL(bucket, name) {
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`;
}

/** The object's generation (changes on every write), or null if it doesn't exist. */
export async function objectGeneration(bucket, name) {
  const response = await fetch(`${objectURL(bucket, name)}?fields=generation`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Storage metadata ${response.status} for ${name}: ${await response.text()}`);
  return (await response.json()).generation;
}

/** Returns { generation, text }, or null if the object doesn't exist. */
export async function readObject(bucket, name) {
  const response = await fetch(`${objectURL(bucket, name)}?alt=media`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Storage read ${response.status} for ${name}: ${await response.text()}`);
  return { generation: response.headers.get("x-goog-generation"), text: await response.text() };
}

export async function writeObject(bucket, name, text, contentType = "application/json") {
  const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  url.searchParams.set("uploadType", "media");
  url.searchParams.set("name", name);
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": contentType },
    body: text,
  });
  if (!response.ok) throw new Error(`Storage write ${response.status} for ${name}: ${await response.text()}`);
}
