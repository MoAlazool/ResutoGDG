# Resuto API style guide

Short rules for every route in `apps/api`. The machine-checkable ones are enforced by the OpenAPI lint in
`apps/api/test/openapi.test.ts` (it runs in CI with the API suite, and `node scripts/openapi/check.mjs` runs the same
checks against a built API); the rest are review rules. The published description is `GET /v1/openapi.json`
(OpenAPI 3.1, generated from the Nest router and the `@resuto/contracts` zod schemas; committed copy:
`docs/api/openapi.json`).

## Paths

- Everything lives under `/v1`. Tenant routes are `/v1/o/:orgId/...`; the guard resolves the membership from `:orgId`
  and answers **404** (never 403) for a restaurant the caller cannot see.
- Public routes (guest, website, webhooks) are marked `@Public()` and live under `/v1/public/...` or
  `/v1/webhooks/<provider>/...`. Public routes are rate limited per client IP (and per token where there is one).
- Collections are plural nouns (`/orders`, `/campaigns`). An action that is not a CRUD write is a `POST` to a verb
  sub-path of the resource (`/campaigns/:id/approve`, `/orders/:id/cancel`).
- Path identifiers that are UUIDs are validated (`ParseUUIDPipe`): a malformed one is **400 `invalid_uuid`**.
- Existing names stay as they are (`/v1/orgs` for creating a restaurant, `/v1/o/:orgId` for working in one;
  `/public/order/:slug` and `/public/menu/:slug`); renames would break clients. New routes follow the rules above.

## Methods and status codes

| Request | Success status |
|---|---|
| `GET` | 200 |
| `POST` that **creates** a resource (an order, a campaign, a payment link, a membership …) | **201** |
| `POST` action that changes or computes something without creating a resource (approve, cancel, transition, availability, sync, verify, read, preview, test-event, resolve …) | **200** — declare `@HttpCode(200)` |
| `POST` that only queues work (`202` where the API says so) or answers nothing (`204`) | as declared |
| `PATCH` / `PUT` | 200 |
| `DELETE` | 200 with the deleted or updated view, or 204 |

The OpenAPI lint (`lintOpenApi` in `packages/contracts/src/openapi.ts`, subpath export `@resuto/contracts/openapi`) fails a `POST` that answers 201 when its last
static path segment is an action (`ACTION_SEGMENTS`: approve, cancel, transition, verify, sync, …) unless the route is
on the `CREATING_ACTIONS` allow-list (actions that do create something: `/invitations/accept` creates a membership,
`/conversations/:id/reply` a message, `/payments/collect` a payment, `/ordering/:token/checkout` an order …).
`/website/publish` answers 200: it changes the site's published state.

## Requests

- Bodies and query strings are validated with zod schemas from `@resuto/contracts` through `zod(...)`
  (`@Body(zod(schema))`, `@Query(zod(schema))`); handlers never parse numbers or booleans by hand.
- **List endpoints** take `listQuery` / `listQueryOf({ defaultLimit })` (`limit` 1–200, `cursor`), extended with their
  filters. A negative, zero, fractional, non-numeric or too large `limit` is a **400 `validation_failed`**.
- Money is integer minor units; timestamps are ISO 8601 with offset; digits are Western (0-9).
- Writes that must not be repeated take an `Idempotency-Key` header (8–200 characters); missing or malformed is a
  **400**.

## Lists and pagination

- Every list answers `{ items: [...], nextCursor: string | null }` (plus endpoint-specific totals where documented).
- `nextCursor` is **opaque**: base64url of `{at, id}` of the last row (the sort key and the row id). Send it back as
  `?cursor=` to get the next page; `null` means there is no next page. Never build or parse cursors in clients.
- Ordering is stable: by the sort key, ties broken by `id` (`apps/api/src/common/http/pagination.ts`: `keyset()`,
  `pageOf()`, `cursorAt()`). Filters (branch scope, status …) are applied in SQL **before** the limit, so a page is
  never short because rows were dropped afterwards.
