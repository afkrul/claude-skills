# Requirements

What has to be on the machine, and running, before `startVideo` can record. Linux and macOS; on Windows, use WSL.

| | Version | Why |
|---|---|---|
| Node.js | 18 or newer (tested on 22) | runs the kit; `playwright-core` 1.57 needs >= 18 |
| Chromium | the build matching `playwright-core` 1.57 (Chromium 143, revision 1200) | the recording browser |
| ffmpeg | any recent build with `libx264` | WebM to MP4, chapters, frame extraction |
| Python 3 + pip | only if ffmpeg is not installed | fallback that fetches a static ffmpeg |
| The app | running locally, reachable at a `localhost` / `*.localhost` / `127.x` URL | what is recorded |

Nothing else: no language runtime or framework is assumed. What the app needs (a CLI for its data, a test transport for its third parties) belongs to your `exec` hook and your adapter.

## Install

```sh
cd <this skill>/kit
npm ci                                   # playwright-core, pinned to 1.57.0
npx playwright-core install chromium     # downloads Chromium into Playwright's cache (~/.cache/ms-playwright on Linux)
```

Already have a Chromium or Chrome? Skip the download: `CHROMIUM=/path/to/chrome` (an executable), or `CHROMIUM_CHANNEL=chrome` for an installed Google Chrome. A version far from 143 may misbehave.

When the skill is installed as a plugin, `kit/` sits in Claude Code's plugin cache and a plugin update replaces it: run `npm ci` there again after an update.

Smoke test, which needs nothing but the above: `node <this skill>/examples/static-app/record.mjs /tmp/walkthrough-test` records a ~50 s video of a bundled local app and prints five frames to look at.

### ffmpeg

Looked up in this order:
1. `FFMPEG=/path/to/ffmpeg`
2. `ffmpeg` on `PATH` (`apt install ffmpeg`, `brew install ffmpeg`)
3. `kit/.py/`: if neither is found, the kit runs `python3 -m pip install --target kit/.py imageio-ffmpeg` once, which brings a static ffmpeg binary. Needs Python 3 with pip and network access. `kit/.py/` is git-ignored.

## The app

The kit records whatever answers at `baseUrl`. Before recording:
- serve it on a local address; a `*.localhost` host is mapped to 127.0.0.1 inside the browser (`hostMap` to add others);
- build its front-end assets (stale bundles show layout bugs that are not there);
- seed demo data on a copy you can reset (jumps change data);
- have a **demo account on that local copy**, created by your seed with credentials you choose, passed through the environment. Never real credentials.

## Login

Login happens **off camera**, before the recording context opens. With a `login` hook (yours, or an adapter's):
1. With `authCacheKey`, a cached session for `baseUrl` + key is tried first, and reused if `isSignedIn` says it works.
2. Otherwise a throwaway browser context runs `login(page, { baseUrl, context })`, which must leave the page signed in.
3. The session (cookies, local storage) is handed to the recording context and, with `authCacheKey`, saved to `<os temp dir>/demo-kit-auth-<hash>.json` (mode 600).

Without a hook: pass `storageState` (a Playwright storage state you made), or nothing for an app without login. `totp(secret)` is exported for login forms that ask for a TOTP code (RFC 6238, SHA-1, 30 s).

## Options and environment variables

Options passed to `startVideo` win; then the adapter's fields; then the environment; then the default.

| Option | Env | Default | |
|---|---|---|---|
| `baseUrl` | `DEMO_BASE_URL` | **required** | the app's root URL; must be local unless `allowRemote: true` |
| `outDir` | `DEMO_OUT_DIR` | `./videos` | where the MP4 and chapters file go |
| `copyTo` | `DEMO_COPY_TO` | off | also copy the MP4 to this folder |
| `theme` | `DEMO_THEME` | `light` | `light` or `dark`: the browser colour scheme (+ the adapter's `init`) |
| `chromiumPath` | `CHROMIUM` | Playwright's Chromium | executable to launch |
| `channel` | `CHROMIUM_CHANNEL` | `chromium` | Playwright channel when no executable is given (`chrome`, `msedge`…) |
| — | `FFMPEG` | `PATH`, then `kit/.py` | ffmpeg binary |
| `title` | | **required** | |
| `purpose`, `audience` | | — | title card lines |
| `kind` | | `tutorial` | or `demo` |
| `product` | | — | first word on the title card ("Admin panel · Tutorial") |
| `totalSteps` | | — | the N in "Step n / N" (or `chapter({ steps })` per section) |
| `slug` / `name` | | from title / `<date>-<slug>` | file name |
| `startPath` | | `/` | first page, loaded behind the title card |
| `loginRetries` / `loginRetryDelayMs` | | `0` / `2000` | retry a refused login (e.g. right after a reseed); a TOTP login wants > 30 s |
| `speed` | | `1` | every hold and reading time is divided by it |
| `viewport` | | `1920×1080` | |
| `lang` | | `en` | `pt` for Portuguese labels; `labels: {…}` overrides any |
| `adapter` | | `{}` | see SKILL.md; any hook can also be passed directly |
| `navigate`, `waitForIdle`, `login`, `isSignedIn`, `authCacheKey`, `storageState`, `exec`, `safeArea`, `init`, `setTheme` | | see SKILL.md | adapter hooks |
| `hostMap` | | the `*.localhost` host of `baseUrl` | hostnames mapped to 127.0.0.1 in the browser |
| `style` | | `STANDARD` | override colours, font and timings (keys in SKILL.md › Style); also an adapter field. `standard` is accepted as an alias |
| `headless` | | `true` | |
| `keepWebm` | | `false` | keep Playwright's raw recording |

### Filament adapter (`adapters/filament.mjs`)

Reads `DEMO_EMAIL`, `DEMO_PASSWORD`, `DEMO_MFA_SECRET` (base32 TOTP secret) or `DEMO_OTP_COMMAND` (prints a current code) when no credentials are passed. Assumes Filament's login page (`/login`, `input[type=email]`, `input[type=password]`, a submit button) and its app-authentication MFA screen; a code already used in the current 30 s window is never reused (it waits for the next one).
