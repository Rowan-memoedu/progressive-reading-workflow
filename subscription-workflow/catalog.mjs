import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { paths, readJson, writeJson, loadConfig, digest } from './config.mjs';
import { urlImportDedupeKey } from '../scripts/url-import-input.mjs';
import { buildPreprocessRequest } from '../rss-source/core.mjs';
import { meaningfulLength } from './content-length.mjs';
import { includesPublication } from './history.mjs';
import { readingOptions } from './reading-options.mjs';
import { findSourcePublication, findSourcePublications } from '../scripts/reading-source-library.mjs';

export const active = root => existsSync(paths(root).marker);
export function materialKey(url) { return urlImportDedupeKey(url); }

export async function saveSourceMaterial(root, source, item, markdown, extra = {}) {
  const identity = item.key || materialKey(item.url);
  const id = 'subdoc-' + digest(identity).slice(0, 24);
  const directory = path.join(paths(root).sources, id);
  const file = path.join(directory, 'record.json');
  const previous = await readJson(file);
  const contentHash = markdown ? digest(markdown) : null;
  const subscriptions = [...new Set([...(previous?.subscription_ids || []), source.id])];
  const record = { ...previous, schema: 'progressive-reading.subscription-source/v1', material_id: id,
    subscription_ids: subscriptions, platform: source.kind.startsWith('bilibili_') ? 'bilibili' : 'zhihu',
    identity, title: item.title || item.video_title, url: item.url, author: item.author || source.name,
    published_at: item.published_at || null, fetched_at: previous?.fetched_at || new Date().toISOString(),
    content_status: markdown ? 'fulltext_ready' : 'fetch_failed', content_hash: contentHash,
    destination: source.destination, ...extra };
  if (markdown && (!previous || previous.content_hash !== contentHash)) {
    const requestPath = path.join(directory, 'revisions', contentHash, 'preprocess-request.json');
    const request = buildPreprocessRequest({ markdown, metadata: { item_url: item.url, title: record.title,
      author: record.author, published_at: record.published_at, fetched_at: new Date().toISOString(),
      content_completeness: 'full', original_source_ref: record.source_ref || item.url } });
    request.source_type = record.platform === 'bilibili' ? 'video' : 'web';
    request.source_metadata.subscription_ids = subscriptions;
    request.source_metadata.platform = record.platform;
    if (record.platform === 'bilibili') request.processing_options = { input_form: 'spoken_transcript', include_reading_guide: true };
    await writeJson(requestPath, request);
    record.preprocess_request = requestPath;
    record.fetched_at = new Date().toISOString();
  }
  await writeJson(file, record);
  return record;
}

export async function externalCatalog(root) {
  const p = paths(root), config = await loadConfig(root);
  if (!config) return [];
  const allowed = new Map(config.subscriptions.filter(source => source.enabled && source.mode === 'reports').map(source => [source.id,source]));
  const entries = await fs.readdir(p.sources, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(p.sources, entry.name), file = path.join(directory, 'record.json');
    const record = await readJson(file);
    if (!record || !record.subscription_ids.some(id => allowed.has(id) && includesPublication(allowed.get(id),record.published_at))) continue;
    const request = record.preprocess_request ? await readJson(record.preprocess_request) : null;
    const eligible = record.content_status === 'fulltext_ready' && Boolean(request);
    const length = meaningfulLength(request?.material?.markdown);
    items.push({ materialId: record.material_id, packageFile: file, packageDir: directory,
      packageSha256: record.content_hash || digest(JSON.stringify(record.errors || [])),
      requestPath: eligible ? record.preprocess_request : null,
      requestSha256: eligible ? digest(await fs.readFile(record.preprocess_request)) : null,
      status: eligible ? 'completed' : 'blocked', contentStatus: record.content_status, eligible,
      route: !eligible ? 'blocked' : record.platform === 'bilibili' || length >= 1200 ? 'long_review' : 'short_aggregate',
      routingReason: record.platform === 'bilibili' ? 'video_review' : 'text_length', meaningfulLength: length,
      title: record.title, author: record.author, publishedAt: record.published_at, fetchedAt: record.fetched_at,
      itemUrl: record.url, feedUrl: null, sourceId: record.subscription_ids[0], subscriptionIds: record.subscription_ids,
      platform: record.platform, destination: record.destination, video: record.video || null,
      errors: record.errors || [], sourceEvidence: { original_source_ref: record.source_ref || null } });
  }
  return items;
}

