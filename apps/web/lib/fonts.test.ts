import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { metadata } from '@/app/layout';
import { APP_ORIGIN } from './app-origin';
import { FONT_PRELOAD, PRIMARY_FONT } from './fonts';

const web = fileURLToPath(new URL('../', import.meta.url));
const css = readFileSync(`${web}app/globals.css`, 'utf8');
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => ({
  family: /font-family:\s*'?([^;']+)'?;/.exec(m[1]!)?.[1],
  src: /url\('([^']+)'\)/.exec(m[1]!)?.[1],
  weight: /font-weight:\s*([^;]+);/.exec(m[1]!)?.[1]?.trim(),
}));

describe('primary font preload (REM-W03)', () => {
  it('preloads, per locale, a file that a @font-face rule actually uses and that exists', () => {
    for (const href of Object.values(PRIMARY_FONT)) {
      expect(faces.map((f) => f.src)).toContain(href);
      expect(existsSync(`${web}public${href}`)).toBe(true);
    }
  });

  it('picks the faces the largest text renders with (Manrope in English, Plex Arabic SemiBold in Arabic)', () => {
    expect(faces.find((f) => f.src === PRIMARY_FONT.en)?.family).toBe('Manrope');
    const ar = faces.find((f) => f.src === PRIMARY_FONT.ar);
    expect(ar?.family).toBe('Plex Arabic');
    expect(ar?.weight).toBe('600');
    // One file per locale, never the other locale's face.
    expect(new Set(Object.values(PRIMARY_FONT)).size).toBe(2);
  });

  it('uses CORS mode, as font loads do', () => {
    expect(FONT_PRELOAD).toEqual({ as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' });
  });
});

describe('root metadataBase (REM-W04)', () => {
  it('resolves social images against the app origin', () => {
    expect(metadata.metadataBase).toBeInstanceOf(URL);
    expect(String(metadata.metadataBase)).toBe(`${APP_ORIGIN}/`);
    expect(new URL('/brand/og-resuto.png', metadata.metadataBase!).href).toBe(`${APP_ORIGIN}/brand/og-resuto.png`);
  });
});
