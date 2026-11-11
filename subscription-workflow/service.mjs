import fs from 'node:fs/promises';
import { existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths, codeRoot, loadConfig, readJson, writeJson, withLock, digest, platform } from './config.mjs';
import { scanRss, scanVideos, scanZhihu, advanceAuto, withAutoImporter } from './adapters.mjs';
import { generateSummaries, prepareSubscriptionPreviews, processMarkdownDecisions } from '../rss-reading/core.mjs';
import { publicationMetadata } from './publication-time.mjs';
import { recordExceptions, acknowledgeExceptions, exceptionFile } from './exception-log.mjs';
import { normalizeVideoRequest, runVideoRequest } from './video-request.mjs';
import {subscriptionImportIssues,readableImportError} from './import-issues.mjs';

const execute = promisify(execFile);
export const JOB_KINDS = ['rss','bilibili','zhihu','daily','weekly','decisions','retry','video_import'];
export const localDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function weekKey(date=localDate()) {
  const day=new Date(date+'T00:00:00Z');day.setUTCDate(day.getUTCDate()+4-(day.getUTCDay()||7));
  const first=new Date(Date.UTC(day.getUTCFullYear(),0,1));
  return day.getUTCFullYear()+'-W'+String(Math.ceil(((day-first)/86400000+1)/7)).padStart(2,'0');
}
const stamp = () => new Date().toISOString();
const cleanError = error => String(error?.message || error).replace(/(?:Cookie|Authorization|Bearer)[^\r\n]*/giu, '[认证信息已省略]').slice(0,1000);

export async function jobList(root = codeRoot) {
  const directory = paths(root).jobs;
  const names = await fs.readdir(directory).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const jobs = [];
  for (const name of names.filter(n => /^[a-f0-9]{32}\.json$/u.test(n))) jobs.push(await readJson(path.join(directory,name)));
  return jobs.filter(Boolean).sort((a,b) => a.created_at.localeCompare(b.created_at));
}

export async function enqueue(root, kind, key = localDate()) {
  if (!JOB_KINDS.includes(kind)) throw new Error('未知订阅任务');
  if (kind === 'video_import') throw new Error('单次视频导入请提供链接和精确分 P 范围');
  const p = paths(root), id = digest(`${kind}:${key}`).slice(0,32), file = path.join(p.jobs,id+'.json');
  return withLock(path.join(p.home,'enqueue.lock'), async () => {
    if (key.startsWith('manual-')) {
      const active = (await jobList(root)).find(job=>job.kind===kind && ['queued','running'].includes(job.status));
      if (active) return active;
    }
    const existing = await readJson(file);
    if (existing) return existing;
    const job = { id, kind, cycle: key, status: 'queued', created_at: stamp(), steps: {} };
    await writeJson(file,job); return job;
  });
}

export async function enqueueVideoRequest(root, input, { retry = false } = {}) {
  const request = normalizeVideoRequest(root,input), p = paths(root);
  const id = digest('video_import:'+JSON.stringify(request)).slice(0,32);
  return withLock(path.join(p.home,'enqueue.lock'),async()=>{
    const file = path.join(p.jobs,id+'.json'), previous = await readJson(file);
    if (previous) {
      if (!retry || ['queued','running'].includes(previous.status)) return previous;
      for (const [name,step] of Object.entries(previous.steps || {})) {
        if (name.startsWith('video-P') && step.result?.status !== 'completed') delete previous.steps[name];
      }
      previous.status='queued'; previous.retried_at=stamp();
      delete previous.completed_at; delete previous.error; delete previous.result; delete previous.current_step;
      await writeJson(file,previous); return previous;
    }
    const job = { id, kind:'video_import', cycle:'one-off-'+id, request, status:'queued', created_at:stamp(), steps:{} };
    await writeJson(file,job); return job;
  });
}

export async function initializeActivity(root) {
  const file = path.join(paths(root).home,'activity.json');
  if (await readJson(file)) return;
  await writeJson(file, { baseline_at: stamp(), seen: (await activityInputs(root)).map(e => e.id), events: [] });
}

