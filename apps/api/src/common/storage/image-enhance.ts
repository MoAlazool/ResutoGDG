import { createHash } from 'node:crypto';

/**
 * Deterministic food-photo enhancement (FT-04). Only tonal and geometric operations on the pixels the restaurant
 * photographed: EXIF orientation, optional trim of a uniform border, an attention-centred crop to a fixed aspect,
 * grey-world white balance (clamped), exposure towards a mid-grey mean (clamped), local contrast (CLAHE) and an
 * unsharp mask. Nothing is generated, painted, removed or added, so the dish, its ingredients and its portion stay
 * exactly what was served. Every computed value is returned as provenance.
 */

let sharpModule: any | null | undefined;
export function loadSharp(): any | null {
  if (sharpModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sharpModule = require('sharp');
      sharpModule.cache(false);
    } catch {
      sharpModule = null;
    }
  }
  return sharpModule;
}

export const sharpAvailable = () => !!loadSharp();

export interface EnhanceParams {
  aspect: '1:1' | '4:3' | '3:2' | '16:9' | 'original';
  trimBorder: boolean;
  exposure: number;
  whiteBalance: boolean;
  contrast: number;
  sharpen: number;
}

export interface EnhancedPhoto {
  master: { bytes: Buffer; width: number; height: number; contentType: 'image/jpeg' };
  formats: Array<{ format: 'webp' | 'avif'; width: number; height: number; bytes: Buffer }>;
  provenance: Record<string, unknown>;
}

