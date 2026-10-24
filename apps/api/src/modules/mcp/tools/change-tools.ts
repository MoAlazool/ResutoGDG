// 21-MCP: typed write tools on the change-set engine (docs/architecture/CHANGE_SETS.md). A tool only turns its typed
// parameters into change-set ops; McpExecutionService proposes them with the connection as the actor. The engine
// validates every op (records in this tenant, branch scope, domain bounds), previews the before/after, and routes the
// set by the restaurant's approval policy made stricter by the connection's overrides: applied at once, waiting for a
// person (approval_required, poll get_approval_status) or refused (change_blocked). There is no free text that becomes
// code or SQL: every parameter is typed by the contracts.
import { MCP_CHANGE_CONTROLS, type ChangeOpType } from '@resuto/contracts';
import { notFound } from '../../../common/errors/domain-error';
import { iso } from '../mcp.util';
import { defineTool, type McpChangeProposal, type McpTool } from './types';

/** The op input: the tool's parameters without the change controls (idempotencyKey, previewOnly). */
function opInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (!(MCP_CHANGE_CONTROLS as readonly string[]).includes(k) && v !== undefined) out[k] = v;
  return out;
}
const single = (title: string, type: ChangeOpType, input: Record<string, unknown>): McpChangeProposal => ({ title, ops: [{ type, input: opInput(input) }] });

const headline = (c: any): string | null => {
  const h = c?.headline;
  if (typeof h === 'string') return h;
  return h?.en || h?.ar || null;
};

const CHANGE_NOTE = 'Goes through the restaurant\'s approval policy: it applies at once, waits for a team member (approval_required: poll get_approval_status with the changeSetId) or is refused. previewOnly: true shows the before/after without proposing.';

export const changeTools: McpTool[] = [
  defineTool('update_menu_item', {
    description: `Edit a menu item: name, Arabic name, descriptions, or whether it is listed. ${CHANGE_NOTE}`,
    changes: (i) => single('Edit a menu item', 'menu.item.update', i),
  }),

  defineTool('set_item_price', {
    description: `Change a menu item's base price (minor units). Prices need approval by default and may move at most 10x at once. ${CHANGE_NOTE}`,
    changes: (i) => single('Change a price', 'menu.item.price.set', i),
  }),

  defineTool('create_promotion', {
    description: `Create an offer: percent (value in basis points, 1500 = 15%, 1–90%), fixed (minor units) or free delivery, optionally with a code, branches, channels and dates. Offers above the owner's threshold (default 30%) need the owner. ${CHANGE_NOTE}`,
    changes: (i) => single(`Create the offer "${i.name}"`, 'promotion.create', i),
  }),

  defineTool('get_website_draft', {
    description: 'The website draft: its sections (id, kind, headline, visibility, featured menu items) and the draft and published revisions. Use the section ids with draft_website_change.',
    async handler(tx, ctx) {
      const w = await tx.maybeOne<any>('select id, status, draft_revision, published_revision from websites where org_id = $1', [ctx.orgId]);
      if (!w) throw notFound('Website');
      const rows = await tx.query<any>(
        `select id, kind, sort_order, is_visible, content, updated_at from website_sections where org_id = $1 and website_id = $2
          order by sort_order, id limit 100`, [ctx.orgId, w.id]);
      return {
        websiteId: w.id, draftRevision: w.draft_revision, publishedRevision: w.published_revision, status: w.status,
        sections: rows.map((s) => ({
          id: s.id, kind: s.kind, position: s.sort_order, isVisible: s.is_visible, headline: headline(s.content),
          productIds: Array.isArray(s.content?.productIds) ? s.content.productIds.map(String) : [], updatedAt: iso(s.updated_at)!,
        })),
      };
    },
  }),

  defineTool('draft_website_change', {
    description: `Add a section to the website draft (give kind and content) or edit one (give sectionId and content or isVisible). Visitors see nothing until the website is published. ${CHANGE_NOTE}`,
    changes: (i) => (i.sectionId
      ? single('Edit a website section', 'website.section.update', { sectionId: i.sectionId, content: i.content, isVisible: i.isVisible })
      : single(`Add a ${i.kind} section to the website`, 'website.section.add', { kind: i.kind, content: i.content ?? {}, isVisible: i.isVisible ?? true })),
  }),

  defineTool('publish_website_revision', {
    description: `Publish the current website draft as the next revision. Any later draft edit before approval invalidates the request. ${CHANGE_NOTE}`,
    changes: (i) => single('Publish the website', 'website.publish', i),
  }),

  defineTool('create_reservation', {
    description: `Book a confirmed table (no deposit) for a party at one branch, at a date and time in the restaurant's timezone. ${CHANGE_NOTE}`,
    changes: (i) => single(`Book a table for ${i.partySize}`, 'reservation.create', i),
  }),

  defineTool('update_order_status', {
    description: `Move an order to its next status (accepted, preparing, ready, served, picked up, delivered). Bound to the connection's role: the kitchen role prepares, the waiter role serves; cancelling stays a staff action. ${CHANGE_NOTE}`,
    changes: (i) => single('Update an order status', 'order.status.set', i),
  }),

  defineTool('propose_changes', {
    description: `Propose several typed changes as ONE change set, applied together or not at all (for example: an "Eid offers" website section featuring three dishes, a 15% offer and publishing the website). Every op is validated first; nothing is stored when one is invalid. Each op needs the matching single-op tool on this connection. ${CHANGE_NOTE}`,
    changes: (i) => ({ title: i.title, summary: i.summary ?? null, ops: i.ops.map((o) => ({ type: o.type, input: o.input as Record<string, unknown> })) }),
  }),
];
