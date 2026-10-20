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
