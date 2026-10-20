'use client';
import { useEffect, useState, type FormEvent } from 'react';
import type { IntegrationConnectionView, ProviderCatalogEntry } from '@resuto/contracts';
import { Badge, Card, DataTable, EmptyState, Field, KeyValueList, Modal, Notice, PageHeader, SelectField, Skeleton, Tabs, useAction, type Tone } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { ApiRequestError } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { beginOAuth } from '../../oauth/binding';

interface FieldSpec {
  key: string; label: string; secret: boolean; required: boolean; hint?: string;
  labelKey?: string; hintKey?: string; kind?: 'text' | 'secret' | 'number' | 'select'; pattern?: string; options?: string[]; placeholder?: string;
}
type ReadinessState = 'not_configured' | 'implementation_incomplete' | 'pending_external_verification' | 'official_test_verified' | 'live_verified' | 'blocked_by_provider';
interface CapabilityReadiness { capability: string; test: ReadinessState; live: ReadinessState; note: string | null; blockedBy: string | null }
interface ReadinessDetail { summary: ReadinessState; configured: boolean; capabilities: CapabilityReadiness[]; restriction: { country: string; reason: string; source: string } | null }
type CatalogItem = ProviderCatalogEntry & {
  fields: { credentials: FieldSpec[]; config: FieldSpec[] }; oauthConfigured: boolean | null;
  activationKeys?: string[]; webhookEvents?: string[]; readinessDetail?: ReadinessDetail | null;
};
interface WebhookInfo { url: string; events: string[]; registeredByMerchant: boolean; verifyToken?: string | null }
interface AccountChoice { id: string; name: string | null; currency: string | null; status: string | null }
/** Config key of the chosen ad account per ads provider (INT-11 picker). */
const ACCOUNT_KEY: Record<string, string> = { meta_ads: 'adAccountId', tiktok_ads: 'advertiserId', snapchat_ads: 'adAccountId' };
type ConnectionView = IntegrationConnectionView & {
  webhook?: WebhookInfo | null; lastSuccessAt?: string | null; lastFailureAt?: string | null; lastWebhookAt?: string | null; account?: Record<string, string> | null;
};
interface ImportRow { externalId?: string; name: string; nameAr?: string; category: string; description?: string; priceMinor: number; station?: string; allergens?: string[]; available?: boolean; action?: 'create' | 'update' }
interface SyncResult { run: { id: string; status: string; stats: any; error: string | null }; rows: ImportRow[]; warnings: string[]; importSource: 'foodics' | 'odoo' | 'csv' | null; retryable: boolean }

const readinessTone = (r: string): Tone => (r === 'simulated' ? 'sandbox' : r === 'implemented_unverified' ? 'warn' : r === 'sandbox_verified' ? 'info' : 'ok');
const stateTone = (s: ReadinessState): Tone => (({
  not_configured: 'neutral', implementation_incomplete: 'danger', pending_external_verification: 'warn', official_test_verified: 'info', live_verified: 'ok', blocked_by_provider: 'danger',
} as Record<ReadinessState, Tone>)[s]);
const statusTone = (s: string): Tone => (({ connected: 'ok', sandbox: 'sandbox', pending: 'warn', error: 'danger', revoked: 'neutral', not_configured: 'neutral' } as Record<string, Tone>)[s] ?? 'neutral');

/** Translation with an English fallback for keys a provider declares but the dictionary does not have yet. */
function useTx() {
  const { t, locale } = useT();
  const tx = (key: string | undefined, fallback: string, vars?: Record<string, string | number>) => {
    if (!key) return fallback;
    const v = t(key, vars);
    return v === key ? fallback : v;
  };
  return { t, tx, locale };
}

/** API errors with a known code are shown in the user's language (form validation, environment mismatch). */
function localizedError(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): Error {
  if (e instanceof ApiRequestError) {
    const d = (e.details ?? {}) as { missing?: string[]; invalid?: string[] };
    const key = `intg.error.${e.code}`;
    const msg = t(key, { fields: (d.missing ?? d.invalid ?? []).join(', ') });
    if (msg !== key) return new Error(msg);
  }
  return e as Error;
}

