-- Tie-out Step 1a: realized host payouts under the OLD rate-card logic.
-- The `resolved` CTE must match migration 046's backfill CTE exactly.
WITH resolved AS (
  SELECT
    s.id, s.host_id,
    COALESCE(o.rate_cents, r.rate_cents, 2000) AS rate_cents,
    (EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 60)::numeric AS duration_min
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
    SELECT ROUND(
      (t.slot_mins - b.day_start_minutes)::numeric
      / NULLIF(b.block_size_minutes, 0)
    )::int AS block_index
  ) bi
  LEFT JOIN public.brand_shift_overrides o
    ON o.brand_id = s.brand_id
   AND o.shift_date = t.date_key
   AND o.block_index = bi.block_index
  LEFT JOIN public.brand_shift_rates r
    ON r.brand_id = s.brand_id
   AND r.day_of_week = t.dow
   AND r.block_index = bi.block_index
  WHERE s.end_time <= ((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
)
SELECT h.name,
       COUNT(*)                                              AS completed_shifts,
       SUM(ROUND(rate_cents * duration_min / 60.0))::bigint  AS realized_payout_cents
FROM resolved
JOIN public.hosts h ON h.id = resolved.host_id
WHERE resolved.host_id IS NOT NULL
GROUP BY h.name
ORDER BY h.name;
