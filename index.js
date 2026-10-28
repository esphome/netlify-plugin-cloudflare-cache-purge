/**
 * Netlify Build Plugin: Purge changed URLs from the Cloudflare CDN cache after a successful deploy.
 *
 * Requires the following environment variables to be set in Netlify:
 *   CLOUDFLARE_API_TOKEN  - API token with "Cache Purge" permission for the zone
 *   CLOUDFLARE_ZONE_ID    - Zone ID of the Cloudflare zone
 *
 * The hostname to purge is derived from the site URL: the `siteUrl` input, else the SITE_URL env var, else the
 * URL env var that Netlify sets per deploy.
 *
 * Plugin inputs (all optional, see manifest.yml):
 *   immutablePrefixes  - content-hashed path prefixes whose added/removed files never need a purge
 *   maxUrls            - above this many URLs the purge becomes a whole-host purge
 *   maxPrefixes        - above this many prefixes the purge becomes a whole-host purge
 *   contexts           - Netlify deploy contexts the plugin runs in
 *   manifestPath       - site path of the manifest, relative to the publish dir
 *   siteUrl            - site URL to take the hostname from
 *
 * How it works:
 *   1. onPostBuild hashes every file in the publish dir and writes the result, plus the resolved redirect rules,
 *      to the manifest path inside the publish dir so it ships with the deploy.
 *   2. onPostBuild also fetches the manifest of the currently live deploy straight from Netlify (bypassing
 *      Cloudflare), diffs the two and stores the list of URLs and prefixes to purge in a temp file.
 *   3. onSuccess purges only those URLs. If no previous manifest is available, or too much changed, the whole
 *      hostname is purged instead.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * @typedef {object} Options
 * @property {string[]} immutablePrefixes Prefixes (relative to the publish dir) of content-hashed files.
 * @property {number} maxUrls Above this many URLs fall back to a whole-host purge.
 * @property {number} maxPrefixes Above this many prefixes fall back to a whole-host purge.
 * @property {string[]} contexts Netlify deploy contexts the plugin runs in.
 * @property {string} manifestPath Site path of the manifest, relative to the publish dir.
 * @property {string | null} siteUrl Explicit site URL, or null to use the environment.
 */

/**
 * @typedef {object} Plan
 * @property {{ added: number, changed: number, removed: number, redirectsAdded: number, redirectsRemoved: number }} [summary]
 * @property {string[]} [paths] Site paths to purge.
 * @property {string[]} [prefixes] Site path prefixes to purge.
 * @property {string | null} fallbackReason Set when the whole host must be purged instead.
 */

/**
 * Defaults for every plugin input.
 * - immutablePrefixes: content-hashed files. A new name was never cached (a cached 404 lasts 60s) and a removed one
 *   is no longer referenced, so only a content change of the same name needs a purge.
 * - maxUrls: 5000 URLs is 50 requests, well inside the Cloudflare URL purge rate limit.
 * - maxPrefixes: 300 prefixes is 3 requests of the 5 per minute budget.
 */
export const DEFAULT_OPTIONS = Object.freeze({
  immutablePrefixes: Object.freeze(["_astro/", "pagefind/fragment/", "pagefind/index/"]),
  maxUrls: 5000,
  maxPrefixes: 300,
  contexts: Object.freeze(["production", "branch-deploy"]),
  manifestPath: "cf-purge-manifest.json",
  siteUrl: null,
});

export const MANIFEST_VERSION = 1;

/**
 * Cloudflare limits (free plan, https://developers.cloudflare.com/cache/how-to/purge-cache/):
 *   - single-file (URL) purge: 100 URLs per request, 800 URLs per second
 *   - prefix / host purge: 100 items per request, 5 requests per minute with a bucket of 25
 */
export const FILES_PER_REQUEST = 100;
export const PREFIXES_PER_REQUEST = 100;

export const retrySettings = { maxRetries: 5, baseDelayMs: 5000 };

const HASH_LENGTH = 16;
const FETCH_TIMEOUT_MS = 30000;
const PLAN_FILE_NAME = "cf-purge-plan.json";

/**
 * @param {string} name Input name for the error message.
 * @param {unknown} value
 * @returns {string[]}
 */
function stringArray(name, value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value;
}

