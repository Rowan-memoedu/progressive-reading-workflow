"""Validate an actual-image review before admitting captured frames to publication."""
import hashlib
import json
from pathlib import Path
import re
import math


def sha(data):
    return hashlib.sha256(data).hexdigest()


def exact(file, data):
    file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with file.open('xb') as target:
            target.write(data)
    except FileExistsError:
        if file.read_bytes() != data:
            raise ValueError('frozen_frame_changed:' + file.name)


def extend_unreviewed_request(file, request):
    data=(json.dumps(request,ensure_ascii=False,indent=2)+'\n').encode()
    if not file.exists():
        exact(file,data)
        return
    old=file.read_bytes()
    if old==data:return
    if (file.parent/'frame-review.json').exists() or (file.parent/'frame-admission.json').exists():raise ValueError('capture_request_already_reviewed')
    previous=json.loads(old)
    for key in ('version','video_id','source_sha256'):
        if previous.get(key)!=request.get(key):raise ValueError('capture_request_identity_changed')
    if len(previous['frames'])!=len(request['frames']):raise ValueError('capture_request_identity_changed')
    for before,after in zip(previous['frames'],request['frames']):
        identity=lambda frame:{key:value for key,value in frame.items() if key!='candidates'}
        if identity(before)!=identity(after) or any(candidate not in after['candidates'] for candidate in before['candidates']):
            raise ValueError('capture_request_not_candidate_extension')
    exact(file.parent/'frozen-inputs'/('frame-review-request-'+sha(old)+'.json'),old)
    if file.read_bytes()!=old:raise ValueError('capture_request_changed_concurrently')
    file.write_bytes(data)


def admit_reviewed_frames(request_file, review_file, images_dir):
    request_bytes=request_file.read_bytes()
    request=json.loads(request_bytes)
    if not review_file.is_file():
        return {'status':'needs_frame_review','reason':'actual_image_review_missing'}
    review=json.loads(review_file.read_text('utf-8'))
    if review.get('version')!='video-frame-review/v1' or review.get('request_sha256')!=sha(request_bytes):
        raise ValueError('frame_review_source_mismatch')
    rows=review.get('frames',[])
    if len(rows)!=len(request['frames']) or len({row.get('file') for row in rows})!=len(rows):
        raise ValueError('frame_review_coverage_mismatch')
    if {row.get('file') for row in rows}!={frame['file'] for frame in request['frames']}:
        raise ValueError('frame_review_identity_mismatch')
    selected=[]
    for frame in request['frames']:
        row=next(row for row in rows if row['file']==frame['file'])
        if row.get('matches_expected') is not True:
            return {'status':'needs_frame_review','reason':'expected_visual_not_visible','file':frame['file']}
        if not isinstance(row.get('observed'),str) or len(row['observed'].strip())<4:
            raise ValueError('frame_review_observation_required')
        candidate=next((item for item in frame['candidates'] if item['time']==row.get('selected_time')),None)
        if not candidate or row.get('sha256')!=candidate['sha256']:
            raise ValueError('reviewed_frame_not_in_capture_window')
        seconds=lambda value:sum(float(part)*60**index for index,part in enumerate(reversed(value.split(':'))))
        actual=candidate.get('actual_seconds')
        if not isinstance(actual,(int,float)) or not seconds(frame['requested_time'])-0.1<=actual<=seconds(frame['window_end'])+0.1:
            raise ValueError('actual_frame_outside_capture_window')
        file=Path(candidate['path'])
        # The generated request is local audit data, never a model-supplied path.
        if not file.resolve().is_relative_to((request_file.parent/'frame-candidates').resolve()):
            raise ValueError('candidate_path_escape')
        data=file.read_bytes()
        if sha(data)!=candidate['sha256']:
            raise ValueError('reviewed_frame_changed')
        if not re.fullmatch(r'shot_\d{2}_\d{2}_\d{2}\.png',frame['file']):
            raise ValueError('frame_target_path_escape')
        selected.append((frame,candidate,row,data))
    # All reviews must pass before any final image is admitted.
    result=[]
    for frame,candidate,row,data in selected:
        exact(images_dir/frame['file'],data)
        result.append({'file':frame['file'],'requested_time':frame['requested_time'],
                       'selected_candidate_time':candidate['time'],'actual_capture_seconds':candidate['actual_seconds'],'sha256':candidate['sha256'],
                       'width':candidate['width'],'height':candidate['height'],'bytes':len(data),
                       'observed':row['observed']})
    return {'status':'passed','request_sha256':sha(request_bytes),'review_sha256':sha(review_file.read_bytes()),'frames':result}


def admit_captured_frames(request_file, images_dir):
    """Admit genuine timestamp captures; semantic alignment is informational only."""
    from PIL import Image, ImageStat
    request_bytes = request_file.read_bytes()
    request = json.loads(request_bytes)
    frames = request.get('frames', [])
    if request.get('version') != 'video-frame-review-request/v1' or not frames:
        raise ValueError('capture_request_required')
    if len({frame['file'] for frame in frames}) != len(frames):
        raise ValueError('capture_frame_identity_mismatch')
    seconds = lambda value: sum(float(part)*60**index for index, part in enumerate(reversed(value.split(':'))))
    selected = []
    for frame in frames:
        start, end = seconds(frame['requested_time']), seconds(frame['window_end'])
        bounded = [candidate for candidate in frame['candidates']
                   if isinstance(candidate.get('actual_seconds'), (int, float))
                   and math.isfinite(candidate['actual_seconds'])
                   and start-0.1 <= candidate['actual_seconds'] <= end+0.1]
        if not bounded:
            raise ValueError('actual_frame_outside_capture_window')
        candidate = min(bounded, key=lambda item: abs(item['actual_seconds']-start))
        file = Path(candidate['path'])
        if not file.resolve().is_relative_to((request_file.parent/'frame-candidates').resolve()):
            raise ValueError('candidate_path_escape')
        if not re.fullmatch(r'shot_\d{2}_\d{2}_\d{2}\.png', frame['file']):
            raise ValueError('frame_target_path_escape')
        data = file.read_bytes()
        if sha(data) != candidate['sha256']:
            raise ValueError('captured_frame_changed')
        recorded = json.loads(file.with_suffix('.capture.json').read_text('utf-8'))
        if recorded.get('sha256') != candidate['sha256'] or recorded.get('actual_seconds') != candidate['actual_seconds']:
            raise ValueError('capture_time_metadata_mismatch')
        with Image.open(file) as picture:
            picture.load()
            width, height = picture.size
            variance = sum(ImageStat.Stat(picture.convert('RGB')).var)
        if min(width, height) < 360 or variance < 10:
            raise ValueError('capture_frame_quality_failed')
        if (width, height) != (candidate['width'], candidate['height']):
            raise ValueError('capture_dimensions_mismatch')
        row = {'file':frame['file'], 'requested_time':frame['requested_time'],
               'selected_candidate_time':candidate['time'], 'actual_capture_seconds':candidate['actual_seconds'],
               'sha256':candidate['sha256'], 'width':width, 'height':height, 'bytes':len(data)}
        selected.append((row, data))
    # Validate the entire set before admitting any image.
    for row, data in selected:
        exact(images_dir/row['file'], data)
    return {'status':'passed', 'policy':'timestamp_integrity', 'request_sha256':sha(request_bytes),
            'semantic_alignment':'not_required', 'frames':[row for row, _ in selected]}
