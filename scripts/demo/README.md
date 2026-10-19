# Demo data (`scripts/demo/load-demo-data.mjs`)

Builds the demo restaurant **The Olive Room** (Egypt; Zamalek fine dining and Smash & Co burgers)
through the running Resuto API: menu with Arabic names and photos, floor plans, staff, inventory,
8 weeks of orders, QR dine-in, WhatsApp (sandbox transport), deliveries, reservations, marketing,
finance, Studio website, AI and MCP. **Local and staging only.**

- Every person, phone number and address is fictional and labelled `(demo)`.
- Payments go through the simulated provider; WhatsApp uses the sandbox channel; nothing leaves the system.
- Historical orders are placed through the API and then back-dated with SQL (the API always stamps
  "now"). The SQL the loader uses is listed at the top of the script.

## Run

```bash
# Local (dev auth): API on :4000 with AUTH_DEV_MODE=true and a worker (or RUN_WORKER_IN_PROCESS=true)
API_URL=http://127.0.0.1:4000 DATABASE_URL=postgres://postgres@127.0.0.1:54329/resuto \
DEMO_OWNER_PASSWORD=… DEMO_ADMIN_PASSWORD=… DEMO_STAFF_PASSWORD=… node scripts/demo/load-demo-data.mjs

# Staging (real Supabase Auth): runs inside the API container at boot with DEMO_SEED_ON_BOOT=1,
# DEMO_TARGET=staging, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY and SUPABASE_SERVICE_ROLE_KEY (see docs/STAGING_DEPLOYMENT.md).
# Accounts are created and re-passworded through the Supabase Admin Auth API (no direct writes to auth tables).
```

## Accounts

`owner@olive-room.demo.test`, `platform-admin@olive-room.demo.test`, and staff
`manager@`, `kitchen@`, `cashier@`, `marketing@`, `accountant@`, `host@`, `waiter@`, `driver1@`, `driver2@`
(same domain). Passwords come from `DEMO_OWNER_PASSWORD`, `DEMO_ADMIN_PASSWORD` and
`DEMO_STAFF_PASSWORD`; the loader never prints them. Re-running with new values resets the owner's password.

## Safety

- Refuses `NODE_ENV=production`, a non-local database without `DEMO_TARGET=staging`, and any database
  that contains a non-demo organization.
- Idempotent: a completed run is detected and skipped; an interrupted run stops and asks for a
  disposable database.

## Consistency rules (fixes from the October review)

- Opening stock is purchased before trading, sized to the planned sales, so stock never goes negative.
- Salaries use the `labor` category; there are no ingredient expenses, because item costs already carry COGS.
- Expenses are only booked inside the demo period, never in the future.
- Each branch offers its own menu; the other branch does not list those dishes.
- Category names have Arabic translations; only dishes with real photos get images.
