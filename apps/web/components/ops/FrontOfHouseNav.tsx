'use client';
import { SectionNav } from '@/components/shell/SectionNav';
import { useT } from '@/lib/i18n/client';
import { navVisible } from '@/lib/nav';
import { useOrg } from '@/lib/org-context';
import { FRONT_OF_HOUSE_SECTIONS } from '@/lib/sections';

/**
 * Tabs across the floor, the front desk and reservations (21-OPS "area tabs"): one front-of-house area. Reservations
 * is left out when the shell's branch takes none (as in the sidebar); nothing is shown when one screen remains.
 */
export function FrontOfHouseNav() {
  const { t } = useT();
  const { org } = useOrg();
  const branch = org.branches[0];
  const sections = FRONT_OF_HOUSE_SECTIONS.filter((s) => s.href !== '/reservations' || branch?.acceptsReservations !== false);
  if (sections.filter((s) => navVisible(s, org.role)).length < 2) return null;
  return <SectionNav sections={sections} label={t('ops.foh.nav')} />;
}
