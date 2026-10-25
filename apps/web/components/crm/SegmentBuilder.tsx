'use client';
// Segment builder inside Customers (21-CRM, plan §6.7): and/or groups (nested up to the engine's limit) of the rule
// types the existing engine compiles (segment-sql.ts), a live count of matching and consented customers
// (POST marketing/segments/preview) and save (POST marketing/segments). Loaded on demand by the Customers page.
import type { MenuEditorView, SegmentGroup, SegmentRule } from '@resuto/contracts';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Badge, DataTable, EmptyState, Field, LockedFeature, Notice, SelectField, Skeleton, useAction } from '@resuto/ui';
import { dateTime, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import {
  addGroup, addRule, canAddGroup, canAddRule, defaultRule, definitionValid, EMPTY_DEFINITION, isGroup, LIMITS, normalise, ORDER_CHANNELS,
  removeAt, RULE_TYPES, ruleValid, updateAt, WINDOWED, type Path, type RuleType,
} from './segment-rules';
import './crm.css';

interface Segment { id: string; name: string; description: string | null; memberCount: number; source: string; lastComputedAt: string | null }
type Products = Array<{ id: string; name: string; nameAr: string | null }>;

export function SegmentsView() {
  const { t } = useT();
  const { org, can, hasModule } = useOrg();
  if (!hasModule('marketing')) {
    return <LockedFeature title={t('crm.seg.locked.title')} description={t('crm.seg.locked.body')}
      cta={{ label: t('action.upgrade'), href: `/dashboard/${org.id}/billing` }} />;
  }
  if (!can('marketing:read')) return <Notice>{t('crm.seg.noRead')}</Notice>;
  return <Builder />;
}

function Builder() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const list = useApi<{ items: Segment[] }>(`/o/${org.id}/marketing/segments`);
  const [def, setDef] = useState<SegmentGroup>(EMPTY_DEFINITION);
  const [count, setCount] = useState<{ count: number; consentedCount: number } | null>(null);
  const [counting, setCounting] = useState(false);
  const [countError, setCountError] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const valid = definitionValid(def);
  const needsProducts = JSON.stringify(def).includes('"purchased_product"');
  const menu = useApi<MenuEditorView>(needsProducts && can('menu:read') ? `/o/${org.id}/menu` : null);
  const products: Products = menu.data?.products ?? [];

  // Live count, debounced; nothing is sent while a rule is incomplete.
  useEffect(() => {
    if (!valid) { setCount(null); setCounting(false); return; }
    let live = true;
    setCounting(true);
    const timer = setTimeout(() => {
      session.call<{ count: number; consentedCount: number }>(`/o/${org.id}/marketing/segments/preview`, { body: { definition: normalise(def) } })
        .then((r) => { if (live) { setCount(r); setCountError(false); } })
        .catch(() => { if (live) { setCount(null); setCountError(true); } })
        .finally(() => { if (live) setCounting(false); });
    }, 350);
    return () => { live = false; clearTimeout(timer); };
  }, [def, valid, org.id, session]);

  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const s = await session.call<Segment>(`/o/${org.id}/marketing/segments`, { body: { name: name.trim(), description: description.trim() || null, definition: normalise(def) } });
    setSaved(t('crm.seg.saved', { name: s.name, count: s.memberCount }));
    setName('');
    setDescription('');
    await list.reload();
  });
  const editable = can('marketing:write');

  return (
    <div className="crm-seg stack gap-16">
      <section className="card" aria-labelledby="crm-seg-title">
        <h2 id="crm-seg-title" className="crm-title">{t('crm.seg.title')}</h2>
        <p className="fine m-0">{t('crm.seg.subtitle')}</p>
        <GroupEditor root={def} path={[]} onChange={setDef} products={products} />
        <p className="fine m-0">{t('crm.seg.limits', { rules: LIMITS.rules, depth: LIMITS.depth })}</p>
        <div className="crm-seg-count" aria-live="polite" data-testid="segment-count">
          <strong>{t('crm.seg.preview')}</strong>{' '}
          {counting ? <span className="fine">{t('crm.seg.previewing')}</span>
            : count ? <Badge tone="info">{t('crm.seg.previewCount', { count: count.count, consented: count.consentedCount })}</Badge>
              : <span className="fine">{countError || !valid ? t('crm.seg.previewError') : '—'}</span>}
        </div>
        <p className="fine m-0">{t('crm.seg.consentNote')}</p>
        {editable ? (
          <form className="crm-seg-save" onSubmit={save.run}>
            <Field label={t('crm.seg.name')} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} dir="auto" />
            <Field label={t('crm.seg.description')} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} dir="auto" />
            <button className="btn btn-primary" disabled={save.pending || !valid || !name.trim()}>{t('crm.seg.save')}</button>
          </form>
        ) : <Notice>{t('crm.seg.noWrite')}</Notice>}
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        {saved && <Notice tone="ok">{saved}</Notice>}
      </section>
      <section className="card" aria-labelledby="crm-seg-list">
        <h2 id="crm-seg-list" className="crm-title">{t('crm.seg.list')}</h2>
        {!list.data ? <Skeleton lines={3} /> : (
          <DataTable rows={list.data.items} rowKey={(s) => s.id} empty={<EmptyState title={t('crm.seg.empty')} />} columns={[
            { key: 'name', header: t('crm.seg.name'), render: (s) => <><strong dir="auto">{s.name}</strong> <Badge>{t(`crm.seg.source.${s.source}`)}</Badge></> },
            { key: 'n', header: t('crm.seg.preview'), align: 'end', render: (s) => <span className="num">{t('crm.seg.members', { count: s.memberCount })}</span> },
            { key: 'at', header: t('crm.seg.col.updated'), render: (s) => <span className="fine">{dateTime(s.lastComputedAt, locale, org.timezone)}</span> },
          ]} />
        )}
      </section>
    </div>
  );
}

