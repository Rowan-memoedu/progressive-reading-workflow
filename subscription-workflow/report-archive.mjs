import fs from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from "node:path";
import { randomUUID } from "node:crypto";
import { digest, loadConfig } from "./config.mjs";
import { renameWithRetry } from "../rss-source/core.mjs";
import sanitizeFilename from "sanitize-filename";
import {readingDestination} from './reading-options.mjs';

export const shortKey = item => digest(`${item.material_id}:${item.source_revision}`);
const chineseStart = key => `<!-- rss-reading:short ${key} -->`;
const englishStart = key => `<!-- rss-reading:short-original ${key} -->`;
const done = /^- \[[xX]\] 已完成阅读\s*$/mu;
const checkbox = /^- \[[ xX]\] 已完成阅读\s*$/mu;

export function shortBlock(key, body, original = false) {
  const start = original ? englishStart(key) : chineseStart(key);
  const end = original ? "short-original-end" : "short-end";
  const mark = !original && !checkbox.test(body) ? "\n\n- [ ] 已完成阅读" : "";
  return `${start}\n${body}${mark}\n<!-- rss-reading:${end} -->`;
}

async function readOptional(file) {
  return fs.readFile(file,"utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function replaceChecked(file, before, after) {
  if (before === after) return;
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp = `${file}.tmp-${randomUUID()}`;
  try {
    await fs.writeFile(temp,after,"utf8");
    if (await readOptional(file) !== before) throw new Error(`report_changed_during_write:${file}`);
    if (before === null) await fs.link(temp,file);
    else await renameWithRetry(temp,file);
  } finally {
    await fs.unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

function readBlocks(text, original = false) {
  const pattern = original
    ? /^<!-- rss-reading:short-original ([a-f0-9]{64}) -->\r?\n([\s\S]*?)\r?\n<!-- rss-reading:short-original-end -->$/gmu
    : /^<!-- rss-reading:short ([a-f0-9]{64}) -->\r?\n([\s\S]*?)\r?\n<!-- rss-reading:short-end -->$/gmu;
  const blocks = new Map();
  for (const match of text.matchAll(pattern)) {
    if (blocks.has(match[1])) throw new Error(`duplicate_short_weekly_block:${match[1]}`);
    const remainder = text.slice(match.index + match[0].length);
    const boundary = remainder.search(/^<!-- rss-reading:short(?:-original)? |^## English Appendix\r?$/mu);
    const gap = remainder.slice(0,boundary < 0 ? remainder.length : boundary);
    const notes = gap.replace(/(?:^|\n)### [^\r\n]+\r?\n\s*$/u,"").trimEnd();
    blocks.set(match[1],match[2]+notes);
  }
  return blocks;
}

function appendixIndex(text) {
  const headings = [...text.matchAll(/^## English Appendix\r?$/gmu)];
  if (headings.length > 1) throw new Error("short_weekly_appendix_ambiguous");
  return headings[0]?.index ?? text.length;
}

// Older reports have author groups and numbered article headings. Use the
// source link for identity and insert markers around the saved prose verbatim.
function upgradeSection(section, entries, original) {
  const urlToItem = new Map(entries.map(item=>[item.item_url,item]));
  const marked = readBlocks(section,original);
  const headings = [...section.matchAll(/^#### .+\r?$/gmu)];
  const starts = headings.filter(heading=>entries.some(item=>{
    const title = original ? item.title : item.review_preview?.chinese_title || item.title;
    return /^#### \d+\. /u.test(heading[0]) || heading[0].replace(/^#### /u,"").trim() === title;
  }));
  const labels = new Set(entries.map(item=>item.author || new URL(item.feed_url || item.item_url).hostname.replace(/^www\./u,"")));
  const groupStarts = [...section.matchAll(/^### .+\r?$/gmu)]
    .filter(match=>labels.has(match[0].slice(4).trim())).map(match=>match.index);
  const edits = [];
  for (const [i, heading] of starts.entries()) {
    const start = heading.index;
    const end = Math.min(starts[i+1]?.index ?? section.length,groupStarts.find(offset=>offset>start) ?? section.length);
    const chunk = section.slice(start,end);
    const link = /^\[(?:原文链接|Original)\]\(([^\r\n]+)\)\r?$/mu.exec(chunk);
    const item = link && urlToItem.get(link[1]);
    if (!item || marked.has(shortKey(item))) continue;
    const body = chunk.trimEnd();
    const previousMarker = !original && new RegExp(`${chineseStart(shortKey(item))}\\r?\\n$`,"u").exec(section.slice(0,start));
    const prefix = previousMarker ? previousMarker[0].length : 0;
    const block = shortBlock(shortKey(item),body,original);
    edits.push({start:start-prefix,end:start+body.length,block});
    marked.set(shortKey(item),body);
  }
  for (const edit of edits.reverse()) section = section.slice(0,edit.start)+edit.block+section.slice(edit.end);
  return section;
}

export async function ensureShortReportControls(file, entries) {
  const before = await fs.readFile(file,"utf8");
  const split = appendixIndex(before);
  const after = upgradeSection(before.slice(0,split),entries,false)
    + upgradeSection(before.slice(split),entries,true);
  const chinese = readBlocks(after);
  const english = readBlocks(after,true);
  for (const item of entries) {
    const key = shortKey(item);
    if (!chinese.has(key)) throw new Error(`short_weekly_article_missing:${item.material_id}:${file}`);
    const preview = item.review_preview || {};
    const expectedEnglish = preview.source_language === "en"
      || (!preview.source_language && preview.translation_state === "generated_translation");
    if (expectedEnglish && !english.has(key)) throw new Error(`short_weekly_original_missing:${item.material_id}:${file}`);
  }
  await replaceChecked(file,before,after);
  return {text:after,chinese,english};
}

export async function appendShortReport(file, week, key, chinese, english, label, verifyExisting = false) {
  const existing = await readOptional(file);
  const title = `# ${week} 订阅 短文周报`;
  const base = existing ?? `${title}\n\n读完一篇后勾选「已完成阅读」。未勾选的正文和批注会移入下一周。\n\n## 中文主文\n`;
  const existingChinese = readBlocks(base).get(key);
  if (existingChinese !== undefined) {
    if (verifyExisting && (existingChinese !== chinese || readBlocks(base,true).get(key) !== english)) throw new Error(`short_rollover_destination_changed:${file}:${key}`);
    return {path:file,sha256:digest(base)};
  }
  const split = appendixIndex(base);
  let after = base.slice(0,split)+`\n\n### ${label}\n\n${shortBlock(key,chinese)}\n\n`+base.slice(split);
  if (english) {
    if (split === base.length) after += "## English Appendix\n";
    after += `\n\n### ${label}\n\n${shortBlock(key,english,true)}\n`;
  }
  await replaceChecked(file,existing,after);
  return {path:file,sha256:digest(after)};
}

function archiveRoot(paths) {
  return path.join(paths.workflowRoot,"待归档原文","订阅");
}

export function relocatedPath(value, mapping, workflowRoot) {
  if (typeof value !== 'string') return value;
  if (mapping.has(value)) return mapping.get(value);
  if (/^file:\/\//iu.test(value)) { try { const file=fileURLToPath(value);return mapping.has(file)?pathToFileURL(mapping.get(file)).href:value; } catch {return value;} }
  if (/^obsidian:\/\//iu.test(value)) {
    try { const url=new URL(value);let changed=false;for(const key of ['path','file'])if(url.searchParams.has(key)){
      const before=url.searchParams.get(key),after=relocatedPath(before,mapping,workflowRoot);if(before!==after){url.searchParams.set(key,after);changed=true;}
    }return changed?url.href.replaceAll('+','%20'):value; } catch {return value;}
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) return value;
  const slash=value.replaceAll('\\','/');
  for (const [from,to] of mapping) {
    if(slash===from.replaceAll('\\','/'))return value.includes('\\')?to:to.replaceAll('\\','/');
    if(!workflowRoot)continue;
    const oldRelative=path.relative(workflowRoot,from).replaceAll('\\','/'),next=path.relative(workflowRoot,to).replaceAll('\\','/');
    if(oldRelative&&(slash===oldRelative||slash.endsWith('/'+oldRelative))){
      const result=slash.slice(0,-oldRelative.length)+next;return value.includes('\\')?result.replaceAll('/','\\'):result;
    }
  }
  return value;
}

export function relocatedMarkdown(text, source, target, mapping = new Map(), workflowRoot) {
  let fence = null;
  return text.split(/(?<=\n)/u).map(line=>{
    const delimiter = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    return line.replace(/(`+[^\r\n]*?`+)|(\]\()(<[^>\r\n]+>|[^\s()]+)(\))/gu,(match,code,open,destination,close)=>{
      if (code) return match;
      const raw = destination.startsWith("<") ? destination.slice(1,-1) : destination;
      const mappedUri=/^(?:file|obsidian):|^[a-z]:[\\/]/iu.test(raw)?relocatedPath(raw,mapping,workflowRoot):raw;
      if(mappedUri!==raw)return `${open}<${mappedUri}>${close}`;
      if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/iu.test(raw)) return match;
      const [,pathname,suffix] = /^([^#?]*)([\s\S]*)$/u.exec(raw);
      let decoded;
      try { decoded = decodeURI(pathname); } catch { return match; }
      const absolute = path.resolve(path.dirname(source),decoded);
      const mapped=mapping.get(absolute)||absolute;
      if(source===target&&mapped===absolute)return match;
      const relative = path.relative(path.dirname(target),mapped).replaceAll("\\","/");
      const encoded = encodeURI(relative).replaceAll("#","%23").replaceAll("?","%3F");
      return `${open}<${encoded+suffix}>${close}`;
    });
  }).join("");
}

export async function ensureArchiveSources(paths, ledger) {
  const config = await loadConfig(paths.workflowRoot);
  const priorOwners = new Set(Object.values(ledger.items).filter(item=>item.delivery?.short_weekly_path).flatMap(item=>item.subscription_ids || []));
  const sources = (config?.subscriptions || []).filter(source=>(source.mode==="reports" || priorOwners.has(source.id)) && !source.kind.startsWith("bilibili_"));
  for (const category of ["日报","长文周报"]) await fs.mkdir(path.join(archiveRoot(paths),category),{recursive:true});
  ledger.short_archive_sources ||= {};
  for (const source of sources) {
    const stem = sanitizeFilename(source.name).trim().slice(0,100) || source.id;
    const marker = `<!-- subscriptions:archive-source ${source.id} -->`;
    const file = path.join(paths.workflowRoot,'待归档原文',readingDestination({subscription_kind:source.kind,subscription_name:source.name,destination:source.destination}),'短文归档.md');
    const previousName=ledger.short_archive_sources[source.id] || stem+'.md';
    const previous=path.join(archiveRoot(paths),/[\\/]/u.test(previousName)?previousName:path.join('短文',previousName));
    const name=path.relative(archiveRoot(paths),file).replaceAll('\\','/');
    let existing = await readOptional(file);
    if(existing===null&&previous!==file){
      const legacy=await readOptional(previous);
      if(legacy!==null){
        if(!legacy.includes(marker))throw new Error(`short_archive_source_collision:${previous}`);
        await moveReport(previous,file,digest(legacy),digest(relocatedMarkdown(legacy,previous,file)));
        existing=await readOptional(file);
      }
    }
    if (existing !== null && !existing.includes(marker)) {
      throw new Error(`short_archive_source_collision:${file}`);
    }
    if (existing === null) await replaceChecked(file,null,`# ${source.name}\n\n${marker}\n`);
    ledger.short_archive_sources[source.id] = name;
  }
  return sources;
}

export async function moveReport(source, target, expected, destinationHash = expected, mapping = new Map(), workflowRoot) {
  const text = await readOptional(source);
  const existing = await readOptional(target);
  if (text === null) {
    if (existing !== null && digest(existing) === destinationHash) return;
    throw new Error(`report_archive_source_missing:${source}`);
  }
  if (digest(text) !== expected) throw new Error(`report_changed_before_archive:${source}`);
  const output = destinationHash === expected ? text : relocatedMarkdown(text,source,target,mapping,workflowRoot);
  if (digest(output) !== destinationHash) throw new Error(`report_archive_hash_mismatch:${target}`);
  await fs.mkdir(path.dirname(target),{recursive:true});
  if (existing === null) await replaceChecked(target,null,output);
  if (await readOptional(target) !== output || await readOptional(source) !== text) throw new Error(`report_archive_collision:${target}`);
  await fs.unlink(source);
}

export async function rollShortReports(paths, ledger, week, save, labelFor) {
  if (!/^\d{4}-W(?:0[1-9]|[1-4]\d|5[0-3])$/u.test(week)) throw new Error("report_period_invalid");
  const sources = await ensureArchiveSources(paths,ledger);
  const results = [];
  const items = Object.values(ledger.items).filter(item=>!item.canonical_material_id);
  const weekly = ledger.report_runs.weekly;
  const current = path.join(paths.shortWeeklyRoot,`${week} 订阅 短文周报.md`);
  for (const [oldWeek,run] of Object.entries(weekly).sort(([a],[b])=>a.localeCompare(b))) {
    const report = run.short_weekly;
    if (!report || report.archived_path || oldWeek>week) continue;
    const source = path.join(paths.shortWeeklyRoot,`${oldWeek} 订阅 短文周报.md`);
    if (path.resolve(report.path) !== path.resolve(source)) continue;
    const entries = items.filter(item=>item.delivery?.short_weekly_path===source);
    if (oldWeek===week) {
      if (entries.length) {
        const controls = await ensureShortReportControls(source,entries);
        report.sha256 = digest(controls.text);
      }
      continue;
    }
    const archive = path.join(paths.dataRoot,"historical-short-weeklies",path.basename(source));
    if (!report.archive_pending) {
      if (!entries.length) throw new Error(`short_weekly_ledger_items_missing:${source}`);
      const {text,chinese,english} = await ensureShortReportControls(source,entries);
      if (chinese.size !== entries.length || [...english.keys()].some(key=>!chinese.has(key))) throw new Error(`short_weekly_untracked_articles:${source}`);
      // Resolve every destination before the first write.
      const transfers = entries.map(item=>{
        const key = shortKey(item), body = chinese.get(key), original = english.get(key);
        const complete = done.test(body);
        const owner = sources.find(candidate=>candidate.url===item.feed_url)
          || sources.find(candidate=>item.subscription_ids?.includes(candidate.id));
        if (complete && !owner) throw new Error(`short_archive_source_unknown:${item.material_id}`);
        return {item,key,body,original,complete,owner};
      });
      let carried = 0, archived = 0;
      for (const transfer of transfers) {
        const {item,key,body,original,complete,owner} = transfer;
        if (complete) {
          const file = path.join(archiveRoot(paths),ledger.short_archive_sources[owner.id]);
          const before = await fs.readFile(file,"utf8");
          const marker = `<!-- subscriptions:archived-short ${key} -->`;
          const archivedBody = relocatedMarkdown(body,source,file);
          const archivedOriginal = original ? relocatedMarkdown(original,source,file) : null;
          const entry = [marker,archivedBody,archivedOriginal ? "**English original**\n\n"+archivedOriginal : "","<!-- subscriptions:archived-short-end -->"].filter(Boolean).join("\n\n");
          if (before.includes(marker) && !before.includes(entry)) throw new Error(`short_archive_entry_changed:${file}:${key}`);
          if (!before.includes(marker)) await replaceChecked(file,before,before+"\n\n"+entry+"\n");
          item.delivery.short_archived_path = file;
          archived++;
        } else {
          const result = await appendShortReport(current,week,key,body,original,labelFor(item),true);
          weekly[week] ||= {};
          weekly[week].short_weekly = result;
          item.delivery.short_weekly_key = week;
          item.delivery.short_weekly_path = current;
          carried++;
        }
      }
      report.archive_pending = {sha256:digest(text),carried,archived};
      await save();
    }
    await moveReport(source,archive,report.archive_pending.sha256);
    results.push({path:source,archived_path:archive,...report.archive_pending});
    report.archived_path = archive;
    delete report.archive_pending;
    await save();
  }
  return results;
}

export async function archiveSummaryReports(paths, ledger, {date,week,rolloverFile}, save) {
  const transferred = new Set();
  if (rolloverFile) {
    const content = await fs.readFile(rolloverFile,"utf8");
    for (const match of content.matchAll(/<!-- rss-reading:item\s+([^\s>]+)\s+-->/gu)) transferred.add(match[1]);
  }
  const candidates = Object.entries(ledger.report_runs?.daily || {})
    .filter(([day])=>day<date || rolloverFile).map(([day,report])=>({report,category:"日报",eligible:day<date}));
  if (week) for (const [oldWeek,run] of Object.entries(ledger.report_runs.weekly)) {
    if (oldWeek<week && run.long_weekly) candidates.push({report:run.long_weekly,category:"长文周报",eligible:true});
  }
  const moved = [];
  for (const {report,category,eligible} of candidates) {
    if (!report.path || report.archived_path) continue;
    if (![paths.summaryRoot,paths.previousSummaryRoot].some(root=>path.resolve(root)===path.dirname(path.resolve(report.path)))) continue;
    const archive = path.join(archiveRoot(paths),category,path.basename(report.path));
    if (!report.archive_pending) {
      const text = await readOptional(report.path);
      if (text === null) continue;
      const ids = [...text.matchAll(/<!-- rss-reading:item\s+([^\s>]+)\s+-->/gu)].map(match=>match[1]);
      if (ids.length !== (text.match(/<!-- rss-reading:item\b/gu) || []).length
        || ids.length !== (text.match(/<!-- rss-reading:end -->/gu) || []).length) throw new Error(`report_archive_malformed_items:${report.path}`);
      const ready = ids.every(id=>{
        const original = ledger.items[id];
        const item = original?.canonical_material_id ? ledger.items[original.canonical_material_id] : original;
        return item && ((item.decision === "dismissed" && !item.pending_markdown_action && !item.requested_action
            && (!item.reading_options?.direct_reading || item.publication?.status === 'archived'))
          || (item.decision === "selected" && item.publication?.status === "published" && !item.pending_markdown_action && !item.requested_action)
          || (item.decision === "deferred" && item.later?.status === "handoff_ready")
          || transferred.has(item.material_id));
      });
      if (!ready) continue;
      if (!eligible) {
        report.rollover_sha256 = digest(text);
        await save();
        continue;
      }
      report.archive_pending = {sha256:digest(text),destination_sha256:digest(relocatedMarkdown(text,report.path,archive))};
      await save();
    }
    await moveReport(report.path,archive,report.archive_pending.sha256,report.archive_pending.destination_sha256);
    report.archived_path = archive;
    delete report.archive_pending;
    moved.push({path:report.path,archived_path:archive});
    await save();
  }
  return moved;
}
