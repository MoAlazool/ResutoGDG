/// <reference path="./lucide-icons.d.ts" />
import type { LucideIcon } from 'lucide-react';
import type { SVGProps } from 'react';

// Icons are Lucide (ISC licence), imported one module per icon from lucide-react's ESM entry:
//   import Search from 'lucide-react/dist/esm/icons/search.mjs';
//   <Icon icon={Search} />                      decorative (aria-hidden)
//   <Icon icon={Search} label={t('search')} />  meaningful (role="img" + label)
// Icons that point somewhere (chevrons, arrows, external link, undo/redo, send…) are mirrored in right-to-left
// pages by the .rui-icon-dir class; `mirror` forces it on or off. Size follows the type scale (16/18/20); the
// stroke is slightly lighter than Lucide's default to sit with Manrope and Plex Arabic.

export type { LucideIcon };

/** Lucide display names of icons whose meaning depends on the reading direction. */
export const DIRECTIONAL_ICONS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUpLeft', 'ArrowUpRight', 'ArrowDownLeft', 'ArrowDownRight', 'ArrowLeftRight',
  'ChevronLeft', 'ChevronRight', 'ChevronsLeft', 'ChevronsRight', 'ChevronFirst', 'ChevronLast',
  'CircleArrowLeft', 'CircleArrowRight', 'CircleChevronLeft', 'CircleChevronRight', 'MoveLeft', 'MoveRight',
  'ExternalLink', 'SquareArrowOutUpRight', 'SquareArrowUpRight', 'Undo', 'Undo2', 'Redo', 'Redo2', 'Reply', 'ReplyAll',
  'Forward', 'Send', 'SendHorizontal', 'LogIn', 'LogOut', 'PanelLeft', 'PanelRight', 'PanelLeftClose', 'PanelLeftOpen',
  'PanelRightClose', 'PanelRightOpen', 'ListIndentIncrease', 'ListIndentDecrease', 'TextAlignStart', 'TextAlignEnd',
  'Quote', 'Rss', 'Bike', 'Truck',
]);

export const isDirectional = (icon: LucideIcon) => DIRECTIONAL_ICONS.has(icon.displayName ?? '');

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref' | 'children'> {
  icon: LucideIcon;
  /** Pixel size (width and height). Default 18. */
  size?: number;
  /** Accessible name. Without it the icon is decorative and hidden from assistive technology. */
  label?: string;
  /** Mirror in right-to-left pages. Defaults to true for directional icons (DIRECTIONAL_ICONS). */
  mirror?: boolean;
  strokeWidth?: number;
}

export function Icon({ icon: Glyph, size = 18, label, mirror, className, strokeWidth = 1.75, ...rest }: IconProps) {
  const flip = mirror ?? isDirectional(Glyph);
  const cls = ['rui-icon', flip && 'rui-icon-dir', className].filter(Boolean).join(' ');
  return label
    ? <Glyph size={size} strokeWidth={strokeWidth} className={cls} role="img" aria-label={label} focusable="false" {...rest} />
    : <Glyph size={size} strokeWidth={strokeWidth} className={cls} aria-hidden="true" focusable="false" {...rest} />;
}
