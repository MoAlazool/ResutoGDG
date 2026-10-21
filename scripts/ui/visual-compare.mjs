#!/usr/bin/env node
// Compares new screenshots against committed baselines with a tolerance (CR-11 visual parity gate).
//
//   node scripts/ui/visual-compare.mjs --baseline <dir> --actual <dir> [--out <dir>] [--tolerance 0.01] [--threshold 24]
//                                      [--json report.json] [--allow-missing]
//
// Every PNG/WebP in --baseline must have a counterpart (same relative path) in --actual. A pixel differs when any
// RGBA channel differs by more than --threshold (0–255, default 24: anti-aliasing noise stays below it); an image
// fails when the share of differing pixels exceeds --tolerance (default 0.01 = 1 %) or its size changed. Failing
// images get a diff (changed pixels in red over a faded actual) in --out. Exits 1 on any failure; a new capture without
// a baseline is reported as "new" (exit 1 unless --allow-missing, so an unapproved surface cannot slip through).
//
// The Playwright visual project (tests/e2e/visual.spec.ts) enforces its baselines itself; this script is for
// comparing capture sets made outside Playwright (staging galleries, the legacy-vs-new composites) and for CI
// artifacts. Pure Node + sharp (already a dependency of the API).
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sharp = () => createRequire(path.join(ROOT, 'apps/api/package.json'))('sharp');

/** Compares two decoded RGBA buffers of the same size. */
export function diffPixels(a, b, { threshold = 24 } = {}) {
  if (a.length !== b.length) throw new Error('buffers differ in length');
  const mask = new Uint8Array(a.length / 4);
  let changed = 0;
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    if (Math.abs(a[i] - b[i]) > threshold || Math.abs(a[i + 1] - b[i + 1]) > threshold || Math.abs(a[i + 2] - b[i + 2]) > threshold || Math.abs(a[i + 3] - b[i + 3]) > threshold) {
      mask[p] = 1;
      changed++;
    }
  }
  return { changed, total: a.length / 4, ratio: changed / (a.length / 4), mask };
}

async function decode(file) {
  const { data, info } = await sharp()(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Compares one baseline image with one actual image; writes a diff image to `diffFile` when it fails. */
export async function compareImages(baselineFile, actualFile, { tolerance = 0.01, threshold = 24, diffFile = null } = {}) {
  const [a, b] = await Promise.all([decode(baselineFile), decode(actualFile)]);
  if (a.width !== b.width || a.height !== b.height) {
    return { ok: false, reason: `size changed ${a.width}x${a.height} → ${b.width}x${b.height}`, ratio: 1 };
  }
  const d = diffPixels(a.data, b.data, { threshold });
  const ok = d.ratio <= tolerance;
  if (!ok && diffFile) {
    const out = Buffer.alloc(b.data.length);
    for (let p = 0; p < d.mask.length; p++) {
      const i = p * 4;
      if (d.mask[p]) { out[i] = 230; out[i + 1] = 0; out[i + 2] = 40; out[i + 3] = 255; }
      else { out[i] = 255 - (255 - b.data[i]) * 0.3; out[i + 1] = 255 - (255 - b.data[i + 1]) * 0.3; out[i + 2] = 255 - (255 - b.data[i + 2]) * 0.3; out[i + 3] = 255; }
    }
    mkdirSync(path.dirname(diffFile), { recursive: true });
    await sharp()(out, { raw: { width: b.width, height: b.height, channels: 4 } }).png().toFile(diffFile);
  }
  return { ok, ratio: d.ratio, changed: d.changed, reason: ok ? null : `${(d.ratio * 100).toFixed(2)} % of pixels changed (tolerance ${(tolerance * 100).toFixed(2)} %)` };
}

function images(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const f = path.join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(png|webp)$/i.test(name)) out.push(path.relative(dir, f));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Compares a directory of actual captures against a directory of baselines. */
export async function compareDirs({ baseline, actual, out = null, tolerance = 0.01, threshold = 24, allowMissing = false }) {
  const base = images(baseline), act = new Set(images(actual));
  const results = [];
  for (const rel of base) {
    if (!act.has(rel)) { results.push({ file: rel, ok: false, status: 'missing-capture', reason: 'no new capture for this baseline' }); continue; }
    act.delete(rel);
    const r = await compareImages(path.join(baseline, rel), path.join(actual, rel), { tolerance, threshold, diffFile: out ? path.join(out, rel.replace(/\.\w+$/, '.diff.png')) : null });
    results.push({ file: rel, status: r.ok ? 'match' : 'changed', ...r });
  }
  for (const rel of act) results.push({ file: rel, ok: allowMissing, status: 'new', reason: 'capture without an approved baseline' });
  return { ok: results.every((r) => r.ok), tolerance, threshold, results };
}

async function main() {
  const a = process.argv.slice(2);
  const arg = (k, d) => (a.includes(`--${k}`) ? a[a.indexOf(`--${k}`) + 1] : d);
  const baseline = arg('baseline'), actual = arg('actual');
  if (!baseline || !actual) { console.error('usage: visual-compare.mjs --baseline <dir> --actual <dir> [--out <dir>] [--tolerance 0.01] [--threshold 24] [--json f] [--allow-missing]'); process.exit(2); }
  const report = await compareDirs({ baseline, actual, out: arg('out', null), tolerance: Number(arg('tolerance', 0.01)), threshold: Number(arg('threshold', 24)), allowMissing: a.includes('--allow-missing') });
  for (const r of report.results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.status.padEnd(15)} ${r.file}${r.reason ? ` — ${r.reason}` : ''}`);
  console.log(`${report.results.filter((r) => r.ok).length}/${report.results.length} images within tolerance`);
  if (arg('json', null)) writeFileSync(arg('json'), `${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
