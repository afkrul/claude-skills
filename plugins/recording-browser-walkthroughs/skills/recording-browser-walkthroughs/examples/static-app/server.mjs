// The app under the camera for the example: a static single-page app plus a JSON file, served on
// 127.0.0.1 at a free port. A login form sets a cookie; every page but /login needs it.
// `node server.mjs` serves it on its own (prints the URL); record.mjs starts it in-process.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEMO_USER = { email: 'operator@example.test', password: 'local-demo-only' };

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title>
<style>body{margin:0;font:15px system-ui,sans-serif;background:#f8fafc}form{max-width:360px;margin:160px auto;display:grid;gap:12px}
input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #e2e8f0}button{background:#2563eb;color:#fff;border:0}</style></head>
<body><form method="post" action="/login"><h2>Parcel desk</h2><input type="email" name="email" placeholder="Email">
<input type="password" name="password" placeholder="Password"><button type="submit">Sign in</button></form></body></html>`;

/** Starts the app; `dataFile` holds the parcels (the example's `exec` hook rewrites it). */
export function startServer({ dataFile, port = 0 } = {}) {
  const page = readFileSync(join(HERE, 'site', 'index.html'));
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const signedIn = /(^|;\s*)session=ok/.test(req.headers.cookie ?? '');
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', c => (body += c));
      req.on('end', () => {
        const f = new URLSearchParams(body);
        if (f.get('email') === DEMO_USER.email && f.get('password') === DEMO_USER.password) {
          res.writeHead(303, { location: '/', 'set-cookie': ['session=ok; Path=/; HttpOnly', `user=${encodeURIComponent(DEMO_USER.email)}; Path=/`] });
        } else res.writeHead(303, { location: '/login?failed=1' });
        res.end();
      });
      return;
    }
    if (url.pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(LOGIN); return; }
    if (!signedIn) { res.writeHead(302, { location: '/login' }); res.end(); return; }
    if (url.pathname === '/api/parcels') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(readFileSync(dataFile)); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });
  return new Promise(ok => server.listen(port, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { seed } = await import('./world.mjs');
  const dataFile = seed();
  const { url } = await startServer({ dataFile, port: +(process.env.PORT ?? 0) });
  console.log(`${url}  (sign in as ${DEMO_USER.email})`);
}
