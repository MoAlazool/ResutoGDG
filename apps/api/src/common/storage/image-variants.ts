import { Logger } from '@nestjs/common';

/**
 * Image derivatives (CR-12): guest menus and public sites were served the uploaded original (up to 15 MB phone
 * photos). Uploads to the public-facing folders get WebP copies at fixed widths; readers pick the smallest copy that
 * is at least as wide as they need, and fall back to the original when there is none (old media, GIF, PDF,
 * originals narrower than the smallest width). Copies are never wider than the original (no upscaling), EXIF
 * orientation is applied and metadata (camera, GPS) is not copied.
 */
export const VARIANT_WIDTHS = [320, 640, 1280] as const;
/** Folders whose images are shown on guest-facing pages and get derivatives. */
export const DERIVED_FOLDERS = new Set(['menu', 'studio']);
const DERIVABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);
/** Decoding a 15 MB photo costs CPU and memory: at most this many transforms run at once per process. */
const MAX_CONCURRENT = 2;
const MAX_INPUT_PIXELS = 60_000_000;

export interface MediaVariant { w: number; h: number; path: string; bytes: number }
export interface DerivedImage {
  width: number | null;
  height: number | null;
  variants: Array<{ w: number; h: number; bytes: Buffer }>;
}

const logger = new Logger('ImageVariants');
let sharpModule: any | null | undefined;
function loadSharp(): any | null {
  if (sharpModule === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      sharpModule = require('sharp');
      sharpModule.cache(false);
    } catch (e) {
      // A deployment without the native module still accepts uploads; it just serves originals.
      logger.warn(`sharp unavailable, image derivatives disabled: ${(e as Error).message}`);
      sharpModule = null;
    }
  }
  return sharpModule;
}

let running = 0;
const waiting: Array<() => void> = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function derivable(contentType: string, folder: string) {
  return DERIVABLE.has(contentType) && DERIVED_FOLDERS.has(folder);
}

/** Dimensions (after EXIF orientation) and WebP copies at VARIANT_WIDTHS narrower than the original. */
export async function deriveImage(bytes: Buffer): Promise<DerivedImage> {
  const sharp = loadSharp();
  if (!sharp) return { width: null, height: null, variants: [] };
  return limited(async () => {
    const base = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
    const meta = await base.metadata();
    // metadata() reports the stored orientation; EXIF orientations 5-8 swap width and height.
    const swap = (meta.orientation ?? 1) >= 5;
    const width = (swap ? meta.height : meta.width) ?? null;
    const height = (swap ? meta.width : meta.height) ?? null;
    const variants: DerivedImage['variants'] = [];
    if (width && height) {
      for (const w of VARIANT_WIDTHS) {
        if (w >= width) break;
        const out = await base.clone().resize({ width: w, withoutEnlargement: true }).webp({ quality: 78, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        variants.push({ w: out.info.width, h: out.info.height, bytes: out.data });
      }
    }
    return { width, height, variants };
  });
}

/** Path of the smallest stored copy at least `minWidth` wide (else the widest copy, else the original). */
export function pickVariant(originalPath: string, variants: MediaVariant[] | null | undefined, minWidth: number): string {
  const sorted = [...(variants ?? [])].sort((a, b) => a.w - b.w);
  if (!sorted.length) return originalPath;
  return (sorted.find((v) => v.w >= minWidth) ?? sorted[sorted.length - 1]!).path;
}

/** Object path of a derivative: next to the original, `<uuid>.w640.webp`. */
export function variantObjectPath(originalPath: string, width: number) {
  return originalPath.replace(/\.[a-z0-9]+$/, '') + `.w${width}.webp`;
}
