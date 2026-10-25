import type { ReactNode, SVGProps } from 'react';
import { Icon, type LucideIcon } from '@resuto/ui';

// Operator console icons (21-ADMIN). Lucide (ISC, lucide-react 1.53.0) element trees drawn without the Lucide runtime,
// as in the staff shell (components/shell/shell-icons.tsx): the console's routes carry only these few shapes. Kept
// separate from the staff shell's set on purpose: sharing that module moved it into a chunk every dashboard route
// loads (+0.7 kB gz each). Rendered through `Icon` from @resuto/ui (size, stroke, decorative or labelled, RTL
// mirroring by display name). Regenerate from lucide-react/dist/esm/icons/<name>.mjs (drop the `key` attributes).

type Props = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string };
function svgIcon(displayName: string, children: ReactNode): LucideIcon {
  const C = ({ size = 24, strokeWidth = 2, ...rest }: Props) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>
  );
  C.displayName = displayName;
  return C as unknown as LucideIcon;
}

const Store = svgIcon('Store', <><path d="M15 21v-5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5" /><path d="M17.774 10.31a1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.451 0 1.12 1.12 0 0 0-1.548 0 2.5 2.5 0 0 1-3.452 0 1.12 1.12 0 0 0-1.549 0 2.5 2.5 0 0 1-3.77-3.248l2.889-4.184A2 2 0 0 1 7 2h10a2 2 0 0 1 1.653.873l2.895 4.192a2.5 2.5 0 0 1-3.774 3.244" /><path d="M4 10.95V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8.05" /></>);
const Activity = svgIcon('Activity', <path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />);
const PanelLeftClose = svgIcon('PanelLeftClose', <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" /></>);
const PanelLeftOpen = svgIcon('PanelLeftOpen', <><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /><path d="m14 9 3 3-3 3" /></>);

const Tag = svgIcon('Tag', <><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></>);
const KeyRound = svgIcon('KeyRound', <><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></>);
const Copy = svgIcon('Copy', <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>);
const Check = svgIcon('Check', <path d="M20 6 9 17l-5-5" />);
const CircleCheck = svgIcon('CircleCheck', <><circle cx="12" cy="12" r="10" /><path d="m16 9-5.5 5.5L8 12" /></>);
const CircleDashed = svgIcon('CircleDashed', <><path d="M10.1 2.182a10 10 0 0 1 3.8 0" /><path d="M13.9 21.818a10 10 0 0 1-3.8 0" /><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /><path d="M2.182 13.9a10 10 0 0 1 0-3.8" /><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /><path d="M21.818 10.1a10 10 0 0 1 0 3.8" /><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" /></>);
const ArrowLeft = svgIcon('ArrowLeft', <><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>);
const RefreshCw = svgIcon('RefreshCw', <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>);

export const ADMIN_ICONS = {
  tenants: Store, prices: Tag, operations: Activity, providers: KeyRound, collapse: PanelLeftClose, expand: PanelLeftOpen,
  copy: Copy, copied: Check, done: CircleCheck, todo: CircleDashed, back: ArrowLeft, refresh: RefreshCw,
} satisfies Record<string, LucideIcon>;
export type AdminIconName = keyof typeof ADMIN_ICONS;

/** A console icon; decorative unless `label` is given. `back` mirrors in Arabic (directional). */
export function AdminIcon({ name, size = 18, label, className }: { name: AdminIconName; size?: number; label?: string; className?: string }) {
  return <Icon icon={ADMIN_ICONS[name]} size={size} label={label} className={className} />;
}
