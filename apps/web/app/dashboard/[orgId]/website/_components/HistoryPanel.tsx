'use client';
import { Badge, EmptyState, Notice, OrderRef, Sheet, Skeleton, useConfirm, useToast } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';

/** Version history (toolbar): every published revision; restoring copies it into the draft (publish to make it live). */
export function HistorySheet({ orgId, canWrite, current, open, onClose, onRestored }: {
  orgId: string; canWrite: boolean; current: number; open: boolean; onClose: () => void; onRestored: () => void;
}) {
  const { t, locale } = useT();
  const session = useSession();
  const toast = useToast();
  const [confirm, dialog] = useConfirm(locale);
  const revs = useApi<{ items: Array<{ revision: number; note: string | null; publishedAt: string; publishedBy: string | null; sectionCount: number }> }>(`/o/${orgId}/studio/website/revisions`);
  return (
    <Sheet open={open} onClose={onClose} title={t('studio.history.title')} description={t('studio.history.hint')} size="lg" locale={locale}>
      {dialog}
      {revs.error ? <Notice tone="danger">{revs.error.message}</Notice> : !revs.data ? <Skeleton lines={3} /> : !revs.data.items.length ? (
        <EmptyState title={t('studio.history.emptyTitle')}>{t('studio.history.emptyBody')}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{t('studio.history.revision')}</th><th>{t('studio.history.when')}</th><th>{t('studio.history.by')}</th><th>{t('studio.history.sections')}</th><th /></tr></thead>
            <tbody>
              {revs.data.items.map((r) => (
                <tr key={r.revision}>
                  <td><OrderRef n={r.revision} /> {r.revision === current && <Badge tone="ok">{t('studio.history.live')}</Badge>}{r.note && <div className="fine">{r.note}</div>}</td>
                  <td>{dateTime(r.publishedAt, locale)}</td>
                  <td>{r.publishedBy ?? '—'}</td>
                  <td className="num">{r.sectionCount}</td>
                  <td className="text-end">
                    {canWrite && (
                      <button type="button" className="btn btn-sm" onClick={async () => {
                        if (!(await confirm({ title: t('studio.history.restoreTitle', { n: r.revision }), body: t('studio.history.restoreBody'), confirmLabel: t('studio.history.restore') }))) return;
                        try {
                          await session.call(`/o/${orgId}/studio/website/revisions/${r.revision}/restore`, { body: {} });
                          toast.show({ message: t('studio.history.restored', { n: r.revision }), tone: 'ok' });
                          onRestored();
                          onClose();
                        } catch (e) { toast.show({ message: (e as Error).message, tone: 'danger' }); }
                      }}>{t('studio.history.restore')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Sheet>
  );
}
