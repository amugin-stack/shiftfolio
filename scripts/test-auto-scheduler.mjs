// Synthetic PGlite regression suite for migration 089 (auto-scheduler).
// Loads the REAL 078 and 089 migrations plus the real double-booking (059) and
// rate-freeze (069) trigger bodies, so bot bookings are proven to hit the same
// guards as admin bookings. Synthetic data only.
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
const brand2 = 'b0000000-0000-0000-0000-000000000002'
const H = n => `10000000-0000-0000-0000-00000000000${n}`
const M = n => `20000000-0000-0000-0000-00000000000${n}`
const phone = n => `+1310555010${n}`
// PT-naive instant: day offset from today (PT) at an hour, as a SQL expression.
let todayPt = ''
const at = (day, hour) =>
  `(('${todayPt}'::timestamp + interval '${day} days ${hour} hours') AT TIME ZONE 'UTC')`

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
  insert into brands values ('${brand}', 'Sample Brand A'), ('${brand2}', 'Sample Brand B');
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
todayPt = (await db.query(`select date_trunc('day', public._sched_now_pt() AT TIME ZONE 'UTC')::text as d`)).rows[0].d

// Roster: 4 hosts in Sample Brand A pool (H5 is NOT), 2 moderators.
await db.exec(`
  insert into hosts (id, name, rate_cents, self_moderating) values
    ('${H(1)}','Ana',2500,false), ('${H(2)}','Ben',3000,false), ('${H(3)}','Cy',2000,false),
    ('${H(4)}','Di',2000,false), ('${H(5)}','Ed',2000,false), ('${H(6)}','Fay',2200,true);
  insert into moderators (id, name) values ('${M(1)}','Mo'), ('${M(2)}','Nia');
  insert into brand_hosts values ('${brand}','${H(1)}'),('${brand}','${H(2)}'),('${brand}','${H(3)}'),('${brand}','${H(4)}'),('${brand}','${H(6)}');
  insert into brand_moderators values ('${brand}','${M(1)}'),('${brand}','${M(2)}');
  insert into sms_contacts (phone_e164, host_id, opt_in_at) values
    ('${phone(1)}','${H(1)}',now()), ('${phone(2)}','${H(2)}',now()), ('${phone(3)}','${H(3)}',now()),
    ('${phone(4)}','${H(4)}',now()), ('${phone(5)}','${H(5)}',now()), ('${phone(6)}','${H(6)}',now());
  insert into sms_contacts (phone_e164, moderator_id, opt_in_at) values
    ('${phone(7)}','${M(1)}',now()), ('${phone(8)}','${M(2)}',now());
  update scheduler_runtime set quiet_start_hour = 0, quiet_end_hour = 0,
    escalation_phone_e164 = '+13105550199';
`)
const asAdmin = `set role authenticated; set request.jwt.claim.sub = '${admin}'`
const asBot = `reset role; set request.jwt.claim.sub = ''; set role service_role`
const asOwner = `reset role; set request.jwt.claim.sub = ''`
const tick = async () => { await db.exec(asOwner); return val('select public._run_auto_scheduler()') }
const reply = async (sid, from, body) => {
  await db.exec(asBot)
  const r = await val(`select public.sched_handle_sms_reply('${sid}', '${from}', '${body.replace(/'/g, "''")}')`)
  await db.exec(asOwner)
  return r
}
const pending = () => one(`select o.*, (select role from coverage_requests where id=o.request_id) as role
  from coverage_offers o where state='pending' order by sent_at desc limit 1`)

// --- 1. Disabled by default: nothing happens.
await db.exec(asAdmin)
await db.exec(`insert into streams (brand_id, start_time, end_time) values
  ('${brand}', ${at(3, 14)}, ${at(3, 16)}), ('${brand}', ${at(3, 16)}, ${at(3, 18)})`)
eq(await tick(), 0, 'disabled tick does nothing')
eq(await val('select count(*)::int from coverage_requests'), 0, 'no requests while disabled')

