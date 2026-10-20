import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dishArtKind } from './dish-art';

describe('dish pictures without a photo (VP-04, DF-08)', () => {
  it('maps fast-food items to the legacy flat illustrations and everything else to the neutral placeholder', () => {
    expect(dishArtKind('Double Smash', 'Burgers')).toBe('burger-double');
    expect(dishArtKind('Crispy Chicken', 'Burgers')).toBe('burger-chicken');
    expect(dishArtKind('Veggie Smash', 'Burgers')).toBe('burger-veggie');
    expect(dishArtKind('Classic Smash', 'Burgers')).toBe('burger');
    expect(dishArtKind('Loaded Fries', 'Sides')).toBe('fries-loaded');
    expect(dishArtKind('Onion Rings', 'Sides')).toBe('rings');
    expect(dishArtKind('Chocolate Shake', 'Shakes')).toBe('shake');
    expect(dishArtKind('Cola', 'Drinks')).toBe('drink');
    expect(dishArtKind('Seabass with lemon butter', 'Mains')).toBeNull();
    expect(dishArtKind('Hibiscus cooler', 'Drinks')).toBeNull();
  });

  it('no public page, site or storefront paints the menu-photography contact sheet as a cover background', () => {
    const repo = join(__dirname, '..', '..', '..', '..');
    const roots = ['apps/web/app/r', 'apps/web/components/public'].map((r) => join(repo, r));
    const offenders: string[] = [];
    const walk = (p: string): void => {
      if (statSync(p).isDirectory()) { for (const n of readdirSync(p)) walk(join(p, n)); return; }
      if (!/\.(css|tsx?)$/.test(p) || /\.test\./.test(p)) return;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (/menu-photography/.test(line) && /cover/.test(line)) offenders.push(`${relative(repo, p)}:${i + 1}`);
      });
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
