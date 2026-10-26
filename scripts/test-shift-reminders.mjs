// Synthetic local PostgreSQL tests: never connects to Supabase or sends email.
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { PGlite } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite')
const db = new PGlite()
let checks=0
const eq=(a,b)=>{assert.deepEqual(a,b);checks++}
const query=async sql=>(await db.query(sql)).rows
const scalar=async sql=>Object.values((await query(sql))[0])[0]
async function fails(sql, pattern){await assert.rejects(db.exec(sql),pattern); checks++}
async function migration(n){const dir=new URL('../supabase/migrations/',import.meta.url);const f=(await readdir(dir)).find(f=>f.startsWith(n+'_'));return (await readFile(new URL(f,dir),'utf8')).replace(/\bnow\(\)/g,'public.test_now()')}
const uid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
const host=uid(1),mod=uid(2),user=uid(3),brand=uid(4)
await db.exec(`
 create role anon; create role authenticated; create role service_role;
 create table profiles(id uuid primary key);
 insert into profiles values('${user}');
 create table hosts(id uuid primary key,name text,user_id uuid,is_active boolean default true);
 create table moderators(like hosts including all);
 insert into hosts values('${host}','Synthetic Host','${user}',true);
 insert into moderators values('${mod}','Synthetic Mod','${user}',true);
 create table brands(id uuid primary key,name text);
 insert into brands values('${brand}','Synthetic Brand');
 create table streams(id uuid primary key default gen_random_uuid(),brand_id uuid,host_id uuid,moderator_id uuid,start_time timestamptz,end_time timestamptz,reminder_sent_at timestamptz);
 create table notifications(id uuid primary key default gen_random_uuid(),recipient_id uuid not null references profiles(id),type text,host_name text,brand_name text,brand_id uuid,shift_start timestamptz,shift_end timestamptz,actor_host_id uuid,body text,is_read boolean,email_sent_at timestamptz,email_skipped_reason text);
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
`)
await db.exec(await migration('076'))
await db.exec(await migration('079'))
async function clear(){await db.exec('delete from shift_reminders;delete from notifications;delete from streams;delete from net.requests;')}
async function stream(offset='2 hours',duration='1 hour',h=host,m=mod){return scalar(`insert into streams(brand_id,host_id,moderator_id,start_time,end_time) values('${brand}',${h?`'${h}'`:'null'},${m?`'${m}'`:'null'},pt_now()+interval '${offset}',pt_now()+interval '${offset}'+interval '${duration}') returning id`)}
const emit=(tier,dry=false)=>query(`select * from _emit_shift_reminders('${tier}',${dry})`)
// Freeze time inside each transaction to make band endpoints exact.
for(const tier of ['2h','24h','48h']){
 await clear(); await db.exec('begin');
 await stream(tier==='2h'?'2 hours':tier==='24h'?'24 hours':'48 hours');
 let rows=await emit(tier,true);eq(rows.length,2);eq(rows.map(r=>r.action),['would_emit','would_emit']);eq(await scalar('select count(*)::int from notifications'),0)
 rows=await emit(tier);eq(rows.length,2);eq(await scalar('select count(*)::int from notifications'),2);eq(await scalar(`select bool_and(is_read=${tier!=='2h'}) from notifications`),true)
 eq((await emit(tier)).length,0);eq(await scalar('select bool_and(notification_id is not null and email_attempts=1) from shift_reminders'),true)
 await db.exec('rollback')
}
// A moderator's arrival remains one session across a host handoff; gaps split it.
await clear();await db.exec('begin');await stream('2 hours','5 minutes');await stream('2 hours 5 minutes','5 minutes',null);let rows=await emit('2h',true);eq(rows.length,2);eq(rows.find(r=>r.recipient_role==='moderator').block_count,2);eq(rows.find(r=>r.recipient_role==='host').block_count,1);await db.exec('rollback')
await clear();await db.exec('begin');await stream('1 hour 55 minutes','1 minute',host,null);await stream('2 hours 5 minutes','1 minute',host,null);eq((await emit('2h',true)).length,2);await db.exec('rollback')
for(const offset of ['1 hour 52 minutes 30 seconds','2 hours 7 minutes 30 seconds','1 hour 52 minutes 29 seconds','2 hours 7 minutes 31 seconds','30 hours']){
 await clear();await db.exec('begin');await stream(offset,'1 minute',host,null);eq((await emit('2h',true)).length,['1 hour 52 minutes 30 seconds','2 hours 7 minutes 30 seconds'].includes(offset)?1:0);await db.exec('rollback')
}
// Missing account is reported, inactive assignments are excluded.
await clear();await db.exec('begin');await stream();await db.exec('update hosts set user_id=null;update moderators set is_active=false');rows=await emit('2h');eq(rows.map(r=>r.action),['skipped_no_account']);eq(await scalar('select count(*)::int from shift_reminders'),0);await db.exec('rollback')
// Notification failure must roll back the winning ledger claim.
await clear();await stream();await db.exec(`create function reject_notification() returns trigger language plpgsql as $$begin raise exception 'synthetic failure';end$$;create trigger reject_notification before insert on notifications for each row execute function reject_notification()`)
await fails("select * from _emit_shift_reminders('2h')",/synthetic failure/);eq(await scalar('select count(*)::int from shift_reminders'),0);eq(await scalar('select count(*)::int from notifications'),0);await db.exec('drop trigger reject_notification on notifications');eq((await emit('2h')).length,2)
// Retry same ID, wait three minutes, stop after five attempts.
await db.exec("update shift_reminders set last_email_attempt_at=now()-interval '4 minutes'")
for(let attempt=2;attempt<=5;attempt++){
 eq(await scalar('select _retry_shift_reminder_emails()'),2);eq(await scalar('select min(email_attempts) from shift_reminders'),attempt);eq(await scalar('select _retry_shift_reminder_emails()'),0);await db.exec("update shift_reminders set last_email_attempt_at=now()-interval '4 minutes'")
}
eq(await scalar('select _retry_shift_reminder_emails()'),0);eq(await scalar("select count(distinct body->'record'->>'id')::int from net.requests"),2);eq(await scalar("select bool_and((body->'record'->>'id')::uuid in(select id from notifications)) from net.requests"),true)
// Sent, intentionally skipped, past shifts, and stale rows never retry.
for(const mutate of ["update notifications set email_sent_at=now()","update notifications set email_skipped_reason='no_address_or_disabled'","update notifications set shift_start=pt_now()-interval '1 minute'","update shift_reminders set sent_at=now()-interval '31 minutes'"]){
 await clear();await stream();await emit('2h');await db.exec("update shift_reminders set last_email_attempt_at=now()-interval '4 minutes'");await db.exec(mutate);eq(await scalar('select _retry_shift_reminder_emails()'),0)
}
// Bounded batch of real emitted reminders, then fair oldest-attempt ordering.
await clear();await db.exec(`with p as(insert into profiles(id) select gen_random_uuid() from generate_series(1,60) returning id), h as(insert into hosts(id,name,user_id,is_active) select gen_random_uuid(),'Synthetic Batch',id,true from p returning id) insert into streams(brand_id,host_id,start_time,end_time) select '${brand}',id,pt_now()+interval '2 hours',pt_now()+interval '3 hours' from h`)
eq((await emit('2h')).length,60)
await db.exec("update shift_reminders set last_email_attempt_at=now()-interval '4 minutes'")
eq(await scalar('select _retry_shift_reminder_emails()'),50)
// Simulate the next retry tick: unattempted candidates must go before retried ones.
await db.exec("update shift_reminders set last_email_attempt_at=last_email_attempt_at-interval '4 minutes'")
eq(await scalar('select _retry_shift_reminder_emails()'),50)
eq(await scalar('select min(email_attempts) from shift_reminders'),2)
eq(await scalar('select _retry_shift_reminder_emails()'),10)
eq(await scalar('select _retry_shift_reminder_emails()'),0)
// Ordinary API roles cannot invoke emitters, retry worker, or read the ledger.
for(const role of ['anon','authenticated']){
 await db.exec(`set role ${role}`);await fails("select * from _emit_shift_reminders('2h')",/permission denied/);await fails('select _retry_shift_reminder_emails()',/permission denied/);await fails(`select _shift_reminder_is_current('${uid(9)}')`,/permission denied/);await fails(`select _emit_shift_reminder_notifications('${uid(9)}')`,/permission denied/);await fails('select * from shift_reminders',/permission denied/);await db.exec('reset role')
}
// Cutover requires paused and drained legacy execution, and refreshes old flags.
await clear();await db.exec("select cron.schedule('shift-reminders-2h','*/5 * * * *','select public._emit_shift_reminder_notifications(null)')")
await fails(await migration('081'),/080 first/);await db.exec('rollback');eq(await scalar("select count(*)::int from cron.job where jobname='shift-reminders-2h'"),1)
await db.exec(await migration('080'));eq(await scalar('select count(*)::int from cron.job'),0)
await db.exec("insert into cron.job_run_details values('running','select public._emit_shift_reminder_notifications(null)')");await fails(await migration('081'),/legacy reminder run/);await db.exec('rollback');await db.exec('delete from cron.job_run_details')
await stream();await db.exec('update streams set reminder_sent_at=now()');await db.exec(await migration('081'));eq(await scalar('select count(*)::int from shift_reminders'),2);eq((await emit('2h')).length,0);eq(await scalar('select count(*)::int from cron.job'),2);eq(await scalar('select count(*)::int from notifications'),0)
await db.exec(await migration('081'));eq(await scalar('select count(*)::int from cron.job'),2)
// Changes after a failed initial send must not retry a stale reminder.
for(const mutate of [
 'update streams set host_id=null',
 "update streams set start_time=start_time+interval '1 day',end_time=end_time+interval '1 day'",
 'update hosts set is_active=false',
 'update hosts set user_id=null',
]){
 await clear();await db.exec('begin');await stream('2 hours','1 hour',host,null);await emit('2h');
 await db.exec("update shift_reminders set last_email_attempt_at=now()-interval '4 minutes'");await db.exec(mutate)
 eq(await scalar('select _retry_shift_reminder_emails()'),0);await db.exec('rollback')
}
// Moderator session membership and assignment changes invalidate pending copy.
for(const mutate of [
 'update streams set moderator_id=null',
 'update moderators set is_active=false',
 'update moderators set user_id=null',
 "update streams set end_time=end_time+interval '15 minutes' where start_time=(select max(start_time) from streams)",
 'delete from streams where start_time=(select max(start_time) from streams)',
 `insert into streams(brand_id,moderator_id,start_time,end_time) select '${brand}','${mod}',max(end_time),max(end_time)+interval '1 hour' from streams`,
 "update streams set moderator_id=null where start_time=(select max(start_time) from streams)",
]){
 await clear();await db.exec('begin');await stream('2 hours','5 minutes',null);await stream('2 hours 5 minutes','1 hour',null);eq((await emit('2h')).length,1)
 await db.exec("update shift_reminders set last_email_attempt_at=now()-interval '4 minutes'");await db.exec(mutate)
 eq(await scalar('select _retry_shift_reminder_emails()'),0);await db.exec('rollback')
}
// Snapshot comparisons stay current across DB timezones; service role can verify.
await clear();await stream('2 hours','1 hour',host,null);await emit('2h');
const notification=await scalar('select id from notifications limit 1')
for(const zone of ['UTC','America/Los_Angeles','Europe/Madrid']){
 await db.exec(`set timezone='${zone}';set role service_role`)
 eq(await scalar(`select _shift_reminder_is_current('${notification}')`),true)
 await db.exec('reset role')
}
// Fixed March/November clocks exercise the actual SQL at DST transitions.
// Only now() is substituted when loading migrations; bands/grouping/ledger SQL
// is unchanged. PT-naive lead times are wall hours, not elapsed real hours.
for(const [clock,tier,offset,expected,realHours] of [
 ['2026-03-07T20:00:00Z','24h','24 hours','2026-03-08 12:00',23],
 ['2026-10-31T19:00:00Z','24h','24 hours','2026-11-01 12:00',25],
 ['2026-03-06T20:00:00Z','48h','48 hours','2026-03-08 12:00',47],
 ['2026-10-30T19:00:00Z','48h','48 hours','2026-11-01 12:00',49],
 ['2026-03-08T09:30:00Z','2h','2 hours','2026-03-08 03:30',1],
 ['2026-11-01T07:30:00Z','2h','2 hours','2026-11-01 02:30',3],
]){
 for(const zone of ['UTC','America/Los_Angeles','Europe/Madrid']){
  await clear();await db.exec(`begin;set timezone='${zone}';set local test.clock='${clock}'`)
  await stream(offset,'1 hour',host,null);eq((await emit(tier,true)).length,1);eq((await emit(tier)).length,1)
  eq(await scalar("select to_char(shift_start at time zone 'UTC','YYYY-MM-DD HH24:MI') from notifications"),expected)
  eq(Number(await scalar("select extract(epoch from (((shift_start at time zone 'UTC') at time zone 'America/Los_Angeles')-public.test_now()))/3600 from notifications")),realHours)
  eq((await emit(tier)).length,0);await db.exec('rollback')
 }
}
await clear();await stream('2 hours','1 hour',host,null);await emit('2h');
// Failed network queue transaction rolls back attempt counters as well.
await db.exec("update shift_reminders set last_email_attempt_at=now()-interval '4 minutes'")
await db.exec(`create or replace function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin raise exception 'synthetic transport failure';end$$`)
await fails('select _retry_shift_reminder_emails()',/synthetic transport failure/)
eq(await scalar('select email_attempts from shift_reminders'),1)
await db.close();console.log(`Shift reminders PostgreSQL integration: ${checks} checks passed. Synthetic HTTP and cron; no real sends.`)
