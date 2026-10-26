'use client';
// Shared pieces of the integrations page (21-INT split of the former 636-line page): provider-declared connection
// fields, the key form, the webhook panel, the readiness table, the account picker and the edit form.
import { useState, type FormEvent } from 'react';
import type { ConnectionPermissions, IntegrationConnectionView, ProviderCatalogEntry, ProviderMarketplaceState } from '@resuto/contracts';
import { Badge, Field, Modal, Notice, SelectField, useAction, type Tone } from '@resuto/ui';
import { ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { capabilityLabel } from '@/lib/vocab-codes';
import { beginOAuth } from '../../oauth/binding';
import s from './integrations.module.css';

export interface FieldSpec {
  key: string; label: string; secret: boolean; required: boolean; hint?: string;
  labelKey?: string; hintKey?: string; kind?: 'text' | 'secret' | 'number' | 'select'; pattern?: string; options?: string[]; placeholder?: string;
}
export type ReadinessState = 'not_configured' | 'implementation_incomplete' | 'pending_external_verification' | 'official_test_verified' | 'live_verified' | 'blocked_by_provider';
export interface CapabilityReadiness { capability: string; test: ReadinessState; live: ReadinessState; note: string | null; blockedBy: string | null }
export interface ReadinessDetail { summary: ReadinessState; configured: boolean; capabilities: CapabilityReadiness[]; restriction: { country: string; reason: string; source: string } | null }
export type CatalogItem = ProviderCatalogEntry & {
  fields: { credentials: FieldSpec[]; config: FieldSpec[] }; oauthConfigured: boolean | null;
  activationKeys?: string[]; webhookEvents?: string[]; readinessDetail?: ReadinessDetail | null; marketplace?: ProviderMarketplaceState;
};
export interface WebhookInfo { url: string; events: string[]; registeredByMerchant: boolean; verifyToken?: string | null }
export interface AccountChoice { id: string; name: string | null; currency: string | null; status: string | null }
export type ConnectionView = IntegrationConnectionView & {
  webhook?: WebhookInfo | null; lastSuccessAt?: string | null; lastFailureAt?: string | null; lastWebhookAt?: string | null; account?: Record<string, string> | null;
  permissions?: ConnectionPermissions;
};

/** Config key of the chosen ad account per ads provider (INT-11 picker). */
export const ACCOUNT_KEY: Record<string, string> = { meta_ads: 'adAccountId', tiktok_ads: 'advertiserId', snapchat_ads: 'adAccountId', meta_pages: 'pageId', foodics: 'businessReference' };
/** Picker wording: a Facebook Page for Messenger / Instagram (INT-21), an ad account otherwise. */
export const pickerKey = (provider: string, k: 'title' | 'help' | 'label' | 'none' | 'use' | 'choose' | 'change') => `intg.${provider === 'meta_pages' ? 'page' : 'account'}.${k}`;

const readinessTone = (r: string): Tone => (r === 'simulated' ? 'sandbox' : r === 'implemented_unverified' ? 'warn' : r === 'sandbox_verified' ? 'info' : 'ok');
const stateTone = (st: ReadinessState): Tone => (({
  not_configured: 'neutral', implementation_incomplete: 'danger', pending_external_verification: 'warn', official_test_verified: 'info', live_verified: 'ok', blocked_by_provider: 'danger',
} as Record<ReadinessState, Tone>)[st]);
export const statusTone = (st: string): Tone => (({ connected: 'ok', sandbox: 'sandbox', pending: 'warn', error: 'danger', revoked: 'neutral', not_configured: 'neutral' } as Record<string, Tone>)[st] ?? 'neutral');

/** Translation with an English fallback for keys a provider declares but the dictionary does not have yet. */
export function useTx() {
  const { t, locale } = useT();
  const tx = (key: string | undefined, fallback: string, vars?: Record<string, string | number>) => {
    if (!key) return fallback;
    const v = t(key, vars);
    return v === key ? fallback : v;
  };
  return { t, tx, locale };
}

/** API errors with a known code are shown in the user's language (form validation, environment mismatch). */
export function localizedError(e: unknown, t: (k: string, v?: Record<string, string | number>) => string): Error {
  if (e instanceof ApiRequestError) {
    const d = (e.details ?? {}) as { missing?: string[]; invalid?: string[] };
    const key = `intg.error.${e.code}`;
    const msg = t(key, { fields: (d.missing ?? d.invalid ?? []).join(', ') });
    if (msg !== key) return new Error(msg);
  }
  return e as Error;
}

export function ReadinessBadge({ readiness }: { readiness: string }) {
  const { t } = useT();
  return <Badge tone={readinessTone(readiness)}>{t(`connect.readiness.${readiness}`)}</Badge>;
}

/** A readiness label that may wrap (the six-state labels are sentences, not single words). */
export function StateBadge({ state }: { state: ReadinessState }) {
  const { t } = useT();
  const tone = stateTone(state);
  return <span className={`badge${tone === 'neutral' ? '' : ` badge-${tone}`} ${s.chip}`}>{t(`intg.readiness.${state}`)}</span>;
}

export function CapabilityTable({ detail, provider }: { detail: ReadinessDetail; provider: string }) {
  const { t, tx, locale } = useTx();
  const r = detail.restriction;
  return (
    <div className="stack gap-6">
      {r && <Notice tone="danger">{tx(`intg.restricted.${r.country}`, r.reason, { provider })} <a href={r.source} target="_blank" rel="noreferrer" dir="ltr">{new URL(r.source).host}</a></Notice>}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{t('intg.readiness.col.capability')}</th><th>{t('intg.readiness.col.test')}</th><th>{t('intg.readiness.col.live')}</th></tr></thead>
          <tbody>{detail.capabilities.map((c) => (
            <tr key={c.capability}>
              <td>{capabilityLabel(t, c.capability)}{c.note && locale === 'en' && <div className="fine">{c.note}</div>}</td>
              <td><StateBadge state={c.test} /></td>
              <td><StateBadge state={c.live} /></td>
            </tr>))}</tbody>
        </table>
      </div>
      <p className="fine m-0">{t('intg.readiness.help')}</p>
    </div>
  );
}

export const fieldValid = (f: FieldSpec, v: string | undefined) => {
  if (!v) return !f.required;
  if (f.options && !f.options.includes(v)) return false;
  return !f.pattern || new RegExp(f.pattern).test(v);
};
const regionKey = (url: string) => `intg.region.${new URL(url).host.split('.')[0]}`;
/** Select options are either region URLs (Paymob) or plain values (Meta CAPI: on_completion, never, on, off). */
const optionKey = (o: string) => (/^https?:\/\//.test(o) ? regionKey(o) : `intg.option.${o}`);

/** Provider-declared credential and settings fields (INT-06): localized labels, formats checked before submit. */
export function ProviderFields({ provider, fields, values, onChange, touched }: {
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

export const pickValues = (fs: FieldSpec[], values: Record<string, string>) =>
  Object.fromEntries(fs.map((f) => [f.key, values[f.key]?.trim()]).filter(([, v]) => v).map(([k, v]) => {
    const spec = fs.find((f) => f.key === k);
    return [k, spec?.kind === 'number' && /^\d+$/.test(v!) ? Number(v) : v];
  }));

/** Test / live choice; live needs an explicit confirmation (INT-06). */
function EnvironmentChoice({ environment, setEnvironment, liveConfirmed, setLiveConfirmed, payment }: {
  environment: 'sandbox' | 'live'; setEnvironment: (e: 'sandbox' | 'live') => void; liveConfirmed: boolean; setLiveConfirmed: (v: boolean) => void; payment?: boolean;
}) {
  const { t } = useT();
  return (
    <>
      <SelectField label={t('intg.env.label')} value={environment} onChange={(e) => { setEnvironment(e.target.value as 'sandbox' | 'live'); setLiveConfirmed(false); }}>
        <option value="sandbox">{t('intg.env.sandbox')}</option><option value="live">{t('intg.env.live')}</option></SelectField>
      {payment && environment === 'sandbox' && <p className="fine">{t('intg.env.testFirst')}</p>}
      {environment === 'live' && (
        <label className={`fine ${s.confirm} ${s.mbe}`}>
          <input type="checkbox" checked={liveConfirmed} onChange={(e) => setLiveConfirmed(e.target.checked)} /> <span>{t('intg.env.liveConfirm')}</span>
        </label>
      )}
    </>
  );
}

/**
 * Creates a connection from the provider's declared fields (test environment by default). Payment connections are
 * health-checked at once and show the webhook URL to register (CR-09).
 */
export function KeysForm({ provider, onDone }: { provider: CatalogItem; onDone: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
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
  if (created) {
    return (
      <div className="stack">
        <strong>{t('intg.next.title')}</strong>
        {save.pending ? <p className="fine">{t('intg.next.checking')}</p> : <Notice tone={created.status === 'connected' ? 'ok' : 'warn'}>
          {created.status === 'connected' ? t('intg.next.ok') : t('intg.next.failed')}{created.lastError && <> — <bdi dir="ltr">{created.lastError}</bdi></>}</Notice>}
        {created.webhook && <WebhookPanel webhook={created.webhook} />}
        <button type="button" className="btn btn-primary" onClick={onDone}>{t('connect.int.save')}</button>
      </div>
    );
  }
  return (
    <form className="stack gap-8" onSubmit={save.run}>
      {provider.sandboxOnly ? <p className="fine m-0">{t('mkt.sandbox.body')}</p> : <>
        {provider.readiness === 'implemented_unverified' && <Notice tone="warn">{t('connect.int.unverifiedNotice')}</Notice>}
        <EnvironmentChoice environment={environment} setEnvironment={setEnvironment} liveConfirmed={liveConfirmed} setLiveConfirmed={setLiveConfirmed} payment={isPayment} />
        <ProviderFields provider={provider.id} fields={all} values={values} onChange={setValues} touched={touched} />
      </>}
      {save.error && <Notice tone="danger">{save.error}</Notice>}
      <div><button className="btn btn-primary" disabled={save.pending || (environment === 'live' && !provider.sandboxOnly && !liveConfirmed)}>
        {provider.sandboxOnly ? t('connect.int.enableSandbox') : t('connect.int.save')}</button></div>
    </form>
  );
}

/** Starts the bound-state OAuth flow (PS-11): the browser keeps a nonce; only its SHA-256 goes to the API. */
export function useOAuthStart(provider: string) {
  const { org } = useOrg();
  const session = useSession();
  return useAction(async () => {
    const redirectAfter = `/dashboard/${org.id}/integrations`;
    const browserBinding = await beginOAuth(provider, org.id, redirectAfter);
    const r = await session.call<{ url: string }>(`/o/${org.id}/integrations/oauth/${provider}/start`, { body: { redirectAfter, browserBinding } });
    window.location.href = r.url;
  });
}

/** The merchant's exact webhook URL with a copy button and the events to subscribe (CR-09). */
export function WebhookPanel({ webhook }: { webhook: WebhookInfo }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(webhook.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* clipboard blocked: the URL stays selectable */ }
  };
  return (
    <div className="stack gap-6">
      <strong className="fine">{t('intg.webhook.title')}</strong>
      <div className={s.copyRow}>
        <code dir="ltr" className={`fine ${s.code}`}>{webhook.url}</code>
        <button type="button" className="btn btn-sm" onClick={copy}>{copied ? t('intg.webhook.copied') : t('intg.webhook.copy')}</button>
      </div>
      <p className="fine m-0">{webhook.registeredByMerchant ? t('intg.webhook.registerInDashboard') : t('intg.webhook.sentPerCheckout')}</p>
      {webhook.verifyToken && <span className="fine">{t('intg.webhook.verifyToken')} <code className="break-all" dir="ltr">{webhook.verifyToken}</code></span>}
      {webhook.events.length > 0 && <>
        <span className="fine">{t('intg.webhook.events')}</span>
        <ul className={s.list}>{webhook.events.map((e) => <li key={e}><code dir="ltr">{e}</code></li>)}</ul>
      </>}
    </div>
  );
}

/**
 * INT-11: the owner picks which granted ad account / advertiser the connection uses. Choices come from the provider
 * (stored at authorisation, refreshable here); the API refuses an account the provider did not grant.
 */
export function AccountPicker({ connection, onClose, onSaved }: { connection: ConnectionView; onClose: () => void; onSaved: () => void }) {
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
    <Modal open onClose={onClose} title={t(pickerKey(connection.provider, 'title'))}>
      <form onSubmit={save.run} className="stack">
        <p className="fine m-0">{t(pickerKey(connection.provider, 'help'))}</p>
        {choices.length === 0 ? <Notice tone="warn">{t(pickerKey(connection.provider, 'none'))}</Notice> : (
          <SelectField label={t(pickerKey(connection.provider, 'label'))} value={value} onChange={(e) => setValue(e.target.value)}>
            {choices.map((a) => <option key={a.id} value={a.id}>{[a.name ?? a.id, a.id, a.currency, a.status].filter(Boolean).join(' · ')}</option>)}
          </SelectField>
        )}
        {refresh.error && <Notice tone="danger">{refresh.error}</Notice>}
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <div className="row gap-8">
          <button type="button" className="btn btn-ghost" disabled={refresh.pending} onClick={() => refresh.run()}>{t('intg.account.refresh')}</button>
          <button className="btn btn-primary" disabled={save.pending || !value}>{t(pickerKey(connection.provider, 'use'))}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Reconnect (replace credentials, optionally switch environment) or edit settings, then re-check (INT-06). */
export function EditConnection({ connection, spec, mode, onClose, onSaved }: { connection: ConnectionView; spec: CatalogItem; mode: 'credentials' | 'settings'; onClose: () => void; onSaved: () => void }) {
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
        <p className="fine m-0">{t(mode === 'credentials' ? 'intg.update.credentialsHelp' : 'intg.update.settingsHelp')}</p>
        {mode === 'credentials' && <EnvironmentChoice environment={environment} setEnvironment={setEnvironment} liveConfirmed={liveConfirmed} setLiveConfirmed={setLiveConfirmed} />}
        <ProviderFields provider={spec.id} fields={fields} values={values} onChange={setValues} touched={touched} />
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        <button className="btn btn-primary" disabled={save.pending || (environment === 'live' && !liveConfirmed)}>{t('intg.action.save')}</button>
      </form>
    </Modal>
  );
}
