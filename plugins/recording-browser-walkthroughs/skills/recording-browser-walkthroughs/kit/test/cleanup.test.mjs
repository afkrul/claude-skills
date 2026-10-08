// A failed recording must not leave Chromium running: the script would never exit.
// Each case runs in a child process that catches the error and does NOT call process.exit;
// the test passes only if that child exits on its own. Needs Chromium (npm run install-browser).
//
//   cd kit && npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const KIT_URL = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'demo-kit.mjs')).href;
const EXIT_WITHIN_MS = 30000;

// A tiny local app, so the recording context can open a page.
const SERVER = `
import { createServer } from 'node:http';
const server = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>t</title><p>ok</p>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
server.unref();
const baseUrl = 'http://127.0.0.1:' + server.address().port;
`;

/** Run `body` (an ES module, startVideo in scope) in a child; resolve with { code, out } or reject on hang. */
function runChild(body) {
  const outDir = mkdtempSync(join(tmpdir(), 'demo-kit-test-'));
  const src = `import { startVideo } from ${JSON.stringify(KIT_URL)};\nconst outDir = ${JSON.stringify(outDir)};\n${SERVER}\n${body}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child did not exit within ${EXIT_WITHIN_MS} ms (browser left open?)\n${out}`));
    }, EXIT_WITHIN_MS);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, out }); });
  });
}

const base = `title: 'cleanup test', baseUrl, outDir`;

test('startVideo closes the browser and rejects when login throws', async () => {
  const { code, out } = await runChild(`
    try {
      await startVideo({ ${base}, login: async () => { throw new Error('login refused'); } });
      console.log('RESOLVED');
    } catch (e) { console.log('REJECTED:' + e.message); }
  `);
  assert.match(out, /REJECTED:login refused/);
  assert.equal(code, 0);
});

test('startVideo closes the browser and rejects when init throws', async () => {
  const { code, out } = await runChild(`
    try {
      await startVideo({ ${base}, init: async () => { throw new Error('init broke'); } });
      console.log('RESOLVED');
    } catch (e) { console.log('REJECTED:' + e.message); }
  `);
  assert.match(out, /REJECTED:init broke/);
  assert.equal(code, 0);
});

test('startVideo closes the browser and rejects when the start page fails', async () => {
  const { code, out } = await runChild(`
    try {
      await startVideo({ ${base}, isSignedIn: async () => { throw new Error('check broke'); } });
      console.log('RESOLVED');
    } catch (e) { console.log('REJECTED:' + e.message); }
  `);
  assert.match(out, /REJECTED:check broke/);
  assert.equal(code, 0);
});

test('loginRetries retries a refused login, then records', async () => {
  const { code, out } = await runChild(`
    let calls = 0;
    const v = await startVideo({ ${base}, loginRetries: 1, loginRetryDelayMs: 10,
      login: async () => { if (++calls === 1) throw new Error('first login refused'); } });
    console.log('CALLS:' + calls);
    await v.abort();
  `);
  assert.match(out, /CALLS:2/);
  assert.equal(code, 0);
});

test('v.abort() after a walkthrough throws midway lets the process exit', async () => {
  const { code, out } = await runChild(`
    const v = await startVideo({ ${base} });
    try {
      await v.step('A step');
      throw new Error('midway');
    } catch (e) {
      console.log('CAUGHT:' + e.message);
      await v.abort();
      await v.abort(); // twice is harmless
    }
  `);
  assert.match(out, /CAUGHT:midway/);
  assert.equal(code, 0);
});
