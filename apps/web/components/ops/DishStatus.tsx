'use client';
import { formatNumber, type Product } from '@resuto/contracts';
import { Badge } from '@resuto/ui';
import { time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { LOW_STOCK, portionsOf } from './portions';
import { branchState } from './SoldOutDrawer';

/**
 * A dish's status at a branch for the menu table and Dish availability (PAR-03 / PAR-08). Like legacy's per-dish list,
 * a dish whose recipe makes no portions from the ingredients on hand is not "Available": it reads "Out of ingredients"
 * (warn), so the status never contradicts a red 0 in the Portions column (review of PAR-08).
 */
export function DishStatus({ p, branchId, timezone }: { p: Product; branchId: string; timezone?: string }) {
  const { t, locale } = useT();
  const s = branchState(p, branchId);
  if (!s.offered) return <Badge>{t('ops.menu.notOffered')}</Badge>;
  if (s.soldOut) return <Badge tone="danger">{s.until ? t('ops.soldOut.until', { time: time(s.until, locale, timezone) }) : t('core.menu.soldOut')}</Badge>;
  if (s.outOfStock) return <Badge tone="warn">{t('ops.menu.outOfStock')}</Badge>;
  const n = portionsOf(p, branchId);
  if (n?.source === 'recipe' && n.count <= 0) return <Badge tone="warn"><span title={t('ops.menu.portionsFromRecipe')}>{t('ops.menu.noIngredients')}</span></Badge>;
  return <Badge tone="ok">{t('core.menu.available')}</Badge>;
}

/** Portions left (legacy badge, red under 6); "—" with the reason when the dish has no recipe or stock count, or when
 * the viewer's role may not read stock (the API leaves recipe portions out). */
export function PortionsCell({ p, branchId }: { p: Product; branchId: string }) {
  const { t, locale } = useT();
  const n = portionsOf(p, branchId);
  if (n === null) {
    // No recipe and no count, or (recipePortions left out) a role that may not read stock levels.
    const why = !p.trackStock && p.recipePortions === undefined ? t('ops.menu.portionsHidden') : t('ops.menu.portionsUntracked');
    return <span className="fine" title={why}>—<span className="sr-only"> {why}</span></span>;
  }
  return (
    <Badge tone={n.count < LOW_STOCK ? 'danger' : 'ok'}>
      <span className="num" title={n.source === 'recipe' ? t('ops.menu.portionsFromRecipe') : undefined}>{formatNumber(n.count, locale)}</span>
    </Badge>
  );
}
