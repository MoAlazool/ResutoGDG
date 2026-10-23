import type { ReactNode } from 'react';

/**
 * The Studio while its layout loads or after loading failed. In the full-bleed editor (backHref set) this card is the
 * only thing on screen (the floor tab bar is not rendered), so it keeps the "Back to service" link too.
 */
export function StudioPending({ backHref, backLabel, children }: { backHref?: string; backLabel: string; children?: ReactNode }) {
  return (
    <div className="card studio-pending">
      {backHref && <p className="studio-pending-back"><a className="studio-back" href={backHref}>← {backLabel}</a></p>}
      {children}
    </div>
  );
}
