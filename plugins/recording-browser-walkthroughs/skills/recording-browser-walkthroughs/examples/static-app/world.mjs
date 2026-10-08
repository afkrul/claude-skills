// The example's data and its "outside world": seed() writes fresh demo data; exec(event) is the
// side-effect hook the jumps call. In a real app this is where a seeder, a signed webhook through the
// app's own route, or a queued job with third parties faked would go.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let file;

export function seed() {
  file ??= join(mkdtempSync(join(tmpdir(), 'walkthrough-example-')), 'parcels.json');
  writeFileSync(file, JSON.stringify([
    { id: 'P-1001', recipient: 'Robin Demo', status: 'Delivered', stuck: false, why: 'Signed for at the door.', who: 'Nobody' },
    { id: 'P-1002', recipient: 'Sam Example', status: 'Stuck at customs', stuck: true, why: 'Customs asked for an invoice.', who: 'The sender: upload the invoice' },
    { id: 'P-1003', recipient: 'Alex Sample', status: 'In transit', stuck: false, why: 'Left the hub this morning.', who: 'The carrier' },
  ], null, 2));
  return file;
}

/** Side effects for jumps: `v.exec('customs-cleared', 'P-1002')`. */
export function exec(event, id) {
  const all = JSON.parse(readFileSync(file, 'utf8'));
  const p = all.find(x => x.id === id);
  if (!p) throw new Error(`no parcel ${id}`);
  if (event === 'customs-cleared') Object.assign(p, { status: 'In transit', stuck: false, why: 'Customs released it.', who: 'The carrier' });
  else throw new Error(`unknown event ${event}`);
  writeFileSync(file, JSON.stringify(all, null, 2));
}
