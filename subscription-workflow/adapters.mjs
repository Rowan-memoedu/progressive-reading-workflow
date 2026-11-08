import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, paths, readJson, writeJson, withLock, digest, platform } from './config.mjs';
import { saveSourceMaterial, findExistingPublication, materialKey } from './catalog.mjs';
import { RssImporter, acquireLock } from '../rss-import/core.mjs';
import { syncAll, fetchText } from '../rss-source/cli.mjs';
import { parseFeedDocument, syncFeedDocument } from '../rss-source/core.mjs';
import { includesPublication, retainedFeedSnapshots } from './history.mjs';
import { scanCatalog } from '../rss-reading/core.mjs';
import { discover, observe, processPending } from '../video-workflow/watch-core.mjs';
import { existingPublications } from '../video-workflow/watch.mjs';
import { prepareWatchSource, processWatchItem, WATCH_ARTIFACTS } from '../video-workflow/watch-process.mjs';
import { WATCH_WORKFLOW, WATCH_MODEL, WATCH_FRAME_POLICY } from '../video-workflow/watch-illustrated.mjs';
import { LiveCookieSnapshot } from '../scripts/live-cookie-snapshot.mjs';
import { discoverZhihuColumn } from '../scripts/zhihu-column-import.mjs';
import { requestZhihuJson } from '../scripts/zhihu-social-archive.mjs';
import { defaultCookieDataRoot } from '../scripts/live-cookie-snapshot.mjs';
import { fetchUrlWithoutBrowser } from '../scripts/url-background-fetch.mjs';
import { htmlArticleToMarkdown } from '../scripts/browser-page-markdown.mjs';

export function autoConfig(config, onlyRss = false) {
  const subscriptions = config.subscriptions.filter(s => s.enabled && !s.kind.startsWith('bilibili_') && s.mode !== 'reports' && (!onlyRss || s.kind === 'rss'))
    .map(s => ({ url: s.url, name: s.name, route: s.mode, destination: s.destination, subscription_id: s.id,
      history_mode: s.history_mode, earliest_date: s.earliest_date }));
  return { ...config.rss_defaults, enabled: config.enabled, subscriptions, feeds: subscriptions.map(s => s.url),
    report_feeds: config.subscriptions.filter(s => s.enabled && s.kind === 'rss' && s.mode === 'reports').map(s => s.url),
    current_feed_only: true, poll_minutes: 1440, max_in_flight: 2, retry_minutes: 60, destination_folder: 'RSS' };
}

export async function withAutoImporter(root, action) {
  const config = await loadConfig(root), release = await acquireLock(config.rss_home);
  try { const importer = await new RssImporter({ home: config.rss_home, workflowRoot: root }).load(); return await action(importer, config); }
  finally { await release(); }
}

export async function advanceAuto(root) {
  return withAutoImporter(root, async (importer, registry) => {
    if (!registry.enabled) return { enabled: false };
    const config = autoConfig(registry);
    try { await importer.advance(config, await importer.backend(config)); importer.state.backend_error = null; }
    catch (error) { importer.state.backend_error = error.message; }
    await importer.save();
    return importer.summary(config);
  });
}

export async function retryAuto(root, kind, cycle) {
  return withAutoImporter(root, async (importer, config) => {
    const sources = config.subscriptions.filter(s => s.enabled && platform(s) === kind);
    let retried = 0;
    for (const item of Object.values(importer.state.items)) {
      if (!sources.some(source => item.feeds.includes(source.url) && includesPublication(source,item.published_at))
        || !['source_blocked','verification_failed','retry_wait'].includes(item.status) || item.retry_cycle === cycle) continue;
      const existing = await findExistingPublication(root, item.url);
      if (existing) Object.assign(item, { status: 'imported', artifacts: [existing], preserved_existing: true, error: null });
      else { item.status = 'pending'; item.retry_cycle = cycle; retried++; }
    }
    await importer.save(); return { retried };
  });
}

