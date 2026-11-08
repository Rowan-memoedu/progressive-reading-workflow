"""Independently verify a reviewed multipart source and its published attachments."""
import argparse,hashlib,json,math
from pathlib import Path

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def seconds(t):return sum(float(v)*60**i for i,v in enumerate(reversed(t.split(':'))))
def verify(source,run):
    load=lambda p:json.loads(p.read_text('utf-8'))
    manifest=load(source/'collection-manifest.json');combined=load(source/'transcript.json')
    receipt=load(run/'video-receipt.json');published=Path(receipt['publication']['markdown']['path'])
    assert digest(published)==receipt['publication']['markdown']['sha256']
    assert manifest['body_calls_before_merge']==0 and receipt['refinement']['api_calls_total']==1
    assert combined['duration']==manifest['duration_seconds']
    index=0;offset=0;count=0;parts=[]
    for row in manifest['parts']:
        original=Path(row['input_dir']);part_run=Path(row['run_dir']);part=load(original/'transcript.json')
        assert digest(original/'transcript.json')==row['transcript_sha256']==digest(source/'parts'/f"p{row['part']}"/'transcript.json')
        assert row['offset_seconds']==offset and row['first_combined_segment']==index
        for local,s in enumerate(part['segments']):
            merged=combined['segments'][index]
            assert merged['text']==s['text'] and merged['source_part']==row['part'] and merged['source_segment_index']==local
            assert seconds(merged['start'])==seconds(s['start'])+offset and seconds(merged['end'])==seconds(s['end'])+offset
            index+=1
        assert row['last_combined_segment']==index-1
        offset+=math.ceil(part['duration'])
        capture=load(part_run/'capture-receipt.json');review=load(part_run/'frame-review.json')
        request=load(part_run/'frame-review-request.json')
        assert capture['frame_review']['status']=='passed'
        assert digest(part_run/'frame-review.json')==capture['frame_review']['review_sha256']==row['frame_review_sha256']
        assert digest(part_run/'frame-review-request.json')==review['request_sha256']==capture['frame_review']['request_sha256']
        assert request['source_sha256']==row['transcript_sha256']
        for image in [i for i in manifest['images'] if i['part']==row['part']]:
            captured=next(f for f in capture['frames'] if 'images/'+f['file']==image['original'])
            observed=next(f for f in review['frames'] if f['file']==captured['file'])
            target=next(a for a in receipt['publication']['assets'] if Path(a['source_path']).resolve()==(source/image['target']).resolve())
            assert observed['matches_expected'] is True and observed['sha256']==image['sha256']==captured['sha256']
            assert digest(original/image['original'])==digest(source/image['target'])==digest(Path(target['published_path']))==image['sha256']
            count+=1
        parts.append(row['part'])
    assert all(b==a+1 for a,b in zip(parts,parts[1:]))
    assert index==len(combined['segments'])==manifest['segments'] and offset==manifest['duration_seconds']
    assert count==len(manifest['images']) and len({i['target'] for i in manifest['images']})==count
    return {'status':'passed','parts':parts,'segments':index,'images_from_reviewed_frames':count,'part_source_text_and_time_mapping':'passed',
      'frame_content_review':'passed','single_combined_body_call':True,'published_markdown':str(published),'markdown_sha256':digest(published)}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,required=True);p.add_argument('--run',type=Path,required=True);p.add_argument('--report',type=Path,required=True);a=p.parse_args()
    result=verify(a.input,a.run);a.report.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n','utf-8');print(json.dumps(result,ensure_ascii=False))
