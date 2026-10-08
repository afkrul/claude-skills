---
name: recording-browser-walkthroughs
description: Use when asked to record a video, tutorial, walkthrough, screen recording or demo of any app that runs in a browser (an admin panel, a SPA, a plain site) running locally; when a feature has to be shown in its different states; when support or operations staff need to be taught a task on screen; or when someone asks for a Jam-style recording of a flow.
---

# Recording browser walkthroughs

Internal documentation videos, not marketing. One standard, drawn in the page by `kit/` (Playwright), so it is code, not discipline. App-agnostic: what depends on the app (navigation, idle wait, login, data changes, fixed chrome) comes in through an **adapter** you pass.

**Local only**: a `baseUrl` that is not `localhost`, `*.localhost` or `127.x` is refused. Every state on screen is demo data on a local copy of the app.

Before the first recording, check [REQUIREMENTS.md](REQUIREMENTS.md) and run `npm ci` in `kit/`.

## The standard: what every video is, in order

1. **Title card**, about 1.8 s (longer with a purpose line): plain light or dark background, small type: product · kind, title, one-line purpose, date · audience.
2. **Steps.** A caption bar at the bottom centre, its bottom edge at **14%** of the frame height (clear of video players' seek bar and buttons), slate-900 at 90% with white text: `STEP n / N` · what we do · why or outcome. Held for its reading time: 46 ms per character, at least 2.4 s.
3. **Every click or type** gets a 2 px orange (#F97316) box with a small label ("Click", "Type"), held 640 ms while the cursor dot glides there, then a ring at the click point. Typing runs at 56 ms per key.
4. **Callouts** (pointing without clicking): the same box with a short note beside it.
5. **Jumps.** Anything that happens outside the app, or time passing, appears in the same bar with a neutral tag (`EXTERNAL`, `LATER`, `MEANWHILE`) and the plain fact. The side effect runs while it is read; then the page reloads in place.
6. **Chapter cards** for a video with several cases: kicker, title, the one line that explains why this case behaves as it does; held 1.44 s per line, at least 4.4 s. With `to`, the case's page loads **behind** the card. A card followed by a card replaces it in place: **the viewer never sees a page between two cards**, or a page on its way to the next one.
7. **Recap card**, about 2.6 s: title and 2 to 4 bullets.

Pacing: `speed` 1 is the standard (every hold, glide, keystroke and reading time is divided by it; 1.2 is brisker, 0.8 slower). Your own `after`, `hold` and `pause` values are milliseconds at speed 1. Output: **1920×1080** H.264 MP4, `<yyyy-mm-dd>-<slug>.mp4` (or `name`), chapters inside the MP4 and in `<name>.chapters.txt`, in `outDir` (default `./videos`).

## Writing a case

A case is what you are handed: **a base URL, the steps, what to show**. Turn each line into calls:

| Line | Becomes |
|---|---|
| an action ("open X", "search Y") | `step` + `click` / `type` |
| "see X" | `step` + `callout` |
| "then the carrier / payment provider / customer does Y" | `jump(fact, { run: () => v.exec(...) })`, and the `exec` hook makes Y true |
| several cases in one video | one `chapter(title, { kicker, purpose, steps, to })` per case |

Then:
1. **Data first.** A seed that is re-run safe, dates relative to today, and prints (or lets you look up) each case's URL by a stable key; never hard-code record ids.
2. **Jumps through the app's real code paths** where the screen depends on what those paths write: post a signed webhook to the app's own route, run its queued job with third parties faked. Writing rows directly is the fallback.
3. **Record**, pull frames with `extractFrames`, **look at them** (captions, boxes, no page between cards), then deliver.

`examples/static-app/record.mjs` is a complete, runnable case (opens with the plain lines and the call each became). Write your script anywhere and import the kit by path: `import { startVideo } from '<this skill>/kit/demo-kit.mjs'`.

## Adapters

An adapter is a plain object; an option of the same name passed to `startVideo` wins over it.

| Hook | Default | What it is for |
|---|---|---|
| `navigate(page, url)` | `page.goto(url)` + `waitForIdle` | change pages inside the app; an SPA router or `Livewire.navigate` avoids reloads |
| `waitForIdle(page)` | `defaultWaitForIdle`: load + network idle + no fetch/XHR in flight for 300 ms | when the page has settled after an action |
| `login(page, { baseUrl, context })` | none | sign in, off camera, in a throwaway context; the kit keeps the session |
| `isSignedIn(page)` | none | checks the session (a cached one is reused while it works; a signed-out start aborts) |
| `authCacheKey` | none | cache the session in the OS temp dir (mode 600), so a retake does not sign in again |
| `storageState` | none | a ready Playwright storage state: skips login |
| `exec(...args)` | none | the side effects for jumps (`v.exec(...)`): a CLI, an HTTP call, a DB script |
| `safeArea: { top, bottom }` | `{ 0, 0 }` | px of fixed chrome; targets are scrolled clear of it and of the caption bar |
| `init(context, { theme })`, `setTheme(page, theme)` | none | where the app keeps its theme, if not only `prefers-color-scheme` |
| `labels` | `en` / `pt` | e.g. `{ product: 'Admin panel', externalSub: 'This happened outside the admin panel.' }` |

Shipped: `adapters/spa.mjs` (plain site or SPA: optional global router function, plain login form) and `adapters/filament.mjs` (a Filament v4/v5 panel: Livewire SPA navigation, Filament login + app-authentication MFA via TOTP, 84 px top bar, theme in `localStorage`). An app-specific skill builds its own adapter on top of these.

## Style

The look is `STANDARD` in the kit; `startVideo({ style: {...} })` or an adapter's `style` is merged over it (the call's wins), so a brand colour or font is one line. Default: the look above.

| Keys | Default | What |
|---|---|---|
| `accent`, `accentLabel` | `#F97316`, `#C2410C` | box border, click ring, list markers; label background behind white text |
| `cursorFill`, `boxGlow` | accent at 30% / 16% | cursor dot fill; soft ring around a box (set them with `accent`) |
| `font` | Inter, then system UI | every drawn text |
| `bar`, `barText`, `barMuted`, `stepTag`, `extTagText` | slate-900 at 90%, white, slate-300, orange-300, slate-200 | caption bar, its two lines, `STEP n / N`, the `EXTERNAL` tag |
| `cardBg`, `cardText`, `cardMuted`, `cardBody` | `#F8FAFC`, `#0F172A`, `#64748B`, `#475569` | light cards: background, title, kicker/meta, purpose and bullets |
| `cardBgDark`, `cardTextDark`, `cardMutedDark`, `cardBodyDark` | `#0F172A`, `#F1F5F9`, `#94A3B8`, `#CBD5E1` | the same for dark cards (`theme: 'dark'`, or a page with `html.dark`) |
| `barBottom`, `barRoom` | `0.14`, `100` | caption bar's bottom edge (fraction of height); room kept above it |
| timings: `titleMs`, `recapMs`, `minReadMs`, `msPerChar`, `cardMsPerLine`, `cardMinMs`, `boxHoldMs`, `typeDelayMs`, `glideStepMs` | see the standard | at speed 1; prefer `speed` for a faster or slower video |

## Kit API (`kit/demo-kit.mjs`)

`startVideo({ title, purpose, audience, kind: 'tutorial'|'demo', product, baseUrl, adapter, ...hooks, outDir, totalSteps, startPath, theme, slug, name, copyTo, lang, speed, viewport, style })`, then:
- `v.step(title, why)`, `v.note(title, sub)`, `v.click(target, { label, place, after })`, `v.type(target, text, { enter })`
- `v.callout(target, note, { place: 'above'|'below'|'right'|'left' })`, `v.hover(target)`, `v.scrollTo(target)`
- `v.chapter(title, { kicker, purpose, steps, to })`: once used, MP4 chapters are the sections, not every step; `steps` restarts "Step n / N"
- `v.jump(fact, { kind: 'external'|'later'|'meanwhile', sub, run, to })`, `v.exec(...args)`
- `v.goto(path)` (through the adapter's `navigate`), `v.pause(ms)`, `v.setTheme('dark')`, `v.signInAs({ login, isSignedIn, authCacheKey })` (switch user off camera)
- `v.finish({ recap })` returns `{ mp4, chapters, copied, seconds }`; `v.abort()` on failure

If `startVideo` throws (login refused, `init` failed, start page down), it has already closed the browser; the error is the caller's. After it returns, the browser is yours: wrap the walkthrough in `try { ... } catch (e) { await v.abort(); throw e; }` (as `examples/static-app/record.mjs` does), or a stray Chromium keeps the script from exiting. `loginRetries` (default 0) and `loginRetryDelayMs` (default 2000) retry a refused login, e.g. the first one after a database reseed; a TOTP login wants a delay past the 30 s window.

`target` is a Playwright locator or a CSS string; `v.page` and `v.context` are Playwright's. Also exported: `STANDARD`, `toMp4`, `extractFrames`, `authenticate`, `totp`, `defaultNavigate`, `defaultWaitForIdle`, `waitForQuiet`, `isLocalUrl`. Options and environment variables: [REQUIREMENTS.md](REQUIREMENTS.md#options-and-environment-variables).

## Common mistakes

- Record as the role the audience has; an admin often bypasses gates the audience hits.
- Navigate with `v.goto` / `chapter({ to })` / `jump({ to })`, never `page.goto` mid-video: the adapter is what avoids flashes.
- Give every `chapter` its `to`, and set `startPath` to the first case's page (the default `/` shows the home page under the title card).
- A callout note covers what is beside it: pick `place` so it covers nothing relevant, then check the frame.
- Fixed headers hide targets: set `safeArea.top` to the header's height.
- Stale front-end assets fake layout bugs: rebuild before recording.
- Leaving data mutated: re-run the seed after a take with jumps.
