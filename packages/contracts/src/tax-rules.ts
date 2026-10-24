// Tax-profile rules and licence kinds. Kept free of zod so the dashboard can validate a profile without the schema
// library (see lite.ts); compliance.ts re-exports them.
import type { RegisteredAddress } from './compliance';

export const TAX_REGIMES = ['zatca', 'eta', 'none'] as const;
export type TaxRegime = (typeof TAX_REGIMES)[number];

export interface TaxProfileFields {
  country: 'EG' | 'SA';
  regime: TaxRegime;
  vatRateBp: number;
  pricesIncludeTax: boolean;
  serviceChargeBp: number;
  vatNumber: string | null;
  registeredName: string | null;
  registeredAddress: RegisteredAddress;
  zatcaEnvironment: 'sandbox' | 'simulation' | 'production' | null;
  zatcaEgsSerial: string | null;
  etaEnvironment: 'preprod' | 'production' | null;
  etaActivityCode: string | null;
  etaBranchCode: string | null;
  etaPosSerial: string | null;
}

export interface TaxValidationIssue {
  field: string;
  code: string;
  severity: 'error' | 'warning';
  message: string;
}

export const EXPECTED_VAT_BP: Record<'EG' | 'SA', number> = { EG: 1400, SA: 1500 };
export const REGIME_FOR_COUNTRY: Record<'EG' | 'SA', TaxRegime> = { EG: 'eta', SA: 'zatca' };

/** KSA VAT registration number: 15 digits, first and last digit 3. */
export const isSaudiVatNumber = (v: string) => /^3\d{13}3$/.test(v);
/** Egyptian tax registration number (RIN): 9 digits. */
export const isEgyptTaxNumber = (v: string) => /^\d{9}$/.test(v);
/** ZATCA EGS serial as used in the CSR: "1-<solution>|2-<model/version>|3-<serial>". */
export const isZatcaEgsSerial = (v: string) => /^1-[^|]+\|2-[^|]+\|3-[^|]+$/.test(v);

/**
 * Country-aware validation of a tax profile. Shared by the API (stored as
 * is_validated / validation_errors) and the dashboard (live form validation).
 * A profile is validated when there are no "error" issues; warnings are advisory.
 */
export function validateTaxProfile(p: TaxProfileFields): TaxValidationIssue[] {
  const issues: TaxValidationIssue[] = [];
  const err = (field: string, code: string, message: string) => issues.push({ field, code, severity: 'error', message });
  const warn = (field: string, code: string, message: string) => issues.push({ field, code, severity: 'warning', message });
  const blank = (v: string | null | undefined) => !v || !v.trim();
  const a = p.registeredAddress ?? {};

  if (p.regime !== 'none' && p.regime !== REGIME_FOR_COUNTRY[p.country]) {
    err('regime', 'regime_country_mismatch', `${p.country === 'SA' ? 'Saudi Arabia uses ZATCA' : 'Egypt uses the ETA'} e-invoicing regime`);
    return issues;
  }
  if (p.regime === 'none') {
    warn('regime', 'regime_none', 'No fiscal documents are issued while the tax regime is "none"');
    return issues;
  }
  if (p.vatRateBp !== EXPECTED_VAT_BP[p.country]) {
    warn('vatRateBp', 'vat_rate_unusual', `The standard VAT rate is ${EXPECTED_VAT_BP[p.country] / 100}%`);
  }
  if (blank(p.registeredName)) err('registeredName', 'required', 'Registered (legal) name is required');

  if (p.regime === 'zatca') {
    if (blank(p.vatNumber)) err('vatNumber', 'required', 'VAT registration number is required');
    else if (!isSaudiVatNumber(p.vatNumber!.trim())) err('vatNumber', 'vat_number_format', 'VAT number must be 15 digits starting and ending with 3');
    if (blank(a.street)) err('registeredAddress.street', 'required', 'Street is required for tax invoices');
    if (blank(a.buildingNumber)) err('registeredAddress.buildingNumber', 'required', 'Building number is required');
    else if (!/^\d{4}$/.test(a.buildingNumber!.trim())) err('registeredAddress.buildingNumber', 'building_number_format', 'Building number must be 4 digits');
    if (blank(a.district)) err('registeredAddress.district', 'required', 'District is required');
    if (blank(a.city)) err('registeredAddress.city', 'required', 'City is required');
    if (blank(a.postalCode)) err('registeredAddress.postalCode', 'required', 'Postal code is required');
    else if (!/^\d{5}$/.test(a.postalCode!.trim())) err('registeredAddress.postalCode', 'postal_code_format', 'Postal code must be 5 digits');
    if (!p.zatcaEnvironment) err('zatcaEnvironment', 'required', 'Choose the ZATCA environment');
    if (blank(p.zatcaEgsSerial)) err('zatcaEgsSerial', 'required', 'EGS unit serial number is required');
    else if (!isZatcaEgsSerial(p.zatcaEgsSerial!.trim())) err('zatcaEgsSerial', 'egs_serial_format', 'Use the format 1-<solution>|2-<model>|3-<serial>');
  }

  if (p.regime === 'eta') {
    if (blank(p.vatNumber)) err('vatNumber', 'required', 'Tax registration number is required');
    else if (!isEgyptTaxNumber(p.vatNumber!.trim())) err('vatNumber', 'tax_registration_number_format', 'Tax registration number must be 9 digits');
    if (blank(a.governate)) err('registeredAddress.governate', 'required', 'Governorate is required');
    if (blank(a.regionCity)) err('registeredAddress.regionCity', 'required', 'Region/city is required');
    if (blank(a.street)) err('registeredAddress.street', 'required', 'Street is required');
    if (blank(a.buildingNumber)) err('registeredAddress.buildingNumber', 'required', 'Building number is required');
    if (blank(p.etaActivityCode)) err('etaActivityCode', 'required', 'ETA activity code is required');
    else if (!/^\d{4}$/.test(p.etaActivityCode!.trim())) err('etaActivityCode', 'activity_code_format', 'Activity code must be 4 digits (e.g. 5610 for restaurants)');
    if (blank(p.etaBranchCode)) err('etaBranchCode', 'required', 'ETA branch code is required ("0" for the main branch)');
    else if (!/^\d{1,10}$/.test(p.etaBranchCode!.trim())) err('etaBranchCode', 'branch_code_format', 'Branch code must be numeric');
    if (blank(p.etaPosSerial)) err('etaPosSerial', 'required', 'POS serial number is required for e-receipts');
    else if (!/^[A-Za-z0-9._-]{1,50}$/.test(p.etaPosSerial!.trim())) err('etaPosSerial', 'pos_serial_format', 'POS serial may contain letters, digits, dot, dash and underscore');
    if (!p.etaEnvironment) err('etaEnvironment', 'required', 'Choose the ETA environment');
  }
  return issues;
}

export const hasBlockingIssues = (issues: TaxValidationIssue[]) => issues.some((i) => i.severity === 'error');

export const LICENCE_KINDS = [
  'commercial_registration', 'tax_certificate', 'municipal_license', 'health_certificate',
  'civil_defense', 'food_safety', 'trade_license', 'employee_health_card', 'other',
] as const;
export type LicenceKind = (typeof LICENCE_KINDS)[number];
