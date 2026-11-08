const sec=t=>String(t).split(':').reduce((sum,n)=>sum*60+Number(n),0);
const stamp=n=>[Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(v=>String(v).padStart(2,'0')).join(':');
// Sparse article illustrations are insufficient evidence for correcting an
// entire mathematics transcript. Supplement long uncovered mathematical spans;
// these frames are evidence candidates, never automatically accepted media.
export function extendBoardEvidencePlan(plan,transcript){
  const effective=structuredClone(plan),added=[];
  const times=effective.items.filter(i=>i.kind==='screenshot').map(i=>sec(i.time));
  const math=/等于|大于|小于|分之|平方|根号|原理|定理|不等式|取等|习题|题目|证明|换元|齐次|韦达/u;
  for(const [index,s] of transcript.segments.entries()){
    const time=sec(s.start);
    if(!math.test(s.text)||s.text.length<4||times.some(t=>Math.abs(t-time)<=180)||time+12>=Number(transcript.duration))continue;
    const item={kind:'screenshot',scene:'static',time:stamp(time),window_end:stamp(time+12),title:'板书校订参考',
      expected_visual:'核对该时刻实际可见的板书公式和题目；未写完或不可见时如实记录，不能猜测。',
      source_segment_index:index,source_quote:s.text,purpose:'board_evidence'};
    effective.items.push(item);times.push(time);added.push({time:item.time,source_segment_index:index});
  }
  effective.items.sort((a,b)=>sec(a.time)-sec(b.time));
  return {plan:effective,receipt:{version:'mathematical-evidence-coverage/v1',added,body_acceptance_implied:false,raw_plan_modified:false}};
}
