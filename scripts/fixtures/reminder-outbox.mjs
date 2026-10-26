import {readFile,readdir} from 'node:fs/promises'
export const setupSQL = `
 create role anon; create role authenticated; create role service_role;
 create table profiles(id uuid primary key,role text default 'host');
 insert into profiles(id) values('00000000-0000-0000-0000-000000000003');
 create table hosts(id uuid primary key,name text,user_id uuid,is_active boolean default true);
 create table moderators(like hosts including all);
 insert into hosts values('00000000-0000-0000-0000-000000000001','Synthetic Host','00000000-0000-0000-0000-000000000003',true);
 insert into moderators values('00000000-0000-0000-0000-000000000002','Synthetic Mod','00000000-0000-0000-0000-000000000003',true);
 create table brands(id uuid primary key,name text);
 insert into brands values('00000000-0000-0000-0000-000000000004','Synthetic Brand');
 create table streams(id uuid primary key default gen_random_uuid(),brand_id uuid,host_id uuid,moderator_id uuid,start_time timestamptz,end_time timestamptz,reminder_sent_at timestamptz);
 create table notifications(id uuid primary key default gen_random_uuid(),recipient_id uuid not null references profiles(id),type text,host_name text not null,brand_name text not null,brand_id uuid,shift_start timestamptz,shift_end timestamptz,actor_host_id uuid,body text,is_read boolean,email_sent_at timestamptz,email_skipped_reason text,email_delivered_at timestamptz,email_delivery_failed_at timestamptz,email_message_id text);
 create function _emit_shift_reminder_notifications(uuid) returns void language sql as $$ select $$;
 -- Test-only clock: production SQL is loaded verbatim except now() becomes this
 -- stable function. Empty override delegates to real PostgreSQL now().
 create function public.test_now() returns timestamptz language sql stable as $$select coalesce(nullif(current_setting('test.clock',true),'')::timestamptz,pg_catalog.now())$$;
 create function pt_now() returns timestamptz language sql stable as $$select ((public.test_now() at time zone 'America/Los_Angeles')::timestamp at time zone 'UTC')$$;
 create schema vault; create table vault.decrypted_secrets(name text,decrypted_secret text);
 insert into vault.decrypted_secrets values('email_webhook_secret','synthetic-not-a-secret');
 create schema net; create table net.requests(id bigserial,body jsonb);
 create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$declare v_id bigint;begin insert into net.requests(body) values(body) returning id into v_id;return v_id;end$$;
 create schema cron; create table cron.job(jobid bigserial,jobname text unique,schedule text,command text,active boolean default true);
 create table cron.job_run_details(status text,command text);
 create function cron.unschedule(text) returns boolean language plpgsql as $$begin delete from cron.job where jobname=$1;return found;end$$;
 create function cron.schedule(text,text,text) returns bigint language plpgsql as $$declare v_id bigint;begin insert into cron.job(jobname,schedule,command) values($1,$2,$3) returning jobid into v_id;return v_id;end$$;

create table email_events(message_id text,event_type text,created_at timestamptz default now());
create table net.http_request_queue(url text);
create function _fire_send_notification_email() returns trigger language plpgsql as $$begin return NEW;end$$;
`
export async function migrationSQL(n){const dir=new URL('../../supabase/migrations/',import.meta.url);const f=(await readdir(dir)).find(f=>f.startsWith(n+'_'));return (await readFile(new URL(f,dir),'utf8')).replace(/\bnow\(\)/g,'public.test_now()')}
