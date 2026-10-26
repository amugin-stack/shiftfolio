// Synthetic SQL only. Never connects to production.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
const target = process.env.SECURITY_TEST_DATABASE_URL
let db, pool
if (target) {
  const url = new URL(target)
  if (!['127.0.0.1','localhost','postgres'].includes(url.hostname) || (url.hostname === 'postgres' && !process.env.CI) || !/^\/security_test_[a-z0-9_]+$/.test(url.pathname) || target.includes('.supabase.co')) throw new Error('Refusing non-local synthetic database')
  const { Pool } = await import('pg')
  pool = new Pool({ connectionString: target })
  const client = await pool.connect()
  db = { query: sql => client.query(sql), exec: sql => client.query(sql), close: async () => { client.release(); await pool.end() } }
} else db=new PGlite()
let checks=0
const q=async sql=>(await db.query(sql)).rows
const eq=async(sql,want)=>{assert.deepEqual(Object.values((await q(sql))[0])[0],want);checks++}
const no=async(sql)=>{await assert.rejects(db.exec(sql));checks++}
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
await db.exec(`
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO authenticated,anon,service_role;
CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
CREATE TABLE profiles(id uuid PRIMARY KEY,email text,role text,full_name text,phone text);
CREATE TABLE hosts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,name text,email text,phone text,is_active boolean DEFAULT true,rate_cents int,email_disabled_at timestamptz,email_disabled_reason text);
CREATE TABLE moderators(LIKE hosts INCLUDING ALL); CREATE TABLE producers(LIKE hosts INCLUDING ALL);
CREATE TABLE brands(id uuid PRIMARY KEY,name text,producer_id uuid);
CREATE TABLE brand_hosts(brand_id uuid,host_id uuid);
CREATE TABLE brand_host_requests(id uuid DEFAULT gen_random_uuid(),host_user_id uuid,brand_id uuid,status text DEFAULT 'pending');
CREATE TABLE shift_cancellation_requests(id uuid,stream_id uuid,host_user_id uuid,status text,reason text);
CREATE TABLE streams(id uuid PRIMARY KEY,host_id uuid,moderator_id uuid,brand_id uuid,start_time timestamptz,end_time timestamptz,host_rate_cents int,gmv_cents int);
CREATE TABLE notifications(id uuid DEFAULT gen_random_uuid(),recipient_id uuid,type text,actor_host_id uuid,host_name text,brand_id uuid,brand_name text,request_id uuid,is_read boolean,email_message_id text);
CREATE TABLE email_events(message_id text,recipient text,event_type text,payload jsonb);
CREATE FUNCTION is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$SELECT EXISTS(SELECT 1 FROM profiles WHERE id=auth.uid() AND role='admin')$$;
GRANT USAGE ON SCHEMA auth TO authenticated,anon;GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated,anon;
GRANT SELECT,UPDATE,DELETE ON notifications TO authenticated;
GRANT UPDATE(email_message_id) ON notifications TO authenticated;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_read ON notifications FOR SELECT TO authenticated USING(recipient_id=auth.uid());
CREATE POLICY own_update ON notifications FOR UPDATE TO authenticated USING(recipient_id=auth.uid()) WITH CHECK(recipient_id=auth.uid());
CREATE POLICY own_delete ON notifications FOR DELETE TO authenticated USING(recipient_id=auth.uid());
INSERT INTO brands VALUES('${id(99)}','Synthetic',null);
INSERT INTO profiles SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'worker'||n||'@example.invalid','user','Synthetic','' FROM generate_series(1,6)n;
INSERT INTO hosts(id,user_id,is_active,rate_cents) VALUES('${id(1)}','${id(1)}',false,1111),('${id(3)}','${id(3)}',true,3333);
INSERT INTO moderators(id,user_id,is_active,rate_cents) VALUES('${id(2)}','${id(2)}',false,2222),('${id(4)}','${id(4)}',true,4444),('${id(3)}','${id(3)}',false,3333);
INSERT INTO producers(id,user_id) VALUES('${id(5)}','${id(5)}'); UPDATE profiles SET role='admin' WHERE id='${id(6)}';
INSERT INTO streams VALUES('${id(101)}','${id(1)}','${id(2)}','${id(99)}','2020-01-01','2020-01-02',1000,0),('${id(102)}','${id(1)}','${id(2)}','${id(99)}','2099-01-01','2099-01-02',2000,0);
`)
for(const name of ['082_deactivated_worker_access.sql','083_atomic_email_webhooks.sql']) await db.exec(readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8'))
// Later outbox columns must stay server-owned without another grant change.
await db.exec(`ALTER TABLE notifications ADD COLUMN email_deferred boolean DEFAULT false, ADD COLUMN reminder_role text;
INSERT INTO notifications(recipient_id,is_read) VALUES('${id(1)}',false),('${id(2)}',false)`)
for(let n=1;n<=6;n++){
 await db.exec(`SET test.uid='${id(n)}';SET ROLE authenticated`)
 await eq('SELECT _is_deactivated_worker()',n<=2)
 if(n<=2){await no(`SELECT request_brand('${id(99)}')`);await eq('SELECT count(*)::int FROM get_my_pay_context()',0)}
 else await eq('SELECT count(*)::int FROM get_my_pay_context()',1)
 await db.exec('RESET ROLE')
}
await db.exec(`SET test.uid='${id(1)}';SET ROLE authenticated`)
await eq('SELECT count(*)::int FROM get_my_stream_pay()',1)
await db.exec(`RESET ROLE;SET test.uid='${id(3)}';UPDATE notifications SET recipient_id='${id(3)}' WHERE recipient_id='${id(1)}';SET ROLE authenticated`)
await no("UPDATE notifications SET email_message_id='forged'")
await no("UPDATE notifications SET email_deferred=false")
await no("UPDATE notifications SET reminder_role='host'")
await db.exec('UPDATE notifications SET is_read=true')
await eq('SELECT bool_and(is_read) FROM notifications',true)
await db.exec('DELETE FROM notifications')
await eq('SELECT count(*)::int FROM notifications',0)
await no("SELECT _process_resend_event('unauthorized','{}')")
await db.exec('RESET ROLE')
await eq('SELECT count(*)::int FROM notifications',1)
await db.exec(`SET test.uid='${id(2)}'; SET ROLE authenticated`)
await eq('SELECT count(*)::int FROM get_my_setup_bonus_stream_ids()',1)
await db.exec('RESET ROLE')
await db.exec(`GRANT SELECT,UPDATE ON profiles TO authenticated; SET ROLE authenticated`)
await no("UPDATE profiles SET email_disabled_at=now()")
await db.exec('RESET ROLE')
const event=JSON.stringify({type:'email.bounced',data:{email_id:'synthetic',to:['worker2@example.invalid']}})
await eq(`SELECT _process_resend_event('one','${event}')`,true)
await eq(`SELECT _process_resend_event('one','${event}')`,false)
await eq('SELECT count(*)::int FROM email_events',1)
await eq(`SELECT email_disabled_at IS NOT NULL FROM profiles WHERE id='${id(2)}'`,true)
// Failed side effect rolls receipt back, so the same event remains retryable.
await db.exec(`CREATE FUNCTION synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic outage';END$$; CREATE TRIGGER synthetic_fail BEFORE INSERT ON email_events FOR EACH ROW EXECUTE FUNCTION synthetic_fail()`)
await no(`SELECT _process_resend_event('retry','${event}')`)
await eq("SELECT count(*)::int FROM email_webhook_receipts WHERE event_id='retry'",0)
await db.exec('DROP TRIGGER synthetic_fail ON email_events')
await eq(`SELECT _process_resend_event('retry','${event}')`,true)
if (pool) {
  const results = await Promise.all(Array.from({length:8}, () => pool.query(`SELECT _process_resend_event('concurrent','${event}') AS accepted`)))
  assert.equal(results.filter(r => r.rows[0].accepted).length,1); checks++
  await eq("SELECT count(*)::int FROM email_webhook_receipts WHERE event_id='concurrent'",1)
}
console.log(`${checks} SQL security assertions passed`)
await db.close()
