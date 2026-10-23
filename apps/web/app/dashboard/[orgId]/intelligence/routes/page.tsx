'use client';
import { useEffect, useState } from 'react';
import type { RoutePlanResponse } from '@resuto/contracts';
import { Badge, Card, Notice, SelectField, Skeleton, Stat, useAction, OrderRef } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { time } from '@/lib/format';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { RouteMap } from '../_components/charts';
import { ApiErrorNotice, BranchSelect, Empty, IntelShell, fmtNum, useBranch } from '../_components/IntelShell';

interface Driver { id: string; displayName: string; availability: string; openJobs: number }

export default function RoutesPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const { branchId, setBranchId } = useBranch();
  const drivers = useApi<{ items: Driver[] }>(branchId ? `/o/${org.id}/intelligence/routes/drivers?branchId=${branchId}` : null);
  const [driverId, setDriverId] = useState('');
  const [objective, setObjective] = useState<'distance' | 'lateness'>('distance');
  const [plan, setPlan] = useState<RoutePlanResponse | null>(null);
  useEffect(() => { setDriverId(drivers.data?.items[0]?.id ?? ''); setPlan(null); }, [drivers.data]);
  const run = useAction(async () => {
    setPlan(await call<RoutePlanResponse>(`/o/${org.id}/intelligence/routes/plan`, { body: { branchId, driverId, objective } }));
  });

  return (
    <IntelShell>
      <ModuleGate module="driver" permission="delivery:dispatch">
        <div className="form-row" style={{ maxWidth: 820, alignItems: 'end' }}>
          <BranchSelect value={branchId} onChange={setBranchId} />
          <SelectField label={t('intelligence.routes.driver')} value={driverId} onChange={(e) => setDriverId(e.target.value)} disabled={!drivers.data?.items.length}>
            {(drivers.data?.items ?? []).map((d) => <option key={d.id} value={d.id}>{d.displayName} ({d.openJobs})</option>)}
          </SelectField>
          <SelectField label={t('intelligence.routes.optimised')} value={objective} onChange={(e) => setObjective(e.target.value as 'distance' | 'lateness')}>
            <option value="distance">{t('intelligence.routes.objective.distance')}</option>
            <option value="lateness">{t('intelligence.routes.objective.lateness')}</option>
          </SelectField>
          <div className="field"><button type="button" className="btn btn-primary" disabled={!driverId || run.pending} onClick={() => run.run()}>
            {run.pending ? t('state.loading') : t('intelligence.routes.plan')}</button></div>
        </div>
        {drivers.loading && !drivers.data ? <div className="card"><Skeleton lines={3} /></div>
          : drivers.error ? <ApiErrorNotice error={drivers.error} onRetry={drivers.reload} />
            : !drivers.data?.items.length ? <Empty title={t('intelligence.routes.noDrivers')} /> : null}
        {run.error && <Notice tone="danger">{run.error}</Notice>}
        {plan && (
          <div className="stack mbs-8">
            <div className="grid grid-4">
              <Stat label={t('intelligence.routes.distance')} value={`${fmtNum(plan.distanceKm, locale)} km`}
                hint={`${fmtNum(plan.distanceSavingPct, locale)}% ${t('intelligence.routes.saving')}`} tone={plan.distanceSavingPct > 0 ? 'ok' : undefined} />
              <Stat label={t('intelligence.routes.duration')} value={`${fmtNum(plan.durationMinutes, locale, 0)} min`} hint={`${t('intelligence.routes.naive')}: ${fmtNum(plan.naive.durationMinutes, locale, 0)} min`} />
              <Stat label={t('intelligence.routes.late')} value={plan.violations.length} hint={`${t('intelligence.routes.naive')}: ${plan.naive.violations}`} tone={plan.violations.length ? 'warn' : 'ok'} />
              <Stat label={t('intelligence.routes.naive')} value={`${fmtNum(plan.naive.distanceKm, locale)} km`} hint={t('intelligence.routes.computed', { ms: fmtNum(plan.computationMs, locale, 1) })} />
            </div>
            <div className="grid grid-2">
              <div className="min-w-0"><Card title={t('intelligence.routes.optimised')}>
                <RouteMap start={plan.start} stops={plan.stops} label={`${t('intelligence.routes.optimised')}: ${plan.stops.length} stops, ${fmtNum(plan.distanceKm, locale)} km`}
                  naiveLabel={t('intelligence.routes.naive')} plannedLabel={t('intelligence.routes.optimised')} startLabel={t('intelligence.routes.start')} />
                <p className="fine">{t('intelligence.routes.model', { factor: plan.distanceModel.roadFactor, speed: plan.distanceModel.speedKmh })}</p>
                {plan.skipped.length > 0 && <Notice tone="warn">{t('intelligence.routes.skipped', { n: plan.skipped.length })}</Notice>}
              </Card></div>
              <div className="min-w-0"><Card title={`#`}>
                <ol style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 10 }}>
                  {plan.stops.map((s) => (
                    <li key={s.jobId}>
                      <strong><OrderRef n={s.orderNumber} /></strong> <span dir="auto">{s.address ?? ''}</span>{' '}
                      <span className="fine">{time(s.arrivesAt, locale, org.timezone)} / {time(s.promisedAt, locale, org.timezone)}</span>{' '}
                      {s.lateMinutes > 0 && <Badge tone="danger">+{fmtNum(s.lateMinutes, locale, 0)} min</Badge>}
                    </li>
                  ))}
                </ol>
              </Card></div>
            </div>
          </div>
        )}
      </ModuleGate>
    </IntelShell>
  );
}
