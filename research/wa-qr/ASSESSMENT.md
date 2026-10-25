# WhatsApp QR compatibility mode: policy and security assessment (21-WAQR, stage 1)

| | |
|---|---|
| Status | **Draft for owner sign-off (gate G-WA, plan item O-5).** Desk research only. |
| Scope | `docs/plans/RESUTO_2_1_PLAN.md` §6.9 (QR compatibility mode, stage 1) and §8 (21-WAQR row) |
| Author | 21-WAQR stage 1 workstream, branch `ws/21-waqr` (base `09dacb8`) |
| Research date | 2026-10-25. Every source below was accessed on this date unless stated otherwise. |
| What was **not** done | No connection to WhatsApp. No phone number was paired. No unofficial client library was installed, downloaded or run. No product code, migration, CI or deploy setting was changed. |

**Recommendation in one line:** do **not** productise QR mode for restaurant accounts. Meet the same need through the
official **WhatsApp Business app coexistence** onboarding, which Resuto's Embedded Signup already partly supports
(§7, §8). A PoC on Resuto-owned test numbers is optional, and it can only measure technical stability. It cannot
reduce the policy risk, which is the deciding factor.

How to read the evidence:

- **[Sn]** points to the source list in §10.
- **Quoted** text is copied word for word from the source on the access date.
- **Unverified / to confirm** marks a claim that could not be checked against a primary source.
- **Anecdotal** marks evidence from forums, issue trackers or vendor blogs.
- **Assumption** marks a number made up for the cost model. These are inputs for the PoC to measure, not facts.

---

## 1. What "QR compatibility mode" means here

The restaurant opens WhatsApp (or WhatsApp Business) on its phone, goes to *Linked devices* and scans a QR code shown
by Resuto. Resuto's server then acts as a **companion device** on that account: an extra, unofficial "WhatsApp Web"
client. It receives the account's messages and sends replies through WhatsApp's linked-device (multi-device) protocol.
Meta's Business Platform is not involved, so there is no app review, no templates and no per-message billing.

WhatsApp's own description of the linked-device design:

- A companion links when "the primary device scans a QR code which is displayed on the companion device". An
  8-character pairing code is a second option [S6].
- Each device "now has its own identity key" [S7].
- A phone can run with "up to four other nonphone devices simultaneously" [S7].
- Companions keep working without the phone being online [S7]. However, "if your primary device is inactive for a long
  period, we automatically log you out of all companion devices" [S8]. Third-party guides give this period as
  14 days (**unverified / to confirm**).

---

## 2. (a) WhatsApp / Meta terms on unofficial and automated clients

### 2.1 WhatsApp Terms of Service (consumer; WhatsApp LLC outside the European Region) [S1]

The page served on the access date shows "Effective Date: January 4, 2021 (archived versions)". The page says WhatsApp
LLC provides the service to users outside the European Region. Egypt and Saudi Arabia are outside it, but **which
version applies to EG/SA users should be confirmed by counsel.** Quoted clauses:

> **Legal And Acceptable Use.** You must access and use our Services only for legal, authorized, and acceptable
> purposes. You will not use (or assist others in using) our Services in ways that: … (e) involve sending illegal or
> impermissible communications such as bulk messaging, auto-messaging, auto-dialing, and the like; or (f) involve any
> non-personal use of our Services unless otherwise authorized by us.

> **Harm To WhatsApp Or Our Users.** You must not (or assist others to) directly, indirectly, through automated or
> other means, access, use, copy, adapt, modify, prepare derivative works based upon, distribute, license, sublicense,
> transfer, display, perform, or otherwise exploit our Services in impermissible or unauthorized manners, or in ways
> that burden, impair, or harm us, our Services, systems, our users, or others, including that you must not directly or
> through automated means: (a) reverse engineer, … (c) gain or attempt to gain unauthorized access to our Services or
> systems; … (h) distribute or make our Services available over a network where they could be used by multiple
> devices at the same time, except as authorized through tools we have expressly provided via our Services; (i) create
> software or APIs that function substantially the same as our Services and offer them for use by third parties in an
> unauthorized manner; …

> **Our Terms And Policies.** … If you violate our Terms or policies, we may take action with respect to your account,
> including disabling or suspending your account and, if we do, you agree not to create another account without our
> permission.

> **Termination.** We may modify, suspend, or terminate your access to or use of our Services anytime for any reason,
> such as if you violate the letter or spirit of our Terms or create harm, risk, or possible legal exposure for us, our
> users, or others.

The dispute-resolution section also names "efforts to interfere with our Services or engage with our Services in
unauthorized ways (for example, automated ways)" as a category of dispute [S1].

### 2.2 WhatsApp Terms for WhatsApp Business App (effective September 23, 2026) [S2]

This document governs restaurants that use the WhatsApp Business app, which is the most likely user of a QR mode.
Quoted:

> **Restrictions.** Except as otherwise permitted by WhatsApp in writing, Company must not directly, indirectly, or
> through automated or other means: (a) distribute, sell, resell, or rent our Business App Services to third parties;
> (b) distribute or make our Business App Services available over a network to be used by multiple devices at the same
> time, except as authorized through tools and configurations that we have expressly provided for your use via our
> Business App Services; … (e) reverse engineer any aspect of our Business App Services or do anything that may
> discover source code; (f) scrape or extract data from our Business App Services; **(g) develop or use any
> applications that interact with our Business App Services without our prior written consent**; and (h) create
> software or APIs that function substantially the same as our Business App Services and offer them for use by third
> parties in an unauthorized manner on or utilizing the WhatsApp platform or our Business App Services.

> … (h) send, distribute, or post spam, unsolicited electronic communications, … (l) bypass, ignore, or circumvent …
> any measures we employ to prevent or limit access to any part of our Business App Services …

> **Enforcement.** … If we determine that you have breached these Business App Terms or are not complying with our
> policies, we have the right to limit, throttle, suspend, or terminate Company's account, depending on the type and
> circumstances of the breach and within our reasonable discretion. In the event that we terminate Company's account,
> Company will not create another WhatsApp business account without our express written permission.

The same terms also require the business to "keep its devices and WhatsApp account safe and secure" and to "prevent
unauthorized use of" its account [S2].

