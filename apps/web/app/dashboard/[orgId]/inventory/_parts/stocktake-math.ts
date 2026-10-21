// Pure helpers for the stocktake screen (FT-25), kept free of UI imports so they can be unit tested.

/** Variance of a counted quantity against the system quantity; null when the row was left blank or is not a number. */
export function varianceOf(onHand: number, counted: string): { delta: number; counted: number } | null {
  const v = counted.trim();
  if (!v) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return { counted: Math.round(n * 1000) / 1000, delta: Math.round((n - onHand) * 1000) / 1000 };
}
