import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {readJson,writeJson,digest} from '../subscription-workflow/config.mjs';
import {sourceUrls} from './reading-source-library.mjs';
import {urlImportDedupeKey} from './url-import-input.mjs';

export async function verifyRepositoryImport(root,directory,{baseline=[]}={}) {
  const run=await readJson(path.join(directory,'run.json'));
  assert.equal(run.phase,'completed','repository_run_not_completed');
  const inventory=run.collection.inventory,records=run.collection.verification?.records;
  assert.ok(inventory.complete&&inventory.repository_snapshot?.sha);
  assert.equal(records?.length,inventory.articles.length);
  const rows=new Map(run.results.map(row=>[row.requested_url,row])),publications=new Map(records.map(row=>[row.url,row]));
  const review=[],mapping=[],checks=[];
  const normalized=value=>value.replace(/\r\n/gu,'\n').replace(/\s/gu,'');
  for(const article of inventory.articles){
    const captured=await readJson(path.join(directory,'sources',digest(article.url)+'.json'));
    const record=publications.get(article.url),result=rows.get(article.url),bytes=await fs.readFile(record.path),markdown=bytes.toString('utf8');
    assert.equal(digest(bytes),record.sha256,'publication_hash_changed:'+record.path);
    assert.ok(sourceUrls(markdown).map(urlImportDedupeKey).includes(urlImportDedupeKey(article.url)),'publication_identity_missing');
    if(!record.reused){assert.equal(result.receipt.processing_mode,'original_text');assert.equal(result.receipt.llm_used,false);assert.ok(normalized(markdown).includes(normalized(captured.markdown)),'body_coverage_failed:'+record.path);}
    const expectedDirectory=path.join(root,'阅读区',run.settings.destination,...captured.metadata.taxonomy.repository_directory);
    // An older publication may be reused in its existing location by design.
    if(!record.reused)assert.equal(path.resolve(path.dirname(record.path)),path.resolve(expectedDirectory));
    const evidence=captured.metadata.original_link_evidence;
    if(evidence.status==='verified')mapping.push({url:article.url,original_url:evidence.url,path:record.path,evidence});
    else review.push({title:captured.title,repository_path:captured.metadata.repository.path,url:article.url,path:record.path,evidence});
    checks.push({url:article.url,path:record.path,sha256:record.sha256,reused:record.reused,body_coverage:true});
  }
  const preserved=[];for(const row of baseline){assert.equal(digest(await fs.readFile(row.path)),row.sha256,'existing_original_changed:'+row.path);preserved.push(row);}
  const relations=await readJson(path.join(root,'.local-ir','source-relations.json'));
  for(const row of mapping){const relation=relations.representations[urlImportDedupeKey(row.url)];assert.ok(relation,'relation_missing');assert.equal(relation.fact_source_url,urlImportDedupeKey(row.original_url));assert.equal(relation.translation_path,row.path);}
  return {status:'VALIDATED',commit:inventory.repository_snapshot.sha,expected:inventory.articles.length,verified:checks.length,excluded:inventory.excluded,
    mapped: mapping.length,pending_mapping:review.length,local_pairs:run.collection.verification.source_relations.bound_local_files,preserved_originals:preserved.length,checks,review};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
  const value=key=>process.argv[process.argv.indexOf(key)+1];
  const root=value('--root'),directory=value('--run'),output=value('--output'),baseline=process.argv.includes('--baseline')?await readJson(value('--baseline')):[];
  const report=await verifyRepositoryImport(root,directory,{baseline});await writeJson(output,report);
  console.log(JSON.stringify({status:report.status,verified:report.verified,mapped:report.mapped,pending_mapping:report.pending_mapping,local_pairs:report.local_pairs,preserved_originals:report.preserved_originals}));
}
