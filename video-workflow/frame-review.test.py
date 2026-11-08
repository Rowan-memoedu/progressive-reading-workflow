import json
from pathlib import Path
import tempfile
import unittest
from frame_review import admit_reviewed_frames, sha


class FrameReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='frame-review-')
        self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name)
        candidates=self.root/'frame-candidates';candidates.mkdir()
        early=candidates/'early.png';early.write_bytes(b'fixture before action')
        later=candidates/'later.png';later.write_bytes(b'fixture result visible')
        self.request={'version':'video-frame-review-request/v1','frames':[{
            'file':'shot_00_00_20.png','requested_time':'00:00:20','window_end':'00:00:24','expected_visual':'导出完成的表格',
            'candidates':[{'time':'00:00:20','path':str(early),'sha256':sha(early.read_bytes()),'width':800,'height':600,'actual_seconds':20},
                          {'time':'00:00:22','path':str(later),'sha256':sha(later.read_bytes()),'width':800,'height':600,'actual_seconds':22}]}]}
        self.request_file=self.root/'frame-review-request.json'
        self.request_file.write_text(json.dumps(self.request),encoding='utf-8')
        self.review_file=self.root/'frame-review.json'
        self.images=self.root/'source/images'

    def review(self,second=True,**patch):
        candidate=self.request['frames'][0]['candidates'][1 if second else 0]
        row={'file':'shot_00_00_20.png','selected_time':candidate['time'],'sha256':candidate['sha256'],
             'matches_expected':True,'observed':'表格已经显示导出完成。',**patch}
        report={'version':'video-frame-review/v1','request_sha256':sha(self.request_file.read_bytes()),'frames':[row]}
        self.review_file.write_text(json.dumps(report),encoding='utf-8')
        return report

    def run_review(self):return admit_reviewed_frames(self.request_file,self.review_file,self.images)

    def test_missing_review_or_wrong_scene_never_enters_publication(self):
        self.assertEqual(self.run_review()['status'],'needs_frame_review')
        self.review(second=False,matches_expected=False,observed='只有打开的空白窗口，还没有结果。')
        self.assertEqual(self.run_review()['status'],'needs_frame_review')
        self.assertFalse(self.images.exists())

    def test_later_candidate_preserves_reference_and_readback_is_exact(self):
        self.review()
        result=self.run_review()
        self.assertEqual(result['status'],'passed')
        self.assertEqual((self.images/'shot_00_00_20.png').read_bytes(),b'fixture result visible')
        self.assertEqual(result['frames'][0]['actual_capture_seconds'],22)
        self.assertEqual(self.run_review(),result)

    def test_changed_picture_and_stale_review_are_rejected(self):
        self.review()
        Path(self.request['frames'][0]['candidates'][1]['path']).write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'reviewed_frame_changed'):self.run_review()
        self.request_file.write_text(json.dumps({**self.request,'new_identity':1}),encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'source_mismatch'):self.run_review()

    def test_outside_window_unobserved_or_duplicate_review_cannot_pass(self):
        self.review(selected_time='00:01:10')
        with self.assertRaisesRegex(ValueError,'not_in_capture_window'):self.run_review()
        self.review(observed='')
        with self.assertRaisesRegex(ValueError,'observation_required'):self.run_review()
        review=self.review();review['frames']*=2
        self.review_file.write_text(json.dumps(review),encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'coverage_mismatch'):self.run_review()

    def test_upstream_offset_cannot_escape_the_selected_scene(self):
        self.request['frames'][0]['candidates'][1]['actual_seconds']=27
        self.request_file.write_text(json.dumps(self.request),encoding='utf-8')
        self.review()
        with self.assertRaisesRegex(ValueError,'actual_frame_outside_capture_window'):self.run_review()


if __name__=='__main__':unittest.main()
