'use client';
import { useEffect, useMemo, useState } from 'react';
import { REGIME_FOR_COUNTRY, hasBlockingIssues, validateTaxProfile, type TaxProfileFields, type TaxProfileView, type TaxValidationIssue } from '@resuto/contracts';
import { Badge, Card, Field, Notice, SelectField, Skeleton, useAction } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';

type AddressKey = keyof TaxProfileFields['registeredAddress'];
const SA_ADDRESS: AddressKey[] = ['street', 'buildingNumber', 'additionalNumber', 'district', 'city', 'postalCode'];
const EG_ADDRESS: AddressKey[] = ['governate', 'regionCity', 'street', 'buildingNumber', 'postalCode', 'floor', 'room', 'landmark'];
const pct = (bp: number) => String(bp / 100);
const bp = (v: string) => Math.round(Number(v || '0') * 100);

/** Tax profile with live, country-aware validation (same rules as the API: validateTaxProfile). */
export function TaxProfileForm({ onSaved }: { onSaved?: () => void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const profile = useApi<TaxProfileView>(`/o/${org.id}/compliance/tax-profile`);
  const [form, setForm] = useState<TaxProfileFields | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useAction(async (body: object) => {
    const r = await call<TaxProfileView>(`/o/${org.id}/compliance/tax-profile`, { method: 'PUT', body });
    profile.setData(r);
    setSaved(true);
    onSaved?.();
    return r;
  });
  useEffect(() => { if (profile.data) setForm({ ...profile.data, registeredAddress: { ...profile.data.registeredAddress } }); }, [profile.data]);
  const issues = useMemo(() => (form ? validateTaxProfile(form) : []), [form]);

  if (profile.loading && !profile.data) return <Skeleton lines={8} />;
  if (profile.error) return <Notice tone="danger">{profile.error.message}</Notice>;
  if (!form) return null;
  const p = profile.data!;
  const editable = can('compliance:write');
  const saudi = form.country === 'SA';
  const issueFor = (field: string): TaxValidationIssue | undefined => issues.find((i) => i.field === field);
  const errorFor = (field: string) => {
    const i = issueFor(field);
    if (!i || i.severity !== 'error') return null;
    const translated = t(`compliance.err.${i.code}`);
    return translated.startsWith('compliance.err.') ? i.message : translated;
  };
  const set = <K extends keyof TaxProfileFields>(k: K, v: TaxProfileFields[K]) => { setSaved(false); setForm({ ...form, [k]: v }); };
  const setAddr = (k: AddressKey, v: string) => { setSaved(false); setForm({ ...form, registeredAddress: { ...form.registeredAddress, [k]: v } }); };
  const blocking = hasBlockingIssues(issues);
  const warnings = issues.filter((i) => i.severity === 'warning');

  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      const { country: _c, ...body } = form;
      void save.run(body);
    }}>
      <Card title={t('compliance.profile.title')} actions={
        <>
          {p.isValidated ? <Badge tone="ok">{t('compliance.profile.validated')}</Badge> : <Badge tone="warn">{t('compliance.profile.incomplete')}</Badge>}
          {p.validatedAt && <span className="fine">{dateTime(p.validatedAt, locale)}</span>}
        </>
      }>
        <p className="fine mbs-0">{t(saudi ? 'compliance.profile.introSa' : 'compliance.profile.introEg')}</p>
        <div className="form-row">
          <SelectField label={t('compliance.profile.regime')} value={form.regime} disabled={!editable}
            onChange={(e) => set('regime', e.target.value as TaxProfileFields['regime'])} error={errorFor('regime')}>
            <option value={REGIME_FOR_COUNTRY[form.country]}>{t(`compliance.regime.${REGIME_FOR_COUNTRY[form.country]}`)}</option>
            <option value="none">{t('compliance.regime.none')}</option>
          </SelectField>
          <Field label={t('compliance.profile.vatRate')} type="number" step="0.01" min={0} max={100} value={pct(form.vatRateBp)} disabled={!editable}
            onChange={(e) => set('vatRateBp', bp(e.target.value))} hint={issueFor('vatRateBp')?.message} />
          <Field label={t('compliance.profile.serviceCharge')} type="number" step="0.01" min={0} max={30} value={pct(form.serviceChargeBp)} disabled={!editable}
            onChange={(e) => set('serviceChargeBp', bp(e.target.value))} />
        </div>
        <label className="check mbe-14">
          <input type="checkbox" checked={form.pricesIncludeTax} disabled={!editable} onChange={(e) => set('pricesIncludeTax', e.target.checked)} /> {t('compliance.profile.inclusive')}
        </label>
        {form.regime !== 'none' && (
          <>
            <div className="form-row">
              <Field label={t(saudi ? 'compliance.profile.vatNumberSa' : 'compliance.profile.vatNumberEg')} value={form.vatNumber ?? ''} disabled={!editable} dir="ltr"
                inputMode="numeric" onChange={(e) => set('vatNumber', e.target.value)} error={errorFor('vatNumber')}
                hint={t(saudi ? 'compliance.profile.vatNumberSaHint' : 'compliance.profile.vatNumberEgHint')} />
              <Field label={t('compliance.profile.registeredName')} value={form.registeredName ?? ''} disabled={!editable}
                onChange={(e) => set('registeredName', e.target.value)} error={errorFor('registeredName')} />
            </div>
            <h3>{t('compliance.profile.address')}</h3>
            <div className="form-row">
              {(saudi ? SA_ADDRESS : EG_ADDRESS).map((k) => (
                <Field key={k} label={t(`compliance.address.${k}`)} value={form.registeredAddress[k] ?? ''} disabled={!editable}
                  onChange={(e) => setAddr(k, e.target.value)} error={errorFor(`registeredAddress.${k}`)} />
              ))}
            </div>
            {form.regime === 'zatca' && (
              <>
                <h3>{t('compliance.profile.zatca')}</h3>
                <div className="form-row">
                  <SelectField label={t('compliance.profile.environment')} value={form.zatcaEnvironment ?? ''} disabled={!editable}
                    onChange={(e) => set('zatcaEnvironment', (e.target.value || null) as TaxProfileFields['zatcaEnvironment'])} error={errorFor('zatcaEnvironment')}>
                    <option value="">—</option>
                    <option value="sandbox">{t('compliance.env.sandbox')}</option>
                    <option value="simulation">{t('compliance.env.simulation')}</option>
                    <option value="production">{t('compliance.env.production')}</option>
                  </SelectField>
                  <Field label={t('compliance.profile.egsSerial')} value={form.zatcaEgsSerial ?? ''} disabled={!editable} dir="ltr" placeholder="1-Resuto|2-Web|3-0001"
                    onChange={(e) => set('zatcaEgsSerial', e.target.value)} error={errorFor('zatcaEgsSerial')} />
                </div>
                <p className="fine">{t('compliance.profile.csid', { status: t(`compliance.csid.${p.zatcaCsidStatus}`) })}</p>
              </>
            )}
            {form.regime === 'eta' && (
              <>
                <h3>{t('compliance.profile.eta')}</h3>
                <div className="form-row">
                  <SelectField label={t('compliance.profile.environment')} value={form.etaEnvironment ?? ''} disabled={!editable}
                    onChange={(e) => set('etaEnvironment', (e.target.value || null) as TaxProfileFields['etaEnvironment'])} error={errorFor('etaEnvironment')}>
                    <option value="">—</option>
                    <option value="preprod">{t('compliance.env.preprod')}</option>
                    <option value="production">{t('compliance.env.production')}</option>
                  </SelectField>
                  <Field label={t('compliance.profile.activityCode')} value={form.etaActivityCode ?? ''} disabled={!editable} dir="ltr" placeholder="5610"
                    onChange={(e) => set('etaActivityCode', e.target.value)} error={errorFor('etaActivityCode')} />
                  <Field label={t('compliance.profile.branchCode')} value={form.etaBranchCode ?? ''} disabled={!editable} dir="ltr" placeholder="0"
                    onChange={(e) => set('etaBranchCode', e.target.value)} error={errorFor('etaBranchCode')} />
                  <Field label={t('compliance.profile.posSerial')} value={form.etaPosSerial ?? ''} disabled={!editable} dir="ltr"
                    onChange={(e) => set('etaPosSerial', e.target.value)} error={errorFor('etaPosSerial')} />
                </div>
              </>
            )}
          </>
        )}
        {warnings.map((w) => <Notice key={w.code} tone="warn">{w.message}</Notice>)}
        <Notice>{t('compliance.profile.honesty')}</Notice>
        {save.error && <Notice tone="danger">{save.error}</Notice>}
        {saved && !save.error && <Notice tone="ok">{t('state.saved')}</Notice>}
        {editable && (
          <div className="row mbs-14">
            <button className="btn btn-primary" disabled={save.pending}>{save.pending ? t('state.loading') : t('action.save')}</button>
            <span className="fine">{blocking ? t('compliance.profile.saveIncomplete') : t('compliance.profile.saveReady')}</span>
          </div>
        )}
      </Card>
    </form>
  );
}
