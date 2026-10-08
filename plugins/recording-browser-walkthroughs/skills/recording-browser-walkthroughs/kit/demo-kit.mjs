// demo-kit.mjs: records walkthrough videos of any app that runs in a browser, with one visual standard.
// App-agnostic: everything that depends on the app (how to navigate, when a page is idle, how to sign
// in, how to change data for a jump, what is fixed on screen) comes in as an adapter the caller passes.
//
//   const v = await startVideo({ title, purpose, baseUrl, totalSteps, adapter, exec });
//   await v.step('Open the order', 'From Orders, search by number');
//   await v.click(locatorOrCss, { label: 'Click' });
//   await v.type(locatorOrCss, 'text');
//   await v.callout(locatorOrCss, 'Status: who acts next');
//   await v.jump('The carrier marked it delivered.', { kind: 'external', run: () => v.exec('deliver'), to: '/orders/1' });
//   const { mp4 } = await v.finish({ recap: ['...', '...'] });
//
// Internal documentation, not marketing: plain cards, one accent colour, no animation for effect.
// Everything visual (cards, caption bar, boxes, cursor) is drawn inside the page, so it is in the
// recording itself. Login happens off camera. Playwright records WebM; finish() makes the MP4.

import { chromium } from 'playwright-core';
import { execSync, spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
const env = process.env;

// ---------------------------------------------------------------- the standard (one place)
export const STANDARD = {
  accent: '#F97316',          // the one accent: box border, click ring, cursor ring, step tag text
  accentLabel: '#C2410C',     // label background behind white text (orange-700)
  bar: 'rgba(15,23,42,0.90)', // caption bar: slate-900, translucent; readable on light and dark pages
  barText: '#FFFFFF',
  barMuted: '#CBD5E1',        // slate-300
  stepTag: '#FDBA74',         // "STEP 2 / 6" (orange-300 on the dark bar)
  font: 'Inter, ui-sans-serif, system-ui, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif',
  // Timings are at `speed` 1 (every one is divided by `speed`).
  titleMs: 1760,              // title card hold
  recapMs: 2560,              // end card floor
  minReadMs: 2400,            // floor for any caption / callout / jump
  msPerChar: 46.4,            // reading time per character (~21 chars/s: viewers read captions while watching the page)
  cardMsPerLine: 1440,        // section card: per line of text (kicker, title, each ~70-char line of purpose)
  cardMinMs: 4400,            // section card floor
  boxHoldMs: 640,             // highlight visible before the click lands
  typeDelayMs: 56,            // per keystroke
  glideStepMs: 11.2,          // cursor glide, per step (8 to 40 steps per move)
  barBottom: 0.14,            // caption bar's bottom edge, as a fraction of the frame height: video players'
                              // controls (Windows player: seek line + buttons) cover the bottom ~10%
  barRoom: 100,               // bar height (~72 px, two lines) + margin: targets stay above barBottom*H + barRoom
  // Look: override any of these with startVideo({ style: {...} }) or an adapter's `style`.
  cursorFill: 'rgba(249,115,22,.30)', // the cursor dot's fill (accent at 30%)
  boxGlow: 'rgba(249,115,22,.16)',    // soft ring around a highlight box (accent at 16%)
  extTagText: '#E2E8F0',      // EXTERNAL / LATER tag on the bar
  cardBg: '#F8FAFC', cardText: '#0F172A', cardMuted: '#64748B', cardBody: '#475569',             // light cards
  cardBgDark: '#0F172A', cardTextDark: '#F1F5F9', cardMutedDark: '#94A3B8', cardBodyDark: '#CBD5E1', // dark cards
};

const LABELS = {
  en: { step: 'Step', click: 'Click', type: 'Type', recap: 'Recap', tutorial: 'Tutorial', demo: 'Demo', product: null,
        external: 'External', later: 'Later', meanwhile: 'Meanwhile', externalSub: 'This happened outside the app.' },
  pt: { step: 'Passo', click: 'Clique', type: 'Digite', recap: 'Resumo', tutorial: 'Tutorial', demo: 'Demo', product: null,
        external: 'Externo', later: 'Depois', meanwhile: 'Enquanto isso', externalSub: 'Isto aconteceu fora do app.' },
};

// ---------------------------------------------------------------- TOTP (RFC 6238), for adapters whose login asks for one
function base32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const v = A.indexOf(c);
    if (v < 0) throw new Error(`TOTP secret: invalid base32 character "${c}"`);
    bits += v.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
/** Six-digit TOTP code (SHA-1, 30 s step) for a base32 secret, as Google Authenticator computes it. */
export function totp(secret, at = Date.now()) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', base32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}

// ---------------------------------------------------------------- ffmpeg
/** FFMPEG env → PATH → kit/.py (imageio-ffmpeg, installed there on first use). */
export function findFfmpeg() {
  if (process.env.FFMPEG && existsSync(process.env.FFMPEG)) return process.env.FFMPEG;
  const onPath = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).stdout.trim();
  if (onPath) return onPath;
  const binDir = join(KIT, '.py', 'imageio_ffmpeg', 'binaries');
  const local = () => existsSync(binDir) && readdirSync(binDir).find(f => f.startsWith('ffmpeg-'));
  if (!local()) {
    console.error('[demo-kit] ffmpeg not found; installing imageio-ffmpeg into kit/.py (one time)…');
    execSync(`python3 -m pip install --quiet --target "${join(KIT, '.py')}" imageio-ffmpeg`, { stdio: 'inherit' });
  }
  const f = local();
  if (!f) throw new Error('ffmpeg not found: set FFMPEG=/path/to/ffmpeg');
  return join(binDir, f);
}

