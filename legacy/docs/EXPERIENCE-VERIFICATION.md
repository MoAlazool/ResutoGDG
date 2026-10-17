# Resuto experience upgrade — verification report

Status: the original single-restaurant MVP has been extended. This report does **not** certify that every launch/business requirement in the supplied brief is complete. Independent merchant signup, subscription billing and a real 14-day account trial remain unimplemented. The working demo stays available without payment. Existing SQLite data was not replaced by the new template.

## 1. Redesign

Guided setup, table selection, confirmation and pricing now have dedicated bilingual layouts. The existing Resuto landing page, restaurant site and operations application were retained and extended.

## 2. Implemented interactions

Six setup steps save through a manager-only revision-checked API. Restaurant name, uploaded logo and first-branch details persist. Native/Connect selection, setup shortcuts, progress and completion checklist work. Incomplete work can be resumed; local drafts preserve in-progress fields. Provider authorization still uses the existing Integrations workspace.

The floor editor adds a 12-table draft template, premium/minimum-spend metadata, expanded seating features, layer locking, zone visibility/materials, structure presets, automatic numbering, alignment guides and optional server autosave. Manual save, undo/redo, conflict handling and archival restrictions remain.

Bookings use current availability, branch/date/time/party, preference chips, an accessible table-button list, table details, Gemini or explicit rule matching, test deposits and a token-scoped confirmation. Calendar download, text sharing, configured directions, changing the time and cancellation work. Sales inquiries persist in a manager-only inbox in the last setup step; there is no email delivery.

## 3–5. Floor / editor / preview architecture

`public/floor-model.js` provides metadata constants and an explicit demo template. `floor-domain.js` remains the authoritative save/validation layer. `public/floor-shared.js` renders the same normalized geometry for operations, editing and guest views.

The 2D editor remains the existing SVG/pointer implementation. It supports mouse/touch, transforms, multi-selection, keyboard movement, guides, snapping, undo/redo, layers and background images. It was not replaced with a second editor framework.

The preview is **CSS/SVG 2.5D**, not a Three.js/WebGL renderer. It projects that same floor using perspective, simple material patterns, furniture shadows, pan, zoom and pinch gestures. There are no GLTF assets, raster textures, continuous rendering loop or WebGL dependency. It should not be described as photorealistic 3D. The landing page offers an interactive 2D/2.5D switch.

## 6. Persistence and compatibility

The existing version-1 document is extended with optional metadata, preserving compatibility: tables gain `minimumSpend` (integer minor EGP units), `premium`, `locked`, and expanded `features`; structural objects/zones retain lock, visibility and material. Objects include divider, entrance, kitchen and bar in addition to existing types.

Restaurant `profile`, revisioned `setup`, and private `salesInquiries` are additional JSON state fields. No destructive SQL migration or table-ID replacement occurs on startup. Template application is an explicit draft action; saving archives removed tables and blocks active visits/future bookings. QR identifiers for retained tables remain unchanged. Existing JSONB/Postgres transaction storage remains compatible with the new fields.

## 7–9. Routes, components and APIs

Routes: `/manager/setup`, `/pricing`, upgraded `/reserve`, retained `/manager/floor-editor`, `/restaurant`, `/menu`, `/order`, `/t/:qr`, `/manager`, `/kitchen`, `/`.

New frontend modules: `experience-ui.js`, `experience.css`, `setup.js`, `pricing.js`, `reservations.js`, `floor-model.js`, `floor-preview.js`, `locales/ar-experience.js`.

New APIs: manager `GET/POST /api/setup`; public `GET /api/plans`, `GET /api/availability`, `POST /api/table-recommend`, `GET /api/reservation?token=…`, `POST /api/reservation-change`, `POST /api/sales-inquiry`. Mutation endpoints use validation, existing transactions and appropriate revision/idempotency guards. Inquiries are rate-limited and omitted from public data.

## 10. Gemini

The table recommender sends available table IDs, capacities, zones and features in a structured prompt. JSON output is filtered against real IDs, capacity and requested metadata; availability is checked again before returning. Invalid output/provider failure uses explicit rule matching. Arabic quiet/window/far-from-entrance/terrace preferences are supported. Mocked Gemini tests reject invented and undersized tables. **Live Gemini was not exercised.**

