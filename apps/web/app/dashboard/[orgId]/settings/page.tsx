'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { parseMajor } from '@resuto/contracts';
import { Badge, Card, DataTable, Field, Modal, Notice, PageHeader, SelectField, Skeleton } from '@resuto/ui';
import { ApiRequestError } from '@/lib/api';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { SETTINGS_STRINGS } from './strings';

/** Lets wide tables scroll inside the page instead of widening it on phones. */
const FIT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } as const;


interface Branch {
  id: string; code: string; name: string; nameAr: string | null; address: string | null; city: string | null; phone: string | null; isActive: boolean;
  acceptsDineIn: boolean; acceptsPickup: boolean; acceptsDelivery: boolean; acceptsReservations: boolean; deliveryFeeMinor: number; minOrderMinor: number;
}
interface OrgDetail {
  id: string; name: string; nameAr: string | null; country: 'EG' | 'SA'; currency: 'EGP' | 'SAR'; timezone: string; defaultLocale: 'en' | 'ar'; status: string;
  legalName: string | null; taxRegistrationNumber: string | null; commercialRegistration: string | null; onboarding: Record<string, string>; branches: Branch[];
}

const STEPS = [
  { key: 'profile', href: '/settings' }, { key: 'branch', href: '/settings' }, { key: 'menu', href: '/menu' }, { key: 'floor', href: '/floor' },
  { key: 'website', href: '/website' }, { key: 'payments', href: '/payments' }, { key: 'launched', href: null },
] as const;
const major = (minor: number) => (minor / 100).toFixed(2).replace(/\.00$/, '');

