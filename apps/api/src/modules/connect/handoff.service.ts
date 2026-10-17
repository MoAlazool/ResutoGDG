import { Injectable } from '@nestjs/common';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { OutboxService } from '../../common/platform/outbox.service';

/**
 * Human handoff. While a handoff is open (requested or accepted) the
 * conversation status is 'handoff' and the bot does not answer.
 */
@Injectable()
export class HandoffService {
  constructor(private readonly outbox: OutboxService) {}

  async open(tx: Tx, ctx: TenantContext, conversationId: string, reason: string, acceptedBy: string | null) {
    const existing = await tx.maybeOne<{ id: string; status: string }>(`select id, status from handoffs where conversation_id = $1 and status <> 'resolved'`, [conversationId]);
    let id = existing?.id;
    if (!existing) {
      id = (await tx.one<{ id: string }>(
        `insert into handoffs(org_id, conversation_id, reason, status, accepted_by, accepted_at)
         values ($1, $2, $3, $4, $5, case when $5::uuid is not null then now() end) returning id`,
        [ctx.orgId, conversationId, reason.slice(0, 300), acceptedBy ? 'accepted' : 'requested', acceptedBy])).id;
      await this.outbox.publish(tx, ctx.orgId, { type: 'conversation.handoff_requested', aggregateType: 'conversation', aggregateId: conversationId, payload: { handoffId: id, reason } });
    } else if (acceptedBy && existing.status === 'requested') {
      await tx.query(`update handoffs set status = 'accepted', accepted_by = $2, accepted_at = now() where id = $1`, [existing.id, acceptedBy]);
    }
    await tx.query(`update conversations set status = 'handoff', assigned_to = coalesce($2, assigned_to) where id = $1`, [conversationId, acceptedBy]);
    return { id: id!, created: !existing };
  }

  async resolve(tx: Tx, conversationId: string) {
    await tx.query(`update handoffs set status = 'resolved', resolved_at = now() where conversation_id = $1 and status <> 'resolved'`, [conversationId]);
    await tx.query(`update conversations set status = case when status = 'handoff' then 'bot' else status end where id = $1`, [conversationId]);
  }
}
