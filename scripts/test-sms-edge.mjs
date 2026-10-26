// Synthetic regression suite for the sms-send / sms-inbound Edge Functions and
// their shared _shared/sms.ts module (migration 090 support code). Transpiles
// the real .ts sources with `typescript` and runs them in a sandboxed
// Function scope with stubbed Deno/console/fetch, modeled on
// test-security-webhook.mjs. No network calls, no real secrets.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { webcrypto, createHmac } from 'node:crypto'

const require = createRequire(import.meta.url)
const ts = require('typescript')

function transpile(relPath) {
  const source = readFileSync(new URL(relPath, import.meta.url), 'utf8')
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
}

const smsSharedCompiled = transpile('../supabase/functions/_shared/sms.ts')
const sendCompiled = transpile('../supabase/functions/sms-send/index.ts')
const inboundCompiled = transpile('../supabase/functions/sms-inbound/index.ts')

// Captured console output across every scenario; asserted PII-free at the end.
const consoleLog = []
const consoleStub = {
  log: (...a) => consoleLog.push(a.map(String).join(' ')),
  error: (...a) => consoleLog.push(a.map(String).join(' ')),
  warn: (...a) => consoleLog.push(a.map(String).join(' ')),
}

// Single mutable env store shared by the compiled shared module AND every
// handler, so setting env before a call is visible no matter which module
// reads Deno.env at request-handling time (the shared module is compiled
// once, up front, but reads envStore lazily on every call).
const envStore = {}
function setEnv(env) {
  for (const k of Object.keys(envStore)) delete envStore[k]
  Object.assign(envStore, env)
}
const sharedDeno = { env: { get: (k) => envStore[k] } }

// Compile the shared module once; every handler's fake `require` resolves
// '../_shared/sms.ts' to this same instantiated module.
function loadSharedSms() {
  const mod = { exports: {} }
  const fn = new Function('require', 'module', 'exports', 'Deno', 'crypto', 'console', smsSharedCompiled)
  fn(fakeRequire, mod, mod.exports, sharedDeno, webcrypto, consoleStub)
  return mod.exports
}
const sharedSms = loadSharedSms()

function fakeRequire(name) {
  if (name === '../_shared/sms.ts') return sharedSms
  if (name.startsWith('jsr:')) return {}
  if (name === 'npm:@supabase/supabase-js@2') return { createClient: currentSupabaseFactory() }
  throw new Error('unexpected require: ' + name)
}

// Per-test supabase stub, swapped in via a mutable holder so both handler
// modules (compiled once each below) pick up whichever stub is active.
let activeSupabaseFactory = () => ({ rpc: async () => ({ data: null, error: { message: 'unconfigured' } }) })
function currentSupabaseFactory() {
  return (...args) => activeSupabaseFactory(...args)
}
function withSupabase(rpcHandlers, fn) {
  activeSupabaseFactory = () => ({
    rpc: async (name, params) => {
      const h = rpcHandlers[name]
      if (!h) throw new Error('unhandled rpc ' + name)
      return h(params)
    },
  })
  return fn()
}

function buildHandler(compiled, env) {
  setEnv(env)
  let handler
  const Deno = { env: sharedDeno.env, serve: (fn) => { handler = fn } }
  const mod = { exports: {} }
  const fn = new Function('require', 'module', 'exports', 'Deno', 'crypto', 'console', compiled)
  fn(fakeRequire, mod, mod.exports, Deno, webcrypto, consoleStub)
  return handler
}

let checks = 0
const ok = (cond, msg) => { assert.ok(cond, msg); checks++ }
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++ }

// ---------------------------------------------------------------------------
// sms-inbound
// ---------------------------------------------------------------------------
const AUTH_TOKEN = 'synthetic-auth-token-0001'
const PUBLIC_URL = 'https://synthetic.invalid/functions/v1/sms-inbound'

function twilioSignature(authToken, url, params) {
  let data = url
  for (const key of Object.keys(params).sort()) data += key + params[key]
  return createHmac('sha1', authToken).update(data).digest('base64')
}

function inboundRequest(params, { url = PUBLIC_URL, signature, method = 'POST' } = {}) {
  const sig = signature !== undefined ? signature : twilioSignature(AUTH_TOKEN, url, params)
  const body = new URLSearchParams(params).toString()
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (sig !== null) headers['X-Twilio-Signature'] = sig
  return new Request('https://synthetic.invalid/functions/v1/sms-inbound', { method, body, headers })
}

const inboundEnv = { TWILIO_AUTH_TOKEN: AUTH_TOKEN, SMS_INBOUND_PUBLIC_URL: PUBLIC_URL }
const phone = '+13105550100'
const validParams = { MessageSid: 'SM100', From: phone, Body: 'YES 1234' }

