'use client';
// Typing the menu in (step 5, manual): one row adds a dish to an existing category or to a new one. The menu API does
// the work (POST …/menu/categories, POST …/menu/products); the list under the step shows what is on the menu.
import { useState, type KeyboardEvent } from 'react';
import type { MenuEditorView } from '@resuto/contracts';
import { Field, SelectField } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { errorText, priceToMinor, useWizard } from '../wizard-context';

const NEW = '__new__';

export function ManualMenu({ menu, onChanged }: { menu: MenuEditorView; onChanged(): Promise<void> }) {
  const { t, locale } = useT();
  const w = useWizard();
  const org = w.org!;
  const categories = menu.categories.filter((c) => c.isActive);
  const [category, setCategory] = useState<string>(categories[categories.length - 1]?.id ?? NEW);
  const [newCategory, setNewCategory] = useState(categories.length ? '' : t('onb.menu.defaultCategory'));
  const [newCategoryAr, setNewCategoryAr] = useState('');
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const priceMinor = priceToMinor(price);
  const chosen = categories.some((c) => c.id === category) ? category : NEW;
  const ready = !!name.trim() && priceMinor !== null && (chosen !== NEW || !!newCategory.trim());

  const add = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      let categoryId = chosen;
      if (chosen === NEW) {
        const c = await w.call<{ id: string }>(`/o/${org.id}/menu/categories`, { body: { name: newCategory.trim(), nameAr: newCategoryAr.trim() || null } });
        categoryId = c.id;
      }
      await w.call(`/o/${org.id}/menu/products`, { body: { categoryId, name: name.trim(), nameAr: nameAr.trim() || null, priceMinor } });
      await onChanged();
      setCategory(categoryId);
      setNewCategory('');
      setNewCategoryAr('');
      setName('');
      setNameAr('');
      setPrice('');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  // Enter in a field adds the dish (it must not submit the step's form).
  const onEnter = (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } };

  return (
    <div className="onb-manual" onKeyDown={onEnter}>
      <div className="onb-row">
        <SelectField label={t('onb.menu.category')} value={chosen} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => <option key={c.id} value={c.id}>{pick(locale, c.name, c.nameAr)}</option>)}
          <option value={NEW}>{t('onb.menu.newCategory')}</option>
        </SelectField>
        {chosen === NEW && (
          <>
            <Field label={t('onb.menu.newCategory')} value={newCategory} maxLength={80} onChange={(e) => setNewCategory(e.target.value)} />
            <Field label={t('onb.menu.categoryAr')} value={newCategoryAr} maxLength={80} dir="rtl" lang="ar" onChange={(e) => setNewCategoryAr(e.target.value)} />
          </>
        )}
      </div>
      <div className="onb-row">
        <Field label={t('onb.menu.item')} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        <Field label={t('onb.menu.itemAr')} value={nameAr} maxLength={120} dir="rtl" lang="ar" onChange={(e) => setNameAr(e.target.value)} />
        <Field label={t('onb.menu.price', { currency: org.currency })} value={price} inputMode="decimal" dir="ltr" onChange={(e) => setPrice(e.target.value)}
          error={price && priceMinor === null ? t('onb.menu.priceInvalid') : undefined} />
      </div>
      <button type="button" className="btn onb-btn" onClick={() => void add()} disabled={!ready || busy}>{t('onb.menu.addItem')}</button>
      {error && <p className="onb-error" role="alert">{error}</p>}
    </div>
  );
}
