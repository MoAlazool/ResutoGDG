# WhatsApp QR compatibility mode: proof-of-concept design

> **NOT IMPLEMENTED: requires explicit owner approval (gate G-WA).**
> This is a design only. No code, package, container, migration or deploy setting exists for it. No phone number has
> been paired and no unofficial client has been installed or run. Building and running it is a separate step that the
> owner must approve in writing, after reading `ASSESSMENT.md`.
>
> `ASSESSMENT.md` §9.1 recommends **not** productising QR mode, and says that skipping this PoC is reasonable. This
> design exists so the owner can make an informed choice if first-hand stability data is wanted.

## 1. Purpose and non-goals

**Purpose.** On Resuto-owned test numbers only, measure what desk research cannot:

1. connection stability (logouts, reconnects, protocol errors);
2. operational effort (re-pairing, upgrades);
3. resource use per session;
4. how much non-customer data a linked device receives;
5. whether the stage 2 controls (filtering, rate limits, encryption, kill switch) are technically workable.

**Non-goals:**

- No restaurant accounts, no real customers and no customer data.
- No integration with `apps/api`, `apps/web`, `apps/mcp-server`, `packages/*` or `supabase/migrations`.
- No production or staging deployment.
- No bulk, marketing or template-like sends.
- No attempt to evade WhatsApp's detection: no IP rotation, fingerprint spoofing or anti-ban tricks. The PoC measures
  honest behaviour.
- No statistical estimate of production ban probability. A handful of numbers over weeks cannot produce one (§6).

## 2. Preconditions (all needed before any code is written)

| # | Precondition | Evidence |
|---|---|---|
| P1 | The owner signs G-WA for the PoC specifically: scope, duration, test numbers, and acceptance that those numbers may be banned and that the PoC itself breaches WhatsApp's terms for those accounts (ASSESSMENT §2.6) | Signed checklist in `research/wa-qr/README.md` |
| P2 | **Test numbers.** 2–3 new SIMs bought by Resuto, registered to Resuto. **Not** the owner's or staff's personal numbers. **Not** registered to, or linked with, Resuto's Meta Business portfolio, WABA, Tech-Provider app or any official-path asset. | Register of numbers, kept outside git |
| P3 | **Test devices.** Dedicated phones with WhatsApp Business. No personal contacts. Contacts hold only the other test numbers. | Device inventory |
| P4 | **Counterparty numbers.** 2–3 more Resuto-owned numbers acting as "customers". These are the only senders. | Same register |
| P5 | Library chosen from ASSESSMENT §4 (whatsmeow preferred). Exact version or commit pinned. Licence reviewed. Dependency tree reviewed before the first run. | Review note |
| P6 | Isolated environment ready (§4). Key material generated for this PoC only. | Environment note |
| P7 | Fixed end date: at most 6 weeks from the first pairing. Teardown plan agreed (§9). | Calendar entry |

## 3. Architecture

```
  Test "customer" phones (Resuto-owned)      Test "restaurant" phones (Resuto-owned, WhatsApp Business)
              │  WhatsApp (official apps)                     │ Linked devices → scan QR
              ▼                                               ▼
        ┌──────────────────── WhatsApp servers ────────────────────┐
        └──────────────────────────────┬───────────────────────────┘
                                       │ linked-device protocol (companion)
                     ┌─────────────────▼─────────────────┐
                     │  wa-bridge-poc (single container) │  isolated VM / sandbox account,
                     │  - companion client (pinned lib)  │  NOT Render/Vercel prod or staging
                     │  - filter: 1:1, allowlisted JIDs  │
                     │  - rate limiter + typing presence │
                     │  - metrics exporter (counts only) │
                     │  - kill switch (file/env + CLI)   │
                     └───────┬───────────────────┬───────┘
                             │                   │
               sealed session blobs        metrics (no content)
               (AES-256-GCM, PoC key)      → local Prometheus / CSV
                             │
                     ┌───────▼────────┐
                     │ local Postgres │  PoC-only instance; never Supabase staging/prod
                     │ or SQLite file │
                     └────────────────┘
```

- **Where the code would live.** `research/wa-qr/poc/`, which does not exist yet. The plan (§6.9) names an
  `apps/wa-bridge` prototype. For the PoC, putting it under `research/` keeps it **out of the pnpm workspace**:
  `pnpm-workspace.yaml` includes only `apps/*` and `packages/*`. If the lead prefers `apps/wa-bridge`, the exclusions
  in §8 become mandatory, because `apps/*` *is* a workspace glob.
