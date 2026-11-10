import fs from 'node:fs/promises';
import path from 'node:path';
import {readJson,writeJson,digest} from '../subscription-workflow/config.mjs';
import {replaceChecked} from '../subscription-workflow/report-archive.mjs';
import {runPath,listRuns} from './store.mjs';
import {taxonomyGroups} from './taxonomy.mjs';

export async function knownIndexes(root,sourceId){const known=new Map();for(const run of await listRuns(root)){if(run.source_id!==sourceId)continue;const index=await readJson(path.join(runPath(root,run.id),'index.json')),organization=await readJson(path.join(runPath(root,run.id),'organization.json'));const moved=(organization?.owned_index_hashes||[]).map(([file,sha256])=>({path:file,sha256}));for(const item of [...(index?[index,...index.files||[]]:[]),...moved])if(item.path&&item.sha256){if(!known.has(item.path))known.set(item.path,new Set());known.get(item.path).add(item.sha256);}}return known;}
export async function writeSiteIndexes(root,settings,inventory,records,id,organization={}){
  const base=path.join(root,'阅读区',settings.destination),known=await knownIndexes(root,settings.id),owned=new Map(organization.owned_index_hashes||[]),files=[];
  const rootIndex=path.join(base,'目录.md'),legacy=await fs.readFile(rootIndex,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  const escaped=value=>String(value).replace(/[\[\]]/gu,'\\$&'),byUrl=new Map(records.map(row=>[row.url,row]));
  const legacyBody=['# '+settings.name,'','[网站]('+settings.url+')','',...inventory.articles.map(article=>'- ['+escaped(article.title)+'](<'+path.relative(base,byUrl.get(article.url).path).replaceAll('\\','/')+'>)')].join('\n')+'\n';
  const normalizeLinks=body=>body.replace(/\]\(<([^>]+)>\)/gu,(_match,target)=>{try{target=decodeURIComponent(target);}catch{}const absolute=path.resolve(base,target);return '](<'+(process.platform==='win32'?absolute.toLowerCase():absolute)+'>)';});
  // Older native moves updated generated links before the old index hash could
  // be saved. Recognize only the exact legacy generator output, with every
  // title and destination accounted for; retain handwritten additions.
  if(legacy!==null&&known.has(rootIndex)&&normalizeLinks(legacy)===normalizeLinks(legacyBody)){
    const recovery=path.join(runPath(root,id),'recovery','legacy-index-'+digest(legacy)+'.md');await fs.mkdir(path.dirname(recovery),{recursive:true});await fs.writeFile(recovery,legacy,{flag:'wx'}).catch(async e=>{if(e.code!=='EEXIST'||await fs.readFile(recovery,'utf8')!==legacy)throw e;});owned.set(rootIndex,digest(legacy));
  }
  const write=async(target,body)=>{let before=await fs.readFile(target,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(before!==null&&before!==body&&!known.get(target)?.has(digest(before))&&owned.get(target)!==digest(before)){target=target.replace(/\.md$/u,'-'+id.slice(-8)+'.md');before=await fs.readFile(target,'utf8').catch(e=>{if(e.code==='ENOENT')return null;throw e;});if(before!==null&&before!==body)throw new Error('分类目录存在人工修改，已保留：'+target);}await replaceChecked(target,before,body);files.push({path:target,sha256:digest(body)});return target;};
  const rows=new Map(records.map(row=>[row.url,row])),escape=text=>String(text).replace(/[\[\]]/gu,'\\$&');
  const groups=taxonomyGroups(inventory.articles),rootLines=['# '+settings.name,'','[网站]('+settings.url+')',''];let kind;
  for(const group of groups){const folder=path.join(base,...group.folder.split('/'));const lines=['# '+group.name,'',...group.articles.map(article=>'- ['+escape(article.title)+'](<'+path.relative(folder,rows.get(article.url).path).replaceAll('\\','/')+'>)')];
    const target=await write(path.join(folder,'目录.md'),lines.join('\n')+'\n');
    if(kind!==group.kind){kind=group.kind;rootLines.push('## '+kind,'');}rootLines.push('- ['+escape(group.name)+'](<'+path.relative(base,target).replaceAll('\\','/')+'>) · '+group.articles.length+' 篇');
  }
  const index=await write(path.join(base,'目录.md'),rootLines.join('\n')+'\n');await writeJson(path.join(runPath(root,id),'index.json'),{path:index,sha256:files.find(f=>f.path===index).sha256,files});return {index,groups:groups.map(g=>({kind:g.kind,name:g.name,count:g.articles.length,folder:g.folder}))};
}
