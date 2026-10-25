'use client';
import { useRef, useState, type FormEvent } from 'react';
import type { AvailabilityResult } from '@resuto/contracts';
import { Field, Notice, SelectField, Sheet } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';

/** Staff booking in a sheet (21-OPS; was a modal): find a table for the time and party, then the guest details. */
export function NewReservationSheet({ branchId, date, onClose, onCreated }: { branchId: string; date: string; onClose: () => void; onCreated: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [form, setForm] = useState({ date, time: '20:00', partySize: 2, tableId: '' });
  const [avail, setAvail] = useState<AvailabilityResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = useRef(newIdempotencyKey());

  const check = async () => {
    setError(null);
    try {
      setAvail(await call<AvailabilityResult>(`/o/${org.id}/reservations/availability?branchId=${branchId}&date=${form.date}&time=${form.time}&partySize=${form.partySize}`));
    } catch (e) { setError((e as Error).message); }
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setPending(true); setError(null);
    try {
      await call(`/o/${org.id}/reservations`, {
        idempotencyKey: key.current,
        body: {
          branchId, date: form.date, time: form.time, partySize: form.partySize, tableId: form.tableId || null,
          guestName: String(f.get('name')), guestPhone: (f.get('phone') as string)?.replace(/[\s-]/g, '') || null, notes: (f.get('notes') as string) || null,
          source: String(f.get('source') ?? 'staff'), requireDeposit: f.get('deposit') === 'on',
        },
      });
      onCreated();
    } catch (err) { setError((err as Error).message); key.current = newIdempotencyKey(); } finally { setPending(false); }
  }

  return (
    <Sheet open onClose={onClose} size="md" title={t('core.resdash.new')}>
      <form onSubmit={submit} className="stack">
        <div className="form-row">
          <Field label={t('core.orders.date')} type="date" required value={form.date} onChange={(e) => { setForm({ ...form, date: e.target.value }); setAvail(null); }} />
          <Field label={t('core.res.time')} type="time" required step={900} value={form.time} onChange={(e) => { setForm({ ...form, time: e.target.value }); setAvail(null); }} />
          <Field label={t('core.res.party')} type="number" min={1} max={50} required value={form.partySize} onChange={(e) => { setForm({ ...form, partySize: Number(e.target.value) || 1 }); setAvail(null); }} />
        </div>
        <div><button type="button" className="btn btn-sm" onClick={() => void check()}>{t('core.res.findTable')}</button></div>
        {avail && (
          <SelectField label={t('core.orders.table')} value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })}
            hint={!avail.open ? t(`core.res.closed.${avail.closedReason ?? 'outside_opening_hours'}`) : undefined}>
            <option value="">{t('core.resdash.autoTable')}</option>
            {avail.tables.filter((x) => x.available).map((x) => <option key={x.id} value={x.id}>{x.label} · {t('core.res.seats', { n: x.capacity })}</option>)}
          </SelectField>
        )}
        <div className="form-row">
          <Field label={t('core.web.name')} name="name" required maxLength={100} />
          <Field label={t('core.web.phone')} name="phone" dir="ltr" placeholder="+20…" />
        </div>
        <SelectField label={t('core.resdash.source')} name="source" defaultValue="staff">
          {['staff', 'phone', 'whatsapp'].map((s) => <option key={s} value={s}>{t(`core.res.source.${s}`)}</option>)}
        </SelectField>
        <Field label={t('core.res.notes')} name="notes" maxLength={500} />
        <label className="check"><input type="checkbox" name="deposit" /> {t('core.resdash.requireDeposit')}</label>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="row justify-end">
          <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
          <button className="btn btn-primary" disabled={pending}>{t('action.create')}</button>
        </div>
      </form>
    </Sheet>
  );
}
