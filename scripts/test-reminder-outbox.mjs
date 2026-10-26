// Executes actual migrations against synthetic local PostgreSQL. No external I/O.
import assert from 'node:assert/strict'
import {pathToFileURL} from 'node:url'
import {setupSQL,migrationSQL} from './fixtures/reminder-outbox.mjs'
const {PGlite}=await import(process.argv[2]?pathToFileURL(process.argv[2]).href:'@electric-sql/pglite')
const db=new PGlite(); let checks=0
const q=async sql=>(await db.query(sql)).rows
const one=async sql=>Object.values((await q(sql))[0])[0]
const eq=(a,b,label)=>{assert.deepEqual(a,b,label);checks++}
const uid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
await db.exec(setupSQL)
for(const n of ['076','079','084']) await db.exec(await migrationSQL(n))
await db.exec(`set test.clock='2027-01-01 00:00:00Z';insert into profiles(id,role) values('${uid(5)}','admin')`)
const clock=t=>db.exec(`set test.clock='${t}'`)
const stream=async(start,end='2027-01-02 11:00Z',h=uid(1),m=null)=>one(`insert into streams(brand_id,host_id,moderator_id,start_time,end_time) values('${uid(4)}',${h?`'${h}'`:'null'},${m?`'${m}'`:'null'},'${start}','${end}') returning id`)
const run=()=>one('select _run_reminder_outbox()')
await stream('2027-01-02 10:00Z') // actual Jan2 18:00Z, 42h ahead
await db.exec(await migrationSQL('085')); await db.exec(await migrationSQL('086'))
eq(await run(),0,'no preactivation 48h obligation')
await clock('2027-01-01 18:00Z');eq(await run(),2,'24h reminder and recovery alert')
eq(await one("select count(*)::int from reminder_outbox where incident_id is null"),1)
eq(await one("select body from notifications where type='shift_reminder'"),'24h')
eq(await run(),0,'overlap does not duplicate')
const reminderID=await one("select id from notifications where type='shift_reminder'")
eq(await one(`select _claim_reminder_send_slot('${reminderID}')`),0,'first paced slot')
eq(await one(`select _claim_reminder_send_slot('${reminderID}')`),1000,'second paced slot')
// Edit then revert between ticks still produces a fresh transition/correction.
await db.exec("update streams set end_time=end_time+interval '15 minutes';update streams set end_time=end_time-interval '15 minutes'")
await clock('2027-01-01 18:03Z');await run()
eq(await one("select count(*)::int from notifications where body='corrected'"),1)
eq(await one("select count(*)::int from reminder_outbox where state='superseded'"),1)
eq(await one("select _reminder_outbox_is_current(id) from notifications where body='corrected'"),true)
await db.exec("update notifications set email_sent_at=test_now() where body='corrected'");await run()
eq(await one("select state from reminder_outbox o join notifications n on n.id=o.notification_id where n.body='corrected'"),'accepted')
await db.exec("update notifications set email_delivered_at=test_now() where body='corrected'");await run()
eq(await one("select state from reminder_outbox o join notifications n on n.id=o.notification_id where n.body='corrected'"),'delivered')
// Move outside48h after acceptance: immediate correction, immutable old history.
await db.exec("update streams set start_time=start_time+interval '4 days',end_time=end_time+interval '4 days'");await clock('2027-01-01 18:06Z');await run()
eq(await one("select count(*)::int from notifications where body='corrected'"),2)
eq(await one("select count(*)::int from reminder_outbox where state='delivered'"),1)
// An inactive worker never passes the send-time guard.
await db.exec('update hosts set is_active=false')
eq(await one("select bool_or(_reminder_outbox_is_current(notification_id)) from reminder_outbox where incident_id is null and state='queued'"),false)
await db.exec('update hosts set is_active=true')
// New tests reset only synthetic state. Keep preparedschema.
async function reset(at='2027-01-01 00:00Z'){
 await db.exec('delete from reminder_outbox;delete from reminder_incidents;delete from reminder_sessions;delete from shift_reminders;delete from notifications;delete from streams;delete from reminder_stream_versions;delete from net.requests;delete from cron.job;update reminder_runtime set enabled=false,activated_at=null,last_tick_at=null;')
 await clock(at)
}
async function activate(){await db.exec(await migrationSQL('086'))}
// Both roles carry explicit role labels; catch-up coalesces missed48h/24h.
await reset();await stream('2027-01-03 00:00Z','2027-01-03 02:00Z',uid(1),uid(2));await activate()
await clock('2027-01-03 06:30Z');await run()
eq(await one("select count(*)::int from notifications where type='shift_reminder'"),2)
eq(await one("select count(distinct reminder_role)::int from notifications where type='shift_reminder'"),2)
eq(await one("select bool_and(body='late') from notifications where type='shift_reminder'"),true)
await run();eq(await one("select count(*)::int from notifications where type='shift_reminder'"),2)
// Exhausted worker delivery and admin delivery failures cannot recursively alert.
await db.exec("update reminder_outbox set attempts=10,next_attempt_at=test_now()-interval '1 minute'");await run()
eq(await one("select count(*)::int from reminder_outbox where state='failed' and incident_id is null"),2)
const incidents=await one('select count(*)::int from reminder_incidents')
await db.exec("update reminder_outbox set attempts=10,next_attempt_at=test_now()-interval '1 minute' where incident_id is not null");await run()
eq(await one('select count(*)::int from reminder_incidents'),incidents)
eq(await one('select bool_or(admin_email_failure) from reminder_incidents'),true)
// Started work cannot be sent even if earlier retries failed.
await clock('2027-01-03 08:01Z');eq(await one("select coalesce(bool_or(_reminder_outbox_is_current(notification_id)),false) from reminder_outbox where incident_id is null"),false)
// Provider failure after acceptance creates one incident; callback-before-marker
// is reconciled from the durable event log on the next scheduler tick.
await reset();await stream('2027-01-02 00:00Z','2027-01-02 01:00Z');await activate();await clock('2027-01-01 08:00Z');await run()
await db.exec("insert into email_events(message_id,event_type) values('synthetic-race','failed');update notifications set email_message_id='synthetic-race',email_sent_at=test_now() where type='shift_reminder'");await run()
eq(await one("select count(*)::int from reminder_outbox where incident_id is null and state='failed'"),1)
const before=await one('select count(*)::int from reminder_incidents');await run();eq(await one('select count(*)::int from reminder_incidents'),before)
// An already-queued earlier tier is replaced by the nearer recovery tier.
await reset();await stream('2027-01-04 00:00Z','2027-01-04 01:00Z');await activate();await clock('2027-01-02 08:00Z');await run()
await clock('2027-01-04 06:05Z');await run()
eq(await one("select count(*)::int from reminder_outbox where incident_id is null and state='queued'"),1,'one recovery obligation')
eq(await one("select count(*)::int from reminder_outbox where incident_id is null and state='superseded'"),1,'older queued tier superseded')
// Healthy scheduler + failed delivery becomes late and alerts without cron outage.
await reset();await stream('2027-01-04 00:00Z','2027-01-04 01:00Z');await activate();await clock('2027-01-02 08:00Z');await db.exec('update reminder_runtime set last_tick_at=test_now()');await run()
for(const minute of ['03','06','09','12']){await clock(`2027-01-02 08:${minute}Z`);await run()}
eq(await one("select body from notifications where type='shift_reminder'"),'late')
eq(await one("select count(*)::int from reminder_incidents where dedup_key like 'transport-late-%'"),1)
const lateCount=await one('select count(*)::int from reminder_incidents');await run();eq(await one('select count(*)::int from reminder_incidents'),lateCount)
// A possibly accepted request freezes its exact payload; late retries do not
// change content under the existing provider idempotency key.
await reset();await stream('2027-01-04 00:00Z','2027-01-04 01:00Z');await activate();await clock('2027-01-02 08:00Z');await db.exec('update reminder_runtime set last_tick_at=test_now()');await run()
let frozenID=await one("select id from notifications where type='shift_reminder'")
eq(await one(`select _prepare_reminder_email('${frozenID}','{"to":"synthetic@example.invalid","html":"original"}')`),{to:'synthetic@example.invalid',html:'original'})
await clock('2027-01-02 08:09Z');await run()
eq(await one("select body from notifications where type='shift_reminder'"),'48h','ambiguous provider payload not rewritten')
eq(await one(`select _prepare_reminder_email('${frozenID}','{"to":"synthetic@example.invalid","html":"changed"}')`),{to:'synthetic@example.invalid',html:'original'})
eq(await one("select count(*)::int from reminder_incidents where dedup_key like 'transport-late-%'"),1)
// Cancelled, unassigned, reassigned, inactive and changed work is superseded
// before its old start/deadline, even when backoff has not expired.
for(const mutation of ['delete from streams','update streams set host_id=null',
 `insert into hosts(id,name,user_id,is_active) values('${uid(99)}','Other Synthetic','${uid(3)}',true);update streams set host_id='${uid(99)}'`,
 'update hosts set is_active=false',"update streams set end_time=end_time+interval '15 minutes'"]){
 await reset();await db.exec('update hosts set is_active=true');await stream('2027-01-02 00:00Z','2027-01-02 01:00Z');await activate();await clock('2027-01-01 08:00Z');await run()
 await db.exec("update reminder_outbox set attempts=10,next_attempt_at='2027-01-02 08:20Z' where incident_id is null")
 await db.exec(mutation);await clock('2027-01-02 08:01Z');await db.exec('update reminder_runtime set last_tick_at=test_now()');await run()
 eq(await one("select state from reminder_outbox where incident_id is null"),'superseded')
 eq(await one("select count(*)::int from reminder_incidents where dedup_key like 'delivery:%'"),0)
}
await db.exec('update hosts set is_active=true')
// A still-current shift that truly starts during backoff gets the real incident.
await reset();await stream('2027-01-02 00:00Z','2027-01-02 01:00Z');await activate();await clock('2027-01-01 08:00Z');await run();await clock('2027-01-02 08:01Z');await run()
eq(await one("select state from reminder_outbox where incident_id is null"),'started')
eq(await one("select count(*)::int from reminder_incidents where dedup_key like 'delivery:%'"),1)
// Every ordinary tier uses the real-clock deadline and one durable obligation.
for(const hours of [48,24,2]){
 await reset();await stream('2027-01-04 00:00Z','2027-01-04 01:00Z');await activate()
 await db.exec(`select set_config('test.clock',('2027-01-04 08:00Z'::timestamptz-make_interval(hours=>${hours}))::text,false)`);await run()
 eq(await one("select body from notifications where type='shift_reminder'"),`${hours}h`)
 await run();eq(await one("select count(*)::int from notifications where type='shift_reminder'"),1)
}
// Touching split/merge membership changes invalidate old work and create corrections.
await reset();await stream('2027-01-02 00:00Z','2027-01-02 01:00Z');await stream('2027-01-02 01:00Z','2027-01-02 02:00Z');await activate();await clock('2027-01-01 08:00Z');await run()
await db.exec("update streams set start_time=start_time+interval '15 minutes' where start_time='2027-01-02 01:00Z'");await run()
eq(await one("select count(*)::int from notifications where body='corrected'"),2,'split sessions both corrected')
await db.exec("update streams set start_time=start_time-interval '15 minutes' where start_time='2027-01-02 01:15Z'");await run()
eq(await one("select count(*)::int from notifications where body='corrected'"),3,'merged arrival corrected once')
// Actual cron sequence across spring-forward: 04:00PT =11:00Z,2h due09:00Z.
await reset('2027-03-14 08:50Z');await stream('2027-03-14 04:00Z','2027-03-14 05:00Z');await activate()
for(const at of ['08:51','08:54','08:57','09:00','09:03','09:06','09:09','09:12']){await clock(`2027-03-14 ${at}Z`);await run()}
eq(await one("select count(*)::int from notifications where type='shift_reminder'"),1,'spring DST no gap')
eq(await one("select body from notifications where type='shift_reminder'"),'late','unaccepted spring reminder becomes late')
// Fall overlap uses a single actual instant and never double emits.
await reset('2027-11-07 07:50Z');await stream('2027-11-07 02:00Z','2027-11-07 03:00Z');await activate()
for(const at of ['07:51','07:54','07:57','08:00','08:03','08:06','09:00','09:03']){await clock(`2027-11-07 ${at}Z`);await run()}
eq(await one("select count(*)::int from notifications where type='shift_reminder'"),1,'fall DST no duplicate')
// 500-item failures:50maximum per tick, allgetafirstattempt, no30minexpiry.
await reset();await db.exec(`with p as(insert into profiles(id) select gen_random_uuid() from generate_series(1,500) returning id),h as(insert into hosts(id,name,user_id,is_active) select gen_random_uuid(),'Synthetic',id,true from p returning id) insert into streams(brand_id,host_id,start_time,end_time) select '${uid(4)}',id,'2027-01-03 00:00Z','2027-01-03 01:00Z' from h`);await activate()
await clock('2027-01-02 08:00Z')
for(let i=0;i<12;i++){const count=await run();eq(count<=50,true);await db.exec("select set_config('test.clock',(test_now()+interval '3 minutes')::text,false)")}
eq(await one("select count(*)::int from reminder_outbox where incident_id is null"),500)
eq(await one("select min(attempts) from reminder_outbox where incident_id is null"),1,'all500attemptedbeforeabandonment')
// No browser role can use internal delivery/outbox APIs.
for(const role of ['anon','authenticated']){
 await db.exec(`set role ${role}`)
 for(const sql of ['select _run_reminder_outbox()','select * from reminder_outbox',`select _reminder_dispatch_allowed('${uid(9)}')`]){await assert.rejects(db.exec(sql),/permission denied/);checks++}
 await db.exec('reset role')
}
await db.close();console.log(`Passed ${checks} reminder outbox SQL checks`)
