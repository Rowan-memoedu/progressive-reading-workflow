import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveSubtitleSource} from './subtitle-source.mjs';
import {bookPublicationPath} from './book-folder.mjs';

test('multipart source preserves upstream identity and never selects a different part',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/part-source-fixture-');
  const id='BV1234567890',url='https://www.bilibili.com/video/'+id+'/';
  for(const name of [id,id+'_p1',id+'_p2']) {
    await fs.mkdir(path.join(root,name));
    await fs.writeFile(path.join(root,name,'transcript.json'),JSON.stringify({video_id:name,video_url:url}));
  }
  assert.equal((await resolveSubtitleSource(root,url,id)).video_id,id+'_p1');
  assert.equal((await resolveSubtitleSource(root,url+'?p=2',id)).video_id,id+'_p2');
  await assert.rejects(resolveSubtitleSource(root,url+'?p=3',id),/not_found/);
  assert.match(bookPublicationPath(path.join(root,id+'（图文模式）.md'),{video_id:id+'_p1',title:'实验课程'}),/实验课程（图文模式）\.md$/u);
});
