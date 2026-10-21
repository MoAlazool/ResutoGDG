'use client';
import { useState, type FormEvent } from 'react';
import { DELIVERY_ZONE_KINDS, parseMajor, type Currency, type DeliveryZone, type DeliveryZoneKind } from '@resuto/contracts';
import { Badge, Card, DataTable, EmptyState, Field, Modal, Notice, SelectField, Skeleton, useAction, useConfirm } from '@resuto/ui';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Draft { id: string | null; name: string; nameAr: string; kind: DeliveryZoneKind; radiusM: string; polygon: string; fee: string; min: string; eta: string; isActive: boolean }
const EMPTY: Draft = { id: null, name: '', nameAr: '', kind: 'area', radiusM: '3000', polygon: '', fee: '', min: '', eta: '', isActive: true };
const major = (minor: number) => (minor / 100).toFixed(2);

/** "lat, lng" per line → [[lat, lng], …]; null when malformed or fewer than 3 points. */
export function parsePolygon(text: string): Array<[number, number]> | null {
  const pts = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split(/[,\s]+/).map(Number));
  if (pts.length < 3 || pts.some((p) => p.length !== 2 || p.some((n) => !Number.isFinite(n)) || Math.abs(p[0]!) > 90 || Math.abs(p[1]!) > 180)) return null;
  return pts as Array<[number, number]>;
}