async function activityInputs(root) {
  const config = await loadConfig(root), inputs = [];
  if (!config) return inputs;
  const rss = await readJson(path.join(config.rss_home,'state.json'), { items: {} });
  for (const item of Object.values(rss.items)) if (['imported','imported_with_warnings'].includes(item.status))
    inputs.push({ id: 'text:'+item.id, title: item.title, url: item.url, paths: (item.artifacts || []).map(a=>a.path), at: item.completed_at, published_at: item.published_at });
  const video = await readJson(path.join(config.video_home,'state.json'), { entries: {} });
  for (const item of Object.values(video.entries)) if (item.status === 'completed' && item.publication)
    inputs.push({ id: 'video:'+item.key, title: item.video_title, url: item.url, paths: [item.publication], at: item.completed_at || item.last_attempt, published_at: item.published_at });
  const ledger = await readJson(path.join(root,'imports','rss-reading','review-ledger.v1.json'), { items: {} });
  for (const item of Object.values(ledger.items)) if (!item.canonical_material_id && item.publication?.path)
    inputs.push({ id: 'review:'+item.material_id, title: item.title, url: item.item_url, paths: [item.publication.path], at: item.publication.published_at, published_at: item.published_at });
  return [...new Map(inputs.map(e => [e.paths[0] || e.id,e])).values()];
}

export async function collectActivity(root) {
  const p = paths(root), file = path.join(p.home,'activity.json');
  return withLock(file+'.lock', async () => {
    const state = await readJson(file, { baseline_at: stamp(), seen: [], events: [] });
    const seen = new Set(state.seen);
    const inputs = await activityInputs(root);
    const byPath = new Map(inputs.filter(event => event.paths[0]).map(event => [event.paths[0], event]));
    for (const event of state.events) {
      if (!event.published_at && byPath.get(event.paths[0])?.published_at) event.published_at = byPath.get(event.paths[0]).published_at;
    }
    for (const event of inputs) if (!seen.has(event.id)) {
      seen.add(event.id);
      if (!state.events.some(e => e.paths[0] && e.paths[0] === event.paths[0])) state.events.push({ ...event, observed_at: stamp() });
    }
    state.seen = [...seen]; await writeJson(file,state); return state.events;
  });
}

function markdownLabel(value) { return String(value || '').replace(/[\[\]\r\n]/gu,' '); }
export async function appendActivity(root, receipt) {
  const p = paths(root), events = await collectActivity(root), config = await loadConfig(root);
  const ledger = await readJson(path.join(root,'imports','rss-reading','review-ledger.v1.json'), { items: {} });
  let targets = [receipt.outputs.daily, receipt.outputs.long_weekly].filter(Boolean);
  if (!targets.length && receipt.mode !== 'weekly') {
    const file = path.join(p.summaryRoot, `${localDate()} 订阅 日报.md`);
    await fs.mkdir(path.dirname(file), { recursive:true });
    if (!existsSync(file)) await fs.writeFile(file, `# ${localDate()} 订阅${receipt.mode === 'weekly' ? '周报' : '日报'}\n\n本期没有新的长文候选。\n`);
    targets = [{ path:file, item_count:0 }]; receipt.outputs.daily = targets[0];
  }
  for (const target of targets) {
    const isWeekly=target===receipt.outputs.long_weekly;
    const cutoff = isWeekly ? Date.now()-7*86400000 : Date.parse(localDate()+'T00:00:00+08:00');
    const recent = events.filter(e => Date.parse(e.observed_at) >= cutoff);
    const lines = ['<!-- subscriptions:activity -->','## 本期新增入库',''];
    if (!recent.length) lines.push('本期暂无新增入库。');
    for (const event of recent) {
      lines.push(`- [${markdownLabel(event.title)}](<${path.relative(path.dirname(target.path),event.paths[0]).replaceAll('\\','/')}>)`);
      const metadata = publicationMetadata(event.published_at);
      if (metadata) lines.push(`  ${metadata}`);
    }
    const updates = Object.values(ledger.items).filter(i => !i.canonical_material_id && i.available_revision);
    if (updates.length) {
      lines.push('','## 来源更新','', '以下材料检测到来源更新，原正文、批注和选择保持不变。');
      for (const item of updates) {
        lines.push(`- [${markdownLabel(item.title)}](${item.item_url})`);
        const metadata = publicationMetadata(item.published_at);
        if (metadata) lines.push(`  ${metadata}`);
      }
    }
    lines.push('','订阅设置与处理状态：[本地订阅页](http://127.0.0.1:37829/subscriptions)。','<!-- subscriptions:activity:end -->');
    const before = await fs.readFile(target.path,'utf8');
    const content = before.replace(/\n*<!-- subscriptions:activity -->[\s\S]*?<!-- subscriptions:activity:end -->/gu,'').trimEnd()+'\n\n'+lines.join('\n')+'\n';
    await fs.writeFile(target.path,content); target.sha256 = digest(content);
    ledger.report_runs ||= {daily:{},weekly:{}};
    if (isWeekly) {
      ledger.report_runs.weekly[weekKey()] ||= {generated_at:stamp()};
      ledger.report_runs.weekly[weekKey()].long_weekly = {path:target.path,sha256:target.sha256};
    } else ledger.report_runs.daily[localDate()] = {path:target.path,sha256:target.sha256,generated_at:stamp()};
  }
  const ledgerFile=path.join(root,'imports','rss-reading','review-ledger.v1.json');
  await writeJson(ledgerFile,ledger);
  if(receipt.outputs.ledger)receipt.outputs.ledger.sha256=digest(await fs.readFile(ledgerFile));
  if (receipt.receipt_path) await writeJson(receipt.receipt_path,receipt);
  return receipt;
}

