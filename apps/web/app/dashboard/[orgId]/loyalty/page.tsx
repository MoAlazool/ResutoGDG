'use client';
import {
  LOYALTY_CHANNELS, LOYALTY_LEDGER_KINDS, formatMoney, formatNumber, parseMajor, pointsFor,
  type Currency, type LoyaltyLedgerEntry, type MenuEditorView, type LoyaltyLedgerKind, type LoyaltyProgram, type LoyaltyProgramInput, type LoyaltyReward,
} from '@resuto/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Badge, DataTable, EmptyState, Field, Loadable, Modal, Notice, PageHeader, SelectField, SkeletonBlock, SkeletonTable, Stat, Tabs, useAction,
} from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { LedgerTable } from './_components/LedgerTable';
import { pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

type Tab = 'rules' | 'rewards' | 'ledger';
interface ProgramView { program: LoyaltyProgram; rewards: LoyaltyReward[] }
interface LedgerView { items: LoyaltyLedgerEntry[]; nextCursor: string | null; totals: { outstanding: number; members: number } }


/** Loyalty (FT-03): earning rules, rewards and the append-only points ledger. */
export default function LoyaltyPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const [tab, setTab] = useState<Tab>('rules');
  const program = useApi<ProgramView>(`/o/${org.id}/loyalty/program`);
  const totals = useApi<LedgerView>(`/o/${org.id}/loyalty/ledger?limit=1`);
  const active = program.data?.program.isActive;
  return (
    <ModuleGate module="marketing" permission="marketing:read">
      <PageHeader overline={t('nav.group.customers')} title={t('loyalty.title')} subtitle={t('loyalty.subtitle')} />
      <div className="grid grid-3" style={{ marginBlockEnd: 18 }}>
        <Stat label={t('loyalty.status')} value={active === undefined ? '—' : active ? t('loyalty.on') : t('loyalty.off')} />
        <Stat label={t('loyalty.liability')} value={totals.data ? formatNumber(totals.data.totals.outstanding, locale) : '—'} />
        <Stat label={t('loyalty.members')} value={totals.data ? formatNumber(totals.data.totals.members, locale) : '—'} />
      </div>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { key: 'rules', label: t('loyalty.tab.rules') },
        { key: 'rewards', label: t('loyalty.tab.rewards') },
        { key: 'ledger', label: t('loyalty.tab.ledger') },
      ]} />
      {tab === 'ledger' ? <Ledger /> : (
        <Loadable state={program} locale={locale} timeZone={org.timezone} skeleton={<div className="card"><SkeletonBlock height={240} /></div>}>
          {(d) => tab === 'rules' ? <Rules initial={d.program} onSaved={program.reload} /> : <Rewards rewards={d.rewards} onChange={program.reload} />}
        </Loadable>
      )}
    </ModuleGate>
  );
}

