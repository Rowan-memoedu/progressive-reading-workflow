import collections
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pipeline import Engine, apply_boundary_patch, compile_plan, digest, math_expressions, parse_selection, prepare, read_json, requires_mermaid, save, source_board_blocks, validate_body, validate_plan, verify_delivery


MATERIAL = {"policy":"fixture", "transcripts":[
    {"part":2,"title":"速度","cues":[[0,"速度是位移对时间的变化率。"]]},
    {"part":3,"title":"能量","cues":[[0,"动能与质量和速度平方有关。"]]}],
    "board_blocks":[],"pages":[],"images":[]}
PLAN={"title":"运动与能量","chapters":[{"id":"c01","title":"运动"}],"units":[
    {"id":"u001","chapter":"c01","title":"速度","part":2,"start":0,"end":0,"board_ranges":[]},
    {"id":"u002","chapter":"c01","title":"动能","part":3,"start":0,"end":0,"board_ranges":[]}]}


class FakeClient:
    identity=["codex_exec","fixture"]
    model="fixture"
    def __init__(self):
        self.fail={"u002"}
        self.calls=collections.Counter()
    def raw(self,messages,**kwargs):
        prompt=messages[0]["content"]
        payload=json.loads(messages[1]["content"])
        unit=payload.get("unit",{}).get("id","integration")
        self.calls[unit]+=1
        if prompt.startswith("独立审核"):
            fail=unit in self.fail
            result={"verdict":"fail" if fail else "pass","issues":[{"kind":"omission","description":"缺条件"}] if fail else [],
                    "checked":dict.fromkeys(["transcript","board","math","media"],True)}
            content=json.dumps(result)
        elif prompt.startswith("审核一份"):
            content=json.dumps({"verdict":"pass","issues":[]})
        elif prompt.startswith("独立检查数学"):
            content=json.dumps({"verdict":"pass","issues":[],
                "checked":dict.fromkeys(['witness_substitution','signs_domains','algebra'],True)})
        else:
            content="- 在给定条件下，$v$ 表示速度。\n  - 保留定义与理由。"
        return {"provider":"codex_exec","model":self.model,"choices":[{"finish_reason":"stop","message":{"content":content}}]}