function GroupEditor({ root, path, onChange, products }: { root: SegmentGroup; path: Path; onChange: (g: SegmentGroup) => void; products: Products }) {
  const { t } = useT();
  const { org } = useOrg();
  const id = useId();
  let group = root;
  for (const i of path) group = group.rules[i] as SegmentGroup;
  const nested = path.length > 0;
  const firstBranch = org.branches[0]?.id ?? null;
  return (
    <fieldset className="crm-seg-group" data-depth={path.length + 1} aria-labelledby={`${id}-legend`}>
      <legend id={`${id}-legend`} className="crm-seg-legend">
        <span>{nested ? t('crm.seg.group') : t('crm.seg.match')}</span>
        <select className="select crm-seg-op" aria-label={t('crm.seg.match')} value={group.op}
          onChange={(e) => onChange(updateAt(root, path, (n) => ({ ...(n as SegmentGroup), op: e.target.value as 'and' | 'or' })))}>
          <option value="and">{t('crm.seg.op.and')}</option>
          <option value="or">{t('crm.seg.op.or')}</option>
        </select>
      </legend>
      <ol className="crm-seg-rules">
        {group.rules.map((r, i) => (
          <li key={i}>
            {isGroup(r)
              ? <GroupEditor root={root} path={[...path, i]} onChange={onChange} products={products} />
              : <RuleEditor rule={r} products={products}
                  onChange={(nr) => onChange(updateAt(root, [...path, i], () => nr))}
                  onRemove={group.rules.length > 1 || nested ? () => onChange(removeAt(root, [...path, i])) : undefined} />}
          </li>
        ))}
      </ol>
      <div className="row gap-8">
        <button type="button" className="btn btn-sm" disabled={!canAddRule(root, path)}
          onClick={() => onChange(addRule(root, path, defaultRule('orders_gte')))}>{t('crm.seg.addRule')}</button>
        {canAddGroup(root, path) && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange(addGroup(root, path, defaultRule('branch', { branchId: firstBranch })))}>
            {t('crm.seg.addGroup')}</button>
        )}
        {nested && <button type="button" className="btn btn-sm btn-ghost btn-danger" onClick={() => onChange(removeAt(root, path))}>{t('crm.seg.removeGroup')}</button>}
      </div>
    </fieldset>
  );
}

