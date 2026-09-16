import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { opsNotificationDecision } from '../src/lib/ops_notification_policy.mjs';
import { claimEmergencyDelivery } from '../src/lib/emergency_outbox.mjs';
import { emitOpsAlertOnce } from '../src/reliability_watchdogs.mjs';
import { sendOpsAlert } from '../src/alerts.mjs';
import { handleAdminOpsHealth } from '../src/admin.mjs';
const now = new Date('2026-09-16T12:00:00Z');
const emergency = { confirmed:true, impact:'service-unavailable', human_action_required:true, automatic_remedy:'exhausted', action:'Restore the production service', verified_at:now.toISOString(), evidence_url:'https://example.com/incident' };
const input = { guard:'production-emergency', stage:'outage', fingerprint:'incident-123', findings:['Production service is unavailable'], emergency, now };
function kv(){const data=new Map();return {get:async k=>data.get(k)||null,put:async(k,v)=>data.set(k,v)};}
const emergencyMigration=readFileSync(new URL('../migrations/0033_ops_emergency_outbox.sql',import.meta.url),'utf8');
function d1(){
 const sqlite=new DatabaseSync(':memory:');sqlite.exec(emergencyMigration);let queryCount=0;
 return {sqlite,getQueryCount:()=>queryCount,DB:{prepare(sql){queryCount+=1;const statement=sqlite.prepare(sql);return {bind(...params){return {
  run(){const result=statement.run(...params);return {meta:{changes:Number(result.changes||0)}}},
  first(){return statement.get(...params)||null},
  all(){return {results:statement.all(...params)}},
 }}}}}};
}
test('severity, age, and repair exhaustion alone cannot turn routine noise into emergency mail',()=>{
 for(const guard of ['served-artifact-freshness','ops-repair-judgment','digest-dead-mans-switch']) assert.equal(opsNotificationDecision({...input,guard,severity:'critical'},now).email,false);
 for(const patch of [{confirmed:false},{human_action_required:false},{automatic_remedy:'pending'},{action:''},{impact:'stale-data'},{verified_at:'2026-09-15T12:00:00Z'},{verified_at:'2026-09-16T12:01:00Z'},{evidence_url:'javascript:alert(1)'},{evidence_url:'https://example.com/?token=secret'}]) assert.equal(opsNotificationDecision({...input,emergency:{...emergency,...patch}},now).email,false);
 assert.equal(opsNotificationDecision(input,now).email,true);
});
test('direct sender cannot bypass the emergency policy',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected send')};
 try{assert.equal((await sendOpsAlert({RESEND_API_KEY:'test'},{guard:'ops-repair-judgment'})).reason,'desk-only');assert.equal(calls,0)}finally{globalThis.fetch=previous}
});
test('silent finding can escalate once; definitive rejection accepts fresh evidence on retry',async()=>{
 const {DB}=d1();const env={DB,ALERT_STATE:kv(),RESEND_API_KEY:'test'};const previous=globalThis.fetch;const requests=[];globalThis.fetch=async(_url,options)=>{requests.push(options);return {ok:requests.length>1,status:400,text:async()=>'rejected',json:async()=>({id:'accepted'})}};
 try{
  const silent=await emitOpsAlertOnce(env,{...input,emergency:null});
  assert.equal(silent.reason,'desk-only');
  const firstEmergency={...emergency,action:'Restore the first failed deployment',evidence_url:'https://example.com/incident/first'};
  const rejected=await emitOpsAlertOnce(env,{...input,emergency:firstEmergency});
  assert.equal(rejected.sent,false);
  assert.equal(rejected.record.confirmed_emergency.evidence_url,firstEmergency.evidence_url);
  const retryNow=new Date('2026-09-16T12:05:00Z');
  const acceptedEmergency={...emergency,action:'Restore the verified production service',verified_at:retryNow.toISOString(),evidence_url:'https://example.com/incident/accepted'};
  const accepted=await emitOpsAlertOnce(env,{...input,now:retryNow,emergency:acceptedEmergency});
  assert.equal(accepted.sent,true);
  assert.deepEqual(accepted.record.confirmed_emergency,{impact:acceptedEmergency.impact,action:acceptedEmergency.action,evidence_url:acceptedEmergency.evidence_url,verified_at:acceptedEmergency.verified_at});
  assert.equal((await emitOpsAlertOnce(env,{...input,now:retryNow,emergency:acceptedEmergency})).sent,false);
  const tomorrow=new Date('2026-09-17T12:00:00Z');
  const stale=await emitOpsAlertOnce(env,{...input,now:tomorrow,emergency:acceptedEmergency});
  assert.equal(stale.sent,false);
  assert.equal(stale.record.notification.reason,'desk-only');
  assert.deepEqual(stale.record.confirmed_emergency,accepted.record.confirmed_emergency);
  assert.equal(stale.record.emergency_sent_at,retryNow.toISOString());
  assert.equal(requests.length,2);
  assert.deepEqual(requests.map((request)=>request.headers['Idempotency-Key']),[silent.signature,silent.signature]);
}finally{globalThis.fetch=previous}
});
test('malformed success preserves and retries the immutable in-flight message',async()=>{
 const {DB}=d1();const ALERT_STATE=kv();const env={DB,ALERT_STATE,RESEND_API_KEY:'test'};const previous=globalThis.fetch;const requests=[];
 globalThis.fetch=async(_url,options)=>{const stored=JSON.parse(await ALERT_STATE.get('ops:alert:signature:incident-malformed'));assert.equal(stored.emergency_delivery.state,'in-flight');requests.push(options);return requests.length===1?{ok:true,json:async()=>{throw new SyntaxError('malformed provider body')}}:{ok:true,json:async()=>({id:'accepted-after-retry'})}};
 try{
  const firstEmergency={...emergency,action:'Restore the first verified deployment',evidence_url:'https://example.com/incident/first'};
  const first=await emitOpsAlertOnce(env,{...input,fingerprint:'incident-malformed',emergency:firstEmergency});
  assert.equal(first.reason,'delivery-indeterminate');
  assert.equal(first.record.emergency_delivery.state,'indeterminate');
  const retryNow=new Date('2026-09-16T12:05:00Z');
  const freshEmergency={...emergency,action:'Restore a later verified deployment',verified_at:retryNow.toISOString(),evidence_url:'https://example.com/incident/later'};
  const retried=await emitOpsAlertOnce(env,{...input,fingerprint:'incident-malformed',now:retryNow,emergency:freshEmergency});
  assert.equal(retried.sent,true);
  assert.equal(retried.record.emergency_delivery.state,'accepted');
  assert.deepEqual(retried.record.confirmed_emergency,first.record.confirmed_emergency);
  assert.deepEqual(requests.map((request)=>request.body),[requests[0].body,requests[0].body]);
  assert.deepEqual(requests.map((request)=>request.headers['Idempotency-Key']),['incident-malformed','incident-malformed']);
 }finally{globalThis.fetch=previous}
});
test('transport uncertainty stays inspectable and never retries after idempotency expiry',async()=>{
 const {DB}=d1();const ALERT_STATE=kv();const env={DB,ALERT_STATE,RESEND_API_KEY:'test'};const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls+=1;throw new TypeError('connection reset after upload')};
 try{
  const first=await emitOpsAlertOnce(env,{...input,fingerprint:'incident-transport'});
  assert.equal(first.reason,'delivery-indeterminate');
  assert.equal(first.record.emergency_delivery.state,'indeterminate');
  const afterExpiry=new Date('2026-09-17T12:00:00.001Z');
  const currentEmergency={...emergency,verified_at:afterExpiry.toISOString(),evidence_url:'https://example.com/incident/current'};
  const held=await emitOpsAlertOnce(env,{...input,fingerprint:'incident-transport',now:afterExpiry,emergency:currentEmergency});
  assert.equal(held.reason,'delivery-indeterminate');
  assert.equal(held.record.emergency_delivery.state,'indeterminate');
  assert.deepEqual(held.record.confirmed_emergency,first.record.confirmed_emergency);
  assert.equal(calls,1);
}finally{globalThis.fetch=previous}
});
test('uncertain retry cutoff preserves a safety margin for new and existing rows',async()=>{
 const first='2026-09-16T12:00:00.000Z';const providerExpiry='2026-09-17T12:00:00.000Z';const cutoff='2026-09-17T11:45:00.000Z';
 const payload={subject:'Emergency',text:'Restore service',evidence:{impact:'service-unavailable',action:'Restore service',evidence_url:'https://example.com/incident',verified_at:first}};
 const created=d1();const fresh=await claimEmergencyDelivery(created.DB,{signature:'new-window',payload,now:new Date(first)});
 assert.equal(fresh.owned,true);assert.equal(fresh.row.retry_until,cutoff);
 const migrated=d1();const expiredMigration=await claimEmergencyDelivery(migrated.DB,{signature:'migrated-at-cutoff',payload,now:new Date(cutoff),attemptedAt:first,retryUntil:providerExpiry});
 assert.equal(expiredMigration.owned,false);assert.equal(expiredMigration.row.state,'indeterminate');assert.equal(expiredMigration.row.retry_until,cutoff);
 for(const [label,stamp,owned] of [['before','2026-09-17T11:44:59.999Z',true],['at',cutoff,false],['after','2026-09-17T11:45:00.001Z',false]]){
  const current=d1();current.sqlite.prepare(`INSERT INTO ops_emergency_deliveries
   (signature,payload_json,state,first_attempted_at,last_attempted_at,retry_until,attempt_count,error_reason)
   VALUES (?,?,\'indeterminate\',?,?,?,?,?)`).run(`existing-${label}`,JSON.stringify(payload),first,first,providerExpiry,1,'delivery-indeterminate');
  const claim=await claimEmergencyDelivery(current.DB,{signature:`existing-${label}`,payload,now:new Date(stamp)});
  assert.equal(claim.owned,owned,label);assert.equal(claim.row.retry_until,cutoff,label);
  assert.equal(Number(claim.row.attempt_count),owned?2:1,label);
 }
});
test('emergency provider requests time out as indeterminate',async()=>{
 const previous=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,{signal})=>{calls+=1;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
 try{
  const result=await sendOpsAlert({RESEND_API_KEY:'test',ALERT_STATE:kv(),OPS_EMERGENCY_SEND_TIMEOUT_MS:5},{...input,signature:'incident-timeout'});
  assert.equal(calls,1);assert.equal(result.accepted,false);assert.equal(result.reason,'delivery-indeterminate');assert.match(result.error,/timed out/i);
 }finally{globalThis.fetch=previous}
});
test('concurrent differing emergencies share one immutable D1 payload owner',async()=>{
 const {sqlite,DB}=d1();const ALERT_STATE=kv();const env={DB,ALERT_STATE,RESEND_API_KEY:'test'};const previous=globalThis.fetch;const requests=[];let release;const held=new Promise((resolve)=>{release=resolve});let submitted;const started=new Promise((resolve)=>{submitted=resolve});
 globalThis.fetch=async(_url,options)=>{requests.push(options);submitted();await held;return {ok:true,json:async()=>({id:'accepted-owner'})}};
 try{
  const firstEmergency={...emergency,action:'Restore deployment owned by first caller',evidence_url:'https://example.com/incident/owner'};
  const secondEmergency={...emergency,action:'Restore deployment proposed by second caller',evidence_url:'https://example.com/incident/loser'};
  const ownerPromise=emitOpsAlertOnce(env,{...input,fingerprint:'incident-concurrent',emergency:firstEmergency});
  await started;
  const loser=await emitOpsAlertOnce(env,{...input,fingerprint:'incident-concurrent',emergency:secondEmergency});
  assert.equal(loser.sent,false);
  assert.equal(loser.reason,'delivery-in-flight');
  assert.equal(requests.length,1);
  release();
  const owner=await ownerPromise;
  assert.equal(owner.sent,true);
  const stored=JSON.parse(await ALERT_STATE.get('ops:alert:signature:incident-concurrent'));
  assert.equal(stored.emergency_delivery.state,'accepted');
  assert.equal(stored.confirmed_emergency.evidence_url,firstEmergency.evidence_url);
  const authoritative=sqlite.prepare("SELECT state, payload_json FROM ops_emergency_deliveries WHERE signature = ?").get('incident-concurrent');
  assert.equal(authoritative.state,'accepted');
  assert.equal(JSON.parse(authoritative.payload_json).evidence.evidence_url,firstEmergency.evidence_url);
 }finally{release?.();globalThis.fetch=previous}
});
test('ops-health overlays accepted D1 evidence after a stale routine KV overwrite',async()=>{
 const {DB}=d1();const data=new Map();const signature='incident-read-race';let releaseRead;const heldRead=new Promise((resolve)=>{releaseRead=resolve});let routineRead;const readStarted=new Promise((resolve)=>{routineRead=resolve});let first=true;
 const ALERT_STATE={async get(key){if(first&&key===`ops:alert:signature:${signature}`){first=false;routineRead();await heldRead;return null}return data.get(key)||null},async put(key,value){data.set(key,String(value))}};
 const env={DB,ALERT_STATE,RESEND_API_KEY:'test',ADMIN_KEY:'secret'};const previous=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({id:'accepted-race'})});
 try{
  const routinePromise=emitOpsAlertOnce(env,{...input,fingerprint:signature,emergency:null});
  await readStarted;
  const accepted=await emitOpsAlertOnce(env,{...input,fingerprint:signature});
  assert.equal(accepted.sent,true);
  releaseRead();
  await routinePromise;
  const stale=JSON.parse(await ALERT_STATE.get(`ops:alert:signature:${signature}`));
  assert.equal(stale.confirmed_emergency,null);
  const response=await handleAdminOpsHealth(new Request('https://w/admin/reliability/ops-health',{headers:{authorization:'Bearer secret'}}),env,{now});
  assert.equal(response.status,200);
  const body=await response.json();
  const projected=body.alerts.items.find((item)=>item.signature===signature);
  assert.equal(body.alerts.emergency_delivery_authority.status,'available');
  assert.equal(projected.emergency_delivery.state,'accepted');
  assert.equal(projected.confirmed_emergency.evidence_url,emergency.evidence_url);
  assert.equal(projected.emergency_sent_at,now.toISOString());
  assert.equal(projected.sent_at,now.toISOString());
 }finally{releaseRead?.();globalThis.fetch=previous}
});
test('ops-health reads accepted D1 evidence when the final KV projection fails',async()=>{
 const {DB}=d1();const data=new Map();let failProjection=false;const signature='incident-kv-failure';
 const ALERT_STATE={async get(key){return data.get(key)||null},async put(key,value){if(failProjection&&(key===`ops:alert:signature:${signature}`||key==='ops:alert:history:v1'))throw new Error('kv-write-failed');data.set(key,String(value))}};
 const env={DB,ALERT_STATE,RESEND_API_KEY:'test',ADMIN_KEY:'secret'};const previous=globalThis.fetch;globalThis.fetch=async()=>{failProjection=true;return {ok:true,json:async()=>({id:'accepted-before-kv-failure'})}};
 try{
  await assert.rejects(()=>emitOpsAlertOnce(env,{...input,fingerprint:signature}),/kv-write-failed/);
  const response=await handleAdminOpsHealth(new Request('https://w/admin/reliability/ops-health',{headers:{authorization:'Bearer secret'}}),env,{now});
  const body=await response.json();
  const projected=body.alerts.items.find((item)=>item.signature===signature);
  assert.equal(body.alerts.emergency_delivery_authority.status,'available');
  assert.equal(projected.emergency_delivery.state,'accepted');
  assert.equal(projected.confirmed_emergency.evidence_url,emergency.evidence_url);
  assert.equal(projected.emergency_sent_at,now.toISOString());
 }finally{globalThis.fetch=previous}
});
test('ops-health marks emergency authority unavailable without D1',async()=>{
 const response=await handleAdminOpsHealth(new Request('https://w/admin/reliability/ops-health',{headers:{authorization:'Bearer secret'}}),{ADMIN_KEY:'secret',ALERT_STATE:kv()},{now});
 const body=await response.json();
 assert.deepEqual(body.alerts.items,[]);
 assert.deepEqual(body.alerts.emergency_delivery_authority,{status:'unavailable',reason:'db-unavailable'});
});
test('new routine findings outrank older emergency history without losing D1 authority',async()=>{
 const {sqlite,DB,getQueryCount}=d1();const ALERT_STATE=kv();const insert=sqlite.prepare(`INSERT INTO ops_emergency_deliveries
  (signature,payload_json,state,first_attempted_at,last_attempted_at,retry_until,attempt_count,resolved_at,provider_id)
  VALUES (?,?,\'accepted\',?,?,?,?,?,?)`);
 for(let index=0;index<50;index+=1){
  const stamp=new Date(Date.parse('2026-08-01T00:00:00Z')+index*60000).toISOString();
  const signature=`old-emergency-${String(index).padStart(2,'0')}`;
  const payload=JSON.stringify({subject:`Emergency ${index}`,text:`Old emergency ${index}`,evidence:{impact:'service-unavailable',action:'Restore the old service',evidence_url:`https://example.com/emergency/${index}`,verified_at:stamp}});
  insert.run(signature,payload,stamp,stamp,'2026-08-02T00:00:00.000Z',1,stamp,`provider-${index}`);
 }
 const items=Array.from({length:49},(_,index)=>{const stamp=new Date(Date.parse('2026-08-01T00:00:00Z')+index*60000).toISOString();return {schema:'cityscroll.ops-alert-signature.v1',signature:`old-emergency-${String(index).padStart(2,'0')}`,guard:'production-emergency',stage:'outage',findings:['stale KV evidence'],first_seen:stamp,last_seen:stamp,count:1,confirmed_emergency:{evidence_url:'https://example.com/wrong'}}});
 items.unshift({schema:'cityscroll.ops-alert-signature.v1',signature:'routine-new',guard:'served-artifact-freshness',stage:'freshness',findings:['new routine finding'],first_seen:'2026-09-16T12:10:00.000Z',last_seen:'2026-09-16T12:10:00.000Z',count:1});
 await ALERT_STATE.put('ops:alert:history:v1',JSON.stringify({schema:'cityscroll.ops-alert-history.v1',observed_at:'2026-09-16T12:10:00.000Z',items}));
 const response=await handleAdminOpsHealth(new Request('https://w/admin/reliability/ops-health',{headers:{authorization:'Bearer secret'}}),{ADMIN_KEY:'secret',ALERT_STATE,DB},{now});
 const body=await response.json();
 assert.equal(body.alerts.items.length,50);
 assert.equal(body.alerts.items[0].signature,'routine-new');
 const selected=body.alerts.items.find((item)=>item.signature==='old-emergency-49');
 assert.equal(selected.confirmed_emergency.evidence_url,'https://example.com/emergency/49');
 assert.equal(selected.emergency_delivery.state,'accepted');
 assert.equal(body.alerts.items.some((item)=>item.signature==='old-emergency-00'),false);
 assert.equal(body.alerts.emergency_delivery_authority.truncated,true);
 assert.equal(getQueryCount(),2);
});
