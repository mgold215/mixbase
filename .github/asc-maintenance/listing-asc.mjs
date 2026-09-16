// Shared App Store Connect client for the listing lane
// (.github/workflows/app-store-listing.yml). Same ES256 JWT pattern as the
// other asc-*.mjs scripts; the token is re-minted when it gets old so long
// screenshot uploads never run into Apple's 20-minute limit.

import { createPrivateKey, createSign } from "node:crypto";

export const API = "https://api.appstoreconnect.apple.com";
export const BUNDLE_ID = "com.moodmixformat.mixbase";

const keyId = process.env.ASC_KEY_ID;
const issuerId = process.env.ASC_ISSUER_ID;
const p8b64 = process.env.ASC_API_KEY_P8_BASE64;
if (!keyId || !issuerId || !p8b64) {
  console.error("Missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_API_KEY_P8_BASE64");
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

let cached = { token: null, mintedAt: 0 };
export function token() {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && now - cached.mintedAt < 600) return cached.token;
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" })
  );
  const key = createPrivateKey(Buffer.from(p8b64, "base64").toString("utf8"));
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const sig = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  cached = { token: `${header}.${payload}.${b64url(sig)}`, mintedAt: now };
  return cached.token;
}

/** JSON request against the ASC API. Never throws; inspect `ok` / `status`. */
export async function api(method, path, body) {
  const res = await fetch(path.startsWith("http") ? path : `${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty or non-JSON body (204s, upload endpoints) */
  }
  return { status: res.status, ok: res.ok, json, text };
}

export function fail(msg, r) {
  console.error(`FAILED: ${msg}`);
  if (r) console.error(`HTTP ${r.status}: ${(r.text ?? "").slice(0, 1500)}`);
  process.exit(1);
}

export async function findApp() {
  const r = await api("GET", `/v1/apps?filter[bundleId]=${BUNDLE_ID}`);
  const app = r.json?.data?.[0];
  if (!app) fail(`app ${BUNDLE_ID} not found`, r);
  return app;
}

/**
 * The App Review demo login, read from the live iOS version's review detail.
 * Runners get it from here so the repository needs no extra secret; the
 * caller masks the password before anything else is logged.
 */
export async function demoLogin(app) {
  const vers = await api(
    "GET",
    `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=5`
  );
  for (const v of vers.json?.data ?? []) {
    const rd = await api("GET", `/v1/appStoreVersions/${v.id}/appStoreReviewDetail`);
    const a = rd.json?.data?.attributes;
    if (a?.demoAccountName && a?.demoAccountPassword) {
      return { email: a.demoAccountName, password: a.demoAccountPassword, version: v.attributes.versionString };
    }
  }
  fail("no App Store version carries a demo account in its review detail");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
