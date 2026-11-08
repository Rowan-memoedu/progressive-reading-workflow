import path from 'node:path';
import { publicationDateFromSeconds } from '../subscription-workflow/publication-time.mjs';

export function videoId(url){
  const parsed=new URL(url);
  if(!['www.bilibili.com','bilibili.com'].includes(parsed.hostname)||parsed.protocol!=='https:')throw Error('bilibili_video_url_required');
  const id=/^\/video\/(BV[0-9A-Za-z]{10})\/?$/u.exec(parsed.pathname)?.[1];
  if(!id)throw Error('bilibili_video_url_required');
  return id;
}
export const itemKey=(bvid,cid)=>`bilibili:${bvid}:${cid}`;
export const canonicalUrl=(bvid,part=1)=>`https://www.bilibili.com/video/${bvid}/`+(part>1?`?p=${part}`:'');
export function readableTitle(value){
  return String(value).replace(/\s+\[\d+-Raw[^\]]*\]\s*$/u,'').replace(/[<>:"/\\|?*\x00-\x1f]/gu,'－').trim().replace(/[. ]+$/u,'');
}
export function entryPublication(destination,item){
  let title=readableTitle(item.video_title);
  if(item.parts>1)title+=` · P${item.part} ${readableTitle(item.part_title)}`;
  if(!title)throw Error('missing_video_title');
  if(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(title))title='_'+title;
  const name=title+'（强结构化整理）';
  return path.join(destination,name,name+'.md');
}

export async function biliApi(endpoint,{fetchImpl=fetch}={}){
  const response=await fetchImpl('https://api.bilibili.com/'+endpoint,{headers:{'User-Agent':'Mozilla/5.0','Referer':'https://www.bilibili.com/'},signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error('bilibili_http_'+response.status);
  const value=await response.json();
  if(value.code!==0||!value.data)throw Error('bilibili_api_'+value.code);
  return value.data;
}

export async function discover(watch,{api=biliApi}={}){
  const seed=videoId(watch.url),first=await api('x/web-interface/view?bvid='+seed);
  const season=watch.collection===false ? null : first.ugc_season;
  if(watch.season_id!=null&&watch.season_id!==season?.id)throw Error('subscribed_collection_changed');
  let ids=[seed];
  if(season){
    const embedded=(season.sections||[]).flatMap(s=>s.episodes||[]).map(e=>e.bvid||e.arc?.bvid).filter(Boolean);
    if(season.ep_count>new Set(embedded).size){
      const collected=[];let total=Infinity;
      for(let page=1;collected.length<total&&page<=1000;page++){
        const data=await api(`x/polymer/web-space/seasons_archives_list?mid=${first.owner.mid}&season_id=${season.id}&page_num=${page}&page_size=30`);
        total=Number(data.page?.total);
        if(!Number.isSafeInteger(total)||total<1||!data.archives?.length)throw Error('collection_pagination_incomplete');
        collected.push(...data.archives.map(e=>e.bvid));
      }
      if(new Set(collected).size!==total)throw Error('collection_pagination_incomplete');
      ids=[seed,...collected];
    }else ids=[seed,...embedded];
  }
  const items=[];
  for(const bvid of new Set(ids)){
    if(!/^BV[0-9A-Za-z]{10}$/u.test(bvid))throw Error('invalid_collection_video_id');
    const view=bvid===seed?first:await api('x/web-interface/view?bvid='+bvid);
    if(view.bvid!==bvid||!view.pages?.length)throw Error('video_view_identity_mismatch');
    for(const page of view.pages){
      if(!Number.isSafeInteger(page.cid)||!Number.isSafeInteger(page.page)||page.page<1)throw Error('invalid_video_part_identity');
      const publishedAt = publicationDateFromSeconds(view.pubdate);
      items.push({key:itemKey(bvid,page.cid),bvid,cid:page.cid,part:page.page,parts:view.pages.length,
        video_title:view.title,part_title:page.part,duration:page.duration||view.duration,url:canonicalUrl(bvid,page.page),
        ...(publishedAt ? { published_at: publishedAt } : {})});
    }
  }
  if(new Set(items.map(i=>i.key)).size!==items.length)throw Error('duplicate_video_content_identity');
  return {season_id:season?.id??null,items};
}

export function observe(state,watch,items,{baseline=false,existing=new Map(),now=new Date().toISOString(),promoteBaseline=false}={}){
  const added=[];
  for(const item of items){
    if(state.entries[item.key]){
      const known=state.entries[item.key];
      known.published_at ??= item.published_at;
      known.watch_ids=[...new Set([...(known.watch_ids||[known.watch_id]),watch.id])];
      if(promoteBaseline&&known.status==='baseline'){
        const publication=existing.get(known.url);
        known.status=publication?'completed':'pending';
        known.publication=publication||null;
        known.publish_path=entryPublication(watch.destination,known);
        if(!publication)added.push(known);
      }
      continue;
    }
    const publication=existing.get(item.url);
    const record={...item,watch_id:watch.id,first_seen:now,
      status:publication?'completed':baseline?'baseline':'pending',publication:publication||null,
      publish_path:entryPublication(watch.destination,item)};
    state.entries[item.key]=record;
    if(record.status==='pending')added.push(record);
  }
  return added;
}

export async function processPending(state,{processItem,save,now=()=>new Date().toISOString(),retryCycle=null,eligible=()=>true}){
  const events=[];
  for(const item of Object.values(state.entries)){
    if(!eligible(item))continue;
    if(retryCycle&&item.attempt_cycle===retryCycle)continue;
    if(retryCycle&&['blocked','running'].includes(item.status)&&item.retry_cycle!==retryCycle){
      item.status='pending'; item.retry_cycle=retryCycle;
    }
    if(item.status==='running'){
      item.status='blocked';item.reason='previous_execution_interrupted_no_automatic_resend';await save();
      events.push({key:item.key,status:'blocked',reason:item.reason});continue;
    }
    if(!['pending','waiting_source'].includes(item.status))continue;
    item.status='running';item.started_at=now();if(retryCycle)item.attempt_cycle=retryCycle;await save();
    try{
      const result=await processItem(item);
      if(result.status==='waiting_source'){item.status='waiting_source';item.reason=result.reason;}
      else if(result.status==='awaiting_review'){item.status='awaiting_review';item.material_id=result.material_id;delete item.reason;}
      else if(result.status==='completed'&&result.publication){
        item.status='completed';item.publication=result.publication;delete item.reason;
        if(result.workflow)item.workflow=result.workflow;
        if(result.model)item.model=result.model;
        if(result.runDir)item.run_dir=result.runDir;
        if(result.media)item.media=result.media;
      }
      else throw Error('unverified_watch_processing_result');
      events.push({key:item.key,title:item.video_title,status:item.status,publication:item.publication,reason:item.reason});
    }catch(error){
      item.status='blocked';item.reason=String(error.message).split('\n')[0].slice(0,240);
      events.push({key:item.key,title:item.video_title,status:'blocked',reason:item.reason});
    }
    item.last_attempt=now();await save();
  }
  return events;
}

export async function resumePublishedItem(state,key,verify){
  const item=state.entries[key];
  if(!item||item.status!=='blocked')throw Error('resume_requires_blocked_item');
  await verify(item);
  item.status='pending';item.resume_mode='verification_only';
  item.resumed_at=new Date().toISOString();delete item.reason;
  return item;
}
