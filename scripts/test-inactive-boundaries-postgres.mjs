// Full migration history, real role/RLS checks, disposable synthetic DB only.
import { Client } from 'pg'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { installFullSchema } from './fixtures/full-schema.mjs'
const raw=process.env.TEST_DATABASE_URL
if(!raw) throw new Error('TEST_DATABASE_URL required')
const url=new URL(raw)
if(!['127.0.0.1','localhost','postgres'].includes(url.hostname)||!url.pathname.includes('synthetic')||raw.includes('.supabase.co')||(url.hostname==='postgres'&&!process.env.CI)) throw new Error('Refusing non-synthetic target')
const control=new Client({connectionString:raw});await control.connect()
const name=`security_test_full_${randomBytes(6).toString('hex')}`
await control.query(`CREATE DATABASE ${name}`)
url.pathname=`/${name}`
const db=new Client({connectionString:url.href});await db.connect()
let checks=0
const eq=async(sql,value)=>{assert.deepEqual(Object.values((await db.query(sql)).rows[0])[0],value);checks++}
const deny=async(sql)=>{await assert.rejects(db.query(sql));checks++}
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
const as=async n=>{await db.query(`RESET ROLE;SET request.jwt.claim.sub='${id(n)}';SET ROLE authenticated`)}
try {
 await installFullSchema(db)
 await db.query(await readFile(new URL('../supabase/migrations/082_deactivated_worker_access.sql',import.meta.url),'utf8'))
 await db.query(await readFile(new URL('../supabase/migrations/087_bounded_reads_and_own_pay.sql',import.meta.url),'utf8'))
 await db.query(`
 INSERT INTO auth.users(id,email) SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'synthetic'||n||'@example.invalid' FROM generate_series(1,7)n;
 -- Fixture bootstrap creates an initial administrator; every tested mutation
 -- below runs with real triggers and authenticated role after this seed.
 ALTER TABLE profiles DISABLE TRIGGER trg_prevent_self_role_escalation;
 UPDATE profiles SET role='admin' WHERE id='${id(1)}';
 ALTER TABLE profiles ENABLE TRIGGER trg_prevent_self_role_escalation;
 SET request.jwt.claim.sub='${id(1)}';
 INSERT INTO hosts(id,name,user_id,is_active,rate_cents) VALUES
 ('${id(12)}','Active','${id(2)}',true,2000),('${id(13)}','Inactive','${id(3)}',false,2000),('${id(15)}','Mixed','${id(5)}',false,2000);
 INSERT INTO moderators(id,name,user_id,is_active,rate_cents) VALUES
 ('${id(14)}','Inactive moderator','${id(4)}',false,2000),('${id(16)}','Mixed active moderator','${id(5)}',true,2000);
 INSERT INTO producers(id,name,user_id) VALUES('${id(17)}','Producer','${id(6)}');
 INSERT INTO brands(id,name) VALUES('${id(20)}','Synthetic Brand');
 INSERT INTO streams(id,title,brand_id,host_id,moderator_id,start_time,end_time,created_by) VALUES
 ('${id(30)}','Completed','${id(20)}','${id(13)}','${id(14)}','2020-01-01 10:00Z','2020-01-01 12:00Z','${id(1)}'),
 ('${id(31)}','Upcoming','${id(20)}','${id(13)}','${id(14)}','2098-01-01 10:00Z','2098-01-01 12:00Z','${id(1)}'),
 ('${id(32)}','Mixed upcoming','${id(20)}','${id(15)}',null,'2098-01-02 10:00Z','2098-01-02 12:00Z','${id(1)}');
 INSERT INTO notifications(recipient_id,type,host_name,brand_name,shift_start,shift_end) VALUES('${id(3)}','shift_booked','Synthetic','Synthetic','2098-01-01','2098-01-02');
 GRANT USAGE ON SCHEMA storage TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
 INSERT INTO storage.objects(bucket_id,name) VALUES('headshots','${id(3)}/old.png');
 `)
 for(const n of [3,4]) {
  await as(n)
  await eq('SELECT _is_deactivated_worker()',true)
  await eq('SELECT count(*)::int FROM hosts WHERE user_id<>auth.uid()',0)
  await eq('SELECT count(*)::int FROM moderators WHERE user_id<>auth.uid()',0)
  await eq('SELECT count(*)::int FROM producers',0)
  await eq('SELECT count(*)::int FROM brands',0)
  await eq('SELECT count(*)::int FROM notifications',0)
  await eq('SELECT count(*)::int FROM streams',0)
  await eq('SELECT count(*)::int FROM profiles WHERE id=auth.uid()',1)
  await eq('SELECT count(*)::int FROM get_my_completed_pay_page()',1)
  await eq('SELECT count(*)::int FROM get_my_pay_context()',0)
  await eq('SELECT count(*)::int FROM get_my_session_gmv()',0)
  await eq('SELECT count(*)::int FROM admin_host_rate_map()',0)
  await eq('SELECT count(*)::int FROM admin_moderator_rate_map()',0)
  await eq('SELECT count(*)::int FROM admin_stream_pay()',0)
  await eq('SELECT count(*)::int FROM admin_brand_pricing()',0)
  await deny(`SELECT set_session_gmv('${id(30)}',100)`)
  await deny(`SELECT host_busy_in_range('${id(13)}','2098-01-01','2098-01-03',null)`)
  await deny(`SELECT moderator_busy_in_range('${id(14)}','2098-01-01','2098-01-03',null)`)
  await eq("SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('submit_stream_summary','get_stream_summary','book_shift','unbook_shift')",0)
  await eq("WITH changed AS (UPDATE profiles SET full_name='Forbidden' WHERE id=auth.uid() RETURNING id) SELECT count(*)::int FROM changed",0)
  await deny(`SELECT request_shift_cancellation('${id(31)}','Synthetic denied')`)
  await deny(`SELECT request_brand('${id(20)}')`)
  await deny(`INSERT INTO storage.objects(bucket_id,name) VALUES('headshots','${id(n)}/new.png')`)
  await eq("WITH changed AS (DELETE FROM storage.objects RETURNING id) SELECT count(*)::int FROM changed",0)
  await eq("WITH changed AS (UPDATE storage.objects SET name='forbidden' RETURNING id) SELECT count(*)::int FROM changed",0)
 }
 for(const n of [1,2,5,6,7]) {
  await as(n);await eq('SELECT _is_deactivated_worker()',false)
  await eq('SELECT count(*)::int FROM brands',1)
  await eq("WITH changed AS (UPDATE profiles SET full_name='Allowed synthetic' WHERE id=auth.uid() RETURNING id) SELECT count(*)::int FROM changed",1)
 }
 await as(5);await deny(`SELECT request_shift_cancellation('${id(32)}','Inactive host membership')`)
 await as(2);await db.query(`INSERT INTO storage.objects(bucket_id,name) VALUES('headshots','${id(2)}/allowed.png')`);checks++
 await db.query('RESET ROLE')
 await eq('SELECT count(*)::int FROM shift_cancellation_requests',0)
 await eq("SELECT count(*)::int FROM storage.objects WHERE name LIKE '%old.png'",1)
 console.log(`${checks} full-schema inactive account boundary checks passed`)
} finally {
 await db.end();await control.query(`DROP DATABASE ${name} WITH (FORCE)`);await control.end()
}
