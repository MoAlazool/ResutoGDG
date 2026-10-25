# API changelog

Changes to the public API (`/v1`). Changes are additive; a breaking change ships as a new route next to the old one,
which answers with a `Deprecation` header and is listed here (policy: `docs/api/IPAD_COMPATIBILITY.md`). The full
description is `docs/api/openapi.json` (regenerate: `UPDATE_OPENAPI=1 npx vitest run test/openapi.test.ts` in
`apps/api`).

## Unreleased

### Added — CRM, growth and funnels (21-CRM)

- `POST /v1/public/funnel/beacon` (public, 204): one first-party funnel event from a guest page, sent as a
  `text/plain` JSON body (`navigator.sendBeacon`) or JSON: `{ e: page_view | qr_scan | add_to_cart | checkout_started,
  s: r | m | order | t | v | reserve, o: <restaurant slug>, b?: <branch id>, sid: <random tab id> }` (strict; at most
  512 bytes). `qr_scan` only from `t`/`v`, cart events only from `order`/`t`/`v`. `400 validation_failed` stores
  nothing; `429 rate_limited` per client address (600/min, before the body is read) and per tab id (30/min); an
  unknown restaurant or an unsampled page view (1 in 4 tab sessions report page views) is dropped with the same 204.
  Stores no IP address, user agent, URL or customer; only a per-restaurant hash of the tab id
  (`docs/security/FUNNEL_BEACONS.md`).
- `GET /v1/o/:orgId/analytics/funnel` (`analytics:read`; `from`, `to`, `branchId`): `steps` visits → QR scans →
  messages → leads → orders → repeat and `cart` (add to cart, checkout started), each `{ key, value, unit, source,
  completeness: complete | partial | estimate | unavailable, notes, measured }`, plus `beaconsSince` and `meta`.
- `GET /v1/o/:orgId/analytics/retention` (`analytics:read`): monthly `cohorts` (as in `analytics/customers`) and
  `repeatCurve { asOf, newCustomers, points[{ day, eligible, repeated, pct }] }` for days 0–90.
- `GET /v1/o/:orgId/customers/:id/360`: `acquisition.firstTouch` gains `linkId` and `stored` (read from the new
  `customers.first_touch`, set once at the first identified interaction and never overwritten; derived as before
  when none is stored or the caller may not see it); `consent.channels[]` gains `contactBasis`
  (`marketing_consent | service_replies_only`: messaging the restaurant is never marketing consent).
- `GET /v1/o/:orgId/analytics/overview` (with a period): acquisition reads the stored first touch;
  `meta.dataCoverage.acquisitionStoredFirstTouch` counts how many new customers it covered. Messenger and Instagram
  first orders/conversations now count as `facebook` / `instagram` instead of `other_source`.
- Tracked link clicks record their link (`attribution_events.link_id`).

### Added — Menu workspace (21-MENU)

- `GET /v1/o/:orgId/menu` and the product responses of the menu editor (`GET`/`POST`/`PATCH …/menu/products…`):
  each product gains `compareAtMinor`, the price before a dish discount (`products.compare_at_price_minor`, set by the
  change-set op `product.discount.set`), or `null`. Read-only: the menu editor never writes it, and a regular price
  edit still ends the discount (`compareAtMinor` becomes `null`). No new endpoints; bulk edits in the web menu
  workspace use the existing per-product routes.

### Added — Saved Insights reports, last-year comparison (21-INSIGHTS)

- `GET /v1/o/:orgId/reports` (`analytics:read`, `limit` ≤ 200 default 100, `cursor`, `section`, `owner` all|mine|shared):
  the caller's saved reports and the reports colleagues shared, most recently changed first. Each report is
  `{ id, name, section, view { period, from?, to?, compare, filters }, branchId, shared, mine, authorName, createdAt,
  updatedAt }`.
