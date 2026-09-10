# Resuto IMPACT X — evidence and judging coverage

Prepared from the two supplied judging PDFs, the current repository, a fresh local runtime review, and browser captures dated 2026-09-10.

## Verification summary

- Build: `npm run build` passed.
- Test suite: 77 tests discovered; **76 passed, 0 failed, 1 skipped**.
- Skipped test: Firebase emulator tenant-isolation test. It remains a production gate.
- Live Gemini: guest recommendation and manager menu-extraction draft both completed in the configured local workspace.
- Order proof: synthetic order `#001`, EGP 135, moved from guest confirmation through kitchen `received → preparing → ready`.
- Payments: checkout capture stayed in test mode. Stripe/Paymob adapters and signed callback validation exist; no live merchant acceptance was claimed.

## Judging matrix

| Criterion | Weight | Main slide | Appendix | Evidence used | Claim boundary |
|---|---:|---:|---:|---|---|
| Problem definition | 10 | 2 | 21–22 | Judging pack positioning; explicit target customer; workflow handoffs | No invented interviews or market statistics |
| Impact and SDG alignment | 15 | 8 | 18–19 | 30-day design, five KPIs, baseline/post comparison, SDG 8 link | Targets are proposed success thresholds, not achieved outcomes |
| Innovation | 10 | 3, 6 | 14, 16 | Connected operating state; bounded Gemini recommendations and extraction | Human approval remains required |
| Solution and UX | 10 | 4, 5 | 13–14 | Fresh mobile, reservation, kitchen, manager and Arabic/RTL captures | Demo restaurant brands are fictional, not customers |
| Technical implementation | 15 | 5, 7 | 13, 15–16, 20 | Repository code, state-machine proof, auth/tenant design, tests | Firebase emulator isolation is not yet proven in this run |
| Feasibility | 10 | 11 | 19–20 | 90-day gated plan, risk register and acceptance checkpoints | Roadmap is a plan, not completed certification |
| ROI and business model | 15 | 9, 10 | 17–19 | Egypt/Saudi pack pricing; transparent Egypt Growth calculation | Pricing and benefits are hypotheses pending pilot evidence |
| Sustainability | 10 | 11 | 19–20 | Per-branch subscription, AI cost controls, monitoring/fallback plan | Unit economics require real cohorts |
| Presentation | 5 | 1–12 | 21–22 | 12-slide narrative, Arabic notes, 340-second timing, Q&A | Main story is 5:40; appendix is outside timed pitch |
| Google technology bonus | +5 | 6 | 16 | Gemini provider integration and fresh live outputs | A runtime check is not an uptime guarantee |
| Efficiency bonus | +5 | 3, 5, 11 | 19–20 | Connected workflow and instrumentation-oriented pilot | Operational savings must be measured during pilot |

## Pricing and ROI trace

- Egypt monthly before tax: Starter EGP 799; Growth EGP 1,499; Pro EGP 2,999; Business custom.
- Egypt illustrative 14% tax totals: EGP 910.86; EGP 1,708.86; EGP 3,418.86.
- Saudi target before VAT: SAR 199 / 399 / 699. Founder offer: SAR 149 / 299 / 499. Illustrative 15% VAT totals: SAR 228.85 / 458.85 / 803.85.
- Egypt Growth model: benefit EGP 5,100 less subscription EGP 1,499 = net benefit EGP 3,601. ROI = `3,601 ÷ 1,499 × 100 = 240.23%`, displayed as 240%.
- Exclusions stated in deck: hardware, gateway fees, tax, setup fees, unsupported attribution, and any unverified operating benefit.

## Primary sources

1. `/Users/tank/Downloads/IMPACT X Judging Criteria.pdf`, 7 pages.
2. `/Users/tank/Downloads/resuto-impact-x-judging-pack-ar.pdf`, 23 pages.
3. Current repository files under `/Users/tank/Downloads/Resuto-main`.
4. Fresh browser captures under `output/presentation/selected-screenshots`.
5. Validation receipt: `.codex-finalizer/resuto-impactx-pitch/Resuto_IMPACTX_Pitch.validation.json`.

## Notes on source interpretation

- The Arabic pack’s page 18 rendered the inequality glyph order ambiguously under RTL. The deck therefore expresses thresholds in plain language: 80% of orders routed through Resuto, 10% improvement in at least two KPIs, and team CSAT 4/5.
- The pack is dated 2026-09-09. Commercial figures are presented as proposal inputs and were not independently re-verified as current competitor pricing.
- Resuto is the platform brand. The Olive Room and Smash & Co are fictional demo restaurants.
