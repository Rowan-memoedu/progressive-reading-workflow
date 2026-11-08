import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {writeCapturePlan} from './capture-plan.mjs';

test('unreviewed candidates may extend inside the original window without changing source identity',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/capture-extension-fixture-');
  const file=path.join(root,'capture-plan.json');
  const initial={version:'fixture',frames:[{file:'shot_00_00_10.png',requested_time:'00:00:10',window_end:'00:00:18',title:'力学作图',candidates:['00:00:10']}]};
  await writeCapturePlan(file,initial);
  const extended=structuredClone(initial);extended.frames[0].candidates.push('00:00:18');
  await writeCapturePlan(file,extended);assert.equal((await fs.readdir(path.join(root,'frozen-inputs'))).length,1);
  const changed=structuredClone(extended);changed.frames[0].title='另一主题';
  await assert.rejects(writeCapturePlan(file,changed),/identity_changed/);
  const outside=structuredClone(extended);outside.frames[0].candidates.push('00:00:19');
  await assert.rejects(writeCapturePlan(file,outside),/not_bounded/);
  await fs.writeFile(path.join(root,'frame-review.json'),'{}');
  await assert.rejects(writeCapturePlan(file,initial),/already_reviewed/);
});

test('timestamp admission freezes the same capture plan even without semantic review',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/capture-admission-fixture-');
  const file=path.join(root,'capture-plan.json');
  const initial={version:'fixture',frames:[{file:'shot_00_00_10.png',requested_time:'00:00:10',window_end:'00:00:12',candidates:['00:00:10']}]};
  await writeCapturePlan(file,initial);await fs.writeFile(path.join(root,'frame-admission.json'),'{}');
  await writeCapturePlan(file,initial);
  const changed=structuredClone(initial);changed.frames[0].candidates.push('00:00:12');
  await assert.rejects(writeCapturePlan(file,changed),/already_admitted/);
});
