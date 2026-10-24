// Inventory units, conversions and waste reasons. Kept free of zod so pages can import them without the schema library
// (see lite.ts); inventory.ts re-exports them.

export const INVENTORY_UNITS = ['g', 'kg', 'ml', 'l', 'pcs'] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

/** Units convert only inside one family (mass, volume, count). */
const UNIT_FACTORS: Record<InventoryUnit, { family: 'mass' | 'volume' | 'count'; factor: number }> = {
  g: { family: 'mass', factor: 1 }, kg: { family: 'mass', factor: 1000 },
  ml: { family: 'volume', factor: 1 }, l: { family: 'volume', factor: 1000 },
  pcs: { family: 'count', factor: 1 },
};
export const unitFamily = (u: InventoryUnit) => UNIT_FACTORS[u].family;
export const unitsCompatible = (a: InventoryUnit, b: InventoryUnit) => UNIT_FACTORS[a].family === UNIT_FACTORS[b].family;

/** Converts a quantity between compatible units, rounded to 3 decimals (the storage precision). */
export function convertQuantity(quantity: number, from: InventoryUnit, to: InventoryUnit): number {
  if (!unitsCompatible(from, to)) throw new RangeError(`Cannot convert ${from} to ${to}`);
  return Math.round((quantity * UNIT_FACTORS[from].factor / UNIT_FACTORS[to].factor) * 1000) / 1000;
}

export const WASTE_REASONS = ['expired', 'spoiled', 'damaged', 'overproduction', 'plate_waste', 'other'] as const;
