'use client';
// Live web-address check for the onboarding wizard (21-ONB): the shape and reserved words are checked at once in the
// browser (slugProblem, zod-free), availability is asked of GET /v1/orgs/slug-availability after the owner stops
// typing for a moment. Answers for an address the field no longer shows are ignored.
import { useEffect, useRef, useState } from 'react';
import { slugProblem } from '@resuto/contracts/lite';
import type { SlugAvailability } from '@resuto/contracts';

export type SlugCheckState = 'idle' | 'checking' | 'available' | 'invalid' | 'reserved' | 'taken' | 'error';

/** Wait after the last keystroke before asking the API (60 checks a minute are allowed per person). */
export const SLUG_CHECK_DEBOUNCE_MS = 350;

/** A web address from free text: lowercase Latin letters (accents dropped), digits and single dashes, at most 48 characters. */
export const toSlug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').replace(/-{2,}/g, '-').slice(0, 48);
/** The address as it is submitted (no trailing dash). */
export const finalSlug = (s: string) => toSlug(s).replace(/-+$/, '');

/** The state the field shows before (or instead of) asking the API. Null means: ask. */
export function localSlugState(slug: string): SlugCheckState | null {
  if (!slug) return 'idle';
  const problem = slugProblem(slug);
  return problem ?? null;
}

/** Maps the API answer to a field state. */
export function remoteSlugState(answer: SlugAvailability): SlugCheckState {
  if (answer.available) return 'available';
  return answer.reason ?? 'taken';
}

/**
 * The live check. `check` performs the request (injected for tests); the returned state is for `slug` only, so a slow
 * answer for an older value never overwrites the current one.
 */
export function useSlugCheck(slug: string, check: (slug: string, signal: AbortSignal) => Promise<SlugAvailability>, delayMs = SLUG_CHECK_DEBOUNCE_MS) {
  const [state, setState] = useState<{ slug: string; value: SlugCheckState }>({ slug: '', value: 'idle' });
  const checkRef = useRef(check);
  checkRef.current = check;
  useEffect(() => {
    const local = localSlugState(slug);
    if (local) { setState({ slug, value: local }); return; }
    setState({ slug, value: 'checking' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      checkRef.current(slug, controller.signal)
        .then((answer) => { if (!controller.signal.aborted && answer.slug === slug) setState({ slug, value: remoteSlugState(answer) }); })
        .catch(() => { if (!controller.signal.aborted) setState({ slug, value: 'error' }); });
    }, delayMs);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [slug, delayMs]);
  return state.slug === slug ? state.value : localSlugState(slug) ?? 'checking';
}

/** Whether the wizard may try to create the restaurant with this state (a failed check is retried by the API). */
export const slugSubmittable = (s: SlugCheckState) => s === 'available' || s === 'error';
