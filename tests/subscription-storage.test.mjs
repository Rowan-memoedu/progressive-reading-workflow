import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SCHEMA,paths,normalizeSource,writeJson,readJson,digest} from '../subscription-workflow/config.mjs';
import {readingDestination} from '../subscription-workflow/reading-options.mjs';
import {planReadingOrganization,organizeReadingSubscriptions} from '../subscription-workflow/reading-organization.mjs';
import {relocatedMarkdown} from '../subscription-workflow/report-archive.mjs';

test('all source types route below subscription and source-specific folders without repeated nesting',()=>{
  for(const [kind,folder]of [['rss','RSS'],['zhihu_column','知乎专栏'],['zhihu_author','知乎作者'],['bilibili_collection','B站合集'],['bilibili_video','B站多P视频']]){
    const expected=path.join('订阅',folder,'Synthetic source');
    assert.equal(readingDestination({subscription_kind:kind,subscription_name:'Synthetic source',destination:'Legacy'}),expected);
    assert.equal(readingDestination({subscription_kind:kind,subscription_name:'Synthetic source',destination:expected}),expected);
    assert.equal(normalizeSource({kind,name:'Synthetic source',url:kind==='rss'?'https://feed.test/rss':kind==='zhihu_column'?'https://www.zhihu.com/column/example':kind==='zhihu_author'?'https://www.zhihu.com/people/example':'https://www.bilibili.com/video/BV1234567890/',mode:'reports'}).destination,expected);
  }
});

async function fixture(){
  const artifact='D:/Artifacts/ProgressiveReading/subscription-storage-tests';await fs.mkdir(artifact,{recursive:true});
  const root=await fs.mkdtemp(path.join(artifact,'case-')),home=path.join(root,'home'),rssHome=path.join(root,'rss'),videoHome=path.join(root,'video');
  const rss=normalizeSource({kind:'rss',name:'Synthetic feed',url:'https://feed.test/rss',mode:'reports'}),column=normalizeSource({kind:'zhihu_column',name:'Synthetic column',url:'https://www.zhihu.com/column/example',mode:'reports'});
  const video=normalizeSource({kind:'bilibili_collection',name:'Synthetic collection',url:'https://www.bilibili.com/video/BV1234567890/',mode:'reports'});video.destination='视频/Synthetic collection';video.watch={id:'fixture-watch',destination:path.join(root,'阅读区',video.destination)};
  const config={schema:SCHEMA,revision:1,enabled:true,rss_home:rssHome,video_home:videoHome,subscriptions:[rss,column,video]};
  await writeJson(paths(root).marker,{home});await writeJson(paths(root).config,config);
  for(const zone of ['阅读区','已归档原文','待归档原文'])await fs.mkdir(path.join(root,zone),{recursive:true});
  const article=path.join(root,'阅读区/RSS/annotated.md'),archived=path.join(root,'已归档原文/legacy.md'),clip=path.join(root,'阅读区',video.destination,'part','video.md'),image=path.join(path.dirname(clip),'images','shot.png');
  await fs.mkdir(path.dirname(article),{recursive:true});await fs.mkdir(path.dirname(image),{recursive:true});
  await fs.writeFile(article,'---\nsource_url: https://feed.test/a\n---\nBody.\n> Original annotation.\n');
  await fs.writeFile(archived,'---\nsource_url: https://zhuanlan.zhihu.com/p/123\n---\nArchived annotation.\n');
  await fs.writeFile(clip,'Video content.\n![frame](images/shot.png)\n');await fs.writeFile(image,Buffer.from([0,7,255,14]));
  const frozen=path.join(path.dirname(clip),'_assets/source/original.md');await fs.mkdir(path.dirname(frozen),{recursive:true});await fs.writeFile(frozen,'![frozen](images/shot.png)\nOriginal source bytes.\n');
  const short=path.join(root,'待归档原文/订阅/短文/Synthetic feed.md');await fs.mkdir(path.dirname(short),{recursive:true});await fs.writeFile(short,`# Synthetic feed\n<!-- subscriptions:archive-source ${rss.id} -->\nArchived short body and annotation.\n`);
  const ledgerPath=path.join(root,'imports/rss-reading/review-ledger.v1.json');
  await writeJson(ledgerPath,{items:{a:{item_url:'https://feed.test/a',subscription_ids:[rss.id],platform:'rss',publication:{path:article,sha256:digest(await fs.readFile(article)),status:'published'}},b:{item_url:'https://zhuanlan.zhihu.com/p/123',subscription_ids:[column.id],platform:'zhihu',publication:{path:archived,status:'archived'}}},short_archive_sources:{[rss.id]:'Synthetic feed.md'}});
  await writeJson(path.join(rssHome,'state.json'),{items:{a:{feeds:[rss.url],artifacts:[{path:article}]}}});
  await writeJson(path.join(videoHome,'state.json'),{entries:{v:{watch_ids:['fixture-watch'],publication:clip}}});
  const report=path.join(paths(root).summaryRoot,'report.md');await fs.mkdir(path.dirname(report),{recursive:true});await fs.writeFile(report,`[Read](<${article.replaceAll('\\','/')}>)\n`);
  const sidecar=path.join(root,'.local-ir/browser-document-state/annotated.md.browser-ir.json');await writeJson(sidecar,{document:{path:'Projects/Reading/阅读区/RSS/annotated.md'},browser:{sourceMetadata:{}},annotations:[{text:'Original annotation.'}]});
  return {root,config,rss,column,video,article,archived,clip,image,frozen,short,ledgerPath,report,sidecar};
}

