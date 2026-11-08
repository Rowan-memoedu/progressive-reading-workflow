import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {startFixture} from './browser-import-web/fixture.mjs';

const fixture = await startFixture();
const post = async (route, body) => {
  const response = await fetch(fixture.baseUrl + route, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)});
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
};
const artifact = (result,kind) => result.artifacts.find(item=>item.kind===kind).path;
try {
  const samples = [
    String.raw`\sqrt{1+\text{history_correct}}`,
    String.raw`x_i+\texttt{sensor_value}+\text{already\_safe}`
  ];
  for (const [i, tex] of samples.entries()) {
    const draft={id:`shared-save-${i}`,url:fixture.sourceUrl+`/snapshot-${i}`,title:`统一保存样本 ${i}`,revision:0,
      html:`<article><h1>统一保存样本 ${i}</h1><p>应当保留来源、公式和批注。<span data-tex="${tex}">公式视觉层</span></p><p>正文在关闭导读时不调用生成器；开启导读时使用同一标准处理器，最终写入结果与回执一致。</p><p>来源快照是唯一输入，不应重新抓取网址。</p></article>`,
      sourceMetadata:{input_form:'written',content_profile:'natural_language',language:'zh'},annotations:[],qaCards:[]};
    const save=await post('/api/highlights/commit',{draft});
    assert.equal(save.receipt.processing_mode,'standard_preprocess');
    assert.equal(save.receipt.reading_guide.status,'skipped');
    assert.equal(save.receipt.model_calls,0);
    const saved=await fs.readFile(artifact(save,'markdown'),'utf8');
    assert.doesNotMatch(saved,/## 阅读前置卡|## 核心洞察/);
    assert.ok(saved.includes(tex.replace(/(?<!\\)_(?=correct|value)/gu,'\\_')));
    const audit=JSON.parse(await fs.readFile(artifact(save,'standard_preprocess_audit')+'/result.json','utf8'));
    assert.ok(audit.artifacts.cleaning_manifest.source_nodes.some(n=>n.text.includes(tex)),'source audit must keep literal source TeX');
    const metadata=JSON.parse(await fs.readFile(artifact(save,'browser_ir_metadata'),'utf8'));
    assert.equal(metadata.content.markdownSha256,createHash('sha256').update(saved).digest('hex'));
    const complete=await post('/api/highlights/complete',{draft});
    assert.equal(complete.status,'completed_pending_archive');
    assert.match(artifact(complete,'markdown'),/待归档原文/);
    assert.equal(complete.receipt.reading_guide.status,'skipped');
    assert.match(await fs.readFile(artifact(complete,'markdown'),'utf8'),/^status: "done"$/mu);
    const imported=await post('/api/highlights/import-local',{draft:{...draft,id:`import-${i}`,url:fixture.sourceUrl+`/import-${i}`}});
    assert.equal(imported.receipt.processing_mode,save.receipt.processing_mode);
    assert.equal(imported.receipt.processor_version,save.receipt.processor_version);
    assert.equal(imported.receipt.reading_guide.status,'generated');
    const local=await fs.readFile(artifact(imported,'markdown'),'utf8');
    assert.match(local,/## 阅读前置卡/);
    assert.ok(local.includes(tex.replace(/(?<!\\)_(?=correct|value)/gu,'\\_')));
  }
  // The async endpoint used by the installed extension must carry the same preset.
  const queued=await post('/api/highlights/import-local',{async:true,client_request_id:'shared-save-async',draft:{id:'async',url:fixture.sourceUrl+'/async',title:'异步导入',pageText:'来源快照与异步任务在重试后仍然保留。需要生成导读并保留原文，使用同一个标准处理器。',sourceMetadata:{input_form:'written',content_profile:'math_lecture',language:'zh'}}});
  let finished;
  for(let i=0;i<150;i++) {
    const request=await (await fetch(fixture.baseUrl+`/api/browser-import/requests/${queued.request_id}`)).json();
    if(request.terminal){finished=request.results[0];break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(finished?.receipt?.reading_guide?.status,'generated',JSON.stringify(finished));
  assert.equal(fixture.hits.length,0,'all snapshot actions must avoid URL refetch');
  console.log(JSON.stringify({status:'passed',root:fixture.root,checks:['save-standard-no-model','import-standard-guide','complete-destination','math-compatibility','source-audit-preserved','metadata-hash','async-explicit-guide','no-refetch']}));
} finally {await fixture.stop();}
