import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {organizeSiteFiles,remapReceipts} from '../site-import/organization.mjs';
import {articleTaxonomy} from '../site-import/taxonomy.mjs';
import {writeSiteIndexes} from '../site-import/indexes.mjs';
import {saveRun,runId,runPath} from '../site-import/store.mjs';
import {writeJson,readJson,digest} from '../subscription-workflow/config.mjs';
import {findSourcePublication,sourceReuseResult} from '../scripts/reading-source-library.mjs';
import {readingMovePayload,readingStateEqual,moveReaderFile} from '../site-import/reader-moves.mjs';

test('batch reader move uses the vault API and the existing reader state handler',async()=>{
  const file={path:'old.md'},calls=[];
  const plugin={managedRenamePaths:new Set(),ensureFolder:async folder=>calls.push(folder),handleVaultRename:async(f,old,managed)=>{assert.equal(plugin.managedRenamePaths.has(old),true);calls.push([f.path,old,managed]);}};
  const app={vault:{getAbstractFileByPath:p=>p==='old.md'?file:null,rename:async(f,to)=>{f.path=to;}}};
  assert.equal(await moveReaderFile(app,plugin,'old.md','Course/new.md'),'Course/new.md');
  assert.deepEqual(calls,['Course',['Course/new.md','old.md',true]]);assert.equal(plugin.managedRenamePaths.size,0);
});

test('native reader movement carries paths only, independent of article length',()=>{
  const input=Array.from({length:12},(_,i)=>({source:'D:/reading/'+i+'.md',target:'D:/reading/Course/'+i+'.md',expected:'large article '.repeat(100000)}));
  const text=JSON.stringify(readingMovePayload(input));assert.ok(text.length<10000);assert.equal(text.includes('large article'),false);assert.equal(readingMovePayload(input).length,12);
});
test('reading state comparison ignores object key order but detects changed selections and progress',()=>{
  assert.equal(readingStateEqual({savedAt:'t',scroll:1,cursor:{ch:3,line:2}},{cursor:{line:2,ch:3},scroll:1,savedAt:'t'}),true);
  assert.equal(readingStateEqual({cursor:{line:2,ch:3}},{cursor:{line:2,ch:4}}),false);
});

test('reference repair updates both publication and document-state body hashes',()=>{
  const root=path.resolve('D:/Artifacts/ProgressiveReading/receipt-fixture'),file=path.join(root,'阅读区/Topic/article.md'),hash=digest('updated relative link');
  const result=remapReceipts({artifacts:[{kind:'markdown',path:file,sha256:'old'}],receipt:{final_markdown_sha256:'old'},document:{path:'阅读区/Topic/article.md'},content:{markdownSha256:'old'}},new Map(),root,new Map([[file,hash]]));
  assert.equal(result.artifacts[0].sha256,hash);assert.equal(result.receipt.final_markdown_sha256,hash);assert.equal(result.content.markdownSha256,hash);
});

test('generated index ownership survives checked relocation and still protects handwritten edits',async()=>{
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/index-owner-'),settings={id:'owned',name:'Independent',url:'https://index-owner.test',destination:'整站/Independent'},id=runId('owned'),file=path.join(root,'阅读区',settings.destination,'目录.md'),url='https://index-owner.test/post';
  await fs.mkdir(path.dirname(file),{recursive:true});const relocated='# Old generated index after relocation\n';await fs.writeFile(file,relocated);
  await saveRun(root,{id,source_id:settings.id,created_at:'2026-01-01',results:[]});await writeJson(path.join(runPath(root,id),'index.json'),{path:file,sha256:digest('before relocation')});await writeJson(path.join(runPath(root,id),'organization.json'),{status:'completed',owned_index_hashes:[[file,digest(relocated)]]});
  const inventory={articles:[{url,title:'First',taxonomy:articleTaxonomy({tags:['Topic']})}]},records=[{url,path:path.join(path.dirname(file),'标签/Topic/first.md')}];
  const written=await writeSiteIndexes(root,settings,inventory,records,runId('owned-next'));assert.equal(written.index,file);assert.match(await fs.readFile(file,'utf8'),/## 标签/u);
  await fs.appendFile(file,'\nHandwritten note\n');const before=await fs.readFile(file,'utf8'),next=await writeSiteIndexes(root,settings,{articles:[]},[],runId('owned-edited'));assert.notEqual(next.index,file);assert.equal(await fs.readFile(file,'utf8'),before);
});

test('Windows source tags with different casing do not move a file onto itself',{skip:process.platform!=='win32'},async()=>{
  const env=process.env.NODE_ENV;process.env.NODE_ENV='test';
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/layout-case-');
  try{const source={id:'case',destination:'整站/Independent'},url='https://case-layout.test/post',file=path.join(root,'阅读区',source.destination,'标签/Topic/article.md'),text='---\nsource_url: '+url+'\n---\n正文';await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);await saveRun(root,{id:runId('case-prior'),source_id:source.id,created_at:'2026-01-01',results:[{requested_url:url,status:'imported',artifacts:[{kind:'markdown',path:file.replace('Topic','topic'),sha256:digest(text)}]}]});const collection={inventory:{articles:[{url,taxonomy:articleTaxonomy({tags:['topic']})}]},results:[sourceReuseResult(url,await findSourcePublication(root,url))]};const report=await organizeSiteFiles(root,source,collection,runId('case'));assert.equal(report.moved,0);assert.equal(report.duplicates_retired,0);assert.equal(await fs.readFile(file,'utf8'),text);}finally{if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;}
});

