# unottr website

Static Astro marketing site for unottr. Astro renders the page structure and copy. React is
limited to the product and citation previews.

## Commerce configuration

The pricing page reads its checkout destination from `PUBLIC_CHECKOUT_URL`. If the variable is
missing, the page shows an honest unavailable state instead of a dead purchase link.

Canonical URLs, Open Graph URLs, the sitemap, and `robots.txt` use `PUBLIC_SITE_URL`. It defaults
to `https://unottr.pages.dev`.

Release downloads can be supplied with `PUBLIC_LINUX_DOWNLOAD_URL` and
`PUBLIC_MACOS_DOWNLOAD_URL`. This keeps commercial downloads independent from the private source
repository.

## Local checks

```sh
pnpm --filter @unottr/website check
```

Do not start the development server or run a build unless the current task explicitly asks
for it.

## Cloudflare Pages

Connect the repository to Cloudflare Pages with these settings:

| Setting | Value |
| --- | --- |
| Root directory | `/` |
| Build command | `pnpm install --frozen-lockfile --filter @unottr/website... && pnpm --filter @unottr/website build` |
| Build output directory | `website/dist` |
| Production branch | `main` |

Set these build environment variables:

| Variable | Value |
| --- | --- |
| `SKIP_DEPENDENCY_INSTALL` | `1` |
| `NODE_VERSION` | `24` |
| `PNPM_VERSION` | `11.20.0` |
| `PUBLIC_SITE_URL` | Canonical production origin, defaults to `https://unottr.pages.dev` |
| `PUBLIC_CHECKOUT_URL` | Hosted checkout URL |
| `PUBLIC_LINUX_DOWNLOAD_URL` | Licensed Linux download URL |
| `PUBLIC_MACOS_DOWNLOAD_URL` | Licensed macOS download URL |

The filtered install prevents a landing-page deployment from installing Electron and the
desktop application's native dependencies. Configure the build watch path to include
`website/*`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`.

Cloudflare Pages copies `public/_headers` into the static output and applies the declared
browser security policies to every response.
