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

- Refuses `NODE_ENV=production` and a non-local database without `DEMO_TARGET=staging`.
- Anything that looks like staging (a non-local host, `DEMO_TARGET=staging` or `NODE_ENV=staging`) also needs
  `--demo-tenant-only`. In that mode the database may hold other organizations: the loader only creates or
  updates rows of the demo tenant and never touches another organization. Without the flag it refuses any
  database that holds a non-demo organization.
- There is no reset path: the loader never deletes, truncates or drops anything. A slug clash with a non-demo
  organization, or a demo tenant left over from an interrupted first load, is refused.
- Every SQL statement is scoped to the demo organization (the list is at the top of the script).

## Re-running (refresh relative to the load time)

A second run against a completed tenant refreshes it instead of doing nothing:

1. live fixtures older than 6 h (kitchen tickets, the QR visit and its waiter call, deliveries, bookings that
   never arrived) are completed through the API the way staff would close them, and dated as history;
2. the history is topped up through yesterday with the same deterministic per-day plan, with a dated restock;
3. fresh live fixtures are created for today;
4. fixed monthly costs are upserted per month and kind (`externalRef demo-fixed:<YYYY-MM>:<kind>`);
5. a reconciliation run covers the new period, ending now (older runs that ended in the future are clamped);
6. the integrity check must pass, or the run exits 1.

Proven locally on disposable copies: fresh load, immediate reload, a copy aged by 3 days, a tenant from the
previous loader, and a shared database with a foreign organization in `--demo-tenant-only` mode.

## Integrity check (`scripts/demo/integrity-check.mjs`)

Read-only SQL assertions on the demo tenant, run by the loader (profile `loader`) and by `scripts/db/seed.mjs`
(profile `migration`): no future rows; reconciliation periods never end after the run; the stock running
balance never goes negative and matches the levels; sale movements are dated with their order; every month
has rent, utilities, fees and payroll; no booking, visit or call stale for more than 6 h and no ticket or
delivery job for more than 12 h; order milestones in order; Arabic names for the restaurant, branches,
categories and dishes; a website hero and a photo per dish; the Smash & Co storefront published with its hero.

```bash
DATABASE_URL=… node scripts/demo/integrity-check.mjs [--profile loader|migration] [--json]
node --test scripts/demo/test/        # unit tests + one test per assertion (DEMO_TEST_DATABASE_URL, local only)
```

## Consistency rules

- Opening stock is purchased the day before the history starts, sized to the planned sales, so stock never
  goes negative; sale movements are dated with their order (never at load time).
- Fixed costs: every month that overlaps the period books rent, utilities, POS fees and payroll once; partial
  months are prorated to the covered days and dated inside them; payroll for the current month is month to
  date. Salaries use the `labor` category; there are no ingredient expenses, because item costs carry COGS.
- Nothing is dated in the future.
- Each branch offers its own menu; the other branch does not list those dishes.
- Category and restaurant names have Arabic translations (`supabase/seeds/olive-room.demo.json`); every dish
  has its own photo; the website has a hero; the Smash & Co storefront is published.

## Local demo

The full demo is this loader against a running API. `scripts/db/seed.mjs` only migrates the legacy fixture
(re-timed to the load, stale legacy work imported as closed history) and is not a substitute for it.
