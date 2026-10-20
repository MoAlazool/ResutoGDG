import type { AnalyticsMeta, AnalyticsPeriodQuery, RatingsSummary } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { branchScope } from './scope';

const avg = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);

/**
 * Guest satisfaction (legacy manager Analytics: overall + food/service/speed/value with counts; VS-27). Ratings are
 * bucketed by their branch's local date. Comments are the guests' own words; no guest identity is stored with them.
 */
export async function ratingsSummary(tx: Tx, ctx: TenantContext, q: AnalyticsPeriodQuery): Promise<RatingsSummary & { meta: AnalyticsMeta }> {
  const scope = branchScope(ctx, q.branchId);
  const scoped = `scoped as (
    select r.*, coalesce(b.timezone, o.timezone) as tz from guest_ratings r join branches b on b.id = r.branch_id join organizations o on o.id = r.org_id
     where r.org_id = $1 and ($2::uuid[] is null or r.branch_id = any($2))
       and r.created_at >= (($3::date - 1)::timestamp at time zone 'UTC') and r.created_at < (($4::date + 2)::timestamp at time zone 'UTC')
       and (r.created_at at time zone coalesce(b.timezone, o.timezone))::date between $3::date and $4::date)`;
  const params = [ctx.orgId, scope, q.from, q.to];
  const [t] = await tx.query<any>(
    `with ${scoped} select count(*)::int as n, avg(overall) as overall, avg(food) as food, avg(service) as service, avg(speed) as speed, avg(value) as value,
        count(*) filter (where overall = 1)::int as s1, count(*) filter (where overall = 2)::int as s2, count(*) filter (where overall = 3)::int as s3,
        count(*) filter (where overall = 4)::int as s4, count(*) filter (where overall = 5)::int as s5,
        count(*) filter (where food is not null or service is not null or speed is not null or value is not null)::int as detailed
       from scoped`, params);
  const bySource = await tx.query<any>(`with ${scoped} select source, count(*)::int as n, avg(overall) as a from scoped group by source order by source`, params);
  const comments = await tx.query<any>(
    `with ${scoped} select created_at, overall, comment, source from scoped where comment is not null order by created_at desc limit 12`, params);
  const tz = (await tx.one<{ timezone: string }>('select timezone from organizations where id = $1', [ctx.orgId])).timezone;
  return {
    from: q.from, to: q.to, count: t.n,
    averages: { overall: avg(t.overall), food: avg(t.food), service: avg(t.service), speed: avg(t.speed), value: avg(t.value) },
    distribution: [t.s1, t.s2, t.s3, t.s4, t.s5],
    bySource: bySource.map((r) => ({ source: r.source, count: r.n, average: avg(r.a) })),
    comments: comments.map((c) => ({ at: new Date(c.created_at).toISOString(), overall: c.overall, comment: c.comment, source: c.source })),
    meta: {
      method: 'Ratings guests left after paying (table bill, split share or web order), bucketed by the branch\'s local date. Averages are the mean of the scores given; the optional food, service, speed and value scores average only the ratings that include them.',
      assumptions: [],
      dataCoverage: { ratings: t.n, withDetailScores: t.detailed, withComments: comments.length },
      kind: 'measured', timezone: tz, generatedAt: new Date().toISOString(),
    },
  };
}
