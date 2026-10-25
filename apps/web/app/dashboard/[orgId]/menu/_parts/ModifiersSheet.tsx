'use client';
import { useState, type FormEvent } from 'react';
import type { MenuEditorView, ModifierGroup } from '@resuto/contracts';
import { EmptyState, Field, MoneyInput, Notice, Sheet, Switch } from '@resuto/ui';
import { money, pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';

/**
 * Option groups (sizes, extras) in a sheet of the menu workspace (21-MENU; the former Options tab, unchanged in what it
 * does): add a group with its choice range, add options with their extra price, switch an option off, delete an
 * option, archive a group. One change at a time; failures stay on screen. Dishes pick their groups in the dish sheet.
 */
export default function ModifiersSheet({ orgId, menu, reload, onClose }: { orgId: string; menu: MenuEditorView; reload: () => Promise<void>; onClose: () => void }) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delta, setDelta] = useState<Record<string, number | null>>({});
  const currency = menu.currency as 'EGP' | 'SAR';
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(true); setError(null);
    try { await fn(); await reload(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };

  async function addGroup(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (await run(() => call(`/o/${orgId}/menu/modifier-groups`, { body: { name: String(f.get('name')), nameAr: (f.get('nameAr') as string) || null, minSelect: Number(f.get('min')), maxSelect: Number(f.get('max')) } }))) form.reset();
  }
  const addOption = async (g: ModifierGroup, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    if (await run(() => call(`/o/${orgId}/menu/modifier-groups/${g.id}/options`, { body: { name: String(f.get('name')), nameAr: (f.get('nameAr') as string) || null, priceDeltaMinor: delta[g.id] ?? 0 } }))) {
      form.reset();
      setDelta((d) => ({ ...d, [g.id]: null }));
    }
  };

  return (
    <Sheet open onClose={onClose} size="lg" title={t('core.menu.modifiers')} description={t('menu.ws.groups.subtitle')}>
      <div className="stack">
        {error && <Notice tone="danger">{error}</Notice>}
        <form className="card" onSubmit={addGroup}>
          <h3 className="menu-h3">{t('core.menu.newGroup')}</h3>
          <div className="form-row">
            <Field label={t('core.menu.name')} name="name" required maxLength={80} placeholder={t('core.menu.groupExample')} />
            <Field label={t('core.menu.nameAr')} name="nameAr" dir="rtl" maxLength={80} />
            <Field label={t('core.menu.min')} name="min" type="number" inputMode="numeric" min={0} max={20} defaultValue={0} />
            <Field label={t('core.menu.max')} name="max" type="number" inputMode="numeric" min={1} max={20} defaultValue={1} />
          </div>
          <button className="btn btn-primary" disabled={busy}>{t('action.add')}</button>
        </form>
        {!menu.modifierGroups.length && <div className="card"><EmptyState title={t('core.menu.noGroups')} /></div>}
        {menu.modifierGroups.map((g) => (
          <section key={g.id} className="card" data-archived={!g.isActive || undefined} aria-label={pick(locale, g.name, g.nameAr)}>
            <div className="spread">
              <h3 className="menu-h3"><bdi>{pick(locale, g.name, g.nameAr)}</bdi> <span className="fine">{t('core.menu.selectRange', { min: g.minSelect, max: g.maxSelect })}</span></h3>
              {g.isActive && <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void run(() => call(`/o/${orgId}/menu/modifier-groups/${g.id}`, { method: 'DELETE' }))}>{t('core.menu.archive')}</button>}
            </div>
            {g.options.map((o) => (
              <div key={o.id} className="spread ops-line">
                <span><bdi>{pick(locale, o.name, o.nameAr)}</bdi> {o.priceDeltaMinor ? <span className="fine num">+{money(o.priceDeltaMinor, currency, locale)}</span> : null}</span>
                <span className="row">
                  <Switch checked={o.isAvailable} disabled={busy} label={t('core.menu.available')}
                    onChange={(on) => void run(() => call(`/o/${orgId}/menu/modifier-options/${o.id}`, { method: 'PATCH', body: { isAvailable: on } }))} />
                  <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void run(() => call(`/o/${orgId}/menu/modifier-options/${o.id}`, { method: 'DELETE' }))}>
                    {t('action.delete')}<span className="sr-only"> <bdi>{pick(locale, o.name, o.nameAr)}</bdi></span>
                  </button>
                </span>
              </div>
            ))}
            {g.isActive && (
              <form className="form-row ops-gap-top" data-align="end" onSubmit={(e) => void addOption(g, e)}>
                <Field label={t('core.menu.option')} name="name" required maxLength={80} />
                <Field label={t('core.menu.nameAr')} name="nameAr" dir="rtl" maxLength={80} />
                <MoneyInput label={t('core.menu.delta', { currency })} valueMinor={delta[g.id] ?? null} onChange={(v) => setDelta((d) => ({ ...d, [g.id]: v }))} currency={currency} locale={locale} />
                <div className="field"><button className="btn" disabled={busy}>{t('action.add')}</button></div>
              </form>
            )}
          </section>
        ))}
      </div>
    </Sheet>
  );
}
