'use client';
// Service model of a branch (legacy settings "Service model" cards + setup "Operating mode"; VS-16, FT-07) and the
// counter's single venue QR (legacy /qr/venue launch card). Shared by Settings, Guided setup, the Overview and the QR sheet.
import { useState } from 'react';
import { SERVICE_MODES, type ServiceMode, type VenueQr } from '@resuto/contracts';
import { Notice, Skeleton, useConfirm } from '@resuto/ui';
import { sanitizeQrSvg } from '@/components/floor/QrSheet';
import { formatWhen } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

const GLYPH: Record<ServiceMode, string> = { tables: '▦', counter: '▣', online: '↗' };

export interface ModeBranch { id: string; serviceMode?: ServiceMode | null; acceptsReservations?: boolean }

/**
 * Radio cards for tables / counter / online, plus "Accept table reservations" for table service. Saving goes through
 * PUT /branches/:id/service-mode, which keeps the ordering flags consistent with the mode on the server.
 */
export function ServiceModeCards({ orgId, branch, canEdit, onSaved, saveLabel }: {
  orgId: string; branch: ModeBranch; canEdit: boolean; onSaved?: (mode: ServiceMode) => void | Promise<void>; saveLabel?: string;
}) {
  const { t } = useT();
  const { call } = useSession();
  const initial = (branch.serviceMode ?? 'tables') as ServiceMode;
  const [mode, setMode] = useState<ServiceMode>(initial);
  const [reservations, setReservations] = useState(branch.acceptsReservations ?? true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    if (pending) return;
    setPending(true); setError(null); setSaved(false);
    try {
      await call(`/o/${orgId}/branches/${branch.id}/service-mode`, { method: 'PUT', body: { mode, ...(mode === 'tables' ? { acceptsReservations: reservations } : {}) } });
      setSaved(true);
      await onSaved?.(mode);
    } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  };

  return (
    <div className="mode-picker">
      <div className="mode-cards" role="radiogroup" aria-label={t('ops.mode.title')}>
        {SERVICE_MODES.map((m) => (
          <label key={m} className={`mode-card${mode === m ? ' is-on' : ''}`}>
            <input type="radio" name={`mode-${branch.id}`} value={m} checked={mode === m} disabled={!canEdit || pending} onChange={() => { setMode(m); setSaved(false); }} />
            <span className="mode-card-glyph" aria-hidden="true">{GLYPH[m]}</span>
            <strong>{t(`ops.mode.${m}`)}</strong>
            <small>{t(`ops.mode.${m}.body`)}</small>
          </label>
        ))}
      </div>
      {mode === 'tables' ? (
        <label className="check mode-reservations">
          <input type="checkbox" checked={reservations} disabled={!canEdit || pending} onChange={(e) => { setReservations(e.target.checked); setSaved(false); }} />
          {t('ops.mode.acceptReservations')}
        </label>
      ) : <p className="fine">{t(mode === 'counter' ? 'ops.mode.counterNote' : 'ops.mode.onlineNote')}</p>}
      {error && <Notice tone="danger">{error}</Notice>}
      {saved && <Notice tone="ok">{t('ops.mode.saved')}</Notice>}
      {canEdit && (
        <div className="mode-actions"><button type="button" className="btn btn-primary" disabled={pending}
          onClick={() => void save()}>{pending ? t('state.loading') : saveLabel ?? t('action.save')}</button></div>
      )}
    </div>
  );
}

/**
 * The counter's single venue QR (legacy launch card): one code at the till, every scan starts that guest's own counter
 * order with a ticket number (FT-07, /v/<code>). Staff who may edit the floor can replace a leaked or lost code: the
 * printed one stops opening orders at once.
 */
export function VenueQrCard({ orgId, branchId, title, canRotate }: { orgId: string; branchId: string; title?: string; canRotate?: boolean }) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [confirm, confirmDialog] = useConfirm(locale);
  const [rotating, setRotating] = useState(false);
  const [rotated, setRotated] = useState<string | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const qr = useApi<VenueQr>(`/o/${orgId}/floor/${branchId}/venue-qr`);
  const rotate = async () => {
    if (rotating || !(await confirm({ title: t('ops.counter.rotateTitle'), body: t('ops.counter.rotateBody'), confirmLabel: t('ops.counter.rotate'), tone: 'danger' }))) return;
    setRotating(true); setRotateError(null); setRotated(null);
    try {
      await call(`/o/${orgId}/floor/${branchId}/venue-qr/rotate`, { method: 'POST' });
      setRotated(t('ops.counter.rotated'));
      await qr.reload();
    } catch (e) { setRotateError((e as Error).message); } finally { setRotating(false); }
  };
  const svg = qr.data ? sanitizeQrSvg(qr.data.svg) : null;
  const download = () => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'resuto-venue-qr.svg'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="panel venue-qr">
      {confirmDialog}
      <div className="panel-head"><h2>{title ?? t('ops.mode.venueQr')}</h2></div>
      <div className="panel-body venue-qr-body">
        {qr.error ? <Notice tone="danger">{qr.error.message}</Notice> : !qr.data ? <Skeleton lines={4} /> : (
          <>
            {svg ? <div className="venue-qr-code" aria-label={t('ops.mode.venueQr')} role="img" dangerouslySetInnerHTML={{ __html: svg }} /> : <div className="venue-qr-code" />}
            <div className="venue-qr-text">
              <p>{t(qr.data.kind === 'counter' ? 'ops.counter.venueBody' : 'ops.mode.venueQrBody')}</p>
              <p className="fine"><bdi dir="ltr">{qr.data.url}</bdi></p>
              {qr.data.rotatedAt && <p className="fine">{t('ops.counter.issuedAt', { when: formatWhen(qr.data.rotatedAt, locale) })}</p>}
              {rotated && <Notice tone="ok">{rotated}</Notice>}
              {rotateError && <Notice tone="danger">{rotateError}</Notice>}
              <div className="row">
                <a className="btn btn-sm btn-primary" href={qr.data.url} target="_blank" rel="noopener noreferrer">{t('ops.floor.openGuest')} ↗</a>
                <button type="button" className="btn btn-sm" disabled={!svg} onClick={download}>{t('ops.floor.downloadQr')} ↓</button>
                <button type="button" className="btn btn-sm" onClick={() => window.print()}>{t('ops.mode.print')}</button>
                {canRotate && qr.data.kind === 'counter' && (
                  <button type="button" className="btn btn-sm" disabled={rotating} onClick={() => void rotate()}>{rotating ? t('state.loading') : t('ops.counter.rotate')}</button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