- `POST /v1/o/:orgId/reports` (`analytics:read`, 201): saves a view (`section` one of `REPORT_SECTIONS`, the section's
  own filters only, `branchId` null = every branch the viewer can see, `shared` default false). `409
  saved_report_name_taken` (names are unique per member, ignoring case), `422 saved_report_limit_reached` (50 per
  member), `422 unknown_branch`, `403` for a branch outside the caller's scope, `429` past 30 writes a minute.
- `GET`/`PATCH`/`DELETE /v1/o/:orgId/reports/:reportId` (`analytics:read`): open a report; rename, re-save the view,
  move it to another branch or share/unshare it; delete it. Only the author changes or deletes a report (a colleague's
  shared report answers 404). Stored in the new `saved_reports` table (RLS: own rows, plus shared rows for roles with
  analytics:read; branch-scoped).
- `GET /v1/o/:orgId/analytics/summary` (and the other analytics period reports): `compare` accepts `last_year` (the
  same local dates one year earlier) besides `previous` and `none`, so a drill-down from the overview keeps its
  comparison.

### Added — payments list test/live filter (21-MONEY)

- `GET /v1/o/:orgId/payments` takes an optional `mode` (`test | live`): only sandbox (test) payments or only live
  ones; omitted lists both as before. It combines with the other filters and keeps the cursor. Same permission
  (`payments:read`, module `pay`); an unknown value is `400 validation_failed`.

### Added — Resuto Studio canvas workspace, section kinds, dish discounts, AI editing (21-STUDIO)

- Website sections: `kind` gains `promo_banner`, `offers`, `social`, `faq` and `menu_full`; section `content` gains
  optional `layout` `{ align, spacing, tone, columns }`, `promotionCode`, `badge` and `categoryIds`. The new kinds take
  only their own fields (`400 validation_failed` on create, `422 section_content_invalid` on edit); `menu_full`
  categories must be the restaurant's (`422 unknown_category`). Older kinds are unchanged.
- `GET /v1/public/sites/:slug` (and `by-host`): every dish (`menuHighlights`, offers, full menu) gains
  `compareAtMinor` (the price before a dish discount, only when above `priceMinor`); `offers` sections gain
  `content.products`, `offers`/`promo_banner` gain `content.promotion` (a live promotion named by code: code, name,
  kind, value, minimum order, end; never redemption counts) and `menu_full` gains `content.menu` (categories with
  their orderable dishes, at most 200).
- `POST /v1/o/:orgId/studio/website/template` (`studio:write`, 200): applies a style family × layout variant
  (`packages/contracts/src/studio-templates.ts`); answers the editor view plus `addedSectionIds`. `422 unknown_template`.
- `GET /v1/o/:orgId/studio/website/preview/change-sets/:changeSetId` (`studio:read`, and `changes:read` or the
  proposer): the draft as it will look once the change set applies, with `diff { changeSetId, added, changed,
  repriced }`. Nothing is written.
- `POST /v1/o/:orgId/studio/ai/proposals` (`studio:write`, `Idempotency-Key` required, 201): a request in plain words
  → one change set (origin `studio_ai`, always waiting for approval) plus `plan { planner: 'resuto_rules', model:
  null, notes }`. `422 ai_request_unclear`, `422 unknown_product`.
- Change sets: new op `product.discount.set` `{ productId, discountBps }` (group `prices`, `menu:write`; 1–90 %, `0`
  removes it; `422 discount_out_of_bounds`, `422 no_discount`). The price guests pay (`products.price_minor`) is the
  discounted one, so menus, checkout and POS sync see it as an ordinary price change; a regular price edit ends the
  discount. MCP `propose_changes` allows it only with `set_item_price`.

### Added — Integrations marketplace, operator console, WhatsApp official stepper (21-INT)

- `GET /v1/o/:orgId/integrations/catalog`: each item gains `connectMethod` (`oauth | embedded_signup |
  guided_onboarding | api_key | platform_managed`), `marketplaceCategory`, `requiredScopes`, `reviewRequirements` and
  `marketplace` `{ status, reasons, connectionId, providerReview }`. `status` is one of `not_connected | connected |
  needs_attention | sandbox | pending_review | not_available`, derived from the readiness facts and the connection
  (`marketplaceStatus` in `packages/contracts/src/marketplace.ts`); nothing in it means "verified".