/**
 * @param {string} name Input name for the error message.
 * @param {unknown} value
 * @returns {number}
 */
function nonNegativeInteger(name, value) {
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`${name} must be a non-negative integer`);
}

/**
 * Validate and normalise the plugin inputs. Missing (undefined or null) inputs take their default.
 * @param {Record<string, unknown>} [inputs]
 * @returns {Options}
 */
export function resolveOptions(inputs = {}) {
  const given = (name) => inputs[name] !== undefined && inputs[name] !== null;

  let immutablePrefixes = [...DEFAULT_OPTIONS.immutablePrefixes];
  if (given("immutablePrefixes")) {
    immutablePrefixes = stringArray("immutablePrefixes", inputs.immutablePrefixes).map((prefix) => {
      const stripped = prefix.replace(/^\/+/, "");
      if (stripped === "") {
        throw new Error("immutablePrefixes must not contain an empty prefix");
      }
      return stripped;
    });
  }

  const maxUrls = given("maxUrls") ? nonNegativeInteger("maxUrls", inputs.maxUrls) : DEFAULT_OPTIONS.maxUrls;
  const maxPrefixes = given("maxPrefixes")
    ? nonNegativeInteger("maxPrefixes", inputs.maxPrefixes)
    : DEFAULT_OPTIONS.maxPrefixes;
  const contexts = given("contexts") ? [...stringArray("contexts", inputs.contexts)] : [...DEFAULT_OPTIONS.contexts];

  let manifestPath = DEFAULT_OPTIONS.manifestPath;
  if (given("manifestPath")) {
    if (typeof inputs.manifestPath !== "string" || inputs.manifestPath === "") {
      throw new Error("manifestPath must be a non-empty string");
    }
    manifestPath = inputs.manifestPath.replace(/^\/+/, "");
    if (manifestPath.split("/").some((segment) => segment === ".." || segment === "")) {
      throw new Error('manifestPath must be a relative path without empty or ".." segments');
    }
  }

  let siteUrl = DEFAULT_OPTIONS.siteUrl;
  if (given("siteUrl")) {
    if (typeof inputs.siteUrl !== "string" || inputs.siteUrl === "" || !URL.canParse(inputs.siteUrl)) {
      throw new Error("siteUrl must be a valid URL");
    }
    siteUrl = inputs.siteUrl;
  }

  return { immutablePrefixes, maxUrls, maxPrefixes, contexts, manifestPath, siteUrl };
}

/**
 * The site URL to take the hostname from: the input, else SITE_URL, else URL.
 * @param {Options} options
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export const resolveSiteUrl = (options, env) => options.siteUrl || env.SITE_URL || env.URL || null;

/**
 * @param {string} file Published file path relative to the publish dir.
 * @param {string[]} prefixes
 * @returns {boolean}
 */
export const isImmutable = (file, prefixes) => prefixes.some((prefix) => file.startsWith(prefix));

export const planFilePath = () => path.join(os.tmpdir(), PLAN_FILE_NAME);

/**
 * @param {string | undefined} context
 * @param {string[]} contexts
 * @returns {boolean}
 */
export const shouldRun = (context, contexts) => contexts.includes(context);

/** Recursively list files below dir as forward-slash paths relative to dir. */
export async function listFiles(dir, prefix = "") {
  const entries = await fs.readdir(path.join(dir, prefix), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(dir, relative)));
    } else {
      files.push(relative);
    }
  }
  return files;
}

export async function hashFile(filePath) {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex").slice(0, HASH_LENGTH);
}

/** Reduce Netlify redirect rules to the fields that matter for caching, sorted for a stable manifest. */
export function normalizeRedirects(redirects) {
  return (redirects || [])
    .map((r) => [String(r.from), String(r.to), r.status === undefined ? 301 : Number(r.status), Boolean(r.force)])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * @param {string} publishDir
 * @param {object[] | undefined} redirects
 * @param {string} manifestPath Manifest path relative to the publish dir, excluded from the manifest.
 */
export async function buildManifest(publishDir, redirects, manifestPath) {
  const names = (await listFiles(publishDir)).filter((name) => name !== manifestPath).sort();
  const files = {};
  const batchSize = 64;
  for (let i = 0; i < names.length; i += batchSize) {
    const batch = names.slice(i, i + batchSize);
    const hashes = await Promise.all(batch.map((name) => hashFile(path.join(publishDir, name))));
    batch.forEach((name, index) => {
      files[name] = hashes[index];
    });
  }
  return { version: MANIFEST_VERSION, files, redirects: normalizeRedirects(redirects) };
}

/** Return true if value looks like a manifest produced by buildManifest. */
export function isManifest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.version === MANIFEST_VERSION &&
    value.files !== null &&
    typeof value.files === "object" &&
    Array.isArray(value.redirects)
  );
}