### 2.3 WhatsApp Business Messaging Policy (last updated September 23, 2026) [S4]

The policy applies to "The WhatsApp Business App" and "The WhatsApp Business Platform" alike. Quoted:

> You may only contact people on WhatsApp if: (a) they have given you their mobile phone number or username; and
> (b) you have received opt-in permission from the recipient confirming that they wish to receive subsequent messages
> or calls from you.

> **Enforcement and Updates.** … If you use or operate a service which utilizes WhatsApp in violation of our terms or
> policies, such as messaging people at scale in an unauthorized manner, we have the right to limit or remove your
> access to WhatsApp for Business. … **If we terminate your account for violations of our terms of service, the
> Business Messaging Policy, or the WhatsApp Messaging Guidelines, we may prohibit you and your organization from all
> future use of WhatsApp products and services.**

> You may not forward or otherwise share information from a customer chat with any other customer.

### 2.4 WhatsApp Terms for WhatsApp Business Platform (effective September 23, 2026) [S3]

The authorised route for software to send and receive WhatsApp messages for a business is described as:

> a suite of products that provide business services and application programming interfaces ("APIs") which enable
> businesses to send and receive messages or calls and use other available features to interact with consumer users
> on WhatsApp.

These terms incorporate the Business Messaging Policy and the Meta Terms for WhatsApp Business Platform. Resuto
already accepted them as a Tech Provider for the official path (`docs/INTEGRATION_READINESS.md`, INT-13).

### 2.5 WhatsApp's own public statements

- **Help Center.** The Help Center has articles titled "About unofficial apps" [S9a], "About unsupported apps" [S9b],
  "About account bans" [S9c] and "About WhatsApp and third-party apps" [S9d]. Their bodies load client-side and could
  not be retrieved word for word. Search-engine summaries of [S9b] say unsupported apps "violate the Terms of Service"
  and that accounts using them "might be temporarily or permanently banned". **Unverified wording; confirm on the
  live page.**
- **Abuse white paper (February 6, 2019; third-party mirror) [S5].** "Regardless of the intent, automated and bulk
  messaging violates our terms of service" … "Our technology aims to identify accounts using automation and take
  action to stop them."
- **Linked-device protocol libraries' own READMEs.**
  - whatsapp-web.js: "WhatsApp does not allow bots or unofficial clients on their platform, so this shouldn't be
    considered totally safe" [S17].
  - Baileys: "This project is not affiliated, associated, authorized, endorsed by, or in any way officially connected
    with WhatsApp" … "We discourage any stalkerware, bulk or automated messaging usage" [S15].

### 2.6 Assessment of the terms position

| Question | Finding |
|---|---|
| Is a server-side linked-device client for a business number authorised? | **No.** Business App Terms (g) forbid any application "that interact[s] with our Business App Services without our prior written consent" [S2]. ToS (h) limits multi-device use to "tools we have expressly provided" [S1]. Resuto has no written consent, and none is known to be available for this use (**to confirm** only by asking Meta). |
| Is it allowed if only inbound and 1:1 human-initiated replies are sent (no bulk)? | **Still not authorised.** Low volume lowers the chance of detection (§3). It does not change the terms: clause (g) prohibits the *application* itself, not only bulk use. |
| Who breaches? | Both. The restaurant (account holder) breaches its terms by linking it, and Resuto "assist[s] others" [S1] and operates "a service which utilizes WhatsApp in violation of our terms" [S4]. |
| Worst-case consequence | The restaurant's number is banned, and it may not create another account without permission [S1][S2]. For Resuto, Meta "may prohibit you and your organization from all future use of WhatsApp products and services" [S4]. Whether Meta would apply this to Resuto's Tech Provider app, and so to the official path for every restaurant, is **unknown**. The policy text allows it. |
| Litigation precedent | WhatsApp said it would take legal action against those who abuse its terms through automated or bulk messaging, from 7 December 2019 [S10] (press coverage; **WhatsApp FAQ text not retrieved**). In October 2022 WhatsApp LLC sued developers of unofficial WhatsApp apps (HeyMods / HeyWhatsApp) in the U.S. District Court for N.D. California over account takeover and spam [S11] (press coverage plus a complaint copy; **not read in full**). No public case against a restaurant SaaS was found. |

---

## 3. (b) Number-ban risk and what is publicly known about enforcement

Facts WhatsApp has published:

- In the three months before February 2019, WhatsApp "banned over two million accounts per month for bulk or automated
  behavior and over 75% of those accounts did not have any recent user reports". "Roughly 20% of account bans happened
  at registration time" [S5].
- Detection runs "at registration; during messaging; and in response to negative feedback". Signals include message
  rate, IP and network reputation, and automation markers: "Spammers attempting to automate messaging may lack the
  technical ability to forge this typing indicator. If an account continually sends messages without triggering the
  typing indicator, it can be a signal of abuse, and we will ban the account." [S5]
- "We are improving our ability to detect these modified versions of WhatsApp as they both violate our Terms of
  Service and pose a security risk" [S5].
- A search-engine summary of [S9e] says WhatsApp bans "over 8 million accounts per month". **Unverified wording.**
- Business-side enforcement: WhatsApp may "limit or remove your access … or limit your ability to send messages, if
  you receive significant amounts of negative feedback" [S4].

What is known about linked-device libraries (**anecdotal unless stated**):

- The Baileys maintainers list, in the v7.0.0-rc10 release notes, "a lot of challenges: LIDs, restrictions, WAM,
  warnings, bans, random logouts". The same notes add a feature for "Reachout Timelock (Your account is restricted -
  the 463 error)" [S16]. This is the maintainers' own report, so it is first-hand but not quantified.
- whatsapp-web.js states that "it is not guaranteed you will not be blocked by using this method" [S17].
- WAHA, a commercial wrapper around these libraries, says its browser-based engines run a real WhatsApp Web instance
  to "avoid getting blocked" [S21]. Some operators clearly see the protocol-only engines as easier to detect.
  **Anecdotal.**
- **No public, quantified ban rate** for low-volume, inbound-led use through a linked device was found. Vendor blogs
  give anecdotes in both directions. **The ban probability for Resuto's use case is unknown.** A PoC with a handful of
  test numbers over a few weeks cannot estimate it with any statistical confidence (see POC_DESIGN.md §6).

