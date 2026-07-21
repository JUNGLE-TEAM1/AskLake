-- Run with:
-- sqlite3 -header -column output/analysis.sqlite < insights.sql

-- 1. Age cohort x category preference
WITH clicks AS (
  SELECT
    CASE
      WHEN u.age BETWEEN 18 AND 34 THEN '18-34'
      WHEN u.age BETWEEN 35 AND 44 THEN '35-44'
      ELSE '45+'
    END AS age_group,
    p.category
  FROM click_events e
  JOIN users u ON u.user_id = e.user_id
  JOIN products p ON p.product_id = e.product_id
  WHERE e.event_type = 'product_click'
), totals AS (
  SELECT age_group, COUNT(*) AS total_clicks
  FROM clicks
  GROUP BY age_group
)
SELECT
  c.age_group,
  c.category,
  COUNT(*) AS clicks,
  ROUND(100.0 * COUNT(*) / t.total_clicks, 2) AS click_share_pct
FROM clicks c
JOIN totals t ON t.age_group = c.age_group
GROUP BY c.age_group, c.category
ORDER BY c.age_group, click_share_pct DESC;

-- 2. Acquisition-channel funnel
SELECT
  u.acquisition_channel,
  SUM(e.event_type = 'product_impression') AS impressions,
  SUM(e.event_type = 'product_click') AS clicks,
  SUM(e.event_type = 'add_to_cart') AS carts,
  SUM(e.event_type = 'purchase_click') AS purchase_clicks,
  ROUND(100.0 * SUM(e.event_type = 'product_click') /
        NULLIF(SUM(e.event_type = 'product_impression'), 0), 2) AS ctr_pct,
  ROUND(100.0 * SUM(e.event_type = 'purchase_click') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_purchase_pct
FROM click_events e
JOIN users u ON u.user_id = e.user_id
GROUP BY u.acquisition_channel
ORDER BY click_to_purchase_pct DESC;

-- 3. Membership-tier funnel
SELECT
  u.membership_tier,
  SUM(e.event_type = 'product_click') AS clicks,
  SUM(e.event_type = 'add_to_cart') AS carts,
  SUM(e.event_type = 'purchase_click') AS purchase_clicks,
  ROUND(100.0 * SUM(e.event_type = 'add_to_cart') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_cart_pct,
  ROUND(100.0 * SUM(e.event_type = 'purchase_click') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_purchase_pct
FROM click_events e
JOIN users u ON u.user_id = e.user_id
GROUP BY u.membership_tier
ORDER BY click_to_purchase_pct DESC;

-- 4. Local-hour pattern by actual event device
SELECT
  device_type,
  COUNT(*) AS events,
  SUM(CASE WHEN CAST(SUBSTR(event_time, 12, 2) AS INTEGER) BETWEEN 18 AND 23 THEN 1 ELSE 0 END)
    AS evening_events,
  ROUND(100.0 * SUM(CASE WHEN CAST(SUBSTR(event_time, 12, 2) AS INTEGER)
                              BETWEEN 18 AND 23 THEN 1 ELSE 0 END) / COUNT(*), 2)
    AS evening_share_pct
FROM click_events
GROUP BY device_type
ORDER BY evening_share_pct DESC;

-- 5. Null control: no direct gender multiplier was planted
SELECT
  u.gender,
  SUM(e.event_type = 'product_click') AS clicks,
  SUM(e.event_type = 'purchase_click') AS purchase_clicks,
  ROUND(100.0 * SUM(e.event_type = 'purchase_click') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_purchase_pct
FROM click_events e
JOIN users u ON u.user_id = e.user_id
GROUP BY u.gender
ORDER BY u.gender;

-- 6. Product-rating-count long tail
WITH event_clicks AS (
  SELECT product_id, COUNT(*) AS clicks
  FROM click_events
  WHERE event_type = 'product_click'
  GROUP BY product_id
), product_clicks AS (
  SELECT p.product_id, p.rating_count, COALESCE(e.clicks, 0) AS clicks
  FROM products p
  LEFT JOIN event_clicks e ON e.product_id = p.product_id
), ranked AS (
  SELECT *, NTILE(10) OVER (ORDER BY rating_count DESC) AS rating_count_decile
  FROM product_clicks
)
SELECT
  rating_count_decile,
  COUNT(*) AS products,
  SUM(clicks) AS clicks,
  ROUND(AVG(clicks), 2) AS avg_clicks_per_product
FROM ranked
GROUP BY rating_count_decile
ORDER BY rating_count_decile;

-- 7. Category purchase-click intent
SELECT
  p.category,
  SUM(e.event_type = 'product_click') AS clicks,
  SUM(e.event_type = 'add_to_cart') AS carts,
  SUM(e.event_type = 'purchase_click') AS purchase_clicks,
  ROUND(100.0 * SUM(e.event_type = 'add_to_cart') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_cart_pct,
  ROUND(100.0 * SUM(e.event_type = 'purchase_click') /
        NULLIF(SUM(e.event_type = 'product_click'), 0), 2) AS click_to_purchase_pct
FROM click_events e
JOIN products p ON p.product_id = e.product_id
GROUP BY p.category
ORDER BY click_to_purchase_pct DESC;

-- 8. Daily event counts in long form
WITH daily AS (
  SELECT
    SUBSTR(event_time, 1, 10) AS event_date,
    SUM(event_type = 'product_impression') AS impressions,
    SUM(event_type = 'product_click') AS clicks,
    SUM(event_type = 'add_to_cart') AS carts,
    SUM(event_type = 'purchase_click') AS purchase_clicks
  FROM click_events
  GROUP BY SUBSTR(event_time, 1, 10)
)
SELECT event_date, 'impressions' AS metric_name, impressions AS metric_value FROM daily
UNION ALL
SELECT event_date, 'clicks', clicks FROM daily
UNION ALL
SELECT event_date, 'carts', carts FROM daily
UNION ALL
SELECT event_date, 'purchase_clicks', purchase_clicks FROM daily
ORDER BY event_date, metric_name;

-- 9. Daily funnel rates
SELECT
  SUBSTR(event_time, 1, 10) AS event_date,
  SUM(event_type = 'product_impression') AS impressions,
  SUM(event_type = 'product_click') AS clicks,
  SUM(event_type = 'add_to_cart') AS carts,
  SUM(event_type = 'purchase_click') AS purchase_clicks,
  ROUND(100.0 * SUM(event_type = 'product_click') /
        NULLIF(SUM(event_type = 'product_impression'), 0), 2) AS ctr_pct,
  ROUND(100.0 * SUM(event_type = 'add_to_cart') /
        NULLIF(SUM(event_type = 'product_click'), 0), 2) AS click_to_cart_pct,
  ROUND(100.0 * SUM(event_type = 'purchase_click') /
        NULLIF(SUM(event_type = 'add_to_cart'), 0), 2) AS cart_to_purchase_click_pct
FROM click_events
GROUP BY SUBSTR(event_time, 1, 10)
ORDER BY event_date;
