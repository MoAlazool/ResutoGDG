'use client';
// Saved reports in the Insights toolbar (21-INSIGHTS): "Saved reports" lists the member's own reports and the ones
// colleagues shared (each opens its view), "Save view" stores the current section, period, comparison, branch and page
// filters under a name, private unless shared. Loaded as its own chunk after the page (InsightsShell).
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge, Notice, Popover, Switch, useAction } from '@resuto/ui';
import { withParams } from '@/components/ops/use-url-state';
import type { ReportSection, ReportView, SavedReport } from '@/lib/contracts-reports';
import { reportHref } from '@/lib/insights';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import s from './insights.module.css';
import { useSavedReports } from './use-saved-reports';

export function ReportControls({ section, view, branchId }: { section: ReportSection; view: ReportView; branchId: string }) {
  const { t } = useT();
  const { org } = useOrg();
  const params = useSearchParams();
  const reports = useSavedReports();
  const current = params.get('report');
  const open = [...reports.mine, ...reports.shared].find((r) => r.id === current);
  const base = `/dashboard/${org.id}`;
  const item = (r: SavedReport) => (
    <li key={r.id}>
      <Link className={s.item} href={`${base}${reportHref(r)}`} aria-current={r.id === current ? 'page' : undefined}>
        <span dir="auto">{r.name}</span>
        <span className={s.itemMeta}>
          {t(`insights.area.${r.section}`)} · {t(`insights.period.${r.view.period}`)}
          {r.shared && r.mine ? <> · {t('insights.report.sharedBadge')}</> : null}
          {!r.mine && r.authorName ? <> · <bdi>{r.authorName}</bdi></> : null}
        </span>
      </Link>
    </li>
  );
  return (
    <>
      {open && <Badge tone="info"><span className="sr-only">{t('insights.report.open')}: </span><bdi>{open.name}</bdi></Badge>}
      <Popover label={t('insights.report.list')} align="end" trigger={
        <button type="button" className="btn btn-sm">{t('insights.report.list')}{reports.data ? <span className="num"> ({reports.mine.length + reports.shared.length})</span> : null}</button>}>
        <div className={s.menu}>
          {reports.error ? <Notice tone="danger">{reports.error.message}</Notice>
            : !reports.mine.length && !reports.shared.length ? <p className={s.empty}>{t('insights.report.none')}</p> : null}
          {reports.mine.length > 0 && (
            <section aria-label={t('insights.report.mine')}>
              <h3 className={s.menuHead}>{t('insights.report.mine')}</h3>
              <ul className={s.list}>{reports.mine.map(item)}</ul>
            </section>
          )}
          {reports.shared.length > 0 && (
            <section aria-label={t('insights.report.sharedWithMe')}>
              <h3 className={s.menuHead}>{t('insights.report.sharedWithMe')}</h3>
              <ul className={s.list}>{reports.shared.map(item)}</ul>
            </section>
          )}
          <Link className="btn btn-sm btn-ghost" href={`${base}/analytics#saved-reports`}>{t('insights.report.manage')}</Link>
        </div>
      </Popover>
      <Popover label={t('insights.report.save')} align="end" trigger={<button type="button" className="btn btn-sm btn-primary">{t('insights.report.save')}</button>}>
        {(close) => <SaveForm section={section} view={view} branchId={branchId} onSaved={close} />}
      </Popover>
    </>
  );
}

function SaveForm({ section, view, branchId, onSaved }: { section: ReportSection; view: ReportView; branchId: string; onSaved: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [name, setName] = useState(() => `${t(`insights.area.${section}`)} · ${t(`insights.period.${view.period}`)}`);
  const [shared, setShared] = useState(false);
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const body = { name: name.trim(), section, view, branchId: branchId || null, shared };
    const r = await call<SavedReport>(`/o/${org.id}/reports`, { body });
    router.replace(`${pathname}${withParams(window.location.search, { report: r.id })}`, { scroll: false });
    onSaved();
  });
  return (
    <form className={s.form} onSubmit={(e) => void save.run(e)}>
      <label className="field">
        <span>{t('insights.report.name')}</span>
        <input className="input" dir="auto" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <Switch checked={shared} onChange={setShared} label={t('insights.report.share')} description={t('insights.report.shareHint')} />
      <p className="fine">{t(branchId ? 'insights.report.branchOne' : 'insights.report.branchAll')}</p>
      {save.error && <Notice tone="danger">{save.error}</Notice>}
      <button type="submit" className="btn btn-primary" disabled={save.pending || !name.trim()}>{save.pending ? t('state.loading') : t('insights.report.saveConfirm')}</button>
    </form>
  );
}
