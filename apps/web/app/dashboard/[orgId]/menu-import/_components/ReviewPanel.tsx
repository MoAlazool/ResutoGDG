'use client';
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  normalizeNumericInput, type ExtractionModifierGroup, type ExtractionRow, type ExtractionRowCheck, type MenuExtractionJob,
} from '@resuto/contracts';
import { Badge, Notice, SkeletonTable, useConfirm, useToast } from '@resuto/ui';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { isolate, num, pct } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

type T = (key: string, vars?: Record<string, string | number>) => string;
type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'pay' | 'neutral';

export const statusTone = (s: MenuExtractionJob['status']): Tone =>
  s === 'committed' ? 'ok' : s === 'failed' ? 'danger' : s === 'review' ? 'pay' : s === 'discarded' ? 'neutral' : 'info';

/** Honest provenance label: Resuto's own parser (no AI) or the restaurant's own Gemini key. */
export const modeLabel = (t: T, j: Pick<MenuExtractionJob, 'mode' | 'model'>) =>
  j.mode === 'vision_model' ? (j.model ? t('studio.ai.mode.vision_model', { model: isolate(j.model) }) : t('studio.ai.mode.vision_model_pending'))
    : t(`studio.ai.mode.${j.mode}`);

const CHECK_KEYS: Record<string, string> = {
  'Enter a price': 'studio.ai.check.price',
  'Already on your menu: rename it or reject this row': 'studio.ai.check.exists',
  'Name is required (up to 120 characters)': 'studio.ai.check.name',
  'Price must be a positive amount with up to two decimals': 'studio.ai.check.priceRange',
  'Duplicate item': 'studio.ai.check.duplicate',
  'Low confidence: check this row against the source': 'studio.ai.check.low',
  'Imported as unavailable': 'studio.ai.check.unavailable',
};
function checkText(t: T, message: string) {
  if (CHECK_KEYS[message]) return t(CHECK_KEYS[message]!);
  if (message.startsWith('Check: ')) {
    const fields = message.slice(7).split(', ').map((f) => t(`studio.ai.uncertain.${f}`));
    return t('studio.ai.check.uncertain', { fields: fields.join('، ') });
  }
  return message;
}

/** Major-unit price text <-> integer minor units (EGP/SAR: 2 decimals). Accepts Arabic-Indic digits. */
const toMinor = (text: string): number | null | 'invalid' => {
  const v = normalizeNumericInput(text).trim().replace(',', '.');
  if (!v) return null;
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(v)) return 'invalid';
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
};
const fromMinor = (minor: number | null) => (minor === null ? '' : (minor / 100).toFixed(minor % 100 ? 2 : 0));

function MoneyInput({ value, onChange, label, required }: { value: number | null; onChange: (v: number | null) => void; label: string; required?: boolean }) {
  const [text, setText] = useState(fromMinor(value));
  const [bad, setBad] = useState(false);
  useEffect(() => { setText((cur) => (toMinor(cur) === value ? cur : fromMinor(value))); }, [value]);
  return (
    <input className={`mi-input mi-num${bad ? ' mi-invalid' : ''}`} inputMode="decimal" dir="ltr" aria-label={label} aria-invalid={bad || (required && value === null) || undefined}
      value={text} onChange={(e) => {
        const raw = normalizeNumericInput(e.target.value);
        setText(raw);
        const m = toMinor(raw);
        setBad(m === 'invalid');
        if (m !== 'invalid') onChange(m);
      }} />
  );
}

let localId = 0;
const newRowId = () => `n${Date.now().toString(36)}${++localId}`.slice(0, 40);

