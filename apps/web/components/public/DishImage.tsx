// A dish picture for public pages: the dish's own photo, else a flat illustration for fast-food items, else a neutral
// placeholder (audits VP-04, DF-08). Server- and client-safe (no hooks). Styling hooks: .dish-img, .dish-art,
// .dish-placeholder; the caller sizes the box. `srcSet` + `sizes` (lib/dish-image) let a phone load the smallest
// stored copy that fills the box; `width`/`height` (the original's) give the browser the aspect ratio up front.
import { dishArtKind, dishArtUrl } from './dish-art';

export function DishImage({ url, name, englishName, category, className = '', eager = false, srcSet, sizes, width, height }: {
  url: string | null;
  /** Display name (alt text) in the page language. */
  name: string;
  /** English name and category, used only to pick an illustration. */
  englishName?: string | null;
  category?: string | null;
  className?: string;
  eager?: boolean;
  srcSet?: string;
  sizes?: string;
  width?: number | null;
  height?: number | null;
}) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- tenant media from the API (signed URL)
      <img className={`dish-img ${className}`} loading={eager ? 'eager' : 'lazy'} decoding="async" srcSet={srcSet} sizes={srcSet ? sizes : undefined}
        src={url} alt={name} width={width ?? undefined} height={height ?? undefined} />
    );
  }
  const kind = dishArtKind(englishName ?? name, category);
  if (kind) return <img className={`dish-art ${className}`} src={dishArtUrl(kind)} alt="" aria-hidden loading="lazy" decoding="async" />;
  return <span className={`dish-placeholder ${className}`} aria-hidden>◌</span>;
}
