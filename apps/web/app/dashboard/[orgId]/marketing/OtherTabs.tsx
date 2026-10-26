'use client';
// Marketing tabs other than Campaigns (segments, promotions, short links, recommendations), loaded when opened.
import dynamic from 'next/dynamic';
import { useEffect, useState, type FormEvent } from 'react';
import type { MarketingRecommendation, SegmentGroup, SegmentRule } from '@resuto/contracts';
import { Badge, Card, DataTableV2, EmptyState, Field, Icon, Notice, SelectField, Skeleton, SkeletonTable, useAction } from '@resuto/ui';
import { XIcon } from '@/components/icons/glyphs';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import st from './marketing.module.css';

const AudienceDryRunButton = dynamic(() => import('./MetaTracking').then((m) => m.AudienceDryRunButton), { ssr: false });

interface Segment { id: string; name: string; memberCount: number; source: string; definition: SegmentGroup; lastComputedAt: string | null }
interface CampaignRef { id: string; name: string }

// ---------------------------------------------------------------------------
// Segment builder (top-level and/or of rules; the API also accepts nested groups)
// ---------------------------------------------------------------------------
const RULE_TYPES: SegmentRule['type'][] = ['inactive_days_gte', 'orders_gte', 'spent_gte', 'has_tag', 'consent', 'branch', 'purchased_product', 'channel', 'points_balance_gte'];
const defaultRule = (type: SegmentRule['type'], branchId: string): SegmentRule => ({
  inactive_days_gte: { type: 'inactive_days_gte', days: 30 }, orders_gte: { type: 'orders_gte', count: 2 }, spent_gte: { type: 'spent_gte', amountMinor: 50000 },
  has_tag: { type: 'has_tag', tag: 'vip' }, consent: { type: 'consent', value: true }, branch: { type: 'branch', branchId },
  purchased_product: { type: 'purchased_product', productId: '' }, channel: { type: 'channel', channel: 'whatsapp' },
  points_balance_gte: { type: 'points_balance_gte', points: 100 },
} as Record<SegmentRule['type'], SegmentRule>)[type];

