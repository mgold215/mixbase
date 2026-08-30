// TestFlight external-testing maintenance via the App Store Connect API.
//
// Same delivery mechanism as asc-certs.mjs: remote maintenance sessions
// cannot dispatch workflows (403) or log into App Store Connect, but they
// CAN push — so this runs from a push-triggered workflow (asc-testflight.yml)
// and takes its orders from testflight-request.json next to it:
//
//   {"action": "none"}          → no-op (parked)
//   {"action": "public-link",
//    "groupName": null,
//    "linkLimit": 50}           → ensure an external beta group with a build,
//                                  enable its public TestFlight link, print it
//
// groupName null picks the first external (non-internal) beta group, creating
// "mixBASE Beta" if the app has none — internal groups are ASC team members
// only, so outside artists can never join one.
//
// Deliberately NO per-email tester action here: this repo is PUBLIC, so a
// request file (or run log) carrying a tester's email address would publish
// their PII. Individual invites are sent by the owner from their own email
// using the public link this prints. The link is made for sharing and safe
// to appear in logs; linkLimit caps how many people can join through it.
//
// Idempotent: re-runs re-print the existing link and change nothing else.

import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://api.appstoreconnect.apple.com";
const BUNDLE_ID = "com.moodmixformat.mixbase";
const DEFAULT_GROUP_NAME = "mixBASE Beta";

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

async function asc(method, path, json) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${makeToken()}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
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

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const request = JSON.parse(readFileSync(join(here, "testflight-request.json"), "utf8"));

if (request.action === "none") {
  console.log("action=none — parked, no changes made.");
  process.exit(0);
}
if (request.action !== "public-link") die(`Unknown action ${JSON.stringify(request.action)}`);

// ── App ─────────────────────────────────────────────────────────────────────
const appRes = await asc("GET", `/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`);
if (appRes.status !== 200 || !appRes.body?.data?.length) {
  die(`Could not find app ${BUNDLE_ID}: HTTP ${appRes.status}: ${appRes.text.slice(0, 500)}`);
}
const appId = appRes.body.data[0].id;
console.log(`App ${BUNDLE_ID} → id=${appId}`);

// ── Beta group ──────────────────────────────────────────────────────────────
const groupsRes = await asc("GET", `/v1/betaGroups?filter[app]=${appId}&limit=50`);
if (groupsRes.status !== 200) {
  die(`Could not list beta groups: HTTP ${groupsRes.status}: ${groupsRes.text.slice(0, 500)}`);
}
const groups = groupsRes.body.data ?? [];
console.log(`\n=== Beta groups (${groups.length}) ===`);
for (const g of groups) {
  console.log(
    `id=${g.id}  name=${JSON.stringify(g.attributes.name)}  internal=${g.attributes.isInternalGroup}  publicLink=${g.attributes.publicLinkEnabled ? g.attributes.publicLink : "off"}`
  );
}

let group = null;
if (request.groupName) {
  group = groups.find(
    (g) => g.attributes.name.toLowerCase() === String(request.groupName).toLowerCase()
  );
  if (!group) die(`No beta group named ${JSON.stringify(request.groupName)} — refusing to guess.`);
  if (group.attributes.isInternalGroup) {
    die(`Group ${JSON.stringify(request.groupName)} is internal — public links need an external group.`);
  }
} else {
  group = groups.find((g) => !g.attributes.isInternalGroup) ?? null;
}

if (!group) {
  console.log(`\nNo external beta group exists — creating ${JSON.stringify(DEFAULT_GROUP_NAME)}.`);
  const created = await asc("POST", "/v1/betaGroups", {
    data: {
      type: "betaGroups",
      attributes: { name: DEFAULT_GROUP_NAME },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  });
  if (created.status !== 201) {
    die(`Failed to create beta group: HTTP ${created.status}: ${created.text.slice(0, 500)}`);
  }
  group = created.body.data;
}
console.log(`\nTarget group: ${JSON.stringify(group.attributes.name)} (id=${group.id})`);

// ── Make sure the group has a build ─────────────────────────────────────────
// A public link with no reviewed build joins the tester to an empty app, so
// attach the newest valid build and make sure it has a beta-review
// submission. Failures here are warnings: the link is the deliverable and
// the build appears for testers as soon as review clears.
let warned = false;
try {
  const groupBuilds = await asc("GET", `/v1/betaGroups/${group.id}/builds?limit=10`);
  const haveBuilds = groupBuilds.status === 200 && (groupBuilds.body.data ?? []).length > 0;
  console.log(`Group has ${haveBuilds ? (groupBuilds.body.data ?? []).length : 0} build(s).`);

  if (!haveBuilds) {
    const buildsRes = await asc(
      "GET",
      `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=5&fields[builds]=version,uploadedDate,processingState,expired`
    );
    const builds = (buildsRes.body?.data ?? []).filter(
      (b) => b.attributes.processingState === "VALID" && !b.attributes.expired
    );
    if (buildsRes.status !== 200 || builds.length === 0) {
      console.warn("WARN: no valid, unexpired build found to attach — link works, build must be added in ASC.");
      warned = true;
    } else {
      const build = builds[0];
      console.log(`Attaching newest valid build ${build.attributes.version} (uploaded ${build.attributes.uploadedDate}).`);
      const attach = await asc("POST", `/v1/betaGroups/${group.id}/relationships/builds`, {
        data: [{ type: "builds", id: build.id }],
      });
      if (attach.status !== 204) {
        console.warn(`WARN: could not attach build: HTTP ${attach.status}: ${attach.text.slice(0, 500)}`);
        warned = true;
      }
      // External distribution needs Beta App Review at least once per version.
      const sub = await asc("GET", `/v1/builds/${build.id}/betaAppReviewSubmission`);
      if (sub.status === 200 && sub.body?.data) {
        console.log(`Beta review state: ${sub.body.data.attributes.betaReviewState}`);
      } else {
        console.log("No beta-review submission — submitting the build for Beta App Review.");
        const submit = await asc("POST", "/v1/betaAppReviewSubmissions", {
          data: {
            type: "betaAppReviewSubmissions",
            relationships: { build: { data: { type: "builds", id: build.id } } },
          },
        });
        if (submit.status === 201) {
          console.log(`Submitted: state ${submit.body.data.attributes.betaReviewState}`);
        } else {
          console.warn(`WARN: beta-review submission failed: HTTP ${submit.status}: ${submit.text.slice(0, 500)}`);
          warned = true;
        }
      }
    }
  }
} catch (err) {
  console.warn(`WARN: build-attachment phase threw: ${err.message}`);
  warned = true;
}

// ── Enable the public link ──────────────────────────────────────────────────
if (group.attributes.publicLinkEnabled && group.attributes.publicLink) {
  console.log(`\nPUBLIC LINK (already enabled): ${group.attributes.publicLink}`);
} else {
  const limit = Number.isInteger(request.linkLimit) && request.linkLimit > 0 ? request.linkLimit : 50;
  const patch = await asc("PATCH", `/v1/betaGroups/${group.id}`, {
    data: {
      type: "betaGroups",
      id: group.id,
      attributes: {
        publicLinkEnabled: true,
        publicLinkLimitEnabled: true,
        publicLinkLimit: limit,
      },
    },
  });
  if (patch.status !== 200) {
    die(`Failed to enable public link: HTTP ${patch.status}: ${patch.text.slice(0, 500)}`);
  }
  console.log(`\nPUBLIC LINK (limit ${limit}): ${patch.body.data.attributes.publicLink}`);
}

if (warned) console.log("\nFinished with warnings — check the build/beta-review lines above.");
process.exit(0);
