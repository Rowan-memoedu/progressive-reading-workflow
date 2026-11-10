import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,withLock,digest} from '../subscription-workflow/config.mjs';
import {replaceChecked} from '../subscription-workflow/report-archive.mjs';

const link=(from,to)=>path.relative(path.dirname(from),to).replaceAll('\\','/');
const label=value=>String(value).replace(/[\[\]\r\n]/gu,' ');
export async function writeRepositoryIndexes(root,settings,captures,publications) {
  const base=path.resolve(root,'阅读区',settings.destination),directories=new Map([['',[]]]),byUrl=new Map(publications.filter(r=>r.verified).map(r=>[r.url,r]));
  for(const capture of captures){
    const row=byUrl.get(capture.url);if(!row)continue;
    const relative=capture.metadata.repository.relative_path,parts=relative.split('/');parts.pop();
    for(let depth=1;depth<=parts.length;depth++){const dir=parts.slice(0,depth).join('/');if(!directories.has(dir))directories.set(dir,[]);}
    directories.get(parts.join('/')).push({capture,row});
  }
  const generated=new Map();
  for(const [dir,articles]of directories){
    const file=path.join(base,dir,'目录.md'),prefix=dir?dir+'/':'';
    const children=[...directories.keys()].filter(child=>child.startsWith(prefix)&&child!==dir&&!child.slice(prefix.length).includes('/'));
    const lines=['# '+(dir?dir.split('/').at(-1):settings.name),''];
    for(const child of children)lines.push(`- [${label(child.split('/').at(-1))}](<${link(file,path.join(base,child,'目录.md'))}>)`);
    for(const {capture,row}of articles)lines.push(`- [${label(capture.title)}](<${link(file,row.path)}>)`);
    generated.set(file,lines.join('\n')+'\n');
  }
  const registry=await readJson(path.join(root,'.local-ir','source-relations.json'));
  const pairs=Object.values(registry?.representations || {}).filter(row=>row.repository?.url===settings.repository.url&&row.original_path);
  const pairFile=path.join(base,'原译文对照.md');
  generated.set(pairFile,['# 原译文对照','','| 译文 | 本地原文 | 原文链接 |','| --- | --- | --- |',...pairs.map(row=>{
    const capture=captures.find(c=>c.url===row.translation_url);
    return `| [${label(capture?.title||path.basename(row.translation_path,'.md')).replaceAll('|','｜')}](<${link(pairFile,row.translation_path)}>) | [打开原文](<${link(pairFile,row.original_path)}>) | [来源](<${row.original_url}>) |`;
  })].join('\n')+'\n');
  const manifest=path.join(root,'.local-ir','repository-indexes',digest(settings.repository.url+':'+settings.repository.content_root)+'.json');
  return withLock(manifest+'.lock',async()=>{
    const previous=await readJson(manifest) || {hashes:{}},before=new Map();
    for(const [file,text]of generated){
      const existing=await fs.readFile(file,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
      if(existing!==null&&existing!==text&&digest(existing)!==previous.hashes[file])throw new Error('repository_index_user_edit_preserved:'+file);
      before.set(file,existing);
    }
    for(const [file,text]of generated)if(before.get(file)!==text){await fs.mkdir(path.dirname(file),{recursive:true});await replaceChecked(file,before.get(file),text);}
    await writeJson(manifest,{hashes:Object.fromEntries([...generated].map(([file,text])=>[file,digest(text)]))});
    return {root_index:path.join(base,'目录.md'),local_pairs:pairFile,index_count:generated.size};
  });
}
