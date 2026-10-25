'use client';
import { useSearchParams } from 'next/navigation';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Skeleton, Tabs } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { TicketBoard } from '@/components/ops/TicketBoard';
import { defaultOrdersView, readOrdersView, rememberOrdersView } from '@/components/ops/orders-view';
import { useUrlParam } from '@/components/ops/use-url-state';
import { useT } from '@/lib/i18n/client';
import { useBranchParam, useOrg } from '@/lib/org-context';
import './orders.css';

// The list (filters, table, bulk moves), the order sheet and the new-order form load on demand: the board is what
// opens, and the route stays inside the staff bundle budget.
const OrdersList = lazy(() => import('./_parts/OrdersList').then((m) => ({ default: m.OrdersList })));
const OrderSheet = lazy(() => import('./_parts/OrderSheet').then((m) => ({ default: m.OrderSheet })));
const NewOrderSheet = lazy(() => import('./_parts/NewOrderSheet').then((m) => ({ default: m.NewOrderSheet })));

type View = 'list' | 'board';
const VIEWS: readonly View[] = ['board', 'list'];

export default function OrdersPage() {
  return <ModuleGate module="core" permission="orders:read"><Suspense fallback={<Skeleton lines={6} />}><Orders /></Suspense></ModuleGate>;
}

/**
 * Orders (21-OPS): the board (the kitchen's five lanes with their counts, drag and drop, keys: j/k between cards,
 * Enter opens the order, a moves it to its next step, x selects cards for a bulk move) and the filterable list with
 * bulk moves. An order opens in a sheet at the reading end. It opens on the board like legacy (PAR-04); view and
 * filters live in the URL, so a reload or a shared link keeps them (PCL-20). The branch is the shell's (21-SHELL).
 */
function Orders() {
  const { t } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const canBoard = can('kitchen:operate');
  // The board first, like legacy Orders; the user's last choice is remembered and ?view= still wins (PAR-04).
  const [storedView] = useState(() => readOrdersView());
  const [view, setViewParam] = useUrlParam<View>('view', defaultOrdersView(storedView, canBoard), canBoard ? VIEWS : ['list']);
  const setView = (v: View) => { rememberOrdersView(v); setViewParam(v); };
  // The branch is the shell's branch switcher (21-SHELL single branch context); a ?branch= link selects it there.
  const branchId = useBranchParam(shellBranch ?? org.branches[0]?.id ?? '');
  // FT-03: the customer card opens a new order for that customer (`?newFor=<customerId>`), so staff can redeem points.
  // The command palette opens a new order (`?new=1`) or one order (`?order=<id>`, a record search result).
  const params = useSearchParams();
  const newFor = params.get('newFor');
  const [selected, setSelected] = useState<string | null>(() => params.get('order'));
  const [creating, setCreating] = useState((!!newFor || params.get('new') === '1') && can('orders:write'));
  const [changed, setChanged] = useState(0);
  const orderParam = params.get('order');
  const newParam = params.get('new');
  useEffect(() => { if (orderParam) setSelected(orderParam); }, [orderParam]);
  useEffect(() => { if (newParam === '1' && can('orders:write')) setCreating(true); }, [newParam]); // eslint-disable-line react-hooks/exhaustive-deps

  const header = {
    title: t('nav.orders'), subtitle: t('core.orders.subtitle'),
    actions: <>
      {canBoard && (
        <Tabs<View> label={t('ops.orders.view')} value={view} onChange={setView}
          tabs={[{ key: 'board', label: t('ops.orders.board') }, { key: 'list', label: t('ops.orders.list') }]} />
      )}
      {can('orders:write') && <button className="btn btn-primary" onClick={() => setCreating(true)}>+ {t('core.orders.new')}</button>}
    </>,
  };

  return (
    <div className="orders-page">
      {view === 'board' ? (
        <TicketBoard key={branchId} mode="orders" header={header} orgId={org.id} branchId={branchId} station={null} timezone={org.timezone} currency={org.currency}
          canCancel={can('orders:cancel')} canResolve={can('floor:seat') || can('orders:status')} can86={can('menu:availability')}
          onOpen={(id) => setSelected(id)} refreshKey={changed} />
      ) : (
        <Suspense fallback={<Skeleton lines={8} />}>
          <OrdersList header={header} branchId={branchId} onOpen={setSelected} refreshKey={changed} />
        </Suspense>
      )}
      {selected && (
        <Suspense fallback={null}>
          <OrderSheet orderId={selected} onClose={() => setSelected(null)} onChanged={() => setChanged((n) => n + 1)} />
        </Suspense>
      )}
      {creating && (
        <Suspense fallback={null}>
          <NewOrderSheet branchId={branchId} customerId={newFor} onClose={() => setCreating(false)}
            onCreated={(id) => { setCreating(false); setSelected(id); setChanged((n) => n + 1); }} />
        </Suspense>
      )}
    </div>
  );
}
