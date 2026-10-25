import type { ReactNode, SVGProps } from 'react';
import { Icon, type LucideIcon } from '@resuto/ui';

// Small action icons for staff pages migrated in 21-MIGRATE (they replace Unicode glyphs such as ✕ ✓ ◷ ↗ ← ＋ ↓).
// Lucide icons (ISC, lucide-react 1.53.0) drawn from the same path data as inline SVG, like the shell's set
// (components/shell/shell-icons.tsx), so a page ships only the element trees it uses and not Lucide's runtime. Each
// definition is a separate /*#__PURE__*/ export, so unused ones are dropped from a route's bundle. They render through
// `Icon` (size, stroke, decorative or labelled, RTL mirroring by display name).

type Props = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string };
function svgIcon(displayName: string, children: ReactNode): LucideIcon {
  const C = ({ size = 24, strokeWidth = 2, ...rest }: Props) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>
  );
  C.displayName = displayName;
  return C as unknown as LucideIcon;
}

export const XIcon = /*#__PURE__*/ svgIcon('X', <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>);
export const CheckIcon = /*#__PURE__*/ svgIcon('Check', <path d="M20 6 9 17l-5-5" />);
export const ClockIcon = /*#__PURE__*/ svgIcon('Clock', <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>);
export const CircleIcon = /*#__PURE__*/ svgIcon('Circle', <circle cx="12" cy="12" r="10" />);
export const ExternalIcon = /*#__PURE__*/ svgIcon('ArrowUpRight', <><path d="M7 7h10v10" /><path d="M7 17 17 7" /></>);
export const BackIcon = /*#__PURE__*/ svgIcon('ArrowLeft', <><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>);
export const DownloadIcon = /*#__PURE__*/ svgIcon('Download', <><path d="M12 15V3" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /></>);
export const PlusIcon = /*#__PURE__*/ svgIcon('Plus', <><path d="M5 12h14" /><path d="M12 5v14" /></>);
export const ForwardIcon = /*#__PURE__*/ svgIcon('ArrowRight', <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>);

/** An icon at text size (16 px) inline with a label; decorative unless `label` is given. */
export function Glyph({ icon, label, size = 16 }: { icon: LucideIcon; label?: string; size?: number }) {
  return <Icon icon={icon} size={size} label={label} />;
}