- Connection views gain `grantedScopes` and `permissions` `{ checked, granted, missing[{ capability, scopes }],
  checkable, source }`. OAuth completion stores the scopes the provider reported in its token response (Snapchat,
  TikTok numeric ids, RFC 6749 `scope`); the code exchange makes the same provider calls as before.
- `POST /v1/o/:orgId/integrations/connections/:id/permissions` (`integrations:manage`): reads the granted permissions
  back from Meta (`GET /me/permissions`) for Meta Ads, WhatsApp and OAuth-connected Messenger / Instagram;
  `422 permissions_not_checkable` for other providers.
- Operator console (platform staff only, `@PlatformAdmin`): `GET /v1/admin/providers`, `GET /v1/admin/providers/:provider`
  (every platform role; secrets masked), `PUT /v1/admin/providers/:provider` and `DELETE /v1/admin/providers/:provider`
  (superadmins) for Resuto's own Meta, TikTok, Snapchat and Foodics apps (`platform_provider_apps`, secrets sealed
  with the key ring and never returned). The environment variables remain the fallback.
- WhatsApp stepper: `POST /v1/o/:orgId/connect/channels/:id/test-template` (`connect:manage`, 10 per hour per
  restaurant) sends the connection test template to a phone; `GET /v1/o/:orgId/connect/channels/:id/inbound-check?since=`
  reports inbound messages since the check started. `PATCH /v1/o/:orgId/connect/channels/:id` accepts `routing`
  (`manual | round_robin | by_branch`); channel views gain `routing` and `number`.
- Error codes: `channel_unverified`, `not_whatsapp_channel`, `permissions_not_checkable`, `provider_app_unknown_field`,
  `provider_app_webhook_token_weak`, `test_template_not_approved`.

No existing route changed (checked with `scripts/openapi/additive.mjs` against 04c07c7).

### Added — Inbox workspace, increment 2 (21-INBOX)

