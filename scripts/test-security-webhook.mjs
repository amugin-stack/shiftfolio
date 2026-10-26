import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
const require=createRequire(import.meta.url), ts=require('typescript')
const source=readFileSync(new URL('../supabase/functions/resend-webhook/index.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
let handler, calls=0, fail=false
const env={RESEND_WEBHOOK_SECRET:'whsec_'+Buffer.from('synthetic-only-key').toString('base64')}
new Function('require','exports','Deno','crypto','console',compiled)(name=>name.startsWith('jsr:')?{}:{createClient:()=>({rpc:async()=>{calls++;return {data:true,error:fail?{}:null}}})},{},{env:{get:k=>env[k]},serve:fn=>handler=fn},webcrypto,{error(){}})
const valid={type:'email.delivered',created_at:new Date().toISOString(),data:{email_id:'synthetic-message',to:['worker@example.invalid']}}
async function invoke(event=valid, offset=0, bad=false){
 const body=JSON.stringify(event), stamp=String(Math.floor(Date.now()/1000)+offset), id='synthetic-id'
 const key=await webcrypto.subtle.importKey('raw',Buffer.from('synthetic-only-key'),{name:'HMAC',hash:'SHA-256'},false,['sign'])
 const sig=Buffer.from(await webcrypto.subtle.sign('HMAC',key,Buffer.from(`${id}.${stamp}.${body}`))).toString('base64')
 return handler(new Request('https://synthetic.invalid',{method:'POST',body,headers:{'svix-id':id,'svix-timestamp':stamp,'svix-signature':'v1,'+(bad?'wrong':sig)}}))
}
let checks=0
async function expect(event,offset,bad,status){assert.equal((await invoke(event,offset,bad)).status,status);checks++}
await expect(valid,0,false,200)
await expect(valid,-301,false,401);await expect(valid,301,false,401);await expect(valid,-100000000,false,401)
await expect(valid,0,true,401)
for(const event of [null,{}, {...valid,type:'unknown'}, {...valid,data:{}},{...valid,data:{email_id:'id',to:'bad'}},{...valid,data:{email_id:'id',to:['not an email']}}]) await expect(event,0,false,400)
assert.equal(calls,1);checks++
fail=true;await expect(valid,0,false,500)
console.log(`${checks} webhook handler security assertions passed`)
