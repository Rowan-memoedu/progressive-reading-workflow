import json
from pathlib import Path
import random
import tempfile
import unittest
from PIL import Image
from frame_review import admit_captured_frames, extend_unreviewed_request, sha


class TimestampCaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='frame-admission-', dir='D:/Artifacts/ProgressiveReading')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        candidates = self.root/'frame-candidates'; candidates.mkdir()
        self.picture = candidates/'shot_00_00_20.png'
        Image.frombytes('RGB', (800, 600), random.Random(381).randbytes(800*600*3)).save(self.picture)
        self.candidate = {'time':'00:00:20','path':str(self.picture),'sha256':sha(self.picture.read_bytes()),
                          'width':800,'height':600,'actual_seconds':20.1}
        self.request = {'version':'video-frame-review-request/v1','frames':[{
            'file':'shot_00_00_20.png','requested_time':'00:00:20','window_end':'00:00:24',
            'expected_visual':'这是语义期望，不是图片完整性要求','candidates':[self.candidate]}]}
        self.request_file = self.root/'frame-review-request.json'
        self.save()

    def save(self):
        self.request_file.write_text(json.dumps(self.request), encoding='utf-8')
        self.picture.with_suffix('.capture.json').write_text(json.dumps({
            'sha256':self.candidate['sha256'],'actual_seconds':self.candidate['actual_seconds']}), encoding='utf-8')

    def admit(self):return admit_captured_frames(self.request_file, self.root/'images')

    def test_semantic_mismatch_and_absent_semantic_review_do_not_block(self):
        (self.root/'frame-review.json').write_text(json.dumps({'frames':[{'matches_expected':False}]}),encoding='utf-8')
        result = self.admit()
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['semantic_alignment'], 'not_required')
        self.assertEqual((self.root/'images/shot_00_00_20.png').read_bytes(), self.picture.read_bytes())
        self.assertEqual(self.admit(), result)

    def test_changed_pixels_and_capture_metadata_are_rejected(self):
        self.picture.with_suffix('.capture.json').write_text('{}',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'capture_time_metadata_mismatch'):self.admit()
        self.save(); self.picture.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'captured_frame_changed'):self.admit()

    def test_wrong_timestamp_is_rejected(self):
        self.candidate['actual_seconds'] = 27; self.save()
        with self.assertRaisesRegex(ValueError,'actual_frame_outside_capture_window'):self.admit()

    def test_blank_or_corrupt_image_is_rejected_even_with_matching_hash(self):
        Image.new('RGB',(800,600),'black').save(self.picture)
        self.candidate['sha256']=sha(self.picture.read_bytes());self.save()
        with self.assertRaisesRegex(ValueError,'capture_frame_quality_failed'):self.admit()
        self.picture.write_bytes(b'not a png');self.candidate['sha256']=sha(self.picture.read_bytes());self.save()
        with self.assertRaises(Exception):self.admit()

    def test_closest_timestamp_wins_even_if_a_later_frame_semantically_matches(self):
        later={**self.candidate,'time':'00:00:24','actual_seconds':24}
        self.request['frames'][0]['candidates'].insert(0,later);self.save()
        self.assertEqual(self.admit()['frames'][0]['selected_candidate_time'],'00:00:20')

    def test_admitted_capture_request_cannot_be_extended(self):
        (self.root/'frame-admission.json').write_text(json.dumps(self.admit()),encoding='utf-8')
        changed=json.loads(json.dumps(self.request));changed['frames'][0]['candidates'].append({**self.candidate,'time':'00:00:22'})
        with self.assertRaisesRegex(ValueError,'already_reviewed'):
            extend_unreviewed_request(self.request_file,changed)


if __name__=='__main__':unittest.main()