export function diffManifests(previous, current) {
  const added = [];
  const changed = [];
  const removed = [];
  for (const [name, hash] of Object.entries(current.files)) {
    if (!Object.hasOwn(previous.files, name)) {
      added.push(name);
    } else if (previous.files[name] !== hash) {
      changed.push(name);
    }
  }
  for (const name of Object.keys(previous.files)) {
    if (!Object.hasOwn(current.files, name)) {
      removed.push(name);
    }
  }
  const previousRules = new Set(previous.redirects.map((r) => JSON.stringify(r)));
  const currentRules = new Set(current.redirects.map((r) => JSON.stringify(r)));
  const redirectsAdded = current.redirects.filter((r) => !previousRules.has(JSON.stringify(r)));
  const redirectsRemoved = previous.redirects.filter((r) => !currentRules.has(JSON.stringify(r)));
  return { added, changed, removed, redirectsAdded, redirectsRemoved };
}

/** Percent-encode a site path the way a browser would request it. */
export function encodePath(sitePath) {
  return encodeURI(sitePath).replace(/\?/g, "%3F").replace(/#/g, "%23");
}

/** Map a published file (relative to the publish dir) to the site paths Cloudflare may have cached. */
export function fileToPaths(file) {
  if (file === "404.html") {
    return ["/404.html"];
  }
  if (file === "index.html") {
    return ["/", "/index.html"];
  }
  if (file.endsWith("/index.html")) {
    const dir = file.slice(0, -"index.html".length);
    return [`/${dir}`, `/${file}`];
  }
  return [`/${file}`];
}

/**
 * Map a Netlify redirect "from" pattern to a purge target.
 * Returns { path } for an exact path (both slash variants), { prefix } for a pattern (the static part), or null
 * when the rule is for another host.
 */
export function redirectFromToTarget(from, hostname) {
  let pattern = from;
  if (/^https?:\/\//i.test(pattern)) {
    const url = new URL(pattern);
    if (url.hostname !== hostname) {
      return null;
    }
    pattern = decodeURI(url.pathname);
  }
  pattern = pattern.split("?")[0];
  if (!pattern.startsWith("/")) {
    pattern = `/${pattern}`;
  }
  const match = pattern.match(/\*|\/:/);
  if (match) {
    const staticEnd = match[0] === "*" ? match.index : match.index + 1;
    return { prefix: pattern.slice(0, staticEnd) };
  }
  const paths = [pattern];
  const last = pattern.slice(pattern.lastIndexOf("/") + 1);
  if (pattern.endsWith("/")) {
    if (pattern.length > 1) {
      paths.push(pattern.slice(0, -1));
    }
  } else if (!last.includes(".")) {
    paths.push(`${pattern}/`);
  }
  return { paths };
}

/**
 * Build the purge plan (site paths, so it is independent of the hostname) from a manifest diff.
 * @param {ReturnType<typeof diffManifests>} diff
 * @param {string} hostname
 * @param {Pick<Options, "immutablePrefixes" | "maxUrls" | "maxPrefixes">} options
 * @returns {Plan}
 */
export function buildPlan(diff, hostname, options) {
  const paths = new Set();
  const candidates = [...diff.added, ...diff.removed].filter((file) => !isImmutable(file, options.immutablePrefixes));
  for (const file of [...candidates, ...diff.changed]) {
    for (const p of fileToPaths(file)) {
      paths.add(p);
    }
  }
  const prefixes = new Set();
  for (const rule of [...diff.redirectsAdded, ...diff.redirectsRemoved]) {
    const target = redirectFromToTarget(rule[0], hostname);
    if (!target) {
      continue;
    }
    if (target.prefix !== undefined) {
      prefixes.add(target.prefix);
    } else {
      target.paths.forEach((p) => paths.add(p));
    }
  }
  const summary = {
    added: diff.added.length,
    changed: diff.changed.length,
    removed: diff.removed.length,
    redirectsAdded: diff.redirectsAdded.length,
    redirectsRemoved: diff.redirectsRemoved.length,
  };
  const plan = { summary, paths: [...paths].sort(), prefixes: [...prefixes].sort(), fallbackReason: null };
  if (plan.paths.length > options.maxUrls) {
    plan.fallbackReason = `${plan.paths.length} URLs to purge exceeds the limit of ${options.maxUrls}`;
  } else if (plan.prefixes.length > options.maxPrefixes) {
    plan.fallbackReason = `${plan.prefixes.length} prefixes to purge exceeds the limit of ${options.maxPrefixes}`;
  }
  return plan;
}

export function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * URL of the currently live deploy on netlify.app, which bypasses Cloudflare.
 * @param {Record<string, string | undefined>} env
 * @param {string} manifestPath
 * @returns {string | null}
 */
export function previousManifestUrl(env, manifestPath) {
  const site = env.SITE_NAME;
  if (!site) {
    return null;
  }
  const sitePath = encodePath(`/${manifestPath}`);
  if (env.CONTEXT === "production") {
    return `https://${site}.netlify.app${sitePath}`;
  }
  if (!env.BRANCH) {
    return null;
  }
  return `https://${env.BRANCH}--${site}.netlify.app${sitePath}`;
}

/**
 * Fetch the manifest of the live deploy. Returns { manifest } or { reason }.
 * @param {Record<string, string | undefined>} env
 * @param {string} manifestPath
 */
export async function fetchPreviousManifest(env, manifestPath) {
  const url = previousManifestUrl(env, manifestPath);
  if (!url) {
    return { reason: "SITE_NAME or BRANCH not set, cannot locate the previous manifest" };
  }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) {
      return { reason: `no previous manifest (${url} returned HTTP ${response.status})` };
    }
    const manifest = await response.json();
    if (!isManifest(manifest)) {
      return { reason: `previous manifest at ${url} has an unexpected format` };
    }
    return { manifest };
  } catch (error) {
    return { reason: `could not fetch the previous manifest from ${url}: ${error.message}` };
  }
}

