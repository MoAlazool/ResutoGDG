import { SkeletonBlock, SkeletonTable, StatsStripSkeleton } from '@resuto/ui';

/** The page templates of plan §4 (packages/ui templates.tsx), as loading placeholders with the same regions. */
export type AreaTemplate = 'dashboard' | 'list' | 'board' | 'workspace' | 'settings';

const Header = () => (
  <div className="page-header area-sk-header">
    <div className="page-header-text area-sk-title">
      <SkeletonBlock width="38%" height={11} />
      <SkeletonBlock width="62%" height={34} />
      <SkeletonBlock width="80%" height={13} />
    </div>
  </div>
);

/**
 * Loading placeholder for an area's routes (21-SHELL, the area loading.tsx files): the page heading and the regions
 * of the area's page template, so the screen does not jump when content arrives. The shell stays in place.
 */
export function AreaSkeleton({ template }: { template: AreaTemplate }) {
  return (
    <div className="area-sk" aria-busy="true" aria-live="polite" data-template={template}>
      <Header />
      {template === 'dashboard' && <>
        <StatsStripSkeleton count={4} />
        <div className="grid grid-2">
          <div className="panel area-sk-panel"><SkeletonBlock width="40%" height={16} /><SkeletonBlock height={180} radius={8} /></div>
          <div className="panel area-sk-panel"><SkeletonBlock width="50%" height={16} /><SkeletonBlock height={180} radius={8} /></div>
        </div>
      </>}
      {template === 'list' && <>
        <div className="area-sk-filters"><SkeletonBlock width={220} height={36} radius={8} /><SkeletonBlock width={140} height={36} radius={8} /></div>
        <div className="panel area-sk-panel"><SkeletonTable rows={8} cols={5} /></div>
      </>}
      {template === 'board' && (
        <div className="area-sk-lanes">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="panel area-sk-panel">
              <SkeletonBlock width="45%" height={14} />
              <SkeletonBlock height={84} radius={8} />
              <SkeletonBlock height={84} radius={8} />
            </div>
          ))}
        </div>
      )}
      {template === 'workspace' && (
        <div className="area-sk-panes">
          <div className="panel area-sk-panel"><SkeletonBlock height={36} radius={8} /><SkeletonTable rows={7} cols={1} /></div>
          <div className="panel area-sk-panel"><SkeletonBlock width="50%" height={16} /><SkeletonBlock height={320} radius={8} /></div>
          <div className="panel area-sk-panel area-sk-end"><SkeletonBlock width="60%" height={16} /><SkeletonBlock height={160} radius={8} /></div>
        </div>
      )}
      {template === 'settings' && (
        <div className="area-sk-settings">
          <div className="area-sk-nav">{[0, 1, 2, 3, 4].map((i) => <SkeletonBlock key={i} height={32} radius={7} />)}</div>
          <div className="panel area-sk-panel"><SkeletonBlock width="35%" height={16} /><SkeletonBlock height={40} radius={8} /><SkeletonBlock height={40} radius={8} /><SkeletonBlock height={40} radius={8} /></div>
        </div>
      )}
    </div>
  );
}
