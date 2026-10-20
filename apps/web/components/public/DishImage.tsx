// A dish picture for public pages: the dish's own photo, else a flat illustration for fast-food items, else a neutral
// placeholder (audits VP-04, DF-08). Server- and client-safe (no hooks). Styling hooks: .dish-img, .dish-art,
// .dish-placeholder; the caller sizes the box.
import { dishArtKind, dishArtUrl } from './dish-art';

export function DishImage({ url, name, englishName, category, className = '', eager = false }: {
  url: string | null;
  /** Display name (alt text) in the page language. */
  name: string;
  /** English name and category, used only to pick an illustration. */
  englishName?: string | null;
  category?: string | null;
  className?: string;
  eager?: boolean;
}) {
  if (url) return <img className={`dish-img ${className}`} src={url} alt={name} loading={eager ? 'eager' : 'lazy'} decoding="async" />;
  const kind = dishArtKind(englishName ?? name, category);
  if (kind) return <img className={`dish-art ${className}`} src={dishArtUrl(kind)} alt="" aria-hidden loading="lazy" decoding="async" />;
  return <span className={`dish-placeholder ${className}`} aria-hidden>◌</span>;
}
