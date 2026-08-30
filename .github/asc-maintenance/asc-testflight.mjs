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
//    "linkLimit": 50,
//    "betaDescription": "..."}  → ensure an external beta group whose newest
//                                  build is attached + submitted for Beta App
//                                  Review, enable its public link, print it
//
// The same workflow also re-runs this after every "iOS TestFlight" upload
// (workflow_run trigger), which is what keeps external testers on the newest
// build: TestFlight groups do not pick up new builds by themselves, and each
// new build needs its own beta-review submission (instant after the first).
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
// Idempotent: everything already in place is skipped, so re-runs just
// re-print the link.

import { createSign, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://api.appstoreconnect.apple.com";
const BUNDLE_ID = "com.moodmixformat.mixbase";
const DEFAULT_GROUP_NAME = "mixBASE Beta";
// A build uploaded moments ago sits in PROCESSING for a few minutes before it
// can be attached anywhere; the workflow_run trigger fires right after upload,
// so wait it out (bounded — ubuntu minutes are cheap, hanging forever isn't).
const PROCESSING_WAIT_MINUTES = 30;

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

let warned = false;
function warn(msg) {
  console.warn(`WARN: ${msg}`);
  warned = true;
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

// ── Keep the newest build in the group, reviewed ────────────────────────────
// Failures in this phase are warnings: the link is the deliverable, and the
// build appears for testers as soon as the pieces are in place.
try {
  // Newest non-expired build, waiting out PROCESSING if the upload just
  // happened (the workflow_run trigger lands here minutes after upload).
  let build = null;
  const deadline = Date.now() + PROCESSING_WAIT_MINUTES * 60 * 1000;
  for (;;) {
    const buildsRes = await asc(
      "GET",
      `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=5&fields[builds]=version,uploadedDate,processingState,expired`
    );
    if (buildsRes.status !== 200) {
      warn(`could not list builds: HTTP ${buildsRes.status}: ${buildsRes.text.slice(0, 300)}`);
      break;
    }
    const fresh = (buildsRes.body.data ?? []).filter((b) => !b.attributes.expired);
    build = fresh.find((b) => b.attributes.processingState === "VALID") ?? null;
    const processing = fresh.some((b) => b.attributes.processingState === "PROCESSING");
    // A build still PROCESSING that is newer than the newest VALID one is the
    // build this run is here for — wait for it.
    const newestIsProcessing = fresh[0]?.attributes.processingState === "PROCESSING";
    if (!newestIsProcessing || Date.now() > deadline) {
      if (newestIsProcessing) warn("newest build still PROCESSING after the wait — using newest VALID build.");
      if (!build && processing) warn("no VALID build yet (still processing) — build must be attached on a later run.");
      break;
    }
    console.log("Newest build is PROCESSING — waiting 60s…");
    await sleep(60_000);
  }

  if (build) {
    console.log(`Newest valid build: ${build.attributes.version} (uploaded ${build.attributes.uploadedDate}).`);

    const groupBuilds = await asc("GET", `/v1/betaGroups/${group.id}/builds?limit=50`);
    const inGroup =
      groupBuilds.status === 200 && (groupBuilds.body.data ?? []).some((b) => b.id === build.id);
    if (inGroup) {
      console.log("Build already in the group.");
    } else {
      const attach = await asc("POST", `/v1/betaGroups/${group.id}/relationships/builds`, {
        data: [{ type: "builds", id: build.id }],
      });
      if (attach.status === 204) console.log("Attached build to the group.");
      else warn(`could not attach build: HTTP ${attach.status}: ${attach.text.slice(0, 300)}`);
    }

    // Beta App Review requires a beta description on the app's TestFlight
    // "Test Information" — fill any empty localization from the request
    // (first hit 2026-08-30: MISSING_BETA_APP_DESCRIPTION).
    if (request.betaDescription) {
      const locs = await asc("GET", `/v1/apps/${appId}/betaAppLocalizations?limit=50`);
      const rows = locs.status === 200 ? (locs.body.data ?? []) : [];
      if (rows.length === 0) {
        const created = await asc("POST", "/v1/betaAppLocalizations", {
          data: {
            type: "betaAppLocalizations",
            attributes: { locale: "en-US", description: request.betaDescription },
            relationships: { app: { data: { type: "apps", id: appId } } },
          },
        });
        if (created.status === 201) console.log("Created en-US beta localization with description.");
        else warn(`could not create beta localization: HTTP ${created.status}: ${created.text.slice(0, 300)}`);
      } else {
        for (const row of rows) {
          const hasDescription = Boolean(row.attributes.description);
          console.log(`Beta localization ${row.attributes.locale}: description ${hasDescription ? "set" : "EMPTY"}`);
          if (hasDescription) continue;
          const patched = await asc("PATCH", `/v1/betaAppLocalizations/${row.id}`, {
            data: {
              type: "betaAppLocalizations",
              id: row.id,
              attributes: { description: request.betaDescription },
            },
          });
          if (patched.status === 200) console.log(`Filled ${row.attributes.locale} description.`);
          else warn(`could not set ${row.attributes.locale} description: HTTP ${patched.status}: ${patched.text.slice(0, 300)}`);
        }
      }
    }

    // Beta App Review also needs review contact info and (for a sign-in app)
    // a demo account — second 422, MISSING_REQUIRED_DATA. The App Store
    // release already carries all of it, so copy it SERVER-SIDE from the
    // released version's review detail: the values never appear in these
    // public logs and never touch the repo. Only presence is printed.
    let reviewContactEmail = null;
    try {
      // Presence is reported for all fields; only the non-secret ones are
      // ever copied. The demo account's secret is deliberately excluded from
      // COPY_FIELDS — if ASC reports it missing, it has to be set once by
      // hand in App Store Connect (TestFlight → Test Information), and the
      // run log will say so.
      const REVIEW_FIELDS = [
        "contactFirstName",
        "contactLastName",
        "contactEmail",
        "contactPhone",
        "demoAccountName",
        "demoAccountPassword",
        "demoAccountRequired",
      ];
      const COPY_FIELDS = REVIEW_FIELDS.filter((f) => f !== "demoAccountPassword");
      const detail = await asc("GET", `/v1/apps/${appId}/betaAppReviewDetail`);
      if (detail.status !== 200 || !detail.body?.data) {
        warn(`could not read betaAppReviewDetail: HTTP ${detail.status}`);
      } else {
        const attrs = detail.body.data.attributes ?? {};
        const missing = REVIEW_FIELDS.filter(
          (f) => attrs[f] === null || attrs[f] === undefined || attrs[f] === ""
        );
        console.log(
          `Beta review detail: ${REVIEW_FIELDS.map((f) => `${f}=${missing.includes(f) ? "EMPTY" : "set"}`).join("  ")}`
        );
        if (missing.length > 0) {
          const versions = await asc(
            "GET",
            `/v1/apps/${appId}/appStoreVersions?limit=5&fields[appStoreVersions]=versionString,appStoreState`
          );
          let source = null;
          for (const v of versions.body?.data ?? []) {
            const rd = await asc("GET", `/v1/appStoreVersions/${v.id}/appStoreReviewDetail`);
            if (rd.status === 200 && rd.body?.data?.attributes) {
              source = rd.body.data.attributes;
              console.log(`Copying review detail from App Store version ${v.attributes.versionString}.`);
              break;
            }
          }
          if (!source) {
            warn("no App Store review detail found to copy from — beta review contact must be set in ASC by hand.");
          } else {
            reviewContactEmail = source.contactEmail ?? null;
            const patchAttrs = {};
            for (const f of missing) {
              if (!COPY_FIELDS.includes(f)) continue;
              if (source[f] !== null && source[f] !== undefined && source[f] !== "") {
                patchAttrs[f] = source[f];
              }
            }
            if (missing.includes("demoAccountPassword")) {
              warn("demo account secret is EMPTY and is never copied by this script — set it once in App Store Connect → TestFlight → Test Information.");
            }
            if (Object.keys(patchAttrs).length === 0) {
              warn("App Store review detail has none of the missing fields either — set them in ASC by hand.");
            } else {
              const patched = await asc("PATCH", `/v1/betaAppReviewDetails/${detail.body.data.id}`, {
                data: {
                  type: "betaAppReviewDetails",
                  id: detail.body.data.id,
                  attributes: patchAttrs,
                },
              });
              if (patched.status === 200) {
                console.log(`Copied ${Object.keys(patchAttrs).join(", ")} into the beta review detail.`);
              } else {
                warn(`could not patch betaAppReviewDetail: HTTP ${patched.status}: ${patched.text.slice(0, 300)}`);
              }
            }
          }
        }
      }
    } catch (err) {
      warn(`beta review detail phase threw: ${err.message}`);
    }

    // TestFlight "Test Information" additionally requires a feedback email
    // for external testing, and a privacy policy URL keeps the listing
    // complete. The feedback address comes from the request, falling back to
    // the App Store review contact copied above (server-side, never logged).
    try {
      const feedbackEmail = request.feedbackEmail ?? reviewContactEmail;
      const privacyPolicyUrl = request.privacyPolicyUrl ?? null;
      const locs = await asc("GET", `/v1/apps/${appId}/betaAppLocalizations?limit=50`);
      for (const row of locs.status === 200 ? (locs.body.data ?? []) : []) {
        const fill = {};
        if (!row.attributes.feedbackEmail && feedbackEmail) fill.feedbackEmail = feedbackEmail;
        if (!row.attributes.privacyPolicyUrl && privacyPolicyUrl) fill.privacyPolicyUrl = privacyPolicyUrl;
        console.log(
          `Beta localization ${row.attributes.locale}: feedbackEmail ${row.attributes.feedbackEmail ? "set" : "EMPTY"}, privacyPolicyUrl ${row.attributes.privacyPolicyUrl ? "set" : "EMPTY"}`
        );
        if (Object.keys(fill).length === 0) continue;
        const patched = await asc("PATCH", `/v1/betaAppLocalizations/${row.id}`, {
          data: { type: "betaAppLocalizations", id: row.id, attributes: fill },
        });
        if (patched.status === 200) console.log(`Filled ${Object.keys(fill).join(", ")} for ${row.attributes.locale}.`);
        else warn(`could not fill ${Object.keys(fill).join(", ")}: HTTP ${patched.status}: ${patched.text.slice(0, 300)}`);
      }
    } catch (err) {
      warn(`feedback-email phase threw: ${err.message}`);
    }

    // A build uploaded without an export-compliance answer strands as
    // "Missing Compliance" — the Info.plist carries the answer for new
    // builds, but heal older ones here (standard HTTPS only → exempt).
    const buildCompliance = await asc(
      "GET",
      `/v1/builds/${build.id}?fields[builds]=usesNonExemptEncryption,version`
    );
    const usesNonExempt = buildCompliance.body?.data?.attributes?.usesNonExemptEncryption;
    console.log(`Build usesNonExemptEncryption: ${usesNonExempt === null ? "UNANSWERED" : usesNonExempt}`);
    if (usesNonExempt === null) {
      const patched = await asc("PATCH", `/v1/builds/${build.id}`, {
        data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } },
      });
      if (patched.status === 200) console.log("Marked build exempt (standard HTTPS/TLS only).");
      else warn(`could not set export compliance: HTTP ${patched.status}: ${patched.text.slice(0, 300)}`);
    }

    // External distribution needs Beta App Review, once per build (the first
    // one is a human review; later builds usually clear in minutes).
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
        warn(`beta-review submission failed: HTTP ${submit.status}: ${submit.text.slice(0, 500)}`);
      }
    }
  }
} catch (err) {
  warn(`build phase threw: ${err.message}`);
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

if (warned) console.log("\nFinished with warnings — check the lines above.");
process.exit(0);
