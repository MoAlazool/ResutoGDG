// Small browser-side helpers for the /pricing page (PricingPage.tsx), kept apart so they are unit tested.

/** Scrolls to the URL fragment's element. Any fragment is accepted (#1, percent-encoded Arabic): no selector parsing. */
export function scrollToHash(hash: string) {
  if (!hash || hash.length < 2) return;
  let id = hash.slice(1);
  try { id = decodeURIComponent(id); } catch { /* malformed escape: use it as typed */ }
  document.getElementById(id)?.scrollIntoView();
}

/**
 * The plan stored with a sales inquiry: only one the visitor chose (?plan=, the comparison, or Business's "Contact
 * sales"), never the comparison's default focus. Business is stored as 'business'.
 */
export function salesPlanId(chosen: string | null, planIds: readonly string[]): string | null {
  return chosen && planIds.includes(chosen) ? chosen : null;
}
