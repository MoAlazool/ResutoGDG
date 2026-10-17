'use client';
import { useState, type FormEvent } from 'react';
import type { IntegrationConnectionView, ProviderCatalogEntry } from '@resuto/contracts';
import { Badge, Card, DataTable, EmptyState, Field, Modal, Notice, PageHeader, SelectField, Skeleton, Tabs, useAction, type Tone } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { ApiRequestError } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface FieldSpec { key: string; label: string; secret: boolean; required: boolean; hint?: string }
type CatalogItem = ProviderCatalogEntry & { fields: { credentials: FieldSpec[]; config: FieldSpec[] }; oauthConfigured: boolean | null };
interface ImportRow { externalId?: string; name: string; nameAr?: string; category: string; description?: string; priceMinor: number; station?: string; allergens?: string[]; available?: boolean; action?: 'create' | 'update' }
interface SyncResult { run: { id: string; status: string; stats: any; error: string | null }; rows: ImportRow[]; warnings: string[]; importSource: 'foodics' | 'odoo' | 'csv' | null; retryable: boolean }

const readinessTone = (r: string): Tone => (r === 'simulated' ? 'sandbox' : r === 'implemented_unverified' ? 'warn' : r === 'sandbox_verified' ? 'info' : 'ok');
const statusTone = (s: string): Tone => (({ connected: 'ok', sandbox: 'sandbox', pending: 'warn', error: 'danger', revoked: 'neutral', not_configured: 'neutral' } as Record<string, Tone>)[s] ?? 'neutral');

export default function IntegrationsPage() {
  const { t } = useT();
  const [tab, setTab] = useState<'catalog' | 'connections' | 'pos' | 'logs'>('catalog');
  return (
    <ModuleGate module="core" permission="integrations:manage">
      <PageHeader title={t('nav.integrations')} subtitle={t('connect.int.subtitle')} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { key: 'catalog', label: t('connect.int.catalog') }, { key: 'connections', label: t('connect.int.connections') },
        { key: 'pos', label: t('connect.int.posImport') }, { key: 'logs', label: t('connect.int.logs') },
      ]} />
      {tab === 'catalog' && <Catalog onConnected={() => setTab('connections')} />}
      {tab === 'connections' && <Connections />}
      {tab === 'pos' && <PosImport />}
      {tab === 'logs' && <Logs />}
    </ModuleGate>
  );
}

function ReadinessBadge({ readiness }: { readiness: string }) {
  const { t } = useT();
  return <Badge tone={readinessTone(readiness)}>{t(`connect.readiness.${readiness}`)}</Badge>;
}

