// Operator console text helpers (21-ADMIN). Separate from strings.ts so client modules never import the dictionaries.
import type { AdminStrings } from './strings';

/** Fills {name} placeholders. */
export const fill = (text: string, vars: Record<string, string | number>) =>
  Object.entries(vars).reduce((a, [k, v]) => a.replaceAll(`{${k}}`, String(v)), text);
/** A dynamic key's string (statuses, plans, checklist items), or `fallback` (the raw code) when there is none. */
export const pickString = (s: AdminStrings, key: string, fallback = key) => (s as unknown as Record<string, string>)[key] ?? fallback;
