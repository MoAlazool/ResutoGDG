import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '../../public');

describe('landing images (VP-27)', () => {
  it('keeps one copy of each image across public/brand and public/landing', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const dir of ['brand', 'landing']) {
      for (const f of readdirSync(path.join(PUBLIC, dir))) {
        const hash = createHash('sha256').update(readFileSync(path.join(PUBLIC, dir, f))).digest('hex');
        if (seen.has(hash)) dupes.push(`${seen.get(hash)} = ${dir}/${f}`);
        else seen.set(hash, `${dir}/${f}`);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('every /brand and /landing file the landing and pricing pages reference exists', () => {
    const refs = new Set<string>();
    for (const f of readdirSync(HERE).filter((n) => /\.(tsx?|css)$/.test(n) && !n.endsWith('.test.ts'))) {
      for (const m of readFileSync(path.join(HERE, f), 'utf8').matchAll(/\/(brand|landing)\/[\w.-]+\.(webp|png|svg|jpe?g)/g)) refs.add(m[0]);
    }
    expect(refs.size).toBeGreaterThan(3);
    expect([...refs].filter((r) => !existsSync(path.join(PUBLIC, r)))).toEqual([]);
  });
});
