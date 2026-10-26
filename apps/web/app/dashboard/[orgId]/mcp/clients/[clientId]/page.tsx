'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { MCP_GROUPS, type McpPermissionGroup } from '@resuto/contracts';
import { Badge, Card, DataTable, Modal, Notice, SelectField, Stat, TextareaField, useAction } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import '@/components/changes/changes.css';
import {
  ClientStatus, endOfDayIso, ExpiryBadge, isoToDateInput, LoadState, McpPage, OutcomeBadge, ScopeForm,
  type CatalogTool, type McpCall, type McpClient, type ScopeValue,
} from '../../_components/shared';
import st from '../../_components/mcp.module.css';

interface Usage {
  windows: Record<'24h' | '7d' | '30d', Record<string, number>>;
  byTool: Array<{ tool: string; calls: number; failures: number; avgMs: number | null }>;
}

const sum = (o: Record<string, number> | undefined) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);

export default function McpClientPage() {
  const { clientId } = useParams<{ clientId: string }>();
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const path = `/o/${org.id}/mcp/clients/${clientId}`;
  const client = useApi<McpClient>(path);
  const catalog = useApi<{ items: CatalogTool[] }>(`/o/${org.id}/mcp/catalog`);
  const usage = useApi<Usage>(`${path}/usage`);
  const calls = useApi<{ items: McpCall[] }>(`/o/${org.id}/mcp/calls?clientId=${clientId}&limit=50`, { pollMs: 30_000 });
  const [saved, setSaved] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  const save = useAction(async (v: ScopeValue) => {
    setSaved(false);
    const next = await session.call<McpClient>(path, {
      method: 'PATCH',
      body: { name: v.name, actingRole: v.actingRole, branchIds: v.branchIds, allowedTools: v.allowedTools,
        rateLimitPerMin: v.rateLimitPerMin, expiresAt: endOfDayIso(v.expiresOn) },
    });
    client.setData(next);
    setSaved(true);
  });
  const revoke = useAction(async () => {
    client.setData(await session.call<McpClient>(`${path}/revoke`, { method: 'POST' }));
    setConfirmRevoke(false);
  });

  const c = client.data;
  const inactive = !!c && (c.status === 'revoked' || c.expired);

  return (
    // While the connection loads its Revoke action holds its place (disabled), so the header does not grow on arrival.
    <McpPage tab="clients" actions={!c || c.status === 'active'
      ? <button type="button" className="btn btn-danger" disabled={!c} onClick={() => setConfirmRevoke(true)}>{t('mcp.detail.revoke')}</button> : undefined}>
      <LoadState loading={client.loading || catalog.loading} error={client.error ?? catalog.error} retry={() => { void client.reload(); void catalog.reload(); }}>
        {c && (
          <div className="stack gap-16">
            <div className="spread">
              <div className="row">
                <h2 className="m-0">{c.name}</h2>
                <ClientStatus client={c} />
                <ExpiryBadge client={c} timezone={org.timezone} />
                <Badge tone="neutral">{t(`mcp.wizard.auth.${c.authKind === 'oauth' ? 'oauth' : 'key'}`)}</Badge>
                <code dir="ltr" className="fine">{c.keyPrefix}…</code>
              </div>
              <span className="fine">{t('mcp.detail.created', { date: dateTime(c.createdAt, locale, org.timezone) })}</span>
            </div>
            {c.status === 'revoked' && <Notice tone="warn">{t('mcp.detail.revoked', { date: dateTime(c.revokedAt, locale, org.timezone) })}</Notice>}
            {c.status === 'active' && c.expired && <Notice tone="warn">{t('mcp.detail.expired')}</Notice>}

            <section aria-labelledby="groups-h">
              <h3 id="groups-h">{t('mcp.detail.groups')}</h3>
              <Card>
                <div className="stack gap-10">
                  {c.groups?.length ? (
                    <div className="row gap-6">{c.groups.map((g) => (
                      <Badge key={g} tone="info">{locale === 'ar' ? MCP_GROUPS[g as McpPermissionGroup]?.titleAr ?? g : MCP_GROUPS[g as McpPermissionGroup]?.title ?? g}</Badge>
                    ))}</div>
                  ) : <p className="muted m-0">{t('mcp.detail.noGroups')}</p>}
                  {!!Object.keys(c.policyOverrides ?? {}).length && (
                    <p className="fine m-0">{t('mcp.detail.overrides')}: {Object.entries(c.policyOverrides ?? {})
                      .map(([g, m]) => `${t(`mcp.policy.group.${g}`)}: ${t(`mcp.policy.mode.${m}`)}`).join(locale === 'ar' ? '، ' : ', ')}</p>
                  )}
                  <details>
                    <summary className="cursor-pointer">{t('mcp.detail.toolList', { n: c.allowedTools.length })}</summary>
                    <ul className="cx-tools mbs-8">{c.allowedTools.map((n) => <li key={n}><code dir="ltr">{n}</code></li>)}</ul>
                  </details>
                </div>
              </Card>
            </section>

            <section aria-labelledby="usage-h">
              <h3 id="usage-h">{t('mcp.detail.usage')}</h3>
              <LoadState loading={usage.loading} error={usage.error} retry={usage.reload}>
                <div className="grid grid-3">
                  {(['24h', '7d', '30d'] as const).map((w) => {
                    const all = sum(usage.data?.windows[w]);
                    const ok = (usage.data?.windows[w]?.ok ?? 0) + (usage.data?.windows[w]?.approval_required ?? 0);
                    return <Stat key={w} label={t(`mcp.usage.${w}`)} value={<span className="num">{all}</span>}
                      hint={all ? `${t('mcp.usage.failures')}: ${all - ok}` : t('mcp.usage.none')} tone={all - ok > 0 ? 'warn' : undefined} />;
                  })}
                </div>
                {!!usage.data?.byTool.length && (
                  <Card title={t('mcp.usage.byTool')}>
                    <DataTable rows={usage.data.byTool} rowKey={(r) => r.tool} columns={[
                      { key: 'tool', header: t('mcp.col.tool'), render: (r) => <code dir="ltr">{r.tool}</code> },
                      { key: 'calls', header: t('mcp.usage.calls'), align: 'end', render: (r) => <span className="num">{r.calls}</span> },
                      { key: 'fail', header: t('mcp.usage.failures'), align: 'end', render: (r) => <span className="num">{r.failures}</span> },
                      { key: 'avg', header: t('mcp.usage.avg'), align: 'end', render: (r) => <span className="num">{r.avgMs ?? '—'} ms</span> },
                    ]} />
                  </Card>
                )}
              </LoadState>
            </section>

            <section aria-labelledby="scope-h">
              <h3 id="scope-h">{t('mcp.detail.scope')}</h3>
              {saved && <Notice tone="ok">{t('mcp.form.saved')}</Notice>}
              <ScopeForm
                key={`${c.id}:${c.status}`}
                catalog={catalog.data?.items ?? []}
                initial={{ name: c.name, actingRole: c.actingRole, branchIds: c.branchIds, allowedTools: c.allowedTools,
                  rateLimitPerMin: c.rateLimitPerMin, expiresOn: isoToDateInput(c.expiresAt) }}
                submitLabel={t('action.save')}
                pending={save.pending}
                error={save.error}
                disabled={c.status === 'revoked'}
                onSubmit={(v) => void save.run(v)}
              />
            </section>

            {!inactive && <TestPanel client={c} catalog={catalog.data?.items ?? []} onRan={() => { void calls.reload(); void usage.reload(); }} />}

            <section aria-labelledby="recent-h">
              <h3 id="recent-h">{t('mcp.activity.title')}</h3>
              <p className="fine mbs-0">{t('mcp.activity.body')}</p>
              <LoadState loading={calls.loading} error={calls.error} retry={calls.reload}>
                <DataTable rows={calls.data?.items ?? []} rowKey={(r) => r.id} empty={<p className="muted m-0">{t('mcp.calls.empty')}</p>} columns={[
                  { key: 'time', header: t('mcp.col.time'), render: (r) => dateTime(r.createdAt, locale, org.timezone) },
                  { key: 'tool', header: t('mcp.col.tool'), render: (r) => <code dir="ltr">{r.tool}</code> },
                  { key: 'outcome', header: t('mcp.col.outcome'), render: (r) => <OutcomeBadge outcome={r.outcome} /> },
                  { key: 'via', header: t('mcp.col.via'), render: (r) => t(`mcp.via.${r.via}`) },
                  { key: 'err', header: t('mcp.col.error'), render: (r) => r.errorCode ? <span className="fine" dir="ltr">{r.errorCode}</span> : '' },
                  { key: 'change', header: t('mcp.activity.change'), render: (r) => r.changeSetId
                    ? <Link href={`/dashboard/${org.id}/approvals/${r.changeSetId}`}>{t('mcp.activity.view')}</Link> : '' },
                ]} />
              </LoadState>
            </section>
          </div>
        )}
      </LoadState>

      <Modal open={confirmRevoke} onClose={() => setConfirmRevoke(false)} title={t('mcp.detail.revokeTitle')} footer={<>
        <button type="button" className="btn btn-ghost" onClick={() => setConfirmRevoke(false)}>{t('action.cancel')}</button>
        <button type="button" className="btn btn-danger" disabled={revoke.pending} onClick={() => void revoke.run()}>{t('mcp.detail.revoke')}</button>
      </>}>
        <p>{t('mcp.detail.revokeConfirm')}</p>
        {revoke.error && <Notice tone="danger">{revoke.error}</Notice>}
      </Modal>
    </McpPage>
  );
}

