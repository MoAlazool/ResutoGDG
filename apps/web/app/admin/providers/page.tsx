'use client';
// 21-INT operator console (plan §6.3): Resuto's own provider apps. Platform staff read it (secrets masked: only
// "set" and the last four characters); superadmins save and delete. The API enforces every role check
// (/v1/admin/providers); this page only hides what a role cannot do. Nothing here claims a capability is verified:
// the checklist counts recorded acceptance runs, and there are none until scripts/providers/acceptance.mjs runs.
import { useState, type FormEvent } from 'react';
import type { AdminProviderAppView, ProviderAppInput, ProviderAppReviewStatus } from '@resuto/contracts';
import { Badge, Card, Field, Notice, PageHeader, SelectField, Skeleton, TextareaField, useAction, useConfirm } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { useAdmin } from '../AdminShell';
import type { AdminStrings } from '../strings';
import st from './providers.module.css';

const SOURCE_TONE = { database: 'ok', environment: 'info', none: 'warn' } as const;
/** PROVIDER_APP_REVIEW_STATUSES (kept local: a runtime import would add the console's schemas to the shared contracts chunk). */
const REVIEW_STATUSES: ProviderAppReviewStatus[] = ['unknown', 'not_submitted', 'in_review', 'approved', 'rejected'];
const key = (s: AdminStrings, k: string) => (s as unknown as Record<string, string>)[k] ?? k;

export default function AdminProvidersPage() {
  const { s } = useAdmin();
  const apps = useApi<{ items: AdminProviderAppView[] }>('/admin/providers');
  if (apps.error) return <Notice tone="danger">{s.loadError} <button className="btn btn-sm" onClick={() => void apps.reload()}>{s.retry}</button></Notice>;
  if (!apps.data) return <Card><Skeleton lines={8} /></Card>;
  return (
    <div className={st.page}>
      <PageHeader title={s.providersTitle} subtitle={s.providersSub} />
      {apps.data.items.map((a) => <ProviderApp key={a.provider} app={a} onSaved={() => apps.reload()} />)}
    </div>
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
      }}>{copied ? s.copied : s.copy}</button>
    </li>
  );
}

