import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
import subprocess
import sys
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('full_text',Path(__file__).parents[1]/'refine-full-text.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SingleCallTests(unittest.TestCase):
    def test_legacy_audio_config_argument_cannot_select_an_api_transport(self):
        result=subprocess.run([sys.executable,str(Path(__file__).parents[1]/'refine-full-text.py'),
            '--input','unused-input.md','--output','unused-output','--audio-config','unused-config.json'],
            capture_output=True,text=True,encoding='utf-8')
        self.assertNotEqual(result.returncode,0)
        self.assertIn('legacy_audio_api_config_not_supported',result.stderr)

    def test_formula_reference_exposes_semantics_without_altering_source(self):
        source='条件 $u+v=5$。图片 ![图](images/a.png)，普通代码 `danger()`。'
        protected, spans=MODULE.protect_source(source)
        reference=MODULE.math_source_reference(spans)
        self.assertIn('$u+v=5$',reference)
        self.assertNotIn('images/a.png',reference)
        self.assertNotIn('danger()',reference)
        self.assertEqual(MODULE.restore_source(protected,spans),source)

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='pr-full-text-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        self.prompt=self.root/'prompt-source.md'
        self.prompt.write_text('书面化全文，保留全部信息。',encoding='utf-8')
        self.source=self.root/'source.md'
        self.source.write_text('第一段保留条件。\n\n最后一段保留例外。',encoding='utf-8')
        def write(path,value):
            path.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
        self.audio=types.SimpleNamespace(read_json=lambda path:json.loads(path.read_text(encoding='utf-8')),write_json=write)
        self.calls=[]
        def call(prompt,text):
            self.calls.append((prompt,text))
            return {'choices':[{'finish_reason':'stop','message':{'content':'# 记录\n\n## 条件与例外\n\n第一段保留条件。\n\n最后一段保留例外。'}}]}, {'thinking':{'type':'disabled'}}
        self.ai=types.SimpleNamespace(model='fixture',compact_call=call,
            module=types.SimpleNamespace(extract_content=lambda raw:raw['choices'][0]['message']['content']))

    def run_body(self):
        return MODULE.run_once(self.audio,self.ai,prompt_path=self.prompt,input_path=self.source,
            target=self.root/'run',mode='spoken_to_written',module_path=Path(__file__),max_tokens=65536)

    def test_full_input_one_response_and_replay(self):
        receipt=self.run_body()
        self.assertEqual(len(self.calls),1)
        self.assertEqual(self.calls[0][1],self.source.read_bytes().decode('utf-8'))
        self.assertEqual(receipt['api_calls_this_run'],1)
        self.assertEqual(self.run_body()['api_calls_this_run'],0)
        self.assertEqual(len(self.calls),1)

    def test_interruption_does_not_retry(self):
        def fail(*args):
            self.calls.append(args)
            raise TimeoutError()
        self.ai.compact_call=fail
        with self.assertRaises(TimeoutError): self.run_body()
        with self.assertRaisesRegex(ValueError,'automatic_retry_disabled'): self.run_body()
        self.assertEqual(len(self.calls),1)

    def test_invalid_response_is_saved_and_never_regenerated(self):
        def incomplete(*args):
            self.calls.append(args)
            return {'choices':[{'finish_reason':'length','message':{'content':'# 截断'}}]},{}
        self.ai.compact_call=incomplete
        for _ in range(2):
            with self.assertRaisesRegex(ValueError,'incomplete'): self.run_body()
        self.assertEqual(len(self.calls),1)
        self.assertTrue((self.root/'run/attempt-1.response.json').exists())

    def test_native_markdown_restored_in_place_and_missing_token_rejected(self):
        source='开头\n\n```mermaid\ngraph LR\nA-->B\n```\n\n公式 $x^2$ 与 [记录](file.pdf)。'
        protected,spans=MODULE.protect_source(source)
        self.assertEqual(MODULE.restore_source(protected,spans),source)
        self.assertEqual(len(spans),3)
        with self.assertRaisesRegex(ValueError,'protected_source_missing'):
            MODULE.restore_source('缺失',spans)

    def test_bounded_image_projection_preserves_prose_and_source_order(self):
        spans={'AA':'![温度](images/a.png)','BB':'![湿度](images/b.png)','CC':'![压力](images/c.png)'}
        text='# 校准\n- 仪器 AA\n  - 校准记录\n  - 测量 CC'
        repaired,changes=MODULE.recover_bounded_image_markers(text,spans)
        self.assertEqual(repaired,'# 校准\n- 仪器 AA\n  - 校准记录\n  - BB\n  - 测量 CC')
        self.assertEqual(len(changes),1)
        self.assertIn('![湿度](images/b.png)',MODULE.restore_source(repaired,spans))
        self.assertEqual(MODULE.recover_bounded_image_markers(repaired,spans),(repaired,[]))

    def test_inline_native_media_gets_own_bullet_without_changing_prose(self):
        spans={'AA':'```mermaid\ngraph LR\nA-->B\n```','BB':'![校准](images/b.png)','CC':'$T$'}
        text='# 仪器\n- 校准 AA BB\n  - 条件 CC'
        fixed,changes=MODULE.normalize_marker_lines(text,spans)
        self.assertEqual(fixed,'# 仪器\n- 校准\n- AA\n- BB\n  - 条件 CC')
        restored=MODULE.restore_source(fixed,spans)
        self.assertIn('- ```mermaid\n  graph LR\n  A-->B\n  ```',restored)
        self.assertEqual(len(changes),1)

    def test_image_projection_rejects_missing_edges_diagrams_and_reordering(self):
        images={'AA':'![一](images/a.png)','BB':'![二](images/b.png)','CC':'![三](images/c.png)'}
        for text in ['# 例\n- BB\n- CC','# 例\n- CC\n- AA','# 例\n- AA CC']:
            with self.assertRaises(ValueError): MODULE.recover_bounded_image_markers(text,images)
        with self.assertRaises(ValueError):
            MODULE.recover_bounded_image_markers('# 例\n- AA\n- CC',{**images,'BB':'```mermaid\nA-->B\n```'})

    def test_windows_native_fence_is_one_literal_protected_span(self):
        source='```mermaid\r\ngraph LR\r\nA["原图"]-->B\r\n```'
        protected,spans=MODULE.protect_source(source)
        self.assertEqual(list(spans.values()),[source])
        self.assertEqual(MODULE.restore_source(protected,spans),source)

    def test_separate_source_contract_preserves_author_prompt_and_each_marker(self):
        original_prompt=self.prompt.read_bytes()
        self.source.write_text('校准前采样。\n\n![现场](images/measurement.png)\n\n```mermaid\ngraph LR\nA-->B\n```\n\n条件 $T=20$。',encoding='utf-8')
        def outline(prompt,text,target,preference):
            self.calls.append((prompt,text))
            _,spans=MODULE.protect_source(self.source.read_bytes().decode('utf-8'))
            self.assertIn(original_prompt.decode('utf-8'),prompt)
            for token in spans:
                self.assertEqual(prompt.count(token),1)
                self.assertEqual(text.count(token),1)
            output='# 校准\n\n- 原文与条件\n'+''.join('  - '+token+'\n' for token in spans)
            self.audio.write_json(target/'attempt-1.response.json',{'choices':[{'finish_reason':'stop','message':{'content':output}}]})
            return output
        self.ai.outline_call=outline
        receipt=MODULE.run_once(self.audio,self.ai,prompt_path=self.prompt,input_path=self.source,
            target=self.root/'run',mode='strong_structuring',module_path=Path(__file__),max_tokens=65536)
        body=(self.root/'run/body.md').read_text(encoding='utf-8')
        self.assertIn('![现场](images/measurement.png)',body)
        self.assertIn('A-->B',body)
        self.assertIn('$T=20$',body)
        self.assertEqual(self.prompt.read_bytes(),original_prompt)
        self.assertEqual(receipt['source_protocol_version'],'source-preservation-protocol/v1')
        self.assertEqual(len(self.calls),1)

    def test_missing_content_headings_stops_without_automatic_retry(self):
        def no_headings(*args):
            self.calls.append(args)
            return {'choices':[{'finish_reason':'stop','message':{'content':'# 记录\n\n没有小标题的连续正文。'}}]},{}
        self.ai.compact_call=no_headings
        for _ in range(2):
            with self.assertRaisesRegex(ValueError,'body_requires_content_headings'): self.run_body()
        self.assertEqual(len(self.calls),1)

    def test_only_standalone_known_markers_get_outline_bullets(self):
        token='PRKEEP0123456789N000000END'
        source='# 记录\n- 原文\n  - 条件\n\n'+token+'\n未带列表符号的普通文字\n  - '+token
        normalized,changes=MODULE.normalize_marker_lines(source,{token:'![原图](images/a.png)'})
        self.assertIn('\n  - '+token+'\n未带列表符号的普通文字\n',normalized)
        self.assertEqual(len(changes),1)
        self.assertEqual(normalized.count(token),2)
        self.assertEqual(normalized.count('条件'),1)

    def test_transport_puts_preservation_in_system_role_and_authoring_in_user_role(self):
        calls=[]
        def unified(system,prompt,text):
            calls.append((system,prompt,text))
            return {'choices':[{'finish_reason':'stop'}]},{'provider':'codex_exec'}
        ai=types.SimpleNamespace(reading_call=unified)
        raw,options=MODULE.source_contract_call(ai,'保留原文标记','原始整理提示词','来源')
        self.assertEqual(calls,[('保留原文标记','原始整理提示词','来源')])
        self.assertEqual(options['source_protocol_role'],'system')
        self.assertEqual(options['provider'],'codex_exec')
        with self.assertRaisesRegex(ValueError,'unified_reading_transport_required'):
            MODULE.source_contract_call(types.SimpleNamespace(key='legacy-fixture'),'system','user','text')

    def test_plain_text_gets_source_fidelity_system_contract_even_without_media_markers(self):
        seen=[]
        native=self.ai.compact_call
        def unified(system,prompt,text):
            seen.append(system)
            return native(prompt,text)
        self.ai.reading_call=unified
        self.run_body()
        self.assertEqual(len(seen),1)
        self.assertIn('不得自行消歧',seen[0])
        self.assertIn('没有依据时不得添加',seen[0])
        effective=(self.root/'run/model-prompt.md').read_text('utf-8')
        self.assertIn('日期、数量、单位、范围和因果关系',effective)
        self.assertIn(self.prompt.read_text('utf-8'),effective)


if __name__=='__main__': unittest.main()
