import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlMembers} from '../src/control-members.mjs';
import {supportFixture,httpCall} from './control-support-fixture.mjs';

test('cutover approves all existing accounts once and never grants admin, uploads or app rights',t=>{
  const f=supportFixture(t),unconfirmed=f.add({confirmed:false}),members=new ControlMembers(f.accounts);
  for(const context of [f.admin,f.user,f.other,unconfirmed]){const status=members.status(context.user.id);assert.equal(status.status,'approved');assert.equal(status.legacy,true);}
  const fresh=f.add({createdAt:1});members.observe(fresh.user.id);assert.equal(members.status(fresh.user.id).status,'pending');assert.equal(members.status(fresh.user.id).legacy,false);
  const restarted=new ControlMembers(f.accounts);assert.equal(restarted.status(fresh.user.id).status,'pending');assert.equal(f.store.get('SELECT is_admin,can_upload FROM accounts WHERE id=?',fresh.user.id).is_admin,0);assert.equal(f.store.get('SELECT COUNT(*) AS n FROM app_requests').n,0);
});
test('new registration notice is atomic and deduplicated, sent only after email confirmation',t=>{
  const f=supportFixture(t),members=new ControlMembers(f.accounts),fresh=f.add({confirmed:false});members.observe(fresh.user.id);
  assert.equal(f.store.get('SELECT COUNT(*) AS n FROM control_notice_events').n,0);f.store.run('UPDATE accounts SET confirmed=1 WHERE id=?',fresh.user.id);members.observe(fresh.user.id);members.observe(fresh.user.id);
  const notices=f.store.all('SELECT * FROM control_notice_events');assert.equal(notices.length,1);assert.equal(notices[0].type,'member_registered');assert.equal(notices[0].target_id,fresh.user.id);assert(!JSON.stringify(notices).includes('@fixture.test'));
});
test('approval preserves email confirmation, current authority and exact review revision',t=>{
  const f=supportFixture(t),members=new ControlMembers(f.accounts),fresh=f.add({confirmed:false});members.observe(fresh.user.id);
  const input={expectedRevision:0,decision:'approve',reason:'',confirm:true};assert.throws(()=>members.review(f.admin,fresh.user.id,input),{status:409});assert.throws(()=>members.review(f.user,fresh.user.id,input),{status:403});
  f.store.run('UPDATE accounts SET confirmed=1 WHERE id=?',fresh.user.id);assert.equal(members.review(f.admin,fresh.user.id,input).member.approval.status,'approved');assert.throws(()=>members.review(f.admin,fresh.user.id,input),{status:409});
  assert.doesNotThrow(()=>members.assertApproved(fresh));assert.throws(()=>members.review(f.admin,fresh.user.id,{...input,expectedRevision:1,decision:'reject',reason:'Kein Zugang'}),{status:403});
});
test('rejection needs a reason, never targets administrators, and existing sessions are not erased',t=>{
  const f=supportFixture(t),members=new ControlMembers(f.accounts),fresh=f.add();members.observe(fresh.user.id);
  const input={expectedRevision:0,decision:'reject',reason:'',confirm:true};assert.throws(()=>members.review(f.admin,fresh.user.id,input));assert.equal(members.review(f.admin,fresh.user.id,{...input,reason:'Bitte Rückfrage klären'}).member.approval.status,'rejected');
  assert.throws(()=>members.assertApproved(fresh),{kind:'registration_rejected'});assert.doesNotThrow(()=>members.assertApproved(f.admin));assert.doesNotThrow(()=>members.assertApproved(f.user));
  assert.equal(members.review(f.admin,fresh.user.id,{...input,expectedRevision:1,decision:'approve',reason:''}).member.approval.status,'approved');
});
test('member list includes all registered accounts and pages equal timestamps without duplicates',t=>{
  const f=supportFixture(t),members=new ControlMembers(f.accounts);for(let i=0;i<6;i++){const user=f.add({name:'New Member '+i,confirmed:i!==0});members.observe(user.user.id);}
  const ids=[];let cursor=null;do{const result=members.list(f.admin,{limit:2,cursor,status:'all',search:''});ids.push(...result.members.map(row=>row.id));cursor=result.nextCursor;assert.equal(result.counts.total,9);}while(cursor);
  assert.equal(new Set(ids).size,9);const pending=members.list(f.admin,{status:'pending',search:'New Member'});assert.equal(pending.members.length,6);assert(pending.members.some(row=>!row.confirmed));assert.equal(pending.counts.unconfirmed,1);
  assert.throws(()=>members.list(f.user),{status:403});assert.throws(()=>members.list(f.admin,{cursor:'bad'}));assert.throws(()=>members.list(f.admin,{path:'/private'}));
});
test('members HTTP handles only scoped routes, enforces admin and CSRF and permits own approval status',async t=>{
  const f=supportFixture(t),members=new ControlMembers(f.accounts),route='/api/admin/control-members/query';
  assert.equal((await httpCall(members,route,{method:'POST',body:{}})).status,401);assert.equal((await httpCall(members,route,{method:'POST',body:{},user:f.user})).status,403);assert.equal((await httpCall(members,route,{method:'POST',body:{},user:f.admin,csrf:'wrong'})).status,403);
  assert.equal((await httpCall(members,route,{method:'POST',body:{},user:f.admin})).body.members.length,3);assert.equal((await httpCall(members,'/api/account/approval',{user:f.user})).body.approval.status,'approved');assert.equal((await httpCall(members,'/api/unrelated')).handled,false);
});
