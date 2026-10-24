import { Injectable } from '@nestjs/common';
import {
  CONVERSATION_TAG_LIMITS, SAVED_REPLY_LIMIT_PER_ORG,
  type ConversationTag, type ConversationTagInput, type ConversationTagUpdate, type InternalNote, type InternalNoteInput,
  type SavedReply, type SavedReplyInput, type SavedReplyListQuery, type SavedReplyUpdate,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, forbidden, invalid, notFound } from '../../common/errors/domain-error';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { escapeLike } from '../mcp/mcp.util';

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const isUnique = (e: unknown) => (e as { code?: string }).code === '23505';

export const tagView = (r: { id: string; name: string; color: string; created_at: Date | string }): ConversationTag =>
  ({ id: r.id, name: r.name, color: r.color as ConversationTag['color'], createdAt: iso(r.created_at)! });

export const noteView = (r: { id: string; conversation_id: string; body: string; sent_by: string | null; author_name?: string | null;
  created_at: Date | string }): InternalNote =>
  ({ id: r.id, conversationId: r.conversation_id, body: r.body, authorId: r.sent_by, authorName: r.author_name ?? null, createdAt: iso(r.created_at)! });

const replyView = (r: any): SavedReply => ({
  id: r.id, title: r.title, shortcut: r.shortcut, bodyEn: r.body_en, bodyAr: r.body_ar, branchId: r.branch_id,
  createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
});

/** Columns of an internal note with its author's name (profiles are readable by members of the organization). */
export const NOTE_SELECT = `m.id, m.conversation_id, m.body, m.sent_by, m.created_at, coalesce(p.full_name, p.email) as author_name`;

/** Tags of each conversation in `ids` (one query), keyed by conversation id, sorted by name. */
export async function tagsByConversation(tx: Tx, ids: string[]): Promise<Map<string, ConversationTag[]>> {
  const out = new Map<string, ConversationTag[]>();
  if (!ids.length) return out;
  const rows = await tx.query<{ conversation_id: string; id: string; name: string; color: string; created_at: Date }>(
    `select a.conversation_id, t.id, t.name, t.color, t.created_at
       from conversation_tag_assignments a join conversation_tags t on t.id = a.tag_id
      where a.conversation_id = any($1::uuid[]) order by lower(t.name), t.id`, [ids]);
  for (const r of rows) {
    const list = out.get(r.conversation_id) ?? [];
    list.push(tagView(r));
    out.set(r.conversation_id, list);
  }
  return out;
}

/**
 * 21-INBOX: internal notes, conversation tags and saved replies.
 *
 * Notes are messages with kind 'note' and direction 'internal'. They are written here only, never touch the
 * conversation row (unread count, last inbound time and so the 24-hour window, last message time, status) and never
 * enter the outbound queue or the outbox: the sender job and every delivery path select direction 'outbound', and the
 * database refuses a note that is queued, has a provider id or a retry time (messages_note_internal).
 */
