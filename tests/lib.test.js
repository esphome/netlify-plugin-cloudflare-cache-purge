import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, test } from "node:test";
import {
  FILES_PER_REQUEST,
  DEFAULT_OPTIONS,
  buildManifest,
  buildPlan,
  chunk,
  diffManifests,
  encodePath,
  fetchPreviousManifest,
  fileToPaths,
  isImmutable,
  isManifest,
  normalizeRedirects,
  onPostBuild,
  onSuccess,
  planFilePath,
  previousManifestUrl,
  purgeRequest,
  readPlan,
  resolveOptions,
  resolveSiteUrl,
  redirectFromToTarget,
  retrySettings,
  shouldRun,
} from "../lib.js";

const MANIFEST_PATH = DEFAULT_OPTIONS.manifestPath;
const MAX_URLS = DEFAULT_OPTIONS.maxUrls;
const MAX_PREFIXES = DEFAULT_OPTIONS.maxPrefixes;
const PREFIXES = DEFAULT_OPTIONS.immutablePrefixes;

const ENV_KEYS = [
  "CONTEXT",
  "SITE_URL",
  "URL",
  "SITE_NAME",
  "BRANCH",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ZONE_ID",
  "TMPDIR",
];

let savedEnv;
let savedFetch;
let savedRetry;
let savedLog;
let tmp;
let logs;
let calls;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  savedFetch = globalThis.fetch;
  savedRetry = { ...retrySettings };
  savedLog = console.log;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-purge-test-"));
  process.env.TMPDIR = tmp;
  for (const k of ENV_KEYS.filter((k) => k !== "TMPDIR")) {
    delete process.env[k];
  }
  retrySettings.baseDelayMs = 1;
  logs = [];
  calls = [];
  console.log = (...args) => logs.push(args.join(" "));
});

