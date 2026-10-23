'use client';
import { Suspense, useState } from 'react';
import { EXPORT_KINDS } from '@resuto/contracts';
import { Badge, Card, DataTable, EmptyState, Notice, SelectField, Skeleton, useAction } from '@resuto/ui';
import { API_URL, newIdempotencyKey } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { AccountMapping, Payouts } from '../_ui/AccountingSetup';
import { FinanceFrame, useMoney, usePeriod } from '../_ui/FinanceFrame';

function Exports() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call, token } = useSession();
  const p = usePeriod();
  const m = useMoney();
  const list = useApi<{ items: any[] }>(`/o/${org.id}/finance/exports`);
  const pushes = useApi<{ items: any[]; providers: any[] }>(`/o/${org.id}/finance/accounting/pushes`);
  const conns = useApi<{ items: { id: string; provider: string; environment: string; status: string }[] }>(`/o/${org.id}/finance/accounting/connections`);
  const [kind, setKind] = useState<string>('sales');
  const [journal, setJournal] = useState<any>(null);
  const [picked, setConnectionId] = useState('');
  const connectionId = picked || conns.data?.items[0]?.id || '';
  const range = { from: p.from, to: p.to, ...(p.branchId ? { branchId: p.branchId } : {}) };

  const download = useAction(async (id: string, filename: string) => {
    // Authenticated download; the browser verifies nothing, the server re-checks the stored checksum.
    const res = await fetch(`${API_URL}/v1/o/${org.id}/finance/exports/${id}/download`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  const create = useAction(async () => {
    const r = await call<any>(`/o/${org.id}/finance/exports`, { body: { kind, ...range } });
    await list.reload();
    await download.run(r.id, r.filename);
  });
  const preview = useAction(async () => setJournal(await call(`/o/${org.id}/finance/accounting/journal?${p.query}`)));
  const push = useAction(async () => { await call(`/o/${org.id}/finance/accounting/push`, { body: { connectionId: connectionId.trim(), ...range, key: newIdempotencyKey() } }); await pushes.reload(); });

  return (
    <>
      <div className="grid grid-2 items-start">
      <Card title={t('finance.export.title')}>
        <p className="fine">{t('finance.export.body')}</p>
        <div className="form-row items-end">
          <SelectField label={t('finance.export.kind')} value={kind} onChange={(e) => setKind(e.target.value)}>
            {EXPORT_KINDS.map((k) => <option key={k} value={k}>{t(`finance.export.kind.${k}`)}</option>)}
          </SelectField>
          <button className="btn btn-primary" style={{ marginBottom: 14 }} disabled={create.pending} onClick={() => create.run()}>{t('finance.export.create')}</button>
        </div>
        {(create.error || download.error || list.error) && <Notice tone="danger">{create.error ?? download.error ?? list.error?.message}</Notice>}
        {!list.data ? <Skeleton lines={4} /> : (
          <DataTable rows={list.data.items} rowKey={(r) => r.id} empty={<EmptyState title={t('finance.export.empty')} />} columns={[
            { key: 'k', header: t('finance.export.kind'), render: (r) => <>{t(`finance.export.kind.${r.kind}`)}<div className="fine" dir="ltr">{r.periodStart} → {r.periodEnd}</div></> },
            { key: 'n', header: t('finance.export.rows'), align: 'end', render: (r) => r.rowCount },
            { key: 'c', header: t('finance.export.checksum'), render: (r) => <code title={r.checksum} dir="ltr" style={{ fontSize: 11 }}>{r.checksum.slice(0, 12)}…</code> },
            { key: 'd', header: '', render: (r) => <button className="btn btn-sm" onClick={() => download.run(r.id, r.filename)}>{t('finance.export.download')}</button> },
          ]} />
        )}
      </Card>
      <Card title={t('finance.acc.title')}>
        <p className="fine">{t('finance.acc.body')}</p>
        <p className="fine">{t('finance.acc.kinds')}</p>
        <div className="row" style={{ gap: 6, marginBottom: 10 }}>
          {(pushes.data?.providers ?? []).map((d: any) => <Badge key={d.id} tone="sandbox">{d.name} · {t('finance.acc.readiness')}</Badge>)}
        </div>
        <button className="btn" disabled={preview.pending} onClick={() => preview.run()}>{t('finance.acc.preview')}</button>
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
          <div className="form-row" style={{ alignItems: 'end', marginTop: 14 }}>
            <SelectField label={t('finance.acc.selectConnection')} value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              {conns.data.items.map((c) => <option key={c.id} value={c.id}>{c.provider} · {c.environment} · {c.status}</option>)}
            </SelectField>
            <button className="btn btn-primary" style={{ marginBottom: 14 }} disabled={push.pending || !connectionId} onClick={() => push.run()}>{t('finance.acc.push')}</button>
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
      </div>
      {/* FT-23: mapping and payouts get a row of their own so their forms and tables have room. */}
      <div className="grid" style={{ alignItems: 'start', marginTop: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))' }}>
        <AccountMapping />
        <Payouts />
      </div>
    </>
  );
}

export default function ExportsPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><FinanceFrame><Exports /></FinanceFrame></Suspense>;
}