function Catalog({ onConnected }: { onConnected: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const catalog = useApi<{ items: CatalogItem[] }>(`/o/${org.id}/integrations/catalog`);
  const [connecting, setConnecting] = useState<CatalogItem | null>(null);
  if (!catalog.data) return catalog.error ? <Notice tone="danger">{catalog.error.message}</Notice> : <Skeleton lines={6} />;
  const groups = [...new Set(catalog.data.items.map((p) => p.category))];
  return (
    <div className="stack">
      <Notice>{t('connect.int.readinessHelp')}</Notice>
      {groups.map((g) => (
        <section key={g}>
          <h2>{t(`connect.int.category.${g}`)}</h2>
          <div className="grid grid-3">
            {catalog.data!.items.filter((p) => p.category === g).map((p) => (
              <article key={p.id} className="card stack" style={{ gap: 8 }}>
                <div className="spread"><strong>{p.name}</strong><ReadinessBadge readiness={p.readiness} /></div>
                <span className="fine">{p.countries.join(' · ')} · {p.capabilities.slice(0, 4).join(', ')}</span>
                <details><summary className="fine">{t('connect.int.activation')}</summary>
                  <ol className="fine" style={{ paddingInlineStart: 18 }}>{p.activation.map((s, i) => <li key={i}>{s}</li>)}</ol>
                  {p.docsUrl && <a className="fine" href={p.docsUrl} target="_blank" rel="noreferrer">{t('connect.int.docs')}</a>}
                </details>
                <button className="btn btn-sm" onClick={() => setConnecting(p)}>{p.sandboxOnly ? t('connect.int.enableSandbox') : t('connect.int.connect')}</button>
              </article>
            ))}
          </div>
        </section>
      ))}
      {connecting && <ConnectModal provider={connecting} onClose={() => setConnecting(null)} onDone={() => { setConnecting(null); onConnected(); }} />}
    </div>
  );
}

function ConnectModal({ provider, onClose, onDone }: { provider: CatalogItem; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>('live');
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const pickVals = (fs: FieldSpec[]) => Object.fromEntries(fs.map((f) => [f.key, values[f.key]?.trim()]).filter(([, v]) => v));
    await session.call(`/o/${org.id}/integrations/connections`, { body: {
      provider: provider.id, environment, credentials: provider.sandboxOnly ? {} : pickVals(provider.fields.credentials), config: provider.sandboxOnly ? {} : pickVals(provider.fields.config),
    } });
    onDone();
  });
  const oauth = useAction(async () => {
    const r = await session.call<{ url: string }>(`/o/${org.id}/integrations/oauth/${provider.id}/start`, { body: { redirectAfter: `/dashboard/${org.id}/integrations` } });
    window.location.href = r.url;
  });
  return (
    <Modal open onClose={onClose} title={provider.name}>
      <div className="row" style={{ marginBlockEnd: 10 }}><ReadinessBadge readiness={provider.readiness} /></div>
      {provider.readiness === 'implemented_unverified' && <Notice tone="warn">{t('connect.int.unverifiedNotice')}</Notice>}
      <form onSubmit={save.run} style={{ marginBlockStart: 12 }}>
        {provider.sandboxOnly ? <p className="fine">{t('connect.int.sandboxNotice')}</p> : <>
          {provider.authType === 'oauth' && (
            <div className="stack" style={{ marginBlockEnd: 12 }}>
              <button type="button" className="btn btn-leaf" disabled={oauth.pending || !provider.oauthConfigured} onClick={() => oauth.run()}>{t('connect.int.oauth')}</button>
              {!provider.oauthConfigured && <p className="fine">{t('connect.int.oauthMissing')}</p>}
              {oauth.error && <Notice tone="danger">{oauth.error}</Notice>}
              <span className="fine">{t('connect.int.orManual')}</span>
            </div>
          )}
          <SelectField label={t('connect.int.environment')} value={environment} onChange={(e) => setEnvironment(e.target.value as 'sandbox' | 'live')}>
            <option value="live">{t('state.live')}</option><option value="sandbox">{t('connect.int.providerSandbox')}</option></SelectField>
          {[...provider.fields.credentials, ...provider.fields.config].map((f) => (
            <Field key={f.key} label={f.label} type={f.secret ? 'password' : 'text'} autoComplete="off" dir="ltr" required={f.required}
              value={values[f.key] ?? ''} hint={f.secret ? t('connect.int.secretHint') : f.hint} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          ))}
        </>}
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <button className="btn btn-primary" disabled={save.pending}>{t('connect.int.save')}</button>
      </form>
    </Modal>
  );
}

