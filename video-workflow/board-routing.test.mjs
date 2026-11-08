import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {runBoardCorrectionJobs} from './run-board-correction.mjs';

async function fixture(){
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/board-routing-');
  const image=path.join(root,'image.png'),inputFile=path.join(root,'jobs.jsonl'),promptFile=path.join(root,'prompt.md');
  await fs.writeFile(image,Buffer.from('fixture image bytes'));
  await fs.writeFile(inputFile,JSON.stringify({id:'board',input:'read actual image',requires_visual:true,images:[{path:image}]})+'\n');
  await fs.writeFile(promptFile,'校订图片：{{input}}');
  return {inputFile,promptFile,outputDir:path.join(root,'run'),image,config:{AI_PRODUCER_PROVIDER:'codex_exec',AI_PRODUCER_CODEX_MODEL:'fixture-model'}};
}

test('visual jobs attach local images to the shared producer, freeze output and replay without a second request',async()=>{
  const f=await fixture();let calls=0;
  const request=async(config,payload)=>{
    calls++;assert.equal(config.AI_PRODUCER_PROVIDER,'codex_exec');assert.equal(payload.requiresVisual,true);
    assert.equal(payload.images[0].path,f.image);assert.equal(payload.images[0].sha256.length,64);
    return {provider:'codex_exec',model:'fixture-model',image_count:1,
      choices:[{finish_reason:'stop',message:{content:'{"observations":["fixture"]}'}}]};
  };
  const first=await runBoardCorrectionJobs({...f,request});assert.equal(first.calls_this_run,1);
  const replay=await runBoardCorrectionJobs({...f,request});assert.equal(replay.calls_this_run,0);assert.equal(calls,1);
  await assert.rejects(runBoardCorrectionJobs({...f,request,config:{...f.config,AI_PRODUCER_CODEX_MODEL:'other'}}),/input_or_backend_changed/);
  await fs.writeFile(f.image,'changed source image');
  await assert.rejects(runBoardCorrectionJobs({...f,request}),/input_or_backend_changed/);assert.equal(calls,1);
});

test('API override, missing image, unknown request outcome and legacy results never trigger fallback',async()=>{
  const f=await fixture();let calls=0;
  const request=async()=>{calls++;throw Error('codex_failed');};
  await assert.rejects(runBoardCorrectionJobs({...f,request,config:{AI_PRODUCER_PROVIDER:'deepseek'}}),/requires_codex_exec/);
  await assert.rejects(runBoardCorrectionJobs({...f,request}),/codex_failed/);
  await assert.rejects(runBoardCorrectionJobs({...f,request}),/EEXIST/);assert.equal(calls,1);
  const legacy=await fixture();await fs.mkdir(legacy.outputDir);await fs.writeFile(path.join(legacy.outputDir,'results.jsonl'),'old API response');
  await assert.rejects(runBoardCorrectionJobs({...legacy,request}),/legacy_board_cache/);assert.equal(calls,1);
  const noImage=await fixture();await fs.writeFile(noImage.inputFile,JSON.stringify({id:'missing',input:'no images',requires_visual:true})+'\n');
  await assert.rejects(runBoardCorrectionJobs({...noImage,request}),/actual_images_required/);assert.equal(calls,1);
});