- **Language.** Go (whatsmeow) gives a separate toolchain and module (`go.mod` inside `research/wa-qr/poc/`). Nothing
  in the TypeScript build can resolve it.
- **Interfaces.** None to Resuto. A CLI is the only control surface:
  - `pair` shows the QR in the terminal;
  - `status`;
  - `send --to <allowlisted test JID> --reply-to <msg id>`;
  - `kill`;
  - `shred`.

  No HTTP listener. No inbound network.
- **Automatic responder (optional, owner decision).** For each inbound message from an allowlisted test "customer",
  send one fixed acknowledgement after a 3–8 s delay with typing presence. This mirrors the narrowest stage 2 behaviour.

## 4. Environment and isolation

- **Host.** A separate VM or sandbox account, such as a throwaway cloud project or a local machine. It must not be:
  - Resuto's Render services (`resuto-2-staging-*`);
  - Vercel;
  - Supabase `resuto-staging`;
  - anywhere that holds Resuto credentials.
- **Secrets.** No `CREDENTIALS_KEYS`, `SIGNING_KEY`, Meta app secret, Supabase key or other Resuto secret is present.
  The PoC's own key is generated on the host and never committed.
- **Network.** Egress to WhatsApp only, plus the package mirror during build. No inbound ports.
- **Users.** At most 2 named Resuto engineers have access, and the host's login records serve as the access log.
- **Code review.** A second engineer reviews the pinned dependency tree before the first run and again after any
  upgrade.

## 5. Threat model (PoC scope)

| Asset | Threat | Control in the PoC |
|---|---|---|
| Test accounts' companion keys | Theft from disk, backups or logs | Sealed with AES-256-GCM (Resuto's `v1:<keyId>:<iv>:<tag>:<ct>` format, PoC-only key). AAD = `wa-poc:v1:<number-label>`. Plaintext only in process memory. Logs scrubbed (no keys, no message bodies). Host disk encrypted. |
| Resuto production and staging | Spill-over: shared credentials, IPs or Meta assets causing organisation-level enforcement (ASSESSMENT §2.6) | No shared secrets, hosts, IPs, Meta portfolio or numbers (P2, §4) |
| Supply chain | Malicious or compromised library or dependency | Exact pin, reviewed dependency tree, isolated host with no Resuto secrets, no inbound network |
| Third-party personal data | The test "restaurant" phone receives non-test messages: spam, wrong numbers, WhatsApp system messages | New numbers with no personal contacts. The filter drops any non-allowlisted JID before persistence. Only counts are recorded (§7). |
| Accidental scope creep | A real restaurant or customer number paired | Allowlist of the test JIDs hard-coded at build time. `pair` refuses any account whose own JID is not on the allowlist, and logs out and shreds immediately. |
| Kill-switch failure | Sessions remain linked after the PoC ends | Teardown (§9) includes **unlinking on the phone**, which is authoritative, then checking *Linked devices* is empty |

## 6. What is measured