Ban risk factors that apply to a restaurant QR mode:

1. **Behaviour.**
   - Replies sent with no typing indicator.
   - Very fast replies from a bot.
   - Many first contacts from numbers not in the restaurant's contacts.
   - Customers who use "Report" or "Block", for example on order-status messages they did not expect.
2. **Network.**
   - Many accounts connecting from the same data-centre IP range, which is a hosting provider's address space.
   - Per [S5], "if an active computer network has recently been used by known abusers, we have more reason to believe
     a new account on that network is likely to be abusive". A shared bridge host therefore **couples the risk across
     restaurants**. This is an inference from [S5], not a published rule.
3. **Client fingerprint.** Protocol-level clients present a client identity that WhatsApp may tell apart from the
   official Web or Desktop client. **Unverified; no public specification.**
4. **Protocol changes.** Forced protocol migrations (LID addressing, a new QR code format [S16]) can cause disconnects
   and, according to anecdotal maintainer reports, restrictions.

**Impact of a ban on a restaurant:** the restaurant loses WhatsApp on its public phone number. That number is usually
printed on menus, Google Maps and delivery apps. The ban may be permanent, and the restaurant agrees not to create
another account without permission [S1][S2]. For a small restaurant this is a severe, hard-to-reverse loss caused by a
Resuto feature.

---

## 4. (c) Technical options for a linked-device bridge (evaluated, not used)

Metadata comes from the public package registries (registry metadata only; no package or tarball was downloaded) and
from project pages, on 2026-10-25.

| Library | Language / method | Licence | Latest release seen | Maintenance signal | Protocol-break history (sourced) |
|---|---|---|---|---|---|
| **Baileys** (`baileys`, `@whiskeysockets/baileys`) [S15][S16] | TypeScript; WebSocket, linked-device protocol, no browser ("does not require Selenium or any other browser") | MIT | `7.0.0-rc14`, 2026-07-29 (npm) | Active. A v7 release-candidate series ran from at least November 2025; the maintainers say releases slipped ("RC10 was scheduled for April 28th…"). The original `@adiwajshing/baileys` package is marked deprecated on npm ("Package no longer supported") and development moved to the WhiskeySockets fork. | v7 brought breaking changes (LID addressing, a new companion QR format) [S16]. |
| **whatsmeow** (`go.mau.fi/whatsmeow`) [S18] | Go; WebSocket, linked-device protocol | MPL-2.0 | Untagged pseudo-version `v0.0.0-20261017175727-b2b1e71d45e2` (2026-10-17, Go proxy) | Active (commits in October 2026). Untagged versions mean no semver stability promise. It also underlies mautrix-whatsapp (**to confirm**) and WAHA's "GOWS" engine [S21]. | No ToS or ban disclaimer in the README. Calls and broadcast lists are not implemented [S18]. |
| **whatsapp-web.js** [S17] | JavaScript; drives the real WhatsApp Web in headless Chromium (Puppeteer) | Apache-2.0 | `1.34.7`, 2026-04-24 (npm) | Active, very widely used | Breaks when WhatsApp Web changes internally. Example: issue #2789 "WhatsApp does not work on v2.3XXX", opened 2024-02-25 when WhatsApp Web moved from Webpack to "Comet". Users pinned old web versions as a workaround, and the issue was closed by PR #2816 on 2024-07-24, about 5 months later [S17]. |
| **WPPConnect** (`@wppconnect-team/wppconnect`) [S19] | JavaScript; WhatsApp Web in a browser | LGPL-3.0-or-later | `2.3.6`, 2026-10-23 | Active | Same browser-injection breakage class as whatsapp-web.js (inferred from the method; not separately sourced). |
| **venom-bot** [S19] | JavaScript; WhatsApp Web in a browser | MIT | `5.3.0`, 2024-11-23 | No release for about 23 months: **treat as unmaintained** | — |
| **open-wa / wa-automate** [S19] | JavaScript; WhatsApp Web in a browser | "SEE LICENSE IN LICENSE.md" (custom; **licence terms not reviewed**) | `5.9.7`, 2026-10-24 | Active | — |
| **yowsup** [S20] | Python; legacy *phone* (primary-device) protocol | GPL-3+ | `3.3.0`, 2021-12-14 | **Abandoned**. It registers as a primary device, which is a different and riskier model. | — |
| **neonize** [S20] | Python bindings over whatsmeow | Not declared on PyPI (**to confirm**) | `0.5.2`, 2026-09-21 | Small project | Inherits whatsmeow's behaviour |
| **WAHA** (`devlikeapro/waha`) [S21] | Self-hosted HTTP server wrapping the libraries above ("WEBJS", "WPP", "NOWEB" = Baileys, "GOWS" = whatsmeow) | **Not checked** (core plus paid edition; **to confirm**) | — | Commercial | Its docs warn that "API responses and webhook payloads may differ significantly" between engines [S21]. |

**Evaluation.** If stage 2 were ever approved, the shortlist would be:

1. **whatsmeow (Go), in its own process.**
   - MPL-2.0 is file-level copyleft, which is acceptable for an isolated service. Legal should confirm the obligations.
   - Low memory per session, since there is no browser.
   - Active upstream.
   - A separate language runtime is itself an isolation boundary from the TypeScript API.
2. **Baileys (TypeScript).**
   - MIT licence.
   - Same stack as the API.
   - Long-running release-candidate series, and its maintainers report bans and restrictions themselves [S16].

Browser-driven libraries are not recommended:

- They need roughly 3 to 10 times more memory per session (**assumption**, §6).
- They pull in a full Chromium instance, which adds attack surface.
- They break whenever WhatsApp Web's internals change [S17].

yowsup is excluded: it is abandoned and uses the primary-device model.

**Common to all options:**

- None is endorsed by WhatsApp.
- All reimplement or drive a protocol that WhatsApp can change without notice.
- None can be pinned in a way that survives a server-side protocol change.
- Each option means running third-party code that handles the restaurant's end-to-end-encrypted keys. A
  supply-chain compromise of the library or one of its dependencies would expose every linked restaurant account.

---

