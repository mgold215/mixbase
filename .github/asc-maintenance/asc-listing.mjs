// App Store listing publisher: version copy + screenshots + build + submit.
//
// Runs from .github/workflows/app-store-listing.yml (push-driven TEMP branch
// asc7-listing, same pattern as the other asc-* lanes — remote sessions
// cannot dispatch workflows). Orders come from listing-request.json:
//
//   action: "inspect"  → read-only: prints the version/state, what would
//                        change in the copy, the screenshot sets, candidate
//                        builds and open review submissions.
//   action: "publish"  → creates App Store version `version` (iOS) if it does
//                        not exist, writes listing-copy.json into its en-US
//                        localization (+ subtitle on the pending app info),
//                        replaces the iPhone screenshot sets from
//                        $SCREENSHOTS_DIR/{iphone69,iphone65}, drops iPad sets
//                        when deleteIpadSets, attaches the newest processed
//                        `version` build uploaded after minBuildUploadedAt
//                        (waiting up to buildWaitMinutes for processing), and
//                        with submit:true creates + submits the review
//                        submission. Never cancels an open submission.
//
// Safety rails: refuses to touch a version that is in review or live, only
// ever edits the one version named in the request, and validates every copy
// field against Apple's length limits before the first write.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, fail, findApp, sleep } from "./listing-asc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const request = JSON.parse(readFileSync(join(here, "listing-request.json"), "utf8"));
const copy = JSON.parse(readFileSync(join(here, "listing-copy.json"), "utf8"));
const SHOTS = process.env.SCREENSHOTS_DIR || join(process.cwd(), "shots");
const WRITE = request.action === "publish";
const log = (...a) => console.log(...a);

if (!["inspect", "publish"].includes(request.action)) fail(`unknown action ${request.action}`);
if (!/^\d+\.\d+(\.\d+)?$/.test(request.version ?? "")) fail(`bad version ${request.version}`);
const LIMITS = { subtitle: 30, promotionalText: 170, keywords: 100, description: 4000, whatsNew: 4000 };
for (const [k, max] of Object.entries(LIMITS)) {
  const n = (copy[k] ?? "").length;
  if (n > max) fail(`${k} is ${n} chars (max ${max})`);
}
log(`mode: ${request.action.toUpperCase()}  version: ${request.version}  submit: ${!!request.submit}`);

const app = await findApp();

// ── 1. The App Store version ─────────────────────────────────────────────
const EDITABLE = new Set(["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"]);
const versions = await api("GET", `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=10`);
for (const v of versions.json?.data ?? []) {
  log(`  version ${v.attributes.versionString}: ${v.attributes.appVersionState ?? v.attributes.appStoreState}`);
}
let version = (versions.json?.data ?? []).find((v) => v.attributes.versionString === request.version);
if (version) {
  const state = version.attributes.appVersionState ?? version.attributes.appStoreState;
  if (!EDITABLE.has(state)) {
    log(`version ${request.version} is ${state}; nothing here may edit it.`);
    process.exit(WRITE ? 1 : 0);
  }
} else if (WRITE) {
  const created = await api("POST", "/v1/appStoreVersions", {
    data: {
      type: "appStoreVersions",
      attributes: { platform: "IOS", versionString: request.version, releaseType: "AFTER_APPROVAL" },
      relationships: { app: { data: { type: "apps", id: app.id } } },
    },
  });
  if (!created.ok) fail("create version", created);
  version = created.json.data;
  log(`created version ${request.version} (${version.id})`);
} else {
  log(`version ${request.version} does not exist yet (publish would create it)`);
}

