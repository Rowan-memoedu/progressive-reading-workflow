const seconds=value=>String(value).split(':').reduce((total,part)=>total*60+Number(part),0);
const stamp=value=>[Math.floor(value/3600),Math.floor(value/60)%60,value%60].map(n=>String(n).padStart(2,'0')).join(':');
const valid=value=>typeof value==='string'&&/^\d{2}:[0-5]\d:[0-5]\d$/u.test(value);
const validSubtitle=value=>typeof value==='string'&&/^\d{2,}:[0-5]\d:[0-5]\d(?:\.\d+)?$/u.test(value);

export function screenshotTiming(item,transcript) {
  if(!['static','demonstration'].includes(item.scene)||!item.expected_visual?.trim())throw Error('screenshot_visual_evidence_required');
  const time=seconds(item.time);
  if(!valid(item.window_end)||seconds(item.window_end)<time||seconds(item.window_end)>=Number(transcript.duration)
    ||seconds(item.window_end)-time>12)throw Error('invalid_capture_window');
  let evidence=null;
  if(item.scene==='demonstration') {
    const quote=String(item.result_quote||'');
    if(!validSubtitle(item.result_start)||quote.length<4)throw Error('demonstration_completion_evidence_required');
    const matches=transcript.segments.filter(segment=>segment.start===item.result_start&&segment.text.includes(quote));
    if(matches.length!==1||!matches[0].end)throw Error('demonstration_result_not_exact_source');
    evidence=matches[0];
    if(time<seconds(evidence.end)||time-seconds(evidence.end)>6)throw Error('capture_before_result_or_outside_scene');
  }
  // Bounded alternatives are captured once. Selection changes no prose or image reference.
  const candidates=[...new Set(item.scene==='demonstration'?[0,2,4]:[0,seconds(item.window_end)-time])].map(offset=>time+offset)
    .filter(value=>value<=seconds(item.window_end)).map(stamp);
  return {file:'shot_'+item.time.replaceAll(':','_')+'.png',scene:item.scene,
    requested_time:item.time,window_end:item.window_end,candidates,expected_visual:item.expected_visual.trim(),
    completion_evidence:evidence?{start:evidence.start,end:evidence.end,text:evidence.text}:null};
}
