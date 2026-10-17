# Literature review — Resuto Intelligence research tracks

**Verification.** Every entry below was checked on 2026-10-17 against the Crossref metadata API
(`https://api.crossref.org/works/<DOI>`): title, year, venue, pages and author surnames match the DOI
record. No entry was included without that check. 14 papers are listed (the brief asked for 10; the
extra four are verified too). Summaries are our own words about why each paper matters to this project.

Track key: **T1** demand forecasting · **T2** customer intelligence & recommendations · **T3** delivery & operational optimisation.

## Forecasting (T1)

1. **Hyndman, R. J., & Koehler, A. B. (2006).** Another look at measures of forecast accuracy.
   *International Journal of Forecasting*, 22(4), 679–688. https://doi.org/10.1016/j.ijforecast.2006.03.001
   — Reviews scale-dependent, percentage and relative error measures and shows why MAPE breaks down on
   series with zeros. This motivates our use of MAE/RMSE plus the volume-weighted WAPE for intermittent
   menu items (Ramadan specials, slow sellers) and of seasonal-naive baselines as the reference.

2. **Makridakis, S., Spiliotis, E., & Assimakopoulos, V. (2022).** M5 accuracy competition: Results,
   findings, and conclusions. *International Journal of Forecasting*, 38(4), 1346–1364.
   https://doi.org/10.1016/j.ijforecast.2021.11.013
   — The M5 competition forecast hierarchical daily retail unit sales; tree-based gradient boosting with
   calendar and lag features dominated, and simple benchmarks remained hard to beat on many series. It is
   the closest public analogue to item-level restaurant demand and the template for our feature design.

3. **Friedman, J. H. (2001).** Greedy function approximation: A gradient boosting machine.
   *The Annals of Statistics*, 29(5), 1189–1232. https://doi.org/10.1214/aos/1013203451
   — The foundational description of gradient boosting with arbitrary differentiable losses. Our
   `hist_gbm` model is a histogram-based implementation of this idea with a Poisson loss suited to counts.

4. **Bergmeir, C., & Benítez, J. M. (2012).** On the use of cross-validation for time series predictor
   evaluation. *Information Sciences*, 191, 192–213. https://doi.org/10.1016/j.ins.2011.12.028
   — Compares blocked/rolling-origin evaluation schemes for time series. It supports our choice of
   rolling-origin backtests that train strictly before each origin, both in the service's automatic model
   selection and in the offline test protocol, to avoid look-ahead leakage.

5. **Lasek, A., Cercone, N., & Saunders, J. (2016).** Restaurant sales and customer demand forecasting:
   Literature survey and categorization of methods. In *Smart City 360°* (Lecture Notes of the Institute
   for Computer Sciences, Social Informatics and Telecommunications Engineering), 479–491.
   https://doi.org/10.1007/978-3-319-33681-7_40
   — Surveys restaurant-specific forecasting work and groups methods (time-series, regression, ML). It
   frames which signals (day of week, holidays, events) matter for restaurants and confirms that most
   published studies are single-restaurant case studies — a gap a multi-tenant platform can address.

## Customer intelligence & recommendations (T2)

6. **Fader, P. S., Hardie, B. G. S., & Lee, K. L. (2005).** RFM and CLV: Using iso-value curves for
   customer base analysis. *Journal of Marketing Research*, 42(4), 415–430.
   https://doi.org/10.1509/jmkr.2005.42.4.415
   — Links recency, frequency and monetary value to customer lifetime value with a probabilistic model.
   It justifies RFM as a compact customer representation and points to the Semester-2 upgrade from
   rule-based RFM segments to probabilistic CLV/"alive" models.

7. **Neslin, S. A., Gupta, S., Kamakura, W., Lu, J., & Mason, C. H. (2006).** Defection detection:
   Measuring and understanding the predictive accuracy of customer churn models. *Journal of Marketing
   Research*, 43(2), 204–211. https://doi.org/10.1509/jmkr.43.2.204
   — Results of a churn-modelling tournament: simple logistic regression is competitive, and model
   evaluation should use out-of-time validation. Our churn baseline (logistic regression, temporal labels,
   compared against recency rules) follows this guidance.

8. **Agrawal, R., Imieliński, T., & Swami, A. (1993).** Mining association rules between sets of items
   in large databases. *Proceedings of the 1993 ACM SIGMOD International Conference on Management of
   Data*, 207–216. https://doi.org/10.1145/170035.170072
   — Introduces support/confidence association rules over market baskets. The "frequently bought with"
   recommendations use exactly these measures (plus lift) over order baskets.

9. **Sarwar, B., Karypis, G., Konstan, J., & Riedl, J. (2001).** Item-based collaborative filtering
   recommendation algorithms. *Proceedings of the 10th International Conference on World Wide Web*,
   285–295. https://doi.org/10.1145/371920.372071
   — Shows that item–item similarity computed offline scales better and is often more accurate than
   user–user filtering. Item-to-item co-occurrence is our production baseline for that reason.

10. **Linden, G., Smith, B., & York, J. (2003).** Amazon.com recommendations: Item-to-item collaborative
    filtering. *IEEE Internet Computing*, 7(1), 76–80. https://doi.org/10.1109/MIC.2003.1167344
    — An industrial account of item-to-item recommendations at scale. It informs the serving design: a
    cheap co-occurrence table per tenant, recomputed per request, with popularity fallback.

11. **Rendle, S., Freudenthaler, C., & Schmidt-Thieme, L. (2010).** Factorizing personalized Markov
    chains for next-basket recommendation. *Proceedings of the 19th International Conference on World
    Wide Web*, 811–820. https://doi.org/10.1145/1772690.1772773
    — Defines next-basket recommendation combining personal preference and sequential (last-basket)
    transitions. Our hybrid score (personal frequency + association from the latest basket) is a simple
    non-factorised baseline of the same idea and FPMC is a Semester-2 candidate.

12. **Järvelin, K., & Kekäläinen, J. (2002).** Cumulated gain-based evaluation of IR techniques.
    *ACM Transactions on Information Systems*, 20(4), 422–446. https://doi.org/10.1145/582415.582418
    — Defines (normalised) discounted cumulated gain. We report NDCG@K alongside Precision@K and Recall@K
    for the leave-last-basket-out evaluation.

## Delivery & operational optimisation (T3)

13. **Croes, G. A. (1958).** A method for solving traveling-salesman problems. *Operations Research*,
    6(6), 791–812. https://doi.org/10.1287/opre.6.6.791
    — The origin of the 2-opt edge-exchange improvement used after nearest-neighbour construction in the
    route planner.

14. **Solomon, M. M. (1987).** Algorithms for the vehicle routing and scheduling problems with time
    window constraints. *Operations Research*, 35(2), 254–265. https://doi.org/10.1287/opre.35.2.254
    — Classic insertion heuristics and benchmark instances for routing with time windows. Our promised
    delivery times are time windows; today we only report violations (and offer a lateness objective),
    and Solomon-style insertion and multi-driver assignment are Semester-2 work.

## Not included

Papers on Ramadan-specific demand effects and on meal-delivery routing were considered, but we did not
include any whose bibliographic record we could not confirm through Crossref in this session.
