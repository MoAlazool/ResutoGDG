'use client';
import { useEffect, useRef, useState } from 'react';
import type { OrderSummary } from '@resuto/contracts';
import { Badge, DataTableV2, EmptyState, Field, FilterBar, ListPage, Notice, OrderRef, SelectField, UserText, useCursorPagination, type FilterChip, type PageHeaderProps } from '@resuto/ui';
import { requestPlace } from '@/components/ops/ServiceRequests';
import { useUrlParam } from '@/components/ops/use-url-state';
import { ApiRequestError } from '@/lib/api';
import { formatWhen, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { statusTone } from '../../../../t/[qr]/_guest/menu-ui';
import { listQuery, mainStep, ORDER_STATUSES } from './order-steps';

const CHANNELS = ['qr', 'web', 'whatsapp', 'staff', 'phone', 'pos', 'mcp'];
const FULFILLMENTS = ['dine_in', 'pickup', 'delivery'];

/**
 * The orders list (ListPage, 21-OPS): guest requests, the filter bar (status, channel, fulfilment, date; they live in
 * the URL), the table (rows open the order sheet; keyboard reachable), cursor pagination and a bulk move of the
 * selected orders to their next step, one transition per order with its own version.
 */
export function OrdersList({ header, branchId, onOpen, refreshKey }: { header: PageHeaderProps; branchId: string; onOpen: (id: string) => void; refreshKey: number }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const [status, setStatus] = useUrlParam<string>('status', 'active');
  const [channel, setChannel] = useUrlParam<string>('channel', '');
  const [fulfillment, setFulfillment] = useUrlParam<string>('fulfillment', '');
  const [date, setDate] = useUrlParam<string>('date', '');
  const pager = useCursorPagination([status, channel, fulfillment, date, branchId]);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  const list = useApi<{ items: OrderSummary[]; nextCursor: string | null }>(
    `/o/${org.id}/orders?${listQuery({ branchId, status, channel, fulfillment, date, cursor: pager.cursor })}`, { pollMs: pager.cursor ? undefined : 3000 });
  const requests = useApi<{ items: Array<{ id: string; kind: string; tableLabel: string | null; visitKind?: 'table' | 'counter'; ticket?: string | null; createdAt: string }> }>(
    `/o/${org.id}/requests${branchId ? `?branchId=${branchId}` : ''}`, { pollMs: 3000 });
  const reloadList = list.reload;
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } void reloadList(); }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
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

  const rows = list.data?.items ?? [];
  const movable = (o: OrderSummary) => !!mainStep(o);
  const moveSelected = async (ids: string[], clear: () => void) => {
    if (bulkBusy) return;
    setBulkBusy(true); setBulk(null);
    let ok = 0;
    let failed = 0;
    let lastError = '';
    for (const o of rows.filter((r) => ids.includes(r.id))) {
      const to = mainStep(o);
      if (!to) continue;
      try { await call(`/o/${org.id}/orders/${o.id}/transition`, { body: { to, version: o.version } }); ok++; }
      catch (e) { failed++; lastError = (e as Error).message; }
    }
    setBulkBusy(false);
    clear();
    setBulk(failed ? { tone: 'danger', text: t('ops.board.bulkSome', { ok, failed, error: lastError }) } : { tone: 'ok', text: t('ops.board.bulkDone', { n: ok }) });
    await list.reload();
  };

  const label = (value: string, prefix: string) => t(`${prefix}.${value}`);
  const chips: FilterChip[] = [
    ...(status !== 'active' ? [{ key: 'status', label: status ? label(status, 'core.status') : t('core.orders.all'), onRemove: () => setStatus('active') }] : []),
    ...(channel ? [{ key: 'channel', label: label(channel, 'core.channel'), onRemove: () => setChannel('') }] : []),
    ...(fulfillment ? [{ key: 'fulfillment', label: label(fulfillment, 'core.web'), onRemove: () => setFulfillment('') }] : []),
    ...(date ? [{ key: 'date', label: date, onRemove: () => setDate('') }] : []),
  ];

  return (
    <ListPage header={header}
      filters={<>
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
              : <span className="skeleton requests-skel" aria-hidden />)
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
        <FilterBar chips={chips} onClearAll={chips.length > 1 ? () => { setStatus('active'); setChannel(''); setFulfillment(''); setDate(''); } : undefined}
          filters={<>
            <SelectField label={t('core.orders.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">{t('core.orders.active')}</option>
              <option value="">{t('core.orders.all')}</option>
              {ORDER_STATUSES.map((s) => <option key={s} value={s}>{t(`core.status.${s}`)}</option>)}
            </SelectField>
            <SelectField label={t('core.orders.channel')} value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="">{t('core.orders.all')}</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{t(`core.channel.${c}`)}</option>)}
            </SelectField>
            <SelectField label={t('core.orders.fulfillment')} value={fulfillment} onChange={(e) => setFulfillment(e.target.value)}>
              <option value="">{t('core.orders.all')}</option>
              {FULFILLMENTS.map((f) => <option key={f} value={f}>{t(`core.web.${f}`)}</option>)}
            </SelectField>
            <Field label={t('core.orders.date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </>} />
      </>}>
      {list.error && <Notice tone="danger">{list.error.message}</Notice>}
      {bulk && <Notice tone={bulk.tone}>{bulk.text}</Notice>}
      <DataTableV2 label={t('nav.orders')} rows={rows} rowKey={(o) => o.id} onRowClick={(o) => onOpen(o.id)} busy={list.pending || (list.loading && !list.data)}
        selectable={can('orders:status')} densityToggle columnToggle
        bulkActions={(ids, clear) => {
          const n = rows.filter((r) => ids.includes(r.id) && movable(r)).length;
          return (
            <button type="button" className="btn btn-sm btn-primary" disabled={!n || bulkBusy} aria-busy={bulkBusy || undefined} onClick={() => void moveSelected(ids, clear)}>
              {t('ops.board.advanceSelected')} <span className="num">({n})</span>
            </button>
          );
        }}
        empty={<EmptyState title={t('core.orders.empty')}>{t('core.orders.emptyHint')}</EmptyState>}
        pagination={{ hasNext: !!list.data?.nextCursor, hasPrev: pager.hasPrev, onNext: () => pager.next(list.data?.nextCursor), onPrev: pager.prev }}
        columns={[
          { key: 'n', header: '#', rowHeader: true, render: (o) => <strong><OrderRef n={o.number} /></strong> },
          { key: 'time', header: t('core.orders.placed'), render: (o) => <span className="num">{formatWhen(o.placedAt, locale, org.timezone)}</span>, sort: (a, b) => a.placedAt.localeCompare(b.placedAt) },
          { key: 'where', header: t('core.orders.where'), render: (o) => o.tableLabel ? t('core.kds.table', { label: o.tableLabel })
            // A counter-session order (FT-07: venue QR visit, no table): the order number is the guest's ticket.
            : o.visitId ? t('ops.kds.counter')
              : <>{t(`core.web.${o.fulfillment}`)}{o.customerName ? <> · <UserText>{o.customerName}</UserText></> : null}</> },
          { key: 'channel', header: t('core.orders.channel'), render: (o) => (o.visitId && !o.tableId ? t('ops.counter.channel') : t(`core.channel.${o.channel}`)) },
          { key: 'status', header: t('core.orders.status'), render: (o) => <Badge tone={statusTone(o.status)}>{t(`core.status.${o.status}`)}</Badge> },
          { key: 'pay', header: t('core.orders.payment'), render: (o) => <Badge tone={o.paymentStatus === 'paid' ? 'ok' : o.paymentStatus === 'unpaid' ? 'neutral' : 'pay'}>{t(`core.payment.${o.paymentStatus}`)}</Badge> },
          { key: 'total', header: t('core.bill.total'), align: 'end', render: (o) => <span className="num">{money(o.totalMinor, o.currency, locale)}</span>, sort: (a, b) => a.totalMinor - b.totalMinor },
        ]} />
    </ListPage>
  );
}
