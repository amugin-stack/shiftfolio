-- ============================================================
-- prep_time_delta.sql — READ-ONLY per-moderator before/after
-- ============================================================
-- What-if comparison for the prep-time supersede (design doc:
-- docs/superpowers/specs/2026-07-15-prep-time-design.md): for the CURRENT
-- PT month, computes each moderator's extra pay under
--   OLD rule: first-of-(brand, PT-day) setup bonus at the mod's OWN rate
--   NEW rule: one prep block per contiguous session, ALSO at the mod's own
--             rate (confirmed 2026-07-15) — so per-block amounts are equal
--             and deltas come from block COUNT (plus rare suppression cases)
-- and the delta. Rows flagged "PAY DECREASE" need explicit sign-off before
-- the PR merges (memo requirement).
--
-- NOTE: with the cutoff posture actually shipped, historical pay does NOT
-- change — this script shows what the rule swap means for a representative
-- month so the approver sees the structural effect per person.
--
-- Mirrors src/lib/prepTime.ts exactly: touching = prev.end == next.start,
-- same moderator + brand; suppression = closed-interval intersection of the
-- prep window with any other stream of the same moderator; rounding =
-- ROUND(numeric) (half away from zero, non-negative operands).
-- PT-naive scheme: stored UTC fields ARE PT wall-clock.
--
-- Run: psql "$DB_URL" -f scripts/tieout/prep_time_delta.sql
-- This script contains ONLY SELECTs.
-- ============================================================

WITH params AS (
  SELECT
    ((date_trunc('month', now() AT TIME ZONE 'America/Los_Angeles')) AT TIME ZONE 'UTC') AS month_start,
    ((date_trunc('month', now() AT TIME ZONE 'America/Los_Angeles') + interval '1 month') AT TIME ZONE 'UTC') AS month_end,
    30::int AS prep_minutes -- PREP_DURATION_MINUTES (rate = mod's own)
),
mod_streams AS (
  SELECT s.id, s.brand_id, s.moderator_id, s.start_time, s.end_time,
         m.name, m.rate_cents
  FROM public.streams s
  JOIN public.moderators m ON m.id = s.moderator_id
  CROSS JOIN params p
  WHERE s.moderator_id IS NOT NULL
    AND s.start_time >= p.month_start - interval '1 day' -- session lookback
    AND s.start_time <  p.month_end
),
-- OLD RULE: earliest mod-assigned stream per (brand, PT day), in-month only.
old_rule AS (
  SELECT t.moderator_id, min(t.name) AS name,
         count(*)::int AS old_blocks,
         sum(round(t.rate_cents / 2.0))::int AS old_cents
  FROM (
    SELECT ms.*,
           row_number() OVER (
             PARTITION BY ms.brand_id, (ms.start_time AT TIME ZONE 'UTC')::date
             ORDER BY ms.start_time, ms.id
           ) AS rn
    FROM mod_streams ms
  ) t
  CROSS JOIN params p
  WHERE t.rn = 1 AND t.start_time >= p.month_start
  GROUP BY t.moderator_id
),
-- NEW RULE: contiguous sessions per (moderator, brand); prep per session.
sessioned AS (
  SELECT ms.*,
         CASE
           WHEN lag(ms.end_time) OVER (
                  PARTITION BY ms.moderator_id, ms.brand_id
                  ORDER BY ms.start_time, ms.id
                ) = ms.start_time
           THEN 0 ELSE 1
         END AS is_session_start
  FROM mod_streams ms
),
numbered AS (
  SELECT *,
         sum(is_session_start) OVER (
           PARTITION BY moderator_id, brand_id
           ORDER BY start_time, id
         ) AS session_no
  FROM sessioned
),
session_bounds AS (
  SELECT moderator_id, brand_id, session_no,
         min(name)       AS name,
         min(rate_cents) AS rate_cents, -- one mod per group; min = the rate
         min(start_time) AS session_start,
         max(end_time)   AS session_end,
         array_agg(id)   AS member_ids
  FROM numbered
  GROUP BY moderator_id, brand_id, session_no
),
new_rule AS (
  SELECT sb.moderator_id, min(sb.name) AS name,
         count(*)::int AS new_blocks,
         sum(round(sb.rate_cents * p.prep_minutes / 60.0))::int AS new_cents
  FROM session_bounds sb
  CROSS JOIN params p
  WHERE sb.session_start >= p.month_start
    -- Suppression: closed-interval intersection with any OTHER stream of
    -- the same moderator (any brand) over the prep window.
    AND NOT EXISTS (
      SELECT 1
      FROM mod_streams o
      WHERE o.moderator_id = sb.moderator_id
        AND o.id <> ALL (sb.member_ids)
        AND o.start_time <= sb.session_start
        AND o.end_time   >= sb.session_start - make_interval(mins => p.prep_minutes)
    )
  GROUP BY sb.moderator_id
)
SELECT
  coalesce(o.name, n.name)                                   AS moderator,
  coalesce(o.old_blocks, 0)                                  AS old_setup_blocks,
  round(coalesce(o.old_cents, 0) / 100.0, 2)                 AS old_setup_dollars,
  coalesce(n.new_blocks, 0)                                  AS new_prep_blocks,
  round(coalesce(n.new_cents, 0) / 100.0, 2)                 AS new_prep_dollars,
  round((coalesce(n.new_cents, 0) - coalesce(o.old_cents, 0)) / 100.0, 2) AS delta_dollars,
  CASE
    WHEN coalesce(n.new_cents, 0) < coalesce(o.old_cents, 0) THEN 'PAY DECREASE — needs sign-off'
    ELSE ''
  END AS flag
FROM old_rule o
FULL OUTER JOIN new_rule n USING (moderator_id)
ORDER BY delta_dollars ASC, moderator;
