'use client';
// 21-INT operator console (plan §6.3): Resuto's own provider apps. Platform staff read it (secrets masked: only
// "set" and the last four characters); superadmins save and delete. The API enforces every role check
// (/v1/admin/providers); this page only hides what a role cannot do. Nothing here claims a capability is verified:
// the checklist counts recorded acceptance runs, and there are none until scripts/providers/acceptance.mjs runs.
// 21-ADMIN: SettingsPage with one section per app (logo, readiness progress), copy buttons for the URLs to register.
import { useState, type FormEvent } from 'react';
import type { AdminProviderAppView, ProviderAppInput, ProviderAppReviewStatus } from '@resuto/contracts';
import { Badge, ErrorState, Field, Notice, ProviderLogo, SelectField, SettingsPage, TextareaField, useAction, useConfirm, PROVIDER_LOGOS } from '@resuto/ui';
import { AreaSkeleton } from '@/components/shell/AreaSkeleton';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { AdminIcon } from '../admin-icons';
import { useAdmin } from '../AdminShell';
import { PROVIDER_APP_LOGO, SOURCE_TONE, checklistLabel, readiness } from '../console';
import { fill, pickString } from '../text';
import st from './providers.module.css';

/** PROVIDER_APP_REVIEW_STATUSES (kept local: a runtime import would add the console's schemas to the shared contracts chunk). */
const REVIEW_STATUSES: ProviderAppReviewStatus[] = ['unknown', 'not_submitted', 'in_review', 'approved', 'rejected'];
const anchor = (p: string) => `provider-${p}`;
const anchorHref = (p: string) => '#' + anchor(p);
/** Marks are square; a wordmark (Foodics) is drawn shorter so it keeps the row's height. */
const logoSize = (p: AdminProviderAppView['provider'], square: number) => (PROVIDER_LOGOS[PROVIDER_APP_LOGO[p]].aspect > 2 ? Math.round(square * 0.6) : square);

export default function AdminProvidersPage() {
  const { s } = useAdmin();
  const { locale } = useT();
  const apps = useApi<{ items: AdminProviderAppView[] }>('/admin/providers');
  const [active, setActive] = useState<string | null>(null);
  if (apps.error && !apps.data) {
    return <ErrorState locale={locale} error={{ status: apps.error.status, code: apps.error.code, message: apps.error.message, requestId: apps.error.requestId }} onRetry={apps.reload} />;
  }
  if (!apps.data) return <AreaSkeleton template="settings" />;
  const items = apps.data.items;
  return (
    <SettingsPage header={{ title: s.providersTitle, subtitle: s.providersSub }} navLabel={s.providers}
      active={active ?? items[0]?.provider ?? ''} onSelect={setActive}
      sections={items.map((a) => {
        const r = readiness(s, a);
        return {
          key: a.provider, href: anchorHref(a.provider),
          label: (
            <span className={st.navItem}>
              <ProviderLogo provider={PROVIDER_APP_LOGO[a.provider]} size={logoSize(a.provider, 18)} decorative />
              <span className={st.navText}><bdi>{a.name}</bdi><small className="num">{r.summary}</small></span>
            </span>
          ),
        };
      })}>
      {items.map((a) => <ProviderApp key={a.provider} app={a} onSaved={() => apps.reload()} />)}
    </SettingsPage>
  );
}

function CopyUrl({ url }: { url: string }) {
  const { s } = useAdmin();
  const [copied, setCopied] = useState(false);
  return (
    <li className={st.url}>
      <code dir="ltr">{url}</code>
      <button type="button" className="btn btn-sm btn-ghost" onClick={async () => {
        try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* selectable */ }
      }}>
        <AdminIcon name={copied ? 'copied' : 'copy'} size={14} />
        <span aria-live="polite">{copied ? s.copied : s.copy}</span>
      </button>
    </li>
  );
}

