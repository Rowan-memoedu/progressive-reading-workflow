"""Exercise the actual capture CLI with local candidate images, no browser or model."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image


class CaptureReviewIntegration(unittest.TestCase):
    def test_pending_then_reviewed_candidates_materialize_without_network_or_credentials(self):
        with tempfile.TemporaryDirectory(prefix='capture-review-') as temporary:
            root=Path(temporary);source=root/'source';source.mkdir()
            audit=root/'audit';candidates=audit/'frame-candidates';candidates.mkdir(parents=True)
            image=candidates/'shot_00_00_22.png'
            Image.effect_noise((640,480),64).convert('RGB').save(image)
            image_hash=hashlib.sha256(image.read_bytes()).hexdigest()
            image.with_suffix('.capture.json').write_text(json.dumps({'actual_seconds':22.0,'sha256':image_hash}),encoding='utf-8')
            (source/'transcript.json').write_text(json.dumps({'video_id':'BV1234567890','video_url':'https://www.bilibili.com/video/BV1234567890/'}),encoding='utf-8')
            tagged='# 独立实验\n\n![测量结果](SCREENSHOT:00:00:20)\n'
            (source/'book.tagged.md').write_text(tagged,encoding='utf-8');(source/'book.md').write_text(tagged,encoding='utf-8')
            plan={'version':'video-frame-plan/v2','frames':[{'file':'shot_00_00_20.png','requested_time':'00:00:20',
                'window_end':'00:00:24','scene':'demonstration','expected_visual':'测试测量结果','candidates':['00:00:22']} ]}
            plan_file=audit/'capture-plan.json';plan_file.write_text(json.dumps(plan),encoding='utf-8')
            report=audit/'capture-receipt.json'
            args=[sys.executable,str(Path(__file__).with_name('capture-authenticated.py')),'--input',str(source),
                  '--plan',str(plan_file),'--cookies-file',str(root/'no-credentials.txt'),'--report',str(report)]
            def execute():
                process=subprocess.run(args,capture_output=True,text=True,encoding='utf-8')
                self.assertEqual(process.returncode,0,process.stdout+process.stderr)
                return json.loads(report.read_text('utf-8'))
            self.assertEqual(execute()['status'],'needs_frame_review')
            self.assertFalse((source/'images').exists())
            request=audit/'frame-review-request.json'
            review={'version':'video-frame-review/v1','request_sha256':hashlib.sha256(request.read_bytes()).hexdigest(),
                    'frames':[{'file':'shot_00_00_20.png','selected_time':'00:00:22','sha256':image_hash,
                               'matches_expected':True,'observed':'离线合成夹具，仅验证图片合并机制。'}]}
            (audit/'frame-review.json').write_text(json.dumps(review),encoding='utf-8')
            result=execute()
            self.assertEqual(result['status'],'completed')
            self.assertEqual(result['frames'][0]['actual_capture_seconds'],22)
            self.assertEqual((source/'images/shot_00_00_20.png').read_bytes(),image.read_bytes())
            self.assertNotIn('SCREENSHOT:',(source/'book.md').read_text('utf-8'))
            self.assertIn('images/shot_00_00_20.png',(source/'book.md').read_text('utf-8'))
            self.assertEqual(execute()['frames'],result['frames'])


if __name__=='__main__':unittest.main()
