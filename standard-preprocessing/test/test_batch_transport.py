"""Transport boundary tests: no model calls or application configuration changes."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import batch_transport as batch


class BatchBoundaryTests(unittest.TestCase):
    def fake_process(self, args, **options):
        self.seen = options
        request = json.loads(options['input'])
        if request.get('action') == 'identity':
            data = {'provider':'codex_exec', 'model':'fixture-model',
                    'identity':['codex_exec','fixture-model','fixture-transport']}
        else:
            self.request = request
            for image in request['images']:
                self.assertTrue(Path(image['path']).is_file())
            data = {'provider':'codex_exec','model':'fixture-model', 'transport':{},
                    'choices':[{'finish_reason':'stop','message':{'content':'{"accepted":true}'}}],
                    'usage':{'total_tokens':9}}
        return SimpleNamespace(returncode=0, stdout=json.dumps(data))

    def test_child_route_does_not_modify_application_environment(self):
        with patch.dict(os.environ, {'AI_PRODUCER_PROVIDER':'deepseek',
                'DEEPSEEK_API_KEY':'fixture-never-sent', 'AI_PRODUCER_MODEL':'deepseek-flash'}):
            before = dict(os.environ)
            with patch.object(batch.subprocess, 'run', side_effect=self.fake_process):
                client = batch.BatchClient()
                raw = client.raw([{'role':'system','content':'SYSTEM EXACT'},
                    {'role':'user','content':'SOURCE\nEXACT'}], max_tokens=4321, temperature=.2)
            self.assertEqual(before, dict(os.environ))
            self.assertEqual(self.seen['env']['AI_PRODUCER_PROVIDER'], 'codex_exec')
            self.assertEqual(self.request['system'], 'SYSTEM EXACT')
            self.assertEqual(self.request['user'], 'SOURCE\nEXACT')
            self.assertNotIn('fixture-never-sent', self.seen['input'])
            self.assertFalse(raw['transport']['compatibility_parameters_applied'])
            self.assertEqual(raw['transport']['requested_compatibility_parameters']['temperature'], .2)

    def test_failure_never_falls_back_to_http(self):
        with patch.object(batch.subprocess, 'run', return_value=SimpleNamespace(returncode=1)), \
             patch.object(batch.urllib.request, 'urlopen', side_effect=AssertionError('API fallback')):
            with self.assertRaisesRegex(RuntimeError, 'no API fallback'):
                batch.BatchClient()

    def test_response_reports_actual_codex_model_and_usage(self):
        with patch.object(batch.subprocess, 'run', side_effect=self.fake_process):
            client = batch.BatchClient()
            result = client.chat.completions.create(model='deepseek-flash', messages=[{'role':'user','content':'x'}])
        self.assertEqual(result.model, 'fixture-model')
        self.assertEqual(result.provider, 'codex_exec')
        self.assertEqual(result.usage.model_dump()['total_tokens'], 9)
        self.assertIn('codex_exec', client.cache_identity)

    def test_foreign_provider_identity_is_rejected(self):
        data = SimpleNamespace(returncode=0, stdout='{"provider":"deepseek"}')
        with patch.object(batch.subprocess, 'run', return_value=data):
            with self.assertRaisesRegex(RuntimeError, 'provider_mismatch'):
                batch.BatchClient()

    def test_unsupported_image_bytes_stop_before_production(self):
        with patch.object(batch.subprocess, 'run', side_effect=self.fake_process) as process:
            client = batch.BatchClient()
            with self.assertRaisesRegex(ValueError, 'image_bytes_unsupported'):
                client.raw([{'role':'user','content':[{'type':'image_url',
                    'image_url':{'url':'data:image/png;base64,bm90LWFuLWltYWdl'}}]}])
            self.assertEqual(process.call_count, 1)  # identity only

    def test_skill_runner_no_longer_uses_api_arguments(self):
        path = Path.home()/'.codex/skills/ai-production-supervisor/scripts/run_ai_batch.py'
        spec = importlib.util.spec_from_file_location('batch_runner_boundary_test', path)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        fake = SimpleNamespace(raw=lambda messages: {'messages':messages})
        with patch.object(runner, 'batch_client', return_value=fake) as factory, \
             patch.object(runner.urllib.request, 'urlopen', side_effect=AssertionError('API call')):
            result = runner.call_chat('https://api.deepseek.com','fixture-key','deepseek-flash','exact',20)
        self.assertEqual(result['messages'][0]['content'], 'exact')
        self.assertIsNone(factory.call_args.kwargs['model'])

    def test_jsonl_cli_requires_no_api_key_and_preserves_prior_outputs(self):
        path = Path.home()/'.codex/skills/ai-production-supervisor/scripts/run_ai_batch.py'
        spec = importlib.util.spec_from_file_location('batch_runner_cli_test', path)
        runner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(runner)
        fake = SimpleNamespace(model='fixture-codex', identity=['codex_exec','fixture-codex'],
            raw=lambda messages: {'choices':[{'message':{'content':'fixture answer'}}]})
        with tempfile.TemporaryDirectory(dir='D:/Caches/ProgressiveReading') as temp:
            root=Path(temp)
            (root/'input.jsonl').write_text('{"id":"one","input":"exact source"}\n',encoding='utf-8')
            (root/'prompt.txt').write_text('{{input}}',encoding='utf-8')
            argv=['runner','--input',str(root/'input.jsonl'),'--prompt',str(root/'prompt.txt'),
                  '--output',str(root/'output.jsonl')]
            with patch.object(sys,'argv',argv), patch.object(runner,'batch_client',return_value=fake), \
                 patch.object(runner.urllib.request,'urlopen',side_effect=AssertionError('API call')):
                self.assertEqual(runner.main(),0)
                original=(root/'output.jsonl').read_bytes()
                record=json.loads(original)
                self.assertEqual(record['provider'],'codex_exec')
                with self.assertRaisesRegex(SystemExit,'prior production evidence'):
                    runner.main()
                self.assertEqual((root/'output.jsonl').read_bytes(),original)


if __name__ == '__main__':
    unittest.main()
