'use client';
import Link from 'next/link';
import { useState } from 'react';
import { PageHeader, SelectField } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { pick } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { KitchenBoard, StationPicker } from '../../../kitchen/[orgId]/_kds/KitchenBoard';

export default function KitchenPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const [branchId, setBranchId] = useState(org.branches[0]?.id ?? '');
  const [station, setStation] = useState<string | null>(null);
  const [stations, setStations] = useState<string[]>([]);
  return (
    <ModuleGate module="core" permission="kitchen:operate">
      <PageHeader title={t('core.kds.title')} subtitle={t('core.kds.subtitle')}
        actions={<Link className="btn btn-primary" href={`/kitchen/${org.id}`}>⛶ {t('core.kds.openFull')}</Link>} />
      <div className="spread" style={{ marginBottom: 14 }}>
        <StationPicker stations={stations} value={station} onChange={setStation} />
        {org.branches.length > 1 && (
          <div style={{ minWidth: 200 }}>
            <SelectField label={t('core.web.branch')} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {org.branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
            </SelectField>
          </div>
        )}
      </div>
      {branchId && <KitchenBoard orgId={org.id} branchId={branchId} station={station} onStations={setStations} />}
    </ModuleGate>
  );
}
