'use client';
import { useEffect, useMemo, useState } from 'react';
import type { IntegrationConnectionView } from '@resuto/contracts';
import { Badge, Card, DataTable, EmptyState, ListPage, Notice, SelectField, Skeleton, Tabs, useAction, OrderRef } from '@resuto/ui';
import '@/components/ops/ops.css';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { ApiRequestError } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { marketCards } from '@/lib/integrations-marketplace';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { Marketplace, ProviderSheet, StatusChip } from './marketplace';
import { ACCOUNT_KEY, AccountPicker, pickerKey, statusTone, type CatalogItem, type ConnectionView } from './parts';
import s from './integrations.module.css';

interface ImportRow { externalId?: string; name: string; nameAr?: string; category: string; description?: string; priceMinor: number; station?: string; allergens?: string[]; available?: boolean; action?: 'create' | 'update' }
interface SyncResult { run: { id: string; status: string; stats: any; error: string | null }; rows: ImportRow[]; warnings: string[]; importSource: 'foodics' | 'odoo' | 'csv' | null; retryable: boolean }

/**
 * Integrations (21-INT, plan §6.3): the marketplace of provider cards with honest chips, the tenant's connections, the
 * POS menu import and the integration logs. Every provider opens the same sheet (connect, capabilities, permissions,
 * requirements, health, logs, disconnect).
 */
export default function IntegrationsPage() {
  const { t } = useT();
  const { org } = useOrg();
  const [tab, setTab] = useState<'catalog' | 'connections' | 'pos' | 'logs'>('catalog');
  const catalog = useApi<{ items: CatalogItem[] }>(`/o/${org.id}/integrations/catalog`);
  const list = useApi<{ items: ConnectionView[] }>(`/o/${org.id}/integrations/connections`);
  // Back from a provider's consent screen (PS-11 completion page): show the connections.
  useEffect(() => { if (new URLSearchParams(window.location.search).has('connected')) setTab('connections'); }, []);
  const reload = async () => { await Promise.all([catalog.reload(), list.reload()]); };
  return (
    <ModuleGate module="core" permission="integrations:manage">
      <ListPage header={{ title: t('nav.integrations'), subtitle: t('connect.int.subtitle') }}
        filters={<Tabs value={tab} onChange={setTab} tabs={[
          { key: 'catalog', label: t('mkt.tab') }, { key: 'connections', label: t('connect.int.connections') },
          { key: 'pos', label: t('connect.int.posImport') }, { key: 'logs', label: t('connect.int.logs') },
        ]} />}>
      {(catalog.error || list.error) && <Notice tone="danger">{(catalog.error ?? list.error)!.message}</Notice>}
      {tab === 'catalog' && (catalog.data && list.data
        ? <Marketplace items={catalog.data.items} connections={list.data.items} onChanged={reload} />
        : !catalog.error && <Skeleton lines={6} />)}
      {tab === 'connections' && (catalog.data && list.data ? <Connections items={catalog.data.items} connections={list.data.items} onChanged={reload} /> : <Skeleton />)}
      {tab === 'pos' && <PosImport />}
      {tab === 'logs' && <Logs />}
      </ListPage>
    </ModuleGate>
  );
}