export default function IntegrationsPage() {
  const { t } = useT();
  const [tab, setTab] = useState<'catalog' | 'connections' | 'pos' | 'logs'>('catalog');
  // Back from a provider's consent screen (PS-11 completion page): show the connections.
  useEffect(() => { if (new URLSearchParams(window.location.search).has('connected')) setTab('connections'); }, []);
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

/** A readiness label that may wrap (the six-state labels are sentences, not single words). */
function StateBadge({ state }: { state: ReadinessState }) {
  const { t } = useT();
  const tone = stateTone(state);
  return <span className={`badge${tone === 'neutral' ? '' : ` badge-${tone}`}`} style={{ whiteSpace: 'normal', lineHeight: 1.35, textAlign: 'start' }}>{t(`intg.readiness.${state}`)}</span>;
}

/** Six-state readiness (INT-16) when the API computed it; the legacy label otherwise. */
function ProviderReadiness({ item }: { item: CatalogItem }) {
  if (!item.readinessDetail) return <ReadinessBadge readiness={item.readiness} />;
  return <StateBadge state={item.readinessDetail.summary} />;
}

function CapabilityTable({ detail }: { detail: ReadinessDetail }) {
  const { t, tx, locale } = useTx();
  return (
    <div className="stack" style={{ gap: 6 }}>
      <strong className="fine">{t('intg.readiness.title')}</strong>
      {detail.restriction && <Notice tone="danger">{detail.restriction.reason} <a href={detail.restriction.source} target="_blank" rel="noreferrer" dir="ltr">{new URL(detail.restriction.source).host}</a></Notice>}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{t('intg.readiness.col.capability')}</th><th>{t('intg.readiness.col.test')}</th><th>{t('intg.readiness.col.live')}</th></tr></thead>
          <tbody>{detail.capabilities.map((c) => (
            <tr key={c.capability}>
              <td>{tx(`intg.capability.${c.capability}`, c.capability)}{c.note && locale === 'en' && <div className="fine">{c.note}</div>}</td>
              <td><StateBadge state={c.test} /></td>
              <td><StateBadge state={c.live} /></td>
            </tr>))}</tbody>
        </table>
      </div>
      <p className="fine" style={{ margin: 0 }}>{t('intg.readiness.help')}</p>
    </div>
  );
}

function Catalog({ onConnected }: { onConnected: () => void }) {
  const { t, tx } = useTx();
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
                <div className="stack" style={{ gap: 6, alignItems: 'flex-start' }}><strong><bdi>{p.name}</bdi></strong><ProviderReadiness item={p} /></div>
                <span className="fine" dir="ltr" style={{ textAlign: 'start' }}>{p.countries.join(' · ')}{p.countries.length ? ' · ' : ''}{p.capabilities.slice(0, 4).join(', ')}</span>
                <details><summary className="fine">{t('connect.int.activation')}</summary>
                  <ol className="fine" style={{ paddingInlineStart: 18 }}>{p.activation.map((s, i) => <li key={i}>{tx(p.activationKeys?.[i], s)}</li>)}</ol>
                  {p.readinessDetail && <CapabilityTable detail={p.readinessDetail} />}
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

const fieldValid = (f: FieldSpec, v: string | undefined) => {
  if (!v) return !f.required;
  if (f.options && !f.options.includes(v)) return false;
  return !f.pattern || new RegExp(f.pattern).test(v);
};
const regionKey = (url: string) => `intg.region.${new URL(url).host.split('.')[0]}`;
/** Select options are either region URLs (Paymob) or plain values (Meta CAPI: on_completion, never, on, off). */
const optionKey = (o: string) => (/^https?:\/\//.test(o) ? regionKey(o) : `intg.option.${o}`);

/** Provider-declared credential and settings fields (INT-06): localized labels, formats checked before submit. */
function ProviderFields({ provider, fields, values, onChange, touched }: {
  provider: string; fields: FieldSpec[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void; touched: boolean;
}) {
  const { t, tx } = useTx();
  return <>{fields.map((f) => {
    const label = tx(f.labelKey, f.label);
    const hint = f.hintKey ? tx(f.hintKey, f.hint ?? '') : f.secret ? t('connect.int.secretHint') : f.hint;
    const invalid = touched && !!values[f.key] && !fieldValid(f, values[f.key]) ? t('intg.field.invalid') : null;
    if (f.kind === 'select' && f.options) {
      return (
        <SelectField key={f.key} label={label} hint={hint} value={values[f.key] || f.options[0]} onChange={(e) => onChange({ ...values, [f.key]: e.target.value })}>
          {f.options.map((o) => <option key={o} value={o}>{tx(optionKey(o), o)}</option>)}
        </SelectField>
      );
    }
    return (
      <Field key={`${provider}-${f.key}`} label={label} type={f.secret ? 'password' : 'text'} autoComplete="off" dir="ltr" required={f.required}
        inputMode={f.kind === 'number' ? 'numeric' : undefined} placeholder={f.placeholder} value={values[f.key] ?? ''} hint={hint} error={invalid}
        onChange={(e) => onChange({ ...values, [f.key]: e.target.value })} />
    );
  })}</>;
}

const pickValues = (fs: FieldSpec[], values: Record<string, string>) =>
  Object.fromEntries(fs.map((f) => [f.key, values[f.key]?.trim()]).filter(([, v]) => v).map(([k, v]) => {
    const spec = fs.find((f) => f.key === k);
    return [k, spec?.kind === 'number' && /^\d+$/.test(v!) ? Number(v) : v];
  }));

function ConnectModal({ provider, onClose, onDone }: { provider: CatalogItem; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  // Default to the provider's TEST environment; live needs an explicit confirmation (INT-06).
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>('sandbox');
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [created, setCreated] = useState<ConnectionView | null>(null);
  const all = [...provider.fields.credentials, ...provider.fields.config];
  const isPayment = provider.category === 'payments' && !provider.sandboxOnly;
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!provider.sandboxOnly && all.some((f) => !fieldValid(f, values[f.key]?.trim()))) throw new Error(t('intg.field.invalid'));
    try {
      const c = await session.call<ConnectionView>(`/o/${org.id}/integrations/connections`, { body: {
        provider: provider.id, environment, credentials: provider.sandboxOnly ? {} : pickValues(provider.fields.credentials, values),
        config: provider.sandboxOnly ? {} : pickValues(provider.fields.config, values),
      } });
      if (!isPayment) { onDone(); return; }
      setCreated(c);
      setCreated(await session.call<ConnectionView>(`/o/${org.id}/integrations/connections/${c.id}/health`, { method: 'POST' }));
    } catch (err) {
      throw localizedError(err, t);
    }
  });
  const oauth = useAction(async () => {
    // PS-11: the browser keeps a nonce; only its SHA-256 goes to the API, and completing needs the nonce back.
    const redirectAfter = `/dashboard/${org.id}/integrations`;
    const browserBinding = await beginOAuth(provider.id, org.id, redirectAfter);
    const r = await session.call<{ url: string }>(`/o/${org.id}/integrations/oauth/${provider.id}/start`, { body: { redirectAfter, browserBinding } });
    window.location.href = r.url;
  });
  if (created) {
    return (
      <Modal open onClose={onDone} title={<bdi>{provider.name}</bdi>}>
        <div className="stack">
          <strong>{t('intg.next.title')}</strong>
          {save.pending ? <p className="fine">{t('intg.next.checking')}</p> : <Notice tone={created.status === 'connected' ? 'ok' : 'warn'}>
            {created.status === 'connected' ? t('intg.next.ok') : t('intg.next.failed')}{created.lastError && <> — <bdi dir="ltr">{created.lastError}</bdi></>}</Notice>}
          {created.webhook && <WebhookPanel webhook={created.webhook} />}
          <button className="btn btn-primary" onClick={onDone}>{t('connect.int.save')}</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={onClose} title={<bdi>{provider.name}</bdi>}>
      <div className="row" style={{ marginBlockEnd: 10 }}><ProviderReadiness item={provider} /></div>
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
          <SelectField label={t('intg.env.label')} value={environment} onChange={(e) => { setEnvironment(e.target.value as 'sandbox' | 'live'); setLiveConfirmed(false); }}>
            <option value="sandbox">{t('intg.env.sandbox')}</option><option value="live">{t('intg.env.live')}</option></SelectField>
          {isPayment && environment === 'sandbox' && <p className="fine">{t('intg.env.testFirst')}</p>}
          {environment === 'live' && (
            <label className="fine" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBlockEnd: 8 }}>
              <input type="checkbox" style={{ width: 'auto', marginBlockStart: 3 }} checked={liveConfirmed} onChange={(e) => setLiveConfirmed(e.target.checked)} /> <span>{t('intg.env.liveConfirm')}</span>
            </label>
          )}
          <ProviderFields provider={provider.id} fields={all} values={values} onChange={setValues} touched={touched} />
        </>}
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <button className="btn btn-primary" disabled={save.pending || (environment === 'live' && !provider.sandboxOnly && !liveConfirmed)}>{t('connect.int.save')}</button>
      </form>
    </Modal>
  );
}

