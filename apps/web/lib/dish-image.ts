// Responsive dish photos (CR-12 web side, REM-W01). The public menu gives each dish `imageUrl` (the smallest stored
// WebP copy at least 640 px wide, else the original), `imageSrcSet` ("url 320w, url 640w, url 1280w" over the stored
// copies) and the original's `imageWidth`/`imageHeight`. Pages pass a srcset plus a `sizes` that matches the CSS box,
// so an 80-120 px phone card downloads the 320 px copy instead of the 640 px one (or a large original).
// Framework-free so it is unit-tested directly.

export interface DishImageSource {
  imageUrl: string | null;
  imageSrcSet?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
}

interface Candidate { url: string; w: number }

/** Parses "url 320w, url 640w" (signed URLs never contain spaces or commas; malformed entries are skipped). */
export function parseSrcSet(srcSet: string | null | undefined): Candidate[] {
  if (!srcSet) return [];
  const out: Candidate[] = [];
  for (const part of srcSet.split(',')) {
    const m = /^\s*(\S+)\s+(\d+)w\s*$/.exec(part);
    if (m && Number(m[2]) > 0) out.push({ url: m[1], w: Number(m[2]) });
  }
  return out;
}

/**
 * The srcset for a dish photo, or undefined when the browser should just load `imageUrl`.
 *
 * With width descriptors the browser ignores `src` as a candidate, so the list must reach as wide as `imageUrl`:
 * when `imageUrl` is the original (wider than every stored copy, e.g. a 512 px photo that only has a 320 px copy),
 * it is added with the original's width. When that width is unknown the copies alone could be too small for a large
 * box, so no srcset is returned and `imageUrl` is used as before.
 */
export function dishSrcSet(p: DishImageSource | null | undefined): string | undefined {
  if (!p?.imageUrl) return undefined;
  const list = parseSrcSet(p.imageSrcSet);
  if (!list.length) return undefined;
  if (!list.some((c) => c.url === p.imageUrl)) {
    const widest = Math.max(...list.map((c) => c.w));
    const w = p.imageWidth ?? 0;
    if (!(w > widest)) return undefined;
    list.push({ url: p.imageUrl, w });
  }
  return list.sort((a, b) => a.w - b.w).map((c) => `${c.url} ${c.w}w`).join(', ');
}

/** `sizes` values for each place a dish photo appears (keep in step with the CSS that sizes the box). */
export const DISH_SIZES = {
  /** Guest menu card (components/guest/consumer.css .gx-grid): 3 columns up to 1260 px, 2 under 768 px, a 100 px thumbnail under 600 px. */
  guestCard: '(max-width: 600px) 100px, (max-width: 768px) 50vw, (max-width: 1024px) 33vw, 380px',
  /** Guest product sheet (.gx-sheet: min(600px, 100%) less 28 px padding each side; full width under 600 px). */
  guestSheet: '(max-width: 600px) 100vw, 544px',
  /** Branch storefront card (storefront.css .sf-grid): 4 columns, 2 under 1020 px, a 142 px thumbnail under 700 px. */
  storefrontCard: '(max-width: 700px) 142px, (max-width: 1020px) 50vw, 310px',
  /** Storefront product sheet (.sf-sheet: min(590px, 100vw - 22px)). */
  storefrontSheet: '(max-width: 612px) 100vw, 590px',
  /** Storefront promo pictures (.sf-combo-pics: 34-42% of the promo block). */
  storefrontCombo: '(max-width: 700px) 42vw, 260px',
} as const;

/** A fixed-size thumbnail (cart line, suggestion, assistant meal). */
export const fixedSizes = (px: number) => `${Math.round(px)}px`;