function Connections({ items, connections, onChanged }: { items: CatalogItem[]; connections: ConnectionView[]; onChanged: () => Promise<void> }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [open, setOpen] = useState<ConnectionView | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const cards = useMemo(() => marketCards(items, org.id, (id) => t(`mkt.link.${id}`)), [items, org.id, t]);
  // Back from OAuth with several granted accounts: open the account picker (INT-11).
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('choose'); if (id && /^[0-9a-f-]{36}$/i.test(id)) setPicking(id); }, []);
  const remove = useAction(async (c: ConnectionView) => { await session.call(`/o/${org.id}/integrations/connections/${c.id}`, { method: 'DELETE' }); await onChanged(); });
  const setSot = useAction(async (c: ConnectionView, menu: string) => {
    await session.call(`/o/${org.id}/integrations/connections/${c.id}`, { method: 'PATCH', body: { sourceOfTruth: { menu } } });
    await onChanged();
  });
  const specOf = (c: ConnectionView) => items.find((i) => i.id === c.provider) ?? null;
  const cardOf = (c: ConnectionView) => cards.find((x) => x.id === c.provider) ?? null;
  const needsAccount = (c: ConnectionView) => !!ACCOUNT_KEY[c.provider] && c.status !== 'revoked' && c.authType === 'oauth' && !c.config?.[ACCOUNT_KEY[c.provider]!];
  const pickingConn = picking ? connections.find((c) => c.id === picking) : undefined;
  return (
    <div className="stack">
      {(remove.error || setSot.error) && <Notice tone="danger">{remove.error ?? setSot.error}</Notice>}
      <DataTable rows={connections} rowKey={(c) => c.id} empty={<EmptyState title={t('connect.int.noConnections')}>{t('connect.int.noConnectionsBody')}</EmptyState>} columns={[
        { key: 'p', header: t('connect.int.provider'), render: (c) => <><strong><bdi>{specOf(c)?.name ?? c.provider}</bdi></strong> <div className="row gap-4">
          {specOf(c)?.marketplace?.connectionId === c.id && <StatusChip status={specOf(c)!.marketplace!.status} />}
          <Badge tone={c.environment === 'live' ? 'info' : 'sandbox'}>{c.environment === 'live' ? t('intg.env.liveBadge') : t('intg.env.testBadge')}</Badge></div></> },
        { key: 's', header: t('connect.channels.status'), render: (c) => <div className={s.tight}><Badge tone={statusTone(c.status)}>{t(`connect.int.status.${c.status}`)}</Badge>
          {!c.enabled && <Badge>{t('connect.int.disabled')}</Badge>}{c.lastError && <span className={`fine ${s.danger}`} dir="ltr">{c.lastError}</span>}</div> },
        { key: 'h', header: t('connect.int.health'), render: (c) => <span className="fine">{c.lastHealthCheckAt ? dateTime(c.lastHealthCheckAt, locale) : t('connect.int.neverChecked')}</span> },
        { key: 'cred', header: t('connect.int.credentials'), render: (c) => <code className="fine" dir="ltr">{c.credentialsHint ?? '—'}</code> },
        { key: 'sot', header: t('connect.int.sourceOfTruth'), render: (c) => c.category === 'pos' ? (
          <select className={`select ${s.select}`} value={c.sourceOfTruth.menu} onChange={(e) => setSot.run(c, e.target.value)} aria-label={t('connect.int.sourceOfTruth')}>
            <option value="resuto">{t('connect.int.sot.resuto')}</option><option value="provider">{t('connect.int.sot.provider')}</option></select>) : <span className="fine">{t('connect.int.sot.ordersResuto')}</span> },
        { key: 'a', header: '', align: 'end', render: (c) => (
          <div className="row gap-4 justify-end wrap">
            {needsAccount(c) && <button className="btn btn-sm btn-primary" onClick={() => setPicking(c.id)}>{t(pickerKey(c.provider, 'choose'))}</button>}
            {['revoked', 'not_configured', 'sandbox'].includes(c.status) && <button className="btn btn-sm btn-ghost btn-danger" disabled={remove.pending} onClick={() => remove.run(c)}>{t('action.delete')}</button>}
            {cardOf(c) && <button className="btn btn-sm btn-ghost" onClick={() => setOpen(c)}>{t('connect.int.details')}</button>}
          </div>) },
      ]} />
      <p className="fine">{t('connect.int.sot.rules')}</p>
      {open && cardOf(open) && <ProviderSheet card={cardOf(open)!} item={specOf(open)} connection={connections.find((c) => c.id === open.id) ?? open}
        onClose={() => setOpen(null)} onChanged={onChanged} />}
      {pickingConn && <AccountPicker connection={pickingConn} onClose={() => setPicking(null)} onSaved={async () => { setPicking(null); await onChanged(); }} />}
    </div>
  );
}

/**
 * POS menu import: fetch rows through the adapter (preview), then hand them to the
 * Menu module's import endpoints (Agent B1: POST /menu/import/preview|commit).
 * This page never writes menu data itself.
 */