/** WebM → MP4 (H.264, yuv420p, faststart). `startMs` trims the head; chapters [{ startMs, title }] become MP4 chapters. */
export function toMp4(webm, mp4, { chapters = [], durationMs, startMs = 0 } = {}) {
  const ff = findFfmpeg();
  const args = ['-loglevel', 'error', '-y', '-ss', (startMs / 1000).toFixed(3), '-i', webm];
  let meta;
  if (chapters.length) {
    meta = `${mp4}.ffmeta`;
    const end = durationMs ?? chapters.at(-1).startMs + 5000;
    let s = ';FFMETADATA1\n';
    chapters.forEach((c, i) => {
      const e = i + 1 < chapters.length ? chapters[i + 1].startMs : end;
      s += `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${Math.round(c.startMs)}\nEND=${Math.round(Math.max(e, c.startMs + 1))}\ntitle=${c.title.replace(/[=;#\\\n]/g, ' ')}\n`;
    });
    writeFileSync(meta, s);
    args.push('-i', meta, '-map_metadata', '1', '-map_chapters', '1', '-map', '0:v');
  }
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart', mp4);
  const r = spawnSync(ff, args, { encoding: 'utf8' });
  if (meta) rmSync(meta, { force: true });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return mp4;
}

/** Duration in seconds, read from ffmpeg's banner. */
export function videoSeconds(file) {
  const r = spawnSync(findFfmpeg(), ['-i', file], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : NaN;
}

/** Still frames (PNG) at the given seconds, for checking a recording by eye. */
export function extractFrames(video, seconds, outDir) {
  mkdirSync(outDir, { recursive: true });
  return seconds.map(s => {
    const out = join(outDir, `frame-${String(s).replace('.', '_')}s.png`);
    spawnSync(findFfmpeg(), ['-loglevel', 'error', '-y', '-ss', String(s), '-i', video, '-frames:v', '1', out]);
    return out;
  });
}

// ---------------------------------------------------------------- the in-page overlay
// Runs in every document (init script). Lives on <html>, not <body>, so SPA navigation that swaps
// <body> (Livewire wire:navigate, Turbo, htmx boost) does not wipe it. Caption, card and cursor survive reloads via sessionStorage.
function overlayScript(S) {
  if (window.__demo) return;
  const css = `
  #__demo{position:fixed;inset:0;pointer-events:none;z-index:2147483646;font-family:${S.font};-webkit-font-smoothing:antialiased}
  #__demo *{box-sizing:border-box}
  #__demo .cur{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:${S.cursorFill};border:2px solid #fff;box-shadow:0 0 0 1.5px ${S.accent},0 1px 4px rgba(0,0,0,.35);z-index:5;left:-60px;top:-60px}
  #__demo .bar{position:fixed;left:50%;bottom:${S.barBottom * 100}vh;transform:translateX(-50%);min-width:480px;max-width:min(1000px,calc(100vw - 64px));background:${S.bar};color:${S.barText};border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.25);padding:11px 18px 12px;display:flex;gap:14px;align-items:baseline}
  #__demo .tag{flex:none;font:600 12px/1 ${S.font};letter-spacing:.07em;text-transform:uppercase;color:${S.stepTag};white-space:nowrap}
  #__demo .tag.ext{color:${S.extTagText};background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);padding:4px 7px;border-radius:5px;position:relative;top:-1px}
  #__demo .t1{font:600 17px/1.35 ${S.font};color:${S.barText}}
  #__demo .t2{font:400 14px/1.4 ${S.font};color:${S.barMuted};margin-top:2px}
  #__demo .box{position:fixed;border:2px solid ${S.accent};border-radius:8px;box-shadow:0 0 0 3px ${S.boxGlow};z-index:3}
  #__demo .lbl{position:absolute;left:-2px;background:${S.accentLabel};color:#fff;font:600 12px/1.3 ${S.font};padding:3px 8px;border-radius:5px;white-space:nowrap}
  #__demo .lbl.note{white-space:normal;width:max-content;max-width:420px;font-size:13px;padding:5px 9px}
  #__demo .lbl.above{bottom:calc(100% + 6px)} #__demo .lbl.below{top:calc(100% + 6px)}
  #__demo .lbl.alignr{left:auto;right:-2px}
  #__demo .lbl.right{left:calc(100% + 8px);top:50%;transform:translateY(-50%)}
  #__demo .lbl.left{left:auto;right:calc(100% + 8px);top:50%;transform:translateY(-50%)}
  #__demo .pulse{position:fixed;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid ${S.accent};z-index:4;animation:__demoPulse .4s ease-out forwards}
  @keyframes __demoPulse{from{transform:scale(1);opacity:.75}to{transform:scale(2.4);opacity:0}}
  #__demo .card{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:10;background:${S.cardBg};color:${S.cardText}}
  #__demo .card.dark{background:${S.cardBgDark};color:${S.cardTextDark}}
  #__demo .card .in{width:min(760px,calc(100vw - 160px))}
  #__demo .card .k{font:500 13px/1 ${S.font};color:${S.cardMuted};letter-spacing:.02em}
  #__demo .card.dark .k,#__demo .card.dark .m{color:${S.cardMutedDark}}
  #__demo .card h1{font:600 28px/1.25 ${S.font};margin:10px 0 0;color:inherit}
  #__demo .card .p{font:400 17px/1.5 ${S.font};color:${S.cardBody};margin-top:8px}
  #__demo .card.dark .p{color:${S.cardBodyDark}}
  #__demo .card .m{font:400 14px/1 ${S.font};color:${S.cardMuted};margin-top:16px}
  #__demo .card ul{margin:14px 0 0;padding:0 0 0 22px;list-style:disc outside}
  #__demo .card li{display:list-item;list-style:disc outside;font:400 17px/1.5 ${S.font};margin:0 0 6px}
  #__demo .card li::marker{color:${S.accent}}
  `;
  const ss = (() => { try { return window.sessionStorage; } catch { return null; } })();
  const get = k => { try { return JSON.parse(ss?.getItem(k) ?? 'null'); } catch { return null; } };
  const set = (k, v) => { try { ss?.setItem(k, JSON.stringify(v)); } catch {} };
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  if (S.firstCard && !get('__demoBooted')) { set('__demoBooted', 1); set('__demoCard', S.firstCard); }
  let root;
  function ensure() {
    if (root && root.isConnected) return root;
    root = document.getElementById('__demo');
    if (root) return root;
    root = el('div'); root.id = '__demo';
    root.appendChild(el('style', null, css));
    const cur = el('div', 'cur'); root.appendChild(cur);
    const p = get('__demoCursor'); if (p) { cur.style.left = p.x + 'px'; cur.style.top = p.y + 'px'; }
    document.documentElement.appendChild(root);
    const c = get('__demoCaption'); if (c) caption(c);
    const k = get('__demoCard'); if (k) card(k);
    return root;
  }
  function caption(c) {
    set('__demoCaption', c);
    const r = ensure();
    let bar = r.querySelector('.bar');
    if (!c) { bar?.remove(); return; }
    if (!bar) { bar = el('div', 'bar'); r.appendChild(bar); }
    bar.replaceChildren();
    if (c.tag) bar.appendChild(el('div', 'tag' + (c.external ? ' ext' : ''), c.tag));
    const txt = el('div'); txt.appendChild(el('div', 't1', c.title));
    if (c.sub) txt.appendChild(el('div', 't2', c.sub));
    bar.appendChild(txt);
  }
  function box(rect, label, opts = {}) {
    const r = ensure();
    const b = el('div', 'box'); const pad = opts.pad ?? 5;
    Object.assign(b.style, { left: rect.x - pad + 'px', top: rect.y - pad + 'px', width: rect.width + pad * 2 + 'px', height: rect.height + pad * 2 + 'px' });
    if (label) {
      const l = el('div', 'lbl' + (opts.note ? ' note' : ''), label);
      const roomAbove = rect.y - pad - S.safeTop, roomBelow = innerHeight - (innerHeight * S.barBottom + S.barRoom + S.safeBottom) - (rect.y + rect.height + pad);
      const roomRight = innerWidth - (rect.x + rect.width + pad) - 16;
      let place = opts.place || 'auto';
      // Short action labels sit beside the box (they cover least); notes go above, else below.
      if (place === 'auto') place = !opts.note && roomRight >= 90 ? 'right' : roomAbove >= 48 || roomAbove > roomBelow ? 'above' : 'below';
      l.classList.add(place);
      if ((place === 'above' || place === 'below') && rect.x + 420 > innerWidth - 24) l.classList.add('alignr');
      b.appendChild(l);
    }
    r.appendChild(b);
  }
  function clearBoxes() { root?.querySelectorAll('.box').forEach(b => b.remove()); }
  function pulse(x, y) { const p = el('div', 'pulse'); Object.assign(p.style, { left: x + 'px', top: y + 'px' }); ensure().appendChild(p); setTimeout(() => p.remove(), 500); }
  function card(d) {
    const r = ensure();
    r.querySelector('.card')?.remove();
    set('__demoCard', d || null);
    if (!d) return;
    const c = el('div', 'card' + (d.dark ? ' dark' : '')); const i = el('div', 'in'); c.appendChild(i);
    if (d.kicker) i.appendChild(el('div', 'k', d.kicker));
    i.appendChild(el('h1', null, d.title));
    if (d.purpose) i.appendChild(el('div', 'p', d.purpose));
    if (d.items?.length) { const ul = el('ul'); d.items.forEach(t => ul.appendChild(el('li', null, t))); i.appendChild(ul); }
    if (d.meta) i.appendChild(el('div', 'm', d.meta));
    r.appendChild(c);
  }
  document.addEventListener('mousemove', e => {
    const cur = ensure().querySelector('.cur'); cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px';
    set('__demoCursor', { x: e.clientX, y: e.clientY });
  }, true);
  // In-flight fetch/XHR counter (any SPA's requests), so we can wait for the page to settle after a click.
  window.__demoInflight = 0;
  const of = window.fetch;
  if (of) window.fetch = function (...a) { window.__demoInflight++; return of.apply(this, a).finally(() => window.__demoInflight--); };
  const oo = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...a) { window.__demoInflight++; this.addEventListener('loadend', () => window.__demoInflight--, { once: true }); return oo.apply(this, a); };
  window.__demo = { ensure, caption, box, clearBoxes, pulse, card };
  // Attach as soon as <html> exists, so a persisted card covers the page from its first paint.
  if (document.documentElement) ensure();
  else new MutationObserver((_, mo) => { if (document.documentElement) { mo.disconnect(); ensure(); } }).observe(document, { childList: true });
  setInterval(() => { if (document.documentElement && !(root && root.isConnected)) ensure(); }, 250);
}

