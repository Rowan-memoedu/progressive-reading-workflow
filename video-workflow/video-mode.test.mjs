import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolveVideoMode} from './video-mode.mjs';
import {screenshotTiming} from './media-timing.mjs';
import {bookPublicationPath} from './book-folder.mjs';

test('video mode is opt-in and never inferred from a title or vague value',()=>{
  for(const value of [undefined,null,'','transcript'])assert.equal(resolveVideoMode(value).enabled,false);
  for(const value of ['illustrated','图文模式','illustrated_strong']){
    assert.equal(resolveVideoMode(value).name,'图文模式');assert.equal(resolveVideoMode(value).explicit,true);
  }
  for(const value of [true,false,'auto','strong_structuring','视频含图片'])assert.throws(()=>resolveVideoMode(value),/unknown_video_mode/);
  assert.match(bookPublicationPath('D:/Artifacts/fixture/BV1Zx2345678（图文模式）.md',{video_id:'BV1Zx2345678',title:'课程材料'}),/课程材料（图文模式）\.md$/u);
});

test('the real PowerShell entry stays on transcript unless explicitly enabled',()=>{
  const common=['-NoProfile','-File','video-workflow/run-workflow.ps1','-InputDir','D:/Artifacts/fixture/nonexistent',
    '-OutputDir','D:/Artifacts/fixture/unused','-PublishPath','D:/Artifacts/fixture/unused.md','-Describe'];
  const call=extra=>JSON.parse(execFileSync('pwsh',[...common,...extra],{encoding:'utf8',windowsHide:true}));
  assert.equal(call([]).entry,'import-transcript.mjs');
  for(const name of ['illustrated','图文模式','illustrated_strong'])assert.equal(call(['-OutputType',name]).entry,'illustrated-strong.mjs');
  assert.match(execFileSync(process.execPath,['video-workflow/run-authenticated.mjs','--help'],{encoding:'utf8'}),/默认字幕模式/);
});

test('an independent demonstration captures after completion and bounds all alternatives',()=>{
  const transcript={duration:90,segments:[{start:'00:00:10',end:'00:00:13',text:'现在开始点击导出按钮。'},
    {start:'00:00:21',end:'00:00:24',text:'导出的表格已经显示完成状态。'}]};
  const item={scene:'demonstration',time:'00:00:25',window_end:'00:00:28',expected_visual:'导出成功提示与表格',
    result_start:'00:00:21',result_quote:'表格已经显示完成状态'};
  assert.deepEqual(screenshotTiming(item,transcript).candidates,['00:00:25','00:00:27']);
  assert.throws(()=>screenshotTiming({...item,time:'00:00:21'},transcript),/capture_before_result/);
  assert.throws(()=>screenshotTiming({...item,result_quote:'没有说过的结果'},transcript),/not_exact_source/);
  assert.throws(()=>screenshotTiming({...item,time:'00:01:20',window_end:'00:01:22'},transcript),/outside_scene/);
  assert.deepEqual(screenshotTiming({scene:'static',time:'00:00:30',window_end:'00:00:36',expected_visual:'标注已完成的几何图'},transcript).candidates,['00:00:30','00:00:36']);
});
