// Domain event names published through the transactional outbox.
// Consumers must be idempotent: events are delivered at least once.
export const DOMAIN_EVENTS = [
  'organization.created',
  'member.invited', 'member.joined',
  'subscription.changed',
  'menu.updated',
  'order.placed', 'order.status_changed', 'order.cancelled', 'order.paid',
  'visit.opened', 'visit.closed',
  'reservation.created', 'reservation.confirmed', 'reservation.cancelled', 'reservation.seated',
  'payment.succeeded', 'payment.failed', 'payment.refunded',
  'checkout.created', 'checkout.paid',
  'delivery.created', 'delivery.assigned', 'delivery.status_changed',
  'message.inbound', 'message.outbound_queued',
  'conversation.handoff_requested',
  'campaign.approved', 'campaign.scheduled',
  'stock.low',
  'compliance.document_expiring',
  'fiscal_document.issued',
  'mcp.approval_requested',
  'customer.merged', 'customer.anonymised',
  'website.published',
  // ws7b (wave 4): a POS reported a menu change (Foodics menu.updated nudge) → schedule a pull sync.
  'integration.menu_changed',
] as const;
export type DomainEventType = (typeof DOMAIN_EVENTS)[number];
