// Independent, read-only audit of actual files, source identity and original text.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readRun,runPath,listRuns} from '../site-import/store.mjs';
import {digest,readJson} from '../subscription-workflow/config.mjs';
import {sourceUrls,LIBRARY_ZONES,sourceAliasResolver,findSourcePublications} from './reading-source-library.mjs';
import {urlImportDedupeKey} from './url-import-input.mjs';
import {relocatedMarkdown} from '../subscription-workflow/report-archive.mjs';

const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const root=path.resolve(arg('--root',path.resolve(import.meta.dirname,'..'))),id=arg('--run');
if(!id)throw new Error('usage: node scripts/verify-site-import.mjs --run site-run-ID [--baseline file.json] [--output file.json]');
const run=await readRun(root,id);assert.equal(run.phase,'completed');
const inventory=run.collection.inventory;assert.equal(inventory.complete,true);assert.equal(run.results.length,inventory.articles.length);
const identity=await sourceAliasResolver(root);
const identities=new Map(inventory.articles.map(article=>[identity(article.url),[]]));
for(const zone of LIBRARY_ZONES){const queue=[path.join(root,zone)];while(queue.length){const directory=queue.pop();const entries=await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});for(const entry of entries){if(entry.isDirectory()){if(!['_assets','images','附件','.git','node_modules'].includes(entry.name))queue.push(path.join(directory,entry.name));continue;}if(!entry.isFile()||!entry.name.endsWith('.md'))continue;const file=path.join(directory,entry.name),handle=await fs.open(file,'r');let front;try{const buffer=Buffer.alloc(16384),read=await handle.read(buffer,0,buffer.length,0);front=buffer.subarray(0,read.bytesRead).toString('utf8');}finally{await handle.close();}for(const url of new Set(sourceUrls(front).map(identity)))if(identities.has(url))identities.get(url).push(file);}}}
const normalize=value=>String(value).replace(/\r\n?/gu,'\n').replace(/\u0000/gu,'').replace(/[ \t]+\n/gu,'\n').replace(/\n{4,}/gu,'\n\n\n').trim();
let original=0,reused=0,sidecars=0;
const files=[];
for(const row of run.results){
  const artifact=row.artifacts.find(a=>a.kind==='markdown');assert.ok(artifact?.path);const text=await fs.readFile(artifact.path,'utf8');assert.equal(digest(text),artifact.sha256);
  const locations=identities.get(identity(row.requested_url));assert.ok(locations.length===1 || (row.receipt.aggregate===true&&locations.length===0),row.requested_url+' has '+locations.length+' copies');
  if(row.status==='idempotent_replay'){assert.equal(row.receipt.existing_article_preserved,true);reused++;}
  else{
    assert.equal(row.receipt.processing_mode,'original_text');assert.equal(row.receipt.llm_used,false);
    const capture=await readJson(path.join(runPath(root,inventory.article_source.run_id),'sources',digest(row.requested_url)+'.json'));
    assert.equal(row.receipt.raw_markdown_sha256,digest(capture.markdown));assert.ok(normalize(text).includes(normalize(capture.markdown)),row.requested_url+' body changed');original++;
    const sidecar=row.artifacts.find(a=>a.kind==='browser_ir_metadata');assert.ok(sidecar?.path);const state=await readJson(sidecar.path);assert.equal(state.content.markdownSha256,artifact.sha256);sidecars++;
  }
  files.push({url:row.requested_url,path:artifact.path,sha256:artifact.sha256,reused:row.status==='idempotent_replay'});
}
let preserved=0,rebased=0;const baseline=arg('--baseline');if(baseline){
  const input=await readJson(baseline),entries=Array.isArray(input)?input:input.publications,current=await findSourcePublications(root,entries.map(([url])=>url));
  const journals=[];for(const previous of (await listRuns(root)).reverse()){const journal=await readJson(path.join(runPath(root,previous.id),'organization.json'));if(journal)journals.push(journal);}
  const mapping=new Map(journals.flatMap(j=>j.mapping||[]));
  for(const [from,to]of mapping){let next=to;const seen=new Set([from]);while(mapping.has(next)&&!seen.has(next)){seen.add(next);next=mapping.get(next);}mapping.set(from,next);}
  for(const [url,entry] of entries){const actual=current.get(urlImportDedupeKey(url));assert.ok(actual,'missing baseline source '+url);const bytes=await fs.readFile(actual.path);if(digest(bytes)!==entry.sha256){
      let original;for(const journal of journals){if(!journal.recovery)continue;const candidate=await fs.readFile(path.join(journal.recovery,digest(entry.path)+'.md'),'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(candidate!==null&&digest(candidate)===entry.sha256){original=candidate;break;}}
      assert.ok(original,'baseline body recovery missing: '+url);assert.equal(bytes.toString('utf8'),relocatedMarkdown(original,entry.path,actual.path,mapping,root),'baseline body changed: '+url);rebased++;
    }preserved++;}
}
assert.equal(run.collection.verification.verified,inventory.articles.length);assert.ok(await fs.stat(run.collection.verification.index));
const report={status:'passed',run:id,total:files.length,original,reused,sidecars,existing_preserved:preserved,relative_links_rebased:rebased,excluded:inventory.excluded,planner:inventory.planner,duplicates:0,failed:0,index:run.collection.verification.index,files};
const output=arg('--output');if(output)await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,files:undefined}));
