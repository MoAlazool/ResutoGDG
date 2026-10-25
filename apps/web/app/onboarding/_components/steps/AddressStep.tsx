'use client';
// Step 3: the web address, checked live as it is typed (shape and reserved words at once, availability after a short
// pause), then the restaurant is created on the Free plan with its first branch and the service model chosen before.
import { useCallback, useState } from 'react';
import type { SlugAvailability } from '@resuto/contracts';
import { Field } from '@resuto/ui';
import { ApiRequestError } from '@/lib/api';
import { APP_ORIGIN } from '@/lib/app-origin';
import { useT } from '@/lib/i18n/client';
import { finalSlug, slugSubmittable, toSlug, useSlugCheck, type SlugCheckState } from '@/lib/onboarding/slug-check';
import { useSession } from '@/lib/session';
import { StepFrame } from '../StepFrame';
import { errorText, useWizard, type WizardOrg } from '../wizard-context';

const STATE_KEY: Record<Exclude<SlugCheckState, 'idle'>, string> = {
  checking: 'onb.address.checking', available: 'onb.address.available', invalid: 'onb.address.invalid',
  reserved: 'onb.address.reserved', taken: 'onb.address.taken', error: 'onb.address.error',
};

export function AddressStep() {
  const { t, tn, locale } = useT();
  const w = useWizard();
  const { call } = w;
  const session = useSession();
  const d = w.progress.draft;
  const [slug, setSlug] = useState(() => toSlug(d.slug ?? d.name ?? ''));
  const [refused, setRefused] = useState<{ slug: string; state: SlugCheckState } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback((s: string, signal: AbortSignal) =>
    call<SlugAvailability>(`/orgs/slug-availability?slug=${encodeURIComponent(s)}`, { signal }), [call]);
  const value = finalSlug(slug);
  const live = useSlugCheck(w.org ? '' : value, check);
  const state: SlugCheckState = refused && refused.slug === value ? refused.state : live;
  const origin = APP_ORIGIN.replace(/^https?:\/\//, '');

  if (w.org) {
    const url = `${origin}/m/${w.org.slug}`;
    return (
      <StepFrame title={t('onb.address.title')} onSubmit={() => w.finish()}>
        <p className="onb-done-line">{tn('onb.address.done', { url: <bdi dir="ltr">{url}</bdi> })}</p>
      </StepFrame>
    );
  }

  const submit = async () => {
    if (!slugSubmittable(state)) return;
    setError(null);
    try {
      const created = await call<{ id: string; branchId: string }>('/orgs', {
        body: {
          name: d.name ?? value, nameAr: d.nameAr || null, slug: value, country: d.country ?? 'EG', planId: 'free',
          defaultLocale: locale, branch: { name: t('onb.address.branch') },
        },
      });
      if (d.serviceMode) {
        await call(`/o/${created.id}/branches/${created.branchId}/service-mode`, { method: 'PUT', body: { mode: d.serviceMode } }).catch(() => undefined);
      }
      const org = await call<WizardOrg>(`/o/${created.id}`);
      w.setOrg(org);
      await session.refreshMe().catch(() => undefined);
      await w.finish({ orgId: created.id, draft: { ...d, slug: value } });
    } catch (e) {
      const code = e instanceof ApiRequestError ? e.code : '';
      if (code === 'slug_taken') setRefused({ slug: value, state: 'taken' });
      else if (code === 'slug_reserved') setRefused({ slug: value, state: 'reserved' });
      else setError(errorText(e));
    }
  };

  const tone = state === 'available' ? 'ok' : state === 'checking' || state === 'idle' || state === 'error' ? 'info' : 'danger';
  return (
    <StepFrame title={t('onb.address.title')} body={t('onb.address.body')} onSubmit={submit} primary={t('onb.address.create')}
      primaryDisabled={!slugSubmittable(state)} error={error}>
      <div className="onb-slug">
        <Field label={t('onb.address.label')} value={slug} required inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
          dir="ltr" maxLength={48} aria-describedby="onb-slug-state onb-slug-url" aria-invalid={tone === 'danger' || undefined}
          onChange={(e) => { setSlug(toSlug(e.target.value)); setRefused(null); }} />
        <p id="onb-slug-url" className="onb-url" dir="ltr">{origin}/m/<strong>{value || '…'}</strong></p>
        <p id="onb-slug-state" className={`onb-slug-state is-${tone}`} role="status" aria-live="polite" data-state={state}>
          {state === 'idle' ? '' : t(STATE_KEY[state])}
        </p>
      </div>
    </StepFrame>
  );
}
