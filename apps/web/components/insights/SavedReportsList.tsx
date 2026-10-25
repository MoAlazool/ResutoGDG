'use client';
// Saved reports on the Insights overview (21-INSIGHTS): open any of them; share, unshare or delete your own (a
// colleague's shared report is read-only: only its author changes it).
import Link from 'next/link';
import { Badge, Notice, Skeleton, useAction, useConfirm } from '@resuto/ui';
import type { SavedReport } from '@/lib/contracts-reports';
import { reportHref } from '@/lib/insights';
import { useT } from '@/lib/i18n/client';
import { useBranchName } from '@/components/charts/insights';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import s from './insights.module.css';
import { useSavedReports } from './use-saved-reports';

export function SavedReportsList() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [confirm, confirmDialog] = useConfirm(locale);
  const reports = useSavedReports();
  const branchName = useBranchName();
  const share = useAction(async (r: SavedReport) => {
    await call(`/o/${org.id}/reports/${r.id}`, { method: 'PATCH', body: { shared: !r.shared } });
  });
  const remove = useAction(async (r: SavedReport) => {
    if (!(await confirm({ title: t('insights.report.deleteTitle', { name: r.name }), body: t('insights.report.deleteBody'), confirmLabel: t('action.delete'), tone: 'danger' }))) return;
    await call(`/o/${org.id}/reports/${r.id}`, { method: 'DELETE' });
  });
  const row = (r: SavedReport) => (
    <li key={r.id} className={s.row} data-report={r.id}>
      <div className={s.rowMain}>
        <Link href={`/dashboard/${org.id}${reportHref(r)}`}><bdi>{r.name}</bdi></Link>
        <span className={s.itemMeta}>
          {t(`insights.area.${r.section}`)} · {t(`insights.period.${r.view.period}`)}
          {r.view.period === 'custom' && r.view.from ? <> <span className="num">{r.view.from} – {r.view.to}</span></> : null}
          {' · '}{r.branchId ? branchName(r.branchId) : t('insights.branch.all')}
          {!r.mine && r.authorName ? <> · {t('insights.report.by', { name: r.authorName })}</> : null}
        </span>
      </div>
      <div className={s.rowActions}>
        {r.shared && <Badge tone="info">{t('insights.report.sharedBadge')}</Badge>}
        {r.mine && (
          <>
            <button type="button" className="btn btn-sm" disabled={share.pending} onClick={() => void share.run(r)}>
              {r.shared ? t('insights.report.unshare') : t('insights.report.shareAction')}<span className="sr-only"> {r.name}</span>
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={remove.pending} onClick={() => void remove.run(r)}>
              {t('action.delete')}<span className="sr-only"> {r.name}</span>
            </button>
          </>
        )}
      </div>
    </li>
  );
  return (
    <section className="card" id="saved-reports" aria-labelledby="saved-reports-title">
      <div className={s.cardHead}>
        <h2 id="saved-reports-title" className={s.cardTitle}>{t('insights.report.list')}</h2>
        <p className={s.note}>{t('insights.report.hint')}</p>
      </div>
      {confirmDialog}
      {(share.error || remove.error) && <Notice tone="danger">{share.error ?? remove.error}</Notice>}
      {reports.loading && !reports.data ? <Skeleton lines={3} />
        : reports.error ? <Notice tone="danger">{reports.error.message}</Notice>
          : !reports.mine.length && !reports.shared.length ? <p className={s.empty}>{t('insights.report.none')}</p>
            : (
              <>
                {reports.mine.length > 0 && <><h3 className={s.menuHead}>{t('insights.report.mine')}</h3><ul className={s.list}>{reports.mine.map(row)}</ul></>}
                {reports.shared.length > 0 && <><h3 className={s.menuHead}>{t('insights.report.sharedWithMe')}</h3><ul className={s.list}>{reports.shared.map(row)}</ul></>}
              </>
            )}
    </section>
  );
}
