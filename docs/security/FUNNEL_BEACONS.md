# Funnel beacons and first touch (21-CRM)

## What the guest pages send

The guest pages (`/r`, `/r/<store>`, `/m`, `/order`, `/t`, `/v`, `/reserve`) report four first-party events to
`POST /v1/public/funnel/beacon` through `apps/web/lib/funnel-beacon.ts`:

| Event | When | Pages |
|---|---|---|
| `page_view` | the page opens, in 1 of 4 tab sessions only (sampled per tab, weight 4) | all |
| `qr_scan` | a page only a printed QR code opens | `/t` (table), `/v` (counter) |
| `add_to_cart` | the guest adds to the cart (a cart restored from the tab is not an add) | `/order`, `/t`, `/v` |
| `checkout_started` | the checkout opens (`/order`) or the cart is opened with items to confirm (`/t`, `/v`) | `/order`, `/t`, `/v` |

The body is `{ e, s, o, b?, sid }`: event, page group, the restaurant's public slug, the branch id the page already
shows and a random tab id kept in `sessionStorage` (gone when the tab closes). Each event is sent at most once per
page load. Nothing else is sent: no name, phone, email, customer id, URL, referrer, cookie or device data.

## What is stored

`attribution_events` rows with `org_id`, `kind`, `surface`, `branch_id` (only when it is the restaurant's own branch,
enforced by the API and a database trigger), `weight` and `session_key = sha256("funnel:v1:<org>:<tab id>")[0..32]`.
The tab id itself, the IP address and the user agent are never stored. The rate limiter keeps only SHA-256 hashes of
its keys (`rate_limit_windows`), as for every other public endpoint.

## Basis

These are aggregate, first-party operational counts for the restaurant (how many guests opened its menu, scanned a
table code or started an order). They contain no personal data, set no cookie, are not shared with any third party
and are not used to profile a person, so they do not wait for the ad-measurement prompt. That prompt
(`apps/web/lib/tracking/MetaPixel.tsx`, INT-20/23) still gates every third-party Pixel (Meta, TikTok, Snap): nothing
in the beacon helper loads or calls them. A restaurant operating where analytics storage needs consent regardless
can switch the helper off per surface (it is one call per page); this is not a setting yet.

## Abuse and failure

- Rate limits: 600 a minute per client address (before the body is read; generous because a restaurant's guests share
  its Wi-Fi) and 30 a minute per tab id. Refusals are `429 rate_limited`.
- Fail closed: an unknown key, a malformed value, an event the page group cannot send, a body over 512 bytes or
  non-JSON is `400 validation_failed`, and nothing is stored.
- No oracle: a beacon for an unknown or closed restaurant, or a page view from a tab outside the sample, answers the
  same `204` as a stored one.
- The counts are lower bounds: a blocked script, an ad blocker or an offline phone sends nothing. The funnel labels
  them `partial` (QR scans, cart activity) or `estimate` (visits, scaled from the sample).

## Retention

Beacon rows have no retention job yet (open item); they hold no personal data. A cleanup of rows older than 400 days
(the longest analytics period) is the planned follow-up.

## First touch (`customers.first_touch`)

Set once by deferred constraint triggers at commit of a customer's first identified interaction (an order, an
attributed event, a conversation) from `attribution_events`, tracked-link sessions and order attribution, inferred
from the first order's or conversation's channel otherwise; never overwritten (`customers_first_touch_keep`). It
holds no personal data: basis, channel, campaign id, link id, order id, branch id, UTM values and times.
`app.backfill_first_touch(org)` fills existing customers once (idempotent). Customer 360 and the overview read it
only when the caller may see what it rests on (its branch is in their scope; a conversation touch needs conversation
access); otherwise they derive the touch from what the caller can see, as before.

## Consent rules

Messaging a business (a WhatsApp chat, a Messenger or Instagram message) never sets marketing consent; only an
explicit opt-in recorded in `customer_consent_events` does (the checkout checkbox, the WhatsApp ordering page's
opt-in, a staff entry with its source). Without it, Customer 360 marks the channel "Contact allowed for service
replies only" (`contactBasis: service_replies_only`), and campaigns record such customers `skipped_no_consent`
(`apps/api/test/crm-consent.test.ts`).
