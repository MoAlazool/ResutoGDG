'use client';
import { useState } from 'react';
import { Badge, Card, Notice, PageHeader, Skeleton, Stat, Tabs } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import styles from './compliance.module.css';
import { FiscalDocuments } from './_components/FiscalDocuments';
import { ExpiryBadge, Licences } from './_components/Licences';
import { RegimeStepper } from './_components/RegimeStepper';
import type { EgsUnitLite } from './_components/steps';
import { TaxProfileForm } from './_components/TaxProfileForm';
import { ZatcaOnboarding } from './_components/ZatcaOnboarding';

type Tab = 'overview' | 'profile' | 'documents' | 'licences';

interface Summary {
  taxProfile: { country: string; regime: string; isValidated: boolean; errorCount: number; zatcaCsidStatus: string; environment: string | null };
  fiscal: { issued30d: number; creditNotes30d: number; errors: number; lastIssuedAt: string | null; paidOrdersWithoutDocument30d: number; submissionMode: string };
  licences: { today: string; total: number; counts: Record<string, number>; attention: Array<{ id: string; title: string; kind: string; expiresOn: string; daysToExpiry: number; status: 'expired' | 'expiring' }> };
}
interface Provider { id: string; name: string; readiness: string; countries: string[]; activation: string[] }

function Overview({ go }: { go(tab: Tab): void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const summary = useApi<Summary>(`/o/${org.id}/compliance/summary`);
  const providers = useApi<{ tax: Provider[]; licensing: Provider[] }>(`/o/${org.id}/compliance/integrations`);
  const regime = summary.data?.taxProfile.regime;
  // The stepper's facts: ZATCA EGS units, or the ETA point-of-sale connection (only roles that manage integrations can read it).
  const egs = useApi<{ items: EgsUnitLite[] }>(regime === 'zatca' ? `/o/${org.id}/compliance/zatca/egs` : null);
  const conns = useApi<{ items: Array<{ provider: string; status: string; environment: string }> }>(regime === 'eta' && can('integrations:manage') ? `/o/${org.id}/integrations/connections` : null);
  if (summary.loading && !summary.data) return <Skeleton lines={6} />;
  if (summary.error) return <Notice tone="danger">{summary.error.message}</Notice>;
  const s = summary.data!;
  const relevant = [...(providers.data?.tax ?? []), ...(providers.data?.licensing ?? [])].filter((p) => p.countries.includes(org.country));
  const eta = conns.data?.items.find((c) => c.provider === 'eta_ereceipt');
  const facts = {
    profileValidated: s.taxProfile.isValidated, branches: org.branches.filter((b) => b.isActive).length,
    units: egs.data ? egs.data.items : null, etaConnection: !can('integrations:manage') || conns.error ? undefined : conns.data ? eta ?? null : undefined,
    issued30d: s.fiscal.issued30d, submissionMode: s.fiscal.submissionMode,
  };
  return (
    <div className="stack">
      {!s.taxProfile.isValidated && s.taxProfile.regime !== 'none' && (
        <Notice tone="warn">{t('compliance.overview.profileIncomplete', { n: s.taxProfile.errorCount })} <button className="btn btn-sm" onClick={() => go('profile')}>{t('compliance.overview.complete')}</button></Notice>
      )}
      {s.fiscal.paidOrdersWithoutDocument30d > 0 && s.taxProfile.regime !== 'none' && (
        <Notice tone="warn">{t('compliance.overview.missingDocs', { n: s.fiscal.paidOrdersWithoutDocument30d })}</Notice>
      )}
      <div className="grid grid-4">
        <Stat label={t('compliance.overview.profile')} value={s.taxProfile.isValidated ? '✓' : '!'} hint={t(`compliance.regime.${s.taxProfile.regime}`)} tone={s.taxProfile.isValidated ? 'ok' : 'warn'} />
        <Stat label={t('compliance.overview.issued30d')} value={s.fiscal.issued30d} hint={s.fiscal.lastIssuedAt ? dateTime(s.fiscal.lastIssuedAt, locale) : undefined} />
        <Stat label={t('compliance.overview.creditNotes30d')} value={s.fiscal.creditNotes30d} />
        <Stat label={t('compliance.overview.licencesAttention')} value={(s.licences.counts.expired ?? 0) + (s.licences.counts.expiring ?? 0)}
          hint={t('compliance.overview.licenceCounts', { expired: s.licences.counts.expired ?? 0, expiring: s.licences.counts.expiring ?? 0 })}
          tone={s.licences.counts.expired ? 'danger' : s.licences.counts.expiring ? 'warn' : undefined} />
      </div>
      {s.taxProfile.regime === 'zatca' || s.taxProfile.regime === 'eta'
        ? <RegimeStepper regime={s.taxProfile.regime} facts={facts} go={go} />
        : <Notice>{t('compliance.steps.none')}</Notice>}
      <div className={styles.pair}>
        <Card title={t('compliance.overview.expiring')} actions={<button className="btn btn-sm" onClick={() => go('licences')}>{t('compliance.overview.manage')}</button>}>
          {s.licences.attention.length ? (
            <div className="stack gap-8">
              {s.licences.attention.map((a) => (
                <div key={a.id} className="spread"><span><strong>{a.title}</strong> <span className="fine">{t(`compliance.lic.kind.${a.kind}`)}</span></span><ExpiryBadge status={a.status} days={a.daysToExpiry} /></div>
              ))}
            </div>
          ) : <p className="muted m-0">{s.licences.total ? t('compliance.overview.allValid') : t('compliance.lic.emptyHint')}</p>}
        </Card>
        <Card title={t('compliance.overview.integrations')}>
          <div className="stack gap-10" data-testid="compliance-readiness">
            {relevant.map((p) => (
              <div key={p.id}>
                <div className={styles.readinessRow}><strong>{p.name}</strong><Badge tone="sandbox">{t(`compliance.readiness.${p.readiness}`)}</Badge></div>
                <div className="fine">{p.activation[0]}</div>
              </div>
            ))}
            <Notice>{t('compliance.overview.honesty')}</Notice>
            {s.taxProfile.regime === 'zatca' && <div className="fine">{t('compliance.profile.csid', { status: t(`compliance.csid.${s.taxProfile.zatcaCsidStatus}`) })}</div>}
            <div><Badge tone="info">{t(`compliance.mode.${s.fiscal.submissionMode}`)}</Badge></div>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** Resuto Compliance: tax profile, fiscal documents (ZATCA / ETA structures) and licences. */
export default function CompliancePage() {
  const { t } = useT();
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <ModuleGate module="compliance" permission="compliance:read">
      <PageHeader title={t('compliance.title')} subtitle={t('compliance.subtitle')} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { key: 'overview', label: t('compliance.tab.overview') },
        { key: 'profile', label: t('compliance.tab.profile') },
        { key: 'documents', label: t('compliance.tab.documents') },
        { key: 'licences', label: t('compliance.tab.licences') },
      ]} />
      {tab === 'overview' && <Overview go={setTab} />}
      {tab === 'profile' && <><TaxProfileForm /><ZatcaOnboarding /></>}
      {tab === 'documents' && <FiscalDocuments />}
      {tab === 'licences' && <Licences />}
    </ModuleGate>
  );
}