| Metric | How | Why |
|---|---|---|
| Session uptime % | Connection-state events, per number per day | Reliability versus the official API |
| Logouts per session-week (and cause: primary inactivity, server-initiated, protocol error) | Disconnect reason codes from the library | Drives the support-cost model (ASSESSMENT §6) |
| Re-pair events and minutes of human effort each | Manual log | Support burden |
| Protocol or decryption error rate | Library error counters | Upkeep burden |
| Restriction or ban signals (any "restricted" or 463-type error, account banned screen on the phone) | Library errors plus a daily phone check | The headline risk. **Reported as raw events, not as a probability.** With 2–3 numbers over 6 weeks, zero bans gives no meaningful upper bound on the production ban rate. |
| RAM and CPU per session (idle, under the PoC's message rate) | Container metrics | Replaces the RAM **assumptions** in ASSESSMENT §6 |
| Non-customer traffic received (counts by type: group, status, broadcast, non-allowlisted 1:1, history-sync bundles) | Counters before the filter. No content stored. | Quantifies the over-collection problem (ASSESSMENT §5.1, §8) |
| Filter correctness | Unit tests plus counters after the filter (must be zero non-allowlisted items persisted) | Proves the stage 2 minimisation control is workable |
| Rate-limit adherence | Send log (timestamps, recipient label) | Proves the stage 2 limits are enforceable |
| Upgrade events (library releases during the PoC, breaking or not) | Release watch | Upkeep burden |
| Migration to official (optional, only if a test WABA exists by then) | Coexistence onboarding of one test number; confirm the companion is invalidated [ASSESSMENT S6] | Validates the one-click exit |

**Traffic profile.** Test "customers" send 5–20 messages per day in a few conversations, at human pace. The bridge
replies 1:1 within the rate limits. No new-contact outreach.

## 7. Data handling

- **Stored:**
  - sealed session blobs;
  - metrics (counts, timestamps, reason codes);
  - a send log containing recipient *labels* (`cust-1`), not phone numbers or bodies.
- **Not stored:** message bodies (beyond the in-memory reply decision), media, contacts, history-sync contents and
  group data. History-sync bundles are dropped on receipt.
- **Personal data.** The test numbers are Resuto's, so personal data should be close to none. Any message from a
  non-allowlisted sender is dropped unread past the counter. If one is seen, its count is reported and nothing else is
  kept.
- **Retention.** Metrics are kept for the PoC report, then summarised into `research/wa-qr/POC_RESULTS.md` (counts
  only; written only if the PoC runs). Raw metrics and the database are deleted at teardown.
- **Location.** The PoC host region is chosen to avoid cross-border questions where possible. Since no EG/SA
  customers are involved, the transfer duties in ASSESSMENT §8 are not triggered by test-only data. **Counsel to
  confirm.**

## 8. How it stays out of builds and deploys

| Mechanism | Detail | Check |
|---|---|---|
| Not a workspace package | Lives under `research/wa-qr/poc/`. `pnpm-workspace.yaml` globs only `apps/*` and `packages/*`. No `package.json` is used (Go module). | `pnpm -r ls` lists no wa-poc package |
| Not referenced by TypeScript or Next | No `tsconfig*.json`, `next.config.*`, `turbo.json` or `vercel.json` mentions `research` (verified at base `09dacb8`: no matches) | `grep -rn research` over those files returns nothing |
| Not in Docker images | `apps/api` and `apps/web` Dockerfiles copy explicit paths (`packages`, `apps/<name>`, `supabase/migrations`, `scripts/...`), never `research/`. `apps/mcp-server/Dockerfile` runs `COPY . .` in its **build stage**, so `research/` enters that stage's context, although the final image copies only `/out` and `dist`. **Before any PoC code is committed**, the lead should add `research` to `apps/mcp-server/Dockerfile.dockerignore`. That is a one-line change outside this workstream's fence. | `docker build` context listing; final image `ls` |
| Not in CI | `.github/workflows/ci.yml` must not build or test `research/wa-qr/poc`. If a guard is wanted, a CI step should *fail* when `apps/**` or `packages/**` imports `research/` or `wa-bridge`. | Workflow review |
| Not deployed | No Render or Vercel service, blueprint or environment variable for it. Vercel builds only `legacy/` (see `vercel.json`). | Render and Vercel service lists reviewed at PoC start and end |
| No secrets shared | §4 | Secret inventory |
| If `apps/wa-bridge` is used instead (plan wording) | It **would** match `apps/*`. Required before creating it: a pnpm workspace exclusion (`!apps/wa-bridge`), Turbo filter exclusion, `.dockerignore` entries for the api, web and mcp Dockerfiles, and a CI import guard. **Recommendation: use `research/wa-qr/poc/` for the PoC.** | Same checks |

## 9. Kill switch and teardown

1. **Immediate stop (any engineer, any time).** `wa-poc kill` closes the connections and stops the process. A file
   flag (`KILL`) on the host is checked every 5 s as a fallback.
2. **Session destruction.** `wa-poc shred` calls the library logout for each number, deletes the sealed blobs and
   destroys the PoC key. Without the key, any remaining blob is unreadable.
3. **Authoritative unlink.** On each test phone, open *Linked devices*, log out the "Resuto PoC" device, and confirm
   the list is empty. Take a screenshot for the report.
4. **Automatic triggers** that run steps 1 and 2 without a human:
   - any restriction or ban signal on any number;
   - a protocol error rate above a threshold (e.g. more than 5% of operations in an hour);
   - any attempt to send to a JID that is not on the allowlist;
   - reaching the PoC end date.
5. **Teardown.** Delete the host or VM and the local database. Keep only the counts-only `POC_RESULTS.md`. Retire or
   keep the SIMs according to the owner's decision. If a number is banned, record it; do not appeal (no evasion).

## 10. Exit criteria and report

The PoC ends at 6 weeks, on any ban, or on owner request. `POC_RESULTS.md` would contain:

- the metrics in §6;
- the observed effort per week;
- the measured RAM per session, replacing the ASSESSMENT §6 assumptions;
- every restriction or ban event;
- the volume of non-customer traffic;
- a restatement of whether anything changes the ASSESSMENT §9.1 recommendation.

The report cannot by itself approve stage 2. Stage 2 still requires the owner's separate sign-off against ASSESSMENT
§9.2.
