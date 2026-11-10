import fs from 'node:fs/promises';
import path from 'node:path';

export const reviewCardPattern = () => /<!-- rss-reading:item\s+([^\s>]+)\s+-->[\s\S]*?<!-- rss-reading:end -->/gu;
const controls = /^- \[[ xX]\] (?:正式入库|稍后再看|不保留|移出阅读区|稍后读|生成导读卡)[^\r\n]*\r?\n?/gmu;

// Old installation paths may be junction aliases of this same workspace.
// Resolve the directory even when the report itself has already moved.
export async function normalizeReportLocations(paths, ledger) {
  const roots = [paths.summaryRoot,paths.previousSummaryRoot].map(root=>path.resolve(root));
  async function normalize(file) {
    if (!file) return file;
    const parent = await fs.realpath(path.dirname(file)).catch(()=>null);
    return parent && roots.includes(path.resolve(parent)) ? path.join(parent,path.basename(file)) : file;
  }
  for (const run of Object.values(ledger.report_runs?.daily || {})) run.path = await normalize(run.path);
  for (const run of Object.values(ledger.report_runs?.weekly || {})) if (run.long_weekly) run.long_weekly.path = await normalize(run.long_weekly.path);
  for (const item of Object.values(ledger.items)) if(item.delivery) {
    for (const key of ['active_review_path','daily_report_path','blocked_report_path']) {
      if(item.delivery[key])item.delivery[key]=await normalize(item.delivery[key]);
    }
  }
}

export async function savedReviewCards(paths,ledger) {
  const cards = new Map();
  cards.sourceSnapshots=new Map();
  const files = new Set(Object.values(ledger.items).map(item=>item.delivery?.active_review_path).filter(Boolean));
  for(const file of files) {
    if(![paths.summaryRoot,paths.previousSummaryRoot].includes(path.dirname(file)))continue;
    const text=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    cards.sourceSnapshots.set(file,text || null);
    const matches=[...text.matchAll(reviewCardPattern())];
    for(const [index,match]of matches.entries()) {
      if(ledger.items[match[1]]?.delivery?.active_review_path!==file)continue;
      const gap=text.slice(match.index+match[0].length,matches[index+1]?.index ?? text.length);
      // Keep notes after a card too; generated source groups and activity are separate.
      const notes=gap.split(/^## |^<!-- subscriptions:activity -->/mu)[0].trimEnd();
      cards.set(match[1],match[0]+notes);
    }
  }
  return cards;
}

export async function verifyReviewSources(cards) {
  for(const [file,expected]of cards.sourceSnapshots || []) {
    const actual=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(actual!==expected)throw new Error(`report_changed_during_generation:${file}`);
  }
}

export function mergeReviewCard(generated,saved) {
  if(!saved)return generated;
  const actions=(generated.match(controls)||[]).join('');
  const instant=/^\[立刻阅读\][^\r\n]*/mu.exec(generated)?.[0];
  const status=/^\*\*当前状态\*\*：[^\r\n]*/mu.exec(generated)?.[0];
  let card=saved.replace(controls,'').replace(/^\[立刻阅读\][^\r\n]*\r?\n?/gmu,'')
    .replace(/^> 本(?:页|条)[^\r\n]*(?:历史|当前|待处理|审批)[^\r\n]*\r?\n?/gmu,'');
  const panel=actions+(instant ? instant+'\n' : '')+(status || '');
  if(/^\*\*当前状态\*\*：/mu.test(card))card=card.replace(/^\*\*当前状态\*\*：[^\r\n]*/mu,panel);
  else card=card.replace('<!-- rss-reading:end -->',panel+'\n<!-- rss-reading:end -->');
  for(const line of generated.split('\n').filter(line=>/^\*\*(?:内容概述|一句话核心|为什么值得读|可能新增量|建议读法)\*\*：/u.test(line))) {
    const label=line.split('：')[0];
    const previous=card.split('\n').find(value=>value.startsWith(label+'：'));
    if(previous && /^(?:概述正在生成。|预览处理尚未完成[^\n]*|待判断)\r?$/u.test(previous.slice(label.length+1))) {
      card=card.replace(previous,line);continue;
    }
    if(!card.includes(label)) {
      const target=card.includes('**预计阅读成本**')?'**预计阅读成本**':'<!-- rss-reading:end -->';
      card=card.replace(target,line+'\n'+target);
    }
  }
  return card;
}

export async function weeklyFromPreviousReports(paths,ledger,items,date) {
  const evidence=new Map();
  for(const [day,report]of Object.entries(ledger.report_runs.daily)) {
    if(day>=date)continue;
    const file=report.archived_path || report.path;
    const text=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    evidence.set(day,new Set([...text.matchAll(reviewCardPattern())].map(match=>match[1])));
  }
  return items.filter(item=>item.route==='long_review' && item.decision==='unresolved' && item.eligible_for_preprocess
    && item.delivery?.daily_report_key<date && evidence.get(item.delivery.daily_report_key)?.has(item.material_id));
}