function Rules({ initial, onSaved }: { initial: LoyaltyProgram; onSaved: () => Promise<void> }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const currency = org.currency as Currency;
  const { updatedAt: _u, ...start } = initial;
  const [p, setP] = useState<LoyaltyProgramInput>(start);
  const [unitMajor, setUnitMajor] = useState(String(initial.unitMinor / 100));
  const [minMajor, setMinMajor] = useState(String(initial.minOrderMinor / 100));
  const [saved, setSaved] = useState(false);
  const menu = useApi<MenuEditorView>(`/o/${org.id}/menu`);
  useEffect(() => setSaved(false), [p, unitMajor, minMajor]);
  const editable = can('marketing:write');
  const toMinor = (v: string) => { try { return parseMajor(v || '0', currency); } catch { return NaN; } };
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const unitMinor = toMinor(unitMajor);
    const minOrderMinor = toMinor(minMajor);
    if (!Number.isFinite(unitMinor) || unitMinor < 1 || !Number.isFinite(minOrderMinor)) throw new Error(t('loyalty.err.invalidAmount'));
    await call(`/o/${org.id}/loyalty/program`, { method: 'PUT', body: { ...p, unitMinor, minOrderMinor } });
    await onSaved();
    setSaved(true);
  });
  const sample = 25_000;
  const examplePoints = pointsFor({ ...p, unitMinor: Math.max(1, toMinor(unitMajor) || 1) }, sample);
  const toggle = <T extends string>(list: T[] | null, all: readonly T[], v: T): T[] | null => {
    const cur = list ?? [...all];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    return next.length === all.length ? null : next.length ? next : cur;
  };
  return (
    <form className="card stack" onSubmit={save.run} style={{ gap: 16 }}>
      <label className="check"><input type="checkbox" checked={p.isActive} disabled={!editable} onChange={(e) => setP({ ...p, isActive: e.target.checked })} /> <strong>{t('loyalty.rules.active')}</strong></label>
      <div className="form-row">
        <SelectField label={t('loyalty.rules.mode')} value={p.earnMode} disabled={!editable} onChange={(e) => setP({ ...p, earnMode: e.target.value as 'spend' | 'visit' })}>
          <option value="spend">{t('loyalty.rules.mode.spend')}</option>
          <option value="visit">{t('loyalty.rules.mode.visit')}</option>
        </SelectField>
        {p.earnMode === 'spend' ? <>
          <Field label={t('loyalty.rules.points')} inputMode="decimal" value={String(p.pointsPerUnit)} disabled={!editable}
            onChange={(e) => setP({ ...p, pointsPerUnit: Math.max(0, Math.round((Number(e.target.value) || 0) * 100) / 100) })} />
          <Field label={`${t('loyalty.rules.per')} (${currency})`} inputMode="decimal" value={unitMajor} disabled={!editable} onChange={(e) => setUnitMajor(e.target.value)} />
          <SelectField label={t('loyalty.rules.rounding')} value={p.rounding} disabled={!editable} onChange={(e) => setP({ ...p, rounding: e.target.value as LoyaltyProgramInput['rounding'] })}>
            {(['floor', 'round', 'ceil'] as const).map((r) => <option key={r} value={r}>{t(`loyalty.rules.rounding.${r}`)}</option>)}
          </SelectField>
        </> : <Field label={t('loyalty.rules.stamps')} inputMode="numeric" value={String(p.stampsPerVisit)} disabled={!editable}
          onChange={(e) => setP({ ...p, stampsPerVisit: Math.max(0, Math.min(100, Math.floor(Number(e.target.value) || 0))) })} />}
      </div>
      <p className="fine" style={{ margin: 0 }}>{t('loyalty.rules.example', { amount: formatMoney(sample, currency, locale), points: examplePoints })}</p>
      <div className="form-row">
        <Field label={`${t('loyalty.rules.minOrder')} (${currency})`} inputMode="decimal" value={minMajor} disabled={!editable} onChange={(e) => setMinMajor(e.target.value)} />
        <Field label={t('loyalty.rules.expiry')} inputMode="numeric" value={p.expiryDays === null ? '' : String(p.expiryDays)} hint={t('loyalty.rules.expiryHint')} disabled={!editable}
          onChange={(e) => setP({ ...p, expiryDays: e.target.value.trim() ? Math.max(1, Math.min(3650, Math.floor(Number(e.target.value) || 1))) : null })} />
      </div>
      <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
        <legend className="fine">{t('loyalty.rules.channels')} {p.eligibleChannels === null && <Badge>{t('loyalty.rules.allChannels')}</Badge>}</legend>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {LOYALTY_CHANNELS.map((c) => (
            <label key={c} className="check"><input type="checkbox" disabled={!editable} checked={p.eligibleChannels === null || p.eligibleChannels.includes(c)}
              onChange={() => setP({ ...p, eligibleChannels: toggle(p.eligibleChannels, LOYALTY_CHANNELS, c) })} /> {t(`insights.channel.${c}`)}</label>
          ))}
        </div>
      </fieldset>
      {org.branches.length > 1 && (
        <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend className="fine">{t('loyalty.rules.branches')} {p.eligibleBranchIds === null && <Badge>{t('loyalty.rules.allBranches')}</Badge>}</legend>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {org.branches.map((b) => (
              <label key={b.id} className="check"><input type="checkbox" disabled={!editable} checked={p.eligibleBranchIds === null || p.eligibleBranchIds.includes(b.id)}
                onChange={() => setP({ ...p, eligibleBranchIds: toggle(p.eligibleBranchIds, org.branches.map((x) => x.id), b.id) })} /> <bdi>{pick(locale, b.name, b.nameAr)}</bdi></label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="stack" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
        <legend className="fine">{t('loyalty.rules.excluded')}</legend>
        <small className="fine">{t('loyalty.rules.excludedHint')}</small>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', maxHeight: 180, overflowY: 'auto' }}>
          {(menu.data?.products ?? []).map((pr) => (
            <label key={pr.id} className="check"><input type="checkbox" disabled={!editable} checked={p.excludedProductIds.includes(pr.id)}
              onChange={(e) => setP({ ...p, excludedProductIds: e.target.checked ? [...p.excludedProductIds, pr.id] : p.excludedProductIds.filter((x) => x !== pr.id) })} />
              <bdi>{pick(locale, pr.name, pr.nameAr)}</bdi></label>
          ))}
        </div>
      </fieldset>
      <Notice>{t('loyalty.rules.policy')}</Notice>
      {save.error && <Notice tone="danger">{save.error}</Notice>}
      {saved && <Notice tone="ok">{t('loyalty.rules.saved')}</Notice>}
      {editable && <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={save.pending}>{t('action.save')}</button></div>}
    </form>
  );
}

function Rewards({ rewards, onChange }: { rewards: LoyaltyReward[]; onChange: () => Promise<void> }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const currency = org.currency as Currency;
  const [draft, setDraft] = useState<{ name: string; nameAr: string; points: string; kind: 'fixed' | 'percent'; value: string; cap: string; min: string } | null>(null);
  const editable = can('marketing:write');
  const money = (minor: number | null) => (minor === null ? '—' : formatMoney(minor, currency, locale));
  const create = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const d = draft!;
    const value = d.kind === 'fixed' ? parseMajor(d.value, currency) : Math.round(Number(d.value) * 100);
    await call(`/o/${org.id}/loyalty/rewards`, { method: 'POST', body: {
      name: d.name, nameAr: d.nameAr || null, pointsCost: Math.floor(Number(d.points)), kind: d.kind, value,
      maxDiscountMinor: d.cap ? parseMajor(d.cap, currency) : null, minOrderMinor: d.min ? parseMajor(d.min, currency) : 0,
    } });
    setDraft(null);
    await onChange();
  });
  const toggle = useAction(async (r: LoyaltyReward) => {
    await call(`/o/${org.id}/loyalty/rewards/${r.id}`, { method: 'PATCH', body: { isActive: !r.isActive } });
    await onChange();
  });
  return (
    <div className="stack">
      <Notice>{t('loyalty.rewards.howRedeem')}</Notice>
      {editable && <div><button type="button" className="btn btn-primary" onClick={() => setDraft({ name: '', nameAr: '', points: '100', kind: 'fixed', value: '', cap: '', min: '' })}>{t('loyalty.rewards.add')}</button></div>}
      {toggle.error && <Notice tone="danger">{toggle.error}</Notice>}
      <DataTable rows={rewards} rowKey={(r) => r.id}
        empty={<EmptyState title={t('loyalty.rewards.empty')}>{t('loyalty.rewards.emptyBody')}</EmptyState>}
        columns={[
          { key: 'name', header: t('loyalty.rewards.name'), render: (r) => <bdi>{pick(locale, r.name, r.nameAr)}</bdi> },
          { key: 'cost', header: t('loyalty.rewards.cost'), align: 'end', render: (r) => <span className="num">{formatNumber(r.pointsCost, locale)}</span> },
          { key: 'value', header: t('loyalty.rewards.value'), render: (r) => r.kind === 'fixed' ? money(r.value)
            : <>{t('loyalty.rewards.percentValue', { pct: formatNumber(r.value / 100, locale) })}{r.maxDiscountMinor ? <span className="fine"> · ≤ {money(r.maxDiscountMinor)}</span> : null}</> },
          { key: 'min', header: t('loyalty.rewards.minOrder'), render: (r) => (r.minOrderMinor ? money(r.minOrderMinor) : '—') },
          { key: 'st', header: '', render: (r) => <Badge tone={r.isActive ? 'ok' : 'neutral'}>{r.isActive ? t('loyalty.rewards.active') : t('loyalty.rewards.paused')}</Badge> },
          { key: 'act', header: '', align: 'end', render: (r) => editable
            ? <button type="button" className="btn btn-sm btn-ghost" disabled={toggle.pending} onClick={() => toggle.run(r)}>{r.isActive ? t('loyalty.rewards.pause') : t('loyalty.rewards.resume')}</button> : null },
        ]} />
      <Modal open={!!draft} onClose={() => setDraft(null)} title={t('loyalty.rewards.add')}>
        {draft && (
          <form onSubmit={create.run}>
            <Field label={t('loyalty.rewards.name')} required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Field label={t('loyalty.rewards.nameAr')} maxLength={80} dir="rtl" value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} />
            <div className="form-row">
              <Field label={t('loyalty.rewards.cost')} required inputMode="numeric" value={draft.points} onChange={(e) => setDraft({ ...draft, points: e.target.value })} />
              <SelectField label={t('loyalty.rewards.kind')} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as 'fixed' | 'percent' })}>
                <option value="fixed">{t('loyalty.rewards.kind.fixed')}</option>
                <option value="percent">{t('loyalty.rewards.kind.percent')}</option>
              </SelectField>
              <Field label={draft.kind === 'fixed' ? `${t('loyalty.rewards.amount')} (${currency})` : `${t('loyalty.rewards.percent')} (%)`} required inputMode="decimal"
                value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} />
            </div>
            <div className="form-row">
              {draft.kind === 'percent' && <Field label={`${t('loyalty.rewards.cap')} (${currency})`} inputMode="decimal" value={draft.cap} onChange={(e) => setDraft({ ...draft, cap: e.target.value })} />}
              <Field label={`${t('loyalty.rewards.minOrder')} (${currency})`} inputMode="decimal" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} />
            </div>
            {create.error && <Notice tone="danger">{create.error}</Notice>}
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={create.pending}>{t('action.save')}</button></div>
          </form>
        )}
      </Modal>
    </div>
  );
}

function Ledger() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const [kind, setKind] = useState<LoyaltyLedgerKind | ''>('');
  const state = useApi<LedgerView>(`/o/${org.id}/loyalty/ledger?limit=100${kind ? `&kind=${kind}` : ''}`);
  return (
    <div className="stack">
      <div className="row spread">
        <SelectField label={t('loyalty.ledger.kind')} value={kind} onChange={(e) => setKind(e.target.value as LoyaltyLedgerKind | '')}>
          <option value="">{t('loyalty.ledger.allKinds')}</option>
          {LOYALTY_LEDGER_KINDS.map((k) => <option key={k} value={k}>{t(`loyalty.kind.${k}`)}</option>)}
        </SelectField>
        <span className="fine">{t('loyalty.ledger.appendOnly')}</span>
      </div>
      <Loadable state={state} locale={locale} timeZone={org.timezone} skeleton={<SkeletonTable rows={8} cols={6} />}>
        {(d) => <LedgerTable rows={d.items} pending={state.pending} />}
      </Loadable>
    </div>
  );
}
