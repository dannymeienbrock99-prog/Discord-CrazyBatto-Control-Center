const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../src/components/robot-photo-state.mjs');
test('further Robot photos retain draft data, deduplicate pictures and end pagination', async () => {
  const {appendRobotPhotos} = await model;
  const before = {order:{id:'order-1',revision:2,note:'saved'},photos:[{id:'photo-1'}],photosNextCursor:'photo-1',conflicts:[{id:'conflict-1'}]};
  const after = appendRobotPhotos(before,{order:{id:'order-1',revision:2},photos:[{id:'photo-1'},{id:'photo-2'}],photosNextCursor:null});
  assert.deepEqual(after.photos.map(p=>p.id),['photo-1','photo-2']);
  assert.equal(after.order,before.order);assert.equal(after.conflicts,before.conflicts);
  assert.equal(after.photosNextCursor,null);assert.equal(before.photos.length,1);
});
test('another order or changed revision cannot append stale photos', async () => {
  const {appendRobotPhotos} = await model;
  const before={order:{id:'order-1',revision:2},photos:[],photosNextCursor:'photo-1'};
  for(const incoming of [{order:{id:'order-2',revision:2},photos:[]},{order:{id:'order-1',revision:3},photos:[]}]) assert.throws(()=>appendRobotPhotos(before,incoming),/geändert/);
  assert.throws(()=>appendRobotPhotos(before,{order:before.order,photos:[],photosNextCursor:'photo-1'}),/Bilderseite/);
  assert.throws(()=>appendRobotPhotos(before,{order:before.order}),/vollständig/);
});