function RuleEditor({ rule, onChange, onRemove }: { rule: SegmentRule; onChange: (r: SegmentRule) => void; onRemove: () => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const num = (v: string) => Math.max(0, Math.floor(Number(v) || 0));
  return (
    <div className={`row ${st.rule}`}>
      <SelectField label={t('marketing.seg.rule')} value={rule.type} onChange={(e) => onChange(defaultRule(e.target.value as SegmentRule['type'], org.branches[0]?.id ?? ''))}>
        {RULE_TYPES.map((r) => <option key={r} value={r}>{t(`marketing.rule.${r}`)}</option>)}
      </SelectField>
      {rule.type === 'inactive_days_gte' && <Field label={t('marketing.seg.days')} type="number" min={1} value={rule.days} onChange={(e) => onChange({ ...rule, days: Math.max(1, num(e.target.value)) })} />}
      {(rule.type === 'orders_gte') && <Field label={t('marketing.seg.count')} type="number" min={1} value={rule.count} onChange={(e) => onChange({ ...rule, count: Math.max(1, num(e.target.value)) })} />}
      {rule.type === 'spent_gte' && <Field label={t('marketing.seg.amount', { currency: org.currency })} type="number" min={0} step="0.01" value={rule.amountMinor / 100}
        onChange={(e) => onChange({ ...rule, amountMinor: Math.round((Number(e.target.value) || 0) * 100) })} />}
      {(rule.type === 'orders_gte' || rule.type === 'spent_gte' || rule.type === 'purchased_product') &&
        <Field label={t('marketing.seg.withinDays')} type="number" min={1} value={rule.withinDays ?? ''} placeholder={t('marketing.seg.anyTime')}
          onChange={(e) => onChange({ ...rule, withinDays: e.target.value ? Math.max(1, num(e.target.value)) : undefined } as SegmentRule)} />}
      {rule.type === 'has_tag' && <Field label={t('marketing.seg.tag')} value={rule.tag} maxLength={40} onChange={(e) => onChange({ ...rule, tag: e.target.value })} />}
      {rule.type === 'consent' && <SelectField label={t('marketing.seg.consent')} value={String(rule.value)} onChange={(e) => onChange({ ...rule, value: e.target.value === 'true' })}>
        <option value="true">{t('marketing.seg.consented')}</option><option value="false">{t('marketing.seg.notConsented')}</option></SelectField>}
      {rule.type === 'branch' && <SelectField label={t('marketing.seg.branch')} value={rule.branchId} onChange={(e) => onChange({ ...rule, branchId: e.target.value })}>
        {org.branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}</SelectField>}
      {rule.type === 'purchased_product' && <Field label={t('marketing.seg.productId')} value={rule.productId} dir="ltr" onChange={(e) => onChange({ ...rule, productId: e.target.value.trim() })} />}
      {rule.type === 'channel' && <SelectField label={t('marketing.seg.channel')} value={rule.channel} onChange={(e) => onChange({ ...rule, channel: e.target.value as any })}>
        {['qr', 'web', 'whatsapp', 'staff', 'pos', 'mcp', 'phone'].map((c) => <option key={c} value={c}>{t(`marketing.orderChannel.${c}`)}</option>)}</SelectField>}
      {rule.type === 'points_balance_gte' && <Field label={t('marketing.seg.points')} type="number" inputMode="numeric" min={0} value={rule.points}
        onChange={(e) => onChange({ ...rule, points: num(e.target.value) })} />}
      <button type="button" className="btn btn-sm btn-ghost btn-danger mbe-14" onClick={onRemove} aria-label={t('action.delete')}><Icon icon={XIcon} size={16} /></button>
    </div>
  );
}

export function Segments() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const list = useApi<{ items: Segment[] }>(`/o/${org.id}/marketing/segments`);
  const [name, setName] = useState('');
  const [def, setDef] = useState<{ op: 'and' | 'or'; rules: SegmentRule[] }>({ op: 'and', rules: [{ type: 'consent', value: true }, { type: 'inactive_days_gte', days: 30 }] });
  const [count, setCount] = useState<{ count: number; consentedCount: number } | null>(null);
  const [countError, setCountError] = useState<string | null>(null);

  useEffect(() => {
    if (!def.rules.length) { setCount(null); return; }
    const timer = setTimeout(() => {
      session.call<{ count: number; consentedCount: number }>(`/o/${org.id}/marketing/segments/preview`, { body: { definition: def } })
        .then((r) => { setCount(r); setCountError(null); }).catch((e) => { setCount(null); setCountError((e as Error).message); });
    }, 350);
    return () => clearTimeout(timer);
  }, [def, org.id, session]);

  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    await session.call(`/o/${org.id}/marketing/segments`, { body: { name, definition: def } });
    setName('');
    await list.reload();
  });
  const refresh = useAction(async (id: string) => { await session.call(`/o/${org.id}/marketing/segments/${id}/refresh`, { method: 'POST' }); await list.reload(); });

  return (
    <div className="stack">
      {can('marketing:write') && (
        <Card title={t('marketing.seg.builder')}>
          <form onSubmit={save.run}>
            <div className="row gap-8">
              <span className="fine">{t('marketing.seg.match')}</span>
              <SelectField label={t('marketing.seg.combine')} value={def.op} onChange={(e) => setDef({ ...def, op: e.target.value as 'and' | 'or' })}>
                <option value="and">{t('marketing.seg.all')}</option><option value="or">{t('marketing.seg.any')}</option></SelectField>
            </div>
            {def.rules.map((r, i) => <RuleEditor key={i} rule={r} onChange={(nr) => setDef({ ...def, rules: def.rules.map((x, j) => (j === i ? nr : x)) })}
              onRemove={() => setDef({ ...def, rules: def.rules.filter((_, j) => j !== i) })} />)}
            <button type="button" className={`btn btn-sm ${st.addRule}`} disabled={def.rules.length >= 20} onClick={() => setDef({ ...def, rules: [...def.rules, { type: 'orders_gte', count: 1 }] })}>{t('marketing.seg.addRule')}</button>
            <div className={`row ${st.count}`} aria-live="polite">
              {count ? <><Badge tone="info">{t('marketing.seg.liveCount', { n: count.count })}</Badge><Badge tone="ok">{t('marketing.seg.liveConsented', { n: count.consentedCount })}</Badge></>
                : countError ? <Notice tone="danger">{countError}</Notice> : <span className="fine">{t('state.loading')}</span>}
            </div>
            <div className="row">
              <input className={`input ${st.nameInput}`} value={name} onChange={(e) => setName(e.target.value)} placeholder={t('marketing.seg.name')} required maxLength={80} aria-label={t('marketing.seg.name')} />
              <button className="btn btn-primary" disabled={save.pending || !def.rules.length}>{t('action.save')}</button>
            </div>
            {save.error && <Notice tone="danger">{save.error}</Notice>}
          </form>
        </Card>
      )}
      {!list.data ? <SkeletonTable rows={4} cols={4} /> : (
        <DataTableV2 label={t('marketing.tab.segments')} rows={list.data.items} rowKey={(s) => s.id} empty={<EmptyState title={t('marketing.seg.empty')} />} columns={[
          { key: 'name', header: t('marketing.seg.name'), render: (s) => <><strong>{s.name}</strong> {s.source !== 'manual' && <Badge>{t(`marketing.source.${s.source}`)}</Badge>}</> },
          { key: 'n', header: t('marketing.seg.members'), align: 'end', sort: (a, b) => a.memberCount - b.memberCount, render: (s) => <span className="num">{s.memberCount}</span> },
          { key: 'at', header: t('marketing.seg.computed'), render: (s) => dateTime(s.lastComputedAt, locale) },
          { key: 'a', header: '', align: 'end', render: (s) => can('marketing:write') && <div className="row gap-4 justify-end">
            <button className="btn btn-sm btn-ghost" disabled={refresh.pending} onClick={() => refresh.run(s.id)}>{t('marketing.seg.refresh')}</button><AudienceDryRunButton segmentId={s.id} /></div> },
        ]} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Promotions() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const list = useApi<{ items: any[] }>(`/o/${org.id}/marketing/promotions`);
  const [form, setForm] = useState({ code: '', name: '', kind: 'percent', value: '10', max: '', min: '' });
  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const v = Number(form.value) || 0;
    await session.call(`/o/${org.id}/marketing/promotions`, { body: {
      code: form.code.trim() || null, name: form.name, kind: form.kind,
      value: form.kind === 'percent' ? Math.round(v * 100) : form.kind === 'fixed' ? Math.round(v * 100) : 0,
      maxDiscountMinor: form.max ? Math.round(Number(form.max) * 100) : null, minOrderMinor: form.min ? Math.round(Number(form.min) * 100) : 0,
    } });
    setForm({ ...form, code: '', name: '' });
    await list.reload();
  });
  const act = useAction(async (p: any, action: 'toggle' | 'delete') => {
    if (action === 'toggle') await session.call(`/o/${org.id}/marketing/promotions/${p.id}`, { method: 'PATCH', body: { isActive: !p.isActive } });
    else await session.call(`/o/${org.id}/marketing/promotions/${p.id}`, { method: 'DELETE' });
    await list.reload();
  });
  const describe = (p: any) => p.kind === 'percent' ? `${p.value / 100}%` : p.kind === 'fixed' ? money(p.value, org.currency, locale) : t('marketing.promo.freeDelivery');
  return (
    <div className="stack">
      <Notice>{t('marketing.promo.help')}</Notice>
      {!list.data ? <SkeletonTable rows={4} cols={5} /> : (
        <DataTableV2 label={t('marketing.tab.promotions')} rows={list.data.items} rowKey={(p) => p.id} empty={<EmptyState title={t('marketing.promo.empty')} />} columns={[
          { key: 'code', header: t('marketing.promo.code'), render: (p) => <strong dir="ltr">{p.code ?? '—'}</strong> },
          { key: 'name', header: t('marketing.promo.name'), render: (p) => p.name },
          { key: 'v', header: t('marketing.promo.value'), render: describe },
          { key: 'used', header: t('marketing.promo.used'), align: 'end', render: (p) => <span className="num">{p.redemptionCount}{p.maxRedemptions ? ` / ${p.maxRedemptions}` : ''}</span> },
          { key: 'on', header: t('marketing.camp.status'), render: (p) => <Badge tone={p.isActive ? 'ok' : 'neutral'}>{t(p.isActive ? 'marketing.promo.active' : 'marketing.promo.inactive')}</Badge> },
          { key: 'a', header: '', align: 'end', render: (p) => can('marketing:write') && <div className="row gap-4 justify-end">
            <button className="btn btn-sm btn-ghost" onClick={() => act.run(p, 'toggle')}>{t(p.isActive ? 'marketing.promo.deactivate' : 'marketing.promo.activate')}</button>
            <button className="btn btn-sm btn-ghost btn-danger" onClick={() => act.run(p, 'delete')}>{t('action.delete')}</button></div> },
        ]} />
      )}
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      {can('marketing:write') && (
        <Card title={t('marketing.promo.new')}>
          <form onSubmit={create.run}>
            <div className="form-row">
              <Field label={t('marketing.promo.code')} value={form.code} pattern="[A-Za-z0-9_\-]{3,32}" dir="ltr" onChange={(e) => setForm({ ...form, code: e.target.value })} />
              <Field label={t('marketing.promo.name')} value={form.name} required onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <SelectField label={t('marketing.promo.kind')} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                <option value="percent">{t('marketing.promo.percent')}</option><option value="fixed">{t('marketing.promo.fixed')}</option><option value="free_delivery">{t('marketing.promo.freeDelivery')}</option></SelectField>
            </div>
            <div className="form-row">
              {form.kind !== 'free_delivery' && <Field label={form.kind === 'percent' ? t('marketing.promo.percentValue') : t('marketing.promo.fixedValue', { currency: org.currency })} type="number" min={0} step="0.01"
                value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />}
              {form.kind === 'percent' && <Field label={t('marketing.promo.max', { currency: org.currency })} type="number" min={0} step="0.01" value={form.max} onChange={(e) => setForm({ ...form, max: e.target.value })} />}
              <Field label={t('marketing.promo.min', { currency: org.currency })} type="number" min={0} step="0.01" value={form.min} onChange={(e) => setForm({ ...form, min: e.target.value })} />
            </div>
            {create.error && <Notice tone="danger">{create.error}</Notice>}
            <button className="btn btn-primary" disabled={create.pending}>{t('action.create')}</button>
          </form>
        </Card>
      )}
    </div>
  );
}