- Every list has an enforced maximum (200). Lists that used to return everything now default to 200 per page and
  return a real `nextCursor` when there are more. They answer the header `X-Resuto-List: full`; the staff web client
  (`apiAll()` in `apps/web/lib/api.ts`, used by `useSession().call`) then follows `nextCursor` itself (bounded, in a
  lazily loaded chunk), so screens that show every row keep doing so.
- The lint requires `cursor` next to every `limit`, except for rankings whose `limit` is a "top N"
  (`TOP_N_LISTS`, e.g. the churn list).
- Small configuration lists that are not pages (stations, branches, team members, MCP connections, the driver
  roster) keep their shape and have a fixed ceiling in SQL: MCP connections 200, team members and pending invitations
  1,000 each (`truncated: true` when reached). Search pickers (the studio's website-highlight product picker, 200
  matches) answer `nextCursor: null` with `truncated: true` when there were more matches: narrow the search.
- A malformed or tampered cursor is **400 `invalid_cursor`**. A cursor the server issued is never rejected: text sort
  keys (names, `name|language`, `branch|item`) can be long, so the key cap (`MAX_CURSOR_KEY_LENGTH`, 1,100 characters)
  is above the longest key any list builds and `cursor` accepts up to `CURSOR_MAX_LENGTH` (9,000) characters, enough
  for that key with every character JSON-escaped. `pagination.test.ts` pages across 120-character supplier names,
  512-character template names and long Arabic branch/item names.
- When a later page of a full list fails, `apiAll()` keeps the rows it has and returns them with `nextCursor` still
  set; only a failed first page, an abort or a 401 throws.

## Errors

Every error response, including ones raised before a controller runs (unknown route, malformed JSON, body too large),
has the same envelope:

```json
{ "error": { "code": "validation_failed", "message": "The request is invalid", "details": [{ "path": "limit", "message": "Too small" }], "requestId": "…" } }
```

- `code` is stable and machine-readable. Generic codes are `HTTP_ERROR_CODES` and domain codes `DOMAIN_ERROR_CODES`
  in `@resuto/contracts` (`packages/contracts/src/api.ts`, `error-codes.ts`, generated by
  `node scripts/openapi/error-codes.mjs`; the API suite fails when a new code is not registered). Clients branch on
  `code`, never on `message`.
- `requestId` is always present and equals the `X-Request-Id` response header.
- Status codes:
  - **400** — the request is malformed or fails schema validation: `validation_failed` (zod; `details` lists each
    field), `invalid_json`, `invalid_uuid`, `invalid_cursor`, `invalid_identifier`, `idempotency_key_required`,
    `invalid_idempotency_key`, `bad_request`.
  - **401** `unauthorized` (missing/expired credentials, or a guest token that is no longer valid, e.g. `visit_closed`).
  - **402** `module_not_entitled`, **403** `forbidden`, **404** `not_found` (also for unknown routes),
    **405** `method_not_allowed`, **409** conflicts (`duplicate`, `conflict`, `stale_*`, …), **410** `gone`,
    **413** `payload_too_large`, **415** `unsupported_media_type`.
  - **422** — the request is well formed but a business rule refuses it; the code names the rule
    (`cart_empty`, `invalid_geometry`, `schedule_in_past`, …).
  - **429** `rate_limited` — always with `Retry-After` (seconds) and `RateLimit-Limit/Remaining/Reset`.
  - **5xx** — `internal_error`, `db_timeout`, `db_unavailable`, `service_unavailable`, provider failures; `503` always
    carries `Retry-After`.
- Responses never contain SQL text, constraint, table or column names or stack traces. Those are logged server-side
  with the request id (`ApiError` logger), so support can find them from the `requestId` a user reports.

## Responses

- Fields are camelCase. (Older endpoints that returned raw database rows keep their snake_case fields for existing
  clients and add the camelCase ones; new code reads the camelCase fields.)
- Controllers return the contract type when one exists (`Promise<Page<OrderSummary>>`), so the compiler checks the
  response shape against what the web app and MCP server read. The OpenAPI document describes list responses as
  `Page` and every error as `Error`; other response bodies are not yet described (request bodies and queries are,
  from the same zod schemas the handlers validate with).
