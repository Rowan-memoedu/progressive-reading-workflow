import contextlib
import importlib.util
import io
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name, file):
    spec=importlib.util.spec_from_file_location(name,file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


ROOT=Path(__file__).parent
PROJECTION=load('projection',ROOT/'prepare-media-projection.py')
BODY=load('body',ROOT.parent/'standard-preprocessing/refine-full-text.py')
CAPTURE=load('capture',ROOT/'capture-authenticated.py')
PLACEMENT=load('placement',ROOT/'plan-media-placement.py')


class GeneratedMediaBoundaryTests(unittest.TestCase):
    def execute(self,content,finish='stop'):
        with tempfile.TemporaryDirectory(prefix='media-projection-') as temporary:
            root=Path(temporary);cache=root/'cache';cache.mkdir()
            image='![测量仪器](images/gauge.png)'
            formula='$T=20$'
            spans={'PRKEEP0123456789N000000END':image,'PRKEEP0123456789N000001END':formula}
            (cache/'protected-spans.json').write_text(json.dumps(spans),encoding='utf-8')
            raw={'choices':[{'finish_reason':finish,'message':{'content':content}}]}
            (cache/'attempt-1.response.json').write_text(json.dumps(raw),encoding='utf-8')
            media=root/'media.json';media.write_text(json.dumps([{'literal':image}]),encoding='utf-8')
            # The production body restoration gate is real; no model is involved.
            audio=types.SimpleNamespace(titled_outline=lambda text:text)
            with patch.object(PROJECTION,'load',side_effect=lambda name,file:BODY if 'body' in name else audio), \
                 patch.object(sys,'argv',['prepare','--cache',str(cache),'--media',str(media),'--output',str(root/'output')]), \
                 contextlib.redirect_stdout(io.StringIO()):
                PROJECTION.main()
            return (root/'output/prose.md').read_text(encoding='utf-8')

    def test_only_allowlisted_generated_visual_can_be_deferred(self):
        text='# 校准\n- 仅在 PRKEEP0123456789N000001END 时进行测量。'
        self.assertEqual(self.execute(text),'# 校准\n- 仅在 $T=20$ 时进行测量。\n')

    def test_missing_original_formula_is_still_rejected(self):
        with self.assertRaisesRegex(ValueError,'protected_source_missing'):
            self.execute('# 校准\n- 进行测量。')

    def test_duplicate_visual_is_not_silently_deduplicated(self):
        with self.assertRaisesRegex(ValueError,'duplicated_generated_media_marker'):
            self.execute('# 校准\n- PRKEEP0123456789N000000END\n- PRKEEP0123456789N000000END\n- PRKEEP0123456789N000001END')

    def test_truncated_prose_cannot_be_recovered_by_media_merge(self):
        with self.assertRaisesRegex(ValueError,'body_response_incomplete'):
            self.execute('# 校准\n- PRKEEP0123456789N000001END',finish='length')

    def test_quality_route_never_intercepts_stream_with_playurl_in_query(self):
        self.assertTrue(CAPTURE.is_quality_api('https://api.bilibili.com/x/player/wbi/playurl?qn=80'))
        self.assertFalse(CAPTURE.is_quality_api('https://video.example.net/stream.m4s?gen=playurlv3'))
        self.assertFalse(CAPTURE.is_quality_api('https://api.bilibili.com/x/player/video?gen=playurl'))
        self.assertFalse(CAPTURE.is_quality_api('https://bilibili.com.example.net/x/player/playurl'))

    def test_anchor_text_is_read_from_frozen_source_not_model_copy(self):
        prose='# 调查\n- 样本已经封存。\n'
        source=json.dumps({'lines':[{'line':i+1,'text':line} for i,line in enumerate(prose.split('\n'))]})
        result=PLACEMENT.freeze_selected_anchors(source,[{'media_id':0,'target_line':2,'exact_line':'- 样本尚未封存。'}])
        self.assertEqual(result['items'],[{'media_id':0,'target_line':2}])
        self.assertEqual(result['prose_sha256'],hashlib.sha256(prose.encode()).hexdigest())
        self.assertEqual(result['ignored_model_line_copies'],[{'media_id':0,'target_line':2}])
        with self.assertRaisesRegex(ValueError,'out_of_bounds'):
            PLACEMENT.freeze_selected_anchors(source,[{'media_id':0,'target_line':0}])
        with self.assertRaisesRegex(ValueError,'identity_changed'):
            PLACEMENT.freeze_selected_anchors(json.dumps({'lines':[{'line':2,'text':'- 项目'}]}),[])


if __name__=='__main__':unittest.main()
