'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const model=import('../src/components/admin-workspace-state.mjs');
test('German euro inputs preserve exact cents and reject amounts below the minimum, exponent notation and fractional cents',async()=>{
  const {parsePrice,priceInput}=await model;
  for(const [value,expected] of [['10',1000],['12,34',1234],['12.3',1230],['100000,00',10000000]])assert.equal(parsePrice(value),expected);
  for(const value of ['9,99','10,001','1e3','-20','1.000,00','100000,01','Infinity',''])assert.equal(parsePrice(value),null);
  assert.equal(parsePrice(priceInput(12345)),12345);
});
test('a counter-offer cannot be approved until the customer accepts the exact current amount',async()=>{
  const {supportCanApprove,supportCanQuote}=await model;
  const original={status:'submitted',order:{requested:true,offerCents:1000,acceptedCents:1000,proposedCents:null}};
  assert.equal(supportCanApprove(original),true);
  assert.equal(supportCanApprove({...original,status:'counter_offer',order:{...original.order,proposedCents:2000}}),false);
  assert.equal(supportCanApprove({...original,status:'pending_review',order:{...original.order,proposedCents:2000}}),false);
  assert.equal(supportCanApprove({...original,status:'pending_review',order:{...original.order,acceptedCents:2000,proposedCents:2000}}),true);
  for(const status of ['approved','closed','rejected'])assert.equal(supportCanQuote({...original,status}),false);
  assert.equal(supportCanApprove({status:'submitted',order:{requested:false}}),true);
});
test('technical support requires every system component, clear symptoms and one of the three driver answers',async()=>{
  const {supportDraftError,supportDraft}=await model;
  const ticket={category:'software',subject:'Startfehler',symptoms:'Das Programm startet nicht.',specs:{cpu:'Unbekannt',gpu:'RTX',mainboard:'Board',ram:'32 GB',os:'Windows',psu:'Unbekannt'},drivers:'unknown'};
  const draft=supportDraft(ticket);assert.equal(supportDraftError(draft),'');
  draft.specs.cpu='';assert.match(supportDraftError(draft),/sechs/);assert.equal(ticket.specs.cpu,'Unbekannt');
  assert.match(supportDraftError({...ticket,drivers:'maybe'}),/Treiber/);
});
test('robot form round-trips explicit zero times and checks end before start',async()=>{
  const {robotDraft,robotChanges,robotDraftError}=await model;
  const order={robot:1,orderNumber:'A-100',articleNumber:'',programInfo:'',missingParts:'',quantity:0,timestamp:1900000000000,shift:'',eventType:'',important:false,note:'',handoverNote:'',startedAt:0,endedAt:0,source:'Android',personnelNumber:''};
  const draft=robotDraft(order);assert.equal(draft.startedAt,'');assert.equal(draft.endedAt,'');
  assert.deepEqual(robotChanges(draft),order);assert.equal(robotDraftError(draft),'');
  assert.match(robotDraftError({...draft,quantity:-1}),/Menge/);
  assert.match(robotDraftError({...draft,orderNumber:' '}),/Auftragsnummer/);
  assert.match(robotDraftError({...draft,startedAt:'2030-01-02T12:00:00',endedAt:'2030-01-01T12:00:00'}),/vor dem Beginn/);
});
test('pagination replaces a changed duplicate by stable ID without duplicating records',async()=>{
  const {mergeEntries}=await model;
  assert.deepEqual(mergeEntries([{id:'a',revision:1},{id:'b',revision:1}],[{id:'b',revision:2},{id:'c',revision:1}]),[{id:'a',revision:1},{id:'b',revision:2},{id:'c',revision:1}]);
});

test('Robot note-only edits preserve original millisecond timestamps and repeated daylight-saving hours',async()=>{
  const {robotDraft,robotPatch,robotDraftError}=await model;
  const order={robot:1,orderNumber:'A-100',articleNumber:'',programInfo:'',missingParts:'',quantity:0,timestamp:1900000000123,shift:'',eventType:'',important:false,note:'Before',handoverNote:'',startedAt:Date.parse('2030-10-27T00:50:00.321Z'),endedAt:Date.parse('2030-10-27T01:10:00.654Z'),source:'Android',personnelNumber:''};
  const previous=process.env.TZ;process.env.TZ='Europe/Berlin';
  try{const draft=robotDraft(order);draft.note='After';assert.deepEqual(robotPatch(draft,order),{note:'After'});assert.equal(robotDraftError(draft,order),'');assert.match(robotDraftError({...draft,quantity:''},order),/Menge/);}
  finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
});
