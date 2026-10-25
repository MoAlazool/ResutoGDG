'use client';
// Step 9: the view-only menu QR (GET /o/:orgId/menu-qr: opens /m/<slug>, never an ordering QR). Downloads: the API's
// PNG and SVG, and print-ready PDF posters (A4, A5, table tent) made in the browser by a lazily loaded generator. The
// first download finishes the wizard. From here: the dashboard, the menu, or "Explore Resuto" for the paid modules.
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { BrandView, MenuQr } from '@resuto/contracts';
import { MENU_QR_POSTERS, type MenuQrPoster } from '@resuto/contracts/lite';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { isPngDataUrl, sanitizeQrSvg } from '@/lib/qr-svg';
import { StepFrame } from '../StepFrame';
import { errorText, useWizard } from '../wizard-context';

/** Saves `href` (a blob or data: URL) as `name`. */
function save(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
}
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  save(url, name);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function QrStep() {
  const { t, locale } = useT();
  const w = useWizard();
  const { call } = w;
  const router = useRouter();
  const org = w.org!;
  const [qr, setQr] = useState<MenuQr | null>(null);
  const [brand, setBrand] = useState<BrandView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [making, setMaking] = useState<MenuQrPoster | null>(null);
  const done = !!w.progress.completedAt;

  useEffect(() => {
    let live = true;
    Promise.all([call<MenuQr>(`/o/${org.id}/menu-qr`), call<BrandView>(`/o/${org.id}/brand`).catch(() => null)])
      .then(([q, b]) => { if (live) { setQr(q); setBrand(b); } })
      .catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [org.id, call]);

  const svg = qr ? sanitizeQrSvg(qr.svg) : null;
  const png = qr && isPngDataUrl(qr.png) ? qr.png : null;
  const base = `${org.slug}-menu-qr`;
  const finishOnce = async () => { if (!done) await w.finish().catch(() => undefined); };

  const downloadPng = () => { if (png) { save(png, `${base}.png`); void finishOnce(); } };
  const downloadSvg = () => {
    if (!svg) return;
    saveBlob(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
    void finishOnce();
  };
  const poster = async (kind: MenuQrPoster) => {
    if (!qr) return;
    setMaking(kind); setError(null);
    try {
      const { makePosterPdf } = await import('@/lib/onboarding/poster');
      const blob = await makePosterPdf({
        kind, url: qr.url, name: org.name, nameAr: org.nameAr, locale,
        colors: { primary: brand?.theme.primaryColor ?? 'black', accent: brand?.theme.accentColor ?? 'gray', background: brand?.theme.backgroundColor ?? 'white' },
        logoUrl: brand?.logoUrl ?? null,
      });
      saveBlob(blob, `${base}-${kind.replace('_', '-')}.pdf`);
      void finishOnce();
    } catch {
      setError(t('onb.qr.posterFailed'));
    } finally {
      setMaking(null);
    }
  };

  const toDashboard = async () => {
    await finishOnce();
    router.push(`/dashboard/${org.id}`);
  };
  const name = pick(locale, org.name, org.nameAr);
  return (
    <StepFrame title={t('onb.qr.title')} body={t('onb.qr.body')} onSubmit={toDashboard} primary={t('onb.qr.dashboard')} error={error}>
      <div className="onb-qr">
        {svg ? <div className="onb-qr-code" role="img" aria-label={t('onb.qr.code', { name })} dangerouslySetInnerHTML={{ __html: svg }} />
          : <div className="onb-qr-code onb-step-loading" aria-hidden="true" />}
        <div className="onb-qr-actions">
          {qr && <p className="onb-hint"><bdi dir="ltr">{qr.url}</bdi></p>}
          <div className="onb-row onb-row-inline">
            <button type="button" className="btn onb-btn" disabled={!png} onClick={downloadPng}>{t('onb.qr.download', { format: 'PNG' })}</button>
            <button type="button" className="btn onb-btn" disabled={!svg} onClick={downloadSvg}>{t('onb.qr.download', { format: 'SVG' })}</button>
          </div>
          <h2>{t('onb.qr.posters')}</h2>
          <div className="onb-row onb-row-inline">
            {(Object.keys(MENU_QR_POSTERS) as MenuQrPoster[]).map((k) => (
              <button key={k} type="button" className="btn onb-btn" disabled={!qr || making !== null} onClick={() => void poster(k)}>
                {making === k ? t('onb.qr.making') : t(`onb.qr.poster.${k}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
      {done && (
        <div className="onb-finish" role="status">
          <p className="onb-ok">{t('onb.qr.finished')}</p>
          <ul className="onb-next">
            {qr && <li><a className="onb-link" href={qr.url} target="_blank" rel="noopener noreferrer">{t('onb.qr.open')} ↗</a></li>}
            <li><a className="onb-link" href={`/dashboard/${org.id}/explore`}>{t('onb.qr.explore')}</a></li>
            <li><button type="button" className="onb-link" onClick={() => void w.restart().catch(() => undefined)}>{t('onb.qr.another')}</button></li>
          </ul>
        </div>
      )}
    </StepFrame>
  );
}
