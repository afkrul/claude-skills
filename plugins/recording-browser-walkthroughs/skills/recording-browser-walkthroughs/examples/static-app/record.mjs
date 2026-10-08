// Runnable example: a walkthrough of a small local single-page app ("Parcel desk"), end to end.
// Starts the app on 127.0.0.1 at a free port, signs in off camera, records, writes the MP4 + chapters,
// then pulls a few frames to look at.
//
//   cd <this skill>/kit && npm ci && npx playwright-core install chromium
//   node <this skill>/examples/static-app/record.mjs [outDir]
//
// The case, as handed over (one line per kit call):
//   base URL   the app's local URL (started below)
//   1. Open Parcels and search for Sam's parcel.         → step + type
//   2. Open it.                                          → step + click
//   3. See why it is stuck, and who acts.                → step + callout ×2
//   -- Customs releases it (outside the app).            → jump external, exec('customs-cleared')
//   4. Back on the parcel: it moves again.               → step + callout
// Two parts, one chapter card each (`to` loads each part's page behind its card).

import { startVideo, extractFrames } from '../../kit/demo-kit.mjs';
import { spa } from '../../adapters/spa.mjs';
import { startServer, DEMO_USER } from './server.mjs';
import { seed, exec } from './world.mjs';
import { join } from 'node:path';

const OUT = process.argv[2] ?? process.env.DEMO_OUT_DIR ?? 'videos';
const app = await startServer({ dataFile: seed() });

const v = await startVideo({
  title: 'Find why a parcel is stuck',
  purpose: 'From the parcel list, open a parcel, read why it is stuck and who has to act, then see it move.',
  audience: 'Support · internal',
  product: 'Parcel desk',
  kind: 'tutorial',
  baseUrl: app.url,
  outDir: OUT,
  name: 'example-parcel-stuck',
  startPath: '/',
  adapter: spa({ go: 'app.go', login: DEMO_USER, safeArea: { top: 56, bottom: 0 }, exec }),
});
const p = v.page;

try {
  await v.chapter('Find the parcel', { kicker: 'Part 1 of 2', steps: 2, to: '/', purpose: 'Every question starts from the parcel list.' });
  await v.step('Search by number or recipient', 'The list filters as you type.');
  await v.type('#search', 'Sam', { after: 700 });
  await v.step('Open the parcel', 'Click the row.');
  await v.click(p.locator('tr.row', { hasText: 'Sam Example' }), { after: 700 });

  await v.chapter('Read it, then see it move', { kicker: 'Part 2 of 2', steps: 2, to: '/parcels/P-1002', purpose: 'The status says where it is stuck; "Who acts" says who moves next.' });
  await v.step('Why it is stuck, and who acts', 'Nothing for support to do but tell the sender.');
  await v.callout('[data-status]', 'Stuck at customs', { place: 'right' });
  await v.callout('[data-who]', 'The sender uploads the invoice', { place: 'below' });

  await v.jump('Customs released the parcel.', { kind: 'external', run: () => v.exec('customs-cleared', 'P-1002') });

  await v.step('Back on the parcel: it moves again', 'The status and who acts changed on their own.');
  await v.callout('[data-status]', 'In transit: the carrier has it', { place: 'right' });

  const r = await v.finish({ recap: ['Search the list, open the parcel.', 'Status says where; "Who acts" says who moves.', 'Outside events change it on their own.'] });
  console.log(JSON.stringify(r, null, 2));
  // Look at the result: title, chapter card, a step, the jump, the recap.
  const frames = extractFrames(r.mp4, [1, 9, 15, 30, Math.floor(r.seconds) - 1], join(OUT, 'frames'));
  console.log(frames.join('\n'));
} catch (e) {
  await p.screenshot({ path: join(OUT, 'failed.png') }).catch(() => {});
  await v.abort();
  throw e;
} finally {
  app.close();
}
