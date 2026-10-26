// Real concurrent PostgreSQL connections, synthetic scratch database only.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {setupSQL,migrationSQL} from './fixtures/reminder-outbox.mjs'
const require=createRequire(import.meta.url)
const {Client}=require(process.argv[2]??'pg')
const raw=process.env.TEST_DATABASE_URL
if(!raw)throw new Error('TEST_DATABASE_URL is required; use isolated local/CI PostgreSQL')
const url=new URL(raw)
if(!['127.0.0.1','localhost','postgres'].includes(url.hostname)||!url.pathname.includes('synthetic')||raw.includes('.supabase.co')||url.hostname==='postgres'&&!process.env.CI)throw new Error('Refusing non-synthetic/non-local database')
const control=new Client({connectionString:raw});await control.connect()
const database=`studio_reminder_synthetic_${process.pid}`
await control.query(`CREATE DATABASE ${database}`)
const local=new URL(raw);local.pathname=`/${database}`
const clients=[];let checks=0
const eq=(a,b)=>{assert.deepEqual(a,b);checks++}
try{
 for(let i=0;i<4;i++){const c=new Client({connectionString:local.href});await c.connect();clients.push(c)}
 const db=clients[0]
 const setup=setupSQL.replace(/create role (anon|authenticated|service_role);/g,(_,r)=>`DO $$ BEGIN CREATE ROLE ${r}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`)
 await db.query(setup)
 for(const n of ['076','079','084'])await db.query(await migrationSQL(n))
 for(const c of clients)await c.query("set test.clock='2027-01-01 00:00Z'")
 await db.query("insert into streams(brand_id,host_id,start_time,end_time) values('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','2027-01-02 00:00Z','2027-01-02 01:00Z')")
 await db.query(await migrationSQL('085'));await db.query(await migrationSQL('086'))
 for(const c of clients)await c.query("set test.clock='2027-01-01 08:00Z'")
 const results=await Promise.all(clients.map(c=>c.query('select _run_reminder_outbox() n')))
 eq(results.reduce((sum,r)=>sum+r.rows[0].n,0),1)
 eq((await db.query('select count(*)::int n from reminder_outbox')).rows[0].n,1)
 eq((await db.query('select count(*)::int n from net.requests')).rows[0].n,1)
 // Another overlapping worker tick retries the same notification, once.
 for(const c of clients)await c.query("set test.clock='2027-01-01 08:03Z'")
 const retries=await Promise.all(clients.map(c=>c.query('select _run_reminder_outbox() n')))
 eq(retries.reduce((sum,r)=>sum+r.rows[0].n,0),1)
 eq((await db.query("select count(distinct body->'record'->>'id')::int n from net.requests")).rows[0].n,1)
 // Rolled-back correction claim cannot orphan notifications or consume identity.
 await db.query("update streams set end_time=end_time+interval '15 minutes'")
 await db.query('begin');await db.query('select _run_reminder_outbox()');await db.query('rollback')
 eq((await db.query("select count(*)::int n from notifications where body='corrected'")).rows[0].n,0)
 const correction=await Promise.all(clients.map(c=>c.query('select _run_reminder_outbox() n')))
 eq(correction.reduce((sum,r)=>sum+r.rows[0].n,0),1)
 eq((await db.query("select count(*)::int n from notifications where body='corrected'")).rows[0].n,1)
 console.log(`Passed ${checks} real PostgreSQL concurrency/rollback checks`)
}finally{
 await Promise.all(clients.map(c=>c.end()))
 await control.query(`DROP DATABASE ${database}`);await control.end()
}
