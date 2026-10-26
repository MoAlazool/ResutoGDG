'use client';
// 21-INT integrations marketplace (plan §6.3): provider cards with their logo and an honest chip, category filters and
// search, and the provider sheet — connect by the provider's own method (OAuth "Continue with …", Meta's WhatsApp
// signup, guided onboarding, or keys under "Advanced" with "Where do I find this?"), then the connection's
// capabilities, missing permissions and provider requirements, access expiry and reconnect, health history, logs and
// disconnect. Copy never claims a capability is verified: that comes only from recorded acceptance runs.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MarketplaceCategory, MarketplaceStatus, ReviewRequirement } from '@resuto/contracts';
import { Badge, FilterBar, KeyValueList, Notice, ProviderLogo, Sheet, useAction, useConfirm } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import {
  connectAction, filterCards, keysAreAdvanced, marketCards, presentCategories, STATUS_TONE, type ConnectAction, type MarketCard,
} from '@/lib/integrations-marketplace';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { capabilityLabel } from '@/lib/vocab-codes';
import {
  ACCOUNT_KEY, AccountPicker, CapabilityTable, EditConnection, KeysForm, pickerKey, useOAuthStart, useTx, WebhookPanel,
  type CatalogItem, type ConnectionView,
} from './parts';
import s from './integrations.module.css';

export function StatusChip({ status }: { status: MarketplaceStatus }) {
  const { t } = useTx();
  return <Badge tone={STATUS_TONE[status]}>{t(`mkt.status.${status}`)}</Badge>;
}

function CardLogo({ card }: { card: MarketCard }) {
  return (
    <span className={s.cardLogo} aria-hidden="true">
      {card.logo ? <ProviderLogo provider={card.logo} size={28} decorative /> : <span className="integ-tile" data-tint={card.name.length % 5}>{card.name.trim().charAt(0).toUpperCase()}</span>}
    </span>
  );
}