// Valid signature, ordinary reply -> 200, TwiML with that reply.
await withSupabase(
  { sched_handle_sms_reply: async (p) => {
      eq(p.p_provider_sid, 'SM100', 'RPC called with MessageSid')
      eq(p.p_from, phone, 'RPC called with From')
      return { data: "Studio: you're booked. Thank you!", error: null }
    } },
  async () => {
    const handler = buildHandler(inboundCompiled, inboundEnv)
    const res = await handler(inboundRequest(validParams))
    eq(res.status, 200, 'valid signature accepted')
    const text = await res.text()
    ok(text.includes('<Message>Studio: you&apos;re booked. Thank you!</Message>'), `twiml body: ${text}`)
  },
)

// TwiML escaping of <, &, >, ", '.
await withSupabase(
  { sched_handle_sms_reply: async () => ({ data: `<a>&"'</a> tag`, error: null }) },
  async () => {
    const handler = buildHandler(inboundCompiled, inboundEnv)
    const res = await handler(inboundRequest({ ...validParams, MessageSid: 'SM101' }))
    const text = await res.text()
    ok(text.includes('&lt;a&gt;&amp;&quot;&apos;&lt;/a&gt; tag'), `escaped twiml: ${text}`)
    ok(!text.includes('<a>'), 'raw tag not present unescaped')
  },
)

// Null reply -> empty self-closing Response.
await withSupabase(
  { sched_handle_sms_reply: async () => ({ data: null, error: null }) },
  async () => {
    const handler = buildHandler(inboundCompiled, inboundEnv)
    const res = await handler(inboundRequest({ ...validParams, MessageSid: 'SM102' }))
    eq(res.status, 200, 'null reply still 200')
    eq(await res.text(), '<Response/>', 'null reply -> empty TwiML')
  },
)

// Tampered param after signing -> signature no longer matches -> 403.
{
  const handler = buildHandler(inboundCompiled, inboundEnv)
  const sig = twilioSignature(AUTH_TOKEN, PUBLIC_URL, validParams)
  const res = await handler(inboundRequest({ ...validParams, Body: 'NO 1234' }, { signature: sig }))
  eq(res.status, 403, 'tampered param rejected')
}

// Tampered URL (signed for a different URL than SMS_INBOUND_PUBLIC_URL) -> 403.
{
  const handler = buildHandler(inboundCompiled, inboundEnv)
  const sig = twilioSignature(AUTH_TOKEN, 'https://attacker.invalid/hook', validParams)
  const res = await handler(inboundRequest(validParams, { signature: sig }))
  eq(res.status, 403, 'tampered url rejected')
}

// Missing signature header -> 403.
{
  const handler = buildHandler(inboundCompiled, inboundEnv)
  const res = await handler(inboundRequest(validParams, { signature: null }))
  eq(res.status, 403, 'missing signature header rejected')
}

// Missing required field (no MessageSid) with an otherwise-valid signature -> 400.
{
  const handler = buildHandler(inboundCompiled, inboundEnv)
  const { MessageSid, ...rest } = validParams
  const res = await handler(inboundRequest(rest))
  eq(res.status, 400, 'missing MessageSid rejected')
}

// RPC error -> 500, empty body (Twilio retries; RPC is idempotent by MessageSid).
await withSupabase(
  { sched_handle_sms_reply: async () => ({ data: null, error: { message: 'boom' } }) },
  async () => {
    const handler = buildHandler(inboundCompiled, inboundEnv)
    const res = await handler(inboundRequest({ ...validParams, MessageSid: 'SM103' }))
    eq(res.status, 500, 'rpc error -> 500 for Twilio retry')
  },
)

// ---------------------------------------------------------------------------
// sms-send
// ---------------------------------------------------------------------------
const SEND_SECRET = 'synthetic-sms-webhook-secret'
const sendEnvBase = {
  SMS_WEBHOOK_SECRET: SEND_SECRET,
  TWILIO_ACCOUNT_SID: 'ACsynthetic0000000000000000000000',
  TWILIO_AUTH_TOKEN: 'synthetic-twilio-auth-token',
  TWILIO_MESSAGING_SERVICE_SID: 'MGsynthetic0000000000000000000000',
  SUPABASE_URL: 'https://synthetic.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role-key',
}

function sendRequest(bodyObj, { secret = SEND_SECRET, method = 'POST', raw } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (secret !== null) headers['X-Webhook-Secret'] = secret
  const body = raw !== undefined ? raw : JSON.stringify(bodyObj)
  return new Request('https://synthetic.invalid/functions/v1/sms-send',
    method === 'GET' ? { method, headers } : { method, body, headers })
}