export async function scanRss(root, cycle, { retryOnly = false } = {}) {
  if (retryOnly) {
    const sourceRetries = await retryBlockedReportSources(root, cycle);
    return { sourceRetries, retry:await retryAuto(root,'rss',cycle) };
  }
  const scanned = await withAutoImporter(root, async (importer, config) => {
    await importer.scan(autoConfig(config, true), { force: true }); return importer.summary(autoConfig(config, true));
  });
  const config = await loadConfig(root);
  const reports = await syncAll({ config: path.join(config.rss_home, 'RSS 自动导入.md'), force:true });
  const history = await replayRssHistory(root, config, reports);
  const sourceRetries = [...history, ...await retryBlockedReportSources(root, cycle, {
    results: [...reports.results, ...history.filter(item => item.result).map(item => ({result:item.result}))]
  })];
  const retry = await retryAuto(root, 'rss', cycle);
  return { auto: scanned, reports, retry, sourceRetries };
}

export async function replayRssHistory(root, config, reports, fetchPage = fetchText) {
  const results = [];
  const sources = config.subscriptions.filter(source => source.enabled && source.kind === 'rss' && source.mode === 'reports'
    && ['since','all'].includes(source.history_mode));
  if (!sources.length) return results;
  const known = new Set((await scanCatalog(root)).items.filter(item => item.itemUrl).map(item => materialKey(item.itemUrl)));
  for (const result of reports.results || []) {
    for (const item of result.result?.items || []) {
      if (item.identity?.normalized_item_url) known.add(materialKey(item.identity.normalized_item_url));
    }
  }
  for (const source of sources) {
    try {
      for (const snapshot of await retainedFeedSnapshots(root, config.rss_home, source.url)) {
        const xml = await fs.readFile(snapshot,'utf8');
        const parsed = await parseFeedDocument(xml,source.url);
        const urls = parsed.items.filter(item => item.item_url && !known.has(materialKey(item.item_url))
          && includesPublication(source,item.published_at)).map(item => item.item_url);
        if (!urls.length) continue;
        const result = await syncFeedDocument({
          feedUrl:source.url, xml, outputRoot:path.join(root,'imports','rss','source-v1'), onlyItemUrls:urls,
          preserveFeedState:true, fetchFulltext:true,
          articleFetcher:async url => {
            const page = await fetchPage(url,{maxBytes:12*1024*1024});
            return {html:page.text,response:{status:page.response.status,final_url:page.finalUrl}};
          }
        });
        urls.forEach(url => known.add(materialKey(url)));
        results.push({urls,status:result.status,run_dir:result.run_dir,result});
      }
    } catch(error) { results.push({url:source.url,error:error.message}); }
  }
  return results;
}

export async function retryBlockedReportSources(root, cycle, reports = {}, fetchPage = fetchText) {
  const attempted = new Set((reports.results || []).flatMap(r=>r.result?.items || []).map(i=>i.identity?.normalized_item_url).filter(Boolean).map(materialKey));
  const catalog = await scanCatalog(root), file=path.join(paths(root).home,'source-retries.json'), state=await readJson(file,{}), results=[];
  const groups=new Map();
  for(const item of catalog.items.filter(i=>i.platform==='rss'&&!i.eligible&&i.itemUrl)) {
    const key=materialKey(item.itemUrl);
    if(attempted.has(key)||state[key]?.cycle===cycle)continue;
    const pkg=await readJson(item.packageFile), snapshot=pkg.artifacts?.raw_feed_snapshot;
    if(!snapshot){results.push({url:item.itemUrl,error:'原始 Feed 快照缺失，无法安全重试'});continue;}
    const snapshotPath=path.resolve(item.packageDir,snapshot), relative=path.relative(path.join(root,'imports','rss','source-v1'),snapshotPath);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('retry_snapshot_outside_source_area');
    const groupKey=item.feedUrl+'\n'+snapshotPath;
    if(!groups.has(groupKey))groups.set(groupKey,{feedUrl:item.feedUrl,snapshot:snapshotPath,urls:[]});
    groups.get(groupKey).urls.push(item.itemUrl);state[key]={cycle,at:new Date().toISOString()};
  }
  await writeJson(file,state);
  for(const group of groups.values()) {
    try {
      const result=await syncFeedDocument({feedUrl:group.feedUrl,xml:await fs.readFile(group.snapshot,'utf8'),outputRoot:path.join(root,'imports','rss','source-v1'),
        fetchFulltext:true,onlyItemUrls:group.urls,preserveFeedState:true,articleFetcher:async url=>{const page=await fetchPage(url,{maxBytes:12*1024*1024});return {html:page.text,response:{status:page.response.status,final_url:page.finalUrl}};}});
      results.push({urls:group.urls,status:result.status,run_dir:result.run_dir});
    } catch(error){results.push({urls:group.urls,error:error.message});}
  }
  return results;
}