- `GET /v1/o/:orgId/connect/conversations` accepts `view=leads|ordering` (`INBOX_VIEWS` in `@resuto/contracts`):
  `ordering` lists conversations with an ordering session in progress; `leads` lists contacts without a counted order
  (confirmed and not cancelled) in the caller's branch scope, or without a customer profile. Each item gains
  `branchId`, `orderingStep` (the live session's step, or `null`) and `lead`.

### Added — Overview command centre (21-HOME)

- `GET /v1/o/:orgId/analytics/overview` accepts optional `from`, `to` (local dates, together, at most 400 days) and
  `compare` (`previous_period` default, `last_year`, `none`; only with `from`/`to`). With them the response gains
  `period` (`OverviewPeriod` in `packages/contracts/src/home.ts`): orders, net, average order and repeat rate with the
  comparison and daily series, new vs returning customers, acquisition of the period's new customers by channel
  (attributed from recorded attribution, otherwise inferred from the first order's channel and counted as inferred),
  and campaign conversion (attributed orders ÷ tracked link clicks; clicks only without a branch filter; sandbox
  campaigns excluded). Without `from`/`to` the response is unchanged except for three new fields:
  `live.tables { total, occupied, outOfService, free }`, `live.stations [{ station, queued, preparing }]` and
  `reservationsToday.next` (the next three of today, `null` for roles without `reservations:read`).
- `GET /v1/o/:orgId/attention?branchId=` (any member): slow orders, unpaid bills, low stock, failing integrations,
  expiring OAuth tokens, change sets pending approval, creative drafts and campaigns waiting for approval, negative
  guest ratings. Each kind is read only with its permission and module (`ATTENTION_ACCESS`); the others are listed in
  `omitted` with the reason. Items carry `kind`, `severity`, `count`, `samples`, `href`, `source` and `provenance`.
- `GET|PUT /v1/o/:orgId/preferences/overview` (the signed-in staff member's own layout: `{ sections: [{ id, visible }] }`,
  every section at most once). Stored in the new `user_preferences` table, readable and writable only by that user.

No existing route changed (checked with `scripts/openapi/additive.mjs` against the previous document).

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

### Added — Free QR menu onboarding, increment 2: the wizard (21-ONB)

- `GET /v1/onboarding/progress` and `PUT /v1/onboarding/progress` (signed-in people, personal: no restaurant in the
  path): the onboarding wizard's saved state `{ step, completed, orgId, draft, completedAt, updatedAt }` for the nine
  steps `account, restaurant, address, brand, menu, details, social, publish, qr`. `completed` only grows; `draft`
  (name, nameAr, country, serviceMode, slug, menuMethod) is strict; `orgId` must be a restaurant the caller is an
  active member of (`403`); restaurant steps and `done: true` need one (`422 onboarding_org_required`);
  `restart: true` starts a new wizard. Stored in `onboarding_progress` (RLS: only its owner).
- studio_basic inside core (plan §6.2/§7: logo, colours, theme presets, social links on every plan):
  `GET /v1/o/:orgId/brand` (`studio:read`), `PUT /v1/o/:orgId/brand` (`studio:write`; strict body `presetId`,
  `primaryColor`, `accentColor`, `backgroundColor`, `logoMediaId`), `GET /v1/o/:orgId/brand/presets`
  (`studio:read`; six presets, each a full website theme and storefront theme), `POST /v1/o/:orgId/brand/logo`
  (`studio:write`, multipart `file`, image up to 5 MB, becomes the site logo) and `POST /v1/o/:orgId/brand/publish`
  (`studio:publish`, `{ key }`, idempotent: the Studio's website publish, a new revision). These need only the
  `core` module; every `/v1/o/:orgId/studio/...` route still needs `studio` (402 `module_not_entitled` on Free).
- Response field: `org.socialLinks` on `GET /v1/public/sites/:slug/storefronts/:storefront`.
- Request value: menu import `source` accepts `xlsx` (a spreadsheet converted to CSV in the browser); like `csv`,
  its dishes are available unless the sheet says otherwise.
- Error codes: `onboarding_org_required`, `unknown_theme_preset`.

No existing route was removed or made stricter (checked with `scripts/openapi/additive.mjs` against `04c07c7`).

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

### Added — POS device API, contract 0.2.0 (21-POSAPI, draft)

Additive over 0.1.0 (`docs/api/IPAD_COMPATIBILITY.md`, "Staff session on a device"); a 0.1.0 client is unaffected.

- Staff session on a paired device: every `/v1/pos/...` route except `POST /v1/pos/pair` takes the optional header
  `X-Resuto-Staff-Authorization: Bearer <staff access token>` next to the device credential (security scheme
  `posStaffAuth`). The request then acts as that employee (active membership of the device's restaurant with the
  device's branch in scope), with effective permissions = the employee's role ∩ the device's acting role. The audit
  log names the employee as actor and records `metadata.deviceId`; device-owned records keep the device id.
- `requireStaff` pairing option (`POST /v1/o/:orgId/pos/pairings` body, default `false`): such a device needs the
  staff session on every device route except `GET /v1/pos/session`. Returned in the pairing response, the device list
  and detail, and the session.
- `GET /v1/pos/session` gains `requireStaff` and `staff` (`{ id, email, role }` or `null`); `permissions` are the
  effective ones.
- `GET /v1/pos/orders/by-client-id/:clientOrderId` (`orders:read`): `accepted` with the original submit response,
  `processing` while a submit is in flight, `404` when never accepted.
- Error codes: `pos_staff_not_allowed` (403), `pos_staff_required` (401).
- Responses vary on `X-Resuto-Staff-Authorization` (`Vary`).

Unchanged: without the header a device behaves as in 0.1.0; a staff token as `Authorization` on a device route is
still `403 pos_device_required`; no `/v1/o/...` route changed (checked with `scripts/openapi/additive.mjs` against the
previous document).

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
