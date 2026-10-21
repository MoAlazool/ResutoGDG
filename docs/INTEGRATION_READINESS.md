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

## Wave 4 integrations (ws7b-integrations)

Last updated 2026-10-21 (branch `ws/ws7b-integrations`). **No capability in this section has been run against a
provider: the last verified result is `not run` everywhere.** `node scripts/providers/acceptance.mjs` without
credentials reports every check below as `not_run` (and `eta.preprod_submit_receipt` as `blocked` until
`--allow fiscal`). Evidence: `scratchpad/program/evidence/ws7b-integrations/` (acceptance report, OpenSSL /
libxml2 cross-checks, screenshots). All keys, tokens, certificates and private keys are stored sealed (SecretBox);
API responses carry only `credentialsHint`. Provider calls run outside database transactions and never echo
provider bodies (they can carry the key or customer data).

States used below: **Implemented; external verification pending** (code + local tests, acceptance check ready),
**Implementation incomplete** (labelled so in the UI and API; known open points listed), **Not configured**.

### Custom domains (INT-27; Vercel domains API)

Code: `packages/integrations/src/domains/` (PSL subset + `VercelDomainsClient`), `apps/api/src/modules/studio` domain
provider. Docs: [Vercel add a domain](https://vercel.com/docs/rest-api/reference/endpoints/projects/add-a-domain-to-a-project),
[publicsuffix.org](https://publicsuffix.org/list/).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Apex detection | `domainParts()` / `isApexDomain()` over a pinned PSL subset (49 TLDs incl. `com.eg`, `com.sa`) | — | — | unit tests (`brand.com.eg` is an apex → A record) | — | not run | Subset, regenerated by `scripts/providers/update-psl-subset.mjs` |
| Attach / verify / detach | v10 add, v9 verify, v6 config, remove (team scope) | official_test, live | `DOMAIN_PROVIDER=vercel`, `VERCEL_TOKEN`, `VERCEL_PROJECT_ID`, `VERCEL_TEAM_ID` | API tests with scripted Vercel | `vercel.domain_attach_detach` | not run | Platform credential (one Vercel project) |
| HTTPS status | TLS probe of the served certificate (SNI, chain, name, validity) after an egress check | live | — | unit tests | — | not run | Active only when Vercel says verified + configured **and** the probe passes |

### TikTok Events API and Snap Conversions API (INT-23)

Code: `packages/integrations/src/tiktok/events-api.ts`, `snapchat/capi.ts`, `ads/tracking-sinks.ts`,
`apps/api/src/modules/marketing/meta-tracking.service.ts`, web `lib/tracking/{tiktok,snap,partners}.ts`.
Docs: [TikTok Events API](https://ads.tiktok.com/help/article/events-api) (request shape taken from TikTok's own
server-side GTM template because the portal pages are JS-only), [Snap Conversions API](https://developers.snap.com/api/marketing-api/Conversions-API/UsingTheAPI).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Server Purchase (TikTok) | `POST business-api.tiktok.com/open_api/v1.3/event/track/`, CompletePayment, hashed email/phone/external_id, ttp/ttclid | test (test event code), live | access token, pixel code, test event code | `tiktok`/`tracking-sinks` unit tests; `apps/api/test/tracking-sinks.test.ts` | `tiktok_events.test_purchase` | not run | Phone format (E.164 with `+`) and return codes from secondary sources |
| Server Purchase (Snap) | `POST tr.snapchat.com/v3/{pixel}/events`; test connections call `/events/validate` only | test (validate), live | CAPI token, pixel id | unit + API tests | `snap_capi.validate_purchase` | not run | Pixel script host from third-party references |
| Browser pixels | consent-gated loaders, shared event id for dedup, CSP only on guest pages | — | `browserPixel=on` | web unit tests (`sinks.test.ts`) | — | not run | — |
| Per-sink delivery + retry | one `meta_capi_events` row per provider (migration `20261022010001`) | — | — | API tests (TikTok outage retries TikTok only) | — | not run | — |

### Foodics (INT-24)

Code: `packages/integrations/src/oauth/`, `pos/foodics.ts`, `apps/api/src/modules/integrations/{oauth.service,pos-webhooks.service}.ts`.
Docs: [get started](https://developers.foodics.com/guides/get-started.html), [authentication](https://apidocs.foodics.com/core/authentication.html).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| OAuth connect | `console[-sandbox].foodics.com/authorize`, server-side `POST /oauth/token`, whoami business confirmation | sandbox, live (per app) | `FOODICS_CLIENT_ID`, `FOODICS_CLIENT_SECRET`, `FOODICS_OAUTH_ENV` | `apps/api/test/foodics-oauth.test.ts`; RFC 7636 vector in `oauth.test.ts` | `foodics.whoami_menu_page` | not run | Tokens do not expire (no refresh) |
| Revoke on disconnect | `DELETE /v5/tokens/client` | — | — | API test | — | not run | — |
| Menu webhook | `POST /v1/webhooks/foodics/<FOODICS_WEBHOOK_TOKEN>` → debounced pull | — | `FOODICS_WEBHOOK_TOKEN` (URL secret) | API test (fail closed, debounce) | — | not run | **Foodics documents no signature**: the URL secret is the only authenticator; the payload only schedules a pull |
| Menu import | products pull → review rows (imported unavailable) | — | — | API test | — | not run | No order push to Foodics |

### Accounting: Wafeq, Qoyod, Odoo Accounting (INT-25)

Code: `packages/integrations/src/accounting/index.ts`, `apps/api/src/modules/finance/accounting.service.ts`.
Docs: [Wafeq API](https://developer.wafeq.com), [Qoyod API](https://apidoc.qoyod.com), [Odoo external JSON-2 API](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Daily journals (RSJ/RSR/RSE/RSC/RSF/RSP) | Wafeq manual journals (signed amounts, idempotency key), Qoyod journal entries, Odoo `account.move` via JSON-2 | test org, live | provider key; account role mapping | `accounting.test.ts`, `net.test.ts`, `apps/api/test/accounting-push.test.ts` | `wafeq.test_journal`, `qoyod.accounts`, `odoo_accounting.json2_search` | not run | Wafeq base currency must equal the restaurant currency (assumed) |
| Daily summary invoices (RSI) | Wafeq `is_summary` invoices, Qoyod invoices, Odoo out_invoice — DRAFT by default | test org, live | `salesPosting=summary_invoice` + contact / tax rate / product ids | same | same | not run | VAT rounding differences are reported, not corrected |
| No duplicates | provider look-up by reference + `accounting_push_items` (migration `20261022010003`) | — | — | API test (second push creates nothing) | `wafeq.test_journal` (pushes twice) | not run | — |
| Daily automatic push | `finance.accounting-daily-push` after 04:00 restaurant time, ≤ 3 attempts | — | `autoPush=daily` | API test | — | not run | Odoo keys last at most 3 months; JSON-2 needs a plan with the external API |

### ZATCA Phase 2 (INT-26 / FT-24) — Implementation incomplete

Code: `packages/integrations/src/tax/{zatca,zatca-phase2,der}.ts`, `apps/api/src/modules/compliance/fiscal-authority.service.ts`,
web Compliance → Tax profile → "ZATCA Phase 2". Docs:
[Developer Portal manual](https://zatca.gov.sa/en/E-Invoicing/Introduction/Guidelines/Documents/DEVELOPER-PORTAL-MANUAL.pdf) (§2.3.10 APIs, §5.3 CSR configuration),
[Security Features Implementation Standards v1.2](https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf),
[XML Implementation Standard](https://zatca.gov.sa/ar/E-Invoicing/SystemsDevelopers/Documents/20230519_ZATCA_Electronic_Invoice_XML_Implementation_Standard_%20vF.pdf).
**Not certified; not yet validated with the ZATCA SDK (`fatoora -validate`) or the sandbox.**

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| EGS key + CSR | secp256k1 key (sealed), PKCS#10 per the manual's OpenSSL config (template name, DN, SAN dirName) | sandbox, simulation, production | validated tax profile (VAT, name), EGS details | `phase2.test.ts`; CSR identical to OpenSSL's from the manual config with the same key (evidence `zatca/csr-vs-openssl-config.txt`) | `zatca.sandbox_onboarding_and_compliance_check` | not run | Template name for sandbox/simulation not confirmed (the manual shows `ZATCA-Code-Signing`) |
| Compliance CSID / production CSID | `POST /compliance` (OTP, Accept-Version V2), `POST /production/csids` | same | FATOORA OTP | `phase2.test.ts`, `apps/api/test/fiscal-authority.test.ts` | same | not run | Simulation and production gateway paths not shown in the manual (`…/simulation`, `…/core` assumed) |
| Cryptographic stamp | XAdES enveloped signature in UBLExtensions, cac:Signature, Phase-2 QR (tags 1–9) | same | active EGS unit | transforms reduce the signed invoice to the hashed body (lxml), SignedProperties digest = lxml C14N, signature verifies (OpenSSL); builder body = libxml2 `--c14n11` | same | not run | Open: SignatureValue input (signed: canonical invoice), QR tag 6/7 encoding (raw bytes), SignaturePolicyIdentifier (no identifier published) |
| Compliance checks | stamped sample invoice / credit / debit note → `POST /compliance/invoices` | same | compliance CSID | API test | same | not run | — |
| Reporting / clearance | `compliance.zatca-submit` job → `/invoices/reporting/single` or `/invoices/clearance/single`; outcome recorded in `government_submissions` (`sandbox_api` / `production_api`). One EGS unit per branch (the unit reports that branch's PIH / ICV series); only documents issued since the unit's activation (`activated_at`) and under the unit's environment (`meta.environment` at issue time) are sent — never stub-era history | same | active EGS unit for the branch whose environment matches the tax profile | API tests (invoice hash = existing PIH chain value; history before onboarding, other environment and other branch not reported) | — | not run | No `Clearance-Status` header is sent (not in the manual's screenshots); 303 is recorded as "clearance required". Open: the first reported document of a newly activated unit continues the branch chain (its PIH is the hash of the last pre-activation document, its ICV continues the branch counter) — whether ZATCA expects the genesis PIH / ICV 1 for a new EGS is to be confirmed in the sandbox |

### ETA e-receipt (INT-26 / FT-24) — Implementation incomplete

Code: `packages/integrations/src/tax/{eta,eta-ereceipt,der}.ts`, `apps/api/src/modules/compliance/fiscal-authority.service.ts`,
connection `eta_ereceipt`. Docs: [Authenticate POS](https://sdk.invoicing.eta.gov.eg/ereceiptapi/01-authenticate-pos/),
[Submit receipts](https://sdk.invoicing.eta.gov.eg/ereceiptapi/02-submit-receipt/),
[Submission details](https://sdk.invoicing.eta.gov.eg/ereceiptapi/06-get-receipt-submission/),
[Serialization](https://sdk.invoicing.eta.gov.eg/document-serialization-approach/),
[Batch signature](https://sdk.invoicing.eta.gov.eg/receipt-batch-signature-creation/), [hosts](https://sdk.invoicing.eta.gov.eg/faq/).
**Not certified; no preprod submission has been made.**

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| POS login | `POST {id}/connect/token` (client credentials + posserial / pososversion / posmodelframework / presharedkey) — also the connection health check | preprod (`sandbox`), production (`live`) | client id/secret, pre-shared key, POS serial/OS/framework | `phase2.test.ts` | `eta.preprod_pos_login` | not run | — |
| Serialization + UUID | literal-preserving JSON serialization | — | — | reproduces ETA's published example byte for byte | — | not run | Batch root `{receipts}` follows the signature page; not confirmed by a validator |
| Issuer signature | CAdES-BES (SignedData v3, detached, id-digestedData, signingCertificateV2), RSA or EC | — | eSeal certificate + private key (sealed) | `openssl cms -verify` passes against the serialized content, like ETA's own sample (evidence `eta/cades-openssl-verify.txt`) | `eta.preprod_submit_receipt` | not run | ETA: "signature validation will not be deployed at this point" |
| Submission | `compliance.eta-submit` job: one signed batch per run, MaximumSizeExceeded split (each receipt recorded under the submission it went in; a failing half after an accepted half is retried alone), DuplicateSubmission Retry-After, 401 re-login. Only receipts issued since the connection was connected in its environment (`environment_connected_at`) and under the matching ETA environment | preprod, production | connected `eta_ereceipt` | `phase2.test.ts`, `apps/api/test/fiscal-authority.test.ts` | same (effect `fiscal`) | not run | — |
| Status | `compliance.eta-poll` job: details → accepted / rejected per receipt | same | same | API test | same | not run | Pages beyond the first 100 receipts are not read |

### Email (Resend) and SMS (Twilio) — notification channels (INT-28 / FT-27)

Code: `packages/integrations/src/notify/index.ts`, `apps/api/src/modules/notifications/outbound.{service,controller}.ts`,
campaign dispatcher `apps/api/src/modules/marketing/campaigns.service.ts`, web `/unsubscribe`, Marketing → quiet hours.
Docs: [Resend send email](https://resend.com/docs/api-reference/emails/send-email), [errors](https://resend.com/docs/api-reference/errors),
[webhook verification](https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests), [test addresses](https://resend.com/docs/dashboard/emails/send-test-emails),
[Twilio Messages](https://www.twilio.com/docs/messaging/api/message-resource), [webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security),
[test credentials](https://www.twilio.com/docs/iam/test-credentials), [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Email send (Resend) | `POST /emails` with Idempotency-Key, List-Unsubscribe + one-click | test (only `delivered+…@resend.dev`), live | API key, From on a verified domain | `notify.test.ts`, `apps/api/test/outbound-channels.test.ts` | `resend.key_check`, `resend.test_inbox_send` | not run | — |
| SMS send (Twilio) | `POST Accounts/{sid}/Messages.json`, Messaging Service or From, StatusCallback | test (Twilio test credentials only; always magic From +15005550006 → To +15005550010, never the customer; the test-connection check is a magic-number POST that live credentials fail), live (check reads the Account; test credentials are reported as test, error 20008) | Account SID, Auth Token (or API key), sender | same | `twilio_sms.test_credentials_send`, `twilio_sms.account` | not run | KSA/EG need a registered alphanumeric Sender ID (owner, in Twilio) |
| Delivery status | Svix-signed Resend webhook, X-Twilio-Signature status callback; statuses only move forward | — | Resend webhook secret; Auth Token | published Svix and Twilio signature examples reproduced; API tests | — | not run | — |
| Consent, opt-out, quiet hours | marketing consent, per-channel opt-outs (link, RFC 8058, complaint), quiet hours in the restaurant time zone (default 22:00–09:00) | — | — | API + DB tests | — | not run | — |
| Queue + retries | `outbound_messages`, 30 s job + send after commit, backoff 1 m/5 m/30 m/2 h; interrupted SMS → `unknown` (never re-sent) | — | — | API tests | — | not run | — |
| Staff email | notifications through the restaurant's Resend when no platform provider exists | — | Resend connection | API test | — | not run | Platform transactional email (B-14) still separate |

### Web Push for the driver app (FT-22)

Code: `packages/integrations/src/push/index.ts`, `apps/api/src/modules/delivery/driver-push.service.ts`,
web `public/driver-sw.js`, `app/driver/_lib/push.tsx`. Docs: [RFC 8030](https://www.rfc-editor.org/rfc/rfc8030),
[RFC 8291](https://www.rfc-editor.org/rfc/rfc8291), [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Encryption + VAPID | aes128gcm (RFC 8291), ES256 VAPID JWT (RFC 8292), node:crypto only | — | `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT` | RFC 8291 §5 example reproduced byte for byte; JWT verified | — (a real browser is needed) | not run | Push services restricted to FCM, Mozilla, Apple, WNS |
| Offer / assign / cancel notifications | outbox handlers after commit, once per device and event, 404/410 drop the subscription | — | driver opts in on the device | `apps/api/test/driver-push.test.ts` (payload decrypted) | — | not run | iPhone: Home Screen app (iOS 16.4+) only |

### Google Maps Routes (INT-29)

Code: `packages/integrations/src/maps/{google-routes,routing}.ts`, `apps/api/src/modules/delivery/routing.service.ts`.
Docs: [computeRoutes](https://developers.google.com/maps/documentation/routes/compute_route_directions),
[waypoint optimization](https://developers.google.com/maps/documentation/routes/opt-way).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| ETA + optimised multi-drop plan | computeRoutes with field mask; baseline fallback labelled with `source` / `fallbackReason`. A plan is kept per stop set (job ids + drop-offs) for 10 min or until the driver is 2 km from where it was planned (the 10 s jobs poll does not call Google); plans may use at most half the daily cap, ETAs (≤ 1 per job per 2 min) the rest | live (restaurant's own key) | Routes API key, daily cap (default 300) | `maps.test.ts`, `routing.test.ts`, `apps/api/test/delivery-routing.test.ts` | `google_routes.eta_and_plan` | not run | Billed by Google to the restaurant's project |

### Gemini (INT-30)

Code: `packages/integrations/src/ai/gemini.ts`; used by the assistant, copy, Studio creative copy and menu vision.
Docs: [generateContent](https://ai.google.dev/api/generate-content).

| Capability | Implemented code | Supported mode | Configuration required | Local test evidence | External test | Last verified | Limitations |
|---|---|---|---|---|---|---|---|
| Text + JSON-schema output, usage | one client, bounded retries, token usage recorded | live | `GEMINI_API_KEY` (platform) or the restaurant's own key (menu vision) | `gemini.test.ts`, `apps/api/test/*` (intelligence, studio) | `gemini.structured_output` | not run | — |

### Owner actions before going live (wave 4)

See `docs/OPEN_BLOCKERS.md` B-6 to B-9 and B-17 to B-21 for the credentials each check needs. The procedure is the
same for every provider: put the test credentials in the environment of a developer machine, run
`node scripts/providers/acceptance.mjs --provider <id>` (add `--allow write_test` / `--allow fiscal` where the check
says so), review the report, and record it with `scripts/providers/record-acceptance.mjs` so the catalog state
changes from "Implemented; external verification pending".
