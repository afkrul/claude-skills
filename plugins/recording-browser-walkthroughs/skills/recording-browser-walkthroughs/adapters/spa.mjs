// Minimal adapter for a plain HTML site or a single-page app. Copy it and change what differs.
//
//   const v = await startVideo({ title, baseUrl, adapter: spa({ go: 'app.go', login: { email, password } }) });
//
// navigate   calls the app's own client-side router when `go` names a global function (e.g. 'app.go',
//            a router's push), so pages change without a reload; otherwise a normal page load
// login      fills a plain form (email/user, password, submit) at `loginPath`, off camera
// isSignedIn not on `loginPath`
// safeArea   px of fixed chrome (a sticky header/footer) to keep targets clear of

/**
 * @param go        dotted path of a global navigation function, e.g. 'app.go' or 'router.push' (optional)
 * @param login     { email, password, user?, pass?, submit? } selectors default to type=email/password/submit (optional)
 * @param loginPath default '/login'
 * @param safeArea  { top, bottom } in px (default none)
 * @param exec      the side-effect hook for jumps (optional)
 */
export function spa({ go, login, loginPath = '/login', safeArea = { top: 0, bottom: 0 }, exec } = {}) {
  const adapter = {
    safeArea,
    exec,
    async navigate(page, url) {
      const same = new URL(url).origin === new URL(page.url()).origin;
      const routed = go && same && await page.evaluate(([fn, u]) => {
        const f = fn.split('.').reduce((o, k) => o?.[k], window);
        if (typeof f !== 'function') return false;
        const parts = fn.split('.'); const owner = parts.slice(0, -1).reduce((o, k) => o?.[k], window) ?? window;
        f.call(owner, new URL(u).pathname + new URL(u).search + new URL(u).hash);
        return true;
      }, [go, url]).catch(() => false);
      if (routed) await page.waitForURL(url, { timeout: 15000 }).catch(() => {});
      else await page.goto(url, { waitUntil: 'load' });
    },
    async isSignedIn(page) { return !new URL(page.url()).pathname.endsWith(loginPath); },
  };
  if (login) {
    adapter.authCacheKey = login.email;
    adapter.login = async (page, { baseUrl }) => {
      await page.goto(baseUrl + loginPath, { waitUntil: 'load' });
      await page.locator(login.user ?? 'input[type=email]').first().fill(login.email);
      await page.locator(login.pass ?? 'input[type=password]').first().fill(login.password);
      await Promise.all([page.waitForLoadState('load'), page.locator(login.submit ?? '[type=submit]').first().click()]);
      await page.waitForURL(u => !u.pathname.endsWith(loginPath), { timeout: 15000 }).catch(() => {});
    };
  }
  return adapter;
}