export async function notify(root, key, title, body) {
  const p = paths(root), file = path.join(p.home,'notifications.json');
  return withLock(file+'.lock', async () => {
    const state = await readJson(file, { sent: {} });
    if (state.sent[key]) return;
    const payload = path.join(p.home,'notification-payload.json');
    await writeJson(payload,{ title, body });
    try {
      // Windows PowerShell 5.1 is required for the existing WinRT toast API.
      await execute('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',path.join(codeRoot,'subscription-workflow','notify.ps1'),'-Payload',payload],{ windowsHide:true, timeout:30000 });
      state.sent[key] = { at:stamp() }; state.last_error = null;
    } catch (error) { state.last_error = { at:stamp(), error:cleanError(error) }; }
    await writeJson(file,state);
  });
}

async function noticeFaults(root, kind, faults) {
  const file = path.join(paths(root).home,`faults-${kind}.json`), previous = await readJson(file, { signature:null });
  const messages = faults.map(f => cleanError(f.error || f.reason || f)).sort();
  const signature = digest(JSON.stringify(messages));
  const ledger = await readJson(path.join(root,'imports','rss-reading','review-ledger.v1.json'),{items:{}});
  const blocked = Object.values(ledger.items).filter(item=>!item.canonical_material_id && item.route==='blocked')
    .map(item=>({...item,error:item.source_errors?.map(error=>error.message).join('; ') || '正文尚未就绪'}));
  const individualFaults = faults.filter(fault=>!blocked.length || !/RSS 正文仍未就绪|排队条目正文仍受来源限制|RSS 正文仍受来源限制/u.test(String(fault.error || '')));
  const pending = await recordExceptions(root,[...individualFaults,...blocked],kind);
  if (pending.length) {
    await notify(root,'exceptions:'+digest(pending.sort().join(',')),'订阅处理需要关注',`${pending.length} 项新异常已记录到订阅异常记录。`);
    await acknowledgeExceptions(root,pending);
  }
  await writeJson(file,{ signature, faults, changed_at: signature === previous.signature ? previous.changed_at : stamp(), checked_at:stamp() });
}

const sourceScans = {rss:scanRss,bilibili:scanVideos,zhihu:scanZhihu};
const scopeSignature = source => JSON.stringify([source.history_mode,source.earliest_date,source.mode,source.updated_at]);
const expandedSources = config => config.subscriptions.filter(source => source.enabled
  && ['since','all'].includes(source.history_mode));

