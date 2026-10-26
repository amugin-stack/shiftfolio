-- Tie-out Step 1b: realized revenue per brand-month + moderator payouts +
-- current-month expected host cost under the OLD logic (changes by design).
WITH revenue AS (
  SELECT b.name AS brand,
         to_char(s.start_time AT TIME ZONE 'UTC', 'YYYY-MM') AS month,
         SUM(ROUND(b.client_rate_cents * (EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 60) / 60.0))::bigint AS realized_revenue_cents
  FROM public.streams s
  JOIN public.brands b ON b.id = s.brand_id
  WHERE s.host_id IS NOT NULL
    AND b.client_rate_cents IS NOT NULL
    AND s.end_time <= ((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
  GROUP BY 1, 2
),
mods AS (
  SELECT m.name AS moderator,
         SUM(ROUND(m.rate_cents * (EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 60) / 60.0))::bigint AS realized_payout_cents
  FROM public.streams s
  JOIN public.moderators m ON m.id = s.moderator_id
  WHERE s.end_time <= ((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
  GROUP BY 1
),
old_expected AS (
  SELECT b.name AS brand,
         SUM(ROUND(
           COALESCE(o.rate_cents, r.rate_cents, 2000)
           * (EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 60) / 60.0
         ))::bigint AS expected_host_cost_cents_old
  FROM public.streams s
  JOIN public.brands b ON b.id = s.brand_id
  CROSS JOIN LATERAL (
    SELECT
      (EXTRACT(HOUR   FROM (s.start_time AT TIME ZONE 'UTC'))::int * 60
     + EXTRACT(MINUTE FROM (s.start_time AT TIME ZONE 'UTC'))::int)   AS slot_mins,
      EXTRACT(DOW FROM (s.start_time AT TIME ZONE 'UTC'))::int        AS dow,
      (s.start_time AT TIME ZONE 'UTC')::date                          AS date_key
  ) t
  CROSS JOIN LATERAL (
    SELECT ROUND((t.slot_mins - b.day_start_minutes)::numeric
                 / NULLIF(b.block_size_minutes, 0))::int AS block_index
  ) bi
  LEFT JOIN public.brand_shift_overrides o
    ON o.brand_id = s.brand_id AND o.shift_date = t.date_key AND o.block_index = bi.block_index
  LEFT JOIN public.brand_shift_rates r
    ON r.brand_id = s.brand_id AND r.day_of_week = t.dow AND r.block_index = bi.block_index
  WHERE s.host_id IS NOT NULL
    AND s.start_time >= date_trunc('month', now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'
    AND s.start_time <  (date_trunc('month', now() AT TIME ZONE 'America/Los_Angeles') + interval '1 month') AT TIME ZONE 'UTC'
  GROUP BY 1
)
SELECT 'revenue' AS section, brand AS k1, month AS k2, realized_revenue_cents AS cents FROM revenue
UNION ALL
SELECT 'moderator', moderator, NULL, realized_payout_cents FROM mods
UNION ALL
SELECT 'old_expected_host_cost_jun', brand, NULL, expected_host_cost_cents_old FROM old_expected
ORDER BY 1, 2, 3;
