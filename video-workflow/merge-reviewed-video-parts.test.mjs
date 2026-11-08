import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mergeReviewedVideoParts} from './merge-reviewed-video-parts.mjs';
test('independent consecutive parts merge without changing subtitle text or image bytes and replay exactly',async()=>{
 const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/collection-fixture-'),parts=[];
 for(const part of [5,6]){
  const dir=path.join(root,'p'+part),run=path.join(dir,'run');await fs.mkdir(path.join(dir,'images'),{recursive:true});await fs.mkdir(run);
  const bytes=Buffer.from('image-'+part),sha256=createHash('sha256').update(bytes).digest('hex'),file='shot_00_00_10.png';await fs.writeFile(path.join(dir,'images',file),bytes);
  const transcript={video_id:'BV1test123456_p'+part,video_url:'https://www.bilibili.com/video/BV1test123456/?p='+part,title:'章节'+part,duration:60,segments:[{start:'00:00:00',end:'00:01:00',text:'完整原文'+part}]};
  await fs.writeFile(path.join(dir,'transcript.json'),JSON.stringify(transcript));
  await fs.writeFile(path.join(dir,'book.md'),'# 讲义\n\n## 图\n\n*(参考时间: 00:00:10)*\n\n![图](images/'+file+')\n');
  await fs.writeFile(path.join(run,'capture-receipt.json'),JSON.stringify({status:'completed',frames:[{file,sha256}],frame_review:{status:'passed'}}));parts.push({part,inputDir:dir,runDir:run});
 }
 const args={parts,outputDir:path.join(root,'combined'),title:'两章合订'},first=await mergeReviewedVideoParts(args),again=await mergeReviewedVideoParts(args);
 assert.deepEqual(first,again);assert.equal(first.transcript.segments[1].start,'00:01:00');assert.equal(first.transcript.segments[1].text,'完整原文6');
 assert.deepEqual(await fs.readFile(path.join(root,'p6/images/shot_00_00_10.png')),await fs.readFile(path.join(root,'combined/images/shot_00_01_10.png')));
 await fs.writeFile(path.join(parts[0].runDir,'capture-receipt.json'),'{}');await assert.rejects(mergeReviewedVideoParts(args),/frame_review_required/);
});