export function sourceWatch(root, source) {
  return { workflow: WATCH_WORKFLOW, body_mode: 'strong_structuring', media_policy: 'generated_and_reviewed',
    frame_policy: WATCH_FRAME_POLICY, provider: 'codex_exec', model: WATCH_MODEL, part_unit: 'individual',
    ...source.watch, id: source.watch?.id || source.id, url: source.url, name: source.name,
    destination: path.resolve(root, '阅读区', source.destination), public_packages: false,
    collection: source.kind === 'bilibili_collection', subscription_id: source.id, mode: source.mode,
    history_mode: source.history_mode, earliest_date: source.earliest_date };
}

export async function prepareVideoPreview(root, source, item, watch, { acquire, artifactRoot = WATCH_ARTIFACTS } = {}) {
  const acquired = await prepareWatchSource(item, watch, artifactRoot, acquire);
  if (acquired.status === 'waiting_source') return acquired;
  const transcript = await readJson(path.join(acquired.sourceDir, 'transcript.json'));
  if (!transcript?.segments?.length || transcript.segments.some(s => !String(s.text || '').trim())) throw new Error('完整字幕不可用');
  const markdown = transcript.segments.map(s => s.text.trim()).join('\n\n');
  const record = await saveSourceMaterial(root, source, { ...item, title: item.parts > 1 ? `${item.video_title} · P${item.part} ${item.part_title}` : item.video_title }, markdown,
    { source_ref: path.join(acquired.sourceDir, 'transcript.json'), subtitle_segments: transcript.segments.length,
      video: { ...item, watch: { ...watch } } });
  return { status: 'awaiting_review', material_id: record.material_id };
}

export async function scanVideos(root, cycle, { discoverFn = discover, processFn = processWatchItem, previewFn = prepareVideoPreview, existingFn = existingPublications, retryOnly = false } = {}) {
  const config = await loadConfig(root), data = config.video_home;
  return withLock(path.join(data, 'watch.lock'), async () => {
    const sources = config.subscriptions.filter(s => s.enabled && s.kind.startsWith('bilibili_'));
    const state = await readJson(path.join(data, 'state.json'));
    if (!state) throw new Error('视频历史状态缺失，已停止以防重复导入');
    state.watch_baselines ||= {};
    const save = () => writeJson(path.join(data, 'state.json'), state);
    const previous = retryOnly ? await readJson(path.join(data,'last-check.json'),{}) : {};
    const failedSources = new Set((previous.errors || []).map(error=>error.subscription_id));
    const existing = await existingFn(), errors = [], added = [];
    const watches = sources.map(s => sourceWatch(root, s));
    for (const watch of watches) {
      if (retryOnly && !failedSources.has(watch.subscription_id)) continue;
      try {
        if (watch.collection && state.watch_baselines[watch.id]?.season_id != null) watch.season_id = state.watch_baselines[watch.id].season_id;
        const found = await discoverFn(watch);
        if (watch.collection && !found.season_id) throw new Error('此视频未发现合集，请改为多 P 视频订阅');
        const source = sources.find(s => s.id === watch.subscription_id);
        const backfill = ['since','all'].includes(source.history_mode);
        const baseline = !backfill && !source.baseline_ready && !state.watch_baselines[watch.id];
        if (backfill) observe(state,watch,found.items.filter(item => !includesPublication(source,item.published_at)),{baseline:true,existing});
        const eligible = found.items.filter(item => includesPublication(source,item.published_at));
        added.push(...observe(state, watch, eligible, { baseline, existing, promoteBaseline:backfill }));
        if (backfill) {
          const listed = new Set(found.items.map(item=>item.key));
          const retained = Object.values(state.entries).filter(item => item.status==='baseline' && !listed.has(item.key)
            && (item.watch_ids || [item.watch_id]).includes(watch.id) && includesPublication(source,item.published_at));
          added.push(...observe(state,watch,retained,{existing,promoteBaseline:true}));
        }
        state.watch_baselines[watch.id] ||= { at: new Date().toISOString(), count: found.items.length, season_id: found.season_id };
        await save();
      } catch (error) { errors.push({ subscription_id: watch.subscription_id, error: error.message }); }
    }
    const matches = item => watches.filter(w => (item.watch_ids || [item.watch_id]).includes(w.id) && includesPublication(w,item.published_at));
    for (const item of Object.values(state.entries)) if (item.status === 'awaiting_review' && matches(item).some(w => w.mode === 'standard_preprocess')) item.status = 'pending';
    const events = await processPending(state, { save, retryCycle: cycle, eligible: item => matches(item).length > 0
      && (!retryOnly || ['blocked','waiting_source','running'].includes(item.status) || added.includes(item)),
      processItem: async item => {
        const candidates = matches(item), watch = candidates.find(w => w.mode === 'standard_preprocess') || candidates[0];
        const source = sources.find(s => s.id === watch.subscription_id);
        console.log(JSON.stringify({ event: 'subscription_video', key: item.key, mode: watch.mode }));
        if (watch.mode === 'reports') {
          const result = await previewFn(root, source, item, watch);
          if (result.material_id) for (const other of candidates.filter(w => w.id !== watch.id && w.mode === 'reports')) {
            const file = path.join(paths(root).sources, result.material_id, 'record.json'), record = await readJson(file);
            record.subscription_ids = [...new Set([...record.subscription_ids, other.subscription_id])]; await writeJson(file, record);
          }
          return result;
        }
        return processFn(item, watch);
      } });
    const report = { checked_at: new Date().toISOString(), new_items: added, events, errors,
      pending: Object.values(state.entries).filter(i => ['pending','waiting_source'].includes(i.status)).length,
      blocked: Object.values(state.entries).filter(i => i.status === 'blocked').map(({key,reason}) => ({key,reason})) };
    await writeJson(path.join(data, 'last-check.json'), report); return report;
  });
}

