import type { ReactNode, SVGProps } from 'react';
import type { LucideIcon } from '@resuto/ui';

// The Studio toolbar's icons: Lucide icons (ISC, lucide-react 1.53.0) drawn from the same path data as inline SVG, as
// the shell does (components/shell/shell-icons.tsx): the website editor is the heaviest staff route, so it ships these
// few element trees instead of Lucide's runtime. Render them through `Icon` from @resuto/ui (Undo2/Redo2 mirror in RTL).
type Props = SVGProps<SVGSVGElement> & { size?: number | string; strokeWidth?: number | string };
function svgIcon(displayName: string, children: ReactNode): LucideIcon {
  const C = ({ size = 24, strokeWidth = 2, ...rest }: Props) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" {...rest}>{children}</svg>
  );
  C.displayName = displayName;
  return C as unknown as LucideIcon;
}

export const Undo2 = svgIcon('Undo2', <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" /></>);
export const Redo2 = svgIcon('Redo2', <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" /></>);
export const Monitor = svgIcon('Monitor', <><rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" /></>);
export const Tablet = svgIcon('Tablet', <><rect width="16" height="20" x="4" y="2" rx="2" ry="2" /><line x1="12" x2="12.01" y1="18" y2="18" /></>);
export const Smartphone = svgIcon('Smartphone', <><rect width="14" height="20" x="5" y="2" rx="2" ry="2" /><path d="M12 18h.01" /></>);
export const ArrowUp = svgIcon('ArrowUp', <><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></>);
export const ArrowDown = svgIcon('ArrowDown', <><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>);