afterEach(() => {
  console.log = savedLog;
  globalThis.fetch = savedFetch;
  Object.assign(retrySettings, savedRetry);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = savedEnv[k];
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const jsonResponse = (body, init = {}) => ({
  ok: init.status === undefined || init.status < 400,
  status: init.status ?? 200,
  headers: new Headers(init.headers),
  json: async () => body,
});

const OK = { success: true, errors: [] };

/** Install a fetch mock; handler(url, init) returns a response. Calls are recorded in `calls`. */
function mockFetch(handler) {
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return handler(url, init);
  };
}

const purgeCalls = () => calls.filter((c) => c.url.includes("api.cloudflare.com"));

function makeUtils() {
  const utils = { failed: [], statuses: [] };
  utils.build = { failPlugin: (msg, opts) => utils.failed.push({ msg, opts }) };
  utils.status = { show: (s) => utils.statuses.push(s) };
  return utils;
}

function writeSite(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const emptyDiff = () => ({ added: [], changed: [], removed: [], redirectsAdded: [], redirectsRemoved: [] });

describe("resolveOptions", () => {
  test("defaults for undefined, empty and null inputs", () => {
    const expected = {
      immutablePrefixes: ["_astro/", "pagefind/fragment/", "pagefind/index/"],
      maxUrls: 5000,
      maxPrefixes: 300,
      contexts: ["production", "branch-deploy"],
      manifestPath: "cf-purge-manifest.json",
      siteUrl: null,
    };
    assert.deepEqual(resolveOptions(), expected);
    assert.deepEqual(resolveOptions({}), expected);
    const nulls = Object.fromEntries(Object.keys(expected).map((k) => [k, null]));
    assert.deepEqual(resolveOptions(nulls), expected);
    assert.deepEqual(resolveOptions(Object.fromEntries(Object.keys(expected).map((k) => [k, undefined]))), expected);
  });

  test("accepts valid overrides", () => {
    assert.deepEqual(
      resolveOptions({
        immutablePrefixes: ["/assets/", "static/"],
        maxUrls: 10,
        maxPrefixes: 0,
        contexts: ["deploy-preview"],
        manifestPath: "/meta/cf.json",
        siteUrl: "https://example.com/",
      }),
      {
        immutablePrefixes: ["assets/", "static/"],
        maxUrls: 10,
        maxPrefixes: 0,
        contexts: ["deploy-preview"],
        manifestPath: "meta/cf.json",
        siteUrl: "https://example.com/",
      },
    );
  });

  test("does not share arrays with the defaults", () => {
    const options = resolveOptions();
    options.immutablePrefixes.push("x/");
    options.contexts.push("x");
    assert.equal(resolveOptions().immutablePrefixes.length, 3);
    assert.equal(resolveOptions().contexts.length, 2);
  });

  test("accepts numeric strings for maxUrls and maxPrefixes", () => {
    const options = resolveOptions({ maxUrls: "250", maxPrefixes: "0" });
    assert.equal(options.maxUrls, 250);
    assert.equal(options.maxPrefixes, 0);
  });

  test("rejects invalid string arrays", () => {
    for (const name of ["immutablePrefixes", "contexts"]) {
      for (const value of ["x", {}, 5, [1], ["ok", ""], [null]]) {
        assert.throws(() => resolveOptions({ [name]: value }), new RegExp(`^Error: ${name} must be an array`));
      }
    }
  });

  test("rejects an immutable prefix that is empty after stripping slashes", () => {
    assert.throws(() => resolveOptions({ immutablePrefixes: ["/"] }), /immutablePrefixes must not contain an empty/);
    assert.throws(() => resolveOptions({ immutablePrefixes: ["a/", "//"] }), /empty prefix/);
  });

  test("rejects invalid maxUrls and maxPrefixes", () => {
    for (const name of ["maxUrls", "maxPrefixes"]) {
      for (const value of [-1, 1.5, "abc", "-1", "1.5", "", NaN, Infinity, true, [], {}]) {
        assert.throws(() => resolveOptions({ [name]: value }), new RegExp(`${name} must be a non-negative integer`));
      }
    }
  });

  test("manifestPath validation", () => {
    for (const value of ["", "/", "a/../b", "..", "a//b", "a/", 5]) {
      assert.throws(() => resolveOptions({ manifestPath: value }), /manifestPath must be/);
    }
    assert.equal(resolveOptions({ manifestPath: "//x.json" }).manifestPath, "x.json");
    assert.equal(resolveOptions({ manifestPath: "meta/cf.json" }).manifestPath, "meta/cf.json");
  });

  test("siteUrl validation", () => {
    for (const value of ["", "not a url", 5, {}]) {
      assert.throws(() => resolveOptions({ siteUrl: value }), /siteUrl must be a valid URL/);
    }
    assert.equal(resolveOptions({ siteUrl: "https://a.example" }).siteUrl, "https://a.example");
  });

  test("manifest.yml declares exactly the inputs and defaults", () => {
    const manifest = parseYaml(fs.readFileSync(new URL("../manifest.yml", import.meta.url), "utf8"));
    assert.equal(manifest.name, "netlify-plugin-cloudflare-cache-purge");
    assert.deepEqual(
      manifest.inputs.map((i) => i.name),
      Object.keys(resolveOptions()),
    );
    for (const input of manifest.inputs) {
      assert.equal(input.required, false);
      assert.equal(typeof input.description, "string");
      if (input.name === "siteUrl") {
        assert.equal(Object.hasOwn(input, "default"), false);
      } else {
        assert.deepEqual(input.default, DEFAULT_OPTIONS[input.name]);
      }
    }
  });
});

describe("resolveSiteUrl", () => {
  test("prefers the input, then SITE_URL, then URL", () => {
    const env = { SITE_URL: "https://site", URL: "https://url" };
    assert.equal(resolveSiteUrl({ siteUrl: "https://input" }, env), "https://input");
    assert.equal(resolveSiteUrl({ siteUrl: null }, env), "https://site");
    assert.equal(resolveSiteUrl({ siteUrl: null }, { URL: "https://url" }), "https://url");
    assert.equal(resolveSiteUrl({ siteUrl: null }, {}), null);
  });
});

describe("custom option plumbing", () => {
  test("shouldRun, isImmutable and buildPlan honour custom options", () => {
    assert.equal(shouldRun("deploy-preview", ["deploy-preview"]), true);
    assert.equal(shouldRun("production", ["deploy-preview"]), false);
    assert.equal(isImmutable("assets/a.js", ["assets/"]), true);
    assert.equal(isImmutable("_astro/a.js", ["assets/"]), false);
    const diff = { ...emptyDiff(), added: ["assets/a.js", "_astro/b.js"] };
    const plan = buildPlan(diff, "h", { immutablePrefixes: ["assets/"], maxUrls: 0, maxPrefixes: 0 });
    assert.match(plan.fallbackReason, /1 URLs to purge exceeds the limit of 0/);
    assert.deepEqual(plan.paths, ["/_astro/b.js"]);
  });

  test("buildManifest excludes a nested manifest path", async () => {
    const dir = path.join(tmp, "nested");
    writeSite(dir, { "index.html": "a", "meta/cf.json": "old" });
    const manifest = await buildManifest(dir, [], "meta/cf.json");
    assert.deepEqual(Object.keys(manifest.files), ["index.html"]);
  });

  test("previousManifestUrl uses the custom path", () => {
    assert.equal(
      previousManifestUrl({ CONTEXT: "production", SITE_NAME: "s" }, "meta/a b.json"),
      "https://s.netlify.app/meta/a%20b.json",
    );
    assert.equal(
      previousManifestUrl({ CONTEXT: "branch-deploy", SITE_NAME: "s", BRANCH: "b" }, "meta/cf.json"),
      "https://b--s.netlify.app/meta/cf.json",
    );
  });
});

describe("shouldRun", () => {
  test("only production and branch deploys", () => {
    assert.equal(shouldRun("production", DEFAULT_OPTIONS.contexts), true);
    assert.equal(shouldRun("branch-deploy", DEFAULT_OPTIONS.contexts), true);
    assert.equal(shouldRun("deploy-preview", DEFAULT_OPTIONS.contexts), false);
    assert.equal(shouldRun(undefined, DEFAULT_OPTIONS.contexts), false);
  });
});

describe("buildManifest", () => {
  test("hashes nested files and skips the manifest itself", async () => {
    const dir = path.join(tmp, "site");
    writeSite(dir, { "index.html": "a", "a/b/index.html": "b", [MANIFEST_PATH]: "old" });
    const manifest = await buildManifest(dir, [{ from: "/x", to: "/y", status: 301, force: false }], MANIFEST_PATH);
    assert.deepEqual(Object.keys(manifest.files), ["a/b/index.html", "index.html"]);
    assert.match(manifest.files["index.html"], /^[0-9a-f]{16}$/);
    assert.notEqual(manifest.files["index.html"], manifest.files["a/b/index.html"]);
    assert.deepEqual(manifest.redirects, [["/x", "/y", 301, false]]);
    assert.equal(manifest.version, 1);
  });

  test("handles more files than one hashing batch", async () => {
    const dir = path.join(tmp, "many");
    const files = {};
    for (let i = 0; i < 150; i++) files[`f${i}.txt`] = String(i);
    writeSite(dir, files);
    const manifest = await buildManifest(dir, undefined, MANIFEST_PATH);
    assert.equal(Object.keys(manifest.files).length, 150);
    assert.deepEqual(manifest.redirects, []);
  });
});

describe("normalizeRedirects", () => {
  test("defaults status and force, and sorts", () => {
    assert.deepEqual(
      normalizeRedirects([
        { from: "/b", to: "/c" },
        { from: "/a", to: "/c", status: "302", force: 1 },
      ]),
      [
        ["/a", "/c", 302, true],
        ["/b", "/c", 301, false],
      ],
    );
  });
});

describe("isManifest", () => {
  test("validates shape", () => {
    assert.equal(isManifest({ version: 1, files: {}, redirects: [] }), true);
    assert.equal(isManifest(null), false);
    assert.equal(isManifest("x"), false);
    assert.equal(isManifest({ version: 2, files: {}, redirects: [] }), false);
    assert.equal(isManifest({ version: 1, files: null, redirects: [] }), false);
    assert.equal(isManifest({ version: 1, files: "x", redirects: [] }), false);
    assert.equal(isManifest({ version: 1, files: {}, redirects: {} }), false);
  });
});

describe("diffManifests", () => {
  test("finds added, changed, removed files and redirect changes", () => {
    const previous = {
      files: { same: "1", changed: "1", removed: "1" },
      redirects: [
        ["/a", "/b", 301, false],
        ["/gone", "/b", 301, false],
      ],
    };
    const current = {
      files: { same: "1", changed: "2", added: "1" },
      redirects: [
        ["/a", "/b", 301, false],
        ["/new", "/b", 301, false],
      ],
    };
    assert.deepEqual(diffManifests(previous, current), {
      added: ["added"],
      changed: ["changed"],
      removed: ["removed"],
      redirectsAdded: [["/new", "/b", 301, false]],
      redirectsRemoved: [["/gone", "/b", 301, false]],
    });
  });
});

describe("path mapping", () => {
  test("fileToPaths", () => {
    assert.deepEqual(fileToPaths("404.html"), ["/404.html"]);
    assert.deepEqual(fileToPaths("index.html"), ["/", "/index.html"]);
    assert.deepEqual(fileToPaths("foo/bar/index.html"), ["/foo/bar/", "/foo/bar/index.html"]);
    assert.deepEqual(fileToPaths("images/a.png"), ["/images/a.png"]);
    assert.deepEqual(fileToPaths("sub/404.html"), ["/sub/404.html"]);
  });

  test("encodePath", () => {
    assert.equal(encodePath("/a b/c?d#e"), "/a%20b/c%3Fd%23e");
  });

  test("isImmutable", () => {
    assert.equal(isImmutable("_astro/a.js", PREFIXES), true);
    assert.equal(isImmutable("pagefind/fragment/x.pf_fragment", PREFIXES), true);
    assert.equal(isImmutable("pagefind/index/x.pf_index", PREFIXES), true);
    assert.equal(isImmutable("pagefind/pagefind.js", PREFIXES), false);
    assert.equal(isImmutable("images/a.png", PREFIXES), false);
  });

  test("chunk", () => {
    assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
    assert.deepEqual(chunk([], 2), []);
  });
});

describe("redirectFromToTarget", () => {
  test("exact paths include the other slash variant", () => {
    assert.deepEqual(redirectFromToTarget("/chat", "h"), { paths: ["/chat", "/chat/"] });
    assert.deepEqual(redirectFromToTarget("/chat/", "h"), { paths: ["/chat/", "/chat"] });
    assert.deepEqual(redirectFromToTarget("/", "h"), { paths: ["/"] });
    assert.deepEqual(redirectFromToTarget("/a/b.html", "h"), { paths: ["/a/b.html"] });
  });

  test("normalizes a missing leading slash and strips the query", () => {
    assert.deepEqual(redirectFromToTarget("old.html?x=1", "h"), { paths: ["/old.html"] });
  });

  test("splat and placeholder patterns become prefixes", () => {
    assert.deepEqual(redirectFromToTarget("/foo/*", "h"), { prefix: "/foo/" });
    assert.deepEqual(redirectFromToTarget("/components/animation*", "h"), { prefix: "/components/animation" });
    assert.deepEqual(redirectFromToTarget("/_static/webserver-v1.*", "h"), { prefix: "/_static/webserver-v1." });
    assert.deepEqual(redirectFromToTarget("/:x", "h"), { prefix: "/" });
    assert.deepEqual(redirectFromToTarget("/blog/:year/:slug", "h"), { prefix: "/blog/" });
    assert.deepEqual(redirectFromToTarget("/*", "h"), { prefix: "/" });
  });

  test("full URLs only apply to the matching host", () => {
    assert.deepEqual(redirectFromToTarget("https://h/old/*", "h"), { prefix: "/old/" });
    assert.equal(redirectFromToTarget("http://other.example/old", "h"), null);
  });
});

describe("buildPlan", () => {
  test("combines files and redirects, skipping immutable added and removed files", () => {
    const diff = {
      added: ["new/index.html", "_astro/new.js", "pagefind/fragment/a.pf_fragment"],
      changed: ["index.html", "_astro/same-name.js"],
      removed: ["old.html", "pagefind/index/b.pf_index"],
      redirectsAdded: [
        ["/chat", "/x", 301, false],
        ["/tags/*", "/", 301, false],
        ["https://elsewhere.example/a", "/", 301, false],
      ],
      redirectsRemoved: [["/tags/*", "/", 302, false]],
    };
    const plan = buildPlan(diff, "esphome.io", DEFAULT_OPTIONS);
    assert.deepEqual(plan.paths, [
      "/",
      "/_astro/same-name.js",
      "/chat",
      "/chat/",
      "/index.html",
      "/new/",
      "/new/index.html",
      "/old.html",
    ]);
    assert.deepEqual(plan.prefixes, ["/tags/"]);
    assert.equal(plan.fallbackReason, null);
    assert.deepEqual(plan.summary, {
      added: 3,
      changed: 2,
      removed: 2,
      redirectsAdded: 3,
      redirectsRemoved: 1,
    });
  });

  test("falls back when too many URLs", () => {
    const diff = { ...emptyDiff(), changed: Array.from({ length: MAX_URLS + 1 }, (_, i) => `p${i}.html`) };
    const plan = buildPlan(diff, "h", DEFAULT_OPTIONS);
    assert.match(plan.fallbackReason, /URLs to purge exceeds/);
  });

  test("falls back when too many prefixes", () => {
    const diff = {
      ...emptyDiff(),
      redirectsAdded: Array.from({ length: MAX_PREFIXES + 1 }, (_, i) => [`/p${i}/*`, "/", 301, false]),
    };
    const plan = buildPlan(diff, "h", DEFAULT_OPTIONS);
    assert.match(plan.fallbackReason, /prefixes to purge exceeds/);
  });

  test("a full HTML change of the real site stays under the limit", () => {
    const changed = Array.from({ length: 1000 }, (_, i) => `c/p${i}/index.html`);
    assert.equal(buildPlan({ ...emptyDiff(), changed }, "h", DEFAULT_OPTIONS).fallbackReason, null);
  });
});

describe("previousManifestUrl", () => {
  test("production uses the site subdomain", () => {
    assert.equal(
      previousManifestUrl({ CONTEXT: "production", SITE_NAME: "esphome" }, MANIFEST_PATH),
      `https://esphome.netlify.app/${MANIFEST_PATH}`,
    );
  });

  test("branch deploys use the branch subdomain", () => {
    assert.equal(
      previousManifestUrl({ CONTEXT: "branch-deploy", SITE_NAME: "esphome", BRANCH: "next" }, MANIFEST_PATH),
      `https://next--esphome.netlify.app/${MANIFEST_PATH}`,
    );
  });

  test("returns null when variables are missing", () => {
    assert.equal(previousManifestUrl({ CONTEXT: "production" }, MANIFEST_PATH), null);
    assert.equal(previousManifestUrl({ CONTEXT: "branch-deploy", SITE_NAME: "esphome" }, MANIFEST_PATH), null);
  });
});

describe("fetchPreviousManifest", () => {
  const env = { CONTEXT: "production", SITE_NAME: "esphome" };

  test("returns a valid manifest", async () => {
    const manifest = { version: 1, files: {}, redirects: [] };
    mockFetch(() => jsonResponse(manifest));
    assert.deepEqual(await fetchPreviousManifest(env, MANIFEST_PATH), { manifest });
    assert.equal(calls[0].url, `https://esphome.netlify.app/${MANIFEST_PATH}`);
  });

  test("reports a missing SITE_NAME", async () => {
    const result = await fetchPreviousManifest({}, MANIFEST_PATH);
    assert.match(result.reason, /SITE_NAME or BRANCH/);
  });

  test("reports HTTP errors", async () => {
    mockFetch(() => jsonResponse({}, { status: 404 }));
    assert.match((await fetchPreviousManifest(env, MANIFEST_PATH)).reason, /HTTP 404/);
  });

  test("reports an unexpected format", async () => {
    mockFetch(() => jsonResponse({ nope: true }));
    assert.match((await fetchPreviousManifest(env, MANIFEST_PATH)).reason, /unexpected format/);
  });

  test("reports fetch and parse errors", async () => {
    mockFetch(() => {
      throw new Error("boom");
    });
    assert.match((await fetchPreviousManifest(env, MANIFEST_PATH)).reason, /boom/);
  });
});

describe("purgeRequest", () => {
  test("returns the result on success", async () => {
    mockFetch(() => jsonResponse(OK));
    assert.deepEqual(await purgeRequest("z", "t", { hosts: ["h"] }), OK);
    assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/zones/z/purge_cache");
    assert.equal(calls[0].init.headers.Authorization, "Bearer t");
  });

  test("retries on 429 using Retry-After, then on backoff without headers", async () => {
    const responses = [
      jsonResponse({}, { status: 429, headers: { "retry-after": "0.001" } }),
      { status: 429, json: async () => ({}) },
      jsonResponse(OK),
    ];
    mockFetch(() => responses.shift());
    await purgeRequest("z", "t", {});
    assert.equal(calls.length, 3);
    assert.equal(logs.filter((l) => l.includes("rate limit")).length, 2);
  });

  test("gives up after the maximum retries", async () => {
    retrySettings.maxRetries = 1;
    mockFetch(() => jsonResponse({ success: false, errors: [{ code: 971, message: "slow down" }] }, { status: 429 }));
    await assert.rejects(purgeRequest("z", "t", {}), /971: slow down/);
    assert.equal(calls.length, 2);
  });

  test("throws API errors, or the HTTP status when none are listed", async () => {
    mockFetch(() => jsonResponse({ success: false, errors: [{ code: 1, message: "bad" }] }));
    await assert.rejects(purgeRequest("z", "t", {}), /1: bad/);
    mockFetch(() => jsonResponse({ success: false }, { status: 500 }));
    await assert.rejects(purgeRequest("z", "t", {}), /HTTP 500/);
    mockFetch(() => jsonResponse({ success: false, errors: [] }, { status: 500 }));
    await assert.rejects(purgeRequest("z", "t", {}), /HTTP 500/);
  });
});

describe("readPlan", () => {
  test("returns null when there is no plan", async () => {
    assert.equal(await readPlan(), null);
  });

  test("reads and removes the plan file", async () => {
    fs.writeFileSync(planFilePath(), JSON.stringify({ paths: [] }));
    assert.deepEqual(await readPlan(), { paths: [] });
    assert.equal(fs.existsSync(planFilePath()), false);
  });
});

describe("onPostBuild", () => {
  const PREV = { version: 1, files: { "index.html": "x" }, redirects: [] };

  function setup(files = { "index.html": "home", "a/index.html": "a" }) {
    const dir = path.join(tmp, "dist");
    writeSite(dir, files);
    process.env.CONTEXT = "production";
    process.env.SITE_URL = "https://esphome.io";
    process.env.SITE_NAME = "esphome";
    return {
      constants: { PUBLISH_DIR: dir },
      netlifyConfig: { redirects: [{ from: "/chat", to: "/c", status: 301 }] },
      utils: makeUtils(),
      dir,
    };
  }

  const plan = () => JSON.parse(fs.readFileSync(planFilePath(), "utf8"));

  test("skips other contexts", async () => {
    const args = setup();
    process.env.CONTEXT = "deploy-preview";
    mockFetch(() => assert.fail("no fetch expected"));
    await onPostBuild(args);
    assert.equal(fs.existsSync(path.join(args.dir, MANIFEST_PATH)), false);
    assert.equal(fs.existsSync(planFilePath()), false);
  });

  test("writes the manifest and a targeted plan", async () => {
    const args = setup();
    fs.writeFileSync(planFilePath(), "stale");
    mockFetch(() => jsonResponse(PREV));
    await onPostBuild(args);
    const manifest = JSON.parse(fs.readFileSync(path.join(args.dir, MANIFEST_PATH), "utf8"));
    assert.deepEqual(Object.keys(manifest.files), ["a/index.html", "index.html"]);
    assert.equal(calls[0].url, `https://esphome.netlify.app/${MANIFEST_PATH}`);
    const p = plan();
    assert.equal(p.fallbackReason, null);
    assert.deepEqual(p.paths, ["/", "/a/", "/a/index.html", "/chat", "/chat/", "/index.html"]);
  });

  test("uses the URL env var when SITE_URL is unset", async () => {
    const args = setup();
    delete process.env.SITE_URL;
    process.env.URL = "https://esphome.io";
    mockFetch(() => jsonResponse(PREV));
    await onPostBuild(args);
    assert.equal(plan().fallbackReason, null);
  });

  test("works without a site URL", async () => {
    const args = setup();
    delete process.env.SITE_URL;
    mockFetch(() => jsonResponse(PREV));
    await onPostBuild(args);
    assert.equal(plan().fallbackReason, null);
  });

  test("records a fallback when there is no previous manifest", async () => {
    const args = setup();
    mockFetch(() => jsonResponse({}, { status: 404 }));
    await onPostBuild(args);
    assert.match(plan().fallbackReason, /HTTP 404/);
    assert.equal(fs.existsSync(path.join(args.dir, MANIFEST_PATH)), true);
  });

  test("records a fallback when the fetch fails", async () => {
    const args = setup();
    mockFetch(() => {
      throw new Error("offline");
    });
    await onPostBuild(args);
    assert.match(plan().fallbackReason, /offline/);
  });

  test("records a fallback when the publish dir cannot be read", async () => {
    const args = setup();
    args.constants.PUBLISH_DIR = path.join(tmp, "missing");
    mockFetch(() => assert.fail("no fetch expected"));
    await onPostBuild(args);
    assert.match(plan().fallbackReason, /could not compute the purge list/);
  });

  test("works with inputs omitted entirely", async () => {
    const args = setup();
    mockFetch(() => jsonResponse(PREV));
    await onPostBuild({ constants: args.constants, netlifyConfig: args.netlifyConfig, utils: args.utils });
    assert.equal(plan().fallbackReason, null);
  });

  test("fails the plugin on invalid inputs", async () => {
    const args = setup();
    mockFetch(() => assert.fail("no fetch expected"));
    await onPostBuild({ ...args, inputs: { maxUrls: "x" } });
    assert.match(args.utils.failed[0].msg, /^Invalid plugin inputs: maxUrls must be/);
    assert.equal(fs.existsSync(planFilePath()), false);
  });

  test("custom contexts run in deploy-preview and skip production", async () => {
    const args = setup();
    process.env.CONTEXT = "deploy-preview";
    process.env.BRANCH = "pr-1";
    mockFetch(() => jsonResponse(PREV));
    await onPostBuild({ ...args, inputs: { contexts: ["deploy-preview"] } });
    assert.equal(calls[0].url, `https://pr-1--esphome.netlify.app/${MANIFEST_PATH}`);
    assert.equal(plan().fallbackReason, null);

    fs.rmSync(planFilePath());
    process.env.CONTEXT = "production";
    mockFetch(() => assert.fail("no fetch expected"));
    await onPostBuild({ ...args, inputs: { contexts: ["deploy-preview"] } });
    assert.equal(fs.existsSync(planFilePath()), false);
  });

  test("custom manifestPath is written, excluded and fetched", async () => {
    const args = setup({ "index.html": "home", "meta/cf.json": "old" });
    mockFetch(() => jsonResponse(PREV));
    await onPostBuild({ ...args, inputs: { manifestPath: "/meta/cf.json" } });
    const manifest = JSON.parse(fs.readFileSync(path.join(args.dir, "meta/cf.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.files), ["index.html"]);
    assert.equal(fs.existsSync(path.join(args.dir, MANIFEST_PATH)), false);
    assert.equal(calls[0].url, "https://esphome.netlify.app/meta/cf.json");
  });

  test("custom manifestPath creates a missing subdirectory", async () => {
    const args = setup();
    mockFetch(() => jsonResponse(PREV));
    await onPostBuild({ ...args, inputs: { manifestPath: "deep/er/cf.json" } });
    assert.equal(fs.existsSync(path.join(args.dir, "deep/er/cf.json")), true);
  });

  test("custom immutablePrefixes change which added files are purged", async () => {
    const args = setup({ "index.html": "home", "assets/a.js": "a", "_astro/b.js": "b" });
    mockFetch(() => jsonResponse({ version: 1, files: { "index.html": "x" }, redirects: [] }));
    await onPostBuild(args);
    const chat = ["/chat", "/chat/"];
    assert.deepEqual(plan().paths, ["/", "/assets/a.js", ...chat, "/index.html"]);

    await onPostBuild({ ...args, inputs: { immutablePrefixes: ["assets/"] } });
    assert.deepEqual(plan().paths, ["/", "/_astro/b.js", ...chat, "/index.html"]);
  });

  test("custom maxUrls and maxPrefixes trigger the fallback", async () => {
    const args = setup();
    mockFetch(() => jsonResponse(PREV));
    await onPostBuild({ ...args, inputs: { maxUrls: "2" } });
    assert.match(plan().fallbackReason, /exceeds the limit of 2/);

    args.netlifyConfig.redirects = [
      { from: "/a/*", to: "/", status: 301 },
      { from: "/b/*", to: "/", status: 301 },
    ];
    await onPostBuild({ ...args, inputs: { maxPrefixes: 1 } });
    assert.match(plan().fallbackReason, /2 prefixes to purge exceeds the limit of 1/);
  });

  test("siteUrl input overrides SITE_URL and URL, and works without either", async () => {
    const args = setup();
    process.env.URL = "https://other.example";
    mockFetch(() => jsonResponse(PREV));
    args.netlifyConfig.redirects = [{ from: "https://custom.example/old/*", to: "/", status: 301 }];
    await onPostBuild({ ...args, inputs: { siteUrl: "https://custom.example" } });
    assert.ok(plan().prefixes.includes("/old/"));

    await onPostBuild(args);
    assert.deepEqual(plan().prefixes, []);

    delete process.env.SITE_URL;
    delete process.env.URL;
    await onPostBuild({ ...args, inputs: { siteUrl: "https://custom.example" } });
    assert.ok(plan().prefixes.includes("/old/"));
  });

  test("records a fallback when the change set is too large", async () => {
    const files = {};
    for (let i = 0; i < MAX_URLS; i++) files[`p${i}/index.html`] = String(i);
    const args = setup(files);
    const prev = { version: 1, files: Object.fromEntries(Object.keys(files).map((f) => [f, "old"])), redirects: [] };
    mockFetch(() => jsonResponse(prev));
    await onPostBuild(args);
    assert.match(plan().fallbackReason, /exceeds/);
  });
});

describe("onSuccess", () => {
  function configure() {
    process.env.CONTEXT = "production";
    process.env.SITE_URL = "https://esphome.io";
    process.env.CLOUDFLARE_API_TOKEN = "tok";
    process.env.CLOUDFLARE_ZONE_ID = "zone";
  }

  const writePlan = (p) => fs.writeFileSync(planFilePath(), JSON.stringify(p));
  const summary = { added: 1, changed: 2, removed: 3, redirectsAdded: 4, redirectsRemoved: 5 };

  test("skips other contexts", async () => {
    configure();
    process.env.CONTEXT = "deploy-preview";
    mockFetch(() => assert.fail("no fetch expected"));
    await onSuccess({ inputs: {}, utils: makeUtils() });
    assert.match(logs[0], /context is "deploy-preview"/);
  });

  test("skips when credentials are missing", async () => {
    configure();
    delete process.env.CLOUDFLARE_API_TOKEN;
    await onSuccess({ inputs: {}, utils: makeUtils() });
    assert.match(logs[0], /not set/);
    configure();
    delete process.env.CLOUDFLARE_ZONE_ID;
    await onSuccess({ inputs: {}, utils: makeUtils() });
    assert.equal(logs.length, 2);
  });

  test("fails the plugin without a site URL", async () => {
    configure();
    delete process.env.SITE_URL;
    const utils = makeUtils();
    await onSuccess({ utils });
    assert.match(utils.failed[0].msg, /SITE_URL/);
  });

  test("uses the URL env var when SITE_URL is unset", async () => {
    configure();
    delete process.env.SITE_URL;
    process.env.URL = "https://next.esphome.io";
    mockFetch(() => jsonResponse(OK));
    await onSuccess({ inputs: {}, utils: makeUtils() });
    assert.deepEqual(purgeCalls()[0].body, { hosts: ["next.esphome.io"] });
  });

  test("purges only the changed URLs and prefixes", async () => {
    configure();
    writePlan({ summary, paths: ["/", "/a b/"], prefixes: ["/tags/"], fallbackReason: null });
    mockFetch(() => jsonResponse(OK));
    const utils = makeUtils();
    await onSuccess({ inputs: {}, utils });
    assert.deepEqual(
      purgeCalls().map((c) => c.body),
      [{ files: ["https://esphome.io/", "https://esphome.io/a%20b/"] }, { prefixes: ["esphome.io/tags/"] }],
    );
    assert.match(utils.statuses[0].summary, /Purged 2 URLs and 1 prefixes for esphome.io/);
    assert.deepEqual(utils.failed, []);
  });

  test("batches URLs and prefixes", async () => {
    configure();
    const paths = Array.from({ length: FILES_PER_REQUEST * 2 + 1 }, (_, i) => `/p${i}`);
    const prefixes = Array.from({ length: 101 }, (_, i) => `/x${i}/`);
    writePlan({ summary, paths, prefixes, fallbackReason: null });
    mockFetch(() => jsonResponse(OK));
    await onSuccess({ inputs: {}, utils: makeUtils() });
    const bodies = purgeCalls().map((c) => c.body);
    assert.deepEqual(
      bodies.map((b) => (b.files || b.prefixes).length),
      [100, 100, 1, 100, 1],
    );
    assert.ok(bodies.slice(0, 3).every((b) => b.files));
    assert.ok(bodies.slice(3).every((b) => b.prefixes));
  });

  test("retries a rate-limited request", async () => {
    configure();
    writePlan({ summary, paths: ["/"], prefixes: [], fallbackReason: null });
    const responses = [jsonResponse({}, { status: 429 }), jsonResponse(OK)];
    mockFetch(() => responses.shift());
    const utils = makeUtils();
    await onSuccess({ inputs: {}, utils });
    assert.equal(purgeCalls().length, 2);
    assert.deepEqual(utils.failed, []);
  });

  test("does nothing when nothing changed", async () => {
    configure();
    writePlan({ summary, paths: [], prefixes: [], fallbackReason: null });
    mockFetch(() => assert.fail("no fetch expected"));
    const utils = makeUtils();
    await onSuccess({ inputs: {}, utils });
    assert.match(utils.statuses[0].summary, /No changes/);
  });

  test("purges the whole host when the plan has a fallback reason", async () => {
    configure();
    writePlan({ fallbackReason: "no previous manifest" });
    mockFetch(() => jsonResponse(OK));
    const utils = makeUtils();
    await onSuccess({ inputs: {}, utils });
    assert.deepEqual(
      purgeCalls().map((c) => c.body),
      [{ hosts: ["esphome.io"] }],
    );
    assert.match(utils.statuses[0].summary, /no previous manifest/);
    assert.ok(logs.some((l) => l.includes("Falling back")));
  });

  test("purges the whole host when there is no plan", async () => {
    configure();
    mockFetch(() => jsonResponse(OK));
    await onSuccess({ inputs: {}, utils: makeUtils() });
    assert.deepEqual(
      purgeCalls().map((c) => c.body),
      [{ hosts: ["esphome.io"] }],
    );
  });

  test("falls back to a host purge when the targeted purge fails", async () => {
    configure();
    writePlan({ summary, paths: ["/"], prefixes: [], fallbackReason: null });
    mockFetch((_url, init) =>
      JSON.parse(init.body).files
        ? jsonResponse({ success: false, errors: [{ code: 1, message: "bad" }] })
        : jsonResponse(OK),
    );
    const utils = makeUtils();
    await onSuccess({ inputs: {}, utils });
    assert.deepEqual(
      purgeCalls().map((c) => Object.keys(c.body)[0]),
      ["files", "hosts"],
    );
    assert.match(utils.statuses[0].summary, /targeted purge failed \(1: bad\)/);
    assert.deepEqual(utils.failed, []);
  });

  test("fails the plugin when the host purge fails", async () => {
    configure();
    mockFetch(() => jsonResponse({ success: false, errors: [{ code: 9, message: "denied" }] }));
    const utils = makeUtils();
    await onSuccess({ inputs: {}, utils });
    assert.match(utils.failed[0].msg, /9: denied/);
    assert.equal(utils.statuses.length, 0);
  });

  test("works with inputs omitted entirely", async () => {
    configure();
    mockFetch(() => jsonResponse(OK));
    await onSuccess({ utils: makeUtils() });
    assert.deepEqual(purgeCalls()[0].body, { hosts: ["esphome.io"] });
  });

  test("fails the plugin on invalid inputs", async () => {
    configure();
    const utils = makeUtils();
    await onSuccess({ inputs: { contexts: "production" }, utils });
    assert.match(utils.failed[0].msg, /^Invalid plugin inputs: contexts must be/);
  });

  test("custom contexts run in deploy-preview and skip production", async () => {
    configure();
    process.env.CONTEXT = "deploy-preview";
    mockFetch(() => jsonResponse(OK));
    await onSuccess({ inputs: { contexts: ["deploy-preview"] }, utils: makeUtils() });
    assert.equal(purgeCalls().length, 1);

    process.env.CONTEXT = "production";
    await onSuccess({ inputs: { contexts: ["deploy-preview"] }, utils: makeUtils() });
    assert.match(logs.at(-1), /context is "production"/);
    assert.equal(purgeCalls().length, 1);
  });

  test("siteUrl input overrides SITE_URL and URL, and works without either", async () => {
    configure();
    process.env.URL = "https://url.example";
    mockFetch(() => jsonResponse(OK));
    await onSuccess({ inputs: { siteUrl: "https://custom.example" }, utils: makeUtils() });
    assert.deepEqual(purgeCalls()[0].body, { hosts: ["custom.example"] });

    delete process.env.SITE_URL;
    delete process.env.URL;
    await onSuccess({ inputs: { siteUrl: "https://custom.example" }, utils: makeUtils() });
    assert.deepEqual(purgeCalls()[1].body, { hosts: ["custom.example"] });
  });

  test("fails the plugin on an invalid site URL", async () => {
    configure();
    process.env.SITE_URL = "not a url";
    const utils = makeUtils();
    await onSuccess({ inputs: {}, utils });
    assert.equal(utils.failed.length, 1);
  });
});
