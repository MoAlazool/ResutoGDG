// Property checks for the restaurant's schema.org JSON-LD (22-STUDIO). These are Resuto's own checks, written from the
// published documentation as we know it — Google Search Central's structured data guidelines for local businesses
// (Restaurant is a LocalBusiness / FoodEstablishment: name and address required; url, telephone, geo,
// openingHoursSpecification, image, priceRange, servesCuisine, menu and, for a business with several locations,
// department recommended) and schema.org's definitions of Menu, MenuSection, MenuItem, Offer and FAQPage. They are not
// Google's validator and passing them does not guarantee rich results, answers or citations: use the Rich Results Test
// and Search Console for Google's own verdict. Pure; unit-tested in lib/structured-data-checks.test.ts.
import { validateJsonLd } from '@/app/r/[slug]/_components/structured-data';

type Ld = Record<string, unknown>;
export type PropLevel = 'required' | 'recommended';
export interface PropRule { property: string; level: PropLevel; test?: (v: unknown, node: Ld) => boolean; note?: string }
export interface PropCheck { path: string; type: string; property: string; level: PropLevel; ok: boolean; note?: string }

const present = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0);
const isUrl = (v: unknown) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v);
const isObj = (v: unknown): v is Ld => !!v && typeof v === 'object' && !Array.isArray(v);
/** Google asks for at least 5 decimal places of latitude and longitude; fewer is a coarse pin, not an error. */
const precise = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && (String(n).split('.')[1]?.length ?? 0) >= 5;

/**
 * The rules per @type. `note` marks a property Resuto has no field for yet (servesCuisine) or that is deliberately left
 * out (aggregateRating: there is no review data, and invented ratings are never emitted) — reported, not failed.
 */
export const PROPERTY_RULES: Record<string, PropRule[]> = {
  Restaurant: [
    { property: 'name', level: 'required' },
    { property: 'address', level: 'required', test: (v) => isObj(v) && v['@type'] === 'PostalAddress' },
    { property: 'url', level: 'recommended', test: isUrl },
    { property: 'telephone', level: 'recommended' },
    { property: 'geo', level: 'recommended', test: (v) => isObj(v) && present(v.latitude) && present(v.longitude) },
    { property: 'openingHoursSpecification', level: 'recommended' },
    { property: 'image', level: 'recommended' },
    { property: 'priceRange', level: 'recommended' },
    { property: 'menu', level: 'recommended' },
    { property: 'servesCuisine', level: 'recommended', note: 'noCuisineField' },
  ],
  PostalAddress: [
    { property: 'streetAddress', level: 'recommended' },
    { property: 'addressLocality', level: 'recommended' },
    { property: 'addressCountry', level: 'recommended' },
  ],
  GeoCoordinates: [
    { property: 'latitude', level: 'required', test: (v) => typeof v === 'number' },
    { property: 'longitude', level: 'required', test: (v) => typeof v === 'number' },
    { property: 'latitude', level: 'recommended', test: precise, note: 'precision' },
  ],
  OpeningHoursSpecification: [
    { property: 'dayOfWeek', level: 'required' },
    { property: 'opens', level: 'required', test: (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) },
    { property: 'closes', level: 'required', test: (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) },
  ],
  Menu: [
    { property: 'hasMenuSection', level: 'required', test: (v) => Array.isArray(v) && v.length > 0 },
    { property: 'url', level: 'recommended', test: isUrl },
  ],
  MenuSection: [
    { property: 'name', level: 'required' },
    { property: 'hasMenuItem', level: 'required', test: (v) => Array.isArray(v) && v.length > 0 },
  ],
  MenuItem: [
    { property: 'name', level: 'required' },
    { property: 'offers', level: 'required' },
    { property: 'description', level: 'recommended' },
  ],
  Offer: [
    { property: 'price', level: 'required', test: (v) => typeof v === 'string' && /^\d+\.\d{2}$/.test(v) },
    { property: 'priceCurrency', level: 'required', test: (v) => typeof v === 'string' && /^[A-Z]{3}$/.test(v) },
  ],
  FAQPage: [{ property: 'mainEntity', level: 'required', test: (v) => Array.isArray(v) && v.length > 0 }],
  Question: [{ property: 'name', level: 'required' }, { property: 'acceptedAnswer', level: 'required' }],
  Answer: [{ property: 'text', level: 'required' }],
};

