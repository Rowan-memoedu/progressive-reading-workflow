"""Recover a saved valid outline; defer only explicitly generated visuals to the merge stage."""
import argparse
import importlib.util
import json
from pathlib import Path
import re


def load(name, file):
    spec=importlib.util.spec_from_file_location(name,file)
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache',type=Path,required=True)
    parser.add_argument('--media',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    base=Path(__file__).parent
    body=load('existing_body_adapter',base.parent/'standard-preprocessing/refine-full-text.py')
    audio=load('existing_outline_validator',Path('D:/Projects/AudioWorkflow/audio_workflow.py'))
    spans=json.loads((args.cache/'protected-spans.json').read_text('utf-8'))
    generated=json.loads(args.media.read_text('utf-8'))
    allowed={item['literal'] for item in generated}
    if len(allowed)!=len(generated):
        raise ValueError('ambiguous_generated_media_literals')
    raw=json.loads((args.cache/'attempt-1.response.json').read_text('utf-8'))
    if raw['choices'][0].get('finish_reason')!='stop':
        raise ValueError('body_response_incomplete')
    output=raw['choices'][0]['message']['content'].strip()
    output,_=body.normalize_marker_lines(output,spans)
    output=audio.titled_outline(output)
    deferred={key:literal for key,literal in spans.items() if literal in allowed}
    if len(deferred)!=len(generated):
        raise ValueError('generated_media_not_exactly_bound_to_input')
    remaining={key:literal for key,literal in spans.items() if key not in deferred}
    for key in deferred:
        if output.count(key)>1:
            raise ValueError('duplicated_generated_media_marker')
        output=re.sub(r'(?m)^\s*-\s*'+re.escape(key)+r'\s*$', '', output)
        output=output.replace(key,'')
    # Native source formulas, code, links and media stay under the original strict gate.
    output=body.restore_source(output,remaining).rstrip()+'\n'
    if re.search(r'PRKEEP[0-9A-F]+N\d+END',output):
        raise ValueError('unknown_media_marker')
    if re.search(r'原话未完|原话截断|听辨待确认|听辨不明|原转写疑点|（疑点）|\(疑点\)',output):
        raise ValueError('outline_contains_prohibited_annotations')
    args.output.mkdir(parents=True,exist_ok=True)
    body.exact(args.output/'prose.md',output.encode())
    receipt={'status':'media_merge_required','deferred_media':len(deferred),'native_source_spans_preserved':len(remaining),
             'api_calls':0,'response_sha256':body.sha((args.cache/'attempt-1.response.json').read_bytes()),
             'prose_sha256':body.sha(output.encode()),'generated_media_sha256':body.sha(args.media.read_bytes())}
    (args.output/'prose-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n','utf-8')
    print(json.dumps(receipt),flush=True)


if __name__=='__main__':
    main()
