// Restore already available content headings by ordered exact text evidence.
// This is a local formatting repair; it never generates or rewrites prose.
const normalized = value => String(value).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu,'').toLowerCase();

export function restoreContentHeadings(reference, target) {
  const groups=[];
  for(const match of String(reference).matchAll(/^(#{2,3} [^\n]+)\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gmu)) {
    const text=normalized(match[2].replace(/^\^pr-[\w-]+\s*$/gmu,''));
    if(text.length>=40) groups.push({heading:match[1],text});
  }
  if(!groups.length) throw new Error('reference_content_headings_missing');
  const paragraphs=[...String(target).matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/gu)]
    .filter(match=>!/^\s*(?:#{1,6} |\^pr-)/u.test(match[0]))
    .map(match=>({offset:match.index,text:normalized(match[0])}));
  const placements=[];
  let after=-1;
  for(const group of groups) {
    const windows=new Set();
    // Requiring multiple long exact spans tolerates punctuation editing without
    // using semantic guesses, heading words or expected sample-specific answers.
    const opening=group.text.slice(0,240);
    for(let i=0;i+24<=opening.length;i+=12) windows.add(opening.slice(i,i+24));
    const hits=paragraphs.map((paragraph,index)=>({paragraph,index,evidence:[...windows].filter(span=>paragraph.text.includes(span))}))
      .filter(hit=>hit.index>after&&hit.evidence.length>=2)
      .sort((a,b)=>b.evidence.length-a.evidence.length||a.index-b.index);
    if(!hits.length) continue;
    if(hits[1]&&hits[0].evidence.length===hits[1].evidence.length) continue;
    const best=hits[0];
    placements.push({heading:group.heading,offset:best.paragraph.offset,matched_spans:best.evidence});
    after=best.index;
  }
  if(!placements.length) throw new Error('no_unambiguous_heading_alignment');
  let markdown=String(target);
  for(const item of [...placements].reverse()) markdown=markdown.slice(0,item.offset)+item.heading+'\n\n'+markdown.slice(item.offset);
  // Verify by removing only the inserted slices; all original characters survive.
  let restored=markdown;
  let shift=0;
  const inserted=[];
  for(const item of placements) {
    const text=item.heading+'\n\n';inserted.push({offset:item.offset+shift,text});shift+=text.length;
  }
  for(const item of inserted.reverse()) restored=restored.slice(0,item.offset)+restored.slice(item.offset+item.text.length);
  if(restored!==target) throw new Error('heading_repair_changed_prose');
  return {markdown,placements,version:'restore-content-headings/v1',prose_unchanged:true};
}
