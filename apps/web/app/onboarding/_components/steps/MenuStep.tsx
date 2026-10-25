'use client';
// Step 5: the menu, three ways. Typed in (categories and dishes created inline through the menu API), a spreadsheet
// (CSV or .xlsx read in the browser by a worker, then the menu import's preview and commit), or assisted: menu text
// read by Resuto's parser, or a photo/PDF read with the restaurant's own AI key (FT-08), always with a review of every
// row before anything is added.
import { useCallback, useEffect, useState } from 'react';
import type { MenuEditorView } from '@resuto/contracts';
import { SegmentedControl } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/pick';
import { StepFrame } from '../StepFrame';
import { errorText, useWizard } from '../wizard-context';
import { AssistedImport } from './AssistedImport';
import { ManualMenu } from './ManualMenu';
import { SpreadsheetImport } from './SpreadsheetImport';

type Method = 'manual' | 'spreadsheet' | 'assisted';

export function MenuStep() {
  const { t, locale } = useT();
  const w = useWizard();
  const { call } = w;
  const org = w.org!;
  const [method, setMethod] = useState<Method>(w.progress.draft.menuMethod ?? 'manual');
  const [menu, setMenu] = useState<MenuEditorView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);

  const reload = useCallback(async () => {
    try { setMenu(await call<MenuEditorView>(`/o/${org.id}/menu`)); } catch (e) { setError(errorText(e)); }
  }, [org.id, call]);
  useEffect(() => { void reload(); }, [reload]);

  const dishes = (menu?.products ?? []).filter((p) => p.isActive);
  const submit = async () => {
    setTried(true);
    if (!dishes.length) return;
    await w.finish({ draft: { ...w.progress.draft, menuMethod: method } });
  };

  return (
    <StepFrame title={t('onb.menu.title')} body={t('onb.menu.body')} onSubmit={submit}
      error={error ?? (tried && !dishes.length ? t('onb.menu.needOne') : null)}>
      <SegmentedControl<Method> label={t('onb.menu.method')} value={method} onChange={setMethod} className="onb-methods"
        options={[{ value: 'manual', label: t('onb.menu.manual') }, { value: 'spreadsheet', label: t('onb.menu.spreadsheet') }, { value: 'assisted', label: t('onb.menu.assisted') }]} />
      {method === 'manual' && menu && <ManualMenu menu={menu} onChanged={reload} />}
      {method === 'spreadsheet' && <SpreadsheetImport onImported={reload} />}
      {method === 'assisted' && <AssistedImport onImported={reload} />}
      <div className="onb-menu-summary" aria-live="polite">
        <strong>{t('onb.menu.count', { n: dishes.length })}</strong>
        {dishes.length > 0 && (
          <ul className="onb-dish-list">
            {(menu?.categories ?? []).map((c) => {
              const items = dishes.filter((p) => p.categoryId === c.id);
              if (!items.length) return null;
              return (
                <li key={c.id}>
                  <span className="onb-cat">{pick(locale, c.name, c.nameAr)}</span>
                  <span className="onb-dishes">{items.map((p) => pick(locale, p.name, p.nameAr)).join(locale === 'ar' ? '، ' : ', ')}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </StepFrame>
  );
}
