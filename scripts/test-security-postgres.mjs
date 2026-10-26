// Disposable synthetic database; never accepts a hosted production target.
import { Client } from 'pg'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
const raw = process.env.TEST_DATABASE_URL
if (!raw) throw new Error('TEST_DATABASE_URL required for isolated PostgreSQL tests')
const url = new URL(raw)
if (!['127.0.0.1','localhost','postgres'].includes(url.hostname)
  || (url.hostname === 'postgres' && !process.env.CI)
  || !url.pathname.includes('synthetic') || raw.includes('.supabase.co')) {
  throw new Error('Refusing non-synthetic/non-local database')
}
const control = new Client({ connectionString: raw })
await control.connect()
const database = `security_test_${process.pid}_${randomBytes(6).toString('hex')}`
let created = false
try {
  await control.query(`CREATE DATABASE ${database}`)
  created = true
  const target = new URL(raw)
  target.pathname = `/${database}`
  const result = await promisify(execFile)(process.execPath,
    [fileURLToPath(new URL('./test-security-sql.mjs', import.meta.url))],
    { env: { ...process.env, SECURITY_TEST_DATABASE_URL: target.href }, timeout: 120000 })
  process.stdout.write(result.stdout)
  process.stderr.write(result.stderr)
} finally {
  try {
    if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`)
  } finally { await control.end() }
}
