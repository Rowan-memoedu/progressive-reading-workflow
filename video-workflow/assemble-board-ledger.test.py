import importlib.util,json,unittest,tempfile
from pathlib import Path
s=importlib.util.spec_from_file_location('ledger',Path(__file__).with_name('assemble-board-ledger.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class WireTests(unittest.TestCase):
 def test_source_conflicts_are_exact_attributed_nonblocking_and_cannot_hide_edits(self):
  with tempfile.TemporaryDirectory(dir=r'D:\Artifacts\ProgressiveReading',prefix='source-conflict-test-') as directory:
   image=Path(directory)/'fixture.png';image.write_bytes(b'controlled image')
   transcript={'segments':[{'start':'00:00:01','text':'这里没有说明变量范围。'}]}
   request={'frames':[{'file':'image','requested_time':'00:00:01','window_end':'00:00:02','candidates':[{'path':str(image),'sha256':m.sha(image.read_bytes()),'time':'00:00:01','actual_seconds':1}]}]}
   conflict={'kind':'source_omission','captions':[{'segment_index':0,'before':transcript['segments'][0]['text']}],'evidence':['image'],'observed':'板书写出不等式但未列变量范围。','reason':'原视频未交代范围，不自行增加。'}
   value={'review':{'verdict':'pass','issues':[]},'observations':[{'image_id':'image','status':'complete','observed':'受控题设与推导','title':'test'}],'patches':[],'formula_notes':[],'unresolved':[],'source_conflicts':[conflict]}
   row={'provider':'codex_exec','image_count':1,'id':'test','input':{'input':json.dumps({'main_range':[0,0]})},'output':json.dumps(value)}
   ledger=m.compile_ledger(transcript,b'raw',request,b'request',[row],True)
   self.assertTrue(ledger['independent_review_passed']);self.assertFalse(ledger['unresolved']);self.assertEqual(ledger['source_conflicts'][0]['captions'],conflict['captions'])
   value['patches']=[{'segment_index':0,'before':transcript['segments'][0]['text'],'after':'擅自补正数范围','evidence':['image']}];row['output']=json.dumps(value)
   with self.assertRaisesRegex(ValueError,'source_conflict_was_modified'):m.compile_ledger(transcript,b'raw',request,b'request',[row],True)
   value['patches']=[];conflict['captions'][0]['before']='伪造引文';row['output']=json.dumps(value)
   with self.assertRaisesRegex(ValueError,'source_conflict_not_exact'):m.compile_ledger(transcript,b'raw',request,b'request',[row],True)
 def test_retained_uncertainty_must_preserve_exact_source_and_cannot_hide_a_patch(self):
  transcript={'segments':[{'start':'00:00:00','text':'回顾刚才的术语。'}]}
  value={'review':{'verdict':'pass','issues':[]},'observations':[],'patches':[],'formula_notes':[],'unresolved':[],
    'retained_uncertainties':[{'segment_index':0,'before':'回顾刚才的术语。','kind':'lexical_or_context_only','reason':'不涉及本题条件或公式。'}]}
  row={'provider':'codex_exec','image_count':1,'id':'fixture','input':{'input':json.dumps({'main_range':[0,0]})},'output':json.dumps(value)}
  ledger=m.compile_ledger(transcript,b'raw',{'frames':[]},b'request',[row],True)
  self.assertEqual(ledger['retained_uncertainties'][0]['before'],transcript['segments'][0]['text'])
  value['patches']=[{'segment_index':0,'before':'回顾刚才的术语。','after':'擅自替换名称','evidence':[]}]
  row['output']=json.dumps(value)
  with self.assertRaisesRegex(ValueError,'uncertainty_was_modified'):m.compile_ledger(transcript,b'raw',{'frames':[]},b'request',[row],True)
 def test_core_mathematical_uncertainty_remains_blocking_even_with_a_pass_label(self):
  value={'review':{'verdict':'pass','issues':[]},'observations':[],'patches':[],'formula_notes':[],'unresolved':['变量定义域无法核清']}
  row={'provider':'codex_exec','image_count':1,'id':'fixture','input':{'input':json.dumps({'main_range':[0,0]})},'output':json.dumps(value)}
  ledger=m.compile_ledger({'segments':[{'start':'00:00:00','text':'原条件'}]},b'raw',{'frames':[]},b'request',[row],True)
  self.assertTrue(ledger['unresolved']);self.assertFalse(ledger['accepted'])
 def test_inexact_source_proposals_are_retained_for_review_but_never_applied(self):
  with tempfile.TemporaryDirectory(dir=r'D:\Artifacts\ProgressiveReading',prefix='ledger-source-test-') as directory:
   image=Path(directory)/'fixture.png';image.write_bytes(b'controlled image bytes')
   transcript={'segments':[{'start':'00:00:01','text':'原始准确字幕'}]}
   request={'frames':[{'file':'image','requested_time':'00:00:01','window_end':'00:00:02','candidates':[{'path':str(image),'sha256':m.sha(image.read_bytes()),'time':'00:00:01','actual_seconds':1}]}]}
   value={'observations':[{'image_id':'image','status':'complete','observed':'独立受控图像夹具','title':'test'}],'patches':[{'segment_index':0,'before':'模型改写过的字幕','after':'不得应用','evidence':['image']}],'formula_notes':[],'unresolved':[]}
   result={'provider':'codex_exec','image_count':1,'id':'test','input':{'input':json.dumps({'main_range':[0,0]})},'output':json.dumps(value)}
   ledger=m.compile_ledger(transcript,b'raw',request,b'request',[result])
   self.assertFalse(ledger['accepted']);self.assertEqual(ledger['patches'],[])
   self.assertEqual(ledger['rejected_proposals'][0]['reason'],'quoted_before_not_exact_source');self.assertTrue(ledger['unresolved'])
 def test_invalid_json_latex_commands_and_delimiters_are_losslessly_decoded(self):
  text=r'{"formula":"$\frac{u}{v}\leq\sqrt{w}$ and \(z\)","line":"第一行\n第二行"}'
  value,repaired=m.decode_visual_json(text);self.assertTrue(repaired);self.assertEqual(value['formula'],r'$\frac{u}{v}\leq\sqrt{w}$ and \(z\)');self.assertEqual(value['line'],'第一行\n第二行')
 def test_valid_json_is_not_reescaped_and_arbitrary_broken_json_is_rejected(self):
  text=json.dumps({'formula':r'$\frac{m}{n}$'});value,repaired=m.decode_visual_json(text);self.assertFalse(repaired);self.assertEqual(value['formula'],r'$\frac{m}{n}$')
  with self.assertRaises(json.JSONDecodeError):m.decode_visual_json('{bad}')
 def test_commands_next_to_digits_and_arrow_commands_are_not_lost(self):
  value,_=m.decode_visual_json(r'{"formula":"$k\le9\Rightarrow k^2\ge0$"}')
  self.assertEqual(value['formula'],r'$k\le9\Rightarrow k^2\ge0$')
 def test_unique_quoted_source_subspan_keeps_every_outer_character_and_rejects_fuzzy_edits(self):
  p={'segment_index':5,'before':'计算此式为甲','after':'计算此式为乙'}
  v,changed=m.bind_patch_source(p,'嗯，计算此式为甲。')
  self.assertTrue(changed);self.assertEqual(v['before'],'嗯，计算此式为甲。');self.assertEqual(v['after'],'嗯，计算此式为乙。')
  with self.assertRaisesRegex(ValueError,'not_exact_source'):m.bind_patch_source(p,'计算那个式为甲。')
 def test_overescaped_math_commands_are_decoded_without_touching_valid_linebreaks_or_before_quotes(self):
  original={'text':r'$x\\ge0$ and $a\\\\b$','before':r'$x\\ge0$'}
  value,changed=m.decode_visual_json(json.dumps(original));self.assertTrue(changed)
  self.assertEqual(value['text'],r'$x\ge0$ and $a\\\\b$');self.assertEqual(value['before'],original['before'])
if __name__=='__main__':unittest.main()