// ---------------------------------------------------------------- browser
// `chromiumPath` / CHROMIUM (an executable), else the Chromium that `npx playwright-core install
// chromium` put in Playwright's cache, launched as full Chromium in new headless mode (channel 'chromium').
function launchOptions(opt) {
  const executablePath = opt.chromiumPath ?? env.CHROMIUM;
  if (executablePath) return { executablePath };
  return { channel: opt.channel ?? env.CHROMIUM_CHANNEL ?? 'chromium' };
}

/** True for localhost, *.localhost, 127.0.0.0/8 and ::1. */
export function isLocalUrl(url) {
  let h;
  try { h = new URL(url).hostname; } catch { return false; }
  return h === 'localhost' || h.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(h) || h === '[::1]';
}

// ---------------------------------------------------------------- default adapter hooks
// An adapter is a plain object; every field is optional, and an option of the same name passed to
// startVideo wins over the adapter's. See adapters/ for examples.
//
//   navigate(page, url)              go to a URL inside the app (default: page.goto, then waitForIdle)
//   waitForIdle(page)                resolve once the page has settled after an action or a navigation
//   login(page, { baseUrl, context }) sign in, in a throwaway browser context, off camera
//   isSignedIn(page, { baseUrl })    true when the page shows a signed-in app (reuses a cached session)
//   authCacheKey                     cache the signed-in session under this key, in the OS temp dir
//   storageState                     a ready Playwright storage state (file or object): no login at all
//   exec(...args)                    side effects for jumps: `v.exec(...)` calls it (a DB change, a webhook, a CLI)
//   safeArea { top, bottom }         px covered by fixed app chrome (a top bar, a footer): targets are kept clear of it
//   init(context, { theme })         per-context setup (init scripts, e.g. where the app keeps its theme)
//   setTheme(page, theme)            what the app needs to switch theme, before the kit reloads the page
//   labels                           label overrides, e.g. { externalSub: 'This happened outside the store.' }

