// Real configured producer, isolated output. Never publishes into the user's reading pool.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {startFixture} from './browser-import-web/fixture.mjs';

const fixture=await startFixture({producer:''});
const post=async(route,body)=>{
  const response=await fetch(fixture.baseUrl+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(600000)});
  const result=await response.json();
  assert.ok(response.ok,JSON.stringify(result));
  return result;
};
try {
  const draft={id:'independent-sensor-canary',url:fixture.sourceUrl+'/sensor-canary',title:'测量记录与校准',revision:0,annotations:[],qaCards:[],
    sourceMetadata:{input_form:'written',content_profile:'natural_language',language:'zh'},
    html:String.raw`<article><h1>测量记录与校准</h1><p>传感器每隔十秒记录一次读数。比较两个传感器时，需要使用同一时钟，并保留原始测量值。</p><p>记录中的名称 <span data-tex="\text{sensor_value}">sensor_value</span> 表示原始读数；数学下标 <span data-tex="x_i">x_i</span> 表示第 i 次测量。</p><p>如果两个传感器的偏差超过百分之三，就暂停采样并重新校准。完成校准后，应记录校准时间，再开始下一轮测量。</p></article>`};
  const save=await post('/api/highlights/commit',{draft});
  assert.equal(save.receipt.model_calls,0);
  assert.equal(save.receipt.reading_guide.status,'skipped');
  console.log('real_canary: direct save passed, generating guide');
  const imported=await post('/api/highlights/import-local',{draft});
  assert.equal(imported.receipt.reading_guide.status,'generated');
  assert.equal(imported.receipt.processor_version,save.receipt.processor_version);
  const markdownPath=imported.artifacts.find(a=>a.kind==='markdown').path;
  const markdown=await fs.readFile(markdownPath,'utf8');
  assert.match(markdown,/## 阅读前置卡/);
  assert.ok(markdown.includes(String.raw`$\text{sensor\_value}$`));
  assert.ok(markdown.includes('$x_i$'));
  assert.equal(fixture.hits.length,0);
  const report={status:'passed',isolated:true,root:fixture.root,markdownPath,save:save.receipt,import:imported.receipt};
  await fs.writeFile(path.join(fixture.root,'real-canary.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,root:fixture.root,markdownPath,processor:imported.receipt.processor_version,saveCalls:save.receipt.model_calls,guideStatus:imported.receipt.reading_guide.status,guideCalls:imported.receipt.model_calls}));
} finally {await fixture.stop();}
