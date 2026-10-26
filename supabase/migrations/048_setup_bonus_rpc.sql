-- ============================================================
-- First-moderator setup pay: self-serve bonus lookup
-- ============================================================
-- Moderator RLS only exposes a moderator's own assigned streams, so the
-- My Shifts page cannot tell whether one of its shifts was the day's
-- first for its brand. This SECURITY DEFINER function evaluates the rule
-- over ALL moderator-assigned streams but returns ONLY the caller's
-- winning stream ids — nothing about other moderators leaks.
-- Rule (keep in sync with src/lib/setupBonus.ts): per (brand_id, PT day
-- of start_time), the earliest moderator-assigned stream (tie: lowest id)
-- grants its moderator +30 minutes of pay.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_my_setup_bonus_stream_ids()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH me AS (
    SELECT id FROM public.moderators WHERE user_id = auth.uid() LIMIT 1
  ),
  ranked AS (
    SELECT s.id, s.moderator_id,
           ROW_NUMBER() OVER (
             PARTITION BY s.brand_id, (s.start_time AT TIME ZONE 'UTC')::date
             ORDER BY s.start_time, s.id
           ) AS rn
    FROM public.streams s
    WHERE s.moderator_id IS NOT NULL
  )
  SELECT r.id
  FROM ranked r
  JOIN me ON me.id = r.moderator_id
  WHERE r.rn = 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_setup_bonus_stream_ids() TO authenticated;