/** Resolves once no fetch/XHR started by the page has been in flight for ~300 ms (15 s cap). */
export async function waitForQuiet(page, { quietMs = 300, timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  let quiet = 0;
  while (Date.now() < deadline && quiet < quietMs / 100) {
    const n = await page.evaluate(() => window.__demoInflight ?? 0).catch(() => 1);
    quiet = n === 0 ? quiet + 1 : 0;
    await page.waitForTimeout(100);
  }
}

/** Default idle wait: the document loaded, the network idle, and no fetch/XHR in flight. */
export async function defaultWaitForIdle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(150);
  await waitForQuiet(page);
}

/** Default navigation: a normal page load. The overlay re-draws from the first paint, so a card stays up. */
export async function defaultNavigate(page, url) {
  await page.goto(url, { waitUntil: 'load' });
}

// ---------------------------------------------------------------- off-camera login
/**
 * Sign in with `login` in a throwaway, non-recording context and return its storage state (cookies,
 * local storage). With `cacheKey`, the state is cached in the OS temp dir (mode 600) and reused while
 * `isSignedIn` says it still works, so a retake does not sign in again (or wait for a new TOTP window).
 */
export async function authenticate(browser, { baseUrl, login, isSignedIn, cacheKey, viewport, waitForIdle = defaultWaitForIdle }) {
  const cache = cacheKey ? join(tmpdir(), `demo-kit-auth-${createHash('sha1').update(`${baseUrl}|${cacheKey}`).digest('hex').slice(0, 12)}.json`) : null;
  const ctx0 = await browser.newContext({ viewport, storageState: cache && existsSync(cache) ? cache : undefined });
  const page = await ctx0.newPage();
  const save = async () => {
    const s = await ctx0.storageState(cache ? { path: cache } : undefined);
    if (cache) try { chmodSync(cache, 0o600); } catch {}
    return s;
  };
  try {
    if (cache && existsSync(cache) && isSignedIn) {
      await page.goto(baseUrl + '/', { waitUntil: 'load' });
      await waitForIdle(page);
      if (await isSignedIn(page, { baseUrl })) return await save();
    }
    await login(page, { baseUrl, context: ctx0 });
    if (isSignedIn && !(await isSignedIn(page, { baseUrl }))) throw new Error(`login did not end signed in (on ${page.url()})`);
    return await save();
  } finally {
    await ctx0.close();
  }
}