async function writePlan(plan) {
  await fs.writeFile(planFilePath(), JSON.stringify(plan));
}

export async function readPlan() {
  try {
    const plan = JSON.parse(await fs.readFile(planFilePath(), "utf8"));
    await fs.rm(planFilePath(), { force: true });
    return plan;
  } catch {
    return null;
  }
}

export const onPostBuild = async function ({ constants, netlifyConfig, inputs = {}, utils }) {
  let options;
  try {
    options = resolveOptions(inputs);
  } catch (error) {
    utils.build.failPlugin(`Invalid plugin inputs: ${error.message}`);
    return;
  }

  const context = process.env.CONTEXT;
  if (!shouldRun(context, options.contexts)) {
    return;
  }
  // Remove any plan left by an earlier build so onSuccess never acts on a stale one.
  await fs.rm(planFilePath(), { force: true });

  let plan;
  try {
    const siteUrl = resolveSiteUrl(options, process.env);
    const hostname = siteUrl ? new URL(siteUrl).hostname : "";
    const manifest = await buildManifest(constants.PUBLISH_DIR, netlifyConfig.redirects, options.manifestPath);
    const manifestFile = path.join(constants.PUBLISH_DIR, options.manifestPath);
    await fs.mkdir(path.dirname(manifestFile), { recursive: true });
    await fs.writeFile(manifestFile, JSON.stringify(manifest));
    console.log(`Wrote purge manifest with ${Object.keys(manifest.files).length} files`);

    const previous = await fetchPreviousManifest(process.env, options.manifestPath);
    if (previous.manifest) {
      plan = buildPlan(diffManifests(previous.manifest, manifest), hostname, options);
    } else {
      plan = { fallbackReason: previous.reason };
    }
  } catch (error) {
    plan = { fallbackReason: `could not compute the purge list: ${error.message}` };
  }
  await writePlan(plan);
};

