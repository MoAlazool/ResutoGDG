'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useRef, useState } from 'react';
import type { LoyaltyReward, MenuEditorView, OrderDetail, OrderSummary, FloorLayout } from '@resuto/contracts';
import { Badge, DataTable, EmptyState, Modal, Notice, PageHeader, Phone, SelectField, Skeleton, Field, UserText, usePrompt, OrderRef } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { Tabs } from '@resuto/ui';
import '@/components/ops/ops.css';
import { defaultOrdersView, readOrdersView, rememberOrdersView } from '@/components/ops/orders-view';
import { useUrlParam } from '@/components/ops/use-url-state';
import { requestPlace } from '@/components/ops/ServiceRequests';
import { KitchenBoard } from '../../../kitchen/[orgId]/_kds/KitchenBoard';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { dateTime, formatWhen, money, num, pick, time } from '@/lib/format';
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

type View = 'list' | 'board';
const VIEWS: readonly View[] = ['board', 'list'];

export default function OrdersPage() {
  return <ModuleGate module="core" permission="orders:read"><Suspense fallback={<Skeleton lines={6} />}><Orders /></Suspense></ModuleGate>;
}

/**
 * Orders (legacy manager "Order board" + the filterable list). The board is the kitchen's five lanes with drag and
 * drop and service requests (VS-14); the list keeps filters. It opens on the board like legacy (PAR-04). View, branch and
 * filters live in the URL, so a reload or a shared link keeps them (PCL-20); the branch defaults to the one chosen in the
 * shell.
 */
