'use client';
// Inbox > Channels, Meta parts: WhatsApp Embedded Signup v4 (INT-13), Messenger / Instagram Direct channels (INT-21 /
// FT-05) and re-verification of provider channels (INT-03).
// Embedded Signup docs (2026-10-20): https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
import { useEffect, useRef, useState } from 'react';
import { Badge, Card, Field, Notice, SelectField, useAction } from '@resuto/ui';
import { documentAllowsMetaSdk } from '@/lib/csp';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

export interface MetaChannel {
  id: string; kind: string; transport: string; sandbox: boolean; displayName: string; status: string; verified: boolean | null; webhookSubscribed: boolean | null;
}

/** Badge for a channel's network. */
export function ChannelKindBadge({ c }: { c: MetaChannel }) {
  const { t } = useT();
  if (c.sandbox) return <Badge tone="sandbox">{t('connect.sandbox.badge')}</Badge>;
  return <Badge tone="info">{t(`connect.channels.kind.${c.kind}`)}</Badge>;
}

/** Verified state and the "Verify" action for WhatsApp / Messenger / Instagram channels. */
export function VerifyCell({ c, onDone }: { c: MetaChannel; onDone: () => Promise<void> | void }) {
  const { t } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const verify = useAction(async () => { await session.call(`/o/${org.id}/connect/channels/${c.id}/verify`, { method: 'POST' }).finally(() => onDone()); });
  if (c.sandbox) return null;
  return (
    <div className="row gap-6 wrap">
      <Badge tone={c.verified ? 'ok' : 'danger'}>{c.verified ? t('connect.channels.verified') : t('connect.channels.unverified')}</Badge>
      {c.verified && c.webhookSubscribed === false && <Badge tone="warn">{t('connect.channels.notSubscribed')}</Badge>}
      {can('connect:manage') && <button className="btn btn-sm btn-ghost" disabled={verify.pending} onClick={() => verify.run()}>{t('connect.channels.verify')}</button>}
      {verify.error && <span className="fine" role="alert">{verify.error}</span>}
    </div>
  );
}

interface SessionInfo { waba_id?: string; phone_number_id?: string; business_id?: string; event?: string }
interface SignupConfig { available: boolean; appId: string | null; configId: string | null; graphVersion: string; sdkUrl: string; missing: string[] }
type FBType = { init(o: Record<string, unknown>): void; login(cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>): void };
declare global { interface Window { FB?: FBType; fbAsyncInit?: () => void } }

/** Loads Meta's SDK once (script added by trusted code; the page CSP allows it under 'strict-dynamic'). */
function loadSdk(cfg: SignupConfig): Promise<FBType> {
  return new Promise((resolve, reject) => {
    if (window.FB) { resolve(window.FB); return; }
    window.fbAsyncInit = () => { window.FB!.init({ appId: cfg.appId, autoLogAppEvents: true, xfbml: true, version: cfg.graphVersion }); resolve(window.FB!); };
    const s = document.createElement('script');
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous'; s.src = cfg.sdkUrl;
    s.onerror = () => reject(new Error('sdk'));
    document.head.appendChild(s);
  });
}

/** Query flag of the full page load the launcher asks for (see loadedWithSdkPolicy). */
export const SIGNUP_RELOAD_PARAM = 'signup';

/**
 * Whether this document was loaded with the Inbox's Content-Security-Policy (the one that lets Meta's SDK frame
 * www.facebook.com). Staff usually reach the Inbox by client-side navigation from another dashboard page, whose
 * stricter policy the document keeps; the launcher then reloads the Inbox before opening Meta's window.
 */
function loadedWithSdkPolicy(): boolean {
  const nav = (typeof performance !== 'undefined' && performance.getEntriesByType?.('navigation')[0]) as PerformanceNavigationTiming | undefined;
  // Without navigation timing, trust a document that was just hard-loaded for the signup.
  const loaded = nav?.name ?? (new URLSearchParams(window.location.search).get(SIGNUP_RELOAD_PARAM) === 'whatsapp' ? window.location.href : null);
  return documentAllowsMetaSdk(loaded);
}

