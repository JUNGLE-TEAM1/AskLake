-- Synthetic commerce insight queries.
-- These queries use CASE expressions supported by both SQLite and PostgreSQL.
-- `purchase_click` is a proxy. Real purchase conversion uses `order_completed`.

-- 1. Session funnel and completed-order conversion
WITH session_funnel AS (
  SELECT
    session_id,
    MAX(CASE WHEN event_type = 'product_impression' THEN 1 ELSE 0 END) AS impression,
    MAX(CASE WHEN event_type = 'product_click' THEN 1 ELSE 0 END) AS click,
    MAX(CASE WHEN event_type = 'add_to_cart' THEN 1 ELSE 0 END) AS cart,
    MAX(CASE WHEN event_type = 'purchase_click' THEN 1 ELSE 0 END) AS purchase_click,
    MAX(CASE WHEN event_type = 'checkout_started' THEN 1 ELSE 0 END) AS checkout_started,
    MAX(CASE WHEN event_type = 'payment_success' THEN 1 ELSE 0 END) AS payment_success,
    MAX(CASE WHEN event_type = 'order_completed' THEN 1 ELSE 0 END) AS order_completed
  FROM commerce_events
  GROUP BY session_id
)
SELECT
  SUM(impression) AS impression_sessions,
  SUM(click) AS click_sessions,
  SUM(cart) AS cart_sessions,
  SUM(purchase_click) AS purchase_click_sessions,
  SUM(checkout_started) AS checkout_started_sessions,
  SUM(payment_success) AS payment_success_sessions,
  SUM(order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(impression), 0), 3)
    AS session_order_conversion_pct,
  ROUND(100.0 * SUM(checkout_started) / NULLIF(SUM(purchase_click), 0), 2)
    AS checkout_entry_pct,
  ROUND(100.0 * SUM(payment_success) / NULLIF(SUM(checkout_started), 0), 2)
    AS payment_success_pct,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(payment_success), 0), 2)
    AS order_confirmation_pct
FROM session_funnel;

-- 2. Acquisition channel: proxy click versus actual completed order
WITH session_funnel AS (
  SELECT
    session_id,
    user_id,
    MAX(CASE WHEN event_type = 'product_impression' THEN 1 ELSE 0 END) AS impression,
    MAX(CASE WHEN event_type = 'purchase_click' THEN 1 ELSE 0 END) AS purchase_click,
    MAX(CASE WHEN event_type = 'order_completed' THEN 1 ELSE 0 END) AS order_completed
  FROM commerce_events
  GROUP BY session_id, user_id
)
SELECT
  u.acquisition_channel,
  SUM(s.impression) AS active_sessions,
  SUM(s.purchase_click) AS purchase_click_sessions,
  SUM(s.order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(s.purchase_click) / NULLIF(SUM(s.impression), 0), 2)
    AS purchase_click_proxy_pct,
  ROUND(100.0 * SUM(s.order_completed) / NULLIF(SUM(s.impression), 0), 2)
    AS order_conversion_pct
FROM session_funnel s
JOIN users u ON u.user_id = s.user_id
GROUP BY u.acquisition_channel
ORDER BY order_conversion_pct DESC;

-- 3. Membership tier conversion
WITH session_funnel AS (
  SELECT
    session_id,
    user_id,
    MAX(CASE WHEN event_type = 'product_impression' THEN 1 ELSE 0 END) AS impression,
    MAX(CASE WHEN event_type = 'purchase_click' THEN 1 ELSE 0 END) AS purchase_click,
    MAX(CASE WHEN event_type = 'order_completed' THEN 1 ELSE 0 END) AS order_completed
  FROM commerce_events
  GROUP BY session_id, user_id
)
SELECT
  u.membership_tier,
  SUM(s.impression) AS active_sessions,
  SUM(s.purchase_click) AS purchase_click_sessions,
  SUM(s.order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(s.purchase_click) / NULLIF(SUM(s.impression), 0), 2)
    AS purchase_click_proxy_pct,
  ROUND(100.0 * SUM(s.order_completed) / NULLIF(SUM(s.impression), 0), 2)
    AS order_conversion_pct
