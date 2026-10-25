'use client';
// Assisted extraction (step 5, FT-08 pipeline): pasted menu text is read by Resuto's own parser (no AI, works on
// every plan); a photo or PDF is read with the restaurant's own AI key when one is connected. Either way the result is
// a draft: every row is shown for review (name, price, keep or not) and only the kept rows are added.
import { useEffect, useState } from 'react';
import type { ExtractionRow, MenuExtractionJob } from '@resuto/contracts';
import { newIdempotencyKey } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { errorText, minorToText, priceToMinor, useWizard } from '../wizard-context';

const POLL_MS = 2000;

export function AssistedImport({ onImported }: { onImported(): Promise<void> }) {
  const { t } = useT();
  const w = useWizard();
  const org = w.org!;
  const base = `/o/${org.id}/menu-import/jobs`;
  const [text, setText] = useState('');
  const [job, setJob] = useState<MenuExtractionJob | null>(null);
  const [rows, setRows] = useState<ExtractionRow[]>([]);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<number | null>(null);

  const show = (j: MenuExtractionJob) => {
    setJob(j);
    if (j.status === 'review') {
      // The owner chose to add these dishes: kept rows go on the menu available (the import default is unavailable).
      const r = j.rows.map((x) => ({ ...x, status: x.priceMinor === null ? 'review' : 'approved', available: true }) as ExtractionRow);
      setRows(r);
      setPrices(Object.fromEntries(r.map((x) => [x.id, x.priceMinor === null ? '' : minorToText(x.priceMinor)])));
    }
  };

  // Photo/PDF jobs are read in the background: poll until the draft is ready (or failed).
  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'processing')) return;
    const id = setTimeout(() => { w.call<MenuExtractionJob>(`${base}/${job.id}`).then(show).catch((e) => setError(errorText(e))); }, POLL_MS);
    return () => clearTimeout(id);
  }, [job, base, w]);

  const start = async (body: FormData | { kind: 'text'; text: string }) => {
    setBusy(true); setError(null); setAdded(null); setJob(null); setRows([]);
    try {
      show(await w.call<MenuExtractionJob>(body instanceof FormData ? `${base}/file` : `${base}/text`, { body }));
    } catch (e) {
      setError(t('onb.assist.failed', { reason: errorText(e) }));
    } finally {
      setBusy(false);
    }
  };
  const fromFile = (f: File | undefined) => {
    if (!f) return;
    const form = new FormData();
    form.append('file', f);
    void start(form);
  };

  const commit = async () => {
    if (!job) return;
    setBusy(true); setError(null);
    try {
      const edited = rows.map((r) => {
        const minor = priceToMinor(prices[r.id] ?? '');
        return { ...r, priceMinor: minor, status: r.status === 'approved' && minor === null ? 'review' : r.status } as ExtractionRow;
      });
      const saved = await w.call<MenuExtractionJob>(`${base}/${job.id}`, { method: 'PATCH', body: { version: job.version, rows: edited } });
      const done = await w.call<MenuExtractionJob>(`${base}/${job.id}/commit`, { body: { version: saved.version, key: newIdempotencyKey() } });
      setAdded(done.commitResult?.created ?? edited.filter((r) => r.status === 'approved').length);
      setJob(null); setRows([]);
      await onImported();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const reading = busy && !job || job?.status === 'queued' || job?.status === 'processing';
  const kept = rows.filter((r) => r.status === 'approved' && priceToMinor(prices[r.id] ?? '') !== null).length;
  return (
    <div className="onb-assist">
      <p className="onb-hint">{t('onb.assist.body')}</p>
      <label className="field">
        <span>{t('onb.assist.text')}</span>
        <textarea className="input onb-textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('onb.assist.textHint')} />
      </label>
      <div className="onb-row onb-row-inline">
        <button type="button" className="btn onb-btn" disabled={!text.trim() || busy} onClick={() => void start({ kind: 'text', text })}>{t('onb.assist.read')}</button>
        <label className="btn onb-btn onb-file">
          {t('onb.assist.file')}
          <input type="file" className="sr-only" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={busy}
            onChange={(e) => { fromFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      <p className="onb-hint">{t('onb.assist.fileNeedsKey')}</p>
      {reading && <p role="status">{t('onb.assist.reading')}</p>}
      {job?.status === 'failed' && <p className="onb-error" role="alert">{t('onb.assist.failed', { reason: job.error ?? '' })}</p>}
      {job?.status === 'review' && (
        rows.length === 0 ? <p>{t('onb.assist.none')}</p> : (
          <div className="onb-review">
            <h2>{t('onb.assist.review')}</h2>
            <p className="onb-hint">{job.mode === 'vision_model' ? t('onb.assist.model', { model: job.model ?? '' }) : t('onb.assist.parser')}</p>
            <ul>
              {rows.map((r, i) => (
                <li key={r.id} className={r.confidence < 0.6 ? 'is-unsure' : undefined}>
                  <label className="onb-keep">
                    <input type="checkbox" checked={r.status === 'approved'}
                      onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, status: e.target.checked ? 'approved' : 'rejected' } : x)))} />
                    <span className="sr-only">{t('onb.assist.keep')}</span>
                  </label>
                  <input className="input" aria-label={t('onb.menu.item')} value={r.name} maxLength={200}
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <input className="input onb-price" aria-label={t('onb.menu.price', { currency: org.currency })} inputMode="decimal" dir="ltr"
                    value={prices[r.id] ?? ''} placeholder={t('onb.assist.missingPrice')} onChange={(e) => setPrices({ ...prices, [r.id]: e.target.value })} />
                  <small className="onb-cat">{r.category}</small>
                </li>
              ))}
            </ul>
            <button type="button" className="btn btn-primary onb-btn" disabled={!kept || busy} onClick={() => void commit()}>{t('onb.assist.add')}</button>
          </div>
        )
      )}
      {added !== null && <p className="onb-ok" role="status">{t('onb.sheet.imported', { created: added, updated: 0 })}</p>}
      {error && <p className="onb-error" role="alert">{error}</p>}
    </div>
  );
}
