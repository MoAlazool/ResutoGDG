'use client';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { parseMajor, type ServiceMode, type SetupChecklist } from '@resuto/contracts';
import { Badge, Card, DataTable, Field, Modal, Notice, SelectField, Skeleton, Tabs } from '@resuto/ui';
import { ServiceModeCards, VenueQrCard } from '@/components/ops/ServiceMode';
import '@/components/ops/ops.css';
import { ApiRequestError } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { formatNumber } from '@resuto/contracts';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { SettingsShell } from '@/components/settings/SettingsShell';
import styles from './settings.module.css';
import { SETTINGS_STRINGS } from './strings';

interface Branch {
  id: string; code: string; name: string; nameAr: string | null; address: string | null; city: string | null; district?: string | null; districtAr?: string | null;
  phone: string | null; isActive: boolean;
  acceptsDineIn: boolean; acceptsPickup: boolean; acceptsDelivery: boolean; acceptsReservations: boolean; deliveryFeeMinor: number; minOrderMinor: number;
  deliveryRadiusM: number | null; reservationDurationMin: number | null; reservationBufferMin: number | null; reservationDepositMinor: number | null; serviceMode?: ServiceMode;
}
interface OrgDetail {
  id: string; name: string; nameAr: string | null; country: 'EG' | 'SA'; currency: 'EGP' | 'SAR'; timezone: string; defaultLocale: 'en' | 'ar'; status: string;
  legalName: string | null; taxRegistrationNumber: string | null; commercialRegistration: string | null; onboarding: Record<string, string>; branches: Branch[];
}

const major = (minor: number) => (minor / 100).toFixed(2).replace(/\.00$/, '');