## 5. (d) Session storage, hijack risk, isolation and revocation

### 5.1 What a linked-device credential grants

From WhatsApp's encryption white paper (v9, February 25, 2026) [S6]:

- A companion has its **own identity key**, attested by an "Account Signature" from the primary and its own "Device
  Signature". "Once both signatures are produced, end-to-end encrypted sessions can be established with the companion
  device."
- **Message history sync:** "Immediately after linking a companion device, the primary device end-to-end encrypts a
  copy of messages from recent chats" and sends it to the companion.
- **App state sync:** chat properties, contact names, broadcast list names and similar settings are synchronised to
  every device.
- A companion can be logged out by itself, by the primary device, or "by the WhatsApp server".

**Consequence:** anyone holding the stored companion key material (identity key, Noise transport key, Signal session,
pre-key and sender-key state) can, from anywhere, without the phone and without the restaurant noticing:

- **read every new message** to the number, including personal chats, family groups, staff groups and supplier chats,
  not only customer orders;
- **send messages as the restaurant**;
- read synced contacts and chat metadata;

until the companion is unlinked. For library-based clients this credential is a set of files or database rows. Baileys
tells integrators to persist it themselves and to save updated keys every time they change [S15]. This is equivalent
to a **permanent, unscoped bearer token for the restaurant's whole WhatsApp identity**. It is much broader than an
official Cloud API token, which is scoped to a WABA and its business phone numbers, revocable in Business Manager, and
covers no personal chats.

### 5.2 Hijack scenarios

| Threat | Effect | Mitigation (stage 2 would require all of these) |
|---|---|---|
| Database dump or backup leak | All linked accounts readable and impersonable | Envelope-encrypt each session blob with the key ring (below). Keep keys out of the database. Use a separate table and role that the API role cannot read. |
| Bridge host compromise (RCE in the library or its dependencies) | Live keys in memory: every session on that host | One process per small tenant group. No inbound network except from the API. Least-privilege container. Dependency pinning plus review. Kill switch. |
| Insider or operator access | Reading restaurants' private chats | No operator UI for message content from the bridge. Audit log on session decrypt. Two-person rule for key access. |
| QR phishing: an attacker shows a Resuto-looking QR | Attacker links a device to the restaurant account | QR shown only inside an authenticated, MFA-protected owner session. Expire each QR within 60 s. Show the linked-device name "Resuto (Unofficial)" so the owner can verify it in *Linked devices*. |
| Stale session after the restaurant leaves Resuto | Resuto keeps reading chats | On disconnect or plan end: logout call, delete the session, and tell the owner to check *Linked devices* on the phone. |

### 5.3 Encryption with Resuto's key ring

Resuto already has an AES-256-GCM envelope (`apps/api/src/common/crypto/secret-box.ts`):

- Envelope format `v1:<keyId>:<iv>:<tag>:<ct>`.
- Keys rotate by prepending to `CREDENTIALS_KEYS`.
- AAD (additional authenticated data) binds a ciphertext to its context.
- Purpose-derived HMAC keys live in `keys.ts`.

Stage 2 would reuse the **format**, but not the API's keys:

- **Separate key material.** Use a dedicated `WA_BRIDGE_KEYS` ring, readable only by the bridge process. If the bridge
  shared `CREDENTIALS_KEYS`, a bridge compromise would also expose every provider credential, and the reverse.
- **AAD** = `wa-bridge:v1:<org_id>:<session_id>`, so one restaurant's blob cannot be swapped onto another's row.
- **Write-through.** Every key update is sealed before it is persisted. Plaintext never touches disk; this needs a
  custom auth-state adapter, not file-based helpers.
- **Rotation.** Re-seal on the next write. Keep the old key id until no rows reference it. This is the same process
  as `CREDENTIALS_KEYS`.

### 5.4 Isolation

- A separate `apps/wa-bridge` deployable with its own process, container, service account, database role and secrets.
  It is **never** imported by `apps/api`.
- API ↔ bridge traffic goes over an authenticated internal channel (signed requests, purpose-bound HMAC key), with a
  narrow contract: `send(1:1 reply)` and `inbound(event)`.
- The bridge filters **before** forwarding:
  - drop group, broadcast, status and newsletter traffic;
  - drop every chat that has no Resuto conversation opened by an inbound customer message;
  - discard history-sync bundles without persisting them.

  This limits, but cannot remove, the over-collection inherent in §5.1. The bridge still *receives and decrypts*
  everything.

### 5.5 Revocation

- Restaurant side: *Linked devices → log out* on the phone, which is authoritative [S6][S7]. Changing or
  re-registering the number also invalidates companions (**to confirm** for each scenario).
- Resuto side:
  - logout through the library, then delete and crypto-shred the session;
  - per-restaurant and global kill switches;
  - key-ring removal makes every blob unreadable (emergency crypto-shred).
- Official-path interaction: linking the number to the Cloud API through coexistence "generates a new random Identity
  Key thereby invalidating all existing companions" [S6]. **Migrating to the official path automatically revokes a QR
  session**, which makes it a clean exit.

---

## 6. (f) Operating cost estimate (stage 2, if it were built)

**All figures are assumptions unless sourced.** Hosting prices are Render's public list prices on 2026-10-25 [S24]:

| Instance | Price | RAM | CPU |
|---|---|---|---|
| Starter | $7/month | 512 MB | 0.5 |
| Standard | $25/month | 2 GB | 1 |
| Pro | $85/month | 4 GB | 2 |

Persistent disk costs $0.25 per GB per month.

