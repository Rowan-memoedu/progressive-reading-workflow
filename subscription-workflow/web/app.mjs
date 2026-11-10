const $=id=>document.getElementById(id);
// Hallmark · scope: component; existing form controls and tokens retained.
const kinds={rss:'RSS / Atom',bilibili_video:'B 站多 P 视频',bilibili_collection:'B 站合集',zhihu_author:'知乎作者',zhihu_column:'知乎专栏',github_repository:'GitHub Markdown 仓库'};
const modes={standard_preprocess:'标准流程，自动入库',original_text:'提取原文，自动入库',reports:'日报 / 周报与阅读操作'};
const states={queued:'排队中',pending:'待处理',processing:'处理中',running:'运行中',waiting_source:'等待来源',blocked:'处理受阻',source_blocked:'来源受限',verification_failed:'待重新核验',retry_wait:'等待下个周期重试',completed:'完成',completed_with_issues:'完成，部分待处理',failed:'失败',route_conflict:'需要选择模式',awaiting_review:'等待勾选',imported:'已入库',imported_with_warnings:'已入库，有提示'};
let current=null,editing=null,refreshing=false;
const jobNames={rss:'RSS 检查',bilibili:'B 站检查',zhihu:'知乎检查',daily:'日报',weekly:'周报',decisions:'勾选处理',retry:'堵塞项重试',video_import:'视频图文导入'};
const stepNames={scan:'检查来源',previews:'处理材料',decisions:'处理勾选',report:'生成报告',activity:'写入入库动态',
  'apply-source-scopes':'应用接收范围','retry-rss':'重试 RSS','retry-bilibili':'重试 B 站','retry-zhihu':'重试知乎','retry-selections':'重试勾选项',
  prepare_visual_jobs:'整理板书证据',extract_and_independently_review:'板书校订与独立审阅',compile_source_evidence:'核对来源证据',supplement_board_evidence:'补充板书证据',
  review_generated_diagrams:'核对图示',admit_reviewed_source:'准入已核验的校订',generate_body_and_guide:'生成正文与导读',verify_publication:'验收图文产物',board_blocked:'来源证据需要补充'};
const trackedRuns=new Map();
const sourceGroupOpen=new Map();
function element(tag,text,cls){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(cls)node.className=cls;return node;}
function readableError(value){const text=String(value||'');if(/paid_subscribers/u.test(text))return '来源正文需要付费订阅，现有访问条件只能取得摘要。';if(/platform_subtitles_not_yet_available/u.test(text))return '平台尚未提供字幕，下个周期会再次检查。';if(/target_login_snapshot_unavailable/u.test(text))return '当前来源的登录快照不可用，等待浏览器登录状态同步后重试。';if(/zhihu_http_403/u.test(text))return '知乎接口拒绝访问（403），当前未取得可用正文。';return text;}
async function api(url,body){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),20000);
  try {
    const response=await fetch(url,{...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:controller.signal});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'本地服务请求失败');
    return data;
  } catch(error) {
    if(error.name==='AbortError')throw new Error('本地服务响应超时，请刷新状态确认处理结果。');
    throw error;
  } finally {clearTimeout(timeout);}
}
function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'success';}
async function busy(button,action){const before=button.textContent;button.disabled=true;button.setAttribute('aria-busy','true');button.textContent='正在处理…';try{await action();}catch(error){message(error.message,true);}finally{button.disabled=false;button.removeAttribute('aria-busy');button.textContent=before;}}
function button(text,action,cls='secondary'){const node=element('button',text,cls);node.type='button';node.onclick=()=>busy(node,action);return node;}
function modeHelp(){const kind=$('kind').value,video=kind.startsWith('bilibili_'),repository=kind==='github_repository';const option=[...$('mode').options].find(o=>o.value==='original_text');option.disabled=video;if(video&&$('mode').value==='original_text')$('mode').value='reports';
  document.querySelectorAll('[data-repository-setting]').forEach(node=>node.hidden=!repository);
  for(const item of $('mode').options)if(item.value!=='original_text')item.disabled=repository;
  if(repository){$('mode').value='original_text';$('history_mode').value='all';}
  for(const item of $('history_mode').options)item.disabled=repository&&item.value!=='all';
  document.querySelectorAll('[data-text-setting]').forEach(node=>node.hidden=video||$('mode').value!=='reports');
  $('url-hint').textContent=repository?'填写公开 GitHub 仓库地址。每天随 RSS 检查新增文章，保留原目录和现有正文。':kind==='rss'?'填写 RSS 或 Atom 订阅地址。':kind==='bilibili_collection'?'填写合集内任意视频链接；首次检查只建立基线。':kind==='bilibili_video'?'填写视频链接；跟踪此视频以后新增的 P。':kind==='zhihu_author'?'填写作者主页，跟踪作者自己的新回答与文章。':'填写专栏主页，跟踪以后新增的文章。';
  $('mode-hint').textContent=$('mode').value==='original_text'?'提取正文并转换为 Markdown，不调用模型。':$('mode').value==='reports'?(video?'先用完整字幕生成预览卡，勾选后再生成图文正文与导读。':$('direct_reading').value==='true'?'长文获取后翻译进入阅读区，日报周报提供移出、稍后读和生成导读卡。短文继续追加到周报正文。':'长文先在日报周报勾选后入库。短文处理完成后追加到当周周报。'):(video?'新增内容自动走现有图文视频流程。':'新增内容自动进入标准预处理流程。');}
