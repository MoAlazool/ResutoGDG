'use client';
import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { ALLERGENS, DIETARY_TAGS, type MenuEditorView, type Product } from '@resuto/contracts';
import { Field, MoneyInput, Notice, SelectField, Sheet, Switch, TextareaField, useConfirm } from '@resuto/ui';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { allergenLabel } from '@/lib/vocab';
import { branchView, compareAtOf } from './model';

const list = (s: FormDataEntryValue | null) => String(s ?? '').split(/[,،]/).map((x) => x.trim()).filter(Boolean);
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

/**
 * A dish in a sheet (21-MENU): every field of the menu editor (names and descriptions in both languages, category,
 * price and cost in minor units, station, prep time, spice, allergens, dietary tags, ingredients, option groups,
 * photo) and the dish at the shell's branch (offered there, its own price, portions left, counted or not). A dish
 * discount from Studio is shown, not edited: changing the price ends it, as the API does. Saves are direct staff edits
 * (no change set), each with the version the sheet loaded.
 */
export default function ItemSheet({ menu, product, branchId, defaultCategory, onClose, onSaved }: {
  menu: MenuEditorView; product: Product | null; branchId: string; defaultCategory?: string; onClose: () => void; onSaved: () => void;
}) {
  const { t, locale } = useT();
  const [confirm, confirmDialog] = useConfirm(locale);
  const { org, can, hasModule } = useOrg();
  const { call } = useSession();
  const currency = menu.currency as 'EGP' | 'SAR';
  const setting = product?.branchSettings.find((s) => s.branchId === branchId);
  const view = product ? branchView(product, branchId) : null;
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [price, setPrice] = useState<number | null>(product?.priceMinor ?? null);
  const [cost, setCost] = useState<number | null>(product?.costMinor ?? null);
  const [override, setOverride] = useState<number | null>(setting?.priceOverrideMinor ?? null);
  const [offered, setOffered] = useState(view?.offered ?? true);
  const [trackStock, setTrackStock] = useState(product?.trackStock ?? false);
  const [groupIds, setGroupIds] = useState<string[]>(product?.modifierGroupIds ?? []);
  const known = new Set<string>(ALLERGENS);
  const [allergens, setAllergens] = useState<string[]>((product?.allergens ?? []).filter((a) => known.has(a)));
  const knownDiet = new Set<string>(DIETARY_TAGS);
  const [dietary, setDietary] = useState<string[]>((product?.dietary ?? []).filter((d) => knownDiet.has(d)));
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const formId = `menu-item-${product?.id ?? 'new'}`;
  const branch = org.branches.find((b) => b.id === branchId);
  const branchName = pick(locale, branch?.name, branch?.nameAr);
  const was = product ? compareAtOf(product) : null;
  const categories = menu.categories.filter((c) => c.isActive);
  const groups = menu.modifierGroups.filter((g) => g.isActive);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    if (price === null) { setError(t('menu.ws.item.priceRequired')); return; }
    const f = new FormData(e.currentTarget);
    setPending(true); setError(null);
    try {
      const body = {
        categoryId: String(f.get('categoryId')), name: String(f.get('name')).trim(), nameAr: String(f.get('nameAr') ?? '').trim() || null,
        description: String(f.get('description') ?? '').trim() || null, descriptionAr: String(f.get('descriptionAr') ?? '').trim() || null,
        priceMinor: price, costMinor: cost,
        station: String(f.get('station') ?? '').trim() || undefined, prepMinutes: f.get('prep') ? Number(f.get('prep')) : null, spiceLevel: Number(f.get('spice') ?? 0),
        allergens: [...allergens, ...list(f.get('allergensOther'))], dietary: [...dietary, ...list(f.get('dietaryOther'))], ingredients: list(f.get('ingredients')),
        trackStock,
      };
      let saved: Product = product
        ? await call<Product>(`/o/${org.id}/menu/products/${product.id}`, { method: 'PATCH', body: { ...body, version: product.version } })
        : await call<Product>(`/o/${org.id}/menu/products`, { body });
      if (!sameSet(groupIds, product?.modifierGroupIds ?? [])) {
        saved = await call<Product>(`/o/${org.id}/menu/products/${saved.id}/modifier-groups`, { method: 'PUT', body: { groupIds } });
      }
      const stock = f.get('stock') !== '' && f.get('stock') !== null ? Number(f.get('stock')) : null;
      if (branchId && (override !== (setting?.priceOverrideMinor ?? null) || stock !== (setting?.stockQty ?? null) || offered !== (setting?.isAvailable ?? true))) {
        await call(`/o/${org.id}/menu/products/${saved.id}/branches/${branchId}`, { method: 'PUT', body: { priceOverrideMinor: override, stockQty: stock, isAvailable: offered } });
      }
      const file = fileRef.current?.files?.[0];
      if (file) {
        const fd = new FormData();
        fd.append('file', file);
        await call(`/o/${org.id}/menu/products/${saved.id}/image`, { body: fd });
      }
      onSaved();
    } catch (err) { setError((err as Error).message); } finally { setPending(false); }
  }

  const archive = async () => {
    if (!product || pending || !(await confirm({ title: t('core.menu.archiveItem'), tone: 'danger', confirmLabel: t('core.menu.archive') }))) return;
    setPending(true); setError(null);
    try { await call(`/o/${org.id}/menu/products/${product.id}`, { method: 'DELETE' }); onSaved(); } catch (e) { setError((e as Error).message); } finally { setPending(false); }
  };
  const toggle = (arr: string[], v: string, on: boolean) => (on ? [...arr, v] : arr.filter((x) => x !== v));
  const other = (all: string[] | undefined, knownSet: Set<string>) => (all ?? []).filter((x) => !knownSet.has(x)).join(', ');

  return (
    <Sheet open onClose={onClose} size="lg" title={product ? t('core.menu.editItem') : t('core.menu.newItem')}
      description={product ? <bdi>{pick(locale, product.name, product.nameAr)}</bdi> : undefined}
      footer={(
        <div className="menu-sheet-foot">
          {product ? <button type="button" className="btn btn-danger" disabled={pending} onClick={() => void archive()}>{t('core.menu.archive')}</button> : <span />}
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button>
            <button type="submit" form={formId} className="btn btn-primary" disabled={pending} aria-busy={pending || undefined}>{pending ? t('state.loading') : t('action.save')}</button>
          </div>
        </div>
      )}>
      {confirmDialog}
      <form id={formId} className="stack menu-item-form" onSubmit={submit}>
        <div className="form-row">
          <Field label={t('core.menu.name')} name="name" required maxLength={120} defaultValue={product?.name} autoFocus={!product} />
          <Field label={t('core.menu.nameAr')} name="nameAr" dir="rtl" maxLength={120} defaultValue={product?.nameAr ?? ''} />
        </div>
        <SelectField label={t('core.menu.category')} name="categoryId" defaultValue={product?.categoryId ?? defaultCategory ?? categories[0]?.id}>
          {categories.map((c) => <option key={c.id} value={c.id}>{pick(locale, c.name, c.nameAr)}</option>)}
        </SelectField>
        <TextareaField label={t('core.menu.description')} name="description" maxLength={1000} rows={3} defaultValue={product?.description ?? ''} />
        <TextareaField label={t('core.menu.descriptionAr')} name="descriptionAr" dir="rtl" maxLength={1000} rows={3} defaultValue={product?.descriptionAr ?? ''} />

        <fieldset className="menu-fieldset">
          <legend>{t('menu.ws.item.pricing')}</legend>
          <div className="form-row">
            <MoneyInput label={t('core.menu.price', { currency })} valueMinor={price} onChange={setPrice} currency={currency} locale={locale} required name="price" />
            <MoneyInput label={t('core.menu.cost', { currency })} valueMinor={cost} onChange={setCost} currency={currency} locale={locale} name="cost" hint={t('core.menu.costHint')} />
          </div>
          {was !== null && product && (
            <Notice tone="info">
              <span className="num">{t('menu.ws.item.discount', { was: money(was, currency, locale), now: money(product.priceMinor, currency, locale) })}</span>{' '}
              {t('menu.ws.item.discountHint')}
            </Notice>
          )}
        </fieldset>

        <fieldset className="menu-fieldset">
          <legend>{t('menu.ws.item.kitchen')}</legend>
          <div className="form-row">
            <Field label={t('core.menu.station')} name="station" list="menu-stations" maxLength={40} defaultValue={product?.station ?? ''} />
            <Field label={t('core.menu.prep')} name="prep" type="number" inputMode="numeric" min={0} max={600} defaultValue={product?.prepMinutes ?? ''} />
            <SelectField label={t('core.menu.spice')} name="spice" defaultValue={String(product?.spiceLevel ?? 0)}>
              {[0, 1, 2, 3].map((n) => <option key={n} value={n}>{n === 0 ? t('menu.ws.item.spiceNone') : t('menu.ws.item.spiceLevel', { n })}</option>)}
            </SelectField>
          </div>
          <datalist id="menu-stations">{menu.stations.map((s) => <option key={s} value={s} />)}</datalist>
          <Field label={t('core.menu.ingredients')} name="ingredients" defaultValue={product?.ingredients.join(', ')} hint={t('core.menu.listHint')} />
        </fieldset>

        <fieldset className="menu-fieldset">
          <legend>{t('core.menu.allergens')}</legend>
          <div className="menu-checks">
            {ALLERGENS.map((a) => (
              <label key={a} className="check"><input type="checkbox" checked={allergens.includes(a)} onChange={(e) => setAllergens(toggle(allergens, a, e.target.checked))} /> {allergenLabel(t, a)}</label>
            ))}
          </div>
          <Field label={t('menu.ws.item.otherAllergens')} name="allergensOther" defaultValue={other(product?.allergens, known)} hint={t('core.menu.listHint')} />
        </fieldset>

        <fieldset className="menu-fieldset">
          <legend>{t('core.menu.dietary')}</legend>
          <div className="menu-checks">
            {DIETARY_TAGS.map((d) => (
              <label key={d} className="check"><input type="checkbox" checked={dietary.includes(d)} onChange={(e) => setDietary(toggle(dietary, d, e.target.checked))} /> {t(`core.dietary.${d}`)}</label>
            ))}
          </div>
          <Field label={t('menu.ws.item.otherDietary')} name="dietaryOther" defaultValue={other(product?.dietary, knownDiet)} hint={t('core.menu.listHint')} />
        </fieldset>

        {groups.length > 0 && (
          <fieldset className="menu-fieldset">
            <legend>{t('core.menu.modifiers')}</legend>
            <div className="menu-checks">
              {groups.map((g) => (
                <label key={g.id} className="check"><input type="checkbox" checked={groupIds.includes(g.id)} onChange={(e) => setGroupIds(toggle(groupIds, g.id, e.target.checked))} />
                  {' '}<bdi>{pick(locale, g.name, g.nameAr)}</bdi> <span className="fine">{t('core.menu.selectRange', { min: g.minSelect, max: g.maxSelect })}</span></label>
              ))}
            </div>
          </fieldset>
        )}

        {branchId && (
          <fieldset className="menu-fieldset">
            <legend>{t('menu.ws.item.atBranch', { branch: branchName })}</legend>
            <Switch checked={offered} onChange={setOffered} label={t('ops.menu.offeredHere', { branch: branchName })} description={t('ops.menu.offeredHint')} />
            <div className="form-row">
              <MoneyInput label={t('core.menu.branchPrice', { currency })} valueMinor={override} onChange={setOverride} currency={currency} locale={locale} name="override" hint={t('core.menu.branchPriceHint')} />
              <Field label={t('core.menu.stock')} name="stock" type="number" inputMode="numeric" min={0} defaultValue={setting?.stockQty ?? ''} hint={t('core.menu.stockHint')} />
            </div>
            <Switch checked={trackStock} onChange={setTrackStock} label={t('menu.ws.item.track')} description={t('menu.ws.item.trackHint')} />
          </fieldset>
        )}

        <fieldset className="menu-fieldset">
          <legend>{t('core.menu.image')}</legend>
          <div className="menu-photo">
            {(preview ?? product?.imageUrl) ? <img src={preview ?? product?.imageUrl ?? ''} alt="" width={96} height={96} /> : null}
            <label className="field"><span>{product?.imageUrl ? t('menu.ws.item.replacePhoto') : t('menu.ws.item.addPhoto')}</span>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp"
                onChange={(e) => { const file = e.target.files?.[0]; setPreview((old) => { if (old) URL.revokeObjectURL(old); return file ? URL.createObjectURL(file) : null; }); }} />
            </label>
          </div>
          {product && can('studio:write') && hasModule('studio') && (
            <p className="fine">
              <Link href={`/dashboard/${org.id}/studio-media?product=${product.id}`}>{t('studio.ai.photo.enhanceFromMenu')}</Link>
              {' · '}{t('studio.ai.photo.enhanceFromMenuHint')}
            </p>
          )}
        </fieldset>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Sheet>
  );
}
