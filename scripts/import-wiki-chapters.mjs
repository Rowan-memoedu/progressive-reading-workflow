import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {JSDOM} from 'jsdom';
import TurndownService from 'turndown';
import {gfm} from 'turndown-plugin-gfm';
import {buildPreprocessRequest,runPreprocessingRequest,standardWorkflowOptions,publishReadingArtifact} from '../standard-preprocessing/index.mjs';
import {urlImportDedupeKey} from './url-import-input.mjs';
import {classifyStandardImportQuality} from './standard-import-quality.mjs';
import {unwrapPublishedOriginal} from '../standard-preprocessing/lib/original-section.mjs';

const workflowRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const readingRoot=path.join(workflowRoot,'阅读区');
const digest=s=>createHash('sha256').update(s).digest('hex');
const safe=s=>s.replace(/[<>:"/\\|?*\x00-\x1f]/g,'＿').replace(/[. ]+$/g,'').trim();
const norm=s=>s.replace(/<[^>]+>/g,'').replace(/[^\p{L}\p{N}]/gu,'');
async function exists(p){return fs.access(p).then(()=>true,()=>false);}
async function json(p){return JSON.parse(await fs.readFile(p,'utf8'));}
async function save(p,v){await fs.writeFile(p+'.tmp',JSON.stringify(v,null,2));await fs.rename(p+'.tmp',p);}
export function verifyChapterPublication({result,request,publication,markdown,sourceMarkdown}){
  const quality=classifyStandardImportQuality(result);
  if(!quality.admissible)throw new Error('preprocess_not_publishable');
  if(request.material.markdown!==sourceMarkdown)throw new Error('audit_source_mismatch');
  if(result.receipt.cleaning_policy.include_reading_guide!==false||result.artifacts.semantic.judgments!==null||result.artifacts.semantic.insights.length)throw new Error('reading_guide_not_disabled');
  if(/^## (阅读前置卡|核心洞察|导读卡)$/m.test(markdown))throw new Error('reading_guide_present');
  const original=unwrapPublishedOriginal(markdown.split('\n## 原文\n')[1]||(publication.duplicate_original_removed?markdown.split('\n## 正文\n')[1]:null));
  if(!original||norm(original)!==norm(sourceMarkdown))throw new Error('published_original_incomplete');
  if(digest(markdown)!==publication.markdown.sha256)throw new Error('publication_hash_mismatch');
  if(publication.quality_status!==quality.quality_status)throw new Error('publication_quality_mismatch');
  return {original_complete:true,no_reading_guide:true,sha256:digest(markdown),quality,original_location:publication.duplicate_original_removed?'body':'appendix'};
}
async function recordPublication(row,audit,body){
  const [result,request,publication,markdown]=await Promise.all([json(path.join(audit,'result.json')),json(path.join(audit,'request.json')),json(path.join(audit,'publication.json')),fs.readFile(row.destination,'utf8')]);
  if(path.resolve(publication.markdown.path)!==path.resolve(row.destination))throw new Error('publication_path_mismatch');
  const verified=verifyChapterPublication({result,request,publication,markdown,sourceMarkdown:body.markdown});
  row.status=verified.quality.quality_status==='warning'?'imported_with_warnings':'imported';
  row.published_path=row.destination;row.sha256=verified.sha256;row.audit_dir=audit;row.quality=verified.quality;
  await save(path.join(audit,'chapter-verification.json'),{...verified,source_html_sha256:body.receipt.source_html_sha256});
  console.log(JSON.stringify({order:row.order,title:row.title,status:row.status,path:row.destination}));
}
export function parseChapterCatalog(capture){
  const d=new JSDOM(capture.html,{url:capture.url}).window.document;
  const root=d.querySelector('.mw-parser-output');if(!root)throw new Error('catalog_root_missing');
  const rows=[],groups=[];let active=false,ended=false,group='';
  for(const el of root.children){
    const h=el.matches('h1,h2')?el:el.querySelector(':scope > h1,:scope > h2');
    if(h?.tagName==='H1'){if(active){ended=true;break;}active=h.textContent.trim()==='Chapters';continue;}
    if(!active)continue;
    if(h?.tagName==='H2'){group=h.textContent.trim();groups.push(group);}
    if(!['UL','OL'].includes(el.tagName))continue;
    for(const li of el.querySelectorAll('li')){
      const a=[...li.children].find(e=>e.tagName==='A');if(!a)throw new Error('unknown_catalog_item');
      const parents=[];let p=li.parentElement?.closest('li');
      while(p){const pa=[...p.children].find(e=>e.tagName==='A');if(!pa)throw new Error('unknown_parent');parents.unshift(pa.textContent.trim());p=p.parentElement?.closest('li');}
      if(!group)throw new Error('chapter_group_missing');
      rows.push({order:rows.length+1,group,parents,title:a.textContent.trim(),url:a.href,hasChildren:Boolean(li.querySelector(':scope > ul,:scope > ol'))});
    }
  }
  if(!ended||!groups.length||!rows.length)throw new Error('catalog_incomplete');
  return {groups,rows};
}
async function sourceIndex(){
  const map=new Map();
  async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){
    if(e.name.startsWith('.'))continue;const p=path.join(dir,e.name);
    if(e.isDirectory())await walk(p);
    else if(e.name.endsWith('.md')){const raw=await fs.readFile(p,'utf8');const fm=raw.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1]||'';
      for(const m of fm.matchAll(/^(?:source_url|canonical_url):\s*["']?(https?:\/\/[^\s"']+)/gm)){const key=urlImportDedupeKey(m[1]);if(!map.has(key))map.set(key,[]);if(!map.get(key).some(v=>v.path===p))map.get(key).push({path:p,sha256:digest(raw)});}
    }
  }}await walk(readingRoot);return map;
}
export function extractWikiBody(capture){
  const d=new JSDOM(capture.html,{url:capture.url}).window.document;
  const root=d.querySelector('.mw-parser-output');if(!root)throw new Error('article_root_missing');
  const removed=[];
  for(const e of root.querySelectorAll('.toc, #toc, script, style, .mw-editsection, .printfooter, .noprint, .more')){removed.push({reason:'page_chrome',text:e.textContent});e.remove();}
  while(root.lastElementChild?.matches('hr,p')&&!root.lastElementChild.textContent.trim()&&!root.lastElementChild.querySelector('img,video,audio'))root.lastElementChild.remove();
  const first=root.querySelector(':scope > p');
  if(first&&/^This (?:text|reference) is (?:part of|used to annotate):?/i.test(first.textContent.trim())){removed.push({reason:'book_backlink',text:first.textContent});first.remove();}
  for(const e of root.querySelectorAll('a[href],img[src]')){const attr=e.tagName==='A'?'href':'src';const raw=e.getAttribute(attr);if(raw&&!raw.startsWith('#'))e.setAttribute(attr,new URL(raw,capture.url).href);}
  const td=new TurndownService({headingStyle:'atx',codeBlockStyle:'fenced',bulletListMarker:'-'});td.use(gfm);
  td.addRule('math',{filter:n=>n.classList?.contains('mwe-math-element'),replacement:(_c,n)=>{const a=n.querySelector('annotation[encoding="application/x-tex"]');if(!a)throw new Error('math_source_missing');return '$'+a.textContent+'$';}});
  const markdown=td.turndown(root.innerHTML).trim();
  if(markdown.length<80)throw new Error('empty_article');
  const textNodes=[];const walker=d.createTreeWalker(root,4);let n;
  while(n=walker.nextNode()){if(n.parentElement.closest('.mwe-math-element'))continue;const t=norm(n.textContent);if(t.length>=12)textNodes.push(t);}
  const rendered=norm(markdown);const missing=textNodes.filter(t=>!rendered.includes(t));
  if(missing.length)throw new Error('html_to_markdown_text_loss:'+missing.length);
  return {markdown,receipt:{source_html_sha256:digest(capture.html),markdown_sha256:digest(markdown),checked_text_nodes:textNodes.length,missing_text_nodes:missing.length,headings:[...root.querySelectorAll('h1,h2,h3,h4')].map(h=>h.textContent.trim()),removed}};
}
async function writeIndex(plan){
  const lines=['---','type: collection_index','---','',`# ${plan.title}`,'',`[原始目录](${plan.source_url})`,''];
  for(const group of plan.groups){lines.push(`## ${group}`,'');for(const row of plan.rows.filter(r=>r.group===group)){
    const target=row.reused?.path||row.published_path;
    const link=target?`[${row.title}](<${path.relative(plan.book_root,target).replaceAll('\\','/')}>)`:`[${row.title}](${row.url})`;
    const state=row.reused?'（复用已有）':row.status==='imported_with_warnings'?'（已导入，质量警告；详见验收记录）':row.status==='failed'?'（导入或修订失败）':row.published_path?'':'（尚未导入）';
    lines.push('  '.repeat(row.parents.length)+'- '+link+state);
  }lines.push('');}
  const file=path.join(plan.book_root,'目录.md');
  if(await exists(file)){const old=await fs.readFile(file,'utf8');if(plan.index_sha256&&digest(old)!==plan.index_sha256)throw new Error('user_modified_index_preserved');if(!plan.index_sha256)throw new Error('existing_index_preserved');}
  const body=lines.join('\n');await fs.writeFile(file,body);plan.index_sha256=digest(body);
}
async function initialize(catalogFile,runRoot,parentRelative,limit){
  const capture=await json(catalogFile);const {groups,rows}=parseChapterCatalog(capture);
  const parent=path.resolve(readingRoot,parentRelative);if(!parent.startsWith(readingRoot+path.sep)||!await exists(parent))throw new Error('existing_parent_required');
  const bookRoot=path.join(parent,safe(capture.title));await fs.mkdir(runRoot,{recursive:true});
  const planPath=path.join(runRoot,'plan.json');if(await exists(planPath))throw new Error('plan_already_exists');
  const sources=await sourceIndex();const seen=new Map();const destinationKeys=new Set();
  for(const row of rows){
    const key=urlImportDedupeKey(row.url);const matches=sources.get(key)||[];if(matches.length>1)throw new Error('multiple_existing_sources:'+row.url);
    const folder=path.join(bookRoot,safe(row.group),...row.parents.map(safe),...(row.hasChildren?[safe(row.title)]:[]));
    row.destination=path.join(folder,safe(row.title)+'.md');row.status='pending';
    if(matches.length){row.reused=matches[0];row.status='reused';}
    if(seen.has(key))row.duplicate_of=seen.get(key);else seen.set(key,row.order);
    const fileKey=row.destination.toLowerCase();if(destinationKeys.has(fileKey)&&!row.duplicate_of)throw new Error('filename_collision');destinationKeys.add(fileKey);
  }
  const plan={schema:'local-ir.wiki-chapter-plan/v1',source_url:capture.url,title:capture.title,catalog_file:catalogFile,catalog_sha256:digest(capture.html),book_root:bookRoot,reading_root:readingRoot,limit,groups,rows,created_at:new Date().toISOString()};
  // Validate the complete plan before making reading-area directories.
  for(const row of rows)await fs.mkdir(path.dirname(row.destination),{recursive:true});
  await writeIndex(plan);await save(planPath,plan);
  console.log(JSON.stringify({plan:planPath,groups:groups.length,entries:rows.length,unique:seen.size,selected:rows.slice(0,limit).map(r=>({order:r.order,title:r.title,url:r.url,status:r.status}))}));
}
async function run(planPath,captureRoot,refreshSources=false){
  const plan=await json(planPath);const runRoot=path.dirname(planPath);
  const missing=[];
  for(const row of plan.rows.slice(0,plan.limit).filter(r=>!r.reused&&!r.published_path))if(!await exists(path.join(captureRoot,digest(row.url).slice(0,16)+'.json')))missing.push(row.url);
  if(missing.length)throw new Error('capture_batch_incomplete:'+JSON.stringify(missing));
  for(const row of plan.rows.slice(0,plan.limit)){
    if(row.reused){if(digest(await fs.readFile(row.reused.path,'utf8'))!==row.reused.sha256)throw new Error('existing_article_changed');console.log(JSON.stringify({order:row.order,status:'reused',title:row.title}));continue;}
    if(row.published_path){if(digest(await fs.readFile(row.published_path,'utf8'))!==row.sha256)throw new Error('published_article_changed');if(!refreshSources)continue;}
    try{
      if(row.error){row.attempt_history??=[];row.attempt_history.push({status:row.status,error:row.error,retried_at:new Date().toISOString()});delete row.error;}
      const id=digest(row.url).slice(0,16);const capture=await json(path.join(captureRoot,id+'.json'));
      if(urlImportDedupeKey(capture.requested_url||capture.url)!==urlImportDedupeKey(row.url))throw new Error('capture_identity_mismatch');
      const body=extractWikiBody(capture);let audit=row.audit_dir||path.join(runRoot,'articles',id);let replacingOwnPublication=false;
      if(row.published_path&&refreshSources){
        const previousRequest=await json(path.join(audit,'request.json'));
        if(previousRequest.material.markdown===body.markdown)continue;
        row.attempt_history??=[];row.attempt_history.push({status:row.status,audit_dir:audit,sha256:row.sha256,reason:'source_extraction_changed',retried_at:new Date().toISOString()});
        const backup=path.join(audit,'previous-publication.md');
        if(await exists(backup)){if(digest(await fs.readFile(backup,'utf8'))!==row.sha256)throw new Error('previous_publication_backup_conflict');}
        else await fs.copyFile(row.published_path,backup,2);
        audit=path.join(runRoot,'articles',id,'attempts',Date.now().toString());replacingOwnPublication=true;
      }
      // Recover a publication made by this run before its plan checkpoint, without
      // confusing it with a pre-existing article or silently overwriting it.
      if(await exists(path.join(audit,'publication.json'))){await recordPublication(row,audit,body);continue;}
      const current=await sourceIndex();const matches=current.get(urlImportDedupeKey(row.url))||current.get(urlImportDedupeKey(capture.canonical_url||capture.url))||[];
      if(matches.length>1)throw new Error('multiple_existing_sources');
      if(matches.length&&!replacingOwnPublication){row.reused=matches[0];row.status='reused';continue;}
      if(await exists(row.destination)&&!replacingOwnPublication)throw new Error('destination_exists_preserved');
      await fs.mkdir(audit,{recursive:true});
      await fs.writeFile(path.join(audit,'source.md'),body.markdown);await save(path.join(audit,'extraction.json'),body.receipt);
      const request=buildPreprocessRequest({markdown:body.markdown,sourceType:'browser_capture_markdown',sourceMetadata:{source_url:row.url,canonical_url:capture.canonical_url||capture.url,title:capture.title,source_title:capture.title,source_is_original:true,input_form:'written',content_profile:'natural_language',language:'en',capture_agent:'chrome_rendered_dom',collection_url:plan.source_url},processingOptions:standardWorkflowOptions({include_reading_guide:false,input_form:'written',content_profile:'natural_language',source_language:'en'})});
      row.status='processing';await save(planPath,plan);console.log(JSON.stringify({order:row.order,title:row.title,status:'processing',source_chars:body.markdown.length}));
      const timer=setInterval(()=>console.log(JSON.stringify({order:row.order,status:'processing',at:new Date().toISOString()})),30000);
      let result;try{({result}=await runPreprocessingRequest(request,{outputDir:audit,publishPath:replacingOwnPublication?undefined:row.destination,cacheDir:'D:/Caches/ProgressiveReading/preprocess'}));}finally{clearInterval(timer);}
      if(replacingOwnPublication){
        if(!classifyStandardImportQuality(result).admissible)throw new Error('replacement_not_publishable');
        if(!row.destination.startsWith(plan.book_root+path.sep)||digest(await fs.readFile(row.destination,'utf8'))!==row.sha256)throw new Error('replacement_target_changed');
        const previous=path.join(audit,'superseded-publication.md');
        await fs.rename(row.destination,previous);
        try{await publishReadingArtifact(result,{publishPath:row.destination,runDir:audit});}
        catch(error){if(!await exists(row.destination))await fs.copyFile(previous,row.destination,2);throw error;}
      }
      await recordPublication(row,audit,body);
    }catch(e){row.status='failed';row.error=e.message;console.log(JSON.stringify({order:row.order,status:'failed',error:e.message}));}
    finally{await writeIndex(plan);await save(planPath,plan);}
  }
  for(const row of plan.rows.filter(r=>r.reused))if(digest(await fs.readFile(row.reused.path,'utf8'))!==row.reused.sha256)throw new Error('reused_article_modified');
  console.log(JSON.stringify({results:plan.rows.slice(0,plan.limit).map(r=>({order:r.order,title:r.title,status:r.status,error:r.error}))}));
  if(plan.rows.slice(0,plan.limit).some(r=>r.status==='failed'))process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [command,...args]=process.argv.slice(2);
  if(command==='plan')await initialize(path.resolve(args[0]),path.resolve(args[1]),args[2],Number(args[3]||10));
  else if(command==='run')await run(path.resolve(args[0]),path.resolve(args[1]),args.includes('--refresh-sources'));
  else throw new Error('usage: plan <catalog.json> <run-root> <existing-parent-relative> [limit] | run <plan.json> <capture-root> [--refresh-sources]');
}
