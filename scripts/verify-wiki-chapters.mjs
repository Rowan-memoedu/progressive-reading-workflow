import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import {urlImportDedupeKey} from './url-import-input.mjs';
import {unwrapPublishedOriginal} from '../standard-preprocessing/lib/original-section.mjs';

const planFile=path.resolve(process.argv[2]),captureRoot=path.resolve(process.argv[3]);
const json=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const hash=s=>createHash('sha256').update(s).digest('hex');
const whitespace=s=>s.replace(/\r/g,'').split('\n').map(x=>x.trimEnd()).join('\n').replace(/\n{3,}/g,'\n\n').trim();
const letters=s=>s.replace(/<[^>]+>/g,'').replace(/[^\p{L}\p{N}]/gu,'');
const plan=await json(planFile),files=[];
async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name.endsWith('.md'))files.push({path:p,text:await fs.readFile(p,'utf8')});}}
await walk(plan.reading_root);
const sourceMatches=url=>files.filter(f=>[...(f.text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]||'').matchAll(/^(?:source_url|canonical_url):\s*["']?(https?:\/\/[^\s"']+)/gm)].some(m=>urlImportDedupeKey(m[1])===urlImportDedupeKey(url)));
const index=await fs.readFile(path.join(plan.book_root,'目录.md'),'utf8');
assert.equal(hash(index),plan.index_sha256);
for(const row of plan.rows)assert.ok((await fs.stat(path.dirname(row.destination))).isDirectory());
const rows=[];
for(const row of plan.rows.slice(0,plan.limit)){
  const target=row.reused?.path||row.published_path;
  assert.ok(target,`unpublished chapter ${row.order}`);
  const markdown=await fs.readFile(target,'utf8');
  assert.equal(hash(markdown),row.reused?.sha256||row.sha256);
  assert.ok(index.includes(`(<${path.relative(plan.book_root,target).replaceAll('\\','/')}>)`));
  const report={order:row.order,title:row.title,status:row.status,path:target,sha256:hash(markdown),index_link_verified:true};
  if(row.reused){assert.equal(sourceMatches(row.url).length,1);report.existing_unchanged=true;rows.push(report);continue;}
  const capture=await json(path.join(captureRoot,hash(row.url).slice(0,16)+'.json'));
  const matches=new Set([...sourceMatches(row.url),...sourceMatches(capture.canonical_url||capture.url)].map(f=>f.path));
  assert.deepEqual([...matches],[target]);
  const request=await json(path.join(row.audit_dir,'request.json'));
  const result=await json(path.join(row.audit_dir,'result.json'));
  const publication=await json(path.join(row.audit_dir,'publication.json'));
  const extraction=await json(path.join(row.audit_dir,'extraction.json'));
  assert.equal(hash(capture.html),extraction.source_html_sha256);
  assert.equal(hash(request.material.markdown),extraction.markdown_sha256);
  const original=unwrapPublishedOriginal(markdown.split('\n## 原文\n')[1]||(publication.duplicate_original_removed?markdown.split('\n## 正文\n')[1]:null));
  assert.ok(original);
  assert.equal(whitespace(original),whitespace(request.material.markdown));
  // Independent DOM-to-published-text coverage, not the extraction receipt's PASS.
  const document=new JSDOM(capture.html).window.document,root=document.querySelector('.mw-parser-output');
  root.querySelectorAll('.toc,#toc,script,style,.mw-editsection,.printfooter,.noprint,.more').forEach(e=>e.remove());
  const first=root.querySelector(':scope > p');
  if(first&&/^This (?:text|reference) is (?:part of|used to annotate):?/i.test(first.textContent.trim()))first.remove();
  const walker=document.createTreeWalker(root,4),text=letters(original);let node,count=0;
  while(node=walker.nextNode()){
    if(node.parentElement.closest('.mwe-math-element'))continue;
    const value=letters(node.textContent);if(value.length<12)continue;
    assert.ok(text.includes(value),`source text missing: chapter ${row.order}`);count++;
  }
  const independent=JSON.parse(execFileSync(process.execPath,[path.join(path.dirname(fileURLToPath(import.meta.url)),'verify-no-guide-publication.mjs'),row.audit_dir],{encoding:'utf8'}));
  assert.equal(independent.passed,true);
  report.quality_status=publication.quality_status;report.original_complete=true;report.source_text_nodes=count;
  report.no_reading_guide=true;report.guide_api_calls=independent.guide_api_calls;
  report.translation=publication.duplicate_original_removed?'original_fallback':'translated';
  report.errors=result.errors;report.attempt_errors=result.receipt.model.attempts.flatMap(a=>a.validation_errors||[]);
  rows.push(report);
}
const report={verified_at:new Date().toISOString(),structural_checks_passed:true,full_translation_complete:rows.every(r=>r.status==='reused'||r.translation==='translated'),groups:plan.groups.length,catalog_entries:plan.rows.length,unique_catalog_urls:new Set(plan.rows.map(r=>urlImportDedupeKey(r.url))).size,selected:rows.length,new_articles:rows.filter(r=>!r.existing_unchanged).length,reused:rows.filter(r=>r.existing_unchanged).length,translated:rows.filter(r=>r.translation==='translated').length,original_fallback:rows.filter(r=>r.translation==='original_fallback').length,rows};
const out=path.dirname(planFile);
await fs.writeFile(path.join(out,'acceptance.json'),JSON.stringify(report,null,2));
const lines=['# Problem of Schooling 首批导入验收','',`验证时间：${report.verified_at}`,'',`目录：${report.groups} 个分组，${report.catalog_entries} 个条目，按目录 URL 去重 ${report.unique_catalog_urls} 篇。首批按原站顺序处理 ${report.selected} 篇，新增 ${report.new_articles} 篇、复用 ${report.reused} 篇。`,'',`新增文章中 ${report.translated} 篇完成翻译，${report.original_fallback} 篇翻译未通过，按标准合同保留完整英文正文并标记 warning。结构、来源正文完整性、无导读与去重检查通过，不代表全部译文通过。`,'','| 顺序 | 章节 | 结果 |','| --- | --- | --- |',...rows.map(r=>`| ${r.order} | [${r.title}](<${r.path.replaceAll('\\','/')}>) | ${r.existing_unchanged?'复用已有，哈希未变':r.translation==='translated'?'译文＋完整原文；无导读':'完整原文；翻译未通过；无导读'} |`),'','核验：逐篇从冻结 HTML 检查正文文本覆盖；原文与标准请求逐字比较（仅归一空白）；独立重跑无导读发布校验；读取正式文件核对 SHA-256；扫描阅读区核对来源 URL 唯一；检查书内索引实际指向；复用文件保持原位及原哈希。','', '失败证据保留在各 article 审计目录与 plan.attempt_history；acceptance.json 记录各次翻译错误。错误含部分段落缺少中文译文、API fetch failed / terminated，不统一解释为语法失真。','','自动化边界：目录构建、去重、正文提取、标准处理、发布与独立验收由 CLI 执行。首批冻结 HTML 仍由真实 Chrome DOM 临时采集；尚未接入无需逐页 GUI 的扩展快照任务接口。普通 HTTP、匹配 Cookie、兼容 HTTP 请求本轮仍为 403。未声称全书采集或一键集合规则已完成。','','范围：本轮为 Chapters 前 10 个条目；根页面 Introduction 及其余章节尚未导入。'];
await fs.writeFile(path.join(out,'验收.md'),lines.join('\n'));
console.log(JSON.stringify({...report,rows:undefined,report:path.join(out,'验收.md')}));