async function scanAndRecordScope(root, kind, cycle) {
  const before = await loadConfig(root);
  const result = await sourceScans[kind](root,cycle);
  const after = await loadConfig(root);
  if (before.revision !== after.revision) return result;
  const sources = expandedSources(before).filter(source => platform(source) === kind);
  if (!sources.length) return result;
  const file = path.join(paths(root).home,'applied-source-scopes.json');
  const applied = await readJson(file,{});
  for (const source of sources) {
    const listingFailed = result.errors?.some(error => error.subscription_id === source.id)
      || result.auto?.feeds?.some(feed => feed.url === source.url && feed.error)
      || result.reports?.results?.some(feed => !feed.ok)
      || result.sourceRetries?.some(retry => retry.url === source.url && retry.error);
    if (!listingFailed) applied[source.id] = scopeSignature(source);
  }
  await writeJson(file,applied);
  return result;
}

async function applyPendingScopes(root, cycle, progress) {
  const config = await loadConfig(root);
  const applied = await readJson(path.join(paths(root).home,'applied-source-scopes.json'),{});
  const pending = expandedSources(config).filter(source => applied[source.id] !== scopeSignature(source));
  const failures = [];
  for (const kind of new Set(pending.map(platform))) {
    try {
      const result = await scanAndRecordScope(root,kind,cycle);
      const previews = await prepareSubscriptionPreviews(root,kind,{retryCycle:cycle,onPreviewProgress:progress});
      failures.push(...(result.errors || []), ...(result.warnings || []), ...previews.failures);
      failures.push(...(result.auto?.feeds || []).filter(feed=>feed.error).map(feed=>({error:feed.error})));
      failures.push(...(result.reports?.results || []).filter(feed=>!feed.ok).map(feed=>({error:feed.error?.message})));
      failures.push(...(result.sourceRetries || []).filter(retry=>retry.error).map(retry=>({error:retry.error})));
    } catch(error) { failures.push({error:cleanError(error)}); }
  }
  return failures;
}

