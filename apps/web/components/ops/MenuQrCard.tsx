'use client';
// The view-only menu QR (21-ONB, plan §6.2): it opens /m/<slug>, the digital menu with no cart, ordering or table
// session. Downloads as PNG (1024 px, from the API) or SVG. The ordering QRs (tables, venue) stay on the floor pages.
import type { MenuQr } from '@resuto/contracts';
import { Notice, Skeleton } from '@resuto/ui';
import { sanitizeQrSvg } from '@/components/floor/QrSheet';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';

/** Saves `href` (a blob or data: URL) as `name`. */
function save(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}

/** Only the API's own PNG data URL is offered for download (never another scheme). */
const isPngDataUrl = (v: string) => /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(v);

export function MenuQrCard({ orgId, orgSlug, restaurantName, branchCode }: { orgId: string; orgSlug: string; restaurantName: string; branchCode?: string | null }) {
  const { t } = useT();
  const qr = useApi<MenuQr>(`/o/${orgId}/menu-qr${branchCode ? `?branch=${encodeURIComponent(branchCode)}` : ''}`);
  const svg = qr.data ? sanitizeQrSvg(qr.data.svg) : null;
  const png = qr.data && isPngDataUrl(qr.data.png) ? qr.data.png : null;
  const base = `${orgSlug}-menu-qr${qr.data?.branchCode ? `-${qr.data.branchCode}` : ''}`;
  const downloadSvg = () => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    save(url, `${base}.svg`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="panel venue-qr">
      <div className="panel-head"><h2>{t('ops.menuQr.title')}</h2></div>
      <div className="panel-body venue-qr-body">
        {qr.error ? <Notice tone="danger">{qr.error.message}</Notice> : !qr.data ? <Skeleton lines={4} /> : (
          <>
            {svg ? <div className="venue-qr-code" role="img" aria-label={t('ops.menuQr.code', { name: restaurantName })} dangerouslySetInnerHTML={{ __html: svg }} />
              : <div className="venue-qr-code" />}
            <div className="venue-qr-text">
              <p>{t('ops.menuQr.body')}</p>
              <p className="fine"><bdi dir="ltr">{qr.data.url}</bdi></p>
              <div className="row">
                <a className="btn btn-sm btn-primary" href={qr.data.url} target="_blank" rel="noopener noreferrer">{t('ops.menuQr.open')} ↗</a>
                <button type="button" className="btn btn-sm" disabled={!png} onClick={() => png && save(png, `${base}.png`)}>{t('ops.menuQr.png')} ↓</button>
                <button type="button" className="btn btn-sm" disabled={!svg} onClick={downloadSvg}>{t('ops.menuQr.svg')} ↓</button>
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