/** POST one purge request, retrying with backoff on HTTP 429. Throws on failure. */
export async function purgeRequest(zoneId, apiToken, body) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (response.status === 429 && attempt < retrySettings.maxRetries) {
      const retryAfter = Number(response.headers?.get("retry-after"));
      const delay = retryAfter > 0 ? retryAfter * 1000 : retrySettings.baseDelayMs * 2 ** attempt;
      console.log(`Cloudflare rate limit hit, retrying in ${delay}ms`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }

    const result = await response.json();
    if (!result.success) {
      const errors = (result.errors || []).map((e) => `${e.code}: ${e.message}`).join(", ");
      throw new Error(errors || `HTTP ${response.status}`);
    }
    return result;
  }
}

async function purgeHost(zoneId, apiToken, hostname) {
  console.log(`Purging Cloudflare cache for hostname: ${hostname}`);
  await purgeRequest(zoneId, apiToken, { hosts: [hostname] });
  console.log(`Cloudflare cache purge successful for ${hostname}`);
}

/** Purge the URLs and prefixes in the plan. Returns a summary string. */
async function purgeChanged(zoneId, apiToken, hostname, plan) {
  const files = plan.paths.map((p) => `https://${hostname}${encodePath(p)}`);
  const prefixes = plan.prefixes.map((p) => `${hostname}${encodePath(p)}`);
  const s = plan.summary;
  console.log(
    `Changes: ${s.added} added, ${s.changed} changed, ${s.removed} removed files; ` +
      `${s.redirectsAdded} added, ${s.redirectsRemoved} removed redirect rules`,
  );
  for (const batch of chunk(files, FILES_PER_REQUEST)) {
    await purgeRequest(zoneId, apiToken, { files: batch });
  }
  for (const batch of chunk(prefixes, PREFIXES_PER_REQUEST)) {
    await purgeRequest(zoneId, apiToken, { prefixes: batch });
  }
  console.log(`Purged ${files.length} URLs and ${prefixes.length} prefixes for ${hostname}`);
  return `Purged ${files.length} URLs and ${prefixes.length} prefixes for ${hostname}`;
}

export const onSuccess = async function ({ inputs = {}, utils }) {
  let options;
  try {
    options = resolveOptions(inputs);
  } catch (error) {
    utils.build.failPlugin(`Invalid plugin inputs: ${error.message}`);
    return;
  }

  const context = process.env.CONTEXT;

  if (!shouldRun(context, options.contexts)) {
    console.log(`Skipping Cloudflare cache purge: context is "${context}"`);
    return;
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const siteUrl = resolveSiteUrl(options, process.env);

  if (!apiToken || !zoneId) {
    console.log("Skipping Cloudflare cache purge: CLOUDFLARE_API_TOKEN or CLOUDFLARE_ZONE_ID not set");
    return;
  }

  if (!siteUrl) {
    utils.build.failPlugin("Cannot determine hostname: none of the siteUrl input, SITE_URL or URL is set");
    return;
  }

  try {
    const hostname = new URL(siteUrl).hostname;
    const plan = await readPlan();
    let fallbackReason = plan ? plan.fallbackReason : "no purge list from the build step";

    if (!fallbackReason) {
      if (plan.paths.length === 0 && plan.prefixes.length === 0) {
        console.log("No cacheable changes since the previous deploy, nothing to purge");
        utils.status.show({
          title: "Cloudflare Cache Purge",
          summary: `No changes to purge for ${hostname}`,
        });
        return;
      }
      try {
        const summary = await purgeChanged(zoneId, apiToken, hostname, plan);
        utils.status.show({ title: "Cloudflare Cache Purge", summary });
        return;
      } catch (error) {
        // The next deploy diffs against this one, so anything missed here would never be purged.
        fallbackReason = `targeted purge failed (${error.message})`;
      }
    }

    console.log(`Falling back to a whole-host purge: ${fallbackReason}`);
    await purgeHost(zoneId, apiToken, hostname);
    utils.status.show({
      title: "Cloudflare Cache Purge",
      summary: `Purged CDN cache for ${hostname} (${fallbackReason})`,
    });
  } catch (error) {
    utils.build.failPlugin(`Cloudflare cache purge failed: ${error.message}`, { error });
  }
};
