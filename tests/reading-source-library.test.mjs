import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { findSourcePublication, findSourcePublications, sourceReuseResult, withSourcePublication } from '../scripts/reading-source-library.mjs';
import { publishReadingArtifact, runPreprocessingRequest, buildPreprocessRequest } from '../standard-preprocessing/index.mjs';
import { SyntheticProducer } from '../standard-preprocessing/test-support/synthetic-producer.mjs';
import { initialize, paths, writeJson } from '../subscription-workflow/config.mjs';
import { canonicalCatalog } from '../subscription-workflow/catalog.mjs';
import { shortKey } from '../subscription-workflow/report-archive.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';

const base='D:/Artifacts/ProgressiveReading/source-library-tests';
test('Bilibili share links preserve distinct parts while reusing the first-part URL',()=>{
  assert.equal(urlImportDedupeKey('http://bilibili.com/video/BV1234567890/?p=1&vd_source=tracking'),urlImportDedupeKey('https://www.bilibili.com/video/BV1234567890/'));
  assert.notEqual(urlImportDedupeKey('https://www.bilibili.com/video/BV1234567890/?p=2'),urlImportDedupeKey('https://www.bilibili.com/video/BV1234567890/'));
});
test('RSS reader URL and original page reuse proven extraction aliases in both orders',async t=>{
  const root=await fixture(t),reader='https://independent.test/feed/read?id=0',page='https://independent.test/posts/zero';
  const request=path.join(root,'rss-request.json');await writeJson(request,{source_metadata:{source_url:reader,canonical_url:reader,original_url:page,original_source_ref:'item-page-original-markdown'}});
  await writeJson(path.join(root,'imports/rss-reading/review-ledger.v1.json'),{items:{rss:{item_url:reader,preprocess_request_path:request}}});
  const file=await article(root,'阅读区',reader);
  assert.equal((await findSourcePublication(root,page)).path,file);
  await fs.unlink(file);const site=await article(root,'阅读区',page,'site.md');
  assert.equal((await findSourcePublication(root,reader)).path,site);
  const result=await resultForAlias(reader,page);
  const publication=await publishReadingArtifact(result,{publishPath:path.join(root,'阅读区','rss-new.md')});assert.equal(publication.markdown.path,site);assert.equal(publication.preserved_existing,true);
});
test('a completed RSS article wins over a later site copy and stale reading receipt',async t=>{
  const root=await fixture(t),url='https://state.test/post';const stale=await article(root,'阅读区',url,'later-copy.md'),completed=await article(root,'待归档原文',url,'completed.md');
  await writeJson(path.join(root,'imports/rss-reading/review-ledger.v1.json'),{items:{rss:{item_url:url,publication:{path:stale}}}});
  assert.equal((await findSourcePublication(root,url)).path,completed);
});
test('a moved alias publication wins over the canonical duplicate while receipts await repair',async t=>{
  const root=await fixture(t),reader='https://resume.test/feed?id=1',page='https://resume.test/posts/first';
  const duplicate=await article(root,'阅读区',page,'later-copy.md'),preserved=await article(root,'阅读区',reader,'category/preserved.md');
  const request=path.join(root,'request.json');await writeJson(request,{source_metadata:{source_url:reader,original_url:page,original_source_ref:'item-page-original-markdown'}});
  await writeJson(path.join(root,'imports/rss-reading/review-ledger.v1.json'),{items:{rss:{item_url:reader,preprocess_request_path:request,publication:{path:duplicate}}}});
  assert.equal((await findSourcePublication(root,page)).path,preserved);
  assert.equal((await findSourcePublication(root,reader)).path,preserved);
});
async function resultForAlias(reader,page){const value=await result(reader);value.source_metadata={...value.source_metadata,original_url:page,original_source_ref:'item-page-original-markdown'};return value;}
async function fixture(t) {
  await fs.mkdir(base,{recursive:true});
  const root=await fs.mkdtemp(path.join(base,'case-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'阅读区'),{recursive:true});
  return root;
}
async function article(root,zone,url,name='existing.md') {
  const file=path.join(root,zone,'来源',name);
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,`---\nsource_url: ${JSON.stringify(url)}\nstatus: imported\n---\n\n正文与用户批注。\n`);
  return file;
}
async function result(url) {
  const request=buildPreprocessRequest({markdown:'这是完整的中文正文，保留原始事实与具体例子。'.repeat(50),sourceType:'web',sourceMetadata:{source_url:url,title:'测试正文',input_form:'written'},processingOptions:{input_form:'written',content_profile:'natural_language',translate:false,spoken_to_written:false,structure_body:false,include_reading_guide:false}});
  return (await runPreprocessingRequest(request,{producer:new SyntheticProducer(),cacheDir:false})).result;
}
test('all lifecycle zones use normalized URLs, retain meaningful queries, and preserve edited files',async t=>{
  const root=await fixture(t);
  for(const [i,zone] of ['阅读区','待归档原文','已归档原文'].entries()) {
    const file=await article(root,zone,`https://example.test/post-${i}/?b=2&a=1&utm_source=site#part`);
    const before=await fs.readFile(file);
    const match=await findSourcePublication(root,`https://example.test/post-${i}?a=1&b=2`);
    assert.equal(match.path,file);assert.equal(match.zone,zone);
    assert.equal(sourceReuseResult('https://example.test/post-'+i,match).receipt.model_calls,0);
    assert.deepEqual(await fs.readFile(file),before);
    assert.equal(await findSourcePublication(root,`https://example.test/post-${i}?a=1&b=3`),null);
  }
});
test('site first and RSS first both publish a single body and retain the first location and notes',async t=>{
  for(const order of [['整站','RSS'],['RSS','整站']]) {
    const root=await fixture(t),url='https://example.test/post';
    const first=path.join(root,'阅读区',order[0],'正文.md'),second=path.join(root,'阅读区',order[1],'正文.md');
    const generated=await result(url);
    const published=await publishReadingArtifact(generated,{publishPath:first});
    assert.equal(published.markdown.path,first);
    await fs.appendFile(first,'\n用户后续批注。\n');
    const before=await fs.readFile(first);
    const reused=await publishReadingArtifact(generated,{publishPath:second});
    assert.equal(reused.preserved_existing,true);assert.equal(reused.markdown.path,first);
    await assert.rejects(fs.access(second),{code:'ENOENT'});
    assert.deepEqual(await fs.readFile(first),before);
  }
});
test('legacy redirect aliases remain reusable after the document moves to an archive',async t=>{
  const root=await fixture(t),original='https://legacy.test/redirect',canonical='https://legacy.test/article';
  const file=await article(root,'已归档原文',original);
  await writeJson(path.join(root,'.local-ir','browser-document-state','legacy.browser-ir.json'),{document:{sourceUrl:original,path:'阅读区/removed-old-location.md'},browser:{sourceMetadata:{source_url:original,canonical_url:canonical}}});
  assert.equal((await findSourcePublication(root,canonical)).path,file);
});
test('RSS catalog recognizes existing long and short site articles before report splitting',async t=>{
  const root=await fixture(t),rssHome=path.join(root,'rss-home'),videoHome=path.join(root,'video-home');
  await fs.mkdir(rssHome,{recursive:true});
  await fs.writeFile(path.join(rssHome,'RSS 自动导入.md'),'```json\n{"enabled":false}\n```\n## ① 标准流程导入\n## ② 原文直接导入\n## ③ 日报与周报\n测试：https://feed.test/rss\n');
  await writeJson(path.join(videoHome,'watchlist.json'),{watches:[]});
  await initialize(root,{home:path.join(root,'home'),rssHome,videoHome});
  const a=await article(root,'阅读区','https://site.test/long'),b=await article(root,'待归档原文','https://site.test/short');
  const catalog=await canonicalCatalog(root,[{materialId:'long',itemUrl:'https://site.test/long?utm_source=rss',feedUrl:'https://feed.test/rss',route:'long_review'},
    {materialId:'short',itemUrl:'https://site.test/short',feedUrl:'https://feed.test/rss',route:'short_aggregate'}]);
  assert.equal(catalog[0].externallyPublished.path,a);assert.equal(catalog[1].externallyPublished.path,b);
  // An already-owned RSS article retains its existing review/weekly workflow.
  await writeJson(path.join(root,'imports','rss-reading','review-ledger.v1.json'),{items:{long:{material_id:'long',item_url:'https://site.test/long',publication:{path:a}}}});
  assert.equal((await canonicalCatalog(root,[{materialId:'long',itemUrl:'https://site.test/long',route:'long_review'}]))[0].externallyPublished,null);
});
test('short articles in weekly reports and their archives are reusable by URL import',async t=>{
  const root=await fixture(t);
  for(const [i,zone] of ['阅读区','待归档原文'].entries()) {
    const url=`https://short.test/${i}`,item={material_id:'short-'+i,source_revision:'source-revision',item_url:url,delivery:{}};
    const file=path.join(root,zone,'周报.md');const key=shortKey(item);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,i?`<!-- subscriptions:archived-short ${key} -->\n正文批注。`:`<!-- rss-reading:short ${key} -->\n正文批注。`);
    item.delivery[i?'short_archived_path':'short_weekly_path']=file;
    await writeJson(path.join(root,'imports','rss-reading','review-ledger.v1.json'),{items:{[item.material_id]:item}});
    const found=await findSourcePublication(root,url);
    assert.equal(found.path,file);assert.equal(found.aggregate,true);
  }
});
test('concurrent processes share the publication lock and produce only one article',async t=>{
  const root=await fixture(t),url='https://race.test/post';
  const reader='https://race.test/rss/read?id=1',request=path.join(root,'alias.json');
  await writeJson(request,{source_metadata:{source_url:reader,original_url:url,original_source_ref:'item-page-original-markdown'}});
  await writeJson(path.join(root,'imports/rss-reading/review-ledger.v1.json'),{items:{rss:{item_url:reader,preprocess_request_path:request}}});
  const deadPid=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});child.on('error',reject);child.on('exit',()=>resolve(child.pid));});
  const lockRoot=path.join(root,'.local-ir','source-publication-locks');await fs.mkdir(lockRoot,{recursive:true});
  await fs.writeFile(path.join(lockRoot,createHash('sha256').update(url).digest('hex')+'.json'),JSON.stringify({pid:deadPid,token:'stale-owner'}));
  const moduleUrl=new URL('../scripts/reading-source-library.mjs',import.meta.url).href;
  const worker=path.join(root,'worker.mjs');
  await fs.writeFile(worker,`import fs from 'node:fs/promises';import path from 'node:path';import {withSourcePublication,findSourcePublication} from ${JSON.stringify(moduleUrl)};const [root,name]=process.argv.slice(2),url=name==='rss'?${JSON.stringify(reader)}:${JSON.stringify(url)};await withSourcePublication(root,url,async()=>{if(await findSourcePublication(root,url))return;await new Promise(r=>setTimeout(r,80));await fs.writeFile(path.join(root,'阅读区',name+'.md'),${JSON.stringify('---\nsource_url: ')}+url+${JSON.stringify('\n---\n正文')});});`);
  const launch=name=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[worker,root,name],{windowsHide:true,stdio:['ignore','ignore','pipe']});let error='';child.stderr.on('data',v=>error+=v);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error)));});
  await Promise.all([launch('site'),launch('rss')]);
  assert.equal((await fs.readdir(path.join(root,'阅读区'))).filter(x=>x.endsWith('.md')).length,1);
});
test('a combined source keeps its native part identity rather than collapsing into its first part',async t=>{
  const root=await fixture(t),url='https://video.test/watch?p=1';
  const single=await article(root,'阅读区',url,'first-part.md');
  const generated=await result(url);
  generated.source_metadata.source_parts=[{part:1,source_url:url},{part:2,source_url:'https://video.test/watch?p=2'}];
  const combined=await publishReadingArtifact(generated,{publishPath:path.join(root,'阅读区','combined.md')});
  assert.notEqual(combined.markdown.path,single);
  const again=await publishReadingArtifact(generated,{publishPath:path.join(root,'阅读区','other-folder','combined.md')});
  assert.equal(again.markdown.path,combined.markdown.path);assert.equal(again.preserved_existing,true);
  assert.equal((await findSourcePublication(root,url)).path,single);
});
