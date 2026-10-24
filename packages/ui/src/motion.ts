// Motion helpers (plan §4 "Motion"). CSS does the animating (packages/ui/src/ds.css: .motion-fade-in, .motion-slide-up,
// .motion-slide-in-end, .motion-scale-in, .motion-content, the chart draw-in); only transform and opacity move, and
// prefers-reduced-motion turns all of it off (the global rule in app/globals.css plus the view-transition rules).

/** True when the person asked the OS to minimise motion (safe outside the browser: false). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => { finished: Promise<void> } };

/**
 * Runs `update` (a route change, a list re-order, a pane swap) inside the View Transitions API where the browser has
 * it and motion is allowed; otherwise runs it straight away. Progressive enhancement: the result is the same either way.
 * Returns a promise that settles when the transition (or the plain update) is done.
 */
export function withViewTransition(update: () => void | Promise<void>): Promise<void> {
  const doc = typeof document === 'undefined' ? null : (document as ViewTransitionDocument);
  if (!doc?.startViewTransition || prefersReducedMotion()) return Promise.resolve(update());
  try {
    return doc.startViewTransition(update).finished.catch(() => undefined);
  } catch {
    return Promise.resolve(update());
  }
}

/** Staggered enter for list items: style={staggerStyle(i)} on items that also carry a motion class (capped at 8 steps). */
export const staggerStyle = (index: number, stepMs = 30) => ({ animationDelay: `${Math.min(index, 8) * stepMs}ms` });
