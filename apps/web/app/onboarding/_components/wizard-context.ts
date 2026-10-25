'use client';
import { createContext, useContext } from 'react';
import { normalizeNumericInput, type OnboardingDraft, type OnboardingProgress, type OnboardingStep, type SocialLinks } from '@resuto/contracts/lite';
import type { ApiOptions } from '@/lib/api';

/** The restaurant the wizard created (GET /v1/o/:orgId, the fields the steps use). */
export interface WizardOrg {
  id: string; slug: string; name: string; nameAr: string | null; country: 'EG' | 'SA'; currency: 'EGP' | 'SAR';
  branches: Array<{ id: string; code: string; name: string; serviceMode?: 'tables' | 'counter' | 'online' }>;
  socialLinks?: SocialLinks;
}

export interface WizardValue {
  progress: OnboardingProgress;
  /** The step on screen. */
  step: OnboardingStep;
  org: WizardOrg | null;
  setOrg(org: WizardOrg): void;
  /** Finishes the current step (saved on the server) and opens the next one. */
  finish(extra?: { orgId?: string | null; draft?: OnboardingDraft }): Promise<void>;
  /** Saves the draft answers without leaving the step. */
  saveDraft(draft: OnboardingDraft): Promise<void>;
  open(step: OnboardingStep): Promise<void>;
  /** The previous step (none before the restaurant step: the signup is behind it). */
  back(): Promise<void>;
  /** Starts a new wizard for another restaurant. */
  restart(): Promise<void>;
  call<T = unknown>(path: string, opts?: Omit<ApiOptions, 'token'>): Promise<T>;
  busy: boolean;
}

export const WizardContext = createContext<WizardValue | null>(null);

export function useWizard(): WizardValue {
  const v = useContext(WizardContext);
  if (!v) throw new Error('useWizard must be used inside the onboarding wizard');
  return v;
}

/** The message of an API error (already in the page language, lib/api.ts). */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Major-unit price text (Western or Arabic-Indic digits, "." or "," decimals) to minor units; null when not a price. */
export function priceToMinor(text: string): number | null {
  const v = normalizeNumericInput(text).trim().replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(v)) return null;
  const [whole, frac = ''] = v.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
/** Minor units to the text an input shows (no grouping, Western digits). */
export const minorToText = (minor: number) => (minor % 100 ? (minor / 100).toFixed(2) : String(minor / 100));
