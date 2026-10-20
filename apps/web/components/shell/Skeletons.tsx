import { SkeletonBlock, StatsStripSkeleton } from '@resuto/ui';

/**
 * Body placeholder with the geometry of a typical staff page (heading, KPI strip, two panels). Used by the
 * dashboard route's loading.tsx during navigation and by the shell while the restaurant loads, so the page does
 * not jump when content arrives.
 */
export function BodySkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="page-header">
        <div className="page-header-text" style={{ width: 'min(420px, 100%)' }}>
          <SkeletonBlock width="38%" height={11} />
          <div style={{ height: 15 }} />
          <SkeletonBlock width="62%" height={34} />
          <div style={{ height: 12 }} />
          <SkeletonBlock width="80%" height={13} />
        </div>
      </div>
      <StatsStripSkeleton count={4} />
      <div className="grid grid-2">
        <div className="panel" style={{ padding: 24 }}><SkeletonBlock width="40%" height={16} /><div style={{ height: 18 }} /><SkeletonBlock height={180} radius={8} /></div>
        <div className="panel" style={{ padding: 24 }}><SkeletonBlock width="50%" height={16} /><div style={{ height: 18 }} /><SkeletonBlock height={180} radius={8} /></div>
      </div>
    </div>
  );
}

/** Navigation placeholder with the real item height (40px) so the sidebar does not shift when links arrive. */
export function NavSkeleton({ count = 9 }: { count?: number }) {
  return (
    <div className="ws-nav-skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => <span key={i} className="skeleton" />)}
    </div>
  );
}
