import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {originalLinkEvidence,repositoryMarkdown,discoverRepository} from '../site-import/repository.mjs';
import {repositoryConfig} from '../site-import/repository-config.mjs';
import {bindRepositoryRelations,resolveSourceRelation} from '../scripts/source-relations.mjs';
import {sourceUrls,findSourcePublications} from '../scripts/reading-source-library.mjs';
import {normalizeSource,writeJson} from '../subscription-workflow/config.mjs';
import {taxonomyFolder} from '../site-import/taxonomy.mjs';
import {scanRepositories} from '../subscription-workflow/repositories.mjs';
import {writeRepositoryIndexes} from '../site-import/repository-indexes.mjs';

const repository=repositoryConfig({url:'https://github.com/example/translations',public_base:'https://example.github.io/translations/'});
test('cached library probes observe source edits, new files, moves and deletes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'library-probe-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'阅读区');await fs.mkdir(dir);
  const urls=['https://writer.example/a','https://writer.example/b'],file=path.join(dir,'a.md');
  await fs.writeFile(file,'---\nsource_url: '+JSON.stringify(urls[0])+'\n---\nOne');
  assert.equal((await findSourcePublications(root,urls)).size,1);
  await fs.writeFile(file,'---\nsource_url: '+JSON.stringify(urls[1])+'\n---\nTwo');
  const edited=await findSourcePublications(root,urls);assert.ok(!edited.has(urls[0]));assert.ok(edited.has(urls[1]));
  await fs.mkdir(path.join(root,'已归档原文'));await fs.rename(file,path.join(root,'已归档原文','a.md'));
  assert.equal((await findSourcePublications(root,urls)).get(urls[1]).zone,'已归档原文');
  await fs.rm(path.join(root,'已归档原文','a.md'));assert.equal((await findSourcePublications(root,urls)).size,0);
});
test('explicit provenance fields are accepted; body citations and ambiguous source labels are not guessed',()=>{
  assert.equal(originalLinkEvidence('# 标题\n\n原文：[Article](https://writer.example/a)').url,'https://writer.example/a');
  assert.equal(originalLinkEvidence('---\noriginal_url: "https://writer.example/a"\n---\n正文').status,'verified');
  assert.equal(originalLinkEvidence('某篇[原文](https://writer.example/a)的引用').status,'missing');
  assert.equal(originalLinkEvidence('原文：[A](https://writer.example/a) 和 [B](https://writer.example/b)').status,'ambiguous');
  assert.equal(originalLinkEvidence('原文：javascript:alert(1)').status,'missing');
  assert.equal(originalLinkEvidence('# 中文标题\n\n[Exact English Title](https://writer.example/a)\n\n正文','Exact English Title').status,'verified');
  assert.equal(originalLinkEvidence('# 中文标题\n\n[其他引用](https://writer.example/a)\n\n正文','Exact English Title').status,'missing');
  const profiles=originalLinkEvidence('原文：[文章](https://writer.example/p/article)\n原文：[作者](https://writer.example/@writer)');
  assert.equal(profiles.url,'https://writer.example/p/article');assert.equal(profiles.discarded.length,1);
});
test('archive extraction verifies every blob and supports long Windows paths',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'repository-snapshot-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const execute=promisify(execFile),name='src/'+('a'.repeat(85)+'/').repeat(3)+'article.md',body='Full verified Markdown';
  const sha=createHash('sha1').update('blob '+Buffer.byteLength(body)+'\0'+body).digest('hex');
  await writeJson(path.join(root,'tree.json'),{tree:[{path:name,sha,type:'blob',mode:'100644'}]});
  const zip=path.join(root,'snapshot.zip');
  await execute('python',['-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr("repo-commit/"+sys.argv[2],sys.argv[3]); z.close()',zip,name,body]);
  const script=path.resolve('site-import/repository-snapshot.py'),args=[script,zip,path.join(root,'tree.json'),path.join(root,'files'),'src'];
  const result=await execute('python',args);assert.equal(JSON.parse(result.stdout).verified_blobs,1);
  assert.equal(await fs.readFile(path.join(root,'files',name),'utf8'),body);
  await writeJson(path.join(root,'tree.json'),{tree:[{path:name,sha:'0'.repeat(40),type:'blob',mode:'100644'}]});
  await assert.rejects(execute('python',args),/repository_blob_hash_mismatch/u);
  await writeJson(path.join(root,'tree.json'),{truncated:true,tree:[]});
  await assert.rejects(execute('python',args),/repository_tree_truncated/u);
});
test('repository checks reuse the existing site queue with a stable commit recovery key',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'repository-subscription-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'subscriptions');await writeJson(path.join(root,'imports/subscriptions/active.json'),{home});
  const source=normalizeSource({name:'Translations',kind:'github_repository',url:repository.url,mode:'original_text',history_mode:'all',repository});
  await writeJson(path.join(home,'subscriptions.json'),{schema:'progressive-reading.subscriptions/v1',revision:1,subscriptions:[source]});
  const calls=[],fetchImpl=async(url,options)=>{
    const route=new URL(url).pathname,input=options?.body?JSON.parse(options.body):null;calls.push({route,input});
    const data=route==='/api/site-imports'?{revision:1,sources:[{id:'site-fixture',repository}]}:{id:'site-run-fixture',phase:'completed',counts:{imported:3}};
    return {ok:true,json:async()=>data};
  };
  const options={fetchImpl,headFn:async()=>({sha:'c'.repeat(40)})};
  assert.equal((await scanRepositories(root,'day1',options)).errors.length,0);
  assert.equal((await scanRepositories(root,'day2',options)).errors.length,0);
  const starts=calls.filter(c=>c.route.endsWith('/start'));assert.equal(starts.length,2);assert.equal(starts[0].input.client_request_id,starts[1].input.client_request_id);
});
test('repository links keep nested hierarchy and pinned images without fetching originals',()=>{
  const markdown=repositoryMarkdown('# 文\n[下一篇](../Other.md#chapter)\n![图](./images/a.png)\n[外部](https://writer.example/a)',repository,'src/author/essay.md','a'.repeat(40));
  assert.ok(markdown.includes('https://example.github.io/translations/Other.html#chapter'));
  assert.ok(markdown.includes('/'+'a'.repeat(40)+'/src/author/images/a.png'));
  assert.ok(markdown.includes('[外部](https://writer.example/a)'));
  assert.equal(taxonomyFolder('合集',{repository_directory:['author','notes']}),'合集/author/notes');
});
test('repository settings reject unsafe source paths and unsupported report/date modes',()=>{
  assert.throws(()=>repositoryConfig({url:'https://github.com/example/translations',content_root:'../private'}));
  assert.throws(()=>repositoryConfig({url:'https://github.com/example/translations',branch:'../main'}));
  assert.throws(()=>normalizeSource({kind:'github_repository',name:'Translations',url:repository.url,mode:'reports'}));
  assert.equal(normalizeSource({kind:'github_repository',name:'Translations',url:repository.url,mode:'original_text',history_mode:'all',repository}).repository.public_base,repository.public_base);
});
test('full tree import separates navigation and binds both local representations while preserving original bytes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'repository-import-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const home=path.join(root,'snapshot'),directory=path.join(root,'run');
  const input={'src/SUMMARY.md':'* [作者](author/intro.md)','src/author/intro.md':'# 作者\n介绍','src/author/notes/One.md':'# 第一篇\n\n原文：[One](https://writer.example/one)\n\n完整译文。','src/author/notes/Two.md':'# 第二篇\n原文：[Two](https://writer.example/two)\n\n正文'};
  for(const [file,body]of Object.entries(input)){await fs.mkdir(path.dirname(path.join(home,'files',file)),{recursive:true});await fs.writeFile(path.join(home,'files',file),body);}
  await writeJson(path.join(home,'tree.json'),{tree:Object.keys(input).map(p=>({type:'blob',path:p,sha:'a'.repeat(40)}))});
  await fs.mkdir(path.join(root,'阅读区','originals'),{recursive:true});
  const originalPath=path.join(root,'阅读区','originals','One.md'),original='---\nsource_url: "https://writer.example/one"\n---\n# One\nOriginal English.';
  await fs.writeFile(originalPath,original);
  const inventory=await discoverRepository(root,{repository},directory,{snapshotFn:async()=>({home,sha:'b'.repeat(40),repository})});
  assert.equal(inventory.candidate_count,4);assert.equal(inventory.articles.length,3);assert.equal(inventory.excluded.length,1);
  assert.equal(inventory.mapping_counts.verified,2);assert.equal(inventory.mapping_counts.local_originals,1);
  const captures=[];for(const name of await fs.readdir(path.join(directory,'sources')))captures.push(JSON.parse(await fs.readFile(path.join(directory,'sources',name),'utf8')));
  const publications=[];
  for(const capture of captures){const file=path.join(root,'阅读区','译文',capture.metadata.repository.relative_path);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'---\nsource_url: '+JSON.stringify(capture.url)+'\noriginal_url: '+JSON.stringify(capture.metadata.original_url||'')+'\n---\n'+capture.markdown);publications.push({url:capture.url,path:file,sha256:'fixture',verified:true});}
  const result=await bindRepositoryRelations(root,captures,publications);assert.equal(result.verified_relations,2);assert.equal(result.bound_local_files,1);
  const relation=await resolveSourceRelation(root,'https://writer.example/one');assert.equal(relation.original.path,originalPath);assert.equal(relation.translations.length,1);assert.equal(relation.original_fetch_required,false);
  const missing=await resolveSourceRelation(root,'https://example.github.io/translations/author/notes/Two.html');assert.equal(missing.original_fetch_required,true);
  assert.equal(await fs.readFile(originalPath,'utf8'),original);
  assert.deepEqual(sourceUrls('---\nsource_url: "https://translation.example/one"\noriginal_url: "https://writer.example/one"\nfact_source_url: "https://writer.example/one"\n---'),['https://translation.example/one']);
  const settings={name:'Translations',destination:'译文',repository};
  const indexes=await writeRepositoryIndexes(root,settings,captures,publications);
  assert.ok((await fs.readFile(indexes.root_index,'utf8')).includes('author/目录.md'));
  const nested=path.join(root,'阅读区','译文','author','notes','目录.md');
  assert.ok((await fs.readFile(nested,'utf8')).includes('One.md'));
  await fs.appendFile(nested,'\n用户的导航备注。\n');
  await assert.rejects(writeRepositoryIndexes(root,settings,captures,publications),/repository_index_user_edit_preserved/u);
  assert.ok((await fs.readFile(nested,'utf8')).includes('用户的导航备注。'));
});
