'use client';
// Step 4: logo and theme preset (studio_basic: on every plan, without the Studio). The logo goes through the storage
// service (POST /o/:orgId/brand/logo); a preset sets the site's colours, font and template; the three colours can be
// fine-tuned. Everything lands in the website draft and goes live at the publish step.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { BrandView, ThemePreset } from '@resuto/contracts';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { StepFrame } from '../StepFrame';
import { errorText, useWizard } from '../wizard-context';

const LOGO_MAX_BYTES = 5 * 1024 * 1024;
type ColorKey = 'primaryColor' | 'accentColor' | 'backgroundColor';
const COLOR_LABEL: Record<ColorKey, string> = { primaryColor: 'onb.brand.primary', accentColor: 'onb.brand.accent', backgroundColor: 'onb.brand.background' };

export function BrandStep() {
  const { t, locale } = useT();
  const w = useWizard();
  const org = w.org!;
  const [brand, setBrand] = useState<BrandView | null>(null);
  const [presets, setPresets] = useState<ThemePreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const colorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (colorTimer.current) clearTimeout(colorTimer.current); }, []);
  const base = `/o/${org.id}/brand`;

  useEffect(() => {
    let live = true;
    Promise.all([w.call<BrandView>(base), w.call<{ items: ThemePreset[] }>(`${base}/presets`)])
      .then(([b, p]) => { if (live) { setBrand(b); setPresets(p.items); } })
      .catch((e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [base, w]);

  const update = async (body: Record<string, unknown>) => {
    setError(null);
    try { setBrand(await w.call<BrandView>(base, { method: 'PUT', body })); } catch (e) { setError(errorText(e)); }
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > LOGO_MAX_BYTES) { setError(t('onb.brand.tooLarge')); return; }
    const form = new FormData();
    form.append('file', f);
    setUploading(true);
    setError(null);
    try { setBrand(await w.call<BrandView>(`${base}/logo`, { body: form })); } catch (e) { setError(errorText(e)); } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  };

  const name = pick(locale, org.name, org.nameAr);
  return (
    <StepFrame title={t('onb.brand.title')} body={t('onb.brand.body')} onSubmit={() => w.finish()} primaryDisabled={uploading} error={error}
      secondary={<button type="button" className="btn onb-btn onb-skip" onClick={() => void w.finish()} disabled={w.busy || uploading}>{t('onb.skip')}</button>}>
      <div className="onb-logo">
        <div className="onb-logo-box">
          {brand?.logoUrl ? <img src={brand.logoUrl} alt={t('onb.brand.logoAlt', { name })} /> : <span>{t('onb.brand.noLogo')}</span>}
        </div>
        <div>
          <label className="btn onb-btn onb-file">
            {uploading ? t('onb.brand.uploading') : brand?.logoUrl ? t('onb.brand.replace') : t('onb.brand.upload')}
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={uploading}
              onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
          <p className="onb-hint">{t('onb.brand.logoHint')}</p>
        </div>
      </div>
      <fieldset className="onb-presets">
        <legend>{t('onb.brand.presets')}</legend>
        <div className="onb-preset-grid">
          {presets.map((p) => {
            const on = brand?.presetId === p.id;
            const swatch = { '--sw-1': p.websiteTheme.primaryColor, '--sw-2': p.websiteTheme.accentColor, '--sw-3': p.websiteTheme.backgroundColor } as CSSProperties;
            return (
              <label key={p.id} className={`onb-preset${on ? ' is-on' : ''}`} style={swatch}>
                <input type="radio" name="preset" value={p.id} checked={on} onChange={() => void update({ presetId: p.id })} />
                <span className="onb-swatch" aria-hidden="true"><i /><i /><i /></span>
                <strong>{pick(locale, p.name.en ?? p.id, p.name.ar)}</strong>
                <small>{pick(locale, p.description.en ?? '', p.description.ar)}</small>
              </label>
            );
          })}
        </div>
      </fieldset>
      {brand && (
        <fieldset className="onb-colors">
          <legend>{t('onb.brand.colors')}</legend>
          {(Object.keys(COLOR_LABEL) as ColorKey[]).map((k) => (
            <label key={k} className="onb-color">
              <input type="color" value={brand.theme[k].toLowerCase()} onChange={(e) => {
                const v = e.target.value;
                setBrand({ ...brand, theme: { ...brand.theme, [k]: v } });
                // The picker reports every drag step; the draft is saved once it settles.
                if (colorTimer.current) clearTimeout(colorTimer.current);
                colorTimer.current = setTimeout(() => void update({ [k]: v }), 600);
              }} />
              <span>{t(COLOR_LABEL[k])}</span>
            </label>
          ))}
        </fieldset>
      )}
    </StepFrame>
  );
}
