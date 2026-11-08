import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataPath } from './runtime-paths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = process.env.BOT_READING_HOME || dataPath('BotReading');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const stamp = () => new Date().toISOString();

export function startImportService(env = process.env) {
  // Let the shared consumer resolve live sync and its legacy fallback itself.
  // Promoting the old pointer to an explicit path disables the live receiver.
  return spawn(process.execPath, [path.join(root, 'scripts/progressive-reading-app.mjs')], {
    cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe']
  });
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function save(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file + '.tmp', JSON.stringify(value, null, 2));
  await fs.rename(file + '.tmp', file);
}

export function links(text) {
  const result = new Set();
  for (const match of String(text || '').matchAll(/https?:\/\/[^\s<>"\u3000-\u303f\uff00-\uffef]+/gu)) {
    try {
      const url = new URL(match[0].replace(/[),.;!?]+$/u, ''));
      if (url.username || url.password || !url.hostname.includes('.') ||
          /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)) continue;
      url.hash = '';
      for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      result.add(url.href);
    } catch {}
  }
  return [...result];
}

export function eligible(record, provider, config) {
  const sender = provider === 'qq' ? record.user_openid || record.author_id : record.from_user_id;
  return record.direction === 'inbound' && !record.group_openid && !record.group_id && !record.guild_id &&
    Date.parse(record.received_at) >= Date.parse(config.since) &&
    config.allowedSenders[provider].includes(sender);
}

export async function verifyReceipt(receipt, readingRoot) {
  if (!receipt.terminal) return { status: 'processing' };
  if (receipt.failed || receipt.degraded || receipt.imported !== 1 || receipt.results?.length !== 1)
    return { status: 'failed', reason: receipt.status };
  const artifact = receipt.results[0].artifacts?.find(item => item.kind === 'markdown');
  if (!artifact?.path || !artifact.sha256) return { status: 'unresolved', reason: 'missing_markdown_evidence' };
  try {
    const actualRoot = await fs.realpath(readingRoot);
    const actualFile = await fs.realpath(artifact.path);
    const relative = path.relative(actualRoot, actualFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('artifact_outside_reading_area');
    const bytes = await fs.readFile(actualFile);
    if (!bytes.toString('utf8').trim() || hash(bytes) !== artifact.sha256) throw new Error('artifact_hash_or_content_invalid');
    return { status: 'completed', artifact: actualFile, sha256: artifact.sha256 };
  } catch (error) { return { status: 'unresolved', reason: error.message }; }
}

async function jsonRequest(url, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...(body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  } : {}) });
  if (!response.ok) throw new Error(`local_http_${response.status}`);
  return response.json();
}

export async function advance(item, base, readingRoot, request = jsonRequest) {
  if (!item.requestId) {
    // Persist the deterministic ID before submission. Replaying an uncertain POST uses the same ID.
    const receipt = await request(base + '/api/browser-import/requests', {
      urls: [item.url], source: 'bot_reading', client_request_id: item.clientId,
      user_instruction: '', destination_folder: 'Bot收集'
    });
    if (!receipt.request_id) throw new Error('missing_request_id');
    item.requestId = receipt.request_id;
  }
  const receipt = await request(base + '/api/browser-import/requests/' + encodeURIComponent(item.requestId));
  return { ...item, ...await verifyReceipt(receipt, readingRoot), upstreamStatus: receipt.status, updatedAt: stamp() };
}