/**
 * Other branches (department) are described by their location facts only (the menu, images and price range belong to
 * the restaurant they are part of): name and address required; phone, map position and hours recommended.
 */
const DEPARTMENT: PropRule[] = PROPERTY_RULES.Restaurant!.filter((r) => ['name', 'address', 'telephone', 'geo', 'openingHoursSpecification'].includes(r.property));
/** A dish offered by the restaurant (Offer → itemOffered): the price is on the Offer, the dish needs its name. */
const DISH_OFFERED: PropRule[] = [{ property: 'name', level: 'required' }, { property: 'description', level: 'recommended' }];
/** Offers of a promotion (makesOffer) describe a discount, not a dish price: they need a name, not a price. */
const PROMO_OFFER: PropRule[] = [{ property: 'name', level: 'required' }, { property: 'url', level: 'recommended', test: isUrl }];

/** Every property check for one document (walks nested nodes; `{ "@id" }` references are skipped). */
export function propertyChecks(doc: unknown): PropCheck[] {
  const out: PropCheck[] = [];
  const walk = (v: unknown, path: string, parentKey: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`, parentKey)); return; }
    if (!isObj(v)) return;
    if (Object.keys(v).length === 1 && typeof v['@id'] === 'string') return;
    const type = typeof v['@type'] === 'string' ? (v['@type'] as string) : '';
    const rules = type === 'Offer' && parentKey === 'makesOffer' && !isObj(v.itemOffered) ? PROMO_OFFER
      : type === 'Restaurant' && parentKey === 'department' ? DEPARTMENT
        : type === 'MenuItem' && parentKey === 'itemOffered' ? DISH_OFFERED
          : PROPERTY_RULES[type] ?? [];
    for (const r of rules) {
      const val = v[r.property];
      out.push({ path, type, property: r.property, level: r.level, ok: present(val) && (r.test ? r.test(val, v) : true), ...(r.note ? { note: r.note } : {}) });
    }
    for (const [k, x] of Object.entries(v)) if (k !== '@context') walk(x, `${path}.${k}`, k);
  };
  walk(doc, '$', '');
  return out;
}

export interface JsonLdReport {
  /** Shape and privacy problems (validateJsonLd): any is an error. */
  problems: string[];
  required: { passed: number; failed: PropCheck[] };
  recommended: { passed: number; missing: PropCheck[] };
  types: Record<string, number>;
}

/** The whole report for a page's documents: shape problems, required and recommended properties, node counts per type. */
export function jsonLdReport(docs: unknown[]): JsonLdReport {
  const problems = docs.flatMap((d, i) => validateJsonLd(d).map((p) => (docs.length > 1 ? `#${i + 1} ${p}` : p)));
  const checks = docs.flatMap((d, i) => propertyChecks(d).map((c) => ({ ...c, path: docs.length > 1 ? `#${i + 1}${c.path.slice(1)}` : c.path })));
  const types: Record<string, number> = {};
  const count = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(count); return; }
    if (!isObj(v)) return;
    if (typeof v['@type'] === 'string') types[v['@type'] as string] = (types[v['@type'] as string] ?? 0) + 1;
    Object.values(v).forEach(count);
  };
  docs.forEach(count);
  const req = checks.filter((c) => c.level === 'required');
  const rec = checks.filter((c) => c.level === 'recommended');
  return {
    problems,
    required: { passed: req.filter((c) => c.ok).length, failed: req.filter((c) => !c.ok) },
    recommended: { passed: rec.filter((c) => c.ok).length, missing: rec.filter((c) => !c.ok) },
    types,
  };
}

/** The JSON-LD documents in an HTML page (each <script type="application/ld+json">), parsed; unparseable ones as errors. */
export function extractJsonLd(html: string): { docs: unknown[]; errors: string[] } {
  const docs: unknown[] = [];
  const errors: string[] = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try { docs.push(JSON.parse(m[1]!)); } catch (e) { errors.push((e as Error).message); }
  }
  return { docs, errors };
}
