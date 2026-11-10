import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
export const readingMovePayload=moves=>moves.map(({source,target})=>({source,target}));
export function readingStateEqual(a,b){const stable=value=>JSON.stringify(value??null,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);return stable(a)===stable(b);}
export async function moveReaderFile(app,plugin,from,to){
  const file=app.vault.getAbstractFileByPath(from);
  if(!file)throw Error('reading_host_source_missing:'+from);
  if(app.vault.getAbstractFileByPath(to))throw Error('reading_host_destination_exists:'+to);
  await plugin.ensureFolder(to.split('/').slice(0,-1).join('/'));
  plugin.managedRenamePaths.add(from);
  try{
    // The importer repairs all affected links in one checked pass. Avoid a
    // whole-vault backlink rewrite for each of hundreds of individual moves.
    await app.vault.rename(file,to);
    await plugin.handleVaultRename(file,from,true);
  }finally{plugin.managedRenamePaths.delete(from);}
  return to;
}

// Use the existing reader's managed move, which preserves records, annotations,
// card IDs, source selections and in-memory state; do not edit its live data.json.
export async function moveInReadingHost(root,moves,recovery,retired=[]){
  if(process.env.NODE_ENV==='test'||process.platform!=='win32'||(!moves.length&&!retired.length))return {available:false};
  const registry=await fs.readFile(path.join(process.env.APPDATA,'obsidian','obsidian.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  const vaults=Object.entries(registry?.vaults||{}).filter(([,v])=>v.open);
  if(!vaults.length)return {available:false};
  const processes=await execute('tasklist.exe',['/FI','IMAGENAME eq Obsidian.exe','/FO','CSV','/NH'],{windowsHide:true,timeout:15000});
  if(!/^"Obsidian\.exe"/imu.test(processes.stdout))return {available:false};
  const cli=path.join(process.env.LOCALAPPDATA,'Programs','Obsidian','Obsidian.com');
  const source=async function(root,moves,recovery,retired,equalSource,moveSource){
    const fs=require('node:fs'),p=require('node:path'),plugin=app.plugins.plugins['local-ir'];
    const equal=eval('('+equalSource+')');
    const moveFile=eval('('+moveSource+')');
    if(!plugin?.moveVaultFilePath)throw Error('reading_host_managed_move_unavailable');
    const folder=[app.vault.getRoot(),...app.vault.getAllLoadedFiles().filter(f=>Array.isArray(f.children)&&f.name===p.basename(root))].find(f=>{try{return fs.realpathSync(app.vault.adapter.getFullPath(f.path))===fs.realpathSync(root);}catch{return false;}});
    if(!folder)return {available:false};
    const toVault=file=>[folder.path==='/'?'':folder.path,p.relative(root,file).replaceAll('\\','/')].filter(Boolean).join('/');
    for(const file of retired){const at=toVault(file),record=plugin.settings.records[at];if(record?.visitCount||record?.metricsEditedByUser||record?.readingPosition||Object.values(plugin.settings.annotations).some(a=>a.path===at)||Object.values(plugin.settings.qaCards).some(a=>a.path===at)||plugin.settings.articleMusings[at])throw Error('duplicate_has_reading_state:'+at);}
    const receipt=[];
    fs.mkdirSync(recovery,{recursive:true});
    for(const move of moves){const from=toVault(move.source),to=toVault(move.target),record=plugin.settings.records[from];
      if(!app.vault.getAbstractFileByPath(from)){if(app.vault.getAbstractFileByPath(to))continue;await app.vault.adapter.reconcileFile(from,from);}
      const before=record?JSON.parse(JSON.stringify(record)):null;
      const annotations=Object.values(plugin.settings.annotations).filter(a=>a.path===from).map(a=>JSON.parse(JSON.stringify(a)));
      fs.writeFileSync(p.join(recovery,'before-move-'+require('node:crypto').createHash('sha256').update(from).digest('hex')+'.json'),JSON.stringify({from,to,before,annotations},null,2));
      const actual=await moveFile(app,plugin,from,to);if(actual!==to)throw Error('reading_host_move_path_mismatch');
      const after=plugin.settings.records[to];
      for(const key of ['metrics','metricsEditedByUser','priority','readingPosition','visitCount','lastVisited','deferUntil','status'])if(before&&!equal(before[key],after?.[key]))throw Error('reading_host_progress_changed:'+key);
      for(const annotation of annotations){const found=plugin.settings.annotations[annotation.id];if(found?.path!==to||!equal({...annotation,path:to,lastKnownPath:to},{...found,lastKnownPath:to}))throw Error('reading_host_annotation_changed');}
      receipt.push({from,to,before,after:after?JSON.parse(JSON.stringify(after)):null,annotations:annotations.length});
    }
    await plugin.saveSettings({flushDocumentStateSidecars:false});
    if(typeof plugin.refreshViews==='function')await plugin.refreshViews();
    fs.writeFileSync(p.join(recovery,'host-'+Date.now()+'.json'),JSON.stringify(receipt,null,2));
    return {available:true,moved:receipt.length,records_preserved:receipt.filter(r=>r.before).length,annotations_preserved:receipt.reduce((n,r)=>n+r.annotations,0)};
  };
  const reports=[];
  for(let offset=0;offset<Math.max(moves.length,1);offset+=12){
    const receiptFile=path.join(recovery,'reader-result-'+offset+'.json');
    await fs.unlink(receiptFile).catch(error=>{if(error.code!=='ENOENT')throw error;});
    const invocation='('+source.toString()+')('+JSON.stringify(root)+','+JSON.stringify(readingMovePayload(moves.slice(offset,offset+12)))+','+JSON.stringify(recovery)+','+JSON.stringify(offset===0?retired:[])+','+JSON.stringify(readingStateEqual.toString())+','+JSON.stringify(moveReaderFile.toString())+')';
    const code='void '+invocation+'.then(result=>{require("node:fs").writeFileSync('+JSON.stringify(receiptFile)+',JSON.stringify({ok:true,result}))}).catch(error=>{require("node:fs").writeFileSync('+JSON.stringify(receiptFile)+',JSON.stringify({ok:false,error:error.message}))}); "started"';
    const jsFile=path.join(recovery,'reader-move-'+offset+'.js');await fs.writeFile(jsFile,code,'utf8');
    const argument='code=eval(require("node:fs").readFileSync('+JSON.stringify(jsFile)+',"utf8"))';
    const quote=value=>"'"+value.replaceAll("'","''")+"'";
    const command='& '+quote(cli)+' '+quote('vault='+vaults[0][0])+' eval '+quote(argument);
    const script=path.join(recovery,'reader-move-'+offset+'.ps1');await fs.writeFile(script,command,'utf8');
    const {stdout,stderr}=await execute('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script],{windowsHide:true,timeout:120000,maxBuffer:1024*1024});
    let receipt;const started=Date.now();
    do{receipt=await fs.readFile(receiptFile,'utf8').then(JSON.parse).catch(()=>null);if(!receipt)await new Promise(resolve=>setTimeout(resolve,500));}while(!receipt&&Date.now()-started<900000);
    if(receipt?.ok===false)throw new Error(receipt.error);
    if(!receipt&&!stdout.trim()){await fs.writeFile(path.join(recovery,'reader-command-error.log'),stderr);throw new Error('阅读器移动命令未返回回执，诊断已保存在恢复记录中');}
    const report=receipt?.result || JSON.parse(stdout.trim().replace(/^=>\s*/u,''));reports.push(report);if(!report.available)return report;
  }
  return {available:true,batches:reports};
}
