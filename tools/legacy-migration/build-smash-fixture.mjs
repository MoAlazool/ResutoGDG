#!/usr/bin/env node
// Builds fixtures/smash-and-co.legacy-state.json: a legacy COUNTER restaurant (Smash & Co, serviceMode "counter")
// derived from the sanitized Olive Room fixture, for the CR-13 rehearsal. It exercises what the Olive Room fixture
// does not: one venue QR instead of table QRs, a photo uploaded to the legacy media store (imageMediaKey, file in
// fixtures/media/), photos served from the legacy public/ folder (assets/smash/…) and an inline data: URL photo.
// Deterministic: re-running produces the same file.
//
//   node tools/legacy-migration/build-smash-fixture.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_STOREFRONT_PHOTOS } from './lib/transform.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const olive = JSON.parse(readFileSync(path.join(here, 'fixtures/olive-room.legacy-state.json'), 'utf8'));
// 1x1 PNG (transparent): the smallest real image, standing in for a photo pasted into the legacy editor.
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const s = structuredClone(olive.state);
const burger = s.branches.find((b) => b.id === 'burger');
s.branches = [{ ...burger, id: 'main', name: 'Smash & Co Downtown', nameAr: 'سماش آند كو وسط البلد', reservations: false }];
s.menu = s.menu.filter((m) => (m.branchIds ?? []).includes('burger')).map((m) => {
  const item = { ...m, branchIds: ['main'] };
  if (m.id === 'b1') item.imageMediaKey = 'menu-b1-3f9c2a7d1e4b.webp';           // uploaded in the legacy manager
  else if (m.id === 'b8') item.image = `data:image/png;base64,${PIXEL}`;       // pasted inline
  else item.imageUrl = `/assets/smash/${LEGACY_STOREFRONT_PHOTOS[m.id]}.webp`;  // served from legacy public/
  return item;
});
s.settings = { ...s.settings, name: 'Smash & Co', branch: 'Smash & Co Downtown', serviceMode: 'counter', reservationsEnabled: false,
  deposit: 0, venueQr: '5d1c9e0b7a3f48e2a6c4b2d09f17e3a8' };
s.tables = []; s.reservations = []; s.visits = []; s.orders = []; s.payments = []; s.requests = []; s.audit = [];
s.floor = { ...s.floor, zones: [], objects: [] };
const doc = {
  _fixture: {
    restaurantId: 'smash-and-co-demo', slug: 'smash-and-co', description: 'Legacy counter-service restaurant derived from the Olive Room fixture (build-smash-fixture.mjs) for the CR-13 media and venue QR rehearsal.',
    sanitized: olive._fixture.sanitized, synthetic: 'Fictional demo restaurant; no real people, orders or payments.', generatedBy: 'tools/legacy-migration/build-smash-fixture.mjs',
  },
  state: s,
};
writeFileSync(path.join(here, 'fixtures/smash-and-co.legacy-state.json'), `${JSON.stringify(doc, null, 2)}\n`);
console.log(`wrote fixtures/smash-and-co.legacy-state.json: ${s.menu.length} menu items, venue QR, ${s.menu.filter((m) => m.imageMediaKey || m.image || m.imageUrl).length} photos`);