// ── 2. Copy: en-US localization of the version ───────────────────────────
let loc = null;
if (version) {
  const locs = await api("GET", `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=10`);
  loc = (locs.json?.data ?? []).find((l) => l.attributes.locale === "en-US");
  const fields = ["description", "keywords", "promotionalText", "whatsNew", "supportUrl", "marketingUrl"];
  if (!loc) {
    log("no en-US localization on the version");
    if (WRITE) {
      const attrs = { locale: "en-US" };
      for (const f of fields) if (copy[f] != null) attrs[f] = copy[f];
      const made = await api("POST", "/v1/appStoreVersionLocalizations", {
        data: { type: "appStoreVersionLocalizations", attributes: attrs,
          relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } },
      });
      if (!made.ok) fail("create localization", made);
      loc = made.json.data;
      log(`created en-US localization ${loc.id}`);
    }
  } else {
    const changes = {};
    for (const f of fields) {
      if (copy[f] != null && (loc.attributes[f] ?? "") !== copy[f]) changes[f] = copy[f];
    }
    log(`copy: ${Object.keys(changes).length ? Object.keys(changes).join(", ") + " would change" : "already up to date"}`);
    if (WRITE && Object.keys(changes).length) {
      const patched = await api("PATCH", `/v1/appStoreVersionLocalizations/${loc.id}`, {
        data: { type: "appStoreVersionLocalizations", id: loc.id, attributes: changes },
      });
      if (!patched.ok) fail("patch localization", patched);
      log("copy written");
    }
  }
}

// ── 3. Subtitle lives on the pending app info ────────────────────────────
{
  const infos = await api("GET", `/v1/apps/${app.id}/appInfos?limit=5`);
  const pending = (infos.json?.data ?? []).filter((i) => {
    const s = i.attributes.state ?? i.attributes.appStoreState;
    return s !== "READY_FOR_DISTRIBUTION" && s !== "REPLACED_WITH_NEW_INFO";
  });
  const info = pending[0];
  if (!info) {
    log("subtitle: no editable app info yet (appears once the version exists)");
  } else {
    const locs = await api("GET", `/v1/appInfos/${info.id}/appInfoLocalizations?limit=10`);
    const il = (locs.json?.data ?? []).find((l) => l.attributes.locale === "en-US");
    if (!il) log("subtitle: no en-US app info localization");
    else if ((il.attributes.subtitle ?? "") === copy.subtitle) log(`subtitle: already "${copy.subtitle}"`);
    else {
      log(`subtitle: "${il.attributes.subtitle}" -> "${copy.subtitle}"`);
      if (WRITE) {
        const r = await api("PATCH", `/v1/appInfoLocalizations/${il.id}`, {
          data: { type: "appInfoLocalizations", id: il.id, attributes: { subtitle: copy.subtitle } },
        });
        if (!r.ok) fail("patch subtitle", r);
      }
    }
  }
}

