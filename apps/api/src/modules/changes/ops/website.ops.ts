import { CHANGE_OPS, changeOpInputs, type ChangeOpInput } from '@resuto/contracts';
import type { TenantContext } from '../../../common/auth/context';
import type { Tx } from '../../../common/db/db.service';
import { notFound } from '../../../common/errors/domain-error';
import type { StudioService } from '../../studio/studio.service';
import { isoOrNull, type OpHandler } from '../op-handler';

type SectionAdd = ChangeOpInput<'website.section.add'>;
type SectionUpdate = ChangeOpInput<'website.section.update'>;
type Publish = ChangeOpInput<'website.publish'>;

async function website(tx: Tx, ctx: TenantContext, lock: boolean) {
  const w = await tx.maybeOne<{ id: string; draft_revision: number; published_revision: number }>(
    `select id, draft_revision, published_revision from websites where org_id = $1 ${lock ? 'for update' : ''}`, [ctx.orgId]);
  if (!w) throw notFound('Website');
  return w;
}

async function productNames(tx: Tx, ctx: TenantContext, ids: string[] | undefined) {
  if (!ids?.length) return [];
  const rows = await tx.query<{ id: string; name: string }>('select id, name from products where org_id = $1 and id = any($2::uuid[])', [ctx.orgId, ids]);
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return ids.map((id) => byId.get(id) ?? id);
}

const headline = (c: { headline?: { en?: string; ar?: string } } | undefined) => c?.headline?.en || c?.headline?.ar || '';

export function websiteOps(deps: { studio: StudioService }): OpHandler[] {
  const sectionAdd: OpHandler<SectionAdd> = {
    type: 'website.section.add', meta: CHANGE_OPS['website.section.add'], input: changeOpInputs['website.section.add'],
    async validate(tx, ctx, input) {
      const w = await website(tx, ctx, false);
      await deps.studio.assertCanAddSection(tx, ctx, w.id, input);
    },
    async snapshot(tx, ctx, _input, lock) {
      // Adding a section does not depend on the other draft sections: no version, the limits are re-checked on apply.
      const w = await website(tx, ctx, lock);
      return { target: { type: 'website', id: w.id }, version: null, before: null };
    },
    async preview(tx, ctx, input) {
      const names = await productNames(tx, ctx, input.content.productIds);
      const title = headline(input.content as any);
      return {
        summary: `Add a ${input.kind} section${title ? ` "${title}"` : ''} to the website draft${names.length ? ` with ${names.length} menu item${names.length === 1 ? '' : 's'}` : ''}`,
        changes: [
          { label: 'Website section', before: null, after: `${input.kind}${title ? `: ${title}` : ''}${input.isVisible ? '' : ' (hidden)'}` },
          ...(names.length ? [{ label: 'Menu items', before: null, after: names.join(', ') }] : []),
        ],
        after: { kind: input.kind, isVisible: input.isVisible, content: input.content },
      };
    },
    async applyLocal(tx, ctx, input) {
      const s = await deps.studio.createSectionTx(tx, ctx, input);
      return { sectionId: s.id, kind: s.kind };
    },
  };

  async function section(tx: Tx, ctx: TenantContext, id: string, lock: boolean) {
    const s = await tx.maybeOne<any>(`select id, kind, content, is_visible, updated_at from website_sections where org_id = $1 and id = $2 ${lock ? 'for update' : ''}`,
      [ctx.orgId, id]);
    if (!s) throw notFound('Section');
    return s;
  }

  const sectionUpdate: OpHandler<SectionUpdate> = {
    type: 'website.section.update', meta: CHANGE_OPS['website.section.update'], input: changeOpInputs['website.section.update'],
    async validate(tx, ctx, input) {
      await section(tx, ctx, input.sectionId, false);
      if (input.content) await deps.studio.assertSectionContent(tx, ctx, input.content);
    },
    async snapshot(tx, ctx, input, lock) {
      const s = await section(tx, ctx, input.sectionId, lock);
      return {
        target: { type: 'website_section', id: s.id }, version: isoOrNull(s.updated_at),
        before: { ...(input.content !== undefined ? { content: s.content ?? {} } : {}), ...(input.isVisible !== undefined ? { isVisible: s.is_visible } : {}) },
      };
    },
    async preview(tx, ctx, input, snap) {
      const s = await section(tx, ctx, input.sectionId, false);
      const changes = [];
      if (input.content !== undefined) changes.push({ label: `${s.kind} section content`, before: headline(snap.before?.content as any) || '(content)', after: headline(input.content as any) || '(new content)' });
      if (input.isVisible !== undefined) changes.push({ label: `${s.kind} section visible`, before: snap.before?.isVisible ? 'yes' : 'no', after: input.isVisible ? 'yes' : 'no' });
      return {
        summary: `Edit the ${s.kind} section of the website draft`, changes,
        after: { ...(input.content !== undefined ? { content: input.content } : {}), ...(input.isVisible !== undefined ? { isVisible: input.isVisible } : {}) },
      };
    },
    async applyLocal(tx, ctx, input) {
      const s = await deps.studio.updateSectionTx(tx, ctx, input.sectionId, { content: input.content, isVisible: input.isVisible });
      return { sectionId: s.id };
    },
  };

  const publish: OpHandler<Publish> = {
    type: 'website.publish', meta: CHANGE_OPS['website.publish'], input: changeOpInputs['website.publish'], runsLast: true,
    async validate(tx, ctx) {
      await website(tx, ctx, false);
    },
    async snapshot(tx, ctx, _input, lock) {
      // The draft that was reviewed is the draft that is published: any other draft edit invalidates the set.
      const w = await website(tx, ctx, lock);
      return { target: { type: 'website', id: w.id }, version: `draft:${w.draft_revision}`, before: { publishedRevision: w.published_revision, draftRevision: w.draft_revision } };
    },
    async preview(_tx, _ctx, input, snap) {
      const next = Number(snap.before?.publishedRevision ?? 0) + 1;
      return {
        summary: `Publish the website (revision ${next})${input.note ? `: ${input.note}` : ''}`,
        changes: [{ label: 'Published revision', before: String(snap.before?.publishedRevision ?? 0), after: String(next) }],
        after: { publishedRevision: next },
      };
    },
    async applyLocal(tx, ctx, input) {
      return deps.studio.publishTx(tx, ctx, input.note ?? null);
    },
  };

  return [sectionAdd, sectionUpdate, publish];
}
