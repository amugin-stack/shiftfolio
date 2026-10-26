// Synthetic execution of the actual Edge handler. No network, credentials, or live data.
// Run with Node after npm ci. SQL snapshot logic has its own PostgreSQL harness.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ts = require(process.argv[2] ?? 'typescript')
const source = readFileSync(new URL('../supabase/functions/send-notification-email/index.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
let checks = 0
function check(value, expected, label) { assert.deepEqual(value, expected, label); checks++ }
function fixture(options = {}) {
  const state = { sends: [], updates: [], rpcCalls: [], clientCalls: 0, renders: 0, rendered: [], providerPayload: null }
  const notification = { id: '00000000-0000-0000-0000-000000000001', recipient_id: '00000000-0000-0000-0000-000000000002', type: 'shift_reminder', body: '24h', brand_id: '00000000-0000-0000-0000-000000000003', brand_name: 'Synthetic Brand', host_name: 'Synthetic Worker', shift_start: '2027-01-01T10:00:00Z', shift_end: '2027-01-01T12:00:00Z', email_sent_at: null, email_skipped_reason: null, ...options.notification }
  const client = {
    rpc: async (name, args) => { state.rpcCalls.push({ name, args }); if(name === '_claim_reminder_send_slot') options.beforeSlot?.(); if(name === '_prepare_reminder_email') { state.providerPayload ??= args.p_payload; return {data:state.providerPayload,error:null} } return { data: name === '_claim_reminder_send_slot' ? (options.waitMs ?? 0) : options.current ?? true, error: options.rpcError ?? null } },
    from: table => {
      let patch
      const query = {
        select: () => query,
        update: value => { patch = value; return query },
        eq: () => query,
        single: async () => ({ data: notification, error: options.fetchError ?? null }),
        maybeSingle: async () => ({ data: options.rows ? (options.rows[table] ?? null) : table === 'hosts' ? { email: 'synthetic@example.invalid', name: 'Synthetic Worker', email_disabled_at: null } : null, error: options.lookupErrors?.[table] ?? null }),
        then: resolve => { state.updates.push(patch); if (!options.failWrite) Object.assign(notification, patch); return Promise.resolve({ error: options.failWrite ? { message: 'synthetic write failure' } : null }).then(resolve) },
      }
      return query
    },
  }
  let handler
  const env = { WEBHOOK_SECRET: 'synthetic-shared-secret', RESEND_API_KEY: 'synthetic-provider-key', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key', SUPABASE_URL: 'https://synthetic.invalid' }
  const dependencies = name => {
    if (name.startsWith('jsr:')) return {}
    if (name.startsWith('npm:@supabase/')) return { createClient: () => { state.clientCalls++; return client } }
    if (name.endsWith('/templates/index.ts')) return { renderEmail: async n => { state.renders++; state.rendered.push(n); return { subject: 'Synthetic reminder', html: '<p>Synthetic reminder</p>' } } }
    throw new Error(`Unexpected import ${name}`)
  }
  const fakeFetch = async (url, init) => {
    state.sends.push({ url, ...init })
    if (options.networkFailure) throw new Error('synthetic network failure')
    return new Response(JSON.stringify(options.providerStatus ? { message: 'synthetic provider failure' } : { id: 'synthetic-message-id' }), { status: options.providerStatus ?? 200 })
  }
  new Function('require', 'exports', 'Deno', 'fetch', 'console', compiled)(dependencies, {}, { env: { get: name => env[name] }, serve: fn => { handler = fn } }, fakeFetch, { error: () => {} })
  const invoke = async (secret = env.WEBHOOK_SECRET) => {
    const response = await handler(new Request('https://synthetic.invalid', { method: 'POST', headers: { 'X-Webhook-Secret': secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'INSERT', table: 'notifications', schema: 'public', record: { id: notification.id } }) }))
    return { status: response.status, body: await response.json() }
  }
  return { state, notification, invoke }
}
{
  const f = fixture(); const r = await f.invoke('wrong-secret')
  check(r.status, 401, 'unauthorized rejected'); check(f.state.clientCalls, 0, 'no database access before secret'); check(f.state.sends.length, 0, 'no unauthorized send')
}
for (const tier of ['48h', '24h', '2h']) {
  const f = fixture({ current: false, notification: { body: tier } }); const r = await f.invoke()
  check(r.body.skipped, 'stale_reminder', `${tier} stale blocked`); check(f.state.sends.length, 0, 'no stale provider request'); check(f.notification.email_skipped_reason, 'stale_reminder', 'terminal stale skip'); check(f.state.renders, 0, 'no stale rendering')
}
{
  const f = fixture({ rpcError: { message: 'synthetic DB unavailable' } }); const r = await f.invoke()
  check(r.status, 500, 'validation unavailable transient'); check(f.state.sends.length, 0, 'no send on validation failure'); check(f.notification.email_skipped_reason, null, 'not terminally skipped'); check(f.notification.email_error, 'reminder_validation_unavailable', 'error persisted')
}
{
  const f = fixture(); const r = await f.invoke()
  check(r.body.sent, true, 'current reminder sent'); check(f.state.rpcCalls[0], { name: '_shift_reminder_is_current', args: { p_notification_id: f.notification.id } }, 'correct trusted RPC'); check(f.state.sends[0].headers['Idempotency-Key'], f.notification.id, 'stable provider idempotency key'); check(JSON.parse(f.state.sends[0].body).to, 'synthetic@example.invalid', 'resolved recipient'); check(f.notification.email_message_id, 'synthetic-message-id', 'accepted send recorded')
  const again = await f.invoke(); check(again.body.skipped, 'already_sent', 'idempotent repeat'); check(f.state.sends.length, 1, 'one provider request after successful persist')
}
{
  const f = fixture({ notification: { body: null } }); const r = await f.invoke()
  check(r.body.sent, true, 'legacy reminder still sent'); check(f.state.rpcCalls.length, 0, 'legacy does not require snapshot')
}
{
  const f = fixture({ notification: { type: 'shift_booked', body: '24h' } }); const r = await f.invoke()
  check(r.body.sent, true, 'other notification unaffected'); check(f.state.rpcCalls.length, 0, 'only reminder validated')
}
for (const options of [{ networkFailure: true }, { providerStatus: 503 }]) {
  const f = fixture(options); const r = await f.invoke()
  check(r.status, 500, 'provider outage transient'); check(f.notification.email_sent_at, null, 'failed send not marked sent'); check(f.notification.email_skipped_reason, null, 'failed send remains retryable')
}
{
  const f = fixture({ failWrite: true }); await f.invoke(); await f.invoke()
  check(f.state.sends.length, 2, 'failed sent-marker write permits retry'); check(f.state.sends[0].headers['Idempotency-Key'], f.state.sends[1].headers['Idempotency-Key'], 'both attempts use same key')
}
for (const table of ['hosts','moderators','producers','profiles']) {
  const f=fixture({rows:{},lookupErrors:{[table]:{message:'temporary unavailable'}}});const r=await f.invoke()
  check(r.status,500,`${table} lookup retries`);check(f.notification.email_skipped_reason,null,'lookup failure not disabled');check(f.state.sends.length,0,'lookup fail closed')
}
{
 const f=fixture({notification:{email_deferred:true,reminder_role:'moderator',body:'corrected'},rows:{
 hosts:{email:'synthetic-host@example.invalid',name:'Synthetic',email_disabled_at:null},
 moderators:{email:'synthetic-mod@example.invalid',name:'Synthetic',email_disabled_at:null},
 }}); const r=await f.invoke();check(r.body.sent,true);check(f.state.rendered[0].shifts[0].role,'moderator');
 check(f.state.rendered[0].reminderMode,'corrected');check(JSON.parse(f.state.sends[0].body).to,'synthetic-mod@example.invalid')
}
{
 const f=fixture({current:false,notification:{email_deferred:true,reminder_role:'host'}});const r=await f.invoke()
 check(r.body.skipped,'not_current_worker_attempt');check(f.state.sends.length,0)
}
{
 const f=fixture({providerStatus:429});check((await f.invoke()).status,500,'throttle retryable')
}
{
 const f=fixture({fetchError:{message:'temporary outage'}});check((await f.invoke()).status,500,'notification read retryable')
}
{
 const rows={hosts:{email:'synthetic@example.invalid',name:'Synthetic',email_disabled_at:null}}
 const f=fixture({notification:{email_deferred:true,reminder_role:'host'},rows,waitMs:1,
 beforeSlot:()=>{rows.hosts.email_disabled_at='2027-01-01T00:00:00Z'}})
 const r=await f.invoke();check(r.body.skipped,'no_address_or_disabled','disable during pacing respected');check(f.state.sends.length,0)
}
{
 const f=fixture({failWrite:true,notification:{email_deferred:true,reminder_role:'host'}})
 await f.invoke();f.notification.body='late';await f.invoke()
 check(f.state.sends[0].body,f.state.sends[1].body,'lost acceptance marker retry keeps exact provider payload')
 check(f.state.sends[0].signal instanceof AbortSignal,true,'provider request has bounded abort signal')
}
// Render the actual deployed HTML, not the provider stub, for changed/late copy.
const templateSource=readFileSync(new URL('../supabase/functions/_shared/templates/render-html.ts',import.meta.url),'utf8')
const templateCompiled=ts.transpileModule(templateSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const templateExports={};new Function('exports',templateCompiled)(templateExports)
for(const mode of ['scheduled','late','corrected']){
 const rendered=await templateExports.renderEmailHtml({type:'shift_reminder',recipientName:'Synthetic <script>',recipientRole:'moderator',
 brand:{id:'synthetic',name:'Synthetic & Brand'},shifts:[{start:'2027-01-03T10:00:00Z',end:'2027-01-03T12:00:00Z',role:'moderator',brandName:'Synthetic & Brand'}],
 appUrl:'https://synthetic.invalid',body:'24h',reminderMode:mode})
 check(rendered.html.includes('Moderator'),true,'actual template assigned role');check(rendered.html.includes('<script>'),false,'escaped display text')
 check(rendered.subject.includes('Tomorrow'),false,'no outdated relative time')
 if(mode==='late')check(rendered.html.includes('This reminder was delayed.'),true)
 if(mode==='corrected')check(rendered.html.includes('in place of the earlier reminder'),true)
}
console.log(`Passed ${checks} synthetic Edge handler checks (provider and rendering stubbed).`)