| Item | Assumption | Estimate |
|---|---|---|
| RAM per session, WebSocket library (whatsmeow / Baileys) | 50–150 MB (**assumption**; Baileys and WAHA say only that no browser saves "a large amount of RAM" [S15][S21]) | Standard 2 GB at 60% target utilisation: about 8–24 sessions, so **about $1–3 per session per month** |
| RAM per session, browser library | 300–600 MB (**assumption**) | 2–4 sessions per Standard instance, so **about $6–12 per session per month** |
| High availability | A companion credential should run in one place at a time (**assumption**), so warm standby only | +1 standby instance per pool: about +$25/month per pool |
| Session storage | Encrypted rows in Postgres, a few KB to a few MB per session (**assumption**) | Negligible |
| Monitoring | Connection state, logout and ban events, per-session send rate, protocol-error rate, alerting | $0–50/month flat, using existing tooling (**assumption**) |
| Engineering upkeep | Track library releases. React to forced protocol changes; whatsapp-web.js's 2024 break took about 5 months to close upstream [S17]. Security review of each upgrade. | **0.1–0.25 FTE ongoing** (**assumption**), the dominant cost |
| Support | Re-pairing after logouts (phone inactive, protocol migration, "random logouts" [S16]); ban appeals; explaining bans to restaurants | Unknown. The PoC should measure logouts per session-month. Assume 0.5–2 tickets per restaurant per month (**assumption**). |
| Liability | A banned restaurant number caused by a Resuto feature; possible legal exposure (§2.6) | Not quantifiable. It could exceed all other costs combined. |

Illustration for 50 restaurants on whatsmeow (**assumptions only**):

| Cost | Amount |
|---|---|
| Hosting: 3 Standard instances plus 1 standby | about $100/month |
| Monitoring | about $25/month |
| Engineering | 0.15 FTE |
| Support | 25–100 tickets/month |

Hosting is cheap; people and risk are not.

---

## 7. (g) Comparison with the official path already in Resuto

Repository state (`docs/INTEGRATION_READINESS.md`, `docs/OPEN_BLOCKERS.md` B-4):

- Resuto is a Meta **Tech Provider**. Restaurants connect through **Embedded Signup v4**, which is implemented.
- Ownership is checked before routing. Webhooks are signature-verified. The 24-hour window and templates are enforced.
- **Nothing has been verified against Meta yet**, because there is no Meta app or test WABA (B-4).
- `whatsapp-signup.service.ts:87` already handles the coexistence finish event `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`
  and skips number registration for it.
- Handling of the coexistence-specific webhooks (Business-app message echoes, history and contact sync [S12]) was
  **not found** in the code (searched 2026-10-25; to confirm with the 21-INT owner).

| Dimension | Official Cloud API (Embedded Signup) | QR compatibility mode (linked device) |
|---|---|---|
| Terms status | Authorised: Business Platform terms [S3] | Prohibited without written consent [S1][S2] (§2) |
| Restaurant keeps its existing Business-app number and keeps chatting on the phone | **Yes, through coexistence.** "Onboard using their existing WhatsApp Business app account and phone number", with one-to-one messaging continuing in the app; requires Business app ≥ 2.24.17 [S12]. Country availability for EG/SA: **to confirm**. | Yes |
| Personal and group chats exposed to Resuto | No. The API carries business conversations only; coexistence history sync needs the business to agree and excludes groups [S12]. | **Yes, everything on the account** (§5.1) |
| Ban risk from the integration method | Policy and quality enforcement only [S4] | Additional, unquantified automation and unofficial-client risk (§3) |
| Reliability | Meta-hosted API with webhooks. Throughput 80 messages/s per number by default [S14], or a fixed 20 per second for coexistence numbers [S12]. | Depends on an unofficial library and the phone's activity. Logouts and protocol breaks are reported [S16][S17]. |
| Business-initiated messages | Approved **templates** only, outside the window [S4] | Technically unrestricted. Stage 2 would deliberately disable this, so no advantage. |
| 24-hour window | "You may reply to a user message without use of a Message Template as long as it's within the 24-hour customer service window, which opens and resets with each user message" [S4] | No window. Stage 2 would impose an equivalent rule anyway (inbound-led, 1:1 replies only). |
| Cost per message | Per-message pricing since July 1, 2025. "Each business phone number has one free tier of 1,000 delivered service messages per month". Meta "only charges as of the 1,001st service message" from October 1, 2026, and utility messages inside an open window are charged from that date [S13]. EG/SA rate amounts: **to confirm** from the rate card. Messages sent from the Business app under coexistence "will continue to be free" [S12]. | No Meta fee. Hosting about $1–12 per session per month plus support and engineering (§6). |
| Features not available | Under coexistence the API does not support groups, broadcast lists, calls, catalogue or status, among others [S12] | Groups, broadcasts and similar are technically possible but out of scope by policy |
| Data-protection position | Meta acts under its Business terms and Data Processing Terms; the scope is clear | Resuto receives third-party personal data with no lawful basis (§8) |
| Exit or migration | — | Linking Cloud API through coexistence invalidates every companion [S6], so migration is clean |

**Conclusion of the comparison.** The main reasons for a QR mode are "keep my number, keep using the app on my phone,
no Meta paperwork". The first two are now met officially by coexistence [S12]. The third is mostly Resuto's
Tech-Provider onboarding work (blocker B-4), which has to be done anyway. With 1,000 free service messages per number
per month [S13], the official path's per-message cost for a typical inbound-led restaurant is probably small. This
cannot be confirmed until the EG/SA rate card is checked and real volumes are known.

---

## 8. (e) Data-protection duties

### 8.1 Egypt: Personal Data Protection Law No. 151 of 2020, Executive Regulations by Ministerial Decree No. 816 of 2025

Source: an unofficial English translation by Andersen Egypt [S22]. **The binding text is the Arabic Official Gazette
publication, so counsel must confirm.** Dates: Digital Policy Alert records the Regulations as adopted on
1 November 2025 and in force on 2 November 2025 [S22b]. The Law's Issuance Article 6 gives entities "one (1) year from
the date of issuance of such Regulations" to comply, so about **November 2026, days after this assessment**.

