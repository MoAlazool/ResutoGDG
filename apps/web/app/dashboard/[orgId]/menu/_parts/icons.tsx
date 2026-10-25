import type { ReactNode, SVGProps } from 'react';
import { Icon, type LucideIcon } from '@resuto/ui';

// The menu workspace's icons: Lucide (ISC, lucide-react 1.53.0) path data as inline SVG, rendered through `Icon`, the
// same fallback the shell uses (docs/ui/DESIGN_SYSTEM.md §3) so the route does not pay for Lucide's runtime.
type Props = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string };
function svgIcon(displayName: string, children: ReactNode): LucideIcon {
  const C = ({ size = 24, strokeWidth = 2, ...rest }: Props) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>
  );
  C.displayName = displayName;
  return C as unknown as LucideIcon;
}

const GripVertical = svgIcon('GripVertical', <><circle cx="9" cy="12" r="1" /><circle cx="9" cy="5" r="1" /><circle cx="9" cy="19" r="1" />
  <circle cx="15" cy="12" r="1" /><circle cx="15" cy="5" r="1" /><circle cx="15" cy="19" r="1" /></>);
const Ellipsis = svgIcon('Ellipsis', <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>);
const Plus = svgIcon('Plus', <><path d="M5 12h14" /><path d="M12 5v14" /></>);
const Upload = svgIcon('Upload', <><path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></>);

const ICONS = { grip: GripVertical, more: Ellipsis, plus: Plus, upload: Upload } as const;
export type MenuIconName = keyof typeof ICONS;

/** A decorative menu icon (the button around it carries the accessible name). */
export const MenuIcon = ({ name, size = 16 }: { name: MenuIconName; size?: number }) => <Icon icon={ICONS[name]} size={size} />;
