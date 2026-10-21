'use client';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeading } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { kitchenDisplayPath } from '@/lib/home-path';
import { useOrg } from '@/lib/org-context';
import { KitchenBoard, StationPicker } from '../../../kitchen/[orgId]/_kds/KitchenBoard';

/** Kitchen display inside the workspace (legacy "Kitchen display" tab); the branch is the one chosen in the shell. */
export default function KitchenPage() {
  const { t } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const branchId = shellBranch ?? org.branches[0]?.id ?? '';
  const [station, setStation] = useState<string | null>(null);
  const [stations, setStations] = useState<string[]>([]);
  return (
    <ModuleGate module="core" permission="kitchen:operate">
      <PageHeading title={t('core.kds.title')} subtitle={t('core.kds.subtitle')}
        actions={<Link className="btn btn-primary" href={kitchenDisplayPath(org.role, org.id, { full: true })}>⛶ {t('core.kds.openFull')}</Link>} />
      <div className="kds-toolbar"><StationPicker stations={stations} value={station} onChange={setStation} /></div>
      {branchId && (
        <KitchenBoard orgId={org.id} branchId={branchId} station={station} onStations={setStations} timezone={org.timezone} currency={org.currency}
          canCancel={can('orders:cancel')} can86={can('menu:availability')} canResolve={can('orders:read') && (can('floor:seat') || can('orders:status'))}
          ordersHref={can('payments:collect') ? `/dashboard/${org.id}/orders` : null} />
      )}
    </ModuleGate>
  );
}
