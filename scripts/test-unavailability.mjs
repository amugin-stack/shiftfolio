// Local-only PostgreSQL integration test. No credentials or live database used.
// Install @electric-sql/pglite in a scratch directory, then run:
// node scripts/test-unavailability.mjs /absolute/path/to/node_modules/@electric-sql/pglite/dist/index.js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const { PGlite } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '@electric-sql/pglite')
const db = new PGlite()
const host = '00000000-0000-0000-0000-000000000001'
const mod = '00000000-0000-0000-0000-000000000002'
const admin = '00000000-0000-0000-0000-000000000003'
let checks = 0
async function rejects(sql, pattern) {
  await assert.rejects(db.exec(sql), pattern)
  checks++
}
async function count(table, expected) {
  assert.equal((await db.query(`select count(*)::int as n from ${table}`)).rows[0].n, expected)
  checks++
}
function absence(role, start, end = start) {
  return `insert into staff_unavailability (${role}_id,start_date,end_date) values ('${role === 'host' ? host : mod}','${start}','${end}')`
}
function shift(role, start, end, table = 'streams') {
  return `insert into ${table} (${role}_id,start_time,end_time) values ('${role === 'host' ? host : mod}','${start}Z','${end}Z')`
}
await db.exec(`
  create role authenticated; create role anon;
  create schema auth;
  create function auth.uid() returns uuid language sql as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function public.is_admin() returns boolean language sql as $$
    select auth.uid() = '${admin}'::uuid
  $$;
  grant usage on schema auth to authenticated, anon;
  create table hosts (id uuid primary key, user_id uuid);
  create table moderators (id uuid primary key, user_id uuid);
  insert into hosts(id) values ('${host}'); insert into moderators(id) values ('${mod}');
  create table streams (id uuid primary key default gen_random_uuid(), host_id uuid, moderator_id uuid,
    start_time timestamptz not null, end_time timestamptz not null, notes text);
  create table extra_pay_slots (like streams including all, status text default 'scheduled');
  grant select,insert,update,delete on streams, extra_pay_slots to authenticated;
  set request.jwt.claim.sub = '${admin}';
`)
await db.exec(await readFile(new URL('../supabase/migrations/078_staff_unavailability.sql', import.meta.url), 'utf8'))
await db.exec('set role authenticated')
// Inclusive dates stay the same through both DST transitions and any DB timezone.
for (const zone of ['UTC', 'America/Los_Angeles', 'Europe/Madrid']) {
  await db.exec(`set timezone = '${zone}'`)
  for (const day of ['2026-03-08', '2026-11-01']) {
    const previous = day === '2026-03-08' ? '2026-03-07' : '2026-10-31'
    const next = day === '2026-03-08' ? '2026-03-09' : '2026-11-02'
    for (const role of ['host', 'moderator']) {
      await db.exec(absence(role, day))
      await rejects(shift(role, `${day}T12:00:00`, `${day}T13:00:00`), /unavailable/)
      await rejects(shift(role, `${previous}T23:00:00`, `${day}T01:00:00`), /unavailable/)
      await db.exec(shift(role, `${previous}T23:00:00`, `${day}T00:00:00`))
      if (role === 'moderator' && day === '2026-11-01') {
        await rejects(shift(role, `${next}T00:00:00`, `${next}T01:00:00`), /unavailable/)
        await db.exec(shift(role, `${next}T01:00:00`, `${next}T02:00:00`))
      } else {
        await db.exec(shift(role, `${next}T00:00:00`, `${next}T01:00:00`))
      }
      await count('streams', 2)
      await db.exec('delete from streams; delete from staff_unavailability')
    }
  }
}
await db.exec(absence('host', '2026-09-22', '2026-09-24'))
await db.exec(absence('moderator', '2026-09-22', '2026-09-24'))
for (const role of ['host', 'moderator']) {
  for (const table of ['streams', 'extra_pay_slots']) {
    await rejects(shift(role, '2026-09-24T23:00:00', '2026-09-25T01:00:00', table), /unavailable/)
    await db.exec(shift(role, '2026-09-25T12:00:00', '2026-09-25T13:00:00', table))
    await rejects(dbUpdate(table), /unavailable/)
    await db.exec(`delete from ${table}`)
  }
}
function dbUpdate(table) {
  return `update ${table} set start_time='2026-09-23T12:00Z', end_time='2026-09-23T13:00Z'`
}
// An unassigned slot is allowed; assigning either unavailable person is not.
await db.exec("insert into streams(start_time,end_time) values ('2026-09-23T12:00Z','2026-09-23T13:00Z')")
await rejects(`update streams set host_id='${host}'`, /Host is unavailable/)
await rejects(`update streams set moderator_id='${mod}'`, /Moderator is unavailable/)
await db.exec("update streams set notes='Unrelated edit'")
await db.exec("insert into streams(start_time,end_time) values ('2026-09-25T12:00Z','2026-09-25T13:00Z')")
await rejects(`update streams set host_id='${host}'`, /unavailable/)
await count('streams where host_id is not null', 0)
await db.exec('delete from streams')
// A copied week / bulk insert is all-or-nothing, even if its first row is valid.
await rejects(`insert into streams(host_id,start_time,end_time) values
  ('${host}','2026-09-25T12:00Z','2026-09-25T13:00Z'),
  ('${host}','2026-09-23T12:00Z','2026-09-23T13:00Z')`, /unavailable/)
await count('streams', 0)
// Restoring canceled work must not bypass the guard.
await db.exec(`insert into extra_pay_slots(moderator_id,start_time,end_time,status)
  values ('${mod}','2026-09-23T12:00Z','2026-09-23T13:00Z','canceled')`)
