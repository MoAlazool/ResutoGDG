# Integration readiness

What each provider integration can do today, how it was tested locally, and what still has to be proven
against the provider. Each section is owned by the workstream that implements the provider. A capability
moves to "Official provider test verified" or "Live capability verified" only after a recorded acceptance
run (`scripts/providers/acceptance.mjs`, stored with `scripts/providers/record-acceptance.mjs` in
`integration_verifications`). The integrations catalog
(`GET /v1/o/:org/integrations/catalog`, Dashboard → Integrations) computes the same states. It does not use
hand-set labels.

**States (INT-16):** Not configured · Implementation incomplete · Implemented; external verification pending ·
Official provider test verified · Live capability verified · Blocked by documented provider restrictions.

## Payments (ws2-payments)

Last updated 2026-10-20 (branch `ws/ws2-payments`). **No payment capability has been run against a provider
yet, so the last verified result is `not run` everywhere.** `node scripts/providers/acceptance.mjs` with no
credentials reports all 16 payment checks as `not_run`. Evidence:
`scratchpad/program/evidence/ws2-payments/acceptance/`.

### How the code decides that a payment is real (all providers)

- A webhook counts only after the secret of the connection it names (`?c=<connectionId>`) verifies it.
  The event is then bound to that connection and its environment. A payment is settled only when every
  identifier the event carries points to one attempt of that connection. An unsigned echo (Paymob
  `merchant_order_id`) is used only as a cross-check.
- When the authenticator is weak (Moyasar `secret_token`) or the amounts are unsigned (Paymob refund and void
  callbacks), Resuto applies the event only after it re-reads the object from the provider with the
  merchant's key.
- Test and live are separated by the documented key prefixes. Both the API and the adapter fail closed.
  Signed or authenticated `livemode`/`live` evidence that differs from the connection is alerted and never
  applied. The ledger also refuses evidence from the other environment.
- Payment amounts and currency must match the attempt. Overpayment, late captures and duplicate captures are
  alerted, and staff can refund them with one click when Resuto never applied them.
- Refunds are applied to the ledger only after the provider confirms them. If the outcome is unknown, the
  refund stays pending and is resolved by an inquiry. It is resent only if the provider has no record of it,
  and the resend uses the same idempotency key.
- Webhooks are deduplicated on signed (or authenticated) content only: Paymob on a hash of the 20 HMAC fields
  (plus the unsigned reference echo, so a forged echo never pre-empts the genuine delivery), Moyasar on the event
  id, the payment it names and `live`, Stripe on the event id. Copies of one transaction that differ in unsigned
  fields are processed once; any other variant is idempotent: one alert per (kind, payment, provider transaction),
  never re-opened after staff resolved it, and one provider transaction is refunded from alerts at most once. A
  one-click alert refund that the provider definitely refused can be retried (new attempt, new key); the dashboard
  reports "refunded" only for a confirmed refund.
- A payment the provider reports as refunded before Resuto saw it settle (Moyasar `refunded` covers partial
  refunds; Paymob inquiry with a refunded amount) is proof of the charge when it comes from an authenticated
  re-read: the capture is applied first, then the cumulative refund, in one transaction.
- Connection health never gates money already in flight. Webhook verification, status queries and refunds of
  existing payments need only the connection's credentials (not revoked) and the matching environment; health
  status and the enabled flag only choose connections for NEW checkouts. A provider outage during a health check
  (network, timeout, 5xx, 429) keeps the connection's status and is recorded in `health` and `last_failure_at`.
  The scheduled `integrations.health` job (every 15 min) re-checks connected connections every 6 h, failing ones
  every 12 h and pending ones hourly.

### Paymob (EG/SA/AE/OM; Intention API + Unified Checkout)

