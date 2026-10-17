# SDG alignment and impact measurement

Resuto is both a startup product and a two-semester AI graduation project. This page maps the
Sustainable Development Goals we claim to **indicators Resuto actually measures**, and to where the
numbers come from. No sustainability result is reported until it is measured on a real restaurant;
everything computed today on demo or synthetic data is labelled as such.

| SDG | Why it applies | Indicator | Source in Resuto | Status |
|---|---|---|---|---|
| **SDG 9** Industry, innovation & infrastructure (primary) | Digital infrastructure and AI for small/medium restaurants in Egypt and KSA | Modules adopted per restaurant; share of orders through digital channels | `subscriptions`, `subscription_modules`; `GET /analytics/summary` (channel mix) | Measurable now |
| **SDG 12** Responsible consumption & production (primary) | Less food waste and paper | Measured food-waste value and quantity (waste movements with reasons) | `GET /analytics/sustainability`, `GET /inventory/waste-report` | Measured only when staff record waste |
| | | Paper avoided: count of digital menus/orders/receipts/fiscal e-documents | `GET /analytics/sustainability` — a **count**; grams are shown only when the caller supplies grams-per-sheet, labelled an estimate | Count measurable now |
| | | Stock-out and over-stock risk from demand forecasts | `GET /intelligence/forecast`, insights `stock-out risk` | Model evaluated on synthetic data only |
| **SDG 8** Decent work & economic growth (supporting) | Revenue and margin growth for small businesses | Revenue, AOV, repeat rate, gross margin (with cost coverage), attributed (non-incremental) campaign revenue | `GET /analytics/*`, `GET /finance/pnl` | Measurable now |
| **SDG 13** Climate action (supporting) | Fewer delivery kilometres | Route distance vs placement order; delivered-per-km | `POST /intelligence/routes/plan` (advisory), `delivery_jobs.distance_m` | Routing evaluated on synthetic instances; no emissions claimed |

## Rules for reporting

1. **Measured vs hypothetical.** The ROI calculator (`POST /analytics/roi`) returns `kind: 'hypothetical'` with its
   assumptions; it is never reported as an achieved result.
2. **Coverage first.** Every analytics response carries `meta.dataCoverage` (for example, the share of order lines with
   a known cost). Report coverage alongside any margin or waste figure.
3. **No emissions numbers** until a documented emission factor and real distance data are both available.
4. **Synthetic data is not evidence.** Research results in `research/*/results/20261017-seed42` come from the seeded
   synthetic generator (`research/data/generate_synthetic.py`) and demonstrate the pipelines only.

## Research tracks and team

See `research/README.md` for the three tracks (demand forecasting; customer intelligence & recommendation; delivery &
operational optimisation), their reproducible pipelines, metrics (MAE/RMSE/WAPE; Precision@K/Recall@K/NDCG; distance,
time, violations, computation time), the verified literature review (`research/literature/LITERATURE_REVIEW.md`), and
the Semester-2 plan. Human team responsibilities (from the project brief):

| Member | Responsibility |
|---|---|
| Mohamed Adel Fouad | AI & ML, forecasting, customer intelligence |
| Hamed Atef Mohamed | Connect, customer engagement, AI tools, recommendation/growth logic |
| Fahd Taha Kassem | Delivery optimisation, routing and data pipelines |
| Mohamed Ahmed Elbassiony | Backend, architecture, database and security |
| Abdelrahman Khaled Mostafa | Frontend, product experience and AI visualisations |