await rejects("update extra_pay_slots set status='scheduled'", /unavailable/)
await db.exec('delete from staff_unavailability; delete from extra_pay_slots')
// Reverse direction: recording absence cannot silently invalidate existing work.
for (const role of ['host', 'moderator']) {
  for (const table of ['streams', 'extra_pay_slots']) {
    await db.exec(shift(role, '2026-09-23T12:00:00', '2026-09-23T13:00:00', table))
    await rejects(absence(role, '2026-09-22', '2026-09-24'), /already has scheduled work/)
    await db.exec(`delete from ${table}`)
  }
}
await rejects(absence('host', '2026-09-24', '2026-09-22'), /check constraint/)
await rejects(absence('host', 'infinity'), /check constraint|timestamp out of range/)
await rejects(`insert into staff_unavailability(host_id,moderator_id,start_date,end_date)
  values ('${host}','${mod}','2026-09-23','2026-09-23')`, /check constraint/)
await db.exec(absence('host', '2026-09-23'))
await count('staff_unavailability', 1)
// Non-admin cannot see, create or remove absences; anonymous gets no access.
await db.exec(`set request.jwt.claim.sub='${host}'`)
await count('staff_unavailability', 0)
await rejects(absence('host', '2026-09-24'), /Only admins|row-level security/)
await db.exec('delete from staff_unavailability')
await db.exec(`set request.jwt.claim.sub='${admin}'`)
await count('staff_unavailability', 1)
await db.exec('reset role; set role anon')
await rejects('select * from staff_unavailability', /permission denied/)
await db.exec('reset role; set role authenticated')
await rejects('select staff_unavailability_guard()', /permission denied/)
// Removing the absence makes the date bookable again.
await db.exec('delete from staff_unavailability')
await db.exec(shift('host', '2026-09-23T12:00:00', '2026-09-23T13:00:00'))
await count('streams', 1)
// Linked accounts must respect one person's absence in both roster roles.
await db.exec(`delete from streams; reset role;
  update hosts set user_id='${host}'; update moderators set user_id='${host}';
  set role authenticated`)
for (const role of ['host', 'moderator']) {
  const other = role === 'host' ? 'moderator' : 'host'
  await db.exec(absence(role, '2026-10-10', '2026-10-12'))
  await rejects(absence(other, '2026-10-11'), /already has unavailable dates/)
  await rejects(absence(role, '2026-10-12', '2026-10-13'), /already has unavailable dates/)
  for (const table of ['streams', 'extra_pay_slots']) {
    await rejects(shift(other, '2026-10-11T12:00:00', '2026-10-11T13:00:00', table), /unavailable/)
  }
  await db.exec('delete from staff_unavailability')
  for (const table of ['streams', 'extra_pay_slots']) {
    await db.exec(shift(other, '2026-10-11T12:00:00', '2026-10-11T13:00:00', table))
    await rejects(absence(role, '2026-10-11'), /already has scheduled work/)
    await db.exec(`delete from ${table}`)
  }
}
// Moderator prep across midnight is protected in both directions, including
// an absence recorded through the person's linked host role.
for (const role of ['host', 'moderator']) {
  await db.exec(absence(role, '2026-10-15'))
  await rejects(shift('moderator', '2026-10-16T00:30:00', '2026-10-16T02:00:00'), /unavailable/)
  await db.exec(shift('moderator', '2026-10-16T01:00:00', '2026-10-16T02:00:00'))
  await db.exec('delete from streams; delete from staff_unavailability')
  await db.exec(shift('moderator', '2026-10-16T00:30:00', '2026-10-16T02:00:00'))
  await rejects(absence(role, '2026-10-15'), /already has scheduled work/)
  await db.exec('delete from streams')
}
// A different host does not inherit the moderator's prep hour.
await db.exec(`reset role; update hosts set user_id = null; update moderators set user_id = null; set role authenticated`)
await db.exec(absence('host', '2026-10-15'))
await db.exec(`insert into streams(host_id,moderator_id,start_time,end_time)
  values ('${host}','${mod}','2026-10-16T00:30Z','2026-10-16T02:00Z')`)
await db.exec('delete from streams; delete from staff_unavailability')
checks++
// BEFORE triggers must not reveal protected dates ahead of RLS WITH CHECK.
await db.exec(absence('host', '2026-11-01'))
await db.exec(`reset role;
  alter table streams enable row level security;
  create policy admin_only on streams to authenticated using (is_admin()) with check (is_admin());
  set role authenticated; set request.jwt.claim.sub='${host}'`)
await rejects(shift('host', '2026-11-01T12:00:00', '2026-11-01T13:00:00'), /Only admins/)
await rejects(shift('host', '2026-11-02T12:00:00', '2026-11-02T13:00:00'), /Only admins/)
await db.exec(`set request.jwt.claim.sub='${admin}'; delete from staff_unavailability`)
// Confirm the lock branches: regular bookings share; absence writes exclude.
await db.exec('begin')
await db.exec(shift('host', '2026-11-02T12:00:00', '2026-11-02T13:00:00'))
assert.equal((await db.query("select mode from pg_locks where locktype='advisory' and granted")).rows[0].mode, 'ShareLock')
checks++
await db.exec('rollback; begin')
await db.exec(absence('host', '2026-11-02'))
assert.equal((await db.query("select mode from pg_locks where locktype='advisory' and granted")).rows[0].mode, 'ExclusiveLock')
checks++
await db.exec('rollback')
await db.close()
console.log(`Unavailability PostgreSQL integration: ${checks} checks passed.`)
