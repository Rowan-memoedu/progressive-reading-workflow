"""Use AudioWorkflow's unmodified prompt and single-call implementation."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


def sha(data):
    return hashlib.sha256(data).hexdigest()


def exact(path, data):
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f'frozen_input_changed:{path.name}')
    else:
        path.write_bytes(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--audio-project', type=Path, default=Path('D:/Projects/AudioWorkflow'))
    parser.add_argument('--audio-config', type=Path, default=Path('D:/AppData/AudioWorkflow/config.json'))
    parser.add_argument('--max-output-tokens', type=int, default=65536)
    args = parser.parse_args()
    target = args.output.resolve()
    target.mkdir(parents=True, exist_ok=True)
    prompt_path = args.audio_project / 'prompts/refine.md'
    module_path = args.audio_project / 'audio_workflow.py'
    prompt_bytes, input_bytes = prompt_path.read_bytes(), args.input.read_bytes()
    prompt, transcript = prompt_bytes.decode('utf-8'), input_bytes.decode('utf-8')
    if not transcript.strip():
        raise ValueError('empty_transcript')
    exact(target / 'prompt.md', prompt_bytes)
    spec = importlib.util.spec_from_file_location('existing_audio_workflow', module_path)
    audio = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audio)
    cfg = audio.read_json(args.audio_config)
    cfg.update(ds_thinking_disabled=True, ds_max_output_tokens=args.max_output_tokens)
    ai = audio.AI(cfg)
    identity = {'mode':'audio-workflow-single-pass/v1', 'prompt_path':str(prompt_path),
                'prompt_sha256':sha(prompt_bytes), 'audio_code_sha256':sha(module_path.read_bytes()),
                'input_sha256':sha(input_bytes), 'input_characters':len(transcript),
                'model':ai.model, 'thinking':'disabled', 'max_output_tokens':args.max_output_tokens,
                'format_preference':'', 'automatic_regeneration':False}
    exact(target / 'input-identity.json', (json.dumps(identity, ensure_ascii=False, indent=2)+'\n').encode())
    response_path = target / 'attempt-1.response.json'
    # A timeout or interrupted request must not silently cause another generation.
    sent = target / 'request-sent.json'
    if sent.exists() and not response_path.exists():
        raise ValueError('previous_request_has_no_saved_response; automatic_retry_disabled')
    replay = response_path.exists()
    if not replay:
        exact(sent, b'{"requests_sent":1}\n')
    outline = ai.outline_call(prompt, transcript, target, '') + '\n'
    if prompt_path.read_bytes() != prompt_bytes:
        raise ValueError('canonical_prompt_changed_during_call')
    exact(target / 'outline.md', outline.encode())
    raw = audio.read_json(response_path)
    receipt = {**identity, 'status':'completed', 'api_calls_total':1, 'api_calls_this_run':0 if replay else 1,
               'finish_reason':raw['choices'][0].get('finish_reason'), 'response_sha256':sha(response_path.read_bytes()),
               'outline_sha256':sha(outline.encode()), 'usage':raw.get('usage',{}),
               'source_lineage':'complete_transcript_to_single_outline; no_paragraph_mapping_claim'}
    audio.write_json(target / 'refinement-receipt.json', receipt)
    print(json.dumps({'status':'completed','api_calls_this_run':receipt['api_calls_this_run'],
                      'finish_reason':receipt['finish_reason'],'outline_characters':len(outline)},ensure_ascii=False))


if __name__ == '__main__':
    main()
