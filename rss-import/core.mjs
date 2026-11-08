import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseFeedDocument } from '../rss-source/core.mjs';
import { fetchText } from '../rss-source/cli.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';
import { DEFAULT_HOME, loadConfig } from './config.mjs';
import { includesPublication, retainedFeedSnapshots } from '../subscription-workflow/history.mjs';
export { DEFAULT_HOME, CONFIG_NAME, parseConfig, loadConfig } from './config.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const SUCCESS = new Set(['imported', 'imported_with_warnings', 'idempotent_replay']);
const stamp = now => new Date(now()).toISOString();
export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function saveJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(temp, file);
}
export function itemEligibility(item, config, now = Date.now) {
  if (!item.item_url) return 'missing_url';
  const date = Date.parse(item.published_at);
  if (!Number.isFinite(date)) return 'date_unknown';
  if (date > now()) return 'future';
  return !config.current_feed_only && date < now() - config.lookback_days * 86400000 ? 'outside_window' : 'eligible';
}

async function retainedRequest(workflowRoot, record) {
  if (record?.content_status !== 'fulltext_ready' || !record.package_path) return null;
  const relative = path.relative(path.join(workflowRoot,'imports','rss','source-v1','packages'),record.package_path);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const request = await readJson(path.join(record.package_path,'preprocess-request.json'));
  return typeof request?.material?.markdown === 'string' && request.material.markdown.trim() ? request : null;
}
export async function verifyImport(result, readingRoot, expectedMode = 'standard_preprocess') {
  if (!SUCCESS.has(result?.status)) return { ok: false, reason: result?.error || result?.status || 'missing_result' };
  const mode = result.receipt?.processing_mode;
  const preserved = result.status==='idempotent_replay' && result.receipt?.existing_article_preserved===true;
  if (!['standard_preprocess','original_text'].includes(mode) || (mode!==expectedMode && !preserved)) return {ok:false,reason:'unexpected_processing_mode'};
  if (mode==='original_text' && result.receipt?.llm_used!==false) return {ok:false,reason:'original_import_llm_contract_missing'};
  const artifacts = (result.artifacts || []).filter(item => item.kind === 'markdown');
  if (!artifacts.length) return { ok: false, reason: 'missing_markdown_artifact' };
  const checked = [];
  try {
    const root = await fs.realpath(readingRoot);
    for (const artifact of artifacts) {
      const file = await fs.realpath(artifact.path);
      const relative = path.relative(root, file);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(file) !== '.md') throw new Error('artifact_outside_reading_root');
      const bytes = await fs.readFile(file);
      if (!bytes.toString('utf8').trim() || hash(bytes) !== artifact.sha256) throw new Error('artifact_hash_mismatch');
      checked.push({ path: file, sha256: artifact.sha256 });
    }
  } catch (error) { return { ok: false, reason: error.message }; }
  return { ok: true, status: result.status === 'imported_with_warnings' || result.receipt?.quality_status === 'warning' ? 'imported_with_warnings' : 'imported', artifacts: checked, processing_mode:mode, preserved_existing:preserved };
}
async function apiRequest(url, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), ...(body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  } : {}) });
  if (!response.ok) throw new Error(`local_http_${response.status}`);
  return response.json();
}
export async function acquireLock(home) {
  await fs.mkdir(home, { recursive: true });
  const file = path.join(home, 'runtime.lock.json');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(file, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() }));
      await handle.close();
      return async () => { if ((await readJson(file))?.token === token) await fs.unlink(file); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readJson(file);
      if (!Number.isInteger(existing?.pid)) throw new Error('rss_import_lock_invalid');
      try { process.kill(existing.pid, 0); throw new Error('rss_import_already_running'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await fs.unlink(file);
    }
  }
  throw new Error('rss_import_lock_unavailable');
}
export class RssImporter {
  constructor({ home = DEFAULT_HOME, workflowRoot, now = Date.now, fetchFeed = fetchText, request = apiRequest, syncObsidian = null } = {}) {
    Object.assign(this, { home: path.resolve(home), workflowRoot, now, fetchFeed, request, syncObsidian });
    this.stateFile = path.join(this.home, 'state.json');
  }
  async load() {
    this.state = await readJson(this.stateFile, { schema: 'progressive-reading.rss-auto-import/v1', feeds: {}, items: {} });
    if (this.state.schema !== 'progressive-reading.rss-auto-import/v1') throw new Error('unsupported_state_schema');
    return this;
  }
  async save() { this.state.updated_at = stamp(this.now); await saveJson(this.stateFile, this.state); }
  async collectFeedItem(item, feedUrl, config, subscription, sourceIndex, archived = false) {
    const eligibility = includesPublication(subscription, item.published_at) ? itemEligibility(item, config, this.now) : 'outside_window';
    const key = item.item_url ? hash(urlImportDedupeKey(item.item_url)) : null;
    if (['eligible', 'date_unknown'].includes(eligibility)) {
      const entry = this.state.items[key] ||= { id: key, url: item.item_url, title: item.title,
        published_at: item.published_at, date_unknown: eligibility === 'date_unknown', feeds: [],
        status: 'pending', attempt: 0, first_seen_at: stamp(this.now), attempts: [] };
      const contentHash = /^[a-f0-9]{64}$/u.test(item.feed_content.content_hash || '')
        ? item.feed_content.content_hash : hash(item.feed_content.raw || item.feed_content.markdown || item.title || '');
      if (!archived && entry.source_content_hash && entry.source_content_hash !== contentHash) {
        entry.available_revision = { content_hash: contentHash, detected_at: stamp(this.now) };
        delete entry.cached_article_hash;
      }
      entry.source_content_hash ||= contentHash;
      if (!archived) entry.source_content_hash = contentHash;
      if (!entry.feeds.includes(feedUrl)) entry.feeds.push(feedUrl);
      if (sourceIndex && !['imported','imported_with_warnings'].includes(entry.status) && entry.source_content_hash === contentHash) {
        let markdown = item.feed_content.status === 'fulltext_ready' ? item.feed_content.markdown : null;
        const known = sourceIndex.aliases?.['item_url:' + item.item_url];
        if (!markdown && known?.content_hash === contentHash) {
          const request = await retainedRequest(this.workflowRoot,sourceIndex.materials?.[known.material_id]);
          if (request?.source_metadata?.item_url === item.item_url) markdown = request.material.markdown;
        }
        if (markdown?.trim() && markdown.length <= 300000 && Buffer.byteLength(markdown) <= 700000) {
          await saveJson(path.join(this.home,'cached-articles',key,contentHash+'.json'), { markdown, title:item.title, published_at:item.published_at });
          entry.cached_article_hash = contentHash;
        }
      }
    }
    return { index: item.index, title: item.title, url: item.item_url, published_at: item.published_at, eligibility, item_id: key };
  }
  async scan(config, { force = false } = {}) {
    for (const feedUrl of config.feeds) {
      const feed = this.state.feeds[feedUrl] ||= { url: feedUrl, rows: [] };
      const subscription = config.subscriptions.find(item=>item.url===feedUrl);
      feed.route = subscription.route;
      feed.display_name = subscription.name;
      if (!force && Date.parse(feed.next_scan_at) > this.now() && feed.lookback_days === config.lookback_days) continue;
      const collectHistory = ['since','all'].includes(subscription.history_mode);
      const sourceIndex = collectHistory ? await readJson(path.join(this.workflowRoot,'imports','rss','source-v1','state.json'), {}) : null;
      const currentUrls = new Set();
      try {
        // Re-evaluate cached XML when the date window changes, even after a 304.
        const headers = { ...(feed.etag ? { 'If-None-Match': feed.etag } : {}), ...(feed.last_modified ? { 'If-Modified-Since': feed.last_modified } : {}) };
        const fetched = await this.fetchFeed(feedUrl, { headers });
        let xml = fetched.text;
        if (fetched.response.status === 304) {
          if (!feed.snapshot) throw new Error('304_without_feed_snapshot');
          xml = await fs.readFile(feed.snapshot, 'utf8');
        } else {
          const snapshot = path.join(this.home, 'feeds', hash(feedUrl).slice(0, 16), `${hash(xml)}.xml`);
          await fs.mkdir(path.dirname(snapshot), { recursive: true });
          await fs.writeFile(snapshot, xml, 'utf8');
          feed.snapshot = snapshot;
        }
        const parsed = await parseFeedDocument(xml, fetched.finalUrl || feedUrl);
        const rows = [];
        for (const item of parsed.items) {
          if (item.item_url) currentUrls.add(urlImportDedupeKey(item.item_url));
          rows.push(await this.collectFeedItem(item, feedUrl, config, subscription, sourceIndex));
        }
        Object.assign(feed, { status: 'ok', title: parsed.title, item_count: parsed.item_count,
          rows, last_success_at: stamp(this.now), lookback_days: config.lookback_days, error: null });
        if (fetched.response.status !== 304) {
          feed.etag = fetched.response.headers.get('etag') || '';
          feed.last_modified = fetched.response.headers.get('last-modified') || '';
        }
      } catch (error) { feed.status = 'failed'; feed.error = error.message; }
      if (collectHistory) {
        try {
          for (const snapshot of await retainedFeedSnapshots(this.workflowRoot,this.home,feedUrl)) {
            const parsed = await parseFeedDocument(await fs.readFile(snapshot,'utf8'),feedUrl);
            for (const item of parsed.items) {
              if (!item.item_url) continue;
              const key = urlImportDedupeKey(item.item_url);
              if (currentUrls.has(key)) continue;
              currentUrls.add(key);
              await this.collectFeedItem(item, feedUrl, config, subscription, sourceIndex, true);
            }
          }
          const canonicalFeed = sourceIndex.feeds?.[feedUrl]?.canonical_feed_url || feedUrl;
          const retained = Object.values(sourceIndex.materials || {}).filter(item=>item.content_status==='fulltext_ready')
            .sort((a,b)=>String(b.last_seen_at || '').localeCompare(String(a.last_seen_at || '')));
          for (const record of retained) {
            const request = await retainedRequest(this.workflowRoot,record);
            const metadata = request?.source_metadata;
            if (!metadata?.item_url || ![feedUrl,canonicalFeed].includes(metadata.feed_url)) continue;
            const key = urlImportDedupeKey(metadata.item_url);
            if (currentUrls.has(key)) continue;
            currentUrls.add(key);
            await this.collectFeedItem({ item_url:metadata.item_url, title:metadata.title,
              published_at:metadata.published_at, feed_content:{ status:'fulltext_ready',
                markdown:request.material.markdown, content_hash:record.content_hash } },
            feedUrl, config, subscription, sourceIndex, true);
          }
        } catch (error) { feed.status = 'failed'; feed.error = error.message; }
      }
      feed.checked_at = stamp(this.now);
      feed.next_scan_at = new Date(this.now() + config.poll_minutes * 60000).toISOString();
      await this.save();
    }
  }
  active(item, config) {
    return item.feeds.some(feed => config.feeds.includes(feed) && includesPublication(config.subscriptions.find(source=>source.url===feed), item.published_at))
      && ['eligible', 'date_unknown'].includes(itemEligibility({item_url:item.url, published_at:item.published_at},config,this.now));
  }
  importModes(item, config) {
    if (item.mode_resolution && ['standard_preprocess','original_text'].includes(item.mode_resolution)) return [item.mode_resolution];
    return [...new Set(config.subscriptions.filter(source=>source.route!=='reports' && item.feeds.includes(source.url)
      && includesPublication(source,item.published_at)).map(source=>source.route))];
  }
  async backend(config) {
    const info = await readJson(path.join(this.workflowRoot, 'imports', 'app-server.json'), {});
    const base = /^http:\/\/127\.0\.0\.1:\d+$/u.test(info.url || '') ? info.url : 'http://127.0.0.1:37829';
    const health = await this.request(base + '/api/highlights/health');
    if (!health.browserImportBroker?.idempotentRequestCreation || !health.readingRoot) throw new Error('standard_import_backend_incompatible');
    if (config?.subscriptions.some(item=>item.route==='original_text') && !health.standardImport?.processingModes?.includes('original_text')) throw new Error('backend_original_text_mode_not_loaded');
    return { base, readingRoot: health.readingRoot };
  }
  async advance(config, backend) {
    let inFlight = 0;
    for (const item of Object.values(this.state.items)) {
      if (item.status !== 'processing') continue;
      try {
        // An uncertain POST always reuses its persisted client_request_id.
        if (!item.request_id) {
          const modes = this.importModes(item,config);
          if (!this.active(item,config) || modes.length!==1 || modes[0] !== (item.import_mode || 'standard_preprocess')) {
            item.status=modes.length>1 ? 'route_conflict' : 'pending';
            item.error=modes.length>1 ? 'article_in_multiple_import_modes' : null;
            await this.save(); continue;
          }
          const cached = /^[a-f0-9]{64}$/u.test(item.cached_article_hash || '')
            ? await readJson(path.join(this.home,'cached-articles',hash(urlImportDedupeKey(item.url)),item.cached_article_hash+'.json'))
            : null;
          const created = await this.request(backend.base + '/api/browser-import/requests', {
            urls: [item.url], source: 'rss_auto_import', entry_route: 'ai',
            destination_folder: item.destination_folder, client_request_id: item.client_request_id, user_instruction: '',
            processing_mode:item.import_mode || 'standard_preprocess',
            ...(cached ? {cached_rss_article:cached} : {})
          });
          if (!created.request_id) throw new Error('missing_request_id');
          item.request_id = created.request_id;
          await this.save();
        }
        const response = await this.request(backend.base + '/api/browser-import/requests/' + encodeURIComponent(item.request_id));
        item.backend_status = response.status;
        if (!response.terminal) { inFlight++; continue; }
        const attempt = { number: item.attempt, request_id: item.request_id, completed_at: stamp(this.now), response };
        const receiptFile = path.join(this.home, 'receipts', item.id, `${item.attempt}.json`);
        await saveJson(receiptFile, attempt);
        item.attempts.push({ number: item.attempt, request_id: item.request_id, receipt: receiptFile, status: response.status });
        const result = response.results?.length === 1 ? response.results[0] : null;
        const verified = await verifyImport(result, backend.readingRoot, item.import_mode || 'standard_preprocess');
        if (verified.ok) {
          Object.assign(item, { status: verified.status, artifacts: verified.artifacts, completed_at: stamp(this.now), error: null,
            quality_status: result.receipt?.quality_status || 'ready', processing_mode:verified.processing_mode, preserved_existing:verified.preserved_existing });
        } else {
          const blocked = ['requires_browser_auth', 'requires_js_render'].includes(result?.status);
          item.status = SUCCESS.has(result?.status) ? 'verification_failed' : blocked ? 'source_blocked' : 'retry_wait';
          item.error = verified.reason;
          item.next_retry_at = new Date(this.now() + Math.min(360, config.retry_minutes * 2 ** Math.min(item.attempt - 1, 4)) * 60000).toISOString();
        }
      } catch (error) {
        item.error = error.message;
        // A pruned terminal broker request can be recovered through its same client id;
        // the shared worker still performs source-URL dedupe before publication.
        if (error.message === 'local_http_404') item.request_id = null;
        inFlight++;
      }
      await this.save();
    }
    for (const item of Object.values(this.state.items)) {
      if (inFlight >= config.max_in_flight) break;
      if (!this.active(item, config)) continue;
      if (!['pending','route_conflict'].includes(item.status) && !(item.status === 'retry_wait' && !config.current_feed_only && Date.parse(item.next_retry_at) <= this.now())) continue;
      const routes = this.importModes(item,config);
      if (routes.length!==1) { item.status='route_conflict'; item.error='article_in_multiple_import_modes'; await this.save(); continue; }
      item.attempt++;
      const destination = config.subscriptions.find(source=>item.feeds.includes(source.url) && source.route===routes[0]
        && includesPublication(source,item.published_at))?.destination || config.destination_folder;
      Object.assign(item, { status: 'processing', destination_folder: destination,
        import_mode:routes[0], client_request_id: `rss-auto-${item.id}-${routes[0]}-${item.attempt}`, request_id: null, error: null, started_at: stamp(this.now) });
      await this.save();
      inFlight++;
    }
    return inFlight;
  }
  summary(config) {
    const items = Object.values(this.state.items);
    const active = items.filter(item => this.active(item, config) || item.status === 'processing');
    return { enabled: config.enabled, lookback_days: config.lookback_days, poll_minutes: config.poll_minutes,
      checked_at: stamp(this.now), feed_count: config.feeds.length,
      report_feed_count:config.report_feeds.length,
      subscriptions:config.subscriptions,
      feeds: config.feeds.map(url => { const feed = this.state.feeds[url] || {}; return {
        url, title: feed.title, name:config.subscriptions.find(item=>item.url===url)?.name, route:config.subscriptions.find(item=>item.url===url)?.route, status: feed.status || 'pending', item_count: feed.item_count,
        checked_at: feed.checked_at, error: feed.error,
        coverage: (feed.rows || []).reduce((counts, row) => { counts[row.eligibility] = (counts[row.eligibility] || 0) + 1; return counts; }, {}) }; }),
      item_count: active.length, counts: active.reduce((counts, item) => { counts[item.status] = (counts[item.status] || 0) + 1; return counts; }, {}),
      retained_inactive_items: items.length - active.length,
      backend_error: this.state.backend_error || null, config_error: this.state.config_error || null,
      items: active.map(({title,url,status,error,artifacts,quality_status,request_id,obsidian,import_mode,processing_mode,preserved_existing}) => ({title,url,status,error,artifacts,quality_status,request_id,obsidian,import_mode,processing_mode,preserved_existing})) };
  }
  async syncVisibility() {
    if (!this.syncObsidian) return;
    const pending = Object.values(this.state.items).filter(item => ['imported','imported_with_warnings'].includes(item.status)
      && item.obsidian?.status !== 'visible' && !(Date.parse(item.obsidian?.next_check_at) > this.now())).slice(0,10);
    if (!pending.length) return;
    let result;
    try { result = await this.syncObsidian(pending.flatMap(item=>item.artifacts)); }
    catch (error) { result = {status:'error',error:error.message}; }
    for (const item of pending) {
      const files = (result.files || []).filter(file=>item.artifacts.some(artifact=>artifact.path===file.absolute_path));
      const visible = files.length === item.artifacts.length && files.every(file=>file.status==='visible');
      item.obsidian = {status:visible ? 'visible' : result.status === 'visible' ? 'pending' : result.status,
        checked_at:stamp(this.now),next_check_at:new Date(this.now()+60000).toISOString(),files,...(result.error ? {error:result.error} : {})};
    }
  }
  async tick({ forceScan = false, scanOnly = false, skipScan = false } = {}) {
    const config = await loadConfig(this.home);
    this.state.config_error = null;
    if (config.enabled) {
      if (!skipScan) await this.scan(config, { force: forceScan });
      if (!scanOnly) {
        try { const backend = await this.backend(config); this.state.backend_error = null; await this.advance(config, backend); }
        catch (error) { this.state.backend_error = error.message; }
        await this.syncVisibility();
      }
    }
    await this.save();
    const report = this.summary(config);
    await saveJson(path.join(this.home, 'status.json'), report);
    await saveJson(path.join(this.home, 'health.json'), { pid:process.pid, heartbeat_at:stamp(this.now), enabled:config.enabled, backend_error:report.backend_error, config_error:null });
    return report;
  }
}
