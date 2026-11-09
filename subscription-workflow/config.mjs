import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { dataPath, artifactPath } from '../scripts/runtime-paths.mjs';
import {readingDestination} from './reading-options.mjs';

export const HOME = dataPath('ProgressiveReading', 'Subscriptions');
export const SCHEMA = 'progressive-reading.subscriptions/v1';
export const MODES = ['standard_preprocess', 'original_text', 'reports'];
export const KINDS = ['rss', 'bilibili_video', 'bilibili_collection', 'zhihu_author', 'zhihu_column'];
export const SCHEDULE = Object.freeze({ rss: '06:00', zhihu: '07:00', bilibili: '08:00', daily: '09:00', weekly: '21:00', weekly_day: 0, timezone: 'Asia/Shanghai' });
export const digest = value => createHash('sha256').update(value).digest('hex');
export const codeRoot = path.resolve(import.meta.dirname, '..');

export function paths(workflowRoot = codeRoot, home) {
  const marker = path.join(workflowRoot, 'imports', 'subscriptions', 'active.json');
  let location = home || process.env.PROGRESSIVE_READING_SUBSCRIPTIONS_HOME;
  if (!location && existsSync(marker)) location = JSON.parse(readFileSync(marker, 'utf8')).home;
  location = path.resolve(location || HOME);
  return { workflowRoot, home: location, marker, config: path.join(location, 'subscriptions.json'),
    state: path.join(location, 'state.json'), jobs: path.join(location, 'jobs'),
    sources: path.join(workflowRoot, 'imports', 'subscriptions', 'sources'),
    summaryRoot: path.join(workflowRoot, '摘要区', '订阅'),
    artifactRoot: artifactPath('ProgressiveReading', 'subscriptions') };
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fs.rename(temporary, file);
}

export async function withLock(file, action) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const token = randomUUID();
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { handle = await fs.open(file, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readJson(file);
      if (!Number.isSafeInteger(previous?.pid)) throw new Error('订阅锁文件需要检查');
      try { process.kill(previous.pid, 0); throw new Error('该操作正在执行，请稍后重试'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      await fs.unlink(file);
    }
  }
  if (!handle) throw new Error('无法取得订阅写入锁');
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.close(); return await action(); }
  finally { if ((await readJson(file))?.token === token) await fs.unlink(file); }
}

export function canonicalUrl(value) {
  const url = new URL(String(value).trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('请填写不含账号密码的 HTTP(S) 链接');
  if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/iu.test(url.hostname) || /\.(local|internal)$/iu.test(url.hostname)) throw new Error('订阅来源需要使用公开网站地址');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|spm_id_from|vd_source|share_source|share_medium)$/iu.test(key)) url.searchParams.delete(key);
  return url.href;
}

