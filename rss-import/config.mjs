import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeUrl } from '../rss-source/core.mjs';
import { inspectUrls } from '../scripts/url-import-input.mjs';
import { normalizeRelativeDestinationFolder } from '../scripts/import-destination-routing.mjs';
import { dataPath } from '../scripts/runtime-paths.mjs';

export const DEFAULT_HOME = dataPath('RSSImport');
export const CONFIG_NAME = 'RSS 自动导入.md';
export const ROUTE_SECTIONS = Object.freeze([
  { heading:'① 标准流程导入', route:'standard_preprocess' },
  { heading:'② 原文直接导入', route:'original_text' },
  { heading:'③ 日报与周报', route:'reports' }
]);
export function configPath(home = process.env.RSS_IMPORT_HOME || DEFAULT_HOME) { return path.join(home,CONFIG_NAME); }

export function parseConfig(markdown) {
  const text = String(markdown);
  const json = text.match(/```json\s*\n([\s\S]*?)\n```/u);
  if (!json) throw new Error('默认模式中缺少 JSON 配置');
  const config = {enabled:true,lookback_days:180,poll_minutes:5,destination_folder:'RSS',retry_minutes:30,max_in_flight:2,...JSON.parse(json[1])};
  if (typeof config.enabled !== 'boolean') throw new Error('enabled 必须是 true 或 false');
  for (const [key,min,max] of [['lookback_days',1,36500],['poll_minutes',1,1440],['retry_minutes',1,10080],['max_in_flight',1,4]]) {
    if (!Number.isInteger(config[key]) || config[key]<min || config[key]>max) throw new Error(`${key} 必须在 ${min}–${max} 之间`);
  }
  config.destination_folder = normalizeRelativeDestinationFolder(config.destination_folder,{required:true});
  const blocks = text.split(/^##\s+/mu).slice(1).map(block=>({heading:block.split('\n',1)[0].trim(),body:block.slice(block.indexOf('\n')+1)}));
  const byUrl = new Map();
  for (const section of ROUTE_SECTIONS) {
    const matches = blocks.filter(block=>block.heading===section.heading || block.heading.startsWith(section.heading+'（'));
    if (matches.length!==1) throw new Error(`需要且只能有一个“## ${section.heading}”区域`);
    for (const line of matches[0].body.split(/\r?\n/u)) {
      const inspected = inspectUrls(line);
      if (/https?:\/\//u.test(line) && !inspected.urls.length) throw new Error(`${section.heading} 中有无法解析的订阅链接`);
      for (const originalUrl of inspected.urls) {
        const url = normalizeUrl(originalUrl);
        const old = byUrl.get(url);
        if (old && old.route!==section.route) throw new Error(`同一订阅链接只能放在一个区域：${url}`);
        if (old) continue;
        const linkedName = [...line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu)].find(match=>{
          try { return normalizeUrl(match[2])===url; } catch { return false; }
        })?.[1];
        const prefix = line.slice(0,line.indexOf(originalUrl)).replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?/u,'').replace(/[：:\s\[\]()]+$/gu,'').trim();
        byUrl.set(url,{url,name:linkedName || prefix || new URL(url).hostname,route:section.route});
      }
    }
  }
  config.subscriptions = [...byUrl.values()];
  config.feeds = config.subscriptions.filter(item=>item.route!=='reports').map(item=>item.url);
  config.report_feeds = config.subscriptions.filter(item=>item.route==='reports').map(item=>item.url);
  return config;
}
export async function loadConfig(home) { return loadConfigFile(configPath(home)); }
export async function loadConfigFile(file) {
  const { unifiedRssConfig } = await import('../subscription-workflow/config.mjs');
  return await unifiedRssConfig(file) || parseConfig(await fs.readFile(file,'utf8'));
}