export async function canonicalCatalog(root, rssItems) {
  const records = [...rssItems, ...await externalCatalog(root)];
  const config = await loadConfig(root);
  const automatic = await readJson(path.join(config.rss_home, 'state.json'), {items:{}});
  const videos = await readJson(path.join(config.video_home, 'state.json'), {entries:{}});
  const published = new Map();
  for (const item of Object.values(automatic.items)) if (['imported','imported_with_warnings'].includes(item.status) && item.artifacts?.[0]?.path)
    published.set(materialKey(item.url), {path:item.artifacts[0].path,sha256:item.artifacts[0].sha256,published_at:item.completed_at});
  for (const item of Object.values(videos.entries)) if (item.status==='completed' && item.publication)
    published.set(materialKey(item.url), {path:item.publication,published_at:item.completed_at||item.last_attempt});
  const ledger = await readJson(path.join(root, 'imports', 'rss-reading', 'review-ledger.v1.json'), { items: {} });
  const grouped = new Map();
  for (const item of records) {
    const key = item.video?.key || (item.itemUrl ? materialKey(item.itemUrl) : item.materialId);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const library = await findSourcePublications(root, records.map(item => item.itemUrl));
  const result = [];
  for (const [key, versions] of grouped) {
    versions.sort((a, b) => String(b.fetchedAt || '').localeCompare(String(a.fetchedAt || '')) || a.materialId.localeCompare(b.materialId));
    const previous = Object.values(ledger.items).filter(item => item.canonical_key === key || (item.item_url && materialKey(item.item_url) === key));
    previous.sort((a, b) => Number(Boolean(b.canonical_key)) - Number(Boolean(a.canonical_key))
      || Number(Boolean(b.publication?.path)) - Number(Boolean(a.publication?.path))
      || Number(b.decision !== 'unresolved') - Number(a.decision !== 'unresolved')
      || String(a.first_observed_at || a.observed_at || '').localeCompare(String(b.first_observed_at || b.observed_at || '')));
    const preserved = previous[0];
    const latest = versions[0];
    const oldRequest = preserved?.preprocess_request_path ? await readJson(preserved.preprocess_request_path) : null;
    const newRequest = latest.requestPath ? await readJson(latest.requestPath) : null;
    const sameBody = oldRequest?.material?.markdown && oldRequest.material.markdown === newRequest?.material?.markdown;
    const ids = [...new Set(versions.flatMap(item => item.subscriptionIds || config.subscriptions.filter(source => source.kind === 'rss' && source.url === item.feedUrl).map(source => source.id)))];
    const libraryMatch = latest.itemUrl ? library.get(materialKey(latest.itemUrl)) : null;
    const ownedPaths = [preserved?.publication?.path, preserved?.delivery?.short_weekly_path, preserved?.delivery?.short_archived_path].filter(Boolean).map(file => path.resolve(file));
    const externalMatch = libraryMatch && !ownedPaths.includes(path.resolve(libraryMatch.path)) ? libraryMatch : null;
    result.push({ ...latest, materialId: preserved?.material_id || latest.materialId,
      externallyPublished: externalMatch || (latest.itemUrl ? published.get(materialKey(latest.itemUrl)) || null : null),
      ...(sameBody ? { requestPath: preserved.preprocess_request_path, requestSha256: preserved.preprocess_request_sha256,
        preservedSourceRevision: preserved.source_revision } : {}),
      canonicalKey: key, aliasIds: [...new Set([...versions.map(item => item.materialId), ...previous.map(item => item.material_id)])],
      subscriptionIds: ids, platform: latest.platform || 'rss',
      readingOptions: readingOptions(config.subscriptions.find(source=>source.mode==='reports' && ids.includes(source.id))),
      subscriptionName: config.subscriptions.find(source=>ids.includes(source.id))?.name,
      subscriptionKind: config.subscriptions.find(source=>ids.includes(source.id))?.kind,
      destination: latest.destination || config.subscriptions.find(source => ids.includes(source.id))?.destination || 'RSS' });
  }
  return result;
}

export function mergeIdentity(ledger, current) {
  if (!current.canonicalKey) return;
  const winner = ledger.items[current.materialId];
  for (const alias of current.aliasIds || []) {
    const old = ledger.items[alias];
    if (!old || alias === current.materialId) continue;
    old.canonical_material_id = current.materialId;
    if (winner) {
      winner.identity_history ||= [];
      if (!winner.identity_history.some(item => item.material_id === alias)) winner.identity_history.push({
        material_id: alias, decision: old.decision, decision_at: old.decision_at,
        publication: old.publication, history: old.history || [], delivery: old.delivery });
    }
  }
}

export async function findExistingPublication(root, url) {
  return findSourcePublication(root, url);
}
