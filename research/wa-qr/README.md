# research/wa-qr: WhatsApp QR compatibility mode (21-WAQR)

## Status

| | |
|---|---|
| Stage | **Stage 1: desk research and written assessment.** Complete as a draft for owner review. |
| Gate | **G-WA** (plan item O-5): the owner reviews and signs, or rejects, the assessment |
| Recommendation | **Do not productise** QR mode for restaurant accounts. Use official WhatsApp Business app **coexistence** through Embedded Signup instead. The PoC is optional, and skipping it is reasonable. See `ASSESSMENT.md` §9. |
| Code | **None.** There is no PoC code, no `apps/wa-bridge`, and nothing reachable from the product. |
| Research date | 2026-10-25 |
| Plan reference | `docs/plans/RESUTO_2_1_PLAN.md` §6.9 (WhatsApp onboarding) and §8 (21-WAQR row) |

## Files

| File | What it is |
|---|---|
| `ASSESSMENT.md` | The policy and security assessment to sign before stage 2. It covers WhatsApp/Meta terms, ban risk, library options, session and hijack risk, Egypt and Saudi data protection, operating cost, comparison with the official path, the recommendation, the stage 2 controls, sources, and unverified claims. |
| `POC_DESIGN.md` | The design of an isolated proof of concept on Resuto-owned test numbers. **NOT IMPLEMENTED: requires explicit owner approval (gate G-WA).** |
| `README.md` | This page: status, scope fence and sign-off checklist |

## Scope fence (stage 1)

Done in stage 1:

- Public web research.
- Registry and project metadata lookups (npm, Go proxy, PyPI, project pages). No package or tarball was downloaded.
- Reading this repository.
- Writing these three Markdown files.

Not done in stage 1, and never done without a separate, explicit owner approval:

- Connecting to WhatsApp, pairing any number, or scanning any QR code.
- Installing, downloading or running any unofficial WhatsApp client library or third-party code.
- Any change to `apps/*`, `packages/*`, `supabase/migrations`, CI workflows, Dockerfiles, deploy configurations, or
  Render or Vercel settings.
- Making anything here reachable from the product, or including it in any build or deploy.

How this directory stays out of builds (checked at base `09dacb8`):

- `pnpm-workspace.yaml` includes only `apps/*` and `packages/*`.
- No `tsconfig*.json`, `next.config.*`, `turbo.json`, `vercel.json`, `package.json` or CI workflow references
  `research`.
- The `apps/api` and `apps/web` Dockerfiles copy explicit paths only.
- **One caveat for the lead.** The build stage of `apps/mcp-server/Dockerfile` runs `COPY . .`, so these Markdown
  files enter that stage's build context, but not the final image. This is harmless for Markdown. Before any PoC code
  is ever committed here, add `research` to `apps/mcp-server/Dockerfile.dockerignore`. That file is outside this
  workstream's fence.

## Owner sign-off checklist (G-WA)

Tick each item, then sign the decision. Nothing in stage 2, and nothing in the PoC, may start until this is signed.

### A. Understanding

- [ ] I have read `ASSESSMENT.md` §2. WhatsApp's Business App Terms forbid applications that interact with the
      Business app without WhatsApp's prior written consent (clause (g)). The consumer Terms forbid unauthorised
      automated access and multi-device use outside WhatsApp's own tools. A QR mode therefore breaches the terms by
      design, whatever the message volume.
- [ ] I understand the worst case (§2.6, §3):
  - a restaurant's public number can be banned, possibly permanently;
  - WhatsApp's policy allows Meta to bar Resuto *as an organisation* from WhatsApp products, which could affect
    Resuto's official Tech-Provider integration.
- [ ] I understand that a linked device receives **every** chat on the number, including personal, family, staff
      and group chats, and that the restaurant owner cannot consent for those third parties (§5.1, §8.3).
- [ ] I understand that the official coexistence path already lets a restaurant keep its existing WhatsApp Business
      number and phone app (§7).
- [ ] I have read the list of unverified claims (§11) and accept that the recommendation does not depend on them.

### B. Decision (choose one)

- [ ] **Option 1 (recommended): close QR mode.** No PoC and no stage 2. Effort goes to the official path:
      unblock B-4 and complete coexistence webhooks and UX in 21-INT.
- [ ] **Option 2: PoC only, no stage 2.** I approve the PoC in `POC_DESIGN.md` under preconditions P1–P7:
  - Resuto-owned test numbers only, unconnected to Resuto's Meta assets;
  - an isolated host;
  - at most 6 weeks;
  - **I accept that those test numbers may be banned and that the PoC breaches WhatsApp's terms for those
    accounts.**

  Stage 2 stays closed unless I sign again after reading the PoC results.
- [ ] **Option 3: stage 2 under every control in `ASSESSMENT.md` §9.2 (not recommended).** I accept the
      contractual, ban, data-protection and organisation-level risks. I require all 13 controls with tests. Only
      consenting pilot restaurants may be enabled, and only after a further explicit go-ahead.

### C. Independent of this decision (applies to Resuto's official path too)

- [ ] Legal advice is arranged on Egypt PDPL licensing and cross-border transfer permits. The Executive Regulations'
      compliance period ends about November 2026; see §8.1.
- [ ] Legal advice is arranged on Saudi PDPL transfer safeguards (SCCs and a risk assessment), because Resuto hosts in
      Frankfurt.

### D. Signature

| Decision (1 / 2 / 3) | Name | Date | Notes or conditions |
|---|---|---|---|
| | | | |
