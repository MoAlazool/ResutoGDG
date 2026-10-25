'use client';
import Link from 'next/link';
import { useState } from 'react';
import type { MenuImportPreview } from '@resuto/contracts';
import { formatNumber } from '@resuto/contracts/lite';
import { Badge, Notice, SegmentedControl, Sheet, TextareaField } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';

type Source = 'file' | 'paste' | 'assisted';
interface ReadSheet { csv: string; kind: 'csv' | 'xlsx'; name: string | null }
const SAMPLE = 'externalId,name,nameAr,category,description,price,station,allergens,available\r\n,Flat white,,Coffee,Double shot with steamed milk,65,Bar,milk,true\r\n,Croissant,,Bakery,Butter croissant,45,,"wheat,milk",true\r\n';

/**
 * Menu import as an action of the menu workspace (21-MENU). A spreadsheet (CSV, or the first sheet of an .xlsx read in
 * the browser by the onboarding wizard's spreadsheet worker, loaded only when a file is chosen) or pasted CSV goes
 * through the API's preview (every row checked, nothing written) and is committed only when no row has an error, with
 * one idempotency key per preview. Photos, PDFs and free text use the assisted extraction with its own review step at
 * /menu-import, linked from here.
 */
export default function ImportSheet({ orgId, currency, onClose, onImported }: {
  orgId: string; currency: string; onClose: () => void; onImported: () => Promise<void> | void;
}) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [source, setSource] = useState<Source>('file');
  const [paste, setPaste] = useState('');
  const [sheet, setSheet] = useState<ReadSheet | null>(null);
  const [preview, setPreview] = useState<MenuImportPreview | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());
  const errors = preview?.summary.errors ?? 0;

  const review = async (next: ReadSheet) => {
    setError(null); setDone(null); setPreview(null); setSheet(next); setBusy(true);
    try {
      setPreview(await call<MenuImportPreview>(`/o/${orgId}/menu/import/preview`, { body: { csv: next.csv, source: next.kind } }));
      setKey(newIdempotencyKey());
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const choose = async (file: File | undefined) => {
    if (!file) return;
    setError(null); setDone(null); setPreview(null); setSheet(null);
    if (!/\.(csv|xlsx|txt)$/i.test(file.name)) { setError(t('onb.sheet.unsupported')); return; }
    setReading(true);
    try {
      // The reader and its worker are separate chunks: nothing of them loads until a file is chosen.
      const { readSpreadsheet } = await import('@/lib/onboarding/spreadsheet');
      const result = await readSpreadsheet(file);
      if (!result.ok) { setError(result.code === 'unsupported' ? t('onb.sheet.unsupported') : t('onb.sheet.failed', { reason: result.message })); return; }
      await review({ csv: result.sheet.csv, kind: result.sheet.kind, name: file.name });
    } catch (e) { setError((e as Error).message); } finally { setReading(false); }
  };
  const commit = async () => {
    if (!sheet || !preview || errors || busy) return;
    setError(null); setBusy(true);
    try {
      const r = await call<{ created: number; updated: number }>(`/o/${orgId}/menu/import/commit`, { body: { csv: sheet.csv, source: sheet.kind, key }, idempotencyKey: key });
      setDone(t('core.menu.imported', { created: formatNumber(r.created, locale), updated: formatNumber(r.updated, locale) }));
      setPreview(null); setSheet(null); setPaste('');
      await onImported();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const exportCsv = async () => {
    setError(null);
    try {
      const r = await call<{ csv: string }>(`/o/${orgId}/menu/export`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + r.csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'menu.csv';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <Sheet open onClose={onClose} size="lg" title={t('menu.ws.import.title')} description={t('menu.ws.import.subtitle')}
      footer={preview ? (
        <div className="menu-sheet-foot">
          <span className="fine">{errors > 0 ? t('core.menu.fixErrors') : t('menu.ws.import.ready', { n: preview.summary.total })}</span>
          <div className="row">
            <button type="button" className="btn" onClick={() => { setPreview(null); setSheet(null); }}>{t('action.cancel')}</button>
            <button type="button" className="btn btn-primary" disabled={errors > 0 || busy} aria-busy={busy || undefined} onClick={() => void commit()}>{t('core.menu.commit')}</button>
          </div>
        </div>
      ) : undefined}>
      <div className="stack">
        <SegmentedControl label={t('menu.ws.import.source')} value={source} onChange={(v) => { setSource(v); setError(null); }}
          options={[{ value: 'file', label: t('menu.ws.import.file') }, { value: 'paste', label: t('menu.ws.import.paste') }, { value: 'assisted', label: t('menu.ws.import.assisted') }]} />
        {source === 'file' && (
          <div className="stack">
            <p className="fine">{t('menu.ws.import.fileHint')}</p>
            <div className="row">
              <label className="btn btn-primary menu-file">
                {reading ? t('onb.sheet.reading') : t('menu.ws.import.choose')}
                <input type="file" className="sr-only" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={reading || busy}
                  onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
              </label>
              <a className="btn" href={`data:text/csv;charset=utf-8,${encodeURIComponent(SAMPLE)}`} download="resuto-menu-sample.csv">{t('onb.sheet.sample')}</a>
              <button type="button" className="btn" onClick={() => void exportCsv()}>{t('menu.ws.import.export')}</button>
            </div>
            <code className="fine menu-columns" dir="ltr">externalId,name,nameAr,category,description,price,station,allergens,available</code>
          </div>
        )}
        {source === 'paste' && (
          <div className="stack">
            <p className="fine">{t('core.menu.importHint')}</p>
            <TextareaField label={t('core.menu.pasteCsv')} value={paste} onChange={(e) => setPaste(e.target.value)} rows={8} className="ops-mono" dir="ltr" />
            <div><button type="button" className="btn btn-primary" disabled={!paste.trim() || busy} onClick={() => void review({ csv: paste, kind: 'csv', name: null })}>{t('core.menu.review')}</button></div>
          </div>
        )}
        {source === 'assisted' && (
          <div className="stack">
            <p>{t('menu.ws.import.assistedBody')}</p>
            <div><Link className="btn btn-primary" href={`/dashboard/${orgId}/menu-import`}>{t('menu.ws.import.assistedOpen')}</Link></div>
          </div>
        )}
        {(reading || (busy && !preview)) && <p role="status" className="fine">{t('onb.sheet.reading')}</p>}
        {error && <Notice tone="danger">{error}</Notice>}
        {done && <Notice tone="ok">{done}</Notice>}
        {preview && (
          <section className="stack" aria-label={t('menu.ws.import.preview')}>
            <div className="spread">
              <h3 className="menu-h3">{sheet?.name ? <bdi>{sheet.name}</bdi> : t('menu.ws.import.preview')} · {t('core.menu.previewTitle', { n: preview.summary.total })}</h3>
              <span className="row">
                <Badge tone="info">{t('core.menu.toCreate', { n: formatNumber(preview.summary.create, locale) })}</Badge>
                <Badge tone="pay">{t('core.menu.toUpdate', { n: preview.summary.update })}</Badge>
                {errors > 0 && <Badge tone="danger">{t('core.menu.withErrors', { n: formatNumber(errors, locale) })}</Badge>}
              </span>
            </div>
            {preview.summary.newCategories.length > 0 && <p className="fine">{t('core.menu.newCategories', { list: preview.summary.newCategories.join(locale === 'ar' ? '، ' : ', ') })}</p>}
            <div className="table-wrap">
              <table className="data menu-import-table">
                <caption className="sr-only">{t('menu.ws.import.preview')}</caption>
                <thead><tr><th scope="col" className="num">#</th><th scope="col">{t('core.menu.name')}</th><th scope="col">{t('core.menu.category')}</th><th scope="col" className="num">{t('ops.menu.col.price')}</th><th scope="col">{t('core.menu.review')}</th></tr></thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr key={r.row} data-invalid={r.errors.length ? '' : undefined}>
                      <td className="num">{formatNumber(r.row, locale)}</td>
                      <td><bdi>{r.item.name}</bdi><div className="fine">{r.action === 'update' ? t('core.menu.willUpdate') : t('core.menu.willCreate')}</div></td>
                      <td><bdi>{r.item.category}</bdi></td>
                      <td className="num">{money(r.item.priceMinor, currency, locale)}</td>
                      <td>{r.errors.map((e) => <div key={e} className="field-error">{e}</div>)}{r.warnings.map((w) => <div key={w} className="fine">{w}</div>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </Sheet>
  );
}
