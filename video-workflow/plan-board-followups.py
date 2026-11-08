"""Plan source-bound supplementary board frames from concrete visual-review gaps."""
import argparse,json,sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'standard-preprocessing'))
from producer_transport import ProducerTransport

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 source=a.input.read_text('utf-8')
 prompt=('只规划补充取帧，不校订字幕，不整理正文，也不推算题目答案。输入包含分P原字幕、已看过的板书观察、已提取公式和具体未解决项。'
  '只为尚未有完整画面支持的核心题设、关键推导、最终结论和取等条件选择新画面；变量范围在原文明确口述时不必为重复核对单独补图，'
  '不为非板书术语或助词取图。优先找每个题目已讲完、板书写完而尚未擦除的时刻；不要再选“我们要证明/先来写题目”的开头。'
  '按整段上下文辨认结果已经出现的字幕，不用未显示的公式或自己算出的答案作为预期。'
  '返回严格JSON {"items":[{"part":整数,"segment_index":整数,"expected_visual":"要核对的完整题面或结果","reason":"对应哪条具体缺口"}]}。'
  '程序在该条结果字幕结束前12秒至结束前1秒提供候选，避免讲师收尾时已擦除整页；请选结果已经讲明而尚未开始下一题的字幕。所有时间由程序确定，不输出时间、不抄写字幕。'
  '数量由实际缺口决定，不给已有足够证据的题目重复取图。\nBEGIN_SOURCE_JSON\n'+source+'\nEND_SOURCE_JSON')
 t=ProducerTransport(required_provider='codex_exec');a.output.mkdir(parents=True,exist_ok=True)
 (a.output/'request.txt').write_text(prompt,'utf-8')
 raw,replay=t.frozen_call(a.output,'依据来源索引规划后续补充板书截图；不能声称已看过拟截取的新图。',prompt,max_tokens=16384)
 content=raw['choices'][0]['message']['content'].strip()
 if content.startswith('```'):content=content.split('\n',1)[1].rsplit('```',1)[0]
 plan=json.loads(content)
 (a.output/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2)+'\n','utf-8')
 print(json.dumps({'stage':'board_gap_plan','provider':t.provider,'model':t.model,'requests_this_run':0 if replay else 1,'items':len(plan['items'])}),flush=True)
if __name__=='__main__':main()
