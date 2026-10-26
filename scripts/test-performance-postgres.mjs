// Independent payroll parity and bounded-history regressions on real PostgreSQL.
// A fresh, local synthetic database is created and removed on every run.
import pg from 'pg'
import { spawn } from 'node:child_process'
const raw = process.env.TEST_DATABASE_URL
if (!raw) throw new Error('TEST_DATABASE_URL is required')
const target = new URL(raw)
if ((!['127.0.0.1', 'localhost'].includes(target.hostname) && !(target.hostname === 'postgres' && process.env.CI)) || !target.pathname.includes('synthetic') || raw.includes('.supabase.co')) throw new Error('Refusing non-local/non-synthetic database')
const control = new pg.Client({ connectionString: raw })
await control.connect()
const database = `performance_synthetic_${process.pid}`
await control.query(`CREATE DATABASE ${database}`)
try {
  target.pathname = `/${database}`
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'src/lib/supabase/ownPaySql.test.ts', '--silent=false'], {
    stdio: 'inherit', env: { ...process.env, PERFORMANCE_TEST_DATABASE_URL: target.href },
  })
  const result = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  if (result !== 0) throw new Error(`PostgreSQL performance/payroll regression failed (${result})`)
} finally {
  await control.query(`DROP DATABASE ${database}`)
  await control.end()
}