@Injectable()
export class InboxService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly idempotency: IdempotencyService) {}

  /**
   * A conversation the caller may act on, exactly as the inbox resolves one: another restaurant's is a 404, and so is
   * another branch's (the branch-scoped conversations RLS hides it); assertBranch is the second line of defence.
   */
  private async conversation(tx: Tx, ctx: TenantContext, id: string) {
    const c = await tx.maybeOne<{ id: string; branch_id: string | null }>(`select id, branch_id from conversations where id = $1 and org_id = $2`, [id, ctx.orgId]);
    if (!c) throw notFound('Conversation');
    ctx.assertBranch(c.branch_id);
    return c;
  }

  // ---------------------------------------------------------------------------
  // Internal notes
  // ---------------------------------------------------------------------------
  addNote(ctx: TenantContext, conversationId: string, input: InternalNoteInput): Promise<InternalNote> {
    return this.db.scoped(ctx, async (tx) => {
      const c = await this.conversation(tx, ctx, conversationId);
      return this.idempotency.run(tx, ctx.orgId, `connect.note:${conversationId}`, input.key, input, async () => {
        const row = await tx.one<{ id: string; conversation_id: string; body: string; sent_by: string | null; created_at: Date }>(
          `insert into messages(org_id, conversation_id, direction, kind, body, payload, status, sent_by, is_automated)
           values ($1, $2, 'internal', 'note', $3, '{}'::jsonb, 'received', $4, false)
           returning id, conversation_id, body, sent_by, created_at`, [ctx.orgId, conversationId, input.body, ctx.userId]);
        const author = ctx.userId
          ? await tx.maybeOne<{ name: string | null }>(`select coalesce(full_name, email) as name from profiles where id = $1`, [ctx.userId]) : null;
        // The note text stays out of the audit log (it is staff-only conversation content); its size is recorded.
        await this.audit.record(tx, ctx, { action: 'connect.note_added', entityType: 'conversation', entityId: conversationId, branchId: c.branch_id,
          metadata: { messageId: row.id, length: input.body.length } });
        return noteView({ ...row, author_name: author?.name ?? null });
      });
    });
  }

  listNotes(ctx: TenantContext, conversationId: string, q: { limit: number; cursor?: string }) {
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => {
      await this.conversation(tx, ctx, conversationId);
      const rows = await tx.query<any>(
        `select ${NOTE_SELECT}, ${cursorAt('m.created_at')} as cursor_at
           from messages m left join profiles p on p.id = m.sent_by
          where m.conversation_id = $1 and m.org_id = $2 and m.kind = 'note' ${k.after('m.created_at', 'm.id', 3)}
          order by m.created_at desc, m.id desc limit ${k.fetch(q.limit)}`, [conversationId, ctx.orgId, ...k.params]);
      return pageOf(rows, q.limit, (r: any) => ({ at: r.cursor_at, id: r.id }), (r: any) => noteView(r));
    });
  }

  // ---------------------------------------------------------------------------
  // Tags
  // ---------------------------------------------------------------------------
  listTags(ctx: TenantContext, q: { limit: number; cursor?: string }) {
    const k = keyset(q.cursor, { atType: 'text', direction: 'asc' });
    return this.db.scoped(ctx, async (tx) => pageOf(await tx.query<any>(
      `select *, lower(name) as sort_key from conversation_tags where org_id = $1 ${k.after('lower(name)', 'id', 2)}
        order by lower(name), id limit ${k.fetch(q.limit)}`, [ctx.orgId, ...k.params]), q.limit, (r: any) => ({ at: r.sort_key, id: r.id }), (r: any) => tagView(r)));
  }

  createTag(ctx: TenantContext, input: ConversationTagInput) {
    return this.db.scoped(ctx, async (tx) => {
      // Serialise creations per restaurant so the limit holds under concurrent requests.
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('conversation_tags:' || $1::text, 0))`, [ctx.orgId]);
      const { n } = await tx.one<{ n: number }>(`select count(*)::int as n from conversation_tags where org_id = $1`, [ctx.orgId]);
      if (n >= CONVERSATION_TAG_LIMITS.perOrg) throw invalid('tag_limit_reached', `A restaurant can have up to ${CONVERSATION_TAG_LIMITS.perOrg} conversation tags`);
      let row;
      try {
        row = await tx.one(`insert into conversation_tags(org_id, name, color, created_by) values ($1, $2, $3, $4) returning *`,
          [ctx.orgId, input.name, input.color, ctx.userId]);
      } catch (e) {
        if (isUnique(e)) throw conflict('tag_name_taken', 'A tag with this name already exists');
        throw e;
      }
      await this.audit.record(tx, ctx, { action: 'connect.tag_created', entityType: 'conversation_tag', entityId: row.id, metadata: { name: row.name, color: row.color } });
      return tagView(row);
    });
  }

  updateTag(ctx: TenantContext, id: string, input: ConversationTagUpdate) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne(`select * from conversation_tags where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
      if (!r) throw notFound('Tag');
      let row;
      try {
        row = await tx.one(`update conversation_tags set name = coalesce($2, name), color = coalesce($3, color) where id = $1 returning *`,
          [id, input.name ?? null, input.color ?? null]);
      } catch (e) {
        if (isUnique(e)) throw conflict('tag_name_taken', 'A tag with this name already exists');
        throw e;
      }
      await this.audit.record(tx, ctx, { action: 'connect.tag_updated', entityType: 'conversation_tag', entityId: id,
        metadata: { fields: Object.keys(input), previousName: r.name } });
      return tagView(row);
    });
  }

  /** Deletes the tag and removes it from every conversation. */
  deleteTag(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<{ id: string; name: string }>(`delete from conversation_tags where id = $1 and org_id = $2 returning id, name`, [id, ctx.orgId]);
      if (!r) throw notFound('Tag');
      await this.audit.record(tx, ctx, { action: 'connect.tag_deleted', entityType: 'conversation_tag', entityId: id, metadata: { name: r.name } });
      return { id, deleted: true };
    });
  }

  /** Idempotent: assigning a tag the conversation already has changes nothing. */
  assignTag(ctx: TenantContext, conversationId: string, tagId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await this.conversation(tx, ctx, conversationId);
      const tag = await tx.maybeOne<{ id: string; name: string }>(`select id, name from conversation_tags where id = $1 and org_id = $2`, [tagId, ctx.orgId]);
      if (!tag) throw notFound('Tag');
      // Lock the conversation so concurrent assignments cannot pass the per-conversation limit together.
      await tx.query(`select 1 from conversations where id = $1 for update`, [conversationId]);
      const has = await tx.maybeOne(`select 1 from conversation_tag_assignments where conversation_id = $1 and tag_id = $2`, [conversationId, tagId]);
      if (!has) {
        const { n } = await tx.one<{ n: number }>(`select count(*)::int as n from conversation_tag_assignments where conversation_id = $1`, [conversationId]);
        if (n >= CONVERSATION_TAG_LIMITS.perConversation) {
          throw invalid('tag_limit_reached', `A conversation can carry up to ${CONVERSATION_TAG_LIMITS.perConversation} tags`);
        }
        await tx.query(`insert into conversation_tag_assignments(org_id, conversation_id, tag_id, assigned_by) values ($1, $2, $3, $4)`,
          [ctx.orgId, conversationId, tagId, ctx.userId]);
        await this.audit.record(tx, ctx, { action: 'connect.tag_assigned', entityType: 'conversation', entityId: conversationId, branchId: c.branch_id,
          metadata: { tagId, name: tag.name } });
      }
      return { conversationId, tags: (await tagsByConversation(tx, [conversationId])).get(conversationId) ?? [] };
    });
  }

  /** Idempotent: removing a tag the conversation does not carry changes nothing (the tag itself must exist). */
  removeTag(ctx: TenantContext, conversationId: string, tagId: string) {
    return this.db.scoped(ctx, async (tx) => {
      const c = await this.conversation(tx, ctx, conversationId);
      const tag = await tx.maybeOne<{ id: string; name: string }>(`select id, name from conversation_tags where id = $1 and org_id = $2`, [tagId, ctx.orgId]);
      if (!tag) throw notFound('Tag');
      const removed = await tx.maybeOne(`delete from conversation_tag_assignments where conversation_id = $1 and tag_id = $2 returning tag_id`, [conversationId, tagId]);
      if (removed) {
        await this.audit.record(tx, ctx, { action: 'connect.tag_removed', entityType: 'conversation', entityId: conversationId, branchId: c.branch_id,
          metadata: { tagId, name: tag.name } });
      }
      return { conversationId, tags: (await tagsByConversation(tx, [conversationId])).get(conversationId) ?? [] };
    });
  }

  // ---------------------------------------------------------------------------
  // Saved replies
  // ---------------------------------------------------------------------------
  listReplies(ctx: TenantContext, q: SavedReplyListQuery) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    const k = keyset(q.cursor, { atType: 'text', direction: 'asc' });
    const text = q.q ? escapeLike(q.q) : null;
    return this.db.scoped(ctx, async (tx) => pageOf(await tx.query(
      `select *, lower(title) as sort_key from saved_replies
        where org_id = $1
          and ($2::uuid[] is null or branch_id is null or branch_id = any($2::uuid[]))
          and ($3::uuid is null or branch_id is null or branch_id = $3)
          and ($4::text is null or shortcut = $4)
          and ($5::text is null or title ilike '%' || $5 || '%' or shortcut ilike '%' || $5 || '%'
               or body_en ilike '%' || $5 || '%' or body_ar ilike '%' || $5 || '%')
          ${k.after('lower(title)', 'id', 6)}
        order by lower(title), id limit ${k.fetch(q.limit)}`,
      [ctx.orgId, ctx.branchFilter, q.branchId ?? null, q.shortcut ?? null, text, ...k.params]), q.limit, (r) => ({ at: r.sort_key, id: r.id }), replyView));
  }

  /**
   * Who may write a reply in a scope: an organization-wide reply (branch null) is used by every branch, so only staff
   * with access to every branch may create, change or delete one; a branch reply needs access to that branch.
   */
  private assertReplyScope(ctx: TenantContext, branchId: string | null) {
    if (branchId === null) {
      if (ctx.branchFilter !== null) throw forbidden('Saved replies for every branch need access to every branch; choose one of your branches');
      return;
    }
    ctx.assertBranch(branchId);
  }

  private async assertBranchExists(tx: Tx, ctx: TenantContext, branchId: string | null) {
    if (branchId && !(await tx.maybeOne(`select 1 from branches where id = $1 and org_id = $2`, [branchId, ctx.orgId]))) {
      throw invalid('unknown_branch', 'This branch does not exist');
    }
  }

  createReply(ctx: TenantContext, input: SavedReplyInput) {
    const branchId = input.branchId ?? null;
    this.assertReplyScope(ctx, branchId);
    return this.db.scoped(ctx, async (tx) => {
      await this.assertBranchExists(tx, ctx, branchId);
      await tx.query(`select pg_advisory_xact_lock(hashtextextended('saved_replies:' || $1::text, 0))`, [ctx.orgId]);
      const { n } = await tx.one<{ n: number }>(`select count(*)::int as n from saved_replies where org_id = $1`, [ctx.orgId]);
      if (n >= SAVED_REPLY_LIMIT_PER_ORG) throw invalid('saved_reply_limit_reached', `A restaurant can keep up to ${SAVED_REPLY_LIMIT_PER_ORG} saved replies`);
      let row;
      try {
        row = await tx.one(
          `insert into saved_replies(org_id, branch_id, title, shortcut, body_en, body_ar, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $7) returning *`,
          [ctx.orgId, branchId, input.title, input.shortcut ?? null, input.bodyEn ?? null, input.bodyAr ?? null, ctx.userId]);
      } catch (e) {
        if (isUnique(e)) throw conflict('shortcut_taken', 'Another saved reply in this scope already uses this shortcut');
        throw e;
      }
      await this.audit.record(tx, ctx, { action: 'connect.saved_reply_created', entityType: 'saved_reply', entityId: row.id, branchId,
        metadata: { title: row.title, shortcut: row.shortcut } });
      return replyView(row);
    });
  }

  updateReply(ctx: TenantContext, id: string, input: SavedReplyUpdate) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.lockReply(tx, ctx, id);
      const branchId = input.branchId !== undefined ? input.branchId : r.branch_id;
      if (input.branchId !== undefined && input.branchId !== r.branch_id) {
        this.assertReplyScope(ctx, branchId);
        await this.assertBranchExists(tx, ctx, branchId);
      }
      const bodyEn = input.bodyEn !== undefined ? input.bodyEn : r.body_en;
      const bodyAr = input.bodyAr !== undefined ? input.bodyAr : r.body_ar;
      if (!bodyEn && !bodyAr) throw invalid('reply_body_required', 'Keep the reply in English, Arabic or both');
      let row;
      try {
        row = await tx.one(
          `update saved_replies set title = $2, shortcut = $3, body_en = $4, body_ar = $5, branch_id = $6, updated_by = $7 where id = $1 returning *`,
          [id, input.title ?? r.title, input.shortcut !== undefined ? input.shortcut : r.shortcut, bodyEn ?? null, bodyAr ?? null, branchId, ctx.userId]);
      } catch (e) {
        if (isUnique(e)) throw conflict('shortcut_taken', 'Another saved reply in this scope already uses this shortcut');
        throw e;
      }
      await this.audit.record(tx, ctx, { action: 'connect.saved_reply_updated', entityType: 'saved_reply', entityId: id, branchId,
        metadata: { fields: Object.keys(input) } });
      return replyView(row);
    });
  }

  deleteReply(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.lockReply(tx, ctx, id);
      await tx.query(`delete from saved_replies where id = $1`, [id]);
      await this.audit.record(tx, ctx, { action: 'connect.saved_reply_deleted', entityType: 'saved_reply', entityId: id, branchId: r.branch_id,
        metadata: { title: r.title } });
      return { id, deleted: true };
    });
  }

  /** A reply the caller may change: invisible (other restaurant or branch) is a 404, organization-wide needs every branch. */
  private async lockReply(tx: Tx, ctx: TenantContext, id: string) {
    const r = await tx.maybeOne(`select * from saved_replies where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
    if (!r || !ctx.canAccessBranch(r.branch_id)) throw notFound('Saved reply');
    this.assertReplyScope(ctx, r.branch_id);
    return r;
  }
}