export function ReviewPanel({ jobId, onChanged, onClose }: { jobId: string; onChanged: () => Promise<unknown> | void; onClose: () => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const toast = useToast();
  const [confirm, dialog] = useConfirm(locale);
  const [poll, setPoll] = useState<number | undefined>(undefined);
  const job = useApi<MenuExtractionJob>(`/o/${org.id}/menu-import/jobs/${jobId}`, { pollMs: poll, staleMs: 0 });
  const [rows, setRows] = useState<ExtractionRow[] | null>(null);
  const [checks, setChecks] = useState<ExtractionRowCheck[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const currency = org.currency;

  const data = job.data;
  useEffect(() => {
    setPoll(data && (data.status === 'queued' || data.status === 'processing') ? 3000 : undefined);
    if (data && (!dirty || data.version !== version) && !stale) {
      if (!dirty) { setRows(data.rows); setChecks(data.checks); setVersion(data.version); }
    }
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const checkById = useMemo(() => new Map(checks.map((c) => [c.id, c])), [checks]);
  const editable = data?.status === 'review' && !stale;

  const update = (id: string, patch: Partial<ExtractionRow>) => {
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...patch } : r)) ?? rs);
    setDirty(true);
  };
  const updateGroup = (row: ExtractionRow, gi: number, patch: Partial<ExtractionModifierGroup> | null) => {
    const modifiers = patch === null ? row.modifiers.filter((_, i) => i !== gi) : row.modifiers.map((g, i) => (i === gi ? { ...g, ...patch } : g));
    update(row.id, { modifiers });
  };

  const save = async (): Promise<MenuExtractionJob | null> => {
    if (!rows || version === null) return null;
    try {
      const saved = await call<MenuExtractionJob>(`/o/${org.id}/menu-import/jobs/${jobId}`, { method: 'PATCH', body: { version, rows } });
      job.setData(saved);
      setRows(saved.rows); setChecks(saved.checks); setVersion(saved.version); setDirty(false);
      return saved;
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'extraction_stale') setStale(true);
      toast.show({ message: (e as Error).message, tone: 'danger' });
      return null;
    }
  };

  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const commit = () => run(async () => {
    const approved = rows?.filter((r) => r.status === 'approved').length ?? 0;
    if (!(await confirm({ title: t('studio.ai.review.commit'), body: t('studio.ai.review.commitConfirm', { n: approved }), confirmLabel: t('studio.ai.review.commit') }))) return;
    const current = dirty ? await save() : data!;
    if (!current) return;
    try {
      const done = await call<MenuExtractionJob>(`/o/${org.id}/menu-import/jobs/${jobId}/commit`, { body: { version: current.version, key: newIdempotencyKey() } });
      job.setData(done);
      setRows(done.rows); setChecks(done.checks); setVersion(done.version);
      await onChanged();
    } catch (e) {
      const details = e instanceof ApiRequestError ? (e.details as { checks?: ExtractionRowCheck[] } | undefined) : undefined;
      if (details?.checks) setChecks((cs) => cs.map((c) => details.checks!.find((x) => x.id === c.id) ?? c));
      toast.show({ message: (e as Error).message, tone: 'danger' });
    }
  });

  const discard = () => run(async () => {
    if (!(await confirm({ title: t('studio.ai.review.discard'), body: t('studio.ai.review.discardConfirm'), confirmLabel: t('studio.ai.review.discard') }))) return;
    try {
      await call(`/o/${org.id}/menu-import/jobs/${jobId}/discard`, { body: {} });
      await onChanged();
      onClose();
    } catch (e) { toast.show({ message: (e as Error).message, tone: 'danger' }); }
  });

  const approveValid = () => {
    setRows((rs) => rs?.map((r) => (r.status === 'review' && r.priceMinor !== null && !(checkById.get(r.id)?.errors.length) ? { ...r, status: 'approved' } : r)) ?? rs);
    setDirty(true);
  };
  const mergeDuplicates = () => {
    setRows((rs) => {
      if (!rs) return rs;
      const seen = new Map<string, ExtractionRow>();
      const out = rs.map((r) => ({ ...r }));
      for (const r of out) {
        if (r.status === 'rejected') continue;
        const k = r.name.trim().toLowerCase();
        const first = seen.get(k);
        if (!first) { seen.set(k, r); continue; }
        first.nameAr ||= r.nameAr; first.description ||= r.description;
        first.allergens = [...new Set([...first.allergens, ...r.allergens])];
        if (first.priceMinor === null) first.priceMinor = r.priceMinor;
        if (!first.modifiers.length) first.modifiers = r.modifiers;
        first.status = 'review';
        r.status = 'rejected';
      }
      return out;
    });
    setDirty(true);
  };
  const addRow = () => {
    setRows((rs) => [...(rs ?? []), { id: newRowId(), status: 'review', name: '', nameAr: null, category: rs?.at(-1)?.category ?? 'Mains', description: null,
      priceMinor: null, allergens: [], modifiers: [], available: false, confidence: 1, uncertainFields: [], source: null }]);
    setDirty(true);
  };

  if (job.error && !data) return <div className="card"><Notice tone="danger">{job.error.message}</Notice></div>;
  if (!data || !rows) return <div className="card"><SkeletonTable rows={6} cols={6} /></div>;
  const s = data.summary;
  const approvedNow = rows.filter((r) => r.status === 'approved').length;

  return (
    <section className="card mi-panel" aria-busy={busy}>
      {dialog}
      <div className="spread">
        <div>
          <h2 className="mi-h2">{data.sourceName ? t('studio.ai.review.title', { name: isolate(data.sourceName) }) : t('studio.ai.review.untitled')}</h2>
          <div className="row gap-6 wrap">
            <Badge tone={statusTone(data.status)}>{t(`studio.ai.status.${data.status}`)}</Badge>
            <Badge tone="neutral">{modeLabel(t, data)}</Badge>
            {data.status === 'review' && <>
              <Badge tone="ok">{t('studio.ai.review.approved', { n: approvedNow })}</Badge>
              <Badge tone="neutral">{t('studio.ai.review.rejected', { n: rows.filter((r) => r.status === 'rejected').length })}</Badge>
              <Badge tone="info">{t('studio.ai.review.inReview', { n: rows.filter((r) => r.status === 'review').length })}</Badge>
              {s.errors > 0 && <Badge tone="danger">{t('studio.ai.review.errors', { n: s.errors })}</Badge>}
              {s.lowConfidence > 0 && <Badge tone="warn">{t('studio.ai.review.lowConfidence', { n: s.lowConfidence })}</Badge>}
            </>}
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={onClose}>{t('action.close')}</button>
      </div>

      {(data.status === 'queued' || data.status === 'processing') && <Notice tone="info">{t('studio.ai.review.waiting')}</Notice>}
      {data.error && data.status !== 'committed' && <Notice tone={data.status === 'failed' ? 'danger' : 'warn'}>{t('studio.ai.review.failed', { error: data.error })}</Notice>}
      {data.status === 'committed' && data.commitResult && (
        <Notice tone="ok">{t('studio.ai.review.committed', { created: data.commitResult.created, groups: data.commitResult.modifierGroupsCreated })}</Notice>
      )}
      {stale && <Notice tone="warn"><span>{t('studio.ai.review.stale')}</span>{' '}
        <button type="button" className="btn btn-sm" onClick={() => { setStale(false); setDirty(false); void job.reload(); }}>{t('studio.ai.review.reload')}</button></Notice>}
      {data.uncertainties.length > 0 && (
        <details className="mi-notes"><summary>{t('studio.ai.review.notes')} ({num(data.uncertainties.length, locale)})</summary>
          <ul>{data.uncertainties.map((u, i) => <li key={i}><bdi>{u}</bdi></li>)}</ul>
        </details>
      )}

      {editable && (
        <div className="row mi-toolbar">
          <button type="button" className="btn btn-sm" onClick={approveValid}>{t('studio.ai.review.approveValid')}</button>
          <button type="button" className="btn btn-sm" onClick={mergeDuplicates}>{t('studio.ai.review.merge')}</button>
          <button type="button" className="btn btn-sm" onClick={addRow}>{t('studio.ai.review.add')}</button>
          <button type="button" className="btn btn-sm" disabled={!dirty || busy} onClick={() => void run(async () => { if (await save()) toast.show({ message: t('studio.ai.review.saved'), tone: 'ok' }); })}>{t('studio.ai.review.save')}</button>
          <button type="button" className="btn btn-sm btn-primary" disabled={!approvedNow || busy} onClick={() => void commit()}>{t('studio.ai.review.commit')}</button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void discard()}>{t('studio.ai.review.discard')}</button>
          {dirty && <span className="fine">{t('studio.ai.review.unsaved')}</span>}
        </div>
      )}

      {rows.length > 0 && (
        <div className="table-wrap mi-table-wrap">
          <table className="data mi-table">
            <thead>
              <tr>
                <th>{t('studio.ai.col.status')}</th><th>{t('studio.ai.col.name')}</th><th>{t('studio.ai.col.nameAr')}</th><th>{t('studio.ai.col.category')}</th>
                <th>{t('studio.ai.col.price', { currency })}</th><th>{t('studio.ai.col.available')}</th><th>{t('studio.ai.col.issues')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const c = checkById.get(r.id);
                const errors = r.status === 'rejected' ? [] : c?.errors ?? [];
                const low = r.status !== 'rejected' && r.confidence < 0.75;
                const problem = errors.length ? 'error' : low ? 'low' : undefined;
                return (
                  <Fragment key={r.id}>
                  <tr data-state={r.status} data-problem={problem} className="mi-main">
                    <td>
                      <div className="mi-rowno"><bdi>{num(i + 1, locale)}</bdi> · <span title={t('studio.ai.col.confidence')}>{pct(r.confidence, locale, 0)}</span></div>
                      <select className="mi-input" aria-label={t('studio.ai.col.status')} value={r.status} disabled={!editable}
                        onChange={(e) => update(r.id, { status: e.target.value as ExtractionRow['status'] })}>
                        <option value="review">{t('studio.ai.row.review')}</option>
                        <option value="approved">{t('studio.ai.row.approved')}</option>
                        <option value="rejected">{t('studio.ai.row.rejected')}</option>
                      </select>
                    </td>
                    <td>
                      <input className="mi-input" aria-label={t('studio.ai.col.name')} value={r.name} maxLength={120} dir="auto" disabled={!editable}
                        aria-invalid={r.uncertainFields.includes('name') || undefined} onChange={(e) => update(r.id, { name: e.target.value })} />
                    </td>
                    <td><input className="mi-input" aria-label={t('studio.ai.col.nameAr')} value={r.nameAr ?? ''} maxLength={120} dir="rtl" lang="ar" disabled={!editable}
                      onChange={(e) => update(r.id, { nameAr: e.target.value || null })} /></td>
                    <td><input className="mi-input" aria-label={t('studio.ai.col.category')} value={r.category} maxLength={80} dir="auto" disabled={!editable}
                      aria-invalid={r.uncertainFields.includes('category') || undefined} onChange={(e) => update(r.id, { category: e.target.value })} /></td>
                    <td>{editable
                      ? <MoneyInput value={r.priceMinor} required label={t('studio.ai.col.price', { currency })} onChange={(v) => update(r.id, { priceMinor: v })} />
                      : <bdi className="num">{r.priceMinor === null ? '—' : num(r.priceMinor / 100, locale)}</bdi>}</td>
                    <td><input type="checkbox" aria-label={t('studio.ai.col.available')} checked={r.available} disabled={!editable}
                      onChange={(e) => update(r.id, { available: e.target.checked })} /></td>
                    <td className="mi-checks">
                      {errors.map((e) => <div key={e} className="field-error">{checkText(t, e)}</div>)}
                      {r.status !== 'rejected' && (c?.warnings ?? []).map((w) => <div key={w} className="fine">{checkText(t, w)}</div>)}
                    </td>
                  </tr>
                  <tr data-state={r.status} data-problem={problem} className="mi-sub">
                    <td colSpan={7}><RowDetails row={r} editable={!!editable} t={t} currency={currency} update={update} updateGroup={updateGroup} /></td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RowDetails({ row, editable, t, currency, update, updateGroup }: {
  row: ExtractionRow; editable: boolean; t: T; currency: string;
  update: (id: string, patch: Partial<ExtractionRow>) => void;
  updateGroup: (row: ExtractionRow, gi: number, patch: Partial<ExtractionModifierGroup> | null) => void;
}) {
  const addGroup = (kind: 'size' | 'extras') => update(row.id, {
    modifiers: [...row.modifiers, kind === 'size'
      ? { name: 'Size', nameAr: 'الحجم', minSelect: 1, maxSelect: 1, options: [{ name: 'Regular', nameAr: 'عادي', priceDeltaMinor: 0 }] }
      : { name: 'Extras', nameAr: 'إضافات', minSelect: 0, maxSelect: 1, options: [{ name: '', nameAr: null, priceDeltaMinor: 0 }] }],
  });
  return (
    <details className="mi-details">
      <summary>{t('studio.ai.row.details')} · {t('studio.ai.row.options', { n: row.modifiers.length })}</summary>
      {row.source && <p className="fine"><bdi>{t('studio.ai.row.source', { source: row.source })}</bdi></p>}
      <label className="field"><span>{t('studio.ai.row.description')}</span>
        <textarea className="mi-input" rows={2} maxLength={1000} dir="auto" value={row.description ?? ''} disabled={!editable}
          onChange={(e) => update(row.id, { description: e.target.value || null })} /></label>
      <label className="field"><span>{t('studio.ai.row.allergens')}</span>
        <input className="mi-input" dir="auto" value={row.allergens.join(', ')} disabled={!editable}
          onChange={(e) => update(row.id, { allergens: e.target.value.split(/[,،]/).map((x) => x.trim()).filter(Boolean).slice(0, 30) })} /></label>
      {row.modifiers.map((g, gi) => (
        <fieldset key={gi} className="mi-group">
          <legend><bdi>{g.name}</bdi></legend>
          <div className="mi-group-head">
            <input className="mi-input" aria-label={t('studio.ai.group.name')} value={g.name} maxLength={80} disabled={!editable} onChange={(e) => updateGroup(row, gi, { name: e.target.value })} />
            <input className="mi-input" aria-label={t('studio.ai.group.nameAr')} value={g.nameAr ?? ''} maxLength={80} dir="rtl" disabled={!editable} onChange={(e) => updateGroup(row, gi, { nameAr: e.target.value || null })} />
            <label className="row gap-6"><input type="checkbox" checked={g.minSelect > 0} disabled={!editable}
              onChange={(e) => updateGroup(row, gi, { minSelect: e.target.checked ? 1 : 0, maxSelect: e.target.checked ? 1 : Math.max(1, g.options.length) })} />{t('studio.ai.group.required')}</label>
            {editable && <button type="button" className="btn btn-sm btn-ghost" onClick={() => updateGroup(row, gi, null)}>{t('studio.ai.group.remove')}</button>}
          </div>
          {g.options.map((o, oi) => (
            <div key={oi} className="mi-option">
              <input className="mi-input" aria-label={t('studio.ai.option.name')} value={o.name} maxLength={100} disabled={!editable}
                onChange={(e) => updateGroup(row, gi, { options: g.options.map((x, j) => (j === oi ? { ...x, name: e.target.value } : x)) })} />
              <input className="mi-input" aria-label={t('studio.ai.option.nameAr')} value={o.nameAr ?? ''} maxLength={100} dir="rtl" disabled={!editable}
                onChange={(e) => updateGroup(row, gi, { options: g.options.map((x, j) => (j === oi ? { ...x, nameAr: e.target.value || null } : x)) })} />
              {editable ? <MoneyInput value={o.priceDeltaMinor} label={t('studio.ai.option.delta', { currency })}
                onChange={(v) => updateGroup(row, gi, { options: g.options.map((x, j) => (j === oi ? { ...x, priceDeltaMinor: v ?? 0 } : x)) })} />
                : <bdi className="num">{(o.priceDeltaMinor / 100).toFixed(2)}</bdi>}
              {editable && g.options.length > 1 && <button type="button" className="btn btn-sm btn-ghost"
                onClick={() => updateGroup(row, gi, { options: g.options.filter((_, j) => j !== oi), maxSelect: Math.max(1, Math.min(g.maxSelect, g.options.length - 1)) })}>{t('studio.ai.option.remove')}</button>}
            </div>
          ))}
          {editable && g.options.length < 30 && <button type="button" className="btn btn-sm"
            onClick={() => updateGroup(row, gi, { options: [...g.options, { name: '', nameAr: null, priceDeltaMinor: 0 }], maxSelect: g.minSelect > 0 ? g.maxSelect : Math.min(20, g.options.length + 1) })}>{t('studio.ai.option.add')}</button>}
        </fieldset>
      ))}
      {editable && row.modifiers.length < 10 && (
        <div className="row gap-6">
          <button type="button" className="btn btn-sm" onClick={() => addGroup('size')}>{t('studio.ai.group.addSizes')}</button>
          <button type="button" className="btn btn-sm" onClick={() => addGroup('extras')}>{t('studio.ai.group.addExtras')}</button>
        </div>
      )}
    </details>
  );
}
