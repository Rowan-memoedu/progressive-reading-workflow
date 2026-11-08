#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RssImporter, DEFAULT_HOME, CONFIG_NAME, acquireLock, loadConfig, readJson, saveJson } from './core.mjs';
import { ensureObsidianVisible } from './obsidian.mjs';

const workflowRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = process.argv[2] || 'status';
const option = (name, fallback) => { const index = process.argv.indexOf('--' + name); return index === -1 ? fallback : process.argv[index + 1]; };
const home = path.resolve(option('home', process.env.RSS_IMPORT_HOME || DEFAULT_HOME));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  if (command === 'status') {
    const importer = await new RssImporter({home,workflowRoot}).load();
    console.log(JSON.stringify({ ...importer.summary(await loadConfig(home)), config:path.join(home,CONFIG_NAME),
      health:await readJson(path.join(home,'health.json')) },null,2));
    return;
  }
  if (!['run','watch','scan'].includes(command)) throw new Error('Commands: status | scan | run [--wait-seconds 1800] | watch; optional --home');
  const unlock = await acquireLock(home);
  let stopping = false;
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { stopping = true; });
  try {
    const importer = await new RssImporter({home,workflowRoot,syncObsidian:ensureObsidianVisible}).load();
    const deadline = Date.now() + Number(option('wait-seconds', '0')) * 1000;
    let first = true;
    let lastProgress = '';
    let lastProgressAt = 0;
    while (!stopping) {
      try {
        const report = await importer.tick({ forceScan:first, scanOnly:command === 'scan' });
        const progress = JSON.stringify({enabled:report.enabled,feeds:report.feed_count,counts:report.counts,
          feed_errors:report.feeds.filter(feed=>feed.status==='failed').length,backend_error:report.backend_error});
        if (progress !== lastProgress || Date.now() - lastProgressAt >= 30000) {
          console.log(new Date().toISOString(),progress); lastProgress=progress; lastProgressAt=Date.now();
        }
        const busy = (report.counts.pending || 0) + (report.counts.processing || 0);
        if (command !== 'watch' && (!busy || command === 'scan' || Date.now() >= deadline)) {
          console.log(JSON.stringify(report,null,2));
          if (report.backend_error || report.feeds.some(feed=>feed.status==='failed') || report.counts.retry_wait || report.counts.source_blocked || report.counts.verification_failed || report.counts.route_conflict) process.exitCode=2;
          else if (busy && command !== 'scan') process.exitCode=3;
          break;
        }
      } catch (error) {
        await saveJson(path.join(home,'health.json'), {pid:process.pid,heartbeat_at:new Date().toISOString(),config_error:error.message});
        console.error(new Date().toISOString(),error.message);
        if (command !== 'watch') throw error;
      }
      first=false;
      await wait(5000);
    }
  } finally { await unlock(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
