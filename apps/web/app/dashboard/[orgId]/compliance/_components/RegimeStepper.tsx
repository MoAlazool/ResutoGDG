'use client';
import Link from 'next/link';
import { Badge, Card, type Tone } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import styles from '../compliance.module.css';
import { currentStep, doneCount, etaSteps, zatcaSteps, type ComplianceFacts, type StepState, type StepTarget } from './steps';

const TONE: Record<StepState, Tone> = { done: 'ok', in_progress: 'info', todo: 'neutral', error: 'danger', outside: 'sandbox', not_certified: 'warn', unknown: 'neutral' };

/**
 * The set-up stepper of the restaurant's tax regime (21-MONEY): each step with its state chip derived from recorded
 * data (steps.ts), the next step marked, and a way to the screen where it is done. The last step is certification,
 * shown as "Not certified" with the reason: nothing on this card claims Resuto is certified.
 */
export function RegimeStepper({ regime, facts, go }: { regime: 'zatca' | 'eta'; facts: ComplianceFacts; go(tab: Exclude<StepTarget, 'integrations' | null>): void }) {
  const { t } = useT();
  const { org, can } = useOrg();
  const steps = regime === 'zatca' ? zatcaSteps(facts) : etaSteps(facts);
  const current = currentStep(steps);
  const countable = steps.filter((s) => s.state !== 'outside' && s.state !== 'not_certified').length;
  return (
    <Card title={t(`compliance.steps.title.${regime}`)} actions={<span className="fine num">{t('compliance.steps.progress', { done: doneCount(steps), total: countable })}</span>}>
      <p className="fine mbs-0">{t(`compliance.steps.body.${regime}`)}</p>
      <ol className={styles.stepper} data-testid={`stepper-${regime}`}>
        {steps.map((s, i) => (
          <li key={s.key} className={styles.step} data-state={s.state} data-step={s.key} aria-current={s.key === current ? 'step' : undefined}>
            <span className={`num ${styles.marker}`} aria-hidden="true">{s.state === 'done' ? '✓' : i + 1}</span>
            <div className={styles.stepBody}>
              <div className={styles.stepHead}>
                <strong>{t(`compliance.step.${regime}.${s.key}`)}</strong>
                <Badge tone={TONE[s.state]}>{t(`compliance.step.state.${s.state}`)}</Badge>
                {s.key === current && <span className="fine">{t('compliance.step.current')}</span>}
              </div>
              <p className="fine m-0">{t(`compliance.step.${regime}.${s.key}.body`)}</p>
              {s.count && regime === 'zatca' && <p className="fine m-0 num">{t('compliance.steps.branches', { done: s.count.done, total: s.count.total })}</p>}
              {s.key === current && s.target && (
                s.target === 'integrations' && !can('integrations:manage') ? null : s.target === 'integrations'
                  ? <Link className="btn btn-sm" href={`/dashboard/${org.id}/integrations`}>{t('compliance.step.open.integrations')}</Link>
                  : <button type="button" className="btn btn-sm" onClick={() => go(s.target as 'profile' | 'documents')}>{t(`compliance.step.open.${s.target}`)}</button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}