function ProviderApp({ app, onSaved }: { app: AdminProviderAppView; onSaved: () => Promise<void> | void }) {
  const { s, can } = useAdmin();
  const { locale } = useT();
  const writer = can('providers:write');
  const r = readiness(s, app);
  const titleId = `${anchor(app.provider)}-title`;
  return (
    <section className={`panel ${st.app}`} id={anchor(app.provider)} aria-labelledby={titleId} data-provider={app.provider}>
      <header className={st.head}>
        <div className={st.identity}>
          <ProviderLogo provider={PROVIDER_APP_LOGO[app.provider]} size={logoSize(app.provider, 32)} decorative />
          <div>
            <h2 id={titleId} className="m-0"><bdi>{app.name}</bdi></h2>
            <p className="fine m-0">{fill(s.serves, { list: app.serves.join(', ') })}{app.updatedAt ? ` · ${fill(s.lastSaved, { time: dateTime(app.updatedAt, locale) })}` : ''}</p>
          </div>
        </div>
        <div className={st.badges}>
          <span className="fine">{s.source}</span><Badge tone={SOURCE_TONE[app.source]}>{pickString(s, `src_${app.source}`, app.source)}</Badge>
          <Badge tone={app.reviewStatus === 'approved' ? 'ok' : 'neutral'}>{s.reviewTitle}: {pickString(s, `rv_${app.reviewStatus}`, app.reviewStatus)}</Badge>
        </div>
      </header>
      <div className={st.progress}>
        <progress max={Math.max(r.total, 1)} value={r.done} aria-label={`${s.checklistTitle}: ${r.summary}`} />
        <span className="fine num">{r.summary}</span>
      </div>
      <div className={st.cols}>
        <section className={st.block} aria-label={s.checklistTitle}>
          <h3>{s.checklistTitle}</h3>
          <ul className={st.list}>{app.checklist.map((c) => (
            <li key={c.key} className={st.check} data-done={c.done || undefined}>
              <AdminIcon name={c.done ? 'done' : 'todo'} size={16} />
              <span>{checklistLabel(s, c.key)}</span>
              <span className="sr-only">{c.done ? s.chkDone : s.chkTodo}</span>
            </li>))}</ul>
          <p className="fine m-0">{r.acceptance}</p>
          {app.blockers.length > 0 && <p className="fine m-0">{fill(s.blockers, { list: app.blockers.join(', ') })}</p>}
        </section>
        <section className={st.block} aria-label={s.registerTitle}>
          <h3>{s.registerTitle}</h3>
          <strong className="fine">{s.redirectUris}</strong>
          <ul className={st.list}>{app.redirectUris.map((u) => <CopyUrl key={u} url={u} />)}</ul>
          {app.webhooks.length > 0 && <>
            <strong className="fine">{s.webhookUrls}</strong>
            <ul className={st.list}>{app.webhooks.map((w) => <CopyUrl key={w.url} url={w.url} />)}</ul>
          </>}
          <strong className="fine">{s.permissionsToRequest}</strong>
          <ul className={st.chips}>{app.reviewPermissions.map((p) => <li key={p}><code dir="ltr">{p}</code></li>)}</ul>
        </section>
        <section className={st.block} aria-label={s.fallbackTitle}>
          <h3>{s.fallbackTitle}</h3>
          <ul className={st.list}>{app.environmentFallback.map((v) => (
            <li key={v.name} className={st.check}><code dir="ltr">{v.name}</code> <Badge tone={v.set ? 'ok' : 'neutral'}>{v.set ? s.varSet : s.varUnset}</Badge></li>))}</ul>
        </section>
      </div>
      {writer ? <AppForm app={app} onSaved={onSaved} /> : <p className="fine">{s.readOnly}</p>}
    </section>
  );
}

