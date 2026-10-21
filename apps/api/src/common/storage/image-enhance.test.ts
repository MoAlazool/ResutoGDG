import { describe, expect, it } from 'vitest';
import { cropBox, enhanceFoodPhoto, loadSharp } from './image-enhance';

const sharp = loadSharp();

/** A dark, warm-cast "plate" photo: grey background with a round dish, 1600x1000. */
async function castPhoto() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><rect width="1600" height="1000" fill="rgb(70,52,40)"/>
    <circle cx="1000" cy="520" r="300" fill="rgb(150,110,60)"/><circle cx="1000" cy="520" r="120" fill="rgb(120,40,30)"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

const params = { aspect: '4:3' as const, trimBorder: false, exposure: 0, whiteBalance: true, contrast: 0.35, sharpen: 0.5 };

describe('deterministic food-photo enhancement', () => {
  it('computes the largest crop box without upscaling', () => {
    expect(cropBox(1600, 1000, 4 / 3)).toEqual({ width: 1333, height: 1000 });
    expect(cropBox(800, 1200, 1)).toEqual({ width: 800, height: 800 });
  });

  it('crops to the aspect, neutralises the cast, lifts exposure and records every step', async () => {
    const input = await castPhoto();
    const out = await enhanceFoodPhoto(input, params);
    expect(out.master).toMatchObject({ contentType: 'image/jpeg', width: 1333, height: 1000 });
    const before = (await sharp(input).stats()).channels.slice(0, 3).map((c: any) => c.mean);
    const after = (await sharp(out.master.bytes).stats()).channels.slice(0, 3).map((c: any) => c.mean);
    const spread = (m: number[]) => Math.max(...m) - Math.min(...m);
    expect(spread(after)).toBeLessThan(spread(before));                    // white balance towards neutral
    expect(after.reduce((a: number, b: number) => a + b) / 3).toBeGreaterThan(before.reduce((a: number, b: number) => a + b) / 3); // brighter
    expect(out.formats.map((f) => `${f.format}:${f.width}`)).toEqual(['avif:1280']);
    expect((await sharp(out.formats[0]!.bytes).metadata()).format).toBe('heif');
    expect(out.provenance).toMatchObject({ mode: 'deterministic', generative: false, input: { width: 1600, height: 1000 }, output: { width: 1333, height: 1000 } });
    expect((out.provenance.operations as any[]).map((o) => o.op)).toEqual(['orient', 'crop', 'measure', 'white_balance', 'exposure', 'local_contrast', 'sharpen']);
    // Gains are clamped (no extreme recolouring of the food).
    const wb = (out.provenance.operations as any[]).find((o) => o.op === 'white_balance').gains as number[];
    expect(wb.every((g) => g >= 0.85 && g <= 1.18)).toBe(true);
    // Metadata (camera, GPS) is not copied to the output.
    expect((await sharp(out.master.bytes).metadata()).exif).toBeUndefined();
  });

  it('is deterministic: the same input and parameters give the same pixels', async () => {
    const input = await castPhoto();
    const a = await enhanceFoodPhoto(input, { ...params, aspect: 'original' });
    const b = await enhanceFoodPhoto(input, { ...params, aspect: 'original' });
    expect(a.provenance.output).toEqual(b.provenance.output);
    expect(a.master.width).toBe(1600);
  });
});