| Duty | Text (translation) | Effect on QR mode |
|---|---|---|
| Consent | Art. 2: "It is prohibited to collect, process, disclose, or reveal personal data by any means without the explicit consent of the data subject, unless otherwise authorized by law." Art. 6 lists the lawful bases (explicit consent, contract, legal obligation, legitimate rights). | The restaurant has a contractual basis for its *customer* order chats. **No basis exists for Resuto receiving the restaurant owner's personal, family, staff or supplier chats**, which a linked device receives by design (§5.1). |
| Breach notification | Art. 7: notify the Centre "within seventy-two (72) hours", and data subjects "within three (3) working days". | A bridge compromise is a breach affecting every person who chatted with every linked number, and it is hard to scope. |
| Cross-border transfer | Art. 14: no transfer abroad "unless the destination provides a level of protection not less than that stipulated under this Law, and subject to licensing or authorization by the Center". Regulations Art. 16 also require a "license or permit from the Center" and "the consent of the data subject prior to transferring". Art. 42: imprisonment of at least 3 months and/or a fine of EGP 500,000–5,000,000. | Resuto's API and database run in **Frankfurt** (`docs/STAGING_DEPLOYMENT.md`), so this applies to Resuto **in general**, not only to QR mode. QR mode adds transfer of data from people who never contacted the business. **Action for the owner regardless of G-WA:** obtain advice on the Centre licence and the transfer permit. |
| Licensing | Art. 26: the Centre issues licences or permits to controllers and processors, including for cross-border transfer and direct electronic marketing. | Applies to Resuto as a processor in general (to confirm with counsel). |
| Direct marketing | Art. 17: prior consent, identification of the sender, an opt-out, and so on. | Stage 2 forbids marketing sends, so this is consistent. |

### 8.2 Saudi Arabia: Personal Data Protection Law (Royal Decree M/19, amended by M/148)

Sources: DLA Piper (19 February 2024) [S23a] and Securiti (updated 30 September 2026) [S23b]. **The official SDAIA
text could not be retrieved** (the request was rejected), so article-level wording is to be confirmed by counsel.

- **Timing.** In force on 14 September 2023, with a compliance deadline of 14 September 2024 [S23a].
- **Lawful bases.** Consent, plus other bases including legitimate interest; legitimate interest does not cover
  sensitive data [S23a]. Exact consent conditions: **to confirm** against SDAIA text.
- **Breach notification.** To SDAIA within 72 hours where notification is required [S23a].
- **Cross-border transfer (Art. 29 and the Transfer Regulation of 1 September 2024).**
  - A transfer must not compromise national security or vital interests.
  - It must meet adequacy or an appropriate safeguard: SCCs, Binding Common Rules, or a certificate of accreditation.
  - It must be limited to the minimum personal data necessary.
  - A risk assessment is required for safeguard-based transfers.
  - Per [S23b], "As of September 2026, no [adequacy] list has been published".
- **Penalties.** Administrative fines up to SAR 5 million, which may be doubled for repeat violations [S23a].
- **Effect on QR mode.** The **minimum-data** condition and the lack of a lawful basis for non-customer chats make
  QR-mode collection hard to justify. Transferring Saudi data to Frankfurt needs SCCs plus a risk assessment, as for
  the official path.

### 8.3 Duties that would apply to any stage 2 (and to the PoC, scaled down)

1. **Role allocation.** The restaurant is the controller and Resuto the processor. This needs a data processing
   agreement addendum that names QR mode, its over-collection and its sub-processing.
2. **Customer notice.** The restaurant's privacy notice and an auto-reply on first contact must state that messages
   are processed by Resuto through an unofficial connection, together with retention and the right to object.
3. **Restaurant consent.** The owner must give a recorded, specific acknowledgement covering:
   - (a) the terms breach and ban risk;
   - (b) that *all* chats on the number become readable by the connection;
   - (c) the cross-border transfer.

   The owner cannot consent on behalf of third parties, such as family or suppliers, whose chats the bridge receives.
   **This gap cannot be closed by any control. It is a structural reason against productising.**
4. **Minimisation.** In-memory filtering, no persistence of non-customer traffic, and history sync discarded (§5.4).
5. **Retention and erasure.** Customer conversation retention as in the official path. Session keys crypto-shredded on
   disconnect.
6. **Breach readiness.** A 72-hour notification runbook for both jurisdictions.
7. **Transfers.** The Egypt Centre licence or permit and Saudi SCCs or a risk assessment. These are needed for Resuto
   overall and should be scheduled independently of G-WA.

---

## 9. (h) Recommendation and the exact conditions for stage 2

### 9.1 Recommendation

1. **Do not productise QR compatibility mode** (do not approve stage 2) for any real restaurant account. Reasons, in
   order of weight:
   - It is a **contractual breach by design**: Business App Terms (g) [S2] and ToS (h)/(i) [S1]. No control changes
     that.
   - **Concentrated downside for Resuto:**
     - Meta may bar "you and your organization from all future use of WhatsApp products and services" [S4]. That
       could reach Resuto's official Tech-Provider integration, which is the production default.
     - Restaurants could lose their public numbers permanently [S1][S2].
   - **Data protection:**
     - A linked device receives every chat on the account [S6].
     - Resuto has no lawful basis for non-customer chats under Egypt PDPL Art. 2 and 6 or the Saudi PDPL
       minimum-data rule (§8).
   - **A better official alternative exists:** coexistence keeps the restaurant's existing Business-app number and
     phone app [S12], and Resuto's signup already recognises the event (§7).
2. **Redirect the effort.** Finish the official path:
   - unblock B-4 (Meta app and test WABA);
   - complete coexistence (echo, history and contacts webhooks, and the 20 messages-per-second limit);
   - show "Keep using WhatsApp Business on your phone" as the headline benefit in the 21-INT stepper.

   This is a suggestion for the lead and the 21-INT owner. Nothing in this workstream changes it.
3. **PoC: optional, and only if the owner wants first-hand stability data.**
   - It can only use Resuto-owned test numbers with no link to Resuto's Meta Business portfolio.
   - It is itself a terms breach for those test accounts (§2.6), so the owner must accept that those numbers may be
     banned.
   - It cannot measure ban probability for production with meaningful confidence (POC_DESIGN.md §6).

   If the recommendation in point 1 is accepted, **skipping the PoC is reasonable.**

### 9.2 If the owner nevertheless approves stage 2: required conditions (all mandatory)

These implement the plan's §6.9 constraints table, made specific. Stage 2 must not start unless each one has an owner
and a test.