/** WhatsApp Embedded Signup v4: Meta's window returns a 30-second code plus the WABA and number ids; the API does the rest. */
export function EmbeddedSignupCard({ onDone }: { onDone: () => Promise<void> | void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const cfg = useApi<SignupConfig>(`/o/${org.id}/connect/whatsapp/embedded-signup`);
  const [name, setName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const info = useRef<SessionInfo | null>(null);
  const startButton = useRef<HTMLButtonElement | null>(null);
  const [reloaded, setReloaded] = useState(false);

  // Back from the full page load the launcher asked for: say so, and put the focus on the button once it is enabled
  // (Meta's window must be opened by a click).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get(SIGNUP_RELOAD_PARAM) !== 'whatsapp') return;
    setReloaded(true);
    setNote(t('connect.signup.reloaded'));
    q.delete(SIGNUP_RELOAD_PARAM);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
  }, [t]);
  const available = !!cfg.data?.available;
  useEffect(() => { if (reloaded && available) startButton.current?.focus(); }, [reloaded, available]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname)) return;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (String(data.event).startsWith('FINISH')) info.current = { ...data.data, event: data.event };
        else if (data.event === 'CANCEL') setNote(t('connect.signup.cancelled'));
      } catch { /* not ours */ }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [t]);

  const start = useAction(async () => {
    setNote(null);
    info.current = null;
    if (!loadedWithSdkPolicy()) {
      // Reached by client-side navigation: load the Inbox itself so its policy (Meta's hosts) applies, then start again.
      window.location.assign(`${window.location.pathname}?${SIGNUP_RELOAD_PARAM}=whatsapp`);
      return;
    }
    const c = cfg.data!;
    const FB = await loadSdk(c);
    const code = await new Promise<string | null>((resolve) => FB.login((r) => resolve(r.authResponse?.code ?? null),
      { config_id: c.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } }));
    // The session event usually arrives just before the login callback; give it a moment.
    for (let i = 0; i < 20 && !info.current; i++) await new Promise((r) => setTimeout(r, 100));
    const s = info.current as SessionInfo | null;
    if (!code || !s?.waba_id || !s.phone_number_id) { setNote(t('connect.signup.incomplete')); return; }
    await session.call(`/o/${org.id}/connect/whatsapp/embedded-signup`, { body: {
      code, wabaId: s.waba_id, phoneNumberId: s.phone_number_id, businessId: s.business_id ?? null,
      event: s.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING' ? s.event : 'FINISH', displayName: name.trim() || t('connect.signup.defaultName'),
    } });
    setNote(t('connect.signup.done'));
    await onDone();
  });

  return (
    <Card title={t('connect.signup.title')}>
      <p className="fine">{t('connect.signup.body')}</p>
      {cfg.data && !cfg.data.available ? (
        <Notice tone="warn">{t('connect.signup.notConfigured', { env: cfg.data.missing.join(', ') })}</Notice>
      ) : (
        <>
          <Field label={t('connect.channels.name')} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          <button ref={startButton} className="btn btn-primary" disabled={!cfg.data?.available || start.pending} onClick={() => start.run()}>{t('connect.signup.start')}</button>
        </>
      )}
      {note && <Notice tone="info">{note}</Notice>}
      {start.error && <Notice tone="danger">{start.error}</Notice>}
    </Card>
  );
}

/** Messenger / Instagram Direct channel from a "Facebook Messenger & Instagram" connection (Page token). */
export function PageChannelCard({ onDone }: { onDone: () => Promise<void> | void }) {
  const { t } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const conns = useApi<{ items: Array<{ id: string; provider: string; status: string; config?: Record<string, unknown> }> }>(
    can('integrations:manage') ? `/o/${org.id}/integrations/connections?category=messaging` : null);
  const pages = (conns.data?.items ?? []).filter((c) => c.provider === 'meta_pages' && c.status !== 'revoked');
  const [form, setForm] = useState({ kind: 'messenger', displayName: '', connectionId: '' });
  const create = useAction(async () => {
    await session.call(`/o/${org.id}/connect/channels`, { body: { transport: 'meta_page', kind: form.kind, displayName: form.displayName,
      connectionId: form.connectionId || pages[0]!.id } });
    setForm({ ...form, displayName: '' });
    await onDone();
  });
  return (
    <Card title={t('connect.pages.title')}>
      <p className="fine">{t('connect.pages.body')}</p>
      {pages.length === 0 ? <p className="fine">{t('connect.pages.needConnection')} <a href={`/dashboard/${org.id}/integrations`}>{t('nav.integrations')}</a></p> : (
        <form onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
          <div className="form-row">
            <SelectField label={t('connect.pages.kind')} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="messenger">{t('connect.channels.kind.messenger')}</option><option value="instagram">{t('connect.channels.kind.instagram')}</option>
            </SelectField>
            {pages.length > 1 && (
              <SelectField label={t('connect.pages.connection')} value={form.connectionId || pages[0]!.id} onChange={(e) => setForm({ ...form, connectionId: e.target.value })}>
                {pages.map((p) => <option key={p.id} value={p.id}>{String(p.config?.pageId ?? p.id)}</option>)}
              </SelectField>
            )}
          </div>
          <Field label={t('connect.channels.name')} value={form.displayName} required maxLength={80} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
          <p className="fine">{t('connect.pages.window')}</p>
          <button className="btn btn-primary" disabled={create.pending}>{t('action.create')}</button>
        </form>
      )}
      {create.error && <Notice tone="danger">{create.error}</Notice>}
    </Card>
  );
}