export function Links() {
  const { t } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const list = useApi<{ items: any[] }>(`/o/${org.id}/marketing/links`);
  const campaigns = useApi<{ items: CampaignRef[] }>(`/o/${org.id}/marketing/campaigns`);
  const [form, setForm] = useState({ campaignId: '', destinationPath: `/order/${org.slug}`, source: '', medium: '', content: '' });
  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const utm = Object.fromEntries(Object.entries({ source: form.source, medium: form.medium, content: form.content }).filter(([, v]) => v.trim()));
    await session.call(`/o/${org.id}/marketing/links`, { body: { campaignId: form.campaignId || null, destinationPath: form.destinationPath, utm } });
    await list.reload();
  });
  return (
    <div className="stack">
      <Notice>{t('marketing.links.help')}</Notice>
      {!list.data ? <SkeletonTable rows={4} cols={4} /> : (
        <DataTableV2 label={t('marketing.tab.links')} rows={list.data.items} rowKey={(l) => l.id} empty={<EmptyState title={t('marketing.links.empty')} />} columns={[
          { key: 'url', header: t('marketing.links.short'), render: (l) => <span className="row gap-6"><code dir="ltr">{l.shortUrl}</code>
            <button className="btn btn-sm btn-ghost" onClick={() => void navigator.clipboard?.writeText(l.shortUrl)}>{t('marketing.links.copy')}</button></span> },
          { key: 'dest', header: t('marketing.links.destination'), render: (l) => <code dir="ltr" className="fine">{l.destinationPath}</code> },
          { key: 'camp', header: t('marketing.links.campaign'), render: (l) => campaigns.data?.items.find((c) => c.id === l.campaignId)?.name ?? '—' },
          { key: 'clicks', header: t('marketing.report.clicks'), align: 'end', sort: (a, b) => a.clickCount - b.clickCount, render: (l) => <span className="num">{l.clickCount}</span> },
        ]} />
      )}
      {can('marketing:write') && (
        <Card title={t('marketing.links.new')}>
          <form onSubmit={create.run}>
            <div className="form-row">
              <SelectField label={t('marketing.links.campaign')} value={form.campaignId} onChange={(e) => setForm({ ...form, campaignId: e.target.value })}>
                <option value="">—</option>{campaigns.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
              <Field label={t('marketing.links.destination')} value={form.destinationPath} required dir="ltr" pattern="/[^/].*" onChange={(e) => setForm({ ...form, destinationPath: e.target.value })} hint={t('marketing.links.destHint')} />
            </div>
            <div className="form-row">
              <Field label="utm_source" value={form.source} dir="ltr" onChange={(e) => setForm({ ...form, source: e.target.value })} />
              <Field label="utm_medium" value={form.medium} dir="ltr" onChange={(e) => setForm({ ...form, medium: e.target.value })} />
              <Field label="utm_content" value={form.content} dir="ltr" onChange={(e) => setForm({ ...form, content: e.target.value })} />
            </div>
            {create.error && <Notice tone="danger">{create.error}</Notice>}
            <button className="btn btn-primary" disabled={create.pending}>{t('action.create')}</button>
          </form>
        </Card>
      )}
    </div>
  );
}

