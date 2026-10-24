// Option lists pages render (assistant allergens, reservation table features, service modes). Kept free of zod so they
// can be imported without the schema library (see lite.ts); guest.ts, floor.ts and operations.ts re-export them.

/** Allergens a guest can ask to avoid (the menu's allergen vocabulary). */
export const ASSISTANT_ALLERGENS = ['milk', 'eggs', 'wheat', 'gluten', 'fish', 'shellfish', 'tree_nuts', 'peanuts', 'sesame', 'soy'] as const;

/** The 13 legacy reservation feature tags (`floor-model.js` tableFeatures). */
export const TABLE_FEATURES = [
  'Smoking', 'Non-smoking', 'Window side', 'Quiet area', 'Terrace', 'Near entrance', 'Far from entrance',
  'Center', 'Outdoor', 'Booth', 'Accessible', 'High chair compatible', 'Near bar',
] as const;
export type TableFeature = (typeof TABLE_FEATURES)[number];

/** How a branch serves guests (venue QR service mode). */
export const SERVICE_MODES = ['tables', 'counter', 'online'] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];