async function runJob(root, job, save) {
  const progress = event => console.log(JSON.stringify({event:'subscription_preview_progress',kind:job.kind,...event}));
  const step = async (name, action) => {
    if (job.steps[name]?.done) return job.steps[name].result;
    job.current_step = name; await save();
    console.log(JSON.stringify({ event:'subscription_step',kind:job.kind,step:name }));
    const result = await action(); job.steps[name] = { done:true, result }; await save(); return result;
  };
  if (job.kind === 'video_import') {
    const result = await runVideoRequest(root,job.request,step,{onProgress:async progress=>{
      job.progress={...progress,at:stamp()};await save();
    }});
    await noticeFaults(root,'video_import',result.faults);
    if (!result.faults.length) await notify(root,'video_import:'+job.id,'视频图文导入完成',`${result.results.length} 个分 P 已进入阅读区。`);
    return result;
  }
  if (job.kind === 'retry') {
    const config = await loadConfig(root);
    const kinds = new Set(config.subscriptions.filter(source=>source.enabled).map(platform));
    const faults = [];
    for (const kind of kinds) {
      const result = await step(`retry-${kind}`, async () => {
        try {
          const scan = await sourceScans[kind](root,job.cycle,{retryOnly:true});
          const previews = await prepareSubscriptionPreviews(root,kind,{retryCycle:job.cycle,onPreviewProgress:progress});
          return [...(scan.errors || []), ...(scan.warnings || []), ...(scan.blocked || []), ...(previews.failures || []),
            ...(scan.events || []).filter(event=>event.status==='waiting_source').map(event=>({error:event.reason})),
            ...(scan.sourceRetries || []).filter(item=>item.error || item.status==='completed_with_failures')
              .map(item=>({error:item.error || '已重试，RSS 正文仍受来源限制'}))];
        } catch(error) { return [{error:cleanError(error)}]; }
      });
      faults.push(...result);
    }
    const decisions = await step('retry-selections',()=>processMarkdownDecisions(root,{retry:true,retryCycle:job.cycle}));
    faults.push(...decisions.failures);
    await noticeFaults(root,'retry',faults);
    return {faults,status:faults.length ? 'completed_with_issues' : 'completed'};
  }
  if (['rss','bilibili','zhihu'].includes(job.kind)) {
    const scan = await step('scan',() => scanAndRecordScope(root,job.kind,job.cycle));
    const previews = await step('previews',() => prepareSubscriptionPreviews(root,job.kind,{ retryCycle:job.cycle, previewConcurrency:2, onPreviewProgress:progress }));
    const decisions = await step('decisions',() => processMarkdownDecisions(root,{ retry:true, platform:job.kind, retryCycle:job.cycle }));
    const faults = [...(scan.errors || []), ...(scan.warnings || []), ...(scan.blocked || []), ...(previews.failures || []), ...(decisions.failures || [])];
    faults.push(...(scan.events || []).filter(e=>e.status==='waiting_source').map(e=>({key:e.key,error:e.reason})));
    if (scan.auto) faults.push(...scan.auto.feeds.filter(f=>f.error).map(f=>({ url:f.url,error:f.error })));
    if (scan.reports?.status === 'completed_with_failures') faults.push({ error:'部分 RSS 正文仍未就绪', receipt:scan.reports.batch_dir });
    faults.push(...(scan.sourceRetries || []).filter(r=>r.error||r.status==='completed_with_failures').map(r=>({error:r.error||'历史排队条目正文仍受来源限制',urls:r.urls})));
    await noticeFaults(root,job.kind,faults);
    return { faults, status:faults.length ? 'completed_with_issues' : 'completed' };
  }
  if (job.kind === 'decisions') {
    const result = await processMarkdownDecisions(root);
    await noticeFaults(root,'decisions',result.failures); return { ...result, status:result.failures.length ? 'completed_with_issues' : 'completed' };
  }
  const scopeFaults = await step('apply-source-scopes',()=>applyPendingScopes(root,job.cycle,progress));
  await step('decisions',()=>processMarkdownDecisions(root));
  const receipt = await step('report',()=>generateSummaries(root,{ mode:job.kind, executeDecisions:false, ingestSummaries:false, onPreviewProgress:progress }));
  const result = await step('activity',()=>appendActivity(root,receipt));
  await step('notify',async()=>{
    const outputs=Object.entries(result.outputs).filter(([key,value])=>key!=='ledger'&&value?.sha256);
    if(!outputs.length)return {done:true,skipped:'no_report_content'};
    const version=digest(JSON.stringify(outputs.map(([key,value])=>[key,value.sha256])));
    const reportName=result.outputs.long_weekly ? '周报' : result.outputs.daily ? '日报' : '短文周报';
    await notify(root,'report:'+job.kind+':'+version,'订阅报告已生成',`${reportName}已更新，可在 Markdown 中勾选内容。`);
    return {done:true};
  });
  return { status:receipt.status === 'completed' && !scopeFaults.length ? 'completed' : 'completed_with_issues',
    faults:scopeFaults, receipt:result.receipt_path, outputs:result.outputs };
}

export async function drain(root = codeRoot) {
  const config = await loadConfig(root);
  if (!config?.enabled) return { status:'paused' };
  return withLock(path.join(paths(root).home,'worker.lock'),async()=>{
    const completed = [];
    for (;;) {
      const job = (await jobList(root)).find(j=>['queued','running'].includes(j.status));
      if (!job) break;
      const save = () => writeJson(path.join(paths(root).jobs,job.id+'.json'),job);
      job.status='running'; job.pid=process.pid; job.started_at ||= stamp(); await save();
      try { const result = await runJob(root,job,save); job.result=result; job.status=result.status; delete job.error; }
      catch (error) { job.status='failed'; job.error=cleanError(error); await noticeFaults(root,job.kind,[{error:job.error}]); }
      job.completed_at=stamp(); delete job.current_step; await save(); completed.push({ id:job.id,kind:job.kind,status:job.status });
    }
    return { status:'idle',completed };
  });
}

