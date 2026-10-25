'use client';
// Table QR print sheet (legacy Settings → QR print sheet). The QR endpoint is the
// only place table QR URLs appear (MODULE_CONTRACTS.md §8).
import { EmptyState, Notice, Skeleton } from '@resuto/ui';
import { sanitizeQrSvg } from '@/lib/qr-svg';
import { useApi } from '@/lib/use-api';
import { useFloorLabels } from './use-floor-labels';
import './floor.css';

interface QrItem { tableId: string; label: string; url: string; svg: string }

// Re-exported for the screens that import it from here (ServiceMode, MenuQrCard, LiveFloor).
export { sanitizeQrSvg };

export function QrSheet({ orgId, branchId, branchName, restaurantName }: { orgId: string; branchId: string; branchName: string; restaurantName: string }) {
  const { t } = useFloorLabels();
  const qr = useApi<{ items: QrItem[] }>(`/o/${orgId}/floor/${branchId}/qr`);
  if (qr.error) {
    return (
      <div className="card">
        <Notice tone="danger">{qr.error.status === 404 ? t('studio.floor.notFound') : `${t('state.error')}: ${qr.error.message}`}</Notice>
        <button className="btn" style={{ marginBlockStart: 12 }} onClick={() => void qr.reload()}>{t('action.retry')}</button>
      </div>
    );
  }
  if (!qr.data) return <div className="card"><Skeleton lines={5} /></div>;
  if (!qr.data.items.length) return <div className="card"><EmptyState title={t('studio.qr.emptyTitle')}>{t('studio.qr.emptyBody')}</EmptyState></div>;
  return (
    <div className="qr-print-root card" style={{ padding: 0 }}>
      <div className="spread no-print" style={{ padding: '16px 16px 0' }}>
        <div>
          <h2 style={{ margin: 0 }}>{t('studio.qr.title')}</h2>
          <p className="fine">{t('studio.qr.hint')}</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => window.print()}>{t('studio.qr.print')}</button>
      </div>
      <div className="qr-sheet">
        {qr.data.items.map((item) => {
          const svg = sanitizeQrSvg(item.svg);
          return (
            <figure key={item.tableId} className="qr-card" style={{ margin: 0 }}>
              {svg ? <div role="img" aria-label={t('studio.qr.codeFor', { label: item.label })} dangerouslySetInnerHTML={{ __html: svg }} /> : <Notice tone="warn">{t('studio.qr.invalid')}</Notice>}
              <figcaption>
                <strong>{item.label}</strong>
                <small>{restaurantName} · {branchName}</small>
                <small>{t('studio.qr.scan')}</small>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
