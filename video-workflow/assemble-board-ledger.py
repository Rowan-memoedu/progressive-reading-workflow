"""Compile visual observations into a source ledger; never modify a body draft."""
import argparse,hashlib,json,re
from pathlib import Path

def sha(data):return hashlib.sha256(data).hexdigest()
def seconds(value):return sum(float(v)*60**i for i,v in enumerate(reversed(value.split(':'))))
def decode_visual_json(text):
    text=text.strip()
    if text.startswith('```'):text=re.sub(r'^```(?:json)?\s*|\s*```$','',text)
    # Lossless wire decoding only: single-backslash LaTeX is not valid JSON.
    # Preserve the saved response and all formula characters, including commands
    # such as \frac/\text which JSON would otherwise decode as control escapes.
    commands=r'frac|dfrac|tfrac|sqrt|geq?|leq?|sum|prod|left|right|cdot|times|lambda|dots|cdots|ldots|alpha|beta|gamma|begin|end|text|mathrm|mathbb|operatorname|qquad|quad|neq?|notin|infty|displaystyle|underbrace|overbrace|widehat|boxed|Delta'
    fixed=re.sub(r'(?<!\\)\\(?=(?:'+commands+r')(?![A-Za-z]))',r'\\\\',text)
    fixed=re.sub(r'(?<!\\)\\(?=[^"\\/bfnrtu])',r'\\\\',fixed)
    value=json.loads(fixed)
    changed=text!=fixed
    def normalize(item,key=None):
        nonlocal changed
        if isinstance(item,dict):return {k:normalize(v,k) for k,v in item.items()}
        if isinstance(item,list):return [normalize(v,key) for v in item]
        if not isinstance(item,str) or key=='before':return item
        def math_span(match):
            return re.sub(r'(?<!\\)\\\\(?=(?:'+commands+r'|Rightarrow|Leftrightarrow|Longleftrightarrow|Longrightarrow)(?![A-Za-z]))',r'\\',match.group())
        result=re.sub(r'(?<!\\)\$[^$\n]+\$',math_span,item)
        changed=changed or result!=item
        return result
    return normalize(value),changed

def bind_patch_source(patch, original):
    if patch['before']==original:return patch,False
    before=patch['before']
    if not isinstance(before,str) or len(before)<4 or original.count(before)!=1:
        raise ValueError('board_patch_not_exact_source:'+str(patch['segment_index']))
    # A quoted exact subspan is sufficient to apply a bounded source edit.
    # Preserve every unquoted prefix/suffix byte; do not fuzzy-match ASR text.
    start=original.index(before)
    return {**patch,'before':original,'after':original[:start]+patch['after']+original[start+len(before):]},True
