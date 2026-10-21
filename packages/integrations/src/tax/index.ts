// Tax and government integrations for Resuto Compliance. Owner: Agent D2.
//
// - ZATCA (KSA): Phase-1 QR (exact), Phase-2 UBL XML builder + interfaces, sandbox stub.
// - ETA (Egypt): e-receipt JSON builder, UUID derivation, QR URL, sandbox stub.
// - Licensing registries (Balady / municipal, civil defense, health): manual
//   tracking MVP behind the LicensingRegistry interface below.
// None of these are certified; readiness levels are reported honestly.
import type { ProviderDescriptor } from '../core';
import { ETA_DESCRIPTOR, EtaSandboxStubClient } from './eta';
import { ZATCA_DESCRIPTOR, ZatcaSandboxStubClient } from './zatca';

export * from './model';
export * from './zatca';
export * from './eta';

/**
 * Government licence registries. Resuto does not integrate any registry API
 * today: KSA Balady (municipal licences), Salamah (civil defense), SFDA/MOH
 * health certificates and Egyptian governorate licences are tracked manually
 * (document upload + expiry + reminders). A future adapter implements this
 * interface to pull status and expiry from an authorised partner API.
 */
export interface LicensingRegistry {
  readonly descriptor: ProviderDescriptor;
  /** Look up a licence by its reference number; null when not found. */
  lookup(input: { referenceNumber: string; kind: string }): Promise<{ status: 'active' | 'expired' | 'suspended' | 'unknown'; expiresOn: string | null; raw: unknown } | null>;
}

export const LICENSING_REGISTRIES: ProviderDescriptor[] = [
  {
    id: 'balady_manual', name: 'Balady municipal licences (manual tracking)', category: 'tax', countries: ['SA'], authType: 'none',
    readiness: 'simulated', capabilities: ['manual_tracking', 'expiry_reminders'],
    docsUrl: 'https://balady.gov.sa',
    activation: ['Manual: upload the licence, enter its number and expiry date. No Balady API is called; an authorised partner integration is required for automatic status checks.'],
  },
  {
    id: 'civil_defense_manual', name: 'Civil defense (Salamah) certificates (manual tracking)', category: 'tax', countries: ['SA'], authType: 'none',
    readiness: 'simulated', capabilities: ['manual_tracking', 'expiry_reminders'],
    activation: ['Manual tracking only; no registry API is called.'],
  },
  {
    id: 'eg_licences_manual', name: 'Egypt operating licences & health certificates (manual tracking)', category: 'tax', countries: ['EG'], authType: 'none',
    readiness: 'simulated', capabilities: ['manual_tracking', 'expiry_reminders'],
    activation: ['Manual tracking only; no governorate or NFSA API is called.'],
  },
];

export const TAX_PROVIDERS: ProviderDescriptor[] = [ZATCA_DESCRIPTOR, ETA_DESCRIPTOR];

export const taxAdapters = [ZatcaSandboxStubClient, EtaSandboxStubClient] as const;
export * from './zatca-phase2';
export * from './eta-ereceipt';
