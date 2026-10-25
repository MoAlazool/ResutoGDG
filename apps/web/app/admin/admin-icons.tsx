import { Icon, type LucideIcon } from '@resuto/ui';
import { AREA_ICONS, svgIcon } from '@/components/shell/shell-icons';

// Operator console icons (21-ADMIN). Lucide (ISC, lucide-react 1.53.0) element trees drawn without the Lucide runtime,
// as in the staff shell (components/shell/shell-icons.tsx): the console's routes carry only these few shapes.
// Rendered through `Icon` from @resuto/ui (size, stroke, decorative or labelled, RTL mirroring by display name).

const Tag = svgIcon('Tag', <><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></>);
const KeyRound = svgIcon('KeyRound', <><path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" /></>);
const Copy = svgIcon('Copy', <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>);
const Check = svgIcon('Check', <path d="M20 6 9 17l-5-5" />);
const CircleCheck = svgIcon('CircleCheck', <><circle cx="12" cy="12" r="10" /><path d="m16 9-5.5 5.5L8 12" /></>);
const CircleDashed = svgIcon('CircleDashed', <><path d="M10.1 2.182a10 10 0 0 1 3.8 0" /><path d="M13.9 21.818a10 10 0 0 1-3.8 0" /><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" /><path d="M2.182 13.9a10 10 0 0 1 0-3.8" /><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /><path d="M21.818 10.1a10 10 0 0 1 0 3.8" /><path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" /></>);
const ArrowLeft = svgIcon('ArrowLeft', <><path d="m12 19-7-7 7-7" /><path d="M19 12H5" /></>);
const RefreshCw = svgIcon('RefreshCw', <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></>);

export const ADMIN_ICONS = {
  tenants: AREA_ICONS.store!, prices: Tag, operations: AREA_ICONS.operations!, providers: KeyRound,
  copy: Copy, copied: Check, done: CircleCheck, todo: CircleDashed, back: ArrowLeft, refresh: RefreshCw,
} satisfies Record<string, LucideIcon>;
export type AdminIconName = keyof typeof ADMIN_ICONS;

/** A console icon; decorative unless `label` is given. `back` mirrors in Arabic (directional). */
export function AdminIcon({ name, size = 18, label, className }: { name: AdminIconName; size?: number; label?: string; className?: string }) {
  return <Icon icon={ADMIN_ICONS[name]} size={size} label={label} className={className} />;
}
