-- Tie-out Step 3: verify the freeze is exact and recompute via the NEW path.
-- (a) mismatches: expect 0 rows — every completed shift's frozen rate must
--     equal the old resolution.
-- (b) non-default host rates: expect 0.
-- (c) realized host payouts via streams.host_rate_cents — must equal Step 1.
WITH resolved AS (
  SELECT
    s.id,
    COALESCE(o.rate_cents, r.rate_cents, 2000) AS rate_cents
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
  WHERE s.end_time <= ((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
),
mismatches AS (
  SELECT COUNT(*) AS n
  FROM public.streams s
  JOIN resolved ON resolved.id = s.id
  WHERE s.host_rate_cents IS DISTINCT FROM resolved.rate_cents
),
nondefault AS (
  SELECT COUNT(*) AS n FROM public.hosts WHERE rate_cents <> 3000
),
unfrozen AS (
  SELECT COUNT(*) AS n
  FROM public.streams s
  WHERE s.end_time <= ((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
    AND s.host_rate_cents IS NULL
),
new_path AS (
  SELECT h.name,
         COUNT(*) AS completed_shifts,
         SUM(ROUND(s.host_rate_cents * (EXTRACT(EPOCH FROM (s.end_time - s.start_time)) / 60) / 60.0))::bigint AS realized_payout_cents
  FROM public.streams s
  JOIN public.hosts h ON h.id = s.host_id
  WHERE s.end_time <= ((now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
  GROUP BY h.name
)
SELECT 'a_freeze_mismatches' AS metric, NULL AS name, NULL::bigint AS shifts, n::bigint AS cents FROM mismatches
UNION ALL
SELECT 'b_hosts_not_3000', NULL, NULL, n::bigint FROM nondefault
UNION ALL
SELECT 'c_completed_unfrozen', NULL, NULL, n::bigint FROM unfrozen
UNION ALL
SELECT 'd_new_path_payout', name, completed_shifts, realized_payout_cents FROM new_path
ORDER BY 1, 2;
