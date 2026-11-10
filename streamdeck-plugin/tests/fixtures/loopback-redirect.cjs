'use strict';
// Test-process-only bridge routing. This file is outside the packaged plugin.
const port=Number(process.env.CB_FIXTURE_PORT);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid fixture port');
const actual=globalThis.fetch;
globalThis.fetch=(url,options)=>{
  if(typeof url!=='string'||!/^http:\/\/127\.0\.0\.1:17654\/v1\/(status|action)$/.test(url))throw Error('Test attempted a non-fixture request');
  return actual(url.replace(':17654/',':'+port+'/'),options);
};
