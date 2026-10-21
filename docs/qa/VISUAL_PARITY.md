# Visual parity gate (CR-11) and phone browsers (CR-10)

## Visual parity

- **What is captured**: `tests/e2e/visual.spec.ts` (Playwright project `visual`, `E2E_VISUAL=1`): landing (EN desktop,
  AR phone), pricing, sign-in, restaurant site (EN desktop, AR phone), web order, reserve, QR table menu, staff
  overview, floor, orders, settings and the kitchen display.
- **Determinism**: fixed clock (`page.clock.setFixedTime`), reduced motion, CSS animations and the caret disabled,
  `document.fonts.ready` awaited, loading skeletons waited out, per-run text masked (`<time>`, order numbers,
  freshness lines, `[data-visual-mask]`). Tolerance 1 % of pixels.
- **Baselines per rendering environment** (fonts and rasterisers differ between machines):
  `tests/e2e/__visual__/local/` (development container, recorded 2026-10-21, two runs agreed) and
  `tests/e2e/__visual__/docker/` (official image `mcr.microsoft.com/playwright:v1.56.1-noble`, CI job `visual`).
  The landing and studio snapshots of the chromium project likewise have `tests/e2e/__screenshots__/docker/`.
- **CI** (`.github/workflows/ci.yml`, job `visual`): runs in the Docker image, enforces every committed docker
  baseline, records missing ones (`--update-snapshots=missing`) and uploads them as the `visual-baselines` artifact.
  The ordinary `browser` job keeps `--ignore-snapshots` because a GitHub runner's fonts match no recorded environment.
- **Status: not yet a gate (CR-11 partial).** No docker baseline is committed yet (only `__visual__/local/`), so
  today the `visual` job records every surface and cannot fail on a pixel difference. It becomes a gate once the
  owner approves the first run's `visual-baselines` artifact and the images are committed under
  `tests/e2e/__visual__/docker/`; then drop `--update-snapshots=missing` from the job so a missing baseline fails it.
- **Approval**: `docs/ui/visual-baselines.json` pairs each surface with the legacy capture (`docs/ui/baseline/`) it
  was compared against side by side, with notes on intended differences. A baseline becomes `approved` only when the
  owner has looked at the pair. Update a baseline with `--update-snapshots` only after such an approval.
- **Other capture sets** (staging galleries, legacy-vs-new composites):
  `node scripts/ui/visual-compare.mjs --baseline <dir> --actual <dir> --out <diffs> [--tolerance 0.01]`.

## Phone browsers (WebKit)

- Project `webkit-iphone-13` (`E2E_WEBKIT=1`) runs `scenario-dine-in`, `scenario-whatsapp` and `scenario-driver` in
  WebKit with the iPhone 13 profile; phone contexts opened by the specs (`newContext(…, { mobile: true })`) take the
  project's device. CI installs WebKit (`playwright install --with-deps chromium webkit`).
- WebKit is not installed in the development sandbox, so the WebKit run has not been executed here. The same specs
  with the iPhone 13 profile in Chromium fail in the same six places as the default Chromium project (2026-10-21):
  the guest, WhatsApp and KDS hand-over specs still look for selectors of the pre-restoration UI (`.g-brand`,
  "2 item(s)", "Out for delivery"). They need updating before either project can be green.
- A manual pass on a real iPhone (sticky sheets, `100vh`, date inputs, the Arabic keyboard) is still required on
  staging.