test('an interrupted case-only duplicate decision restores the original before resuming',{skip:process.platform!=='win32'},async()=>{
  const env=process.env.NODE_ENV;process.env.NODE_ENV='test';const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/layout-case-resume-');
  try{const source={id:'case-resume',destination:'整站/Independent'},url='https://case-resume.test/post',from=path.join(root,'阅读区',source.destination,'标签/Topic/article.md'),to=from.replace('Topic','topic'),text='---\nsource_url: '+url+'\n---\n原文';const old=runId('case-bad'),recovery=path.join(runPath(root,old),'recovery');await fs.mkdir(recovery,{recursive:true});await fs.writeFile(path.join(recovery,'duplicate-'+digest(from)+'.md'),text);await saveRun(root,{id:old,source_id:source.id,created_at:'2026-01-01',results:[]});await writeJson(path.join(runPath(root,old),'organization.json'),{status:'running',moves:[],duplicates:[{source:from,winner:to,sha256:digest(text)}],mapping:[[from,to]],recovery,ownedIndexes:[]});const collection={inventory:{articles:[{url,taxonomy:articleTaxonomy({tags:['Topic']})}]},results:[{requested_url:url,status:'idempotent_replay',artifacts:[{kind:'markdown',path:to,sha256:digest(text)}]}]};await organizeSiteFiles(root,source,collection,runId('case-recovered'));assert.equal(await fs.readFile(from,'utf8'),text);assert.equal((await readJson(path.join(runPath(root,old),'organization.json'))).same_location_restored,1);}finally{if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;}
});

test('a new entry retry resumes native moves and repairs relative links before replanning',async()=>{
  const env=process.env.NODE_ENV;process.env.NODE_ENV='test';
  const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/layout-resume-');
  try{
    const source={id:'independent',destination:'整站/Independent'},oldId=runId('interrupted'),id=runId('retry'),url='https://resume-layout.test/post';
    const from=path.join(root,'阅读区',source.destination,'article.md'),to=path.join(root,'阅读区',source.destination,'标签/Topic/article.md');
    const text='---\nsource_url: '+url+'\n---\n![original](images/example.png)\n';
    const recovery=path.join(runPath(root,oldId),'recovery');await fs.mkdir(recovery,{recursive:true});await fs.mkdir(path.dirname(to),{recursive:true});await fs.writeFile(to,text);await fs.writeFile(path.join(recovery,digest(from)+'.md'),text);
    const result={requested_url:url,status:'imported',artifacts:[{kind:'markdown',path:from,sha256:digest(text)}]};
    await saveRun(root,{id:oldId,source_id:source.id,created_at:'2026-01-01',results:[result]});
    await writeJson(path.join(runPath(root,oldId),'organization.json'),{status:'running',moves:[{source:from,target:to,sha256:digest(text)}],duplicates:[],mapping:[[from,to]],recovery,ownedIndexes:[]});
    const collection={inventory:{articles:[{url,title:'Article',taxonomy:articleTaxonomy({tags:['Topic']})}]},results:[{...result,artifacts:[{kind:'markdown',path:to,sha256:digest(text)}]}]};
    await organizeSiteFiles(root,source,collection,id);
    assert.match(await fs.readFile(to,'utf8'),/\.\.\/\.\.\/images\/example\.png/u);
    assert.equal((await readJson(path.join(runPath(root,oldId),'organization.json'))).status,'completed');
    assert.equal(collection.results[0].artifacts[0].path,to);
  }finally{if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;}
});

test('a later completed migration prevents replaying an older obsolete move',async()=>{
  const env=process.env.NODE_ENV;process.env.NODE_ENV='test';const root=await fs.mkdtemp('D:/Artifacts/ProgressiveReading/layout-obsolete-');
  try{const source={id:'resume',destination:'整站/Independent'},url='https://obsolete-layout.test/post',file=path.join(root,'已归档原文','article.md'),text='---\nsource_url: '+url+'\n---\n已读正文';await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);
    const old=runId('obsolete'),done=runId('done');await saveRun(root,{id:old,source_id:source.id,created_at:'2026-01-01',results:[]});await writeJson(path.join(runPath(root,old),'organization.json'),{status:'running',moves:[{source:'missing-old-reading-file',target:'missing-old-destination'}],recovery:'missing'});await saveRun(root,{id:done,source_id:source.id,created_at:'2026-01-02',results:[]});await writeJson(path.join(runPath(root,done),'organization.json'),{status:'completed'});
    const collection={inventory:{articles:[{url,taxonomy:articleTaxonomy({tags:['Topic']})}]},results:[sourceReuseResult(url,await findSourcePublication(root,url))]};const report=await organizeSiteFiles(root,source,collection,runId('new'));assert.equal(report.moved,0);assert.equal(report.mapping.length,0);assert.equal(collection.results[0].artifacts[0].path,file);
  }finally{if(env===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=env;}
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