function PosImport() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const conns = useApi<{ items: IntegrationConnectionView[] }>(`/o/${org.id}/integrations/connections?category=pos`);
  const conflicts = useApi<{ items: any[] }>(`/o/${org.id}/integrations/conflicts?status=pending`);
  const [connectionId, setConnectionId] = useState('');
  const [result, setResult] = useState<SyncResult | null>(null);
  const [extraRows, setExtraRows] = useState<ImportRow[]>([]);
  const [importPreview, setImportPreview] = useState<unknown>(null);
  const [importDone, setImportDone] = useState<string | null>(null);
  const pos = (conns.data?.items ?? []).filter((c) => c.status !== 'revoked');
  const selected = pos.find((c) => c.id === (connectionId || pos[0]?.id));
  const sync = useAction(async () => {
    setImportPreview(null); setImportDone(null);
    setResult(await session.call<SyncResult>(`/o/${org.id}/integrations/connections/${selected!.id}/sync`, { body: { resource: 'menu', cursor: null } }));
    await conflicts.reload();
  });
  const resolve = useAction(async (k: any, resolution: string) => {
    const r = await session.call<{ importRow: ImportRow | null }>(`/o/${org.id}/integrations/conflicts/${k.id}/resolve`, { body: { resolution } });
    if (r.importRow) setExtraRows((rows) => [...rows, r.importRow!]);
    await conflicts.reload();
  });
  const rows = [...(result?.rows ?? []), ...extraRows];
  const payload = () => ({ rows: rows.map(({ action: _a, ...r }) => r), source: result?.importSource ?? (selected?.provider === 'odoo' ? 'odoo' : 'foodics') });
  const sendToMenu = useAction(async (step: 'preview' | 'commit') => {
    try {
      const r = await session.call(`/o/${org.id}/menu/import/${step}`, { body: payload() });
      if (step === 'preview') setImportPreview(r); else { setImportDone(t('connect.int.pos.committed', { n: rows.length })); setResult(null); setExtraRows([]); }
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 404 || e.status === 503)) throw new Error(t('connect.int.pos.menuImportUnavailable'));
      throw e;
    }
  });
  if (!conns.data) return <Skeleton />;
  if (!pos.length) return <div className="card"><EmptyState title={t('connect.int.pos.none')}>{t('connect.int.pos.noneBody')}</EmptyState></div>;
  return (
    <div className="stack">
      <Card title={t('connect.int.pos.fetch')}>
        <div className="row">
          <SelectField label={t('connect.int.provider')} value={selected?.id ?? ''} onChange={(e) => setConnectionId(e.target.value)}>
            {pos.map((c) => <option key={c.id} value={c.id}>{c.provider} · {t(`connect.int.status.${c.status}`)}</option>)}</SelectField>
          <button className="btn btn-primary" disabled={sync.pending || !can('integrations:manage')} onClick={() => sync.run()}>{sync.pending ? t('state.loading') : t('connect.int.pos.fetchCta')}</button>
        </div>
        <p className="fine">{selected?.sourceOfTruth.menu === 'provider' ? t('connect.int.pos.providerOwns') : t('connect.int.pos.resutoOwns')}</p>
        {sync.error && <Notice tone="danger">{sync.error}</Notice>}
        {result && <div className="stack gap-6">
          <div className="row gap-6">
            <Badge tone={result.run.status === 'succeeded' ? 'ok' : result.run.status === 'failed' ? 'danger' : 'warn'}>{result.run.status}</Badge>
            {result.run.stats?.sandbox && <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>}
            <span className="fine">{t('connect.int.pos.stats', { fetched: result.run.stats?.fetched ?? 0, rows: result.rows.length, unchanged: result.run.stats?.unchanged ?? 0, conflicts: result.run.stats?.conflicts ?? 0 })}</span>
          </div>
          {result.run.error && <Notice tone="danger">{result.run.error}{result.retryable ? ` — ${t('connect.int.pos.retryable')}` : ''}</Notice>}
          {result.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
        </div>}
      </Card>
      {(conflicts.data?.items.length ?? 0) > 0 && (
        <Card title={t('connect.int.conflicts')}>
          <p className="fine">{t('connect.int.conflictsHelp')}</p>
          <DataTable rows={conflicts.data!.items} rowKey={(k) => k.id} columns={[
            { key: 'id', header: t('connect.int.pos.externalId'), render: (k) => <code dir="ltr">{k.externalId}</code> },
            { key: 'l', header: t('connect.int.pos.resutoValue'), render: (k) => <>{k.local?.name} · {money(k.local?.priceMinor, org.currency, locale)}</> },
            { key: 'e', header: t('connect.int.pos.providerValue'), render: (k) => <>{k.external?.name} · {money(k.external?.priceMinor, org.currency, locale)}</> },
            { key: 'a', header: '', align: 'end', render: (k) => <div className="row gap-4 justify-end">
              <button className="btn btn-sm" disabled={resolve.pending} onClick={() => resolve.run(k, 'kept_local')}>{t('connect.int.keepResuto')}</button>
              <button className="btn btn-sm btn-leaf" disabled={resolve.pending} onClick={() => resolve.run(k, 'kept_external')}>{t('connect.int.keepProvider')}</button>
              <button className="btn btn-sm btn-ghost" disabled={resolve.pending} onClick={() => resolve.run(k, 'ignored')}>{t('connect.int.ignore')}</button></div> },
          ]} />
          {resolve.error && <Notice tone="danger">{resolve.error}</Notice>}
        </Card>
      )}
      {rows.length > 0 && (
        <Card title={t('connect.int.pos.preview', { n: rows.length })}>
          <DataTable rows={rows} rowKey={(r) => `${r.externalId}-${r.name}`} columns={[
            { key: 'n', header: t('connect.int.pos.name'), render: (r) => <><strong>{r.name}</strong>{r.nameAr && <div className="fine" dir="rtl">{r.nameAr}</div>}</> },
            { key: 'c', header: t('connect.int.pos.category'), render: (r) => r.category },
            { key: 'p', header: t('connect.int.pos.price'), align: 'end', render: (r) => <span className="num">{money(r.priceMinor, org.currency, locale)}</span> },
            { key: 'a', header: '', render: (r) => <Badge tone={r.action === 'update' ? 'warn' : 'info'}>{t(`connect.int.pos.action_${r.action ?? 'create'}`)}</Badge> },
          ]} />
          <p className="fine">{t('connect.int.pos.unavailableNote')}</p>
          <div className="row">
            <button className="btn" disabled={sendToMenu.pending || !can('menu:write')} onClick={() => sendToMenu.run('preview')}>{t('connect.int.pos.sendPreview')}</button>
            <button className="btn btn-primary" disabled={sendToMenu.pending || !importPreview || !can('menu:write')} onClick={() => sendToMenu.run('commit')}>{t('connect.int.pos.commit')}</button>
          </div>
          {importPreview != null && <pre className={`fine ${s.pre}`} dir="ltr">{JSON.stringify(importPreview, null, 2)}</pre>}
          {sendToMenu.error && <Notice tone="danger">{sendToMenu.error}</Notice>}
        </Card>
      )}
      {importDone && <Notice tone="ok">{importDone}</Notice>}
    </div>
  );
}

function Logs() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const logs = useApi<{ items: Array<{ id: number; provider: string | null; level: string; message: string; createdAt: string }> }>(`/o/${org.id}/integrations/logs?limit=100`, { pollMs: 15000 });
  if (!logs.data) return logs.error ? <Notice tone="danger">{logs.error.message}</Notice> : <Skeleton />;
  return (
    <DataTable rows={logs.data.items} rowKey={(l) => String(l.id)} empty={<EmptyState title={t('state.empty')} />} columns={[
      { key: 't', header: t('connect.int.time'), render: (l) => <span className="fine">{dateTime(l.createdAt, locale)}</span> },
      { key: 'p', header: t('connect.int.provider'), render: (l) => l.provider ?? '—' },
      { key: 'l', header: t('connect.int.level'), render: (l) => <Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warn' : 'neutral'}>{l.level}</Badge> },
      { key: 'm', header: t('connect.int.message'), render: (l) => l.message },
    ]} />
  );
}
