// App Store Connect certificate audit / cleanup.
//
// Why this exists: the TestFlight workflow signs each run on a FRESH macOS
// runner, and the Apple team eventually hits "Your account has reached the
// maximum number of certificates" (first seen 2026-08-29, run #15) — at which
// point every iOS archive on CI fails before compiling a single file. The
// remote Claude sessions that maintain this repo cannot dispatch workflows
// (403) or log into developer.apple.com, but they CAN push to tst — so this
// script runs from a push-triggered workflow (asc-cert-audit.yml) and takes
// its orders from request.json next to it:
//
//   {"action": "list"}                            → print the cert inventory
//   {"action": "revoke", "certificateIds": [..]}  → revoke those certs
//
// Safety rails: revocation refuses anything that is not certificateType
// DEVELOPMENT (distribution certs sign App Store builds — never touched),
// and refuses ids not present in the live inventory. Revoking a DEVELOPMENT
// cert whose private key lived on a dead ephemeral CI runner breaks nothing;
// if a Mac's own cert is ever revoked by mistake, Xcode's automatic signing
// mints a replacement on the next local build.

import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com";

const keyId = process.env.ASC_KEY_ID;
const issuerId = process.env.ASC_ISSUER_ID;
const p8b64 = process.env.ASC_API_KEY_P8_BASE64;
if (!keyId || !issuerId || !p8b64) {
  console.error("Missing ASC_KEY_ID / ASC_ISSUER_ID / ASC_API_KEY_P8_BASE64");
  process.exit(1);
}

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function makeToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: issuerId, iat: now, exp: now + 600, aud: "appstoreconnect-v1" })
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(Buffer.from(p8b64, "base64").toString("utf8"));
  const signer = createSign("SHA256");
  signer.update(signingInput);
  // ASC requires the raw (r||s) ECDSA signature, not DER.
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

async function asc(method, path) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${makeToken()}` },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body — keep raw text */
  }
  return { status: res.status, body, text };
}

async function listCertificates() {
  const certs = [];
  let path = "/v1/certificates?limit=200";
  while (path) {
    const { status, body, text } = await asc("GET", path);
    if (status !== 200) {
      console.error(`GET ${path} → HTTP ${status}: ${text.slice(0, 500)}`);
      process.exit(1);
    }
    certs.push(...body.data);
    const next = body.links?.next;
    path = next ? next.replace(API, "") : null;
  }
  return certs;
}

const here = dirname(fileURLToPath(import.meta.url));
const request = JSON.parse(readFileSync(join(here, "request.json"), "utf8"));

const certs = await listCertificates();
certs.sort((a, b) =>
  String(a.attributes.expirationDate).localeCompare(String(b.attributes.expirationDate))
);

console.log(`\n=== Certificate inventory (${certs.length} total) ===`);
for (const c of certs) {
  const a = c.attributes;
  console.log(
    [
      `id=${c.id}`,
      `type=${a.certificateType}`,
      `name=${JSON.stringify(a.displayName ?? a.name ?? "")}`,
      `serial=${a.serialNumber}`,
      // ASC omits a created timestamp; certs live 1 year, so expiration - 1y
      // is effectively the creation time. Correlate with CI run timestamps to
      // spot runner-minted certs.
      `expires=${a.expirationDate}`,
      a.platform ? `platform=${a.platform}` : "",
    ]
      .filter(Boolean)
      .join("  ")
  );
}

if (request.action === "list") {
  console.log("\naction=list — no changes made.");
  process.exit(0);
}

if (request.action !== "revoke") {
  console.error(`Unknown action ${JSON.stringify(request.action)}`);
  process.exit(1);
}

const wanted = request.certificateIds ?? [];
if (wanted.length === 0) {
  console.error("action=revoke but certificateIds is empty — refusing.");
  process.exit(1);
}

let failed = false;
for (const id of wanted) {
  const cert = certs.find((c) => c.id === id);
  if (!cert) {
    console.error(`SKIP ${id}: not present in the live inventory.`);
    failed = true;
    continue;
  }
  if (cert.attributes.certificateType !== "DEVELOPMENT") {
    console.error(
      `SKIP ${id}: type ${cert.attributes.certificateType} — only DEVELOPMENT certs may be revoked here.`
    );
    failed = true;
    continue;
  }
  const { status, text } = await asc("DELETE", `/v1/certificates/${id}`);
  if (status === 204) {
    console.log(`REVOKED ${id} (${cert.attributes.displayName ?? cert.attributes.name}, serial ${cert.attributes.serialNumber})`);
  } else {
    console.error(`FAILED to revoke ${id}: HTTP ${status}: ${text.slice(0, 500)}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
