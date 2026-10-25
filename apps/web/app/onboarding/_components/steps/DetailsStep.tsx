'use client';
// Step 6: photos, prices, descriptions and availability, one compact row per dish (the menu workspace's essentials).
// Edits go through the menu API: PATCH …/products/:id (with the version the row was loaded at), POST …/image, and
// POST …/availability for the branch (sold out today / back on).
import { useCallback, useEffect, useState } from 'react';
import type { MenuEditorView, Product } from '@resuto/contracts';
import { Switch } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { StepFrame } from '../StepFrame';
import { errorText, minorToText, priceToMinor, useWizard } from '../wizard-context';

export function DetailsStep() {
  const { t } = useT();
  const w = useWizard();
  const org = w.org!;
  const [menu, setMenu] = useState<MenuEditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setMenu(await w.call<MenuEditorView>(`/o/${org.id}/menu`)); } catch (e) { setError(errorText(e)); }
  }, [org.id, w]);
  useEffect(() => { void reload(); }, [reload]);
  const dishes = (menu?.products ?? []).filter((p) => p.isActive);
  return (
    <StepFrame title={t('onb.details.title')} body={t('onb.details.body')} onSubmit={() => w.finish()} error={error}>
      <ul className="onb-details">
        {dishes.map((p) => <DishRow key={p.id} product={p} onChanged={reload} />)}
      </ul>
    </StepFrame>
  );
}

function DishRow({ product, onChanged }: { product: Product; onChanged(): Promise<void> }) {
  const { t, locale } = useT();
  const w = useWizard();
  const org = w.org!;
  const branchId = org.branches[0]?.id ?? '';
  const [price, setPrice] = useState(minorToText(product.priceMinor));
  const [description, setDescription] = useState(product.description ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const available = !product.branchSettings.find((s) => s.branchId === branchId)?.soldOut;
  const minor = priceToMinor(price);
  const dirty = minor !== product.priceMinor || description.trim() !== (product.description ?? '');
  const base = `/o/${org.id}/menu/products/${product.id}`;
  const name = pick(locale, product.name, product.nameAr);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null); setState('saving');
    try { await fn(); await onChanged(); setState('saved'); } catch (e) { setError(errorText(e)); setState('idle'); }
  };
  const save = () => run(() => w.call(base, { method: 'PATCH', body: { version: product.version, priceMinor: minor, description: description.trim() || null } }));
  const photo = (f: File | undefined) => {
    if (!f) return;
    const form = new FormData();
    form.append('file', f);
    form.append('alt', product.name);
    void run(() => w.call(`${base}/image`, { body: form }));
  };
  const toggle = (on: boolean) => run(() => w.call(`${base}/availability`, { body: { branchId, available: on } }));

  return (
    <li className="onb-dish">
      <div className="onb-dish-photo">
        {product.imageUrl ? <img src={product.imageUrl} alt="" /> : <span aria-hidden="true">{name.slice(0, 1)}</span>}
        <label className="btn btn-sm onb-file">
          {product.imageUrl ? t('onb.details.changePhoto') : t('onb.details.photo')}
          <input type="file" className="sr-only" accept="image/png,image/jpeg,image/webp" aria-label={`${t('onb.details.photo')}: ${name}`}
            onChange={(e) => { photo(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      <div className="onb-dish-fields">
        <strong className="onb-dish-name"><bdi>{name}</bdi></strong>
        <label className="field">
          <span>{t('onb.details.price', { currency: org.currency })}</span>
          <input className="input onb-price" inputMode="decimal" dir="ltr" value={price} onChange={(e) => setPrice(e.target.value)} aria-invalid={minor === null || undefined} />
        </label>
        <label className="field">
          <span>{t('onb.details.description')}</span>
          <input className="input" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="onb-dish-actions">
          <Switch checked={available} onChange={(on) => void toggle(on)} label={t('onb.details.available')} />
          <button type="button" className="btn btn-sm onb-btn" disabled={!dirty || minor === null || state === 'saving'} onClick={() => void save()}>{t('onb.details.save')}</button>
          <span className="onb-hint" role="status">{state === 'saving' ? t('onb.saving') : state === 'saved' && !dirty ? t('onb.details.saved') : ''}</span>
        </div>
        {error && <p className="onb-error" role="alert">{error}</p>}
      </div>
    </li>
  );
}
