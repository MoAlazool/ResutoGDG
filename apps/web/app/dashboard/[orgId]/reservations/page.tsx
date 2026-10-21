'use client';
import { Suspense, useRef, useState, type FormEvent } from 'react';
import type { AvailabilityResult, ReservationView } from '@resuto/contracts';
import { Badge, Code, EmptyState, Field, Modal, Notice, PageHeader, Phone, SelectField, Skeleton, UserText, useConfirm, type Tone } from '@resuto/ui';
import '@/components/ops/ops.css';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useUrlParam } from '@/components/ops/use-url-state';
import { newIdempotencyKey } from '@/lib/api';
import { money, pick, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

const tone = (s: string): Tone => ({ held: 'warn', pending_deposit: 'pay', confirmed: 'info', seated: 'ok', completed: 'neutral', cancelled: 'danger', no_show: 'danger', expired: 'neutral' } as Record<string, Tone>)[s] ?? 'neutral';
const today = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export default function ReservationsPage() {
  return <Suspense fallback={<Skeleton lines={6} />}><Reservations /></Suspense>;
}

function Reservations() {
  const { t, locale } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const { call } = useSession();
  // Branch and day live in the URL (PCL-20): a reload or a shared link keeps them; the shell's branch is the default.
  const [branchParam, setBranchId] = useUrlParam<string>('branch', '');
  const branchId = org.branches.some((b) => b.id === branchParam) ? branchParam : (shellBranch ?? org.branches[0]?.id ?? '');
  const [date, setDate] = useUrlParam<string>('date', today(org.timezone));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm(locale);
  const day = useApi<{ items: ReservationView[] }>(`/o/${org.id}/reservations?date=${date}${branchId ? `&branchId=${branchId}` : ''}`, { pollMs: 15000 });

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null); setNotice(null);
    try { await fn(); setNotice(ok); await day.reload(); } catch (e) { setError((e as Error).message); }
  };
  const items = day.data?.items ?? [];
  const live = items.filter((r) => !['cancelled', 'expired'].includes(r.status));
  const covers = live.reduce((a, r) => a + r.partySize, 0);

  return (
    <ModuleGate module="core" permission="reservations:read">
      {confirmDialog}
      <PageHeader title={t('nav.reservations')} subtitle={t('core.resdash.subtitle', { n: live.length, covers })}
        actions={can('reservations:write') && <button className="btn btn-primary" onClick={() => setCreating(true)}>+ {t('core.resdash.new')}</button>} />
      <div className="form-row" data-align="end">
        <Field label={t('core.orders.date')} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {org.branches.length > 1 && (
          <SelectField label={t('core.web.branch')} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {org.branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
          </SelectField>
        )}
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {notice && <Notice tone="ok">{notice}</Notice>}
      {day.loading && !day.data ? <Skeleton lines={6} /> : !items.length ? (
        <div className="card"><EmptyState title={t('core.resdash.empty')}>{t('core.resdash.emptyHint')}</EmptyState></div>
      ) : (
        <ol className="stack res-timeline" aria-label={t('core.resdash.timeline')}>
          {items.map((r) => (
            <li key={r.id} className="card res-row" data-closed={['cancelled', 'expired', 'no_show'].includes(r.status) || undefined}>
              <div><strong className="num res-time">{time(r.startsAt, locale, org.timezone)}</strong><div className="fine">{time(r.endsAt, locale, org.timezone)}</div></div>
              <div className="stack res-body">
                <div className="spread">
                  <span><strong><UserText>{r.guestName}</UserText></strong> · {t('core.res.guests', { n: r.partySize })}{r.tableLabel ? ` · ${t('core.kds.table', { label: r.tableLabel })}` : ''}</span>
                  <Badge tone={tone(r.status)}>{t(`core.res.status.${r.status}`)}</Badge>
                </div>
                <div className="fine">
                  <Code>{r.code}</Code> · {t(`core.res.source.${r.source}`)}{r.guestPhone ? <> · <Phone value={r.guestPhone} link /></> : null}
                  {r.depositMinor > 0 && ` · ${t('core.res.deposit')}: ${money(r.depositMinor, r.currency, locale)} (${t(`core.res.deposit.${r.depositStatus}`)})`}
                </div>
                {r.notes && <div className="fine">“<UserText>{r.notes}</UserText>”</div>}
                {can('reservations:write') && (
                  <div className="row">
                    {r.status === 'confirmed' && can('floor:seat') && (
                      <button className="btn btn-sm btn-primary" onClick={() => void act(() => call(`/o/${org.id}/reservations/${r.id}/check-in`, { body: {} }), t('core.resdash.seated'))}>{t('core.resdash.checkIn')}</button>
                    )}
                    {r.status === 'confirmed' && new Date(r.startsAt).getTime() < Date.now() && (
                      <button className="btn btn-sm" onClick={() => void act(() => call(`/o/${org.id}/reservations/${r.id}/no-show`, { body: {} }), t('core.res.status.no_show'))}>{t('core.resdash.noShow')}</button>
                    )}
                    {['held', 'pending_deposit', 'confirmed'].includes(r.status) && (
                      <button className="btn btn-sm btn-danger" onClick={async () => {
                        if (await confirm({ title: t('core.res.cancelConfirm'), tone: 'danger', confirmLabel: t('core.res.cancel') })) void act(() => call(`/o/${org.id}/reservations/${r.id}/cancel`, { body: {} }), t('core.res.cancelled'));
                      }}>{t('core.res.cancel')}</button>
                    )}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
      {creating && <NewReservation branchId={branchId} date={date} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); setNotice(t('core.res.status.confirmed')); void day.reload(); }} />}
    </ModuleGate>
  );
}

function NewReservation({ branchId, date, onClose, onCreated }: { branchId: string; date: string; onClose: () => void; onCreated: () => void }) {
  const { t, locale } = useT();
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
    <Modal open onClose={onClose} title={t('core.resdash.new')}>
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label={t('core.orders.date')} type="date" required value={form.date} onChange={(e) => { setForm({ ...form, date: e.target.value }); setAvail(null); }} />
          <Field label={t('core.res.time')} type="time" required step={900} value={form.time} onChange={(e) => { setForm({ ...form, time: e.target.value }); setAvail(null); }} />
          <Field label={t('core.res.party')} type="number" min={1} max={50} required value={form.partySize} onChange={(e) => { setForm({ ...form, partySize: Number(e.target.value) || 1 }); setAvail(null); }} />
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void check()}>{t('core.res.findTable')}</button>
        {avail && (
          <SelectField label={t('core.orders.table')} value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })}
            hint={!avail.open ? t(`core.res.closed.${avail.closedReason ?? 'outside_opening_hours'}`) : undefined}>
            <option value="">{t('core.resdash.autoTable')}</option>
            {avail.tables.filter((x) => x.available).map((x) => <option key={x.id} value={x.id}>{x.label} · {t('core.res.seats', { n: x.capacity })}</option>)}
          </SelectField>
        )}
        <div className="form-row" style={{ marginTop: 12 }}>
          <Field label={t('core.web.name')} name="name" required maxLength={100} />
          <Field label={t('core.web.phone')} name="phone" dir="ltr" placeholder="+20…" />
        </div>
        <SelectField label={t('core.resdash.source')} name="source" defaultValue="staff">
          {['staff', 'phone', 'whatsapp'].map((s) => <option key={s} value={s}>{t(`core.res.source.${s}`)}</option>)}
        </SelectField>
        <Field label={t('core.res.notes')} name="notes" maxLength={500} />
        <label className="check"><input type="checkbox" name="deposit" /> {t('core.resdash.requireDeposit')}</label>
        {error && <Notice tone="danger">{error}</Notice>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
          <button className="btn btn-primary" disabled={pending}>{t('action.create')}</button>
        </div>
      </form>
    </Modal>
  );
}