/** The merchant's exact webhook URL with a copy button and the events to subscribe (CR-09). */
function WebhookPanel({ webhook }: { webhook: WebhookInfo }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(webhook.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked: the URL stays selectable */ }
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <strong className="fine">{t('intg.webhook.title')}</strong>
      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
        <code dir="ltr" className="fine" style={{ wordBreak: 'break-all', background: 'var(--surface-warm)', padding: '6px 8px', borderRadius: 6, flex: 1 }}>{webhook.url}</code>
        <button type="button" className="btn btn-sm" onClick={copy}>{copied ? t('intg.webhook.copied') : t('intg.webhook.copy')}</button>
      </div>
      <p className="fine" style={{ margin: 0 }}>{webhook.registeredByMerchant ? t('intg.webhook.registerInDashboard') : t('intg.webhook.sentPerCheckout')}</p>
      {webhook.verifyToken && <span className="fine">{t('intg.webhook.verifyToken')} <code dir="ltr" style={{ wordBreak: 'break-all' }}>{webhook.verifyToken}</code></span>}
      {webhook.events.length > 0 && <>
        <span className="fine">{t('intg.webhook.events')}</span>
        <ul className="fine" style={{ margin: 0, paddingInlineStart: 18 }}>{webhook.events.map((e) => <li key={e}><code dir="ltr">{e}</code></li>)}</ul>
      </>}
    </div>
  );
}

