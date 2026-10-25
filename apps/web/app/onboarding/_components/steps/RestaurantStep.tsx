'use client';
// Step 2: the restaurant's name (English and Arabic), country and service model. Before the restaurant exists these
// are draft answers saved with the progress; afterwards the name is the restaurant's own (PATCH /o/:orgId) and the
// service model its branch's (PUT …/service-mode). The country sets the currency and cannot change after creation.
import { useState } from 'react';
import { ONBOARDING_SERVICE_TYPES } from '@resuto/contracts/lite';
import { Field, SelectField } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { StepFrame } from '../StepFrame';
import { errorText, useWizard } from '../wizard-context';

type Service = (typeof ONBOARDING_SERVICE_TYPES)[number];

export function RestaurantStep() {
  const { t } = useT();
  const w = useWizard();
  const { call } = w;
  const d = w.progress.draft;
  const branch = w.org?.branches[0];
  const [name, setName] = useState(w.org?.name ?? d.name ?? '');
  const [nameAr, setNameAr] = useState(w.org?.nameAr ?? d.nameAr ?? '');
  const [country, setCountry] = useState<'EG' | 'SA'>(w.org?.country ?? d.country ?? 'EG');
  const [service, setService] = useState<Service>(branch?.serviceMode ?? d.serviceMode ?? 'tables');
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const nameMissing = !name.trim();

  const submit = async () => {
    setTouched(true);
    if (nameMissing) return;
    setError(null);
    try {
      const draft = { ...d, name: name.trim(), nameAr: nameAr.trim() || undefined, country, serviceMode: service };
      if (w.org) {
        await call(`/o/${w.org.id}`, { method: 'PATCH', body: { name: name.trim(), nameAr: nameAr.trim() || null } });
        if (branch && branch.serviceMode !== service) await call(`/o/${w.org.id}/branches/${branch.id}/service-mode`, { method: 'PUT', body: { mode: service } });
        w.setOrg({ ...w.org, name: name.trim(), nameAr: nameAr.trim() || null, branches: w.org.branches.map((b, i) => (i === 0 ? { ...b, serviceMode: service } : b)) });
      }
      await w.finish({ draft });
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <StepFrame title={t('onb.restaurant.title')} body={t('onb.restaurant.body')} onSubmit={submit} error={error}>
      <p className="onb-free">{t('onb.freeNote')}</p>
      <Field label={t('onb.restaurant.name')} value={name} required maxLength={120} autoComplete="organization"
        onChange={(e) => setName(e.target.value)} error={touched && nameMissing ? t('onb.restaurant.nameRequired') : undefined} />
      <Field label={t('onb.restaurant.nameAr')} value={nameAr} maxLength={120} dir="rtl" lang="ar" onChange={(e) => setNameAr(e.target.value)} />
      {w.org ? (
        <p className="onb-fixed"><span>{t('onb.restaurant.country')}</span> <strong>{t(`onb.country.${country}`)}</strong></p>
      ) : (
        <SelectField label={t('onb.restaurant.country')} value={country} onChange={(e) => setCountry(e.target.value as 'EG' | 'SA')}>
          <option value="EG">{t('onb.country.EG')}</option>
          <option value="SA">{t('onb.country.SA')}</option>
        </SelectField>
      )}
      <fieldset className="onb-choices">
        <legend>{t('onb.restaurant.service')}</legend>
        {ONBOARDING_SERVICE_TYPES.map((s) => (
          <label key={s} className={`onb-choice${service === s ? ' is-on' : ''}`}>
            <input type="radio" name="service" value={s} checked={service === s} onChange={() => setService(s)} />
            <span><strong>{t(`onb.service.${s}`)}</strong><small>{t(`onb.service.${s}.hint`)}</small></span>
          </label>
        ))}
      </fieldset>
    </StepFrame>
  );
}
