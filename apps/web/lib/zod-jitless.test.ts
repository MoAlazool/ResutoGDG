import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { config } from 'zod/v4/core';

// REM-W08: the web entry of @resuto/contracts turns zod's JIT off before any schema is built, so no `new Function`
// probe trips the page CSP (script-src without 'unsafe-eval'). Schemas then parse through zod's interpreted path.
describe('lib/zod-jitless (the web entry of @resuto/contracts)', () => {
  afterAll(() => { config({ jitless: false }); });

  it('sets jitless and never calls the Function constructor while building or parsing schemas', async () => {
    await import('./zod-jitless');
    expect(config().jitless).toBe(true);
    const spy = vi.spyOn(globalThis, 'Function');
    const { z } = await import('zod');
    const schema = z.object({ name: z.string().min(1), qty: z.number().int().positive(), notes: z.string().nullable().optional() });
    expect(schema.parse({ name: 'Burrata', qty: 2, notes: null })).toEqual({ name: 'Burrata', qty: 2, notes: null });
    expect(schema.safeParse({ name: '', qty: 0 }).success).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('the web resolves @resuto/contracts through lib/contracts-entry.ts', () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

  it('switches the JIT off before the contracts source is evaluated (imports run in order)', () => {
    const imports = [...read('./contracts-entry.ts').matchAll(/^(?:import|export \* from) '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['./zod-jitless', '../../../packages/contracts/src/index']);
  });

  it('is the webpack alias of @resuto/contracts', () => {
    expect(read('../next.config.ts')).toMatch(/'@resuto\/contracts\$': path\.join\(repoRoot, 'apps\/web\/lib\/contracts-entry\.ts'\)/);
  });
});
