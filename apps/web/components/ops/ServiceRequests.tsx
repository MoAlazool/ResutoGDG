'use client';
// Service requests panel (legacy .service-panel: table, "Waiter requested · 21:04", Resolve; "You're all caught up").
// Shared by the KDS, the orders board, the live floor and the front desk. Each Resolve is guarded against double
// clicks, shows its pending state and reports a failure in place (PCL-21); the list then refreshes from the server.
import { useState } from 'react';
import { Notice } from '@resuto/ui';
import { formatWhen } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

export interface ServiceRequest { id: string; kind: string; status: string; tableId: string; tableLabel: string; createdAt: string; visitId: string }

export function useServiceRequests(orgId: string, branchId: string | null, pollMs = 3000) {
  return useApi<{ items: ServiceRequest[] }>(branchId ? `/o/${orgId}/requests?branchId=${branchId}` : null, { pollMs });
}

export function ServiceRequestList({ orgId, items, timezone, canResolve, onResolved, onSelect, resolveLabel }: {
  orgId: string; items: ServiceRequest[] | undefined; timezone: string; canResolve: boolean; onResolved?: () => void;
  onSelect?: (r: ServiceRequest) => void; resolveLabel?: string;
}) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const resolve = async (r: ServiceRequest) => {
    if (pending.has(r.id)) return;
    setPending((p) => new Set(p).add(r.id));
    setError(null);
    try {
      await call(`/o/${orgId}/requests/${r.id}/resolve`, { body: { status: 'resolved' } });
      onResolved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending((p) => { const n = new Set(p); n.delete(r.id); return n; });
    }
  };

  if (items === undefined) return <div className="skeleton ops-skel" aria-hidden="true" />;
  return (
    <div className="ops-requests" aria-live="polite">
      {error && <Notice tone="danger">{error}</Notice>}
      {items.length === 0 ? (
        <div className="ops-quiet"><span aria-hidden="true">✓</span><p style={{ margin: 0 }}>{t('ops.req.caughtUp')}<small>{t('ops.req.caughtUpHint')}</small></p></div>
      ) : items.map((r) => (
        <div key={r.id} className="ops-request">
          <span>
            {onSelect
              ? <button type="button" className="ops-link"onClick={() => onSelect(r)}><strong>{t('core.kds.table', { label: r.tableLabel })}</strong></button>
              : <strong>{t('core.kds.table', { label: r.tableLabel })}</strong>}
            <small>{t(`ops.req.kind.${r.kind}`)} · <span className="num">{formatWhen(r.createdAt, locale, timezone)}</span></small>
          </span>
          {canResolve && (
            <button type="button" className="btn btn-sm" disabled={pending.has(r.id)} aria-busy={pending.has(r.id) || undefined} onClick={() => void resolve(r)}>
              {resolveLabel ?? t('ops.req.resolve')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
