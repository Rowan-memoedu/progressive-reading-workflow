import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {organizeSiteFiles} from '../site-import/organization.mjs';
import {articleTaxonomy} from '../site-import/taxonomy.mjs';
import {writeSiteIndexes} from '../site-import/indexes.mjs';
import {saveRun,runId,runPath} from '../site-import/store.mjs';
import {writeJson,readJson,digest} from '../subscription-workflow/config.mjs';
import {findSourcePublication,sourceReuseResult} from '../scripts/reading-source-library.mjs';
import {readingMovePayload,readingStateEqual} from '../site-import/reader-moves.mjs';

test('native reader movement carries paths only, independent of article length',()=>{
  const input=Array.from({length:12},(_,i)=>({source:'D:/reading/'+i+'.md',target:'D:/reading/Course/'+i+'.md',expected:'large article '.repeat(100000)}));
  const text=JSON.stringify(readingMovePayload(input));assert.ok(text.length<10000);assert.equal(text.includes('large article'),false);assert.equal(readingMovePayload(input).length,12);
});
test('reading state comparison ignores object key order but detects changed selections and progress',()=>{
  assert.equal(readingStateEqual({savedAt:'t',scroll:1,cursor:{ch:3,line:2}},{cursor:{line:2,ch:3},scroll:1,savedAt:'t'}),true);
  assert.equal(readingStateEqual({cursor:{line:2,ch:3}},{cursor:{line:2,ch:4}}),false);
});

test('original taxonomy, RSS aliases, duplicate recovery, paths and annotations survive organization',async()=>{
  const previousEnv=process.env.NODE_ENV;process.env.NODE_ENV='test';
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/layout-test-'),source={id:'source',name:'Independent',url:'https://example.test',destination:'整站/Independent'},id=runId('layout');
  try{
    const page='https://example.test/posts/first',rss='https://example.test/reader?id=0',second='https://example.test/posts/second';
    const oldSite=path.join(root,'阅读区',source.destination,'first.md'),oldRss=path.join(root,'阅读区/RSS','first.md'),oldSecond=path.join(root,'阅读区',source.destination,'second.md');
    const texts=new Map([[oldSite,'---\nsource_url: '+page+'\n---\n原文。\n'],[oldRss,'---\nsource_url: '+rss+'\n---\n==既有批注== 与阅读前置卡。\n'],[oldSecond,'---\nsource_url: '+second+'\n---\n第二篇正文与批注。\n']]);
    for(const [file,text]of texts){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
    const request=path.join(root,'request.json');await writeJson(request,{source_metadata:{source_url:rss,original_url:page,original_source_ref:'item-page-original-markdown'}});
    await writeJson(path.join(root,'imports/rss-reading/review-ledger.v1.json'),{items:{first:{item_url:rss,preprocess_request_path:request,publication:{path:oldRss,sha256:digest(texts.get(oldRss))}}}});
    await saveRun(root,{id:runId('prior'),source_id:source.id,created_at:'2026-01-01',results:[{requested_url:page,status:'imported',artifacts:[{kind:'markdown',path:oldSite,sha256:digest(texts.get(oldSite))}]}]});
    const annotation={id:'keep-id',path:'阅读区/'+source.destination+'/second.md',selectedText:'第二篇正文',range:{start:0,end:5}};
    const sidecar=path.join(root,'.local-ir/browser-document-state/second.md.browser-ir.json');await writeJson(sidecar,{document:{path:annotation.path},annotations:[annotation],content:{markdownSha256:digest(texts.get(oldSecond))}});
    const collection={inventory:{articles:[{url:page,title:'First',taxonomy:articleTaxonomy({collections:[{name:'Course',order:0}],tags:['Topic','Extra']})},{url:second,title:'Second',taxonomy:articleTaxonomy({categories:[['Computing','Systems']],tags:['Topic']})}]},results:[sourceReuseResult(page,await findSourcePublication(root,page)),sourceReuseResult(second,await findSourcePublication(root,second))]};
    const report=await organizeSiteFiles(root,source,collection,id);
    assert.equal(report.moved,2);assert.equal(report.duplicates_retired,1);assert.equal(await fs.access(oldSite).then(()=>true,()=>false),false);
    const first=collection.results[0].artifacts[0].path,next=collection.results[1].artifacts[0].path;
    assert.ok(first.includes(path.join('合集','Course')));assert.ok(next.includes(path.join('分类','Computing','Systems')));
    assert.equal(await fs.readFile(first,'utf8'),texts.get(oldRss));assert.equal(await fs.readFile(next,'utf8'),texts.get(oldSecond));
    const state=await readJson(sidecar);assert.deepEqual(state.annotations[0].range,annotation.range);assert.equal(state.annotations[0].id,annotation.id);assert.equal(state.annotations[0].selectedText,annotation.selectedText);assert.equal(state.annotations[0].path,path.relative(root,next).replaceAll('\\','/'));
    assert.equal((await findSourcePublication(root,rss)).path,first);
    const records=collection.results.map(r=>({url:r.requested_url,path:r.artifacts[0].path}));const indexes=await writeSiteIndexes(root,source,collection.inventory,records,id,report);
    assert.match(await fs.readFile(indexes.index,'utf8'),/## 合集/u);assert.equal(indexes.groups.length,4);
    const topic=await fs.readFile(path.join(root,'阅读区',source.destination,'标签/Topic/目录.md'),'utf8');assert.match(topic,/First/u);assert.match(topic,/Second/u);
    // Resume after file moves completed but the journal completion was lost.
    const journal=path.join(runPath(root,id),'organization.json');await writeJson(journal,{...report,status:'running'});
    await organizeSiteFiles(root,source,collection,id);assert.equal(await fs.readFile(first,'utf8'),texts.get(oldRss));
  }finally{if(previousEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousEnv;}
});