function TestPanel({ client, catalog, onRan }: { client: McpClient; catalog: CatalogTool[]; onRan: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const tools = catalog.filter((x) => x.readOnly && client.allowedTools.includes(x.name));
  const [tool, setTool] = useState(tools[0]?.name ?? '');
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState<unknown>(null);
  const run = useAction(async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input || '{}');
    } catch {
      throw new Error(t('mcp.test.invalidJson'));
    }
    setResult(null);
    try {
      setResult(await session.call(`/o/${org.id}/mcp/clients/${client.id}/test/${tool}`, { body: { input: parsed } }));
    } finally {
      onRan();
    }
  });
  return (
    <Card title={t('mcp.test.title')}>
      <p className="fine mbs-0">{t('mcp.test.body')}</p>
      {!tools.length ? <p className="muted">{t('mcp.test.none')}</p> : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run.run(); }}>
          <SelectField label={t('mcp.test.tool')} value={tool} onChange={(e) => setTool(e.target.value)}>
            {tools.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          </SelectField>
          <TextareaField label={t('mcp.test.input')} value={input} rows={3} dir="ltr" spellCheck={false}
            hint={Object.keys(catalog.find((x) => x.name === tool)?.inputSchema.properties ?? {}).join(', ') || '{}'}
            onChange={(e) => setInput(e.target.value)} className={`textarea ${st.monoInput}`} />
          {run.error && <Notice tone="danger">{run.error}</Notice>}
          <div className="row"><button className="btn btn-primary" disabled={run.pending || !tool}>{run.pending ? t('state.loading') : t('mcp.test.run')}</button></div>
          {result !== null && (
            <div>
              <strong>{t('mcp.test.result')}</strong>
              <pre dir="ltr" className="code-block is-tall">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </form>
      )}
    </Card>
  );
}