function RuleEditor({ rule, onChange, onRemove, products }: { rule: SegmentRule; onChange: (r: SegmentRule) => void; onRemove?: () => void; products: Products }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const whole = (v: string, min: number) => Math.max(min, Math.floor(Number(v) || 0));
  const invalid = !ruleValid(rule);
  return (
    <div className="crm-seg-rule" data-invalid={invalid || undefined}>
      <SelectField label={t('crm.seg.rule')} value={rule.type}
        onChange={(e) => onChange(defaultRule(e.target.value as RuleType, { branchId: org.branches[0]?.id ?? null }))}>
        {RULE_TYPES.map((r) => <option key={r} value={r}>{t(`crm.seg.type.${r}`)}</option>)}
      </SelectField>
      {rule.type === 'inactive_days_gte' && <Field label={t('crm.seg.days')} type="number" inputMode="numeric" min={1} max={3650} value={rule.days}
        onChange={(e) => onChange({ ...rule, days: whole(e.target.value, 1) })} />}
      {rule.type === 'orders_gte' && <Field label={t('crm.seg.count')} type="number" inputMode="numeric" min={1} value={rule.count}
        onChange={(e) => onChange({ ...rule, count: whole(e.target.value, 1) })} />}
      {rule.type === 'spent_gte' && <Field label={t('crm.seg.amount', { currency: org.currency })} type="number" inputMode="decimal" min={0} step="0.01"
        value={rule.amountMinor / 100} onChange={(e) => onChange({ ...rule, amountMinor: Math.max(0, Math.round((Number(e.target.value) || 0) * 100)) })} />}
      {rule.type === 'has_tag' && <Field label={t('crm.seg.tag')} value={rule.tag} maxLength={40} dir="auto" onChange={(e) => onChange({ ...rule, tag: e.target.value })} />}
      {rule.type === 'consent' && <SelectField label={t('crm.seg.type.consent')} value={String(rule.value)} onChange={(e) => onChange({ ...rule, value: e.target.value === 'true' })}>
        <option value="true">{t('crm.seg.consent.yes')}</option><option value="false">{t('crm.seg.consent.no')}</option></SelectField>}
      {rule.type === 'branch' && <SelectField label={t('crm.seg.branch')} value={rule.branchId} onChange={(e) => onChange({ ...rule, branchId: e.target.value })}>
        {!rule.branchId && <option value="">—</option>}
        {org.branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}</SelectField>}
      {rule.type === 'purchased_product' && <SelectField label={t('crm.seg.product')} value={rule.productId} onChange={(e) => onChange({ ...rule, productId: e.target.value })}>
        <option value="">—</option>
        {products.map((p) => <option key={p.id} value={p.id}>{pick(locale, p.name, p.nameAr)}</option>)}</SelectField>}
      {rule.type === 'channel' && <SelectField label={t('crm.seg.channel')} value={rule.channel} onChange={(e) => onChange({ ...rule, channel: e.target.value as typeof rule.channel })}>
        {ORDER_CHANNELS.map((c) => <option key={c} value={c}>{t(`insights.channel.${c}`)}</option>)}</SelectField>}
      {rule.type === 'points_balance_gte' && <Field label={t('crm.seg.points')} type="number" inputMode="numeric" min={0} value={rule.points}
        onChange={(e) => onChange({ ...rule, points: whole(e.target.value, 0) })} />}
      {WINDOWED.has(rule.type) && (
        <Field label={t('crm.seg.within')} type="number" inputMode="numeric" min={1} max={3650} placeholder={t('crm.seg.withinAny')}
          value={(rule as { withinDays?: number }).withinDays ?? ''}
          onChange={(e) => onChange({ ...rule, withinDays: e.target.value ? whole(e.target.value, 1) : undefined } as SegmentRule)} />
      )}
      {onRemove && <button type="button" className="btn btn-sm btn-ghost btn-danger crm-seg-remove" onClick={onRemove}>{t('crm.seg.remove')}</button>}
    </div>
  );
}
