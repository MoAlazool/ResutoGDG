import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// VS-19: the browser's native confirm/prompt/alert dialogs are unstyled, untranslated (OK/Cancel in the browser's
// language) and block the page. Use useConfirm / usePrompt / Modal from @resuto/ui. The allowlist names screens
// owned by other workstreams that still use them; remove entries as they migrate, never add new ones.
const ROOTS = ['apps/web/app', 'apps/web/components'];
const ALLOW = new Set([
  'apps/web/app/dashboard/[orgId]/integrations/page.tsx', // integrations workstream (revoke confirm)
  'apps/web/app/o/[token]/OrderingClient.tsx', // guest WhatsApp ordering workstream (cancel confirm)
  'apps/web/app/reserve/[slug]/manage/page.tsx', // guest booking workstream (cancel confirm)
]);
const repo = join(__dirname, '..', '..', '..');
const NATIVE = /\bwindow\.(confirm|prompt|alert)\s*\(|(?<![.\w])(?<!await )(confirm|prompt|alert)\s*\(\s*t\(/;

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}

describe('no native dialogs (VS-19)', () => {
  it('uses useConfirm/usePrompt instead of window.confirm/prompt/alert', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) {
        const rel = relative(repo, f);
        if (ALLOW.has(rel)) continue;
        readFileSync(f, 'utf8').split('\n').forEach((line, i) => { if (NATIVE.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`); });
      }
    }
    expect(offenders).toEqual([]);
  });
});
