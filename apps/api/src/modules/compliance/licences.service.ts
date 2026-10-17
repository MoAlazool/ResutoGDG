import { Injectable } from '@nestjs/common';
import { daysUntil, expiryStatus, type LicenceInput, type LicenceUpdate, type LicenceView } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { StorageService } from '../../common/storage/storage.service';

const COLUMNS: Record<string, string> = {
  kind: 'kind', title: 'title', branchId: 'branch_id', referenceNumber: 'reference_number', issuingAuthority: 'issuing_authority',
  issuedOn: 'issued_on', expiresOn: 'expires_on', reminderDays: 'reminder_days', notes: 'notes',
};

/**
 * Licences & certificates (compliance_documents): commercial registration, tax
 * certificate, municipal licence (Balady in KSA — manual tracking), health and
 * civil-defense certificates, food safety, employee health cards. Expiry is
 * evaluated in the restaurant's time zone; reminder rows (default 30/7/1 days
 * before expiry) are sent by the compliance.expiry_reminders job, which emits
 * compliance.document_expiring for notification consumers (Connect).
 */
@Injectable()
export class LicencesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly outbox: OutboxService, private readonly storage: StorageService) {}

  private async today(tx: Tx, orgId: string): Promise<string> {
    return (await tx.one<{ d: string }>(`select (now() at time zone timezone)::date::text as d from organizations where id = $1`, [orgId])).d;
  }

  private async view(tx: Tx, r: any, today: string, withUrl = false): Promise<LicenceView> {
    const reminders = await tx.query('select days_before, remind_on::text, status, sent_at from compliance_reminders where document_id = $1 order by days_before desc', [r.id]);
    let file: LicenceView['file'] = null;
    if (r.media_id) {
      const m = await tx.maybeOne<{ path: string; content_type: string }>('select path, content_type from media_assets where id = $1', [r.media_id]);
      if (m) file = { mediaId: r.media_id, contentType: m.content_type, url: withUrl ? await this.storage.signedUrl(m.path, 900) : '' };
    }
    const maxWindow = Math.max(30, ...(r.reminder_days ?? []));
    return {
      id: r.id, branchId: r.branch_id, kind: r.kind, title: r.title, referenceNumber: r.reference_number, issuingAuthority: r.issuing_authority,
      issuedOn: r.issued_on, expiresOn: r.expires_on, daysToExpiry: r.expires_on ? daysUntil(r.expires_on, today) : null,
      expiryStatus: expiryStatus(r.expires_on, today, maxWindow), reminderDays: r.reminder_days, notes: r.notes,
      reminders: reminders.map((x) => ({ daysBefore: x.days_before, remindOn: x.remind_on, status: x.status, sentAt: x.sent_at })),
      file, createdAt: r.created_at, updatedAt: r.updated_at,
    };
  }

  /** (Re)creates reminder rows. Expiry changes (renewals) reset sent reminders; otherwise sent ones are kept. */
  private async scheduleReminders(tx: Tx, orgId: string, doc: any, today: string, resetSent: boolean) {
    await tx.query(`delete from compliance_reminders where document_id = $1 ${resetSent ? '' : `and status <> 'sent'`}`, [doc.id]);
    if (!doc.expires_on || doc.expires_on < today) return;
    for (const days of doc.reminder_days ?? []) {
      await tx.query(
        `insert into compliance_reminders(org_id, document_id, remind_on, days_before) values ($1, $2, $3::date - $4::int, $4)
         on conflict (document_id, days_before) do nothing`, [orgId, doc.id, doc.expires_on, days]);
    }
  }

  async list(ctx: TenantContext, q: { status?: string; branchId?: string }) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const today = await this.today(tx, ctx.orgId);
      const rows = await tx.query(
        `select * from compliance_documents where org_id = $1 and ($2::uuid is null or branch_id = $2)
          order by expires_on nulls last, created_at desc limit 500`, [ctx.orgId, q.branchId ?? null]);
      const items = [];
      for (const r of rows) {
        if (r.branch_id && !ctx.canAccessBranch(r.branch_id)) continue;
        const v = await this.view(tx, r, today);
        if (!q.status || v.expiryStatus === q.status) items.push(v);
      }
      return { items, today };
    });
  }

  async get(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => this.view(tx, await this.row(tx, ctx, id), await this.today(tx, ctx.orgId), true));
  }

  private async row(tx: Tx, ctx: TenantContext, id: string, lock = false) {
    const r = await tx.maybeOne<any>(`select * from compliance_documents where id = $1${lock ? ' for update' : ''}`, [id]);
    if (!r) throw notFound('Document');
    ctx.assertBranch(r.branch_id);
    return r;
  }

  private async checkBranch(tx: Tx, ctx: TenantContext, branchId: string | null | undefined) {
    if (!branchId) return;
    ctx.assertBranch(branchId);
    if (!(await tx.maybeOne('select 1 from branches where id = $1 and org_id = $2', [branchId, ctx.orgId]))) throw invalid('unknown_branch', 'This branch does not exist');
  }

  async create(ctx: TenantContext, input: LicenceInput) {
    return this.db.scoped(ctx, async (tx) => {
      await this.checkBranch(tx, ctx, input.branchId);
      const r = await tx.one<any>(
        `insert into compliance_documents(org_id, branch_id, kind, title, reference_number, issuing_authority, issued_on, expires_on, reminder_days, notes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, '{30,7,1}'::int[]), $10, $11) returning *`,
        [ctx.orgId, input.branchId ?? null, input.kind, input.title, input.referenceNumber ?? null, input.issuingAuthority ?? null,
          input.issuedOn ?? null, input.expiresOn ?? null, input.reminderDays ?? null, input.notes ?? null, ctx.userId]);
      const today = await this.today(tx, ctx.orgId);
      await this.scheduleReminders(tx, ctx.orgId, r, today, true);
      await this.audit.record(tx, ctx, { action: 'compliance_document.created', entityType: 'compliance_document', entityId: r.id, branchId: r.branch_id, metadata: { kind: r.kind } });
      return this.view(tx, r, today);
    });
  }

  async update(ctx: TenantContext, id: string, patch: LicenceUpdate) {
    return this.db.scoped(ctx, async (tx) => {
      const current = await this.row(tx, ctx, id, true);
      if (patch.branchId !== undefined) await this.checkBranch(tx, ctx, patch.branchId);
      const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && COLUMNS[k]);
      const issued = patch.issuedOn !== undefined ? patch.issuedOn : current.issued_on;
      const expires = patch.expiresOn !== undefined ? patch.expiresOn : current.expires_on;
      if (issued && expires && expires < issued) throw invalid('expiry_before_issue', 'Expiry must be on or after the issue date');
      const r = entries.length
        ? await tx.one<any>(`update compliance_documents set ${entries.map(([k], i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')} where id = $1 returning *`, [id, ...entries.map(([, v]) => v)])
        : current;
      const today = await this.today(tx, ctx.orgId);
      if (patch.expiresOn !== undefined || patch.reminderDays !== undefined) {
        await this.scheduleReminders(tx, ctx.orgId, r, today, patch.expiresOn !== undefined && patch.expiresOn !== current.expires_on);
      }
      await this.audit.record(tx, ctx, { action: 'compliance_document.updated', entityType: 'compliance_document', entityId: id, branchId: r.branch_id, metadata: { fields: entries.map(([k]) => k) } });
      return this.view(tx, r, today);
    });
  }

  async remove(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.row(tx, ctx, id, true);
      await tx.query('delete from compliance_documents where id = $1', [id]);
      await this.audit.record(tx, ctx, { action: 'compliance_document.deleted', entityType: 'compliance_document', entityId: id, branchId: r.branch_id, metadata: { kind: r.kind, title: r.title } });
      return { deleted: true };
    });
  }

  async attachFile(ctx: TenantContext, id: string, file: { buffer: Buffer; mimetype: string } | undefined) {
    if (!file?.buffer?.length) throw invalid('file_required', 'Attach a PDF or image');
    return this.db.scoped(ctx, async (tx) => {
      await this.row(tx, ctx, id, true);
      const media = await this.storage.put(tx, ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'compliance-documents', source: 'upload' });
      const r = await tx.one<any>('update compliance_documents set media_id = $2 where id = $1 returning *', [id, media.id]);
      await this.audit.record(tx, ctx, { action: 'compliance_document.file_attached', entityType: 'compliance_document', entityId: id, branchId: r.branch_id, metadata: { mediaId: media.id } });
      return this.view(tx, r, await this.today(tx, ctx.orgId), true);
    });
  }

  async counts(tx: Tx, ctx: TenantContext) {
    const today = await this.today(tx, ctx.orgId);
    const rows = await tx.query<any>('select id, branch_id, kind, title, expires_on, reminder_days from compliance_documents where org_id = $1', [ctx.orgId]);
    const visible = rows.filter((r) => !r.branch_id || ctx.canAccessBranch(r.branch_id));
    const counts = { expired: 0, expiring: 0, valid: 0, no_expiry: 0 } as Record<string, number>;
    const attention: Array<{ id: string; kind: string; title: string; expiresOn: string; daysToExpiry: number; status: string }> = [];
    for (const r of visible) {
      const s = expiryStatus(r.expires_on, today, Math.max(30, ...(r.reminder_days ?? [])));
      counts[s] = (counts[s] ?? 0) + 1;
      if (s === 'expired' || s === 'expiring') attention.push({ id: r.id, kind: r.kind, title: r.title, expiresOn: r.expires_on, daysToExpiry: daysUntil(r.expires_on, today), status: s });
    }
    attention.sort((a, b) => a.daysToExpiry - b.daysToExpiry);
    return { today, total: visible.length, counts, attention: attention.slice(0, 20) };
  }

  /**
   * Sends due reminders across tenants. Per document only the closest due
   * reminder is sent (e.g. a licence added 5 days before expiry gets the 7-day
   * reminder once, not 30 and 7); larger ones are marked dismissed.
   */
  async runReminders(): Promise<{ sent: number; dismissed: number }> {
    const orgs = await this.db.withPlatform((tx) => tx.query<{ org_id: string }>(
      `select distinct r.org_id from compliance_reminders r join organizations o on o.id = r.org_id
        where r.status = 'scheduled' and r.remind_on <= (now() at time zone o.timezone)::date limit 1000`));
    let sent = 0, dismissed = 0;
    for (const { org_id: orgId } of orgs) {
      await this.db.withTenant(orgId, async (tx) => {
        const today = await this.today(tx, orgId);
        const due = await tx.query<any>(
          `select r.id, r.document_id, r.days_before, d.kind, d.title, d.expires_on, d.branch_id
             from compliance_reminders r join compliance_documents d on d.id = r.document_id
            where r.status = 'scheduled' and r.remind_on <= $1::date
            order by r.document_id, r.days_before asc for update of r skip locked`, [today]);
        const seen = new Set<string>();
        for (const r of due) {
          if (seen.has(r.document_id) || r.expires_on < today) {
            await tx.query(`update compliance_reminders set status = 'dismissed' where id = $1`, [r.id]);
            dismissed++;
            continue;
          }
          seen.add(r.document_id);
          await this.outbox.publish(tx, orgId, {
            type: 'compliance.document_expiring', aggregateType: 'compliance_document', aggregateId: r.document_id,
            payload: { kind: r.kind, title: r.title, expiresOn: r.expires_on, daysBefore: r.days_before, daysLeft: daysUntil(r.expires_on, today), branchId: r.branch_id },
          });
          await tx.query(`update compliance_reminders set status = 'sent', sent_at = now() where id = $1`, [r.id]);
          sent++;
        }
      }, 'system:compliance.expiry_reminders');
    }
    return { sent, dismissed };
  }
}
