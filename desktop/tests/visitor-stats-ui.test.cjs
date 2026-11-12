const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/components/visitor-stats-state.mjs');
const deferred = () => { let resolve, reject; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
const report = (rangeDays=30,views=4) => ({rangeDays,timeZone:'Europe/Berlin',retentionDays:90,startedAt:'2026-11-12T07:00:00.000Z',generatedAt:'2026-11-12T09:00:00.000Z',partial:false,today:{date:'2026-11-12',views,visitors:views?1:0},period:{views,visitorDays:views?1:0},totals:{views,visitorDays:views?1:0},daily:[{date:'2026-11-12',views,visitors:views?1:0}],pages:views?[{path:'/',label:'Startseite',views}]:[],method:'daily-ip-hmac'});

test('visitor reports preserve actual zero totals and do not interpret missing statistics as zero',async()=>{
  const {visitorReport}=await model;
  const empty=report(7,0);
  assert.equal(visitorReport(empty,7),empty);
  for(const invalid of [null,{}, {...empty,today:null},{...empty,daily:[]},{...empty,totals:{visitorDays:0}},{...empty,rangeDays:90},{...empty,today:{date:'2026-02-30',views:0,visitors:0}}])assert.throws(()=>visitorReport(invalid,7),/vollständige/);
});

test('visitor report rejects inconsistent summaries, invalid counts and duplicate dates or pages',async()=>{
  const {visitorReport}=await model,good=report();
  for(const invalid of [
    {...good,period:{views:99,visitorDays:1}},
    {...good,totals:{views:2,visitorDays:1}},
    {...good,daily:[{date:'2026-11-12',views:-1,visitors:1}]},
    {...good,daily:[{date:'2026-11-12',views:4,visitors:5}]},
    {...good,daily:[...good.daily,...good.daily]},
    {...good,pages:[...good.pages,...good.pages]},
    {...good,pages:[]},
    {...good,generatedAt:'not-a-date'},
    {...good,timeZone:'America/New_York'},
  ])assert.throws(()=>visitorReport(invalid,30),/vollständige/);
});

test('a slower old range cannot overwrite the most recently selected range',async()=>{
  const {createVisitorStatsController}=await model,requests=[],changes=[];
  const control=createVisitorStatsController({request:days=>{const pending=deferred();requests.push({days,...pending});return pending.promise;},onChange:state=>changes.push(state)});
  const old=control.load(30),current=control.load(7);
  requests[1].resolve(report(7,9));assert.equal(await current,true);
  requests[0].resolve(report(30,4));assert.equal(await old,false);
  assert.equal(control.state().days,7);assert.equal(control.state().data.period.views,9);
  assert.equal(changes.at(-1).data.rangeDays,7);
});

test('changing range clears the old numbers until a matching report arrives',async()=>{
  const {createVisitorStatsController}=await model,requests=[];
  const control=createVisitorStatsController({request:days=>{const pending=deferred();requests.push(pending);return pending.promise;},onChange:()=>{}});
  const first=control.load();requests[0].resolve(report());await first;
  const next=control.load(90);assert.equal(control.state().data,null);assert.equal(control.state().loading,true);
  requests[1].resolve(report(90,8));await next;assert.equal(control.state().data.rangeDays,90);
});

test('expired access clears previous totals and late replies after account disposal never publish',async()=>{
  const {createVisitorStatsController}=await model,requests=[],changes=[];
  const control=createVisitorStatsController({request:()=>{const pending=deferred();requests.push(pending);return pending.promise;},onChange:state=>changes.push(state)});
  const first=control.load();requests[0].resolve(report());await first;
  const expired=control.load();requests[1].reject(new Error('Bitte erneut anmelden.'));await expired;
  assert.equal(control.state().data,null);assert.match(control.state().error,/anmelden/);
  const late=control.load();control.dispose();const before=changes.length;
  requests[2].resolve(report());assert.equal(await late,false);assert.equal(changes.length,before);assert.equal(control.state().data,null);
});

test('invalid responses remain errors and impossible ranges never send requests',async()=>{
  const {createVisitorStatsController}=await model;let calls=0;
  const control=createVisitorStatsController({request:()=>{calls++;return {};},onChange:()=>{}});
  assert.equal(await control.load(365),false);assert.equal(calls,0);
  assert.equal(await control.load(7),false);assert.equal(calls,1);assert.match(control.state().error,/vollständige/);assert.equal(control.state().data,null);
});

test('daily labels use Berlin calendar days and times regardless of the PC timezone',async()=>{
  const {visitorDate,visitorTime}=await model;
  assert.equal(visitorDate('2026-10-25',true),'25.10.2026');
  assert.match(visitorTime('2026-11-12T23:30:00.000Z'),/13\.11\.2026.*00:30/);
});