function AppForm({ app, onSaved }: { app: AdminProviderAppView; onSaved: () => Promise<void> | void }) {
  const { s } = useAdmin();
  const { locale } = useT();
  const session = useSession();
  const [confirm, confirmDialog] = useConfirm(locale);
  const [environment, setEnvironment] = useState(app.environment);
  const [appId, setAppId] = useState(app.appId ?? '');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<Record<string, boolean>>({});
  const [configIds, setConfigIds] = useState<Record<string, string>>(Object.fromEntries(Object.entries(app.configIds).map(([k, v]) => [k, v ?? ''])));
  const [reviewStatus, setReviewStatus] = useState(app.reviewStatus);
  const [notes, setNotes] = useState(app.notes ?? '');
  const [flash, setFlash] = useState(false);
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    setFlash(false);
    const body: ProviderAppInput = {
      environment, appId: appId.trim() || null, reviewStatus, notes: notes.trim() || null,
      secrets: Object.fromEntries(Object.keys(app.secrets).flatMap((k): Array<[string, string | null]> => (clear[k] ? [[k, null]] : secrets[k]?.trim() ? [[k, secrets[k]!.trim()]] : []))),
      configIds: Object.fromEntries(Object.keys(app.configIds).map((k) => [k, configIds[k]?.trim() || null])),
    };
    await session.call(`/admin/providers/${app.provider}`, { method: 'PUT', body });
    // Secrets never come back: the form forgets what was typed.
    setSecrets({}); setClear({}); setFlash(true);
    await onSaved();
  });
  const remove = useAction(async () => {
    if (!(await confirm({ title: s.deleteApp, body: fill(s.deleteConfirm, { name: app.name }), tone: 'danger', confirmLabel: s.deleteApp }))) return;
    await session.call(`/admin/providers/${app.provider}`, { method: 'DELETE' });
    await onSaved();
  });
  return (
    <form className={st.form} onSubmit={save.run} aria-label={app.name}>
      {confirmDialog}
      <h3 className={st.formTitle}>{s.formTitle}</h3>
      <div className={st.cols}>
        <div className={st.block}>
          <SelectField label={s.environmentLabel} value={environment} onChange={(e) => setEnvironment(e.target.value as 'sandbox' | 'live')}>
            <option value="live">{s.env_live}</option><option value="sandbox">{s.env_sandbox}</option>
          </SelectField>
          <Field label={s.appId} value={appId} dir="ltr" autoComplete="off" onChange={(e) => setAppId(e.target.value)} />
          {Object.keys(app.configIds).length > 0 && <strong className="fine">{s.configTitle}</strong>}
          {Object.keys(app.configIds).map((k) => (
            <Field key={k} label={pickString(s, `cfg_${k}`, k)} value={configIds[k] ?? ''} dir="ltr" autoComplete="off" onChange={(e) => setConfigIds({ ...configIds, [k]: e.target.value })} />
          ))}
        </div>
        <div className={st.block}>
          <strong className="fine">{s.secretsTitle}</strong>
          <p className="fine m-0">{s.secretsNote}</p>
          {Object.entries(app.secrets).map(([k, v]) => (
            <div key={k} className={st.secret}>
              <Field label={pickString(s, `sec_${k}`, k)} type="password" autoComplete="new-password" dir="ltr" value={secrets[k] ?? ''} placeholder={s.secretNew}
                hint={v.set ? (v.hint ? fill(s.secretSet, { hint: v.hint }) : s.secretSetNoHint) : s.secretUnset}
                onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
              {v.set && app.source !== 'environment' && (
                <label className={`fine ${st.secretRow}`}><input type="checkbox" checked={!!clear[k]} onChange={(e) => setClear({ ...clear, [k]: e.target.checked })} /> {s.secretClear}</label>
              )}
            </div>
          ))}
        </div>
        <div className={st.block}>
          <SelectField label={s.reviewTitle} value={reviewStatus} onChange={(e) => setReviewStatus(e.target.value as typeof reviewStatus)} hint={s.reviewHelp}>
            {REVIEW_STATUSES.map((r) => <option key={r} value={r}>{pickString(s, `rv_${r}`, r)}</option>)}
          </SelectField>
          <TextareaField label={s.notes} value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
        </div>
      </div>
      {save.error && <Notice tone="danger">{save.error}</Notice>}
      {remove.error && <Notice tone="danger">{remove.error}</Notice>}
      {flash && <Notice tone="ok">{s.saved}</Notice>}
      <div className={st.actions}>
        <button className="btn btn-primary" disabled={save.pending}>{s.saveApp}</button>
        {app.updatedAt && <button type="button" className="btn btn-ghost btn-danger" disabled={remove.pending} onClick={() => remove.run()}>{s.deleteApp}</button>}
      </div>
    </form>
  );
}
