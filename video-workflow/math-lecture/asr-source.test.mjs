import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReceipt} from './asr-source.mjs';

test('audio ASR binds the source and requires verified cloud cleanup',()=>{
  const audio={sha256:'input-hash'};
  const raw={schema_version:1,source_sha256:'input-hash',route:'filetrans',utterances:[{text:'定理'}],cleanup:{deleted:true,prefix_empty:true}};
  validateReceipt(raw,audio,'bailian');
  assert.throws(()=>validateReceipt({...raw,source_sha256:'another-video'},audio,'bailian'),/source_mismatch/);
  assert.throws(()=>validateReceipt({...raw,cleanup:{deleted:true,prefix_empty:false}},audio,'bailian'),/cleanup_unverified/);
  assert.throws(()=>validateReceipt({...raw,utterances:[]},audio,'bailian'),/source_mismatch/);
});
