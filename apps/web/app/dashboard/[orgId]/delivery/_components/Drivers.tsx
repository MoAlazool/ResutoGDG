'use client';
import { useState, type FormEvent } from 'react';
import { VEHICLE_TYPES, type DriverView } from '@resuto/contracts';
import { Card, DataTable, EmptyState, Field, Modal, Notice, SelectField, Skeleton, useAction } from '@resuto/ui';
import { money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { Availability } from './shared';

/** Driver roster: invite (members:manage), edit vehicle/contact/branches, suspend or reactivate. */
export function Drivers() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const drivers = useApi<{ items: DriverView[] }>(`/o/${org.id}/delivery/drivers?includeSuspended=true`);
  const [editing, setEditing] = useState<DriverView | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const act = useAction(async (fn: () => Promise<unknown>) => { const r = await fn(); await drivers.reload(); return r; });

  async function sendInvite(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const branch = String(f.get('branchId') || '');
    const res = await act.run(() => call<{ token: string }>(`/o/${org.id}/invitations`, {
      body: { email: String(f.get('email')), role: 'driver', branchIds: branch ? [branch] : null },
    }));
    if (res && typeof res === 'object' && 'token' in res) {
      setInvite(`${window.location.origin}/invite/${(res as { token: string }).token}`);
      (e.target as HTMLFormElement).reset();
    }
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing) return;
    const f = new FormData(e.currentTarget);
    const branch = String(f.get('branchId') || '');
    const ok = await act.run(() => call(`/o/${org.id}/delivery/drivers/${editing.id}`, {
      method: 'PATCH',
      body: {
        displayName: String(f.get('displayName')), phone: String(f.get('phone') || '') || null, vehicleType: f.get('vehicleType'),
        vehiclePlate: String(f.get('vehiclePlate') || '') || null, branchIds: branch ? [branch] : null,
      },
    }));
    if (ok) setEditing(null);
  }

  const branchName = (id: string) => org.branches.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="stack">
      {can('members:manage') && (
        <Card title={t('driver.dispatch.invite')}>
          <form className="form-row items-end" onSubmit={sendInvite}>
            <Field label={t('auth.email')} name="email" type="email" required />
            {org.branches.length > 1 && (
              <SelectField label={t('driver.dispatch.branch')} name="branchId" defaultValue="">
                <option value="">{t('driver.dispatch.allBranches')}</option>
                {org.branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
              </SelectField>
            )}
            <div className="field"><button className="btn btn-primary" disabled={act.pending}>{t('driver.dispatch.sendInvite')}</button></div>
          </form>
          {invite && <Notice tone="ok">{t('driver.dispatch.inviteLink')} <code className="break-all" dir="ltr">{invite}</code></Notice>}
          <p className="fine m-0">{t('driver.dispatch.inviteHint')}</p>
        </Card>
      )}
      {act.error && <Notice tone="danger">{act.error}</Notice>}
      {drivers.loading && !drivers.data ? <Skeleton lines={5} /> : drivers.error ? <Notice tone="danger">{drivers.error.message}</Notice> : (
        <DataTable rows={drivers.data!.items} rowKey={(d) => d.id}
          empty={<EmptyState title={t('driver.dispatch.noDrivers')}>{t('driver.dispatch.noDriversHint')}</EmptyState>}
          columns={[
            { key: 'name', header: t('driver.dispatch.name'), render: (d) => <><strong>{d.displayName}</strong>{d.phone && <div className="fine text-start" dir="ltr">{d.phone}</div>}</> },
            { key: 'status', header: t('driver.availability.label'), render: (d) => <Availability driver={d} /> },
            { key: 'vehicle', header: t('driver.dispatch.vehicle'), render: (d) => <>{t(`driver.vehicle.${d.vehicleType}`)}{d.vehiclePlate ? ` · ${d.vehiclePlate}` : ''}</> },
            { key: 'branches', header: t('driver.dispatch.branch'), render: (d) => (d.branchIds?.length ? d.branchIds.map(branchName).join(', ') : t('driver.dispatch.allBranches')) },
            { key: 'jobs', header: t('driver.dispatch.active'), align: 'end', render: (d) => d.activeJobs },
            { key: 'cash', header: t('driver.cash.onHand'), align: 'end', render: (d) => money(d.cashOnHandMinor, org.currency, locale) },
            { key: 'seen', header: t('driver.dispatch.location'), render: (d) => (d.lastLocation ? time(d.lastLocation.at, locale) : '—') },
            { key: 'actions', header: '', render: (d) => (
              <div className="row gap-6">
                <button className="btn btn-sm" onClick={() => setEditing(d)}>{t('action.edit')}</button>
                {d.status === 'suspended'
                  ? <button className="btn btn-sm btn-leaf" disabled={act.pending} onClick={() => void act.run(() => call(`/o/${org.id}/delivery/drivers/${d.id}`, { method: 'PATCH', body: { status: 'active' } }))}>{t('driver.dispatch.activate')}</button>
                  : <button className="btn btn-sm btn-danger" disabled={act.pending} onClick={() => void act.run(() => call(`/o/${org.id}/delivery/drivers/${d.id}`, { method: 'PATCH', body: { status: 'suspended' } }))}>{t('driver.dispatch.suspend')}</button>}
              </div>
            ) },
          ]} />
      )}
      {editing && (
        <Modal open onClose={() => setEditing(null)} title={editing.displayName}>
          <form onSubmit={save}>
            <Field label={t('driver.dispatch.name')} name="displayName" defaultValue={editing.displayName} required maxLength={120} />
            <Field label={t('driver.dispatch.phone')} name="phone" defaultValue={editing.phone ?? ''} placeholder="+201001234567" dir="ltr" />
            <div className="form-row">
              <SelectField label={t('driver.dispatch.vehicle')} name="vehicleType" defaultValue={editing.vehicleType}>
                {VEHICLE_TYPES.map((v) => <option key={v} value={v}>{t(`driver.vehicle.${v}`)}</option>)}
              </SelectField>
              <Field label={t('driver.dispatch.plate')} name="vehiclePlate" defaultValue={editing.vehiclePlate ?? ''} maxLength={30} />
            </div>
            {org.branches.length > 1 && (
              <SelectField label={t('driver.dispatch.branch')} name="branchId" defaultValue={editing.branchIds?.[0] ?? ''}>
                <option value="">{t('driver.dispatch.allBranches')}</option>
                {org.branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
              </SelectField>
            )}
            {act.error && <Notice tone="danger">{act.error}</Notice>}
            <div className="row justify-end">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>{t('action.cancel')}</button>
              <button className="btn btn-primary" disabled={act.pending}>{t('action.save')}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
