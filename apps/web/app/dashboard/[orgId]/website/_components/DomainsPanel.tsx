'use client';
import { useState, type FormEvent } from 'react';
import type { CustomDomainView } from '@resuto/contracts';
import { Badge, EmptyState, Notice, Skeleton, useConfirm, useToast, type Tone } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';

const STATUS_TONE: Record<string, Tone> = { pending_verification: 'warn', verified: 'info', provisioning: 'info', active: 'ok', failed: 'danger', removed: 'neutral' };

function CopyValue({ value, label }: { value: string; label: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  return (
    <span className="ws-copy">
      <code dir="ltr">{value}</code>
      <button type="button" className="btn btn-ghost btn-sm" aria-label={`${t('studio.domains.copy')} ${label}`}
        onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } }}>
        {copied ? '✓' : t('studio.domains.copy')}
      </button>
    </span>
  );
}

export function DomainsPanel({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const { t, locale } = useT();
  const session = useSession();
  const toast = useToast();
  const [confirm, dialog] = useConfirm(locale);
  const domains = useApi<{ items: CustomDomainView[]; provider: { id: string; readiness: string } }>(`/o/${orgId}/studio/domains`);
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.show({ message: ok, tone: 'ok' });
      await domains.reload();
      return true;
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (await run('add', () => session.call(`/o/${orgId}/studio/domains`, { body: { hostname: hostname.trim().toLowerCase() } }), t('studio.domains.added'))) setHostname('');
  };

  return (
    <section className="card">
      {dialog}
      <h2>{t('studio.domains.title')}</h2>
      <p className="fine">{t('studio.domains.hint')}</p>
      {domains.data && (
        <p className="fine">
          {t('studio.domains.provider')}: <Badge tone={domains.data.provider.id === 'manual' ? 'sandbox' : 'info'}>
            {domains.data.provider.id === 'manual' ? t('studio.domains.providerManual') : `Vercel · ${t('studio.domains.unverifiedAdapter')}`}
          </Badge>
        </p>
      )}
      {canManage && (
        <form className="row" onSubmit={add} style={{ marginBlock: 12 }}>
          <label className="sr-only" htmlFor="ws-domain">{t('studio.domains.hostname')}</label>
          <input id="ws-domain" className="input" style={{ flex: 1, minWidth: 200 }} dir="ltr" placeholder="www.example.com" value={hostname}
            onChange={(e) => setHostname(e.target.value)} pattern="([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}" required />
          <button className="btn btn-primary" disabled={busy === 'add'}>{t('studio.domains.add')}</button>
        </form>
      )}
      {domains.error ? <Notice tone="danger">{domains.error.message}</Notice> : !domains.data ? <Skeleton lines={3} /> : !domains.data.items.length ? (
        <EmptyState title={t('studio.domains.emptyTitle')}>{t('studio.domains.emptyBody')}</EmptyState>
      ) : (
        <div className="stack">
          {domains.data.items.map((d) => (
            <article key={d.id} className="ws-domain">
              <div className="spread">
                <strong dir="ltr">{d.hostname}</strong>
                <span className="row gap-6">
                  <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>{t(`studio.domains.status.${d.status}`)}</Badge>
                  {d.status !== 'pending_verification' && <Badge tone={d.sslStatus === 'issued' ? 'ok' : 'neutral'}>HTTPS: {t(`studio.domains.ssl.${d.sslStatus}`)}</Badge>}
                </span>
              </div>
              <ol className="ws-steps">
                <li data-done={d.status !== 'pending_verification' && d.status !== 'failed'}>
                  <strong>{t('studio.domains.step1')}</strong>
                  <table className="data ws-dns">
                    <thead><tr><th>{t('studio.domains.type')}</th><th>{t('studio.domains.name')}</th><th>{t('studio.domains.value')}</th></tr></thead>
                    <tbody><tr><td>TXT</td><td><CopyValue value={d.verificationRecord.name} label={t('studio.domains.name')} /></td><td><CopyValue value={d.verificationRecord.value} label={t('studio.domains.value')} /></td></tr></tbody>
                  </table>
                </li>
                <li data-done={d.status === 'active'}>
                  <strong>{t('studio.domains.step2')}</strong>
                  {d.routingRecords.length ? (
                    <table className="data ws-dns">
                      <thead><tr><th>{t('studio.domains.type')}</th><th>{t('studio.domains.name')}</th><th>{t('studio.domains.value')}</th></tr></thead>
                      <tbody>{d.routingRecords.map((r, i) => <tr key={i}><td>{r.type}</td><td><CopyValue value={r.name} label={t('studio.domains.name')} /></td><td><CopyValue value={r.value} label={t('studio.domains.value')} /></td></tr>)}</tbody>
                    </table>
                  ) : <p className="fine">{t('studio.domains.routingAfterVerify')}</p>}
                </li>
              </ol>
              {d.instructions.length > 0 && <ul className="fine">{d.instructions.map((x, i) => <li key={i}>{x}</li>)}</ul>}
              {d.lastError && <Notice tone="warn">{d.lastError}</Notice>}
              <p className="fine">{d.lastCheckedAt ? t('studio.domains.lastChecked', { at: dateTime(d.lastCheckedAt, locale) }) : t('studio.domains.notChecked')}</p>
              {canManage && (
                <div className="row">
                  {(d.status === 'pending_verification' || d.status === 'failed' || d.status === 'verified') && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy === d.id} onClick={() => void run(d.id, () => session.call(`/o/${orgId}/studio/domains/${d.id}/verify`, { body: {} }))}>{t('studio.domains.verify')}</button>
                  )}
                  {d.status === 'provisioning' && (
                    <button type="button" className="btn btn-sm" disabled={busy === d.id} onClick={() => void run(d.id, () => session.call(`/o/${orgId}/studio/domains/${d.id}/refresh`, { body: {} }))}>{t('studio.domains.checkHosting')}</button>
                  )}
                  <button type="button" className="btn btn-sm btn-danger" disabled={busy === d.id}
                    onClick={async () => { if (await confirm({ title: t('studio.domains.removeTitle', { host: d.hostname }), body: t('studio.domains.removeBody'), confirmLabel: t('studio.domains.remove'), tone: 'danger' })) void run(d.id, () => session.call(`/o/${orgId}/studio/domains/${d.id}`, { method: 'DELETE' })); }}>
                    {t('studio.domains.remove')}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