FROM session_funnel s
JOIN users u ON u.user_id = s.user_id
GROUP BY u.membership_tier
ORDER BY order_conversion_pct DESC;

-- 4. Device conversion and checkout drop-off
WITH session_funnel AS (
  SELECT
    session_id,
    MIN(device_type) AS device_type,
    MAX(CASE WHEN event_type = 'product_impression' THEN 1 ELSE 0 END) AS impression,
    MAX(CASE WHEN event_type = 'checkout_started' THEN 1 ELSE 0 END) AS checkout_started,
    MAX(CASE WHEN event_type = 'payment_success' THEN 1 ELSE 0 END) AS payment_success,
    MAX(CASE WHEN event_type = 'order_completed' THEN 1 ELSE 0 END) AS order_completed
  FROM commerce_events
  GROUP BY session_id
)
SELECT
  device_type,
  SUM(impression) AS active_sessions,
  SUM(checkout_started) AS checkout_started_sessions,
  SUM(payment_success) AS payment_success_sessions,
  SUM(order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(impression), 0), 2)
    AS order_conversion_pct,
  ROUND(100.0 * (SUM(checkout_started) - SUM(order_completed)) /
        NULLIF(SUM(checkout_started), 0), 2) AS checkout_dropoff_pct
FROM session_funnel
GROUP BY device_type
ORDER BY order_conversion_pct DESC;

-- 5. Completed-order value. Do not use purchase_click for revenue.
SELECT
  COUNT(*) AS completed_orders,
  ROUND(SUM(order_value), 2) AS gross_order_value,
  ROUND(AVG(order_value), 2) AS average_order_value,
  ROUND(MIN(order_value), 2) AS minimum_order_value,
  ROUND(MAX(order_value), 2) AS maximum_order_value
FROM commerce_events
WHERE event_type = 'order_completed';

-- 6. Category conversion and completed-order value
WITH category_sessions AS (
  SELECT
    p.category,
    e.session_id,
    MAX(CASE WHEN e.event_type = 'product_impression' THEN 1 ELSE 0 END) AS impression,
    MAX(CASE WHEN e.event_type = 'order_completed' THEN 1 ELSE 0 END) AS order_completed,
    SUM(CASE WHEN e.event_type = 'order_completed' THEN e.order_value ELSE 0 END) AS order_value
  FROM commerce_events e
  JOIN products p ON p.product_id = e.product_id
  GROUP BY p.category, e.session_id
)
SELECT
  category,
  SUM(impression) AS impression_sessions,
  SUM(order_completed) AS order_completed_sessions,
  ROUND(100.0 * SUM(order_completed) / NULLIF(SUM(impression), 0), 2)
    AS order_conversion_pct,
  ROUND(SUM(order_value), 2) AS gross_order_value
FROM category_sessions
GROUP BY category
ORDER BY order_conversion_pct DESC, gross_order_value DESC;

-- 7. event_id uniqueness: duplicate_event_ids must be zero
SELECT
  COUNT(*) AS total_events,
  COUNT(DISTINCT event_id) AS unique_event_ids,
  COUNT(*) - COUNT(DISTINCT event_id) AS duplicate_event_ids
FROM commerce_events;

-- 8. Invalid server-source mapping: every count must be zero
SELECT
  event_type,
  event_source,
  COUNT(*) AS invalid_events
FROM commerce_events
WHERE event_source <> CASE event_type
  WHEN 'product_impression' THEN 'web_client'
  WHEN 'product_click' THEN 'web_client'
  WHEN 'add_to_cart' THEN 'web_client'
  WHEN 'purchase_click' THEN 'web_client'
  WHEN 'checkout_started' THEN 'checkout_service'
  WHEN 'payment_success' THEN 'payment_service'
  WHEN 'order_completed' THEN 'order_service'
  ELSE '__unsupported__' END
GROUP BY event_type, event_source;