function Connections() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const list = useApi<{ items: ConnectionView[] }>(`/o/${org.id}/integrations/connections`);
  const catalog = useApi<{ items: CatalogItem[] }>(`/o/${org.id}/integrations/catalog`);
  const [open, setOpen] = useState<ConnectionView | null>(null);
  const [editing, setEditing] = useState<{ c: ConnectionView; mode: 'credentials' | 'settings' } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [revocation, setRevocation] = useState<{ attempted: boolean; revoked: boolean; note: string } | null>(null);
  // Back from OAuth with several granted accounts: open the account picker (INT-11).
  useEffect(() => { const id = new URLSearchParams(window.location.search).get('choose'); if (id && /^[0-9a-f-]{36}$/i.test(id)) setPicking(id); }, []);
  const act = useAction(async (c: ConnectionView, action: 'health' | 'enable' | 'disable' | 'revoke' | 'delete') => {
    if (action === 'revoke' && !window.confirm(t('connect.int.revokeConfirm'))) return;
    setRevocation(null);
    if (action === 'delete') await session.call(`/o/${org.id}/integrations/connections/${c.id}`, { method: 'DELETE' });
    else {
      const r = await session.call<{ providerRevocation?: { attempted: boolean; revoked: boolean; note: string } | null }>(`/o/${org.id}/integrations/connections/${c.id}/${action}`, { method: 'POST' });
      if (action === 'revoke' && r.providerRevocation) setRevocation(r.providerRevocation);
    }
    await list.reload();
  });
  const needsAccount = (c: ConnectionView) => !!ACCOUNT_KEY[c.provider] && c.status !== 'revoked' && c.authType === 'oauth' && !c.config?.[ACCOUNT_KEY[c.provider]!];
  const hasChoices = (c: ConnectionView) => !!ACCOUNT_KEY[c.provider] && c.status !== 'revoked' && c.authType === 'oauth';
  const setSot = useAction(async (c: ConnectionView, menu: string) => {
    await session.call(`/o/${org.id}/integrations/connections/${c.id}`, { method: 'PATCH', body: { sourceOfTruth: { menu } } });
    await list.reload();
  });
  const specOf = (c: ConnectionView) => catalog.data?.items.find((i) => i.id === c.provider) ?? null;
  if (!list.data) return list.error ? <Notice tone="danger">{list.error.message}</Notice> : <Skeleton />;
  return (
    <div className="stack">
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      {revocation && <Notice tone={revocation.revoked ? 'ok' : 'warn'}>{t(revocation.revoked ? 'intg.revoke.providerOk' : revocation.attempted ? 'intg.revoke.providerUnconfirmed' : 'intg.revoke.providerManual')} <bdi dir="ltr">{revocation.note}</bdi></Notice>}
      {setSot.error && <Notice tone="danger">{setSot.error}</Notice>}
      <DataTable rows={list.data.items} rowKey={(c) => c.id} empty={<EmptyState title={t('connect.int.noConnections')}>{t('connect.int.noConnectionsBody')}</EmptyState>} columns={[
        { key: 'p', header: t('connect.int.provider'), render: (c) => <><strong><bdi>{specOf(c)?.name ?? c.provider}</bdi></strong> <div className="row" style={{ gap: 4 }}>
          {specOf(c)?.readinessDetail ? <StateBadge state={specOf(c)!.readinessDetail!.summary} /> : c.readiness && <ReadinessBadge readiness={c.readiness} />}
          <Badge tone={c.environment === 'live' ? 'info' : 'sandbox'}>{c.environment === 'live' ? t('intg.env.liveBadge') : t('intg.env.testBadge')}</Badge></div></> },
        { key: 's', header: t('connect.channels.status'), render: (c) => <div className="stack" style={{ gap: 2 }}><Badge tone={statusTone(c.status)}>{t(`connect.int.status.${c.status}`)}</Badge>
          {!c.enabled && <Badge>{t('connect.int.disabled')}</Badge>}{c.lastError && <span className="fine" dir="ltr" style={{ color: 'var(--danger)', textAlign: 'start' }}>{c.lastError}</span>}</div> },
        { key: 'h', header: t('connect.int.health'), render: (c) => <span className="fine">{c.lastHealthCheckAt ? dateTime(c.lastHealthCheckAt, locale) : t('connect.int.neverChecked')}</span> },
        { key: 'cred', header: t('connect.int.credentials'), render: (c) => <code className="fine" dir="ltr">{c.credentialsHint ?? '—'}</code> },
        { key: 'sot', header: t('connect.int.sourceOfTruth'), render: (c) => c.category === 'pos' ? (
          <select className="select" style={{ minHeight: 32, width: 'auto' }} value={c.sourceOfTruth.menu} onChange={(e) => setSot.run(c, e.target.value)} aria-label={t('connect.int.sourceOfTruth')}>
            <option value="resuto">{t('connect.int.sot.resuto')}</option><option value="provider">{t('connect.int.sot.provider')}</option></select>) : <span className="fine">{t('connect.int.sot.ordersResuto')}</span> },
        { key: 'a', header: '', align: 'end', render: (c) => (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {needsAccount(c) && <button className="btn btn-sm btn-primary" onClick={() => setPicking(c.id)}>{t('intg.account.choose')}</button>}
            {!needsAccount(c) && hasChoices(c) && <button className="btn btn-sm btn-ghost" onClick={() => setPicking(c.id)}>{t('intg.account.change')}</button>}
            {c.status !== 'revoked' && <button className="btn btn-sm" disabled={act.pending} onClick={() => act.run(c, 'health')}>{t('connect.int.check')}</button>}
            {c.status !== 'sandbox' && specOf(c) && <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ c, mode: 'credentials' })}>{t('intg.action.updateCredentials')}</button>}
            {c.status !== 'revoked' && c.status !== 'sandbox' && (specOf(c)?.fields.config.length ?? 0) > 0 && <button className="btn btn-sm btn-ghost" onClick={() => setEditing({ c, mode: 'settings' })}>{t('intg.action.editSettings')}</button>}
            {c.status !== 'revoked' && <button className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => act.run(c, c.enabled ? 'disable' : 'enable')}>{t(c.enabled ? 'connect.channels.disable' : 'connect.channels.enable')}</button>}
            {c.status !== 'revoked' && c.status !== 'sandbox' && <button className="btn btn-sm btn-ghost btn-danger" disabled={act.pending} onClick={() => act.run(c, 'revoke')}>{t('connect.int.revoke')}</button>}
            {['revoked', 'not_configured', 'sandbox'].includes(c.status) && <button className="btn btn-sm btn-ghost btn-danger" disabled={act.pending} onClick={() => act.run(c, 'delete')}>{t('action.delete')}</button>}
            <button className="btn btn-sm btn-ghost" onClick={() => setOpen(c)}>{t('connect.int.details')}</button>
          </div>) },
      ]} />
      <p className="fine">{t('connect.int.sot.rules')}</p>
      {open && <ConnectionDetail connection={open} spec={specOf(open)} onClose={() => setOpen(null)} />}
      {picking && list.data.items.find((c) => c.id === picking) && <AccountPicker connection={list.data.items.find((c) => c.id === picking)!}
        onClose={() => setPicking(null)} onSaved={async () => { setPicking(null); await list.reload(); }} />}
      {editing && specOf(editing.c) && <EditConnection connection={editing.c} spec={specOf(editing.c)!} mode={editing.mode} onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await list.reload(); }} />}
    </div>
  );
}

