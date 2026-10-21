// Inventory tabs: Dish availability first and the default, like the legacy Inventory page (PAR-08); the stock module
// (levels, purchases, counts, recipes, alerts, waste, history) follows. Recording movements and counts needs inventory:write.
export const INVENTORY_TABS = ['availability', 'levels', 'movement', 'stocktake', 'items', 'recipes', 'alerts', 'waste', 'history'] as const;
export type InventoryTab = (typeof INVENTORY_TABS)[number];
export const DEFAULT_INVENTORY_TAB: InventoryTab = 'availability';

export const visibleInventoryTabs = (writable: boolean): InventoryTab[] =>
  INVENTORY_TABS.filter((k) => writable || (k !== 'movement' && k !== 'stocktake'));