export async function launchWorker(root = codeRoot) {
  const p = paths(root), lock = await readJson(path.join(p.home,'worker.lock'));
  if (lock?.pid) { try { process.kill(lock.pid,0); return; } catch (error) { if(error.code!=='ESRCH') throw error; } }
  if (!(await jobList(root)).some(j=>['queued','running'].includes(j.status))) return;
  await fs.mkdir(path.join(p.artifactRoot,'logs'),{recursive:true});
  const fd = openSync(path.join(p.artifactRoot,'logs',`${Date.now()}-worker.log`),'a');
  try {
    const child = spawn(process.execPath,[path.join(codeRoot,'subscription-workflow','cli.mjs'),'drain','--root',root],{ cwd:codeRoot, windowsHide:true, stdio:['ignore',fd,fd] });
    child.on('error',error=>console.error('subscription_worker_start',cleanError(error))); child.unref();
  } finally { closeSync(fd); }
}

export async function monitorMarkdown(root, now = Date.now()) {
  const p = paths(root), file = path.join(p.home,'markdown-monitor.json');
  const state = await readJson(file,{files:{}}); const changes=[];
  for (const directory of [p.summaryRoot,path.join(root,'摘要区','RSS')]) {
    const names = await fs.readdir(directory).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    for (const name of names.filter(n=>/(?:RSS|订阅) (?:长文日报|日报|长文周报)\.md$/u.test(n))) {
      const target=path.join(directory,name), stat=await fs.stat(target), signature=`${stat.mtimeMs}:${stat.size}`, previous=state.files[target];
      if (!previous || previous.signature!==signature) { state.files[target]={signature,observed:now,processed:previous?.processed}; continue; }
      if (now-previous.observed<45000 || previous.processed===signature) continue;
      const hash=digest(await fs.readFile(target));
      changes.push({target,hash,signature});
    }
  }
  if(changes.length) {
    await enqueue(root,'decisions',changes.map(c=>c.target+':'+c.hash).sort().join('\n'));
    for(const change of changes)state.files[change.target].processed=change.signature;
  }
  await writeJson(file,state); return {queued:changes.length?1:0};
}

export function startSubscriptionWorker(root = codeRoot) {
  if (!existsSync(paths(root).marker)) return () => {};
  let busy=false;
  const tick=async()=>{
    if(busy)return; busy=true;
    try {
      const config=await loadConfig(root); if(!config?.enabled)return;
      await monitorMarkdown(root); await launchWorker(root);
      const summary=await advanceAuto(root); await collectActivity(root);
      await writeJson(path.join(paths(root).home,'auto-status.json'),summary);
      const faults=[...summary.items.filter(i=>['source_blocked','verification_failed','retry_wait','route_conflict'].includes(i.status)).map(i=>({title:i.title,error:i.error})), ...(summary.backend_error?[{error:summary.backend_error}]:[])];
      await noticeFaults(root,'automatic',faults);
      await writeJson(path.join(paths(root).home,'heartbeat.json'),{at:stamp(),pid:process.pid,status:'ready'});
    } catch(error) {
      if(!/already_running|该操作正在执行/u.test(error.message)) {
        console.error('subscription_tick',cleanError(error));
        await writeJson(path.join(paths(root).home,'heartbeat.json'),{at:stamp(),pid:process.pid,status:'error',error:cleanError(error)}).catch(()=>{});
      }
    } finally {busy=false;}
  };
  const timer=setInterval(tick,15000); timer.unref(); void tick(); return ()=>clearInterval(timer);
}

export async function resolveMode(root,id,mode) {
  if(!['original_text','standard_preprocess'].includes(mode))throw new Error('处理模式无效');
  return withAutoImporter(root,async importer=>{
    const item=importer.state.items[id]; if(!item||item.status!=='route_conflict')throw new Error('该条目当前没有待解决的模式冲突');
    item.mode_resolution=mode;item.mode_resolved_at=stamp();item.status='pending';item.error=null;await importer.save();return {status:'queued'};
  });
}