/**
 * INT-11: the owner picks which granted ad account / advertiser the connection uses. Choices come from the provider
 * (stored at authorisation, refreshable here); the API refuses an account the provider did not grant.
 */
function AccountPicker({ connection, onClose, onSaved }: { connection: ConnectionView; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const key = ACCOUNT_KEY[connection.provider]!;
  const [choices, setChoices] = useState<AccountChoice[]>(((connection.config?.accountChoices as AccountChoice[] | undefined) ?? []));
  const [value, setValue] = useState<string>(String(connection.config?.[key] ?? choices[0]?.id ?? ''));
  const refresh = useAction(async () => {
    const r = await session.call<{ accounts: AccountChoice[] }>(`/o/${org.id}/integrations/connections/${connection.id}/accounts`);
    setChoices(r.accounts);
    if (!r.accounts.some((a) => a.id === value)) setValue(r.accounts[0]?.id ?? '');
  });
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await session.call(`/o/${org.id}/integrations/connections/${connection.id}/account`, { body: { accountId: value } });
    onSaved();
  });
  return (
    <Modal open onClose={onClose} title={t('intg.account.title')}>
      <form onSubmit={save.run} className="stack">
        <p className="fine" style={{ margin: 0 }}>{t('intg.account.help')}</p>
        {choices.length === 0 ? <Notice tone="warn">{t('intg.account.none')}</Notice> : (
          <SelectField label={t('intg.account.label')} value={value} onChange={(e) => setValue(e.target.value)}>
            {choices.map((a) => <option key={a.id} value={a.id}>{[a.name ?? a.id, a.id, a.currency, a.status].filter(Boolean).join(' · ')}</option>)}
          </SelectField>
        )}
        {refresh.error && <Notice tone="danger">{refresh.error}</Notice>}
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="row" style={{ gap: 8 }}>
          <button type="button" className="btn btn-ghost" disabled={refresh.pending} onClick={() => refresh.run()}>{t('intg.account.refresh')}</button>
          <button className="btn btn-primary" disabled={save.pending || !value}>{t('intg.account.use')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Reconnect (replace credentials, optionally switch environment) or edit settings, then re-check (INT-06). */
function EditConnection({ connection, spec, mode, onClose, onSaved }: { connection: ConnectionView; spec: CatalogItem; mode: 'credentials' | 'settings'; onClose: () => void; onSaved: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(connection.config ?? {}).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)])));
  const [environment, setEnvironment] = useState<'sandbox' | 'live'>(connection.environment);
  const [liveConfirmed, setLiveConfirmed] = useState(connection.environment === 'live');
  const [touched, setTouched] = useState(false);
  const fields = mode === 'credentials' ? [...spec.fields.credentials, ...spec.fields.config] : spec.fields.config;
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (fields.some((f) => !fieldValid(f, values[f.key]?.trim()))) throw new Error(t('intg.field.invalid'));
    try {
      const body = mode === 'credentials'
        ? { environment, credentials: pickValues(spec.fields.credentials, values), config: pickValues(spec.fields.config, values) }
        : { config: pickValues(spec.fields.config, values) };
      await session.call(`/o/${org.id}/integrations/connections/${connection.id}`, { method: 'PATCH', body });
      await session.call(`/o/${org.id}/integrations/connections/${connection.id}/health`, { method: 'POST' });
    } catch (err) {
      throw localizedError(err, t);
    }
    onSaved();
  });
  return (
    <Modal open onClose={onClose} title={<>{t(mode === 'credentials' ? 'intg.action.updateCredentials' : 'intg.action.editSettings')} · <bdi>{spec.name}</bdi></>}>
      <form onSubmit={save.run} className="stack">
        <p className="fine" style={{ margin: 0 }}>{t(mode === 'credentials' ? 'intg.update.credentialsHelp' : 'intg.update.settingsHelp')}</p>
        {mode === 'credentials' && <>
          <SelectField label={t('intg.env.label')} value={environment} onChange={(e) => { setEnvironment(e.target.value as 'sandbox' | 'live'); setLiveConfirmed(false); }}>
            <option value="sandbox">{t('intg.env.sandbox')}</option><option value="live">{t('intg.env.live')}</option></SelectField>
          {environment === 'live' && (
            <label className="fine" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <input type="checkbox" style={{ width: 'auto', marginBlockStart: 3 }} checked={liveConfirmed} onChange={(e) => setLiveConfirmed(e.target.checked)} /> <span>{t('intg.env.liveConfirm')}</span>
            </label>
          )}
        </>}
        <ProviderFields provider={spec.id} fields={fields} values={values} onChange={setValues} touched={touched} />
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <button className="btn btn-primary" disabled={save.pending || (environment === 'live' && !liveConfirmed)}>{t('intg.action.save')}</button>
      </form>
    </Modal>
  );
}

