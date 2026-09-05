// App ID / capability provisioning via the App Store Connect API.
//
// Why this exists: adding the widget extension (2026-09-05, TestFlight runs
// #24/#25) requires Xcode's cloud signing to REGISTER a new bundle id
// (com.moodmixformat.mixbase.widgets) and enable the App Groups capability on
// both App IDs. Those identifier-management calls fail on the runners with
// "Authentication failed" even though certificate + profile minting for the
// existing App ID has worked for weeks — so the registration is done here,
// through the public ASC API, where every response is visible. Once the
// identifiers and capabilities exist, cloud signing is back on the code path
// that has always worked.
//
// Same delivery mechanism as asc-certs.mjs: remote maintenance sessions
// cannot dispatch workflows (403), but they CAN push — this runs from a
// push-triggered workflow (asc-provisioning.yml) and takes its orders from
// provisioning-request.json next to it:
//
//   {"action": "none"}            → no-op (parked)
//   {"action": "inspect"}         → read-only: bundle ids, their capabilities,
//                                    and an app-group endpoint probe
//   {"action": "ensure-widgets"}  → idempotent: create the widgets bundle id
//                                    if missing, enable APP_GROUPS on both
//                                    App IDs, then run the same probes
//
// Safety rails: only ever creates the ONE hardcoded widgets bundle id and
// only ever enables capabilities — nothing here deletes or disables anything.
// Capability changes invalidate existing provisioning profiles for the App
// ID, which is fine here: every profile in this setup is minted fresh by
// cloud signing (CI runners and local Xcode alike).

import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com";
const APP_BUNDLE_ID = "com.moodmixformat.mixbase";
const WIDGETS_BUNDLE_ID = "com.moodmixformat.mixbase.widgets";
const APP_GROUP = "group.com.moodmixformat.mixbase";

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

async function asc(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${makeToken()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body — keep raw text */
  }
  return { status: res.status, body: parsed, text };
}

async function listBundleIds() {
  const ids = [];
  let path = "/v1/bundleIds?limit=200";
  while (path) {
    const { status, body, text } = await asc("GET", path);
    if (status !== 200) {
      console.error(`GET ${path} → HTTP ${status}: ${text.slice(0, 500)}`);
      process.exit(1);
    }
    ids.push(...body.data);
    const next = body.links?.next;
    path = next ? next.replace(API, "") : null;
  }
  return ids;
}

async function capabilitiesOf(bundleIdResourceId) {
  // No ?limit here — this relationship rejects the parameter (HTTP 400
  // PARAMETER_ERROR.ILLEGAL, seen on the first run).
  const { status, body, text } = await asc(
    "GET",
    `/v1/bundleIds/${bundleIdResourceId}/bundleIdCapabilities`
  );
  if (status !== 200) {
    console.error(`  capabilities → HTTP ${status}: ${text.slice(0, 300)}`);
    return null;
  }
  return body.data;
}

function printCapabilities(caps) {
  if (caps === null) return;
  if (caps.length === 0) {
    console.log("  capabilities: (none)");
    return;
  }
  for (const cap of caps) {
    console.log(
      `  capability: ${cap.attributes?.capabilityType}  id=${cap.id}` +
        (cap.attributes?.settings ? `  settings=${JSON.stringify(cap.attributes.settings)}` : "")
    );
  }
}

// Best-effort probe of app-group support in the public API — informational
// only, never fails the run. Xcode assigns app groups through its own
// developer-services flow; this shows whether the public API can too.
async function probeAppGroups() {
  console.log("\n=== App-group endpoint probe (informational) ===");
  const { status, text } = await asc("GET", "/v1/appGroups?limit=200");
  console.log(`GET /v1/appGroups → HTTP ${status}: ${text.slice(0, 600)}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const request = JSON.parse(readFileSync(join(here, "provisioning-request.json"), "utf8"));

if (request.action === "none") {
  console.log("action=none — parked, nothing to do.");
  process.exit(0);
}
if (request.action !== "inspect" && request.action !== "ensure-widgets") {
  console.error(`Unknown action ${JSON.stringify(request.action)}`);
  process.exit(1);
}

const all = await listBundleIds();
console.log(`\n=== Bundle id inventory (${all.length} total) ===`);
const relevant = all.filter((b) =>
  String(b.attributes.identifier).startsWith("com.moodmixformat.")
);
for (const b of relevant.length ? relevant : all) {
  console.log(
    `id=${b.id}  identifier=${b.attributes.identifier}  name=${JSON.stringify(
      b.attributes.name
    )}  platform=${b.attributes.platform}`
  );
  printCapabilities(await capabilitiesOf(b.id));
}

let failed = false;

if (request.action === "ensure-widgets") {
  const main = all.find((b) => b.attributes.identifier === APP_BUNDLE_ID);
  if (!main) {
    console.error(`\n${APP_BUNDLE_ID} not found in the inventory — refusing to continue.`);
    process.exit(1);
  }

  // 1. The widgets bundle id.
  let widgets = all.find((b) => b.attributes.identifier === WIDGETS_BUNDLE_ID);
  if (widgets) {
    console.log(`\nwidgets bundle id already registered (${widgets.id}).`);
  } else {
    console.log(`\nRegistering ${WIDGETS_BUNDLE_ID}…`);
    const { status, body, text } = await asc("POST", "/v1/bundleIds", {
      data: {
        type: "bundleIds",
        attributes: { identifier: WIDGETS_BUNDLE_ID, name: "mixBase Widgets", platform: "IOS" },
      },
    });
    if (status === 201) {
      widgets = body.data;
      console.log(`CREATED bundle id ${widgets.id} (${WIDGETS_BUNDLE_ID})`);
    } else {
      console.error(`FAILED to create bundle id: HTTP ${status}: ${text.slice(0, 800)}`);
      if (status === 401 || status === 403) {
        console.error(
          "→ The ASC key cannot manage identifiers (this is the same wall Xcode's cloud " +
            "signing is hitting). Fix: in App Store Connect → Users and Access → " +
            "Integrations, this key needs a role with 'Certificates, Identifiers & " +
            "Profiles' access (Admin), or register the identifiers once by hand in " +
            "developer.apple.com → Identifiers."
        );
      }
      failed = true;
    }
  }

  // 2. APP_GROUPS capability on both App IDs.
  for (const target of [main, widgets].filter(Boolean)) {
    const caps = await capabilitiesOf(target.id);
    const has = (caps ?? []).some((c) => c.attributes?.capabilityType === "APP_GROUPS");
    if (has) {
      console.log(`APP_GROUPS already enabled on ${target.attributes.identifier}.`);
      continue;
    }
    console.log(`Enabling APP_GROUPS on ${target.attributes.identifier}…`);
    const { status, text } = await asc("POST", "/v1/bundleIdCapabilities", {
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType: "APP_GROUPS" },
        relationships: { bundleId: { data: { type: "bundleIds", id: target.id } } },
      },
    });
    if (status === 201) {
      console.log(`ENABLED APP_GROUPS on ${target.attributes.identifier}`);
    } else {
      console.error(
        `FAILED to enable APP_GROUPS on ${target.attributes.identifier}: HTTP ${status}: ${text.slice(0, 800)}`
      );
      failed = true;
    }
  }

  console.log(`\nApp group expected by the entitlements: ${APP_GROUP}`);
}

await probeAppGroups();

process.exit(failed ? 1 : 0);
