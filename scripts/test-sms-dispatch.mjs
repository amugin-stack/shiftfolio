// Synthetic PGlite regression suite for migration 090 (Twilio SMS dispatch).
// Reuses the same real-migration bootstrap as test-auto-scheduler.mjs (078,
// 089) plus this migration (090), and stubs the two external schemas 090
// depends on: vault.decrypted_secrets (a Vault secret lookup) and
// net.http_post (pg_net's async HTTP call), recording every call it would
// have made instead of doing any real network I/O. Synthetic data only.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const { PGlite } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite')
const db = new PGlite()
const mig = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')
const fn = (sql, name) => {
  const m = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\$\\$;`))
  assert.ok(m, `extract ${name}`)
  return m[0]
}
let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++ }
const one = async (sql) => (await db.query(sql)).rows[0]
const val = async (sql) => Object.values(await one(sql))[0]

const admin = 'a0000000-0000-0000-0000-000000000001'
const brand = 'b0000000-0000-0000-0000-000000000001'
const H = n => `10000000-0000-0000-0000-00000000000${n}`
const phone = n => `+1310555010${n}`

// --- Bootstrap (mirrors test-auto-scheduler.mjs's setup section) ----------
await db.exec(`
  create role authenticated; create role anon; create role service_role;
  create schema auth;
  create function auth.uid() returns uuid language sql as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create table profiles (id uuid primary key, role text default 'user');
  insert into profiles values ('${admin}', 'admin');
  create function public.is_admin() returns boolean language sql stable as $$
    select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;
  grant usage on schema auth to authenticated, anon, service_role;
  create table brands (id uuid primary key, name text not null);
  insert into brands values ('${brand}', 'Sample Brand A');
  create table hosts (id uuid primary key, name text, user_id uuid, rate_cents int not null default 0,
    is_active boolean not null default true, self_moderating boolean not null default false);
  create table moderators (id uuid primary key, name text, user_id uuid, rate_cents int not null default 0,
    is_active boolean not null default true);
  create table streams (id uuid primary key default gen_random_uuid(), brand_id uuid not null,
    host_id uuid, moderator_id uuid, start_time timestamptz not null, end_time timestamptz not null,
    host_rate_cents int, notes text);
  create table extra_pay_slots (id uuid primary key default gen_random_uuid(), host_id uuid, moderator_id uuid,
    start_time timestamptz not null, end_time timestamptz not null, status text default 'scheduled');
  create table brand_hosts (brand_id uuid, host_id uuid, primary key (brand_id, host_id));
  grant select, insert, update, delete on all tables in schema public to authenticated;
`)
const m059 = await mig('059_close_deactivation_bypasses.sql')
const m069 = await mig('069_restore_request_brand_and_fix_rate_freeze.sql')
await db.exec(fn(m059, 'enforce_no_double_booking'))
await db.exec(fn(m069, 'freeze_host_rate'))
await db.exec(`
  create trigger trg_enforce_no_double_booking before insert or update of host_id, moderator_id, start_time, end_time
    on streams for each row execute function public.enforce_no_double_booking();
  create trigger trg_freeze_host_rate before insert or update on streams
    for each row execute function public.freeze_host_rate();
`)
await db.exec(await mig('078_staff_unavailability.sql'))
await db.exec(await mig('089_auto_scheduler.sql'))

// --- Stub the two external schemas 090's dispatcher depends on ------------
await db.exec(`
  create schema vault;
  create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
  create schema net;
  create table net._http_calls (
    id serial primary key, url text, body jsonb, headers jsonb,
    timeout_milliseconds int, called_at timestamptz not null default now()
  );
  create function net.http_post(url text, body jsonb default null, headers jsonb default '{}'::jsonb,
    timeout_milliseconds int default 5000) returns bigint
  language plpgsql as $$
  DECLARE v_id bigint;
  BEGIN
    INSERT INTO net._http_calls(url, body, headers, timeout_milliseconds)
    VALUES (url, body, headers, timeout_milliseconds) RETURNING id INTO v_id;
    RETURN v_id;
  END $$;
  grant usage on schema net, vault to authenticated, anon, service_role;
  grant select on net._http_calls, vault.decrypted_secrets to authenticated, anon, service_role;
`)
await db.exec(await mig('090_auto_scheduler_sms_dispatch.sql'))

const asAdmin = `set role authenticated; set request.jwt.claim.sub = '${admin}'`
const asService = `reset role; set request.jwt.claim.sub = ''; set role service_role`
const asOwner = `reset role; set request.jwt.claim.sub = ''`
const dispatch = async () => { await db.exec(asOwner); return val('select public._dispatch_sms_outbox()') }
const httpCalls = () => val('select count(*)::int from net._http_calls')

await db.exec(asOwner)
await db.exec(`insert into hosts (id, name) values ('${H(1)}', 'Ana')`)
await db.exec(`insert into brand_hosts values ('${brand}', '${H(1)}')`)

// Helper: insert a coverage_request + coverage_offer + queued sms_outbox row,
// returns their ids. run_start/run_end are far enough out to never collide
// with "already started" guards.
let replyCodeCounter = 1000
async function makeOfferOutbox({ offerState = 'pending', expiresIn = "'2 hours'", attempts = 0, nextAttempt = 'now()' } = {}) {
  const replyCode = String(replyCodeCounter++)
  const req = await one(`insert into coverage_requests (run_key, role, brand_id, stream_ids, run_start, run_end)
    values (gen_random_uuid()::text, 'host', '${brand}', array[gen_random_uuid()], now() + interval '3 days', now() + interval '3 days 2 hours')
    returning *`)
  const offer = await one(`insert into coverage_offers (request_id, worker_id, phone_e164, reply_code, state, expires_at)
    values ('${req.id}', '${H(1)}', '${phone(1)}', '${replyCode}', '${offerState}', now() + interval ${expiresIn})
    returning *`)
  const outbox = await one(`insert into sms_outbox (to_e164, body, kind, offer_id, request_id, state, attempts, next_attempt_at)
    values ('${phone(1)}', 'Studio: Open host shift, SAMPLE BRAND A test. Reply YES 4242 to take it.', 'offer', '${offer.id}', '${req.id}',
      'queued', ${attempts}, ${nextAttempt})
    returning *`)
  return { req, offer, outbox }
}

// --- 1. Disabled by default: dispatcher does nothing. ----------------------
{
  const { outbox } = await makeOfferOutbox()
  eq(await dispatch(), 0, 'disabled: returns 0')
  eq(await val(`select state from sms_outbox where id = '${outbox.id}'`), 'queued', 'disabled: row untouched')
  eq(await httpCalls(), 0, 'disabled: no http calls')
  await db.exec(`delete from sms_outbox; delete from coverage_offers; delete from coverage_requests`)
}

// --- 2. Enabled, but no vault secret configured: still a no-op. -----------
{
  await db.exec(`update scheduler_runtime set enabled = true`)
  const { outbox } = await makeOfferOutbox()
  eq(await dispatch(), 0, 'no secret: returns 0')
  eq(await val(`select state from sms_outbox where id = '${outbox.id}'`), 'queued', 'no secret: row untouched')
  eq(await httpCalls(), 0, 'no secret: no http calls')
  await db.exec(`delete from sms_outbox; delete from coverage_offers; delete from coverage_requests`)
}

await db.exec(`insert into vault.decrypted_secrets (name, decrypted_secret) values ('sms_webhook_secret', 'synthetic-secret-0001')`)

// --- 3. Sends a queued, still-pending offer text. --------------------------
{
  const { outbox } = await makeOfferOutbox()
  eq(await dispatch(), 1, 'sends the one due row')
  const after = await one(`select * from sms_outbox where id = '${outbox.id}'`)
  eq(after.state, 'queued', 'stays queued pending sms-send result')
  eq(after.attempts, 1, 'attempts incremented')
  const call = await one(`select * from net._http_calls order by id desc limit 1`)
  eq(call.url, 'https://demo-project.supabase.invalid/functions/v1/sms-send', 'posts to sms-send')
  eq(call.headers['X-Webhook-Secret'], 'synthetic-secret-0001', 'carries the webhook secret')
  eq(call.body.id, outbox.id, 'body carries the outbox row id')
  eq(call.timeout_milliseconds, 30000, '30s timeout')
  const gapMinutes = (new Date(after.next_attempt_at) - Date.now()) / 60000
  ok(gapMinutes > 1.9 && gapMinutes < 2.2, `first backoff ~2 min (was ${gapMinutes})`)
}

// --- 4. A stale/expired offer is canceled instead of texted. ---------------
{
  const { outbox: expired } = await makeOfferOutbox({ expiresIn: "'-1 minute'" })
  const { outbox: declined } = await makeOfferOutbox({ offerState: 'no' })
  const before = await httpCalls()
  await dispatch()
  eq(await val(`select state from sms_outbox where id = '${expired.id}'`), 'canceled', 'expired offer canceled, not sent')
  eq(await val(`select state from sms_outbox where id = '${declined.id}'`), 'canceled', 'declined offer canceled, not sent')
  eq(await httpCalls(), before, 'no new http call for canceled rows')
}

// --- 5. dry_run rows are never touched. ------------------------------------
{
  const { req, offer } = await makeOfferOutbox()
  const dryRun = await one(`update sms_outbox set state = 'dry_run' where offer_id = '${offer.id}' returning *`)
  const before = await httpCalls()
  await dispatch()
  eq(await val(`select state from sms_outbox where id = '${dryRun.id}'`), 'dry_run', 'dry_run row left alone')
  eq(await httpCalls(), before, 'dry_run generates no http call')
  await db.exec(`delete from sms_outbox where id = '${dryRun.id}'`)
  await db.exec(`delete from coverage_requests where id = '${req.id}'`)
}

// --- 6. Backoff schedule across attempts 0->1->2->3, capped at the 4th. ---
{
  const mkEscalation = async (attempts) => one(`insert into sms_outbox (to_e164, body, kind, state, attempts, next_attempt_at)
    values ('+13105550199', 'Studio bot: could not fill a shift.', 'escalation', 'queued', ${attempts}, now()) returning *`)
  const expectMinutes = { 0: 2, 1: 4, 2: 8, 3: 16, 4: 16 }
  for (const attempts of [0, 1, 2, 3, 4]) {
    const row = await mkEscalation(attempts)
    await dispatch()
    const after = await one(`select * from sms_outbox where id = '${row.id}'`)
    eq(after.attempts, attempts + 1, `attempts ${attempts} -> ${attempts + 1}`)
    const gapMinutes = (new Date(after.next_attempt_at) - Date.now()) / 60000
    const expected = expectMinutes[attempts]
    ok(Math.abs(gapMinutes - expected) < 0.3, `backoff after attempts=${attempts} ~${expected}min (was ${gapMinutes})`)
  }
  // attempts=5 is past the retry ceiling: never picked up again.
  const stuck = await one(`insert into sms_outbox (to_e164, body, kind, state, attempts, next_attempt_at)
    values ('+13105550199', 'Studio bot: still open.', 'escalation', 'queued', 5, now()) returning *`)
  const before = await httpCalls()
  eq(await dispatch(), 0, 'attempts>=5 rows are not picked up by the dispatcher')
  eq(await httpCalls(), before, 'no http call for an exhausted row')
  eq(await val(`select attempts from sms_outbox where id = '${stuck.id}'`), 5, 'exhausted row left as-is')
}

// --- 7. sms_claim_for_send: happy path, and it refuses a stale offer. ------
await db.exec(`delete from sms_outbox; delete from coverage_offers; delete from coverage_requests`)
{
  const { outbox } = await makeOfferOutbox()
  await db.exec(asService)
  const claimed = await one(`select * from public.sms_claim_for_send('${outbox.id}')`)
  eq(claimed.to_e164, phone(1), 'claim returns the phone number')
  ok(claimed.body.includes('Reply YES'), 'claim returns the message body')
  await db.exec(asOwner)
}
{
  // Offer went stale after the outbox row was queued but before claim.
  const { req, offer, outbox } = await makeOfferOutbox()
  await db.exec(`update coverage_offers set state = 'stale' where id = '${offer.id}'`)
  await db.exec(asService)
  const claimedRows = (await db.query(`select * from public.sms_claim_for_send('${outbox.id}')`)).rows
  eq(claimedRows.length, 0, 'stale offer: claim returns nothing')
  await db.exec(asOwner)
  eq(await val(`select state from sms_outbox where id = '${outbox.id}'`), 'canceled', 'stale offer: claim cancels the row')
  await db.exec(`delete from coverage_offers where id = '${offer.id}'; delete from coverage_requests where id = '${req.id}'`)
}
{
  // Row already claimed/dispatched (not 'queued' anymore) is refused too.
  const { outbox } = await makeOfferOutbox()
  await db.exec(`update sms_outbox set state = 'accepted' where id = '${outbox.id}'`)
  await db.exec(asService)
  const claimedRows = (await db.query(`select * from public.sms_claim_for_send('${outbox.id}')`)).rows
  eq(claimedRows.length, 0, 'non-queued row: claim returns nothing')
  await db.exec(asOwner)
}

// --- 8. sms_mark_result: success, retryable error, and final failure. -----
await db.exec(`delete from sms_outbox; delete from coverage_offers; delete from coverage_requests`)
{
  const { outbox } = await makeOfferOutbox()
  await db.exec(asService)
  await db.exec(`select public.sms_mark_result('${outbox.id}', 'SMsynthetic123', null)`)
  await db.exec(asOwner)
  const after = await one(`select * from sms_outbox where id = '${outbox.id}'`)
  eq(after.state, 'accepted', 'success -> accepted')
  eq(after.provider_sid, 'SMsynthetic123', 'success -> provider_sid recorded')
  ok(after.accepted_at !== null, 'success -> accepted_at stamped')
}
{
  // Error with attempts < 5: stays queued for the next retry.
  const outbox = await one(`insert into sms_outbox (to_e164, body, kind, state, attempts, next_attempt_at)
    values ('+13105550199', 'Studio bot: escalation.', 'escalation', 'queued', 2, now()) returning *`)
  await db.exec(asService)
  await db.exec(`select public.sms_mark_result('${outbox.id}', null, 'twilio_http_500')`)
  await db.exec(asOwner)
  const after = await one(`select * from sms_outbox where id = '${outbox.id}'`)
  eq(after.state, 'queued', 'retryable error: stays queued')
  eq(after.last_error, 'twilio_http_500', 'error message recorded')
}
{
  // Error with attempts >= 5: final failure.
  const outbox = await one(`insert into sms_outbox (to_e164, body, kind, state, attempts, next_attempt_at)
    values ('+13105550199', 'Studio bot: escalation.', 'escalation', 'queued', 5, now()) returning *`)
  await db.exec(asService)
  await db.exec(`select public.sms_mark_result('${outbox.id}', null, 'twilio_http_500')`)
  await db.exec(asOwner)
  eq(await val(`select state from sms_outbox where id = '${outbox.id}'`), 'failed', 'exhausted retries -> failed')
}
{
  // last_error is truncated to 500 chars.
  const outbox = await one(`insert into sms_outbox (to_e164, body, kind, state, attempts, next_attempt_at)
    values ('+13105550199', 'Studio bot: escalation.', 'escalation', 'queued', 1, now()) returning *`)
  const longError = 'x'.repeat(900)
  await db.exec(asService)
  await db.exec(`select public.sms_mark_result('${outbox.id}', null, '${longError}')`)
  await db.exec(asOwner)
  eq(await val(`select length(last_error) from sms_outbox where id = '${outbox.id}'`), 500, 'error message truncated to 500 chars')
}

// --- 9. Grants: authenticated (and anon) cannot call claim/mark/dispatch. --
await db.exec(`${asOwner}; delete from sms_outbox`)
{
  const outbox = await one(`insert into sms_outbox (to_e164, body, kind, state) values ('${phone(1)}', 'x', 'escalation', 'queued') returning *`)
  await db.exec(asAdmin)
  await assert.rejects(db.query(`select * from public.sms_claim_for_send('${outbox.id}')`), /permission denied/)
  checks++
  await assert.rejects(db.query(`select public.sms_mark_result('${outbox.id}', 'x', null)`), /permission denied/)
  checks++
  await assert.rejects(db.query(`select public._dispatch_sms_outbox()`), /permission denied/)
  checks++
  await assert.rejects(db.query(`select public._run_auto_scheduler_cycle()`), /permission denied/)
  checks++
  await db.exec(`reset role; set request.jwt.claim.sub = ''; set role anon`)
  await assert.rejects(db.query(`select * from public.sms_claim_for_send('${outbox.id}')`), /permission denied/)
  checks++
}

await db.close()
console.log(`SMS dispatch PostgreSQL integration: ${checks} checks passed.`)
