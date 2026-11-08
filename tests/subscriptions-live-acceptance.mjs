import fs from 'node:fs/promises';
import path from 'node:path';
import { codeRoot, readJson, writeJson, digest } from '../subscription-workflow/config.mjs';
import { status, jobList } from '../subscription-workflow/service.mjs';
import { scanCatalog } from '../rss-reading/core.mjs';

const artifact=process.argv[2] || 'D:/Artifacts/ProgressiveReading/subscriptions-20261106';
const before=await readJson(path.join(artifact,'before/runtime/publications-manifest.json'));
const oldLedger=await readJson(path.join(artifact,'before/runtime/Projects/渐进阅读工作流/imports/rss-reading/review-ledger.v1.json'));
const oldVideo=await readJson(path.join(artifact,'before/runtime/AppData/ProgressiveReading/VideoWatch/state.json'));
const ledger=await readJson(path.join(codeRoot,'imports/rss-reading/review-ledger.v1.json'));
const video=await readJson('D:/AppData/ProgressiveReading/VideoWatch/state.json');
const changed=[];
for(const [index,entry] of before.entries()) {
  try { if(digest(await fs.readFile(entry.path)).toUpperCase()!==entry.sha256.toUpperCase())changed.push({path:entry.path,reason:'hash_changed'}); }
  catch(error){changed.push({path:entry.path,reason:error.code});}
  if(index%250===0)console.log(JSON.stringify({event:'checking_existing_publications',checked:index,total:before.length}));
}
const decisions=Object.entries(oldLedger.items).filter(([id,item])=>!ledger.items[id]||ledger.items[id].decision!==item.decision).map(([id])=>id);
const videoChanges=Object.entries(oldVideo.entries).filter(([id,item])=>!video.entries[id]||video.entries[id].status!==item.status||video.entries[id].publication!==item.publication).map(([id])=>id);
const current=await status(),catalog=await scanCatalog(),jobs=await jobList();
const reports=jobs.filter(j=>j.kind==='daily'&&j.result?.outputs?.daily).sort((a,b)=>b.created_at.localeCompare(a.created_at));
const latest=reports[0]?.result.outputs.daily;
const text=latest?await fs.readFile(latest.path,'utf8'):'';
const sourceUrls=[...text.matchAll(/\[原文链接\]\((https?:[^)]+)\)/gu)].map(m=>m[1]);
const report={path:latest?.path,hash_matches:Boolean(latest)&&digest(text)===latest.sha256,cards:[...text.matchAll(/<!-- rss-reading:item /gu)].length,source_links:sourceUrls.length,unique_source_links:new Set(sourceUrls).size};
const endpoint=await fetch('http://127.0.0.1:37829/api/subscriptions').then(r=>r.json());
const result={checked_at:new Date().toISOString(),status:'passed',existing_publications:{checked:before.length,changed},
  historical_decisions:{checked:Object.keys(oldLedger.items).length,changed:decisions},video_history:{checked:Object.keys(oldVideo.entries).length,changed:videoChanges},
  registry:{subscriptions:current.subscriptions.length,enabled:current.enabled,endpoint_enabled:endpoint.enabled,heartbeat:endpoint.heartbeat},
  catalog:{canonical_items:catalog.items.length,unique_keys:new Set(catalog.items.map(i=>i.canonicalKey)).size,retained_aliases:Object.values(ledger.items).filter(i=>i.canonical_material_id).length},
  report,queue:{counts:current.counts,pending:current.pending,failures:current.failures},zhihu:current.zhihu_validation};
if(changed.length||decisions.length||videoChanges.length||!report.hash_matches||!current.enabled||!endpoint.enabled||sourceUrls.length!==new Set(sourceUrls).size||catalog.items.length!==result.catalog.unique_keys)result.status='failed';
await writeJson(path.join(artifact,'acceptance.json'),result);
console.log(JSON.stringify(result,null,2));
if(result.status!=='passed')process.exitCode=1;
