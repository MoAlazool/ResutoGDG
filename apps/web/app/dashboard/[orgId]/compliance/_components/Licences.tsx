'use client';
import { useState, type FormEvent } from 'react';
import type { ExpiryStatus, LicenceView } from '@resuto/contracts';
import { LICENCE_KINDS } from '@resuto/contracts/lite';
import { Badge, DataTable, EmptyState, Field, Modal, Notice, SelectField, Skeleton, TextareaField, useAction, useConfirm, type Tone } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';

const EXPIRY_TONE: Record<ExpiryStatus, Tone> = { expired: 'danger', expiring: 'warn', valid: 'ok', no_expiry: 'neutral' };

export function ExpiryBadge({ status, days }: { status: ExpiryStatus; days: number | null }) {
  const { t } = useT();
  const label = status === 'expired' ? t('compliance.lic.expiredAgo', { n: Math.abs(days ?? 0) })
    : status === 'expiring' ? t('compliance.lic.expiresIn', { n: days ?? 0 })
      : t(`compliance.lic.status.${status}`);
  return <Badge tone={EXPIRY_TONE[status]}>{label}</Badge>;
}

/** Licences & certificates with expiry badges, reminders (default 30/7/1 days) and file attachments. */
export function Licences() {
  const { t, locale } = useT();
  const [confirm, confirmDialog] = useConfirm(locale);
  const { org, can } = useOrg();
  const { call } = useSession();
  const [filter, setFilter] = useState<'' | ExpiryStatus>('');
  const list = useApi<{ items: LicenceView[]; today: string }>(`/o/${org.id}/compliance/documents${filter ? `?status=${filter}` : ''}`);
  const [editing, setEditing] = useState<LicenceView | 'new' | null>(null);
  const editable = can('compliance:write');
  const act = useAction(async (fn: () => Promise<unknown>) => { const r = await fn(); await list.reload(); return r; });

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) || '').trim() || null;
    const days = String(f.get('reminderDays') || '').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n >= 0);
    const body = {
      kind: f.get('kind'), title: String(f.get('title') || '').trim(), branchId: str('branchId'), referenceNumber: str('referenceNumber'),
      issuingAuthority: str('issuingAuthority'), issuedOn: str('issuedOn'), expiresOn: str('expiresOn'), reminderDays: days, notes: str('notes'),
    };
    const file = f.get('file') as File | null;
    const saved = await act.run(async () => {
      const r = await call<LicenceView>(editing === 'new' ? `/o/${org.id}/compliance/documents` : `/o/${org.id}/compliance/documents/${(editing as LicenceView).id}`,
        { method: editing === 'new' ? 'POST' : 'PATCH', body });
      if (file && file.size) {
        const form = new FormData();
        form.append('file', file);
        await call(`/o/${org.id}/compliance/documents/${r.id}/file`, { body: form });
      }
      return r;
    });
    if (saved) setEditing(null);
  }

  async function openFile(id: string) {
    const d = await call<LicenceView>(`/o/${org.id}/compliance/documents/${id}`);
    if (d.file?.url) window.open(d.file.url, '_blank', 'noopener');
  }

  const current = editing && editing !== 'new' ? editing : null;
  const branchLabel = (id: string | null) => {
    if (!id) return t('compliance.lic.allBranches');
    const b = org.branches.find((x) => x.id === id);
    return b ? (locale === 'ar' && b.nameAr ? b.nameAr : b.name) : '—';
  };

  return (
    <div className="stack">
      {confirmDialog}
      <div className="spread">
        <div className="row gap-6">
          {(['', 'expired', 'expiring', 'valid', 'no_expiry'] as const).map((k) => (
            <button key={k || 'all'} className={`btn btn-sm btn-pill ${filter === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setFilter(k)}>
              {k ? t(`compliance.lic.status.${k}`) : t('compliance.doc.all')}
            </button>
          ))}
        </div>
        {editable && <button className="btn btn-primary" onClick={() => setEditing('new')}>{t('compliance.lic.add')}</button>}
      </div>
      {act.error && !editing && <Notice tone="danger">{act.error}</Notice>}
      {list.loading && !list.data ? <Skeleton lines={5} /> : list.error ? <Notice tone="danger">{list.error.message}</Notice> : (
        <DataTable rows={list.data!.items} rowKey={(d) => d.id}
          empty={<EmptyState title={t('compliance.lic.empty')}>{t('compliance.lic.emptyHint')}</EmptyState>}
          columns={[
            { key: 'title', header: t('compliance.lic.title'), render: (d) => <><strong>{d.title}</strong><div className="fine">{t(`compliance.lic.kind.${d.kind}`)}{d.referenceNumber ? ` · ${d.referenceNumber}` : ''}</div></> },
            { key: 'branch', header: t('compliance.lic.branch'), render: (d) => branchLabel(d.branchId) },
            { key: 'authority', header: t('compliance.lic.authority'), render: (d) => d.issuingAuthority ?? '—' },
            { key: 'expires', header: t('compliance.lic.expiresOn'), render: (d) => d.expiresOn ?? '—' },
            { key: 'status', header: t('compliance.doc.status'), render: (d) => <ExpiryBadge status={d.expiryStatus} days={d.daysToExpiry} /> },
            { key: 'reminders', header: t('compliance.lic.reminders'), render: (d) => (
              <span className="fine">{d.reminders.map((r) => `${r.daysBefore}d${r.status === 'sent' ? ' ✓' : r.status === 'dismissed' ? ' –' : ''}`).join(' · ') || '—'}</span>
            ) },
            { key: 'actions', header: '', render: (d) => (
              <div className="row gap-6">
                {d.file && <button className="btn btn-sm" onClick={() => void openFile(d.id)}>{t('compliance.lic.file')}</button>}
                {editable && <button className="btn btn-sm" onClick={() => setEditing(d)}>{t('action.edit')}</button>}
                {editable && <button className="btn btn-sm btn-danger" disabled={act.pending}
                  onClick={async () => { if (await confirm({ title: t('compliance.lic.confirmDelete', { title: d.title }), tone: 'danger', confirmLabel: t('action.delete') })) void act.run(() => call(`/o/${org.id}/compliance/documents/${d.id}`, { method: 'DELETE' })); }}>
                  {t('action.delete')}
                </button>}
              </div>
            ) },
          ]} />
      )}
      <p className="fine">{t('compliance.lic.manualNote')}</p>
      {editing && (
        <Modal open onClose={() => setEditing(null)} title={current ? current.title : t('compliance.lic.add')}>
          <form onSubmit={save}>
            <div className="form-row">
              <SelectField label={t('compliance.lic.type')} name="kind" defaultValue={current?.kind ?? (org.country === 'SA' ? 'municipal_license' : 'commercial_registration')}>
                {LICENCE_KINDS.map((k) => <option key={k} value={k}>{t(`compliance.lic.kind.${k}`)}</option>)}
              </SelectField>
              <SelectField label={t('compliance.lic.branch')} name="branchId" defaultValue={current?.branchId ?? ''}>
                <option value="">{t('compliance.lic.allBranches')}</option>
                {org.branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
              </SelectField>
            </div>
            <Field label={t('compliance.lic.title')} name="title" required maxLength={200} defaultValue={current?.title ?? ''} />
            <div className="form-row">
              <Field label={t('compliance.lic.reference')} name="referenceNumber" maxLength={100} defaultValue={current?.referenceNumber ?? ''} dir="ltr" />
              <Field label={t('compliance.lic.authority')} name="issuingAuthority" maxLength={200} defaultValue={current?.issuingAuthority ?? ''} />
            </div>
            <div className="form-row">
              <Field label={t('compliance.lic.issuedOn')} name="issuedOn" type="date" defaultValue={current?.issuedOn ?? ''} />
              <Field label={t('compliance.lic.expiresOn')} name="expiresOn" type="date" defaultValue={current?.expiresOn ?? ''} />
              <Field label={t('compliance.lic.reminderDays')} name="reminderDays" defaultValue={(current?.reminderDays ?? [30, 7, 1]).join(', ')} hint={t('compliance.lic.reminderHint')} dir="ltr" />
            </div>
            <TextareaField label={t('compliance.lic.notes')} name="notes" maxLength={2000} rows={2} defaultValue={current?.notes ?? ''} />
            <Field label={t('compliance.lic.upload')} name="file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" hint={current?.file ? t('compliance.lic.replaceFile') : t('compliance.lic.fileHint')} />
            {act.error && <Notice tone="danger">{act.error}</Notice>}
            <div className="row justify-end">
              <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>{t('action.cancel')}</button>
              <button className="btn btn-primary" disabled={act.pending}>{act.pending ? t('state.loading') : t('action.save')}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
