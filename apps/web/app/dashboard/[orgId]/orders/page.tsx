'use client';
import { useMemo, useRef, useState } from 'react';
import type { MenuEditorView, OrderDetail, OrderSummary, FloorLayout } from '@resuto/contracts';
import { Badge, DataTable, EmptyState, Modal, Notice, PageHeader, Phone, SelectField, Skeleton, Field, UserText, usePrompt } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { dateTime, formatWhen, money, pick, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { statusTone } from '../../../t/[qr]/_guest/menu-ui';

const STATUSES = ['awaiting_payment', 'placed', 'accepted', 'preparing', 'ready', 'served', 'picked_up', 'delivered', 'cancelled'];
const NEXT: Record<string, Record<string, string[]>> = {
  dine_in: { placed: ['accepted', 'preparing'], accepted: ['preparing'], preparing: ['ready'], ready: ['served'] },
  pickup: { placed: ['accepted', 'preparing'], accepted: ['preparing'], preparing: ['ready'], ready: ['picked_up'] },
  delivery: { placed: ['accepted', 'preparing'], accepted: ['preparing'], preparing: ['ready'], ready: ['delivered'] },
};

export default function OrdersPage() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const [branchId, setBranchId] = useState(org.branches[0]?.id ?? '');
  const [status, setStatus] = useState('active');
  const [channel, setChannel] = useState('');
  const [fulfillment, setFulfillment] = useState('');
  const [date, setDate] = useState('');
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const qs = new URLSearchParams({
    limit: '50', ...(branchId ? { branchId } : {}),
    ...(status === 'active' ? { status: 'awaiting_payment,placed,accepted,preparing,ready' } : status ? { status } : {}),
    ...(channel ? { channel } : {}), ...(fulfillment ? { fulfillment } : {}), ...(date ? { date } : {}), ...(cursor ? { cursor } : {}),
  });
  const list = useApi<{ items: OrderSummary[]; nextCursor: string | null }>(`/o/${org.id}/orders?${qs}`, { pollMs: cursor ? undefined : 5000 });
  const requests = useApi<{ items: Array<{ id: string; kind: string; tableLabel: string; createdAt: string }> }>(
    `/o/${org.id}/requests${branchId ? `?branchId=${branchId}` : ''}`, { pollMs: 5000 });
  const { call } = useSession();

  return (
    <ModuleGate module="core" permission="orders:read">
      <PageHeader title={t('nav.orders')} subtitle={t('core.orders.subtitle')}
        actions={can('orders:write') && <button className="btn btn-primary" onClick={() => setCreating(true)}>+ {t('core.orders.new')}</button>} />
      {/* Guest requests keep a fixed slot (VS-07): the strip is always there, so its arrival does not push the filters
          and the table down after the page has rendered. */}
      <section className="card card-warm requests-strip" aria-label={t('core.orders.requests')} aria-busy={requests.data === undefined || undefined}>
        <h2>{t('core.orders.requests')}</h2>
        <div className="row">
          {requests.data === undefined ? <span className="skeleton" style={{ display: 'block', width: 220, height: 30 }} aria-hidden />
            : requests.data.items.length === 0 ? <span className="fine">{t('core.orders.noRequests')}</span>
              : requests.data.items.map((r) => (
                <span key={r.id} className="badge badge-warn request-chip">
                  {t('core.kds.table', { label: r.tableLabel })} · {t(`core.request.${r.kind}`)} · <span className="num">{formatWhen(r.createdAt, locale, org.timezone)}</span>
                  <button className="btn btn-sm" aria-label={t('core.orders.resolveRequest')} onClick={async () => { await call(`/o/${org.id}/requests/${r.id}/resolve`, { body: { status: 'resolved' } }); void requests.reload(); }}>✓</button>
                </span>
              ))}
        </div>
      </section>
      <div className="form-row" style={{ alignItems: 'end' }}>
        {org.branches.length > 1 && (
          <SelectField label={t('core.web.branch')} value={branchId} onChange={(e) => { setBranchId(e.target.value); setCursor(undefined); }}>
            {org.branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
          </SelectField>
        )}
        <SelectField label={t('core.orders.status')} value={status} onChange={(e) => { setStatus(e.target.value); setCursor(undefined); }}>
          <option value="active">{t('core.orders.active')}</option>
          <option value="">{t('core.orders.all')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{t(`core.status.${s}`)}</option>)}
        </SelectField>
        <SelectField label={t('core.orders.channel')} value={channel} onChange={(e) => { setChannel(e.target.value); setCursor(undefined); }}>
          <option value="">{t('core.orders.all')}</option>
          {['qr', 'web', 'whatsapp', 'staff', 'phone', 'pos', 'mcp'].map((c) => <option key={c} value={c}>{t(`core.channel.${c}`)}</option>)}
        </SelectField>
        <SelectField label={t('core.orders.fulfillment')} value={fulfillment} onChange={(e) => { setFulfillment(e.target.value); setCursor(undefined); }}>
          <option value="">{t('core.orders.all')}</option>
          {['dine_in', 'pickup', 'delivery'].map((f) => <option key={f} value={f}>{t(`core.web.${f}`)}</option>)}
        </SelectField>
        <Field label={t('core.orders.date')} type="date" value={date} onChange={(e) => { setDate(e.target.value); setCursor(undefined); }} />
      </div>
      {list.error && <Notice tone="danger">{list.error.message}</Notice>}
      {list.loading && !list.data ? <Skeleton lines={6} /> : (
        <DataTable rows={list.data?.items ?? []} rowKey={(o) => o.id} onRowClick={(o) => setSelected(o.id)} busy={list.pending}
          empty={<EmptyState title={t('core.orders.empty')}>{t('core.orders.emptyHint')}</EmptyState>}
          columns={[
            { key: 'n', header: '#', render: (o) => <strong>#{o.number}</strong> },
            { key: 'time', header: t('core.orders.placed'), render: (o) => <span className="num">{formatWhen(o.placedAt, locale, org.timezone)}</span> },
            { key: 'where', header: t('core.orders.where'), render: (o) => o.tableLabel ? t('core.kds.table', { label: o.tableLabel }) : <>{t(`core.web.${o.fulfillment}`)}{o.customerName ? <> · <UserText>{o.customerName}</UserText></> : null}</> },
            { key: 'channel', header: t('core.orders.channel'), render: (o) => t(`core.channel.${o.channel}`) },
            { key: 'status', header: t('core.orders.status'), render: (o) => <Badge tone={statusTone(o.status)}>{t(`core.status.${o.status}`)}</Badge> },
            { key: 'pay', header: t('core.orders.payment'), render: (o) => <Badge tone={o.paymentStatus === 'paid' ? 'ok' : o.paymentStatus === 'unpaid' ? 'neutral' : 'pay'}>{t(`core.payment.${o.paymentStatus}`)}</Badge> },
            { key: 'total', header: t('core.bill.total'), align: 'end', render: (o) => <span className="num">{money(o.totalMinor, o.currency, locale)}</span> },
          ]} />
      )}
      <div className="row" style={{ marginTop: 12 }}>
        {cursor && <button className="btn btn-sm" onClick={() => setCursor(undefined)}>{t('core.orders.latest')}</button>}
        {list.data?.nextCursor && <button className="btn btn-sm" onClick={() => setCursor(list.data!.nextCursor!)}>{t('core.orders.older')}</button>}
      </div>
      {selected && <OrderDrawer orderId={selected} onClose={() => setSelected(null)} onChanged={() => void list.reload()} />}
      {creating && <NewOrderModal branchId={branchId} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelected(id); void list.reload(); }} />}
    </ModuleGate>
  );
}

