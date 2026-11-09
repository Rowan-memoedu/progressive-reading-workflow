"""Independent reconstruction of raw captions -> accepted board-corrected source."""
import argparse
import copy
import hashlib
import json
from pathlib import Path


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def verify(source):
    ledger_file=source/'board-correction.json'
    ledger=json.loads(ledger_file.read_text('utf-8'))
    receipt=json.loads((source/'board-correction-receipt.json').read_text('utf-8'))
    original_file=Path(receipt['raw_input_dir'])/'transcript.json'
    original=json.loads(original_file.read_text('utf-8'))
    actual=json.loads((source/'transcript.json').read_text('utf-8'))
    assert ledger['accepted'] is True and not ledger['unresolved']
    assert digest(original_file)==digest(source/'transcript.original.json')==receipt['raw_transcript_sha256']==ledger['raw_transcript_sha256']
    assert digest(source/'transcript.json')==receipt['corrected_transcript_sha256']
    assert digest(ledger_file)==receipt['ledger_sha256']
    expected=copy.deepcopy(original)
    changed=set()
    for patch in ledger['patches']:
        index=patch['segment_index']
        assert index not in changed and original['segments'][index]['text']==patch['before']
        expected['segments'][index]['text']=patch['after']
        changed.add(index)
    terminology=[]
    for term in ledger.get('terminology_corrections',[]):
        indices=[]
        for index,segment in enumerate(expected['segments']):
            if term['before'] in segment['text']:
                segment['text']=segment['text'].replace(term['before'],term['after'])
                indices.append(index)
        terminology.append({'before':term['before'],'after':term['after'],'segment_indices':indices,'evidence':term['evidence']})
    assert terminology==receipt.get('terminology_applications',[])
    for note in ledger['formula_notes']:
        expected['segments'][note['after_segment_index']]['text']+='\n'+note['text']
    for item in ledger.get('source_conflicts',[]):
        import re
        quotes=[]
        for caption in item['captions']:
            index=caption['segment_index']
            assert original['segments'][index]['text']==caption['before'] and index not in changed
            quotes.append('原字幕（'+original['segments'][index]['start']+'）：'+caption['before'])
        literal='\n'.join(quotes+['同段画面：'+item['observed'],'两者关系：'+item['reason']])
        fence='`'*max([3]+[len(m.group())+1 for m in re.finditer(r'`+',literal)])
        note='原视频此处的表述：\n'+fence+'text\n'+literal+'\n'+fence+'\n\n'
        expected['segments'][item['captions'][0]['segment_index']]['text']+='\n'+note
    assert actual==expected, 'Unrecorded source edits or missing speech'
    assert [(s['start'],s['end']) for s in actual['segments']]==[(s['start'],s['end']) for s in original['segments']]
    raw_request=Path(receipt['raw_frame_request']) if receipt.get('raw_frame_request') else Path(receipt['run_dir']).parents[1]/'frame-review-request.json'
    assert digest(raw_request)==ledger['frame_request_sha256']
    request=json.loads(raw_request.read_text('utf-8'))
    assert len(ledger['frames'])==len(request['frames'])==receipt['reviewed_frames']
    used=[]
    for row in ledger['frames']:
        frame=next(f for f in request['frames'] if f['file']==row['file'])
        candidate=next(c for c in frame['candidates'] if c['time']==row['selected_time'])
        assert digest(Path(candidate['path']))==row['sha256']==candidate['sha256']
        if row['use']:used.append(row)
    assert len(used)==receipt['used_frames']
    frame_ids={r['file'] for r in ledger['frames']}
    for item in [*ledger['patches'],*ledger['formula_notes'],*ledger.get('terminology_corrections',[])]:
        assert item['evidence'] and all(value in frame_ids for value in item['evidence'])
    return {'status':'passed','raw_segments':len(original['segments']),'corrected_segments':len(actual['segments']),
            'patches':len(changed),'formula_notes':len(ledger['formula_notes']),'unrecorded_source_edits':0,
            'original_timestamps_unchanged':True,'raw_subtitles_preserved':True,'reviewed_frames':len(ledger['frames']),
            'used_frames':len(used),'ledger_sha256':digest(ledger_file)}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input',type=Path,required=True)
    parser.add_argument('--report',type=Path)
    args=parser.parse_args()
    result=verify(args.input)
    data=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if args.report:args.report.write_text(data,'utf-8')
    print(data)
