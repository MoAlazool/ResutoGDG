// Inventory tabs (21-OPS): stock levels first and the default, as a list with what needs attention on top; the stocktake
// is a sheet opened from it (?tab=stocktake still opens it). Dish availability (PAR-08), recording movements, items,
// recipes, alerts, waste and history follow. Recording movements needs inventory:write.
export const INVENTORY_TABS = ['levels', 'availability', 'movement', 'items', 'recipes', 'alerts', 'waste', 'history'] as const;
export type InventoryTab = (typeof INVENTORY_TABS)[number];
export const DEFAULT_INVENTORY_TAB: InventoryTab = 'levels';

export const visibleInventoryTabs = (writable: boolean): InventoryTab[] =>
  INVENTORY_TABS.filter((k) => writable || k !== 'movement');
