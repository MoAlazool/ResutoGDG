// Meta Custom Audiences from CRM segments (INT-22): DRY RUN ONLY.
// Docs (checked 2026-10-20): https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences
//   create: POST /act_<AD_ACCOUNT_ID>/customaudiences { name, subtype: CUSTOM, description, customer_file_source }
//   add:    POST /<AUDIENCE_ID>/users { payload: { schema: [...], data: [[...]] }, session: { session_id, batch_seq, last_batch_flag } }
//           up to 10,000 users per request; values SHA-256 lowercase hex after normalisation (email trim+lowercase;
//           phone digits with country code, no leading zeros); error 200/1870090 when the Custom Audience Terms are not
//           accepted on the ad account.
// This module builds exactly what would be uploaded (hashed, consent-filtered, batched) so the owner can review it, and
// never calls Meta: uploading customer lists needs the ad account's Custom Audience Terms, App Review for
// ads_management with customer-list use, and marketing approval in Resuto. Upload, ad set / creative creation and
// Page / Instagram publishing are deferred (docs/INTEGRATION_READINESS.md, Meta section).
import { hashEmail, hashPhone } from './meta-capi';

export const AUDIENCE_BATCH_SIZE = 10_000;
export const AUDIENCE_SCHEMA = ['EMAIL', 'PHONE'] as const;

export interface AudienceMember { email?: string | null; phone?: string | null; marketingConsent: boolean; anonymised?: boolean }

export interface AudienceDryRun {
  dryRun: true;
  create: { path: string; body: { name: string; subtype: 'CUSTOM'; description: string; customer_file_source: 'USER_PROVIDED_ONLY' } };
  batches: Array<{ path: string; rows: number; session: { batch_seq: number; last_batch_flag: boolean } }>;
  counts: { segment: number; withConsent: number; matchable: number; excludedNoConsent: number; excludedNoIdentifier: number };
  /** First hashed rows only (never raw identifiers), to show the format. */
  sample: string[][];
  schema: readonly string[];
  notes: string[];
}

/** Builds the hashed, consent-filtered upload plan for a segment. Raw emails/phones never leave this function. */
export function buildCustomAudienceDryRun(input: { adAccountId: string; name: string; description: string; members: AudienceMember[] }): AudienceDryRun {
  const act = input.adAccountId.startsWith('act_') ? input.adAccountId : `act_${input.adAccountId}`;
  const consenting = input.members.filter((m) => m.marketingConsent && !m.anonymised);
  const seen = new Set<string>();
  const rows: string[][] = [];
  let noIdentifier = 0;
  for (const m of consenting) {
    const row = [hashEmail(m.email) ?? '', hashPhone(m.phone) ?? ''];
    if (!row[0] && !row[1]) { noIdentifier++; continue; }
    const key = row.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  const batchCount = Math.ceil(rows.length / AUDIENCE_BATCH_SIZE);
  return {
    dryRun: true,
    create: { path: `${act}/customaudiences`, body: { name: input.name.slice(0, 100), subtype: 'CUSTOM', description: input.description.slice(0, 200), customer_file_source: 'USER_PROVIDED_ONLY' } },
    batches: Array.from({ length: batchCount }, (_, i) => ({
      path: '<AUDIENCE_ID>/users', rows: Math.min(AUDIENCE_BATCH_SIZE, rows.length - i * AUDIENCE_BATCH_SIZE),
      session: { batch_seq: i + 1, last_batch_flag: i === batchCount - 1 },
    })),
    counts: { segment: input.members.length, withConsent: consenting.length, matchable: rows.length,
      excludedNoConsent: input.members.length - consenting.length, excludedNoIdentifier: noIdentifier },
    sample: rows.slice(0, 3),
    schema: AUDIENCE_SCHEMA,
    notes: [
      'Dry run: nothing was sent to Meta.',
      'Only customers who gave marketing consent are included; identifiers are SHA-256 hashed after Meta normalisation.',
      'Uploading needs the Custom Audience Terms accepted on the ad account and Meta App Review for ads_management.',
    ],
  };
}
