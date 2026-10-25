'use client';
import { Suspense, useState } from 'react';
import { EXPORT_KINDS } from '../_ui/kinds';
import { Badge, Card, DataTable, DataTableV2, EmptyState, Notice, SelectField, Skeleton, useAction } from '@resuto/ui';
import { API_URL, newIdempotencyKey } from '@/lib/api';
import { date, dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import dynamic from 'next/dynamic';
import styles from '../_ui/finance.module.css';
import { FinanceFrame, useMoney, usePeriod } from '../_ui/FinanceFrame';

// Account mapping and payouts (FT-23) load after the export centre: they need the full contracts (journal roles).
const setupLoading = () => <div className="card"><Skeleton lines={4} /></div>;
const AccountMapping = dynamic(() => import('../_ui/AccountingSetup').then((m) => m.AccountMapping), { ssr: false, loading: setupLoading });
const Payouts = dynamic(() => import('../_ui/AccountingSetup').then((m) => m.Payouts), { ssr: false, loading: setupLoading });

interface ExportRow { id: string; kind: string; format: string; filename: string; rowCount: number; checksum: string; periodStart: string; periodEnd: string; branchId: string | null; createdAt: string }

/**
 * Export centre (21-MONEY): pick a report for the period and branch above, create it (it downloads at once) and
 * download any earlier file again. Exports are built synchronously and stored with their SHA-256 checksum, so a listed
 * export is ready; the server re-checks the checksum on every download.
 */
function Exports() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call, token } = useSession();
  const p = usePeriod();
  const m = useMoney();
  const list = useApi<{ items: ExportRow[] }>(`/o/${org.id}/finance/exports`);
  const pushes = useApi<{ items: any[]; providers: any[] }>(`/o/${org.id}/finance/accounting/pushes`);
  const conns = useApi<{ items: { id: string; provider: string; environment: string; status: string }[] }>(`/o/${org.id}/finance/accounting/connections`);
  const [kind, setKind] = useState<string>('sales');
  const [done, setDone] = useState<string | null>(null);
  const [journal, setJournal] = useState<any>(null);
  const [picked, setConnectionId] = useState('');
  const connectionId = picked || conns.data?.items[0]?.id || '';
  const range = { from: p.from, to: p.to, ...(p.branchId ? { branchId: p.branchId } : {}) };
  const day = (d: string) => date(`${d}T12:00:00Z`, locale, 'UTC');
  const branchName = (id: string | null) => {
    if (!id) return t('finance.export.allBranches');
    const b = org.branches.find((x) => x.id === id);
    return b ? (locale === 'ar' && b.nameAr ? b.nameAr : b.name) : id.slice(0, 8);
  };

  const download = useAction(async (id: string, filename: string) => {
    // Authenticated download; the server re-checks the stored checksum before it sends the file.
    const res = await fetch(`${API_URL}/v1/o/${org.id}/finance/exports/${id}/download`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const create = useAction(async () => {
    setDone(null);
    const r = await call<ExportRow>(`/o/${org.id}/finance/exports`, { body: { kind, ...range } });
    await list.reload();
    await download.run(r.id, r.filename);
    setDone(r.filename);
  });
  const preview = useAction(async () => setJournal(await call(`/o/${org.id}/finance/accounting/journal?${p.query}`)));
  const push = useAction(async () => { await call(`/o/${org.id}/finance/accounting/push`, { body: { connectionId: connectionId.trim(), ...range, key: newIdempotencyKey() } }); await pushes.reload(); });

  return (
    <div className="stack">
      <Card title={t('finance.export.centre')}>
        <p className="fine mbs-0">{t('finance.export.centreBody')}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (!create.pending) void create.run(); }}>
          <fieldset className={styles.kinds} aria-label={t('finance.export.kind')}>
            {EXPORT_KINDS.map((k) => (
              <label key={k} className={styles.kind} data-kind={k}>
                <span className={styles.kindName}><input type="radio" name="export-kind" value={k} checked={kind === k} onChange={() => setKind(k)} />{t(`finance.export.kind.${k}`)}</span>
                <span className={styles.kindHint}>{t(`finance.export.kindHint.${k}`)}</span>
              </label>
            ))}
          </fieldset>
          <div className={styles.exportActions}>
            <button className="btn btn-primary" aria-busy={create.pending || undefined}>{create.pending ? t('finance.export.creating') : t('finance.export.create')}</button>
            <span className="fine">{t('finance.export.forPeriod', { from: day(p.from), to: day(p.to) })} · {branchName(p.branchId || null)}</span>
          </div>
        </form>
        {done && !create.error && !download.error && <div className="mbs-12" role="status"><Notice tone="ok">{t('finance.export.done', { file: done })}</Notice></div>}
        {(create.error || download.error) && <div className="mbs-12"><Notice tone="danger">{create.error ?? download.error}</Notice></div>}
      </Card>

      <Card title={t('finance.export.history')}>
        {list.error && <Notice tone="danger">{list.error.message}</Notice>}
        {!list.data ? <Skeleton lines={4} /> : (
          <DataTableV2 label={t('finance.export.history')} rows={list.data.items} rowKey={(r) => r.id} empty={<EmptyState title={t('finance.export.empty')} />} columns={[
            { key: 'k', header: t('finance.export.kind'), rowHeader: true, render: (r) => <>{t(`finance.export.kind.${r.kind}`)}<div className="fine"><bdi>{day(r.periodStart)}</bdi> – <bdi>{day(r.periodEnd)}</bdi></div></> },
            { key: 'b', header: t('finance.export.branch'), render: (r) => <bdi>{branchName(r.branchId)}</bdi> },
            { key: 'n', header: t('finance.export.rows'), align: 'end', render: (r) => <span className="num">{r.rowCount}</span> },
            { key: 'c', header: t('finance.export.created'), render: (r) => <span className="num">{dateTime(r.createdAt, locale)}</span> },
            { key: 's', header: t('finance.export.status'), render: (r) => <><Badge tone="ok">{t('finance.export.ready')}</Badge>
              <div className="fine">{t('finance.export.readyHint')}: <code title={r.checksum} dir="ltr" className={styles.checksum}>{r.checksum.slice(0, 12)}…</code></div></> },
            { key: 'd', header: '', align: 'end', render: (r) => <button className="btn btn-sm" aria-busy={download.pending || undefined} onClick={() => { if (!download.pending) void download.run(r.id, r.filename); }}>{t('finance.export.redownload')}</button> },
          ]} />
        )}
      </Card>

      <Card title={t('finance.acc.title')}>
        <p className="fine">{t('finance.acc.body')}</p>
        <p className="fine">{t('finance.acc.kinds')}</p>
        <div className={styles.providers}>
          {(pushes.data?.providers ?? []).map((d: any) => <Badge key={d.id} tone="sandbox">{d.name} · {t('finance.acc.readiness')}</Badge>)}
        </div>
        <button className="btn" aria-busy={preview.pending || undefined} onClick={() => { if (!preview.pending) void preview.run(); }}>{t('finance.acc.preview')}</button>
        {preview.error && <Notice tone="danger">{preview.error}</Notice>}
        {journal && (
          <div className="stack mbs-12">
            <p className="fine">{t('finance.acc.entries', { n: journal.entries.length })}</p>
            {journal.entries.slice(0, 7).map((e: any) => (
              <details key={e.reference}>
                <summary className="cursor-pointer" dir="ltr">{e.date} · {e.reference}</summary>
                <DataTable rows={e.lines.map((l: any, i: number) => ({ ...l, i }))} rowKey={(l: any) => String(l.i)} columns={[
                  { key: 'a', header: t('finance.acc.account'), render: (l: any) => <>{t(`finance.role.${l.role}`)}<div className="fine" dir="ltr">{l.description}</div></> },
                  { key: 'd', header: t('finance.acc.debit'), align: 'end', render: (l: any) => l.debitMinor ? <span dir="ltr">{m(l.debitMinor)}</span> : '' },
                  { key: 'c', header: t('finance.acc.credit'), align: 'end', render: (l: any) => l.creditMinor ? <span dir="ltr">{m(l.creditMinor)}</span> : '' },
                ]} />
              </details>
            ))}
          </div>
        )}
        {can('finance:write') && conns.data && (conns.data.items.length === 0 ? <Notice tone="info">{t('finance.acc.noConnection')}</Notice> : (
          <div className={`form-row ${styles.connect}`}>
            <SelectField label={t('finance.acc.selectConnection')} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              {conns.data.items.map((c) => <option key={c.id} value={c.id}>{c.provider} · {c.environment} · {c.status}</option>)}
            </SelectField>
            <button className={`btn btn-primary ${styles.apply}`} aria-busy={push.pending || undefined} onClick={() => { if (!push.pending && connectionId) void push.run(); }}>{t('finance.acc.push')}</button>
          </div>
        ))}
        {push.error && <Notice tone="danger">{push.error}</Notice>}
        {(pushes.data?.items ?? []).length > 0 && (
          <>
            <h3 className="mbs-12">{t('finance.acc.status')}</h3>
            {pushes.data!.items.map((x) => (
              <p key={x.id} className="fine">{x.provider} · <Badge tone={x.status === 'succeeded' ? 'ok' : x.status === 'partial' ? 'warn' : 'danger'}>{x.status}</Badge> · {dateTime(x.createdAt, locale)}{x.error ? ` · ${x.error}` : ''}</p>
            ))}
          </>
        )}
      </Card>
      {/* FT-23: mapping and payouts get a row of their own so their forms and tables have room. */}
      <div className={styles.setup}>
        <AccountMapping />
        <Payouts />
      </div>
    </div>
  );
}

export default function ExportsPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><FinanceFrame compare={false}><Exports /></FinanceFrame></Suspense>;
}