export async function publishVideoSelection(root, item) {
  const config = await loadConfig(root);
  return withLock(path.join(config.video_home, 'watch.lock'), async () => {
    const file = path.join(config.video_home, 'state.json'), state = await readJson(file);
    const record = state?.entries[item.video?.key];
    if (!record || !item.video?.watch) throw new Error('视频原始任务记录缺失');
    if (record.status === 'completed' && record.publication && await fs.stat(record.publication).then(s => s.isFile(), () => false)) return { publication: record.publication, runDir: record.run_dir };
    const result = await processWatchItem(record, item.video.watch);
    if (result.status !== 'completed') throw new Error(result.reason || '视频处理未完成');
    Object.assign(record, { status: 'completed', publication: result.publication, run_dir: result.runDir, completed_at: new Date().toISOString() });
    delete record.reason; await writeJson(file, state); return result;
  });
}

export function zhihuAccess(root) {
  const snapshot = new LiveCookieSnapshot({ workflowRoot: root, dataRoot: defaultCookieDataRoot(root) });
  snapshot.refresh({ force: true });
  return { cookieHeaderForUrl: url => snapshot.headerForUrl(url), retryDelaysMs: [],
    fetchImpl: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(30000) }) };
}

export async function discoverAuthor(source, options, request = requestZhihuJson) {
  const token = new URL(source.url).pathname.split('/').filter(Boolean).at(-1), items = [];
  for (const kind of ['answers','articles']) {
    const endpoint = `/api/v4/members/${token}/${kind}`, visited = new Set();
    let next = `https://www.zhihu.com${endpoint}?limit=20&offset=0&sort_by=created&include=data%5B*%5D.content,created,created_time,updated,updated_time`;
    while (next) {
      const target = new URL(next);
      if (target.origin !== 'https://www.zhihu.com' || target.pathname !== endpoint || target.username || target.password || visited.has(next) || visited.size >= 1000) throw new Error('知乎作者分页不完整');
      visited.add(next);
      const page = await request(next, options);
      if (!Array.isArray(page.data) || typeof page.paging?.is_end !== 'boolean') throw new Error('知乎作者列表格式异常');
      for (const value of page.data) {
        if (!/^\d+$/u.test(String(value.id)) || (kind === 'answers' && !/^\d+$/u.test(String(value.question?.id)))) throw new Error('知乎内容身份无效');
        items.push({ key: `zhihu:${kind}:${value.id}`, url: kind === 'answers' ? `https://www.zhihu.com/question/${value.question.id}/answer/${value.id}` : `https://zhuanlan.zhihu.com/p/${value.id}`,
          title: kind === 'answers' ? value.question.title : value.title, author: value.author?.name || source.name,
          published_at: value.created_time || value.created ? new Date((value.created_time || value.created) * 1000).toISOString() : null,
          revision: String(value.updated_time || value.updated || ''), html: value.content || null });
      }
      if (!page.paging.is_end && (!page.data.length || !page.paging.next)) throw new Error('知乎作者列表缺少后续页');
      next = page.paging.is_end ? null : page.paging.next;
    }
  }
  return [...new Map(items.map(i => [i.url,i])).values()];
}

