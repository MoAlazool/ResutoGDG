# Open blockers and decisions needing the owner

Items here cannot be completed from this environment without the owner's
access, approval or money. Everything else continues in parallel.

| # | Blocker | Impact | What is needed | Status |
|---|---|---|---|---|
| B-1 | No Supabase project exists for Resuto (the connected account has only unrelated projects). | Staging/production database, Auth and Storage cannot be provisioned; local work uses plain Postgres 16 + an auth shim. | Owner approval to create `resuto-staging` and `resuto-prod` Supabase projects (paid plan recommended for production: PITR backups), or credentials for existing ones. | Open — not created (creating projects may incur cost). |
| B-2 | No Docker daemon in the build environment. | `supabase start`, container builds and the compose stack were not executed here. | Run `docker compose up` / `supabase start` on a machine with Docker; CI can add an image build job. | Open |
| B-3 | No payment-provider credentials (Paymob, Stripe, Moyasar). | Real adapters are implemented against public docs and tested with signature vectors; never exercised against provider sandboxes. | Merchant (or Resuto test) sandbox accounts + webhook secrets per provider. | Open |
| B-4 | No Meta WhatsApp Cloud API app / test number. | WhatsApp runs through the sandbox transport; Meta adapter unverified. | Meta developer app, WABA, test phone number, app secret, verify token; template approvals. | Open |
| B-5 | No ad-platform developer access (Meta Ads, TikTok, Snapchat). | Ads adapters unverified; sandbox reports are labelled and excluded from ROI. | Developer apps + test ad accounts; app review where required. | Open |
| B-6 | No ZATCA (FATOORA) or ETA onboarding. | Fiscal documents use real data structures with sandbox-stub submission; no clearance/reporting. | ZATCA developer portal CSID onboarding (sandbox → simulation → production); ETA pre-production client credentials. | Open — legal certification is not claimed. |
| B-7 | No accounting (Wafeq, Qoyod, Odoo) or POS (Foodics) credentials. | Adapters unverified. | API keys / OAuth apps from each provider. | Open |
| B-8 | No Gemini API key. | Native AI assistant and creative generation run in labelled rules/template mode. | `GEMINI_API_KEY` (server-side only). | Open |
| B-9 | Custom domain activation needs a hosting provider integration (Vercel domains API token). | Domains can be added and DNS-verified; SSL/routing activation is a manual provider step. | Vercel project + token for the 2.0 web app. | Open |
| B-10 | Production deployment and data cutover. | Nothing in this branch touches production (`main`, Render, Vercel production, Firebase). | Explicit owner approval, maintenance window, legacy data export. | Not started by design |
| B-11 | Legacy production issues found in the audit (table QR tokens exposed by `/api/public`; `PAYMENT_MODE=test` in `render.yaml`). | Affects the live legacy app, not 2.0. | Owner decision; a separate task card was queued to fix the legacy app. | Reported |
