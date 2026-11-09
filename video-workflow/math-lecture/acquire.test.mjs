import test from 'node:test';
import assert from 'node:assert/strict';
import {parseParts} from './acquire.mjs';
test('requested parts expand inclusively and never silently drop duplicates',()=>{
  assert.deepEqual(parseParts('3-5,8'),[3,4,5,8]);
  for(const text of ['0','5-3','1,1','3-5,4','x','1-99999'])assert.throws(()=>parseParts(text));
});
