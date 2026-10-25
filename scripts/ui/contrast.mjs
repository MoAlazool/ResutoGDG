#!/usr/bin/env node
// WCAG 2.2 AA contrast check for the design-token pairs in docs/ui/design-tokens.json ("css.contrast"), in the light
// and the dark theme. 'text' pairs need 4.5:1; 'large' (large or non-essential text) and 'ui' (focus rings, control
// borders, chart marks: SC 1.4.11) need 3:1. Translucent colours are composited over the background first.
//
//   node scripts/ui/contrast.mjs            print every pair, exit 1 when one fails
//   node scripts/ui/contrast.mjs --json     the same as JSON
//
// scripts/ui/test/contrast.test.mjs runs it in CI (node --test scripts/ui/test/*.test.mjs).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE, tierEntries } from './build-tokens.mjs';

export const MIN = { text: 4.5, large: 3, ui: 3 };

/** name → resolved value for a theme ('light' or 'dark'), following var(--…) chains. */
export function resolveTheme(json, theme = 'light') {
  const raw = new Map();
  for (const tier of ['primitive', 'semantic', 'alias', 'component']) for (const [k, v] of tierEntries(json, tier)) raw.set(k, v);
  if (theme === 'dark') for (const tier of ['dark', 'component-dark']) for (const [k, v] of tierEntries(json, tier)) raw.set(k, v);
  const out = new Map();
  const resolve = (name, stack = []) => {
    if (out.has(name)) return out.get(name);
    if (stack.includes(name)) throw new Error(`token cycle: ${[...stack, name].join(' → ')}`);
    const v = raw.get(name);
    if (v === undefined) throw new Error(`undefined token ${name}`);
    const r = v.replace(/var\((--[\w-]+)\)/g, (_, ref) => resolve(ref, [...stack, name]));
    out.set(name, r);
    return r;
  };
  for (const k of raw.keys()) resolve(k);
  return out;
}

/** [r, g, b, a] in 0-255 / 0-1 from #rgb, #rgba, #rrggbb or #rrggbbaa. */
export function parseHex(value) {
  const m = /^#([0-9a-f]{3,8})$/i.exec(String(value).trim());
  if (!m || ![3, 4, 6, 8].includes(m[1].length)) throw new Error(`not a hex colour: ${value}`);
  let h = m[1];
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) : 255));
  return [n[0], n[1], n[2], n[3] / 255];
}

const over = ([r, g, b, a], [R, G, B]) => [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a)];
const channel = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio of a foreground over a background (both hex; translucency composited over white, then bg). */
export function contrast(fg, bg) {
  const b = over(parseHex(bg), [255, 255, 255]);
  const f = over(parseHex(fg), b);
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every configured pair in both themes: { theme, kind, fg, bg, ratio, min, pass }. */
export function checkContrast(json) {
  const rows = [];
  for (const theme of ['light', 'dark']) {
    const t = resolveTheme(json, theme);
    for (const [kind, pairs] of Object.entries(json.css.contrast ?? {})) {
      if (!(kind in MIN)) continue;
      for (const [fg, bgs] of pairs) for (const bg of bgs) {
        const ratio = contrast(t.get(fg), t.get(bg));
        rows.push({ theme, kind, fg, bg, fgValue: t.get(fg), bgValue: t.get(bg), ratio: Math.round(ratio * 100) / 100, min: MIN[kind], pass: ratio >= MIN[kind] });
      }
    }
  }
  return rows;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = checkContrast(JSON.parse(readFileSync(SOURCE, 'utf8')));
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 1));
  else for (const r of rows) console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.theme.padEnd(5)} ${r.kind.padEnd(5)} ${String(r.ratio).padStart(6)} ≥ ${r.min}  ${r.fg} (${r.fgValue}) on ${r.bg} (${r.bgValue})`);
  const failed = rows.filter((r) => !r.pass);
  console.log(`${rows.length} pairs, ${failed.length} failing`);
  if (failed.length) process.exit(1);
}
