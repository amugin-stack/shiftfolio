// Every checked-in synthetic regression harness is part of the normal test gate.
// PostgreSQL concurrency tests have a separate mandatory CI gate with an isolated DB.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const postgres = process.argv.includes('--postgres')
// These harnesses exercise archived email/SMS Edge handlers that intentionally
// return 410 in the portfolio. Their live-service assertions are out of scope.
const archivedEdgeHarnesses = new Set([
  'test-security-webhook.mjs',
  'test-shift-reminder-email.mjs',
  'test-sms-edge.mjs',
])
const scripts = readdirSync(new URL('./', import.meta.url))
  .filter(name => /^test-.*\.mjs$/.test(name) && name.endsWith('-postgres.mjs') === postgres && !archivedEdgeHarnesses.has(name))
  .sort()
if (postgres && (!process.env.TEST_DATABASE_URL || scripts.length === 0)) {
  console.error('PostgreSQL tests require TEST_DATABASE_URL and a checked-in concurrency harness.')
  process.exit(1)
}
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env })
  if (result.error) console.error(result.error)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
if (!postgres) {
  console.log(`Excluding archived Edge-handler harnesses: ${[...archivedEdgeHarnesses].join(', ')}`)
  // The two explicitly documented PT DST regression failures must reproduce
  // consistently on developer machines and CI; changing the host zone hid them.
  run(['node_modules/vitest/vitest.mjs', 'run'], { ...process.env, TZ: 'America/Los_Angeles' })
}
for (const name of scripts) run([fileURLToPath(new URL(name, import.meta.url))])