export function Recommendations({ onApplied }: { onApplied: () => void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const recs = useApi<{ items: MarketingRecommendation[]; method: string }>(`/o/${org.id}/marketing/recommendations`);
  const apply = useAction(async (key: string) => {
    await session.call(`/o/${org.id}/marketing/recommendations/${key}/apply`, { method: 'POST' });
    onApplied();
  });
  if (!recs.data) return recs.error ? <Notice tone="danger">{recs.error.message}</Notice> : <Skeleton />;
  return (
    <div className="stack">
      <Notice>{t('marketing.recs.method')}</Notice>
      {recs.data.items.length === 0 && <div className="card"><EmptyState title={t('marketing.recs.empty')}>{t('marketing.recs.emptyBody')}</EmptyState></div>}
      <div className="grid grid-2">
        {recs.data.items.map((r) => (
          <Card key={r.key} title={locale === 'ar' ? r.titleAr : r.title}>
            <p>{r.rationale}</p>
            <details><summary className="fine">{t('marketing.recs.evidence')}</summary><pre className={`fine ${st.evidence}`} dir="ltr">{JSON.stringify(r.evidence, null, 2)}</pre></details>
            {r.action.kind === 'create_campaign_draft' && can('marketing:write') && (
              <button className="btn btn-primary mbs-10" disabled={apply.pending} onClick={() => apply.run(r.key)}>{t('marketing.recs.createDraft')}</button>
            )}
          </Card>
        ))}
      </div>
      {apply.error && <Notice tone="danger">{apply.error}</Notice>}
    </div>
  );
}
