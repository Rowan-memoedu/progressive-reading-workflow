"""Prepare visual formula-correction jobs from frozen subtitle/frame evidence.

This does not call a model, accept corrections, change subtitles or generate prose.
The resulting supervisor jobs require actual image content, not OCR alone.
"""
import argparse
import hashlib
import json
from pathlib import Path


def seconds(value):
    return sum(float(part) * 60 ** index for index, part in enumerate(reversed(value.split(':'))))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--transcript', type=Path, required=True)
    parser.add_argument('--frame-request', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ocr-root', type=Path)
    parser.add_argument('--group-size', type=int, default=6)
    args = parser.parse_args()
    if args.group_size < 1:
        raise ValueError('positive_board_group_size_required')
    transcript = json.loads(args.transcript.read_text('utf-8'))
    request = json.loads(args.frame_request.read_text('utf-8'))
    frames = request['frames']
    jobs = []
    for offset in range(0, len(frames), args.group_size):
        end = min(offset + args.group_size, len(frames))
        start_seconds = 0 if offset == 0 else seconds(frames[offset]['requested_time'])
        end_seconds = float(transcript['duration']) + 1 if end == len(frames) else seconds(frames[end]['requested_time'])
        indices = [i for i, s in enumerate(transcript['segments']) if start_seconds <= seconds(s['start']) < end_seconds]
        if not indices:
            continue
        pictures, evidence = [], []
        for index in range(max(0, offset-1), min(len(frames), end+1)):
            frame = frames[index]
            valid = [candidate for candidate in frame['candidates']
                     if seconds(frame['requested_time'])-.1 <= candidate['actual_seconds'] <= seconds(frame['window_end'])+.1]
            if not valid:
                raise ValueError('no_candidate_inside_actual_window:' + frame['file'])
            candidate = valid[-1]
            image = Path(candidate['path'])
            if hashlib.sha256(image.read_bytes()).hexdigest() != candidate['sha256']:
                raise ValueError('candidate_changed:' + str(image))
            ocr = list(args.ocr_root.rglob(image.stem + '-*.md')) if args.ocr_root else []
            evidence.append({'image_id': frame['file'], 'actual_time': candidate['time'],
                             'expected_visual_untrusted': frame['expected_visual'],
                             'ocr_auxiliary_untrusted': ocr[0].read_text('utf-8') if ocr else None})
            pictures.append({'path': str(image), 'detail': 'original'})
        segments = [{'segment_index': i, **transcript['segments'][i]} for i in range(max(0, indices[0]-8), min(len(transcript['segments']), indices[-1]+9))]
        payload = {'main_range': [indices[0], indices[-1]], 'images': evidence, 'segments': segments}
        jobs.append({'id': str(len(jobs)), 'requires_visual': True, 'images': pictures,
                     'input': json.dumps(payload, ensure_ascii=False)})
    args.output.mkdir(parents=True, exist_ok=True)
    for shard in range(2):
        target = args.output / f'jobs-{shard}.jsonl'
        data = ''.join(json.dumps(job, ensure_ascii=False) + '\n' for job in jobs[shard::2]).encode('utf-8')
        try:
            with target.open('xb') as handle:
                handle.write(data)
        except FileExistsError:
            if target.read_bytes() != data:
                raise ValueError('frozen_board_jobs_changed')
    print(json.dumps({'jobs': len(jobs), 'actual_image_inputs': sum(len(j['images']) for j in jobs)}))


if __name__ == '__main__':
    main()
