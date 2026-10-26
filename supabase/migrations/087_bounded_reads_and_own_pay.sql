-- 087: Bounded calendar reads and complete own-pay summaries/history.
-- Apply after086, before the application using these RPCs. Additive only;
-- no stored rates, timestamps or historical payroll are modified.
-- Rollback: restore the compatible application first; retain these read-only
-- helpers or revoke their grants. Never change frozen rates to repair a read.
BEGIN;
CREATE INDEX IF NOT EXISTS streams_host_start_id_idx ON public.streams(host_id,start_time,id);
CREATE INDEX IF NOT EXISTS streams_mod_start_id_idx ON public.streams(moderator_id,start_time,id);
CREATE INDEX IF NOT EXISTS streams_brand_end_idx ON public.streams(brand_id,end_time);
CREATE INDEX IF NOT EXISTS streams_mod_span_idx ON public.streams USING gist(tstzrange(start_time,end_time,'[]')) WHERE moderator_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS streams_brand_mod_start_idx ON public.streams(brand_id,start_time,id) WHERE moderator_id IS NOT NULL;

-- Invoker preserves existing RLS and column permissions. Expand to an actual
-- session gap, including moderator preparation context, rather than padding a
-- fixed day and silently cutting long sessions. Exceptional chains fail closed.
CREATE OR REPLACE FUNCTION public.get_stream_window_ids(
 p_from timestamptz,p_to timestamptz,p_brand uuid DEFAULT NULL,
 p_host uuid DEFAULT NULL,p_mod uuid DEFAULT NULL)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE ids uuid[];
BEGIN
 IF auth.uid() IS NULL OR p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from)
 OR NOT isfinite(p_to) OR p_to<=p_from OR p_to-p_from>interval '100 days' THEN
 RAISE EXCEPTION 'Invalid calendar range'; END IF;
 IF p_brand IS NULL AND p_host IS NULL AND p_mod IS NULL THEN RAISE EXCEPTION 'Missing scope'; END IF;
 WITH RECURSIVE picked(id) AS (
 SELECT s.id FROM streams s WHERE (p_brand IS NULL OR s.brand_id=p_brand)
 AND ((p_host IS NULL AND p_mod IS NULL) OR s.host_id=p_host OR s.moderator_id=p_mod)
 AND s.start_time<p_to AND s.end_time>=p_from
 UNION
 SELECT s.id FROM picked p JOIN streams a ON a.id=p.id JOIN streams s ON (
   (s.brand_id=a.brand_id AND (s.end_time=a.start_time OR s.start_time=a.end_time)
     AND (s.host_id IS NOT DISTINCT FROM a.host_id OR s.moderator_id IS NOT DISTINCT FROM a.moderator_id))
   OR (s.moderator_id=a.moderator_id AND s.start_time<=a.start_time AND s.end_time>=a.start_time-interval '1 hour')
 ) WHERE (p_brand IS NULL OR s.brand_id=p_brand)
 AND ((p_host IS NULL AND p_mod IS NULL) OR s.host_id=p_host OR s.moderator_id=p_mod)
 )
 SELECT coalesce(array_agg(q.id),'{}') INTO ids FROM (SELECT picked.id FROM picked LIMIT 5001) q;
 IF cardinality(ids)>5000 THEN RAISE EXCEPTION 'Calendar range is too large; choose a shorter range'; END IF;
 RETURN QUERY SELECT s.id FROM streams s WHERE s.id=ANY(ids) ORDER BY s.start_time,s.id;