function ConnectionDetail({ connection, spec, onClose }: { connection: ConnectionView; spec: CatalogItem | null; onClose: () => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const runs = useApi<{ items: Array<{ id: string; status: string; attempt: number; stats: any; error: string | null; startedAt: string }> }>(
    connection.category === 'pos' ? `/o/${org.id}/integrations/connections/${connection.id}/sync-runs` : null);
  const logs = useApi<{ items: Array<{ id: number; level: string; message: string; createdAt: string }> }>(`/o/${org.id}/integrations/connections/${connection.id}/logs?limit=30`);
  const health = (connection.health ?? {}) as { ok?: boolean | null; transient?: boolean; error?: { code?: string; message?: string } | string };
  const when = (v: string | null | undefined) => (v ? dateTime(v, locale) : t('intg.diag.never'));
  const account = connection.account ?? null;
  const accountText = account ? [account.name, account.id, account.country].filter(Boolean).join(' · ') : null;
  // Lists and server-owned objects (account choices) are not settings; the webhook verify token is shown with the webhook.
  const configItems = Object.entries(connection.config ?? {}).filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && k !== 'webhookVerifyToken');
  return (
    <Modal open onClose={onClose} title={<bdi>{spec?.name ?? connection.provider}</bdi>}>
      <div className="stack">
        <h3 style={{ margin: 0 }}>{t('intg.diag.title')}</h3>
        <KeyValueList items={[
          { key: 'h', label: t('connect.int.health'), value: <Badge tone={health.ok === true ? 'ok' : health.ok === false ? (health.transient ? 'warn' : 'danger') : 'neutral'}>
            {health.ok === true ? t('intg.diag.healthOk') : health.ok === false ? t(health.transient ? 'intg.diag.healthUnreachable' : 'intg.diag.healthFailed') : t('intg.diag.healthUnknown')}</Badge> },
          ...(accountText ? [{ key: 'acc', label: t('intg.diag.account'), value: <bdi dir="ltr">{accountText}</bdi> }] : []),
          ...(account?.webhookAccountName ? [{ key: 'wacc', label: t('intg.diag.accountWebhook'), value: <bdi>{account.webhookAccountName}</bdi> }] : []),
          { key: 'ls', label: t('intg.diag.lastSuccess'), value: when(connection.lastSuccessAt) },
          { key: 'lf', label: t('intg.diag.lastFailure'), value: when(connection.lastFailureAt) },
          ...(connection.category === 'payments' ? [{ key: 'lw', label: t('intg.diag.lastWebhook'), value: when(connection.lastWebhookAt) }] : []),
          ...(typeof health.error === 'object' && health.error?.code ? [{ key: 'ec', label: t('intg.diag.errorCode'), value: <code dir="ltr">{health.error.code}</code> }] : []),
          ...(connection.lastError ? [{ key: 'le', label: t('intg.diag.error'), value: <bdi dir="ltr">{connection.lastError}</bdi> }] : []),
        ]} />
        {connection.webhook && <WebhookPanel webhook={connection.webhook} />}
        {configItems.length > 0 && <>
          <h3 style={{ margin: 0 }}>{t('intg.diag.settings')}</h3>
          <KeyValueList items={configItems.map(([k, v]) => {
            const f = spec?.fields.config.find((x) => x.key === k);
            return { key: k, label: f?.labelKey ? t(f.labelKey) : k, value: <bdi dir="ltr">{String(v)}</bdi> };
          })} />
        </>}
        {spec?.readinessDetail && <CapabilityTable detail={spec.readinessDetail} />}
        {connection.category === 'pos' && <><h3>{t('connect.int.syncRuns')}</h3>
          {(runs.data?.items ?? []).length === 0 ? <p className="fine">{t('state.empty')}</p> : <ul className="fine">{runs.data!.items.map((r) => (
            <li key={r.id}>{dateTime(r.startedAt, locale)} · <Badge tone={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'danger' : 'warn'}>{r.status}</Badge> · #{r.attempt} · {r.stats?.fetched ?? 0} / {r.stats?.conflicts ?? 0} {r.error ? `· ${r.error}` : ''}</li>))}</ul>}</>}
        <h3>{t('connect.int.logs')}</h3>
        <ul className="fine">{(logs.data?.items ?? []).map((l) => <li key={l.id}><Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warn' : 'neutral'}>{l.level}</Badge> {dateTime(l.createdAt, locale)} — <bdi>{l.message}</bdi></li>)}</ul>
      </div>
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
