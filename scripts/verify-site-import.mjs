// Independent, read-only audit of actual files, source identity and original text.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readRun,runPath} from '../site-import/store.mjs';
import {digest,readJson} from '../subscription-workflow/config.mjs';
import {sourceUrls,LIBRARY_ZONES} from './reading-source-library.mjs';
import {urlImportDedupeKey} from './url-import-input.mjs';

const args=process.argv.slice(2),arg=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
const root=path.resolve(arg('--root',path.resolve(import.meta.dirname,'..'))),id=arg('--run');
if(!id)throw new Error('usage: node scripts/verify-site-import.mjs --run site-run-ID [--baseline file.json] [--output file.json]');
const run=await readRun(root,id);assert.equal(run.phase,'completed');
const inventory=run.collection.inventory;assert.equal(inventory.complete,true);assert.equal(run.results.length,inventory.articles.length);
const identities=new Map(inventory.articles.map(article=>[urlImportDedupeKey(article.url),[]]));
for(const zone of LIBRARY_ZONES){const queue=[path.join(root,zone)];while(queue.length){const directory=queue.pop();const entries=await fs.readdir(directory,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;});for(const entry of entries){if(entry.isDirectory()){if(!['_assets','images','附件','.git','node_modules'].includes(entry.name))queue.push(path.join(directory,entry.name));continue;}if(!entry.isFile()||!entry.name.endsWith('.md'))continue;const file=path.join(directory,entry.name),handle=await fs.open(file,'r');let front;try{const buffer=Buffer.alloc(16384),read=await handle.read(buffer,0,buffer.length,0);front=buffer.subarray(0,read.bytesRead).toString('utf8');}finally{await handle.close();}for(const url of new Set(sourceUrls(front).map(urlImportDedupeKey)))if(identities.has(url))identities.get(url).push(file);}}}
const normalize=value=>String(value).replace(/\r\n?/gu,'\n').replace(/\u0000/gu,'').replace(/[ \t]+\n/gu,'\n').replace(/\n{4,}/gu,'\n\n\n').trim();
let original=0,reused=0,sidecars=0;
const files=[];
for(const row of run.results){
  const artifact=row.artifacts.find(a=>a.kind==='markdown');assert.ok(artifact?.path);const text=await fs.readFile(artifact.path,'utf8');assert.equal(digest(text),artifact.sha256);
  const locations=identities.get(urlImportDedupeKey(row.requested_url));assert.ok(locations.length===1 || (row.receipt.aggregate===true&&locations.length===0),row.requested_url+' has '+locations.length+' copies');
  if(row.status==='idempotent_replay'){assert.equal(row.receipt.existing_article_preserved,true);reused++;}
  else{
    assert.equal(row.receipt.processing_mode,'original_text');assert.equal(row.receipt.llm_used,false);
    const capture=await readJson(path.join(runPath(root,inventory.article_source.run_id),'sources',digest(row.requested_url)+'.json'));
    assert.equal(row.receipt.raw_markdown_sha256,digest(capture.markdown));assert.ok(normalize(text).includes(normalize(capture.markdown)),row.requested_url+' body changed');original++;
    const sidecar=row.artifacts.find(a=>a.kind==='browser_ir_metadata');assert.ok(sidecar?.path);const state=await readJson(sidecar.path);assert.equal(state.content.markdownSha256,artifact.sha256);sidecars++;
  }
  files.push({url:row.requested_url,path:artifact.path,sha256:artifact.sha256,reused:row.status==='idempotent_replay'});
}
let preserved=0;const baseline=arg('--baseline');if(baseline){for(const [,entry] of (await readJson(baseline)).publications){assert.equal(digest(await fs.readFile(entry.path)),entry.sha256);preserved++;}}
assert.equal(run.collection.verification.verified,inventory.articles.length);assert.ok(await fs.stat(run.collection.verification.index));
const report={status:'passed',run:id,total:files.length,original,reused,sidecars,existing_unchanged:preserved,excluded:inventory.excluded,planner:inventory.planner,duplicates:0,failed:0,index:run.collection.verification.index,files};
const output=arg('--output');if(output)await fs.writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,files:undefined}));