END $$;
REVOKE ALL ON FUNCTION public.get_stream_window_ids(timestamptz,timestamptz,uuid,uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_stream_window_ids(timestamptz,timestamptz,uuid,uuid,uuid) TO authenticated;

-- Internal own-pay mirror of payout.ts/setupBonus.ts/prepTime.ts/extraPay.ts.
-- Identity is always auth.uid(); no caller-supplied worker id. Kept private so
-- inactive workers cannot invoke an unrestricted future-pay accessor.
CREATE OR REPLACE FUNCTION public._my_pay_rows()
RETURNS TABLE(id uuid,brand_id uuid,brand_name text,start_time timestamptz,end_time timestamptz,
 role text,total_cents bigint,setup_cents bigint,realized_cents bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 WITH me_h AS (SELECT h.id,h.rate_cents FROM hosts h WHERE h.user_id=auth.uid()),
 me_m AS (SELECT m.id,m.rate_cents FROM moderators m WHERE m.user_id=auth.uid()),
 clock AS (SELECT (now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC' AS pt),
 mods AS (
 SELECT s.*,m.rate_cents AS mod_rate,
 CASE WHEN lag(s.end_time) OVER w=s.start_time AND lag(s.brand_id) OVER w=s.brand_id THEN 0 ELSE 1 END AS boundary
 FROM streams s JOIN me_m m ON s.moderator_id=m.id
 WINDOW w AS (PARTITION BY s.moderator_id ORDER BY s.start_time,s.id)),
 numbered AS (SELECT mods.*,sum(boundary) OVER(PARTITION BY moderator_id ORDER BY start_time,id) AS session FROM mods),
 sessions AS (SELECT moderator_id,session,(array_agg(id ORDER BY start_time,id))[1] AS anchor,
 min(start_time) AS starts,(array_agg(end_time ORDER BY start_time DESC,id DESC))[1] AS ends,
 array_agg(id) AS members FROM numbered GROUP BY moderator_id,session),
 prep AS (SELECT ss.anchor,ss.ends,
 CASE WHEN ss.starts>='2026-08-24T00:00:00Z'::timestamptz THEN 60 ELSE 30 END AS minutes
 FROM sessions ss WHERE ss.starts>='2026-07-22T00:00:00Z'::timestamptz
 AND NOT EXISTS(SELECT 1 FROM streams other WHERE other.moderator_id=ss.moderator_id
 AND NOT other.id=ANY(ss.members)
 AND tstzrange(other.start_time,other.end_time,'[]') && tstzrange(ss.starts-(CASE WHEN ss.starts>='2026-08-24T00:00:00Z'::timestamptz THEN interval '1 hour' ELSE interval '30 minutes' END),ss.starts,'[]'))),
 mod_pay AS (SELECT s.*,
 CASE WHEN s.start_time<'2026-07-22T00:00:00Z'::timestamptz AND NOT EXISTS(
 SELECT 1 FROM streams earlier WHERE earlier.brand_id=s.brand_id AND earlier.moderator_id IS NOT NULL
 AND earlier.start_time>=date_trunc('day',s.start_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
 AND earlier.start_time<(date_trunc('day',s.start_time AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC'
 AND (earlier.start_time,earlier.id)<(s.start_time,s.id)) THEN round(s.mod_rate::numeric/2)::bigint ELSE 0 END AS setup,
 coalesce(round(s.mod_rate::numeric*p.minutes/60),0)::bigint AS prep_pay,p.ends AS prep_end
 FROM mods s LEFT JOIN prep p ON p.anchor=s.id),
 all_pay AS (
 SELECT s.id,s.brand_id,b.name::text,s.start_time,s.end_time,'host'::text,
 round(coalesce(s.host_rate_cents,h.rate_cents,0)::numeric*extract(epoch FROM s.end_time-s.start_time)/3600)::bigint AS total,
 0::bigint AS setup,
 CASE WHEN s.end_time<=clock.pt THEN round(coalesce(s.host_rate_cents,h.rate_cents,0)::numeric*extract(epoch FROM s.end_time-s.start_time)/3600)::bigint ELSE 0 END AS realized
 FROM streams s JOIN me_h h ON h.id=s.host_id JOIN brands b ON b.id=s.brand_id CROSS JOIN clock
 UNION ALL
 SELECT s.id,s.brand_id,b.name::text,s.start_time,s.end_time,'moderator'::text,
 round(coalesce(s.mod_rate,0)::numeric*extract(epoch FROM s.end_time-s.start_time)/3600)::bigint+s.setup+s.prep_pay,
 s.setup+CASE WHEN s.prep_end<=clock.pt THEN s.prep_pay ELSE 0 END,
 CASE WHEN s.end_time<=clock.pt THEN round(coalesce(s.mod_rate,0)::numeric*extract(epoch FROM s.end_time-s.start_time)/3600)::bigint+s.setup ELSE 0 END
 +CASE WHEN s.prep_end<=clock.pt THEN s.prep_pay ELSE 0 END
 FROM mod_pay s JOIN brands b ON b.id=s.brand_id CROSS JOIN clock
 UNION ALL
 SELECT e.id,e.brand_id,coalesce(b.name,CASE e.kind::text WHEN 'office_hours' THEN 'Office hours' WHEN 'training' THEN 'Training' ELSE 'Setup' END),e.start_time,e.end_time,
 CASE WHEN e.host_id IS NOT NULL THEN 'host' ELSE 'moderator' END,
 round(e.rate_cents::numeric*greatest(0,extract(epoch FROM e.end_time-e.start_time))/3600)::bigint,0::bigint,
 CASE WHEN e.end_time<=clock.pt THEN round(e.rate_cents::numeric*greatest(0,extract(epoch FROM e.end_time-e.start_time))/3600)::bigint ELSE 0 END
 FROM extra_pay_slots e LEFT JOIN brands b ON b.id=e.brand_id CROSS JOIN clock
 WHERE e.status<>'canceled' AND (e.host_id IN(SELECT me_h.id FROM me_h) OR e.moderator_id IN(SELECT me_m.id FROM me_m)))
 SELECT * FROM all_pay;
$$;
REVOKE ALL ON FUNCTION public._my_pay_rows() FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.get_my_completed_pay_page(
 p_before_start timestamptz DEFAULT NULL,p_before_id uuid DEFAULT NULL,p_limit integer DEFAULT 50)
RETURNS TABLE(id uuid,start_time timestamptz,end_time timestamptz,brand_name text,role text,total_cents bigint,setup_cents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
 IF p_limit NOT BETWEEN 1 AND 100 OR p_limit IS NULL OR ((p_before_start IS NULL)<>(p_before_id IS NULL))
 OR (p_before_start IS NOT NULL AND NOT isfinite(p_before_start)) THEN RAISE EXCEPTION 'Invalid history cursor'; END IF;
 RETURN QUERY SELECT r.id,min(r.start_time),max(r.end_time),min(r.brand_name),string_agg(r.role,' + ' ORDER BY r.role),sum(r.realized_cents)::bigint,
 sum(least(r.setup_cents,r.realized_cents))::bigint
 FROM public._my_pay_rows() r
 WHERE r.end_time<=(now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC'
 AND (p_before_start IS NULL OR (r.start_time,r.id)<(p_before_start,p_before_id))
 GROUP BY r.id ORDER BY min(r.start_time) DESC,r.id DESC LIMIT p_limit;
END $$;
REVOKE ALL ON FUNCTION public.get_my_completed_pay_page(timestamptz,uuid,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_completed_pay_page(timestamptz,uuid,integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_my_pay_totals()
RETURNS TABLE(brand_id uuid,brand_name text,earned_cents bigint,completed_count bigint,upcoming_cents bigint,upcoming_count bigint,category_key text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL OR public._is_deactivated_worker() THEN RAISE EXCEPTION 'Active account required'; END IF;
 RETURN QUERY SELECT r.brand_id,r.brand_name,sum(r.realized_cents)::bigint,
 count(*) FILTER(WHERE r.end_time<=c.pt),
 coalesce(sum(r.total_cents) FILTER(WHERE r.end_time>c.pt),0)::bigint,count(*) FILTER(WHERE r.end_time>c.pt),coalesce(r.brand_id::text,'extra:'||e.kind::text)
 FROM public._my_pay_rows() r LEFT JOIN extra_pay_slots e ON r.brand_id IS NULL AND e.id=r.id CROSS JOIN(SELECT (now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC' pt)c
 GROUP BY r.brand_id,r.brand_name,e.kind ORDER BY r.brand_id,r.brand_name;
END $$;
REVOKE ALL ON FUNCTION public.get_my_pay_totals() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_pay_totals() TO authenticated;
CREATE OR REPLACE FUNCTION public.get_my_gmv_summary()
RETURNS TABLE(all_time_per_hour_cents bigint,this_month_per_hour_cents bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL OR public._is_deactivated_worker() THEN RAISE EXCEPTION 'Active account required'; END IF;
 RETURN QUERY WITH owned AS (
 SELECT s.*,CASE WHEN lag(s.end_time) OVER w=s.start_time AND lag(s.brand_id) OVER w=s.brand_id THEN 0 ELSE 1 END boundary
 FROM streams s JOIN hosts h ON h.id=s.host_id AND h.user_id=auth.uid()
 WINDOW w AS(PARTITION BY s.host_id ORDER BY s.start_time,s.id)),
 grouped AS(SELECT owned.*,sum(boundary) OVER(PARTITION BY host_id ORDER BY start_time,id) session FROM owned),
 sessions AS(SELECT host_id,session,(array_agg(gmv_cents ORDER BY start_time,id) FILTER(WHERE gmv_cents IS NOT NULL))[1] gmv,
 sum(extract(epoch FROM end_time-start_time))/3600 hours,max(end_time) ends FROM grouped GROUP BY host_id,session)
 SELECT round(sum(gmv)/nullif(sum(hours) FILTER(WHERE gmv IS NOT NULL),0))::bigint,
 round(sum(gmv) FILTER(WHERE date_trunc('month',ends AT TIME ZONE 'UTC')=date_trunc('month',now() AT TIME ZONE 'America/Los_Angeles'))
 /nullif(sum(hours) FILTER(WHERE gmv IS NOT NULL AND date_trunc('month',ends AT TIME ZONE 'UTC')=date_trunc('month',now() AT TIME ZONE 'America/Los_Angeles')),0))::bigint FROM sessions;
END $$;
REVOKE ALL ON FUNCTION public.get_my_gmv_summary() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_gmv_summary() TO authenticated;
-- Identifier constraints belong INSIDE these SECURITY DEFINER functions:
-- filtering a function result from PostgREST would materialize all history on
-- every identifier chunk. Every lookup below starts with the primary-key ids.
CREATE OR REPLACE FUNCTION public.get_my_window_pay(p_ids uuid[])
RETURNS TABLE(stream_id uuid,host_rate_cents int,gmv_cents int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL OR p_ids IS NULL OR cardinality(p_ids)>1000 THEN RAISE EXCEPTION 'Invalid pay request'; END IF;
 RETURN QUERY SELECT s.id,s.host_rate_cents,s.gmv_cents FROM streams s JOIN hosts h ON h.id=s.host_id
 WHERE s.id=ANY(p_ids) AND h.user_id=auth.uid()
 AND (NOT public._is_deactivated_worker() OR s.end_time<=(now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
 ORDER BY s.id;
END $$;
REVOKE ALL ON FUNCTION public.get_my_window_pay(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_window_pay(uuid[]) TO authenticated;
CREATE OR REPLACE FUNCTION public.get_my_window_gmv(p_ids uuid[])
RETURNS TABLE(stream_id uuid,gmv_cents int,updated_by_name text,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL OR p_ids IS NULL OR cardinality(p_ids)>1000 THEN RAISE EXCEPTION 'Invalid GMV request'; END IF;
 RETURN QUERY SELECT s.id,s.gmv_cents,p.full_name,s.gmv_updated_at FROM streams s
 LEFT JOIN profiles p ON p.id=s.gmv_updated_by
 WHERE s.id=ANY(p_ids) AND s.host_id IS NOT NULL AND (
 EXISTS(SELECT 1 FROM moderators m WHERE m.id=s.moderator_id AND m.user_id=auth.uid() AND m.is_active)
 OR EXISTS(SELECT 1 FROM hosts h WHERE h.id=s.host_id AND h.user_id=auth.uid() AND h.is_active AND h.self_moderating))
 ORDER BY s.id;
END $$;
REVOKE ALL ON FUNCTION public.get_my_window_gmv(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_window_gmv(uuid[]) TO authenticated;
CREATE OR REPLACE FUNCTION public.get_my_window_setup_ids(p_ids uuid[])
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF auth.uid() IS NULL OR p_ids IS NULL OR cardinality(p_ids)>1000 THEN RAISE EXCEPTION 'Invalid setup request'; END IF;
 RETURN QUERY SELECT s.id FROM streams s JOIN moderators m ON m.id=s.moderator_id
 WHERE s.id=ANY(p_ids) AND m.user_id=auth.uid()
 AND (NOT public._is_deactivated_worker() OR s.end_time<=(now() AT TIME ZONE 'America/Los_Angeles') AT TIME ZONE 'UTC')
 AND NOT EXISTS(SELECT 1 FROM streams earlier WHERE earlier.brand_id=s.brand_id AND earlier.moderator_id IS NOT NULL
 AND earlier.start_time>=date_trunc('day',s.start_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
 AND earlier.start_time<(date_trunc('day',s.start_time AT TIME ZONE 'UTC')+interval '1 day') AT TIME ZONE 'UTC'
 AND (earlier.start_time,earlier.id)<(s.start_time,s.id)) ORDER BY s.id;
END $$;
REVOKE ALL ON FUNCTION public.get_my_window_setup_ids(uuid[]) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_my_window_setup_ids(uuid[]) TO authenticated;
COMMIT;
