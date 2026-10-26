// Exercise the retained Edge transports with synthetic requests only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')
let checks = 0
for (const name of ['resend-webhook', 'send-notification-email', 'sms-inbound', 'sms-send']) {
  const source = readFileSync(new URL(`../supabase/functions/${name}/index.ts`, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  let handler
  const Deno = { env: { get: () => undefined }, serve: callback => { handler = callback } }
  new Function('require', 'exports', 'Deno', compiled)(() => ({}), {}, Deno)
  assert.equal(typeof handler, 'function', `${name}: Deno handler registered`)
  for (const method of ['GET', 'POST']) {
    const response = await handler(new Request('https://synthetic.invalid/', { method }))
    assert.equal(response.status, 410, `${name}: ${method} is disabled`)
    checks++
  }
}
console.log(`${checks} archived Edge transport boundary checks passed`)