function OrderDrawer({ orderId, onClose, onChanged }: { orderId: string; onClose: () => void; onChanged: () => void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const detail = useApi<OrderDetail>(`/o/${org.id}/orders/${orderId}`, { pollMs: 5000 });
  const [error, setError] = useState<string | null>(null);
  const [refund, setRefund] = useState<{ paidMinor: number } | null>(null);
  const [pending, setPending] = useState(false);
  const collectKey = useRef(newIdempotencyKey());
  const o = detail.data;
  const [prompt, promptDialog] = usePrompt(locale);

  const run = async (fn: () => Promise<unknown>) => {
    setPending(true); setError(null);
    try { await fn(); await detail.reload(); onChanged(); }
    catch (e) {
      const err = e as ApiRequestError;
      if (err.code === 'refund_required') setRefund(err.details as { paidMinor: number });
      setError(err.message);
    } finally { setPending(false); }
  };

  return (
    <Modal open onClose={onClose} title={o ? t('core.guest.orderNumber', { n: o.number }) : t('state.loading')}>
      {promptDialog}
      {!o ? <Skeleton lines={5} /> : (
        <div className="stack">
          <div className="row">
            <Badge tone={statusTone(o.status)}>{t(`core.status.${o.status}`)}</Badge>
            <Badge tone={o.paymentStatus === 'paid' ? 'ok' : 'pay'}>{t(`core.payment.${o.paymentStatus}`)}</Badge>
            <span className="fine">{t(`core.channel.${o.channel}`)} · {t(`core.web.${o.fulfillment}`)} · {dateTime(o.placedAt, locale, org.timezone)}</span>
          </div>
          {(o.customerName || o.customerPhone) && <p style={{ margin: 0 }}><UserText>{o.customerName}</UserText>{o.customerName && o.customerPhone ? ' · ' : ''}<Phone value={o.customerPhone} link />{o.tableLabel ? ` · ${t('core.kds.table', { label: o.tableLabel })}` : ''}</p>}
          {o.deliveryAddress != null && <p className="fine" style={{ margin: 0 }}><UserText>{String((o.deliveryAddress as { line1?: string }).line1 ?? '')}</UserText></p>}
          <div>
            {o.lines.map((l) => (
              <div key={l.id} className="spread" style={{ borderBottom: '1px solid var(--line-soft)', padding: '8px 0' }}>
                <span><strong>{l.quantity}×</strong> {pick(locale, l.name, l.nameAr)}
                  {l.modifiers.length > 0 && <small className="fine"> · {l.modifiers.map((m) => m.option).join(', ')}</small>}
                  {l.notes && <small className="fine"> · “<UserText>{l.notes}</UserText>”</small>}
                  {' '}<Badge>{t(`core.kitchen.${l.kitchenStatus}`)}</Badge></span>
                <span className="num">{money(l.lineTotalMinor, o.currency, locale)}</span>
              </div>
            ))}
          </div>
          {o.notes && <Notice tone="warn"><UserText>{o.notes}</UserText></Notice>}
          <div className="spread"><span>{t('core.bill.total')}</span><strong className="num">{money(o.totalMinor, o.currency, locale)}</strong></div>
          <div className="spread fine"><span>{t('core.bill.paid')}</span><span className="num">{money(o.paidMinor - o.refundedMinor, o.currency, locale)}</span></div>
          {o.dueMinor > 0 && <div className="spread"><span>{t('core.bill.due')}</span><strong className="num">{money(o.dueMinor, o.currency, locale)}</strong></div>}
          {error && <Notice tone="danger">{error}</Notice>}
          {refund && <Notice tone="warn">{t('core.orders.refundFirst', { amount: money(refund.paidMinor, o.currency, locale) })}</Notice>}
          <div className="row">
            {can('orders:status') && (NEXT[o.fulfillment]?.[o.status] ?? []).map((to) => (
              <button key={to} className="btn btn-primary" disabled={pending} onClick={() => void run(() => call(`/o/${org.id}/orders/${o.id}/transition`, { body: { to, version: o.version } }))}>
                {t(`core.orders.to.${to}`)}
              </button>
            ))}
            {can('payments:collect') && o.dueMinor > 0 && o.status !== 'cancelled' && !o.visitId && (
              <button className="btn btn-leaf" disabled={pending} onClick={() => void run(async () => {
                await call(`/o/${org.id}/orders/${o.id}/collect`, { body: { method: 'cash' }, idempotencyKey: collectKey.current });
                collectKey.current = newIdempotencyKey();
              })}>{t('core.orders.collectCash', { amount: money(o.dueMinor, o.currency, locale) })}</button>
            )}
            {can('orders:cancel') && !['cancelled', 'served', 'picked_up', 'delivered'].includes(o.status) && (
              <button className="btn btn-danger" disabled={pending} onClick={async () => {
                const reason = await prompt({ title: t('core.orders.cancel'), label: t('core.orders.cancelReason'), minLength: 2, maxLength: 300, multiline: true, tone: 'danger', confirmLabel: t('core.orders.cancel') });
                if (reason) void run(() => call(`/o/${org.id}/orders/${o.id}/cancel`, { body: { reason, version: o.version } }));
              }}>{t('core.orders.cancel')}</button>
            )}
          </div>
          {o.visitId && o.dueMinor > 0 && <p className="fine">{t('core.orders.tableBillHint')}</p>}
          <details>
            <summary className="fine" style={{ cursor: 'pointer' }}>{t('core.orders.history')}</summary>
            <ol className="fine">
              {o.events.map((e) => <li key={e.id}>{time(e.at, locale, org.timezone)} · {e.to ? t(`core.status.${e.to}`) : e.type} · {e.actorType}</li>)}
              {o.payments.map((p) => <li key={p.id}>{t(`core.method.${p.method}`)} · {money(p.amountMinor, o.currency, locale)} · {p.status}{p.isTest ? ` · ${t('state.sandbox')}` : ''}</li>)}
            </ol>
          </details>
        </div>
      )}
    </Modal>
  );
}

interface DraftLine { productId: string; quantity: number; modifiers: Record<string, string>; notes: string }

function NewOrderModal({ branchId, onClose, onCreated }: { branchId: string; onClose: () => void; onCreated: (id: string) => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const menu = useApi<MenuEditorView>(`/o/${org.id}/menu`);
  const floor = useApi<FloorLayout>(branchId ? `/o/${org.id}/floor/${branchId}` : null);
  const [fulfillment, setFulfillment] = useState<'dine_in' | 'pickup' | 'delivery'>('dine_in');
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
          deliveryAddress: fulfillment === 'delivery' ? { line1: address } : null,
        },
      });
      onCreated(o.id);
    } catch (e) { setError((e as Error).message); key.current = newIdempotencyKey(); } finally { setPending(false); }
  };

  return (
    <Modal open onClose={onClose} title={t('core.orders.new')} footer={<>
      <button className="btn" onClick={onClose}>{t('action.cancel')}</button>
      <button className="btn btn-primary" disabled={pending || !lines.length || (fulfillment === 'dine_in' && !tableId)} onClick={() => void submit()}>{t('core.orders.create')}</button>
    </>}>
      {!menu.data ? <Skeleton lines={4} /> : (
        <div className="stack">
          <div className="g-seg" role="group" aria-label={t('core.orders.fulfillment')} style={{ display: 'inline-flex', background: 'var(--line-soft)', borderRadius: 99, padding: 3 }}>
            {(['dine_in', 'pickup', 'delivery'] as const).map((f) => (
              <button key={f} type="button" className={`btn btn-sm btn-pill ${fulfillment === f ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFulfillment(f)}>{t(`core.web.${f}`)}</button>
            ))}
          </div>
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
              <div key={i} className="card" style={{ padding: 12 }}>
                <div className="spread"><strong>{p ? pick(locale, p.name, p.nameAr) : ''}</strong>
                  <span className="row">
                    <input className="input" type="number" min={1} max={99} value={l.quantity} style={{ width: 80 }} aria-label={t('core.orders.qty')}
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
          <p className="fine">{t('core.orders.serverPrices')}</p>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      )}
    </Modal>
  );
}