Reference: https://ai.google.dev/gemini-api/docs/structured-output

## 11. Pricing

Starter 799, Growth 1,499, Pro 2,999 EGP/month and Business custom. Annual pricing is 10 monthly payments, saving 16.7%. Proposed add-ons and separate provider fees are shown in both languages. Unsupported staff-account limits, support commitments and enterprise features are marked planned/subject to agreement. Pricing is a launch proposal, not functioning subscription checkout. CTAs open the usable guest demo or the persisted inquiry form.

## 12. Arabic and RTL

The existing local Manrope/Plex Arabic fonts and heavier Arabic weights are reused. New page copy is bilingual, layout uses logical properties, and the language switch sets the HTML direction. New editor labels are added to the existing dictionary. Entered restaurant/branch/table names remain user data; they are not automatically machine-translated.

## 13. Performance

The preview module is approximately 2.7 KB uncompressed, with no graphics-library dependency. A local headless desktop Chromium pricing-page sample reached DOMContentLoaded/load in 83 ms. This is a local sample, **not** a mobile performance benchmark, Lighthouse score or production latency guarantee. Physical-device FPS testing remains outstanding.

## 14. Verification

- `npm run build`: JavaScript syntax checks passed.
- `npm test`: 58 tests passed, including permissions, atomic floor saves, stale revisions, idempotency, stock/payment invariants, setup validation, private inquiries and Gemini ID validation.
- `python scripts/editor_smoke.py`: passed dragging, resizing, rotation, duplication, multi-selection, alignment/spacing, keyboard, undo/redo/discard, stale-save export/reload, background, failed-save retry and responsive panels.
- `python scripts/premium_smoke.py`: passed menu-first AI demo ordering, reservation, PIN-free QR ordering, four-person named split payment, ratings, kitchen fulfillment, close and cleaning; EN/AR responsive checks passed.
- `python scripts/experience_smoke.py`: passed saved restaurant/branch names and uploaded logo, Native mode, 12-table template, save/reload, locks, autosave, 2.5D preview, T6 window booking, T9 Arabic recommendation, annual pricing and private inquiry submission. New public pages checked at 375/430/768/1440 CSS px; RTL at 375/430/1440. Manager setup/editor also checked in Arabic at 375/430/1440. Synthetic two-finger pinch input changed the floor zoom in Chromium. No page errors or horizontal overflow in these checks.
- `npm run package:netlify`: function packaging passed. This is packaging verification, not a deployment.

## 15. Remaining requirements and limitations

- No independent merchant registration, tenant isolation, subscription billing, account-based 14-day trial or enforced plan entitlements. The original app still operates one restaurant installation, with manager/kitchen roles.
- One shared primary-branch reservation floor. Additional branches retain the existing pickup/delivery support. Separate branch floors are not implemented.
- 2.5D is implemented instead of a Three.js 3D scene. There is no live split-screen editing and rendering; reopening preview reads the current draft.
- Opening hours are stored display text, not an enforced booking schedule. Currency/timezone remain EGP/Africa-Cairo. Minimum spend is disclosed metadata, not a separately charged fee.
- Existing integrations require provider credentials. Selecting Connect does not perform OAuth authorization. No new unimplemented provider is advertised as connected.
- Live reservation deposit checkout and automatic refunds are not implemented. Existing live bill checkout adapters remain available when configured. Cancellation advises the guest about the deposit rather than inventing a refund.
- Self-service modification currently changes date/time on the same table; the API can validate table/party changes, but that broader UI is not provided.
- Physical mobile hardware, production hosting, live payment credentials/webhooks and live Gemini verification remain separate tasks.

## 16. Screenshots

Generated in `artifacts/`: `experience-onboarding-basics.png`, `experience-floor-2d.png`, `experience-floor-25d.png`, `experience-reservation.png`, `experience-confirmation.png`, `experience-reserve-375.png`, `experience-ar-reserve.png`, `experience-landing-1440.png`, `experience-pricing-1440.png`. Reviewed visually after generation. Representative copies are in `docs/screenshots/`.
