'use client';
import type { FormEvent, ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import { useWizard } from './wizard-context';

/**
 * One wizard step: its heading (focused when the step opens), body, and the actions row. The primary action is a
 * submit button, so Enter in a field continues; Back appears from the second step on.
 */
export function StepFrame({ title, body, children, onSubmit, primary, primaryDisabled, secondary, error }: {
  title: string; body?: ReactNode; children?: ReactNode;
  onSubmit(): Promise<void> | void;
  primary?: string; primaryDisabled?: boolean; secondary?: ReactNode; error?: string | null;
}) {
  const { t } = useT();
  const w = useWizard();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (w.busy || primaryDisabled) return;
    // A failed progress save is shown by the wizard (and the step stays open); nothing else to do here.
    try { await onSubmit(); } catch { /* shown by the wizard */ }
  };
  return (
    <form className="onb-form" onSubmit={submit} noValidate>
      <div className="onb-head">
        <h1 id="onb-step-title" tabIndex={-1}>{title}</h1>
        {body && <p className="onb-body">{body}</p>}
      </div>
      {children}
      {error && <p className="onb-error" role="alert">{error}</p>}
      <div className="onb-actions">
        {w.step !== 'restaurant' && (
          <button type="button" className="btn onb-btn" onClick={() => void w.back().catch(() => undefined)} disabled={w.busy}>{t('onb.back')}</button>
        )}
        {secondary}
        <button type="submit" className="btn btn-primary onb-btn onb-primary" disabled={w.busy || primaryDisabled}>
          {primary ?? t('onb.continue')}
        </button>
      </div>
    </form>
  );
}