function ProviderApp({ app, onSaved }: { app: AdminProviderAppView; onSaved: () => Promise<void> | void }) {
  const { s, can } = useAdmin();
  const { locale } = useT();
  const writer = can('providers:write');
  const done = app.checklist.filter((c) => c.done).length;
  const label = (k: string) => {
    if (k.startsWith('config.')) return s.chk_config.replace('{name}', key(s, `cfg_${k.slice(7)}`));
    if (k.startsWith('secret.')) return s.chk_secret.replace('{name}', key(s, `sec_${k.slice(7)}`));
    return key(s, `chk_${k}`);
  };
  return (
    <Card>
      <div className={st.head}>
        <h2 className="m-0"><bdi>{app.name}</bdi></h2>
        <div className={st.check}>
          <span className="fine">{s.source}</span><Badge tone={SOURCE_TONE[app.source]}>{key(s, `src_${app.source}`)}</Badge>
          <Badge tone={app.reviewStatus === 'approved' ? 'ok' : 'neutral'}>{s.reviewTitle}: {key(s, `rv_${app.reviewStatus}`)}</Badge>
          <span className="fine" dir="ltr">{done} / {app.checklist.length}</span>
        </div>
      </div>
      <p className="fine">{s.serves.replace('{list}', app.serves.join(', '))}{app.updatedAt ? ` · ${dateTime(app.updatedAt, locale)}` : ''}</p>
      <div className={st.cols}>
        <section className={st.block}>
          <h3>{s.checklistTitle}</h3>
          <ul className={st.list}>{app.checklist.map((c) => (
            <li key={c.key} className={st.check}><Badge tone={c.done ? 'ok' : 'warn'}>{c.done ? s.varSet : s.varUnset}</Badge> <span>{label(c.key)}</span></li>))}</ul>
          <p className="fine m-0">{app.acceptance.passed > 0 ? s.acceptance.replace('{n}', String(app.acceptance.passed)) : s.unverified}</p>
          {app.blockers.length > 0 && <p className="fine m-0">{s.blockers.replace('{list}', app.blockers.join(', '))}</p>}
        </section>
        <section className={st.block}>
          <h3>{s.registerTitle}</h3>
          <strong className="fine">{s.redirectUris}</strong>
          <ul className={st.list}>{app.redirectUris.map((u) => <CopyUrl key={u} url={u} />)}</ul>
          {app.webhooks.length > 0 && <>
            <strong className="fine">{s.webhookUrls}</strong>
            <ul className={st.list}>{app.webhooks.map((w) => <CopyUrl key={w.url} url={w.url} />)}</ul>
          </>}
          <strong className="fine">{s.permissionsToRequest}</strong>
          <p className="fine m-0" dir="ltr">{app.reviewPermissions.join(', ')}</p>
        </section>
        <section className={st.block}>
          <h3>{s.fallbackTitle}</h3>
          <ul className={st.list}>{app.environmentFallback.map((v) => (
            <li key={v.name} className={st.check}><code dir="ltr">{v.name}</code> <Badge tone={v.set ? 'ok' : 'neutral'}>{v.set ? s.varSet : s.varUnset}</Badge></li>))}</ul>
        </section>
      </div>
      {writer ? <AppForm app={app} onSaved={onSaved} /> : <p className="fine">{s.readOnly}</p>}
    </Card>
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
    if (!(await confirm({ title: s.deleteApp, body: s.deleteConfirm.replace('{name}', app.name), tone: 'danger', confirmLabel: s.deleteApp }))) return;
    await session.call(`/admin/providers/${app.provider}`, { method: 'DELETE' });
    await onSaved();
  });
  return (
    <form className={st.form} onSubmit={save.run} aria-label={app.name}>
      {confirmDialog}
      <div className={st.cols}>
        <div className={st.block}>
          <SelectField label={s.environmentLabel} value={environment} onChange={(e) => setEnvironment(e.target.value as 'sandbox' | 'live')}>
            <option value="live">{s.env_live}</option><option value="sandbox">{s.env_sandbox}</option>
          </SelectField>
          <Field label={s.appId} value={appId} dir="ltr" autoComplete="off" onChange={(e) => setAppId(e.target.value)} />
          {Object.keys(app.configIds).length > 0 && <strong className="fine">{s.configTitle}</strong>}
          {Object.keys(app.configIds).map((k) => (
            <Field key={k} label={key(s, `cfg_${k}`)} value={configIds[k] ?? ''} dir="ltr" autoComplete="off" onChange={(e) => setConfigIds({ ...configIds, [k]: e.target.value })} />
          ))}
        </div>
        <div className={st.block}>
          <strong className="fine">{s.secretsTitle}</strong>
          {Object.entries(app.secrets).map(([k, v]) => (
            <div key={k} className={st.secret}>
              <Field label={key(s, `sec_${k}`)} type="password" autoComplete="new-password" dir="ltr" value={secrets[k] ?? ''} placeholder={s.secretNew}
                hint={v.set ? (v.hint ? s.secretSet.replace('{hint}', v.hint) : s.secretSetNoHint) : s.secretUnset}
                onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />
              {v.set && app.source !== 'environment' && (
                <label className={`fine ${st.secretRow}`}><input type="checkbox" checked={!!clear[k]} onChange={(e) => setClear({ ...clear, [k]: e.target.checked })} /> {s.secretClear}</label>
              )}
            </div>
          ))}
        </div>
        <div className={st.block}>
          <SelectField label={s.reviewTitle} value={reviewStatus} onChange={(e) => setReviewStatus(e.target.value as typeof reviewStatus)} hint={s.reviewHelp}>
            {REVIEW_STATUSES.map((r) => <option key={r} value={r}>{key(s, `rv_${r}`)}</option>)}
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
