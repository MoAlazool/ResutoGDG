'use client';
import { useState } from 'react';
import { useT } from '@/lib/i18n/client';
import { MediaPicker } from './MediaLibrary';
import type { WebsiteState } from './types';

type Loc = { en?: string; ar?: string };

/** One copy field in both site languages (Arabic is RTL). */
export function LocalizedField({ label, value, onChange, max, multiline, hint }: {
  label: string; value: Loc | undefined; onChange: (v: Loc) => void; max: number; multiline?: boolean; hint?: string;
}) {
  const { t } = useT();
  const v = value ?? {};
  const Input = multiline ? 'textarea' : 'input';
  return (
    <fieldset className="ws-loc">
      <legend>{label}</legend>
      <label className="field"><span>{t('studio.lang.en')}</span>
        <Input className={multiline ? 'textarea' : 'input'} dir="ltr" lang="en" maxLength={max} value={v.en ?? ''} onChange={(e) => onChange({ ...v, en: e.target.value })} />
      </label>
      <label className="field"><span>{t('studio.lang.ar')}</span>
        <Input className={multiline ? 'textarea' : 'input'} dir="rtl" lang="ar" maxLength={max} value={v.ar ?? ''} onChange={(e) => onChange({ ...v, ar: e.target.value })} />
      </label>
      {hint && <small className="fine">{hint}</small>}
    </fieldset>
  );
}

/** One image from the media library (choose, replace, remove). */
export function MediaField({ orgId, label, id, media, onChange, disabled }: {
  orgId: string; label: string; id: string | null | undefined; media: WebsiteState['media']; onChange: (id: string | null) => void; disabled?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<Record<string, string>>({});
  const url = id ? media[id]?.url ?? local[id] : null;
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row">
        {url ? <img src={url} alt="" className="ws-thumb" /> : <span className="ws-thumb ws-thumb-empty" aria-hidden>▢</span>}
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setOpen(true)}>{id ? t('studio.media.replace') : t('studio.media.choose')}</button>
        {id && <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => onChange(null)}>{t('studio.media.remove')}</button>}
      </div>
      <MediaPicker orgId={orgId} open={open} onClose={() => setOpen(false)} selected={id ? [id] : []}
        onPick={(ids, items) => { setLocal(Object.fromEntries(items.map((m) => [m.id, m.url]))); onChange(ids[0] ?? null); }} />
    </div>
  );
}