/** FT-09: delivery zones per branch (fee, minimum order, typical time, coverage). */
export function Zones({ branchId: filter }: { branchId: string }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const branches = org.branches.filter((b) => b.isActive);
  const [branchId, setBranchId] = useState(filter || branches[0]?.id || '');
  const list = useApi<{ items: DeliveryZone[] }>(branchId ? `/o/${org.id}/delivery-zones?branchId=${branchId}` : null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const currency = org.currency as Currency;
  const m = (v: number) => money(v, currency, locale);
  const editable = can('branches:manage');
  const [confirm, confirmDialog] = useConfirm(locale);

  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    const polygon = draft.kind === 'polygon' ? parsePolygon(draft.polygon) : null;
    if (draft.kind === 'polygon' && !polygon) { setFormError(t('zones.polygonInvalid')); return; }
    setFormError(null);
    const body = {
      branchId, name: draft.name.trim(), nameAr: draft.nameAr.trim() || null, kind: draft.kind,
      radiusM: draft.kind === 'radius' ? Number(draft.radiusM) : null, polygon,
      feeMinor: draft.fee ? parseMajor(draft.fee, currency) : 0, minOrderMinor: draft.min ? parseMajor(draft.min, currency) : 0,
      etaMin: draft.eta ? Number(draft.eta) : null, sortOrder: 0, isActive: draft.isActive,
    };
    await call(`/o/${org.id}/delivery-zones${draft.id ? `/${draft.id}` : ''}`, { method: draft.id ? 'PUT' : 'POST', body });
    setDraft(null);
    await list.reload();
  });
  const remove = useAction(async (z: DeliveryZone) => {
    if (!(await confirm({ title: t('zones.deleteConfirm'), tone: 'danger', confirmLabel: t('zones.delete') }))) return;
    await call(`/o/${org.id}/delivery-zones/${z.id}`, { method: 'DELETE' });
    await list.reload();
  });

  const edit = (z: DeliveryZone) => setDraft({
    id: z.id, name: z.name, nameAr: z.nameAr ?? '', kind: z.kind, radiusM: String(z.radiusM ?? ''), polygon: (z.polygon ?? []).map(([a, b]) => `${a}, ${b}`).join('\n'),
    fee: major(z.feeMinor), min: z.minOrderMinor ? major(z.minOrderMinor) : '', eta: z.etaMin ? String(z.etaMin) : '', isActive: z.isActive,
  });

  return (
    <Card title={t('zones.title')} actions={editable ? <button className="btn btn-sm btn-primary" onClick={() => setDraft({ ...EMPTY })}>{t('zones.add')}</button> : undefined}>
      <p className="fine" style={{ marginTop: 0 }}>{t('zones.body')}</p>
      {branches.length > 1 && (
        <SelectField label={t('zones.branch')} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
          {branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
        </SelectField>
      )}
      {list.error && <Notice tone="danger">{list.error.message}</Notice>}
      {!list.data ? <Skeleton lines={3} /> : (
        <DataTable rows={list.data.items} rowKey={(z) => z.id} empty={<EmptyState title={t('zones.empty')} />} columns={[
          { key: 'n', header: t('zones.name'), render: (z) => <><bdi>{locale === 'ar' && z.nameAr ? z.nameAr : z.name}</bdi><div className="fine">{t(`zones.kind.${z.kind}`)}{z.radiusM ? <> · <span className="num" dir="ltr">{z.radiusM} m</span></> : null}</div></> },
          { key: 'f', header: t('zones.fee'), align: 'end', render: (z) => <span className="num" dir="ltr">{m(z.feeMinor)}</span> },
          { key: 'm', header: t('zones.min'), align: 'end', render: (z) => (z.minOrderMinor ? <span className="num" dir="ltr">{m(z.minOrderMinor)}</span> : '—') },
          { key: 'e', header: t('zones.eta'), align: 'end', render: (z) => (z.etaMin ? <span className="num">{z.etaMin}</span> : '—') },
          { key: 's', header: '', render: (z) => <Badge tone={z.isActive ? 'ok' : 'neutral'}>{z.isActive ? t('zones.active') : t('zones.inactive')}</Badge> },
          { key: 'a', header: '', render: (z) => editable ? (
            <div className="row" style={{ gap: 6 }}>
              <button className="btn btn-sm" onClick={() => edit(z)}>{t('zones.edit')}</button>
              <button className="btn btn-sm btn-ghost" disabled={remove.pending} onClick={() => void remove.run(z)}>{t('zones.delete')}</button>
            </div>) : null },
        ]} />
      )}
      {remove.error && <Notice tone="danger">{remove.error}</Notice>}
      {confirmDialog}
      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? t('zones.edit') : t('zones.add')}>
        {draft && (
          <form onSubmit={save.run} className="stack" style={{ gap: 4 }}>
            <div className="form-row">
              <Field label={t('zones.name')} required maxLength={80} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <Field label={t('zones.nameAr')} maxLength={80} dir="rtl" lang="ar" value={draft.nameAr} onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })} />
            </div>
            <SelectField label={t('zones.kind')} value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as DeliveryZoneKind })}>
              {DELIVERY_ZONE_KINDS.map((k) => <option key={k} value={k}>{t(`zones.kind.${k}`)}</option>)}
            </SelectField>
            {draft.kind === 'radius' && <Field label={t('zones.radius')} type="number" min={100} max={100000} required value={draft.radiusM} onChange={(e) => setDraft({ ...draft, radiusM: e.target.value })} />}
            {draft.kind === 'polygon' && (
              <label className="field"><span className="field-label">{t('zones.polygon')}</span>
                <textarea className="input" rows={5} dir="ltr" value={draft.polygon} placeholder={'30.0600, 31.2100\n30.0700, 31.2300\n30.0500, 31.2350'} onChange={(e) => setDraft({ ...draft, polygon: e.target.value })} />
                <small className="fine">{t('zones.polygonHint')}</small>
              </label>
            )}
            <div className="form-row">
              <Field label={`${t('zones.fee')} (${currency})`} inputMode="decimal" required value={draft.fee} onChange={(e) => setDraft({ ...draft, fee: e.target.value })} />
              <Field label={`${t('zones.min')} (${currency})`} inputMode="decimal" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} />
              <Field label={t('zones.eta')} type="number" min={5} max={600} value={draft.eta} onChange={(e) => setDraft({ ...draft, eta: e.target.value })} />
            </div>
            <label className="check"><input type="checkbox" checked={draft.isActive} onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })} /> {t('zones.active')}</label>
            {(formError || save.error) && <Notice tone="danger">{formError ?? save.error}</Notice>}
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn btn-primary" disabled={save.pending || !draft.name.trim()}>{t('zones.save')}</button></div>
          </form>
        )}
      </Modal>
    </Card>
  );
}
