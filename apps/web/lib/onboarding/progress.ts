// Wizard progress (21-ONB): what the onboarding wizard saves after every step (PUT /v1/onboarding/progress) and how
// it decides where to resume. The server keeps the finished steps (they only grow) and refuses restaurant steps
// without a restaurant; these helpers build the requests and mirror those rules for the screen.
import {
  mergeCompleted, nextStep, ONBOARDING_STEPS, resumeStep, stepIndex,
  type OnboardingDraft, type OnboardingProgress, type OnboardingStep,
} from '@resuto/contracts/lite';

export interface ProgressSave {
  step: OnboardingStep;
  completed: OnboardingStep[];
  orgId?: string | null;
  draft?: OnboardingDraft;
  done?: boolean;
  restart?: boolean;
}

/** The save after finishing `step`: it is marked finished and the wizard moves on (the last step finishes the wizard). */
export function finishStep(step: OnboardingStep, extra: { orgId?: string | null; draft?: OnboardingDraft } = {}): ProgressSave {
  const last = step === 'qr';
  return { step: nextStep(step), completed: [step], ...extra, ...(last ? { done: true } : {}) };
}

/** The save when the owner moves to another step without finishing the current one (back, or a finished step). */
export const moveTo = (step: OnboardingStep): ProgressSave => ({ step, completed: [] });

/** What the screen shows right after a save, before the server answers (the same rules the server applies). */
export function applySave(p: OnboardingProgress, save: ProgressSave): OnboardingProgress {
  const orgId = save.orgId !== undefined ? save.orgId : p.orgId;
  const completed = save.restart ? mergeCompleted(['account'], save.completed) : mergeCompleted(p.completed, save.completed);
  return {
    ...p, step: save.step, completed, orgId, draft: save.draft ?? (save.restart ? {} : p.draft),
    completedAt: save.done ? p.completedAt ?? new Date().toISOString() : save.restart ? null : p.completedAt,
  };
}

/** The steps shown in the progress list: all nine (the account step, the signup, is always finished). */
export const WIZARD_STEPS: readonly OnboardingStep[] = ONBOARDING_STEPS;

/** 1-based position among the nine steps. */
export const stepNumber = (s: OnboardingStep) => WIZARD_STEPS.indexOf(s) + 1;

/** A step the owner may jump to from the progress list: a finished one, or the next open one. */
export function canOpen(p: Pick<OnboardingProgress, 'step' | 'completed' | 'orgId'>, s: OnboardingStep): boolean {
  if (s === 'account') return false;
  if (p.completed.includes(s)) return !!p.orgId || stepIndex(s) <= stepIndex('address');
  return s === resumeStep({ ...p, step: s });
}

export { resumeStep };