function Connections() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const list = useApi<{ items: IntegrationConnectionView[] }>(`/o/${org.id}/integrations/connections`);
  const [open, setOpen] = useState<IntegrationConnectionView | null>(null);
  const act = useAction(async (c: IntegrationConnectionView, action: 'health' | 'enable' | 'disable' | 'revoke' | 'delete') => {
    if (action === 'revoke' && !window.confirm(t('connect.int.revokeConfirm'))) return;
    if (action === 'delete') await session.call(`/o/${org.id}/integrations/connections/${c.id}`, { method: 'DELETE' });
    else await session.call(`/o/${org.id}/integrations/connections/${c.id}/${action}`, { method: 'POST' });
    await list.reload();
  });
  const setSot = useAction(async (c: IntegrationConnectionView, menu: string) => {
    await session.call(`/o/${org.id}/integrations/connections/${c.id}`, { method: 'PATCH', body: { sourceOfTruth: { menu } } });
    await list.reload();
  });
  if (!list.data) return list.error ? <Notice tone="danger">{list.error.message}</Notice> : <Skeleton />;
  return (
    <div className="stack">
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      {setSot.error && <Notice tone="danger">{setSot.error}</Notice>}
      <DataTable rows={list.data.items} rowKey={(c) => c.id} empty={<EmptyState title={t('connect.int.noConnections')}>{t('connect.int.noConnectionsBody')}</EmptyState>} columns={[
        { key: 'p', header: t('connect.int.provider'), render: (c) => <><strong>{c.provider}</strong> <div className="row" style={{ gap: 4 }}>{c.readiness && <ReadinessBadge readiness={c.readiness} />}
          <Badge tone={c.environment === 'live' ? 'info' : 'sandbox'}>{c.environment === 'live' ? t('state.live') : t('connect.int.providerSandbox')}</Badge></div></> },
        { key: 's', header: t('connect.channels.status'), render: (c) => <div className="stack" style={{ gap: 2 }}><Badge tone={statusTone(c.status)}>{t(`connect.int.status.${c.status}`)}</Badge>
          {!c.enabled && <Badge>{t('connect.int.disabled')}</Badge>}{c.lastError && <span className="fine" style={{ color: 'var(--danger)' }}>{c.lastError}</span>}</div> },
        { key: 'h', header: t('connect.int.health'), render: (c) => <span className="fine">{c.lastHealthCheckAt ? dateTime(c.lastHealthCheckAt, locale) : t('connect.int.neverChecked')}</span> },
        { key: 'cred', header: t('connect.int.credentials'), render: (c) => <code className="fine" dir="ltr">{c.credentialsHint ?? '—'}</code> },
        { key: 'sot', header: t('connect.int.sourceOfTruth'), render: (c) => c.category === 'pos' ? (
          <select className="select" style={{ minHeight: 32, width: 'auto' }} value={c.sourceOfTruth.menu} onChange={(e) => setSot.run(c, e.target.value)} aria-label={t('connect.int.sourceOfTruth')}>
            <option value="resuto">{t('connect.int.sot.resuto')}</option><option value="provider">{t('connect.int.sot.provider')}</option></select>) : <span className="fine">{t('connect.int.sot.ordersResuto')}</span> },
        { key: 'a', header: '', align: 'end', render: (c) => (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {c.status !== 'revoked' && <button className="btn btn-sm" disabled={act.pending} onClick={() => act.run(c, 'health')}>{t('connect.int.check')}</button>}
            {c.status !== 'revoked' && <button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => act.run(c, c.enabled ? 'disable' : 'enable')}>{t(c.enabled ? 'connect.channels.disable' : 'connect.channels.enable')}</button>}
            {c.status !== 'revoked' && c.status !== 'sandbox' && <button className="btn btn-sm btn-ghost btn-danger" disabled={act.pending} onClick={() => act.run(c, 'revoke')}>{t('connect.int.revoke')}</button>}
            {['revoked', 'not_configured', 'sandbox'].includes(c.status) && <button className="btn btn-sm btn-ghost btn-danger" disabled={act.pending} onClick={() => act.run(c, 'delete')}>{t('action.delete')}</button>}
            <button className="btn btn-sm btn-ghost" onClick={() => setOpen(c)}>{t('connect.int.details')}</button>
          </div>) },
      ]} />
      <p className="fine">{t('connect.int.sot.rules')}</p>
      {open && <ConnectionDetail connection={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ConnectionDetail({ connection, onClose }: { connection: IntegrationConnectionView; onClose: () => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const runs = useApi<{ items: Array<{ id: string; status: string; attempt: number; stats: any; error: string | null; startedAt: string }> }>(
    connection.category === 'pos' ? `/o/${org.id}/integrations/connections/${connection.id}/sync-runs` : null);
  const logs = useApi<{ items: Array<{ id: number; level: string; message: string; createdAt: string }> }>(`/o/${org.id}/integrations/connections/${connection.id}/logs?limit=30`);
  return (
    <Modal open onClose={onClose} title={connection.provider}>
      <pre className="fine" dir="ltr" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-warm)', padding: 10, borderRadius: 8 }}>{JSON.stringify({ health: connection.health, config: connection.config }, null, 2)}</pre>
      {connection.category === 'pos' && <><h3>{t('connect.int.syncRuns')}</h3>
        {(runs.data?.items ?? []).length === 0 ? <p className="fine">{t('state.empty')}</p> : <ul className="fine">{runs.data!.items.map((r) => (
          <li key={r.id}>{dateTime(r.startedAt, locale)} · <Badge tone={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn'}>{r.status}</Badge> · #{r.attempt} · {r.stats?.fetched ?? 0} / {r.stats?.conflicts ?? 0} {r.error ? `· ${r.error}` : ''}</li>))}</ul>}</>}
      <h3>{t('connect.int.logs')}</h3>
      <ul className="fine">{(logs.data?.items ?? []).map((l) => <li key={l.id}><Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warn' : 'neutral'}>{l.level}</Badge> {dateTime(l.createdAt, locale)} — {l.message}</li>)}</ul>
    </Modal>
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
        {result && <div className="stack" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 6 }}>
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
            { key: 'a', header: '', align: 'end', render: (k) => <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
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
          {importPreview != null && <pre className="fine" dir="ltr" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>{JSON.stringify(importPreview, null, 2)}</pre>}
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