function scopeHelp(){
  const mode=$('history_mode').value, since=mode==='since';
  $('earliest-field').hidden=!since;
  $('earliest_date').required=since;
  $('earliest_date').disabled=!since;
  $('scope-hint').textContent=since?'从所选日期的北京时间 00:00 起补收。有明确发布时间的条目才会参与日期筛选。'
    :mode==='all'?($('kind').value==='github_repository'?'接收仓库完整目录。已有正文和批注保持原样。':'接收平台可列出的全部条目，并复用已保留的 RSS 内容。')
    :$('kind').value==='rss'?'沿用现有 RSS 范围。':'沿用现有基线，只接收之后出现的条目。';
}
function edit(source=null){editing=source;$('editor').hidden=false;$('editor-title').textContent=source?'编辑订阅':'添加订阅';for(const key of ['name','url','kind','mode','destination','history_mode','earliest_date','direct_reading','translation_mode','generate_guide'])$(key).value=source?.[key]??({kind:'rss',mode:'reports',destination:'RSS',history_mode:'default',direct_reading:source?false:true,translation_mode:'terminology',generate_guide:false}[key]??'');$('enabled').checked=source?.enabled??true;$('kind').disabled=Boolean(source);$('url').disabled=Boolean(source);$('form-error').textContent='';
  $('repository-branch').value=source?.repository?.branch||'main';$('repository-root').value=source?.repository?.content_root??'src';$('repository-site').value=source?.repository?.public_base||'';
  modeHelp();scopeHelp();$('name').focus();}
