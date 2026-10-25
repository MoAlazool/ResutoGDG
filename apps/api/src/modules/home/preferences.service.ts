import { Injectable } from '@nestjs/common';
import {
  defaultOverviewPreferences, normaliseOverviewPreferences, type OverviewPreferencesInput, type OverviewPreferencesResponse,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { forbidden } from '../../common/errors/domain-error';
import { iso } from '../analytics/scope';

/**
 * Per-user overview layout (21-HOME "Customise"): which sections show and in which order. Stored in user_preferences,
 * whose RLS lets a staff session read and write only its own user's rows in the current restaurant. Only a signed-in
 * staff member has preferences; any other actor is refused.
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly db: DbService) {}

  private userOf(ctx: TenantContext): string {
    if (ctx.actorType !== 'user' || !ctx.userId) throw forbidden('Only a signed-in staff member has overview preferences');
    return ctx.userId;
  }

  async getOverview(ctx: TenantContext): Promise<OverviewPreferencesResponse> {
    const userId = this.userOf(ctx);
    const row = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ value: unknown; updated_at: Date }>(
      `select value, updated_at from user_preferences where org_id = $1 and user_id = $2 and scope = 'overview'`, [ctx.orgId, userId]));
    return row
      ? { scope: 'overview', value: normaliseOverviewPreferences(row.value), isDefault: false, updatedAt: iso(row.updated_at) }
      : { scope: 'overview', value: defaultOverviewPreferences(), isDefault: true, updatedAt: null };
  }

  async putOverview(ctx: TenantContext, input: OverviewPreferencesInput): Promise<OverviewPreferencesResponse> {
    const userId = this.userOf(ctx);
    // Sections the client did not send (an older page) are kept, visible, at the end.
    const value = normaliseOverviewPreferences(input);
    const row = await this.db.scoped(ctx, (tx) => tx.one<{ updated_at: Date }>(
      `insert into user_preferences(org_id, user_id, scope, value) values ($1, $2, 'overview', $3)
       on conflict (org_id, user_id, scope) do update set value = excluded.value
       returning updated_at`, [ctx.orgId, userId, value]));
    return { scope: 'overview', value, isDefault: false, updatedAt: iso(row.updated_at) };
  }
}
