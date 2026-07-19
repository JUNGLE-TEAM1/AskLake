# Nessie SQL Benchmark Comparison

Gate: **PASS**
Confidence: `exploratory-small-sample`

Correctness: 33.33% → 100.00% (+66.67%p)

Performance is gated only for cases correct in both campaigns; overall metrics are informational.

- `ambiguous_top_customers` (ambiguous): PASS; correct 0 → 5; failures=[]
- `approx_distinct_customers` (approximate_aggregate): PASS; correct 5 → 5; failures=[]
- `avoid_cross_join` (cross_join_trap): PASS; correct 5 → 5; failures=[]
- `avoid_select_star` (select_star_trap): PASS; correct 0 → 5; failures=[]
- `customer_spend_rank` (high_cardinality): PASS; correct 5 → 5; failures=[]
- `exact_distinct_customers` (approximate_aggregate): PASS; correct 0 → 5; failures=[]
- `invalid_private_dataset` (invalid_scope): PASS; correct 5 → 5; failures=[]
- `monthly_order_count` (time_partition): PASS; correct 0 → 5; failures=[]
- `recent_large_orders` (projection_filter): PASS; correct 0 → 5; failures=[]
- `region_category_revenue` (multi_join): PASS; correct 0 → 5; failures=[]
- `segment_revenue` (fact_dimension_join): PASS; correct 0 → 5; failures=[]
- `status_revenue` (aggregate): PASS; correct 0 → 5; failures=[]

Promotion requires bounded live evidence and explicit human approval.