export function normalizeSource(value, previous = null) {
  const kind = String(value.kind || previous?.kind || 'rss');
  const mode = String(value.mode || previous?.mode || 'reports');
  if (!KINDS.includes(kind) || !MODES.includes(mode)) throw new Error('来源类型或处理模式无效');
  const url = new URL(canonicalUrl(value.url ?? previous?.url));
  if (kind.startsWith('bilibili_')) {
    if (mode === 'original_text') throw new Error('视频不提供原文直接导入模式');
    if (!['www.bilibili.com', 'bilibili.com'].includes(url.hostname) || !/^\/video\/BV[0-9A-Za-z]{10}\/?$/u.test(url.pathname)) throw new Error('请填写 B 站视频链接；订阅合集时可填写合集内任意视频链接');
    url.hostname = 'www.bilibili.com'; url.protocol = 'https:'; url.search = ''; url.pathname = url.pathname.replace(/\/?$/u, '/');
  }
  if (kind === 'zhihu_author') {
    if (!['www.zhihu.com', 'zhihu.com'].includes(url.hostname) || !/^\/people\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname)) throw new Error('请填写知乎作者主页链接');
    url.hostname = 'www.zhihu.com'; url.protocol = 'https:'; url.search = ''; url.pathname = url.pathname.replace(/\/$/u, '');
  }
  if (kind === 'zhihu_column') {
    const valid = (['www.zhihu.com', 'zhihu.com'].includes(url.hostname) && /^\/column\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname))
      || (url.hostname === 'zhuanlan.zhihu.com' && /^\/[A-Za-z0-9_-]+\/?$/u.test(url.pathname) && url.pathname !== '/p');
    if (!valid) throw new Error('请填写知乎专栏链接，而非单篇文章链接');
    url.protocol = 'https:'; url.search = ''; url.pathname = url.pathname.replace(/\/$/u, '');
  }
  const name = String(value.name ?? previous?.name ?? '').trim();
  if (!name || name.length > 160) throw new Error('订阅名称需要在 1–160 个字符之间');
  const folder = String(value.destination ?? previous?.destination ?? (kind === 'rss' ? 'RSS' : kind.startsWith('bilibili_') ? '视频' : '知乎')).trim().replaceAll('\\', '/');
  if (!folder || path.isAbsolute(folder) || /(^|\/)\.\.(\/|$)|[:\x00-\x1f]/u.test(folder)) throw new Error('目标目录应为阅读区中的相对目录');
  const historyMode = value.history_mode ?? previous?.history_mode ?? 'default';
  if (!['default', 'since', 'all'].includes(historyMode)) throw new Error('订阅范围无效');
  const earliest = value.earliest_date ?? previous?.earliest_date ?? '';
  if (historyMode === 'since') {
    const date = new Date(earliest + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(earliest) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== earliest) {
      throw new Error('请选择有效的最早日期');
    }
  }
  return { ...previous, id: previous?.id || 'sub-' + randomUUID(), kind, name, url: url.href,
    mode, destination: readingDestination({subscription_kind:kind,subscription_name:name,destination:folder}), enabled: value.enabled ?? previous?.enabled ?? true,
    history_mode: historyMode, earliest_date: historyMode === 'since' ? earliest : null,
    added_at: previous?.added_at || new Date().toISOString(), updated_at: new Date().toISOString(),
    initial_policy: kind === 'rss' ? 'current_feed' : 'new_only' };
}

export function validateConfig(config) {
  if (config?.schema !== SCHEMA || !Array.isArray(config.subscriptions)) throw new Error('订阅配置格式无效');
  const ids = new Set(), identities = new Set();
  for (const source of config.subscriptions) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/u.test(source.id) || ids.has(source.id) || typeof source.enabled !== 'boolean') throw new Error('订阅 ID 或启用状态无效');
    normalizeSource(source, source);
    const identity = `${source.kind}:${source.url}`;
    if (identities.has(identity)) throw new Error('该来源已经存在，请编辑已有订阅');
    ids.add(source.id); identities.add(identity);
  }
  return config;
}

export async function loadConfig(workflowRoot = codeRoot, home) {
  if (!home && !process.env.PROGRESSIVE_READING_SUBSCRIPTIONS_HOME && path.resolve(workflowRoot) !== codeRoot && !existsSync(paths(workflowRoot).marker)) return null;
  const config = await readJson(paths(workflowRoot, home).config);
  return config ? validateConfig(config) : null;
}

export async function saveSource(workflowRoot, value, { home, expectedRevision } = {}) {
  const p = paths(workflowRoot, home);
  return withLock(p.config + '.lock', async () => {
    const config = await loadConfig(workflowRoot, home);
    if (!config) throw new Error('订阅配置尚未初始化');
    if (expectedRevision != null && config.revision !== expectedRevision) throw new Error('配置已在另一处更新，请刷新后重试');
    const previous = value.id ? config.subscriptions.find(source => source.id === value.id) : null;
    if (value.id && !previous) throw new Error('订阅不存在');
    if (previous && (value.kind && value.kind !== previous.kind || value.url && canonicalUrl(value.url) !== previous.url)) throw new Error('修改来源地址时请停用旧订阅并添加新订阅，以保留基线与历史');
    const next = normalizeSource(value, previous);
    if (previous) config.subscriptions[config.subscriptions.indexOf(previous)] = next;
    else config.subscriptions.push(next);
    config.revision++; config.updated_at = new Date().toISOString();
    validateConfig(config); await writeJson(p.config, config);
    return config;
  });
}