function Orders() {
  const { t, locale } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const canBoard = can('kitchen:operate');
  // The board first, like legacy Orders; the user's last choice is remembered and ?view= still wins (PAR-04).
  const [storedView] = useState(() => readOrdersView());
  const [view, setViewParam] = useUrlParam<View>('view', defaultOrdersView(storedView, canBoard), canBoard ? VIEWS : ['list']);
  const setView = (v: View) => { rememberOrdersView(v); setViewParam(v); };
  const [branchParam, setBranchId] = useUrlParam<string>('branch', '');
  const branchId = org.branches.some((b) => b.id === branchParam) ? branchParam : (shellBranch ?? org.branches[0]?.id ?? '');
  const [status, setStatus] = useUrlParam<string>('status', 'active');
  const [channel, setChannel] = useUrlParam<string>('channel', '');
  const [fulfillment, setFulfillment] = useUrlParam<string>('fulfillment', '');
  const [date, setDate] = useUrlParam<string>('date', '');
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(null);
  // FT-03: the customer card opens a new order for that customer (`?newFor=<customerId>`), so staff can redeem points.
  const params = useSearchParams();
  const newFor = params.get('newFor');
  const [creating, setCreating] = useState(!!newFor && can('orders:write'));

  const qs = new URLSearchParams({
    limit: '50', ...(branchId ? { branchId } : {}),
    ...(status === 'active' ? { status: 'awaiting_payment,placed,accepted,preparing,ready' } : status ? { status } : {}),
    ...(channel ? { channel } : {}), ...(fulfillment ? { fulfillment } : {}), ...(date ? { date } : {}), ...(cursor ? { cursor } : {}),
  });
  const list = useApi<{ items: OrderSummary[]; nextCursor: string | null }>(view === 'list' ? `/o/${org.id}/orders?${qs}` : null, { pollMs: cursor ? undefined : 3000 });
  const requests = useApi<{ items: Array<{ id: string; kind: string; tableLabel: string | null; visitKind?: 'table' | 'counter'; ticket?: string | null; createdAt: string }> }>(
    view === 'list' ? `/o/${org.id}/requests${branchId ? `?branchId=${branchId}` : ''}` : null, { pollMs: 3000 });
  const { call } = useSession();
  // Keep the last failure on screen while a poll retries (useApi clears `error` during the request), so the strip
  // does not flicker between the failure text and the skeleton.
  const requestsErr = useRef<ApiRequestError | null>(null);
  if (requests.data !== undefined) requestsErr.current = null;
  else if (requests.error) requestsErr.current = requests.error;
  const reqError = requestsErr.current;

  /** One resolve at a time; a failure stays visible instead of becoming an unhandled rejection (PCL-21). */
  const resolve = async (id: string) => {
    if (resolving) return;
    setResolving(id); setResolveError(null);
    try { await call(`/o/${org.id}/requests/${id}/resolve`, { body: { status: 'resolved' } }); await requests.reload(); }
    catch (e) { setResolveError((e as Error).message); }
    finally { setResolving(null); }
  };

  return (
    <>
      <PageHeader title={t('nav.orders')} subtitle={t('core.orders.subtitle')}
        actions={can('orders:write') && <button className="btn btn-primary" onClick={() => setCreating(true)}>+ {t('core.orders.new')}</button>} />
      {canBoard && (
        <div className="orders-views">
          <Tabs<View> value={view} onChange={setView} label={t('nav.orders')} tabs={[{ key: 'board', label: t('ops.orders.board') }, { key: 'list', label: t('ops.orders.list') }]} />
          {org.branches.length > 1 && view === 'board' && (
            <SelectField label={t('core.web.branch')} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {org.branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
            </SelectField>
          )}
        </div>
      )}
      {view === 'board' ? (
        <KitchenBoard key={branchId} orgId={org.id} branchId={branchId} station={null} timezone={org.timezone} currency={org.currency}
          canCancel={can('orders:cancel')} canResolve={can('floor:seat') || can('orders:status')} can86={can('menu:availability')}
          onOpen={(id) => setSelected(id)} />
      ) : <>
      {/* Guest requests keep a fixed slot (VS-07): the strip is always there, so its arrival does not push the filters
          and the table down after the page has rendered. */}
      <section className="card card-warm requests-strip" aria-label={t('core.orders.requests')} aria-busy={(requests.data === undefined && !reqError) || undefined}>
        <h2>{t('core.orders.requests')}</h2>
        <div className="row">
          {requests.data === undefined ? (reqError
            ? <span className="fine requests-error" role="status" data-kind={reqError.kind}>
                {reqError.kind === 'forbidden' ? t('core.orders.requestsForbidden') : <>{t('core.orders.requestsFailed')}{' '}
                  <button type="button" className="btn btn-sm" onClick={() => void requests.reload()}>{t('action.retry')}</button></>}
              </span>
            : <span className="skeleton" style={{ display: 'block', width: 220, height: 30 }} aria-hidden />)
            : requests.data.items.length === 0 ? <span className="fine">{t('core.orders.noRequests')}</span>
              : requests.data.items.map((r) => (
                <span key={r.id} className="badge badge-warn request-chip">
                  {requestPlace(r, t)} · {t(`core.request.${r.kind}`)} · <span className="num">{formatWhen(r.createdAt, locale, org.timezone)}</span>
                  <button className="btn btn-sm" aria-label={t('core.orders.resolveRequest')} disabled={resolving !== null} aria-busy={resolving === r.id || undefined} onClick={() => void resolve(r.id)}>✓</button>
                </span>
              ))}
        </div>
        {resolveError && <Notice tone="danger">{resolveError}</Notice>}
      </section>
      <div className="form-row" data-align="end">
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
            { key: 'n', header: '#', render: (o) => <strong><OrderRef n={o.number} /></strong> },
            { key: 'time', header: t('core.orders.placed'), render: (o) => <span className="num">{formatWhen(o.placedAt, locale, org.timezone)}</span> },
            { key: 'where', header: t('core.orders.where'), render: (o) => o.tableLabel ? t('core.kds.table', { label: o.tableLabel })
              // A counter-session order (FT-07: venue QR visit, no table): the order number is the guest's ticket.
              : o.visitId ? t('ops.kds.counter')
                : <>{t(`core.web.${o.fulfillment}`)}{o.customerName ? <> · <UserText>{o.customerName}</UserText></> : null}</> },
            { key: 'channel', header: t('core.orders.channel'), render: (o) => (o.visitId && !o.tableId ? t('ops.counter.channel') : t(`core.channel.${o.channel}`)) },
            { key: 'status', header: t('core.orders.status'), render: (o) => <Badge tone={statusTone(o.status)}>{t(`core.status.${o.status}`)}</Badge> },
            { key: 'pay', header: t('core.orders.payment'), render: (o) => <Badge tone={o.paymentStatus === 'paid' ? 'ok' : o.paymentStatus === 'unpaid' ? 'neutral' : 'pay'}>{t(`core.payment.${o.paymentStatus}`)}</Badge> },
            { key: 'total', header: t('core.bill.total'), align: 'end', render: (o) => <span className="num">{money(o.totalMinor, o.currency, locale)}</span> },
          ]} />
      )}
      <div className="row" style={{ marginTop: 12 }}>
        {cursor && <button className="btn btn-sm" onClick={() => setCursor(undefined)}>{t('core.orders.latest')}</button>}
        {list.data?.nextCursor && <button className="btn btn-sm" onClick={() => setCursor(list.data!.nextCursor!)}>{t('core.orders.older')}</button>}
      </div>
      </>}
      {selected && <OrderDrawer orderId={selected} onClose={() => setSelected(null)} onChanged={() => void list.reload()} />}
      {creating && <NewOrderModal branchId={branchId} customerId={newFor} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setSelected(id); void list.reload(); }} />}
    </>
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
          {(o.customerName || o.customerPhone) && <p className="flush"><UserText>{o.customerName}</UserText>{o.customerName && o.customerPhone ? ' · ' : ''}<Phone value={o.customerPhone} link />{o.tableLabel ? ` · ${t('core.kds.table', { label: o.tableLabel })}` : ''}</p>}
          {o.deliveryAddress != null && <p className="fine flush"><UserText>{String((o.deliveryAddress as { line1?: string }).line1 ?? '')}</UserText></p>}
          <div>
            {o.lines.map((l) => (
              <div key={l.id} className="spread ops-line">
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
            {/* A counter ticket (FT-07) is paid as a whole: cash for every unpaid order of this guest's counter visit. */}
            {can('payments:collect') && o.dueMinor > 0 && o.status !== 'cancelled' && o.visitId && !o.tableId && (
              <button className="btn btn-leaf" disabled={pending} onClick={() => void run(async () => {
                await call(`/o/${org.id}/visits/${o.visitId}/collect`, { body: { method: 'cash' }, idempotencyKey: collectKey.current });
                collectKey.current = newIdempotencyKey();
              })}>{t('ops.counter.collectTicket')}</button>
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

interface Redeemable { customerId: string; displayName: string | null; active: boolean; balance: number; rewards: Array<LoyaltyReward & { affordable: boolean }> }

function NewOrderModal({ branchId, customerId, onClose, onCreated }: { branchId: string; customerId?: string | null; onClose: () => void; onCreated: (id: string) => void }) {
  const { t, locale } = useT();
  const { org, hasModule } = useOrg();
  const { call } = useSession();
  // FT-03: an order for a known customer may redeem a reward; staff identify the guest, the server checks the points.
  const loyalty = useApi<Redeemable>(customerId && hasModule('marketing') ? `/o/${org.id}/loyalty/customers/${customerId}/rewards` : null);
  const [rewardId, setRewardId] = useState('');
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
          customerId: customerId || null, loyaltyRewardId: customerId && rewardId ? rewardId : null,
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
          {customerId && loyalty.data && <p style={{ margin: 0 }}><strong>{t('loyalty.staff.for', { name: loyalty.data.displayName ?? '—' })}</strong></p>}
          <div className="g-seg ops-seg" role="group" aria-label={t('core.orders.fulfillment')}>
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
              <div key={i} className="card ops-draft-line">
                <div className="spread"><strong>{p ? pick(locale, p.name, p.nameAr) : ''}</strong>
                  <span className="row">
                    <input type="number" min={1} max={99} value={l.quantity} className="input ops-qty" aria-label={t('core.orders.qty')}
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
              <p className="fine" style={{ marginBlockStart: 4 }}>{t('loyalty.staff.balance', { points: num(loyalty.data.balance, locale) })}</p>
            </div>
          )}
          <p className="fine">{t('core.orders.serverPrices')}</p>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      )}
    </Modal>
  );
}