export default function SettingsPage() {
  const { locale } = useT();
  const s = SETTINGS_STRINGS[locale];
  const { org, can, reload: reloadShell } = useOrg();
  const session = useSession();
  const detail = useApi<OrgDetail>(`/o/${org.id}`);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  const [stepBusy, setStepBusy] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

  useEffect(() => {
    const d = detail.data;
    if (d) setForm({ name: d.name, nameAr: d.nameAr ?? '', defaultLocale: d.defaultLocale, timezone: d.timezone, legalName: d.legalName ?? '',
      taxRegistrationNumber: d.taxRegistrationNumber ?? '', commercialRegistration: d.commercialRegistration ?? '' });
  }, [detail.data]);

  if (!can('org:manage')) return <><PageHeader title={s.title} /><Notice tone="warn">{s.noAccess}</Notice></>;
  if (detail.error) return <><PageHeader title={s.title} /><Notice tone="danger">{s.loadError} <button className="btn btn-sm" onClick={() => void detail.reload()}>{s.retry}</button></Notice></>;
  if (!detail.data) return <><PageHeader title={s.title} subtitle={s.subtitle} /><Card><Skeleton lines={6} /></Card></>;
  const d = detail.data;
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setMsg(null);
    try {
      await session.call(`/o/${org.id}`, { method: 'PATCH', body: {
        name: form.name, nameAr: form.nameAr || null, defaultLocale: form.defaultLocale, timezone: form.timezone,
        legalName: form.legalName || null, taxRegistrationNumber: form.taxRegistrationNumber || null, commercialRegistration: form.commercialRegistration || null,
      } });
      if (!d.onboarding.profile && form.legalName) await session.call(`/o/${org.id}/onboarding/profile`, { body: {} }).catch(() => undefined);
      setMsg({ tone: 'ok', text: s.saved });
      await Promise.all([detail.reload(), reloadShell()]);
    } catch (err) {
      setMsg({ tone: 'danger', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function markStep(step: string) {
    setStepBusy(step); setStepError(null);
    try {
      await session.call(`/o/${org.id}/onboarding/${step}`, { body: {} });
      await Promise.all([detail.reload(), reloadShell()]);
    } catch (err) {
      setStepError((err as Error).message);
    } finally {
      setStepBusy(null);
    }
  }

  const doneCount = STEPS.filter((x) => d.onboarding[x.key]).length;
  return (
    <div style={FIT}>
      <PageHeader title={s.title} subtitle={s.subtitle} />
      <div className="grid grid-2" style={{ marginBlockEnd: 16 }}>
        <Card title={s.profile}>
          <form onSubmit={saveProfile}>
            <div className="form-row">
              <Field label={s.name} value={form.name ?? ''} onChange={set('name')} required maxLength={120} />
              <Field label={s.nameAr} value={form.nameAr ?? ''} onChange={set('nameAr')} dir="rtl" maxLength={120} />
            </div>
            <div className="form-row">
              <SelectField label={s.locale} value={form.defaultLocale ?? 'en'} onChange={set('defaultLocale')}>
                <option value="en">{s.english}</option><option value="ar">{s.arabic}</option>
              </SelectField>
              <SelectField label={s.timezone} value={form.timezone ?? ''} onChange={set('timezone')}>
                {[...new Set([d.timezone, 'Africa/Cairo', 'Asia/Riyadh'])].map((z) => <option key={z} value={z}>{z}</option>)}
              </SelectField>
            </div>
            <Field label={s.legalName} value={form.legalName ?? ''} onChange={set('legalName')} maxLength={200} />
            <div className="form-row">
              <Field label={s.taxNumber} value={form.taxRegistrationNumber ?? ''} onChange={set('taxRegistrationNumber')} maxLength={40} dir="ltr" />
              <Field label={s.crNumber} value={form.commercialRegistration ?? ''} onChange={set('commercialRegistration')} maxLength={40} dir="ltr" />
            </div>
            <p className="fine">{s.countryLocked.replace('{country}', d.country).replace('{currency}', d.currency)}</p>
            {msg && <div style={{ marginBlockEnd: 12 }}><Notice tone={msg.tone}>{msg.text}</Notice></div>}
            <button className="btn btn-primary" disabled={saving}>{saving ? s.saving : s.save}</button>
          </form>
        </Card>

        {/* breaks the global .card + .card margin inside grids */}<span hidden />
        <Card title={s.checklist} actions={<Badge tone={doneCount === STEPS.length ? 'ok' : 'info'}>{doneCount}/{STEPS.length}</Badge>}>
          <p className="fine" style={{ marginTop: 0 }}>{s.checklistSub}</p>
          {stepError && <div style={{ marginBlockEnd: 10 }}><Notice tone="danger">{stepError}</Notice></div>}
          <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
            {STEPS.map((step) => {
              const done = !!d.onboarding[step.key];
              return (
                <li key={step.key} className="spread" style={{ padding: '10px 12px', borderRadius: 10, background: done ? 'var(--ok-bg)' : 'var(--surface-warm)' }}>
                  <span><span aria-hidden style={{ marginInlineEnd: 8 }}>{done ? '✓' : '○'}</span>{s[`st_${step.key}` as keyof typeof s]}</span>
                  <span className="row" style={{ gap: 6 }}>
                    {step.href && step.href !== '/settings' && <Link className="btn btn-sm btn-ghost" href={`/dashboard/${org.id}${step.href}`}>{s.open}</Link>}
                    {done ? <Badge tone="ok">{s.done}</Badge>
                      : <button className="btn btn-sm" disabled={stepBusy === step.key} onClick={() => void markStep(step.key)}>{s.markDone}</button>}
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="fine" style={{ marginBlockEnd: 0 }}>{s.launchedNote}</p>
        </Card>
      </div>

      <Card title={s.branches} actions={can('branches:manage') ? <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>{s.addBranch}</button> : undefined}>
        <DataTable rows={d.branches} rowKey={(b) => b.id} onRowClick={can('branches:manage') ? (b) => setEditing(b) : undefined} columns={[
          { key: 'name', header: s.name, render: (b) => <div><strong>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</strong><div className="fine" dir="ltr">{b.code}</div></div> },
          { key: 'city', header: s.city, render: (b) => b.city ?? '—' },
          { key: 'services', header: s.services, render: (b) => (
            <div className="row" style={{ gap: 4 }}>
              {b.acceptsDineIn && <Badge>{s.dineIn}</Badge>}{b.acceptsPickup && <Badge>{s.pickup}</Badge>}
              {b.acceptsDelivery && <Badge>{s.delivery} · {money(b.deliveryFeeMinor, d.currency, locale)}</Badge>}{b.acceptsReservations && <Badge>{s.reservations}</Badge>}
            </div>) },
          { key: 'status', header: '', align: 'end', render: (b) => b.isActive ? <Badge tone="ok">✓</Badge> : <Badge tone="warn">{s.inactive}</Badge> },
        ]} />
      </Card>
      {editing && <BranchModal branch={editing === 'new' ? null : editing} currency={d.currency} s={s} onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await Promise.all([detail.reload(), reloadShell()]); }} />}
    </div>
  );
}

function BranchModal({ branch, currency, s, onClose, onSaved }: {
  branch: Branch | null; currency: 'EGP' | 'SAR'; s: (typeof SETTINGS_STRINGS)['en']; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { org } = useOrg();
  const session = useSession();
  const [f, setF] = useState({
    name: branch?.name ?? '', nameAr: branch?.nameAr ?? '', code: branch?.code ?? '', address: branch?.address ?? '', city: branch?.city ?? '', phone: branch?.phone ?? '',
    acceptsDineIn: branch?.acceptsDineIn ?? true, acceptsPickup: branch?.acceptsPickup ?? true, acceptsDelivery: branch?.acceptsDelivery ?? false,
    acceptsReservations: branch?.acceptsReservations ?? true, deliveryFee: major(branch?.deliveryFeeMinor ?? 0), minOrder: major(branch?.minOrderMinor ?? 0),
    isActive: branch?.isActive ?? true,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ text: string; limit?: boolean } | null>(null);
  const text = (k: keyof typeof f) => ({ value: String(f[k]), onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })) });
  const flag = (k: keyof typeof f, label: string) => (
    <label className="check"><input type="checkbox" checked={!!f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.checked }))} /> {label}</label>
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setPending(true); setError(null);
    try {
      const body = {
        name: f.name, nameAr: f.nameAr || null, address: f.address || null, city: f.city || null, phone: f.phone || null,
        acceptsDineIn: f.acceptsDineIn, acceptsPickup: f.acceptsPickup, acceptsDelivery: f.acceptsDelivery, acceptsReservations: f.acceptsReservations,
        deliveryFeeMinor: parseMajor(f.deliveryFee || '0', currency), minOrderMinor: parseMajor(f.minOrder || '0', currency),
        ...(branch ? { isActive: f.isActive } : f.code ? { code: f.code } : {}),
      };
      if (branch) await session.call(`/o/${org.id}/branches/${branch.id}`, { method: 'PATCH', body });
      else await session.call(`/o/${org.id}/branches`, { body });
      await onSaved();
    } catch (err) {
      const x = err as ApiRequestError;
      setError(x instanceof RangeError ? { text: (err as Error).message } : { text: x.message, limit: x.code === 'plan_limit_reached' });
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={branch ? s.editBranch : s.addBranch}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label={s.name} required maxLength={120} {...text('name')} />
          <Field label={s.nameAr} dir="rtl" maxLength={120} {...text('nameAr')} />
        </div>
        {!branch && <Field label={s.code} pattern="[a-z0-9-]{1,40}" dir="ltr" placeholder="downtown" {...text('code')} />}
        <div className="form-row">
          <Field label={s.city} maxLength={80} {...text('city')} />
          <Field label={s.phone} maxLength={30} dir="ltr" {...text('phone')} />
        </div>
        <Field label={s.address} maxLength={300} {...text('address')} />
        <div className="row" style={{ gap: 14, marginBlockEnd: 14 }}>
          {flag('acceptsDineIn', s.dineIn)}{flag('acceptsPickup', s.pickup)}{flag('acceptsDelivery', s.delivery)}{flag('acceptsReservations', s.reservations)}
        </div>
        <div className="form-row">
          <Field label={s.deliveryFee.replace('{currency}', currency)} inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" {...text('deliveryFee')} />
          <Field label={s.minOrder.replace('{currency}', currency)} inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" {...text('minOrder')} />
        </div>
        {branch && <div style={{ marginBlockEnd: 14 }}>{flag('isActive', s.active)}</div>}
        {error && <div style={{ marginBlockEnd: 12 }}><Notice tone="danger">{error.limit ? s.limitHit : error.text} {error.limit && <Link href={`/dashboard/${org.id}/billing`}>{s.upgrade}</Link>}</Notice></div>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose}>{s.cancel}</button>
          <button className="btn btn-primary" disabled={pending}>{pending ? s.saving : s.save}</button>
        </div>
      </form>
    </Modal>
  );
}
