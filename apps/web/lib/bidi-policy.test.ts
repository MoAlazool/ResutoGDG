import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// VS-09 / DF-07 guard: phones and emails are always left-to-right, and user-entered names/addresses can be either
// direction. Concatenating them into a sentence with a template string (`${name} · ${phone}`) loses the isolation
// and reorders them in Arabic ("201090001004+"). Render them with <Phone>, <Email>, <UserText>, <Code> or <bdi>
// from @resuto/ui instead. Staff surfaces are enforced here; guest pages are covered by their own workstreams.
const ROOTS = ['apps/web/app/dashboard', 'apps/web/app/kitchen', 'apps/web/app/admin', 'apps/web/components/shell'];
const repo = join(__dirname, '..', '..', '..');
const FIELD = /\$\{[^}]*\b(phone|guestPhone|customerPhone|supplierPhone|email|guestEmail|customerEmail|address|guestName|customerName|fullName|displayName)\b[^}]*\}/i;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}

describe('bidi isolation policy (VS-09)', () => {
  it('no staff screen interpolates phones, emails or user-entered names into template strings', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) {
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
          // href/tel:/mailto: and API paths are not displayed text.
          const shown = line.replace(/(href|to|src)=\{`[^`]*`\}/g, '').replace(/call\([^)]*\)/g, '');
          if (FIELD.test(shown)) offenders.push(`${relative(repo, f)}:${i + 1}: ${line.trim().slice(0, 140)}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
