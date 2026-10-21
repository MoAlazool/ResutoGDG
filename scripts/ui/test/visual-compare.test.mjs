// node --test scripts/ui/test/*.test.mjs  (CR-11: the comparison behind the visual parity gate)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { compareDirs, compareImages, diffPixels } from '../visual-compare.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sharp = createRequire(path.join(ROOT, 'apps/api/package.json'))('sharp');
const dir = mkdtempSync(path.join(tmpdir(), 'visual-'));
/** A 100x100 white image with a black square of `size` px at the top left, optionally slightly off-white. */
const image = async (file, { size = 10, tint = 0, width = 100 } = {}) => {
  const raw = Buffer.alloc(width * 100 * 4, 255);
  for (let y = 0; y < 100; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const v = x < size && y < size ? 0 : 255 - tint;
    raw[i] = raw[i + 1] = raw[i + 2] = v; raw[i + 3] = 255;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  await sharp(raw, { raw: { width, height: 100, channels: 4 } }).png().toFile(file);
  return file;
};

describe('visual comparison', () => {
  it('ignores sub-threshold noise and counts real changes', () => {
    const a = Buffer.from([0, 0, 0, 255, 10, 10, 10, 255]);
    assert.equal(diffPixels(a, Buffer.from([20, 20, 20, 255, 10, 10, 10, 255])).changed, 0);
    assert.equal(diffPixels(a, Buffer.from([90, 0, 0, 255, 10, 10, 10, 255])).changed, 1);
  });

  it('passes identical and anti-aliasing-level differences, fails a moved element, writes a diff', async () => {
    const base = await image(path.join(dir, 'b/x.png'));
    assert.equal((await compareImages(base, await image(path.join(dir, 'a1/x.png')))).ok, true);
    assert.equal((await compareImages(base, await image(path.join(dir, 'a2/x.png'), { tint: 10 }))).ok, true);   // below threshold
    const diffFile = path.join(dir, 'out/x.diff.png');
    const changed = await compareImages(base, await image(path.join(dir, 'a3/x.png'), { size: 30 }), { diffFile });
    assert.equal(changed.ok, false);
    assert.ok(changed.ratio > 0.07 && changed.ratio < 0.09, String(changed.ratio));
    assert.ok(existsSync(diffFile));
    assert.match((await compareImages(base, await image(path.join(dir, 'a4/x.png'), { width: 120 }))).reason, /size changed/);
  });

  it('flags missing captures and unapproved new captures', async () => {
    await image(path.join(dir, 'B/one.png')); await image(path.join(dir, 'B/two.png'));
    await image(path.join(dir, 'A/one.png')); await image(path.join(dir, 'A/three.png'));
    const r = await compareDirs({ baseline: path.join(dir, 'B'), actual: path.join(dir, 'A') });
    assert.equal(r.ok, false);
    assert.deepEqual(r.results.map((x) => [x.file, x.status]), [['one.png', 'match'], ['two.png', 'missing-capture'], ['three.png', 'new']]);
    const lenient = await compareDirs({ baseline: path.join(dir, 'B'), actual: path.join(dir, 'A'), allowMissing: true });
    assert.equal(lenient.results.find((x) => x.status === 'new').ok, true);
  });
});