// ── 4. Screenshots ───────────────────────────────────────────────────────
const SETS = [
  ["APP_IPHONE_67", "iphone69", [1320, 2868]],
  ["APP_IPHONE_65", "iphone65", [1284, 2778]],
];
function pickFiles(dir) {
  if (!existsSync(dir)) return [];
  let files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png")).sort();
  if (Array.isArray(request.screenshots) && request.screenshots.length) {
    const wanted = request.screenshots.map((n) => `${n}.png`);
    files = wanted.filter((w) => files.includes(w));
  }
  return files.map((f) => join(dir, f));
}
async function uploadScreenshot(setId, file) {
  const bytes = readFileSync(file);
  const reserve = await api("POST", "/v1/appScreenshots", {
    data: { type: "appScreenshots", attributes: { fileName: basename(file), fileSize: bytes.length },
      relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } } },
  });
  if (!reserve.ok) fail(`reserve ${basename(file)}`, reserve);
  const shot = reserve.json.data;
  for (const op of shot.attributes.uploadOperations ?? []) {
    const headers = Object.fromEntries((op.requestHeaders ?? []).map((h) => [h.name, h.value]));
    const res = await fetch(op.url, { method: op.method, headers, body: bytes.subarray(op.offset, op.offset + op.length) });
    if (!res.ok) fail(`upload chunk ${basename(file)} @${op.offset}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  const commit = await api("PATCH", `/v1/appScreenshots/${shot.id}`, {
    data: { type: "appScreenshots", id: shot.id,
      attributes: { uploaded: true, sourceFileChecksum: createHash("md5").update(bytes).digest("hex") } },
  });
  if (!commit.ok) fail(`commit ${basename(file)}`, commit);
  return shot.id;
}
if (loc) {
  const sets = await api("GET", `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?include=appScreenshots&limit=20`);
  const included = new Map((sets.json?.included ?? []).map((i) => [i.id, i]));
  const byType = new Map((sets.json?.data ?? []).map((s) => [s.attributes.screenshotDisplayType, s]));
  for (const s of sets.json?.data ?? []) {
    const n = (s.relationships?.appScreenshots?.data ?? []).length;
    log(`  set ${s.attributes.screenshotDisplayType}: ${n} screenshots`);
  }
  if (request.deleteIpadSets) {
    for (const [type, s] of byType) {
      if (!type.startsWith("APP_IPAD")) continue;
      log(`iPad set ${type}: ${WRITE ? "deleting" : "would delete"}`);
      if (WRITE) {
        const r = await api("DELETE", `/v1/appScreenshotSets/${s.id}`);
        if (!r.ok && r.status !== 404) fail(`delete set ${type}`, r);
      }
    }
  }
  const uploadedIds = [];
  for (const [type, sub, [w, h]] of SETS) {
    const files = pickFiles(join(SHOTS, sub));
    log(`${type} <- ${files.length} files from ${sub}/ (${w}x${h}): ${files.map((f) => basename(f)).join(", ") || "none"}`);
    if (!files.length) { if (WRITE) fail(`no screenshots for ${type}`); continue; }
    if (!WRITE) continue;
    let set = byType.get(type);
    if (!set) {
      const made = await api("POST", "/v1/appScreenshotSets", {
        data: { type: "appScreenshotSets", attributes: { screenshotDisplayType: type },
          relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: loc.id } } } },
      });
      if (!made.ok) fail(`create set ${type}`, made);
      set = made.json.data;
      log(`  created set ${type}`);
    } else {
      for (const ref of set.relationships?.appScreenshots?.data ?? []) {
        const old = included.get(ref.id);
        const r = await api("DELETE", `/v1/appScreenshots/${ref.id}`);
        if (!r.ok && r.status !== 404) fail(`delete old screenshot ${old?.attributes?.fileName ?? ref.id}`, r);
      }
      log(`  cleared ${(set.relationships?.appScreenshots?.data ?? []).length} old screenshots from ${type}`);
    }
    const ids = [];
    for (const file of files) {
      const id = await uploadScreenshot(set.id, file);
      ids.push(id);
      log(`  uploaded ${basename(file)} -> ${id}`);
    }
    const order = await api("PATCH", `/v1/appScreenshotSets/${set.id}/relationships/appScreenshots`, {
      data: ids.map((id) => ({ type: "appScreenshots", id })),
    });
    if (!order.ok) fail(`order ${type}`, order);
    uploadedIds.push(...ids);
  }
  if (WRITE && uploadedIds.length) {
    const deadline = Date.now() + 10 * 60 * 1000;
    let pending = new Set(uploadedIds);
    while (pending.size && Date.now() < deadline) {
      await sleep(10000);
      for (const id of [...pending]) {
        const r = await api("GET", `/v1/appScreenshots/${id}?fields[appScreenshots]=fileName,assetDeliveryState`);
        const st = r.json?.data?.attributes?.assetDeliveryState?.state;
        if (st === "COMPLETE") pending.delete(id);
        else if (st === "FAILED") fail(`screenshot ${r.json?.data?.attributes?.fileName} failed processing: ${JSON.stringify(r.json?.data?.attributes?.assetDeliveryState)}`);
      }
      log(`  screenshots still processing: ${pending.size}`);
    }
    if (pending.size) fail(`${pending.size} screenshots never reached COMPLETE`);
    log("all screenshots COMPLETE");
  }
}

// ── 5. Build ─────────────────────────────────────────────────────────────
let attachedBuild = null;
if (version) {
  const current = await api("GET", `/v1/appStoreVersions/${version.id}/build?fields[builds]=version,uploadedDate,processingState`);
  attachedBuild = current.json?.data ?? null;
  log(`attached build: ${attachedBuild ? `${attachedBuild.attributes.version} (${attachedBuild.attributes.processingState})` : "none"}`);
}
if (request.attachBuild) {
  const minUpload = request.minBuildUploadedAt ? Date.parse(request.minBuildUploadedAt) : 0;
  const deadline = Date.now() + (request.buildWaitMinutes ?? 0) * 60 * 1000;
  let chosen = null;
  for (;;) {
    const builds = await api("GET",
      `/v1/builds?filter[app]=${app.id}&filter[preReleaseVersion.platform]=IOS&filter[preReleaseVersion.version]=${request.version}` +
      `&sort=-uploadedDate&limit=10&fields[builds]=version,uploadedDate,processingState,expired`);
    const candidates = (builds.json?.data ?? []).filter((b) => !b.attributes.expired && Date.parse(b.attributes.uploadedDate) >= minUpload);
    for (const b of candidates) log(`  candidate build ${b.attributes.version}: ${b.attributes.processingState} (uploaded ${b.attributes.uploadedDate})`);
    chosen = candidates.find((b) => b.attributes.processingState === "VALID") ?? null;
    const processing = candidates.some((b) => b.attributes.processingState === "PROCESSING");
    if (chosen || !WRITE || !processing || Date.now() >= deadline) break;
    log("  newest build still processing; waiting 60s");
    await sleep(60000);
  }
  if (!chosen) {
    log(`no processed ${request.version} build uploaded after ${request.minBuildUploadedAt ?? "the beginning"}`);
    if (WRITE) fail("no build to attach");
  } else if (WRITE && version) {
    if (attachedBuild?.id === chosen.id) log(`build ${chosen.attributes.version} already attached`);
    else {
      const r = await api("PATCH", `/v1/appStoreVersions/${version.id}/relationships/build`, { data: { type: "builds", id: chosen.id } });
      if (!r.ok) fail("attach build", r);
      attachedBuild = chosen;
      log(`attached build ${chosen.attributes.version}`);
    }
  } else if (chosen) {
    log(`would attach build ${chosen.attributes.version}`);
  }
}

// ── 6. Review submission ─────────────────────────────────────────────────
{
  const open = await api("GET",
    `/v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=5`);
  const openSubs = open.json?.data ?? [];
  for (const s of openSubs) log(`  open submission ${s.id}: ${s.attributes.state} (${s.attributes.submittedDate ?? "not submitted"})`);
  if (request.submit && WRITE) {
    if (!version || !attachedBuild) fail("cannot submit without a version and an attached build");
    if (openSubs.length) {
      log("an open review submission already exists; not creating another (cancel it in App Store Connect first)");
    } else {
      const sub = await api("POST", "/v1/reviewSubmissions", {
        data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } },
      });
      if (!sub.ok) fail("create review submission", sub);
      const subId = sub.json.data.id;
      let item = null;
      for (let attempt = 1; attempt <= 8 && !item?.ok; attempt++) {
        item = await api("POST", "/v1/reviewSubmissionItems", {
          data: { type: "reviewSubmissionItems", relationships: {
            reviewSubmission: { data: { type: "reviewSubmissions", id: subId } },
            appStoreVersion: { data: { type: "appStoreVersions", id: version.id } } } },
        });
        if (!item.ok) { log(`  add item attempt ${attempt}: HTTP ${item.status} ${item.text.slice(0, 200)}`); await sleep(15000); }
      }
      if (!item?.ok) fail("add version to submission", item);
      const go = await api("PATCH", `/v1/reviewSubmissions/${subId}`, {
        data: { type: "reviewSubmissions", id: subId, attributes: { submitted: true } },
      });
      if (!go.ok) fail("submit for review", go);
      log(`SUBMITTED for review: submission ${subId} (${go.json?.data?.attributes?.state})`);
    }
  } else if (request.submit) {
    log("submit requested, but inspect mode never submits");
  }
}

log(WRITE ? "publish complete" : "inspection complete; nothing changed");