def compile_ledger(transcript,raw_bytes,request,request_bytes,results,require_review=False):
    frames={f['file']:f for f in request['frames']};observations={};patches={};notes=[];unresolved=[];wire_repairs=[];out_of_scope=[];slice_projections=[];rejected=[]
    review_receipts=[];retained=[]
    for result in results:
        if result.get('provider')!='codex_exec' or result.get('image_count',0)<1:raise ValueError('board_visual_transport_required')
        value,repaired=decode_visual_json(result['output'])
        if require_review:
            review=value.get('review',{})
            if review.get('verdict') not in ('pass','needs_more_evidence','needs_revision') or not isinstance(review.get('issues'),list):
                raise ValueError('independent_board_review_required')
            review_receipts.append({'job':result['id'],**review})
            if review['verdict']!='pass' or review['issues']:
                unresolved.extend({'job':result['id'],'finding':issue} for issue in review['issues'] or ['独立来源审阅未通过'])
        if result['input'].get('visual_only') is True and value['patches']:raise ValueError('visual_only_source_stage_cannot_edit_captions')
        if repaired:wire_repairs.append({'job':result['id'],'method':'escape_literal_LaTeX_for_JSON','raw_response_modified':False})
        job=json.loads(result['input']['input']);low,high=job['main_range']
        for item in value.get('retained_uncertainties',[]):
            index=item.get('segment_index')
            if not isinstance(index,int) or not low<=index<=high or item.get('before')!=transcript['segments'][index]['text'] or item.get('kind')!='lexical_or_context_only' or not item.get('reason'):
                raise ValueError('retained_uncertainty_not_exact_source')
            if any(p.get('segment_index')==index for p in value['patches']):raise ValueError('retained_uncertainty_was_modified')
            retained.append({'job':result['id'],**item})
        for row in value['observations']:
            if row['image_id'] not in frames:raise ValueError('unknown_observed_image')
            index=min(range(len(transcript['segments'])),key=lambda i:abs(seconds(transcript['segments'][i]['start'])-seconds(frames[row['image_id']]['requested_time'])))
            owned=low<=index<=high
            if row['image_id'] not in observations or owned:observations[row['image_id']]=row
        for patch in value['patches']:
            index=patch['segment_index']
            if not low<=index<=high:
                out_of_scope.append({'job':result['id'],'kind':'patch','proposal':patch});continue
            try:patch,projected=bind_patch_source(patch,transcript['segments'][index]['text'])
            except ValueError as error:
                if not str(error).startswith('board_patch_not_exact_source:'):raise
                rejected.append({'job':result['id'],'kind':'patch','proposal':patch,'reason':'quoted_before_not_exact_source'})
                unresolved.append({'job':result['id'],'finding':'未应用第'+str(index)+'条候选：before不是原字幕的精确原句或唯一片段。'})
                continue
            if projected:slice_projections.append({'job':result['id'],'segment_index':index,'method':'exact_unique_subspan_with_original_prefix_suffix_retained'})
            if not patch['after'].strip() or any(e not in frames for e in patch['evidence']):raise ValueError('board_patch_invalid_evidence')
            if index in patches and patches[index]['after']!=patch['after']:raise ValueError('board_patch_conflict:'+str(index))
            patches[index]=patch
        for note in value['formula_notes']:
            if not low<=note['after_segment_index']<=high:
                out_of_scope.append({'job':result['id'],'kind':'formula_note','proposal':note});continue
            if any(e not in frames for e in note['evidence']):raise ValueError('board_note_invalid_evidence')
            if note not in notes:notes.append(note)
        unresolved.extend({'job':result['id'],'finding':finding} for finding in value['unresolved'])
    rows=[]
    for name,frame in frames.items():
        row=observations.get(name)
        if not row or row['status'] not in ('complete','partial','unusable') or len(row['observed'].strip())<4:raise ValueError('board_observation_missing:'+name)
        candidates=[c for c in frame['candidates'] if seconds(frame['requested_time'])-.1<=c['actual_seconds']<=seconds(frame['window_end'])+.1]
        candidate=candidates[-1]
        if sha(Path(candidate['path']).read_bytes())!=candidate['sha256']:raise ValueError('observed_image_changed')
        use=row['status']=='complete'
        record={'file':name,'selected_time':candidate['time'],'sha256':candidate['sha256'],'status':'complete' if use else 'partial',
                'observed_status':row['status'],'observed':row['observed'],'title':row['title'],'use':use,
                'review_method':'Codex Exec actual-image observations; supervisor review required'}
        if not use:record['omission_reason']='画面未完整显示题设或关键公式；原图保留在审计区。'
        rows.append(record)
    evidence_adjustments=[]
    for item in [*patches.values(),*notes]:
        index=item.get('segment_index',item.get('after_segment_index'))
        times={}
        for name in item['evidence']:
            row=next(r for r in rows if r['file']==name);frame=frames[name]
            candidate=next(c for c in frame['candidates'] if c['time']==row['selected_time'])
            times[name]=candidate['actual_seconds']
        if 'after_segment_index' in item:
            # A board transcription is new visual source material, rather than
            # a spoken caption edit. Anchor it to the closest actual source time
            # that satisfies every declared image's unchanged six-minute bound.
            lower=max(times.values())-360;upper=min(times.values())+360
            eligible=[i for i,s in enumerate(transcript['segments']) if lower<=seconds(s['start'])<=upper]
            if not eligible:rejected.append({'kind':'formula_note','proposal':item,'reason':'no_common_nearby_visual_anchor'});continue
            anchor=min(eligible,key=lambda i:abs(seconds(transcript['segments'][i]['start'])-seconds(transcript['segments'][index]['start'])))
            if anchor!=index:
                evidence_adjustments.append({'kind':'visual_note_anchor','before_index':index,'after_index':anchor,'evidence':item['evidence']})
                item['after_segment_index']=anchor
        else:
            nearby=[name for name,time in times.items() if abs(time-seconds(transcript['segments'][index]['start']))<=360]
            if not nearby:rejected.append({'kind':'patch','proposal':item,'reason':'no_declared_nearby_visual_evidence'});continue
            if nearby!=item['evidence']:
                evidence_adjustments.append({'kind':'distant_references_excluded','segment_index':index,'before':item['evidence'],'after':nearby})
                item['evidence']=nearby
        content=item.get('after',item.get('text',''))
        if re.search(r'[\x00-\x08\x0b-\x1f]',content):raise ValueError('invalid_formula_control_character')
    for row in rejected:
        if row['reason']=='quoted_before_not_exact_source':continue
        if row['kind']=='patch':patches.pop(row['proposal']['segment_index'],None)
        else:notes.remove(row['proposal'])
    return {'version':'video-board-correction/v1','accepted':False,'unresolved':unresolved,
      'raw_transcript_sha256':sha(raw_bytes),'frame_request_sha256':sha(request_bytes),'frames':rows,
      'patches':sorted(patches.values(),key=lambda p:p['segment_index']),'formula_notes':sorted(notes,key=lambda n:n['after_segment_index']),
      'terminology_corrections':[],'diagram_corrections':[],'no_correction_needed':not patches and not notes,
      'wire_syntax_repairs':wire_repairs,'out_of_scope_proposals':out_of_scope,'source_slice_projections':slice_projections,
      'visual_evidence_adjustments':evidence_adjustments,'rejected_proposals':rejected,
      'retained_uncertainties':retained,'independent_reviews':review_receipts,
      'independent_review_passed':bool(review_receipts) and all(r['verdict']=='pass' and not r['issues'] for r in review_receipts)}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--transcript',type=Path,required=True);p.add_argument('--frame-request',type=Path,required=True)
    p.add_argument('--results',type=Path,nargs='+',required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--require-review',action='store_true');args=p.parse_args()
    raw=args.transcript.read_bytes();request_bytes=args.frame_request.read_bytes()
    results=[json.loads(line) for file in args.results for line in file.read_text('utf-8').splitlines() if line.strip()]
    ledger=compile_ledger(json.loads(raw),raw,json.loads(request_bytes),request_bytes,results,args.require_review)
    args.output.write_text(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n','utf-8')
    print(json.dumps({'status':'source_evidence_compiled_for_review','frames':len(ledger['frames']),'used_frames':sum(r['use'] for r in ledger['frames']),
      'patches':len(ledger['patches']),'formula_notes':len(ledger['formula_notes']),'unresolved':ledger['unresolved']},ensure_ascii=False))
if __name__=='__main__':main()
