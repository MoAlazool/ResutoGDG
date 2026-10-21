/**
 * Menu availability rules shared by the menu, ordering, connect and MCP read paths (FT-02 / DF-01).
 *
 * product_branch_settings.is_available means OFFERED at the branch (assignment): false hides the dish there.
 * sold_out is the temporary 86: the dish stays listed as sold out (contracts SOLD_OUT_DISPLAY) and ordering refuses
 * it. The 86 is effective until sold_out_until passes (the restore job then clears it, which bumps the menu version).
 * `s` is the product_branch_settings alias (left joined, so every column may be null).
 */
export const SOLD_OUT_SQL = `coalesce(s.sold_out and (s.sold_out_until is null or s.sold_out_until > now()), false)`;
export const OFFERED_SQL = `coalesce(s.is_available, true)`;
/** Tracked stock is not exhausted. Needs the products alias `p`. */
export const IN_STOCK_SQL = `(not p.track_stock or s.stock_qty is null or s.stock_qty > 0)`;