export default function SettingsPage() {
  const { locale, t } = useT();
  const s = SETTINGS_STRINGS[locale];
  const { org, can, reload: reloadShell } = useOrg();
  const session = useSession();
  const detail = useApi<OrgDetail>(`/o/${org.id}`);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  // The launch checklist is derived on the server from the restaurant's data (FT-13); it cannot be ticked by hand.
  const setup = useApi<SetupChecklist>(can('org:manage') ? `/o/${org.id}/setup` : null);
  const [modeBranch, setModeBranch] = useState<string | null>(null);

  useEffect(() => {
    const d = detail.data;
    if (d) setForm({ name: d.name, nameAr: d.nameAr ?? '', defaultLocale: d.defaultLocale, timezone: d.timezone, legalName: d.legalName ?? '',
      taxRegistrationNumber: d.taxRegistrationNumber ?? '', commercialRegistration: d.commercialRegistration ?? '' });
  }, [detail.data]);

  const header = { title: s.title, subtitle: s.subtitle };
  if (!can('org:manage')) return <SettingsShell header={{ title: s.title }}><Notice tone="warn">{s.noAccess}</Notice></SettingsShell>;
  if (detail.error) return <SettingsShell header={{ title: s.title }}><Notice tone="danger">{s.loadError} <button className="btn btn-sm" onClick={() => void detail.reload()}>{s.retry}</button></Notice></SettingsShell>;
  if (!detail.data) return <SettingsShell header={header}><Card><Skeleton lines={6} /></Card></SettingsShell>;
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
      setMsg({ tone: 'ok', text: s.saved });
      await Promise.all([detail.reload(), reloadShell(), setup.reload()]);
    } catch (err) {
      setMsg({ tone: 'danger', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  }

  const steps = (setup.data?.steps ?? []).filter((x) => x.step !== 'welcome');
  const doneCount = steps.filter((x) => x.done).length;
  const activeBranches = d.branches.filter((b) => b.isActive);
  const mb = activeBranches.find((b) => b.id === modeBranch) ?? activeBranches[0];
  const refreshAll = async () => { await Promise.all([detail.reload(), reloadShell(), setup.reload()]); };
  return (
    // Settings › Messaging (21-INBOX), team, billing, data and the audit log are the template's other sections.
    <SettingsShell header={header}>
      {/* The service model comes first, as in legacy settings; profile and the launch checklist follow (PAR-08). */}
      {mb && (
        <Card title={t('ops.mode.title')}>
          <p className="fine mbs-0">{t('ops.mode.subtitle', { branch: pick(locale, mb.name, mb.nameAr) })}</p>
          {activeBranches.length > 1 && (
            <Tabs value={mb.id} onChange={setModeBranch} label={s.branches}
              tabs={activeBranches.map((b) => ({ key: b.id, label: pick(locale, b.name, b.nameAr) }))} />
          )}
          <ServiceModeCards key={`${mb.id}:${mb.serviceMode}:${mb.acceptsReservations}`} orgId={org.id} branch={mb} canEdit={can('branches:manage')} onSaved={refreshAll} />
          {mb.serviceMode === 'counter' && <VenueQrCard orgId={org.id} branchId={mb.id} canRotate={can('floor:write')} />}
        </Card>
      )}
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
            {msg && <div className="mbe-12"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
            <button className="btn btn-primary" disabled={saving}>{saving ? s.saving : s.save}</button>
          </form>
        </Card>
        <Card title={s.checklist} actions={setup.data ? <Badge tone={setup.data.launched ? 'ok' : 'info'}><span className="num">{formatNumber(doneCount, locale)}/{formatNumber(steps.length, locale)}</span></Badge> : undefined}>
          <p className="fine mbs-0">{t('ops.setup.checklistSub')}</p>
          {setup.error && <Notice tone="danger">{setup.error.message}</Notice>}
          {!setup.data ? <Skeleton lines={5} /> : (
            <div className="setup-checklist">
              {steps.map((x) => (
                <p key={x.step} className={x.done ? 'is-done' : undefined}>
                  <span aria-hidden="true">{x.done ? '✓' : '○'}</span>
                  <Link href={`/dashboard/${org.id}/setup?step=${x.step}`}>{t(`ops.setup.step.${x.step}`)}</Link>
                  <small>{x.done ? s.done : x.required ? t('ops.setup.status.todo') : t('ops.setup.status.optional')}</small>
                </p>
              ))}
            </div>
          )}
          <Link className="btn btn-sm btn-primary" href={`/dashboard/${org.id}/setup`}>✦ {t('ops.setup.link')}</Link>
        </Card>

      {mb && <PolicyCard key={`policy:${mb.id}`} branch={mb} currency={d.currency} canEdit={can('branches:manage')} onSaved={refreshAll} />}

      <Card title={s.branches} actions={can('branches:manage') ? <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>{s.addBranch}</button> : undefined}>
        <DataTable rows={d.branches} rowKey={(b) => b.id} onRowClick={can('branches:manage') ? (b) => setEditing(b) : undefined} columns={[
          { key: 'name', header: s.name, render: (b) => <div><strong>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</strong><div className="fine" dir="ltr">{b.code}</div></div> },
          { key: 'city', header: s.city, render: (b) => b.city ?? '—' },
          { key: 'services', header: s.services, render: (b) => (
            <div className="row gap-4">
              {b.acceptsDineIn && <Badge>{s.dineIn}</Badge>}{b.acceptsPickup && <Badge>{s.pickup}</Badge>}
              {b.acceptsDelivery && <Badge>{s.delivery} · {money(b.deliveryFeeMinor, d.currency, locale)}</Badge>}{b.acceptsReservations && <Badge>{s.reservations}</Badge>}
            </div>) },
          { key: 'status', header: '', align: 'end', render: (b) => b.isActive ? <Badge tone="ok">✓</Badge> : <Badge tone="warn">{s.inactive}</Badge> },
        ]} />
      </Card>
      {editing && <BranchModal branch={editing === 'new' ? null : editing} currency={d.currency} s={s} onClose={() => setEditing(null)}
        onSaved={async () => { setEditing(null); await Promise.all([detail.reload(), reloadShell()]); }} />}
    </SettingsShell>
  );
}

function BranchModal({ branch, currency, s, onClose, onSaved }: {
  branch: Branch | null; currency: 'EGP' | 'SAR'; s: (typeof SETTINGS_STRINGS)['en']; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const { org } = useOrg();
  const session = useSession();
  const [f, setF] = useState({
    name: branch?.name ?? '', nameAr: branch?.nameAr ?? '', code: branch?.code ?? '', address: branch?.address ?? '', city: branch?.city ?? '', phone: branch?.phone ?? '',
    district: branch?.district ?? '', districtAr: branch?.districtAr ?? '',
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
        district: f.district || null, districtAr: f.districtAr || null,
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
        <div className="form-row">
          <Field label={s.district} hint={s.districtHint} maxLength={80} {...text('district')} />
          <Field label={s.districtAr} dir="rtl" maxLength={80} {...text('districtAr')} />
        </div>
        <div className={styles.flags}>
          {flag('acceptsDineIn', s.dineIn)}{flag('acceptsPickup', s.pickup)}{flag('acceptsDelivery', s.delivery)}{flag('acceptsReservations', s.reservations)}
        </div>
        <div className="form-row">
          <Field label={s.deliveryFee.replace('{currency}', currency)} inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" {...text('deliveryFee')} />
          <Field label={s.minOrder.replace('{currency}', currency)} inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" {...text('minOrder')} />
        </div>
        {branch && <div className="mbe-14">{flag('isActive', s.active)}</div>}
        {error && <div className="mbe-12"><Notice tone="danger">{error.limit ? s.limitHit : error.text} {error.limit && <Link href={`/dashboard/${org.id}/billing`}>{s.upgrade}</Link>}</Notice></div>}
        <div className="row justify-end">
          <button type="button" className="btn" onClick={onClose}>{s.cancel}</button>
          <button className="btn btn-primary" disabled={pending}>{pending ? s.saving : s.save}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Reservation & delivery policy of one branch (legacy settings: duration, turnaround buffer, deposit, delivery fee). */
function PolicyCard({ branch, currency, canEdit, onSaved }: { branch: Branch; currency: 'EGP' | 'SAR'; canEdit: boolean; onSaved: () => Promise<void> }) {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [pending, setPending] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
  const tables = (branch.serviceMode ?? 'tables') === 'tables';
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? '').trim();
    setPending(true); setMsg(null);
    try {
      const radiusKm = v('radius');
      await session.call(`/o/${org.id}/branches/${branch.id}`, { method: 'PATCH', body: {
        ...(tables && branch.acceptsReservations ? {
          reservationDurationMin: Number(v('duration')), reservationBufferMin: Number(v('buffer')), reservationDepositMinor: parseMajor(v('deposit') || '0', currency),
        } : {}),
        acceptsPickup: f.has('pickup'), acceptsDelivery: f.has('delivery'),
        deliveryFeeMinor: parseMajor(v('fee') || '0', currency), minOrderMinor: parseMajor(v('min') || '0', currency),
        deliveryRadiusM: radiusKm ? Math.round(Number(radiusKm) * 1000) : null,
      } });
      setMsg({ tone: 'ok', text: t('ops.policy.saved') });
      await onSaved();
    } catch (err) { setMsg({ tone: 'danger', text: (err as Error).message }); } finally { setPending(false); }
  }
  return (
    <Card title={t('ops.policy.title')}>
      <p className="fine mbs-0">{t('ops.policy.subtitle')}</p>
      <form onSubmit={submit}>
        <fieldset disabled={!canEdit || pending} className={styles.fieldset}>
          {tables && branch.acceptsReservations ? (
            <div className="form-row">
              <Field label={t('ops.policy.duration')} name="duration" type="number" min={15} max={600} required defaultValue={branch.reservationDurationMin ?? 90} />
              <Field label={t('ops.policy.buffer')} name="buffer" type="number" min={0} max={240} required defaultValue={branch.reservationBufferMin ?? 15} />
              <Field label={t('ops.policy.deposit', { currency })} name="deposit" inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" defaultValue={major(branch.reservationDepositMinor ?? 0)} hint={t('ops.policy.depositHint')} />
            </div>
          ) : <p className="fine">{t('ops.policy.reservationsOff')}</p>}
          <div className={styles.flags}>
            <label className="check"><input type="checkbox" name="pickup" defaultChecked={branch.acceptsPickup} /> {t('ops.policy.enablePickup')}</label>
            <label className="check"><input type="checkbox" name="delivery" defaultChecked={branch.acceptsDelivery} /> {t('ops.policy.enableDelivery')}</label>
          </div>
          <div className="form-row">
            <Field label={t('ops.policy.deliveryFee', { currency })} name="fee" inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" defaultValue={major(branch.deliveryFeeMinor)} />
            <Field label={t('ops.policy.minOrder', { currency })} name="min" inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" defaultValue={major(branch.minOrderMinor)} />
            <Field label={t('ops.policy.radius')} name="radius" inputMode="decimal" pattern="\d+(\.\d{1,2})?" dir="ltr" defaultValue={branch.deliveryRadiusM ? String(branch.deliveryRadiusM / 1000) : ''} />
          </div>
          {msg && <div className="mbe-12"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
          {canEdit && <button className="btn btn-primary" disabled={pending}>{pending ? t('state.loading') : t('action.save')}</button>}
        </fieldset>
      </form>
    </Card>
  );
}