export async function scanZhihu(root, cycle, { access = zhihuAccess, discoverColumn = discoverZhihuColumn, discoverMember = discoverAuthor, fetchPage = fetchUrlWithoutBrowser, retryOnly = false } = {}) {
  const config = await loadConfig(root), file = path.join(paths(root).home, 'zhihu-state.json');
  const state = await readJson(file, { sources: {}, entries: {} }), options = access(root), errors = [];
  for (const source of config.subscriptions.filter(s => s.enabled && s.kind.startsWith('zhihu_'))) {
    const previous = state.sources[source.id];
    if (retryOnly && !previous?.error) continue;
    try {
      const listed = source.kind === 'zhihu_column' ? (await discoverColumn(source.url, options)).articles : await discoverMember(source, options);
      const seen = new Set(previous?.seen || []);
      const backfill = ['since','all'].includes(source.history_mode);
      for (const item of listed) {
        const key = materialKey(item.url);
        if ((!previous?.baseline_at && !backfill) || !includesPublication(source,item.published_at)) { seen.add(key); continue; }
        const entry = state.entries[key];
        if (backfill || !seen.has(key)) state.entries[key] ||= { ...item, sources: [], status: 'pending', first_seen: new Date().toISOString() };
        const current = state.entries[key];
        if (current) current.published_at ??= item.published_at;
        if (current && !current.sources.includes(source.id)) current.sources.push(source.id);
        if (entry && item.revision && item.revision !== entry.revision && entry.status === 'ready') entry.source_updated = new Date().toISOString();
        seen.add(key);
      }
      state.sources[source.id] = { baseline_at: previous?.baseline_at || new Date().toISOString(), seen: [...seen], checked_at: new Date().toISOString(), error: null };
      await writeJson(file, state);
    } catch (error) { state.sources[source.id] = { ...previous, error: error.message, checked_at: new Date().toISOString() }; errors.push({ subscription_id: source.id, error: error.message }); }
  }
  for (const item of Object.values(state.entries)) {
    if (retryOnly && !['blocked','pending'].includes(item.status)) continue;
    const sources = config.subscriptions.filter(s => item.sources.includes(s.id) && s.enabled && includesPublication(s,item.published_at));
    const modeSignature = sources.map(s=>s.id+':'+s.mode).sort().join('|');
    if (!sources.length || (item.status === 'ready' && item.mode_signature === modeSignature) || item.last_cycle === cycle) continue;
    item.last_cycle = cycle;
    try {
      const reports = sources.filter(s => s.mode === 'reports');
      if (reports.length) {
        const page = item.html ? { body: item.html, isHtml: true, title: item.title, finalUrl: item.url } : await fetchPage(item.url, options);
        const markdown = page.isHtml ? htmlArticleToMarkdown({ html: page.body, sourceUrl: page.finalUrl, title: item.title }).markdown : page.body;
        for (const source of reports) await saveSourceMaterial(root, source, item, markdown);
      }
      const automatic = sources.filter(s => s.mode !== 'reports');
      if (automatic.length) await withAutoImporter(root, async importer => {
        const id = digest(materialKey(item.url)), entry = importer.state.items[id] ||= { id, url: item.url, title: item.title, published_at: item.published_at,
          date_unknown: !item.published_at, feeds: [], status: 'pending', attempt: 0, first_seen_at: item.first_seen, attempts: [] };
        entry.feeds = [...new Set([...entry.feeds, ...automatic.map(s => s.url)])]; await importer.save();
      });
      item.status = 'ready'; item.mode_signature = modeSignature; delete item.html; delete item.error;
    } catch (error) { item.status = 'blocked'; item.error = error.message; errors.push({ url: item.url, error: error.message }); }
    await writeJson(file, state);
  }
  await writeJson(file, state);
  return { checked_at: new Date().toISOString(), subscriptions: Object.keys(state.sources).length, errors, retry: await retryAuto(root, 'zhihu', cycle) };
}