class PipelineTests(unittest.TestCase):
    def setUp(self):
        home=Path('D:/Quarantine/MathLectureTests') if os.name=='nt' else None
        if home:home.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=home)
        self.addCleanup(self.temp.cleanup)
        self.client=FakeClient()
        self.engine=Engine(self.temp.name,self.client,syntax_checker=lambda body:[])
        save(Path(self.temp.name)/'material.json',MATERIAL)
        save(Path(self.temp.name)/'plan.json',{'plan':PLAN})

    def test_plan_rejects_omitted_or_repeated_subtitles(self):
        self.assertEqual(validate_plan(copy.deepcopy(PLAN),MATERIAL),PLAN)
        p=copy.deepcopy(PLAN);p["units"].pop()
        with self.assertRaisesRegex(ValueError,"subtitle_coverage"):validate_plan(p,MATERIAL)
        p=copy.deepcopy(PLAN);p["units"][0]["end"]=1
        with self.assertRaisesRegex(ValueError,"subtitle_coverage"):validate_plan(p,MATERIAL)

    def test_source_lengths_compile_endpoints_without_dropping_last_cue(self):
        material=copy.deepcopy(MATERIAL)
        material["transcripts"][0]["cues"].append([1,"最后一个有用结论"])
        proposal=copy.deepcopy(PLAN)
        proposal["units"][0].pop("end")
        proposal["units"][1].pop("end")
        result=compile_plan(proposal,material)
        self.assertEqual(result["units"][0]["end"],1)
        proposal["units"][0]["start"]=1
        with self.assertRaisesRegex(ValueError,"subtitle_coverage"):compile_plan(proposal,material)

    def test_board_coverage_and_course_order_are_exact(self):
        m=copy.deepcopy(MATERIAL);m["board_blocks"]=[{"index":0,"page":1,"text":"图"}]
        with self.assertRaisesRegex(ValueError,"board_coverage"):validate_plan(PLAN,m)
        p=copy.deepcopy(PLAN);p["units"][0]["board_ranges"]=[[0,0]]
        validate_plan(p,m)
        p["units"][1]["board_ranges"]=[[0,0]]
        with self.assertRaisesRegex(ValueError,"board_coverage"):validate_plan(p,m)
        p=copy.deepcopy(PLAN);p["units"].reverse()
        with self.assertRaisesRegex(ValueError,"source_order"):validate_plan(p,MATERIAL)

    def test_board_owner_boundaries_cover_tail_and_allow_noncontiguous_ownership(self):
        m=copy.deepcopy(MATERIAL)
        m["board_blocks"]=[{"index":i,"page":1,"text":str(i)} for i in range(5)]
        p=copy.deepcopy(PLAN)
        p["board_owners"]=[{"start":0,"unit":"u001"},{"start":1,"unit":"u002"},{"start":3,"unit":"u001"}]
        compiled=compile_plan(p,m)
        self.assertEqual(compiled["units"][0]["board_ranges"],[[0,0],[3,4]])
        self.assertEqual(compiled["units"][1]["board_ranges"],[[1,2]])
        p["board_owners"][1]["start"]=0
        with self.assertRaisesRegex(ValueError,"owner_boundaries"):compile_plan(p,m)

    def test_boundary_repair_keeps_all_sources_and_unselected_units(self):
        m=copy.deepcopy(MATERIAL)
        m['transcripts'][0]['cues']=[[0,'题设'],[1,'解释'],[2,'结论'],[3,'下一主题']]
        m['board_blocks']=[{'index':i,'page':1,'text':str(i)} for i in range(4)]
        p=copy.deepcopy(PLAN)
        p['units'][0].update(end=1,board_ranges=[[0,1]])
        p['units'].insert(1,{**p['units'][0],'id':'u003','start':2,'end':3,'board_ranges':[[2,3]]})
        proposal={'units':[{'id':'u001','start':0,'board_ranges':[[0,0],[2,2]]},
                           {'id':'u003','start':3,'board_ranges':[[1,1],[3,3]]}]}
        fixed=apply_boundary_patch(p,proposal,m,['u001','u003'])
        self.assertEqual(fixed['units'][0]['end'],2)
        self.assertEqual(fixed['units'][-1],p['units'][-1])
        self.assertEqual(p['units'][0]['end'],1)
        bad=copy.deepcopy(proposal);bad['units'][1]['board_ranges']=[[1,1]]
        with self.assertRaisesRegex(ValueError,'board_coverage'):apply_boundary_patch(p,bad,m,['u001','u003'])
        bad=copy.deepcopy(proposal);bad['units'][0]['chapter']='非法更换章节'
        with self.assertRaisesRegex(ValueError,'only_change_source_ranges'):apply_boundary_patch(p,bad,m,['u001','u003'])
        only_second={'units':[{**proposal['units'][1],'board_ranges':[[2,3]]}]}
        with self.assertRaisesRegex(ValueError,'unselected_unit'):
            apply_boundary_patch(p,only_second,m,['u003'])

    def test_failed_boundary_review_cannot_mutate_accepted_plan(self):
        root=Path(self.temp.name)
        save(root/'integration-review.json',{'review':{'verdict':'fail','issues':[
            {'unit_ids':['u001','u002'],'description':'跨题目边界'}]}})
        before=(root/'plan.json').read_bytes()
        proposed={'units':[{k:u[k] for k in ['id','start','board_ranges']} for u in PLAN['units']]}
        def fake_call(stage,payload,images=()):
            value=proposed if stage=='repair-boundaries' else {'verdict':'fail','issues':['仍有错配']}
            return json.dumps(value),{'request_key':stage}
        self.engine.call=fake_call
        with self.assertRaisesRegex(ValueError,'boundary_repair_review_failed'):
            self.engine.repair_boundaries(MATERIAL,PLAN,['u001','u002'])
        self.assertEqual((root/'plan.json').read_bytes(),before)
        self.assertFalse((root/'units/u001/state.json').exists())

    def test_mixed_ocr_block_is_partitioned_losslessly_at_a_unique_source_quote(self):
        m=copy.deepcopy(MATERIAL)
        text='上一题的最后结论。[例2]下一题的题设与解答。'
        m['board_blocks']=[{'index':0,'page':1,'type':'text','text':text}]
        p=copy.deepcopy(PLAN)
        p['units'][0]['board_ranges']=[[0,0]]
        p['board_splits']=[{'index':0,'pieces':[{'at':None,'unit':'u001'},{'at':'[例2]','unit':'u002'}]}]
        validate_plan(p,m)
        first=source_board_blocks(p,m,p['units'][0])[0]
        second=source_board_blocks(p,m,p['units'][1])[0]
        self.assertEqual(first['text']+second['text'],text)
        self.assertEqual(first['text'],'上一题的最后结论。')
        self.assertEqual(first['source_text_range'][1],second['source_text_range'][0])
        self.assertEqual(second['source_text_range'][1],len(text))
        m['board_blocks'][0]['type']='equation'
        validate_plan(p,m)
        self.assertEqual(''.join(source_board_blocks(p,m,u)[0]['text'] for u in p['units']),text)
        m['board_blocks'][0]['type']='image'
        with self.assertRaisesRegex(ValueError,'requires_mixed_text'):validate_plan(p,m)
        m['board_blocks'][0]['type']='text'
        m['board_blocks'][0]['text']+='又有[例2]'
        with self.assertRaisesRegex(ValueError,'quote_not_unique'):validate_plan(p,m)

    def test_alignment_failure_retries_binding_without_repeating_transcript_planning(self):
        root=Path(self.temp.name)/'alignment-fixture'
        engine=Engine(root,self.client)
        m=copy.deepcopy(MATERIAL)
        m['board_blocks']=[{'index':0,'page':1,'type':'text','text':'定义'}]
        p=copy.deepcopy(PLAN);p['units'][0]['board_ranges']=[[0,0]]
        stages=[]
        reviews=0
        def fake_call(stage,payload,images=()):
            nonlocal reviews
            stages.append(stage)
            if stage=='plan':value=p
            elif stage=='align':value={'board_owners':[{'start':0,'unit':'u001'}]}
            else:
                reviews+=1
                value={'verdict':'fail' if reviews==1 else 'pass','issues':['归属问题'] if reviews==1 else []}
            return json.dumps(value),{'request_key':str(len(stages))}
        engine.call=fake_call
        engine.plan(m)
        self.assertEqual(stages.count('plan'),1)
        self.assertEqual(stages.count('align'),2)
        self.assertEqual(stages.count('plan-review'),2)

    def test_invalid_fragment_format_retries_only_alignment(self):
        engine=Engine(Path(self.temp.name)/'fragment-format-fixture',self.client)
        m=copy.deepcopy(MATERIAL)
        m['board_blocks']=[{'index':0,'page':1,'type':'text','text':'完整题设'}]
        p=copy.deepcopy(PLAN);p['units'][0]['board_ranges']=[[0,0]]
        stages=[]
        def fake_call(stage,payload,images=()):
            stages.append(stage)
            if stage=='plan':value=p
            elif stage=='align':
                value={'board_owners':[{'start':0,'unit':'u001'}]}
                if stages.count('align')==1:
                    value['board_splits']=[{'index':0,'pieces':[{'at':None,'unit':'u001'}]}]
                else:self.assertIn('review_findings',payload)
            else:value={'verdict':'pass','issues':[]}
            return json.dumps(value),{'request_key':str(len(stages))}
        engine.call=fake_call
        engine.plan(m)
        self.assertEqual(stages,['plan','align','align','plan-review'])

    def test_failed_unit_only_retries_review_after_general_review_repair(self):
        first=self.engine.run(MATERIAL,PLAN,[],workers=1)
        self.assertEqual(first["accepted"],["u001"])
        self.assertEqual(set(first["failures"]),{"u002"})
        accepted_file=Path(self.temp.name)/"units/u001/accepted.json"
        accepted_bytes=accepted_file.read_bytes()
        self.client.fail.clear()
        old_prompt=self.engine.prompt
        self.engine.prompt=lambda stage:old_prompt(stage)+("\n通用审核边界澄清。" if stage=="review" else "")
        second=self.engine.run(MATERIAL,PLAN,[],workers=1)
        self.assertFalse(second["failures"])
        self.assertEqual(self.client.calls["u001"],3)
        self.assertEqual(self.client.calls["u002"],4)
        self.assertEqual(accepted_file.read_bytes(),accepted_bytes)

    def test_selected_ocr_pages_preserve_original_pdf_page_numbers(self):
        root=Path(self.temp.name)
        pdf=root/'source.pdf';pdf.write_bytes(b'original-pdf-identity')
        transcript=root/'transcript.json'
        save(transcript,{"cid":45,"video_id":"fixture_p1","segments":[{"text":"定义及推导"}]})
        inventory=root/'inventory.json'
        save(inventory,{"parts":[{"part":1,"title":"定义","cid":45,"transcript":str(transcript),"sha256":digest(transcript.read_bytes())}],
            "source_video":"fixture","board":{"path":str(pdf),"sha256":digest(pdf.read_bytes()),"pages":5}})
        board=root/'board.json'
        save(board,[{"page_idx":0,"type":"text","text":"定义"},{"page_idx":1,"type":"text","text":"证明"}])
        for page in [3,5]:(root/f'page-{page}.png').write_bytes(b'pixel-fixture')
        material=prepare(inventory,board,str(root/'page-{page}.png'),root/'run',[3,5],True)
        self.assertEqual([b['page'] for b in material['board_blocks']],[3,5])
        self.assertEqual([b['index'] for b in material['board_blocks']],[0,1])
        save(board,[{"page_idx":0,"type":"text","text":"定义"}])
        with self.assertRaisesRegex(ValueError,'coverage_incomplete'):
            prepare(inventory,board,str(root/'page-{page}.png'),root/'missing',[3,5],True)

    def test_selection_rejects_reversed_ranges_and_duplicates(self):
        self.assertEqual(parse_selection('3-5,8',minimum=1),[3,4,5,8])
        for text in ['5-3','3,3','0-4']:
            with self.assertRaises(ValueError):parse_selection(text,minimum=1)

    def test_required_source_diagram_cannot_disappear_into_prose(self):
        with self.assertRaisesRegex(ValueError,'diagram_relation_not_preserved'):
            validate_body('- 只有文字和 $a+b$。',set(),True)
        body='- 对应关系\n\n  ```mermaid\n  flowchart LR\n  A["甲"] --> B["乙"]\n  ```\n'
        self.assertEqual(validate_body(body,set(),True),body)
        with self.assertRaisesRegex(ValueError,'required_source_diagram_missing'):
            validate_body('- 从图像看，曲线与直线相切。',{'images/curve.jpg'})
        validate_body('- 几何意义\n  - ![曲线与切线](images/curve.jpg)',{'images/curve.jpg'})

    def test_math_syntax_collection_excludes_diagram_code_and_keeps_tex_unchanged(self):
        body='- $x$\n\n  $$\\begin{cases}x&x>0\\end{cases}$$\n\n  ```mermaid\n  A["$literal$"]\n  ```\n'
        rows=math_expressions(body)
        self.assertEqual(rows,[{'tex':'\\begin{cases}x&x>0\\end{cases}','display':True},{'tex':'x','display':False}])

    def test_diagram_conditions_must_be_latex_or_adjacent_to_the_diagram(self):
        with self.assertRaisesRegex(ValueError,'diagram_formula_requires_latex'):
            validate_body('- 情形\n\n  ```mermaid\n  A["a = 2"] --> B["相切"]\n  ```\n',set())
        validate_body('- 当 $a=2$ 时\n\n  ```mermaid\n  A["取等情形"] --> B["1：相切"]\n  ```\n',set())
        with self.assertRaisesRegex(ValueError,'named_color'):
            validate_body('- 关系\n\n  ```mermaid\n  A --> B\n  linkStyle 0 stroke:#a855f7;\n  ```\n',set())
        validate_body('- 关系\n\n  ```mermaid\n  A --> B\n  linkStyle 0 stroke:purple;\n  ```\n',set())
        with self.assertRaisesRegex(ValueError,'frontmatter_not_supported'):
            validate_body('- 关系\n\n  ```mermaid\n    ---\n    config: {}\n    ---\n    xychart-beta\n  ```\n',set())

    def test_numeric_reconstruction_is_source_bound_visible_and_not_a_flowchart_substitute(self):
        root=Path(self.temp.name)
        original=root/'original.png';original.write_bytes(b'synthetic-original')
        generated=root/'generated.png';generated.write_bytes(b'synthetic-scientific-diagram')
        plan_file=root/'numeric-plan.json';save(plan_file,{'synthetic':True})
        receipt_file=root/'diagram-receipt.json'
        save(receipt_file,{'source_image_id':'img0000','source_sha256':digest(original.read_bytes()),
            'renderer':'MathTopicPipeline/diagrams','plan_path':str(plan_file),'plan_sha256':digest(plan_file.read_bytes()),
            'path':str(generated),'hashes':{'png':digest(generated.read_bytes())},'checks':[{'passed':True}]})
        save(root/'diagram-reconstructions.json',{'images':[{'source_image_id':'img0000','receipt':str(receipt_file),
            'receipt_sha256':digest(receipt_file.read_bytes())}]})
        material=copy.deepcopy(MATERIAL)
        material['board_blocks']=[{'index':0,'page':1,'type':'image'}]
        material['images']=[{'id':'img0000','block':0,'page':1,'path':str(original),
            'sha256':digest(original.read_bytes()),'link':'images/source.png'}]
        plan=copy.deepcopy(PLAN);plan['units'][0]['board_ranges']=[[0,0]]
        media=[{'id':'img0000','action':'transcribe','diagram_required':True}]
        payload,visual=self.engine.unit_payload(material,plan,plan['units'][0],media)
        self.assertFalse(requires_mermaid(payload))
        self.assertEqual(len(payload['allowed_images']),1)
        self.assertEqual(visual[-1]['sha256'],digest(generated.read_bytes()))
        kept_media=[{'id':'img0000','action':'keep_diagram','diagram_required':True}]
        replacement,_=self.engine.unit_payload(material,plan,plan['units'][0],kept_media)
        self.assertEqual([i['id'] for i in replacement['allowed_images']],['reconstructed-img0000'])
        self.assertEqual(replacement['mixed_images'][0]['id'],'img0000')
        with self.assertRaisesRegex(ValueError,'unapproved'):
            validate_body('- ![](images/source.png)',{i['link'] for i in replacement['allowed_images']})
        with self.assertRaisesRegex(ValueError,'required_source_diagram_missing'):
            validate_body('- 只有一段分类文字。',{i['link'] for i in payload['allowed_images']})
        generated.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'reconstruction_asset_changed'):
            self.engine.unit_payload(material,plan,plan['units'][0],media)

    def test_syntax_failure_cannot_accept_or_publish_a_candidate(self):
        self.client.fail.clear()
        self.engine.syntax_checker=lambda body:[{'kind':'rendering','description':'unclosed cases'}]
        result=self.engine.run(MATERIAL,PLAN,[],selected=['u001'],workers=1)
        self.assertIn('u001',result['failures'])
        self.assertFalse((Path(self.temp.name)/'units/u001/accepted.json').exists())
        self.assertEqual(len(list((Path(self.temp.name)/'units/u001').glob('syntax-*.json'))),1)

    def test_new_structure_failure_reopens_only_the_affected_accepted_unit(self):
        self.client.fail.clear()
        self.engine.run(MATERIAL,PLAN,[],workers=1)
        other=Path(self.temp.name)/'units/u002/accepted.json'
        before=other.read_bytes()
        checks=0
        def strengthened(body,*args,**kwargs):
            nonlocal checks
            checks+=1
            if checks==1:raise ValueError('new_general_structure_requirement')
            return validate_body(body,*args,**kwargs)
        with patch('pipeline.validate_body',strengthened):
            result=self.engine.run(MATERIAL,PLAN,[],selected=['u001'],workers=1)
        self.assertFalse(result['failures'])
        self.assertEqual(other.read_bytes(),before)
        self.assertGreaterEqual(checks,2)

    def test_adjacent_merge_regenerates_only_merged_source_and_rebinds_catalog_without_generation(self):
        self.client.fail.clear()
        material=copy.deepcopy(MATERIAL)
        material['transcripts']=[{'part':2,'title':'运动','cues':[[0,'定义'],[1,'重述定义并证明'],[2,'后续应用']]}]
        plan=copy.deepcopy(PLAN)
        plan['units'][1].update(part=2,start=1,end=1)
        plan['units'].append({**plan['units'][1],'id':'u003','title':'后续应用','start':2,'end':2})
        root=Path(self.temp.name)
        save(root/'material.json',material);save(root/'plan.json',{'plan':plan})
        self.engine.run(material,plan,[],workers=1)
        before=read_json(root/'units/u003/accepted.json')
        calls_before=self.client.calls['u003']
        save(root/'integration-review.json',{'review':{'verdict':'fail','issues':[
            {'unit_ids':['u001','u002'],'description':'同一对象重复讲解，应融合理由'}]}})
        result=self.engine.merge_units(material,plan,['u001','u002'])
        self.assertEqual(result['regenerate'],'u001')
        merged=read_json(root/'plan.json')['plan']
        self.assertEqual([u['id'] for u in merged['units']],['u001','u003'])
        self.assertEqual(merged['units'][0]['end'],1)
        self.assertEqual(merged['units'][1],plan['units'][2])
        self.engine.run(material,merged,[],workers=1)
        after=read_json(root/'units/u003/accepted.json')
        self.assertEqual(self.client.calls['u003'],calls_before)
        for field in ['lecture_sha256','lecture_receipt','review_receipt','math_review_receipt']:
            self.assertEqual(after[field],before[field])
        self.assertTrue(after['context_rebinding']['own_source_verified_unchanged'])
        self.assertEqual(read_json(root/'units/u002/state.json')['status'],'merged')
        self.assertTrue((root/'units/u002/accepted.json').exists())

    def test_merge_cannot_cross_source_parts_or_proceed_without_a_localized_failure(self):
        with self.assertRaisesRegex(ValueError,'same_part_and_chapter'):
            self.engine.merge_units(MATERIAL,PLAN,['u001','u002'])

    def test_previous_lecture_context_is_verified_and_cannot_use_a_future_unit(self):
        self.client.fail.clear()
        self.engine.run(MATERIAL,PLAN,[],workers=1)
        root=Path(self.temp.name)
        save(root/'unit-context.json',{'units':{'u002':['u001']}})
        payload,_=self.engine.unit_payload(MATERIAL,PLAN,PLAN['units'][1],[])
        self.assertEqual(payload['previous_lecture_context'][0]['unit_id'],'u001')
        record=read_json(root/'units/u001/accepted.json')
        self.assertEqual(payload['previous_lecture_context'][0]['sha256'],record['lecture_sha256'])
        Path(record['lecture_file']).write_text('- changed',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'context_evidence_changed'):
            self.engine.unit_payload(MATERIAL,PLAN,PLAN['units'][1],[])
        save(root/'unit-context.json',{'units':{'u001':['u002']}})
        with self.assertRaisesRegex(ValueError,'previously_defined'):
            self.engine.unit_payload(MATERIAL,PLAN,PLAN['units'][0],[])

    def test_math_audit_rejects_incorrect_attainment_without_rewriting_passing_units(self):
        self.client.fail.clear()
        result=self.engine.unit(MATERIAL,PLAN,PLAN['units'][0],[])
        body=Path(result['lecture_file']).read_bytes()
        original=self.client.raw
        old_prompt=self.engine.prompt
        self.engine.prompt=lambda stage:old_prompt(stage)+ ('\n重新核算见证。' if stage=='math-review' else '')
        def failing_math(messages,**kwargs):
            if messages[0]['content'].startswith('独立检查数学'):
                return {'provider':'codex_exec','model':'fixture','choices':[{'finish_reason':'stop','message':{
                    'content':json.dumps({'verdict':'fail','issues':[{'kind':'math','description':'取等值不满足原约束'}],
                        'checked':dict.fromkeys(['witness_substitution','signs_domains','algebra'],True)})}}]}
            return original(messages,**kwargs)
        self.client.raw=failing_math
        failed=self.engine.run(MATERIAL,PLAN,[],selected=['u001'],workers=1,recheck_math=True)
        self.assertIn('u001',failed['failures'])
        self.assertEqual(Path(result['lecture_file']).read_bytes(),body)
        with self.assertRaisesRegex(ValueError,'pending_revalidation'):
            self.engine.assemble(MATERIAL,PLAN,[])

    def test_render_failure_cannot_be_reported_as_complete(self):
        self.client.fail.clear()
        self.engine.run(MATERIAL,PLAN,[],workers=1)
        self.engine.assemble(MATERIAL,PLAN,[])
        root=Path(self.temp.name)
        def failed_renderer(*args,**kwargs):
            save(root/'render/render-verification.json',{'status':'failed','errors':[{'kind':'math'}]})
        with patch('pipeline.subprocess.run',failed_renderer):
            with self.assertRaisesRegex(ValueError,'rendering_failed'):verify_delivery(root)
        self.assertFalse((root/'acceptance.json').exists())
        def passed_renderer(*args,**kwargs):
            save(root/'render/render-verification.json',{'status':'passed','errors':[]})
        with patch('pipeline.subprocess.run',passed_renderer):
            self.assertEqual(verify_delivery(root)['status'],'passed')
        plan=read_json(root/'plan.json');plan['changed']=True;save(root/'plan.json',plan)
        with self.assertRaisesRegex(ValueError,'source_binding_changed'):verify_delivery(root)

    def test_source_change_invalidates_only_affected_unit(self):
        self.client.fail.clear()
        self.engine.run(MATERIAL,PLAN,[],workers=1)
        changed=copy.deepcopy(MATERIAL);changed["transcripts"][1]["cues"][0][1]+="质量为正。"
        self.engine.run(changed,PLAN,[],workers=1)
        self.assertEqual(self.client.calls["u001"],3)
        self.assertEqual(self.client.calls["u002"],6)

    def test_automatic_repair_regenerates_only_failed_unit_from_unchanged_sources(self):
        self.engine.run(MATERIAL,PLAN,[],workers=1)
        accepted_file=Path(self.temp.name)/'units/u001/accepted.json'
        accepted_before=accepted_file.read_bytes()
        source_file=Path(self.temp.name)/'units/u002/source.json'
        source_before=source_file.read_bytes()
        original=self.client.raw
        seen=[]
        def repaired(messages,**kwargs):
            payload=json.loads(messages[1]['content'])
            if payload.get('review_findings'):
                seen.append(payload)
                self.client.fail.clear()
                result=original(messages,**kwargs)
                result['choices'][0]['message']['content']='- 在给定条件下，$m>0$，动能为 $K=mv^2/2$。'
                return result
            return original(messages,**kwargs)
        self.client.raw=repaired
        result=self.engine.run(MATERIAL,PLAN,[],workers=1,revisions=1)
        self.assertFalse(result['failures'])
        self.assertEqual(accepted_before,accepted_file.read_bytes())
        self.assertEqual(source_before,source_file.read_bytes())
        self.assertEqual(len(seen),1)
        self.assertEqual(seen[0]['transcript'],MATERIAL['transcripts'][1]['cues'])
        self.assertNotIn('candidate_lecture',seen[0])
        self.assertEqual(len(list((Path(self.temp.name)/'units/u002').glob('lecture-*.md'))),2)

    def test_local_regeneration_receives_integration_findings_without_touching_other_units(self):
        self.client.fail.clear()
        self.engine.run(MATERIAL,PLAN,[],workers=1)
        other=Path(self.temp.name)/'units/u002/accepted.json'
        before=other.read_bytes()
        finding={'unit_ids':['u001'],'description':'核实与上文重复的同一推导。'}
        save(Path(self.temp.name)/'integration-review.json',{'review':{'verdict':'fail','issues':[finding]}})
        original=self.client.raw
        seen=[]
        def capture(messages,**kwargs):
            payload=json.loads(messages[1]['content'])
            if 'review_findings' in payload:seen.extend(payload['review_findings'])
            return original(messages,**kwargs)
        self.client.raw=capture
        result=self.engine.run(MATERIAL,PLAN,[],selected=['u001'],refresh=True,workers=1)
        self.assertFalse(result['failures'])
        self.assertIn(finding,seen)
        self.assertEqual(before,other.read_bytes())

    def test_modified_body_or_review_cannot_be_accepted_from_cache(self):
        result=self.engine.unit(MATERIAL,PLAN,PLAN["units"][0],[])
        body=Path(result["lecture_file"]);original=body.read_bytes()
        body.write_text("- modified",encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"accepted_body_modified"):
            self.engine.unit(MATERIAL,PLAN,PLAN["units"][0],[])
        body.write_bytes(original)
        review=Path(result["review_file"]);review.write_text('{}',encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"accepted_review_modified"):
            self.engine.unit(MATERIAL,PLAN,PLAN["units"][0],[])

    def test_reopened_failed_unit_cannot_publish_using_previous_acceptance(self):
        self.client.fail.clear()
        self.engine.run(MATERIAL,PLAN,[],workers=1)
        self.client.fail.add("u001")
        old_prompt=self.engine.prompt
        self.engine.prompt=lambda stage:old_prompt(stage)+("\n新增通用核验条件。" if stage=="review" else "")
        result=self.engine.run(MATERIAL,PLAN,[],selected=["u001"],refresh=True,workers=1)
        self.assertIn("u001",result["failures"])
        with self.assertRaisesRegex(ValueError,"pending_revalidation"):
            self.engine.assemble(MATERIAL,PLAN,[])

    def test_formula_images_and_guide_are_rejected(self):
        with self.assertRaisesRegex(ValueError,"unapproved"):
            validate_body("- ![](images/mixed-formulas.jpg)",{"images/graph.jpg"})
        with self.assertRaisesRegex(ValueError,"processing_commentary"):
            validate_body("- 阅读前置卡：高价值。",set())
        with self.assertRaisesRegex(ValueError,"unclosed"):
            validate_body("- 原理\n  ```mermaid\n  graph LR",set())
        validate_body("- 关系\n  - ![](images/graph.jpg)\n  - $x^2$",{"images/graph.jpg"})

    def test_assembly_protects_user_edits_and_requires_all_units(self):
        with self.assertRaises(FileNotFoundError):self.engine.assemble(MATERIAL,PLAN,[])
        self.client.fail.clear();self.engine.run(MATERIAL,PLAN,[],workers=1)
        result=self.engine.assemble(MATERIAL,PLAN,[])
        file=Path(result["path"])
        self.assertEqual(digest(file.read_bytes()),result["sha256"])
        file.write_text(file.read_text(encoding="utf-8")+"用户批注\n",encoding="utf-8")
        with self.assertRaisesRegex(ValueError,"refuse_overwrite"):
            self.engine.assemble(MATERIAL,PLAN,[])

    def test_chapter_delivery_keeps_complete_units_and_checks_every_document(self):
        self.client.fail.clear()
        plan=copy.deepcopy(PLAN)
        plan['chapters']=[{'id':'c01','title':'速度'},{'id':'c02','title':'动能'}]
        plan['units'][1]['chapter']='c02'
        save(Path(self.temp.name)/'plan.json',{'plan':plan})
        self.engine.run(MATERIAL,plan,[],workers=1)
        publication=self.engine.assemble(MATERIAL,plan,[],split_chapters=True)
        self.assertEqual([d['unit_ids'] for d in publication['documents']],[['u001'],['u002']])
        calls=[]
        def renderer(args,**kwargs):
            output=Path(args[args.index('--output')+1]);calls.append(output)
            save(output/'render-verification.json',{'status':'passed','errors':[]})
        with patch('pipeline.subprocess.run',renderer):
            acceptance=verify_delivery(self.temp.name)
        self.assertEqual(len(calls),3)
        self.assertEqual(len(acceptance['documents']),2)
        for document in publication['documents']:
            self.assertTrue(Path(document['path']).read_text(encoding='utf-8').startswith('# '+document['title']))

    def test_edited_chapter_is_protected_and_cannot_reach_rendering(self):
        self.client.fail.clear()
        self.engine.run(MATERIAL,PLAN,[],workers=1)
        publication=self.engine.assemble(MATERIAL,PLAN,[],split_chapters=True)
        document=Path(publication['documents'][0]['path'])
        document.write_text(document.read_text(encoding='utf-8')+'用户批注\n',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'published_chapter_modified'):
            self.engine.assemble(MATERIAL,PLAN,[])
        with patch('pipeline.subprocess.run',side_effect=AssertionError('must fail before rendering')):
            with self.assertRaisesRegex(ValueError,'chapter_document_modified'):
                verify_delivery(self.temp.name)


if __name__=="__main__":unittest.main()