/** The card grid with its category filter and search. `?provider=<id>` opens that provider's sheet (deep links). */
export function Marketplace({ items, connections, onChanged }: { items: CatalogItem[]; connections: ConnectionView[]; onChanged: () => Promise<void> | void }) {
  const { t } = useTx();
  const { org } = useOrg();
  const [category, setCategory] = useState<MarketplaceCategory | ''>('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const p = q.get('provider');
    if (p && /^[a-z0-9_]{2,40}$/.test(p)) setOpen(p);
  }, []);
  const cards = useMemo(() => marketCards(items, org.id, (id) => t(`mkt.link.${id}`)), [items, org.id, t]);
  const shown = filterCards(cards, { category, query }, (c) => t(`mkt.category.${c}`));
  const card = open ? cards.find((c) => c.id === open) ?? null : null;
  return (
    <div className="stack">
      <FilterBar search={{ value: query, onChange: setQuery, placeholder: t('mkt.search'), label: t('mkt.search'), debounceMs: 0 }}
        filters={
          <div className="integ-chips" role="group" aria-label={t('mkt.filter.label')}>
            <button type="button" className="integ-chip" aria-pressed={!category} onClick={() => setCategory('')}>{t('mkt.filter.all')}</button>
            {presentCategories(cards).map((c) => (
              <button key={c} type="button" className="integ-chip" aria-pressed={category === c} onClick={() => setCategory(c)}>{t(`mkt.category.${c}`)}</button>
            ))}
          </div>
        } />
      <p className="fine m-0" aria-live="polite">{t('mkt.count', { n: shown.length })} · {t('mkt.verificationHelp')}</p>
      {shown.length === 0 ? <Notice>{t('mkt.empty')}</Notice> : (
        <ul className={s.grid} aria-label={t('mkt.tab')}>
          {shown.map((c) => (
            <li key={c.id}>
              <button type="button" className={s.card} onClick={() => setOpen(c.id)} aria-haspopup="dialog" data-card={c.id}>
                <CardLogo card={c} />
                <span className={s.cardName}><bdi>{c.name}</bdi></span>
                <span className={s.cardMeta}>{t(`mkt.category.${c.category}`)} · {t(`mkt.method.${c.connectMethod}`)}</span>
                <span className={s.cardFoot}>
                  <StatusChip status={c.status} />
                  {c.countries.length > 0 && <span className={s.cardMeta} dir="ltr">{c.countries.join(' · ')}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {card && <ProviderSheet card={card} item={items.find((i) => i.id === card.id) ?? null}
        connection={connections.find((c) => c.id === items.find((i) => i.id === card.id)?.marketplace?.connectionId) ?? null}
        onClose={() => setOpen(null)} onChanged={onChanged} />}
    </div>
  );
}

/** "Where do I find this?": the provider's activation steps (translated when the dictionary has them) and its docs. */
function WhereToFind({ item }: { item: Pick<CatalogItem, 'activation' | 'activationKeys' | 'docsUrl'> }) {
  const { t, tx } = useTx();
  if (!item.activation.length && !item.docsUrl) return null;
  return (
    <details>
      <summary className="fine">{t('mkt.whereFind')}</summary>
      <ol className={s.steps}>{item.activation.map((step, i) => <li key={i}>{tx(item.activationKeys?.[i], step)}</li>)}</ol>
      {item.docsUrl && <a className="fine" href={item.docsUrl} target="_blank" rel="noreferrer">{t('mkt.docs')}</a>}
    </details>
  );
}

/**
 * The connect area for one connect method: OAuth leads with "Continue with …" and keeps keys under "Advanced";
 * Embedded Signup links to the Inbox stepper; guided flows link out; API-key providers lead with the key form.
 * `keys` is the key form (KeysForm) so the method rendering stays testable on its own.
 */
export function ConnectOptions({ card, item, action, oauth, keys }: {
  card: MarketCard; item: Pick<CatalogItem, 'activation' | 'activationKeys' | 'docsUrl'> | null; action: ConnectAction;
  oauth: { run: () => void; pending: boolean; error: string | null }; keys: ReactNode;
}) {
  const { t } = useTx();
  if (action.kind === 'link') {
    return (
      <div className="stack gap-8">
        <p className="fine m-0">{t(card.id === 'zatca' ? 'mkt.guided.zatcaBody' : 'mkt.domains.body')}</p>
        <div><a className="btn btn-primary" href={action.href}>{t(card.id === 'zatca' ? 'mkt.guided.zatca' : 'mkt.domains.cta')}</a></div>
      </div>
    );
  }
  if (!item) return null;
  return (
    <div className="stack gap-8">
      {action.kind === 'oauth' && <>
        <div><button type="button" className="btn btn-primary" disabled={!action.configured || oauth.pending} onClick={() => oauth.run()}>
          {t('mkt.continueWith', { provider: action.brand })}</button></div>
        {!action.configured && <p className="fine m-0">{t('mkt.oauth.notConfigured', { provider: action.brand })}</p>}
        <p className="fine m-0">{t('mkt.oauth.reviewNote', { provider: action.brand })}</p>
        {oauth.error && <Notice tone="danger">{oauth.error}</Notice>}
      </>}
      {action.kind === 'whatsapp' && <>
        <p className="fine m-0">{t('mkt.whatsapp.body')}</p>
        {/* A full page load: Meta's SDK may only run under the Inbox page's Content-Security-Policy. */}
        <div><a className="btn btn-primary" href={action.href}>{t('mkt.whatsapp.cta')}</a></div>
      </>}
      {action.kind === 'guided_keys' && <p className="fine m-0">{t('mkt.guided.eta')}</p>}
      <WhereToFind item={item} />
      {keysAreAdvanced(card.connectMethod)
        ? <details><summary>{t('mkt.advanced')}</summary><div className="mbs-12">{keys}</div></details>
        : <>{action.kind !== 'sandbox' && <h4 className="m-0">{t('mkt.keys')}</h4>}{keys}</>}
    </div>
  );
}

function ConnectSection({ card, item, action, onDone }: { card: MarketCard; item: CatalogItem | null; action: ConnectAction; onDone: () => void }) {
  const oauth = useOAuthStart(card.id);
  return <ConnectOptions card={card} item={item} action={action} oauth={{ run: () => void oauth.run(), pending: oauth.pending, error: oauth.error }}
    keys={item ? <KeysForm provider={item} onDone={onDone} /> : null} />;
}

function Permissions({ connection }: { connection: ConnectionView }) {
  const { t } = useTx();
  const { org } = useOrg();
  const session = useSession();
  const [view, setView] = useState(connection);
  const p = view.permissions;
  const check = useAction(async () => setView(await session.call<ConnectionView>(`/o/${org.id}/integrations/connections/${connection.id}/permissions`, { method: 'POST' })));
  if (!p) return null;
  return (
    <div className="stack gap-6">
      {!p.checked && <p className="fine m-0">{p.checkable ? t('mkt.sheet.permissionsUnchecked') : t('mkt.sheet.permissionsNotReported')}</p>}
      {p.checked && p.missing.length === 0 && <p className="fine m-0">{t('mkt.sheet.permissionsOk')}</p>}
      {p.missing.length > 0 && (
        <ul className={s.list}>{p.missing.map((m) => (
          <li key={m.capability}>{capabilityLabel(t, m.capability)}: {t('mkt.sheet.needsPermission')} <bdi dir="ltr">{m.scopes.join(', ')}</bdi></li>
        ))}</ul>
      )}
      {p.granted.length > 0 && <p className="fine m-0">{t('mkt.sheet.granted')} <bdi dir="ltr">{p.granted.join(', ')}</bdi></p>}
      {p.checkable && <div><button type="button" className="btn btn-sm" disabled={check.pending} onClick={() => check.run()}>{t('mkt.sheet.checkPermissions')}</button></div>}
      {check.error && <Notice tone="danger">{check.error}</Notice>}
    </div>
  );
}

function Requirements({ item }: { item: CatalogItem }) {
  const { t } = useTx();
  const reqs = (item.reviewRequirements ?? []) as ReviewRequirement[];
  if (!reqs.length) return null;
  const review = item.marketplace?.providerReview;
  return (
    <section className={s.section}>
      <h3>{t('mkt.sheet.requirements')}</h3>
      <ul className={s.list}>{reqs.map((r) => <li key={r}>{t(`mkt.req.${r}`)}</li>)}</ul>
      {review && <p className="fine m-0">{t('mkt.sheet.review', { state: t(`mkt.review.${review}`) })}</p>}
    </section>
  );
}

/** Connected: access and reconnect, account, health and its history, sync, logs, webhook, disconnect. */
function ConnectionDetails({ item, connection, onChanged }: { item: CatalogItem; connection: ConnectionView; onChanged: () => Promise<void> | void }) {
  const { t, locale } = useTx();
  const { org } = useOrg();
  const session = useSession();
  const [confirm, confirmDialog] = useConfirm(locale);
  const [editing, setEditing] = useState<'credentials' | 'settings' | null>(null);
  const [picking, setPicking] = useState(false);
  const [revocation, setRevocation] = useState<{ attempted: boolean; revoked: boolean; note: string } | null>(null);
  const logs = useApi<{ items: Array<{ id: number; level: string; message: string; createdAt: string }> }>(`/o/${org.id}/integrations/connections/${connection.id}/logs?limit=30`);
  const runs = useApi<{ items: Array<{ id: string; status: string; startedAt: string }> }>(connection.category === 'pos' ? `/o/${org.id}/integrations/connections/${connection.id}/sync-runs` : null);
  const reconnect = useOAuthStart(item.id);
  const act = useAction(async (action: 'health' | 'enable' | 'disable' | 'revoke') => {
    if (action === 'revoke' && !(await confirm({ title: t('mkt.sheet.disconnectTitle', { provider: item.name }), body: t('mkt.sheet.disconnectBody'),
      confirmLabel: t('mkt.sheet.disconnect'), tone: 'danger' }))) return;
    const r = await session.call<{ providerRevocation?: { attempted: boolean; revoked: boolean; note: string } | null }>(
      `/o/${org.id}/integrations/connections/${connection.id}/${action}`, { method: 'POST' });
    if (action === 'revoke' && r.providerRevocation) setRevocation(r.providerRevocation);
    await onChanged();
    await logs.reload();
  });
  const health = (connection.health ?? {}) as { ok?: boolean | null; transient?: boolean };
  const expires = typeof connection.config.tokenExpiresAt === 'string' ? connection.config.tokenExpiresAt : null;
  const refreshable = connection.provider === 'snapchat_ads';
  const oauthConnected = connection.authType === 'oauth' && connection.config.tokenSource === 'platform_app';
  const lastSync = (runs.data?.items ?? []).find((r) => r.status === 'succeeded')?.startedAt ?? null;
  const when = (v: string | null | undefined) => (v ? dateTime(v, locale) : t('intg.diag.never'));
  const history = (logs.data?.items ?? []).filter((l) => /^Health check|^Permission check|^Access token/.test(l.message)).slice(0, 8);
  const hasAccount = !!ACCOUNT_KEY[connection.provider] && connection.authType === 'oauth';
  return (
    <>
      <section className={s.section}>
        <h3>{t('mkt.sheet.access')}</h3>
        <KeyValueList items={[
          { key: 'env', label: t('intg.env.label'), value: <Badge tone={connection.environment === 'live' ? 'info' : 'sandbox'}>{connection.environment === 'live' ? t('intg.env.liveBadge') : t('intg.env.testBadge')}</Badge> },
          { key: 'via', label: t('mkt.sheet.method'), value: t(`mkt.method.${oauthConnected ? 'oauth' : item.connectMethod === 'embedded_signup' && connection.config.onboarding === 'embedded_signup' ? 'embedded_signup' : 'api_key'}`) },
          { key: 'exp', label: t('mkt.sheet.expiry'), value: refreshable ? t('mkt.sheet.refreshAuto') : expires ? t('mkt.sheet.expires', { date: dateTime(expires, locale) }) : t('mkt.sheet.noExpiry') },
          { key: 'cred', label: t('connect.int.credentials'), value: <code dir="ltr">{connection.credentialsHint ?? '—'}</code> },
        ]} />
        <div className="row gap-6">
          {oauthConnected && <button type="button" className="btn btn-sm" disabled={reconnect.pending || !item.oauthConfigured} onClick={() => reconnect.run()}>{t('mkt.sheet.reconnect')}</button>}
          {!oauthConnected && <button type="button" className="btn btn-sm" onClick={() => setEditing('credentials')}>{t('mkt.sheet.reconnect')}</button>}
          {item.fields.config.length > 0 && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing('settings')}>{t('intg.action.editSettings')}</button>}
          {hasAccount && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicking(true)}>{t(pickerKey(connection.provider, connection.config[ACCOUNT_KEY[connection.provider]!] ? 'change' : 'choose'))}</button>}
        </div>
        {reconnect.error && <Notice tone="danger">{reconnect.error}</Notice>}
      </section>
      <section className={s.section}>
        <h3>{t('mkt.sheet.permissions')}</h3>
        <Permissions connection={connection} />
      </section>
      <section className={s.section}>
        <h3>{t('connect.int.health')}</h3>
        <KeyValueList items={[
          { key: 'h', label: t('connect.int.health'), value: <Badge tone={health.ok === true ? 'ok' : health.ok === false ? (health.transient ? 'warn' : 'danger') : 'neutral'}>
            {health.ok === true ? t('intg.diag.healthOk') : health.ok === false ? t(health.transient ? 'intg.diag.healthUnreachable' : 'intg.diag.healthFailed') : t('intg.diag.healthUnknown')}</Badge> },
          { key: 'ls', label: t('intg.diag.lastSuccess'), value: when(connection.lastSuccessAt) },
          { key: 'lf', label: t('intg.diag.lastFailure'), value: when(connection.lastFailureAt) },
          ...(connection.category === 'pos' ? [{ key: 'sync', label: t('mkt.sheet.lastSync'), value: when(lastSync) }] : []),
          ...(connection.lastError ? [{ key: 'le', label: t('intg.diag.error'), value: <bdi dir="ltr">{connection.lastError}</bdi> }] : []),
        ]} />
        <div><button type="button" className="btn btn-sm" disabled={act.pending} onClick={() => act.run('health')}>{t('connect.int.check')}</button></div>
        <strong className="fine">{t('mkt.sheet.healthHistory')}</strong>
        {history.length === 0 ? <p className="fine m-0">{t('mkt.sheet.noHistory')}</p> : (
          <ul className={s.plain}>{history.map((l) => (
            <li key={l.id}><Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warn' : 'ok'}>{l.level}</Badge> {dateTime(l.createdAt, locale)} — <bdi>{l.message}</bdi></li>))}</ul>
        )}
      </section>
      {connection.webhook && <section className={s.section}><WebhookPanel webhook={connection.webhook} /></section>}
      <section className={s.section}>
        <h3>{t('connect.int.logs')}</h3>
        <ul className={s.plain}>{(logs.data?.items ?? []).slice(0, 15).map((l) => (
          <li key={l.id}><Badge tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warn' : 'neutral'}>{l.level}</Badge> {dateTime(l.createdAt, locale)} — <bdi>{l.message}</bdi></li>))}</ul>
      </section>
      <section className={s.section}>
        {revocation && <Notice tone={revocation.revoked ? 'ok' : 'warn'}>{t(revocation.revoked ? 'intg.revoke.providerOk' : revocation.attempted ? 'intg.revoke.providerUnconfirmed' : 'intg.revoke.providerManual')} <bdi dir="ltr">{revocation.note}</bdi></Notice>}
        {act.error && <Notice tone="danger">{act.error}</Notice>}
        <div className="row gap-6">
          <button type="button" className="btn btn-sm btn-ghost" disabled={act.pending} onClick={() => act.run(connection.enabled ? 'disable' : 'enable')}>
            {t(connection.enabled ? 'connect.channels.disable' : 'connect.channels.enable')}</button>
          {connection.status !== 'sandbox' && <button type="button" className="btn btn-sm btn-ghost btn-danger" disabled={act.pending} onClick={() => act.run('revoke')}>{t('mkt.sheet.disconnect')}</button>}
        </div>
      </section>
      {confirmDialog}
      {editing && <EditConnection connection={connection} spec={item} mode={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChanged(); }} />}
      {picking && <AccountPicker connection={connection} onClose={() => setPicking(false)} onSaved={async () => { setPicking(false); await onChanged(); }} />}
    </>
  );
}

export function ProviderSheet({ card, item, connection, onClose, onChanged }: {
  card: MarketCard; item: CatalogItem | null; connection: ConnectionView | null; onClose: () => void; onChanged: () => Promise<void> | void;
}) {
  const { t } = useTx();
  const { org } = useOrg();
  const live = connection && connection.status !== 'revoked' ? connection : null;
  const action = connectAction(card, org.id, item?.oauthConfigured ?? null);
  return (
    <Sheet open onClose={onClose} size="lg" title={<span className={s.sheetHead}><CardLogo card={card} /><bdi>{card.name}</bdi></span>}
      description={`${t(`mkt.category.${card.category}`)} · ${t(`mkt.method.${card.connectMethod}`)}`}>
      <section className={s.section}>
        <div className="row gap-6"><span className="fine">{t('mkt.sheet.status')}</span><StatusChip status={card.status} /></div>
        {card.reasons.length > 0 && <ul className={s.reasons} aria-label={t('mkt.sheet.why')}>{card.reasons.map((r) => <li key={r}>{t(`mkt.reason.${r}`)}</li>)}</ul>}
      </section>
      {!live && <section className={s.section}><h3>{t('mkt.connect')}</h3><ConnectSection card={card} item={item} action={action} onDone={async () => { await onChanged(); }} /></section>}
      {live && item && <ConnectionDetails item={item} connection={live} onChanged={onChanged} />}
      {item?.readinessDetail && (
        <section className={s.section}>
          <h3>{t('mkt.sheet.capabilities')}</h3>
          <p className="fine m-0">{t('mkt.verificationHelp')}</p>
          <CapabilityTable detail={item.readinessDetail} provider={item.name} />
        </section>
      )}
      {item && <Requirements item={item} />}
    </Sheet>
  );
}