export async function deleteSource(workflowRoot, id, { home, expectedRevision } = {}) {
  const p = paths(workflowRoot, home);
  return withLock(p.config + '.lock', async () => {
    const config = await loadConfig(workflowRoot, home);
    if (!config) throw new Error('订阅配置尚未初始化');
    if (!Number.isSafeInteger(expectedRevision) || config.revision !== expectedRevision) throw new Error('配置已在另一处更新，请刷新后重试');
    const source = config.subscriptions.find(source => source.id === id);
    if (!source) throw new Error('订阅不存在');
    if (source.enabled) throw new Error('请先停用此订阅，再删除');
    config.subscriptions = config.subscriptions.filter(source => source.id !== id);
    config.revision++; config.updated_at = new Date().toISOString();
    validateConfig(config); await writeJson(p.config, config);
    return config;
  });
}

export function platform(source) { return source.kind.split('_')[0]; }

export async function initialize(workflowRoot = codeRoot, { home, rssHome = process.env.RSS_IMPORT_HOME || dataPath('RSSImport'), videoHome = process.env.PROGRESSIVE_READING_VIDEO_HOME || dataPath('ProgressiveReading', 'VideoWatch') } = {}) {
  const p = paths(workflowRoot, home);
  return withLock(p.config + '.lock', async () => {
    const existing = await loadConfig(workflowRoot, home);
    if (existing) return existing;
    const { parseConfig } = await import('../rss-import/config.mjs');
    const rssFile = path.join(rssHome, 'RSS 自动导入.md');
    const rss = parseConfig(await fs.readFile(rssFile, 'utf8'));
    const video = await readJson(path.join(videoHome, 'watchlist.json'), { watches: [] });
    const subscriptions = rss.subscriptions.map(source => normalizeSource({ kind: 'rss', name: source.name, url: source.url, mode: source.route, destination: rss.destination_folder }));
    for (const watch of video.watches) {
      const destination = path.relative(path.join(workflowRoot, '阅读区'), watch.destination).replaceAll('\\', '/');
      const source = normalizeSource({ kind: watch.season_id ? 'bilibili_collection' : 'bilibili_video', name: watch.name, url: watch.url, mode: 'standard_preprocess', destination });
      source.watch = { ...watch }; source.baseline_ready = true; subscriptions.push(source);
    }
    const config = { schema: SCHEMA, revision: 1, enabled: false, created_at: new Date().toISOString(),
      schedule: { ...SCHEDULE }, rss_home: path.resolve(rssHome), video_home: path.resolve(videoHome),
      rss_defaults: { ...rss, subscriptions: undefined, feeds: undefined, report_feeds: undefined },
      subscriptions };
    validateConfig(config); await writeJson(p.config, config);
    await writeJson(p.marker, { schema: SCHEMA, home: p.home });
    return config;
  });
}

export async function unifiedRssConfig(file) {
  const config = await loadConfig();
  if (!config || path.resolve(file) !== path.resolve(config.rss_home, 'RSS 自动导入.md')) return null;
  const subscriptions = config.subscriptions.filter(source => source.enabled && source.kind === 'rss')
    .map(source => ({ url: source.url, name: source.name, route: source.mode, destination: source.destination, subscription_id: source.id,
      history_mode: source.history_mode, earliest_date: source.earliest_date }));
  return { ...config.rss_defaults, enabled: config.enabled, poll_minutes: 1440, current_feed_only: true,
    max_in_flight: 2, subscriptions, feeds: subscriptions.filter(source => source.route !== 'reports').map(source => source.url),
    report_feeds: subscriptions.filter(source => source.route === 'reports').map(source => source.url) };
}
