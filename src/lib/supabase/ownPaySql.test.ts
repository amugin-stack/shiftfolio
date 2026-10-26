import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { computePrepBlocks, prepBlockCents, setupBonusApplies } from '../prepTime'
import { findSetupBonusStreamIds, setupBonusCents } from '../setupBonus'
import { computeHostShiftPayoutCents } from '../payout'
import { buildSessionsByHost } from '../gmv'

type Database = {
  exec(sql: string): Promise<unknown>
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>
  close(): Promise<unknown>
}
const target = process.env.PERFORMANCE_TEST_DATABASE_URL
let db: Database
if (target) {
  const url = new URL(target)
  if ((!['127.0.0.1', 'localhost'].includes(url.hostname) && !(url.hostname === 'postgres' && process.env.CI)) || !/^\/performance_(test|synthetic_\d+)$/.test(url.pathname)) throw new Error('Refusing non-local synthetic database')
  const { Client } = createRequire(import.meta.url)('pg') as { Client: new (options: { connectionString: string }) => Database & { connect(): Promise<void>; end(): Promise<void> } }
  const client = new Client({ connectionString: target })
  await client.connect()
  db = { exec: sql => client.query(sql), query: (sql, params) => client.query(sql, params), close: () => client.end() }
} else db = new PGlite()
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const stream = (n: number, start: string, end: string, brand = 90, mod = 2, frozen: number | null = null, gmv: number | null = null) => ({
  id: id(n), brand_id: id(brand), host_id: id(1), moderator_id: mod ? id(mod) : null,
  start_time: `${start}Z`, end_time: `${end}Z`, host_rate_cents: frozen, gmv_cents: gmv,
})
const rows = [
  stream(101, '2026-03-08T01:00:00', '2026-03-08T04:00:00', 90, 2, 1234),
  stream(102, '2025-11-02T01:00:00', '2025-11-02T03:00:00', 90, 2, 2345),
  stream(103, '2026-07-01T08:00:00', '2026-07-01T09:00:00', 90, 3), // other mod wins setup
  stream(104, '2026-07-01T10:00:00', '2026-07-01T11:00:00'),
  stream(105, '2026-07-23T10:00:00', '2026-07-23T11:00:00', 90, 2, null, 40000),
  stream(106, '2026-07-23T11:00:00', '2026-07-23T12:00:00'),
  stream(107, '2026-08-24T10:00:00', '2026-08-24T11:00:00', 90, 2, 0),
  stream(108, '2026-08-24T11:30:00', '2026-08-24T12:30:00', 91), // cross-brand prep suppressed
  stream(109, '2099-01-01T10:00:00', '2099-01-01T11:00:00'),
]
beforeAll(async () => {
  await db.exec(`DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$; DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('test.uid',true),'')::uuid$$;
 CREATE TABLE hosts(id uuid PRIMARY KEY,user_id uuid,rate_cents int,is_active boolean DEFAULT true);
 CREATE TABLE moderators(LIKE hosts INCLUDING ALL);
 ALTER TABLE hosts ADD COLUMN self_moderating boolean DEFAULT false;
 CREATE TABLE profiles(id uuid PRIMARY KEY,full_name text);
 CREATE TABLE brands(id uuid PRIMARY KEY,name text);
 CREATE TABLE streams(id uuid PRIMARY KEY,brand_id uuid,host_id uuid,moderator_id uuid,start_time timestamptz,end_time timestamptz,host_rate_cents int,gmv_cents int);
 ALTER TABLE streams ADD COLUMN gmv_updated_by uuid,ADD COLUMN gmv_updated_at timestamptz;
 CREATE TABLE extra_pay_slots(id uuid PRIMARY KEY,brand_id uuid,host_id uuid,moderator_id uuid,start_time timestamptz,end_time timestamptz,rate_cents int,status text,kind text);
 CREATE FUNCTION _is_deactivated_worker() RETURNS boolean LANGUAGE sql AS $$SELECT current_setting('test.inactive',true)='true'$$;
 GRANT USAGE ON SCHEMA public,auth TO authenticated,anon; GRANT SELECT ON streams TO authenticated;
 INSERT INTO hosts(id,user_id,rate_cents,is_active) VALUES('${id(1)}','${id(10)}',3333,true);
 INSERT INTO moderators VALUES('${id(2)}','${id(10)}',2223,true),('${id(3)}','${id(11)}',9999,true);
 INSERT INTO brands VALUES('${id(90)}','Sample'),('${id(91)}','Other');
 SET test.uid='${id(10)}';SET test.inactive='false';`)
  for (const r of rows) await db.query('INSERT INTO streams(id,brand_id,host_id,moderator_id,start_time,end_time,host_rate_cents,gmv_cents) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', Object.values(r))
  await db.exec(`INSERT INTO extra_pay_slots VALUES('${id(200)}',null,'${id(1)}',null,'2026-08-01T10:00Z','2026-08-01T11:30Z',1777,'completed','training');`)
  await db.exec(readFileSync('supabase/migrations/048_setup_bonus_rpc.sql', 'utf8'))
  await db.exec(readFileSync('supabase/migrations/087_bounded_reads_and_own_pay.sql', 'utf8'))
}, 30000)
afterAll(async () => { await db.close() })
describe('own pay SQL mirrors existing payroll math', () => {
  it('ties out frozen/current/zero host rates, both prep cutoffs, suppression, DST and extra work', async () => {
    const now = Date.now()
    const mine = rows.filter(r => r.moderator_id === id(2))
    const bonuses = findSetupBonusStreamIds(rows)
    const prep = computePrepBlocks(mine)
    const host = rows.filter(r => Date.parse(r.end_time) <= now).reduce((sum, r) => sum + computeHostShiftPayoutCents(r.start_time, r.end_time, r.host_rate_cents, 3333).totalCents, 0)
    const mod = mine.filter(r => Date.parse(r.end_time) <= now).reduce((sum, r) => sum + Math.round(2223 * (Date.parse(r.end_time) - Date.parse(r.start_time)) / 3600000) + (bonuses.has(r.id) && setupBonusApplies(r.start_time) ? setupBonusCents(2223) : 0), 0)
      + prep.filter(p => Date.parse(p.sessionEndISO) <= now).reduce((sum, p) => sum + prepBlockCents(2223, p.durationMinutes), 0)
    const got = await db.query<{ cents: string }>('SELECT sum(earned_cents)::text cents FROM get_my_pay_totals()')
    expect(Number(got.rows[0].cents)).toBe(host + mod + Math.round(1777 * 1.5))
  })
  it('preserves GMV session fallback and hours', async () => {
    const sessions = buildSessionsByHost(rows).filter(s => s.gmvCents != null)
    const expected = Math.round(sessions.reduce((s, r) => s + r.gmvCents!, 0) / sessions.reduce((s, r) => s + r.hours, 0))
    const got = await db.query<{ all_time_per_hour_cents: string }>('SELECT * FROM get_my_gmv_summary()')
    expect(Number(got.rows[0].all_time_per_hour_cents)).toBe(expected)
  })
  it('combines dual-role work once per cursor id and excludes future rows', async () => {
    const first = await db.query<{ id: string; start_time: Date; role: string }>('SELECT * FROM get_my_completed_pay_page(null,null,2)')
    expect(first.rows).toHaveLength(2)
    expect(first.rows[0].role).toBe('host + moderator')
    const second = await db.query<{ id: string }>('SELECT * FROM get_my_completed_pay_page($1,$2,100)', [first.rows[1].start_time, first.rows[1].id])
    expect(second.rows.some(r => first.rows.some(a => a.id === r.id))).toBe(false)
    expect([...first.rows, ...second.rows].some(r => r.id === id(109))).toBe(false)
    expect([...first.rows, ...second.rows]).toHaveLength(9)
  })
  it('allows inactive own history, denies future aggregates and private accessor', async () => {
    await db.exec("SET test.inactive='true'; SET ROLE authenticated")
    expect((await db.query('SELECT * FROM get_my_completed_pay_page()')).rows.length).toBeGreaterThan(0)
    await expect(db.query('SELECT * FROM get_my_pay_totals()')).rejects.toThrow()
    await expect(db.query('SELECT * FROM _my_pay_rows()')).rejects.toThrow()
    await db.exec("RESET ROLE; SET test.inactive='false'")
  })
  it('never returns another user’s history', async () => {
    await db.exec(`SET test.uid='${id(12)}'`)
    expect((await db.query('SELECT * FROM get_my_completed_pay_page()')).rows).toEqual([])
    await db.exec(`SET test.uid='${id(10)}'`)
  })
  it('keeps a touching session intact across the visible boundary', async () => {
    const got = await db.query('SELECT * FROM get_stream_window_ids($1,$2,$3)', ['2026-07-23T11:30Z', '2026-07-24T00:00Z', id(90)])
    expect(got.rows.map(r => Object.values(r)[0]).sort()).toEqual([id(105), id(106)])
  })
  it('keeps the visible payload constant when 50,000 old rows are added', async () => {
    const before = await db.query('SELECT * FROM get_stream_window_ids($1,$2,$3)', ['2026-07-23T11:30Z', '2026-07-24T00:00Z', id(90)])
    const totalBefore = Number((await db.query<{ cents: string }>('SELECT sum(earned_cents)::text cents FROM get_my_pay_totals()')).rows[0].cents)
    await db.exec(`INSERT INTO streams(id,brand_id,host_id,start_time,end_time,host_rate_cents)
      SELECT ('10000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,'${id(90)}','${id(1)}',
      '1800-01-01'::timestamptz+n*interval '1 day','1800-01-01'::timestamptz+n*interval '1 day'+interval '1 hour',1000 FROM generate_series(1,50000)n;`)
    const after = await db.query('SELECT * FROM get_stream_window_ids($1,$2,$3)', ['2026-07-23T11:30Z', '2026-07-24T00:00Z', id(90)])
    expect(after.rows).toEqual(before.rows)
    expect(Number((await db.query<{ cents: string }>('SELECT sum(earned_cents)::text cents FROM get_my_pay_totals()')).rows[0].cents)).toBe(totalBefore + 50_000 * 1000)
    expect((await db.query('SELECT * FROM get_my_completed_pay_page(null,null,50)')).rows).toHaveLength(50)
  }, 30000)
  it('bounds pay/GMV/setup inside each accessor and preserves authorization', async () => {
    const selected = [id(101), id(104), id(109)]
    expect((await db.query('SELECT * FROM get_my_window_pay($1)', [selected])).rows).toHaveLength(3)
    expect((await db.query('SELECT * FROM get_my_window_gmv($1)', [selected])).rows).toHaveLength(3)
    expect((await db.query('SELECT * FROM get_my_window_setup_ids($1)', [selected])).rows.map(r => Object.values(r)[0])).toEqual([id(101), id(109)])
    for (const name of ['get_my_window_pay', 'get_my_window_gmv', 'get_my_window_setup_ids']) {
      const definition = String((await db.query('SELECT pg_get_functiondef(($1)::regprocedure) source', [name + '(uuid[])'])).rows[0].source)
      expect(definition).toContain('s.id=ANY(p_ids)')
      expect(definition).not.toMatch(/FROM public.get_my_(stream_pay|session_gmv|setup_bonus_stream_ids)/)
      await expect(db.query(`SELECT * FROM ${name}($1)`, [Array(1001).fill(id(101))])).rejects.toThrow()
    }
    await db.exec(`SET test.uid='${id(12)}'`)
    for (const name of ['get_my_window_pay', 'get_my_window_gmv', 'get_my_window_setup_ids']) expect((await db.query(`SELECT * FROM ${name}($1)`, [selected])).rows).toEqual([])
    await db.exec(`SET test.uid='${id(10)}';SET test.inactive='true';UPDATE moderators SET is_active=false WHERE id='${id(2)}'`)
    expect((await db.query('SELECT * FROM get_my_window_pay($1)', [selected])).rows).toHaveLength(2)
    expect((await db.query('SELECT * FROM get_my_window_gmv($1)', [selected])).rows).toHaveLength(0)
    expect((await db.query('SELECT * FROM get_my_window_setup_ids($1)', [selected])).rows).toHaveLength(1)
    await db.exec(`SET test.inactive='false';UPDATE moderators SET is_active=true WHERE id='${id(2)}'`)
  })
  it('avoids materializing 50,000 historical rows for a one-id pay request', async () => {
    const security = readFileSync('supabase/migrations/082_deactivated_worker_access.sql', 'utf8')
    const start = security.indexOf('CREATE OR REPLACE FUNCTION public.get_my_stream_pay(')
    const end = security.indexOf('CREATE OR REPLACE FUNCTION public.get_my_pay_context()', start)
    await db.exec(security.slice(start, end))
    const oldPlan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM get_my_stream_pay() WHERE stream_id='${id(101)}'`)).rows[0]['QUERY PLAN'] as { Plan: Record<string, number> }[]
    const newPlan = (await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM get_my_window_pay(ARRAY['${id(101)}'::uuid])`)).rows[0]['QUERY PLAN'] as { Plan: Record<string, number> }[]
    expect(oldPlan[0].Plan['Rows Removed by Filter']).toBeGreaterThanOrEqual(50000)
    expect(newPlan[0].Plan['Actual Rows']).toBe(1)
    expect(newPlan[0].Plan['Rows Removed by Filter'] ?? 0).toBe(0)
    if (target) {
      expect(newPlan[0].Plan['Shared Hit Blocks']).toBeLessThan(oldPlan[0].Plan['Shared Hit Blocks'])
      console.log('Synthetic50k pay accessor benchmark', JSON.stringify({ oldMs: oldPlan[0].Plan['Actual Total Time'], newMs: newPlan[0].Plan['Actual Total Time'], oldBuffers: oldPlan[0].Plan['Shared Hit Blocks'], newBuffers: newPlan[0].Plan['Shared Hit Blocks'] }))
    }
  })
  it('returns stable keys for every extra-pay kind, including branded work', async () => {
    for (const [i, kind] of ['setup', 'training', 'office_hours'].entries()) {
      await db.query(`INSERT INTO extra_pay_slots VALUES($1,null,$2,null,'2026-01-01T10:00Z','2026-01-01T11:00Z',2000,'completed',$3),($4,$5,$2,null,'2026-01-02T10:00Z','2026-01-02T11:00Z',2000,'completed',$3)`, [id(300+i), id(1), kind, id(400+i), id(91)])
    }
    const got = (await db.query<{ category_key: string; earned_cents: string }>('SELECT * FROM get_my_pay_totals()')).rows
    for (const kind of ['setup', 'training', 'office_hours']) expect(Number(got.find(r => r.category_key === `extra:${kind}`)?.earned_cents)).toBeGreaterThanOrEqual(2000)
    expect(Number(got.find(r => r.category_key === id(91))?.earned_cents)).toBeGreaterThanOrEqual(6000)
  })
  it('validates bounds and cursor limits instead of serving partial money', async () => {
    await expect(db.query("SELECT * FROM get_stream_window_ids('2020-01-01','2099-01-01',$1)", [id(90)])).rejects.toThrow()
    await expect(db.query('SELECT * FROM get_my_completed_pay_page(null,null,1000)')).rejects.toThrow()
  })
})
