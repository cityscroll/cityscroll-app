import test from 'node:test';
import assert from 'node:assert/strict';
import { opsNotificationDecision } from '../src/lib/ops_notification_policy.mjs';
import { emitOpsAlertOnce } from '../src/reliability_watchdogs.mjs';
import { sendOpsAlert } from '../src/alerts.mjs';
const now = new Date('2026-09-16T12:00:00Z');
const emergency = { confirmed:true, impact:'service-unavailable', human_action_required:true, automatic_remedy:'exhausted', action:'Restore the production service', verified_at:now.toISOString(), evidence_url:'https://example.com/incident' };
const input = { guard:'production-emergency', stage:'outage', fingerprint:'incident-123', findings:['Production service is unavailable'], emergency, now };
function kv(){const data=new Map();return {get:async k=>data.get(k)||null,put:async(k,v)=>data.set(k,v)};}
test('severity, age, and repair exhaustion alone cannot turn routine noise into emergency mail',()=>{
 for(const guard of ['served-artifact-freshness','ops-repair-judgment','digest-dead-mans-switch']) assert.equal(opsNotificationDecision({...input,guard,severity:'critical'},now).email,false);
 for(const patch of [{confirmed:false},{human_action_required:false},{automatic_remedy:'pending'},{action:''},{impact:'stale-data'},{verified_at:'2026-09-15T12:00:00Z'},{verified_at:'2026-09-16T12:01:00Z'},{evidence_url:'javascript:alert(1)'},{evidence_url:'https://example.com/?token=secret'}]) assert.equal(opsNotificationDecision({...input,emergency:{...emergency,...patch}},now).email,false);
 assert.equal(opsNotificationDecision(input,now).email,true);
});
test('direct sender cannot bypass the emergency policy',async()=>{
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('unexpected send')};
 try{assert.equal((await sendOpsAlert({RESEND_API_KEY:'test'},{guard:'ops-repair-judgment'})).reason,'desk-only');assert.equal(calls,0)}finally{globalThis.fetch=previous}
});
test('silent finding can escalate once; failed sends retry and accepted emergencies never daily-roll up',async()=>{
 const env={ALERT_STATE:kv(),RESEND_API_KEY:'test'};const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return {ok:calls>1,status:503,text:async()=>'unavailable',json:async()=>({id:'accepted'})}};
 try{
  assert.equal((await emitOpsAlertOnce(env,{...input,emergency:null})).reason,'desk-only');
  assert.equal((await emitOpsAlertOnce(env,input)).sent,false);
  assert.equal((await emitOpsAlertOnce(env,input)).sent,true);
  assert.equal((await emitOpsAlertOnce(env,input)).sent,false);
  const tomorrow=new Date('2026-09-17T12:00:00Z');
  const stale=await emitOpsAlertOnce(env,{...input,now:tomorrow});
  assert.equal(stale.sent,false);
  assert.equal(stale.record.notification.reason,'desk-only');
  assert.deepEqual(stale.record.confirmed_emergency,{impact:emergency.impact,action:emergency.action,evidence_url:emergency.evidence_url,verified_at:emergency.verified_at});
  assert.equal(stale.record.emergency_sent_at,now.toISOString());
  assert.equal(calls,2);
}finally{globalThis.fetch=previous}
});
