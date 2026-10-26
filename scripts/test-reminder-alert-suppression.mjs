import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { setupSQL, migrationSQL } from './fixtures/reminder-outbox.mjs'
const db = new PGlite()
let checks = 0
const one = async sql => Object.values((await db.query(sql)).rows[0])[0]
const eq = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++ }
await db.exec(setupSQL)
for (const n of ['076', '079', '084']) await db.exec(await migrationSQL(n))
await db.exec(`set test.clock='2027-01-01 00:00Z';
 insert into profiles(id,role) values('00000000-0000-0000-0000-000000000005','admin');
 insert into streams(brand_id,host_id,start_time,end_time) values
 ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','2027-01-02 10:00Z','2027-01-02 11:00Z');`)
for (const n of ['085', '086']) await db.exec(await migrationSQL(n))
await db.exec(`set test.clock='2027-01-01 18:00Z';select _run_reminder_outbox();`)
const worker = await one("select notification_id from reminder_outbox where incident_id is null limit 1")
const alert = await one("select notification_id from reminder_outbox where incident_id is not null limit 1")
eq(await one(`select _reminder_dispatch_allowed('${alert}')`), true, 'fixture has an in-flight administrator alert')
await db.exec(await migrationSQL('088'))
eq(await one(`select _reminder_dispatch_allowed('${alert}')`), false, 'in-flight alert guard stops sending')
eq(await one(`select _claim_reminder_send_slot('${alert}')`), null, 'no new provider slot for alert')
eq(await one(`select _prepare_reminder_email('${alert}','{}')`), null, 'no provider payload for alert')
eq(await one(`select state from reminder_outbox where notification_id='${alert}'`), 'superseded', 'pending alert canceled')
eq(await one("select count(*)::int from notifications where type='reminder_delivery_alert' and dismissed_at is null"), 0, 'alert bell copies dismissed')
eq(await one(`select _reminder_dispatch_allowed('${worker}')`), true, 'assigned worker reminder remains eligible')
const before = await one('select count(*)::int from notifications')
eq(await one("select _record_reminder_incident('account:unassigned','No assignment')"), null, 'missing account quietly ignored')
eq(await one("select count(*)::int from reminder_incidents where dedup_key='account:unassigned'"), 0, 'no incident for missing account')
const diagnostic = await one("select _record_reminder_incident('delivery:synthetic','Synthetic failure')")
eq(await one("select _record_reminder_incident('delivery:synthetic','Synthetic failure')"), diagnostic, 'private diagnostics remain deduplicated')
eq(await one('select count(*)::int from notifications'), before, 'failure creates no administrator notifications or emails')
await db.exec(`update reminder_outbox set state='queued',last_attempt_at=test_now() where notification_id='${alert}'`)
eq(await one(`select _reminder_dispatch_allowed('${alert}')`), false, 'accidental future alert queue cannot bypass guard')
await db.exec(`update hosts set user_id=null;
 insert into streams(brand_id,start_time,end_time) values('00000000-0000-0000-0000-000000000004','2027-01-02 12:00Z','2027-01-02 13:00Z');
 set test.clock='2027-01-01 18:03Z';select _run_reminder_outbox();`)
eq(await one('select count(*)::int from notifications'), before, 'unlinked and unassigned shifts do not create alerts')
eq(await one("select has_function_privilege('authenticated','_record_reminder_incident(text,text)','EXECUTE')"), false, 'diagnostic function remains private')
eq(await one("select has_function_privilege('anon','_reminder_dispatch_allowed(uuid)','EXECUTE')"), false, 'guard remains private')
eq(await one('select enabled from reminder_runtime'), true, 'worker scheduler remains enabled')
console.log(`${checks} reminder alert suppression checks passed`)
await db.close()