function runStatus(id,text,state=''){
  const field=$(id);
  field.hidden=false;
  field.className='run-status hint'+(state?' '+state:'');
  field.textContent=text;
}
function showJob(id,job){
  const status=states[job.status]||job.status;
  const reason=job.error||job.result?.faults?.[0]?.error||job.result?.faults?.[0]?.reason;
  const step=stepNames[job.current_step]||(/^video-P\d+$/u.test(job.current_step||'')?'处理 '+job.current_step.slice(6):undefined);
  runStatus(id,`${jobNames[job.kind]} · ${status}${step?' · '+step:''}${reason?'。'+readableError(reason):''}`,
    job.status==='failed'||job.status==='completed_with_issues'?'error':job.status==='completed'?'success':'');
}
async function submitRun(kind,id){
  runStatus(id,`${jobNames[kind]} · 正在提交…`);
  trackedRuns.delete(id);
  try {
    const job=await api('/api/subscriptions/run',{kind});
    trackedRuns.set(id,job.id);
    showJob(id,{...job,kind});
    if(id==='retry-run-status')$('job-history').open=true;
    await refresh();
  } catch(error) {runStatus(id,error.message,'error');}
}
async function retryVideo(job){
  const id='retry-run-status';
  runStatus(id,'视频图文导入 · 正在提交…');
  const queued=await api('/api/subscriptions/import-video',{...job.request,retry:true});
  trackedRuns.set(id,queued.id);showJob(id,{...queued,kind:'video_import'});
  await refresh();
}
function render(data){current=data;if(!data.initialized){$('health').textContent='订阅尚未初始化。';return;}
  $('open-exceptions').hidden=!data.exception_path;
  const heartbeat=data.heartbeat,late=heartbeat&&Date.now()-Date.parse(heartbeat.at)>90000;
  $('zhihu-validation').hidden=!['blocked','partial'].includes(data.zhihu_validation?.status);
  const columnReady=data.zhihu_validation?.checks?.some(check=>check.name==='column'&&check.status==='passed');
  $('zhihu-validation').textContent=columnReady?'知乎专栏采集已通过登录态验证；作者列表接口仍受限。单篇正文继续复用浏览器登录态。':'知乎部分采集接口仍受限；单篇正文继续复用浏览器登录态，并按实际获取结果判断。';
  $('health').className='notice'+(late||heartbeat?.status==='error'?' error':'');$('health').textContent=!data.enabled?'订阅流程已暂停。':late?'后台心跳已超过 90 秒，保存的配置仍然保留。':heartbeat?.status==='error'?'后台检查遇到问题：'+heartbeat.error:'订阅流程已启用。保存后的勾选会自动入队；正文与批注保留在原位置。';
  document.querySelectorAll('[data-source-group]').forEach(group=>sourceGroupOpen.set(group.dataset.sourceGroup,group.open));
  const sources=$('sources'),disabledSources=$('disabled-sources'),groups=new Map();
  sources.replaceChildren();disabledSources.replaceChildren();
  const disabledCount=data.subscriptions.filter(source=>!source.enabled).length;
  $('disabled-count').textContent=`${disabledCount} 项`;
  if(!data.subscriptions.some(source=>source.enabled))sources.append(element('p','暂无启用的订阅。','empty'));
  if(!disabledCount)disabledSources.append(element('p','暂无已停用的订阅。','empty'));
  for(const enabled of [true,false])for(const [kind,label] of Object.entries(kinds)){
    const members=data.subscriptions.filter(source=>source.enabled===enabled&&source.kind===kind);
    if(!members.length)continue;
    const key=`${enabled?'enabled':'disabled'}:${kind}`,group=element('details',undefined,'source-group'),summary=element('summary');
    group.dataset.sourceGroup=key;group.open=sourceGroupOpen.get(key)??true;
    summary.append(element('span',label),element('span',`${members.length} 项`,'hint group-count'));
    const list=element('div',undefined,'source-group-items');group.append(summary,list);
    (enabled?sources:disabledSources).append(group);groups.set(key,list);
  }
  for(const source of data.subscriptions){
    const row=element('article',undefined,'source'),info=element('div');
    row.dataset.sourceId=source.id;
    info.append(element('h3',source.name));
    const meta=element('p');
    meta.append(element('span',source.enabled?'已启用':'已停用',source.enabled?'success':'paused'));
    info.append(meta);
    const link=element('a',source.url);
    link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';info.append(link);
    const mode=element('div',undefined,'source-mode');
    mode.append(element('p',modes[source.mode]),element('p','阅读区 / '+source.destination,'hint'));
    if(source.mode==='reports'&&!source.kind.startsWith('bilibili_')){
      const settings=[source.direct_reading?'直接进入阅读区':'先勾选入库',source.translation_mode==='plain'?'普通简体翻译':'保留术语翻译',source.generate_guide?'默认生成导读卡':'默认无导读卡'];
      mode.append(element('p',settings.join(' · '),'hint'));
    }
    const actions=element('div',undefined,'source-actions');
    actions.append(button('编辑',async()=>edit(source)),button(source.enabled?'停用':'启用',async()=>{
      await api('/api/subscriptions/source',{revision:current.revision,source:{id:source.id,enabled:!source.enabled}});
      if(editing?.id===source.id){$('editor').hidden=true;editing=null;}
      message(source.enabled?'订阅已移至“已停用的订阅”。':'订阅已启用。');await refresh();
      if(source.enabled)$('disabled-subscriptions').querySelector('summary').focus();
    }));
    if(!source.enabled)actions.append(button('删除',async()=>{
      await api('/api/subscriptions/source/delete',{revision:current.revision,id:source.id});
      if(editing?.id===source.id){$('editor').hidden=true;editing=null;}
      message('订阅已删除。');await refresh();$('disabled-subscriptions').querySelector('summary').focus();
    },'secondary danger'));
    row.append(info,mode,actions);groups.get(`${source.enabled?'enabled':'disabled'}:${source.kind}`).append(row);
  }
  $('schedule').replaceChildren();for(const [label,time] of [['RSS',data.schedule.rss],['知乎',data.schedule.zhihu],['B 站',data.schedule.bilibili],['日报',data.schedule.daily],['短文周报','逐篇追加'],['长文周报','周日 '+data.schedule.weekly]])$('schedule').append(element('dt',label),element('dd',time));
  $('conflict-section').hidden=!data.conflicts.length;$('conflicts').replaceChildren();for(const item of data.conflicts){const row=element('div',undefined,'queue-row');row.append(element('h3',item.title));const actions=element('div',undefined,'actions');for(const [mode,label] of [['standard_preprocess','用标准流程'],['original_text','只提取原文']])actions.append(button(label,async()=>{await api('/api/subscriptions/resolve',{id:item.id,mode});message('处理方式已确定，材料重新入队。');await refresh();}));row.append(actions);$('conflicts').append(row);}
  $('report-list').replaceChildren();for(const file of data.reports){const row=element('li',undefined,'report-row');row.append(element('span',file.split(/[\\/]/).at(-1)),button('编辑',async()=>{await api('/api/subscriptions/open-report',{path:file});message('已打开报告原文件。勾选后请保存。');}));$('report-list').append(row);}if(!data.reports.length)$('report-list').append(element('li','尚未生成报告。','empty'));
  const items=[...data.pending,...data.failures,...Object.entries(data.zhihu_sources).filter(([id,s])=>s.error&&data.subscriptions.some(source=>source.id===id&&source.enabled)).map(([id,s])=>({title:data.subscriptions.find(x=>x.id===id).name,status:'blocked',error:s.error}))];
  $('queue-summary').textContent=`${items.length} 项待处理或需要关注；${data.pending_job_count??data.jobs.filter(j=>['running','queued'].includes(j.status)).length} 个任务正在运行或排队。`;$('queue').replaceChildren();for(const item of items){const row=element('div',undefined,'queue-row');row.append(element('h3',item.title||'订阅任务'),element('p',states[item.status]||item.status,'hint'));if(item.error)row.append(element('p',readableError(item.error),'error'));$('queue').append(row);}if(!items.length)$('queue').append(element('p','当前没有堵塞项。','empty'));
  $('jobs').replaceChildren();for(const job of data.jobs){
    const row=element('li',`${jobNames[job.kind]} · ${states[job.status]||job.status} · ${new Date(job.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`);
    if(job.error)row.append(element('p',job.error,'error'));
    if(job.kind==='video_import'){
      row.append(element('p','分 P：'+job.request.parts.join('、'),'hint'));
      if(job.status==='running'&&job.progress)row.append(element('p',`P${job.progress.part} · ${stepNames[job.progress.stage]||'处理中'}`,'hint'));
      for(const item of job.result?.results||[])row.append(element('p',`P${item.part} ${item.title} · ${states[item.status]||item.status}${item.reason?'：'+readableError(item.reason):''}`,item.status==='completed'?'hint':'error'));
    }
    if(['failed','blocked','completed_with_issues'].includes(job.status)){
      const actions=element('div',undefined,'actions');
      actions.append(button('重试此任务',()=>job.kind==='video_import'?retryVideo(job):submitRun(job.kind,'retry-run-status')));
      row.append(actions);
    }
    $('jobs').append(row);
  }
  for(const [id,jobId] of trackedRuns){
    const job=data.jobs.find(entry=>entry.id===jobId);
    if(!job)continue;
    showJob(id,job);
    if(!['queued','running'].includes(job.status))trackedRuns.delete(id);
  }
}
async function refresh(){if(refreshing)return;refreshing=true;try{render(await api('/api/subscriptions'));}catch(error){$('health').textContent='无法连接本地订阅服务：'+error.message;$('health').className='notice error';for(const id of trackedRuns.keys())runStatus(id,'暂时无法查询任务状态。'+error.message,'error');}finally{refreshing=false;}}
$('add').onclick=()=>edit();$('cancel').onclick=()=>{$('editor').hidden=true;editing=null;$('add').focus();};$('kind').onchange=()=>{if(!editing)$('destination').value=$('kind').value==='rss'?'RSS':$('kind').value==='github_repository'?'订阅/GitHub仓库':$('kind').value.startsWith('bilibili_')?'视频':'知乎';modeHelp();scopeHelp();};$('mode').onchange=modeHelp;
$('history_mode').onchange=scopeHelp;
$('direct_reading').onchange=modeHelp;
$('open-exceptions').onclick=()=>busy($('open-exceptions'),()=>api('/api/subscriptions/open-report',{path:current.exception_path}));
$('source-form').onsubmit=event=>{event.preventDefault();void busy($('save'),async()=>{const source={...(editing?{id:editing.id}:{}),name:$('name').value,kind:$('kind').value,url:$('url').value,mode:$('mode').value,destination:$('destination').value,enabled:$('enabled').checked,history_mode:$('history_mode').value,earliest_date:$('earliest_date').value,direct_reading:$('direct_reading').value==='true',translation_mode:$('translation_mode').value,generate_guide:$('generate_guide').value==='true'};
  if(source.kind==='github_repository')source.repository={url:source.url,branch:$('repository-branch').value,content_root:$('repository-root').value,public_base:$('repository-site').value||undefined};
  try{await api('/api/subscriptions/source',{revision:current.revision,source});$('editor').hidden=true;editing=null;message('订阅已保存。下一次来源检查时生效。');await refresh();$('add').focus();}catch(error){$('form-error').textContent=error.message;throw error;}});};
document.querySelectorAll('[data-run]').forEach(node=>{
  const kind=node.dataset.run;
  const id=kind==='retry'?'retry-run-status':['daily','weekly'].includes(kind)?'report-run-status':'source-run-status';
  node.onclick=()=>busy(node,()=>submitRun(kind,id));
});
$('refresh').onclick=()=>busy($('refresh'),refresh);
modeHelp();
scopeHelp();
await refresh();
let lastPoll=Date.now();
setInterval(()=>{
  if(document.hidden || (!trackedRuns.size && (editing || Date.now()-lastPoll<15000)))return;
  lastPoll=Date.now();
  void refresh();
},2000);
