"""No network calls: execute each Python stage through a controlled unified bridge."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).parent
sys.path.insert(0,str(ROOT.parent/'standard-preprocessing'))
from producer_transport import ProducerTransport


def load(name,file):
    spec=importlib.util.spec_from_file_location(name,file)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


class RouteTests(unittest.TestCase):
    def test_exact_source_indices_never_accept_a_rewritten_quote_or_invent_an_index(self):
        module=load('indexed_media',ROOT/'plan-upstream-media.py')
        transcript={'segments':[{'start':'00:00:10','text':'几何意几何E就是两边之和'}]}
        raw={'items':[{'kind':'screenshot','source_segment_index':0,'source_quote':'模型悄悄润色的引文'}]}
        result=module.bind_source_evidence(raw,transcript)
        self.assertEqual(result['items'][0]['source_quote'],transcript['segments'][0]['text'])
        self.assertEqual(raw['items'][0]['source_quote'],'模型悄悄润色的引文')
        for index in [None,-1,True,1,'0']:
            with self.assertRaisesRegex(ValueError,'exact_source_index'):
                module.bind_source_evidence({'items':[{'source_segment_index':index}]},transcript)

    def test_demonstration_schema_requires_a_real_completion_index_and_preserves_fractional_evidence(self):
        module=load('indexed_demonstration',ROOT/'plan-upstream-media.py')
        transcript={'segments':[{'start':'00:00:12.125','end':'00:00:14.750','text':'操作已经完成并显示结果'}]}
        item={'kind':'screenshot','scene':'demonstration','source_segment_index':0}
        with self.assertRaisesRegex(ValueError,'exact_result_index'):
            module.bind_source_evidence({'items':[item]},transcript)
        result=module.bind_source_evidence({'items':[{**item,'result_segment_index':0}]},transcript)
        self.assertEqual(result['items'][0]['result_start'],'00:00:12.125')
        self.assertEqual(result['items'][0]['result_quote'],transcript['segments'][0]['text'])
        prompt=(ROOT/'prompts/upstream-media-only.md').read_text('utf-8')
        examples=prompt.split('{"items":[',1)[1].split(']}',1)[0]
        self.assertIn('"result_segment_index":1',examples)
        self.assertNotIn('"source_quote":',examples)

    def test_both_media_stages_use_one_unified_request_and_replay_without_resending(self):
        for script in ['plan-upstream-media.py','plan-media-placement.py']:
            with self.subTest(script=script),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);source=root/'input.json';output=root/'run'
                source.write_text(json.dumps({'video_id':'fixture','title':'读数','duration':120,'segments':[]}),encoding='utf-8')
                module=load('media_stage',ROOT/script)
                requests=[]
                def bridge(payload,timeout=630):
                    identity=['codex_exec','codex_exec','fixture-model']
                    if payload.get('action')=='identity':return {'provider':'codex_exec','model':'fixture-model','identity':identity,'timeout_ms':600000}
                    self.assertEqual(payload['requiredProvider'],'codex_exec')
                    self.assertEqual(payload['expectedIdentity'],identity);requests.append(payload)
                    return {'provider':'codex_exec','model':'fixture-model','producer_identity':identity,
                            'choices':[{'finish_reason':'stop','message':{'content':'{"items":[]}'}}]}
                with patch('producer_transport.bridge',side_effect=bridge),patch.object(sys,'argv',[script,'--input',str(source),'--output',str(output)]),contextlib.redirect_stdout(io.StringIO()):
                    module.main();module.main()
                self.assertEqual(len(requests),1)
                receipt=json.loads((output/'receipt.json').read_text('utf-8'))
                self.assertEqual(receipt['provider'],'codex_exec');self.assertEqual(receipt['model'],'fixture-model')
                self.assertEqual(receipt['api_calls_this_run'],0)

    def test_legacy_api_response_and_changed_model_are_never_relabelled(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'model-response.json').write_text('{"model":"deepseek-fixture"}',encoding='utf-8')
            transport=ProducerTransport.__new__(ProducerTransport)
            transport.identity=['codex_exec','codex_exec','fixture-model']
            with self.assertRaisesRegex(ValueError,'legacy_stage_cache'):
                transport.frozen_call(root,'system','user')
            (root/'transport-identity.json').write_text(json.dumps({'version':'unified-reading-transport/v1','identity':['codex_exec','codex_exec','another-model']}),encoding='utf-8')
            with self.assertRaisesRegex(ValueError,'stage_cache_producer_mismatch'):
                transport.frozen_call(root,'system','user')

    def test_unknown_request_outcome_does_not_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'request-sent.json').write_text('{}',encoding='utf-8')
            transport=ProducerTransport.__new__(ProducerTransport);transport.identity=['codex_exec','codex_exec','fixture-model']
            with self.assertRaisesRegex(ValueError,'outcome_unknown'):
                transport.frozen_call(root,'system','user')


if __name__=='__main__':unittest.main()