async function main() {
  const config = await readJson(path.join(data, 'config.json'), null);
  if (!config) throw new Error('bot_reading_config_missing');
  const stateFile = path.join(data, 'state.json');
  const state = await readJson(stateFile, { items: {}, experiment: 'waiting', lastBatch: null });
  if (process.argv.includes('--status')) {
    console.log(JSON.stringify({ heartbeat: await readJson(path.join(data, 'health.json'), null),
      experiment: state.experiment, lastBatch: state.lastBatch,
      items: Object.values(state.items).map(({ status, artifact, reason, updatedAt }) => ({ status, artifact, reason, updatedAt })) }, null, 2));
    return;
  }
  const health = { pid: process.pid, startedAt: stamp(), qq: 'starting', weixin: 'starting' };
  const children = new Set();
  let stopping = false;
  const env = { ...process.env, CN_IM_HOME: path.join(data, 'bot-home') };
  function trackChild(proc) {
    children.add(proc); proc.once('close', () => children.delete(proc));
    return proc;
  }
  function child(args, options = {}) {
    return trackChild(spawn(process.execPath, args, { cwd: root, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'], ...options }));
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    stopping = true; for (const proc of children) proc.kill();
  });
  async function receiveQQ() {
    while (!stopping) {
      const proc = child([path.join(config.cliRoot, 'bin/qq-cli.mjs'), '--json', 'events', 'listen']);
      proc.stdout.on('data', () => { health.qqLastEvent = stamp(); });
      let diagnostic = '';
      proc.stderr.on('data', bytes => {
        diagnostic = (diagnostic + bytes.toString()).slice(-2048);
        if (/WebSocket (ready|resumed)/.test(diagnostic)) { health.qq = 'ready'; health.qqReadyAt = stamp(); diagnostic = ''; }
        if (/WebSocket error/.test(diagnostic)) health.qq = 'connection_error';
      });
      await new Promise(resolve => { proc.on('error', resolve); proc.on('close', resolve); });
      health.qq = 'reconnecting'; await pause(10000);
    }
  }
  async function receiveWeixin() {
    while (!stopping) {
      let output = '';
      const proc = child([path.join(config.cliRoot, 'bin/weixin-cli.mjs'), '--json', 'updates', 'poll', '--timeout-ms', '40000']);
      proc.stdout.on('data', bytes => { output += bytes; });
      proc.stderr.on('data', () => {});
      const code = await new Promise(resolve => { proc.on('error', () => resolve(-1)); proc.on('close', resolve); });
      try {
        const result = JSON.parse(output);
        health.weixin = code === 0 && result.ok ? (result.data.client_timeout ? 'poll_timeout' : 'ready') : 'error';
        if (health.weixin === 'ready') health.weixinReadyAt = stamp();
      } catch { health.weixin = 'error'; }
      await pause(health.weixin === 'error' ? 30000 : 1000);
    }
  }
  // Receivers never print message bodies, tokens or raw SDK diagnostics to service logs.
  void receiveQQ(); void receiveWeixin();
  let appChild = null;
  async function appBase() {
    const info = await readJson(path.join(root, 'imports/app-server.json'), {});
    const base = /^http:\/\/127\.0\.0\.1:\d+$/.test(info.url || '') ? info.url : 'http://127.0.0.1:37829';
    try {
      const status = await jsonRequest(base + '/api/highlights/health');
      if (!status.browserImportBroker?.idempotentRequestCreation) throw new Error('incompatible_import_service');
      health.importService = 'ready'; return base;
    } catch (error) {
      health.importService = 'unavailable';
      if (!appChild) {
        appChild = trackChild(startImportService());
        appChild.stdout.on('data', () => {}); appChild.stderr.on('data', () => {});
        appChild.once('close', () => { appChild = null; });
      }
      throw error;
    }
  }
  while (!stopping) {
    try {
      for (const provider of ['qq', 'weixin']) {
        let raw = '';
        try { raw = await fs.readFile(path.join(data, 'bot-home', provider, 'events.jsonl'), 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const lines = raw.split('\n'); lines.pop(); // An append in progress is consumed on the next scan.
        for (const line of lines) {
          if (!line.trim()) continue;
          const record = JSON.parse(line);
          if (!eligible(record, provider, config)) continue;
          for (const url of links(record.content)) {
            const id = hash(url);
            if (!state.items[id]) state.items[id] = { url, clientId: 'bot-reading-' + id,
              status: 'queued', receivedAt: record.received_at, provider, updatedAt: stamp() };
          }
        }
      }
      const local = new Date();
      const day = `${local.getFullYear()}-${local.getMonth() + 1}-${local.getDate()}`;
      const due = local.getHours() >= config.dailyHour && state.lastBatch !== day;
      const queued = Object.entries(state.items).filter(([, item]) => item.status === 'queued');
      if (state.experiment === 'waiting' && queued.length) {
        state.experiment = 'running'; state.experimentId = queued[0][0];
        queued[0][1].status = 'processing';
      }
      if (due) {
        for (const [, item] of queued) item.status = 'processing';
        state.lastBatch = day;
      }
      await save(stateFile, state);
      const base = await appBase();
      for (const [id, item] of Object.entries(state.items).filter(([, item]) => item.status === 'processing')) {
        try { state.items[id] = await advance(item, base, path.join(root, '阅读区')); }
        catch (error) { item.reason = error.message; item.updatedAt = stamp(); }
        if (id === state.experimentId && ['completed', 'failed', 'unresolved'].includes(state.items[id].status))
          state.experiment = state.items[id].status;
        await save(stateFile, state);
      }
      delete health.error;
    } catch (error) { health.error = error.message; }
    health.updatedAt = stamp(); health.experiment = state.experiment;
    health.counts = Object.values(state.items).reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] || 0) + 1 }), {});
    await save(path.join(data, 'health.json'), health);
    await pause(15000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
