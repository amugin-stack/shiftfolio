// Isolated synthetic Supabase baseline. Network, storage service and cron are mocks.
import { readdir, readFile } from 'node:fs/promises'
export async function installFullSchema(db) {
for(const role of ['anon','authenticated','service_role','supabase_auth_admin']) {
 await db.query(`DO $$ BEGIN CREATE ROLE ${role}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
}
await db.query(`
 create schema auth; create schema storage; create schema extensions; create schema vault; create schema net; create schema cron;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role() returns text language sql stable as $$select current_user::text$$;
 grant usage on schema public,auth to authenticated,anon,service_role;
 alter default privileges in schema public grant all on tables to authenticated,service_role;
 alter default privileges in schema public grant all on sequences to authenticated,service_role;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
 alter table storage.objects enable row level security;
 create function storage.foldername(text) returns text[] language sql as $$select string_to_array($1,'/')$$;
 create table vault.decrypted_secrets(name text,decrypted_secret text);
 create table net.requests(id bigserial,body jsonb);
 create table net._http_response(id bigint,status_code int,content text,created timestamptz default now());
 create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer default 1000) returns bigint language plpgsql as $$declare v_id bigint;begin insert into net.requests(body) values(body) returning id into v_id;return v_id;end$$;
 create table cron.job(jobid bigserial,jobname text unique,schedule text,command text,active boolean default true);
 create table cron.job_run_details(jobid bigint,status text,command text,start_time timestamptz,end_time timestamptz,return_message text);
 create function cron.unschedule(text) returns boolean language plpgsql as $$begin delete from cron.job where jobname=$1;return found;end$$;
 create function cron.schedule(text,text,text) returns bigint language plpgsql as $$declare v_id bigint;begin insert into cron.job(jobname,schedule,command) values($1,$2,$3) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into v_id;return v_id;end$$;
`)
const dir=new URL('../../supabase/migrations/',import.meta.url)
for(const file of (await readdir(dir)).filter(f=>/^\d+.*sql$/.test(f)&&parseInt(f)<=81).sort()){
 if (file.startsWith('046_')) {
  const legacy=new URL('agent2migrations/',dir)
  for (const name of (await readdir(legacy)).filter(f=>f.endsWith('.sql')).sort()) {
   await db.query(await readFile(new URL(name,legacy),'utf8')); void 0
  }
 }
 let sql=await readFile(new URL(file,dir),'utf8')
 if(file.startsWith('061_')) await db.query(`
  -- Fixture-only prerequisites documented as live schema drift in migration061.
  alter table hosts add column sms_consent boolean default false, add column sms_consent_at timestamptz;
  alter table moderators add column sms_consent boolean default false, add column sms_consent_at timestamptz;
  alter table brands add column billing_rate_cents int;
 `)
 sql=sql.replace(/CREATE EXTENSION IF NOT EXISTS pg_(?:cron|net)[^;]*;/gi,'-- mocked network and cron extensions')
 try{await db.query(sql);void 0}catch(e){throw new Error('Baseline migration '+file+' failed: '+e.message)}
}

 await db.query('create table net.http_request_queue(id bigint,url text)')
}
