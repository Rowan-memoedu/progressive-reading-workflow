// Preserve attributed source variants as immutable literal source, never turn
// an inconsistent lecture into an invented corrected solution. Existing body
// transport protects fenced source spans and verifies exact restoration.
export function sourceConflictNotes(ledger,transcript){
  return (ledger.source_conflicts||[]).map(item=>{
    if(!item.captions?.length||!item.evidence?.length||!item.observed||!item.reason)throw Error('source_conflict_evidence_required');
    const quotes=item.captions.map(c=>{
      if(transcript.segments[c.segment_index]?.text!==c.before
          ||ledger.patches.some(p=>p.segment_index===c.segment_index))throw Error('source_conflict_was_modified');
      return `原字幕（${transcript.segments[c.segment_index].start}）：${c.before}`;
    });
    const literal=[...quotes,`同段画面：${item.observed}`,`两者关系：${item.reason}`].join('\n');
    const fence='`'.repeat(Math.max(3,...[...literal.matchAll(/`+/gu)].map(m=>m[0].length+1)));
    return {after_segment_index:item.captions[0].segment_index,
      text:`原视频此处的表述：\n${fence}text\n${literal}\n${fence}\n\n`};
  });
}
