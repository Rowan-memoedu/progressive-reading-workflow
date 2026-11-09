// Compile model-selected semantic scenes into bounded capture requests. This
// only narrows declared windows; it cannot invent a scene or admit an image.
import {normalizeMermaidSource} from './mermaid-source.mjs';
const seconds=value=>String(value).split(':').reduce((sum,n)=>sum*60+Number(n),0);
const valid=value=>typeof value==='string'&&/^\d{2}:[0-5]\d:[0-5]\d$/u.test(value);
const validSubtitle=value=>typeof value==='string'&&/^\d{2,}:[0-5]\d:[0-5]\d(?:\.\d+)?$/u.test(value);
const stamp=value=>[Math.floor(value/3600),Math.floor(value/60)%60,value%60].map(n=>String(n).padStart(2,'0')).join(':');
export function compileMediaSchedule(plan,transcript){
  const effective=structuredClone(plan),changes=[];
  if(!Array.isArray(effective.items))throw Error('invalid_media_items');
  effective.items.forEach((item,index)=>{
    if(item.kind==='mermaid'){
      const code=String(item.code||'');
      if(/<\/?[a-z][\w:-]*(?:\s+[^<>\n]*)?\/?>/iu.test(code))throw Error('unsafe_mermaid_html');
      // Mermaid's numeric entity renders the same mathematical less-than sign
      // inside a quoted label, without introducing an HTML token into the graph.
      item.code=normalizeMermaidSource(code);
      if(item.code!==code)changes.push({index,method:'mermaid_quoted_label_entity',before_sha_text:code,after_sha_text:item.code});
      return;
    }
    if(item.kind!=='screenshot')return;
    if(!valid(item.time)||!valid(item.window_end))throw Error('invalid_capture_window');
    const before={time:item.time,window_end:item.window_end};
    let start=seconds(item.time),end=seconds(item.window_end);
    if(end<start||start>=Number(transcript.duration))throw Error('invalid_capture_window');
    if(item.scene==='demonstration'){
      const matches=transcript.segments.filter(s=>s.start===item.result_start&&String(item.result_quote||'').length>=4&&s.text.includes(item.result_quote));
      if(matches.length!==1||!validSubtitle(matches[0].end))throw Error('demonstration_result_not_exact_source');
      // Never expand a proposed scene to fetch a later unrelated frame.
      const completed=seconds(matches[0].end);
      if(start<completed){const next=Math.ceil(completed);if(next>end)throw Error('result_outside_declared_capture_window');start=next;}
    }
    end=Math.min(end,start+12,Math.ceil(Number(transcript.duration))-1);
    if(end<start)throw Error('invalid_capture_window');
    item.time=stamp(start);item.window_end=stamp(end);
    if(item.time!==before.time||item.window_end!==before.window_end)changes.push({index,before,after:{time:item.time,window_end:item.window_end},method:'subset_of_declared_scene_window'});
  });
  return {plan:effective,receipt:{version:'bounded-media-schedule/v1',changes,raw_plan_modified:false,scene_windows_expanded:false,visual_acceptance_required:true}};
}
