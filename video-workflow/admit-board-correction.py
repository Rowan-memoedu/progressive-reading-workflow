"""Admit existing reviewed frames for a derived board-corrected source package.

No browser, video fetch, screenshot capture or model call is performed.
"""
import argparse
import json
from pathlib import Path
from frame_review import admit_reviewed_frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--run', type=Path, required=True)
    args = parser.parse_args()
    result = admit_reviewed_frames(args.run/'frame-review-request.json', args.run/'frame-review.json', args.input/'images')
    if result['status'] != 'passed':
        raise ValueError('board_corrected_frames_not_admitted')
    receipt = {'status': 'completed', 'capture_engine': 'pinned_upstream_capture_frames',
               'browser': 'authenticated_chrome', 'headless': True, 'media_downloaded': False,
               'new_capture_calls': 0, 'frames': result['frames'], 'frame_review': result}
    (args.run/'capture-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2)+'\n', 'utf-8')
    print(json.dumps({'stage': 'board_frame_admission', 'status': 'passed', 'frames': len(result['frames']), 'new_capture_calls': 0}))


if __name__ == '__main__':
    main()
