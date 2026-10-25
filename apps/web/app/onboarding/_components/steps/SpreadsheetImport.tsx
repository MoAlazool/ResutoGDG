'use client';
// A menu spreadsheet (step 5): the file is read in the browser by the spreadsheet worker (CSV, or the first sheet of
// an .xlsx turned into CSV), then the menu import previews every row (errors per row) and commits only a clean file.
import { useState } from 'react';
import type { MenuImportPreview } from '@resuto/contracts';
import { newIdempotencyKey } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import type { ParsedSheet } from '@/lib/onboarding/spreadsheet-parse';
import { errorText, useWizard } from '../wizard-context';

const SAMPLE = 'name,name_ar,category,price,description\r\nFlat white,,Coffee,65,Double shot with steamed milk\r\nCroissant,,Bakery,45,Butter croissant\r\n';

export function SpreadsheetImport({ onImported }: { onImported(): Promise<void> }) {
  const { t } = useT();
  const w = useWizard();
  const { call } = w;
  const org = w.org!;
  const [reading, setReading] = useState(false);
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [preview, setPreview] = useState<MenuImportPreview | null>(null);
  const [done, setDone] = useState<{ created: number; updated: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setPreview(null); setSheet(null); setDone(null);
    if (!/\.(csv|xlsx|txt)$/i.test(file.name)) { setError(t('onb.sheet.unsupported')); return; }
    setReading(true);
    try {
      const { readSpreadsheet } = await import('@/lib/onboarding/spreadsheet');
      const result = await readSpreadsheet(file);
      if (!result.ok) { setError(result.code === 'unsupported' ? t('onb.sheet.unsupported') : t('onb.sheet.failed', { reason: result.message })); return; }
      setSheet(result.sheet);
      setPreview(await call<MenuImportPreview>(`/o/${org.id}/menu/import/preview`, { body: { csv: result.sheet.csv, source: result.sheet.kind } }));
      setKey(newIdempotencyKey());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setReading(false);
    }
  };

  const commit = async () => {
    if (!sheet || !preview || preview.summary.errors) return;
    setError(null);
    try {
      const r = await call<{ created: number; updated: number }>(`/o/${org.id}/menu/import/commit`, {
        body: { csv: sheet.csv, source: sheet.kind, key }, idempotencyKey: key,
      });
      setDone({ created: r.created, updated: r.updated });
      setPreview(null);
      await onImported();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const problems = preview?.rows.filter((r) => r.errors.length) ?? [];
  const sampleHref = `data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`;
  return (
    <div className="onb-sheet">
      <p className="onb-hint">{t('onb.sheet.body')}</p>
      <div className="onb-row onb-row-inline">
        <label className="btn onb-btn onb-file">
          {t('onb.sheet.choose')}
          <input type="file" className="sr-only" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        <a className="onb-link" href={sampleHref} download="resuto-menu-sample.csv">{t('onb.sheet.sample')}</a>
      </div>
      {reading && <p role="status">{t('onb.sheet.reading')}</p>}
      {sheet && preview && (
        <div className="onb-preview" aria-live="polite">
          <h2>{t('onb.sheet.check')}</h2>
          <p>{t('onb.sheet.found', { n: sheet.rows })}{problems.length ? ` · ${t('onb.sheet.problems', { n: problems.length })}` : ''}</p>
          {problems.length > 0 && (
            <ul className="onb-problems">
              {problems.slice(0, 20).map((r) => <li key={r.row}><strong>{t('onb.sheet.row', { n: r.row + 1 })}</strong> {r.errors.join('; ')}</li>)}
            </ul>
          )}
          <button type="button" className="btn btn-primary onb-btn" disabled={problems.length > 0 || w.busy} onClick={() => void commit()}>{t('onb.sheet.import')}</button>
        </div>
      )}
      {done && <p className="onb-ok" role="status">{t('onb.sheet.imported', done)}</p>}
      {error && <p className="onb-error" role="alert">{error}</p>}
    </div>
  );
}
