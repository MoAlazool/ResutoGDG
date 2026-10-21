'use client';
// ZATCA Phase-2 onboarding (INT-26): EGS key + CSR → compliance CSID (OTP from FATOORA) → compliance checks →
// production CSID. Implementation incomplete — not certified: the card says so on every state.
import { useState } from 'react';
import { Badge, Card, Field, Notice, SelectField, Skeleton, useAction } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

interface Egs {
  id: string; environment: string; status: string; commonName: string; egsSerial: string; invoiceType: string; csrPem: string;
  complianceChecks: Array<{ kind: string; outcome: string; errors?: string[]; error?: string }>; hasComplianceCsid: boolean; hasProductionCsid: boolean;
  lastError: string | null; updatedAt: string;
}
const tone = (s: string) => (({ active: 'ok', compliance_checked: 'info', compliance_csid: 'info', key_generated: 'neutral', error: 'danger' } as const)[s] ?? 'neutral');

export function ZatcaOnboarding() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const list = useApi<{ items: Egs[] }>(`/o/${org.id}/compliance/zatca/egs`);
  const [form, setForm] = useState({ environment: 'sandbox', commonName: '', organizationUnit: '', egsSerial: '1-Resuto|2-2.0|3-', invoiceType: '0100', location: '', industry: '' });
  const [otp, setOtp] = useState('');
  const editable = can('compliance:write');
  const run = useAction(async (path: string, body?: unknown) => {
    await session.call(`/o/${org.id}/compliance/zatca/egs${path}`, { method: 'POST', body: body ?? {} });
    setOtp('');
    await list.reload();
  });
  if (org.country !== 'SA') return null;
  if (list.error) return <Notice tone="danger">{list.error.message}</Notice>;
  if (!list.data) return <Skeleton lines={3} />;
  const unit = list.data.items.find((u) => u.status !== 'retired');
  return (
    <Card title={t('compliance.zatca.title')}>
      <div className="stack" data-testid="zatca-onboarding">
        <Notice tone="warn">{t('compliance.zatca.incomplete')}</Notice>
        {!unit ? (
          editable && (
            <form className="stack" onSubmit={(e) => { e.preventDefault(); void run.run('', form); }}>
              <SelectField label={t('compliance.zatca.environment')} value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
                {['sandbox', 'simulation', 'production'].map((v) => <option key={v} value={v}>{t(`compliance.zatca.env.${v}`)}</option>)}
              </SelectField>
              <Field label={t('compliance.zatca.commonName')} value={form.commonName} onChange={(e) => setForm({ ...form, commonName: e.target.value })} required />
              <Field label={t('compliance.zatca.branch')} value={form.organizationUnit} onChange={(e) => setForm({ ...form, organizationUnit: e.target.value })} required />
              <Field label={t('compliance.zatca.serial')} dir="ltr" value={form.egsSerial} onChange={(e) => setForm({ ...form, egsSerial: e.target.value })} hint={t('compliance.zatca.serialHint')} required />
              <SelectField label={t('compliance.zatca.invoiceType')} value={form.invoiceType} onChange={(e) => setForm({ ...form, invoiceType: e.target.value })}>
                {['0100', '1100', '1000'].map((v) => <option key={v} value={v}>{t(`compliance.zatca.type.${v}`)}</option>)}
              </SelectField>
              <Field label={t('compliance.zatca.location')} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} hint={t('compliance.zatca.locationHint')} required />
              <Field label={t('compliance.zatca.industry')} value={form.industry} onChange={(e) => setForm({ ...form, industry: e.target.value })} required />
              <button className="btn btn-primary" disabled={run.pending}>{t('compliance.zatca.create')}</button>
            </form>
          )
        ) : (
          <>
            <div className="spread">
              <span><bdi dir="ltr">{unit.commonName}</bdi> · {t(`compliance.zatca.env.${unit.environment}`)}</span>
              <Badge tone={tone(unit.status)}>{t(`compliance.zatca.status.${unit.status}`)}</Badge>
            </div>
            <p className="fine">{t('compliance.zatca.updated', { at: dateTime(unit.updatedAt, locale) })}</p>
            {unit.lastError && <Notice tone="danger"><bdi dir="ltr">{unit.lastError}</bdi></Notice>}
            {unit.complianceChecks.length > 0 && (
              <ul className="fine">
                {unit.complianceChecks.map((c) => <li key={c.kind}>{t(`compliance.zatca.check.${c.kind}`)}: <bdi dir="ltr">{c.outcome}{c.errors?.length ? ` — ${c.errors.join('; ')}` : c.error ? ` — ${c.error}` : ''}</bdi></li>)}
              </ul>
            )}
            {editable && unit.status === 'key_generated' && (
              <form className="row" style={{ gap: 8, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void run.run(`/${unit.id}/compliance-csid`, { otp }); }}>
                <Field label={t('compliance.zatca.otp')} dir="ltr" inputMode="numeric" pattern="\d{6}" value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} hint={t('compliance.zatca.otpHint')} />
                <button className="btn btn-primary" disabled={run.pending || otp.length !== 6}>{t('compliance.zatca.requestCsid')}</button>
              </form>
            )}
            {editable && (unit.status === 'compliance_csid' || unit.status === 'compliance_checked') && (
              <div className="row" style={{ gap: 8 }}>
                <button className="btn" disabled={run.pending} onClick={() => void run.run(`/${unit.id}/compliance-checks`)}>{t('compliance.zatca.runChecks')}</button>
                {unit.status === 'compliance_checked' && <button className="btn btn-primary" disabled={run.pending} onClick={() => void run.run(`/${unit.id}/production-csid`)}>{t('compliance.zatca.production')}</button>}
              </div>
            )}
            {unit.status === 'active' && <Notice tone="ok">{t('compliance.zatca.active')}</Notice>}
          </>
        )}
        {run.error && <Notice tone="danger">{run.error}</Notice>}
      </div>
    </Card>
  );
}
