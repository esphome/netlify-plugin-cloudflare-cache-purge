# netlify-plugin-cloudflare-cache-purge

A [Netlify Build Plugin](https://docs.netlify.com/extend/install-and-use/build-plugins/) that purges a Netlify site's
Cloudflare CDN cache after a successful deploy. It purges only the URLs that changed since the previous deploy, not the
whole hostname, so most of the cache stays warm and Cloudflare does not send a flood of misses back to Netlify after
every deploy.

## How it works

1. **`onPostBuild`** hashes every file in the publish directory (SHA-256, truncated) and writes the hashes, plus the
   site's resolved redirect rules, to a manifest file (`cf-purge-manifest.json` by default) inside the publish
   directory. The manifest ships with the deploy.
2. Still in `onPostBuild`, the plugin fetches the manifest of the deploy that is currently live straight from
   `*.netlify.app`, which bypasses Cloudflare:
   - production: `https://<SITE_NAME>.netlify.app/<manifestPath>`
   - branch deploy: `https://<BRANCH>--<SITE_NAME>.netlify.app/<manifestPath>`

   It diffs the two manifests and saves a purge plan to a temp file:
   - a changed file is purged under every URL Cloudflare may have cached for it (`foo/index.html` is purged as
     `/foo/` and `/foo/index.html`)
   - an added or removed file is purged too (a new name may have a cached 404, and a removed name must stop being
     served), except under `immutablePrefixes`, where file names are content hashed: a new name was never requested
     and a removed one is no longer referenced
   - an added or removed redirect rule purges its `from` path (both slash variants), or the static prefix of the
     pattern for splat / placeholder rules (`/old/*` purges the prefix `/old/`). Rules for other hosts are ignored.

3. **`onSuccess`** sends the plan to the Cloudflare API in batches of 100 (URL purges, then prefix purges), retrying
   with backoff on HTTP 429. Nothing is purged when nothing cacheable changed.

The plugin falls back to purging the whole hostname when it cannot do a targeted purge safely:

- there is no previous manifest (first deploy, or a deploy from before this plugin was installed)
- the previous manifest cannot be fetched or has an unexpected format
- the plan has more than `maxUrls` URLs or more than `maxPrefixes` prefixes
- computing the plan failed, or a targeted purge request failed (the next deploy diffs against this one, so a missed
  URL would otherwise never be purged)

The plugin does nothing outside the deploy contexts listed in `contexts`, or when the Cloudflare credentials are not
set (so deploy previews and forks without secrets still build).

## Installation

The plugin is distributed as a git tag, not on npm. Add it to the site's `devDependencies`:

```bash
npm install -D github:esphome/netlify-plugin-cloudflare-cache-purge#v1.0.0
```

This adds `"@esphome/netlify-plugin-cloudflare-cache-purge": "github:esphome/netlify-plugin-cloudflare-cache-purge#v1.0.0"`
to `package.json`. Then enable it in `netlify.toml` by its package name:

```toml
[[plugins]]
  package = "@esphome/netlify-plugin-cloudflare-cache-purge"

  # Optional, all inputs have defaults.
  [plugins.inputs]
    immutablePrefixes = ["_astro/", "pagefind/fragment/", "pagefind/index/"]
    contexts = ["production", "branch-deploy"]
    maxUrls = 5000
    maxPrefixes = 300
```

Netlify loads a plugin that is not in its plugin directory from the site's `node_modules`, so the package must be in
the `package.json` of the site's base directory (the directory with `netlify.toml`). Netlify only auto-installs plugins
from its official directory, so a site without a `package.json` cannot use this plugin by package name: add a minimal
`package.json` with the dependency (Netlify then runs `npm install` before the build), or vendor the plugin and point
`package` at a local path.

To upgrade, install the new tag (`npm install -D github:esphome/netlify-plugin-cloudflare-cache-purge#v1.1.0`) and
commit the updated `package.json` and lock file.

## Inputs

All inputs are optional. Netlify rejects inputs that are not listed here.

| Input               | Type     | Default                                                | Description                                                                                                                                             |
| ------------------- | -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `immutablePrefixes` | string[] | `["_astro/", "pagefind/fragment/", "pagefind/index/"]` | Publish-dir path prefixes of content-hashed files. Added and removed files under them are not purged; changed ones still are. A leading `/` is ignored. |
| `maxUrls`           | integer  | `5000`                                                 | Fall back to a whole-host purge above this many URLs (5000 URLs is 50 API requests).                                                                    |
| `maxPrefixes`       | integer  | `300`                                                  | Fall back to a whole-host purge above this many prefixes (prefix purges are rate limited much harder than URL purges).                                  |
| `contexts`          | string[] | `["production", "branch-deploy"]`                      | Netlify deploy contexts (`CONTEXT`) in which the plugin runs.                                                                                           |
| `manifestPath`      | string   | `"cf-purge-manifest.json"`                             | Path of the manifest inside the publish directory and on the site. Must not contain `..`.                                                               |
| `siteUrl`           | string   | none                                                   | URL whose hostname is purged. Defaults to Netlify's `SITE_URL`, else `URL`. Set it when the Cloudflare hostname differs from the Netlify site URL.      |

Integers may also be given as strings of digits. Invalid inputs fail the plugin with a message naming the input.

## Environment variables

Set these in the Netlify site settings (scope them to Builds):

| Variable               | Description                                                      |
| ---------------------- | ---------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with the **Zone > Cache Purge** permission. |
| `CLOUDFLARE_ZONE_ID`   | ID of the Cloudflare zone that serves the site.                  |

Create the token under Cloudflare dashboard > My Profile > API Tokens > Create Token > Custom token, with the
permission `Zone` / `Cache Purge` / `Purge` and the zone resource limited to the site's zone. Nothing else is needed.

The plugin also reads the variables Netlify sets for every build: `CONTEXT`, `SITE_NAME`, `BRANCH`, `SITE_URL` and
`URL`.

## Cloudflare zone settings

A targeted purge assumes Cloudflare's cache key is the URL path, so set the zone to ignore query strings in the cache
key for the site's hosts (otherwise `/page?x=1` stays cached after `/page` is purged). Caching redirects (301 / 308)
and 404s with a short TTL works well with this plugin: changed redirect rules and added files are purged explicitly.

## Development

Requires Node.js 22.8 or newer for the coverage thresholds (the plugin itself runs on Node.js 20+).

```bash
npm ci
npm run lint
npm run format:check
npm test
```

`npm test` runs the `node:test` suite with coverage and fails below 100% line, branch and function coverage of
`index.js`.

The package has no runtime dependencies and no build step. Do not add a `prepare` script: npm runs it on every site
that installs the package from git, after installing this repo's dev dependencies.

## Releasing

Releases are drafted by [Release Drafter](https://github.com/release-drafter/release-drafter):

1. Every push to `main` updates a draft release for the next version. The version is resolved from the labels of the
   PRs merged since the last release: `breaking-change` bumps the major version, `enhancement` the minor version, and
   anything else the patch version.
2. The same workflow commits the resolved version to `package.json` and `package-lock.json` on `main` (as the ESPHome
   GitHub App), so the release commit's `package.json` always matches its tag.
3. To release, review the draft and publish it in the GitHub UI. Publishing creates the `vX.Y.Z` tag on `main`. With
   immutable releases enabled for the repository, the tag and release cannot be changed afterwards.
4. Update the sites' `devDependencies` to the new tag.

No release assets are built and nothing runs on publish: sites install the package straight from the git tag.

For the first release, run the Release Drafter workflow manually with `version` set to `1.0.0` (there is no previous
release to bump from), then publish the draft before merging anything else.

## License

[Apache License 2.0](LICENSE)
