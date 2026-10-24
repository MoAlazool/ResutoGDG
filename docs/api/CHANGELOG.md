# API changelog

Changes to the public API (`/v1`). Changes are additive; a breaking change ships as a new route next to the old one,
which answers with a `Deprecation` header and is listed here (policy: `docs/api/IPAD_COMPATIBILITY.md`). The full
description is `docs/api/openapi.json` (regenerate: `UPDATE_OPENAPI=1 npx vitest run test/openapi.test.ts` in
`apps/api`).

## Unreleased

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
