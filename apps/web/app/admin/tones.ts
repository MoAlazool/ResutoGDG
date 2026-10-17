import type { Tone } from '@resuto/ui';

export const ORG_TONE: Record<string, Tone> = { active: 'ok', onboarding: 'info', suspended: 'danger', closed: 'neutral' };
export const SUB_TONE: Record<string, Tone> = { active: 'ok', trialing: 'info', past_due: 'warn', unpaid: 'danger', canceled: 'neutral' };
