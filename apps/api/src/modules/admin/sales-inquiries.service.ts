import { Injectable } from '@nestjs/common';
import {
  salesInquiryReference,
  type SalesInquiryInput, type SalesInquiryListQuery, type SalesInquiryReceipt, type SalesInquiryView,
} from '@resuto/contracts';
import { DbService } from '../../common/db/db.service';
import { conflict, DomainError } from '../../common/errors/domain-error';

/** At most this many inquiries per email address per rolling day (shared across API instances, unlike the IP limiter). */
export const SALES_INQUIRIES_PER_EMAIL_PER_DAY = 3;

interface Row {
  id: string; restaurant: string; email: string; branches: number; requirements: string; plan_id: string | null;
  locale: 'en' | 'ar' | null; status: SalesInquiryView['status']; created_at: Date; idempotency_key: string;
}

const view = (r: Row): SalesInquiryView => ({
  id: r.id, reference: salesInquiryReference(r.id), restaurant: r.restaurant, email: r.email, branches: r.branches,
  requirements: r.requirements, planId: r.plan_id, locale: r.locale, status: r.status, createdAt: new Date(r.created_at).toISOString(),
});

/**
 * Sales inquiries from the public pricing page (audit VP-09). Stored for the platform team, listed in platform
 * administration; no email is sent (the page says so). Platform mode: the table has no tenant.
 */
@Injectable()
export class SalesInquiriesService {
  constructor(private readonly db: DbService) {}

  async submit(input: SalesInquiryInput): Promise<SalesInquiryReceipt> {
    return this.db.withPlatform(async (tx) => {
      const prior = await tx.maybeOne<Row>(`select * from sales_inquiries where idempotency_key = $1`, [input.key]);
      if (prior) {
        // Same key, same form: the visitor resubmitted; anything else is a reused key.
        if (prior.email.toLowerCase() !== input.email.toLowerCase() || prior.restaurant !== input.restaurant) {
          throw conflict('idempotency_key_reused', 'This request key was already used for a different inquiry');
        }
        return { id: prior.id, reference: salesInquiryReference(prior.id) };
      }
      const [{ n }] = await tx.query<{ n: number }>(
        `select count(*)::int as n from sales_inquiries where lower(email) = lower($1) and created_at > now() - interval '1 day'`, [input.email]);
      if (n >= SALES_INQUIRIES_PER_EMAIL_PER_DAY) {
        throw new DomainError('rate_limited', 'We already have your recent requests. The team will reply to them.', 429, { retryAfterMs: 86_400_000 });
      }
      const [row] = await tx.query<Row>(
        `insert into sales_inquiries (restaurant, email, branches, requirements, plan_id, locale, idempotency_key)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (idempotency_key) do nothing
         returning *`,
        [input.restaurant, input.email, input.branches, input.requirements, input.planId ?? null, input.locale ?? null, input.key],
      );
      // A concurrent submit with the same key won the insert: return that one.
      const saved = row ?? (await tx.one<Row>(`select * from sales_inquiries where idempotency_key = $1`, [input.key]));
      return { id: saved.id, reference: salesInquiryReference(saved.id) };
    }, 'public:sales-inquiry');
  }

  async list(q: SalesInquiryListQuery): Promise<{ items: SalesInquiryView[] }> {
    const rows = await this.db.withPlatform((tx) => tx.query<Row>(
      `select * from sales_inquiries where ($1::text is null or status = $1) order by created_at desc limit $2`,
      [q.status ?? null, q.limit]));
    return { items: rows.map(view) };
  }
}