// ---------------------------------------------------------------- the recorder
export async function startVideo(o) {
  // Options win; then the adapter; then environment variables; then defaults. Nothing machine-specific.
  const adapter = o.adapter ?? {};
  const given = Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
  const opt = {
    kind: 'tutorial', lang: 'en', speed: 1, viewport: { width: 1920, height: 1080 },
    startPath: '/', headless: true, date: new Date(), keepWebm: false,
    ...adapter, ...given,
  };
  delete opt.adapter;
  opt.baseUrl ??= env.DEMO_BASE_URL;
  opt.outDir = resolve(opt.outDir ?? env.DEMO_OUT_DIR ?? 'videos');
  opt.theme ??= env.DEMO_THEME ?? 'light';
  if (given.copyTo === undefined) opt.copyTo = env.DEMO_COPY_TO || null; // off unless asked for
  if (opt.baseUrl) opt.baseUrl = opt.baseUrl.replace(/\/+$/, '');
  // *.localhost names (e.g. app.localhost) are pointed at 127.0.0.1 inside the browser.
  opt.hostMap ??= opt.baseUrl && new URL(opt.baseUrl).hostname.endsWith('.localhost') ? [new URL(opt.baseUrl).hostname] : [];
  if (!opt.title || !opt.baseUrl) throw new Error('startVideo needs title and baseUrl (or DEMO_BASE_URL)');
  if (!isLocalUrl(opt.baseUrl) && !opt.allowRemote)
    throw new Error(`baseUrl ${opt.baseUrl} is not local: this kit records against a local app only (demo data, never production)`);
  const waitForIdle = opt.waitForIdle ?? defaultWaitForIdle;
  const navigateHook = opt.navigate ?? defaultNavigate;
  const safeArea = { top: 0, bottom: 0, ...opt.safeArea };
  const L = { ...(LABELS[opt.lang] ?? LABELS.en), ...(opt.product ? { product: opt.product } : {}), ...adapter.labels, ...given.labels };
  const W = opt.viewport.width, H = opt.viewport.height;
  const pace = ms => Math.round(ms / opt.speed);
  const readMs = text => pace(Math.max(S.minReadMs, (text || '').length * S.msPerChar));
  const day = opt.date.toISOString().slice(0, 10);
  const slug = opt.slug ?? opt.title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const name = opt.name ?? `${day}-${slug}`; // `name` overrides the whole file name (no date prefix)
  const dark = opt.theme === 'dark';
  const titleCard = {
    kicker: [L.product, opt.kind === 'demo' ? L.demo : L.tutorial].filter(Boolean).join(' · '),
    title: opt.title, purpose: opt.purpose, meta: [day, opt.audience].filter(Boolean).join(' · '), dark,
  };
  const S = { ...STANDARD, ...adapter.style, ...given.style, ...given.standard, safeTop: safeArea.top, safeBottom: safeArea.bottom, firstCard: titleCard };
  mkdirSync(opt.outDir, { recursive: true });
  const rawDir = join(opt.outDir, `.raw-${name}`);

  const browser = await chromium.launch({
    ...launchOptions(opt),
    headless: opt.headless,
    args: ['--no-sandbox', '--hide-scrollbars', ...(opt.hostMap.length ? [`--host-resolver-rules=${opt.hostMap.map(h => `MAP ${h} 127.0.0.1`).join(',')}`] : [])],
  });
  // From here on, anything that throws before startVideo returns closes the browser first: an open
  // Chromium keeps the node process alive, and the caller's script would hang instead of failing.
  let context = null;
  const closeAll = async () => {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  };
  // A refused login (e.g. the first one after a database reseed) is retried `loginRetries` times,
  // `loginRetryDelayMs` apart (a TOTP login may need a new 30 s window).
  const retries = Math.max(0, opt.loginRetries ?? 0);
  const signIn = async hooks => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await authenticate(browser, {
          baseUrl: opt.baseUrl, viewport: opt.viewport, waitForIdle,
          login: hooks.login, isSignedIn: hooks.isSignedIn, cacheKey: hooks.authCacheKey,
        });
      } catch (e) {
        if (attempt >= retries) throw e;
        console.error(`[demo-kit] login failed (${String(e?.message ?? e).split('\n')[0]}); retry ${attempt + 1} of ${retries}`);
        await new Promise(r => setTimeout(r, opt.loginRetryDelayMs ?? 2000));
      }
    }
  };
  let page;
  try {
    let storageState = opt.storageState;
    if (!storageState && opt.login) storageState = await signIn(opt);

    context = await browser.newContext({
      viewport: opt.viewport, colorScheme: opt.theme, storageState,
      recordVideo: { dir: rawDir, size: opt.viewport },
    });
    if (opt.init) await opt.init(context, { theme: opt.theme });
    await context.addInitScript(overlayScript, S);
    page = await context.newPage();
  } catch (e) {
    await closeAll();
    throw e;
  }
  const t0 = Date.now();
  const chapters = [];
  const mark = (title, kind = 'step') => chapters.push({ at: Date.now(), title, kind });
  let stepN = 0;
  let totalSteps = opt.totalSteps;
  let explicitChapters = false; // set by v.chapter(): chapters then follow the sections, not every step

  const ov = (fn, ...args) => page.evaluate(([f, a]) => { window.__demo?.ensure(); return window.__demo?.[f](...a); }, [fn, args]).catch(() => {});
  const loc = t => (typeof t === 'string' ? page.locator(t).first() : t);

  async function settle(min = 400) {
    await waitForIdle(page);
    await page.waitForTimeout(pace(min));
  }

  // A card (title or section) stays up until the next thing that needs the page: a card followed by
  // another card replaces it in place, so the page never flashes between two cards, and a section's
  // page (`chapter(..., { to })`) is loaded behind its card before it lifts.
  let cardUp = false;
  async function lift() {
    if (!cardUp) return;
    cardUp = false;
    await ov('card', null);
    await settle(120);
  }

  let cursor = { x: W / 2, y: H / 2 };
  async function moveTo(x, y) {
    const d = Math.hypot(x - cursor.x, y - cursor.y);
    const n = Math.max(8, Math.min(40, Math.round(d / 18)));
    const from = cursor;
    for (let i = 1; i <= n; i++) {
      const t = i / n, e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease-in-out
      await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
      await page.waitForTimeout(pace(S.glideStepMs));
    }
    cursor = { x, y };
  }

  /** Scroll the target into the safe band (below fixed top chrome, above the caption bar). */
  async function show(target) {
    const l = loc(target);
    await l.waitFor({ state: 'visible', timeout: 15000 });
    let b = await l.boundingBox();
    if (!b || b.y < S.safeTop || b.y + b.height > H - (H * S.barBottom + S.barRoom + S.safeBottom)) {
      await l.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
      let prev = null;
      for (let i = 0; i < 40; i++) {
        await page.waitForTimeout(60);
        b = await l.boundingBox();
        if (prev && b && Math.abs(prev.y - b.y) < 0.5) break;
        prev = b;
      }
      await page.waitForTimeout(pace(200));
    }
    return { l, b: await l.boundingBox() };
  }

  /** Navigation inside the app, through the adapter (an SPA can change pages without a reload). */
  async function navigate(url) {
    const full = url.startsWith('http') ? url : opt.baseUrl + url;
    await navigateHook(page, full);
    await settle(240);
  }

  const stepTag = () => (stepN ? `${L.step} ${stepN}${totalSteps ? ` / ${totalSteps}` : ''}` : null);
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains('dark')).catch(() => dark);

  const v = {
    page, context, browser, name, L, S, readMs,

    /** New step: caption "Step n / N · title" (+ the why), held for its reading time. */
    async step(title, sub = '', { hold } = {}) {
      await lift();
      stepN++;
      mark(`${stepTag()} · ${title}`);
      await ov('caption', { tag: stepTag(), title, sub });
      await page.waitForTimeout(hold ?? readMs(`${title} ${sub}`));
    },

    /**
     * Section card: a short plain card (kicker, title, one line) that opens a part of the video, e.g. one
     * case of several. Once used, the MP4/txt chapters are the sections (plus title and recap) instead of
     * every step. `steps` restarts the step count for this section ("Step 1 / steps"); `to` navigates
     * behind the card, so the section's first page is already there when the card lifts.
     */
    async chapter(title, { kicker, purpose, steps, to, hold } = {}) {
      explicitChapters = true;
      mark(title, 'chapter');
      if (steps !== undefined) { stepN = 0; totalSteps = steps; }
      await ov('caption', null);
      const shown = Date.now();
      await ov('card', { kicker, title, purpose, dark: await isDark() });
      if (to) await navigate(to);
      const lines = 2 + (purpose ? Math.ceil(purpose.length / 70) : 0);
      const wait = (hold ?? Math.max(pace(S.cardMinMs), pace(lines * S.cardMsPerLine), readMs(`${kicker ?? ''} ${title} ${purpose ?? ''}`))) - (Date.now() - shown);
      if (wait > 0) await page.waitForTimeout(wait);
      cardUp = true; // lifted by the next step/click/callout/jump, or replaced by the next card
    },

    /** Replace the caption text within the current step (e.g. the outcome after a click). */
    async note(title, sub = '', { hold } = {}) {
      await lift();
      await ov('caption', { tag: stepTag(), title, sub });
      await page.waitForTimeout(hold ?? readMs(`${title} ${sub}`));
    },

    async click(target, { label = L.click, hold = S.boxHoldMs, after = 400, position, place } = {}) {
      await lift();
      const { l, b } = await show(target);
      const pt = position ? { x: b.x + position.x, y: b.y + position.y } : { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      const t = Date.now();
      await ov('box', b, label, { place });
      await moveTo(pt.x, pt.y);
      await page.waitForTimeout(Math.max(0, pace(hold) - (Date.now() - t)));
      await ov('pulse', pt.x, pt.y);
      await page.waitForTimeout(120);
      await ov('clearBoxes');
      await l.click({ position: position ?? undefined });
      await settle(after);
    },

    async type(target, text, { label = L.type, hold = S.boxHoldMs, delay = S.typeDelayMs, clear = true, after = 320, enter = false, place } = {}) {
      await lift();
      const { l, b } = await show(target);
      const t = Date.now();
      await ov('box', b, label, { place });
      await moveTo(b.x + Math.max(b.width - 36, b.width / 2), b.y + b.height / 2);
      await page.waitForTimeout(Math.max(0, pace(hold) - (Date.now() - t)));
      await ov('pulse', cursor.x, cursor.y);
      await l.click();
      if (clear) await l.fill('');
      await l.pressSequentially(text, { delay: pace(delay) });
      if (enter) await page.keyboard.press('Enter');
      await page.waitForTimeout(pace(240));
      await ov('clearBoxes');
      await settle(after);
    },

    /** Point at something without clicking: box + note, held for the note's reading time. */
    async callout(target, text, { hold, move = true, place } = {}) {
      await lift();
      const { b } = await show(target);
      await ov('box', b, text, { note: true, place });
      // The cursor rests beside the box, on the side the note is not (a note placed right would start under it).
      if (move) await moveTo(place !== 'right' && b.x + b.width + 14 < W ? b.x + b.width + 14 : b.x - 14, b.y + b.height / 2);
      await page.waitForTimeout(hold ?? readMs(text) + pace(480));
      await ov('clearBoxes');
      await page.waitForTimeout(pace(200));
    },

    async hover(target, { hold = 480 } = {}) {
      await lift();
      const { b } = await show(target);
      await moveTo(b.x + b.width / 2, b.y + b.height / 2);
      await page.waitForTimeout(pace(hold));
    },

    async scrollTo(target) { await show(target); },
    goto: navigate,
    async pause(ms) { await page.waitForTimeout(pace(ms)); },

    /**
     * Something happened outside the app, or time passed. The caption bar shows a neutral tag
     * (EXTERNAL / LATER / MEANWHILE) and the plain fact; `run` changes the world while it is read;
     * then the page reloads (or goes to `to`) in place. Not counted as a step.
     */
    async jump(fact, { kind = 'external', sub, run, to, hold } = {}) {
      await lift();
      const tag = L[kind] ?? kind;
      const line = sub ?? (kind === 'external' ? L.externalSub : '');
      mark(`${tag} · ${fact}`, 'jump');
      const started = Date.now();
      await ov('caption', { tag, external: true, title: fact, sub: line });
      if (run) await run();
      const wait = (hold ?? readMs(`${fact} ${line}`)) - (Date.now() - started);
      if (wait > 0) await page.waitForTimeout(wait);
      await navigate(to ?? page.url());
    },

    /** The caller's side-effect hook (`exec` option or adapter field), usually called from `jump({ run })`. */
    async exec(...args) {
      if (!opt.exec) throw new Error('v.exec needs an `exec` function: pass it to startVideo or in the adapter');
      return opt.exec(...args);
    },

    /** Switch the signed-in user off camera (cookies replaced); the next navigation shows the new session. */
    async signInAs(hooks) {
      const state = await signIn({ ...opt, ...hooks });
      await context.clearCookies();
      await context.addCookies(state.cookies);
    },

    /** Switch theme and reload: the adapter's `setTheme` (where the app keeps it), then the colour scheme. */
    async setTheme(theme) {
      if (opt.setTheme) await opt.setTheme(page, theme);
      if (opt.init) await opt.init(context, { theme });
      await page.emulateMedia({ colorScheme: theme });
      await page.reload({ waitUntil: 'load' });
      await settle(240);
    },

    async finish({ recap = [], hold, copyTo = opt.copyTo, chaptersFile = true } = {}) {
      mark(L.recap, 'recap');
      await ov('caption', null);
      await ov('card', { kicker: L.recap, title: opt.title, items: recap, dark: await isDark() });
      await page.waitForTimeout(hold ?? Math.max(pace(S.recapMs), readMs(recap.join(' ')) * 0.6));
      const endAt = Date.now();
      const video = page.video();
      await context.close();
      await browser.close();
      const webm = await video.path();
      const mp4 = join(opt.outDir, `${name}.mp4`);
      const startMs = Math.max(0, titleShownAt - t0 - 100); // trim the blank frames before the title card
      const ch = chapters.filter(c => !explicitChapters || !['step', 'jump'].includes(c.kind)).map(c => ({ startMs: Math.max(0, c.at - t0 - startMs), title: c.title }));
      toMp4(webm, mp4, { chapters: ch, durationMs: endAt - t0 - startMs, startMs });
      let chaptersPath = null;
      if (chaptersFile) {
        chaptersPath = join(opt.outDir, `${name}.chapters.txt`);
        const ts = ms => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
        writeFileSync(chaptersPath, ch.map(c => `${ts(c.startMs)} ${c.title}`).join('\n') + '\n');
      }
      if (!opt.keepWebm) rmSync(rawDir, { recursive: true, force: true });
      let copied = null;
      if (copyTo) { mkdirSync(copyTo, { recursive: true }); copied = join(copyTo, `${name}.mp4`); copyFileSync(mp4, copied); }
      return { mp4, chapters: chaptersPath, copied, seconds: videoSeconds(mp4), webm: opt.keepWebm ? webm : null };
    },

    /** Abort without producing a video (closes the browser; safe to call more than once). */
    async abort() { await closeAll(); },
  };

  // Title card: the overlay draws it from the first paint of the first page (see firstCard); the
  // app loads underneath, the card holds, then it is removed (a plain cut, no fade).
  let titleShownAt;
  try {
    await page.goto(opt.baseUrl + opt.startPath, { waitUntil: 'load' });
    await waitForIdle(page);
    if (opt.isSignedIn && !(await opt.isSignedIn(page, { baseUrl: opt.baseUrl })))
      throw new Error(`not signed in at ${page.url()}: pass login (or storageState), or check the adapter's credentials`);
    await ov('ensure');
    titleShownAt = Date.now();
    mark('Title', 'title');
    // Held like a section card when it carries a purpose line: every line has to be readable.
    await page.waitForTimeout(Math.max(pace(S.titleMs), opt.purpose ? pace((3 + Math.ceil(opt.purpose.length / 70)) * S.cardMsPerLine) : 0));
  } catch (e) {
    await closeAll();
    throw e;
  }
  cardUp = true; // lifted by the first action, or replaced by a first chapter card (no page flash between)
  return v;
}
