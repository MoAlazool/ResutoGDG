# Cloudflare Workers static-assets deployment

The public marketing site is an isolated static-export Next.js application. It reuses the modern Resuto 2.0 landing components and bundled public pricing catalog. It does not build or expose the API, authentication, dashboard, database, or legacy landing.

## Workers Builds project settings

| Setting | Value |
| --- | --- |
| Git provider | GitHub |
| Repository | `MoAlazool/ResutoGDG` |
| Production branch | `deploy/cloudflare-landing` |
| Root directory | `/` (repository root) |
| Install command | `corepack enable && pnpm install --frozen-lockfile` |
| Build command | `pnpm --filter @resuto/marketing build` |
| Deploy command | `pnpm --filter @resuto/marketing deploy` |
| Static assets directory | `apps/marketing/out` (declared as `./out` in `apps/marketing/wrangler.jsonc`) |
| Node.js version | `22.12.0` |

Set one build environment variable: `NODE_VERSION=22.12.0`. It selects the build image runtime and is not an application secret. No application environment variables, API URLs, database credentials, or other secrets are required.

## Domains

Wrangler deploys the asset-only Worker named `resuto-marketing`. The configuration has no `main` entrypoint and cannot package the SaaS API or dashboard. After the first successful deployment, add `resuto.app` and `www.resuto.app` as custom domains. Do not change DNS until the preview deployment has passed acceptance checks.

Create a Cloudflare Redirect Rule for the zone after both hostnames are active:

- When hostname equals `www.resuto.app`
- Dynamic redirect destination: `concat("https://resuto.app", http.request.uri.path)`
- Preserve query string: enabled
- Status code: `301`

The generated pages, sitemap, Open Graph metadata, and canonical links use `https://resuto.app`.

## Local verification

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter @resuto/marketing typecheck
pnpm --filter @resuto/marketing test
pnpm --filter @resuto/marketing build
pnpm --filter @resuto/marketing deploy:dry-run
```

Serve `apps/marketing/out` with any static HTTP server for browser QA. Protected application paths are intentionally absent and return a static 404.