Code: `packages/integrations/src/payments/paymob.ts`. Docs used:
[HMAC transaction callback](https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-transaction-callback),
[Create intention](https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention),
[Integration credentials](https://developers.paymob.com/paymob-docs/need-help/setup-guides/getting-integration-credentials).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test (acceptance check) | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Health check / account identity | `healthCheck`: `POST /api/auth/tokens` (API key); key-prefix and integration-id checks | test, live (separate connections) | secretKey, publicKey, hmacSecret, apiKey, integrationIdCard (+ wallet id, region) | `payments-providers.test.ts` › activation; adapter tests | `paymob.auth` | not run | The profile fields shown as account identity (`id`, `company_name`) are as observed in public examples |
| Checkout | `createCheckout`: `POST /v1/intention/` (`Token <secret>`), Unified Checkout URL | test, live | same | adapter test (request shape); API test (redirect URL) | `paymob.checkout` | not run | `expiration` units are not documented (sent as seconds, 300–1800); placeholder billing email and phone when the guest gives none |
| Webhooks (transaction processed) | `verifyWebhook`: HMAC-SHA512 over the 20 documented fields, 128-hex hmac, integration id must be configured | test, live | hmacSecret, integration ids; Paymob dashboard callback for wallets | Paymob's published sample concatenation + openssl vectors (`payments.test.ts`); PS-02 replay test inverted; upper-case hex; malformed/tampered/missing; duplicates in parallel | `paymob.webhook_signature`, `paymob.webhook_signature_wallet` | not run | HMAC of `null` source_data fields (wallets) is unverified |
| Status query | `retrieveStatus` / `confirmEvent`: `POST /api/ecommerce/orders/transaction_inquiry` (Bearer token from the API key), `is_live` and integration checked | test, live | apiKey | adapter tests; refund-callback API test | `paymob.status_query` | not run | Response fields are taken from regional docs (Oman) and public examples |
| Refunds | `refund`: `POST /api/acceptance/void_refund/refund` (`Token <secret>`), no idempotency key | test, live | secretKey | adapter tests | `paymob.refund` | not run | No idempotency key on Paymob's side: an uncertain refund is resolved only from `refunded_amount_cents`. Same-day transactions may need a void instead |
| Refund status | `refundStatus` from the inquiry's `refunded_amount_cents` | test, live | apiKey | adapter tests | `paymob.refund` | not run | — |
| Provider-side refunds/voids | refund/void/child callbacks → authenticated inquiry → ledger | test, live | — | API test (refund callback applied from the inquiry, not the body) | — | not run | — |
| Cancel checkout | not implemented (no documented intention cancel) | — | — | — | — | — | Intentions are kept short (30 min). A late capture is applied if still due, otherwise alerted for refund |
| Transaction listing | not implemented: no documented listing API | — | — | adapter test asserts no call | — | — | Reconcile with the Paymob settlement CSV (statement upload) |

### Stripe (Checkout Sessions)

Code: `packages/integrations/src/payments/stripe.ts`. `Stripe-Version: 2026-09-30.endive` is pinned
([upgrades](https://docs.stripe.com/upgrades),
[endive change](https://docs.stripe.com/changelog/endive/2026-09-30/remove-payment-method-types-checkout-sessions)).
**Blocked by documented provider restrictions for Egyptian and Saudi businesses:**
[stripe.com/global](https://stripe.com/global) lists neither country, so a tenant can use Stripe only with an
account of an entity in a supported country. The catalog shows Stripe as blocked for EG/SA tenants.

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test (acceptance check) | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Health check / account identity | `GET /v1/account` (id, country, display name, default currency) + `whsec_` check | test (`sk_test_`/`rk_test_`), live (`sk_live_`/`rk_live_`) | secretKey, webhookSecret | API activation test (scripted `/v1/account`, redacted 401) | `stripe.account` | not run | — |
| Checkout | `POST /v1/checkout/sessions` (`allowed_payment_method_types`, `expires_at` 30 min–24 h, idempotency key per attempt) | test, live | secretKey | adapter + API tests | `stripe.checkout` | not run | Cards only |
| Webhooks | v1 HMAC-SHA256, 300 s tolerance, multiple v1 (rotation), `livemode` required and must match | test, live | webhook endpoint with the listed events; signing secret | openssl vector; API tests: wrong/missing/malformed signature, tampered body, livemode confusion, wrong amount/currency, other connection, other tenant, duplicates | `stripe.webhook_signature` | not run | The webhook endpoint's API version should match the pinned version |
| Status query | `GET /v1/checkout/sessions/:id` | test, live | secretKey | adapter + supersede API test | `stripe.status_query` | not run | — |
| Refunds | `POST /v1/refunds` with `Idempotency-Key: resuto-refund-<paymentId>:<n>` and the key in metadata | test, live | secretKey | API tests: dropped refund → pending, same key on resend; 503 → resolved from inquiry; refusal | `stripe.refund` | not run | — |
| Refund status | `GET /v1/refunds/:id` or list by `payment_intent` matched on `metadata.resuto_refund_key` | test, live | secretKey | API tests | `stripe.refund` | not run | — |
| Provider-side refunds / disputes | `charge.refunded`, `refund.updated` (re-read through the payment intent), `charge.dispute.created/closed` | test, live | subscribe the events | API test (refund applied once, older success never re-settles, dispute alerted) | — | not run | — |
| Cancel checkout | `POST /v1/checkout/sessions/:id/expire` before superseding/expiring an attempt | test, live | — | API test | `stripe.checkout` (expires its session) | not run | — |
| Transaction listing | `GET /v1/charges` (+ balance transaction fees) | test, live | — | — | — | not run | — |

### Moyasar (SA; hosted invoices)

Code: `packages/integrations/src/payments/moyasar.ts`. Docs:
[webhook reference](https://docs.moyasar.com/api/other/webhooks/webhook-reference) (fields
`secret_token`, `live`, `account_name`; the event table spells the failure event `payment_faild`),
[available webhooks](https://docs.moyasar.com/api/other/webhooks/available-webhooks) (`payment_failed`),
[create invoice](https://docs.moyasar.com/api/invoices/01-create-invoice) (amount ≥ 100; `callback_url`
receives an unsigned POST "when the invoice is paid"),
[cancel invoice](https://docs.moyasar.com/api/invoices/06-cancel-invoice).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test (acceptance check) | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Health check | `GET /v1/payments?page=1` + key-prefix check | test (`sk_test_`), live (`sk_live_`) | secretKey, webhookSecret | API activation test | `moyasar.auth` | not run | No account endpoint. The account name is taken from webhooks (`account_name`) |
| Checkout | `POST /v1/invoices` (≥ 100 minor units), `callback_url` = unsigned nudge route `/v1/public/pay/:token/nudge` | test, live | secretKey | adapter + API tests | `moyasar.checkout` | not run | Invoice `metadata` is not documented as a request field. Payments are matched by `invoice_id` |
| Webhooks | `secret_token` (constant time) = hint only; `GET /v1/payments/:id` with the secret key decides; both failure spellings; `live` checked before any fetch; token never stored | test, live | dashboard webhook + secret token | API tests: fetched payment beats the body, forged "paid" refused, amount mismatch, `live:true` on a test connection, token absent from the inbox | `moyasar.webhook_signature` | not run | Moyasar documents no signature or timestamp |
| Status query | `GET /v1/invoices/:id` (+ the nudge route) | test, live | secretKey | API test (nudge) | `moyasar.status_query` | not run | — |
| Refunds | `POST /v1/payments/:id/refund` (no idempotency key) | test, live | secretKey | adapter tests | `moyasar.refund` | not run | Uncertain outcomes are resolved from `refunded` on the payment |
| Refund status | `GET /v1/payments/:id` cumulative `refunded` | test, live | secretKey | adapter tests | `moyasar.refund` | not run | — |
| Cancel checkout | `PUT /v1/invoices/:id/cancel` | test, live | — | adapter tests | `moyasar.checkout` | not run | Which invoice statuses are cancellable is not documented |
| Transaction listing | `GET /v1/payments?page=n` | test, live | — | — | — | not run | — |

### Resuto sandbox (simulated)

Local test tool only. It never contacts a provider and runs only with `PAYMENT_MODE=sandbox`. It is not a
readiness claim: the catalog shows it as "Sandbox" and the live-mode boot test proves it is unreachable in live
mode.

### What needs provider-sandbox verification (PAY-21)

Run each with the provider's test account through `scripts/providers/acceptance.mjs`, and record the results
with `record-acceptance.mjs`.

1. **Paymob** wallet callbacks: the HMAC with `null` `source_data` fields (`paymob.webhook_signature_wallet`), and
   whether the intention's `notification_url` reaches wallet integrations or the dashboard callback is needed.
2. **Paymob** refund of a same-day (unsettled) transaction: does refund work, or is `void_refund/void` needed?
   A void path is not implemented.
3. **Paymob** intention `billing_data`: whether the placeholders `guest@resuto.invalid` and `+200000000000` are
   accepted when the guest gives no email or phone. Also the units of `expiration`.
4. **Paymob** transaction inquiry response: the `refunded_amount_cents`, `is_live` and `integration_id` fields
   on the regional hosts (EG, KSA). Also whether `order.merchant_order_id` echoes `special_reference`
   (it is only cross-checked).
5. **Paymob** auth token `profile` fields used for account identity.
6. **Stripe** webhook endpoint API version behaviour with the pinned `2026-09-30.endive`, and
   `allowed_payment_method_types` on the account.
7. **Stripe** availability: an account of an entity in a supported country. EG/SA businesses are blocked by
   Stripe.
8. **Moyasar** invoice `metadata` on creation, the `url` scheme returned (the docs sample is `http://`), and
   which statuses `PUT /invoices/:id/cancel` accepts and what it returns otherwise.
9. **Moyasar** `payment_captured`/`payment_authorized`/`payment_voided` delivery for manual-capture accounts,
   and which failure spelling is actually delivered.
10. **All**: a full test payment → webhook in `webhook_inbox` → ledger, a test refund, and the inquiry that
    resolves it (acceptance checks `*.status_query`, `*.refund`).

### Owner actions before going live

Create a TEST connection per provider in Dashboard → Integrations, paste the webhook URL shown there into the
provider dashboard, run the acceptance checks, then create a separate LIVE connection with the live keys.
Merchants who used Moyasar before this change should rotate their webhook secret token, because older inbox
rows stored it (a migration has since removed it).

## Meta: WhatsApp, Messenger, Instagram, Ads, Pixel + Conversions API (ws7a-meta)

Last updated 2026-10-20 (branch `ws/ws7a-meta`). **No Meta capability has been run against Meta yet: there is no Meta
app, test WABA, Page, sandbox ad account or Pixel in this environment.** `node scripts/providers/acceptance.mjs`
without credentials reports the 11 Meta checks as `not_run` (8) or `blocked` (3: the two message checks without
`--allow message`, the paused campaign without `--allow spend`). Evidence:
`scratchpad/program/evidence/ws7a-meta/acceptance-no-credentials.txt`.

### Version pin (INT-12)

Every Meta call (WhatsApp Cloud API, Marketing API, Messenger Send API, Conversions API, OAuth dialog) uses one
constant, `META_GRAPH_VERSION = 'v26.0'` (`packages/integrations/src/meta/graph.ts`). Checked 2026-10-20:
[Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions) (v26.0 released 2026-07-29,
expiry TBD) and the [Marketing API changelog](https://developers.facebook.com/docs/marketing-api/marketing-api-changelog)
(v26.0 TBD, v25.0 until 2027-02-23, v24.0 until 2026-11-10; v23.0 is no longer listed). `metaVersionWarnings()` is a
unit-test gate (and the `meta.graph_version` acceptance check) that fails 60 days before a pinned version's known end of
life; update `META_VERSION_SUPPORT` when Meta publishes the v26.0 date.

### Decisions

- **WhatsApp multi-tenant model (INT-13): Resuto is a Meta Tech Provider; restaurants connect with Embedded Signup v4**
  ([implementation](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation);
  v2/v3 were deprecated on 2026-10-15). The browser runs Meta's SDK (`FB.login` with the configuration id, session event
  `WA_EMBEDDED_SIGNUP`); the API exchanges the 30-second code for the business token, proves the number belongs to the
  WABA, subscribes Resuto's app to the WABA's webhooks, registers the number (sealed 6-digit PIN), and only then stores a
  connected connection and a verified channel. Webhooks are signed with the platform app secret (`WHATSAPP_APP_SECRET`).
  A restaurant's own Meta app stays supported: its connection carries its app secret and gets its own callback
  `/v1/webhooks/whatsapp/c/<connection id>` with a generated verify token; only that app's signature reaches its channels.
- **Ownership before routing (INT-03, INT-21):** a WhatsApp channel exists only for its connection's number and WABA after
  `GET /<WABA_ID>/phone_numbers` lists the number; webhooks reach only verified channels whose WABA equals `entry[].id`.
  A Messenger / Instagram channel exists only after the Page token proves it is that Page (`GET /me`) and, for
  Instagram, that the Page's `instagram_business_account` is the claimed account; the Page/account ids come from the
  connection, never from the request; webhooks reach only the verified channel whose kind and account equal `entry[].id`.
- **OAuth (INT-11 / PS-11) for Meta, TikTok and Snapchat ads:** the state is bound to the starting user and a browser nonce
  (only its SHA-256 is stored); the provider callback only forwards code and state to `/dashboard/oauth/<provider>`, which
  completes with the user's session and the nonce. None of Meta (manual login flow), TikTok for Business or Snapchat
  Marketing API documents PKCE for these flows, so the binding is the CSRF control. Meta short-lived → long-lived token
  (or a Facebook Login for Business system-user token with `META_ADS_LOGIN_CONFIG_ID`), `appsecret_proof` for platform-app
  tokens, account picker, Snapchat refresh (before use, after 401, every 30 min), provider revoke on disconnect where
  documented (Meta `DELETE /{user-id}/permissions`, TikTok `revoke_token`; Snapchat documents none).
- **Ad launches (INT-14 / PS-14):** no silent sandbox fallback (an unhealthy live account is a 409 with its health; the
  sandbox is an explicit `{ mode: 'sandbox' }`); two-phase launch with a row-locked claim, a `[rs:<token>]` tag in the
  provider campaign name, `Idempotency-Key` on launch and send, and a 5-minute recovery job.
- **Pixel + Conversions API (INT-20):** consent first, one Purchase per order, same `event_id` from the browser and the
  server (`p.<sha256("purchase:"+public ref)>`, so the public order reference never reaches Meta). Purchase policy:
  prepaid = when an online payment is captured; cash on delivery / pay at pickup = when the order is completed (or never,
  per restaurant). Never sent: guests who declined (no consented order context), demo restaurants
  (`organizations.onboarding.demo`), test or simulated payments, cancelled orders, events older than 7 days. Test
  connections send `test_event_code` on every event; live connections never do (Meta processes test events too).
  A restaurant has one `meta_capi` connection (unique per org, provider and branch): the owner tests it in Test, then
  switches the same connection to Live (Integrations > Reconnect); no second connection is created.
- **Audiences, ad sets, creatives, Page / Instagram publishing (INT-22): deferred.** A Custom Audience *dry run*
  (`POST /v1/o/:org/marketing/segments/:id/meta-audience/dry-run`, Marketing > Segments) shows the consent-filtered,
  SHA-256-normalised, 10,000-row batches and the `customaudiences` request Resuto would make, and sends nothing. Uploading
  needs the ad account's Custom Audience Terms (error 200/1870090 otherwise) and App Review; publishing needs
  `pages_manage_posts` / `instagram_content_publish` review. Both stay off until those exist.

### WhatsApp Cloud API (`whatsapp_cloud`)

Code: `packages/integrations/src/messaging/whatsapp-cloud.ts`, `apps/api/src/modules/connect/*`.

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test (acceptance check) | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Embedded Signup v4 | `whatsapp-signup.service.ts`, Inbox > Channels "Connect with Meta" | live | `META_APP_ID`, `META_APP_SECRET`, `WHATSAPP_ES_CONFIG_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`; Tech Provider status | `whatsapp-ownership.test.ts` (scripted Graph) | — (needs a real signup) | not run | The browser launcher was not run against Meta (no app); CSP allows facebook.com framing on the Inbox page only |
| Number ownership (INT-03) | `verifyPhoneOwnership`, channel create/verify | test number, live | token that can read the WABA | `whatsapp-ownership.test.ts` | `whatsapp.ownership` | not run | — |
| Webhooks | `X-Hub-Signature-256` before parsing; per-scope inbox keys; WABA + number routing | live | platform or own-app secret | `connect.test.ts`, `whatsapp-ownership.test.ts` | `whatsapp.webhook_signature` | not run | — |
| Send / 24-hour window / templates | sender job with retries; templates outside the window | test number, live | — | `connect.test.ts` | `whatsapp.send_template` (`--allow message`) | not run | Template review status arrives by webhook |

### Messenger and Instagram Direct (`meta_pages`, INT-21 / FT-05)

Code: `packages/integrations/src/messaging/meta-pages.ts`, `apps/api/src/modules/connect/meta-pages-webhook.service.ts`.
Docs: [Send API](https://developers.facebook.com/docs/messenger-platform/send-messages),
[Instagram send](https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message),
[webhooks](https://developers.facebook.com/docs/messenger-platform/webhooks).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test (acceptance check) | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Connecting the Page | Facebook Login (for Business with `META_PAGES_LOGIN_CONFIG_ID`, else `pages_show_list,pages_messaging,pages_manage_metadata,business_management,instagram_basic,instagram_manage_messages`) with the PS-11 bound state; long-lived user token; Page picker from `GET /me/accounts`; the chosen Page's own token from `GET /<PAGE_ID>?fields=access_token` (no expiry); revoke `DELETE /{user-id}/permissions` | live | `META_APP_ID`, `META_APP_SECRET`, redirect URI `/v1/public/integrations/oauth/meta_pages/callback` | `meta-pages.test.ts` (adapter), `oauth-binding.test.ts` (start, binding, picker, Page token, channel proof, revoke) | `meta_pages.ownership` | not run | A pasted Page token (system user) remains possible; it can only offer its own Page and has no provider revoke |
| Page / Instagram ownership | `verifyOwnership` (`GET /me`, `instagram_business_account`), `subscribed_apps` | live (test Page) | the connection's Page token, Page id, Instagram account id | `meta-pages.test.ts` (adapter + API) | `meta_pages.ownership` | not run | — |
| Webhooks | `/v1/webhooks/meta`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` | live | app webhooks for `page` and `instagram` (messages, messaging_postbacks) | API tests: signature, handshake, routing by kind + account, unknown accounts ignored | `meta_pages.webhook_signature` | not run | Delivery/read receipts are not mapped (Messenger reports watermarks, not message ids) |
| Bot ordering | quick replies (13), button template / link, typed address, phone asked on the hosted page for delivery | live | — | API test webhook → bot → order (channel `messenger`) | — | not run | No location pin; Instagram has no button template (link in text) |
| 24-hour window and handoff | RESPONSE inside 24 h; staff only with `HUMAN_AGENT` up to 7 days (re-checked at send); no templates | live | `human_agent` feature (App Review) | API test | `meta_pages.send_reply` (`--allow message`) | not run | Meta's Handover Protocol (multiple apps) is not used; handoff is Resuto's bot → staff |

### Meta Ads (`meta_ads`), TikTok (`tiktok_ads`), Snapchat (`snapchat_ads`)

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test (acceptance check) | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| OAuth bound to browser + user | `oauth.service.ts`, `/dashboard/oauth/<provider>` | live | provider app ids/secrets, redirect URI | `oauth-binding.test.ts` | — | not run | No PKCE documented by the providers |
| Ad account picker | `listAccounts` | live | — | `ads.test.ts`, `oauth-binding.test.ts` | `meta_ads.ad_accounts` | not run | — |
| Paused campaign, idempotent launch | `createCampaign` (PAUSED, `[rs:<token>]`), `findCampaignByToken`, recovery job | live (sandbox ad account) | ad account with a payment method | `ad-launch-safety.test.ts` | `meta_ads.campaign_create_paused` (`--allow spend`) | not run | Ad sets / creatives are created in Ads Manager (INT-22 deferred) |
| Insights | `fetchInsights` | live | — | `ads.test.ts`, `marketing.test.ts` | — | not run | — |
| Custom Audience | dry run only | — | — | `meta-capi.test.ts`, `meta-tracking.test.ts` | — | — | Upload deferred (Terms, App Review) |

### Meta Pixel + Conversions API (`meta_capi`, INT-20)

Code: `packages/integrations/src/ads/meta-capi.ts`, `apps/api/src/modules/marketing/meta-tracking.service.ts`,
`apps/web/lib/tracking/**`. Docs: [using the API](https://developers.facebook.com/docs/marketing-api/conversions-api/using-the-api),
[customer information parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters),
[deduplication](https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events),
[Pixel](https://developers.facebook.com/docs/meta-pixel/get-started).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test (acceptance check) | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Browser Pixel (consented) | consent prompt per restaurant + prompt version; `_fbp`/`_fbc` after consent; fbq + fbevents.js added by nonce-trusted code; PageView, ViewContent, AddToCart, InitiateCheckout, Purchase (eventID) | test, live | Pixel id; browser Pixel on | `lib/tracking/meta.test.ts` (CSP scope, loader, dedup id parity, mounts); browser proof | — | not run | `connect-src` gains www.facebook.com / connect.facebook.net only on `/r`, `/order`, `/reserve` and custom domains |
| Server Purchase | outbox `order.paid` / `order.status_changed`; one row per event id; retry on 5xx | test (`test_event_code`), live | CAPI token, Pixel id, Test Events code for test | `meta-capi.test.ts`, `meta-tracking.test.ts` | `meta_capi.test_event`, `meta_capi.health` | not run | Only web orders (consented context); IP/UA kept 8 days |
| Diagnostics | Marketing > Meta Pixel (status, 7-day counts, events with reasons), "Send test event" | test | — | API test, browser proof | — | — | — |

### Owner actions before going live (Meta)

1. Create Resuto's Business-type Meta app; become a Tech Provider; configure Embedded Signup (`WHATSAPP_ES_CONFIG_ID`),
   Facebook Login for Business, Messenger + Instagram products, Marketing API. Set `META_APP_ID`, `META_APP_SECRET`,
   `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `META_WEBHOOK_VERIFY_TOKEN` (and optionally `META_ADS_LOGIN_CONFIG_ID`,
   `META_PAGES_LOGIN_CONFIG_ID`). Add `https://<api>/v1/public/integrations/oauth/meta_ads/callback` and
   `.../oauth/meta_pages/callback` as valid OAuth redirect URIs.
2. Register webhooks: `https://<api>/v1/webhooks/whatsapp` (WhatsApp) and `https://<api>/v1/webhooks/meta` (page, instagram).
3. App Review: `whatsapp_business_management`, `whatsapp_business_messaging`, `pages_messaging`, `pages_manage_metadata`,
   `instagram_basic`, `instagram_manage_messages`, `human_agent`, `ads_management`, `ads_read`, `business_management`.
4. Run the acceptance checks with Meta's test assets (`--list` prints the variables), record them with
   `record-acceptance.mjs`, then allow `message` / `spend` checks one at a time with your own test recipient and a sandbox
   ad account.