| # | Constraint (plan §6.9) | Exact control | Acceptance test |
|---|---|---|---|
| 1 | Separate process | `apps/wa-bridge` as its own deployable: own container, database role, secrets and key ring (`WA_BRIDGE_KEYS`). Never imported by `apps/api` or `apps/web`. An internal signed channel with a two-call contract. | A lint or CI check that no `apps/api` or `apps/web` file imports wa-bridge. The API database role cannot `SELECT` the session table (RLS or privilege negative test). |
| 2 | Library | whatsmeow (preferred) or Baileys, pinned by exact version or commit, vendored lockfile, upgrade only after security review. MPL-2.0 or MIT obligations reviewed by counsel. | Software bill of materials (SBOM) and licence report in CI for wa-bridge only |
| 3 | Encrypted sessions | AES-256-GCM key-ring envelope, AAD bound to org and session; plaintext never on disk; crypto-shred on disconnect | A test that a session blob from org A fails to open under org B's AAD. A disk scan in the test shows no plaintext key material. |
| 4 | Operator flag off by default | Platform-level `wa_qr_mode_enabled = false`. Only a platform operator can turn it on, and turning it on is audited. | A negative test with the flag off: no endpoint, no UI and no pairing possible |
| 5 | Per-restaurant opt-in, high-risk disclosure and stored acknowledgement | The owner (MFA step-up) reads the disclosure (terms breach, possible permanent ban of the number, *all chats readable*, cross-border transfer, the official alternative). A typed confirmation is stored with user id, timestamp, disclosure version hash and IP. Re-acknowledgement is required when the disclosure version changes. | Tests: no acknowledgement means no QR; a staff role cannot acknowledge; the version bump forces re-acknowledgement. |
| 6 | Inbound plus 1:1 service replies only | Outbound is allowed only to a JID (WhatsApp chat id) with an inbound message in the last 24 hours, and only as a reply in that chat. No groups, broadcasts, status, new contacts, templates, campaigns or MCP or automation sends. Only send paths initiated by human staff; bot auto-replies are off, or limited to one acknowledgement per inbound (**owner decision**). | Negative tests for every blocked path |
| 7 | Strict rate limits | Per session: at most 1 outbound per 3 seconds; at most 200 per day; at most 20 distinct recipients per hour (**assumption; tune with PoC data**). Simulated typing presence before each send. Back off on any restriction or 463-type error, and auto-pause the session on the first restriction signal. | Rate-limit tests. A restriction event pauses the session and alerts. |
| 8 | "Unofficial" labelling | "Unofficial — high risk" badge on every surface: connection card, inbox channel chip, conversation header, settings. Never the default, never pre-selected. Linked-device name shown on the phone: "Resuto (Unofficial)". Use of the WhatsApp name and logo to be checked against WhatsApp's Brand Guidelines (**to confirm**). | UI tests in Arabic and English for the badge on each surface and for non-default selection |
| 9 | One-click migration to official | A "Switch to official WhatsApp" action that launches Embedded Signup coexistence for the same number. On success the QR session is invalidated [S6] and deleted, and the conversation history stays in Resuto. | E2E test against the sandbox, plus a manual test on a test number |
| 10 | Data protection | DPA addendum. Customer notice auto-reply. In-memory filtering of non-customer traffic. History sync discarded. Breach runbook (72 h EG/SA). Transfer licence or permit (EG) and SCCs (SA) in place before any EG/SA restaurant. | Filtering tests (group and non-customer messages never persisted). Legal sign-off recorded. |
| 11 | Kill switches | Global and per-restaurant kill (logout, shred, disable). Automatic kill when the protocol-error rate or ban signals pass a threshold. | Drill: global kill completes for every session in under 5 minutes |
| 12 | Isolation of the official path | No shared Meta app, business portfolio, IPs or numbers between QR mode and the official Tech-Provider integration (to limit [S4] organisation-level spill-over, which may not be enough) | Configuration review |
| 13 | Rollout | Ships last in 1C. Never enabled for real customers without the owner's explicit, separate go-ahead after stage 2 tests pass. Starts with at most 3 consenting pilot restaurants, with a review after 30 days. | Owner sign-off recorded in `docs/` |

---

## 10. Sources (all accessed 2026-10-25)

