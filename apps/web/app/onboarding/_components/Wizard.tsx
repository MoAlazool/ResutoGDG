'use client';
// The Free QR-menu onboarding wizard (21-ONB increment 2, plan §6.2): nine steps from the signup to a printed menu QR,
// saved on the server after every step (GET/PUT /v1/onboarding/progress), so it resumes on any device. The restaurant
// is created on the Free plan at the address step; nothing here offers ordering, payments or other paid features
// (they appear only in "Explore Resuto" from the last step). Steps after the first two load on demand.
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { previousStep, type OnboardingDraft, type OnboardingProgress, type OnboardingStep } from '@resuto/contracts/lite';
import { Notice, Wordmark } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { applySave, canOpen, finishStep, moveTo, resumeStep, stepNumber, WIZARD_STEPS, type ProgressSave } from '@/lib/onboarding/progress';
import { useSession } from '@/lib/session';
import { AddressStep } from './steps/AddressStep';
import { RestaurantStep } from './steps/RestaurantStep';
import { WizardContext, errorText, type WizardOrg, type WizardValue } from './wizard-context';
import '../onboarding.css';

const loading = () => <div className="onb-step-loading" aria-hidden="true" />;
const BrandStep = dynamic(() => import('./steps/BrandStep').then((m) => m.BrandStep), { loading });
const MenuStep = dynamic(() => import('./steps/MenuStep').then((m) => m.MenuStep), { loading });
const DetailsStep = dynamic(() => import('./steps/DetailsStep').then((m) => m.DetailsStep), { loading });
const SocialStep = dynamic(() => import('./steps/SocialStep').then((m) => m.SocialStep), { loading });
const PublishStep = dynamic(() => import('./steps/PublishStep').then((m) => m.PublishStep), { loading });
const QrStep = dynamic(() => import('./steps/QrStep').then((m) => m.QrStep), { loading });

const STEP_VIEW: Record<Exclude<OnboardingStep, 'account'>, () => ReactNode> = {
  restaurant: () => <RestaurantStep />, address: () => <AddressStep />, brand: () => <BrandStep />, menu: () => <MenuStep />,
  details: () => <DetailsStep />, social: () => <SocialStep />, publish: () => <PublishStep />, qr: () => <QrStep />,
};

export function Wizard() {
  const { t } = useT();
  const session = useSession();
  const router = useRouter();
  const [progress, setProgress] = useState<OnboardingProgress | null>(null);
  const [org, setOrg] = useState<WizardOrg | null>(null);
  const [step, setStep] = useState<OnboardingStep>('restaurant');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const heading = useRef<HTMLDivElement>(null);
  const { call } = session;

  useEffect(() => {
    if (session.ready && !session.token) router.replace(`/signup?next=${encodeURIComponent('/onboarding')}`);
  }, [session.ready, session.token, router]);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const p = await call<OnboardingProgress>('/onboarding/progress');
      const o = p.orgId ? await call<WizardOrg>(`/o/${p.orgId}`) : null;
      setOrg(o);
      setProgress(p);
      setStep(resumeStep(p));
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [call]);
  useEffect(() => { if (session.ready && session.token) void load(); }, [session.ready, session.token, load]);

  // Each new step moves the focus to its heading (keyboard and screen reader users start there).
  useEffect(() => { heading.current?.querySelector<HTMLElement>('h1')?.focus(); }, [step]);

  const save = useCallback(async (body: ProgressSave, current: OnboardingProgress) => {
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    try {
      const next = await call<OnboardingProgress>('/onboarding/progress', { method: 'PUT', body });
      setProgress(next);
      setSaved(true);
      return next;
    } catch (e) {
      setSaveError(errorText(e));
      setProgress(current);
      throw e;
    } finally {
      setBusy(false);
    }
  }, [call]);

  const value = useMemo<WizardValue | null>(() => {
    if (!progress) return null;
    return {
      progress, org, setOrg, busy, step, call: call as WizardValue['call'],
      async back() {
        const target = previousStep(step);
        if (target === step) return;
        await save(moveTo(target), progress);
        setStep(target);
      },
      async finish(extra) {
        const body = finishStep(step, extra);
        const next = await save(body, progress);
        setStep(resumeStep({ ...next, step: body.step }));
      },
      async saveDraft(draft: OnboardingDraft) {
        await save({ step, completed: [], draft }, progress);
      },
      async open(target) {
        if (!canOpen(progress, target)) return;
        await save(moveTo(target), progress);
        setStep(target);
      },
      async restart() {
        const body: ProgressSave = { step: 'restaurant', completed: [], orgId: null, restart: true };
        setProgress(applySave(progress, body));
        setOrg(null);
        await save(body, progress);
        setStep('restaurant');
      },
    };
  }, [progress, org, busy, call, step, save]);

  if (session.ready && !session.token) return null;
  const n = stepNumber(step);
  return (
    <main className="onb" aria-busy={!progress || busy || undefined}>
      <header className="onb-top">
        <Wordmark />
        <span className="onb-eyebrow">{t('onb.eyebrow')}</span>
        <LanguageToggle className="onb-lang" />
      </header>
      <div className="onb-shell">
        <nav className="onb-steps" aria-label={t('onb.steps')}>
          <p className="onb-count" aria-live="polite">{t('onb.progress', { n, total: WIZARD_STEPS.length })}</p>
          <div className="onb-bar" aria-hidden="true"><span style={{ inlineSize: `${(n / WIZARD_STEPS.length) * 100}%` }} /></div>
          <ol>
            {WIZARD_STEPS.map((s) => {
              const done = s === 'account' || !!progress?.completed.includes(s);
              const openable = !!progress && s !== step && canOpen(progress, s);
              return (
                <li key={s} className={`${s === step ? 'is-current' : ''}${done ? ' is-done' : ''}`}>
                  {openable
                    ? <button type="button" onClick={() => void value?.open(s).catch(() => undefined)} disabled={busy}><StepMark n={stepNumber(s)} done={done} />{t(`onb.step.${s}`)}</button>
                    : <span aria-current={s === step ? 'step' : undefined}><StepMark n={stepNumber(s)} done={done} />{t(`onb.step.${s}`)}</span>}
                </li>
              );
            })}
          </ol>
        </nav>
        <section className="onb-card" ref={heading} aria-labelledby="onb-step-title">
          {loadError && (
            <Notice tone="danger">{t('onb.loadError')} {loadError} <button type="button" className="btn btn-sm" onClick={() => void load()}>{t('onb.retry')}</button></Notice>
          )}
          {!value ? (!loadError && <div className="onb-step-loading" aria-hidden="true" />) : (
            <WizardContext.Provider value={value}>
              {STEP_VIEW[step === 'account' ? 'restaurant' : step]()}
            </WizardContext.Provider>
          )}
          {saveError && <Notice tone="danger">{saveError}</Notice>}
          <p className="onb-saved" role="status">{busy ? t('onb.saving') : saved ? t('onb.saved') : ''}</p>
        </section>
      </div>
    </main>
  );
}

function StepMark({ n, done }: { n: number; done: boolean }) {
  return <span className="onb-mark" aria-hidden="true">{done ? '✓' : n}</span>;
}
