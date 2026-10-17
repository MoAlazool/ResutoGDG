import { parseCsv, parseMajor, type MenuImportPreview, type MenuImportPreviewRow, type MenuImportRow } from '@resuto/contracts';
import { invalid } from '../../common/errors/domain-error';

/**
 * Review semantics ported from legacy data-tools.menuPreview: every row is
 * validated and annotated; nothing is written until /commit, and a commit with
 * any row error is refused. Rows may come from CSV, POS adapters (Foodics,
 * Odoo) or an AI draft (MODULE_CONTRACTS §8 row shape).
 */
export interface ExistingProduct { id: string; name: string; external_ref: string | null }

const MAX_NAME = 120;
const MAX_CATEGORY = 80;
const MAX_STATION = 40;
const MAX_PRICE_MINOR = 10_000_000;

const bool = (v: string | undefined): boolean | undefined => {
  if (v === undefined || v.trim() === '') return undefined;
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(s)) return true;
  if (['false', '0', 'no'].includes(s)) return false;
  return undefined;
};

/** Maps CSV columns (2.0 export or legacy `price_egp` exports) to §8 rows. */
export function csvToRows(csv: string, currency: 'EGP' | 'SAR'): MenuImportRow[] {
  let records: Array<Record<string, string>>;
  try {
    records = parseCsv(csv);
  } catch (e) {
    throw invalid('invalid_csv', (e as Error).message);
  }
  if (!records.length || records.length > 300) throw invalid('invalid_csv', 'Provide between 1 and 300 menu items.');
  return records.map((r) => {
    const rawPrice = r.priceMinor ?? r.price_minor;
    let priceMinor = Number.NaN;
    if (rawPrice !== undefined && rawPrice.trim() !== '') priceMinor = Number(rawPrice);
    else {
      const major = r.price ?? r.price_egp ?? r.price_sar;
      try { if (major !== undefined && major.trim() !== '') priceMinor = parseMajor(major, currency); } catch { priceMinor = Number.NaN; }
    }
    const available = bool(r.available);
    return {
      externalId: (r.externalId ?? r.external_id ?? r.id ?? '').trim() || undefined,
      name: r.name ?? '',
      nameAr: r.nameAr ?? r.name_ar ?? undefined,
      category: r.category ?? '',
      description: r.description ?? undefined,
      priceMinor,
      station: r.station ?? undefined,
      allergens: (r.allergens ?? '').split('|').map((x) => x.trim()).filter(Boolean),
      ...(available === undefined ? {} : { available }),
    };
  });
}

export function previewRows(
  rows: MenuImportRow[], existing: ExistingProduct[], categories: string[], source: string,
): MenuImportPreview {
  const byExternal = new Map(existing.filter((p) => p.external_ref).map((p) => [p.external_ref!, p]));
  const seenNames = new Set<string>();
  const seenExternal = new Set<string>();
  const knownCategories = new Set(categories.map((c) => c.trim().toLowerCase()));
  const newCategories = new Set<string>();
  const out: MenuImportPreviewRow[] = rows.map((r, index) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const name = String(r.name ?? '').trim();
    const category = String(r.category ?? '').trim() || 'Mains';
    const station = String(r.station ?? '').trim() || 'Kitchen';
    const externalId = r.externalId?.trim() || null;
    if (!name || name.length > MAX_NAME) errors.push(`Name is required (up to ${MAX_NAME} characters)`);
    if (category.length > MAX_CATEGORY) errors.push(`Category must be up to ${MAX_CATEGORY} characters`);
    if (station.length > MAX_STATION) errors.push(`Station must be up to ${MAX_STATION} characters`);
    if (!Number.isSafeInteger(r.priceMinor) || r.priceMinor < 1 || r.priceMinor > MAX_PRICE_MINOR) {
      errors.push('Price must be a positive amount with up to two decimals');
    }
    const allergens = (r.allergens ?? []).map((a) => String(a).trim()).filter(Boolean);
    if (allergens.length > 30 || allergens.some((a) => a.length > 40)) errors.push('Invalid allergens (at most 30, 40 characters each)');
    if ((r.nameAr ?? '').length > MAX_NAME) errors.push('Arabic name is too long');
    if ((r.description ?? '').length > 1000) errors.push('Description is too long');

    const match = externalId ? byExternal.get(externalId) ?? null : null;
    if (externalId) {
      if (seenExternal.has(externalId)) errors.push('Duplicate external id in this file');
      seenExternal.add(externalId);
    }
    const normalized = name.toLowerCase();
    if (normalized) {
      if (seenNames.has(normalized) || existing.some((p) => p.id !== match?.id && p.name.trim().toLowerCase() === normalized)) errors.push('Duplicate item');
      seenNames.add(normalized);
    }
    if (!knownCategories.has(category.toLowerCase())) newCategories.add(category);
    const defaultAvailable = source === 'csv';
    const available = r.available ?? defaultAvailable;
    if (source !== 'csv') warnings.push('Review price and allergens before publishing');
    if (!available) warnings.push('Imported as unavailable');
    return {
      row: index + 1, action: match ? 'update' : 'create', productId: match?.id ?? null, errors, warnings,
      item: {
        externalId, name, nameAr: r.nameAr?.trim() || null, category, description: r.description?.trim() || null,
        priceMinor: Number.isSafeInteger(r.priceMinor) ? r.priceMinor : 0, station, allergens, available,
      },
    };
  });
  return {
    source,
    rows: out,
    summary: {
      total: out.length,
      create: out.filter((r) => r.action === 'create').length,
      update: out.filter((r) => r.action === 'update').length,
      errors: out.filter((r) => r.errors.length).length,
      newCategories: [...newCategories],
    },
  };
}
