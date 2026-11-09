"""Admit a compiled source ledger only after independent actual-image review."""
import argparse, hashlib, json, runpy
from pathlib import Path

def sha(data): return hashlib.sha256(data).hexdigest()

def admit(transcript_file, request_file, candidate_file, results):
    raw=transcript_file.read_bytes(); transcript=json.loads(raw)
    request_bytes=request_file.read_bytes(); request=json.loads(request_bytes)
    ledger=json.loads(candidate_file.read_text('utf-8'))
    rows=[json.loads(line) for file in results for line in file.read_text('utf-8').splitlines() if line.strip()]
    compiler=runpy.run_path(str(Path(__file__).with_name('assemble-board-ledger.py')))['compile_ledger']
    if compiler(transcript,raw,request,request_bytes,rows,True)!=ledger:
        raise ValueError('board_candidate_not_reproducible_from_review')
    if ledger.get('accepted') is not False or not ledger.get('independent_review_passed') or ledger.get('unresolved') or ledger.get('rejected_proposals'):
        raise ValueError('board_independent_source_review_not_passed')
    if ledger['raw_transcript_sha256']!=sha(raw) or ledger['frame_request_sha256']!=sha(request_bytes) or request['source_sha256']!=sha(raw):
        raise ValueError('board_admission_source_changed')
    if len(ledger['frames'])!=len(request['frames']) or not any(row['use'] for row in ledger['frames']):
        raise ValueError('board_admission_image_coverage_required')
    frames={row['file']:row for row in request['frames']}
    for row in ledger['frames']:
        frame=frames[row['file']]
        candidate=next(c for c in frame['candidates'] if c['time']==row['selected_time'] and c['sha256']==row['sha256'])
        if sha(Path(candidate['path']).read_bytes())!=row['sha256']:
            raise ValueError('board_admission_image_changed')
        if row['use'] and row['status']!='complete': raise ValueError('board_admission_incomplete_frame')
    for patch in ledger['patches']:
        if patch['before']!=transcript['segments'][patch['segment_index']]['text']:
            raise ValueError('board_admission_patch_not_exact')
    ledger['accepted']=True
    for frame in ledger['frames']: frame['review_method']='independent Codex Exec actual-image source review; deterministic admission'
    ledger['automated_admission']={'version':'board-source-admission/v1','candidate_sha256':sha(candidate_file.read_bytes()),
        'review_results':[{'path':str(file.resolve()),'sha256':sha(file.read_bytes())} for file in results]}
    return ledger

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--transcript',type=Path,required=True);p.add_argument('--frame-request',type=Path,required=True)
    p.add_argument('--candidate',type=Path,required=True);p.add_argument('--results',type=Path,nargs='+',required=True)
    p.add_argument('--output',type=Path,required=True);args=p.parse_args()
    ledger=admit(args.transcript,args.frame_request,args.candidate,args.results)
    data=(json.dumps(ledger,ensure_ascii=False,indent=2)+'\n').encode()
    try:
        with args.output.open('xb') as file:file.write(data)
    except FileExistsError:
        if args.output.read_bytes()!=data:raise ValueError('accepted_board_ledger_conflict')
    print(json.dumps({'stage':'automated_board_admission','status':'passed','frames':len(ledger['frames']),
        'patches':len(ledger['patches']),'formula_notes':len(ledger['formula_notes'])}),flush=True)

if __name__=='__main__':main()
