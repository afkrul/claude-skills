// Reference adapter for a Filament (v4/v5) panel served by Laravel. Optional: nothing in the kit needs it.
//
//   import { startVideo } from '../kit/demo-kit.mjs';
//   import { filament } from '../adapters/filament.mjs';
//   const v = await startVideo({ title, baseUrl, adapter: filament({ email, password, mfaSecret }) });
//
// What it supplies:
//   navigate     Livewire's SPA navigation (window.Livewire.navigate) when the panel uses spa(); a normal load otherwise
//   login        Filament's login form (email, password, submit) and, when asked, its app-authentication MFA step
//   isSignedIn   not on the login or MFA page
//   safeArea     Filament's top bar (84 px)
//   init/setTheme  Filament keeps the theme in localStorage.theme
//   exec         optional: pass `exec` yourself (a php/artisan call, an HTTP request…); this adapter has none
//
// Credentials come from the arguments or DEMO_EMAIL / DEMO_PASSWORD / DEMO_MFA_SECRET / DEMO_OTP_COMMAND.
// Use a demo account on a local database; never real credentials.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultWaitForIdle, totp } from '../kit/demo-kit.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const OTP_STAMP = join(tmpdir(), 'demo-kit-last-otp-window');
const secondsLeftInWindow = () => 30 - (Math.floor(Date.now() / 1000) % 30);

/** Credentials from the environment, when DEMO_EMAIL is set. */
export function filamentCredentialsFromEnv(env = process.env) {
  if (!env.DEMO_EMAIL) return undefined;
  return { email: env.DEMO_EMAIL, password: env.DEMO_PASSWORD ?? '', mfaSecret: env.DEMO_MFA_SECRET || undefined, otpCommand: env.DEMO_OTP_COMMAND || undefined };
}

async function resolveOtp(c) {
  if (c.otp) return typeof c.otp === 'function' ? await c.otp() : String(c.otp);
  if (c.otpCommand) return execSync(c.otpCommand, { encoding: 'utf8' }).trim();
  if (c.mfaSecret) return totp(c.mfaSecret);
  return null;
}

/**
 * @param creds     { email, password, mfaSecret | otpCommand | otp } (default: from the environment)
 * @param loginPath the panel's login path (default '/login')
 */
export function filament(creds = filamentCredentialsFromEnv(), { loginPath = '/login', topBar = 84 } = {}) {
  const onLogin = page => new URL(page.url()).pathname.endsWith(loginPath);
  const onMfa = page => /\/multi-factor|\/two-factor/.test(new URL(page.url()).pathname);

  const adapter = {
    safeArea: { top: topBar, bottom: 0 },
    labels: { product: 'Admin panel', externalSub: 'This happened outside the admin panel.' },

    async navigate(page, url) {
      const spa = await page.evaluate(u => { if (window.Livewire?.navigate) { window.Livewire.navigate(u); return true; } return false; }, url).catch(() => false);
      if (spa) await page.waitForURL(url, { timeout: 20000 }).catch(() => {});
      else await page.goto(url, { waitUntil: 'load' });
    },

    waitForIdle: defaultWaitForIdle, // Livewire requests are fetches: the kit's in-flight counter covers them

    async init(context, { theme }) {
      await context.addInitScript(t => { try { localStorage.setItem('theme', t); } catch {} }, theme);
    },
    async setTheme(page, theme) {
      await page.evaluate(t => localStorage.setItem('theme', t), theme);
    },

    async isSignedIn(page) { return !onLogin(page) && !onMfa(page); },
  };
  if (!creds) return adapter; // no login: pass storageState, or record a panel without auth

  adapter.authCacheKey = creds.email; // the session is reused across takes while it still works
  adapter.login = async (page, { baseUrl }) => {
    await page.goto(baseUrl + loginPath, { waitUntil: 'networkidle' });
    await page.locator('input[type=email]').first().fill(creds.email);
    await page.locator('input[type=password]').first().fill(creds.password);
    await page.locator('button[type=submit]').first().click();
    await page.waitForLoadState('networkidle').catch(() => {});
    // Filament's app-authentication step: a hidden one-time-code input followed by the visible text input.
    const hidden = page.locator('input[autocomplete="one-time-code"]').first();
    await hidden.waitFor({ state: 'attached', timeout: 4000 }).catch(() => {});
    if (await hidden.count()) {
      if (!(creds.otp || creds.otpCommand || creds.mfaSecret)) throw new Error('the panel asks for an MFA code: pass mfaSecret, otpCommand or otp');
      // Filament refuses a code reused within its 30 s window; a code typed in the last seconds may expire.
      let last = null; try { last = +readFileSync(OTP_STAMP, 'utf8'); } catch {}
      if (last === Math.floor(Date.now() / 30000) || secondsLeftInWindow() < 4) await sleep(secondsLeftInWindow() * 1000 + 400);
      const code = await resolveOtp(creds);
      try { writeFileSync(OTP_STAMP, String(Math.floor(Date.now() / 30000))); } catch {}
      await hidden.locator('xpath=following::input[@type="text"][@autocomplete="off"]').first().click();
      await page.keyboard.type(code, { delay: 20 });
      await page.getByRole('button', { name: /confirm|verify|sign in/i }).last().click();
      await page.waitForURL(u => !u.pathname.endsWith(loginPath), { timeout: 20000 }).catch(() => {});
      await page.waitForLoadState('networkidle').catch(() => {});
    }
    if (onLogin(page)) throw new Error(`login failed (still on ${page.url()}); a reused TOTP code is the usual cause: wait 30 s and retry`);
  };
  return adapter;
}

/** Filament's table search box (the first input[type=search] is the global search, not this one). */
export const TABLE_SEARCH = 'input[wire\\:model\\.live\\.debounce\\.500ms="tableSearch"]';
