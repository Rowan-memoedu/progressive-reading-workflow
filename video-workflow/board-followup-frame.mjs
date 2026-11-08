const sec=t=>String(t).split(':').reduce((sum,n)=>sum*60+Number(n),0);
const stamp=n=>[Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(v=>String(v).padStart(2,'0')).join(':');
export function bindFollowupQuote(item,transcript){
 if(String(item.source_quote||'').length>=4)return item;
 const index=item.source_segment_index,segments=transcript.segments;
 if(!Number.isInteger(index)||segments[index]?.text!==item.source_quote)throw Error('followup_quote_not_exact_source');
 let first=index,last=index,quote=segments[index].text;
 while(quote.length<4&&first>0&&Math.abs(sec(segments[first-1].start)-sec(item.time))<=60){first--;quote=segments.slice(first,last+1).map(s=>s.text).join('');}
 while(quote.length<4&&last+1<segments.length&&Math.abs(sec(segments[last+1].start)-sec(item.time))<=60){last++;quote=segments.slice(first,last+1).map(s=>s.text).join('');}
 if(quote.length<4)throw Error('followup_source_context_too_short');
 return {...item,source_quote:quote,source_quote_segment_range:[first,last]};
}
export function boardFollowupFrame(transcript,choice,{timing='before_completion'}={}){
 const segment=transcript.segments[choice.segment_index];
 if(!Number.isInteger(choice.segment_index)||!segment?.end)throw Error('followup_source_index_invalid');
 const duration=Math.ceil(Number(transcript.duration)),completed=sec(segment.end);
 const start=timing==='before_completion'?Math.max(0,completed-12):Math.min(completed+2,duration-1);
 const end=timing==='before_completion'?Math.max(start,Math.min(completed-1,duration-1)):Math.min(start+12,duration-1);
 return bindFollowupQuote({kind:'screenshot',scene:'static',time:stamp(start),window_end:stamp(end),title:'补充板书',expected_visual:choice.expected_visual,
  source_segment_index:choice.segment_index,source_quote:segment.text,purpose:'board_followup',reason:choice.reason},transcript);
}