// --- 2. Dry run: one grouped request, one dry-run offer, nothing queued for real.
await db.exec(`${asOwner}; update scheduler_runtime set enabled = true`)
await tick()
const req = await one(`select * from coverage_requests`)
eq(req.stream_ids.length, 2, 'two touching blocks become ONE shift request')
eq(req.role, 'host', 'host role requested')
eq(await val(`select count(*)::int from coverage_offers where state='dry_run'`), 1, 'one dry-run offer')
eq(await val(`select count(*)::int from sms_outbox where state='dry_run'`), 1, 'dry-run text logged, not queued')
eq(await val(`select count(*)::int from sms_outbox where state='queued'`), 0, 'nothing queued in dry run')
const body = await val(`select body from sms_outbox limit 1`)
ok(/^Studio: Open host shift, SAMPLE BRAND A \w{3} \d{1,2}\/\d{1,2} 2:00-6:00pm\. Reply YES \d{4}/.test(body), `offer wording: ${body}`)
await tick()
eq(await val(`select count(*)::int from coverage_offers`), 1, 'dry run does not keep offering')

// --- 3. Live: ranking prefers fewest booked minutes that week.
await db.exec(`delete from sms_outbox; delete from coverage_offers; delete from coverage_requests;
  update scheduler_runtime set dry_run = false`)
await db.exec(asAdmin)
// Ana, Ben already have hours that week (on another brand); Cy, Di have none.
await db.exec(`insert into streams (brand_id, host_id, start_time, end_time) values
  ('${brand2}', '${H(1)}', ${at(3, 8)}, ${at(3, 12)}), ('${brand2}', '${H(2)}', ${at(3, 8)}, ${at(3, 10)})`)
// Di is unavailable that day; Ed is not in the pool; Fay self-moderates (still a valid host).
await db.exec(`insert into staff_unavailability (host_id, start_date, end_date)
  values ('${H(4)}', (${at(3, 0)} AT TIME ZONE 'UTC')::date, (${at(3, 0)} AT TIME ZONE 'UTC')::date)`)
await tick()
let o = await pending()
const firstWorker = o.worker_id
ok([H(3), H(6)].includes(firstWorker), 'a zero-hours eligible host is offered first')
ok(![H(4), H(5)].includes(firstWorker), 'unavailable / out-of-pool never offered')
eq(await val(`select count(*)::int from sms_outbox where state='queued'`), 1, 'one real text queued')
eq(await val(`select count(*)::int from coverage_requests where brand_id='${brand2}'`), 0, 'brand with no pools is not managed (no alert spam)')

// --- 4. NO moves to the next candidate; declined person is never re-offered.
eq(await reply('SM1', o.phone_e164, `no ${o.reply_code}`), 'Studio: no problem, thanks for letting us know.', 'decline ack')
await tick()
o = await pending()
ok(o.worker_id !== firstWorker, 'next candidate after NO')

// --- 5. Timeout moves on too.
const second = o.worker_id
await db.exec(`update coverage_offers set expires_at = now() - interval '1 second' where state='pending'`)
await tick()
eq(await val(`select state from coverage_offers where worker_id='${second}'`), 'timeout', 'expired offer timed out')
o = await pending()
ok(![firstWorker, second].includes(o.worker_id), 'third candidate after timeout')

// --- 6. Guard rejection: the candidate gets booked elsewhere before replying YES.
await db.exec(asAdmin)
await db.exec(`insert into streams (brand_id, host_id, start_time, end_time)
  values ('${brand2}', '${o.worker_id}', ${at(3, 15)}, ${at(3, 17)})`)
const r6 = await reply('SM2', o.phone_e164, `YES ${o.reply_code}`)
ok(/could not book/.test(r6), 'double-booking guard rejects bot booking')
eq(await val(`select count(*)::int from streams where brand_id='${brand}' and host_id is not null`), 0, 'no partial booking')
eq(await val(`select state from coverage_offers where id='${o.id}'`), 'stale', 'rejected offer retired')