test('migration covers reading and archived bodies, video assets, short archives and reference readback',async()=>{
  const f=await fixture(),planned=await planReadingOrganization(f.root);assert.equal(planned.moves.length,6);
  const result=await organizeReadingSubscriptions(f.root,{recoveryRoot:path.join(f.root,'recovery')});assert.equal(result.status,'completed');
  for(const move of result.moves){assert.equal(await fs.readFile(move.target).then(digest),move.destination_sha256);await assert.rejects(fs.access(move.source),{code:'ENOENT'});}
  const updated=await readJson(f.ledgerPath);assert.match(await fs.readFile(updated.items.a.publication.path,'utf8'),/> Original annotation\./);
  assert.equal(updated.items.b.publication.status,'archived');assert.ok(updated.items.b.publication.path.includes(path.join('已归档原文','订阅','知乎专栏','Synthetic column')));
  const targetClip=result.moves.find(m=>m.source===f.clip).target;assert.deepEqual(await fs.readFile(path.join(path.dirname(targetClip),'images/shot.png')),Buffer.from([0,7,255,14]));
  assert.equal(await fs.readFile(path.join(path.dirname(targetClip),'_assets/source/original.md'),'utf8'),'![frozen](images/shot.png)\nOriginal source bytes.\n');
  const sidecar=await readJson(f.sidecar);assert.equal(sidecar.document.path,'Projects/Reading/阅读区/订阅/RSS/Synthetic feed/annotated.md');assert.equal(sidecar.annotations[0].text,'Original annotation.');
  assert.match(await fs.readFile(f.report,'utf8'),/订阅\/RSS\/Synthetic feed/);assert.equal(updated.short_archive_sources[f.rss.id],'RSS/Synthetic feed/短文归档.md');
  assert.equal((await organizeReadingSubscriptions(f.root,{recoveryRoot:path.join(f.root,'recovery-again')})).moves.length,0);
});

test('a destination collision blocks before moving or overwriting any article',async()=>{
  const f=await fixture(),target=path.join(f.root,'阅读区',readingDestination({subscription_kind:'rss',subscription_name:f.rss.name}),'annotated.md');await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,'Another user body.');
  await assert.rejects(organizeReadingSubscriptions(f.root,{recoveryRoot:path.join(f.root,'recovery')}),/destination_collision/);
  assert.equal(await fs.readFile(target,'utf8'),'Another user body.');assert.match(await fs.readFile(f.article,'utf8'),/Original annotation/);
});

test('an interrupted move resumes from the saved plan without duplicate files or lost annotations',async()=>{
  const f=await fixture();
  await assert.rejects(organizeReadingSubscriptions(f.root,{recoveryRoot:path.join(f.root,'recovery'),onProgress:event=>{if(event.moved===2)throw new Error('synthetic interruption');}}),/synthetic interruption/);
  const resumed=await organizeReadingSubscriptions(f.root);assert.equal(resumed.status,'completed');
  for(const move of resumed.moves){assert.equal(digest(await fs.readFile(move.target)),move.destination_sha256);await assert.rejects(fs.access(move.source),{code:'ENOENT'});}
  assert.match(await fs.readFile(resumed.moves.find(m=>m.source===f.article).target,'utf8'),/Original annotation/);
});

test('moving linked documents updates ordinary links and preserves code and annotations',()=>{
  const root=path.resolve('D:/fixture'),source=path.join(root,'阅读区/old/a.md'),other=path.join(root,'阅读区/old/b.md'),target=path.join(root,'阅读区/订阅/RSS/source/a.md'),next=path.join(root,'阅读区/订阅/RSS/source/b.md');
  const before='[Other](b.md)\n> Annotation.\n```md\n[Literal](b.md)\n```\n';
  const after=relocatedMarkdown(before,source,target,new Map([[other,next]]),root);
  assert.match(after,/\[Other\]\(<b.md>\)/);assert.match(after,/> Annotation\./);assert.match(after,/```md\n\[Literal\]\(b.md\)\n```/);
});