// Wrong secret -> 401.
{
  const handler = buildHandler(sendCompiled, sendEnvBase)
  const res = await handler(sendRequest({ id: 'x' }, { secret: 'wrong-secret' }))
  eq(res.status, 401, 'wrong secret rejected')
}

// Missing secret header -> 401.
{
  const handler = buildHandler(sendCompiled, sendEnvBase)
  const res = await handler(sendRequest({ id: 'x' }, { secret: null }))
  eq(res.status, 401, 'missing secret header rejected')
}

// SMS_WEBHOOK_SECRET not configured -> 500.
{
  const handler = buildHandler(sendCompiled, { ...sendEnvBase, SMS_WEBHOOK_SECRET: undefined })
  const res = await handler(sendRequest({ id: 'x' }))
  eq(res.status, 500, 'unconfigured secret -> 500')
}

// Invalid JSON body -> 400.
{
  const handler = buildHandler(sendCompiled, sendEnvBase)
  const res = await handler(sendRequest(null, { raw: 'not json' }))
  eq(res.status, 400, 'invalid json body rejected')
}

// Missing id -> 400.
{
  const handler = buildHandler(sendCompiled, sendEnvBase)
  const res = await handler(sendRequest({}))
  eq(res.status, 400, 'missing id rejected')
}

// Method not POST -> 405.
{
  const handler = buildHandler(sendCompiled, sendEnvBase)
  const res = await handler(sendRequest({ id: 'x' }, { method: 'GET' }))
  eq(res.status, 405, 'GET rejected')
}

// Twilio env vars missing -> 500 twilio_not_configured.
{
  const handler = buildHandler(sendCompiled, { ...sendEnvBase, TWILIO_ACCOUNT_SID: undefined })
  const res = await handler(sendRequest({ id: 'x' }))
  eq(res.status, 500, 'missing twilio config -> 500')
}

// Claim returns nothing (already sent/canceled elsewhere) -> 200 skipped, no send, no mark_result.
await withSupabase(
  {
    sms_claim_for_send: async () => ({ data: [], error: null }),
    sms_mark_result: async () => { throw new Error('mark_result must not be called when nothing was claimed') },
  },
  async () => {
    const handler = buildHandler(sendCompiled, sendEnvBase)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('must not call Twilio when claim is empty') }
    try {
      const res = await handler(sendRequest({ id: 'row-1' }))
      eq(res.status, 200, 'empty claim -> 200')
      const json = await res.json()
      eq(json.skipped, true, 'empty claim -> skipped')
    } finally {
      globalThis.fetch = originalFetch
    }
  },
)

// Provider success -> mark_result called with the provider sid.
{
  let markedWith = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ sid: 'SMsynthetic999' }) })
  try {
    await withSupabase(
      {
        sms_claim_for_send: async (p) => {
          eq(p.p_id, 'row-2', 'claim called with outbox id')
          return { data: [{ to_e164: '+13105550111', body: 'Studio: Open host shift...' }], error: null }
        },
        sms_mark_result: async (p) => { markedWith = p; return { data: null, error: null } },
      },
      async () => {
        const handler = buildHandler(sendCompiled, sendEnvBase)
        const res = await handler(sendRequest({ id: 'row-2' }))
        eq(res.status, 200, 'provider success -> 200')
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  ok(markedWith, 'mark_result was called on success')
  eq(markedWith.p_id, 'row-2', 'mark_result id matches')
  eq(markedWith.p_provider_sid, 'SMsynthetic999', 'mark_result records provider sid')
  eq(markedWith.p_error, null, 'mark_result success has no error')
}

// Provider error -> mark_result called with an error, response still 200 (outbox owns retry).
{
  let markedWith = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
  try {
    await withSupabase(
      {
        sms_claim_for_send: async () => ({ data: [{ to_e164: '+13105550111', body: 'Studio: Open host shift...' }], error: null }),
        sms_mark_result: async (p) => { markedWith = p; return { data: null, error: null } },
      },
      async () => {
        const handler = buildHandler(sendCompiled, sendEnvBase)
        const res = await handler(sendRequest({ id: 'row-3' }))
        eq(res.status, 200, 'provider error still 200 (outbox retries)')
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
  ok(markedWith, 'mark_result was called on provider error')
  eq(markedWith.p_provider_sid, null, 'mark_result error has no sid')
  ok(typeof markedWith.p_error === 'string' && markedWith.p_error.length > 0, 'mark_result records an error string')
}

// ---------------------------------------------------------------------------
// No PII in any console output across every scenario above.
// ---------------------------------------------------------------------------
const joined = consoleLog.join('\n')
ok(!/\+1\d{10}/.test(joined), 'no phone numbers in console output')
ok(!joined.includes('Open host shift'), 'no message body text in console output')
checks++

console.log(`${checks} SMS edge-function assertions passed`)
