import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildPreprocessRequest,runPreprocessingRequest,standardWorkflowOptions} from '../index.mjs';
import {resolveProcessingPlan,requiredRouteLabels} from '../lib/workflow-plan.mjs';
import {SyntheticProducer} from '../test-support/synthetic-producer.mjs';
const sha = value => createHash('sha256').update(value).digest('hex');
const source = '# 现场记录\n\n晴天测量两次，阴天暂不开展。\n\n除非出现异常，否则保留原始设置。';

function input(form,options) {
  return buildPreprocessRequest({markdown:source,sourceType:'fixture',
    sourceMetadata:{input_form:form,language:'zh',content_profile:'natural_language',title:'现场记录'},
    processingOptions:standardWorkflowOptions({translate:false,include_reading_guide:false,...options})});
}

test('strong prompt retains the original prompt exactly',async()=>{
  const prompt=await fs.readFile(new URL('../prompts/强结构化整理.md',import.meta.url));
  assert.equal(sha(Buffer.from(prompt.toString('utf8').replace(/\r\n/gu,'\n'))),'c996ee91a7e23aa3b98a1685cf90df7ff51e5655943416da434cea3fd26c9dc8');
});

for(const form of ['written','spoken_transcript']) {
  test(`explicit strong structuring handles ${form} once from the whole source`,async()=>{
    const producer=new SyntheticProducer();
    const {result}=await runPreprocessingRequest(input(form,{structure_body:true}),{producer,cacheDir:false});
    assert.equal(result.status,'completed');
    assert.deepEqual(producer.bodyCalls,[{markdown:source,mode:'strong_structuring'}]);
    assert.equal(producer.calls,0);
    assert.equal(result.receipt.model.calls,1);
    assert.equal(result.receipt.body_refinement.input_sha256,sha(source));
    assert.equal(result.artifacts.cleaning_manifest.body_text,source);
  });
}

test('ordinary spoken source uses full-text prose; written source skips body production',async()=>{
  for(const form of ['spoken_transcript','written']) {
    const producer=new SyntheticProducer();
    const {result}=await runPreprocessingRequest(input(form,{}),{producer,cacheDir:false});
    assert.equal(result.status,'completed');
    assert.equal(producer.bodyCalls.length,Number(form==='spoken_transcript'));
    if(producer.bodyCalls.length) assert.equal(producer.bodyCalls[0].mode,'spoken_to_written');
    assert.equal(result.receipt.workflow_route.plan.choices.structure_body.enabled,false);
  }
});

test('explicit strong choice needs no input-form classification and supersedes ordinary editing',()=>{
  assert.deepEqual(requiredRouteLabels({structure_body:true,translate:false,include_reading_guide:false},{}),[]);
  assert.equal(resolveProcessingPlan({structure_body:true,spoken_to_written:true},{}).body_mode,'strong_structuring');
});

test('one-shot guide failure never re-edits the body or starts a repair loop',async()=>{
  const producer=new SyntheticProducer({invalid:true});
  const {result}=await runPreprocessingRequest(input('spoken_transcript',{include_reading_guide:true}),{producer,cacheDir:false});
  assert.equal(producer.bodyCalls.length,1);
  assert.equal(producer.calls,1);
  assert.equal(result.receipt.reading_guide.status,'failed');
  assert.equal(result.receipt.model.calls,2);
});
