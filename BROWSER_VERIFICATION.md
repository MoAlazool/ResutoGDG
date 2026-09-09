# Resuto browser checkpoint

## SaaS pages and floor studio update — 6 September 2026

Implemented and verified the Resuto landing page (`/`), The Olive Room guest website (`/restaurant`), and manager-only Floor studio (`/manager/floor-editor`). Generated restaurant imagery is identified as illustrative; product screenshots come from the real app using fictional test data.

`npm run test:editor` passes in real Chromium. It verifies public desktop/mobile layouts and image loading, manager login, canvas drag/resize/rotation handles, property editing, multi-selection, alignment and spacing, keyboard movement, duplication, deletion, undo/redo, explicit save/discard, zoom/pan, background controls, draft isolation and reload recovery, two-manager conflicts, draft export and successful retry after a failed network save. The tested mobile viewport is 390 pixels; this is browser emulation, not physical-device testing.

The original service smoke test was updated for the dedicated editor and shared SVG reservation map and passes: reservation/deposit/check-in, QR guest visits, kitchen updates, lost-response order/payment retries, split bills, cleaning, pickup/delivery and restart persistence. Existing QR identifiers remain stable after saving floor geometry.

40 Node tests pass, including eight new floor-domain/API tests and the additional restaurant route template check. The pre-upgrade local SQLite files were backed up to `data/before-floor-upgrade/` before migration.

Screenshots are in `artifacts/`: `saas-desktop.png`, `saas-mobile.png`, `restaurant-desktop.png`, `restaurant-mobile.png`, `editor-preview.png`, `floor-editor-desktop.png`, and `floor-editor-mobile.png`. The editor's test-completion screenshot includes intentionally added test objects; `editor-preview.png` shows the clean seed floor.

Hosting, live Gemini and physical iPhone/Android testing remain outside this update. The app is still a local single-restaurant demo with simulated payments, not a multi-tenant subscription service.

## Original browser checkpoint

Verified on the user's Windows machine using real headless Chromium, a real Node HTTP server, and a temporary SQLite database. The expanded rehearsal passed **twice consecutively**. No production or existing demo data was changed.

## Fixes made during verification

1. The reservation deposit succeeded, but the new confirmation dialog disappeared. A delayed close event from the old dialog was removing the new dialog. Dialog cleanup now captures and removes only its own element.
2. The mobile ordering grid could expand a 390-pixel viewport to 404 pixels. Grid children now permit shrinking. The smoke test checks document width against the configured viewport, rather than the browser's potentially expanded `innerWidth`.

## Browser checks passed

- Separate manager and kitchen logins, isolated from guest sessions.
- Manager walk-in seating, table QR link and PIN join in two guest contexts.
- Order confirmation to the kitchen, with exactly one order after deliberately losing a successful server response and retrying.
- Kitchen preparing, ready and served transitions appear in the guest page without manually refreshing. Observed times in the final run: 0.78 s, 1.78 s and 2.28 s respectively. These are local observations, not a latency guarantee.
- A lost successful payment response can be retried without charging the test ledger twice. The second guest sees and pays the remaining EGP 95 after the first pays EGP 50 against EGP 145.
- Manager closes the settled, fulfilled visit and explicitly cleans the table.
- Guest creates a reservation from the floor and confirms the simulated deposit. A second browser cannot select that table in the conflicting time window.
- Manager checks in the reservation; the visit has exactly EGP 200 deposit credit.
- Pickup and delivery orders both reach the same kitchen.
- Dragging a table persists its position and preserves its QR URL.
- Server restart preserves order records, reservations, table geometry and QR identities. Existing staff access can read the reopened state.
- No uncaught page errors in the tested journeys; no horizontal document overflow at the tested 1440-pixel desktop and 390-pixel mobile widths.
- OpenCV independently decoded the table QR from a rendered manager screenshot.

The existing 31 automated Node tests also pass: 24 API/domain tests and seven lightweight template execution tests. The template tests are distinct from the real browser rehearsal.

## Reproduce

```powershell
npm test
npm run test:browser
```

Browser prerequisites: Python Playwright and its Chromium installation. The script starts port 3100, creates fictional accounts and records in a temporary directory, runs the journeys, restarts its own server, and removes its test database. The normal port-3000 app stays separate. Screenshots are saved to the ignored `artifacts/` directory.

## Not claimed as verified

Actual iPhone/Safari and Android devices, phone-camera scanning over a LAN, live Gemini, Arabic/mixed-language model responses, hosted deployment/HTTPS, WebMCP, payment providers, WhatsApp and courier integrations. No credentials were supplied for live Gemini; the demo remains labeled as rules mode. Full P1 completion still includes service hours, product photography and more complete reservation-hold/draft recovery, as listed in the README.
