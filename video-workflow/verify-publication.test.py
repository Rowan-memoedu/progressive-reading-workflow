import runpy
import hashlib
import json
import tempfile
from pathlib import Path
import unittest

MODULE=runpy.run_path(str(Path(__file__).with_name('verify-publication.py')))
canonical=MODULE['canonical_body_layout']
verify_projection=MODULE['verify_generated_projection']
verify_request=MODULE['verify_projection_request']


class LayoutAuditTests(unittest.TestCase):
    def test_shared_projection_checks_source_request_and_bound_stage_output(self):
        refinement={'input_sha256':'source-id','body_sha256':'body-id','mode':'strong_structuring'}
        result={'receipt':{'body_refinement':dict(refinement),'workflow_route':{'plan':{'body_mode':'strong_structuring'}}}}
        request={'material':{'markdown':'原字幕'},'processing_options':{'structure_body':True}}
        verify_request(request,result,refinement,'原字幕','冻结正文加原图')
        with self.assertRaises(AssertionError):verify_request(request,result,refinement,'被换掉的字幕','冻结正文加原图')
        result['receipt']['body_refinement']['body_sha256']='unrelated'
        with self.assertRaises(AssertionError):verify_request(request,result,refinement,'原字幕','冻结正文加原图')

    def test_external_projection_still_requires_completed_written_input(self):
        request={'material':{'markdown':'冻结正文加原图'},'processing_options':{'structure_body':False,'spoken_to_written':False}}
        verify_request(request,{'receipt':{}},{},'原字幕','冻结正文加原图')
        request['processing_options']['structure_body']=True
        with self.assertRaises(AssertionError):verify_request(request,{'receipt':{}},{},'原字幕','冻结正文加原图')

    def test_only_empty_separator_lines_are_ignored(self):
        self.assertEqual(canonical('# 标题\n- 原文\n  - 条件'),canonical('# 标题\n\n- 原文\n\n  - 条件'))

    def test_code_empty_lines_and_indentation_remain_literal(self):
        code='- 图\n  - ```mermaid\n    graph LR\n\n    A-->B\n    ```'
        self.assertNotEqual(canonical(code),canonical(code.replace('\n\n','\n')))
        self.assertNotEqual(canonical(code),canonical(code.replace('A-->B','A-->C')))

    def test_prose_and_hierarchy_changes_are_rejected(self):
        text='- 除非异常，否则采样。\n  - 保留记录。'
        self.assertNotEqual(canonical(text),canonical(text.replace('除非','如果')))
        self.assertNotEqual(canonical(text),canonical(text.replace('  -','-')))

    def test_generated_media_merge_is_independently_reversed_and_tampering_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);pending=root/'generated-media-projection';pending.mkdir()
            prose='# 观测\n- 🌱采集温度\n';addition='\n- ![仪器](images/gauge.png)'
            offset=len(prose.rstrip().encode('utf-16-le'))//2
            merged=prose.rstrip()+addition+'\n'
            sha=lambda text:hashlib.sha256(text.encode()).hexdigest()
            raw='{"choices":[{"finish_reason":"stop"}]}'
            (root/'attempt-1.response.json').write_text(raw,encoding='utf-8')
            (root/'body.md').write_text(merged,encoding='utf-8',newline='')
            (pending/'prose.md').write_text(prose,encoding='utf-8',newline='')
            projection={'prose_sha256':sha(prose),'output_sha256':sha(merged),'prose_unchanged':True,
                        'media':1,'insertions':[{'output_offset':offset,'text':addition,'media_ids':[0]}]}
            (pending/'projection.json').write_text(json.dumps(projection),encoding='utf-8')
            (pending/'prose-receipt.json').write_text(json.dumps({'response_sha256':sha(raw),'prose_sha256':sha(prose)}),encoding='utf-8')
            refinement={'generated_media_projection':projection,'response_sha256':sha(raw)}
            verify_projection(root,refinement,root/'body.md')
            (pending/'prose.md').write_text(prose.replace('温度','湿度'),encoding='utf-8',newline='')
            with self.assertRaises(AssertionError):verify_projection(root,refinement,root/'body.md')


if __name__=='__main__': unittest.main()
