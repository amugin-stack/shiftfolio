// Full migration integration gate. Disposable local/CI database; no real sends.
import assert from 'node:assert/strict'
import { Client } from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { installFullSchema } from './fixtures/full-schema.mjs'
const raw=process.env.TEST_DATABASE_URL
if(!raw) throw new Error('Synthetic TEST_DATABASE_URL required')
const url=new URL(raw)
if(!['127.0.0.1','localhost','postgres'].includes(url.hostname)||!url.pathname.includes('synthetic')||url.hostname==='postgres'&&!process.env.CI) throw new Error('Only isolated synthetic database targets allowed')
const control=new Client({connectionString:raw});await control.connect()
const database=`studio_full_synthetic_${process.pid}_${randomBytes(4).toString('hex')}`
let db,created=false
try{
 await control.query(`create database ${database}`);created=true
 const target=new URL(raw);target.pathname='/'+database;db=new Client({connectionString:target.href});await db.connect()
 await installFullSchema(db)
 const dir=new URL('../supabase/migrations/',import.meta.url)
 // Performance expansion must precede app rollout; activation remains last.
 for(const n of ['082','083','084','087','085','086','088']){
  const name=(await readdir(dir)).find(f=>f.startsWith(n+'_'))
  await db.query(await readFile(new URL(name,dir),'utf8'))
 }
 await db.query(`insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-0000-0000-000000000001','admin@example.test','{}');
 alter table profiles disable trigger trg_prevent_self_role_escalation;
 update profiles set role='admin' where id='00000000-0000-0000-0000-000000000001';
 alter table profiles enable trigger trg_prevent_self_role_escalation;
 insert into auth.users(id,email,raw_user_meta_data) values('00000000-0000-0000-0000-000000000002','worker@example.test','{}');
 select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
 insert into hosts(id,name,user_id,rate_cents) values('00000000-0000-0000-0000-000000000012','Sample Worker','00000000-0000-0000-0000-000000000002',3000);
 insert into brands(id,name) values('00000000-0000-0000-0000-000000000020','Sample Brand');
 insert into streams(title,brand_id,host_id,start_time,end_time,created_by) values('Sample Shift','00000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000012',((now() at time zone 'America/Los_Angeles') at time zone 'UTC')+interval'25 hours',((now() at time zone 'America/Los_Angeles') at time zone 'UTC')+interval'26 hours','00000000-0000-0000-0000-000000000001');
 select _run_reminder_outbox();`)
 // Actual constructors against actual historical NOT NULL/FK/check constraints.
 const incident=await db.query("select _record_reminder_incident('synthetic-check','Synthetic delayed reminder') id")
 assert.ok(incident.rows[0].id)
 await db.query("select _queue_reminder_v2(s,'00000000-0000-0000-0000-000000000020','Sample Brand',24,'24h') from reminder_sessions s limit 1")
 const rows=(await db.query("select type,host_name,brand_name from notifications where type in ('shift_reminder','reminder_delivery_alert')")).rows
 assert.ok(rows.some(r=>r.type==='shift_reminder'));assert.ok(!rows.some(r=>r.type==='reminder_delivery_alert'));assert.ok(rows.every(r=>r.host_name&&r.brand_name))
 console.log('Full migration baseline + all repairs + worker notifications and suppressed administrator alerts passed (4 assertions)')
}finally{
 if(db)await db.end()
 if(created)await control.query(`drop database ${database} with (force)`)
 await control.end()
}
