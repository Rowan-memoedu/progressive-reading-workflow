import fs from 'node:fs/promises';
import path from 'node:path';
import { paths, readJson, writeJson, withLock, digest } from './config.mjs';
import { publicationMetadata } from './publication-time.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';

export const exceptionFile = root => path.join(paths(root).summaryRoot,'订阅异常记录.md');
function detail(fault) {
  const raw = String(fault.error?.message || fault.error || fault.reason || fault.message || '正文尚未就绪');
  if (/paid_subscribers|paid_subscription_required|paywall/iu.test(raw)) return {kind:'paid',message:'正文需要付费订阅，当前未能取得完整内容。'};
  if (/403|access_restricted|forbidden/iu.test(raw)) return {kind:'restricted',message:'来源限制访问，当前未能取得完整内容。'};
  return {kind:fault.code || raw.replace(/\b\d{4}-\d\d-\d\dT[^\s]+|\b[0-9a-f]{20,}\b/gu,'').slice(0,200),
    message:raw.replace(/(?:Cookie|Authorization|Bearer)[^\r\n]*/giu,'[认证信息已省略]').slice(0,1200)};
}

export async function recordExceptions(root,faults,kind = '来源') {
  const stateFile = path.join(paths(root).home,'exception-records.json');
  return withLock(stateFile+'.lock',async()=>{
    const state = await readJson(stateFile,{entries:{}});
    const file = exceptionFile(root);
    await fs.mkdir(path.dirname(file),{recursive:true});
    const existing = await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    const initial = existing ?? '# 订阅异常记录\n';
    let text = initial;
    const pending = [];
    for (const fault of faults) {
      const info = detail(fault);
      const url = fault.url || fault.item_url;
      const identity = fault.canonical_key || (url ? urlImportDedupeKey(url) : null) || fault.material_id || fault.key || fault.subscription_id || `${kind}:${info.kind}`;
      const id = digest(String(identity));
      const event = digest(id+':'+info.kind);
      const marker = `<!-- subscriptions:exception ${event} -->`;
      if (!text.includes(marker)) {
        const title = String(fault.title || kind+'处理异常').replace(/[\r\n]/gu,' ');
        text += ['','',marker,'## '+title,'',info.message,'',url ? `[来源](${url})` : '',
          publicationMetadata(fault.published_at),'首次记录于 '+new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}),''].filter(line=>line!==undefined).join('\n');
      }
      state.entries[id] ||= {first_seen:new Date().toISOString(),notified:false};
      state.entries[id].last_seen = new Date().toISOString();
      if (!state.entries[id].notified) pending.push(id);
    }
    if (existing === null) await fs.writeFile(file,initial,{encoding:'utf8',flag:'wx'});
    if (text.length > initial.length) await fs.appendFile(file,text.slice(initial.length),'utf8');
    await writeJson(stateFile,state);
    return [...new Set(pending)];
  });
}

export async function acknowledgeExceptions(root,ids) {
  const file = path.join(paths(root).home,'exception-records.json');
  return withLock(file+'.lock',async()=>{
    const state = await readJson(file,{entries:{}});
    for (const id of ids) if(state.entries[id])state.entries[id].notified = true;
    await writeJson(file,state);
  });
}

export async function recordBlockedArticles(paths,ledger) {
  const blocked = Object.values(ledger.items).filter(item=>!item.canonical_material_id && item.route==='blocked');
  await recordExceptions(paths.workflowRoot,blocked.map(item=>({...item,error:item.source_errors?.map(error=>error.message).join('; ') || '正文尚未就绪'})),'文章获取');
  return new Set(blocked.map(item=>item.material_id));
}

export async function removeBlockedCards(paths,ledger) {
  const blocked = await recordBlockedArticles(paths,ledger);
  for (const folder of new Set([paths.summaryRoot,paths.previousSummaryRoot])) {
    const names = await fs.readdir(folder).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    for (const name of names.filter(name=>/(?:RSS|订阅) (?:日报|长文日报|长文周报)\.md$/u.test(name))) {
      const file = path.join(folder,name);
      const before = await fs.readFile(file,'utf8');
      const after = before.replace(/<!-- rss-reading:item\s+([^\s>]+)\s+-->[\s\S]*?<!-- rss-reading:end -->/gu,(block,id)=>(blocked.has(id)||blocked.has(ledger.items[id]?.canonical_material_id))?'':block)
        .replace(/^## 正文受限或尚未就绪\r?\n(?:(?!^## )[\s\S])*?(?=^## |$(?![\s\S]))/gmu,'');
      if (after !== before) await fs.writeFile(file,after,'utf8');
    }
  }
}
