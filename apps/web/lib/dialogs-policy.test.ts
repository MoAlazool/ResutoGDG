import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// VS-19: the browser's native confirm/prompt/alert dialogs are unstyled, untranslated (OK/Cancel in the browser's
// language) and block the page. Use useConfirm / usePrompt / Modal from @resuto/ui. The allowlist names screens
// owned by other workstreams that still use them; remove entries as they migrate, never add new ones.
const ROOTS = ['apps/web/app', 'apps/web/components'];
const ALLOW = new Set([
  'apps/web/app/dashboard/[orgId]/integrations/page.tsx', // integrations workstream (revoke confirm)
]);
const repo = join(__dirname, '..', '..', '..');
/** Always native: called on a global object. */
const GLOBAL_CALL = /\b(?:window|globalThis|self|top|parent)\s*\.\s*(confirm|prompt|alert)\s*\(/;
/** A bare call; native unless the file declares that name itself (useConfirm/usePrompt tuple, local function, …). */
const BARE_CALL = /(?<![.\w$])(confirm|prompt|alert)\s*\(/g;

const declares = (src: string, name: string) => new RegExp(
  `\\bfunction\\s*\\*?\\s*${name}\\b|\\b(?:const|let|var)\\s+${name}\\b|\\b(?:const|let|var)\\s*\\[[^\\]]*\\b${name}\\b[^\\]]*\\]\\s*=` +
  `|\\b(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=|\\bimport\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`,
).test(src);

/** Comments are not code: drop `//` comments that start a line and `/* … *\/` blocks, keeping line numbers. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/^\s*\/\/.*$/gm, '');

/** `file:line: text` for every native dialog call in one source file. */
export function nativeDialogCalls(rel: string, src: string): string[] {
  const out: string[] = [];
  const body = code(src);
  body.split('\n').forEach((line, i) => {
    const hit = GLOBAL_CALL.test(line) || [...line.matchAll(BARE_CALL)].some((m) => !declares(body, m[1]!));
    if (hit) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  return out;
}

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) yield p;
  }
}

describe('no native dialogs (VS-19)', () => {
  it('flags window.*, bare and awaited native calls, and accepts names bound by useConfirm/usePrompt', () => {
    expect(nativeDialogCalls('a.tsx', "alert('Saved');")).toHaveLength(1);
    expect(nativeDialogCalls('a.tsx', 'if (!confirm(msg)) return;')).toHaveLength(1);
    expect(nativeDialogCalls('a.tsx', 'const ok = await confirm(t("x"));')).toHaveLength(1);
    expect(nativeDialogCalls('a.tsx', 'const name = prompt("Name?");')).toHaveLength(1);
    expect(nativeDialogCalls('a.tsx', 'window.confirm("x")')).toHaveLength(1);
    expect(nativeDialogCalls('a.tsx', 'globalThis.alert(1)')).toHaveLength(1);
    expect(nativeDialogCalls('a.tsx', 'const [confirm, dialog] = useConfirm(locale);\nif (await confirm({ title })) go();')).toEqual([]);
    expect(nativeDialogCalls('a.tsx', 'const [prompt, promptDialog] = usePrompt(locale);\nconst v = await prompt({ title });')).toEqual([]);
    expect(nativeDialogCalls('a.tsx', 'async function confirm() {}\nvoid confirm();')).toEqual([]);
    expect(nativeDialogCalls('a.tsx', 'const [confirm] = useConfirm(l);\nwindow.alert("x");')).toHaveLength(1);
    expect(nativeDialogCalls('a.tsx', '// press confirm (or cancel)\n/** then prompt (later) */\nconst x = 1;')).toEqual([]);
    expect(nativeDialogCalls('a.tsx', 'act.confirm(x); api.prompt(y); onConfirm(z);')).toEqual([]);
  });

  it('uses useConfirm/usePrompt instead of window.confirm/prompt/alert', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of files(join(repo, root))) {
        const rel = relative(repo, f);
        if (ALLOW.has(rel)) continue;
        offenders.push(...nativeDialogCalls(rel, readFileSync(f, 'utf8')));
      }
    }
    expect(offenders).toEqual([]);
  });
});
