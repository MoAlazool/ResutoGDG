import type { ReactNode, SVGProps } from 'react';
import { Icon, type LucideIcon } from '@resuto/ui';
import type { ShellIconName } from '@/lib/nav';

// The shell's icons (21-SHELL). They are Lucide icons (ISC, lucide-react 1.53.0), drawn from the same path data as an
// inline SVG set: the staff layout is on every staff route, and Lucide's runtime alone is ~1.9 kB gzip (the largest
// route had ~3 kB of headroom), so the shell ships only these element trees (docs/ui/DESIGN_SYSTEM.md §3 fallback).
// They render through `Icon` from @resuto/ui (size, stroke, decorative/labelled, RTL mirroring by display name).
// Areas, the Settings cluster and Explore carry an icon; secondary items are text, so their icons are not shipped.
// Regenerate a definition from lucide-react/dist/esm/icons/<name>.mjs (drop the `key` attributes).

type Props = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string };
/** A Lucide icon from its element tree (no Lucide runtime); also used by the operator console (app/admin/admin-icons.tsx). */
export function svgIcon(displayName: string, children: ReactNode): LucideIcon {
  const C = ({ size = 24, strokeWidth = 2, ...rest }: Props) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>
  );
  C.displayName = displayName;
  return C as unknown as LucideIcon;
}

const Activity = svgIcon('Activity', <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />);
const Blocks = svgIcon('Blocks', <><path d="M10 22V7a1 1 0 0 0-1-1H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5a1 1 0 0 0-1-1H2" /><rect x="14" y="2" width="8" height="8" rx="1" /></>);
const ChartLine = svgIcon('ChartLine', <><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="m19 9-5 5-4-4-3 3" /></>);
const ChevronDown = svgIcon('ChevronDown', <path d="m6 9 6 6 6-6" />);
const Compass = svgIcon('Compass', <><circle cx="12" cy="12" r="10" /><path d="m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z" /></>);
const Ellipsis = svgIcon('Ellipsis', <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>);
const House = svgIcon('House', <><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>);
const PanelLeftClose = svgIcon('PanelLeftClose', <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" /></>);
const PanelLeftOpen = svgIcon('PanelLeftOpen', <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m14 9 3 3-3 3" /></>);
const Search = svgIcon('Search', <><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>);
const Settings = svgIcon('Settings', <><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></>);
const Store = svgIcon('Store', <><path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5" /><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244" /><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05" /></>);
const Users = svgIcon('Users', <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><path d="M16 3.128a4 4 0 0 1 0 7.744" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /></>);
const Wallet = svgIcon('Wallet', <><path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1" /><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4" /></>);

export const AREA_ICONS: Partial<Record<ShellIconName, LucideIcon>> = {
  home: House, operations: Activity, store: Store, customers: Users, money: Wallet, insights: ChartLine, apps: Blocks,
  settings: Settings, explore: Compass,
};

export const UI_ICONS = { chevron: ChevronDown, collapse: PanelLeftClose, expand: PanelLeftOpen, search: Search, more: Ellipsis } as const;

/** An area icon (decorative: the area's name is its label). Nothing for names without a shell icon. */
export function ShellIcon({ name, size = 18 }: { name: ShellIconName; size?: number }) {
  const glyph = AREA_ICONS[name];
  return glyph ? <Icon icon={glyph} size={size} className="ws-glyph-icon" /> : null;
}

export function UiIcon({ name, size = 18 }: { name: keyof typeof UI_ICONS; size?: number }) {
  return <Icon icon={UI_ICONS[name]} size={size} />;
}