// --- 7. YES books every block of the shift, stamps pay rate, logs the booking.
await tick()
o = await pending()
ok(o, 'another candidate after rejection')
const rateExpected = await val(`select rate_cents from hosts where id='${o.worker_id}'`)
const r7 = await reply('SM3', o.phone_e164, `yes${o.reply_code}`)
ok(/^Studio: you're booked for SAMPLE BRAND A/.test(r7), `booking confirmation: ${r7}`)
eq(await val(`select count(*)::int from streams where brand_id='${brand}' and host_id='${o.worker_id}'`), 2, 'both blocks booked')
eq(await val(`select min(host_rate_cents) = max(host_rate_cents) and min(host_rate_cents) = ${rateExpected}
  from streams where brand_id='${brand}'`), true, 'host rate frozen at booking (payroll)')
eq(await val(`select count(*)::int from bot_bookings`), 1, 'bot booking logged')
eq(await val(`select status from coverage_requests where id='${o.request_id}'`), 'filled', 'request filled')

// --- 8. Idempotent webhook retries; late YES is refused.
eq(await reply('SM3', o.phone_e164, `yes${o.reply_code}`), r7, 'same provider sid returns same reply')
eq(await val(`select count(*)::int from bot_bookings`), 1, 'retry does not double book')
eq(await reply('SM4', o.phone_e164, `YES ${o.reply_code}`),
  'Studio: that offer has expired or was already filled. Thanks for replying!', 'late YES refused')

// --- 9. Undo clears the role and pay stamp; refill=false parks the shift.
const booking = await val(`select id from bot_bookings limit 1`)
await db.exec(`${asOwner}; set role authenticated; set request.jwt.claim.sub = '${H(1)}'`)
await assert.rejects(db.query(`select public.sched_undo_bot_booking('${booking}', false)`), /permission denied|Admins only/)
checks++
await db.exec(asAdmin)
eq(await val(`select public.sched_undo_bot_booking('${booking}', false)`), 2, 'undo cleared both blocks')
eq(await val(`select count(*)::int from streams where brand_id='${brand}' and (host_id is not null or host_rate_cents is not null)`), 0, 'rate stamp cleared with host')
eq(await val(`select status from coverage_requests where status='parked'`), 'parked', 'no-refill parks the run')
const before = await val(`select count(*)::int from coverage_offers`)
await tick()
eq(await val(`select count(*)::int from coverage_offers`), before, 'parked run is not re-offered')

// --- 10. Admin fills a run manually: request resolves and a live YES is too late.
await db.exec(`${asOwner}; delete from bot_bookings; delete from coverage_offers; delete from coverage_requests`)
await tick()
o = await pending()
await db.exec(asAdmin)
await db.exec(`update streams set host_id='${H(1)}' where brand_id='${brand}'`)
await tick()
eq(await val(`select state from coverage_offers where id='${o.id}'`), 'stale', 'manual fill retires live offer')
ok(/expired or was already filled/.test(await reply('SM5', o.phone_e164, `YES ${o.reply_code}`)), 'YES after manual fill refused')

// --- 11. Moderator runs: needed only when the host is not self-moderating.
eq(await val(`select count(*)::int from coverage_requests where role='moderator' and status='open'`), 1, 'moderator needed for Ana')
await db.exec(asAdmin)
await db.exec(`update streams set host_id='${H(6)}' where brand_id='${brand}'`)
await tick()
eq(await val(`select count(*)::int from coverage_requests where role='moderator' and status='open'`), 0, 'self-moderating host needs no moderator')

// --- 12. Escalation when nobody is left, exactly once.
await db.exec(`${asOwner}; update sms_contacts set opted_out_at = now() where moderator_id is not null`)
await db.exec(asAdmin)
await db.exec(`update streams set host_id='${H(1)}' where brand_id='${brand}'`)
await tick(); await tick()
eq(await val(`select count(*)::int from coverage_requests where role='moderator' and status='escalated'`), 1, 'escalated when pool exhausted')
eq(await val(`select count(*)::int from sms_outbox where kind='escalation'`), 1, 'escalation texted once')

// --- 13. STOP opts out and cancels live offers; HELP / unknown senders.
await db.exec(`${asOwner}; update sms_contacts set opted_out_at = null where moderator_id is not null;
  delete from coverage_offers; delete from coverage_requests`)
await tick()
o = await pending()
eq(await reply('SM6', o.phone_e164, 'Stop texting me please'), null, 'STOP handled (provider confirms)')
ok(await val(`select opted_out_at is not null from sms_contacts where phone_e164='${o.phone_e164}'`), 'opt-out recorded')
eq(await val(`select state from coverage_offers where id='${o.id}'`), 'no', 'live offer withdrawn on STOP')
ok(/reply YES or NO/.test(await reply('SM7', phone(1), 'what?')), 'help reply')
eq(await reply('SM8', '+13105550000', 'YES'), null, 'unknown sender ignored')

// --- 13b. Changing a number keeps the old row (and its STOP) as history.
await db.exec(`${asAdmin}; update sms_contacts set host_id = null where phone_e164 = '${o.phone_e164}'`)
ok(await val(`select opted_out_at is not null from sms_contacts where phone_e164='${o.phone_e164}'`), 'detached number keeps its STOP record')
eq(await reply('SM10', o.phone_e164, 'YES'), 'Studio: that offer has expired or was already filled. Thanks for replying!', 'detached number cannot take shifts')

await db.exec(asAdmin)
await assert.rejects(db.query(`delete from sms_contacts where phone_e164 = '${o.phone_e164}'`), /permission denied/)
checks++
await db.exec(asOwner)

// --- 14. Daily cap withdraws the offer instead of texting.
await db.exec(`${asOwner}; update scheduler_runtime set daily_send_cap = 0; delete from coverage_offers;
  delete from coverage_requests`)
await tick()
eq(await val(`select count(*)::int from coverage_offers`), 0, 'cap reached: no offers created')

// --- 15. Quiet hours hold non-urgent offers.
await db.exec(`update scheduler_runtime set daily_send_cap = 300,
  quiet_start_hour = extract(hour from public._sched_now_pt() AT TIME ZONE 'UTC')::int,
  quiet_end_hour = (extract(hour from public._sched_now_pt() AT TIME ZONE 'UTC')::int + 1) % 24`)
await tick()
eq(await val(`select count(*)::int from coverage_offers`), 0, 'quiet hours: no offers for later shifts')

// --- 15b. The unavailability CHECK still runs for bot bookings (only the admin
// gate was relaxed): absence added after the offer blocks the YES.
await db.exec(`${asOwner}; update scheduler_runtime set quiet_start_hour = 0, quiet_end_hour = 0;
  delete from bot_bookings; delete from coverage_offers; delete from coverage_requests`)
await db.exec(asAdmin)
await db.exec(`update streams set host_id = null where brand_id='${brand}'`)
await tick()
o = await pending()
await db.exec(asAdmin)
await db.exec(`insert into staff_unavailability (${o.role === 'host' ? 'host_id' : 'moderator_id'}, start_date, end_date)
  values ('${o.worker_id}', (${at(3, 0)} AT TIME ZONE 'UTC')::date, (${at(3, 0)} AT TIME ZONE 'UTC')::date)`)
ok(/could not book/.test(await reply('SM9', o.phone_e164, `YES ${o.reply_code}`)), 'unavailability guard still blocks the bot')
eq(await val(`select count(*)::int from streams where brand_id='${brand}' and host_id is not null`), 0, 'nothing booked for an absent worker')
eq(await val(`select outcome from sms_inbound_log where provider_sid='SM9'`), 'booking_rejected:P0001', 'rejection reason logged')

// --- 16. Permissions: only service_role may process replies; the bot mark is not forgeable by callers.
await db.exec(asAdmin)
await assert.rejects(db.query(`select public.sched_handle_sms_reply('x','${phone(1)}','YES')`), /permission denied/)
checks++
await assert.rejects(db.query(`select public._run_auto_scheduler()`), /permission denied/)
checks++
await db.exec(`${asOwner}; set role authenticated; set request.jwt.claim.sub = '${H(1)}'`)
await db.exec(`select set_config('studio.sched_bot_txn', 'forged', false)`)
await assert.rejects(db.query(`update streams set host_id='${H(1)}' where brand_id='${brand}'`), /Only admins/)
checks++

// --- 17. Labels are DST-neutral (PT-naive values are formatted, never converted).
await db.exec(asOwner)
eq(await val(`select public._sched_shift_label('Sample Brand A', '2026-11-01 10:00+00', '2026-11-01 14:00+00')`),
  'SAMPLE BRAND A Sun 11/1 10:00am-2:00pm', 'November DST day label')
eq(await val(`select public._sched_shift_label('Sample Brand A', '2026-03-08 13:00+00', '2026-03-08 17:00+00')`),
  'SAMPLE BRAND A Sun 3/8 1:00-5:00pm', 'March DST day label')

await db.close()
console.log(`Auto-scheduler PostgreSQL integration: ${checks} checks passed.`)
