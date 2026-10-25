import { StatsStripSkeleton } from '@resuto/ui';

// The shell's own placeholders draw plain `.skeleton` blocks instead of @resuto/ui SkeletonBlock: the staff layout is
// on every staff route, and importing SkeletonBlock pulled the whole states module (with its English and Arabic
// copy) into every route's first load (21-SHELL bundle budget). Same markup as SkeletonBlock.
const Block = ({ w = '100%', h, r }: { w?: string; h: number; r?: number }) => (
  <span className="skeleton" aria-hidden="true" style={{ display: 'block', width: w, height: h, borderRadius: r }} />
);

/**
 * Body placeholder with the geometry of a typical staff page (heading, KPI strip, two panels). Used by the shell while
 * the restaurant loads, so the page does not jump when content arrives.
 */
export function BodySkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <div className="page-header">
        <div className="page-header-text" style={{ width: 'min(420px, 100%)' }}>
          <Block w="38%" h={11} />
          <div style={{ height: 15 }} />
          <Block w="62%" h={34} />
          <div style={{ height: 12 }} />
          <Block w="80%" h={13} />
        </div>
      </div>
      <StatsStripSkeleton count={4} />
      <div className="grid grid-2">
        <div className="panel" style={{ padding: 24 }}><Block w="40%" h={16} /><div style={{ height: 18 }} /><Block h={180} r={8} /></div>
        <div className="panel" style={{ padding: 24 }}><Block w="50%" h={16} /><div style={{ height: 18 }} /><Block h={180} r={8} /></div>
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