const ASPECTS: Record<Exclude<EnhanceParams['aspect'], 'original'>, number> = { '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9 };
const MAX_EDGE = 2048;
const MAX_INPUT_PIXELS = 60_000_000;
/** Width of the AVIF derivative (WebP derivatives come from StorageService.store, CR-12). */
export const ENHANCED_AVIF_WIDTH = 1280;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Largest crop of `aspect` that fits w x h (never upscaled). */
export function cropBox(w: number, h: number, aspect: number) {
  if (w / h > aspect) return { width: Math.round(h * aspect), height: h };
  return { width: w, height: Math.round(w / aspect) };
}

export async function enhanceFoodPhoto(input: Buffer, params: EnhanceParams): Promise<EnhancedPhoto> {
  const sharp = loadSharp();
  if (!sharp) throw new Error('Image processing (sharp) is not available on this server');
  const started = Date.now();
  const ops: Array<Record<string, unknown>> = [];

  // 1. Orientation + optional uniform-border trim, materialised so later steps see real pixels.
  let img = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
  const meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
  ops.push({ op: 'orient', exifOrientation: meta.orientation ?? 1 });
  let buf: Buffer = await img.toBuffer();
  if (params.trimBorder) {
    const trimmed = await sharp(buf).trim({ threshold: 18 }).toBuffer({ resolveWithObject: true }).catch(() => null);
    if (trimmed) {
      const before = await sharp(buf).metadata();
      // Keep the trim only when it removes a real border but not most of the picture.
      const kept = (trimmed.info.width * trimmed.info.height) / ((before.width ?? 1) * (before.height ?? 1));
      if (kept < 0.995 && kept > 0.45) { buf = trimmed.data; ops.push({ op: 'trim_border', threshold: 18, keptArea: round(kept, 3) }); }
      else ops.push({ op: 'trim_border', skipped: true, keptArea: round(kept, 3) });
    }
  }

  // 2. Crop to the aspect, centred on the most salient region (the dish), then cap the long edge (no upscaling).
  const m1 = await sharp(buf).metadata();
  let w = m1.width!, h = m1.height!;
  if (params.aspect !== 'original') {
    const box = cropBox(w, h, ASPECTS[params.aspect]);
    buf = await sharp(buf).resize({ width: box.width, height: box.height, fit: 'cover', position: sharp.strategy.attention }).toBuffer();
    ops.push({ op: 'crop', aspect: params.aspect, strategy: 'attention', from: { width: w, height: h }, to: box });
    w = box.width; h = box.height;
  }
  if (Math.max(w, h) > MAX_EDGE) {
    const r = await sharp(buf).resize({ width: w >= h ? MAX_EDGE : undefined, height: h > w ? MAX_EDGE : undefined, withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
    buf = r.data; ops.push({ op: 'downscale', to: { width: r.info.width, height: r.info.height } });
    w = r.info.width; h = r.info.height;
  }

  // 3. Measure, then correct white balance and exposure with clamped, global gains (no local repainting).
  const stats = await sharp(buf).removeAlpha().stats();
  const [rM, gM, bM] = stats.channels.slice(0, 3).map((c: any) => Math.max(1, c.mean as number));
  const grey = (rM! + gM! + bM!) / 3;
  const wb = params.whiteBalance ? [clamp(grey / rM!, 0.85, 1.18), clamp(grey / gM!, 0.85, 1.18), clamp(grey / bM!, 0.85, 1.18)] : [1, 1, 1];
  const luma = 0.2126 * rM! * wb[0]! + 0.7152 * gM! * wb[1]! + 0.0722 * bM! * wb[2]!;
  // Auto exposure pulls the mean towards ~118/255 (food photos sit slightly above mid-grey), at most ±35%.
  const autoGain = clamp(118 / Math.max(luma, 1), 0.8, 1.35);
  const exposureGain = clamp(autoGain * 2 ** (params.exposure * 0.75), 0.6, 1.8);
  const gains = wb.map((g) => round(g * exposureGain));
  ops.push({ op: 'measure', channelMeans: { r: round(rM!, 2), g: round(gM!, 2), b: round(bM!, 2) } });
  ops.push({ op: 'white_balance', method: params.whiteBalance ? 'grey_world_clamped' : 'off', gains: wb.map((g) => round(g)) });
  ops.push({ op: 'exposure', autoGain: round(autoGain), userStops: params.exposure, gain: round(exposureGain) });
  let pipeline = sharp(buf).removeAlpha().linear(gains, [0, 0, 0]);

  // 4. Local contrast (CLAHE on luminance) and sharpening, both bounded.
  if (params.contrast > 0) {
    const tile = Math.max(8, Math.round(Math.min(w, h) / 8));
    const maxSlope = Math.round(1 + params.contrast * 3);
    pipeline = pipeline.clahe({ width: tile, height: tile, maxSlope });
    ops.push({ op: 'local_contrast', method: 'clahe', tile, maxSlope });
  }
  if (params.sharpen > 0) {
    const sigma = round(0.6 + params.sharpen * 0.9, 2);
    pipeline = pipeline.sharpen({ sigma, m1: 0.5, m2: 2 + params.sharpen * 2 });
    ops.push({ op: 'sharpen', method: 'unsharp_mask', sigma });
  }
  const enhanced = await pipeline.toColourspace('srgb').toBuffer();

  // 5. Outputs: JPEG master (metadata stripped: no GPS/camera data) and WebP/AVIF derivatives.
  const master = await sharp(enhanced).jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer({ resolveWithObject: true });
  // WebP widths are produced by StorageService.store() for the public folder (CR-12); AVIF is added here.
  const formats: EnhancedPhoto['formats'] = [];
  const avifWidth = Math.min(ENHANCED_AVIF_WIDTH, master.info.width);
  const avif = await sharp(enhanced).resize({ width: avifWidth, withoutEnlargement: true }).avif({ quality: 55, effort: 2 }).toBuffer({ resolveWithObject: true });
  formats.push({ format: 'avif', width: avif.info.width, height: avif.info.height, bytes: avif.data });

  return {
    master: { bytes: master.data, width: master.info.width, height: master.info.height, contentType: 'image/jpeg' },
    formats,
    provenance: {
      mode: 'deterministic', engine: { name: 'sharp', version: sharp.versions?.sharp ?? null, libvips: sharp.versions?.vips ?? null },
      generative: false, guarantee: 'Tonal and geometric adjustments only; no pixels were generated, added or removed beyond the crop.',
      input: { sha256: sha(input), width: meta.width ?? null, height: meta.height ?? null, format: meta.format ?? null },
      output: { sha256: sha(master.data), width: master.info.width, height: master.info.height },
      params, operations: ops, durationMs: Date.now() - started,
    },
  };
}
