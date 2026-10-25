# API changelog

Changes to the public API (`/v1`). Changes are additive; a breaking change ships as a new route next to the old one,
which answers with a `Deprecation` header and is listed here (policy: `docs/api/IPAD_COMPATIBILITY.md`). The full
description is `docs/api/openapi.json` (regenerate: `UPDATE_OPENAPI=1 npx vitest run test/openapi.test.ts` in
`apps/api`).

## Unreleased

### Added — Inbox workspace and Customer 360, increment 1 (21-INBOX)

- Internal notes: `POST /v1/o/:orgId/connect/conversations/:id/notes` (`connect:reply`, idempotent by `key`) and
  `GET /v1/o/:orgId/connect/conversations/:id/notes` (`connect:read`). Notes are staff-only (`messages.kind = 'note'`,
  direction `internal`): never sent, never queued, not in the customer thread, and they leave the unread count, the
  last message and the 24-hour window unchanged. `GET .../conversations/:id` gains `notes` (latest 50) and `tags`;
  its `messages` never include notes.
- Conversation tags: `GET|POST /v1/o/:orgId/connect/tags`, `PATCH|DELETE /v1/o/:orgId/connect/tags/:tagId`
  (`connect:read` to list, `connect:manage` to change), `PUT|DELETE /v1/o/:orgId/connect/conversations/:id/tags/:tagId`
  (`connect:reply`, idempotent). `GET .../connect/conversations` accepts `tagId` and each item gains `tags`.
- Saved replies: `GET|POST /v1/o/:orgId/connect/saved-replies`, `PATCH|DELETE /v1/o/:orgId/connect/saved-replies/:replyId`
  (`connect:read` to list, `connect:manage` to change; organization-wide or per branch, optional `/` shortcut).
- Customer 360: `GET /v1/o/:orgId/customers/:id/360` (`customers:read`; conversation parts need `connect:read` and the
  Connect module, loyalty the Marketing module, reported in `sections`). Contract: `Customer360` in
  `packages/contracts/src/inbox.ts`.
- Error codes: `reply_body_required`, `saved_reply_limit_reached`, `shortcut_taken`, `tag_limit_reached`,
  `tag_name_taken`.

No existing route changed (checked with `scripts/openapi/additive.mjs` against the previous document).

### Added — Free QR menu onboarding, increment 1 (21-ONB)

- `GET /v1/orgs/slug-availability?slug=` (signed-in people): `{ slug, available, reason }` with `reason`
  `invalid | reserved | taken | null`. Reserved words (app routes, infrastructure hosts, official-sounding names) are
  `RESERVED_SLUGS` in `@resuto/contracts`; `POST /v1/orgs` now refuses them with `422 slug_reserved`.
- `GET /v1/o/:orgId/social-links` (members) and `PUT /v1/o/:orgId/social-links` (`org:manage`, replaces the set):
  https links for `instagram`, `facebook`, `tiktok`, `x`, `snapchat`, `whatsapp`, `google_maps`, `website`, each
  checked against the network's own hosts. `GET /v1/o/:orgId` gains `socialLinks`.
- `GET /v1/o/:orgId/menu-qr?branch=` (`menu:read`): the view-only menu QR `{ kind: 'menu', url, branchCode, svg, png }`
  pointing at `/m/<slug>` (no token; never an ordering QR).
- Response fields: `org.socialLinks` on `GET /v1/public/menu/:slug` (and the guest menus built the same way) and on
  `GET /v1/public/sites/:slug`; `planId` on `GET /v1/o/:orgId/setup` and `POST /v1/o/:orgId/setup/launch`, and
  `detail.optional` on the profile step.
- Behaviour: setup requirements follow the plan and service model. On Free (and without a live subscription) the
  legal name, floor and payments steps are optional; on paid plans the floor is required only for table service.
  Entitlements: without a live subscription a restaurant keeps the free plan's modules (`app.module_enabled`), so a
  lapsed trial keeps `core`; `GET /v1/o/:orgId/billing/entitlements` reports those with source `plan`.
- Error code: `slug_reserved`.

No existing route was removed or made stricter for its existing inputs except `POST /v1/orgs` with a reserved address
(checked with `scripts/openapi/additive.mjs`).

### Added — POS device API, contract 0.1.0 (21-POSAPI, draft)

For the native iPad POS app (`feature/ipad-pos`). Every route and event is listed with its status in
`docs/api/IPAD_COMPATIBILITY.md`.

- Device pairing and auth: `POST /v1/o/:orgId/pos/pairings`, `GET /v1/o/:orgId/pos/devices`,
  `GET /v1/o/:orgId/pos/devices/:id`, `POST /v1/o/:orgId/pos/devices/:id/revoke` (staff, new permission
  `devices:manage` for owner, admin and manager) and `POST /v1/pos/pair` (public). Device credentials `rpos_...`
  (security scheme `posDeviceAuth`) are scoped to one organization, branch and acting role (waiter, cashier,
  kitchen) and accepted only on `/v1/pos/...`.
- Session and sync: `GET /v1/pos/session`, `GET /v1/pos/sync/menu`, `GET /v1/pos/sync/floor`, `GET /v1/pos/sync/orders`.
- Ordered per-branch event feed: `GET /v1/pos/events` (`after`, `epoch`, long-poll `wait`); kinds `order.created`,
  `order.updated`, `ticket.status_changed`, `payment.captured`, `payment.refunded`, `menu.changed`,
  `availability.changed`, `table.changed`, `print_job.created`.
- Orders: `POST /v1/pos/orders/quote`, `POST /v1/pos/orders` (idempotent by `clientOrderId`, server-authoritative
  prices and availability), `GET /v1/pos/orders/:id`, `POST /v1/pos/orders/:id/transition` (version required),
  `POST /v1/pos/orders/:id/payments` (idempotent by `clientPaymentId`), `POST /v1/pos/orders/:id/receipt`.
- Kitchen: `GET /v1/pos/kitchen/routing`, `GET /v1/pos/kitchen/tickets`, `POST /v1/pos/kitchen/orders/:id/bump`
  (version required), `POST /v1/pos/kitchen/lines/:lineId`.
- Print jobs: `GET /v1/pos/print-jobs`, `GET /v1/pos/print-jobs/:id`, `POST /v1/pos/print-jobs/:id/claim`,
  `POST /v1/pos/print-jobs/:id/complete`.
- Error codes: `client_order_id_reused`, `client_request_id_reused`, `device_expired`, `device_revoked`,
  `pairing_code_invalid`, `pos_device_only`, `pos_device_required`, `pos_items_unavailable`, `pos_price_changed`,
  `print_job_claimed`, `print_job_completed`, `print_job_not_claimed`, `resync_required`.
- Audit log entries may now have actor type `device`.

No existing route changed (checked with `scripts/openapi/additive.mjs` against the previous document; CI runs it on
every pull request). A device credential sent to any other route is refused with `403 pos_device_only`; staff
tokens are refused on the device routes with `403 pos_device_required`.
