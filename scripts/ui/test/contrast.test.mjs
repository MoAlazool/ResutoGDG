import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkContrast, contrast, parseHex, resolveTheme } from '../contrast.mjs';
import { SOURCE, undefinedReferences } from '../build-tokens.mjs';

const json = JSON.parse(readFileSync(SOURCE, 'utf8'));

test('contrast() matches the WCAG reference values', () => {
  assert.equal(Math.round(contrast('#000000', '#ffffff') * 100) / 100, 21);
  assert.equal(Math.round(contrast('#ffffff', '#ffffff') * 100) / 100, 1);
  // #767676 on white is the classic 4.54:1 grey.
  assert.equal(Math.round(contrast('#767676', '#ffffff') * 100) / 100, 4.54);
  // A translucent foreground is composited over the background before measuring.
  assert.ok(contrast('#00000080', '#ffffff') < contrast('#000000', '#ffffff'));
  assert.deepEqual(parseHex('#abc'), [170, 187, 204, 1]);
});

test('every semantic text/background pair meets WCAG 2.2 AA in light and dark', () => {
  const rows = checkContrast(json);
  assert.ok(rows.length > 100, `expected the full pair list, got ${rows.length}`);
  assert.ok(rows.some((r) => r.theme === 'dark') && rows.some((r) => r.theme === 'light'));
  const failed = rows.filter((r) => !r.pass).map((r) => `${r.theme} ${r.fg} on ${r.bg}: ${r.ratio} < ${r.min}`);
  assert.deepEqual(failed, []);
});

test('the dark theme redefines every semantic colour role', () => {
  const semantic = Object.keys(json.css.semantic).filter((k) => k.startsWith('--') && !k.startsWith('--elevation'));
  const dark = new Set(Object.keys(json.css.dark));
  assert.deepEqual(semantic.filter((k) => !dark.has(k)), []);
  const light = resolveTheme(json, 'light');
  const darkT = resolveTheme(json, 'dark');
  assert.notEqual(light.get('--bg'), darkT.get('--bg'));
  // Aliases follow the theme (they are var() references onto semantic tokens).
  assert.equal(darkT.get('--muted'), darkT.get('--text-muted'));
});

test('no token references an undefined token', () => {
  assert.deepEqual(undefinedReferences(json), []);
});