export async function status(root = codeRoot,{broker}={}) {
  const p=paths(root),config=await loadConfig(root),jobs=await jobList(root);
  if(!config)return {initialized:false};
  const text=await readJson(path.join(config.rss_home,'state.json'),{items:{}}),video=await readJson(path.join(config.video_home,'state.json'),{entries:{}});
  const ledger=await readJson(path.join(root,'imports','rss-reading','review-ledger.v1.json'),{items:{}});
  const zhihu=await readJson(path.join(p.home,'zhihu-state.json'),{sources:{},entries:{}});
  const entries=[...Object.values(text.items).map(i=>({id:i.id,title:i.title,url:i.url,status:i.status,error:i.error})),
    ...Object.values(video.entries).map(i=>({id:i.key,title:i.video_title,url:i.url,status:i.status,error:i.reason})),
    ...Object.values(zhihu.entries).map(i=>({id:i.key||digest(i.url),title:i.title,url:i.url,status:i.status,error:i.error}))];
  const reportRows=Object.values(ledger.items).filter(i=>!i.canonical_material_id);
  const reportDate = file => {
    const name=path.basename(file), week=/^(\d{4})-W(\d{2})/u.exec(name);
    if(!week)return Date.parse(name.slice(0,10))||0;
    const fourth=new Date(Date.UTC(Number(week[1]),0,4));
    return fourth.getTime()+((Number(week[2])-1)*7-((fourth.getUTCDay()+6)%7)+6)*86400000;
  };
  const reports=[...new Set([...(ledger.report_runs?.daily?Object.values(ledger.report_runs.daily).map(r=>r.path):[]),
    ...Object.values(ledger.report_runs?.weekly||{}).flatMap(r=>[r.long_weekly?.path,r.short_weekly?.path]),
    ...jobs.flatMap(j=>Object.values(j.result?.outputs||{}).filter(o=>o?.path&&o.path.endsWith('.md')).map(o=>o.path))].filter(file=>file && existsSync(file)))].sort((a,b)=>reportDate(b)-reportDate(a)||a.localeCompare(b)).slice(0,8);
  const failures=await subscriptionImportIssues(root,reportRows.filter(i=>i.route!=='import_activity'&&(i.publication_failure||i.review_preview?.status==='failed'||(!i.eligible_for_preprocess&&i.decision==='unresolved'))),{broker});
  return {initialized:true,enabled:config.enabled,revision:config.revision,schedule:config.schedule,
    exception_path:existsSync(exceptionFile(root)) ? exceptionFile(root) : null,
    subscriptions:config.subscriptions.map(({watch,...s})=>s), heartbeat:await readJson(path.join(p.home,'heartbeat.json')),
    notifications:await readJson(path.join(p.home,'notifications.json')),
    pending_job_count:jobs.filter(j=>['running','queued'].includes(j.status)).length,
    jobs:[...jobs.filter(j=>j.status==='running'),...jobs.filter(j=>j.status==='queued'),...jobs.filter(j=>!['running','queued'].includes(j.status)).reverse()].slice(0,25)
      .map(({steps,...job})=>({...job,steps:Object.entries(steps||{}).map(([name,s])=>({name,done:s.done}))})),
    conflicts:entries.filter(i=>i.status==='route_conflict'), pending:entries.filter(i=>['pending','processing','running','waiting_source','blocked','source_blocked','verification_failed','retry_wait'].includes(i.status)).map(i=>({...i,error:i.error?readableImportError(i.error):null,severity:['blocked','source_blocked','verification_failed','waiting_source'].includes(i.status)?'blocking':undefined})),
    failures,import_issues:failures, zhihu_sources:zhihu.sources, zhihu_validation:await readJson(path.join(p.home,'zhihu-validation.json')), reports, updates:reportRows.filter(i=>i.available_revision).map(i=>({title:i.title,url:i.item_url})),
    counts:entries.reduce((a,i)=>{a[i.status]=(a[i.status]||0)+1;return a;},{}), config_path:p.config};
}
