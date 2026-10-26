-- ============================================================
-- Drop the moderator shift-summary system entirely
-- ============================================================
-- Originally introduced in migration 030 (and amended by 032 and
-- agent2migrations/001), the summary system required moderators to submit a
-- recap via the submit_stream_summary RPC, which flipped streams.verified
-- to true. The app gated "realized" revenue/payroll on verified=true so
-- moderators (and the hosts they recapped) were paid only after the
-- write-up landed.
--
-- This routine work was overhead the team has decided to drop. The new
-- model: a shift is realized when its end_time is in the past. Full stop.
-- No verification, no summary, no RPC, no triggers.
--
-- DROP order:
--   1. The trigger (depends on the function)
--   2. The auto-verify function (no longer called)
--   3. The two RPCs (no longer called from the app)
--   4. The streams columns (verified, verified_at, summary)
--
-- Existing summary text and verified_at history are permanently lost — the
-- user opted for a clean drop over an archive table. ============================================================

-- 1. Trigger first (depends on the function below)
DROP TRIGGER IF EXISTS streams_auto_verify_no_mod ON public.streams;

-- 2. Auto-verify trigger function — last updated in agent2migrations/001
DROP FUNCTION IF EXISTS public.streams_auto_verify_when_no_moderator();

-- 3. RPCs (signatures match migration 030)
DROP FUNCTION IF EXISTS public.submit_stream_summary(UUID, TEXT);
DROP FUNCTION IF EXISTS public.get_stream_summary(UUID);

-- 4. Columns (drops associated column-level grants from migration 030
--    automatically — Postgres cascades column privileges with the column).
ALTER TABLE public.streams DROP COLUMN IF EXISTS summary;
ALTER TABLE public.streams DROP COLUMN IF EXISTS verified;
ALTER TABLE public.streams DROP COLUMN IF EXISTS verified_at;
