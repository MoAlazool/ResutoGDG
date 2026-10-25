'use client';
import { useMemo, useRef, useState } from 'react';
import type { FloorLayout, LoyaltyReward, MenuEditorView } from '@resuto/contracts';
import { Field, Notice, SegmentedControl, SelectField, Sheet, Skeleton } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { money, num, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface DraftLine { productId: string; quantity: number; modifiers: Record<string, string>; notes: string }

interface Redeemable { customerId: string; displayName: string | null; active: boolean; balance: number; rewards: Array<LoyaltyReward & { affordable: boolean }> }

type Fulfillment = 'dine_in' | 'pickup' | 'delivery';

/** Staff order entry in a sheet (21-OPS; was a modal). Prices are always the server's; one idempotency key per intent. */
export function NewOrderSheet({ branchId, customerId, onClose, onCreated }: { branchId: string; customerId?: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { t, locale } = useT();
  const { org, hasModule } = useOrg();
  const { call } = useSession();
  // FT-03: an order for a known customer may redeem a reward; staff identify the guest, the server checks the points.
  const loyalty = useApi<Redeemable>(customerId && hasModule('marketing') ? `/o/${org.id}/loyalty/customers/${customerId}/rewards` : null);
  const [rewardId, setRewardId] = useState('');
  const menu = useApi<MenuEditorView>(`/o/${org.id}/menu`);
  const floor = useApi<FloorLayout>(branchId ? `/o/${org.id}/floor/${branchId}` : null);
  const [fulfillment, setFulfillment] = useState<Fulfillment>('dine_in');
  const [tableId, setTableId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [customer, setCustomer] = useState({ name: '', phone: '' });
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef(newIdempotencyKey());
  const products = useMemo(() => (menu.data?.products ?? []).filter((p) => p.isActive), [menu.data]);
  const groupsById = useMemo(() => new Map((menu.data?.modifierGroups ?? []).map((g) => [g.id, g])), [menu.data]);

  const submit = async () => {
    setPending(true); setError(null);
    try {
      const o = await call<{ id: string }>(`/o/${org.id}/orders`, {
        idempotencyKey: key.current,
        body: {
          branchId, fulfillment, tableId: fulfillment === 'dine_in' ? tableId || null : null,
          lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, notes: l.notes || null,
            modifiers: Object.entries(l.modifiers).filter(([, v]) => v).map(([groupId, optionId]) => ({ groupId, optionId })) })),
          customer: customer.name || customer.phone ? { name: customer.name || null, phone: customer.phone || null } : null,
          customerId: customerId || null, loyaltyRewardId: customerId && rewardId ? rewardId : null,
          deliveryAddress: fulfillment === 'delivery' ? { line1: address } : null,
        },
      });
      onCreated(o.id);
    } catch (e) { setError((e as Error).message); key.current = newIdempotencyKey(); } finally { setPending(false); }
  };

  return (
    <Sheet open onClose={onClose} size="lg" title={t('core.orders.new')} footer={<>
      <button className="btn" onClick={onClose}>{t('action.cancel')}</button>
      <button className="btn btn-primary" disabled={pending || !lines.length || (fulfillment === 'dine_in' && !tableId)} onClick={() => void submit()}>{t('core.orders.create')}</button>
    </>}>
      {!menu.data ? <Skeleton lines={4} /> : (
        <div className="stack">
          {customerId && loyalty.data && <p className="m-0"><strong>{t('loyalty.staff.for', { name: loyalty.data.displayName ?? '—' })}</strong></p>}
          <SegmentedControl<Fulfillment> label={t('core.orders.fulfillment')} value={fulfillment} onChange={setFulfillment}
            options={(['dine_in', 'pickup', 'delivery'] as const).map((f) => ({ value: f, label: t(`core.web.${f}`) }))} />
          {fulfillment === 'dine_in' && (
            <SelectField label={t('core.orders.table')} value={tableId} onChange={(e) => setTableId(e.target.value)}>
              <option value="">—</option>
              {(floor.data?.tables ?? []).map((tb) => <option key={tb.id} value={tb.id}>{tb.label} · {t('core.res.seats', { n: tb.capacity })}</option>)}
            </SelectField>
          )}
          {fulfillment !== 'dine_in' && (
            <div className="form-row">
              <Field label={t('core.web.name')} value={customer.name} onChange={(e) => setCustomer({ ...customer, name: e.target.value })} />
              <Field label={t('core.web.phone')} value={customer.phone} dir="ltr" placeholder="+20…" onChange={(e) => setCustomer({ ...customer, phone: e.target.value.replace(/[\s-]/g, '') })} />
            </div>
          )}
          {fulfillment === 'delivery' && <Field label={t('core.web.address')} value={address} onChange={(e) => setAddress(e.target.value)} />}
          {lines.map((l, i) => {
            const p = products.find((x) => x.id === l.productId);
            return (
              <div key={i} className="card ops-draft-line">
                <div className="spread"><strong>{p ? pick(locale, p.name, p.nameAr) : ''}</strong>
                  <span className="row">
                    <input type="number" min={1} max={99} value={l.quantity} className="input ops-qty num" aria-label={t('core.orders.qty')}
                      onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, Math.min(99, Number(e.target.value) || 1)) } : x)))} />
                    <button className="btn btn-sm btn-ghost" aria-label={t('action.delete')} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
                  </span>
                </div>
                {p?.modifierGroupIds.map((gid) => {
                  const g = groupsById.get(gid);
                  if (!g || !g.isActive) return null;
                  return (
                    <SelectField key={gid} label={`${pick(locale, g.name, g.nameAr)}${g.minSelect > 0 ? ' *' : ''}`} value={l.modifiers[gid] ?? ''}
                      onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, modifiers: { ...x.modifiers, [gid]: e.target.value } } : x)))}>
                      <option value="">—</option>
                      {g.options.filter((o) => o.isAvailable).map((o) => <option key={o.id} value={o.id}>{pick(locale, o.name, o.nameAr)}{o.priceDeltaMinor ? ` +${money(o.priceDeltaMinor, menu.data!.currency, locale)}` : ''}</option>)}
                    </SelectField>
                  );
                })}
              </div>
            );
          })}
          <SelectField label={t('core.orders.addItem')} value="" onChange={(e) => { if (e.target.value) setLines([...lines, { productId: e.target.value, quantity: 1, modifiers: {}, notes: '' }]); }}>
            <option value="">{t('core.orders.chooseItem')}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{pick(locale, p.name, p.nameAr)} · {money(p.priceMinor, p.currency, locale)}</option>)}
          </SelectField>
          {customerId && loyalty.data?.active && loyalty.data.rewards.length > 0 && (
            <div>
              <SelectField label={t('loyalty.staff.reward')} value={rewardId} onChange={(e) => setRewardId(e.target.value)}>
                <option value="">{t('loyalty.staff.none')}</option>
                {loyalty.data.rewards.map((r) => (
                  <option key={r.id} value={r.id} disabled={!r.affordable}>
                    {t(r.affordable ? 'loyalty.staff.option' : 'loyalty.staff.short', { name: pick(locale, r.name, r.nameAr), points: num(r.pointsCost, locale) })}
                  </option>
                ))}
              </SelectField>
              <p className="fine mbs-4">{t('loyalty.staff.balance', { points: num(loyalty.data.balance, locale) })}</p>
            </div>
          )}
          <p className="fine">{t('core.orders.serverPrices')}</p>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      )}
    </Sheet>
  );
}
