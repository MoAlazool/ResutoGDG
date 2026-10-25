# Native iPad UX review — 25 October 2026

## Evidence and scope

The review uses fresh **native CoreSimulator captures**, not generated mockups or a web replica. The app runs its actual SwiftUI, Keychain and encrypted stores with explicitly synthetic HTTP fixtures. Every frame shows **SIMULATED UI TEST — NOT STAGING**. No screenshot establishes authenticated staging, hardware or production acceptance.

Baseline application UI: `2d1cfe9`. Capture-only revisions `39b79ac` and `8e4c175` do not change the application UI. Initial capture run [40198418276](https://github.com/MoAlazool/ResutoGDG/actions/runs/40198418276) produced eight English and two Arabic full frames, but its two capture scenarios failed later in the flow. Those individual inspected images are valid evidence; that run is not a passing UI suite. The capture handshake was hardened; [baseline run 40200247954](https://github.com/MoAlazool/ResutoGDG/actions/runs/40200247954) passed 107 core tests and both visual scenarios, producing all 19 expected full native captures. Evidence: `evidence/native-ux-baseline.json`.

CoreSimulator retains original PNGs under `raw/`. The review copies apply a quarter-turn only when needed to display the physical simulator frame upright. Sidecar JSON records the transformation. No UI pixels are added, cropped or retouched. XCTest attachment captures on the current runner truncate landscape content; they remain diagnostic attachments, not the primary visual evidence.

## Findings and implemented changes

| Capture | Finding | Implementation and operational reason |
|---|---|---|
| 01 sign-in EN/AR | Placeholder-only credentials and a weak reading hierarchy | Explicit email/password labels, staff access context, responsive introduction plus credential card, prominent sign-in, LTR email input within RTL. No credentials are retained in view state after submission. |
| 02 workspace EN/AR | Full-width sparse rows do little to distinguish restaurant, role and branch | Bounded readable workspace column, separate restaurant and branch cards, visible role/selection, and explanation that only authorized scopes appear. Membership filtering and backend checks are preserved. |
| 03 menu EN | Large navigation column and low-emphasis prices compete with the catalogue | Narrower native sidebar, solid catalogue cards, stronger name/price hierarchy, selected category pills and a clear search action. The actual product imagery or an honest neutral fallback is used; no invented popularity or sales metrics. |
| 04 customization EN | Numeric group limits are cryptic; the main action sits in the toolbar | Required/optional badges, explicit option selection range, high-contrast selection surfaces, quantity card, notes limit and bottom action rail with a **line estimate**. Existing modifier constraints remain authoritative. |
| 05 cart EN | Send and local save have equal prominence; notes compete with items | One filled Review and send action; secondary local save; kitchen notes and promotion in a disclosure; readable line modifiers and notes. Dine-in table selection opens the actual floor workflow. |
| 06 review EN | Little recap of what will be submitted | Item quantities, fulfillment/table context, estimate and the existing server-pricing warning before explicit submission. No local tax total is presented as a server quote. |
| 08 checkout EN | Audit rows push cash entry down the form | Server due/payment state first, online cash entry next, expandable complete price breakdown, retained server status IDs and financial confirmation. No payment success is inferred locally. |
| Narrow/portrait and large text | Fixed catalogue/cart arrangement constrains ordering space | Geometry-based dock on roomy landscape; a full cart sheet opened by an accessible order bar elsewhere. Scrollable cart content, adaptive product cards and system Dynamic Type. |
| Kitchen / floor / sync | Inconsistent state typography and action grouping | Shared status badges, grouped kitchen tickets/notes, floor status legend and explicit local-draft versus accepted-order recovery language. These are implementation changes; see the final captures and test record for actual verification. |
| Device / printers | Operational caveats and pairing actions lack emphasis | Readable linking caveat, clear paired state, larger pairing control, stronger printer state labels. Read-only shadow mode and real-device printer limitations remain explicit. |

## Executed review follow-up

[Native run 40201606143](https://github.com/MoAlazool/ResutoGDG/actions/runs/40201606143), source `106010a`, passed Release, 107 core tests and all 21 native UI tests, including the accessibility-size compact cart. Its 19 captures were inspected as full native frames. The review confirmed the menu, cart, workspace, cash action and operational hierarchy improvements, and exposed a remaining issue: Arabic sheets did not consistently inherit RTL despite translated content. The follow-up explicitly reapplies the selected language inside navigation presentations, declares both bundle localizations, localizes recognized allergen tokens while preserving unknown server text, and adds real frame-position/Western-digit assertions. The correction passed [run 40210274577](https://github.com/MoAlazool/ResutoGDG/actions/runs/40210274577) at `42263eb`: all 107 core and 21 UI tests, both builds, including physical frame-position assertions. All 19 final native frames were inspected. `UX_GALLERY.md` contains selected before/after evidence.

The theme's specified accent versus white/black references has calculated contrast ratios 12.00:1 and 12.97:1 (`evidence/design-contrast.json`). This is a narrowly scoped calculation, not an audit of all rendered text, images or system states.

## Visual system and performance

Evergreen accent, warm neutral canvas, solid content surfaces, consistent rounded cards and restrained borders. Native split navigation, system sheets and toolbars remain intact. Frosted material is limited to the modifier/review action rails; Reduce Transparency switches these to opaque surfaces. Tap feedback respects Reduce Motion. This is compatible material treatment on the selected Xcode SDK, not a claim that iPadOS 26 Liquid Glass APIs were built or verified.

Catalogue and kitchen remain lazy grids; cart validation is evaluated once per cart body rather than once for each action. Product images use system AsyncImage; decorative assets, image-generation dependencies, persistent animation loops and external UI packages are not added. Core money, tax, idempotency, scoped authorization and financial replay rules are unchanged.

Arabic uses native RTL leading/trailing layout, the existing Western-digit money formatter, explicit localized labels and English/Arabic key parity checks. The physical floor map deliberately keeps spatial coordinates unchanged. Visible status labels accompany color. New frequent action targets are at least 44 points, generally 48–52 points.

## Acceptance still required

- **Completed for the final 19 synthetic frames:** full native screenshots inspected in both languages. This is not a real-catalogue/device visual acceptance.
- **Completed at `42263eb`:** all 21 native regression cases, including compact accessibility cart, failure recovery, pairing and restricted roles. Synthetic tests are not backend integration.
- Test VoiceOver focus order, Switch Control, keyboard traversal, text clipping at every supported Dynamic Type size, contrast measurement, dark appearance, reduced motion/transparency and all iPad window sizes. Screenshots alone do not prove accessibility compliance.
- Measure menu scrolling/tap latency, cold/warm startup and memory on actual supported iPads with a representative real catalogue. Simulator launch results are not hardware acceptance.
- Run authorized staff/device staging lifecycle against the same order ID in web, KDS, payment ledger, inventory and analytics after Claude's staging rollout and QA identity setup.
- Validate AirPrint and each specifically supported network printer on physical hardware. No universal printer compatibility or successful paper output is claimed.

## Design references

- [Apple: adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass): use system navigation and controls; reserve translucent layering for navigation/control surfaces and maintain content clarity.
- [Apple: materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple: accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple: designing for iPadOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-ipados)
- [Square: item detail settings](https://squareup.com/help/us/en/article/8634-customize-item-details-settings): operational reference for deliberate modifier/quantity/note selection; no Square visual assets or unsupported feature claims.