| Id | Source | Notes |
|---|---|---|
| S1 | WhatsApp Terms of Service, https://www.whatsapp.com/legal/terms-of-service | Page shows "Effective Date: January 4, 2021"; the version served may depend on region |
| S2 | WhatsApp Terms for WhatsApp Business App, https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-App | Effective September 23, 2026 |
| S3 | WhatsApp Terms for WhatsApp Business Platform, https://www.whatsapp.com/legal/WhatsApp-Terms-for-WhatsApp-Business-Platform | Effective September 23, 2026 |
| S4 | WhatsApp Business Messaging Policy, https://whatsappbusiness.com/policy/ (redirected from https://business.whatsapp.com/policy) | Last updated September 23, 2026 |
| S5 | WhatsApp, "Stopping Abuse: How WhatsApp Fights Bulk Messaging and Automated Behavior", February 6, 2019; copy at https://www.internetlab.org.br/wp-content/uploads/2019/10/WA_StoppingAbuse_Whitepaper_020618-Final-1.pdf | Third-party mirror of a WhatsApp document |
| S6 | WhatsApp Encryption Overview, technical white paper v9 (February 25, 2026), https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf | Sections: Companion Device Registration, Message History Syncing, App State Syncing, Companion Device Removal, Linking the WhatsApp Business App with Cloud API |
| S7 | Meta Engineering, "How WhatsApp enables multi-device capability", July 14, 2021, https://engineering.fb.com/2021/07/14/security/whatsapp-multi-device/ | |
| S8 | WhatsApp blog, "One WhatsApp account now across multiple phones", April 25, 2023, https://blog.whatsapp.com/one-whatsapp-account-now-across-multiple-phones | |
| S9a–e | WhatsApp Help Center: (a) "About unofficial apps" https://faq.whatsapp.com/1217634902127718; (b) "About unsupported apps" https://faq.whatsapp.com/520312452657376; (c) "About account bans" https://faq.whatsapp.com/465883178708358; (d) "About WhatsApp and third-party apps" https://faq.whatsapp.com/916543719558426; (e) "About WhatsApp and elections" https://faq.whatsapp.com/518562649771533 | Titles confirmed. **Bodies render client-side and were not retrieved**; content known only from search-engine summaries, so unverified |
| S10 | Press coverage of WhatsApp's 2019 "legal action from December 7" FAQ: MediaNama (June 2019) https://www.medianama.com/2019/06/223-whatsapp-will-use-public-information-to-take-legal-action-against-bulk-senders-other-violators-from-december-7/; Mobile Ecosystem Forum (December 19, 2019) https://mobileecosystemforum.com/2019/12/19/whatsapp-will-sue-businesses-for-abusing-bulk-messaging/ | Secondary; seen through search results only, articles not opened |
| S11 | WhatsApp LLC v. Rockey Tech HK Ltd et al. (N.D. Cal., October 2022): complaint copy https://pplware.sapo.pt/wp-content/uploads/2022/10/whatsapp_llc_v-rockey_tech_hk_ltd.pdf; Sophos https://www.sophos.com/en-gb/blog/whatsapp-goes-after-chinese-password-scammers-via-us-court | Secondary; seen through search results only, complaint not read in full |
| S12 | Meta for Developers, "Onboarding WhatsApp Business app users" (coexistence), https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users | No last-updated date on the page |
| S13 | Meta for Developers, WhatsApp pricing, https://developers.facebook.com/docs/whatsapp/pricing | Reflects updates effective October 1, 2026 |
| S14 | Meta for Developers, WhatsApp throughput, https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput | 80 messages per second by default; seen through a search-engine summary ("updated May 21, 2026") |
| S15 | Baileys: https://github.com/WhiskeySockets/Baileys, README https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/README.md; npm metadata https://registry.npmjs.org/baileys, https://registry.npmjs.org/@whiskeysockets/baileys, https://registry.npmjs.org/@adiwajshing/baileys | |
| S16 | Baileys v7.0.0-rc10 release notes (mirror), https://newreleases.io/project/github/WhiskeySockets/Baileys/release/v7.0.0-rc10 | |
| S17 | whatsapp-web.js: https://github.com/wwebjs/whatsapp-web.js; npm https://registry.npmjs.org/whatsapp-web.js; issue #2789 https://github.com/pedroslopez/whatsapp-web.js/issues/2789 | |
| S18 | whatsmeow: https://pkg.go.dev/go.mau.fi/whatsmeow; https://proxy.golang.org/go.mau.fi/whatsmeow/@latest; README https://raw.githubusercontent.com/tulir/whatsmeow/main/README.md | |
| S19 | npm metadata: https://registry.npmjs.org/@wppconnect-team/wppconnect, https://registry.npmjs.org/venom-bot, https://registry.npmjs.org/@open-wa/wa-automate | |
| S20 | PyPI metadata: https://pypi.org/pypi/yowsup/json, https://pypi.org/pypi/neonize/json | |
| S21 | WAHA engines documentation, https://waha.devlike.pro/docs/how-to/engines/ | |
| S22 | Egypt Law No. 151 of 2020 and Executive Regulations (Ministerial Decree No. 816 of 2025), unofficial English translation by Andersen Egypt, https://eg.andersen.com/wp-content/uploads/2026/02/Law-No.-151-of-2020.pdf. S22b: Digital Policy Alert, https://digitalpolicyalert.org/change/17620-data-protection-regulation-in-executive-regulations-of-the-personal-data-protection-law-ministerial-decision-no-816-of-2025 | Translation; the binding text is the Arabic Official Gazette |
| S23 | Saudi PDPL: (a) DLA Piper, "Saudi Arabia's new Personal Data Protection Law in force", February 19, 2024, https://www.dlapiper.com/insights/publications/2024/02/saudi-arabias-new-personal-data-protection-law-in-force; (b) Securiti, "Regulation on Personal Data Transfer Outside the Kingdom" (updated September 30, 2026), https://securiti.ai/regulation-on-personal-data-transfer-outside-the-kingdom | Secondary. The official SDAIA text was not retrievable. |
| S24 | Render pricing, https://render.com/pricing | |
| Repo | `docs/plans/RESUTO_2_1_PLAN.md` §6.9 and §8; `docs/INTEGRATION_READINESS.md` (Meta / WhatsApp Cloud API); `docs/OPEN_BLOCKERS.md` B-4; `docs/STAGING_DEPLOYMENT.md` (Frankfurt hosting); `apps/api/src/common/crypto/secret-box.ts`, `keys.ts`; `apps/api/src/modules/connect/whatsapp-signup.service.ts` | Read at base `09dacb8` |

## 11. Claims not verified (to confirm before relying on them)

1. Which WhatsApp ToS version (and effective date) applies to users in Egypt and Saudi Arabia. The page served here
   showed January 4, 2021.
2. The word-for-word content of the WhatsApp Help Center articles S9a–e, including the "temporarily or permanently
   banned" wording and "8 million accounts per month".
3. WhatsApp's 2019 legal-action FAQ text (S10) and the details of the 2022 HeyMods lawsuit (S11). Both were seen only
   through search results and press coverage.
4. The 14-day primary-device inactivity logout. WhatsApp says only "a long period" [S8].
5. Any ban rate for low-volume, inbound-led linked-device use. No public data was found.
6. Whether WhatsApp can fingerprint protocol-level clients, and how.
7. Whether Meta would extend an organisation-level ban [S4] to Resuto's Tech-Provider app.
8. Whether Meta grants written consent for third-party Business-app integrations (clause (g)) in any form.
9. Coexistence availability in Egypt and Saudi Arabia, and current coexistence limits (a mirror lists Nigeria and
   South Africa as unsupported; Meta's page as summarised did not list exclusions).
10. EG and SA per-message rates (service, utility, marketing, authentication) from Meta's rate card.
11. The Cloud API default throughput figure (S14), seen through a search summary only.
12. Licences of WAHA, open-wa (custom) and neonize (not declared). Whether whatsmeow underlies mautrix-whatsapp.
13. Egypt PDPL wording (unofficial translation) and the end date of the compliance period (about November 2026).
14. Saudi PDPL article-level consent conditions (official SDAIA text not retrieved).
15. Every RAM-per-session, staffing, support-ticket and rate-limit figure in §6 and §9.2. These are **assumptions**.
16. WhatsApp Brand Guidelines constraints on an "Unofficial" label that names WhatsApp.
17. Whether Resuto's code handles coexistence webhooks (echoes, history, contacts). Not found by search; to confirm
    with 21-INT.
