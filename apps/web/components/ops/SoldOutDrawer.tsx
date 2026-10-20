'use client';
// "Sold out" (86) drawer for the kitchen and the floor (FT-02 / DF-01). Marks a dish sold out at this branch until the
// end of the branch's day or until it is turned back on; the dish stays on guest menus shown as sold out. Whether the
// branch offers the dish at all is the menu editor's branch setting, not this drawer.
import { useMemo, useState } from 'react';
import type { MenuEditorView, Product } from '@resuto/contracts';
import { Drawer, Notice, SearchInput } from '@resuto/ui';
import { pick, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { stationLabel } from '@/lib/vocab';

export const branchState = (p: Product, branchId: string) => {
  const s = p.branchSettings.find((b) => b.branchId === branchId);
  return {
    offered: s ? s.isAvailable : true,
    soldOut: !!s?.soldOut,
    until: s?.soldOutUntil ?? null,
    outOfStock: p.trackStock && s?.stockQty !== null && s?.stockQty !== undefined && s.stockQty <= 0,
    stock: p.trackStock ? s?.stockQty ?? null : null,
  };
};

export function SoldOutDrawer({ open, onClose, orgId, branchId, timezone }: { open: boolean; onClose: () => void; orgId: string; branchId: string; timezone?: string }) {
  const { t, locale } = useT();
  const { call } = useSession();
  const menu = useApi<MenuEditorView>(open ? `/o/${orgId}/menu` : null, { pauseWhileEditing: false });
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => (menu.data?.products ?? [])
    .filter((p) => p.isActive && branchState(p, branchId).offered)
    .filter((p) => !q || `${p.name} ${p.nameAr ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(branchState(b, branchId).soldOut) - Number(branchState(a, branchId).soldOut) || a.name.localeCompare(b.name)), [menu.data, branchId, q]);

  const set = async (p: Product, available: boolean) => {
    if (pending) return;
    setPending(p.id);
    setError(null);
    try {
      await call(`/o/${orgId}/menu/products/${p.id}/availability`, { body: { branchId, available, ...(available ? {} : { until: 'end_of_day' }) } });
      await menu.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(null);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={t('ops.soldOut.title')} locale={locale}>
      <p className="fine">{t('ops.soldOut.hint')}</p>
      <SearchInput value={q} onChange={setQ} placeholder={t('ops.soldOut.search')} label={t('ops.soldOut.search')} locale={locale} />
      {error && <Notice tone="danger">{error}</Notice>}
      {!menu.data ? <div className="skeleton ops-skel" aria-hidden="true" /> : (
        <div className="soldout-list">
          {rows.map((p) => {
            const s = branchState(p, branchId);
            return (
              <div key={p.id} className="soldout-row">
                <span>
                  <strong>{pick(locale, p.name, p.nameAr)}</strong>
                  <small>{stationLabel(t, p.station)}{s.soldOut ? <> · {s.until ? t('ops.soldOut.until', { time: time(s.until, locale, timezone) }) : t('ops.soldOut.untilCleared')}</> : null}</small>
                </span>
                {s.soldOut
                  ? <button type="button" className="btn btn-sm btn-leaf" disabled={pending === p.id} onClick={() => void set(p, true)}>{t('ops.soldOut.restore')}</button>
                  : <button type="button" className="btn btn-sm" disabled={pending === p.id} onClick={() => void set(p, false)}>{t('ops.soldOut.mark')}</button>}
              </div>
            );
          })}
        </div>
      )}
    </Drawer>
  );
}
